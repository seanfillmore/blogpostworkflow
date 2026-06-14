# Pipeline Prioritizer Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop — a durable provenance ledger links published posts to the signal type that caused them, a monthly weight tuner learns which signal types drive revenue and nudges `config/pipeline-priority.json` (bounded, auto-applied), and a dashboard panel shows what the prioritizer is doing.

**Architecture:** Pure, unit-tested libs (`lib/attribution-log.js`, `lib/priority-tuning.js`) + thin agent (`agents/priority-tuner/index.js`). The prioritizer appends attribution records during its apply step; the tuner joins that ledger against `seo-impact` action_wins. One small Phase-1 enhancement: `computePlan` attaches a structured `contributing` array so promotions can be attributed too. Dashboard reads the existing prioritizer report.

**Tech Stack:** Node.js ESM, `node --test`, existing libs (`lib/pipeline-priority.js`, `lib/seo-impact.js`, `lib/snapshot-health.js`, `lib/notify.js`, calendar-store).

**Spec:** `docs/superpowers/specs/2026-06-14-pipeline-prioritizer-phase2-design.md`

---

## File structure

| File | Responsibility | New/Modify |
|---|---|---|
| `lib/pipeline-priority.js` | Attach `contributing` array to scored/injected items | Modify |
| `lib/attribution-log.js` | `appendAttribution` / `readAttribution` (JSONL) | Create |
| `agents/pipeline-prioritizer/index.js` | Append attribution records on live apply | Modify |
| `config/pipeline-priority.json` | Add `tuning` block | Modify |
| `lib/priority-tuning.js` | `aggregatePerformance` / `proposeWeightChanges` / `applyWeightChanges` / `pathMatchesSlug` | Create |
| `agents/priority-tuner/index.js` | Monthly: join ledger × action_wins, apply bounded weight changes | Create |
| `scripts/setup-cron.sh` | Schedule priority-tuner monthly | Modify |
| `agents/dashboard/lib/data-loader.js` | Load `pipeline-prioritizer` + `priority-tuner` reports | Modify |
| `agents/dashboard/public/index.html` | "Pipeline Priority" card shell | Modify |
| `agents/dashboard/public/js/dashboard.js` | `renderPipelinePriority()` + wire into render | Modify |
| `tests/lib/attribution-log.test.js` | Tests | Create |
| `tests/lib/priority-tuning.test.js` | Tests | Create |
| `tests/lib/pipeline-priority.test.js` | Add `contributing` tests | Modify |

### Shared data shapes

**Attribution ledger record** (`data/reports/pipeline-prioritizer/attribution.jsonl`, one per line):
```js
{ ts: '2026-06-14T00:48:00Z', date: '2026-06-14', slug: 'coconut-oil-stretch-marks',
  keyword: 'coconut oil for stretch marks', signal_type: 'unmapped',
  strength: 5000, score: 40, action: 'inject', cluster: null }
```

**`contributing` entry** (attached by computePlan to each scored/injected item):
```js
{ type: 'revenue_cluster', strength: 111.8, score: 22 }
```

**Per-signal performance** (from `aggregatePerformance`):
```js
{ unmapped: { measured: 5, wins: 3, revenue: 180.5, score: 36.1 }, ... }
```

**Weight change** (from `proposeWeightChanges`):
```js
{ signal_type: 'unmapped', param: 'unmapped.perImpression', from: 0.01, to: 0.011, reason: 'score 36.1 vs mean 22.0 → +10%' }
```

---

## Task 1: computePlan attaches `contributing`

**Files:**
- Modify: `lib/pipeline-priority.js`
- Modify: `tests/lib/pipeline-priority.test.js`

Phase 1's `computePlan` already computes, per scored idea, which signals matched it (in `contributionsFor`). It returns only a `priority_provenance` string. Add a structured `contributing` array to each `scored` item and each `injections` item so the prioritizer can attribute promotions/injections to signal types.

- [ ] **Step 1: Add the failing test** — APPEND to `tests/lib/pipeline-priority.test.js`:

```js
test('computePlan: scored items carry a structured contributing[] of matched signals', () => {
  const plan = computePlan(baseInputs({
    signals: [{ type: 'revenue_cluster', key: 'toothpaste', cluster: 'toothpaste', taskType: 'new', strength: 111.8, label: 'revenue +$112' }],
  }));
  const a = plan.scored.find((i) => i.slug === 'a-post');
  assert.ok(Array.isArray(a.contributing));
  assert.equal(a.contributing.length, 1);
  assert.equal(a.contributing[0].type, 'revenue_cluster');
  assert.equal(a.contributing[0].score, 22);
  assert.equal(a.contributing[0].strength, 111.8);
});

test('computePlan: an idea with no matching signal has empty contributing[]', () => {
  const plan = computePlan(baseInputs()); // no signals
  const a = plan.scored.find((i) => i.slug === 'a-post');
  assert.deepEqual(a.contributing, []);
});

test('computePlan: injected idea carries contributing[] of its injecting signal', () => {
  const plan = computePlan(baseInputs({
    signals: [{ type: 'unmapped', key: 'coconut oil for stretch marks', taskType: 'new', cluster: null, strength: 5000, label: 'u' }],
  }));
  const inj = plan.injections.find((i) => i.keyword === 'coconut oil for stretch marks');
  assert.equal(inj.contributing[0].type, 'unmapped');
  assert.equal(inj.contributing[0].score, 40);
});
```

- [ ] **Step 2: Run, confirm the new tests FAIL** (contributing undefined):

Run: `node --test tests/lib/pipeline-priority.test.js`
Expected: the 3 new tests fail; the existing 31 still pass.

- [ ] **Step 3: Implement** — in `lib/pipeline-priority.js`, modify `contributionsFor` to also return the structured list, and attach it.

Change `contributionsFor` (inside `computePlan`) so it returns `contributing` too:

