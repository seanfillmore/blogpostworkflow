# Recap Reviewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A morning agent that resolves everything the daily recap would ask Sean to act on (re-runs, fix-and-deploy sessions, post repair/removal, unsticking queued work), and a recap rebuilt as "What's working" + "How to grow".

**Architecture:** Pure decision logic lives in `lib/recap-*.js` and `lib/fix-*.js` (testable without I/O); `agents/recap-reviewer/index.js` orchestrates with injected dependencies and writes `data/reports/recap-reviewer/latest.json`; `agents/daily-summary` renders from that file. Code defects go to a `claude -p` session with tools in a credential-free worktree, gated by deterministic diff rules and the full test suite, then merged through the GitHub REST API and deployed with the documented safe sequence.

**Tech Stack:** Node 22 ESM, `node --test`, Shopify Admin REST via `lib/shopify.js`, GitHub REST API via `fetch`, Claude Code CLI 2.1.288 on the server.

**Spec:** `docs/superpowers/specs/2026-11-11-recap-reviewer-design.md`. Read it first; "My calls" 1-14 in it are binding.

## Global Constraints

- Every LLM call except the fix session goes through `lib/anthropic.js`, with model tiers from `config/llm-models.js`. Never hardcode a model ID, and never import `@anthropic-ai/sdk`.
- Growth recommendations use the `flagship` tier. Redirect-target picks use `fast`.
- Every entry point uses `isDirectRun(import.meta.url)`. It is dry by default on the CLI; `--apply` is what cron passes.
- `notify()` is deferred. Only the reviewer's own crash handler uses `immediate: true`.
- Schedule: the reviewer runs at `5 11 * * *` UTC, with no `TZ=` prefix (verify the minute is free with `crontab -l`; at plan time 11:00, 11:30, 11:45 and 11:50 are taken).
- Time limits:
  - the recap waits up to 30 minutes after 13:00 for the reviewer;
  - nothing new starts after 14:30 UTC;
  - no merge starts after 13:45 UTC;
  - a fix session is capped at 45 minutes and runs at most once per run;
  - the fix diff is capped at 300 changed lines.
- Removals: at most 5 per run, 301 redirect before delete, backup to `data/backups/removed-posts/<slug>-<YYYY-MM-DD>.json`.
- The fix session gets NO `.env` and NO `ANTHROPIC_API_KEY`.
- Never `git stash`, `git reset --hard` or stash pop anywhere in this code.
- `data/reports/recap-reviewer/` is gitignored. Add it and pin it in `tests/repo/server-reports-untracked.test.js`'s style.

## Review Focus

1. **The reviewer did not run, crashed, or left yesterday's `latest.json`.** The recap must fall back to today's old-style blocks and say "the reviewer did not run". It must never render as an all-clear. (Task 9 test.)
2. **The same failure appears in several rows** (e.g. `Creator outreach failed` twice on 2026-11-09). It should become ONE item, with one re-run and one fix session. (Task 1 test.)
3. **An error row with no `source`** (rows written before `lib/notify.js` stamped one) cannot be re-run. It must still be routed (fix session by stem, or residual), never dropped. (Task 1 test.)
4. **A fix session returns no diff, or says the failure is a gate correctly refusing, or says it is external.** Nothing is merged, and the item goes to residual carrying the session's own one-line explanation. (Task 6 test.)
5. **A removal candidate whose redirect pick is unparseable, whose target does not return 200, or whose order-history read failed.** That post is not removed this run and is reported as skipped with the reason. (Task 3 and Task 7 tests.)

---

### Task 1: Review items and failure classification (`lib/recap-review.js`)

**Files:**
- Create: `lib/recap-review.js`
- Test: `tests/lib/recap-review.test.js`

