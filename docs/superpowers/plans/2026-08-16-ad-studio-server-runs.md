# Ad Studio — Server Runs + Creation Inputs in the UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the production server the place Ad Studio runs happen, launched from a form in the dashboard's Ad Studio tab, with a live cost estimate before the button and live progress after it.

**Architecture:** The dashboard route writes a job file and spawns `agents/ad-studio/index.js --job-id <id>` as a **detached child process**; the agent writes its own structured progress into that job file, and the browser polls it. The agent is the only writer of a job file after creation — the route creates it once and reads thereafter — so there is no write race and no lock to orphan. Nothing about the existing CLI behaviour changes: with no `--job-id`, every progress write is a no-op.

**Tech Stack:** Node 22 LTS (ESM), `node --test` + `node:assert/strict`, zero-dependency vanilla browser JS in `agents/dashboard/public/`, the repo's existing tiny router (`agents/dashboard/lib/router.js`).

**Spec:** `docs/superpowers/specs/2026-08-14-ad-studio-ui-design.md` — read the **Reconciliation** section and the **Addendum, 2026-08-16** first; both win over the screen bodies.

**Worktree:** `.claude/worktrees/adstudio-server`, branch `feat/ad-studio-server-runs`. All work happens there. Never in the main checkout.

## Global Constraints

- **Node 22 LTS.** Run `nvm use` before testing. When reading `node --test` output, check the **cancelled** count as well as fail — a cancelled test prints alongside `# fail 0` and reads like a pass.
- **A Meta target bills TWO renders**, not one: the plate, then its derived comp (`agents/ad-studio/index.js:744` calls `budget.take()` for the comp). Every cost number in this plan follows from that.
- **Cost model.** Expected = `F × V × (2m + d)`. Worst case = `F × V × (3(m+d) + m)`. `F` = formats, `V` = variations, `m` = selected Meta ratios, `d` = selected Demand Gen ratios. `$0.13` per render.
- **`--targets meta`** resolves to 3 Meta ratios (1:1, 4:5, 9:16); **`--targets all`** to those 3 plus 3 Demand Gen ratios. Verified against `selectTargets` in `agents/ad-studio/packaging.js`.
- **Launch ceiling: 120 renders** (≈$15.60), clamped server-side regardless of what the form sends. Approved by Sean 2026-08-16.
- **Server creatives budget: 4 GiB** via `CREATIVES_BUDGET_BYTES`; the 10 GiB default stays for local. Approved by Sean 2026-08-16.
- **One run at a time.** A second launch gets HTTP 409 naming the active job.
- **Never echo `.env` or any API key into a response.** The agent reads `.env` itself; no route may surface it.
- **No format list, product list or ratio count is hardcoded in browser JS.** All of it is served from `GET /api/ad-studio/options`, so a tenth format needs no UI edit.
- **Commit after every task.** Branch `feat/ad-studio-server-runs`, PR at the end. Never commit to `main`.

---

### Task 1: The cost estimator

The number the whole setup screen exists to show. It lives in its own module because the launch route enforces a ceiling with it and the browser displays it, and because its arithmetic is the thing most likely to silently drift.

**Files:**
- Create: `lib/ad-studio-cost.js`
- Modify: `agents/ad-studio/index.js` (line ~49 — re-export the per-render price from the new module so `$0.13` has one home)
- Modify: `agents/ad-studio/README.md` (the Cost section — its table is stale for the same comp reason)
- Test: `tests/lib/ad-studio-cost.test.js`

**Interfaces:**
- Consumes: nothing. This module imports **nothing** — not even `packaging.js` — so it stays free to test and free to import. Callers resolve targets themselves and hand in the resolved array.
- Produces:
  - `USD_PER_RENDER: number` (0.13)
  - `countTargetKinds(targets: {platform: string}[]) => { meta: number, demandGen: number }`
  - `estimateRenders({ formats: string[], variations: number, targets: {platform:string}[] }) => { meta, demandGen, expected, worstCase, expectedUsd, worstCaseUsd }`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/ad-studio-cost.test.js`:

```js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { USD_PER_RENDER, countTargetKinds, estimateRenders } from '../../lib/ad-studio-cost.js';

const META = [
  { platform: 'meta', ratio: '1:1' },
  { platform: 'meta', ratio: '4:5' },
  { platform: 'meta', ratio: '9:16' },
];
const ALL = [
  ...META,
  { platform: 'demand-gen', ratio: '1.91:1' },
  { platform: 'demand-gen', ratio: '1:1' },
  { platform: 'demand-gen', ratio: '4:5' },
];

test('counts targets by platform', () => {
  assert.deepEqual(countTargetKinds(META), { meta: 3, demandGen: 0 });
  assert.deepEqual(countTargetKinds(ALL), { meta: 3, demandGen: 3 });
});

// THE POINT OF THIS MODULE. A Meta target bills the plate AND the comp derived from
// it — index.js's comp pass calls budget.take(). Three separate documents said a
// default run was 3 renders; it is 6. If this assertion ever "fails" because the
// number changed, check whether the comp still costs a render before touching it.
test('a Meta target bills two renders, a Demand Gen target one', () => {
  const one = estimateRenders({ formats: ['ingredient-callout'], variations: 1, targets: META });
  assert.equal(one.expected, 6);
  assert.equal(one.expectedUsd, 0.78);
});

// Worst case: every plate burns all 3 attempts. A REJECTED plate never gets a comp,
// which is why the comp term stays at m and does not triple with the plates.
test('worst case triples the plates but not the comps', () => {
  const one = estimateRenders({ formats: ['ingredient-callout'], variations: 1, targets: META });
  assert.equal(one.worstCase, 12);          // 3*(3+0) + 3
  assert.equal(one.worstCaseUsd, 1.56);
});

test('demand-gen targets add one render each, with no comp', () => {
  const r = estimateRenders({ formats: ['ingredient-callout'], variations: 1, targets: ALL });
  assert.equal(r.expected, 9);              // 2*3 + 3
  assert.equal(r.worstCase, 21);            // 3*6 + 3
});

// The number the spec quotes for a full sweep. It is in the spec so an operator can
// see what the expensive path costs; it is here so it cannot quietly stop being true.
test('the full sweep matches the figure written into the spec', () => {
  const r = estimateRenders({
    formats: ['us-vs-them', 'ingredient-callout', 'manifesto', 'problem-aware', 'top-x-review',
              'offer-focused', 'testimonial', 'stat-stack', 'state-contrast'],
    variations: 3,
    targets: ALL,
  });
  assert.equal(r.expected, 243);
  assert.equal(r.expectedUsd, 31.59);
  assert.equal(r.worstCase, 567);
  assert.equal(r.worstCaseUsd, 73.71);
});

test('an empty format selection costs nothing', () => {
  const r = estimateRenders({ formats: [], variations: 1, targets: META });
  assert.equal(r.expected, 0);
  assert.equal(r.expectedUsd, 0);
});

test('money is rounded to cents, never left as float noise', () => {
  const r = estimateRenders({ formats: ['a', 'b', 'c'], variations: 1, targets: META });
  assert.equal(r.expectedUsd, Number(r.expectedUsd.toFixed(2)));
});