```js
  const contributionsFor = (idea) => {
    const hits = [
      ...(byKey.get(slugify(idea.keyword)) || []),
      ...(byKey.get(idea.slug) || []),
      ...(idea.cluster ? (byCluster.get(idea.cluster) || []) : []),
    ];
    const seen = new Set();
    let add = 0; const prov = []; const contributing = [];
    for (const { sig, c } of hits) {
      const id = `${sig.type}:${sig.key}`;
      if (seen.has(id)) continue; seen.add(id);
      add += c.score; prov.push(c.provenance);
      contributing.push({ type: sig.type, strength: sig.strength, score: c.score });
    }
    return { add, prov, contributing };
  };
```

In the "score existing backlog" map, attach `contributing`:

```js
  const scored = backlog.map((idea) => {
    const base = scoreBase(idea, cfg);
    const { add, prov, contributing } = contributionsFor(idea);
    const provenance = [`base ${base}`, ...prov].join(', ');
    return { ...idea, priority_score: base + add, priority_provenance: provenance, contributing };
  });
```

In the injections loop, attach `contributing` from the injecting signal (compute `c` is already there):

```js
    const idea = {
      slug: slugify(kw), keyword: kw, cluster: sig.cluster || null,
      volume: null, kd: null, search_intent: 'commercial',
      task_type: sig.taskType || 'new',
      source: sig.type === 'unmapped' ? 'gsc_unmapped' : sig.type,
      status_override: null, publish_date: null,
      priority_score: c.score, priority_provenance: `injected, ${c.provenance}`,
      contributing: [{ type: sig.type, strength: sig.strength, score: c.score }],
    };
```

- [ ] **Step 4: Run, confirm ALL pass** (34 total):

Run: `node --test tests/lib/pipeline-priority.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline-priority.js tests/lib/pipeline-priority.test.js
git commit -m "feat(pipeline-priority): attach structured contributing[] to scored/injected items"
```

---

## Task 2: Attribution log lib

**Files:**
- Create: `lib/attribution-log.js`
- Test: `tests/lib/attribution-log.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendAttribution, readAttribution } from '../../lib/attribution-log.js';

function tmpFile() {
  const dir = mkdtempSync(join(tmpdir(), 'attr-'));
  return { path: join(dir, 'attribution.jsonl'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('appendAttribution creates the file and writes one line per record', () => {
  const { path, cleanup } = tmpFile();
  try {
    appendAttribution([
      { ts: 't1', date: '2026-06-14', slug: 'a', keyword: 'a', signal_type: 'unmapped', strength: 5000, score: 40, action: 'inject', cluster: null },
      { ts: 't1', date: '2026-06-14', slug: 'b', keyword: 'b', signal_type: 'rank_drop', strength: 8, score: 24, action: 'promote', cluster: 'deodorant' },
    ], { path });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).slug, 'a');
  } finally { cleanup(); }
});

test('appendAttribution appends (does not overwrite) on a second call', () => {
  const { path, cleanup } = tmpFile();
  try {
    appendAttribution([{ slug: 'a', signal_type: 'unmapped' }], { path });
    appendAttribution([{ slug: 'b', signal_type: 'ai_gap' }], { path });
    assert.equal(readAttribution(path).length, 2);
  } finally { cleanup(); }
});

test('appendAttribution with empty array writes nothing / no error', () => {
  const { path, cleanup } = tmpFile();
  try {
    appendAttribution([], { path });
    assert.deepEqual(readAttribution(path), []);
  } finally { cleanup(); }
});

test('readAttribution returns [] for a missing file and skips malformed lines', () => {
  const { path, cleanup } = tmpFile();
  try {
    assert.deepEqual(readAttribution(join(path, 'nope.jsonl')), []);
    writeFileSync(path, '{"slug":"ok"}\nNOT JSON\n{"slug":"ok2"}\n');
    assert.deepEqual(readAttribution(path).map((r) => r.slug), ['ok', 'ok2']);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run, confirm FAIL** (module not found):

Run: `node --test tests/lib/attribution-log.test.js`

- [ ] **Step 3: Implement** `lib/attribution-log.js`:

```js
// lib/attribution-log.js
// Append-only ledger linking a published post (slug) back to the signal type that
// caused the pipeline-prioritizer to create or fast-track it. This is the durable
// record the weight tuner joins against seo-impact action_wins — the prioritizer's
// latest.json is overwritten each run, so attribution must be logged here to survive
// the weeks until revenue accrues. See the Phase 2 design doc.

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Append attribution records (one JSON object per line). Creates the file/dir if
 * absent. No-op for an empty/missing array.
 * @param {Array<object>} records
 * @param {{path:string}} opts
 */
export function appendAttribution(records, { path } = {}) {
  if (!path || !Array.isArray(records) || records.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  appendFileSync(path, lines);
}

/** Read a JSONL ledger → array of records. Missing file → []. Malformed lines skipped. */
export function readAttribution(path) {
  if (!path || !existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip malformed */ }
  }
  return out;
}
```

- [ ] **Step 4: Run, confirm ALL 4 PASS.**

- [ ] **Step 5: Commit**

```bash
git add lib/attribution-log.js tests/lib/attribution-log.test.js
git commit -m "feat(attribution-log): append-only signal→post provenance ledger"
```

---

## Task 3: Prioritizer writes attribution records

**Files:**
- Modify: `agents/pipeline-prioritizer/index.js`

Append ledger records during the LIVE apply step (never in `--dry-run`). For each injection: one record with `signal_type = its contributing[0].type`, `action: 'inject'`. For each promotion: one record per contributing signal type of the promoted slug, `action: 'promote'`. Promotions with no contributing signals (pure base score) write nothing.

- [ ] **Step 1: Add the import** near the other lib imports:

```js
import { appendAttribution } from '../../lib/attribution-log.js';
```

And add a path constant near `SIGNAL_STATE_PATH`:

```js
const ATTRIBUTION_PATH = join(REPORTS_DIR, 'attribution.jsonl');
```

- [ ] **Step 2: Build + append records in the apply section.** After the promote loop (Task 10B's `// 3) promote:` block) and before the report writes (`// 4) persist signal state + report`), add:

