# Spin-off prompt — separate authored post copy from machine-written state

Feed everything below the line to a fresh Claude Code instance in this repo.

---

Separate authored post copy from machine-written post state in the SEO Claude repo
(/Users/seanfillmore/Code/Claude), so a deploy can never again collide with cron-written
metadata.

Read CLAUDE.md first — especially "Deploy hygiene", the post-meta reconcile section, and
the non-negotiable development rules (branch, PR, worktree; never work in the main checkout).

## Why this exists

data/posts/<slug>/meta.json is TRACKED IN GIT and also rewritten continuously by cron on the
production server. On 2026-08-23 that collision fired twice in one day and both times left
INVALID JSON on production:

  - PR #629 (rejected-keywords.json): `git stash pop` conflicted -> 20 conflict markers,
    invalid JSON, live.
  - PR #634 (five meta.json): pull aborted; stash/pull/pop -> all five conflicted, invalid
    JSON, live. And NEITHER SIDE WAS CORRECT — git's copy lacked indexing_state,
    indexing_submissions, published_at and shopify_status: published, including a backfill
    run hours earlier. It had to be resolved field by field, by hand.

PR #637 shipped lib/post-meta-reconcile.js + scripts/reconcile-post-metas.mjs as a three-way
per-field merge with an ownership table, and rewrote the deploy procedure so git is never
asked to text-merge those paths. PR #646 added a daily drift detector (12:40 UTC) and fixed
agents/blog-post-writer, which was destroying 23 distinct meta fields on every redraft —
including legacy_locked on 21 posts, silently unlocking protected winners.

Those work, but their own recorded conclusion is that they are PATCHES. The durable fix is
separating the two kinds of data.

## The shape of the fix

meta.json currently mixes ~6 authored fields with ~50 machine-written ones:

  - Repo-owned (a human authors, a deploy exists to ship): slug, title, meta_description,
    target_keyword, tags, post_type
  - Server-owned (a machine observes or stamps): Shopify identity and publish state,
    indexing_*, legacy_*, refresh/rebuild stamps, needs_rebuild, blocked_resolution, image
    records, word_count, generated_at, brief_path, tokens_used, republished_at,
    republish_reason

Move the server-owned set into a gitignored sibling (state.json is the proposed name),
leaving meta.json as reviewable authored content. After that a pull can never collide.

lib/post-meta-reconcile.js ALREADY holds the derived ownership table — 27 writers
inventoried, 40 keys censused — plus AUTHORED_BY, which maps an agent to the fields it
produces. That is the authority. Do not re-derive it from scratch; verify it, extend it if
you find a writer it missed, and use it.

Note the two axes are different and both are needed: FIELD_OWNERS answers "in a deploy
conflict, whose value wins", AUTHORED_BY answers "which fields does this agent produce".
They disagree in both directions — post_type is repo-owned but no agent authors it;
word_count/generated_at/brief_path/tokens_used are server-owned stamps that blog-post-writer
rewrites every draft.

## Scale and hazards

~200 post directories. 27 writers across agents/, lib/, scripts/ and the dashboard. Every
getPostMeta() reader. Specific traps:

  - shopify_status has SIX independent writers.
  - data/posts is partly server-authoritative: the LOCAL checkout is routinely stale or
    different from production. Verify against the server (ssh root@137.184.119.230,
    READ-ONLY) — a prior agent's verification was wrong because it tested the local corpus.
  - Some local content.html files are wholly DIFFERENT, OLDER articles than what is live.
    Do not assume local mirrors live for anything.
  - Migration must be idempotent, reversible, and safe to run WHILE cron is writing. The
    server writes these files continuously; a migration that assumes a quiet filesystem will
    lose data.
  - Every reader in the fleet `catch {}`s a parse failure and carries on as though the file
    were empty — so a broken migration is invisible rather than loud.

## What I want from you

Do NOT start editing. First produce a written plan covering:

  - the exact field split, verified against the ownership table AND the live corpus
  - the migration script's design, including how it handles concurrent cron writes
  - the compatibility strategy for ~27 writers and every reader (big-bang vs a shim period)
  - the rollback path
  - what you would verify on production before and after

Then check in before executing.

Non-negotiable: work in a git worktree (scripts/new-worktree.sh <name>), branch from
origin/main, TDD with tests under tests/ run via node --test on Node 22 (check the
`cancelled` count, not just `fail`), update CLAUDE.md in the same commit, and merge only via
PR. Never `git stash --include-untracked` on the server; never `git reset --hard` with a
dirty tree.