**Interfaces:**
- Consumes: `subjectStem` from `lib/digest-recovery.js`.
- Produces:
  - `itemKey(row) -> string`: `${source||''}|${category||''}|${subjectStem(subject)}`.
  - `classifyFailure(row, { priorDays = [] }) -> 'external'|'code'|'transient'`. `priorDays` are earlier-day rows with the same key.
  - `buildReviewItems({ errorRows, healthIssues, needsDecision, flops, blockedDrafts }) -> ReviewItem[]`, where `ReviewItem = { key, kind: 'failure'|'health'|'decision'|'flop'|'blocked-draft', route, subject, detail, source, row }`. `route` is one of `'rerun'|'fix-session'|'only-you'|'collector-rerun'|'heartbeat'|'stash-residual'|'regenerate'|'refresh'|'remove'|'count-only'|'remediate-draft'`.

- [ ] **Step 1: Write failing tests.** Include all of these:
  - `classifyFailure` returns `'external'` for bodies matching `/\b401\b|\b403\b|invalid[_ ]?(api[_ ]?)?(key|token)|expired|access denied|missing scope|unauthori[sz]ed|refresh token|LWA/i`. External takes precedence even when a stack trace is present.
  - It returns `'code'` for `/TypeError|ReferenceError|SyntaxError|is not a function|Cannot read propert|is not defined/`.
  - It returns `'transient'` for `/ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|timed? ?out|\b429\b|rate limit|\b50[234]\b|SIGKILL|out of memory/i`.
  - An unmatched row returns `'transient'` the first time and `'code'` when `priorDays` holds the same key on 2+ distinct UTC days.
  - `buildReviewItems` collapses two rows with the same `itemKey` into one item.
  - A row with no `source`:
    - classified `code` → `route: 'fix-session'`;
    - classified `transient` → `route: 'rerun'`, and the rerun later finds no command (Task 2), which leaves it residual. It is not dropped.
  - `external` → `'only-you'`.
  - Flops map `auto-refresh|locked|not-indexed` → `'count-only'`, `demote` → `'refresh'`, `no-demand` → `'remove'`.
  - Decisions from `amazon-account-health` → `'only-you'`; every other source → `'regenerate'`.
  - Health issues map by title: a feed or report freshness row → `'collector-rerun'`, a stash row → `'stash-residual'`, a freeze follow-up → `'only-you'`.