```js
  // 3b) attribution ledger — durable signal→post link for the weight tuner.
  // Reuses `scoredBySlug` declared in apply step 1 (values are plan.scored items,
  // which carry `contributing` after the Task 1 computePlan change).
  const nowIso = new Date().toISOString();
  const attribution = [];
  for (const idea of plan.injections) {
    const c = (idea.contributing && idea.contributing[0]) || null;
    if (!c) continue;
    attribution.push({ ts: nowIso, date: today, slug: idea.slug, keyword: idea.keyword,
      signal_type: c.type, strength: c.strength, score: c.score, action: 'inject', cluster: idea.cluster || null });
  }
  for (const p of payload.promotions) { // payload.promotions excludes any cratered-demand skips
    const item = scoredBySlug.get(p.slug);
    for (const c of (item?.contributing || [])) {
      attribution.push({ ts: nowIso, date: today, slug: p.slug, keyword: item.keyword,
        signal_type: c.type, strength: c.strength, score: c.score, action: 'promote', cluster: item.cluster || null });
    }
  }
  appendAttribution(attribution, { path: ATTRIBUTION_PATH });
  if (attribution.length) console.log(`  Attribution: logged ${attribution.length} signal→post record(s).`);
```

NOTE on ordering: this runs only in the live path (after the `if (DRY_RUN) { ...; return; }` guard), so dry-run writes no ledger records. `payload.promotions` is used (not `plan.promotions`) so a promotion skipped for cratered demand in Task 10B is not falsely attributed.

- [ ] **Step 3: Verify dry-run writes no ledger** and the code loads:

Run: `node agents/pipeline-prioritizer/index.js --dry-run`
Expected: clean dry-run; no "Attribution: logged" line; `data/reports/pipeline-prioritizer/attribution.jsonl` is NOT created by this run (check: `test -f data/reports/pipeline-prioritizer/attribution.jsonl && echo EXISTS || echo absent`).

- [ ] **Step 4: Verify the agent test still passes:**

Run: `node --test tests/agents/pipeline-prioritizer.test.js`
Expected: PASS (1/1).

- [ ] **Step 5: Commit**

```bash
git add agents/pipeline-prioritizer/index.js
git commit -m "feat(pipeline-prioritizer): write signal→post attribution ledger on apply"
```

---

## Task 4: Config — tuning block

**Files:**
- Modify: `config/pipeline-priority.json`

- [ ] **Step 1: Add a `tuning` key** to `config/pipeline-priority.json` (sibling of `signals`). The file currently ends with the `signals` object; add `tuning` after it:

```json
  "tuning": {
    "minSamplesPerSignal": 3,
    "totalFloor": 8,
    "maxStepPct": 0.10,
    "measureLagDays": 28,
    "paramBounds": {
      "unmapped.perImpression":    { "min": 0.002, "max": 0.05 },
      "rank_drop.perPosition":     { "min": 1,     "max": 8 },
      "revenue_cluster.perDollar": { "min": 0.05,  "max": 0.6 },
      "competitor_gap.boost":      { "min": 5,     "max": 30 },
      "ai_gap.boost":              { "min": 4,     "max": 24 }
    }
  }
```

