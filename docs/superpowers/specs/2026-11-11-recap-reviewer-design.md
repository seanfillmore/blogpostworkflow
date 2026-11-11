# Recap Reviewer: fix everything before Sean reads the morning email

Date: 2026-11-11. Status: design, awaiting approval.

## Why

Sean, verbatim: *"I shouldn't see errors or anything didn't work. The agent should review and fix whatever needs fixing. I should see a summary of what is working and how we can grow the business."* And: *"If there are posts that are underperforming, it sends them to get repaired or deleted."*

The 13:00 UTC daily recap (`agents/daily-summary`) currently hands Sean homework. The 2026-11-10 recap carried:

- a "Needs your decision" item: an SEO rewrite stuck 16 days ("the editor gate failed 3 times, rewrite it, or write it off");
- five "Underperforming posts" labelled "merge or remove" (all `LOW_DEMAND`: under 200 impressions and at most 1 click in 90 days). Nothing in the fleet acts on that label;
- an "Action Required" hard-blocked draft (`lume-deodorant-alternative`).

On days with failures it also carries a red Failures block. For example, 2026-11-09 had `Creator outreach failed` (twice) and `Scheduler heartbeat — died`. The recap already contains a good "What's Working" block, which proves the useful half exists.

The fleet detects problems well and then waits for a human. The fix is an agent that does the waiting-for-a-human part itself.

## Goals

1. A **reviewer agent** (`agents/recap-reviewer`) runs every morning **before** the recap. It reads the same inputs the recap reads and resolves every item that would otherwise ask Sean to act.
2. **Failures get fixed**:
   - a transient failure is re-run;
   - a code defect goes to an autonomous **Claude Code fix session** that writes the fix and tests it. When tests pass, the session **merges and deploys it without Sean's involvement** (Sean's decision, 2026-11-11).
3. **Underperforming posts get repaired or removed**:
   - pages with demand are refreshed (the existing auto-refresh path);
   - `LOW_DEMAND` pages are removed: redirected first, deleted second, backed up always.
4. **Stuck work is unstuck**: a fresh attempt, or written off with a record. Never a question to Sean.
5. **The recap becomes two parts**: **What's working** (revenue, movers, what got fixed overnight) and **How to grow** (a short, dollar-ranked list of concrete next moves drawn from data the fleet already holds).

## Non-goals

- Not a second monitoring system. It consumes what `notify()`, `checkSystemHealth()` and the agents' `latest.json` files already produce.
- Not a change to the `notify()` contract or to the other agents' severity rules.
- No changes to the Shopify theme (`theme/` is not deployed by `git pull`), Klaviyo, Meta, Google Ads or Amazon from the fix session.

## Anti-goals (failure even if it "works")

- **Hiding a broken thing.** Dropping an error row without fixing it is the worst outcome: it turns a visible failure into a silent outage. Every item the reviewer suppresses must carry a verified resolution, or it is still owed somewhere (see "Unresolved" below).
- **A fix session that weakens a guard to make an error go away.** Examples: editing a health-claim gate, the mirror-divergence refusal, a test assertion, a threshold, or `status: 'error'` → `'info'` to quiet a row. That is the opposite of a fix.
- **Deleting a page that earns money or carries a lock.**
- **Breaking production on deploy.** A bad auto-merge on a 961 MB box that runs a public dashboard and an unattended pipeline is worse than the error it fixed.

## How it works

### Schedule and ordering

