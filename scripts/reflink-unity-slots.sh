#!/usr/bin/env bash
set -euo pipefail

exec python3 -u - "$@" <<'PY'
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
from dataclasses import dataclass
from pathlib import Path

FICLONE = 0x40049409
GIB = 1024 ** 3


@dataclass(frozen=True)
class ScanTarget:
    path: Path
    kind: str


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
            "Reflink byte-identical files across registered Git worktrees and standalone Unity validation checkouts. "
            "Dry-run by default."
        )
    )
    parser.add_argument("--apply", action="store_true", help="replace duplicate files with reflink clones")
    parser.add_argument("--state-dir", default=default_state, help="Unity validator state directory")
    parser.add_argument(
        "--repo-root",
        action="append",
        default=[],
        help="directory containing Git repositories whose registered worktrees should be scanned; repeatable",
    )
    parser.add_argument(
        "--scan-root",
        action="append",
        default=[],
        help="additional root to scan for standalone Unity validation/project checkouts; repeatable",
    )
    parser.add_argument(
        "--jobs",
        type=int,
        default=min(8, os.cpu_count() or 1),
        help="parallel discovery, indexing, and hashing workers (default: min(8, CPU count))",
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
        return False


def immediate_git_repositories(root: Path) -> list[Path]:
    repositories: list[Path] = []
    try:
        root = root.expanduser().resolve()
        if not root.is_dir():
            return repositories
    except (FileNotFoundError, PermissionError):
        return repositories

    if (root / ".git").exists():
        repositories.append(root)

    try:
        with os.scandir(root) as entries:
            for entry in entries:
                try:
                    if not entry.is_dir(follow_symlinks=False):
                        continue
                    path = Path(entry.path)
                    if (path / ".git").exists():
                        repositories.append(path)
                except (FileNotFoundError, PermissionError):
                    continue
    except (FileNotFoundError, PermissionError):
        pass
    return repositories


def registered_worktrees(repository: Path) -> set[Path]:
    worktrees: set[Path] = set()
    result = subprocess.run(
        ["git", "-C", os.fspath(repository), "worktree", "list", "--porcelain"],
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return worktrees
    for line in result.stdout.splitlines():
        if not line.startswith("worktree "):
            continue
        path = Path(line[9:])
        try:
            path = path.resolve()
            if path.is_dir():
                worktrees.add(path)
        except (FileNotFoundError, PermissionError):
            continue
    return worktrees


def find_registered_worktrees(repo_roots: list[Path], jobs: int) -> list[Path]:
    repositories: set[Path] = set()
    workers = min(jobs, max(1, len(repo_roots)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        for found in executor.map(immediate_git_repositories, repo_roots):
            repositories.update(found)

    worktrees: set[Path] = set()
    workers = min(jobs, max(1, len(repositories)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        for found in executor.map(registered_worktrees, sorted(repositories)):
            worktrees.update(found)
    return sorted(worktrees)


def scan_root_for_unity_projects(root: Path) -> set[Path]:
    projects: set[Path] = set()
    skipped = {
        ".git", ".svn", ".hg", ".cache", ".gradle", ".vs", ".vscode",
        "Library", "Temp", "Logs", "obj", "Build", "Builds", "node_modules",
        "Packages", "Assets", "UserSettings",
    }
    max_depth = 4

    try:
        root = root.expanduser().resolve()
        if not root.is_dir():
            return projects
    except (FileNotFoundError, PermissionError):
        return projects

    stack: list[tuple[Path, int]] = [(root, 0)]
    while stack:
        current, depth = stack.pop()
        try:
            is_unity_project = (current / "ProjectSettings" / "ProjectVersion.txt").is_file()
        except (FileNotFoundError, PermissionError):
            continue
        if is_unity_project:
            try:
                if (current / "Library").is_dir():
                    projects.add(current.resolve())
            except (FileNotFoundError, PermissionError):
                pass
            continue

        if depth >= max_depth:
            continue
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    try:
                        if not entry.is_dir(follow_symlinks=False) or entry.name in skipped:
                            continue
                        stack.append((Path(entry.path), depth + 1))
                    except (FileNotFoundError, PermissionError):
                        continue
        except (FileNotFoundError, PermissionError):
            continue
    return projects


def find_standalone_unity_projects(roots: list[Path], jobs: int) -> list[Path]:
    projects: set[Path] = set()
    workers = min(jobs, max(1, len(roots)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        for found in executor.map(scan_root_for_unity_projects, roots):
            projects.update(found)
    return sorted(projects)


def inside(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def build_targets(worktrees: list[Path], unity_projects: list[Path]) -> list[ScanTarget]:
    targets = [ScanTarget(path, "worktree") for path in worktrees]
    for project in unity_projects:
        if any(inside(project, worktree) for worktree in worktrees):
            continue
        targets.append(ScanTarget(project, "unity"))
    unique: dict[Path, ScanTarget] = {}
    for target in targets:
        unique[target.path] = target
    return [unique[path] for path in sorted(unique)]


def walk_target(target: ScanTarget) -> list[tuple[str, str, int, int]]:
    root = os.fspath(target.path)
    root_len = len(root) + 1
    stack = [root]
    found: list[tuple[str, str, int, int]] = []

    while stack:
        directory = stack.pop()
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    try:
                        if entry.name == ".git":
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            # A nested checkout/repository gets its own scan target when registered.
                            if os.path.exists(os.path.join(entry.path, ".git")):
                                continue
                            stack.append(entry.path)
                            continue
                        if not entry.is_file(follow_symlinks=False):
                            continue
                        info = entry.stat(follow_symlinks=False)
                        if info.st_nlink != 1 or info.st_size == 0:
                            continue
                        found.append((entry.path, entry.path[root_len:], info.st_size, info.st_dev))
                    except (FileNotFoundError, PermissionError):
                        continue
        except (FileNotFoundError, PermissionError):
            continue
    return found


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
                        f"filesystem rejected a dirty reflink source for {target}; stop writers and re-run after sync"
                    ) from error
                raise

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


def filesystem_name(path: Path) -> str:
    try:
        result = subprocess.run(
            ["findmnt", "-T", os.fspath(path), "-n", "-o", "FSTYPE,SOURCE"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            check=False,
        )
        value = result.stdout.strip()
        return value if value else "unknown"
    except FileNotFoundError:
        return "unknown"


def flush_filesystems(targets: list[ScanTarget]) -> None:
    seen: set[int] = set()
    for target in targets:
        try:
            device = os.stat(target.path).st_dev
        except OSError:
            continue
        if device in seen:
            continue
        seen.add(device)
        subprocess.run(["sync", "-f", os.fspath(target.path)], check=True)


def probe_reflink(directory: Path) -> bool:
    source_fd = target_fd = -1
    source = target = None
    try:
        source_fd, source = tempfile.mkstemp(prefix=".reflink-probe-src.", dir=directory)
        target_fd, target = tempfile.mkstemp(prefix=".reflink-probe-dst.", dir=directory)
        os.write(source_fd, b"devspace-reflink-probe")
        os.fsync(source_fd)
        fcntl.ioctl(target_fd, FICLONE, source_fd)
        return True
    except OSError:
        return False
    finally:
        for fd in (source_fd, target_fd):
            if fd >= 0:
                try:
                    os.close(fd)
                except OSError:
                    pass
        for path in (source, target):
            if path:
                try:
                    os.unlink(path)
                except FileNotFoundError:
                    pass


def main() -> int:
    args = parse_args()
    if args.jobs < 1:
        print("--jobs must be at least 1", file=sys.stderr)
        return 2
    if args.apply and unity_running():
        print("A Unity Editor process appears to be running. Stop Unity/validation jobs before --apply.", file=sys.stderr)
        return 1

    home = Path.home()
    repo_roots = [Path(value).expanduser() for value in args.repo_root] or [
        home / "projects",
        home / "Projects",
        Path("/Projects"),
    ]
    scan_roots = [Path(value).expanduser() for value in args.scan_root] or [
        Path(args.state_dir).expanduser() / "slots",
        home / ".devspace" / "worktrees",
        home / "Projects",
        Path("/Projects"),
    ]

    worktrees = find_registered_worktrees(repo_roots, args.jobs)
    unity_projects = find_standalone_unity_projects(scan_roots, args.jobs)
    targets = build_targets(worktrees, unity_projects)
    if len(targets) < 2:
        print("Fewer than two registered worktree/Unity checkout targets were found; there is nothing to reflink.")
        return 0

    print(
        f"Found {len(worktrees)} registered Git worktrees and "
        f"{len(targets) - len(worktrees)} standalone Unity checkouts."
    )

    devices: dict[int, Path] = {}
    for target in targets:
        try:
            devices.setdefault(os.stat(target.path).st_dev, target.path)
        except OSError:
            pass
    for path in devices.values():
        print(f"  filesystem: {filesystem_name(path)} at {path}")

    supported_devices: set[int] = set()
    if args.apply:
        print("Checking filesystem reflink support before indexing...")
        flush_filesystems(targets)
        for device, path in devices.items():
            if probe_reflink(path):
                supported_devices.add(device)
                print(f"  reflink supported: {filesystem_name(path)}")
            else:
                print(f"  reflink NOT supported: {filesystem_name(path)}", file=sys.stderr)
        if not supported_devices:
            print("None of the discovered worktrees/checkouts are on a filesystem that supports FICLONE/reflinks.", file=sys.stderr)
            return 1

    print(f"Indexing {len(targets)} targets with {args.jobs} workers...")
    candidates: dict[tuple[str, int, int], list[str]] = defaultdict(list)
    scanned = 0
    workers = min(args.jobs, len(targets))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(walk_target, target): target for target in targets}
        for future in concurrent.futures.as_completed(futures):
            target = futures[future]
            files = future.result()
            scanned += len(files)
            for path, relative, size, device in files:
                candidates[(relative, size, device)].append(path)
            print(f"  {target.kind}: {target.path}: {len(files):,} files")

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

    duplicates: list[tuple[str, str, int, int]] = []
    for (relative, size, device), paths in candidates.items():
        if len(paths) < 2:
            continue
        by_digest: dict[bytes, list[str]] = defaultdict(list)
        for path in paths:
            by_digest[digests[path]].append(path)
        for identical in by_digest.values():
            if len(identical) < 2:
                continue
            source = identical[0]
            for target in identical[1:]:
                duplicates.append((source, target, size, device))

    logical_bytes = sum(size for _, _, size, _ in duplicates)
    if not args.apply:
        print(
            f"Would reflink {len(duplicates):,} identical files across {len(targets)} targets "
            f"({logical_bytes / GIB:.2f} GiB logical data)."
        )
        print("Dry run only. Re-run with --apply after stopping writers that use these worktrees.")
        return 0

    print("Flushing backing filesystems before FICLONE...")
    flush_filesystems(targets)

    eligible = [item for item in duplicates if item[3] in supported_devices]
    if not eligible:
        print("No duplicate files are on a filesystem that supports FICLONE/reflinks.", file=sys.stderr)
        return 1

    done = 0
    done_bytes = 0
    for source, target, size, _device in eligible:
        clone_file(source, target)
        done += 1
        done_bytes += size
        if done % 10000 == 0:
            print(f"  reflinked {done:,}/{len(eligible):,} files ({done_bytes / GIB:.2f} GiB)")

    skipped = len(duplicates) - len(eligible)
    print(
        f"Reflinked {done:,} identical files ({done_bytes / GIB:.2f} GiB logical data); "
        f"skipped {skipped:,} files on non-reflink filesystems."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
PY