(Remember to add a comma after the `signals` object's closing brace.)

- [ ] **Step 2: Verify valid JSON:**

Run: `node -e "const c=require('./config/pipeline-priority.json'); console.log('tuning ok:', !!c.tuning, 'bounds:', Object.keys(c.tuning.paramBounds).length)"`
Expected: `tuning ok: true bounds: 5`

- [ ] **Step 3: Commit**

```bash
git add config/pipeline-priority.json
git commit -m "feat(pipeline-priority): tuning config block (bounds, step, lag, guards)"
```

---

## Task 5: priority-tuning — aggregatePerformance + pathMatchesSlug

**Files:**
- Create: `lib/priority-tuning.js`
- Test: `tests/lib/priority-tuning.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { aggregatePerformance, pathMatchesSlug } from '../../lib/priority-tuning.js';

const TODAY = '2026-06-14';
const LAG = 28;

test('pathMatchesSlug matches blog path suffix', () => {
  assert.equal(pathMatchesSlug('/blogs/news/coconut-oil-stretch-marks', 'coconut-oil-stretch-marks'), true);
  assert.equal(pathMatchesSlug('/blogs/news/other-post', 'coconut-oil-stretch-marks'), false);
});

test('aggregatePerformance: only counts records older than the lag window', () => {
  const ledger = [
    { slug: 'old', signal_type: 'unmapped', date: '2026-05-01', action: 'inject' }, // 44d ago — measurable
    { slug: 'new', signal_type: 'unmapped', date: '2026-06-10', action: 'inject' }, // 4d ago — too recent
  ];
  const wins = [{ path: '/blogs/news/old', revenueDelta: 50 }];
  const perf = aggregatePerformance(ledger, wins, { today: TODAY, measureLagDays: LAG });
  assert.equal(perf.unmapped.measured, 1);   // only 'old'
  assert.equal(perf.unmapped.wins, 1);
  assert.equal(perf.unmapped.revenue, 50);
  assert.equal(perf.unmapped.score, 50);     // revenue / measured
});

test('aggregatePerformance: a measured post with no win counts toward measured, not wins', () => {
  const ledger = [{ slug: 'flop', signal_type: 'rank_drop', date: '2026-05-01', action: 'promote' }];
  const perf = aggregatePerformance(ledger, [], { today: TODAY, measureLagDays: LAG });
  assert.equal(perf.rank_drop.measured, 1);
  assert.equal(perf.rank_drop.wins, 0);
  assert.equal(perf.rank_drop.revenue, 0);
  assert.equal(perf.rank_drop.score, 0);
});

test('aggregatePerformance: dedups a slug attributed to the same signal twice (inject + promote)', () => {
  const ledger = [
    { slug: 'p', signal_type: 'unmapped', date: '2026-05-01', action: 'inject' },
    { slug: 'p', signal_type: 'unmapped', date: '2026-05-02', action: 'promote' },
  ];
  const wins = [{ path: '/blogs/news/p', revenueDelta: 30 }];
  const perf = aggregatePerformance(ledger, wins, { today: TODAY, measureLagDays: LAG });
  assert.equal(perf.unmapped.measured, 1); // counted once
  assert.equal(perf.unmapped.revenue, 30);
});

test('aggregatePerformance: a slug under two different signals counts for each', () => {
  const ledger = [
    { slug: 'p', signal_type: 'unmapped', date: '2026-05-01', action: 'inject' },
    { slug: 'p', signal_type: 'revenue_cluster', date: '2026-05-01', action: 'promote' },
  ];
  const wins = [{ path: '/blogs/news/p', revenueDelta: 40 }];
  const perf = aggregatePerformance(ledger, wins, { today: TODAY, measureLagDays: LAG });
  assert.equal(perf.unmapped.measured, 1);
  assert.equal(perf.revenue_cluster.measured, 1);
});
```

- [ ] **Step 2: Run, confirm FAIL** (module not found).

- [ ] **Step 3: Implement** `lib/priority-tuning.js`:

```js
// lib/priority-tuning.js
// Pure brain for the closed-loop weight tuner. Joins the prioritizer's attribution
// ledger (signal→post) against seo-impact action_wins (post→revenue) to measure which
// signal types actually drive revenue, then proposes bounded nudges to the per-signal
// weight knobs in config/pipeline-priority.json. No I/O. See Phase 2 design doc.

const DAY_MS = 86400000;

/** True if an action_win path belongs to the given post slug (path suffix match). */
export function pathMatchesSlug(path, slug) {
  if (!path || !slug) return false;
  const tail = String(path).split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop();
  return tail === slug;
}

/**
 * Per-signal-type performance from the ledger + action_wins.
 * Only ledger records whose `date` is >= measureLagDays old are "measurable".
 * A (slug, signal_type) pair is counted once. score = revenue / measured.
 * @returns {{ [signalType:string]: {measured, wins, revenue, score} }}
 */
export function aggregatePerformance(ledger, actionWins, { today, measureLagDays }) {
  const todayMs = Date.parse(today + 'T00:00:00Z');
  const measurable = (ledger || []).filter((r) => {
    if (!r.date) return false;
    const age = Math.floor((todayMs - Date.parse(r.date + 'T00:00:00Z')) / DAY_MS);
    return age >= measureLagDays;
  });

  // win lookup by slug → revenueDelta (max if multiple paths map to the slug)
  const winRevenueBySlug = new Map();
  for (const w of (actionWins || [])) {
    for (const r of measurable) {
      if (pathMatchesSlug(w.path, r.slug)) {
        const prev = winRevenueBySlug.get(r.slug) || 0;
        winRevenueBySlug.set(r.slug, Math.max(prev, w.revenueDelta || 0));
      }
    }
  }

  // dedup (slug, signal_type)
  const seen = new Set();
  const perf = {};
  for (const r of measurable) {
    const key = `${r.slug}:${r.signal_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const p = (perf[r.signal_type] ||= { measured: 0, wins: 0, revenue: 0, score: 0 });
    p.measured += 1;
    const rev = winRevenueBySlug.get(r.slug) || 0;
    if (rev > 0) { p.wins += 1; p.revenue += rev; }
  }
  for (const t of Object.keys(perf)) {
    perf[t].revenue = Math.round(perf[t].revenue * 100) / 100;
    perf[t].score = perf[t].measured ? Math.round((perf[t].revenue / perf[t].measured) * 100) / 100 : 0;
  }
  return perf;
}
```

- [ ] **Step 4: Run, confirm ALL PASS.**

- [ ] **Step 5: Commit**

```bash
git add lib/priority-tuning.js tests/lib/priority-tuning.test.js
git commit -m "feat(priority-tuning): aggregatePerformance + pathMatchesSlug"
```

---

## Task 6: priority-tuning — proposeWeightChanges

**Files:**
- Modify: `lib/priority-tuning.js`
- Modify: `tests/lib/priority-tuning.test.js`

- [ ] **Step 1: Add the failing test** — APPEND:

```js
import { proposeWeightChanges } from '../../lib/priority-tuning.js';

const CFG = {
  signals: {
    unmapped:        { perImpression: 0.01 },
    rank_drop:       { perPosition: 3 },
    revenue_cluster: { perDollar: 0.2 },
    competitor_gap:  { boost: 15 },
    ai_gap:          { boost: 12 },
  },
  tuning: {
    minSamplesPerSignal: 3, totalFloor: 8, maxStepPct: 0.10,
    paramBounds: {
      'unmapped.perImpression':    { min: 0.002, max: 0.05 },
      'rank_drop.perPosition':     { min: 1, max: 8 },
      'revenue_cluster.perDollar': { min: 0.05, max: 0.6 },
      'competitor_gap.boost':      { min: 5, max: 30 },
      'ai_gap.boost':              { min: 4, max: 24 },
    },
  },
};

test('proposeWeightChanges: above-mean signal nudged up, below-mean nudged down (bounded)', () => {
  const perf = {
    unmapped:  { measured: 5, wins: 4, revenue: 200, score: 40 }, // high
    rank_drop: { measured: 5, wins: 1, revenue: 20,  score: 4 },  // low  (mean = 22)
  };
  const changes = proposeWeightChanges(perf, CFG);
  const up = changes.find((c) => c.signal_type === 'unmapped');
  const down = changes.find((c) => c.signal_type === 'rank_drop');
  assert.ok(up.to > up.from);                 // 0.01 → 0.011 (+10% capped)
  assert.equal(up.to, 0.011);
  assert.ok(down.to < down.from);             // 3 → 2.7
  assert.equal(down.to, 2.7);
});

test('proposeWeightChanges: signal below minSamplesPerSignal is not changed', () => {
  const perf = {
    unmapped:  { measured: 5, wins: 4, revenue: 200, score: 40 },
    rank_drop: { measured: 5, wins: 0, revenue: 0,   score: 0 },
    ai_gap:    { measured: 1, wins: 1, revenue: 99,  score: 99 }, // too few samples
  };
  const changes = proposeWeightChanges(perf, CFG);
  assert.ok(!changes.find((c) => c.signal_type === 'ai_gap'));
});

