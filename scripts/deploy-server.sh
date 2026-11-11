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
#   6. restart, then require seo-dashboard online within 20 seconds
set -u
cd "$(dirname "$0")/.." || exit 1

git fetch origin || { echo "deploy: git fetch failed"; exit 1; }

node scripts/reconcile-post-metas.mjs --ref origin/main
GATE=$?
if [ "$GATE" -ge 2 ]; then
  echo "deploy: reconcile gate exit $GATE needs a human (2 = unclassified field, 3 = unparseable meta.json)"
  exit 1
fi

SNAP=$(node scripts/reconcile-post-metas.mjs --snapshot | sed -n "s/.*→ //p")
if [ -z "$SNAP" ]; then
  echo "deploy: meta.json snapshot failed"
  exit 1
fi
echo "snapshot: $SNAP"

git checkout -- "data/posts/*/meta.json" \
  && git pull --no-rebase \
  && node scripts/reconcile-post-metas.mjs --against "$SNAP" --apply; pm2 restart seo-dashboard

if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
  echo "deploy: HEAD is not origin/main after pull"
  exit 1
fi

ONLINE=0
for _ in $(seq 1 20); do
  sleep 1
  if pm2 jlist 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      try {
        const p = JSON.parse(s).find((x) => x.name === "seo-dashboard");
        process.exit(p && p.pm2_env && p.pm2_env.status === "online" ? 0 : 1);
      } catch { process.exit(1); }
    });'; then
    ONLINE=1
    break
  fi
done
if [ "$ONLINE" -ne 1 ]; then
  echo "deploy: seo-dashboard not online within 20 seconds"
  exit 1
fi
echo "deploy: ok at $(git rev-parse --short HEAD)"
