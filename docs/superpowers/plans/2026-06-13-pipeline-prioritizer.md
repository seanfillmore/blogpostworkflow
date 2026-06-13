# Pipeline Prioritizer Implementation Plan (Phase 1 — Core Engine)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the content pipeline signal-aware — rank a backlog of *ideas* by a signal-driven `priority_score`, write just-in-time with a small buffer, auto-apply strong signals (logged to the daily digest) and surface weak ones, all behind SEO best-practice guardrails.

**Architecture:** A pure, unit-tested brain (`lib/pipeline-priority.js`) computes a reprioritization plan from normalized signals + the current backlog. A thin agent (`agents/pipeline-prioritizer/index.js`) reads the on-disk signal reports, adapts them to the normalized shape, calls the brain, and applies the plan to `calendar.json`. Two small edits to existing code: a write-lead-window guard in `calendar-runner`, and a machine-readable `latest.json` from `rank-alerter`. The monthly closed-loop weight tuner and the dashboard panel are **Phase 2** (separate plan).

**Tech Stack:** Node.js ESM, `node --test`, existing libs (`lib/calendar-store.js`, `lib/snapshot-health.js`, `lib/notify.js`, `lib/posts.js`).

**Spec:** `docs/superpowers/specs/2026-06-13-pipeline-prioritizer-design.md`

---

## Scope note

Phase 1 (this plan) ships the complete working engine: scoring, hysteresis, injection, JIT buffer/promotion, guardrails, digest integration, cron wiring. It is independently useful and testable.

**Phase 2 (separate plan, not detailed here):**
- Closed-loop weight tuner — monthly job reading `seo-impact` `action_wins` to nudge `config/pipeline-priority.json` weights toward signal types that drive revenue.
- Dashboard "Pipeline Priority" panel.

**Phase 1 simplification (documented intentionally):** once a backlog idea is *promoted* (assigned a publish slot) it holds that slot. A stronger later signal does not preempt an already-assigned slot — it instead takes the *next* open slot ahead of lower-priority un-promoted ideas. This keeps the buffer frozen and bounds churn (combined with one promotion/run). Re-evaluation happens daily against fresh data.

---

## File structure

| File | Responsibility | New/Modify |
|---|---|---|
| `config/pipeline-priority.json` | All weights/thresholds (tuning without code) | Create |
| `lib/keyword-dedup.js` | Pure `isRejected` / `isCovered` for injection dedup | Create |
| `lib/publish-schedule.js` | `formatPublishAt` (moved) + `nextOpenSlot` | Create |
| `lib/product-scope.js` | `isInProductScope` (moved) + scope terms | Create |
| `agents/content-strategist/index.js` | Import `isInProductScope` from lib | Modify |
| `lib/pipeline-priority.js` | Pure brain: scoring, hysteresis, guardrails, `computePlan` | Create |
| `agents/pipeline-prioritizer/index.js` | I/O glue: read signals → normalize → computePlan → apply | Create |
| `agents/calendar-runner/index.js` | Import `formatPublishAt` from lib; add lead-window guard | Modify |
| `agents/rank-alerter/index.js` | Also write `data/reports/rank-alerter/latest.json` | Modify |
| `agents/daily-summary/index.js` | Render prioritizer section; add freshness entry | Modify |
| `agents/unmapped-query-promoter/index.js` | Deprecation header (subsumed by prioritizer) | Modify |
| `scripts/setup-cron.sh` | Add prioritizer cron; remove unmapped-promoter cron | Modify |
| `tests/lib/keyword-dedup.test.js` | Tests | Create |
| `tests/lib/publish-schedule.test.js` | Tests | Create |
| `tests/lib/pipeline-priority.test.js` | Tests | Create |
| `tests/agents/pipeline-prioritizer.test.js` | Dry-run integration test | Create |

### Shared data shapes (referenced by many tasks)

**Normalized signal** (what adapters produce, what the brain consumes):
```js
// type: 'unmapped' | 'rank_drop' | 'revenue_cluster' | 'competitor_gap' | 'ai_gap'
// taskType: 'new' | 'refresh'
{
  type: 'rank_drop',
  key: 'natural deodorant for men', // identity for hysteresis + matching
  taskType: 'refresh',
  cluster: 'deodorant',             // or null
  targetSlug: 'natural-deodorant-for-men', // for refresh; else null
  strength: 8,                      // raw magnitude (impressions / positions / $ delta)
  label: 'rank-drop 8 pos',         // human text for provenance
  raw: { from: 6, to: 14 }          // optional, for the report
}
```

**Backlog idea** (subset of a calendar item the brain needs; the agent passes these):
```js
{
  slug: 'fluoride-free-toothpaste',
  keyword: 'fluoride free toothpaste',
  cluster: 'toothpaste',         // from category/topical_hub, lowercased
  volume: 22000,
  kd: 0,
  search_intent: 'commercial',   // 'transactional'|'commercial'|'informational'
  task_type: 'new',
  source: 'gap_report',
  status_override: null,          // 'paused' | 'rush' | null
  added_at: '2026-04-08T...'
}
```

---

## Task 1: Config file

**Files:**
- Create: `config/pipeline-priority.json`

- [ ] **Step 1: Create the config**

```json
{
  "buffer": { "target": 2, "days": 7 },
  "maxPromotionsPerRun": 1,
  "clusterSpacingDays": 14,
  "clusterSpacingMax": 2,
  "refreshCooldownDays": 45,
  "hysteresisRuns": 2,
  "backlogLowWater": 5,
  "strongThreshold": 30,
  "base": {
    "intentMult": { "transactional": 1.4, "commercial": 1.2, "informational": 1.0 },
    "volumeDivisor": 100,
    "volumeCap": 50,
    "kdEasyThreshold": 5,
    "kdEasyBonus": 10
  },
  "signals": {
    "unmapped":        { "minImpressions": 500, "strongImpressions": 3000, "perImpression": 0.01, "cap": 40 },
    "rank_drop":       { "strongPositions": 5, "perPosition": 3, "cap": 40, "trafficStrongPct": 20 },
    "revenue_cluster": { "minDelta": 25, "strongDelta": 100, "perDollar": 0.2, "cap": 30 },
    "competitor_gap":  { "boost": 15, "cap": 30 },
    "ai_gap":          { "boost": 12, "cap": 24 }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add config/pipeline-priority.json
git commit -m "feat(pipeline-priority): config defaults for the prioritizer engine"
```

---

## Task 2: Keyword dedup lib

**Files:**
- Create: `lib/keyword-dedup.js`
- Test: `tests/lib/keyword-dedup.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isRejected, isCovered, slugify } from '../../lib/keyword-dedup.js';

test('slugify normalizes to kebab-case', () => {
  assert.equal(slugify('Fluoride Free Toothpaste!'), 'fluoride-free-toothpaste');
});

test('isRejected: exact matchType compares slugs', () => {
  const rej = [{ keyword: 'whitening toothpaste', matchType: 'exact' }];
  assert.equal(isRejected('Whitening Toothpaste', rej), true);
  assert.equal(isRejected('best whitening toothpaste', rej), false);
});

test('isRejected: default matchType is substring', () => {
  const rej = [{ keyword: 'crest' }];
  assert.equal(isRejected('best crest toothpaste', rej), true);
  assert.equal(isRejected('natural toothpaste', rej), false);
});

test('isCovered: exact keyword or slug already in index', () => {
  const index = new Set(['natural-deodorant', 'fluoride free toothpaste']);
  assert.equal(isCovered('Natural Deodorant', index), true);
  assert.equal(isCovered('fluoride free toothpaste', index), true);
});

test('isCovered: fuzzy slug containment (min length 6)', () => {
  const index = new Set(['fluoride-free-toothpaste-2026']);
  assert.equal(isCovered('fluoride free toothpaste', index), true); // substring of indexed slug
});

test('isCovered: short tokens do not fuzzy-match', () => {
  const index = new Set(['abc']);
  assert.equal(isCovered('abcdef', index), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib/keyword-dedup.test.js`
Expected: FAIL — `Cannot find module '../../lib/keyword-dedup.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// lib/keyword-dedup.js
// Pure dedup helpers shared by the pipeline-prioritizer (and available to any
// agent that injects calendar ideas). Extracted so injection dedup is unit-tested
// in one place rather than re-implemented per agent.

export function slugify(keyword) {
  return String(keyword).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * @param {string} keyword
 * @param {Array<{keyword:string, matchType?:string}>} rejections
 */
export function isRejected(keyword, rejections) {
  const kw = String(keyword).toLowerCase();
  return (rejections || []).some((r) => {
    const term = String(r.keyword).toLowerCase();
    if (r.matchType === 'exact') return slugify(keyword) === slugify(r.keyword);
    return kw.includes(term);
  });
}

/**
 * @param {string} keyword
 * @param {Set<string>} index  exact keywords AND slugs already covered (calendar/briefs/posts)
 */
export function isCovered(keyword, index) {
  if (!index || !index.size) return false;
  const kw = String(keyword).toLowerCase();
  if (index.has(kw)) return true;
  const slug = slugify(keyword);
  if (index.has(slug)) return true;
  if (slug.length < 6) return false;
  for (const entry of index) {
    const e = slugify(entry);
    if (e.length < 6) continue;
    if (e.includes(slug) || slug.includes(e)) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib/keyword-dedup.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/keyword-dedup.js tests/lib/keyword-dedup.test.js
git commit -m "feat(keyword-dedup): pure isRejected/isCovered helpers"
```