test('proposeWeightChanges: no-op when fewer than 2 signals qualify', () => {
  const perf = { unmapped: { measured: 5, wins: 4, revenue: 200, score: 40 } };
  assert.deepEqual(proposeWeightChanges(perf, CFG), []);
});

test('proposeWeightChanges: no-op when total measured below totalFloor', () => {
  const perf = {
    unmapped:  { measured: 3, wins: 1, revenue: 30, score: 10 },
    rank_drop: { measured: 3, wins: 1, revenue: 60, score: 20 }, // total 6 < floor 8
  };
  assert.deepEqual(proposeWeightChanges(perf, CFG), []);
});

test('proposeWeightChanges: clamps to param max', () => {
  const cfg = JSON.parse(JSON.stringify(CFG));
  cfg.signals.unmapped.perImpression = 0.05; // already at max
  const perf = {
    unmapped:  { measured: 5, wins: 5, revenue: 500, score: 100 },
    rank_drop: { measured: 5, wins: 1, revenue: 20,  score: 4 },
  };
  const changes = proposeWeightChanges(perf, cfg);
  const up = changes.find((c) => c.signal_type === 'unmapped');
  // would go above max → clamped to 0.05 → from===to → omitted
  assert.ok(!up || up.to <= 0.05);
});
```

- [ ] **Step 2: Run, confirm new tests FAIL** (proposeWeightChanges not exported).

- [ ] **Step 3: Implement** — APPEND to `lib/priority-tuning.js`:

```js
// Which knob each signal type tunes.
const PARAM_OF = {
  unmapped: 'unmapped.perImpression',
  rank_drop: 'rank_drop.perPosition',
  revenue_cluster: 'revenue_cluster.perDollar',
  competitor_gap: 'competitor_gap.boost',
  ai_gap: 'ai_gap.boost',
};

function getParam(cfg, param) {
  const [sig, key] = param.split('.');
  return cfg.signals[sig]?.[key];
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function round4(v) { return Math.round(v * 10000) / 10000; }

/**
 * Propose bounded weight nudges. Qualifying signals (measured >= minSamplesPerSignal)
 * are nudged toward their score relative to the qualifying-signal mean, by at most
 * maxStepPct, clamped to paramBounds. Whole-run no-op if <2 qualify or total measured
 * (across ALL signals) < totalFloor. Returns only knobs that actually change.
 */
export function proposeWeightChanges(perf, cfg) {
  const t = cfg.tuning;
  const totalMeasured = Object.values(perf).reduce((a, p) => a + (p.measured || 0), 0);
  if (totalMeasured < t.totalFloor) return [];

  const qualifying = Object.entries(perf).filter(([, p]) => p.measured >= t.minSamplesPerSignal);
  if (qualifying.length < 2) return [];

  const mean = qualifying.reduce((a, [, p]) => a + p.score, 0) / qualifying.length;
  if (mean <= 0) return [];

  const changes = [];
  for (const [signal_type, p] of qualifying) {
    const param = PARAM_OF[signal_type];
    if (!param) continue;
    const from = getParam(cfg, param);
    const bounds = t.paramBounds[param];
    if (from == null || !bounds) continue;
    const rel = clamp(p.score / mean - 1, -1, 1);       // -1..+1
    const factor = 1 + rel * t.maxStepPct;               // within ±maxStepPct
    const to = round4(clamp(from * factor, bounds.min, bounds.max));
    if (to === round4(from)) continue;                   // no effective change
    const dir = to > from ? '+' : '−';
    changes.push({ signal_type, param, from, to,
      reason: `score ${p.score} vs mean ${Math.round(mean * 100) / 100} → ${dir}${Math.abs(Math.round((to / from - 1) * 100))}%` });
  }
  return changes;
}
```

- [ ] **Step 4: Run, confirm ALL PASS.**

- [ ] **Step 5: Commit**

```bash
git add lib/priority-tuning.js tests/lib/priority-tuning.test.js
git commit -m "feat(priority-tuning): proposeWeightChanges (bounded, guarded nudges)"
```

---

## Task 7: priority-tuning — applyWeightChanges

**Files:**
- Modify: `lib/priority-tuning.js`
- Modify: `tests/lib/priority-tuning.test.js`

- [ ] **Step 1: Add the failing test** — APPEND:

```js
import { applyWeightChanges } from '../../lib/priority-tuning.js';

test('applyWeightChanges: returns a new cfg with changed knobs, others untouched', () => {
  const cfg = JSON.parse(JSON.stringify(CFG));
  const changes = [
    { signal_type: 'unmapped', param: 'unmapped.perImpression', from: 0.01, to: 0.011, reason: 'x' },
    { signal_type: 'rank_drop', param: 'rank_drop.perPosition', from: 3, to: 2.7, reason: 'y' },
  ];
  const out = applyWeightChanges(cfg, changes);
  assert.equal(out.signals.unmapped.perImpression, 0.011);
  assert.equal(out.signals.rank_drop.perPosition, 2.7);
  assert.equal(out.signals.revenue_cluster.perDollar, 0.2); // untouched
  // original not mutated
  assert.equal(cfg.signals.unmapped.perImpression, 0.01);
});

test('applyWeightChanges: empty changes returns an equivalent cfg', () => {
  const cfg = JSON.parse(JSON.stringify(CFG));
  const out = applyWeightChanges(cfg, []);
  assert.deepEqual(out.signals, cfg.signals);
});
```

- [ ] **Step 2: Run, confirm FAIL.**

- [ ] **Step 3: Implement** — APPEND to `lib/priority-tuning.js`:

```js
/** Apply weight changes to a deep copy of cfg (pure — does not mutate the input). */
export function applyWeightChanges(cfg, changes) {
  const out = JSON.parse(JSON.stringify(cfg));
  for (const c of (changes || [])) {
    const [sig, key] = c.param.split('.');
    if (out.signals[sig]) out.signals[sig][key] = c.to;
  }
  return out;
}
```

- [ ] **Step 4: Run, confirm ALL PASS.**

- [ ] **Step 5: Commit**

```bash
git add lib/priority-tuning.js tests/lib/priority-tuning.test.js
git commit -m "feat(priority-tuning): applyWeightChanges (pure cfg merge)"
```

---

## Task 8: priority-tuner agent

**Files:**
- Create: `agents/priority-tuner/index.js`
- Test: `tests/agents/priority-tuner.test.js`

- [ ] **Step 1: Write the agent**

```js
#!/usr/bin/env node
/**
 * Priority Tuner (closed-loop weight tuner)
 *
 * Monthly. Joins the prioritizer's attribution ledger (signal→post) against
 * seo-impact action_wins (post→revenue) to measure which signal types actually drive
 * revenue, then applies BOUNDED nudges to the per-signal weight knobs in
 * config/pipeline-priority.json. Auto-applied (each step clamped + ≤maxStepPct, every
 * change logged to tuning-history.jsonl for manual revert). No-ops until enough
 * measured outcomes accrue (~6-8 weeks after Phase 1 goes live).
 *
 * The decision logic lives in lib/priority-tuning.js (pure, unit-tested).
 *
 * Usage:
 *   node agents/priority-tuner/index.js            # apply
 *   node agents/priority-tuner/index.js --dry-run  # print, write nothing
 *
 * See docs/superpowers/specs/2026-06-14-pipeline-prioritizer-phase2-design.md
 */

import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAttribution } from '../../lib/attribution-log.js';
import { aggregatePerformance, proposeWeightChanges, applyWeightChanges } from '../../lib/priority-tuning.js';
import { newestReportDate } from '../../lib/snapshot-health.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CONFIG_PATH = join(ROOT, 'config', 'pipeline-priority.json');
const ATTRIBUTION_PATH = join(ROOT, 'data', 'reports', 'pipeline-prioritizer', 'attribution.jsonl');
const SEO_IMPACT_PATH = join(ROOT, 'data', 'reports', 'seo-impact', 'latest.json');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'priority-tuner');
const HISTORY_PATH = join(REPORTS_DIR, 'tuning-history.jsonl');
const DRY_RUN = process.argv.includes('--dry-run');

