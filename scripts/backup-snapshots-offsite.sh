#!/usr/bin/env bash
#
# Archive the snapshot tree and push it offsite to DigitalOcean Spaces.
#
#   ./scripts/backup-snapshots-offsite.sh [--dry-run]
#
# DESIGNED TO RUN ON THE SERVER, not a laptop. The server holds the authoritative
# data, it is always on, and SFO3 droplet -> SFO3 Space transfer is free. A laptop
# is asleep most of the time, which is the one state in which a backup schedule
# quietly stops running. It still works locally if you need a manual push.
#
# WHY OFFSITE IS THE COPY THAT MATTERS
#   ~74 MB of the tree is GSC history, which Google's API only serves for a
#   trailing ~16 months; Clarity's window is shorter. Past those, these snapshots
#   are the only surviving record and cannot be re-fetched. Everything else is one
#   25 GB droplet whose disk filled once and silently killed cron for four days.
#
# CREDENTIALS come from .env (gitignored, never committed):
#   SPACES_KEY, SPACES_SECRET, SPACES_REGION, SPACES_BUCKET
#
# rclone is configured entirely through RCLONE_CONFIG_* environment variables, so
# there is no rclone.conf holding a second copy of the secret. One source of truth.

set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly SRC="$ROOT/data/snapshots"
readonly KEEP_REMOTE=12          # ~3 months of weekly archives, ~72 MB total
readonly PREFIX="snapshots"

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1 && echo "DRY RUN — will not upload or prune"

die() { echo "ERROR: $*" >&2; exit 1; }

# ── credentials ──────────────────────────────────────────────────────────────
[[ -f "$ROOT/.env" ]] || die "no .env at $ROOT"
# Read only the keys we need. Never echo the values.
for k in SPACES_KEY SPACES_SECRET SPACES_REGION SPACES_BUCKET; do
  v="$(grep -E "^${k}=" "$ROOT/.env" | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
  [[ -n "$v" ]] || die "$k missing from .env"
  printf -v "$k" '%s' "$v"
done

command -v rclone >/dev/null 2>&1 || die "rclone not installed (apt install rclone / brew install rclone)"

# Configure rclone from the environment — no config file, no second copy of the secret.
# Point RCLONE_CONFIG at /dev/null so rclone stops emitting a "config file not found"
# NOTICE on every call; under weekly cron that noise would land in root's mail and
# train you to ignore output from the one job whose output actually matters.
export RCLONE_CONFIG=/dev/null
export RCLONE_CONFIG_SPACES_TYPE=s3
export RCLONE_CONFIG_SPACES_PROVIDER=DigitalOcean
export RCLONE_CONFIG_SPACES_ACCESS_KEY_ID="$SPACES_KEY"
export RCLONE_CONFIG_SPACES_SECRET_ACCESS_KEY="$SPACES_SECRET"
export RCLONE_CONFIG_SPACES_ENDPOINT="${SPACES_REGION}.digitaloceanspaces.com"
export RCLONE_CONFIG_SPACES_ACL=private

readonly REMOTE="spaces:${SPACES_BUCKET}/${PREFIX}"

# ── build the archive ────────────────────────────────────────────────────────
[[ -d "$SRC" ]] || die "$SRC does not exist"
file_count=$(find "$SRC" -name '*.json' | wc -l | tr -d ' ')
(( file_count > 0 )) || die "$SRC has no snapshots — refusing to back up an empty tree"

stamp=$(date +%Y-%m-%d)
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
archive="$tmp/${PREFIX}-${stamp}.tar.gz"

tar czf "$archive" -C "$(dirname "$SRC")" "$(basename "$SRC")"

# An archive that cannot be read is not a backup. Verify before uploading.
entries=$(tar tzf "$archive" | wc -l | tr -d ' ')
(( entries >= file_count )) || die "archive has $entries entries but source has $file_count files"
echo "archived $entries entries, $(du -h "$archive" | cut -f1), verified readable"

if (( DRY_RUN )); then
  echo "would upload $(basename "$archive") -> $REMOTE/"
  rclone lsf "$REMOTE/" 2>/dev/null | tail -5 || echo "  (bucket empty or unreachable)"
  exit 0
fi

# ── upload ───────────────────────────────────────────────────────────────────
rclone copy "$archive" "$REMOTE/" --s3-no-check-bucket

# Confirm the object is actually listed. An upload that reports success but stores
# nothing is the failure mode that makes a backup worthless exactly when needed.
remote_name="$(basename "$archive")"
rclone lsf "$REMOTE/" | grep -qF "$remote_name" \
  || die "upload reported success but $remote_name is not listed in $REMOTE"

size=$(rclone size "$REMOTE/$remote_name" --json 2>/dev/null | grep -oE '"bytes":[0-9]+' | cut -d: -f2)
local_size=$(wc -c < "$archive" | tr -d ' ')
[[ "$size" == "$local_size" ]] \
  || die "size mismatch: local $local_size bytes, remote ${size:-unknown} bytes"

echo "verified offsite: $REMOTE/$remote_name ($size bytes, matches local)"

# ── prune old remote archives ────────────────────────────────────────────────
# Names are date-stamped, so lexical sort is chronological.
rclone lsf "$REMOTE/" | grep -E "^${PREFIX}-[0-9]{4}-[0-9]{2}-[0-9]{2}\.tar\.gz$" \
  | sort -r | tail -n +$((KEEP_REMOTE + 1)) | while read -r old; do
    rclone deletefile "$REMOTE/$old"
    echo "  pruned $old"
  done

echo "retained $(rclone lsf "$REMOTE/" | grep -cE "^${PREFIX}-" || echo 0) archives offsite"
