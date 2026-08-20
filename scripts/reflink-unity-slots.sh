#!/usr/bin/env bash
set -euo pipefail

exec python3 - "$@" <<'PY'
from __future__ import annotations

import argparse
import concurrent.futures
import errno
import fcntl
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

FICLONE = 0x40049409
GIB = 1024 ** 3


def parse_args() -> argparse.Namespace:
    default_state = os.environ.get(
        "DEVSPACE_UNITY_STATE_DIR",
        os.path.join(
            os.environ.get("DEVSPACE_STATE_DIR", os.path.expanduser("~/.local/share/devspace")),
            "unity-runner",
        ),
    )
    parser = argparse.ArgumentParser(
        description=(
            "Reflink byte-identical Unity Library files across validator slots and worktrees. "
            "Dry-run by default."
        )
    )
    parser.add_argument("--apply", action="store_true", help="replace duplicate files with reflink clones")
    parser.add_argument("--state-dir", default=default_state, help="Unity validator state directory")
    parser.add_argument(
        "--scan-root",
        action="append",
        default=[],
        help="root to scan for Unity projects; repeat to override the default roots",
    )
    parser.add_argument(
        "--jobs",
        type=int,
        default=min(8, os.cpu_count() or 1),
        help="parallel hashing workers (default: min(8, CPU count))",
    )
    return parser.parse_args()


def unity_running() -> bool:
    try:
        result = subprocess.run(
            ["pgrep", "-f", r"/Editor/Unity([[:space:]]|$)"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return result.returncode == 0
    except FileNotFoundError:
        # Be conservative only when applying; the caller handles this by not blocking.
        return False


def find_libraries(roots: list[Path]) -> list[Path]:
    libraries: set[Path] = set()
    for root in roots:
        if not root.is_dir():
            continue
        for current, dirs, files in os.walk(root):
            # Unity project identity. Avoid descending into Library itself after finding one.
            if os.path.basename(current) == "ProjectSettings" and "ProjectVersion.txt" in files:
                project = Path(current).parent
                library = project / "Library"
                if library.is_dir():
                    libraries.add(library.resolve())
                dirs[:] = []
                continue
            # These trees cannot contain another project definition worth scanning.
            base = os.path.basename(current)
            if base in {"Library", ".git", "Temp", "Logs", "obj", "Build", "Builds"}:
                dirs[:] = []
    return sorted(libraries)


def walk_library(library: Path):
    root_len = len(os.fspath(library)) + 1
    stack = [os.fspath(library)]
    while stack:
        directory = stack.pop()
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            stack.append(entry.path)
                        elif entry.is_file(follow_symlinks=False):
                            info = entry.stat(follow_symlinks=False)
                            if info.st_nlink == 1:
                                yield entry.path, entry.path[root_len:], info.st_size
                    except (FileNotFoundError, PermissionError):
                        continue
        except (FileNotFoundError, PermissionError):
            continue


def digest(path: str) -> bytes:
    h = hashlib.sha256()
    with open(path, "rb", buffering=1024 * 1024) as handle:
        while chunk := handle.read(4 * 1024 * 1024):
            h.update(chunk)
    return h.digest()


def clone_file(source: str, target: str) -> None:
    directory = os.path.dirname(target)
    fd, temporary = tempfile.mkstemp(prefix=f".reflink.{os.path.basename(target)}.", dir=directory)
    try:
        with open(source, "rb", buffering=0) as src, os.fdopen(fd, "wb", buffering=0) as dst:
            try:
                fcntl.ioctl(dst.fileno(), FICLONE, src.fileno())
            except OSError as error:
                if error.errno == errno.EAGAIN:
                    raise RuntimeError(
                        f"ZFS rejected a dirty reflink source for {target}; stop writers and re-run after sync"
                    ) from error
                raise

        # Preserve the target's metadata, not the source's. copystat includes Linux xattrs where supported.
        target_stat = os.stat(target, follow_symlinks=False)
        shutil.copystat(target, temporary, follow_symlinks=False)
        try:
            os.chown(temporary, target_stat.st_uid, target_stat.st_gid, follow_symlinks=False)
        except PermissionError:
            pass
        os.replace(temporary, target)
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def flush_filesystems(libraries: list[Path]) -> None:
    seen: set[int] = set()
    for library in libraries:
        device = os.stat(library).st_dev
        if device in seen:
            continue
        seen.add(device)
        subprocess.run(["sync", "-f", os.fspath(library)], check=True)


def main() -> int:
    args = parse_args()
    if args.jobs < 1:
        print("--jobs must be at least 1", file=sys.stderr)
        return 2
    if args.apply and unity_running():
        print("A Unity Editor process appears to be running. Stop Unity/validation jobs before --apply.", file=sys.stderr)
        return 1

    home = Path.home()
    roots = [Path(value).expanduser() for value in args.scan_root] or [
        Path(args.state_dir).expanduser() / "slots",
        home / ".devspace" / "worktrees",
        home / "Projects",
    ]
    libraries = find_libraries(roots)
    if len(libraries) < 2:
        print("Fewer than two Unity Library directories were found; there is nothing to reflink.")
        return 0

    print(f"Found {len(libraries)} Unity Libraries. Indexing files...")

    # Relative path + size is a cheap, high-selectivity filter. Only groups present in
    # multiple Libraries are ever hashed.
    candidates: dict[tuple[str, int], list[str]] = defaultdict(list)
    scanned = 0
    for library in libraries:
        before = scanned
        for path, relative, size in walk_library(library):
            candidates[(relative, size)].append(path)
            scanned += 1
        print(f"  {library}: {scanned - before:,} files")

    groups = [paths for paths in candidates.values() if len(paths) > 1]
    hash_paths = sorted({path for paths in groups for path in paths})
    print(
        f"Indexed {scanned:,} files; {len(hash_paths):,} files in {len(groups):,} candidate groups need hashing "
        f"({args.jobs} workers)."
    )

    digests: dict[str, bytes] = {}
    if hash_paths:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as executor:
            for path, value in zip(hash_paths, executor.map(digest, hash_paths, chunksize=16)):
                digests[path] = value

    duplicates: list[tuple[str, str, int]] = []
    for paths in groups:
        by_digest: dict[bytes, list[str]] = defaultdict(list)
        for path in paths:
            by_digest[digests[path]].append(path)
        for identical in by_digest.values():
            if len(identical) < 2:
                continue
            source = identical[0]
            size = os.stat(source, follow_symlinks=False).st_size
            for target in identical[1:]:
                duplicates.append((source, target, size))

    logical_bytes = sum(size for _, _, size in duplicates)
    if not args.apply:
        print(
            f"Would reflink {len(duplicates):,} identical files across {len(libraries)} Unity Libraries "
            f"({logical_bytes / GIB:.2f} GiB logical data)."
        )
        print("Dry run only. Re-run with --apply after stopping Unity/validation jobs.")
        return 0

    print("Flushing backing filesystems before FICLONE...")
    flush_filesystems(libraries)
    done = 0
    done_bytes = 0
    for source, target, size in duplicates:
        clone_file(source, target)
        done += 1
        done_bytes += size
        if done % 10000 == 0:
            print(f"  reflinked {done:,}/{len(duplicates):,} files ({done_bytes / GIB:.2f} GiB)")

    print(
        f"Reflinked {done:,} identical files across {len(libraries)} Unity Libraries "
        f"({done_bytes / GIB:.2f} GiB logical data)."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
PY
