#!/usr/bin/env bash
# Safe deploy, run LOCALLY on the production server (no ssh) from the repo root.
# It is CLAUDE.md's "The stash dance is RETIRED" sequence, used by the recap
# reviewer after it merges a fix. Never stash, never hard-reset.
#
#   1. reconcile gate against origin/main (exit 2/3 need a human: stop here)
#   2. snapshot every meta.json (the pre-pull merge base)
#   3. discard tracked meta.json edits; the pathspec is QUOTED so git, not the
#      shell, matches it (unquoted, untracked post dirs make git error out)
#   4. pull
#   5. 3-way reconcile against the snapshot, joined to pm2 restart with ';'
#      because exit 2 there means "classify a field", not "stay on old code"
#   6. restart, then require seo-dashboard online on two readings 5 s apart
#      with restart_time unchanged (not crash-looping), within ~20 s
#
# Exit codes: 0 deployed; 3 the pull never happened (server HEAD unchanged);
# 1 pulled but the server is not healthy (or HEAD is not origin/main).
set -u
cd "$(dirname "$0")/.." || exit 3

HEAD_BEFORE=$(git rev-parse HEAD)
fail() {
  echo "deploy: $1"
  if [ "$(git rev-parse HEAD)" = "$HEAD_BEFORE" ]; then exit 3; fi
  exit 1
}

git fetch origin || fail "git fetch failed"

node scripts/reconcile-post-metas.mjs --ref origin/main
GATE=$?
if [ "$GATE" -ge 2 ]; then
  fail "reconcile gate exit $GATE needs a human (2 = unclassified field, 3 = unparseable meta.json)"
fi

SNAP=$(node scripts/reconcile-post-metas.mjs --snapshot | sed -n "s/.*→ //p")
[ -n "$SNAP" ] || fail "meta.json snapshot failed"
echo "snapshot: $SNAP"

git checkout -- "data/posts/*/meta.json" \
  && git pull --no-rebase \
  && node scripts/reconcile-post-metas.mjs --against "$SNAP" --apply; pm2 restart seo-dashboard

[ "$(git rev-parse HEAD)" != "$HEAD_BEFORE" ] || fail "the pull never happened; server unchanged at $HEAD_BEFORE"
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || fail "HEAD is not origin/main after pull"

# Prints "<status> <restart_time>" for seo-dashboard, or "missing".
pm2_state() {
  pm2 jlist 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      try {
        const p = JSON.parse(s).find((x) => x.name === "seo-dashboard");
        console.log(p ? `${p.pm2_env.status} ${p.pm2_env.restart_time}` : "missing");
      } catch { console.log("missing"); }
    });'
}

ONLINE=0
for _ in $(seq 1 20); do
  sleep 1
  FIRST=$(pm2_state)
  case "$FIRST" in
    online\ *)
      sleep 5
      SECOND=$(pm2_state)
      if [ "$SECOND" = "$FIRST" ]; then ONLINE=1; break; fi
      ;;
  esac
done
[ "$ONLINE" -eq 1 ] || fail "seo-dashboard not stably online (two readings 5 s apart, same restart_time)"
echo "deploy: ok at $(git rev-parse --short HEAD)"
