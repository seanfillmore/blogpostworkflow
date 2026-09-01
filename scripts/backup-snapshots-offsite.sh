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
# TWO SETS, ONE UPLOAD PATH
#   `snapshots`  — the tree above.
#   `post-state` — data/posts/*/state.json, the server-owned half of the post
#                  metadata split out of meta.json. It is GITIGNORED, so unlike
#                  every other tracked data file it has no redundancy in git at
#                  all; this job is its only copy. It holds shopify_article_id —
#                  the sole link between a local post directory and its live
#                  article — plus legacy_locked, indexing_state and published_at
#                  across ~200 posts. Re-deriving those means matching handles
#                  against live Shopify, which the mirror-gate work showed is not
#                  reliable. Backing it up is a PRECONDITION of that split, not a
#                  follow-up to it.
#
#   The two sets are archived and pruned independently but share one upload,
#   verify and prune path — a second copy of that logic is a second copy that
#   drifts, and this is the one script whose output matters exactly when nobody
#   is watching.
#
#   THE EMPTY-SET RULE DIFFERS BY SET, DELIBERATELY. An empty `snapshots` tree is
#   an emergency and still aborts the run. An empty `post-state` set is the normal
#   state BEFORE the migration lands, so it is skipped with a notice rather than
#   failing the whole job and taking the snapshot backup down with it.
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
readonly STATE_PREFIX="post-state"   # data/posts/*/state.json — tiny; same retention

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

# ── one upload path, shared by both sets ─────────────────────────────────────
# Verify the archive is readable, upload it, confirm it is actually listed and
# byte-identical remotely, then prune that prefix to KEEP_REMOTE.
#
# An upload that reports success but stores nothing is the failure mode that makes
# a backup worthless exactly when it is needed, which is why the listing and the
# size are both re-checked from the remote rather than trusted from the exit code.
push_archive() {
  local prefix="$1" archive="$2" expected="$3"
  local remote="spaces:${SPACES_BUCKET}/${prefix}"

  local entries
  entries=$(tar tzf "$archive" | wc -l | tr -d ' ')
  (( entries >= expected )) || die "$prefix: archive has $entries entries but source has $expected files"
  echo "[$prefix] archived $entries entries, $(du -h "$archive" | cut -f1), verified readable"

  if (( DRY_RUN )); then
    echo "[$prefix] would upload $(basename "$archive") -> $remote/"
    rclone lsf "$remote/" 2>/dev/null | tail -3 || echo "  (bucket empty or unreachable)"
    return 0
  fi

  rclone copy "$archive" "$remote/" --s3-no-check-bucket

  local remote_name size local_size
  remote_name="$(basename "$archive")"
  rclone lsf "$remote/" | grep -qF "$remote_name" \
    || die "$prefix: upload reported success but $remote_name is not listed in $remote"

  size=$(rclone size "$remote/$remote_name" --json 2>/dev/null | grep -oE '"bytes":[0-9]+' | cut -d: -f2)
  local_size=$(wc -c < "$archive" | tr -d ' ')
  [[ "$size" == "$local_size" ]] \
    || die "$prefix: size mismatch: local $local_size bytes, remote ${size:-unknown} bytes"

  echo "[$prefix] verified offsite: $remote/$remote_name ($size bytes, matches local)"

  # Names are date-stamped, so lexical sort is chronological.
  rclone lsf "$remote/" | grep -E "^${prefix}-[0-9]{4}-[0-9]{2}-[0-9]{2}\.tar\.gz$" \
    | sort -r | tail -n +$((KEEP_REMOTE + 1)) | while read -r old; do
      rclone deletefile "$remote/$old"
      echo "  pruned $old"
    done

  echo "[$prefix] retained $(rclone lsf "$remote/" | grep -cE "^${prefix}-" || echo 0) archives offsite"
}

stamp=$(date +%Y-%m-%d)
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# ── set 1: the snapshot tree ─────────────────────────────────────────────────
# An empty tree here is an emergency, not a normal state: it means the collectors
# stopped. Abort rather than push an empty archive over a good one.
[[ -d "$SRC" ]] || die "$SRC does not exist"
snap_count=$(find "$SRC" -name '*.json' | wc -l | tr -d ' ')
(( snap_count > 0 )) || die "$SRC has no snapshots — refusing to back up an empty tree"

snap_archive="$tmp/${PREFIX}-${stamp}.tar.gz"
tar czf "$snap_archive" -C "$(dirname "$SRC")" "$(basename "$SRC")"
push_archive "$PREFIX" "$snap_archive" "$snap_count"

# ── set 2: the server-owned post state ───────────────────────────────────────
# A FILE LIST, not a directory: `tar -C data posts` would sweep in content.html,
# backups/ and every other per-post intermediate — hundreds of megabytes, and the
# content mirrors specifically, which are NOT what this is protecting.
#
# Skipped rather than fatal when empty. Before the meta/state split lands there
# are legitimately zero of these, and failing here would take the snapshot backup
# down with it every week over a condition that is correct.
state_list="$tmp/post-state.files"
( cd "$ROOT" && find data/posts -maxdepth 2 -name 'state.json' -type f | sort ) > "$state_list"
state_count=$(wc -l < "$state_list" | tr -d ' ')

if (( state_count == 0 )); then
  echo "[$STATE_PREFIX] no data/posts/*/state.json found — nothing to back up."
  echo "[$STATE_PREFIX] Expected BEFORE the meta/state split; after it, this line means the state files are gone."
else
  state_archive="$tmp/${STATE_PREFIX}-${stamp}.tar.gz"
  tar czf "$state_archive" -C "$ROOT" -T "$state_list"
  push_archive "$STATE_PREFIX" "$state_archive" "$state_count"
fi
