#!/usr/bin/env bash
#
# Take a dated, versioned archive of the local snapshot tree.
#
#   ./scripts/archive-snapshots.sh
#
# WHY THIS IS SEPARATE FROM sync-snapshots.sh
#   A mirror is not a backup. sync-snapshots.sh reproduces whatever the server
#   currently holds; if a file is corrupted or truncated there, the next sync
#   copies the damage down. These dated tarballs are the copy that survives that,
#   because they are immutable once written.
#
#   Keeps the most recent KEEP archives and prunes the rest. At ~5 MB compressed
#   per archive, 8 weekly archives is ~40 MB — cheap for two months of rollback.
#
# THIS IS STILL NOT OFFSITE. A laptop can die, be lost, or be stolen, and then
# both copies are gone. See scripts/backup-snapshots-offsite.sh for the durable
# copy; it needs an object-storage credential that does not exist yet.

set -euo pipefail

readonly SRC="${SNAPSHOT_DEST:-/Users/seanfillmore/Code/Claude/data/snapshots}"
readonly ARCHIVE_DIR="${SNAPSHOT_ARCHIVE_DIR:-$HOME/Backups/seo-snapshots}"
readonly KEEP=8

if [[ ! -d "$SRC" ]]; then
  echo "ERROR: $SRC does not exist — run scripts/sync-snapshots.sh first" >&2
  exit 1
fi

file_count=$(find "$SRC" -name '*.json' | wc -l | tr -d ' ')
if (( file_count == 0 )); then
  echo "ERROR: $SRC has no snapshots — refusing to archive an empty tree" >&2
  exit 1
fi

mkdir -p "$ARCHIVE_DIR"
stamp=$(date +%Y-%m-%d)
out="$ARCHIVE_DIR/snapshots-$stamp.tar.gz"

tar czf "$out" -C "$(dirname "$SRC")" "$(basename "$SRC")"

# An archive that cannot be read is not a backup. Verify before pruning anything.
entries=$(tar tzf "$out" | wc -l | tr -d ' ')
if (( entries < file_count )); then
  echo "ERROR: archive has $entries entries but source has $file_count files — not pruning" >&2
  exit 1
fi

echo "archived $entries entries -> $out ($(du -h "$out" | cut -f1)), verified readable"

# Prune oldest beyond KEEP.
# Plain while-read, not mapfile: macOS ships bash 3.2 and mapfile is bash 4+.
# This script must run under /bin/bash without a Homebrew bash on PATH.
ls -1t "$ARCHIVE_DIR"/snapshots-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r f; do
  rm -f "$f"
  echo "  pruned $(basename "$f")"
done

echo "retained $(ls -1 "$ARCHIVE_DIR"/snapshots-*.tar.gz 2>/dev/null | wc -l | tr -d ' ') archives in $ARCHIVE_DIR"
