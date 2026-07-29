#!/usr/bin/env bash
#
# Spin up an isolated worktree for one agent/session.
#
#   scripts/new-worktree.sh <name> [branch-name]
#
# Why this exists: multiple Claude sessions run against this repo at once. Two
# sessions sharing the main checkout fight over HEAD — on 2026-07-24 one session
# switched the shared working dir onto its branch twice and a commit landed on
# the wrong branch, and on 2026-07-27 two sessions committed to the same feature
# branch within the same hour. A worktree gives each session its own HEAD.
#
# Branches from origin/main, not from wherever the main checkout happens to be
# sitting. Symlinks .env and node_modules, which git does not carry into a fresh
# worktree, so scripts and tests run immediately.
#
set -euo pipefail

# Resolve the MAIN checkout, not wherever this script happens to be running from.
# Every worktree shares one common git dir, and its parent is the main checkout —
# so this stays correct when the script is invoked from inside a worktree, which
# would otherwise nest worktrees inside worktrees.
MAIN_REPO="$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)"
NAME="${1:-}"
BRANCH="${2:-feature/$NAME}"

if [ -z "$NAME" ]; then
  echo "usage: scripts/new-worktree.sh <name> [branch-name]" >&2
  echo "example: scripts/new-worktree.sh gift-box-lander feature/gift-box-lander" >&2
  exit 1
fi

# Reject anything that would escape the worktrees directory.
case "$NAME" in
  */*|.|..) echo "error: <name> must be a plain directory name, got '$NAME'" >&2; exit 1 ;;
esac

DEST="$MAIN_REPO/.claude/worktrees/$NAME"

if [ -e "$DEST" ]; then
  echo "error: $DEST already exists. Pick another name, or remove it with:" >&2
  echo "  git -C '$MAIN_REPO' worktree remove '$DEST'" >&2
  exit 1
fi

if git -C "$MAIN_REPO" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "error: branch '$BRANCH' already exists. Pass a different branch name." >&2
  exit 1
fi

echo "Fetching origin so the worktree branches from current main..."
git -C "$MAIN_REPO" fetch origin --quiet

git -C "$MAIN_REPO" worktree add "$DEST" -b "$BRANCH" origin/main

# Gitignored files do not exist in a fresh worktree. Symlink rather than copy:
# .env must stay a single source of truth, and node_modules is ~hundreds of MB.
for f in .env node_modules; do
  if [ -e "$MAIN_REPO/$f" ]; then
    ln -s "$MAIN_REPO/$f" "$DEST/$f"
    echo "  linked $f"
  else
    echo "  warning: $MAIN_REPO/$f not found — skipped" >&2
  fi
done

cat <<EOF

Worktree ready.

  cd $DEST
  git branch --show-current    # $BRANCH

Commit here, open a PR from here, and leave the main checkout alone. When the
PR has merged:

  git -C "$MAIN_REPO" worktree remove "$DEST"
EOF