- [ ] **Step 2: Run** `node --test tests/lib/recap-review.test.js`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the three exports, pure with no I/O.
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(recap-reviewer): review items and failure classification`

### Task 2: Job commands and the re-run allowlist (`lib/recap-jobs.js`)

**Files:**
- Create: `lib/recap-jobs.js`
- Test: `tests/lib/recap-jobs.test.js`

**Interfaces:**
- Produces:
  - `parseCrontab(text) -> Map<source, { schedule, command }>`. Parse each non-comment line's `node <script> <args>` up to `>>`. Key on the repo-relative script path (`agents/x/index.js`, `scripts/y.mjs`). The command keeps its args, with `>> log` stripped.
  - `isRerunnable(source) -> boolean`.
  - `NEVER_RERUN: ReadonlySet<string>`.
  - `collectorFor(healthTitle) -> source|null`, mapping each `checkSystemHealth` feed/report to its producer script.

- [ ] **Step 1: Write failing tests.**
  - Parse three real lines copied from `scripts/setup-cron.sh` with `$NODE` → `/usr/bin/node` and `$PROJECT_DIR` substituted, as they appear in `crontab -l`.
  - The `isRerunnable` allowlist is: `scripts/check-*.mjs`, any `*-collector` agent, `agents/rank-tracker`, `agents/post-performance`, `agents/seo-impact`, `agents/gsc-opportunity`, `agents/quick-win-targeter`, `agents/indexing-checker`, `agents/keyword-index-builder`, `agents/trybe-review` (read-only reporting, never approves). Every other source returns `false`.
  - `NEVER_RERUN` contains at least `agents/creator-outreach/index.js`, `agents/press-outreach/index.js`, `agents/ugc-reels/index.js`, `agents/social-poster/index.js`, `agents/instagram-dm/index.js`, `agents/founder-notes/index.js`, `agents/amazon-review-requests/index.js`, `agents/publisher/index.js`, `agents/calendar-runner/index.js`, `agents/meta-optimizer/index.js`, `agents/queue-autoapply/index.js`.
  - `isRerunnable` is `false` for every `NEVER_RERUN` entry, even one that matches an allowlist pattern.
  - `collectorFor`: before choosing producers, read `checkSystemHealth()` in `agents/daily-summary/index.js` and `setup-cron.sh` for each feed's producer. Pin every mapping in the test. An unknown title maps to `null`.
- [ ] **Step 2: Run** `node --test tests/lib/recap-jobs.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(recap-reviewer): job command map and rerun allowlist`

### Task 3: Low-demand removal eligibility (`lib/low-demand-removal.js`)

**Files:**
- Create: `lib/low-demand-removal.js`
- Test: `tests/lib/low-demand-removal.test.js`

**Interfaces:**
- Consumes: `handleOf` from `lib/ctr-protected.js`; `buildChoiceList` and `parseChoice` from `lib/tech-seo-steward.js` (reused for the by-number pick).
- Produces:
  - `convertedPaths(orders) -> Set<string>`: pathnames of each order's `landing_site`, with query and trailing slash stripped.
  - `cannibalizationWinners(report) -> Set<handle>`: for each `conflicts[]`, the handle of the URL with the most `impressions`.
  - `removalEligibility(row, { lockState, ctrHandles, converted, winners, redirectTargets, ordersOk }) -> { ok: boolean, reason: string }`.
  - `removalCandidates(flops, ctx, { limit = 5 }) -> { take: Row[], skipped: {slug, reason}[] }`.

- [ ] **Step 1: Write failing tests.** `removalEligibility` refuses each of the following, each with a distinct reason string:
  - `lockState` is `locked` or `unreadable` (via `lib/post-lock.js` constants);
  - the handle is in `ctrHandles`;
  - the `/blogs/news/<handle>` path is in `converted`;
  - the handle is in `winners`;
  - the path is the target of an existing redirect (`redirectTargets`);
  - `ordersOk === false`, with reason `order history unreadable`;
  - `row.action !== 'no-demand'`.

  An eligible row returns `{ ok: true }`. `removalCandidates` caps `take` at 5, in the input order, and lists the rest as skipped with reason `cap`. `convertedPaths` maps `'/blogs/news/foo?utm=x'` and `'https://www.realskincare.com/blogs/news/foo/'` to `/blogs/news/foo`.
- [ ] **Step 2: Run** `node --test tests/lib/low-demand-removal.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(recap-reviewer): low-demand removal eligibility`

### Task 4: Fix diff rules (`lib/fix-diff-rules.js`)

**Files:**
- Create: `lib/fix-diff-rules.js`
- Test: `tests/lib/fix-diff-rules.test.js`

**Interfaces:**
- Produces:
  - `checkFixDiff({ numstat, patch }) -> { ok: boolean, problems: string[] }`. `numstat` is the output of `git diff --numstat origin/main...HEAD`, and `patch` is the unified diff.
  - `FORBIDDEN_PATHS` and `GATE_FILES`.

- [ ] **Step 1: Write failing tests.** Each of the following is a separate problem:
  - touching a path under `data/`, `.env*`, `theme/`, `config/` (the whole directory), or `scripts/setup-cron.sh`;
  - touching any of `agents/ad-studio/health-claims.js`, `lib/seo-copy-health-gate.js`, `lib/product-category-terms.js`, `lib/content-mirror.js`, `lib/post-lock.js`, `lib/post-edit-gate.js`, `lib/cluster-hold.js`;
  - more than 300 added+deleted lines in total;
  - no added or modified file under `tests/`;
  - a deleted file under `tests/`;
  - a removed line under `tests/` containing `assert`;
  - an added line containing `.skip(`, `{ skip`, `test.todo` or `it.todo`;
  - an added or removed line matching `/status:\s*['"]/` inside the patch (a `notify` status change);
  - an empty diff, with problem `no change`.

  A 40-line fix to `agents/x/index.js` plus a new test file passes.
- [ ] **Step 2: Run** `node --test tests/lib/fix-diff-rules.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(recap-reviewer): deterministic fix diff rules`

### Task 5: The fix session (`lib/fix-session.js`)

**Files:**
- Create: `lib/fix-session.js`
- Test: `tests/lib/fix-session.test.js`

**Interfaces:**
- Consumes: `childEnv` from `lib/claude-subscription.js`.
- Produces:
  - `createCleanWorktree(name, { exec, root }) -> worktreePath`. It runs `git fetch origin`, then `git worktree add -b fix/recap-<name> .claude/worktrees/fix-<name> origin/main`, then symlinks `node_modules` only. It **never** links `.env`.
  - `buildFixPrompt({ item, logTail, command }) -> string`.
  - `runFixSession({ worktree, prompt, spawnImpl, timeoutMs = 45*60_000 }) -> { exitCode, verdict: 'fixed'|'gate'|'external'|'no-fix', summary }`.

  The CLI argv must be exactly: `-p <prompt> --output-format json --permission-mode acceptEdits --allowedTools "Read,Edit,Write,Grep,Glob,Bash(node:*),Bash(npm test:*),Bash(git diff:*),Bash(git status:*),Bash(git add:*),Bash(git commit:*)"`. `cwd` is the worktree. The env comes from `childEnv()` with `ANTHROPIC_API_KEY` removed and no `.env`-derived Shopify, Klaviyo or Hushmail keys (start from a minimal env: `HOME`, `PATH`, plus `childEnv`'s token).

  The prompt instructs the session to end with exactly one line, `VERDICT: fixed|gate|external|no-fix — <one sentence>`, which `runFixSession` parses. A missing line means `no-fix`.

- [ ] **Step 1: Write failing tests**, using a fake `spawnImpl` that records argv, cwd and env, and a fake `exec`:
  - the argv equals the list above;
  - the env has no `ANTHROPIC_API_KEY`, `SHOPIFY_*`, `KLAVIYO_*` or `HUSHMAIL_*` keys even when the parent env has them;
  - `createCleanWorktree` never issues a command containing `.env`;
  - the prompt contains the spec rules verbatim: the forbidden paths, the gate files, "a failure caused by a gate correctly refusing is not a code defect", "add a test that fails before the fix", and the VERDICT line format;
  - the timeout kills the child and returns `verdict: 'no-fix'` with summary `timed out`;
  - a reply with no VERDICT line returns `no-fix`.
- [ ] **Step 2: Run** `node --test tests/lib/fix-session.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(recap-reviewer): credential-free claude fix session`

### Task 6: Ship a fix: test, merge, deploy, verify, revert (`lib/fix-ship.js`, `lib/github-pr.js`, `scripts/deploy-server.sh`)

**Files:**
- Create: `lib/github-pr.js`, `lib/fix-ship.js`, `scripts/deploy-server.sh`
- Test: `tests/lib/github-pr.test.js`, `tests/lib/fix-ship.test.js`, `tests/scripts/deploy-server.test.js`

**Interfaces:**
- Consumes: `checkFixDiff` (Task 4).
- Produces:
  - `createPullRequest({ token, head, title, body, fetchImpl }) -> { number, url }`, against `seanfillmore/blogpostworkflow`, base `main`.
  - `mergePullRequest({ token, number, fetchImpl }) -> { sha }`, with `merge_method: 'merge'`.
  - `shipFix({ worktree, item, session, now, exec, gh, deploy, rerun, token }) -> { outcome: 'deployed'|'reverted'|'refused'|'too-late', pr?, problems?, otherCommits? }`.
  - `scripts/deploy-server.sh`: the CLAUDE.md "safe deploy" sequence, run locally on the server:
    1. reconcile gate;
    2. `SNAP=$(… --snapshot …)`;
    3. `git checkout -- "data/posts/*/meta.json"`, with the pathspec quoted;
    4. `git pull --no-rebase`;
    5. reconcile `--against "$SNAP" --apply`, joined with `;`;
    6. `pm2 restart seo-dashboard`;
    7. exit 1 if `pm2 jlist` does not show `seo-dashboard` `online` within 20 seconds.

  `shipFix` order:
  1. Refuse with `too-late` when `now` is after 13:45 UTC.
  2. `git rebase origin/main` (after a fresh fetch).
  3. `checkFixDiff`: on problems, `refused`.
  4. `npm test`: refuse unless the summary shows `# fail 0` AND `# cancelled 0`.
  5. Push the branch, then `createPullRequest`, whose body holds the error, the session summary, the test added and the test summary, and ends with the 🤖 Generated line.
  6. `mergePullRequest`.
  7. Record `otherCommits` (`git log --oneline <serverHEAD>..origin/main` minus the fix).
  8. `deploy()`.
  9. `rerun()` (the job's real command, or `null` when the job is in `NEVER_RERUN`; in that case verification is deferred to the next scheduled run and the outcome stays `deployed` with `verify: 'next-scheduled-run'`).
  10. If deploy or rerun fails: `git revert -m 1 <sha>` on a new branch `revert/recap-<name>`, then push, PR, merge and deploy the same way, and return `reverted`.

- [ ] **Step 1: Write failing tests**, with fake `exec`, `fetch`, `deploy` and `rerun`:
  - after 13:45 UTC → `too-late` and no `exec` calls;
  - `# cancelled 1` with `# fail 0` → `refused`;
  - a diff problem → `refused` with no push;
  - happy path → calls in order fetch, rebase, test, push, PR, merge, deploy, rerun, and returns `deployed`;
  - a rerun that fails → a revert branch, PR and merge, a second deploy, and `reverted`;
  - the `github-pr` tests assert the exact REST paths, `Authorization: Bearer <token>`, and `merge_method: 'merge'`;
  - `deploy-server.test.js` is a source scan asserting the quoted pathspec, the absence of `stash` and `reset --hard`, the `;` before `pm2 restart`, and the `pm2 jlist` online check.
- [ ] **Step 2: Run** `node --test tests/lib/github-pr.test.js tests/lib/fix-ship.test.js tests/scripts/deploy-server.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(recap-reviewer): merge, deploy, verify and auto-revert a fix`

### Task 7: The reviewer agent (`agents/recap-reviewer/index.js`)

**Files:**
- Create: `agents/recap-reviewer/index.js`, `agents/recap-reviewer/README.md`, `lib/recap-reviewer-state.js`
- Modify: `agents/daily-summary/index.js`. Export a pure `collectDigestInputs({ now, readLastSent })` that returns `{ entries, laterRows, healthIssues, postPerformance, blockedPosts, needsDecision }`, extracted from `main()` with no behaviour change, so the reviewer and the recap read the same thing. (This is the spec's "one item list, not two copies".)
- Test: `tests/agents/recap-reviewer.test.js`, `tests/lib/recap-reviewer-state.test.js`

**Interfaces:**
- Consumes: Tasks 1-6; `killPost`, `findArticleByHandle` from `lib/post-kill.js`; `createRedirect`, `getAllRedirects`, `getAllOrders` from `lib/shopify.js`; `readLockState` from `lib/post-lock.js`; `ctrProtectedHandles`; `generateGrowthRecs` (Task 8).
- Produces:
  - `runReview(deps, { apply, now }) -> Report`, written to `data/reports/recap-reviewer/latest.json`, with `done.json` touched at the end. `Report = { generated_at, date, apply, resolved: Outcome[], unresolved: Outcome[], onlyYou: Outcome[], counts, growth, fixSession: Outcome|null, skipped: {slug,reason}[] }` and `Outcome = { key, kind, subject, action, result, evidence, since? }`.
  - `lib/recap-reviewer-state.js`: `loadState`/`saveState` on `data/reports/recap-reviewer/state.json`, holding `firstSeen[key]`, `fixAttempts[key]` (stop spawning sessions for a key after 3), and `regenerated[queueItemId]`.

  Route execution, in this order:
  1. **Unit A (in order):** heartbeat, collector-rerun, rerun.
     - Heartbeat: read `scripts/check-scheduler-heartbeat.mjs --json`. On `stuck`, kill the pid only when the last scheduler log line is more than 2 h old. On `orphaned-browser`, kill those Chrome pids.
     - Re-runs: from the crontab map, only when `isRerunnable`, with a 20-minute timeout each.
     - Resolution is verified with `dropRecoveredFailures` semantics on the rows the re-run writes.
  2. **Unit B (in order):** refresh (`agents/refresh-runner/index.js <slug>`), regenerate, remediate-draft, remove.
     - Regenerate: the policy is one retry and then a close-out. Read each producer's `needs_decision` shape (`agents/queue-autoapply`, `agents/indexing-fixer`, `lib/indexing-escalation.js`, `agents/content-strategist`, `lib/duplicate-flag.js`) and implement one handler per source. The retry re-runs the producing step for that one item. The close-out marks the item dismissed or withheld in its producer's own file, with `closed_by: 'recap-reviewer'` and a reason. **A close-out never deletes a file and never publishes.** Pin each handler with a test.
     - Remediate-draft: `node agents/content-remediator/index.js --slug <slug>` once. If the draft is still blocked the next morning, move the post dir to `data/posts/_orphaned/` with a `<slug>.orphan.json` sidecar (match `scripts/rehome-orphan-refreshes.mjs`'s sidecar fields) and remove its calendar item into the calendar's existing `_dropped` archive.
     - Remove, per post:
       1. back up the article (body, title, tags, metafields);
       2. build choices with `buildChoiceList('blog', inventory)`, restricted to live pages in the same cluster (`clusterForText`);
       3. one `fast` call with the by-number prompt, then `parseChoice`;
       4. HEAD the target and expect 200;
       5. `killPost(slug, { reason: 'low-demand', redirectTo })`;
       6. verify that the old URL 301s to the target;
       7. after all removals, run `scripts/fix-redirect-links.mjs --apply` once.
  3. **Unit C:** at most one fix session, for the unresolved `fix-session` item with the most rows, where `fixAttempts < 3`. Create a clean worktree, then `runFixSession`, then `shipFix` when the verdict is `fixed`. On `gate`, `external` or `no-fix`, the item goes to unresolved (or `onlyYou` for `external`) with the session summary. Remove the worktree after a ship; leave it on a timeout.
  4. **Unit D:** `generateGrowthRecs` (Task 8). Skip it while Unit C's child is alive; run it after.
  5. Before each step, check `now() >= 14:30 UTC` and stop starting new work. Anything unstarted goes to unresolved with result `deferred to tomorrow`.
  6. One deferred `notify()` with counts. A crash calls `notify({ immediate: true, status: 'error' })` and still writes `latest.json` with `{ crashed: true }`.

- [ ] **Step 1: Write failing tests** for `runReview`, with every dependency injected and fakes recording calls:
  - two same-key rows → one rerun call;
  - a `NEVER_RERUN` source with a transient error → no rerun, and the item goes to unresolved with "waits for next scheduled run";
  - removal skips with a reason when `parseChoice` returns null, when the target HEAD is 404, or when `getAllOrders` throws, and `killPost` is not called for those;
  - the backup is written before `killPost`;
  - a fix session returning `gate` → no `shipFix`, and the item is unresolved with the summary;
  - `fixAttempts[key] === 3` → no session;
  - at 14:31 UTC no new steps start and unstarted items read `deferred to tomorrow`;
  - without `apply`, no rerun, kill, `killPost`, session or ship is invoked and the report is still written.
- [ ] **Step 2: Run** `node --test tests/agents/recap-reviewer.test.js tests/lib/recap-reviewer-state.test.js tests/agents/daily-summary.test.js`. Expected: the new tests FAIL; the daily-summary tests still PASS after extracting `collectDigestInputs`.
- [ ] **Step 3: Implement**, with `main()` behind `isDirectRun`, wiring real dependencies.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Dry run on the server.**

  ```
  ssh root@137.184.119.230 'cd ~/seo-claude && git fetch -q && git worktree add /tmp/rr origin/feature/recap-reviewer-design && cd /tmp/rr && ln -s ~/seo-claude/node_modules && ln -s ~/seo-claude/.env && node agents/recap-reviewer/index.js'
  ```

  Expected: a report listing routes for today's real items, with nothing applied. (Read the report path from its output; the run must not write under `~/seo-claude`.) Remove `/tmp/rr` afterwards.
- [ ] **Step 6: Commit.** `feat(recap-reviewer): orchestrating agent`

### Task 8: How-to-grow recommendations (`lib/growth-recs.js`)

**Files:**
- Create: `lib/growth-recs.js`
- Test: `tests/lib/growth-recs.test.js`

**Interfaces:**
- Consumes: `lib/anthropic.js` (`flagship`), `checkSeoCopyFields` from `lib/seo-copy-health-gate.js` (default commercial surface).
- Produces:
  - `gatherGrowthInputs(root) -> object`, reading only those of these that exist and are fresh per `lib/seo-impact-freshness.js` (seo-impact) or under 9 days old (the others): `data/reports/seo-impact/latest.json` (totals, clusters, efficiency, "traffic, no sales"), `quick-wins/latest.json`, `gsc-opportunity/latest.json`, `ctr-program/wave.json`, the newest Google Ads snapshot, `lib/commercial-cvr.js` output, and `AOV_TRAILING_90D` from `lib/business-baseline.js`.
  - `generateGrowthRecs({ inputs, client }) -> { recs: Rec[], dropped: {rec, reason}[] }`, where `Rec = { move, evidence, dollars_low, dollars_high, status: 'agent-doing'|'needs-decision' }`. Return 3-5 recs.
  - `growthRecProblems(rec, inputsText) -> string[]`. Every number in `evidence` must appear in `inputsText`; the claim gate runs over `move` + `evidence`; no em dashes.

  Generation: one retry naming the problems, then drop the failing recs. If fewer than 2 survive, return an empty list with the reason.
- [ ] **Step 1: Write failing tests**, with a fake client:
  - an invented number in `evidence` is dropped with the number named;
  - a rec saying "heals eczema" is dropped by the claim gate;
  - a malformed JSON reply gets one retry and then returns empty with a reason;
  - stale or missing inputs are omitted and listed in `inputs.missing`.
- [ ] **Step 2: Run** `node --test tests/lib/growth-recs.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** The prompt states: the Prime Directive (revenue, not traffic); dollars are a directional range and must be labelled so; each rec names whether an existing agent already does it; and the reply is a JSON array.
- [ ] **Step 4: Run the test.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(recap-reviewer): how-to-grow recommendations`

### Task 9: The new recap (`agents/daily-summary`)

**Files:**
- Modify: `agents/daily-summary/index.js`
- Test: `tests/agents/daily-summary.test.js` (extend)

**Interfaces:**
- Consumes: `data/reports/recap-reviewer/latest.json` and `done.json` (Task 7); `collectDigestInputs`; `classifyFailure`, `itemKey` and `isRerunnable`/`parseCrontab` from Tasks 1-2.
- Produces:
  - `loadReview({ today, read }) -> Report|null`. It returns null unless `generated_at` is today (UTC) and the report is not `crashed`.
  - `waitForReview({ deadlineMs = 30*60_000, poll, sleep })`.
  - `reconcileWithReview(entries, healthIssues, review) -> { visibleErrors: [], residual: Outcome[] }`. Error rows whose `itemKey` is in `review.resolved` are removed. Error rows newer than `review.generated_at` (late gates at 12:15-12:58) go through a quick pass: transient and rerunnable means re-run now, within the remaining wait budget; everything else goes to residual as "picked up tomorrow morning".
  - `buildDigestHtml` gains a trailing `review` argument. When `review` is present the email has only:
    1. **What's working:** the existing seo-impact block, rank movers, change verdicts, A/B, and a "Fixed overnight" list from `review.resolved` (one line each, "N more" past 12).
    2. **How to grow:** `review.growth.recs`, each with evidence, dollar range labelled "directional", and status.
    3. **Still being worked on:** `review.unresolved` plus the quick-pass residual, one line each (what, since `firstSeen`, what was tried).
    4. **One thing only you can do:** `review.onlyYou`, plus the existing creator-review block (approving creative is Sean's).

    The Failures, Needs your decision, Underperforming posts and Action Required blocks, and the health block, do not render when `review` is present. The health-issue `notify({ status: 'error' })` side effect is skipped for issues the review resolved.
  - When `review` is null, render exactly today's email plus a first-line banner: "The overnight reviewer did not run; this is the unreviewed recap."
  - Subject line: `Daily Recap — <date> (<n> fixed overnight[, <m> still being worked on][, <k> for you])`. Use `all clear` when all three are zero.

- [ ] **Step 1: Write failing tests:**
  - with a review, the HTML contains none of `Failures`, `Needs your decision`, `Underperforming posts` or `Action Required`, and contains `What's working`, `How to grow`, and each resolved subject;
  - a review dated yesterday → the fallback banner and the old blocks;
  - a review with `crashed: true` → the fallback;
  - an error row newer than `generated_at` with a non-rerunnable source → in residual, not dropped;
  - a resolved key removes all of its rows;
  - the subject line format for the cases 0/0/0, 3/0/0 and 3/1/1.
- [ ] **Step 2: Run** `node --test tests/agents/daily-summary.test.js`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** In `main()`: `waitForReview` before collecting inputs, then `loadReview` and `reconcileWithReview`, then build. `--preview` still works and never waits.
- [ ] **Step 4: Run the full suite** with `npm test`. Expected: `# fail 0` and `# cancelled 0`.
- [ ] **Step 5: Preview on the server against today's data** (worktree as in Task 7 Step 5, after a dry reviewer run writes a report into the worktree's data dir):

  ```
  node agents/daily-summary/index.js --preview
  ```

  Read the rendered text and confirm the four sections and no error blocks.
- [ ] **Step 6: Commit.** `feat(daily-summary): render the reviewed recap`

### Task 10: Schedule, ops, docs, ship

**Files:**
- Modify: `scripts/setup-cron.sh` (add `DAILY_RECAP_REVIEWER="5 11 * * * cd \"$PROJECT_DIR\" && $NODE agents/recap-reviewer/index.js --apply >> data/reports/scheduler/recap-reviewer.log 2>&1"` and its line in the job list/install block)
- Modify: `.gitignore` (`data/reports/recap-reviewer/`, `data/backups/removed-posts/`, `.claude/worktrees/fix-*`)
- Modify: `CLAUDE.md`. Add a "Recap reviewer" section after the digest paragraphs, stating what it fixes, the fix-session rules and auto-merge (Sean's decision, 2026-11-11), the removal rule, and the residual blocks. Update the digest paragraph that describes the old sections.
- Modify: `tests/scripts/post-meta-drift-gate.test.js` is not needed; the existing "no `TZ=`" test covers the new line. Add the new cron var to whatever test pins the job list, if one exists.

- [ ] **Step 1:** Run `npm test`. Expected: `# fail 0` and `# cancelled 0`.
- [ ] **Step 2:** Re-derive the mirror-diff `sed` line number with `grep -n 'crontab -' scripts/setup-cron.sh`, run the CLAUDE.md mirror diff, and confirm the only difference is the new `>` line.
- [ ] **Step 3:** Open the PR from the worktree (`gh pr create`), merge it, and deploy with the documented safe sequence.
- [ ] **Step 4: Server ops** (once):
  1. Copy the token out of the remote URL into `.env` as `GITHUB_TOKEN=…`.
  2. `git remote set-url origin https://github.com/seanfillmore/blogpostworkflow.git`.
  3. `git config credential.helper store` with `~/.git-credentials` mode 600 holding the token.
  4. Verify with `git fetch`.
  5. Run `scripts/setup-cron.sh`.
  6. Re-run the mirror diff. Expected: empty.
- [ ] **Step 5:** Run `node agents/recap-reviewer/index.js` (dry) on the server and read the report. Then `--apply` once by hand, outside 15:00-15:30 UTC, and confirm in `latest.json` that the resolved items are verified. Then `node agents/daily-summary/index.js --preview` and read it.
- [ ] **Step 6:** Remove the worktree after the merge.