const ymd = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }

async function main() {
  console.log('\nPriority Tuner' + (DRY_RUN ? ' (dry-run)' : '') + '\n');
  const today = ymd(Date.now());
  const cfg = readJson(CONFIG_PATH);
  if (!cfg?.tuning) { console.error('No tuning config; aborting.'); process.exit(1); }

  // seo-impact freshness — don't tune on stale outcome data (allow 35d: monthly cadence)
  const impactDate = newestReportDate(SEO_IMPACT_PATH);
  const impactAge = impactDate ? Math.floor((Date.parse(today) - Date.parse(impactDate)) / 86400000) : Infinity;
  if (impactAge > 35) {
    console.log(`  seo-impact stale (${impactDate || 'missing'}); skipping tune.`);
    writeReport({ today, status: 'skipped', reason: `seo-impact stale (${impactDate || 'missing'})`, perf: {}, changes: [] });
    return;
  }

  const ledger = readAttribution(ATTRIBUTION_PATH);
  const actionWins = (readJson(SEO_IMPACT_PATH)?.action_wins) || [];
  const perf = aggregatePerformance(ledger, actionWins, { today, measureLagDays: cfg.tuning.measureLagDays });
  const changes = proposeWeightChanges(perf, cfg);

  console.log(`  Ledger records: ${ledger.length} | signal types measured: ${Object.keys(perf).length}`);
  for (const [t, p] of Object.entries(perf)) console.log(`    ${t}: measured ${p.measured}, wins ${p.wins}, $${p.revenue}, score ${p.score}`);
  console.log(`  Proposed changes: ${changes.length}`);
  for (const c of changes) console.log(`    ${c.param}: ${c.from} → ${c.to} (${c.reason})`);

  if (DRY_RUN) { console.log('\nDry-run: no changes written.'); return; }

  if (!changes.length) {
    writeReport({ today, status: 'no-op', reason: 'insufficient data or no qualifying signals', perf, changes: [] });
    console.log('\n  No-op (insufficient data). Report written, config unchanged.');
    return;
  }

  const newCfg = applyWeightChanges(cfg, changes);
  writeFileSync(CONFIG_PATH, JSON.stringify(newCfg, null, 2) + '\n');

  mkdirSync(REPORTS_DIR, { recursive: true });
  appendFileSync(HISTORY_PATH, JSON.stringify({ ts: new Date().toISOString(), date: today, changes }) + '\n');
  writeReport({ today, status: 'applied', reason: '', perf, changes });

  await notify({
    subject: `Priority tuner: adjusted ${changes.length} signal weight(s)`,
    body: changes.map((c) => `- ${c.param}: ${c.from} → ${c.to} (${c.reason})`).join('\n'),
    status: 'info', category: 'content',
  }).catch(() => {});
  console.log(`\n  Applied ${changes.length} change(s). config + history updated.`);
}

function writeReport({ today, status, reason, perf, changes }) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const payload = { generated_at: new Date().toISOString(), status, reason, performance: perf, changes };
  writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify(payload, null, 2));
  const L = ['# Priority Tuner Report', '', `**Status:** ${status}${reason ? ` — ${reason}` : ''}`, ''];
  if (Object.keys(perf).length) {
    L.push('## Per-signal performance (measured posts)', '');
    for (const [t, p] of Object.entries(perf)) L.push(`- **${t}**: measured ${p.measured}, wins ${p.wins}, $${p.revenue}, score ${p.score}`);
    L.push('');
  }
  if (changes.length) { L.push('## Weight changes', ''); for (const c of changes) L.push(`- \`${c.param}\`: ${c.from} → ${c.to} (${c.reason})`); }
  writeFileSync(join(REPORTS_DIR, `${today}.md`), L.join('\n'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error('Priority tuner failed:', err); process.exit(1); });
}
```

- [ ] **Step 2: Write the dry-run integration test** `tests/agents/priority-tuner.test.js`:

```js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

