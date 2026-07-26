#!/usr/bin/env bash
#
# Pull daily metric snapshots from the production server to this machine.
#
#   ./scripts/sync-snapshots.sh          # sync
#   ./scripts/sync-snapshots.sh --dry-run
#
# WHY THIS EXISTS
#   data/snapshots/ is gitignored and written by cron on the server, so a local
#   checkout never sees it. That is correct for git (~0.6 MB/day, ~233 MB/yr, and
#   git keeps every version forever) but it left the data unreachable locally and
#   stranded on one droplet. See docs/bundle-marketing-plan.md section 5.
#
#   Most of the volume is GSC history, which Google's API only serves for a
#   trailing ~16 months. Clarity's window is shorter still. Once those pass, the
#   snapshots are the only record that survives — they cannot be re-fetched.
#
# DIRECTION IS FIXED AND NOT PARAMETERIZED.
#   Server is always the source; local is always the destination. There is no
#   flag to reverse it. Running rsync backwards against a --delete would destroy
#   data that has no other copy, so the wrong direction is not expressible here
#   rather than merely discouraged.
#
#   --delete is deliberately NOT used. If the server loses files (its disk filled
#   once already and silently killed cron for four days), a mirror would happily
#   propagate the loss. Local accumulates instead, so it is a superset and acts as
#   a safety net rather than a faithful mirror.

set -euo pipefail

readonly SERVER="root@137.184.119.230"
readonly REMOTE_DIR="/root/seo-claude/data/snapshots/"

# Always the main checkout, never a worktree — worktrees would each hold their own
# copy of ~79 MB. Symlink from a worktree if an agent there needs the data.
readonly DEST="${SNAPSHOT_DEST:-/Users/seanfillmore/Code/Claude/data/snapshots}"

DRY_RUN=""
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN="--dry-run"
  echo "DRY RUN — nothing will be written"
fi

if ! ssh -o ConnectTimeout=15 -o BatchMode=yes "$SERVER" true 2>/dev/null; then
  echo "ERROR: cannot reach $SERVER (key auth failed or host down)" >&2
  exit 1
fi

mkdir -p "$DEST"
before=$(find "$DEST" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')

# -a archive, -z compress, --partial resume interrupted transfers.
# No --delete: see the direction note above.
rsync -az --partial $DRY_RUN \
  -e "ssh -o ConnectTimeout=15" \
  "$SERVER:$REMOTE_DIR" "$DEST/"

after=$(find "$DEST" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')

echo "snapshots: $before -> $after files ($(du -sh "$DEST" | cut -f1)) at $DEST"
for feed in "$DEST"/*/; do
  [[ -d "$feed" ]] || continue
  latest=$(ls "$feed" 2>/dev/null | tail -1)
  printf '  %-18s %4s files   latest: %s\n' "$(basename "$feed")" "$(ls "$feed" 2>/dev/null | wc -l | tr -d ' ')" "${latest:-none}"
done
