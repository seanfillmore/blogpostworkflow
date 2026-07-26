#!/usr/bin/env bash
#
# Push the snapshot archive offsite to object storage.
#
#   ./scripts/backup-snapshots-offsite.sh
#
# STATUS: ready to run, blocked on one credential that only Sean can create.
#
# WHY OFFSITE IS THE ONE THAT ACTUALLY MATTERS
#   Everything else is one machine. The server is a single 24 GB droplet whose
#   disk filled once and silently killed all cron for four days; the laptop copy
#   can be lost or stolen. ~74 MB of the tree is GSC history that Google's API
#   only serves for a trailing ~16 months, and Clarity's window is shorter. Past
#   those windows the snapshots are the only record — losing them is permanent,
#   not inconvenient.
#
# SETUP (one time, ~5 minutes)
#   1. DigitalOcean console -> Spaces -> create a bucket (e.g. rsc-backups),
#      then API -> Spaces Keys -> generate a key pair.
#   2. brew install rclone
#   3. rclone config
#        name:     spaces
#        storage:  s3
#        provider: DigitalOcean
#        endpoint: <region>.digitaloceanspaces.com
#        (paste the access key and secret from step 1)
#   4. export SNAPSHOT_BUCKET=rsc-backups     # add to your shell profile
#   5. Re-run this script.
#
#   The AWS_ACCESS_KEY / AWS_SECRET_KEY / AWS_ARN already in .env are NOT usable
#   here. They are dead leftovers from Amazon SP-API's old IAM role-assumption
#   requirement, are referenced nowhere in the codebase, and carry no S3 grant.
#   Do not wire them in.

set -euo pipefail

readonly ARCHIVE_DIR="${SNAPSHOT_ARCHIVE_DIR:-$HOME/Backups/seo-snapshots}"
readonly REMOTE="${SNAPSHOT_REMOTE:-spaces}"
readonly BUCKET="${SNAPSHOT_BUCKET:-}"

fail_setup() {
  echo "ERROR: $1" >&2
  echo "" >&2
  echo "Offsite backup is not configured yet. See the SETUP block at the top of" >&2
  echo "$0 — it is about five minutes of work and needs a DigitalOcean Spaces key." >&2
  exit 1
}

command -v rclone >/dev/null 2>&1 || fail_setup "rclone is not installed"
[[ -n "$BUCKET" ]] || fail_setup "SNAPSHOT_BUCKET is not set"
rclone listremotes 2>/dev/null | grep -q "^${REMOTE}:$" \
  || fail_setup "rclone remote '${REMOTE}' is not configured"

latest=$(ls -1t "$ARCHIVE_DIR"/snapshots-*.tar.gz 2>/dev/null | head -1 || true)
[[ -n "$latest" ]] || fail_setup "no archive found in $ARCHIVE_DIR — run scripts/archive-snapshots.sh first"

echo "uploading $(basename "$latest") ($(du -h "$latest" | cut -f1)) -> ${REMOTE}:${BUCKET}/snapshots/"
rclone copy "$latest" "${REMOTE}:${BUCKET}/snapshots/" --progress

# Confirm the object is actually there. An upload that reports success but lands
# nothing is the failure mode that makes a backup worthless exactly when needed.
if rclone lsf "${REMOTE}:${BUCKET}/snapshots/" | grep -qF "$(basename "$latest")"; then
  echo "verified present offsite: ${REMOTE}:${BUCKET}/snapshots/$(basename "$latest")"
else
  echo "ERROR: upload reported success but the object is not listed offsite" >&2
  exit 1
fi
