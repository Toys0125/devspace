#!/usr/bin/env bash
set -euo pipefail

apply=0
state_dir="${DEVSPACE_UNITY_STATE_DIR:-${DEVSPACE_STATE_DIR:-$HOME/.local/share/devspace}/unity-runner}"

usage() {
  cat <<'EOF'
Usage: reflink-unity-slots.sh [--apply] [--state-dir PATH]

Finds byte-identical regular files at the same relative path across existing
Unity validation slots and replaces later copies with filesystem reflink clones.
File paths, contents, ownership, permissions, timestamps, and xattrs are preserved.

The default is a dry run. Stop Unity validation jobs before using --apply.
EOF
}

while (($#)); do
  case "$1" in
    --apply) apply=1; shift ;;
    --state-dir) state_dir="${2:?missing path after --state-dir}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

slots_root="$state_dir/slots"
if [[ ! -d "$slots_root" ]]; then
  echo "No Unity validation slots directory: $slots_root" >&2
  exit 1
fi

if ((apply)) && pgrep -f '/Editor/Unity([[:space:]]|$)' >/dev/null 2>&1; then
  echo "A Unity Editor process appears to be running. Stop validation jobs before --apply." >&2
  exit 1
fi

if ! cp --help 2>&1 | grep -q -- '--reflink'; then
  echo "This cp does not support --reflink." >&2
  exit 1
fi

mapfile -d '' slots < <(find "$slots_root" -mindepth 2 -maxdepth 2 -type d -name 'slot-*' -print0 | sort -z)
if ((${#slots[@]} < 2)); then
  echo "Fewer than two Unity validation slots exist; there is nothing to reflink."
  exit 0
fi

if ((apply)); then
  # OpenZFS normally returns EAGAIN for FICLONE when source blocks are still dirty.
  # Flush the backing filesystem once before replacing any files.
  sync -f "$slots_root"
fi

declare -A canonical=()
files=0
bytes=0
scanned=0

for slot in "${slots[@]}"; do
  echo "Scanning ${slot#"$slots_root"/}"
  while IFS= read -r -d '' candidate; do
    [[ $(stat -c '%h' -- "$candidate") == 1 ]] || continue
    rel="${candidate#"$slot"/}"
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
  done < <(find "$slot" -type f -links 1 -print0)
done

mode="would reflink"
((apply)) && mode="reflinked"
printf '%s %d identical files out of %d scanned across %d slots (%.2f GiB logical data).\n' \
  "$mode" "$files" "$scanned" "${#slots[@]}" "$(awk -v b="$bytes" 'BEGIN { print b / 1073741824 }')"

if ((!apply)); then
  echo "Dry run only. Re-run with --apply after stopping Unity validation jobs."
fi