test('the per-render price is exported for callers that show it', () => {
  assert.equal(USD_PER_RENDER, 0.13);
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
cd /Users/seanfillmore/Code/Claude/.claude/worktrees/adstudio-server
nvm use
node --test tests/lib/ad-studio-cost.test.js
```

Expected: FAIL — `Cannot find module '.../lib/ad-studio-cost.js'`.

- [ ] **Step 3: Write the implementation**

Create `lib/ad-studio-cost.js`:

```js
// lib/ad-studio-cost.js
//
// What an Ad Studio run will cost, before it is launched.
//
// THE NON-OBVIOUS PART, and the reason this is a module rather than a line of
// arithmetic in a route: A META TARGET BILLS TWO RENDERS. The plate is rendered and
// gated, and then a comp is derived from it as a layout reference for the operator —
// and that derived pass calls budget.take() like any other render. Demand Gen plates
// get no comp (`wantsComp: false` in packaging.js's target table), so they bill one.
//
// Three separate documents — this agent's README, the UI spec's reconciliation table
// and the UI spec's screen 1 — all said a default run was one render per target. It
// is not, and the whole point of the setup screen is a number the operator can trust
// while ticking boxes.
//
// Imports NOTHING on purpose. The launch route needs this to enforce a ceiling and
// the browser needs the same shape to display; keeping it dependency-free means
// neither pays for sharp (which packaging.js pulls in) to do arithmetic.

/** Gemini 3 Pro at 2K. Matches ESTIMATED_COST_PER_RENDER_USD in the agent. */
export const USD_PER_RENDER = 0.13;

/** Plate attempts before renderWithRetry gives up on a target. */
const MAX_ATTEMPTS_PER_PLATE = 3;

/** Split resolved targets by platform. Takes the output of packaging.js's selectTargets. */
export function countTargetKinds(targets = []) {
  let meta = 0, demandGen = 0;
  for (const t of targets) {
    if (t.platform === 'meta') meta += 1;
    else demandGen += 1;
  }
  return { meta, demandGen };
}

const usd = (renders) => Number((renders * USD_PER_RENDER).toFixed(2));

/**
 * expected  = F × V × (2m + d)          every plate passes first attempt, every Meta plate comps
 * worstCase = F × V × (3(m+d) + m)      every plate burns all three attempts
 *
 * The comp term stays at `m` in the worst case rather than tripling: a comp is only
 * derived from a plate that was ACCEPTED, so the run that pays for the most plate
 * attempts is not paying three comps for them.
 */
export function estimateRenders({ formats = [], variations = 1, targets = [] } = {}) {
  const { meta, demandGen } = countTargetKinds(targets);
  const concepts = formats.length * variations;
  const expected = concepts * (2 * meta + demandGen);
  const worstCase = concepts * (MAX_ATTEMPTS_PER_PLATE * (meta + demandGen) + meta);
  return { meta, demandGen, expected, worstCase, expectedUsd: usd(expected), worstCaseUsd: usd(worstCase) };
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
node --test tests/lib/ad-studio-cost.test.js
```

Expected: PASS, 8 tests, 0 fail, **0 cancelled**.

- [ ] **Step 5: Give `$0.13` one home**

In `agents/ad-studio/index.js`, add to the imports (near the existing `lib/` imports around line 34):

```js
import { USD_PER_RENDER } from '../../lib/ad-studio-cost.js';
```

and replace the literal declaration at line ~49:

```js
export const ESTIMATED_COST_PER_RENDER_USD = USD_PER_RENDER;
```

Keep the export name — `parseArgs` uses it in an error message and tests reference it.

- [ ] **Step 6: Correct the README's cost table**

In `agents/ad-studio/README.md`, replace the Cost section's table and the `--targets` default note. The table becomes:

```markdown
| | renders | ≈ cost |
|---|---|---|
| **Default** — one format, one variation, `--targets meta` | **6** | **$0.78** |
| One format, `--variations 3`, Meta | 18 | $2.34 |
| One format, one variation, `--targets all` | 9 | $1.17 |
| One format, `--variations 3`, `--targets all` | 27 | $3.51 |
| Nine formats, `--variations 3`, `--targets all` | 243 | $31.59 |
| `--max-renders` default ceiling | 120 | $15.60 |
```

Immediately under it, add:

```markdown
**A Meta target bills two renders.** The plate is rendered and gated, then a comp is
derived from it as the operator's layout reference — and that derived pass takes a
budget slot like any other render. Demand Gen plates get no comp, so they bill one.
Every row above follows from that; `lib/ad-studio-cost.js` is the one implementation
and `tests/lib/ad-studio-cost.test.js` pins these numbers.
```

Also fix the `--targets` row in the flag table, which says the default is
`meta=1:1,meta=4:5`: the default is **`meta`**, which is all three Meta ratios.

- [ ] **Step 7: Run the agent's own suite to prove nothing regressed**

```bash
node --test 'tests/agents/ad-studio-*.test.js'
```

Expected: PASS with 0 fail and **0 cancelled**.

- [ ] **Step 8: Commit**

```bash
git add lib/ad-studio-cost.js tests/lib/ad-studio-cost.test.js agents/ad-studio/index.js agents/ad-studio/README.md
git commit -m "feat(ad-studio): cost estimator that counts the comp render

A Meta target bills TWO renders — the plate and the comp derived from it,
which calls budget.take() like any other render. The README, the UI spec's
reconciliation table and its screen 1 all said one. A default run is 6
renders / \$0.78, not 3 / \$0.39.

Dependency-free on purpose: the launch route enforces a ceiling with it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: The job file layer

Where a run's progress lives while it runs. Shared between the agent (sole writer) and the dashboard (reader), so it goes in the flat `lib/` namespace per CLAUDE.md's data-layout conventions.

**Files:**
- Create: `lib/ad-studio-job.js`
- Test: `tests/lib/ad-studio-job.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `jobsDir(root: string) => string` — `<root>/data/reports/ad-studio/jobs`
  - `isValidJobId(id: string) => boolean`
  - `jobPath(root, jobId) => string`
  - `writeJob(root, job: object) => object` — atomic; requires `job.jobId`
  - `readJob(root, jobId) => object | null`
  - `updateJob(root, jobId, patch: object) => object` — shallow merge, atomic
  - `appendEvent(root, jobId, event: object) => object` — pushes onto `events[]` with an `at` stamp
  - `listJobs(root) => object[]` — newest first
  - `findActiveJob(root, { now?, isAlive?, pendingGraceMs? }) => object | null`
  - `rendersToday(root, { now? }) => number`
  - `pruneJobs(root, { now?, maxAgeMs? }) => string[]` — removed job ids

- [ ] **Step 1: Write the failing test**

Create `tests/lib/ad-studio-job.test.js`:

```js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  jobsDir, jobPath, isValidJobId, writeJob, readJob, updateJob, appendEvent,
  listJobs, findActiveJob, rendersToday, pruneJobs,
} from '../../lib/ad-studio-job.js';

function freshRoot() {
  return mkdtempSync(join(tmpdir(), 'ad-studio-job-'));
}

test('job ids may not contain a path separator', () => {
  assert.equal(isValidJobId('coconut-lotion-1786000000000'), true);
  assert.equal(isValidJobId('a.b-c_d'), true);
  assert.equal(isValidJobId('../../../etc/passwd'), false);
  assert.equal(isValidJobId('a/b'), false);
  assert.equal(isValidJobId('a\\b'), false);
  assert.equal(isValidJobId(''), false);
  assert.equal(isValidJobId('..'), false);
});

test('write then read round-trips, creating the directory', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', status: 'pending' });
  assert.equal(existsSync(jobsDir(root)), true);
  assert.equal(readJob(root, 'j1').status, 'pending');
});

test('reading a job that does not exist is null, not a throw', () => {
  assert.equal(readJob(freshRoot(), 'nope'), null);
});

test('reading a corrupt job file is null, not a throw', () => {
  const root = freshRoot();
  mkdirSync(jobsDir(root), { recursive: true });
  writeFileSync(jobPath(root, 'bad'), '{ not json');
  assert.equal(readJob(root, 'bad'), null);
});

// The dashboard polls this file while the agent writes it. A partial read of a
// half-written file would show the operator a broken run; writing to a temp file and
// renaming makes every read see one whole version or the previous one.
test('a write leaves no partial file behind', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', status: 'running' });
  updateJob(root, 'j1', { status: 'complete' });
  const files = readdirSync(jobsDir(root));
  assert.deepEqual(files, ['j1.json']);
  assert.equal(JSON.parse(readFileSync(jobPath(root, 'j1'), 'utf8')).status, 'complete');
});

test('writeJob refuses a job with no id', () => {
  assert.throws(() => writeJob(freshRoot(), { status: 'pending' }), /jobId/);
});

test('update merges shallowly and leaves untouched keys alone', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', status: 'pending', args: { product: 'coconut-lotion' } });
  const merged = updateJob(root, 'j1', { status: 'running', pid: 4242 });
  assert.equal(merged.status, 'running');
  assert.equal(merged.pid, 4242);
  assert.equal(merged.args.product, 'coconut-lotion');
});

test('update on a missing job throws rather than creating a headless one', () => {
  assert.throws(() => updateJob(freshRoot(), 'ghost', { status: 'running' }), /ghost/);
});

test('events append in order and each carries a timestamp', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', status: 'running' });
  appendEvent(root, 'j1', { stage: 'copy', concept: 'manifesto' });
  const after = appendEvent(root, 'j1', { stage: 'render', artifact: 'plate-1x1.png', state: 'accepted' });
  assert.equal(after.events.length, 2);
  assert.equal(after.events[0].stage, 'copy');
  assert.equal(after.events[1].artifact, 'plate-1x1.png');
  assert.ok(Date.parse(after.events[1].at));
});

test('listJobs returns newest first', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', createdAt: '2026-08-16T10:00:00.000Z' });
  writeJob(root, { jobId: 'j2', createdAt: '2026-08-16T12:00:00.000Z' });
  assert.deepEqual(listJobs(root).map(j => j.jobId), ['j2', 'j1']);
});

// ── findActiveJob: liveness is checked, never assumed ────────────────────────────────
//
// The dashboard restarts on every deploy and an agent can be OOM-killed. A lock file
// left behind by either would block every future launch with nothing saying why, so
// "is a run active" is answered by asking the OS about the pid, not by a lock.

test('a running job with a live pid is active', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', status: 'running', pid: 999, createdAt: new Date().toISOString() });
  assert.equal(findActiveJob(root, { isAlive: () => true }).jobId, 'j1');
});

test('a running job whose process is gone is NOT active', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', status: 'running', pid: 999, createdAt: new Date().toISOString() });
  assert.equal(findActiveJob(root, { isAlive: () => false }), null);
});

test('a complete job is never active, however alive its pid looks', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', status: 'complete', pid: 999, createdAt: new Date().toISOString() });
  assert.equal(findActiveJob(root, { isAlive: () => true }), null);
});

// A job is 'pending' for the moment between the route writing it and the child booting
// up to claim it. Without a grace window a double-click launches two paid runs.
test('a just-created pending job with no pid is active during the grace window', () => {
  const root = freshRoot();
  const now = Date.parse('2026-08-16T12:00:00.000Z');
  writeJob(root, { jobId: 'j1', status: 'pending', createdAt: '2026-08-16T11:59:50.000Z' });
  assert.equal(findActiveJob(root, { now, isAlive: () => false }).jobId, 'j1');
});

test('a pending job that never claimed a pid goes stale and stops blocking', () => {
  const root = freshRoot();
  const now = Date.parse('2026-08-16T12:00:00.000Z');
  writeJob(root, { jobId: 'j1', status: 'pending', createdAt: '2026-08-16T11:50:00.000Z' });
  assert.equal(findActiveJob(root, { now, isAlive: () => false }), null);
});

// Gemini's project quota is a hard 250 renders/day. The form shows what today has
// already spent so the operator is not told about it by a 429 nineteen hours long.
test('rendersToday sums todays jobs only', () => {
  const root = freshRoot();
  const now = Date.parse('2026-08-16T12:00:00.000Z');
  writeJob(root, { jobId: 'j1', createdAt: '2026-08-16T01:00:00.000Z', totals: { renders: 6 } });
  writeJob(root, { jobId: 'j2', createdAt: '2026-08-16T09:00:00.000Z', totals: { renders: 12 } });
  writeJob(root, { jobId: 'j3', createdAt: '2026-08-15T23:00:00.000Z', totals: { renders: 90 } });
  assert.equal(rendersToday(root, { now }), 18);
});

test('rendersToday tolerates a job with no totals yet', () => {
  const root = freshRoot();
  const now = Date.parse('2026-08-16T12:00:00.000Z');
  writeJob(root, { jobId: 'j1', createdAt: '2026-08-16T01:00:00.000Z' });
  assert.equal(rendersToday(root, { now }), 0);
});

// Job files are a few KB and the run's own run.json is the permanent record. This
// project has already lost four days of cron to a full disk; nothing on that box
// accumulates without a sweep.
test('prune removes job files older than the window and keeps the rest', () => {
  const root = freshRoot();
  const now = Date.parse('2026-08-16T12:00:00.000Z');
  writeJob(root, { jobId: 'old', createdAt: '2026-08-10T12:00:00.000Z' });
  writeJob(root, { jobId: 'new', createdAt: '2026-08-16T11:00:00.000Z' });
  assert.deepEqual(pruneJobs(root, { now }), ['old']);
  assert.equal(readJob(root, 'old'), null);
  assert.equal(readJob(root, 'new').jobId, 'new');
});

test('prune on a directory that does not exist is a no-op', () => {
  assert.deepEqual(pruneJobs(freshRoot(), {}), []);
});
```

- [ ] **Step 2: Run the test and watch it fail**

```bash
node --test tests/lib/ad-studio-job.test.js
```

Expected: FAIL — `Cannot find module '.../lib/ad-studio-job.js'`.

- [ ] **Step 3: Write the implementation**

Create `lib/ad-studio-job.js`:

```js
// lib/ad-studio-job.js
//
// The progress record of one Ad Studio run, while it runs.
//
// ONE WRITER, BY DESIGN. The dashboard route creates the job file and then never
// touches it again; the spawned agent writes everything after that, including its own
// pid on startup. Two writers on one file would need locking, and every lock this
// project could reasonably use survives a crash it should not survive.
//
// That is also why cancellation is a SIGNAL and not a write: the route sends SIGTERM
// and the agent's existing handler — which already archives run output before exiting
// — records the outcome. The reader never decides what happened.
//
// Liveness is asked of the OS, never of a lock file. The dashboard restarts on every
// deploy and an agent can be OOM-killed on a 961 MB box; a stale lock would block
// every future launch with nothing on screen saying why.

import { readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Job files are a few KB; the run's own run.json is the permanent record. */
export const DEFAULT_MAX_AGE_MS = 3 * DAY_MS;

/** How long a job may sit 'pending' before it is presumed never to have started. */
export const DEFAULT_PENDING_GRACE_MS = 60 * 1000;

/** `data/reports/ad-studio/` is already gitignored, so job files need no ignore rule. */
export function jobsDir(root) {
  return join(root, 'data', 'reports', 'ad-studio', 'jobs');
}

const JOB_ID_RE = /^[\w.-]+$/;

export function isValidJobId(id) {
  const s = String(id || '');
  if (!s || s === '.' || s === '..') return false;
  return JOB_ID_RE.test(s);
}

export function jobPath(root, jobId) {
  if (!isValidJobId(jobId)) throw new Error(`ad-studio-job: invalid job id "${jobId}"`);
  return join(jobsDir(root), `${jobId}.json`);
}

/**
 * Atomic: write a temp file, then rename over the target. The dashboard polls this
 * file while the agent writes it, and a partial read would render a broken run.
 */
export function writeJob(root, job) {
  if (!job || !job.jobId) throw new Error('ad-studio-job: writeJob requires a jobId');
  const dir = jobsDir(root);
  mkdirSync(dir, { recursive: true });
  const final = jobPath(root, job.jobId);
  const tmp = `${final}.tmp`;
  writeFileSync(tmp, JSON.stringify(job, null, 2));
  renameSync(tmp, final);
  return job;
}

/** null — never a throw — for missing OR corrupt. A reader must not crash on either. */
export function readJob(root, jobId) {
  try {
    return JSON.parse(readFileSync(jobPath(root, jobId), 'utf8'));
  } catch {
    return null;
  }
}

export function updateJob(root, jobId, patch) {
  const current = readJob(root, jobId);
  if (!current) throw new Error(`ad-studio-job: no such job "${jobId}"`);
  return writeJob(root, { ...current, ...patch });
}

export function appendEvent(root, jobId, event) {
  const current = readJob(root, jobId);
  if (!current) throw new Error(`ad-studio-job: no such job "${jobId}"`);
  const events = Array.isArray(current.events) ? current.events : [];
  events.push({ at: new Date().toISOString(), ...event });
  return writeJob(root, { ...current, events });
}

export function listJobs(root) {
  const dir = jobsDir(root);
  if (!existsSync(dir)) return [];
  const jobs = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const job = readJob(root, f.replace(/\.json$/, ''));
    if (job) jobs.push(job);
  }
  return jobs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

const pidAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/**
 * The run currently in flight, or null. `isAlive` and `now` are injectable so the
 * behaviour is testable without spawning processes.
 */
export function findActiveJob(root, { now = Date.now(), isAlive = pidAlive, pendingGraceMs = DEFAULT_PENDING_GRACE_MS } = {}) {
  for (const job of listJobs(root)) {
    if (job.status === 'running') {
      if (job.pid && isAlive(job.pid)) return job;
      continue;
    }
    if (job.status === 'pending') {
      const age = now - Date.parse(job.createdAt || 0);
      if (job.pid && isAlive(job.pid)) return job;
      if (Number.isFinite(age) && age < pendingGraceMs) return job;
    }
  }
  return null;
}

/** Renders billed today. Gemini's project quota is a hard 250/day. */
export function rendersToday(root, { now = Date.now() } = {}) {
  const day = new Date(now).toISOString().slice(0, 10);
  let total = 0;
  for (const job of listJobs(root)) {
    if (String(job.createdAt || '').slice(0, 10) !== day) continue;
    total += Number(job.totals?.renders) || 0;
  }
  return total;
}

export function pruneJobs(root, { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  const dir = jobsDir(root);
  if (!existsSync(dir)) return [];
  const removed = [];
  for (const job of listJobs(root)) {
    const age = now - Date.parse(job.createdAt || 0);
    if (!Number.isFinite(age) || age <= maxAgeMs) continue;
    try { unlinkSync(jobPath(root, job.jobId)); removed.push(job.jobId); } catch { /* ignore */ }
  }
  return removed;
}
```

- [ ] **Step 4: Run the test and watch it pass**

```bash
node --test tests/lib/ad-studio-job.test.js
```

Expected: PASS, 19 tests, 0 fail, **0 cancelled**.

- [ ] **Step 5: Commit**

```bash
git add lib/ad-studio-job.js tests/lib/ad-studio-job.test.js
git commit -m "feat(ad-studio): job file layer for server-side runs

One writer by design — the route creates the job file, the spawned agent
owns it after that and writes its own pid. Cancellation is a signal, not a
write, so the reader never decides what happened.

Liveness is asked of the OS rather than held in a lock file: the dashboard
restarts on every deploy and an agent can be OOM-killed on a 961 MB box, and
a stale lock would block every future launch silently.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `--job-id` — the agent reports its own progress

The agent becomes the sole writer of the job file. Without `--job-id` every write is a no-op, so the CLI is untouched.

**Files:**
- Modify: `agents/ad-studio/index.js` — `parseArgs` (~line 606), `main()` (~lines 1037, 1268-1345), the SIGINT/SIGTERM handler (~line 1258), the module-scope error handler (~line 1377)
- Modify: `agents/ad-studio/README.md` — document `--job-id`
- Test: `tests/agents/ad-studio-orchestrator.test.js` (extend — it already tests `parseArgs`)
- Test: `tests/agents/ad-studio-job-reporting.test.js` (create)

**Interfaces:**
- Consumes: `writeJob`, `updateJob`, `appendEvent` from `lib/ad-studio-job.js` (Task 2); `estimateRenders` from `lib/ad-studio-cost.js` (Task 1).
- Produces:
  - `parseArgs(argv)` gains a `jobId: string | null` field.
  - `createJobReporter({ root, jobId }) => { start(fn), event(fn), finish(fn), fail(fn) }` — exported from `agents/ad-studio/index.js`. **Every method is a no-op when `jobId` is null**, and every method swallows its own errors: a job-file problem must never fail a paid run.

- [ ] **Step 1: Write the failing tests**

Create `tests/agents/ad-studio-job-reporting.test.js`:

```js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs, createJobReporter } from '../../agents/ad-studio/index.js';
import { writeJob, readJob } from '../../lib/ad-studio-job.js';

const freshRoot = () => mkdtempSync(join(tmpdir(), 'ad-studio-report-'));

const baseArgv = ['--product', 'coconut-lotion', '--formats', 'manifesto'];

test('--job-id is parsed, and absent by default', () => {
  assert.equal(parseArgs(baseArgv).jobId, null);
  assert.equal(parseArgs([...baseArgv, '--job-id', 'j1']).jobId, 'j1');
});

test('a job id with a path separator is rejected at parse time', () => {
  assert.throws(() => parseArgs([...baseArgv, '--job-id', '../escape']), /job-id/);
});

// THE LOAD-BEARING PROPERTY. Every CLI run in this repo's history passes no --job-id.
// If the reporter did anything at all without one, every existing invocation would
// start writing files it never wrote before.
test('with no job id every reporter method is a silent no-op', () => {
  const root = freshRoot();
  const r = createJobReporter({ root, jobId: null });
  r.start({ pid: 1 });
  r.event({ stage: 'render' });
  r.finish({ runId: 'x' });
  r.fail(new Error('boom'));
  assert.equal(readJob(root, 'null'), null);
});

test('start claims the job: running, with the pid and the run id', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', status: 'pending', createdAt: new Date().toISOString() });
  createJobReporter({ root, jobId: 'j1' }).start({ pid: 4242, runId: 'coconut-lotion-2026' });
  const job = readJob(root, 'j1');
  assert.equal(job.status, 'running');
  assert.equal(job.pid, 4242);
  assert.equal(job.runId, 'coconut-lotion-2026');
  assert.ok(job.startedAt);
});

test('events accumulate on the job', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', status: 'pending', createdAt: new Date().toISOString() });
  const r = createJobReporter({ root, jobId: 'j1' });
  r.start({ pid: 1 });
  r.event({ stage: 'copy', concept: 'manifesto', state: 'ok' });
  r.event({ stage: 'render', concept: 'manifesto', variation: 1, artifact: 'plate-1x1.png', state: 'accepted', attempts: 1 });
  const job = readJob(root, 'j1');
  assert.equal(job.events.length, 2);
  assert.equal(job.events[1].artifact, 'plate-1x1.png');
});

test('finish records the totals and the terminal status', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', status: 'pending', createdAt: new Date().toISOString() });
  const r = createJobReporter({ root, jobId: 'j1' });
  r.start({ pid: 1 });
  r.finish({ runId: 'r1', totals: { renders: 6, artifacts: { accepted: 3, total: 3 } } });
  const job = readJob(root, 'j1');
  assert.equal(job.status, 'complete');
  assert.equal(job.totals.renders, 6);
  assert.ok(job.finishedAt);
});

test('fail records the message, never the stack, and never the environment', () => {
  const root = freshRoot();
  writeJob(root, { jobId: 'j1', status: 'pending', createdAt: new Date().toISOString() });
  const r = createJobReporter({ root, jobId: 'j1' });
  r.start({ pid: 1 });
  r.fail(new Error('ad-studio: --formats is required'));
  const job = readJob(root, 'j1');
  assert.equal(job.status, 'error');
  assert.equal(job.error, 'ad-studio: --formats is required');
  assert.equal(job.stack, undefined);
  assert.ok(job.finishedAt);
});

// A job-file problem must never turn a successful paid run into a crash. This is the
// same posture archiveRunOutput takes: the images are on disk by then.
test('a reporter whose job file has vanished swallows the error', () => {
  const root = freshRoot();
  const r = createJobReporter({ root, jobId: 'gone' });
  assert.doesNotThrow(() => { r.start({ pid: 1 }); r.event({ stage: 'render' }); r.finish({}); });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test tests/agents/ad-studio-job-reporting.test.js
```

Expected: FAIL — `createJobReporter is not a function`.

- [ ] **Step 3: Add `jobId` to `parseArgs`**

In `agents/ad-studio/index.js`, inside `parseArgs`, immediately before `const dryRun = ...`:

```js
  // --job-id turns on progress reporting into data/reports/ad-studio/jobs/<id>.json.
  // The dashboard sets it; a human never does. Validated here as well as in the route
  // because this argv can also arrive from a shell.
  const jobId = getFlag('--job-id') || null;
  if (jobId !== null && !isValidJobId(jobId)) {
    throw new Error(`ad-studio: invalid --job-id "${jobId}" — letters, digits, dot, dash and underscore only`);
  }
```

and add `jobId` to the returned object. Add to the imports at the top:

```js
import { writeJob, updateJob, appendEvent, readJob, isValidJobId } from '../../lib/ad-studio-job.js';
```

- [ ] **Step 4: Add the reporter**

In `agents/ad-studio/index.js`, above `async function main()`:

```js
/**
 * Progress reporting into a dashboard job file.
 *
 * EVERY METHOD IS A NO-OP WITHOUT A JOB ID. Every CLI invocation in this repo's
 * history passes none, and none of them should start writing files.
 *
 * Every method also swallows its own errors. A job file that cannot be written must
 * never turn a successful, paid run into a crash — the same posture archiveRunOutput
 * takes, and for the same reason: by the time this is called the money is spent and
 * the images are on disk.
 */
export function createJobReporter({ root = ROOT, jobId = null } = {}) {
  if (!jobId) {
    const noop = () => {};
    return { start: noop, event: noop, finish: noop, fail: noop };
  }
  const guard = (fn) => (...a) => { try { return fn(...a); } catch { /* never fail a run over a job file */ } };
  return {
    start: guard(({ pid, runId = null, plan = null }) => updateJob(root, jobId, {
      status: 'running', pid, runId, plan, startedAt: new Date().toISOString(),
    })),
    event: guard((event) => appendEvent(root, jobId, event)),
    finish: guard(({ runId = null, totals = null, status = 'complete' }) => updateJob(root, jobId, {
      status, runId, totals, finishedAt: new Date().toISOString(),
    })),
    // The MESSAGE only. A stack trace can carry absolute paths, and this file is
    // served to a browser over a public URL.
    fail: guard((err) => updateJob(root, jobId, {
      status: 'error', error: err?.message || String(err), finishedAt: new Date().toISOString(),
    })),
  };
}
```

- [ ] **Step 5: Run the reporter tests and watch them pass**

```bash
node --test tests/agents/ad-studio-job-reporting.test.js
```

Expected: PASS, 8 tests, 0 fail, **0 cancelled**.

- [ ] **Step 6: Wire the reporter into `main()`**

Four edits in `agents/ad-studio/index.js`, all inside `main()`:

**(a)** Right after `const args = parseArgs(process.argv.slice(2));`:

```js
  const job = createJobReporter({ root: ROOT, jobId: args.jobId });
```

**(b)** Right after `mkdirSync(runDir, { recursive: true });` (the run-id block, ~line 1200) — this is where the run finally has an id to report:

```js
  job.start({ pid: process.pid, runId });
```

For a `--dry-run`, which returns before that block, call it at the top of the dry-run branch instead with `runId: null`, and follow the printed summary with:

```js
    job.finish({ runId: null, totals: { renders: 0, concepts: concepts.length, rejected: rejectedConcepts.length } });
```

**(c)** In the existing `onProgress` callback inside the concept loop (~line 1296), after the existing `console.log`, report the same thing structurally. Add to the skipped branch:

```js
            job.event({ stage: 'render', concept: conceptSlug, variation: n, artifact, state: 'skipped-budget' });
```

and at the end of the non-skipped branch:

```js
          job.event({
            stage: 'render', concept: conceptSlug, variation: n, artifact,
            state: result.buffer ? (result.ok ? 'accepted' : 'rejected') : 'errored',
            attempts: result.proofEntry?.attempts ?? null,
            score: typeof score === 'number' ? score : null,
            reasons: result.ok ? [] : (result.proofEntry?.reasons || []),
          });
```

Also report each concept's copy outcome, right after `buildConcepts` returns (~line 1160) — a gate rejection is a first-class outcome the UI must show, and it happens before any render:

```js
  for (const c of concepts) job.event({ stage: 'copy', concept: c.format.key, state: 'ok' });
  for (const c of rejectedConcepts) {
    job.event({ stage: 'copy', concept: c.conceptSlug, state: 'gate-rejected', reasons: (c.violations || []).map(v => `[${v.zone}] ${v.reason}`) });
  }
```

**(d)** After `finalizeRunReport` returns (~line 1336):

```js
  job.finish({ runId, totals: { ...report.totals, renders: budget.used() } });
```

- [ ] **Step 7: Record a cancelled or crashed run**

In the SIGINT/SIGTERM handler registered inside `main()` (~line 1258), after `flushArchive()`:

```js
      job.finish({ runId, totals: null, status: 'cancelled' });
```

`job` is in scope — the handler is registered inside `main()`, which is also why it can see it. And in the module-scope `.catch()` at the bottom of the file (~line 1400), the reporter is not in scope, so mark the failure from the argv directly, before the existing notify/exit:

```js
    try {
      const failedJobId = parseArgs(process.argv.slice(2)).jobId;
      if (failedJobId) createJobReporter({ jobId: failedJobId }).fail(err);
    } catch { /* a parseArgs failure is itself the error being reported */ }
```

- [ ] **Step 8: Document the flag**

In `agents/ad-studio/README.md`'s flag table, add:

```markdown
| `--job-id` | no | Progress reporting for the dashboard. Writes stage-by-stage state into `data/reports/ad-studio/jobs/<id>.json`, which the Ad Studio tab polls. Set by the dashboard's launch route; a human never types it. **With no `--job-id` nothing is written and the CLI behaves exactly as before.** |
```

- [ ] **Step 9: Prove the CLI is unchanged**

```bash
node --test 'tests/agents/ad-studio-*.test.js' tests/lib/ad-studio-job.test.js
```

Expected: PASS, 0 fail, **0 cancelled**.

Then a real no-cost end-to-end that spends nothing but one Opus copy call, confirming no job file appears when no `--job-id` is passed:

```bash
node agents/ad-studio/index.js --product coconut-lotion --variant coconut-breeze \
  --formats ingredient-callout --dry-run
ls data/reports/ad-studio/jobs 2>&1   # expected: no such directory
```

- [ ] **Step 10: Commit**

```bash
git add agents/ad-studio/index.js agents/ad-studio/README.md tests/agents/ad-studio-job-reporting.test.js
git commit -m "feat(ad-studio): --job-id progress reporting

The agent writes its own progress — stage, concept, variation, artifact,
verdict — into the dashboard's job file, including its own pid so the route
can cancel it without ever writing to the file itself.

Every reporter method is a no-op without --job-id, so every CLI invocation
behaves exactly as before, and every method swallows its own errors: a job
file must never turn a successful paid run into a crash.

fail() records the message and never the stack — a stack carries absolute
paths and this file is served to a browser over a public URL.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: The creatives budget has to fit the disk

10 GiB is larger than the server's free disk, so the budget could never fire before the disk filled — and a full disk on this box has already cost four days of cron.

**Files:**
- Modify: `lib/creatives-budget.js` (the `DEFAULT_BUDGET_BYTES` declaration ~line 39, and `enforceBudget` ~line 227)
- Modify: `agents/ad-studio/index.js` (~line 1241 and the warning at ~1250)
- Modify: `scripts/creatives-budget.mjs` (~line 29)
- Modify: `CLAUDE.md` (the "hard 10 GiB disk budget" sentence)
- Test: `tests/lib/creatives-budget.test.js` (extend)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `resolveBudgetBytes(env = process.env) => number` exported from `lib/creatives-budget.js`. `enforceBudget` and `planPurge` default `budgetBytes` to it.

- [ ] **Step 1: Write the failing test**

Append to `tests/lib/creatives-budget.test.js`:

```js
import { resolveBudgetBytes, DEFAULT_BUDGET_BYTES } from '../../lib/creatives-budget.js';

test('with no env override the budget is the 10 GiB default', () => {
  assert.equal(resolveBudgetBytes({}), DEFAULT_BUDGET_BYTES);
});

// The production box has ~9.9 GB free of 24 GB. A 10 GiB ceiling can never fire
// before the disk fills, which is the failure that cost this project four days of
// cron. The server sets 4 GiB; local keeps the default.
test('CREATIVES_BUDGET_BYTES overrides it', () => {
  assert.equal(resolveBudgetBytes({ CREATIVES_BUDGET_BYTES: String(4 * 1024 ** 3) }), 4 * 1024 ** 3);
});

test('a junk or non-positive override falls back to the default rather than purging everything', () => {
  assert.equal(resolveBudgetBytes({ CREATIVES_BUDGET_BYTES: 'lots' }), DEFAULT_BUDGET_BYTES);
  assert.equal(resolveBudgetBytes({ CREATIVES_BUDGET_BYTES: '0' }), DEFAULT_BUDGET_BYTES);
  assert.equal(resolveBudgetBytes({ CREATIVES_BUDGET_BYTES: '-1' }), DEFAULT_BUDGET_BYTES);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test tests/lib/creatives-budget.test.js
```

Expected: FAIL — `resolveBudgetBytes is not a function`.

- [ ] **Step 3: Implement**

In `lib/creatives-budget.js`, correct the stale docstring and add the resolver:

```js
/**
 * 10 GiB — the LOCAL default, where disk is plentiful.
 *
 * Deliberately NOT the value used on the production box: that machine has ~9.9 GB
 * free of 24 GB, so a 10 GiB ceiling can never fire before the disk fills, and a full
 * disk there has already stopped every cron job for four days with nothing saying
 * why. The server sets CREATIVES_BUDGET_BYTES to 4 GiB.
 */
export const DEFAULT_BUDGET_BYTES = 10 * 1024 * 1024 * 1024;

/**
 * A junk, zero or negative override falls back to the default. A budget of 0 would
 * mean "purge everything eligible", which is the worst possible reading of a typo in
 * a .env file.
 */
export function resolveBudgetBytes(env = process.env) {
  const raw = Number(env?.CREATIVES_BUDGET_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BUDGET_BYTES;
}
```

Change the `budgetBytes` default in `planPurge` from `DEFAULT_BUDGET_BYTES` to `resolveBudgetBytes()`, and have `enforceBudget` pass the same default through.

In `agents/ad-studio/index.js` line ~1250, the "STILL OVER" warning prints `formatBytes(DEFAULT_BUDGET_BYTES)`, which would lie once an override is set. Use the sweep's own figure:

```js
          `${formatBytes(sweep.wouldRemain)} of ${formatBytes(sweep.budgetBytes)}. ` +
```

and drop `DEFAULT_BUDGET_BYTES` from that import if it is then unused.

In `scripts/creatives-budget.mjs` line ~29, make the `--gb` flag override the resolved value rather than the constant:

```js
const budgetBytes = gb === undefined ? resolveBudgetBytes() : Number(gb) * 1024 * 1024 * 1024;
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
node --test tests/lib/creatives-budget.test.js
```

Expected: PASS, 0 fail, **0 cancelled**.

- [ ] **Step 5: Prove the override end-to-end, without deleting anything**

```bash
CREATIVES_BUDGET_BYTES=4294967296 node scripts/creatives-budget.mjs
```

Expected: a dry-run plan (deletes nothing — dry is the default) reporting the budget as 4 GiB, not 10 GiB.

- [ ] **Step 6: Update CLAUDE.md**

In the "**`--formats` is required.**" paragraph, replace "has a **hard 10 GiB disk budget**" with:

```markdown
has a **hard disk budget** (`lib/creatives-budget.js`) — 10 GiB locally, and **4 GiB on
the production server** via `CREATIVES_BUDGET_BYTES`, because that box has ~9.9 GB free
of 24 GB and a ceiling above the free disk can never fire before the disk fills
```

- [ ] **Step 7: Commit**

```bash
git add lib/creatives-budget.js scripts/creatives-budget.mjs agents/ad-studio/index.js tests/lib/creatives-budget.test.js CLAUDE.md
git commit -m "fix(creatives): budget must fit the disk it protects

10 GiB is larger than the production box's free disk (9.9 GB of 24 GB), so
the ceiling could never fire before the disk filled — the exact failure that
cost this project four days of cron. CREATIVES_BUDGET_BYTES overrides it;
the server is set to 4 GiB, local keeps 10.

A junk or non-positive override falls back to the default rather than being
read as 'purge everything eligible'.

The ad-studio over-budget warning printed the CONSTANT, which would have
lied about the ceiling the moment an override was set. It prints the sweep's
own figure now.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: The launch routes

The endpoints that spend money. Kept in their own module — `routes/ad-studio.js` is the read/judge surface and this is the write/spawn one.

**Files:**
- Create: `agents/dashboard/routes/ad-studio-launch.js`
- Modify: `agents/dashboard/index.js` — import and register the route module in `ROUTES`; prune job files on start
- Test: `tests/dashboard/ad-studio-launch.test.js`

**Interfaces:**
- Consumes: `estimateRenders`, `USD_PER_RENDER` (Task 1); `writeJob`, `readJob`, `findActiveJob`, `rendersToday`, `isValidJobId`, `pruneJobs` (Task 2); `FORMATS` from `agents/ad-studio/formats.js`; `selectTargets` from `agents/ad-studio/packaging.js`.
- Produces:
  - `validateLaunch(body, { formats, manifestProducts }) => { ok: true, args } | { ok: false, error }` — exported for testing, and the only place a request is trusted.
  - `buildAgentArgv(args, jobId) => string[]`
  - default export: the route array.

**Routes:**
| Method | URL | Behaviour |
|---|---|---|
| GET | `/api/ad-studio/options` | products (Culina filtered), variants, formats, target sets, `perRenderUsd`, `maxRendersCeiling`, `rendersToday` |
| POST | `/api/ad-studio/launch` | 400 invalid · 409 a run is active · 200 `{ jobId, plan }` |
| GET | `/api/ad-studio/job/<id>` | the job JSON · 404 unknown |
| POST | `/api/ad-studio/job/<id>/cancel` | SIGTERM to the job's pid · 404 unknown · 409 not running |

- [ ] **Step 1: Write the failing test**

Create `tests/dashboard/ad-studio-launch.test.js`:

```js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateLaunch, buildAgentArgv, MAX_RENDERS_CEILING } from '../../agents/dashboard/routes/ad-studio-launch.js';

const FORMATS = [{ key: 'manifesto' }, { key: 'us-vs-them' }, { key: 'testimonial' }];
const PRODUCTS = [{ handle: 'coconut-lotion' }, { handle: 'coconut-oil-deodorant' }];
const ctx = { formats: FORMATS, manifestProducts: PRODUCTS };

const good = { product: 'coconut-lotion', formats: ['manifesto'], variations: 1, targets: 'meta', maxRenders: 120 };

test('a well-formed request is accepted and normalised', () => {
  const r = validateLaunch(good, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.args.product, 'coconut-lotion');
  assert.deepEqual(r.args.formats, ['manifesto']);
  assert.equal(r.args.variant, null);
  assert.equal(r.args.dryRun, false);
});

test('an unknown product is refused', () => {
  const r = validateLaunch({ ...good, product: 'not-a-product' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /product/i);
});

// The browser's format list is a convenience. The authority is here — a client that
// posts a format that does not exist must not reach a spawn.
test('an unknown format is refused and named', () => {
  const r = validateLaunch({ ...good, formats: ['manifesto', 'invented-format'] }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /invented-format/);
});

// The single most expensive default in the CLI, deliberately inverted in the UI: the
// cheapest action is the one you get by accident.
test('no formats is refused rather than meaning all of them', () => {
  assert.equal(validateLaunch({ ...good, formats: [] }, ctx).ok, false);
});

test('variations must be a whole number in 1..10', () => {
  assert.equal(validateLaunch({ ...good, variations: 0 }, ctx).ok, false);
  assert.equal(validateLaunch({ ...good, variations: 11 }, ctx).ok, false);
  assert.equal(validateLaunch({ ...good, variations: 2.5 }, ctx).ok, false);
  assert.equal(validateLaunch({ ...good, variations: 10 }, ctx).ok, true);
});

test('targets must be one of the two offered sets', () => {
  assert.equal(validateLaunch({ ...good, targets: 'all' }, ctx).ok, true);
  assert.equal(validateLaunch({ ...good, targets: 'demand-gen=1:1' }, ctx).ok, false);
});

// The ceiling is enforced here regardless of what the form sends. A launch button on
// a publicly reachable URL is categorically different from every other route on it.
test('maxRenders is clamped to the ceiling, never trusted upward', () => {
  assert.equal(validateLaunch({ ...good, maxRenders: 5000 }, ctx).args.maxRenders, MAX_RENDERS_CEILING);
  assert.equal(validateLaunch({ ...good, maxRenders: 6 }, ctx).args.maxRenders, 6);
  assert.equal(validateLaunch({ ...good, maxRenders: 0 }, ctx).ok, false);
});

test('a run whose expected renders exceed its own ceiling is refused before it starts', () => {
  // 3 formats x 10 variations x meta = 30 concepts x 6 = 180 expected, over a ceiling of 20.
  const r = validateLaunch(
    { ...good, formats: ['manifesto', 'us-vs-them', 'testimonial'], variations: 10, maxRenders: 20 },
    ctx,
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /expected/i);
});

test('the plan carries the cost estimate the operator was shown', () => {
  const r = validateLaunch(good, ctx);
  assert.equal(r.args.plan.expected, 6);
  assert.equal(r.args.plan.expectedUsd, 0.78);
  assert.equal(r.args.plan.worstCase, 12);
});

test('a dry run is allowed with no ceiling argument at all', () => {
  const r = validateLaunch({ ...good, dryRun: true, maxRenders: undefined }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.args.dryRun, true);
});

// ── buildAgentArgv ───────────────────────────────────────────────────────────────────

test('argv is built from validated args only', () => {
  const { args } = validateLaunch({ ...good, variant: 'coconut-breeze' }, ctx);
  assert.deepEqual(buildAgentArgv(args, 'job-1'), [
    '--product', 'coconut-lotion',
    '--variant', 'coconut-breeze',
    '--formats', 'manifesto',
    '--targets', 'meta',
    '--variations', '1',
    '--max-renders', '120',
    '--job-id', 'job-1',
  ]);
});

test('a dry run passes --dry-run and no render ceiling', () => {
  const { args } = validateLaunch({ ...good, dryRun: true }, ctx);
  const argv = buildAgentArgv(args, 'job-2');
  assert.ok(argv.includes('--dry-run'));
  assert.equal(argv.includes('--max-renders'), false);
});

test('a variant is omitted entirely when there is none', () => {
  const { args } = validateLaunch(good, ctx);
  assert.equal(buildAgentArgv(args, 'job-3').includes('--variant'), false);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test tests/dashboard/ad-studio-launch.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the route module**

Create `agents/dashboard/routes/ad-studio-launch.js`:

```js
// agents/dashboard/routes/ad-studio-launch.js
//
// The endpoints that SPEND MONEY. Kept apart from routes/ad-studio.js, which reads and
// judges runs that already exist.
//
// Three things make this route different from every other one on this server, and all
// three are here rather than in the browser:
//
//   1. The dashboard is reachable over a public ngrok URL. Basic auth is in front of
//      it, but a launch endpoint deserves its own ceiling regardless.
//   2. The browser's format and product lists are a CONVENIENCE. Every field is
//      re-validated here against formats.js and the product manifest.
//   3. One run at a time. On a 1 vCPU box two concurrent runs only slow each other
//      down, and a double-clicked button would otherwise pay twice.
//
// The agent is spawned DETACHED and owns its job file from the moment it starts. This
// route writes the job file exactly once, before the spawn, and only ever reads it
// afterwards — including on cancel, which sends a signal rather than writing a verdict.

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FORMATS } from '../../ad-studio/formats.js';
import { selectTargets } from '../../ad-studio/packaging.js';
import { estimateRenders, USD_PER_RENDER } from '../../../lib/ad-studio-cost.js';
import { writeJob, readJob, findActiveJob, rendersToday, isValidJobId } from '../../../lib/ad-studio-job.js';
import { respondJson, respondError, readJsonBody } from '../lib/responses.js';
import { ROOT, PRODUCT_IMAGES_DIR, PRODUCT_MANIFEST_PATH } from '../lib/paths.js';

/** ≈$15.60. Approved 2026-08-16. Enforced here whatever the form sends. */
export const MAX_RENDERS_CEILING = 120;

/** The agent's own MAX_VARIATIONS. Duplicated deliberately — this must reject before spawning. */
const MAX_VARIATIONS = 10;

/** The two target sets the UI offers. Anything else is a CLI-only power feature. */
const TARGET_SETS = ['meta', 'all'];

function manifestProducts() {
  try {
    const raw = JSON.parse(readFileSync(PRODUCT_MANIFEST_PATH, 'utf8'));
    const list = Array.isArray(raw) ? raw : (raw.products || []);
    // Culina is a separate brand on a separate site — never an RSC ad.
    return list.filter(p => !/culina|cast iron/i.test(`${p.handle} ${p.title || ''}`));
  } catch {
    return [];
  }
}

/** Variant subdirectories of a product's image directory — the ones holding photos. */
function variantsFor(product) {
  const dir = join(PRODUCT_IMAGES_DIR, product.imageDir || product.handle);
  try {
    return readdirSync(dir)
      .filter(name => !name.startsWith('.'))
      .filter(name => { try { return statSync(join(dir, name)).isDirectory(); } catch { return false; } })
      .sort();
  } catch {
    return [];
  }
}

/**
 * The only place a launch request is trusted. Returns normalised args or a reason.
 *
 * `formats` and `manifestProducts` are injected so this is testable without the real
 * manifest, and so the test suite pins the RULES rather than today's product list.
 */
export function validateLaunch(body = {}, { formats = FORMATS, manifestProducts: products = [] } = {}) {
  const bad = (error) => ({ ok: false, error });

  const product = String(body.product || '').trim();
  if (!product) return bad('product is required');
  if (!products.some(p => p.handle === product)) return bad(`unknown product "${product}"`);

  const variant = body.variant ? String(body.variant).trim() : null;

  const requested = Array.isArray(body.formats) ? body.formats.map(f => String(f).trim()).filter(Boolean) : [];
  if (!requested.length) return bad('pick at least one format');
  const unknown = requested.filter(k => !formats.some(f => f.key === k));
  if (unknown.length) return bad(`unknown format(s): ${unknown.join(', ')}`);

  const variations = body.variations === undefined ? 1 : Number(body.variations);
  if (!Number.isInteger(variations) || variations < 1 || variations > MAX_VARIATIONS) {
    return bad(`variations must be a whole number from 1 to ${MAX_VARIATIONS}`);
  }

  const targetSet = String(body.targets || 'meta');
  if (!TARGET_SETS.includes(targetSet)) return bad(`targets must be one of: ${TARGET_SETS.join(', ')}`);
  const targets = selectTargets(targetSet);

  const dryRun = Boolean(body.dryRun);

  let maxRenders = body.maxRenders === undefined ? MAX_RENDERS_CEILING : Number(body.maxRenders);
  if (!Number.isInteger(maxRenders) || maxRenders < 1) return bad('render ceiling must be a positive whole number');
  // Clamped, never trusted upward.
  maxRenders = Math.min(maxRenders, MAX_RENDERS_CEILING);

  const plan = estimateRenders({ formats: requested, variations, targets });

  // A run that cannot finish inside its own ceiling would budget-stop halfway, having
  // spent the money and produced a partial batch. Refuse it while it is still free.
  if (!dryRun && plan.expected > maxRenders) {
    return bad(
      `this run expects ${plan.expected} render(s) (~$${plan.expectedUsd.toFixed(2)}) but the ceiling is ` +
      `${maxRenders}. Reduce formats or variations, or raise the ceiling (max ${MAX_RENDERS_CEILING}).`
    );
  }

  return { ok: true, args: { product, variant, formats: requested, variations, targets: targetSet, maxRenders, dryRun, plan } };
}

/** Built from validated args only — nothing from the request body reaches argv directly. */
export function buildAgentArgv(args, jobId) {
  const argv = ['--product', args.product];
  if (args.variant) argv.push('--variant', args.variant);
  argv.push('--formats', args.formats.join(','));
  argv.push('--targets', args.targets);
  argv.push('--variations', String(args.variations));
  if (args.dryRun) argv.push('--dry-run');
  else argv.push('--max-renders', String(args.maxRenders));
  argv.push('--job-id', jobId);
  return argv;
}

export default [
  // GET /api/ad-studio/options — everything the setup form needs, so nothing about the
  // rotation is hardcoded in browser JS.
  {
    method: 'GET',
    match: '/api/ad-studio/options',
    handler(req, res) {
      try {
        const products = manifestProducts().map(p => ({
          handle: p.handle, title: p.title || p.handle, unitCount: p.unitCount ?? null, variants: variantsFor(p),
        }));
        respondJson(res, {
          products,
          formats: FORMATS.map(f => ({ key: f.key, name: f.name, plateSetting: f.plateSetting })),
          targetSets: TARGET_SETS.map(key => {
            const t = selectTargets(key);
            return { key, meta: t.filter(x => x.platform === 'meta').length, demandGen: t.filter(x => x.platform !== 'meta').length };
          }),
          perRenderUsd: USD_PER_RENDER,
          maxRendersCeiling: MAX_RENDERS_CEILING,
          maxVariations: MAX_VARIATIONS,
          rendersToday: rendersToday(ROOT),
          activeJobId: findActiveJob(ROOT)?.jobId || null,
        });
      } catch (err) {
        respondError(res, 500, err.message);
      }
    },
  },

  // POST /api/ad-studio/launch
  {
    method: 'POST',
    match: '/api/ad-studio/launch',
    async handler(req, res) {
      let body;
      try { body = await readJsonBody(req); } catch { return respondError(res, 400, 'bad JSON body'); }

      const verdict = validateLaunch(body, { formats: FORMATS, manifestProducts: manifestProducts() });
      if (!verdict.ok) return respondError(res, 400, verdict.error);

      const active = findActiveJob(ROOT);
      if (active) {
        return respondError(res, 409, `a run is already in progress (${active.jobId}) — wait for it or cancel it first`);
      }

      const { args } = verdict;
      const jobId = `${args.product}-${Date.now()}`;
      if (!isValidJobId(jobId)) return respondError(res, 400, 'could not build a safe job id');

      // Written ONCE, here. The agent owns this file from the moment it boots.
      writeJob(ROOT, {
        jobId, status: 'pending', createdAt: new Date().toISOString(),
        args: { ...args, plan: undefined }, plan: args.plan,
        runId: null, pid: null, events: [], totals: null, error: null,
      });

      const child = spawn('node', [join(ROOT, 'agents/ad-studio/index.js'), ...buildAgentArgv(args, jobId)], {
        cwd: ROOT, detached: true, stdio: 'ignore',
      });
      child.unref();

      respondJson(res, { ok: true, jobId, plan: args.plan });
    },
  },

  // GET /api/ad-studio/job/<id>
  {
    method: 'GET',
    match: (url) => /^\/api\/ad-studio\/job\/[^/]+$/.test(url.split('?')[0]),
    handler(req, res) {
      const jobId = decodeURIComponent(req.url.split('?')[0].split('/').pop());
      if (!isValidJobId(jobId)) return respondError(res, 400, 'bad job id');
      const job = readJob(ROOT, jobId);
      if (!job) return respondError(res, 404, 'no such job');
      respondJson(res, job);
    },
  },

  // POST /api/ad-studio/job/<id>/cancel — a SIGNAL, never a write. The agent's own
  // handler archives run output and records the outcome, so the file keeps one writer.
  {
    method: 'POST',
    match: (url) => /^\/api\/ad-studio\/job\/[^/]+\/cancel$/.test(url.split('?')[0]),
    handler(req, res) {
      const jobId = decodeURIComponent(req.url.split('?')[0].split('/')[4]);
      if (!isValidJobId(jobId)) return respondError(res, 400, 'bad job id');
      const job = readJob(ROOT, jobId);
      if (!job) return respondError(res, 404, 'no such job');
      if (!job.pid || job.status !== 'running') return respondError(res, 409, `job is ${job.status}, not running`);
      try {
        process.kill(job.pid, 'SIGTERM');
      } catch (err) {
        return respondError(res, 409, `could not signal the run: ${err.message}`);
      }
      respondJson(res, { ok: true, signalled: job.pid });
    },
  },
];
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
node --test tests/dashboard/ad-studio-launch.test.js
```

Expected: PASS, 13 tests, 0 fail, **0 cancelled**.

- [ ] **Step 5: Register the routes and prune jobs on start**

In `agents/dashboard/index.js`, beside the existing `import adStudioRoutes from './routes/ad-studio.js';` (line ~39):

```js
import adStudioLaunchRoutes from './routes/ad-studio-launch.js';
import { pruneJobs } from '../../lib/ad-studio-job.js';
```

Add `...adStudioLaunchRoutes` to the `ROUTES` array next to `...adStudioRoutes`.

In the `server.listen` callback, beside the existing `reconcileStaleInProgress()` sweep:

```js
  // Job files are a few KB and the run's own run.json is the permanent record. Nothing
  // accumulates unswept on a 24 GB box.
  try {
    const pruned = pruneJobs(ROOT);
    if (pruned.length) console.log(`  Pruned ${pruned.length} Ad Studio job file(s).`);
  } catch (e) { console.error('  Ad Studio job prune failed:', e.message); }
```

- [ ] **Step 6: Prove the routes are live locally**

Start the dashboard and exercise the read-only endpoint (spends nothing):

```bash
node agents/dashboard/index.js &
sleep 3
curl -s localhost:4242/api/ad-studio/options | head -c 600
```

Expected: JSON carrying `products` (no Culina entries), 9 `formats`, `targetSets` with `meta: 3 / demandGen: 0` and `meta: 3 / demandGen: 3`, `perRenderUsd: 0.13`, `maxRendersCeiling: 120`.

Then prove validation refuses a bad launch **without spawning anything**:

```bash
curl -s -X POST localhost:4242/api/ad-studio/launch \
  -H 'Content-Type: application/json' \
  -d '{"product":"coconut-lotion","formats":[],"variations":1,"targets":"meta"}'
```

Expected: `{"ok":false,"error":"pick at least one format"}` and **no** new file under `data/reports/ad-studio/jobs/`.

Then a real dry run through the route — one Opus copy call, no pixels:

```bash
curl -s -X POST localhost:4242/api/ad-studio/launch \
  -H 'Content-Type: application/json' \
  -d '{"product":"coconut-lotion","variant":"coconut-breeze","formats":["ingredient-callout"],"variations":1,"targets":"meta","dryRun":true}'
# take the jobId from the response, wait ~30s, then:
curl -s localhost:4242/api/ad-studio/job/<jobId> | head -c 800
```

Expected: `status` reaches `complete`, `events` carries a `copy` entry per concept, `pid` is set. Kill the dashboard afterwards.

- [ ] **Step 7: Commit**

```bash
git add agents/dashboard/routes/ad-studio-launch.js agents/dashboard/index.js tests/dashboard/ad-studio-launch.test.js
git commit -m "feat(dashboard): launch Ad Studio runs from the server

POST /api/ad-studio/launch spawns the agent detached with --job-id and
returns immediately; the agent owns its job file from there. Cancel sends
SIGTERM rather than writing a verdict, so the file keeps a single writer.

Guardrails, all server-side because the dashboard is on a public URL: every
field re-validated against formats.js and the product manifest, the render
ceiling clamped to 120 whatever the form sends, a run refused if its
expected renders exceed its own ceiling, and one run at a time by asking the
OS whether the previous pid is alive — not by a lock file that a deploy or
an OOM kill would strand.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: The setup and progress screens

**Files:**
- Modify: `agents/dashboard/public/index.html` (~line 198, the `adstudio-panel` block)
- Modify: `agents/dashboard/public/js/dashboard.js` (~line 5567, beside `adStudioState`)

**Interfaces:**
- Consumes: `GET /api/ad-studio/options`, `POST /api/ad-studio/launch`, `GET /api/ad-studio/job/<id>`, `POST /api/ad-studio/job/<id>/cancel` (Task 5); `loadAdStudioRuns()` / `loadAdStudioRun(runId)`, already in `dashboard.js`.
- Produces: `switchAdStudioView('new'|'judge')`, `adStudioEstimate()`, `adStudioLaunch(dryRun)`, `adStudioPollJob(jobId)`, `adStudioCancel()`.

Browser JS in `public/` is edited directly — the template-literal escaping rule applies only to browser JS embedded inside a server-side template literal, which this is not.

- [ ] **Step 1: Add the markup**

In `agents/dashboard/public/index.html`, inside `<div id="adstudio-panel">` and **above** the existing run-select toolbar, add a view toggle and the setup form:

```html
<div style="display:flex;gap:0.4rem;margin-bottom:0.75rem">
  <button id="as-view-new-btn" onclick="switchAdStudioView('new')" class="creatives-mode-btn" style="padding:0.3rem 0.8rem;border:none;font-size:0.82rem;cursor:pointer">New run</button>
  <button id="as-view-judge-btn" onclick="switchAdStudioView('judge')" class="creatives-mode-btn" style="padding:0.3rem 0.8rem;border:none;font-size:0.82rem;cursor:pointer">Judge</button>
</div>

<div id="adstudio-new" style="display:none">
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));gap:0.75rem;margin-bottom:0.75rem">
    <label style="font-size:0.8rem">Product<br>
      <select id="as-product" class="creatives-select" onchange="adStudioProductChanged()" style="width:100%"></select></label>
    <label style="font-size:0.8rem">Variant<br>
      <select id="as-variant" class="creatives-select" style="width:100%"></select></label>
    <label style="font-size:0.8rem">Variations<br>
      <input id="as-variations" type="number" min="1" max="10" value="1" oninput="adStudioEstimate()" style="width:100%"></label>
    <label style="font-size:0.8rem">Targets<br>
      <select id="as-targets" class="creatives-select" onchange="adStudioEstimate()" style="width:100%">
        <option value="meta">Meta — 1:1, 4:5, 9:16</option>
        <option value="all">All — Meta + Demand Gen</option>
      </select></label>
    <label style="font-size:0.8rem">Render ceiling<br>
      <input id="as-max-renders" type="number" min="1" value="120" oninput="adStudioEstimate()" style="width:100%"></label>
  </div>

  <div style="margin-bottom:0.5rem;font-size:0.8rem;color:var(--muted)">
    Formats — none selected by default. <a href="#" onclick="adStudioSelectAllFormats();return false">select all</a>
  </div>
  <div id="as-formats" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:0.35rem;margin-bottom:0.75rem"></div>

  <div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap">
    <button id="as-dry-btn" onclick="adStudioLaunch(true)" class="creatives-mode-btn" style="padding:0.4rem 1rem;cursor:pointer">Dry run (free)</button>
    <button id="as-run-btn" onclick="adStudioLaunch(false)" class="creatives-mode-btn" style="padding:0.4rem 1rem;cursor:pointer" disabled>Render</button>
    <span id="as-estimate" style="font-size:0.85rem"></span>
    <span id="as-today" style="font-size:0.78rem;color:var(--muted)"></span>
  </div>
  <div id="as-launch-error" style="margin-top:0.5rem;font-size:0.82rem;color:var(--danger,#f87171)"></div>

  <div id="as-progress" style="margin-top:1rem;display:none">
    <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.5rem">
      <strong id="as-progress-status" style="font-size:0.9rem"></strong>
      <button id="as-cancel-btn" onclick="adStudioCancel()" class="creatives-mode-btn" style="padding:0.25rem 0.7rem;font-size:0.78rem;cursor:pointer">Cancel</button>
      <a id="as-judge-link" href="#" style="display:none;font-size:0.82rem" onclick="switchAdStudioView('judge');return false">Judge this run →</a>
    </div>
    <div id="as-progress-body" style="font-size:0.82rem"></div>
  </div>
</div>
```

Wrap the existing toolbar and `adstudio-body` in `<div id="adstudio-judge">` so the toggle can hide them.

- [ ] **Step 2: Add the browser logic**

In `agents/dashboard/public/js/dashboard.js`, beside `var adStudioState = ...` (~line 5567):

```js
var adStudioSetup = { options: null, view: 'new', jobId: null, pollTimer: null };

function switchAdStudioView(view) {
  adStudioSetup.view = view;
  document.getElementById('adstudio-new').style.display = view === 'new' ? '' : 'none';
  document.getElementById('adstudio-judge').style.display = view === 'judge' ? '' : 'none';
  var newBtn = document.getElementById('as-view-new-btn');
  var judgeBtn = document.getElementById('as-view-judge-btn');
  if (newBtn) newBtn.classList.toggle('active', view === 'new');
  if (judgeBtn) judgeBtn.classList.toggle('active', view === 'judge');
  if (view === 'judge') loadAdStudioRuns();
  else if (!adStudioSetup.options) loadAdStudioOptions();
}

async function loadAdStudioOptions() {
  try {
    var res = await fetch('/api/ad-studio/options', { credentials: 'same-origin' });
    adStudioSetup.options = await res.json();
  } catch (err) {
    document.getElementById('as-launch-error').textContent = 'Could not load options: ' + err.message;
    return;
  }
  var o = adStudioSetup.options;
  document.getElementById('as-product').innerHTML = o.products.map(function (p) {
    return '<option value="' + adStudioEsc(p.handle) + '">' + adStudioEsc(p.title) + '</option>';
  }).join('');
  // NOTHING is checked. The cheapest action must be the one you get by accident.
  document.getElementById('as-formats').innerHTML = o.formats.map(function (f) {
    return '<label style="font-size:0.82rem;display:block"><input type="checkbox" class="as-format" value="' +
      adStudioEsc(f.key) + '" onchange="adStudioEstimate()"> ' + adStudioEsc(f.key) +
      ' <span style="color:var(--muted)">' + adStudioEsc(f.name || '') + '</span></label>';
  }).join('');
  document.getElementById('as-max-renders').max = o.maxRendersCeiling;
  document.getElementById('as-variations').max = o.maxVariations;
  document.getElementById('as-today').textContent =
    o.rendersToday + ' render(s) billed today (Gemini allows 250)';
  adStudioProductChanged();
  if (o.activeJobId) adStudioPollJob(o.activeJobId);
}

function adStudioProductChanged() {
  var o = adStudioSetup.options;
  if (!o) return;
  var handle = document.getElementById('as-product').value;
  var product = o.products.filter(function (p) { return p.handle === handle; })[0];
  var variants = (product && product.variants) || [];
  document.getElementById('as-variant').innerHTML =
    '<option value="">(none)</option>' + variants.map(function (v) {
      return '<option value="' + adStudioEsc(v) + '">' + adStudioEsc(v) + '</option>';
    }).join('');
  adStudioEstimate();
}

function adStudioSelectedFormats() {
  return Array.prototype.slice.call(document.querySelectorAll('.as-format:checked'))
    .map(function (el) { return el.value; });
}

function adStudioSelectAllFormats() {
  Array.prototype.slice.call(document.querySelectorAll('.as-format'))
    .forEach(function (el) { el.checked = true; });
  adStudioEstimate();
}

// Mirrors lib/ad-studio-cost.js. A Meta target bills TWO renders — the plate and the
// comp derived from it. This copy is a DISPLAY convenience so the number moves while
// boxes are ticked; the authority is the server, which recomputes it at launch and
// refuses anything over the ceiling.
function adStudioEstimate() {
  var o = adStudioSetup.options;
  if (!o) return;
  var formats = adStudioSelectedFormats();
  var variations = parseInt(document.getElementById('as-variations').value, 10) || 0;
  var setKey = document.getElementById('as-targets').value;
  var set = o.targetSets.filter(function (t) { return t.key === setKey; })[0] || { meta: 0, demandGen: 0 };
  var concepts = formats.length * variations;
  var expected = concepts * (2 * set.meta + set.demandGen);
  var worst = concepts * (3 * (set.meta + set.demandGen) + set.meta);
  var usd = function (n) { return '$' + (n * o.perRenderUsd).toFixed(2); };
  document.getElementById('as-estimate').innerHTML = formats.length
    ? '<strong>' + expected + ' renders · ' + usd(expected) + '</strong>' +
      ' <span style="color:var(--muted)">worst case ' + worst + ' · ' + usd(worst) + '</span>'
    : '<span style="color:var(--muted)">$0.00 — pick a format</span>';
  document.getElementById('as-run-btn').disabled = formats.length === 0;
}

async function adStudioLaunch(dryRun) {
  var err = document.getElementById('as-launch-error');
  err.textContent = '';
  var body = {
    product: document.getElementById('as-product').value,
    variant: document.getElementById('as-variant').value || null,
    formats: adStudioSelectedFormats(),
    variations: parseInt(document.getElementById('as-variations').value, 10),
    targets: document.getElementById('as-targets').value,
    maxRenders: parseInt(document.getElementById('as-max-renders').value, 10),
    dryRun: !!dryRun,
  };
  document.getElementById('as-run-btn').disabled = true;
  document.getElementById('as-dry-btn').disabled = true;
  try {
    var res = await fetch('/api/ad-studio/launch', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    var data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    adStudioPollJob(data.jobId);
  } catch (e) {
    err.textContent = e.message;
    document.getElementById('as-dry-btn').disabled = false;
    adStudioEstimate();
  }
}

function adStudioPollJob(jobId) {
  adStudioSetup.jobId = jobId;
  document.getElementById('as-progress').style.display = '';
  if (adStudioSetup.pollTimer) clearInterval(adStudioSetup.pollTimer);
  var tick = async function () {
    var job;
    try {
      var res = await fetch('/api/ad-studio/job/' + encodeURIComponent(jobId), { credentials: 'same-origin' });
      job = await res.json();
    } catch (e) { return; }
    adStudioRenderJob(job);
    if (job.status === 'complete' || job.status === 'error' || job.status === 'cancelled') {
      clearInterval(adStudioSetup.pollTimer);
      adStudioSetup.pollTimer = null;
      document.getElementById('as-dry-btn').disabled = false;
      adStudioEstimate();
    }
  };
  adStudioSetup.pollTimer = setInterval(tick, 2000);
  tick();
}

function adStudioRenderJob(job) {
  var status = document.getElementById('as-progress-status');
  status.textContent = job.status + (job.runId ? ' — ' + job.runId : '');
  document.getElementById('as-cancel-btn').style.display = job.status === 'running' ? '' : 'none';
  var link = document.getElementById('as-judge-link');
  if (job.status === 'complete' && job.runId) {
    link.style.display = '';
    link.onclick = function () { switchAdStudioView('judge'); loadAdStudioRun(job.runId); return false; };
  } else {
    link.style.display = 'none';
  }

  var html = '';
  if (job.plan) {
    html += '<div style="color:var(--muted);margin-bottom:0.4rem">planned ' + job.plan.expected +
      ' render(s) · $' + job.plan.expectedUsd.toFixed(2) + '</div>';
  }
  if (job.error) {
    html += '<pre style="white-space:pre-wrap;color:var(--danger,#f87171)">' + adStudioEsc(job.error) + '</pre>';
  }
  var byConcept = {};
  (job.events || []).forEach(function (e) {
    byConcept[e.concept || '—'] = byConcept[e.concept || '—'] || [];
    byConcept[e.concept || '—'].push(e);
  });
  Object.keys(byConcept).forEach(function (concept) {
    html += '<div style="margin-bottom:0.5rem"><strong>' + adStudioEsc(concept) + '</strong>';
    byConcept[concept].forEach(function (e) {
      // A gate rejection is a first-class outcome, not an error page.
      var colour = e.state === 'accepted' ? 'var(--ok,#4ade80)'
        : (e.state === 'ok' ? 'var(--muted)' : 'var(--danger,#f87171)');
      html += '<div style="color:' + colour + '">' +
        adStudioEsc(e.stage) + (e.variation ? ' v' + e.variation : '') +
        (e.artifact ? ' · ' + adStudioEsc(e.artifact) : '') +
        ' — ' + adStudioEsc(e.state || '') +
        (e.attempts ? ' (' + e.attempts + ' attempt(s))' : '') +
        (typeof e.score === 'number' ? ' — ' + e.score + '/5' : '') +
        ((e.reasons && e.reasons.length) ? '<br><span style="color:var(--muted)">' + adStudioEsc(e.reasons.join('; ')) + '</span>' : '') +
        '</div>';
    });
    html += '</div>';
  });
  document.getElementById('as-progress-body').innerHTML = html;
}

async function adStudioCancel() {
  if (!adStudioSetup.jobId) return;
  await fetch('/api/ad-studio/job/' + encodeURIComponent(adStudioSetup.jobId) + '/cancel',
    { method: 'POST', credentials: 'same-origin' });
}
```

Finally, in `switchCreativesMode` (~line 2878), when the mode becomes `adstudio`, call `switchAdStudioView(adStudioSetup.view)` instead of `loadAdStudioRuns()` directly, so the tab opens on the setup form.

- [ ] **Step 3: Verify in a browser locally**

```bash
node agents/dashboard/index.js
```

Open `http://localhost:4242`, go to Creatives → Ad Studio. Confirm, by eye:

1. The tab opens on **New run** with **no format checked** and the estimate reading `$0.00 — pick a format`, Render disabled.
2. Ticking `ingredient-callout` makes it read **6 renders · $0.78, worst case 12 · $1.56** and enables Render.
3. Ticking a second format doubles it to 12 / $1.56.
4. Switching Targets to **All** with one format gives **9 renders · $1.17**.
5. Setting Variations to 3 with one format and Meta gives **18 · $2.34**.
6. **Dry run (free)** launches, the progress panel appears, and a `copy` line per concept arrives within ~60s, ending `complete`.
7. Switching to **Judge** still lists runs as before.

- [ ] **Step 4: Run the whole suite**

```bash
node --test 'tests/**/*.test.js' 2>&1 | tail -20
```

Expected: 0 fail and **0 cancelled**. Note the pass count for the PR body.

- [ ] **Step 5: Commit**

```bash
git add agents/dashboard/public/index.html agents/dashboard/public/js/dashboard.js
git commit -m "feat(dashboard): Ad Studio run setup and live progress

New run / Judge toggle inside the existing Ad Studio mode. The form starts
with NO format selected and the estimate at \$0.00 with Render disabled —
the CLI's empty-means-everything default inverted, so the cheapest action is
the one you get by accident and the cost of the sixth format is visible at
the moment it is being ticked.

Products, variants, formats and ratio counts all come from
/api/ad-studio/options, so a tenth format needs no UI edit. The browser's
copy of the cost formula is a display convenience; the server recomputes it
at launch and refuses anything over the ceiling.

Progress polls the job file every 2s and shows a gate-rejected concept as a
first-class outcome rather than an error page.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Ship it and prove it on the server

The only task that spends real money, and the only one that answers the question the whole project exists for: does `/api/ad-studio/runs` stop returning `{"runs":[]}` on the server.

**Files:** none — deployment and verification.

- [ ] **Step 1: Open the PR**

```bash
git push -u origin feat/ad-studio-server-runs
gh pr create --title "feat(ad-studio): run natively on the server, with creation inputs in the UI" --body "$(cat <<'EOF'
Makes the production server the place Ad Studio runs happen, launched from a
form in the dashboard with a live cost estimate before the button and live
progress after it. Fixes the judging screen returning `{"runs":[]}` on the
server — the agent had never run there.

Spec: `docs/superpowers/specs/2026-08-14-ad-studio-ui-design.md` (Addendum, 2026-08-16)
Plan: `docs/superpowers/plans/2026-08-16-ad-studio-server-runs.md`

## A Meta target bills two renders

The comp derived from each accepted Meta plate calls `budget.take()` like any
other render. The README, the UI spec's reconciliation table and its screen 1
all said one render per target. A default run is **6 renders / $0.78**, not 3
/ $0.39. `lib/ad-studio-cost.js` is the single implementation and its test
pins the numbers, including the $31.59 full sweep.

## Execution: a detached child, not the dashboard's process

The spec said to drive the agent's exported functions in-process. On a
1 vCPU / 961 MB box that means an OOM takes down `seo-dashboard` rather than
one run, and every `pm2 restart` kills a paid run. The agent is spawned
detached and writes structured progress into its own job file — which loses
none of what the original note was protecting, because nothing scrapes stdout.

The agent is the **only writer** of a job file after the route creates it,
including its own pid. Cancellation is a signal, not a write.

## Guardrails

A launch button on a publicly reachable URL is different from every other
route on this server: every field re-validated server-side, the render
ceiling clamped to 120 whatever the form sends, a run refused when its
expected renders exceed its own ceiling, and one run at a time — decided by
asking the OS whether the previous pid is alive, not by a lock file a deploy
or an OOM kill would strand.

## The creatives budget now fits the disk

10 GiB exceeded the server's 9.9 GB free, so the ceiling could never fire
before the disk filled — the failure that already cost this project four days
of cron. `CREATIVES_BUDGET_BYTES` overrides it; the server is set to 4 GiB.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Merge, set the server's budget, deploy**

Merge the PR on GitHub, then:

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && grep -q CREATIVES_BUDGET_BYTES .env || echo "CREATIVES_BUDGET_BYTES=4294967296" >> .env'
ssh root@137.184.119.230 'cd ~/seo-claude && git pull && pm2 restart seo-dashboard'
ssh root@137.184.119.230 'pm2 status && pm2 logs seo-dashboard --lines 20 --nostream'
```

Expected: `seo-dashboard` **online**, no startup errors.

- [ ] **Step 3: Confirm the server can see its own inputs**

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && curl -s -u "$DASHBOARD_USER:$DASHBOARD_PASSWORD" localhost:4242/api/ad-studio/options | head -c 400'
```

Expected: products with variants, 9 formats, `maxRendersCeiling: 120`. If products come back empty, `data/product-images/` is not where the route expects — stop and fix that before spending anything.

- [ ] **Step 4: A free dry run on the server, through the UI**

In the browser, on the dashboard's public URL: Creatives → Ad Studio → New run. Product `coconut-lotion`, variant `coconut-breeze`, format `ingredient-callout`, **Dry run**.

Expected: progress panel reaches `complete`, one `copy` event, nothing rendered, no charge beyond one Opus call.

- [ ] **Step 5: One real run — the smallest useful one**

Same form, **Render**. 1 format × 1 variation × Meta = **6 renders ≈ $0.78** (worst case $1.56).

Expected, in order:
1. Progress shows plates arriving one at a time with attempt counts and 1-5 scores.
2. It ends `complete` with a `runId`.
3. **"Judge this run →" opens the judging screen and the run is there** — this is the whole point of the project.
4. On the server: `ls ~/seo-claude/data/creatives/ad-studio/` lists the run.

- [ ] **Step 6: Verify the money and the disk**

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && cat data/creatives/ad-studio/*/run.json | grep -o "\"renders\":[0-9]*" | tail -3; du -sh data/creatives; df -h / | tail -1'
```

Expected: `renders` at or below the plan's 6 (a retry can push it toward 12 — a higher number is not a bug, it is a retry, and `proof.json` says which frame). `data/creatives` grew by ~50-150 MB and the disk still has headroom. Confirm the run's own log shows the 4 GiB budget, not 10:

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && CREATIVES_BUDGET_BYTES=4294967296 node scripts/creatives-budget.mjs | head -5'
```

- [ ] **Step 7: Verify cancellation actually stops a paid run**

Launch a 2-format Meta run (12 renders ≈ $1.56) and press **Cancel** after the first plate.

Expected: status goes to `cancelled` within seconds, the pid is gone (`ssh ... 'pgrep -f ad-studio'` returns nothing), the partial run directory still exists with its `run.json`, and — critically — **a new run can then be launched**, proving the one-at-a-time check reads liveness rather than a stranded lock.

- [ ] **Step 8: Clean up the worktree**

```bash
git -C /Users/seanfillmore/Code/Claude worktree remove /Users/seanfillmore/Code/Claude/.claude/worktrees/adstudio-server
```

Run output archives to the main checkout automatically (`lib/archive-run-output.js`), but confirm anything you want to keep is there **before** removing — `--force` deletes untracked files, which is how a set of sample plates was destroyed on 2026-08-15.

---

## Self-review against the spec

**Coverage of the addendum:**

| Addendum requirement | Task |
|---|---|
| Cost model `F × V × (2m + d)`, comps counted | 1 |
| README cost table + default-targets line corrected | 1 |
| Job file at `data/reports/ad-studio/jobs/`, atomic, pruned at 3 days | 2, 5 |
| Detached child, agent writes its own progress | 3, 5 |
| `--job-id` a no-op when absent | 3 |
| Cancel = SIGTERM, single writer | 3, 5 |
| Screen 1: product/variant/formats/variations/targets/max-renders, nothing pre-selected, estimate inline and live, dry run first-class | 6 |
| Screen 2: poll, tree by concept, gate rejection first-class, link into judging | 6 |
| One run at a time (409) | 2, 5 |
| Server-side validation, never client-trusted | 5 |
| Launch ceiling 120, clamped | 5 |
| `rendersToday` shown against the 250/day quota | 2, 5, 6 |
| `CREATIVES_BUDGET_BYTES`, server 4 GiB | 4 |
| Never echo `.env` or a stack trace | 3 (`fail()` message only), 5 |
| Judging screen works on the server | 7 |

**Known gap, accepted deliberately:** the cost formula exists twice — once in `lib/ad-studio-cost.js` (authoritative, tested) and once in `adStudioEstimate()` in the browser. The spec requires the number to move *while* boxes are ticked, and a round trip per checkbox over ngrok would not. The browser copy is four lines of arithmetic over counts the server supplies, and it is display-only: the server recomputes at launch and refuses anything over the ceiling, so a drifted browser number can mislead but can never overspend. Both are commented as mirrors of each other.

**Out of scope, per Sean 2026-08-16:** creative steering (angle, persona, chosen review), copy editing in the browser, format learning, uploading to Meta or Google.