- `recap-reviewer` runs at **11:00 UTC** daily (new cron variable `DAILY_RECAP_REVIEWER`, UTC fields only, no `TZ=` prefix). That leaves two hours before the 13:00 recap and four before the 15:00 scheduler. **Check `crontab -l` for a free minute** before installing it.
- It writes `data/reports/recap-reviewer/latest.json` (gitignored), which records each item, its route, its outcome and its evidence.
- `daily-summary` reads that file and renders from it (below). If the reviewer has not finished by 13:00, the recap waits up to **30 minutes**, polling for `latest.json` from today, then sends anyway using what exists. *(Builder's call on the exact mechanism; a done-marker file is fine.)*
- **Hard stop at 14:30 UTC** for anything the reviewer started, fix sessions included, so nothing overlaps the 15:00 scheduler on this RAM budget. Work still in progress is killed cleanly (worktree left for the next morning) and picked up the next day.

### What it reviews

The reviewer builds the same item list the recap would render, from the same code paths:
- error and warning rows in the window (`lib/digest-window.js`, after `dropRecoveredFailures`);
- `checkSystemHealth()` rows;
- `needs_decision[]` from the four reports;
- `post-performance` `action_required[]`;
- `findBlockedPosts()`.

**Refactor the recap's builders so both consume one item list, not two copies.**

### Routing table

| Item | Route | Verified by |
|---|---|---|
| Error row, transient (timeout, 429, `ECONNRESET`, 5xx, OOM kill) | Re-run that job's own command once (the `source` field on the row names the entry script; command lines come from `setup-cron.sh` / `scheduler.js`) | A non-error row from the same reporter after the re-run, i.e. `lib/digest-recovery.js`'s existing rule |
| Error row, repeats or is a code exception (`TypeError`, `ReferenceError`, stack trace, same error 2+ runs) | **Fix session** (below) | Fix deployed AND a re-run of the job succeeds |
| Stale data feed / stale report health row | Re-run the producing collector/agent | Freshness check passes |
| Scheduler heartbeat stuck/died | Died: nothing to kill, the next run happens; record. Stuck: **kill the stuck scheduler only if its last log line is older than 2 hours** (it is wedged, not mid-publish), then record. Orphaned Chrome: kill it. | Heartbeat check passes |
| Leftover git stash | Do not auto-pop (stash pop is how production JSON was corrupted twice). Fix session reconciles it using the documented procedure, or it is listed as unresolved | Stash list empty |
| `needs_decision` queue item the gate gave up on | One fresh regeneration by the producing agent; if that fails the gate, **dismiss** with the reason recorded on the item (never delete files) | Item no longer pending |
| Hard-blocked **draft** (not live) | `content-remediator` / regenerate through the pipeline once; if still blocked, take it off the calendar into the existing `_dropped`/`_orphaned` move-not-delete archives with a sidecar | No longer in `findBlockedPosts()` |
| Flop `auto-refresh` / `locked` / `not-indexed` | Already automated, so just count it | n/a |
| Flop `demote` | Refresh via `refresh-runner <slug>` | Queued/published |
| Flop `no-demand` (LOW_DEMAND) | **Remove** (below), max **5 per run** | URL returns 301 to the target |

### Removing a low-demand post

A page qualifies only if it meets **all** of the following:
- `LOW_DEMAND` at the 90-day milestone;
- **not** `legacy_locked` (read through `lib/post-lock.js`);
- not in a CTR wave (`lib/ctr-protected.js`);
- **zero** entry-page orders ever in the Shopify snapshots;
- not the winner of a cannibalization pair.

Steps, in this order:
1. Back up the live article (`body_html`, title, tags, metafields) to `data/backups/removed-posts/<slug>-<date>.json`.
2. Pick the redirect target. The model chooses **by number** from a closed list of live pages in the same cluster: PDP, then collection, then the strongest sibling post (the same pattern as `tech-seo-steward`). The target must answer 200.
3. Create the 301 **before** the delete. A redirect on an occupied path lies dormant, so there is no 404 window.
4. Delete via `lib/post-kill.js` (which archives the brief rather than deleting it).
5. Re-run `scripts/fix-redirect-links.mjs --apply` so internal links point at the target. This runs on the server, which is where the reviewer runs.
6. Verify that the old URL 301s to the target and the target returns 200.

Merging (folding the unique content into the target) is **not** done here. A merge is a body rewrite of a ranking page, which the one-change-per-page rule (`lib/post-edit-gate.js`) and the winner lock exist to prevent. At under 200 impressions there is nothing worth merging.

### The fix session

Runs at most **one session per morning**, on the highest-impact unresolved code error. Further errors wait for the next day.

1. Create a worktree from `origin/main` on the server (`scripts/new-worktree.sh fix-<source>-<date> fix/recap-<source>-<date>`).
2. Spawn `~/.local/bin/claude -p` **with tools** (this is not the bare subscription transport; it is a real agentic session). The prompt carries:
   - the error row;
   - the last 200 lines of the job's log;
   - the job's command;
   - the rules below, verbatim.

   Allowed tools: Read, Edit, Write, Grep/Glob, and Bash limited to `node`, `npm test`, `git` (inside the worktree). No web fetch, no `ssh`, no `curl` to Shopify. Time limit **45 minutes**.
3. Rules the session must follow (enforced afterwards by checks, not only stated in the prompt):
   - The diff may not touch `data/`, `.env`, `config/` facts files, `theme/`, `scripts/setup-cron.sh`, or any `tests/` assertion it did not add. **No deleted or `skip`ped tests.**
   - The diff may not touch the gate modules: `agents/ad-studio/health-claims.js`, `lib/seo-copy-health-gate.js`, `lib/product-category-terms.js`, `lib/content-mirror.js`, `lib/post-lock.js`, `lib/post-edit-gate.js`, `lib/cluster-hold.js`. A failure caused by a gate correctly refusing something is **not a code defect**. The session must say so and stop.
   - The diff may not change a `status:` value in a `notify()` call.
   - The diff is capped at **300 changed lines**.
   - It must add a test that fails before the fix and passes after.
4. Checks run by the reviewer, not the session:
   - the diff passes the path/size rules;
   - `npm test` passes in the worktree with **0 failed and 0 cancelled** (the cancelled count matters; see the Node 22 note in CLAUDE.md);
   - the failing job, re-run **dry** from the worktree where it has a dry mode, no longer throws.
5. Merge and deploy:
   - push the branch, then open the PR and merge it (merge commit, not squash) via the GitHub REST API. `gh` is not installed on the server; the token comes from `GITHUB_TOKEN` in `.env`. *(Builder: the token currently sits in the remote URL; move it.)*
   - deploy using the **documented safe deploy sequence** (post-meta snapshot → checkout meta.json → pull → reconcile → `pm2 restart seo-dashboard`). Never `stash`, never `reset --hard`.
6. Post-deploy verification: re-run the failing job for real. If it fails, or `seo-dashboard` is not `online` after restart, **revert the merge commit via a revert PR, merged and deployed the same way**, and mark the item unresolved.
7. The PR body records the error, the diagnosis, the test added and the verification output, so there is an audit trail in git even though Sean never reviews it.

Work that is external-only (an expired token, a missing Shopify scope, the LWA rotation, a billing issue) cannot be fixed by code. The session must recognise it and stop. See "Unresolved".

### Unresolved items (the honest residual)

Anything the reviewer could not verify as fixed is **not dropped**. It goes into a single short block at the **bottom** of the recap: "Still being worked on: N". Each entry is one line: what, since when, and what was tried. It is phrased as status, not as a request.

The exception is items only Sean can do (renew a token, grant a scope). Those appear as **"One thing only you can do"** with the exact steps. That is the only kind of request the recap may contain.

*(Builder: this residual is what keeps the anti-goal "hiding a broken thing" from happening. It must never be empty because the reviewer crashed. If the reviewer itself fails, the recap falls back to today's behaviour and says the reviewer did not run.)*

### The new recap

Order:
1. **What's working.** The existing "What's Working" block (organic revenue, top pages, sold by category), rank movers, change verdicts and A/B results, plus a new **"Fixed overnight"** line. That line is a compact list of what the reviewer resolved: "Re-ran creator-outreach (recovered)", "Fixed `creator-outreach` crash, PR #NNNN deployed", "Removed 3 low-demand posts → 301s to /products/coconut-oil-toothpaste…", "Refreshed 2 posts".
2. **How to grow.** Three to five recommendations from one `flagship` model call. Each one names:
   - the move;
   - the evidence (numbers quoted from the inputs, never invented, checked in code the way `ad-batch` meta-copy numbers are);
   - an estimated dollar range, labelled directional;
   - whether an agent is already doing it or it needs a decision.

   Inputs: `seo-impact/latest.json` (including "Traffic, no sales" pages and cluster efficiency), quick-wins, gsc-opportunity, CTR program wave, Google Ads and Meta campaign summaries where available, commercial CVR, AOV baseline. Recommendations go through the commercial claim gate (they may quote copy ideas). **Recommendations are suggestions in the email; the reviewer does not execute them.**
3. **Still being worked on** / **One thing only you can do**, if non-empty.

The Failures, Needs your decision, Underperforming posts and Action Required blocks are removed from the email. Their content is either resolved (shown in "Fixed overnight") or residual (shown in block 3).

## Constraints

- Every LLM call goes through `lib/anthropic.js` and uses tiers from `config/llm-models.js`. The fix session is the one exception: it spawns the CLI with tools directly, which needs its own small module, and it must also strip `ANTHROPIC_API_KEY` from the child env.
- RAM: one Claude process at a time. The reviewer must not run its own LLM calls while a fix session is running.
- `notify()` for the reviewer's own run is **deferred**. Its own crash is the only `immediate: true`, because a dead reviewer means Sean gets the old-style recap with no explanation otherwise.
- `isDirectRun` guard; pure decision logic in `lib/recap-review.js` (routing, eligibility for removal, diff-rule checks) so it is testable without running anything.
- Dry by default on the CLI, `--apply` on cron, the same as every other agent here.
- Update CLAUDE.md (recap section and a new reviewer section) and `scripts/setup-cron.sh` in the same PR. Verify the cron mirror afterwards.

## Decided by Sean

- The reviewer fixes, it does not report: no errors and no decisions in the recap.
- Underperforming posts are repaired or deleted.
- Code defects get an autonomous Claude Code fix session that **merges and deploys** without Sean's review.

## My calls (Sean to check)

1. Low-demand "delete" means **301 to the closest live page, then delete, with a backup**, capped at 5 a day, never touching a locked, CTR-protected or ever-converting page. Merging content is not done.
2. **One fix session per morning**, 45-minute limit, 300-line diff cap, gate modules and tests off-limits, and an automatic revert if the post-deploy re-run fails.
3. Items that can't be fixed are not hidden. They go in a short "Still being worked on" block at the bottom. Things only Sean can do (renewing a token) appear as "One thing only you can do" with steps.
4. Timing: reviewer at 11:00 UTC, recap still at 13:00 (waits up to 30 min), and everything stops by 14:30 to stay clear of the 15:00 pipeline.
5. "How to grow" is advice only; nothing in it is executed automatically.
6. A stuck queue item gets one regeneration, then is dismissed with a record. A blocked draft gets one remediation, then is archived (move, never delete).

7. **The fix session gets no credentials.** Its worktree is created **without** the `.env` symlink (and with `ANTHROPIC_API_KEY` stripped; the CLI auth comes from its own config). A Bash-allowed session holding production keys could write to Shopify or send email through `node`, so the tool restriction alone is not a boundary. Tests must pass without credentials, as they already do locally. The "dry re-run from the worktree" check applies only to jobs that start without credentials; for the rest, the post-deploy real re-run is the verification.
8. **Re-runs are limited to an allowlist of side-effect-safe jobs.** These are collectors, reports, gates and analysis agents. Jobs that send or post (`creator-outreach`, `press-outreach`, `ugc-reels`, `social-poster`, `instagram-dm`, `founder-notes --send`, anything Klaviyo/Meta-sending) are **never re-run** by the reviewer, because a partial run could double-send. Their failures go to the fix session or wait for their next scheduled run. The post-deploy verification for them is that scheduled run, which is recorded the next morning.
9. **Deploying ships everything on `main`.** The fix branch is rebased onto the current `origin/main` and `npm test` runs on that combined state before merging. So any other merged-but-undeployed PRs are tested with it and deployed with it, which is what Sean's normal deploy does anyway. A post-deploy revert reverts only the fix commit, and the run record names the other commits that went out.
10. **`main` has no branch protection** (verified 2026-11-11 via the GitHub API: "Branch not protected", 0 rulesets, merge commits allowed), so an API merge works. Nothing is relaxed to make it work.
11. **Leftover git stashes are never resolved automatically.** They almost always hold `data/` files, which the fix session may not touch, and stash pop is the procedure that corrupted production JSON twice. They go to "Still being worked on" with the stash's file list.
12. **"Ever converted" means any order in the full Shopify order history whose `landing_site` path is the post's URL**, checked through the Admin API. The store has a few hundred orders, so a full scan is cheap. Snapshots alone are not enough, because `attribution.orders[]` does not cover a post's whole life. If the order read fails, that post is not removed this run.
13. **"Cannibalization winner"** means the post is a winner in the latest `data/reports/cannibalization` report, or is the target of any existing redirect in Shopify's redirect table (something already points at it). Either one excludes it.
14. **No merge starts after 13:45 UTC.** Once a merge starts, merge → deploy → verify → (revert) runs to completion and is exempt from the 14:30 kill. The kill applies only to a session still writing code, so production is never left half-deployed.

## Left to the builder

- Exact log-classification rules for "transient" vs "code defect" (start with the patterns listed; record misroutes).
- The shape of `latest.json` and the done-marker.
- Prompt wording for the fix session and the growth call, within the rules above.
- The split between `agents/recap-reviewer/index.js` and `lib/recap-review.js`.