---

## Task 3: Publish-schedule lib (extract formatPublishAt + add nextOpenSlot)

**Files:**
- Create: `lib/publish-schedule.js`
- Test: `tests/lib/publish-schedule.test.js`
- Modify: `agents/calendar-runner/index.js` (import from lib instead of local def)

- [ ] **Step 1: Write the failing test**

```js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { formatPublishAt, nextOpenSlot } from '../../lib/publish-schedule.js';

const NOW = new Date('2026-06-15T12:00:00-07:00'); // a Monday

test('formatPublishAt snaps to a Mon/Wed/Fri slot at 08:00 PT', () => {
  const out = formatPublishAt(new Date('2026-06-16T00:00:00-07:00'), NOW); // Tue -> Wed
  assert.equal(out, '2026-06-17T08:00:00-07:00');
});

test('formatPublishAt advances past now', () => {
  const out = formatPublishAt(new Date('2026-06-01T00:00:00-07:00'), NOW); // past -> future
  assert.equal(new Date(out) > NOW, true);
});

test('nextOpenSlot skips dates already taken', () => {
  const taken = new Set(['2026-06-17']); // Wed taken
  const out = nextOpenSlot(taken, new Date('2026-06-16T00:00:00-07:00'), NOW); // Tue -> Wed taken -> Fri
  assert.equal(out, '2026-06-19T08:00:00-07:00');
});

test('nextOpenSlot returns first free slot when nothing taken', () => {
  const out = nextOpenSlot(new Set(), new Date('2026-06-16T00:00:00-07:00'), NOW);
  assert.equal(out, '2026-06-17T08:00:00-07:00');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib/publish-schedule.test.js`
Expected: FAIL — `Cannot find module '../../lib/publish-schedule.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// lib/publish-schedule.js
// Canonical publish-day scheduling. formatPublishAt was previously defined inside
// calendar-runner; it is the single authority for which days posts publish on, so
// the prioritizer reuses it to assign slots — runner and prioritizer can never
// disagree.

/**
 * Snap `date` forward to the next allowed publish day (Mon/Wed/Fri), 08:00 PT,
 * and ensure it is in the future relative to `now`.
 * @returns {string} ISO-like 'YYYY-MM-DDT08:00:00-07:00'
 */
export function formatPublishAt(date, now = new Date()) {
  const PUBLISH_DAYS = new Set([1, 3, 5]); // Mon, Wed, Fri
  const d = new Date(date);
  while (!PUBLISH_DAYS.has(d.getDay())) d.setDate(d.getDate() + 1);
  while (d < now) d.setDate(d.getDate() + 7);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${dy}T08:00:00-07:00`;
}

/**
 * Next publish slot whose date (YYYY-MM-DD) is not already in `takenDates`.
 * @param {Set<string>} takenDates  set of 'YYYY-MM-DD' already assigned
 */