test('priority-tuner --dry-run runs and writes neither config nor report', () => {
  const cfgBefore = readFileSync(join(ROOT, 'config', 'pipeline-priority.json'), 'utf8');
  const reportP = join(ROOT, 'data', 'reports', 'priority-tuner', 'latest.json');
  const reportBefore = existsSync(reportP) ? readFileSync(reportP, 'utf8') : null;

  const out = execFileSync('node', ['agents/priority-tuner/index.js', '--dry-run'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /Priority Tuner \(dry-run\)/);
  assert.match(out, /no changes written/);

  assert.equal(readFileSync(join(ROOT, 'config', 'pipeline-priority.json'), 'utf8'), cfgBefore); // config untouched
  const reportAfter = existsSync(reportP) ? readFileSync(reportP, 'utf8') : null;
  assert.equal(reportAfter, reportBefore); // dry-run writes no report
});
```

- [ ] **Step 3: Run the test:**

Run: `node --test tests/agents/priority-tuner.test.js`
Expected: PASS. (If a lib import name mismatches, fix to the real export and re-run.)

- [ ] **Step 4: Manual smoke test** (current data: empty action_wins → no-op):

Run: `node agents/priority-tuner/index.js --dry-run`
Expected: prints ledger record count (0 today), measured signal types (0), proposed changes 0, and "Dry-run: no changes written." No throw.

- [ ] **Step 5: Commit**

```bash
git add agents/priority-tuner/index.js tests/agents/priority-tuner.test.js
git commit -m "feat(priority-tuner): monthly closed-loop weight tuner agent"
```

---

## Task 9: Schedule priority-tuner (monthly cron)

**Files:**
- Modify: `scripts/setup-cron.sh`

- [ ] **Step 1: Study the monthly entries.** Read `scripts/setup-cron.sh`; find the MONTHLY section (e.g. the content-gap entry `0 8 1 * *`) and the variable + install-block style.

- [ ] **Step 2: Add a monthly entry.** Schedule the tuner for the 1st at a time after seo-impact has produced its latest.json. Add a variable matching the file's style:

```bash
MONTHLY_PRIORITY_TUNER="0 16 1 * * cd \"$PROJECT_DIR\" && /usr/bin/node agents/priority-tuner/index.js >> $LOG_DIR/priority-tuner.log 2>&1"
```

(Use the SAME `cd`, node path, and `$LOG_DIR`/`$PROJECT_DIR` variables the other entries use — match exactly. 16:00 UTC on the 1st is after the daily signal band and the prioritizer; adjust only if the file's conventions differ.)

Then add `$MONTHLY_PRIORITY_TUNER` to the crontab install block alongside the other monthly entries, and to the printed summary if the script echoes one.

- [ ] **Step 3: Verify syntax + presence:**

Run: `bash -n scripts/setup-cron.sh` (expect no output)
Run: `grep -n "priority-tuner" scripts/setup-cron.sh` (expect the var definition + install reference)

Do NOT run the installer locally (it edits the crontab — happens on the server at deploy).

- [ ] **Step 4: Commit**

```bash
git add scripts/setup-cron.sh
git commit -m "chore(cron): schedule priority-tuner monthly (1st, 16:00 UTC)"
```

---

## Task 10: Dashboard data-loader

**Files:**
- Modify: `agents/dashboard/lib/data-loader.js`

- [ ] **Step 1: Add the loads.** In `agents/dashboard/lib/data-loader.js`, near the other `readJsonIfExists(...)` calls (around lines 266-276), add:

```js
  const pipelinePrioritizer = readJsonIfExists(join(REPORTS_DIR, 'pipeline-prioritizer', 'latest.json'));
  const priorityTuner       = readJsonIfExists(join(REPORTS_DIR, 'priority-tuner', 'latest.json'));
```

- [ ] **Step 2: Add to the return object.** In the `return { ... }` block (around line 397), add the two keys (e.g. after `seoImpact,`):

```js
    pipelinePrioritizer,
    priorityTuner,
```

- [ ] **Step 3: Verify it loads without error:**

Run: `node -e "import('./agents/dashboard/lib/data-loader.js').then(m => { const d = m.loadData(); console.log('keys present:', 'pipelinePrioritizer' in d, 'priorityTuner' in d); })"`
Expected: `keys present: true true` (values may be null if reports absent — that's fine).

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/lib/data-loader.js
git commit -m "feat(dashboard): load pipeline-prioritizer + priority-tuner reports"
```

---

## Task 11: Dashboard "Pipeline Priority" card

**Files:**
- Modify: `agents/dashboard/public/index.html`
- Modify: `agents/dashboard/public/js/dashboard.js`

NOTE: `public/js/dashboard.js` is a standalone browser file (NOT inside a server template literal), so the `\n`→`\\n` escaping caveat does NOT apply here — edit normally. Use the existing `esc()` helper for any interpolated text.

- [ ] **Step 1: Add the card shell to `index.html`.** Next to the SEO Impact card (after the `seo-impact-card` div, around line 88), add:

```html
  <!-- Pipeline Priority — what the prioritizer is doing -->
  <div class="card" id="pipeline-priority-card" style="display:none">
    <div class="card-header"><h2>Pipeline Priority</h2><span class="section-note" id="pipeline-priority-note"></span></div>
    <div class="card-body" id="pipeline-priority-body"></div>
  </div>
```

- [ ] **Step 2: Add `renderPipelinePriority()` to `dashboard.js`.** Add this function (e.g. just after `renderSeoImpact`):

```js
function renderPipelinePriority(d) {
  var card = document.getElementById('pipeline-priority-card');
  var p = d && d.pipelinePrioritizer;
  if (!card) return;
  if (!p) { card.style.display = 'none'; return; }
  card.style.display = '';

  document.getElementById('pipeline-priority-note').textContent =
    'backlog ' + (p.backlog_depth || 0) + ' · buffer ' + (p.buffer_ready || 0) + '/' + (p.buffer_target || 0);

  var html = '';

  var promos = p.promotions || [];
  if (promos.length) {
    html += '<h3 style="font-size:13px;margin:6px 0">Fast-tracked / written next</h3>';
    html += '<ul style="margin:0 0 10px;padding-left:18px;font-size:13px">' +
      promos.map(function(x) {
        return '<li><strong>' + esc(x.slug) + '</strong> → ' + esc(String(x.publish_date || '').slice(0, 10)) +
          ' <span style="color:#6b7280">(' + esc(x.reason || '') + ')</span></li>';
      }).join('') + '</ul>';
  }

  var inj = p.injections || [];
  if (inj.length) {
    html += '<h3 style="font-size:13px;margin:6px 0">New ideas queued</h3>';
    html += '<ul style="margin:0 0 10px;padding-left:18px;font-size:13px">' +
      inj.map(function(x) { return '<li>' + esc(x.keyword) + ' <span style="color:#6b7280">(' + esc(x.why || '') + ')</span></li>'; }).join('') + '</ul>';
  }

  var top = p.top_backlog || [];
  if (top.length) {
    html += '<h3 style="font-size:13px;margin:6px 0">Top backlog</h3>';
    html += '<table style="width:100%;border-collapse:collapse;font-size:13px"><tbody>' +
      top.slice(0, 8).map(function(x) {
        return '<tr><td style="padding:3px 0">' + esc(x.keyword) + '</td>' +
          '<td style="text-align:right;font-weight:600">' + (x.priority_score || 0) + '</td>' +
          '<td style="color:#6b7280;font-size:12px;padding-left:8px">' + esc(x.why || '') + '</td></tr>';
      }).join('') + '</tbody></table>';
  }

  if ((p.suggestions || []).length) {
    html += '<h3 style="font-size:13px;margin:10px 0 6px">Suggested (confirm)</h3>';
    html += '<ul style="margin:0 0 10px;padding-left:18px;font-size:13px;color:#6b7280">' +
      p.suggestions.slice(0, 5).map(function(x) { return '<li>' + esc(x.key) + ' (' + esc(x.reason || '') + ')</li>'; }).join('') + '</ul>';
  }

  if ((p.alerts || []).length) {
    html += '<div style="margin-top:8px;color:#b91c1c;font-size:13px">' +
      p.alerts.map(function(a) { return '⚠️ ' + esc(a); }).join('<br>') + '</div>';
  }

  // tuner: last weight changes (if a tuner report exists)
  var tn = d && d.priorityTuner;
  if (tn && (tn.changes || []).length) {
    html += '<h3 style="font-size:13px;margin:12px 0 6px">Weight tuner — last changes</h3>';
    html += '<ul style="margin:0;padding-left:18px;font-size:12px;color:#6b7280">' +
      tn.changes.map(function(c) { return '<li>' + esc(c.param) + ': ' + c.from + ' → ' + c.to + ' (' + esc(c.reason || '') + ')</li>'; }).join('') + '</ul>';
  }

  document.getElementById('pipeline-priority-body').innerHTML = html || '<p style="color:#6b7280">No pending actions.</p>';
}
```

- [ ] **Step 3: Wire it into the render sequence.** Find the block that calls `renderSeoImpact(data);` (around line 4229) and add right after it:

```js
    renderPipelinePriority(data);
```

- [ ] **Step 4: Verify with Puppeteer or a JS syntax check.** At minimum confirm the JS parses:

Run: `node --check agents/dashboard/public/js/dashboard.js`
Expected: no output (valid syntax).

(Optional fuller check: start the dashboard locally and load it, or render with Puppeteer from the repo dir, to confirm the card appears when `pipeline-prioritizer/latest.json` exists.)

- [ ] **Step 5: Commit**

```bash
git add agents/dashboard/public/index.html agents/dashboard/public/js/dashboard.js
git commit -m "feat(dashboard): Pipeline Priority card (backlog, promotions, tuner changes)"
```

---

## Final verification (before PR)

- [ ] **All Phase 2 tests pass**

Run: `node --test tests/lib/attribution-log.test.js tests/lib/priority-tuning.test.js tests/lib/pipeline-priority.test.js tests/agents/pipeline-prioritizer.test.js tests/agents/priority-tuner.test.js`
Expected: all green, output pristine.

- [ ] **Dashboard JS valid:** `node --check agents/dashboard/public/js/dashboard.js`

- [ ] **End-to-end dry-runs:**
  - `node agents/pipeline-prioritizer/index.js --dry-run` — clean, no ledger written.
  - `node agents/priority-tuner/index.js --dry-run` — clean no-op (0 ledger records today), config untouched.

- [ ] **Seed-and-check (optional, mutates calendar — only if you want to see a real ledger line):** run the prioritizer live once on a dev calendar that has a promotable item, confirm `attribution.jsonl` gains a line, then `git checkout` any calendar churn.

- [ ] **Open the PR**

```bash
git push -u origin feature/priority-tuner
gh pr create --title "Pipeline prioritizer Phase 2: closed-loop weight tuner + provenance ledger + dashboard" --body "Implements docs/superpowers/specs/2026-06-14-pipeline-prioritizer-phase2-design.md. Adds an append-only signal→post attribution ledger, a monthly bounded weight tuner that learns which signals drive revenue, and a Pipeline Priority dashboard card. Tuner self-guards (no-ops) until ~6-8 weeks of attribution data accrue."
```

- [ ] **Deploy after merge:** `ssh root@137.184.119.230 'cd ~/seo-claude && git pull && ./scripts/setup-cron.sh && pm2 restart seo-dashboard'`; confirm the monthly priority-tuner cron line and `pm2 status` online.

---

## Spec coverage notes

- **Ledger** → Tasks 1 (structured contributing), 2 (lib), 3 (prioritizer writes it).
- **Tuner** → Tasks 4 (config), 5-7 (pure lib), 8 (agent), 9 (cron).
- **Dashboard** → Tasks 10 (data-loader), 11 (card).
- **Auto-apply bounded + history** → Task 8 (writes config + tuning-history.jsonl, digest notify).
- **Self-guards until data accrues** → Task 6 (`totalFloor` / `minSamplesPerSignal` / <2-qualifying no-op) + Task 8 (no-op report path).
- **Out of scope** (cap/strongThreshold/intent tuning, changing seo-impact, auto-revert) — not implemented, per spec.
