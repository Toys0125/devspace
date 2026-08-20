#!/usr/bin/env bash
set -euo pipefail

apply=0
state_dir="${DEVSPACE_UNITY_STATE_DIR:-${DEVSPACE_STATE_DIR:-$HOME/.local/share/devspace}/unity-runner}"
scan_roots=()

usage() {
  cat <<'EOF'
Usage: reflink-unity-slots.sh [--apply] [--state-dir PATH] [--scan-root PATH ...]

Finds Unity Library directories in validator slots, DevSpace worktrees, and normal
project worktrees, then replaces byte-identical files at the same Library-relative
path with filesystem reflink clones. File paths, contents, ownership, permissions,
timestamps, and xattrs are preserved.

Defaults scan:
  <state-dir>/slots
  ~/.devspace/worktrees
  ~/Projects

Use --scan-root one or more times to replace those defaults with explicit roots.
The default is a dry run. Stop Unity/validation jobs before using --apply.
EOF
}

while (($#)); do
  case "$1" in
    --apply) apply=1; shift ;;
    --state-dir) state_dir="${2:?missing path after --state-dir}"; shift 2 ;;
    --scan-root) scan_roots+=("${2:?missing path after --scan-root}"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ((${#scan_roots[@]} == 0)); then
  scan_roots=(
    "$state_dir/slots"
    "$HOME/.devspace/worktrees"
    "$HOME/Projects"
  )
fi

if ((apply)) && pgrep -f '/Editor/Unity([[:space:]]|$)' >/dev/null 2>&1; then
  echo "A Unity Editor process appears to be running. Stop Unity/validation jobs before --apply." >&2
  exit 1
fi

if ! cp --help 2>&1 | grep -q -- '--reflink'; then
  echo "This cp does not support --reflink." >&2
  exit 1
fi

libraries=()
declare -A seen_library=()
for root in "${scan_roots[@]}"; do
  [[ -d "$root" ]] || continue
  while IFS= read -r -d '' project_version; do
    project_root="${project_version%/ProjectSettings/ProjectVersion.txt}"
    library="$project_root/Library"
    [[ -d "$library" ]] || continue
    if [[ -z "${seen_library[$library]:-}" ]]; then
      seen_library[$library]=1
      libraries+=("$library")
    fi
  done < <(find "$root" -maxdepth 6 -type f -path '*/ProjectSettings/ProjectVersion.txt' -print0 2>/dev/null)
done

if ((${#libraries[@]} < 2)); then
  echo "Fewer than two Unity Library directories were found; there is nothing to reflink."
  exit 0
fi

IFS=$'\n' libraries=($(printf '%s\n' "${libraries[@]}" | sort -u))
unset IFS

if ((apply)); then
  # OpenZFS normally returns EAGAIN for FICLONE when source blocks are still dirty.
  # Flush every backing filesystem represented by the discovered Libraries first.
  declare -A flushed_fs=()
  for library in "${libraries[@]}"; do
    fsid=$(stat -f -c '%d' -- "$library")
    if [[ -z "${flushed_fs[$fsid]:-}" ]]; then
      sync -f "$library"
      flushed_fs[$fsid]=1
    fi
  done
fi

declare -A canonical=()
files=0
bytes=0
scanned=0

for library in "${libraries[@]}"; do
  echo "Scanning $library"
  while IFS= read -r -d '' candidate; do
    [[ $(stat -c '%h' -- "$candidate") == 1 ]] || continue
    rel="${candidate#"$library"/}"
    [[ "$rel" != "$candidate" ]] || continue
    size=$(stat -c '%s' -- "$candidate")
    key="$size:$rel"
    ((scanned+=1))

    source="${canonical[$key]:-}"
    if [[ -z "$source" ]]; then
      canonical[$key]="$candidate"
      continue
    fi
    cmp -s -- "$source" "$candidate" || continue

    ((files+=1))
    ((bytes+=size))
    if ((apply)); then
      target_dir=$(dirname "$candidate")
      tmp=$(mktemp --tmpdir="$target_dir" ".reflink.$(basename "$candidate").XXXXXX")
      if ! cp --reflink=always --preserve=all -- "$source" "$tmp"; then
        rm -f -- "$tmp"
        echo "Reflink failed for $candidate; source and target may be on different filesystems/datasets." >&2
        exit 1
      fi
      cp --attributes-only --preserve=all -- "$candidate" "$tmp"
      mv -f -- "$tmp" "$candidate"
    fi
  done < <(find "$library" -type f -links 1 -print0)
done

mode="would reflink"
((apply)) && mode="reflinked"
printf '%s %d identical files out of %d scanned across %d Unity Libraries (%.2f GiB logical data).\n' \
  "$mode" "$files" "$scanned" "${#libraries[@]}" "$(awk -v b="$bytes" 'BEGIN { print b / 1073741824 }')"

if ((!apply)); then
  echo "Dry run only. Re-run with --apply after stopping Unity/validation jobs."
fi