export function nextOpenSlot(takenDates, fromDate, now = new Date()) {
  let slot = formatPublishAt(fromDate, now);
  const taken = takenDates || new Set();
  while (taken.has(slot.slice(0, 10))) {
    const d = new Date(slot);
    d.setDate(d.getDate() + 1);
    slot = formatPublishAt(d, now);
  }
  return slot;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib/publish-schedule.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Point calendar-runner at the lib (remove the duplicate def)**

In `agents/calendar-runner/index.js`, add to the imports block (near line 33):

```js
import { formatPublishAt } from '../../lib/publish-schedule.js';
```

Then delete the local `export function formatPublishAt(date, now = new Date()) { ... }` (lines ~451-466). Leave all call sites unchanged — they now resolve to the imported function.

- [ ] **Step 6: Verify calendar-runner still loads**

Run: `node agents/calendar-runner/index.js`
Expected: prints the calendar status table with no `formatPublishAt is not defined` error.

- [ ] **Step 7: Commit**

```bash
git add lib/publish-schedule.js tests/lib/publish-schedule.test.js agents/calendar-runner/index.js
git commit -m "refactor(publish-schedule): extract formatPublishAt to lib + add nextOpenSlot"
```

---

## Task 3B: Product-scope lib (extract isInProductScope)

**Files:**
- Create: `lib/product-scope.js`
- Test: `tests/lib/product-scope.test.js`
- Modify: `agents/content-strategist/index.js` (import from lib)

The prioritizer must not inject off-brand ideas (guardrail #8). `isInProductScope` already exists, but inside `agents/content-strategist/index.js`. Extract it to a lib so the prioritizer reuses it without importing an agent module.

- [ ] **Step 1: Write the failing test**

```js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isInProductScope, PRODUCT_SCOPE_TERMS } from '../../lib/product-scope.js';

test('isInProductScope: in-scope keyword (deodorant)', () => {
  assert.equal(isInProductScope('best natural deodorant'), true);
});

test('isInProductScope: off-scope keyword (shampoo)', () => {
  assert.equal(isInProductScope('best clarifying shampoo'), false);
});

test('isInProductScope: handles null/empty safely', () => {
  assert.equal(isInProductScope(''), false);
  assert.equal(isInProductScope(null), false);
});

test('PRODUCT_SCOPE_TERMS includes the core categories', () => {
  for (const t of ['deodorant', 'toothpaste', 'lotion', 'soap', 'lip balm', 'coconut oil']) {
    assert.ok(PRODUCT_SCOPE_TERMS.includes(t), `missing ${t}`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib/product-scope.test.js`
Expected: FAIL — `Cannot find module '../../lib/product-scope.js'`

- [ ] **Step 3: Create the lib (copy the exact list + function from content-strategist lines 283-295)**

```js
// lib/product-scope.js
// Single source of truth for "is this keyword on-brand for Real Skin Care?".
// Extracted from content-strategist so any agent (e.g. pipeline-prioritizer) can
// gate ideas against product scope without importing an agent module.

export const PRODUCT_SCOPE_TERMS = [
  'deodorant', 'antiperspirant',
  'toothpaste', 'tooth paste', 'oral',
  'lotion', 'moisturizer', 'moisturiser',
  'cream', 'body butter',
  'soap',
  'lip balm', 'lip',
  'coconut oil',
];

export function isInProductScope(keyword) {
  const kw = (keyword || '').toLowerCase();
  return PRODUCT_SCOPE_TERMS.some((t) => kw.includes(t));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib/product-scope.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Re-point content-strategist at the lib**

In `agents/content-strategist/index.js`: delete the local `const PRODUCT_SCOPE_TERMS = [...]` (lines ~283-291) and the local `export function isInProductScope(...)` (lines ~292-295), and add to the imports:

```js
import { isInProductScope, PRODUCT_SCOPE_TERMS } from '../../lib/product-scope.js';
```

(If `isInProductScope` was re-exported/used elsewhere, the import keeps the name identical, so call sites are unchanged.)

- [ ] **Step 6: Verify content-strategist still loads**

Run: `node -e "import('./agents/content-strategist/index.js').then(()=>console.log('ok'))"`
Expected: prints `ok` with no "isInProductScope is not defined" error.

- [ ] **Step 7: Commit**

```bash
git add lib/product-scope.js tests/lib/product-scope.test.js agents/content-strategist/index.js
git commit -m "refactor(product-scope): extract isInProductScope to a shared lib"
```

---

## Task 4: Brain — base scoring

**Files:**
- Create: `lib/pipeline-priority.js`
- Test: `tests/lib/pipeline-priority.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { scoreBase } from '../../lib/pipeline-priority.js';

const CFG = {
  base: { intentMult: { transactional: 1.4, commercial: 1.2, informational: 1.0 },
          volumeDivisor: 100, volumeCap: 50, kdEasyThreshold: 5, kdEasyBonus: 10 },
};

test('scoreBase: volume normalized, capped, times intent', () => {
  // volume 2000 -> 20; commercial 1.2 -> 24
  assert.equal(scoreBase({ volume: 2000, search_intent: 'commercial', kd: 40 }, CFG), 24);
});

test('scoreBase: volume cap applies', () => {
  // volume 999999 -> capped 50; informational 1.0 -> 50
  assert.equal(scoreBase({ volume: 999999, search_intent: 'informational', kd: 40 }, CFG), 50);
});

test('scoreBase: low-KD bonus added', () => {
  // volume 1000 -> 10; transactional 1.4 -> 14; +10 kd bonus = 24
  assert.equal(scoreBase({ volume: 1000, search_intent: 'transactional', kd: 2 }, CFG), 24);
});

test('scoreBase: missing fields default safely', () => {
  assert.equal(scoreBase({}, CFG), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib/pipeline-priority.test.js`
Expected: FAIL — `Cannot find module '../../lib/pipeline-priority.js'`

- [ ] **Step 3: Write minimal implementation**

```js
// lib/pipeline-priority.js
// Pure reprioritization brain. No I/O: every function takes plain data + config
// and returns plain data. The agent (agents/pipeline-prioritizer) supplies the
// normalized signals and backlog and applies the returned plan.

/** Intrinsic value of a backlog idea, revenue-first (intent-weighted). */
export function scoreBase(idea, cfg) {
  const b = cfg.base;
  const vol = Math.min(b.volumeCap, (idea.volume || 0) / b.volumeDivisor);
  const intent = b.intentMult[idea.search_intent] ?? b.intentMult.informational ?? 1.0;
  const kdBonus = (idea.kd != null && idea.kd <= b.kdEasyThreshold) ? b.kdEasyBonus : 0;
  return Math.round(vol * intent + kdBonus);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib/pipeline-priority.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline-priority.js tests/lib/pipeline-priority.test.js
git commit -m "feat(pipeline-priority): base scoring"
```

---

## Task 5: Brain — signal classification (score + strong + provenance)

**Files:**
- Modify: `lib/pipeline-priority.js`
- Modify: `tests/lib/pipeline-priority.test.js`

- [ ] **Step 1: Add the failing test**

Append to `tests/lib/pipeline-priority.test.js`:

```js
import { classify } from '../../lib/pipeline-priority.js';

const SCFG = {
  strongThreshold: 30,
  signals: {
    unmapped:        { minImpressions: 500, strongImpressions: 3000, perImpression: 0.01, cap: 40 },
    rank_drop:       { strongPositions: 5, perPosition: 3, cap: 40, trafficStrongPct: 20 },
    revenue_cluster: { minDelta: 25, strongDelta: 100, perDollar: 0.2, cap: 30 },
    competitor_gap:  { boost: 15, cap: 30 },
    ai_gap:          { boost: 12, cap: 24 },
  },
};

test('classify unmapped: score from impressions, strong over cap', () => {
  const r = classify({ type: 'unmapped', strength: 2000, label: 'unmapped 2000 impr' }, SCFG);
  assert.equal(r.score, 20);          // 2000 * 0.01
  assert.equal(r.strong, false);      // < 3000 and < strongThreshold
  assert.match(r.provenance, /\+20/);
});

test('classify unmapped: strong when impressions exceed strongImpressions', () => {
  const r = classify({ type: 'unmapped', strength: 5000 }, SCFG);
  assert.equal(r.score, 40);          // capped
  assert.equal(r.strong, true);
});

test('classify rank_drop: strong at >=5 positions', () => {
  const r = classify({ type: 'rank_drop', strength: 8 }, SCFG);
  assert.equal(r.score, 24);          // 8 * 3
  assert.equal(r.strong, true);       // >= strongPositions
});

test('classify revenue_cluster: scaled by dollars, strong over strongDelta', () => {
  const r = classify({ type: 'revenue_cluster', strength: 111.8 }, SCFG);
  assert.equal(r.score, 22);          // round(111.8 * 0.2)
  assert.equal(r.strong, true);       // >= 100
});

test('classify competitor_gap: fixed boost, never strong on its own', () => {
  const r = classify({ type: 'competitor_gap', strength: 1 }, SCFG);
  assert.equal(r.score, 15);
  assert.equal(r.strong, false);
});

test('classify: score crossing strongThreshold forces strong', () => {
  const r = classify({ type: 'rank_drop', strength: 11 }, SCFG); // 33 >= 30
  assert.equal(r.strong, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib/pipeline-priority.test.js`
Expected: FAIL — `classify` is not exported.

- [ ] **Step 3: Implement**

Append to `lib/pipeline-priority.js`:

```js
/** Score + strong flag + provenance text for one normalized signal. */
export function classify(signal, cfg) {
  const s = cfg.signals[signal.type] || {};
  let score = 0;
  let strong = false;
  switch (signal.type) {
    case 'unmapped':
      score = Math.min(s.cap, Math.round(signal.strength * s.perImpression));
      strong = signal.strength >= s.strongImpressions;
      break;
    case 'rank_drop':
      score = Math.min(s.cap, Math.round(signal.strength * s.perPosition));
      strong = signal.strength >= s.strongPositions;
      break;
    case 'revenue_cluster':
      score = Math.min(s.cap, Math.round(signal.strength * s.perDollar));
      strong = signal.strength >= s.strongDelta;
      break;
    case 'competitor_gap':
    case 'ai_gap':
      score = Math.min(s.cap, s.boost);
      strong = false;
      break;
    default:
      score = 0;
  }
  if (score >= cfg.strongThreshold) strong = true;
  const label = signal.label || signal.type;
  return { score, strong, provenance: `+${score} ${label}` };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib/pipeline-priority.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline-priority.js tests/lib/pipeline-priority.test.js
git commit -m "feat(pipeline-priority): signal classification with provenance"
```

---

## Task 6: Brain — hysteresis

**Files:**
- Modify: `lib/pipeline-priority.js`
- Modify: `tests/lib/pipeline-priority.test.js`

- [ ] **Step 1: Add the failing test**

Append:

```js
import { applyHysteresis } from '../../lib/pipeline-priority.js';

const HCFG = { ...SCFG, hysteresisRuns: 2 };

test('hysteresis: weak signal first seen today is held back', () => {
  const sig = { type: 'unmapped', key: 'x', strength: 1000 }; // weak (score 10)
  const { active, state } = applyHysteresis([sig], {}, '2026-06-15', HCFG);
  assert.equal(active.length, 0);                 // needs 2 runs
  assert.equal(state['unmapped:x'].runs, 1);
});

test('hysteresis: weak signal persisting a 2nd run becomes active', () => {
  const sig = { type: 'unmapped', key: 'x', strength: 1000 };
  const prior = { 'unmapped:x': { firstSeen: '2026-06-14', lastSeen: '2026-06-14', runs: 1 } };
  const { active } = applyHysteresis([sig], prior, '2026-06-15', HCFG);
  assert.equal(active.length, 1);
});

test('hysteresis: strong signal is active immediately', () => {
  const sig = { type: 'rank_drop', key: 'y', strength: 8 }; // strong
  const { active } = applyHysteresis([sig], {}, '2026-06-15', HCFG);
  assert.equal(active.length, 1);
});

test('hysteresis: a signal absent this run resets (not carried forward)', () => {
  const prior = { 'unmapped:x': { firstSeen: '2026-06-13', lastSeen: '2026-06-14', runs: 5 } };
  const { state } = applyHysteresis([], prior, '2026-06-15', HCFG);
  assert.equal(state['unmapped:x'], undefined); // dropped — must re-accumulate
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib/pipeline-priority.test.js`
Expected: FAIL — `applyHysteresis` not exported.

- [ ] **Step 3: Implement**

Append to `lib/pipeline-priority.js`:

```js
/**
 * Gate signals on strength-or-persistence. A signal counts as active if it is
 * strong (classify().strong) OR has now been seen for >= cfg.hysteresisRuns
 * consecutive runs. Returns the surviving signals and the rebuilt state (state
 * is rebuilt from THIS run's signals only, so a one-day gap resets the counter).
 */
export function applyHysteresis(signals, prevState, today, cfg) {
  const state = {};
  const active = [];
  for (const sig of signals || []) {
    const id = `${sig.type}:${sig.key}`;
    const prev = prevState ? prevState[id] : undefined;
    const runs = (prev?.runs || 0) + 1;
    state[id] = { firstSeen: prev?.firstSeen || today, lastSeen: today, runs };
    const { strong } = classify(sig, cfg);
    if (strong || runs >= cfg.hysteresisRuns) active.push(sig);
  }
  return { active, state };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib/pipeline-priority.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline-priority.js tests/lib/pipeline-priority.test.js
git commit -m "feat(pipeline-priority): hysteresis gate (strength-or-persistence)"
```

---

## Task 7: Brain — guardrail helpers

**Files:**
- Modify: `lib/pipeline-priority.js`
- Modify: `tests/lib/pipeline-priority.test.js`

- [ ] **Step 1: Add the failing test**

Append:

```js
import { clusterSpacingOk, refreshCooldownOk } from '../../lib/pipeline-priority.js';

const GCFG = { ...HCFG, clusterSpacingDays: 14, clusterSpacingMax: 2, refreshCooldownDays: 45 };

test('clusterSpacingOk: under the cap within the window → ok', () => {
  const recent = { toothpaste: ['2026-06-10', '2026-06-02'] }; // 2 in last 14d? 06-02 is 13 days before 06-15
  // window from 2026-06-15 back 14 days = >= 2026-06-01; both count = 2 >= max → NOT ok
  assert.equal(clusterSpacingOk('toothpaste', recent, '2026-06-15', GCFG), false);
});

test('clusterSpacingOk: old posts outside window do not count', () => {
  const recent = { toothpaste: ['2026-05-01', '2026-05-10'] }; // both > 14 days ago
  assert.equal(clusterSpacingOk('toothpaste', recent, '2026-06-15', GCFG), true);
});

test('clusterSpacingOk: unknown cluster is always ok', () => {
  assert.equal(clusterSpacingOk('newcluster', {}, '2026-06-15', GCFG), true);
});

test('refreshCooldownOk: refreshed within cooldown → not ok', () => {
  const last = { 'natural-deodorant-for-men': '2026-06-01' }; // 14 days ago < 45
  assert.equal(refreshCooldownOk('natural-deodorant-for-men', last, '2026-06-15', GCFG), false);
});

test('refreshCooldownOk: never refreshed → ok', () => {
  assert.equal(refreshCooldownOk('brand-new-post', {}, '2026-06-15', GCFG), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib/pipeline-priority.test.js`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Implement**

Append to `lib/pipeline-priority.js`:

```js
const DAY_MS = 86400000;
function daysBetween(aYmd, bYmd) {
  return Math.floor((Date.parse(aYmd + 'T00:00:00Z') - Date.parse(bYmd + 'T00:00:00Z')) / DAY_MS);
}

/** True if fewer than clusterSpacingMax new posts landed in this cluster within the window. */
export function clusterSpacingOk(cluster, recentByCluster, today, cfg) {
  const dates = (recentByCluster && recentByCluster[cluster]) || [];
  const within = dates.filter((d) => daysBetween(today, d) <= cfg.clusterSpacingDays && daysBetween(today, d) >= 0);
  return within.length < cfg.clusterSpacingMax;
}

/** True if this post has not been refreshed within the cooldown window. */
export function refreshCooldownOk(slug, lastRefreshBySlug, today, cfg) {
  const last = lastRefreshBySlug && lastRefreshBySlug[slug];
  if (!last) return true;
  return daysBetween(today, last) >= cfg.refreshCooldownDays;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib/pipeline-priority.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline-priority.js tests/lib/pipeline-priority.test.js
git commit -m "feat(pipeline-priority): cluster-spacing + refresh-cooldown guardrails"
```

---

## Task 8: Brain — computePlan (scoring + injection + promotion + split)

**Files:**
- Modify: `lib/pipeline-priority.js`
- Modify: `tests/lib/pipeline-priority.test.js`

This is the orchestrator. It takes already-partitioned inputs from the agent (the agent does disk I/O and status determination) and returns the plan to apply.

- [ ] **Step 1: Add the failing test**

Append:

```js
import { computePlan } from '../../lib/pipeline-priority.js';

const FULL = {
  ...GCFG,
  base: CFG.base,
  buffer: { target: 2, days: 7 },
  maxPromotionsPerRun: 1,
  backlogLowWater: 5,
};
const NOW2 = new Date('2026-06-15T12:00:00-07:00'); // Monday
const TODAY2 = '2026-06-15';

function baseInputs(over = {}) {
  return {
    backlog: [
      { slug: 'a-post', keyword: 'a post', cluster: 'toothpaste', volume: 1000, kd: 2, search_intent: 'commercial', task_type: 'new', source: 'gap_report', status_override: null },
      { slug: 'b-post', keyword: 'b post', cluster: 'deodorant', volume: 500, kd: 10, search_intent: 'informational', task_type: 'new', source: 'gap_report', status_override: null },
    ],
    signals: [],
    bufferReady: 0,
    takenSlots: new Set(),
    clusterRecent: {},
    refreshRecent: {},
    coveredIndex: new Set(['a-post', 'b-post']),
    rejections: [],
    today: TODAY2,
    now: NOW2,
    cfg: FULL,
    ...over,
  };
}

test('computePlan: scores backlog with base + matching signal, provenance attached', () => {
  const plan = computePlan(baseInputs({
    signals: [{ type: 'revenue_cluster', key: 'toothpaste', cluster: 'toothpaste', taskType: 'new', strength: 111.8, label: 'revenue +$112' }],
  }));
  const a = plan.scored.find((i) => i.slug === 'a-post');
  // base: 1000/100=10 *1.2 +10 kd =22 ; +revenue 22 => 44
  assert.equal(a.priority_score, 44);
  assert.match(a.priority_provenance, /revenue/);
});

test('computePlan: fills buffer up to target but capped by maxPromotionsPerRun', () => {
  const plan = computePlan(baseInputs({ bufferReady: 0 })); // target 2, cap 1
  assert.equal(plan.promotions.length, 1);                  // only 1 this run
  assert.ok(plan.promotions[0].publish_date);
});

test('computePlan: no promotion when buffer already full', () => {
  const plan = computePlan(baseInputs({ bufferReady: 2 }));
  assert.equal(plan.promotions.length, 0);
});

test('computePlan: highest score promoted first', () => {
  const plan = computePlan(baseInputs({
    signals: [{ type: 'rank_drop', key: 'b post', cluster: 'deodorant', taskType: 'new', strength: 10, label: 'drop' }],
  }));
  assert.equal(plan.promotions[0].slug, 'b-post'); // boosted above a-post
});

test('computePlan: paused item is never promoted', () => {
  const inputs = baseInputs();
  inputs.backlog[0].status_override = 'paused';
  inputs.backlog[1].status_override = 'paused';
  const plan = computePlan(inputs);
  assert.equal(plan.promotions.length, 0);
});

test('computePlan: rush item is promoted ahead of higher-scored ones', () => {
  const inputs = baseInputs();
  inputs.backlog[1].status_override = 'rush'; // b-post (lower base) pinned
  const plan = computePlan(inputs);
  assert.equal(plan.promotions[0].slug, 'b-post');
});

test('computePlan: injects a new idea from an unmapped signal not yet covered', () => {
  const plan = computePlan(baseInputs({
    signals: [{ type: 'unmapped', key: 'coconut oil for stretch marks', taskType: 'new', cluster: null, strength: 5000, label: 'unmapped 5000' }],
    coveredIndex: new Set(['a-post', 'b-post']),
  }));
  const inj = plan.injections.find((i) => i.keyword === 'coconut oil for stretch marks');
  assert.ok(inj);
  assert.equal(inj.publish_date, null);          // backlog: no date until promoted
  assert.equal(inj.source, 'gsc_unmapped');
});

test('computePlan: does NOT inject an unmapped idea already covered', () => {
  const plan = computePlan(baseInputs({
    signals: [{ type: 'unmapped', key: 'a post', taskType: 'new', cluster: null, strength: 5000, label: 'u' }],
  }));
  assert.equal(plan.injections.length, 0);
});

test('computePlan: cluster spacing blocks promotion (defers, not drops)', () => {
  const plan = computePlan(baseInputs({
    bufferReady: 0,
    clusterRecent: { toothpaste: ['2026-06-12', '2026-06-05'] }, // 2 in window → a-post blocked
  }));
  // a-post (toothpaste) blocked → b-post promoted instead
  assert.equal(plan.promotions[0].slug, 'b-post');
});

test('computePlan: refresh cooldown blocks a refresh-type promotion', () => {
  const inputs = baseInputs({
    backlog: [{ slug: 'old-post', keyword: 'old post', cluster: 'soap', volume: 3000, kd: 1, search_intent: 'commercial', task_type: 'refresh', source: 'refresh', status_override: null }],
    refreshRecent: { 'old-post': '2026-06-01' }, // 14d ago < 45
    coveredIndex: new Set(['old-post']),
  });
  const plan = computePlan(inputs);
  assert.equal(plan.promotions.length, 0);
});

test('computePlan: backlog below low-water emits an alert', () => {
  const plan = computePlan(baseInputs()); // 2 ideas < lowWater 5
  assert.ok(plan.alerts.some((a) => /backlog/i.test(a)));
});

test('computePlan: never assigns two promotions to the same slot', () => {
  // force 2 promotions by raising the per-run cap
  const cfg = { ...FULL, maxPromotionsPerRun: 2 };
  const plan = computePlan(baseInputs({ cfg, bufferReady: 0 }));
  const dates = plan.promotions.map((p) => p.publish_date.slice(0, 10));
  assert.equal(new Set(dates).size, dates.length);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib/pipeline-priority.test.js`
Expected: FAIL — `computePlan` not exported.

- [ ] **Step 3: Implement**

Append to `lib/pipeline-priority.js`:

```js
import { isCovered, isRejected, slugify } from './keyword-dedup.js';
import { nextOpenSlot } from './publish-schedule.js';

/**
 * Compute the reprioritization plan. Pure: the agent does all disk I/O and passes
 * partitioned inputs.
 *
 * inputs = {
 *   backlog,        // idea items (pending, no publish_date) — see "Backlog idea" shape
 *   signals,        // active normalized signals (post-hysteresis)
 *   bufferReady,    // count of written/scheduled-not-published posts
 *   takenSlots,     // Set<'YYYY-MM-DD'> already assigned to dated items
 *   clusterRecent,  // { cluster: ['YYYY-MM-DD', ...] } recent new posts
 *   refreshRecent,  // { slug: 'YYYY-MM-DD' } last refresh per post
 *   coveredIndex,   // Set of keywords+slugs already covered (calendar/briefs/posts)
 *   rejections,     // rejected-keywords.json contents
 *   today,          // 'YYYY-MM-DD'
 *   now,            // Date
 *   cfg,
 * }
 *
 * returns {
 *   scored,       // backlog items + { priority_score, priority_provenance }
 *   injections,   // new backlog items to upsert (publish_date: null)
 *   promotions,   // [{ slug, publish_date, reason }]
 *   suggestions,  // [{ key, type, score, reason }] weak signals not applied
 *   alerts,       // string[]
 * }
 */
export function computePlan(inputs) {
  const {
    backlog, signals, bufferReady, takenSlots, clusterRecent, refreshRecent,
    coveredIndex, rejections, today, now, cfg,
  } = inputs;

  // index active signals by their matching key (keyword/slug) and by cluster
  const byKey = new Map();
  const byCluster = new Map();
  const suggestions = [];
  for (const sig of signals || []) {
    const c = classify(sig, cfg);
    if (sig.cluster) {
      byCluster.set(sig.cluster, [...(byCluster.get(sig.cluster) || []), { sig, c }]);
    }
    byKey.set(slugify(sig.key), [...(byKey.get(slugify(sig.key)) || []), { sig, c }]);
    if (!c.strong) suggestions.push({ key: sig.key, type: sig.type, score: c.score, reason: c.provenance });
  }

  const contributionsFor = (idea) => {
    const hits = [
      ...(byKey.get(slugify(idea.keyword)) || []),
      ...(byKey.get(idea.slug) || []),
      ...(idea.cluster ? (byCluster.get(idea.cluster) || []) : []),
    ];
    // de-dup identical (sig,c) refs
    const seen = new Set();
    let add = 0; const prov = [];
    for (const { sig, c } of hits) {
      const id = `${sig.type}:${sig.key}`;
      if (seen.has(id)) continue; seen.add(id);
      add += c.score; prov.push(c.provenance);
    }
    return { add, prov };
  };

  // 1) score existing backlog
  const scored = backlog.map((idea) => {
    const base = scoreBase(idea, cfg);
    const { add, prov } = contributionsFor(idea);
    const provenance = [`base ${base}`, ...prov].join(', ');
    return { ...idea, priority_score: base + add, priority_provenance: provenance };
  });

  // 2) injections from signals introducing a NOT-yet-covered keyword
  const injections = [];
  const covered = new Set(coveredIndex);
  for (const sig of signals || []) {
    if (sig.type === 'revenue_cluster') continue; // boosts existing, never injects
    const kw = sig.key;
    if (isRejected(kw, rejections)) continue;
    if (isCovered(kw, covered)) continue;
    const c = classify(sig, cfg);
    const idea = {
      slug: slugify(kw), keyword: kw, cluster: sig.cluster || null,
      volume: null, kd: null, search_intent: 'commercial',
      task_type: sig.taskType || 'new',
      source: sig.type === 'unmapped' ? 'gsc_unmapped' : sig.type,
      status_override: null, publish_date: null,
      priority_score: c.score, priority_provenance: `injected, ${c.provenance}`,
    };
    injections.push(idea);
    covered.add(slugify(kw)); covered.add(kw.toLowerCase());
    scored.push(idea); // injected ideas are promotable this run
  }

  // 3) promotion (JIT buffer fill), respecting guardrails + pins + caps
  const need = Math.max(0, cfg.buffer.target - (bufferReady || 0));
  const limit = Math.min(need, cfg.maxPromotionsPerRun);
  const taken = new Set(takenSlots);
  const promotions = [];

  const rank = (a, b) => {
    const ar = a.status_override === 'rush' ? 1 : 0;
    const br = b.status_override === 'rush' ? 1 : 0;
    if (ar !== br) return br - ar;            // rush first
    return b.priority_score - a.priority_score; // then score
  };
  const candidates = scored
    .filter((i) => i.status_override !== 'paused')
    .sort(rank);

  for (const idea of candidates) {
    if (promotions.length >= limit) break;
    if (idea.cluster && !clusterSpacingOk(idea.cluster, clusterRecent, today, cfg)) continue;
    if (idea.task_type === 'refresh' && !refreshCooldownOk(idea.slug, refreshRecent, today, cfg)) continue;
    const publish_date = nextOpenSlot(taken, now, now);
    taken.add(publish_date.slice(0, 10));
    promotions.push({ slug: idea.slug, publish_date, reason: idea.priority_provenance });
  }

  // 4) backlog low-water alert
  const alerts = [];
  const depth = backlog.length + injections.length;
  if (depth < cfg.backlogLowWater) {
    alerts.push(`Backlog low: ${depth} idea(s) < ${cfg.backlogLowWater}. Run content-strategist to replenish.`);
  }

  return { scored, injections, promotions, suggestions, alerts };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/lib/pipeline-priority.test.js`
Expected: PASS (all computePlan cases)

- [ ] **Step 5: Commit**

```bash
git add lib/pipeline-priority.js tests/lib/pipeline-priority.test.js
git commit -m "feat(pipeline-priority): computePlan orchestrator (score/inject/promote/split)"
```

---

## Task 9: rank-alerter — emit machine-readable latest.json

**Files:**
- Modify: `agents/rank-alerter/index.js`

The prioritizer's rank-drop signal needs structured data. rank-alerter currently writes only markdown. Add a `latest.json` alongside it, serializing the `drops`, `gains`, `trafficDrops` arrays it already computes.

- [ ] **Step 1: Locate the write site**

Open `agents/rank-alerter/index.js`. Find where it writes the markdown report (around line 117, the `data/reports/rank-alerts/YYYY-MM-DD.md` write) and where `drops`, `gains`, `trafficDrops` are in scope.

- [ ] **Step 2: Add the JSON write**

Immediately after the markdown `writeFileSync(...)`, add (adjust variable names to match the file — the arrays are `drops`, `gains`, `trafficDrops`):

```js
// Machine-readable mirror for downstream consumers (pipeline-prioritizer) and
// snapshot-health freshness monitoring.
import { join } from 'path'; // (use existing path import if already present)
const latestPath = join(ROOT, 'data', 'reports', 'rank-alerter', 'latest.json');
mkdirSync(dirname(latestPath), { recursive: true });
writeFileSync(latestPath, JSON.stringify({
  generated_at: new Date().toISOString(),
  drops,            // [{ query, from, to, delta }]
  gains,            // [{ query, from, to, delta }]
  traffic_drops: trafficDrops, // [{ page, from, to, pctDrop }]
}, null, 2));
```

If `ROOT`, `mkdirSync`, or `dirname` are not already imported/defined in the file, add them to the existing imports (`import { mkdirSync, writeFileSync } from 'fs'`, `import { join, dirname } from 'path'`) and define `ROOT` the same way other agents do (`const ROOT = join(__dirname, '..', '..')`).

- [ ] **Step 3: Verify it writes**

Run: `node agents/rank-alerter/index.js`
Expected: completes; `data/reports/rank-alerter/latest.json` now exists with `generated_at`, `drops`, `gains`, `traffic_drops`.

Run: `cat data/reports/rank-alerter/latest.json | head -20` to eyeball shape.

- [ ] **Step 4: Commit**

```bash
git add agents/rank-alerter/index.js
git commit -m "feat(rank-alerter): emit latest.json for machine consumers"
```

---

## Task 10: The agent — adapters + apply + dry-run

**Files:**
- Create: `agents/pipeline-prioritizer/index.js`
- Test: `tests/agents/pipeline-prioritizer.test.js`

This is I/O glue (integration-verified). It reads the signal reports, normalizes them, determines backlog/buffer via post status, calls `computePlan`, and applies the result.

- [ ] **Step 1: Write the agent**

```js
#!/usr/bin/env node
/**
 * Pipeline Prioritizer
 *
 * Makes the content queue signal-aware. Reads the signal latest.json reports,
 * normalizes them, scores the idea backlog, injects new ideas, and promotes the
 * top ideas just-in-time to keep a small write buffer full — all behind SEO
 * best-practice guardrails. Auto-applies strong signals; surfaces weak ones in
 * the daily digest.
 *
 * The decision logic lives in lib/pipeline-priority.js (pure, unit-tested). This
 * file is the I/O glue: read reports → normalize → computePlan → apply to
 * calendar.json → write report + digest.
 *
 * Usage:
 *   node agents/pipeline-prioritizer/index.js            # apply
 *   node agents/pipeline-prioritizer/index.js --dry-run  # print plan, write nothing
 *
 * See docs/superpowers/specs/2026-06-13-pipeline-prioritizer-design.md
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCalendar, upsertItem, writeCalendar } from '../../lib/calendar-store.js';
import { listAllSlugs, getPostMeta } from '../../lib/posts.js';
import { newestReportDate } from '../../lib/snapshot-health.js';
import { computePlan, applyHysteresis } from '../../lib/pipeline-priority.js';
import { slugify } from '../../lib/keyword-dedup.js';
import { isInProductScope } from '../../lib/product-scope.js';
import { getSearchVolume } from '../../lib/dataforseo.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'pipeline-prioritizer');
const SIGNAL_STATE_PATH = join(REPORTS_DIR, 'signal-state.json');
const DRY_RUN = process.argv.includes('--dry-run');

const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'pipeline-priority.json'), 'utf8'));
const ymd = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
function reportPath(name) { return join(ROOT, 'data', 'reports', name, 'latest.json'); }
function rejections() { return readJson(join(ROOT, 'data', 'rejected-keywords.json')) || []; }

// ── signal freshness guard ──────────────────────────────────────────────────
// Skip a signal source whose latest.json is stale (per snapshot-health), so we
// never act on data a dead collector left behind.
function fresh(name, maxAgeDays, today) {
  const d = newestReportDate(reportPath(name));
  if (!d) return false;
  const age = Math.floor((Date.parse(today) - Date.parse(d)) / 86400000);
  return age <= maxAgeDays;
}

// ── map a keyword to an existing post slug (for refresh signals) ─────────────
function slugForKeyword(keyword) {
  const target = keyword.toLowerCase();
  for (const slug of listAllSlugs()) {
    const meta = getPostMeta(slug);
    if (meta?.target_keyword?.toLowerCase() === target) return slug;
  }
  return null;
}

// ── adapters: on-disk report → normalized signals ───────────────────────────
function collectSignals(today) {
  const out = [];

  // 1) surging unmapped queries → inject NEW
  if (fresh('gsc-opportunity', 5, today)) {
    const g = readJson(reportPath('gsc-opportunity'));
    for (const u of (g?.unmapped || [])) {
      if ((u.impressions || 0) < cfg.signals.unmapped.minImpressions) continue;
      out.push({ type: 'unmapped', key: u.keyword, taskType: 'new', cluster: null,
        targetSlug: null, strength: u.impressions, label: `unmapped ${u.impressions} impr`,
        raw: { position: u.position } });
    }
  }

  // 2) revenue-growth clusters → boost NEW ideas in cluster
  if (fresh('seo-impact', 3, today)) {
    const s = readJson(reportPath('seo-impact'));
    for (const c of (s?.clusters || [])) {
      if ((c.revenueDelta || 0) < cfg.signals.revenue_cluster.minDelta) continue;
      out.push({ type: 'revenue_cluster', key: c.cluster, taskType: 'new',
        cluster: String(c.cluster).toLowerCase(), targetSlug: null,
        strength: c.revenueDelta, label: `revenue +$${Math.round(c.revenueDelta)}`,
        raw: { revenue: c.revenue } });
    }
  }

  // 3) rank/traffic drops → REFRESH that post
  if (fresh('rank-alerter', 3, today)) {
    const r = readJson(reportPath('rank-alerter'));
    for (const d of (r?.drops || [])) {
      const slug = slugForKeyword(d.query);
      if (!slug) continue; // can't refresh a post we don't have
      const meta = getPostMeta(slug);
      out.push({ type: 'rank_drop', key: d.query, taskType: 'refresh',
        cluster: (meta?.category || '').toLowerCase() || null, targetSlug: slug,
        strength: d.delta, label: `rank-drop ${d.delta} pos`, raw: { from: d.from, to: d.to } });
    }
  }

  // 4) competitor + AI-citation gaps
  if (fresh('competitor-watcher', 8, today)) {
    const cw = readJson(reportPath('competitor-watcher'));
    for (const p of (cw?.new_posts || [])) {
      const cluster = (p.clusters && p.clusters[0]) ? String(p.clusters[0]).toLowerCase() : null;
      out.push({ type: 'competitor_gap', key: p.title || p.url, taskType: 'new',
        cluster, targetSlug: null, strength: 1, label: `competitor: ${p.domain || 'rival'}` });
    }
  }
  if (fresh('ai-citations', 8, today)) {
    const ai = readJson(reportPath('ai-citations'));
    for (const res of (ai?.results || [])) {
      const gap = Object.values(res.responses || {}).some((r) => r.mentioned === true && r.cited === false);
      if (!gap) continue;
      const slug = slugForKeyword(res.prompt);
      out.push({ type: 'ai_gap', key: res.prompt, taskType: slug ? 'refresh' : 'new',
        cluster: null, targetSlug: slug, strength: 1, label: 'AI mentioned-not-cited' });
    }
  }

  // Guardrail #8: an inject-capable signal (would create a NEW post) must be in
  // product scope. Refresh signals target existing in-scope posts, so they pass.
  return out.filter((s) => {
    const wouldInject = (s.taskType === 'new') && !s.targetSlug && s.type !== 'revenue_cluster';
    return !wouldInject || isInProductScope(s.key);
  });
}

// ── build the covered index + recency maps from disk ────────────────────────
function buildContext(calendar, today) {
  const covered = new Set();
  const clusterRecent = {};
  const refreshRecent = {};

  for (const it of calendar.items) {
    covered.add((it.keyword || '').toLowerCase());
    covered.add(it.slug);
    if (it.publish_date && it.source !== 'refresh') {
      const cl = (it.category || it.topical_hub || '').toLowerCase();
      if (cl) (clusterRecent[cl] ||= []).push(ymd(it.publish_date));
    }
  }
  for (const slug of listAllSlugs()) {
    covered.add(slug);
    const meta = getPostMeta(slug);
    if (meta?.target_keyword) covered.add(meta.target_keyword.toLowerCase());
    if (meta?.last_refreshed_at) refreshRecent[slug] = ymd(meta.last_refreshed_at);
    const cl = (meta?.category || '').toLowerCase();
    if (cl && meta?.published_at) (clusterRecent[cl] ||= []).push(ymd(meta.published_at));
  }
  return { covered, clusterRecent, refreshRecent };
}

// item status (mirrors calendar-runner's getItemStatus, simplified for buffer count)
function statusOf(item) {
  const meta = getPostMeta(item.slug);
  if (meta?.shopify_status === 'published') return 'published';
  if (meta?.shopify_publish_at) return 'scheduled';
  if (meta?.shopify_article_id) return 'draft';
  const briefPath = join(ROOT, 'data', 'briefs', `${item.slug}.json`);
  if (existsSync(join(ROOT, 'data', 'posts', item.slug, 'content.html'))) return 'written';
  if (existsSync(briefPath)) return 'briefed';
  return 'pending';
}

async function main() {
  console.log('\nPipeline Prioritizer' + (DRY_RUN ? ' (dry-run)' : '') + '\n');
  const today = ymd(Date.now());
  const now = new Date();

  const calendar = loadCalendar();
  const { covered, clusterRecent, refreshRecent } = buildContext(calendar, today);

  // partition: backlog ideas = pending items with no publish_date
  const backlog = [];
  let bufferReady = 0;
  const takenSlots = new Set();
  for (const it of calendar.items) {
    const st = statusOf(it);
    if (['written', 'scheduled', 'draft', 'briefed'].includes(st)) bufferReady++;
    if (it.publish_date) takenSlots.add(ymd(it.publish_date));
    if (st === 'pending' && !it.publish_date) {
      backlog.push({
        slug: it.slug, keyword: it.keyword,
        cluster: (it.category || it.topical_hub || '').toLowerCase() || null,
        volume: it.volume, kd: it.kd, search_intent: it.search_intent || 'commercial',
        task_type: it.source === 'refresh' ? 'refresh' : 'new',
        source: it.source, status_override: it.status_override || null,
      });
    }
  }

  // hysteresis
  const rawSignals = collectSignals(today);
  const prevState = readJson(SIGNAL_STATE_PATH) || {};
  const { active, state } = applyHysteresis(rawSignals, prevState, today, cfg);
  console.log(`  Signals: ${rawSignals.length} raw → ${active.length} active (after hysteresis)`);
  console.log(`  Backlog ideas: ${backlog.length} | buffer ready: ${bufferReady}/${cfg.buffer.target}`);

  const plan = computePlan({
    backlog, signals: active, bufferReady, takenSlots, clusterRecent, refreshRecent,
    coveredIndex: covered, rejections: rejections(), today, now, cfg,
  });

  // ── report payload ──
  const generated_at = new Date().toISOString();
  const payload = {
    generated_at,
    backlog_depth: backlog.length + plan.injections.length,
    buffer_ready: bufferReady,
    buffer_target: cfg.buffer.target,
    injections: plan.injections.map((i) => ({ slug: i.slug, keyword: i.keyword, source: i.source, priority_score: i.priority_score, why: i.priority_provenance })),
    promotions: plan.promotions,
    top_backlog: [...plan.scored].sort((a, b) => b.priority_score - a.priority_score).slice(0, 15)
      .map((i) => ({ slug: i.slug, keyword: i.keyword, priority_score: i.priority_score, why: i.priority_provenance })),
    suggestions: plan.suggestions,
    alerts: plan.alerts,
  };

  if (DRY_RUN) {
    console.log(JSON.stringify(payload, null, 2));
    console.log('\nDry-run: no changes written.');
    return;
  }

  // ── apply ──
  // 1) write back priority_score + provenance for existing backlog items
  const scoredBySlug = new Map(plan.scored.map((i) => [i.slug, i]));
  const updatedItems = calendar.items.map((it) => {
    const s = scoredBySlug.get(it.slug);
    return s ? { ...it, priority_score: s.priority_score } : it;
  });
  writeCalendar({ items: updatedItems, preserve_metadata: true });

  // 2) inject new ideas (no publish_date → stays in backlog until promoted)
  for (const idea of plan.injections) {
    upsertItem({
      slug: idea.slug, keyword: idea.keyword, title: null,
      category: idea.cluster || 'GSC Demand', content_type: 'Blog Post',
      priority: 'High', week: null, publish_date: null,
      kd: null, volume: null, source: idea.source, topical_hub: idea.cluster || null,
      priority_score: idea.priority_score, status_override: null,
    });
  }

  // 3) promote: assign publish_date to the chosen ideas
  for (const p of plan.promotions) {
    upsertItem({ slug: p.slug, publish_date: p.publish_date, original_publish_date: p.publish_date });
  }

  // 4) persist signal state + report
  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(SIGNAL_STATE_PATH, JSON.stringify(state, null, 2));
  writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify(payload, null, 2));
  writeFileSync(join(REPORTS_DIR, `${today}.md`), buildReport(payload));
  console.log(`  Applied: ${plan.injections.length} injected, ${plan.promotions.length} promoted.`);

  // 5) alerts bypass digest deferral (errors email immediately)
  if (plan.alerts.length) {
    await notify({ subject: `⚠️ Pipeline prioritizer: ${plan.alerts.length} alert(s)`,
      body: plan.alerts.join('\n'), status: 'error', category: 'content' }).catch(() => {});
  }
  console.log('\nPrioritizer complete.');
}

function buildReport(p) {
  const L = ['# Pipeline Prioritizer Report', ''];
  L.push(`**Backlog depth:** ${p.backlog_depth} | **Buffer:** ${p.buffer_ready}/${p.buffer_target}`, '');
  if (p.promotions.length) { L.push('## Promoted (written next)'); for (const x of p.promotions) L.push(`- \`${x.slug}\` → ${x.publish_date.slice(0,10)} (${x.reason})`); L.push(''); }
  if (p.injections.length) { L.push('## Injected ideas'); for (const x of p.injections) L.push(`- \`${x.slug}\` — ${x.why}`); L.push(''); }
  if (p.suggestions.length) { L.push('## Suggested (weak signals — confirm)'); for (const x of p.suggestions) L.push(`- ${x.key} (${x.type}, ${x.reason})`); L.push(''); }
  if (p.alerts.length) { L.push('## Alerts'); for (const a of p.alerts) L.push(`- ${a}`); }
  return L.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error('Pipeline prioritizer failed:', err); process.exit(1); });
}

export { collectSignals, statusOf };
```

- [ ] **Step 2: Write the dry-run integration test**

```js
// tests/agents/pipeline-prioritizer.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');

test('pipeline-prioritizer --dry-run runs and writes nothing new', () => {
  const before = existsSync(join(ROOT, 'data', 'reports', 'pipeline-prioritizer', 'latest.json'))
    ? readFileSync(join(ROOT, 'data', 'reports', 'pipeline-prioritizer', 'latest.json'), 'utf8') : null;

  const out = execFileSync('node', ['agents/pipeline-prioritizer/index.js', '--dry-run'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /Pipeline Prioritizer \(dry-run\)/);
  assert.match(out, /no changes written/);

  const after = existsSync(join(ROOT, 'data', 'reports', 'pipeline-prioritizer', 'latest.json'))
    ? readFileSync(join(ROOT, 'data', 'reports', 'pipeline-prioritizer', 'latest.json'), 'utf8') : null;
  assert.equal(after, before); // dry-run must not change the report
});
```

- [ ] **Step 3: Run the test**

Run: `node --test tests/agents/pipeline-prioritizer.test.js`
Expected: PASS. (If `lib/posts.js` exports differ — e.g. `getPostMeta` name — fix the import to match the real export before re-running.)

- [ ] **Step 4: Manual dry-run against real data**

Run: `node agents/pipeline-prioritizer/index.js --dry-run`
Expected: prints signal counts, backlog/buffer, and a JSON plan. Eyeball that promotions land on Mon/Wed/Fri and injections have `publish_date` absent.

- [ ] **Step 5: Commit**

```bash
git add agents/pipeline-prioritizer/index.js tests/agents/pipeline-prioritizer.test.js
git commit -m "feat(pipeline-prioritizer): agent adapters, apply, and dry-run"
```

---

## Task 10B: Re-validate at promotion

**Files:**
- Modify: `agents/pipeline-prioritizer/index.js` (the promotion-apply loop in `main`)

When an idea leaves the backlog to be written, re-pull its *current* search volume so we never write against stale numbers — and if demand has cratered below the floor, skip the promotion rather than spend a writing slot on dead demand. This is the "re-validate at promotion" guarantee.

- [ ] **Step 1: Add the re-validation helper**

In `agents/pipeline-prioritizer/index.js`, add near the other helpers:

```js
// Re-pull current volume for a keyword at promotion time. Returns the live
// monthly volume (number) or null if unavailable. Single keyword → one cheap call.
async function currentVolume(keyword) {
  try {
    const [row] = await getSearchVolume([keyword]);
    return row?.volume ?? null;
  } catch { return null; }
}
```

- [ ] **Step 2: Re-validate inside the promotion loop**

Replace the existing promote loop (the `for (const p of plan.promotions)` block in `main`) with:

```js
  // 3) promote: re-validate demand, then assign publish_date
  const MIN_VOL = cfg.signals.unmapped.minImpressions; // reuse demand floor
  for (const p of plan.promotions) {
    const item = calendar.items.find((i) => i.slug === p.slug);
    const kw = item?.keyword || plan.scored.find((i) => i.slug === p.slug)?.keyword;
    const vol = kw ? await currentVolume(kw) : null;
    if (vol != null && vol < MIN_VOL) {
      console.log(`  skip promote ${p.slug}: demand cratered (vol ${vol} < ${MIN_VOL})`);
      payload.promotions = payload.promotions.filter((x) => x.slug !== p.slug);
      continue;
    }
    upsertItem({
      slug: p.slug, publish_date: p.publish_date, original_publish_date: p.publish_date,
      ...(vol != null ? { volume: vol } : {}),
    });
  }
```

- [ ] **Step 3: Verify dry-run still works and a live run re-validates**

Run: `node agents/pipeline-prioritizer/index.js --dry-run` (unchanged — dry-run never reaches the promote loop)
Then a guarded live check: `node agents/pipeline-prioritizer/index.js` and confirm the log shows either a promotion with a refreshed `volume` on the calendar item, or a `skip promote ... demand cratered` line. Confirm `data/calendar/calendar.json` shows the promoted item with an updated `volume`.

- [ ] **Step 4: Commit**

```bash
git add agents/pipeline-prioritizer/index.js
git commit -m "feat(pipeline-prioritizer): re-validate demand at promotion"
```

---

## Task 11: calendar-runner — write-lead-window guard

**Files:**
- Modify: `agents/calendar-runner/index.js` (the `workItems` filter, ~line 645)

Make the runner draft an item only when its publish date is within `BUFFER_DAYS`, so promoted ideas are written just-in-time rather than far ahead.

- [ ] **Step 1: Add the config read near the top of the file**

After the existing `const ROOT = ...` (line 37), add:

```js
import { readFileSync as _rf } from 'fs';
const PRIORITY_CFG = (() => { try { return JSON.parse(_rf(join(ROOT, 'config', 'pipeline-priority.json'), 'utf8')); } catch { return { buffer: { days: 7 } }; } })();
const BUFFER_DAYS = PRIORITY_CFG.buffer?.days ?? 7;
```

(`readFileSync` is likely already imported from `fs`; if so, skip the aliased import and just use the existing `readFileSync`.)

- [ ] **Step 2: Apply the guard at the workItems filter**

Find (line ~645):

```js
  let workItems = items.filter(i => !['published', 'scheduled'].includes(getItemStatus(i)));
```

Replace with:

```js
  // Lead-window guard (JIT): only draft items whose publish date is within
  // BUFFER_DAYS. Promoted ideas get a near-term slot from the prioritizer; ideas
  // dated further out (or undated backlog) wait. Keyword-targeted runs bypass this.
  const leadCutoff = new Date(Date.now() + BUFFER_DAYS * 86400000);
  let workItems = items.filter(i =>
    !['published', 'scheduled'].includes(getItemStatus(i)) &&
    (kwArg || (i.adjustedDate || i.publishDate) <= leadCutoff)
  );
```

- [ ] **Step 3: Verify**

Run: `node agents/calendar-runner/index.js --dry-run`
Expected: only items dated within ~7 days appear as "Processing"; far-future/undated items are not selected. No errors.

- [ ] **Step 4: Commit**

```bash
git add agents/calendar-runner/index.js
git commit -m "feat(calendar-runner): JIT write-lead-window guard"
```

---

## Task 12: daily-summary — prioritizer section + freshness

**Files:**
- Modify: `agents/daily-summary/index.js`

- [ ] **Step 1: Add a loader + section**

Find where other sections build the digest body (e.g. `loadSeoImpact()` / `seoImpactSection`). Add a loader mirroring that pattern:

```js
function loadPrioritizer() {
  const p = join(ROOT, 'data', 'reports', 'pipeline-prioritizer', 'latest.json');
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function prioritizerSection(pp) {
  if (!pp) return '';
  const L = ['## Pipeline Priority', ''];
  L.push(`Backlog ${pp.backlog_depth} ideas · buffer ${pp.buffer_ready}/${pp.buffer_target}`);
  if (pp.promotions?.length) { L.push('', '**Fast-tracked / written next:**'); for (const x of pp.promotions) L.push(`- ${x.slug} → ${x.publish_date.slice(0,10)} (${x.reason})`); }
  if (pp.injections?.length) { L.push('', '**New ideas queued:**'); for (const x of pp.injections) L.push(`- ${x.keyword} (${x.why})`); }
  if (pp.suggestions?.length) { L.push('', '**Suggested (confirm):**'); for (const x of pp.suggestions.slice(0,5)) L.push(`- ${x.key} (${x.reason})`); }
  if (pp.alerts?.length) { L.push('', '**⚠️ Alerts:**'); for (const a of pp.alerts) L.push(`- ${a}`); }
  return L.join('\n');
}
```

- [ ] **Step 2: Wire the section into the digest body**

Where the digest concatenates sections, add `prioritizerSection(loadPrioritizer())` alongside the existing `seoImpactSection`.

- [ ] **Step 3: Add freshness monitoring entry**

In `checkSystemHealth()`, add `pipeline-prioritizer` to the report-freshness list with `maxAgeDays: 2` (it runs daily), matching how `gsc-opportunity` / `publish-drift` entries are registered.

- [ ] **Step 4: Verify the digest renders**

Run: `node agents/daily-summary/index.js --dry-run` (or the file's equivalent preview flag)
Expected: a "Pipeline Priority" section appears; no template errors.

- [ ] **Step 5: Commit**

```bash
git add agents/daily-summary/index.js
git commit -m "feat(daily-summary): pipeline-priority digest section + freshness"
```

---

## Task 13: Retire unmapped-query-promoter + wire cron

**Files:**
- Modify: `agents/unmapped-query-promoter/index.js` (deprecation header)
- Modify: `scripts/setup-cron.sh`

The prioritizer subsumes unmapped-query-promoter (it injects unmapped queries as JIT backlog ideas). Running both would double-inject and the promoter's `today+14` date defeats JIT.

- [ ] **Step 1: Add a deprecation note to the promoter header**

At the top of `agents/unmapped-query-promoter/index.js`, add a comment:

```js
// DEPRECATED (2026-06): superseded by agents/pipeline-prioritizer, which injects
// unmapped queries as just-in-time backlog ideas (no fixed +14d date) and ranks
// them against all other signals. Left in place for manual/historical use; no
// longer scheduled. See docs/superpowers/specs/2026-06-13-pipeline-prioritizer-design.md
```

- [ ] **Step 2: Update cron**

In `scripts/setup-cron.sh`:
- **Remove** the `unmapped-query-promoter` entry (the `WEEKLY_UNMAPPED_PROMOTER` / daily promoter line).
- **Add** a daily prioritizer entry that runs after the signal agents (~07:00 PT = 14:00 UTC, before the 10:00-UTC... note: confirm ordering against existing UTC offsets in the file) and before calendar-runner. Match the file's existing variable + cron style:

```bash
DAILY_PIPELINE_PRIORITIZER="0 14 * * * cd $PROJECT_DIR && /usr/bin/node agents/pipeline-prioritizer/index.js >> $LOG_DIR/pipeline-prioritizer.log 2>&1"
```

Then include `$DAILY_PIPELINE_PRIORITIZER` in the block that gets written to crontab, and ensure the script's "strip all seo-claude entries" step still matches (it strips by project dir, so no change needed). Verify the prioritizer's UTC hour is AFTER gsc-opportunity (13:30 UTC) / rank-alerter / seo-impact and BEFORE calendar-runner.

- [ ] **Step 3: Verify the cron script is valid**

Run: `bash -n scripts/setup-cron.sh`
Expected: no syntax errors. (Do NOT run the installer locally — it edits the crontab. Install happens on the server during deploy.)

- [ ] **Step 4: Commit**

```bash
git add agents/unmapped-query-promoter/index.js scripts/setup-cron.sh
git commit -m "chore(cron): schedule pipeline-prioritizer, retire unmapped-query-promoter"
```

---

## Spec coverage notes (read before reviewing)

A few spec guardrails are realized through scoring/structure rather than a dedicated rule — intentional, not omissions:

- **Refresh-first when revenue is at risk** — delivered by scoring: a `rank_drop` on a money page is a *strong* signal (high `priority_score`), so its refresh task outranks speculative `new` posts in the promotion sort. No separate tie-break rule needed.
- **Cannibalization-safe injection** — `computePlan` skips injecting any keyword already covered (`isCovered`). If a page already targets it, no competing post is created; a decline on that page surfaces separately as a `rank_drop` refresh.
- **Quality gate absolute / cadence flat** — preserved by *not* changing the writing pipeline or weekly slot count: promotions only fill the buffer (reorder, never add), and the editor gate is untouched. Buffer-zero surfaces as a backlog low-water alert rather than a rushed post.
- **Dashboard panel** — deferred to Phase 2 (digest section in Task 12 gives interim visibility).

## Final verification (before PR)

- [ ] **All tests pass**

Run: `node --test tests/lib/keyword-dedup.test.js tests/lib/publish-schedule.test.js tests/lib/pipeline-priority.test.js tests/agents/pipeline-prioritizer.test.js`
Expected: all green, output pristine.

- [ ] **End-to-end dry-run on real data** (your "test before bulk-apply" rule)

Run: `node agents/pipeline-prioritizer/index.js --dry-run`
Confirm: signal counts look sane; promotions on Mon/Wed/Fri; injections undated; no off-scope or rejected keywords injected; buffer math correct.

- [ ] **One live run, then inspect**

Run: `node agents/pipeline-prioritizer/index.js`
Then: `node agents/calendar-runner/index.js` (status only) and confirm the promoted item now shows a near-term date and would be the next written. Check `data/reports/pipeline-prioritizer/latest.json` and the digest section.

- [ ] **Open the PR**

```bash
git push -u origin feature/pipeline-prioritizer
gh pr create --title "Signal-driven content pipeline reprioritization (Phase 1)" --body "Implements docs/superpowers/specs/2026-06-13-pipeline-prioritizer-design.md. JIT backlog + buffer, signal-driven scoring with hysteresis, auto-apply-strong/surface-weak, SEO best-practice guardrails. Phase 2 (closed-loop weight tuner + dashboard panel) to follow."
```

- [ ] **Deploy** (after merge, per CLAUDE.md): `ssh root@137.184.119.230 'cd ~/seo-claude && git pull && ./scripts/setup-cron.sh && pm2 restart seo-dashboard'`, then confirm the new cron line and `pm2 status` online.

---

## Phase 2 (separate plan — author after Phase 1 is live)

1. **Closed-loop weight tuner** — monthly job: read `seo-impact` `action_wins`, attribute rank/revenue outcomes to the signal type that drove each fast-track, nudge `config/pipeline-priority.json` weights (bounded deltas), log to digest. Same shape as `insight-aggregator`.
2. **Dashboard "Pipeline Priority" panel** — ranked backlog with provenance, buffer gauge, recent moves, sourced from `data/reports/pipeline-prioritizer/latest.json`.
