# Demand Miner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the top-of-funnel demand data the fleet already pays for and throws away — People Also Ask questions, related searches, and GSC impression leaks — into a joinable artifact.

**Architecture:** Follows the established `lib/voice-of-customer.js` + `agents/voice-of-customer/index.js` split: a pure, network-free "brain" library holding all logic and rendering, paired with a thin agent shell that does I/O, one LLM call, and `notify()`. Two upstream changes feed it — an additive `paa`/`relatedSearches` on `getSerpResults`, and a new `impression-leaks.json` feed from `gsc-query-miner` that mirrors the existing `untapped-candidates.json`.

**Tech Stack:** Node 22 LTS, plain ESM, `node --test`. DataForSEO via `lib/dataforseo.js`, Anthropic via `lib/anthropic.js`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-26-demand-miner-design.md` — read it first. It explains why this produces data and deliberately no content.

## Global Constraints

- **Node 22 LTS.** Run `nvm use` before testing. The server runs 22.x and is production truth.
- **Test command:** `npm test` (defined as `node --test 'tests/**/*.test.js'`). A bare directory argument does NOT work in this repo — `node --test tests/` reports a spurious `fail 1`. Baseline entering this plan: **2093 pass / 0 fail / 0 cancelled**; report all three, because a test that never settles prints `cancelled` alongside `# fail 0` and reads like a pass.
- **`getSerpResults` changes are ADDITIVE ONLY.** It has **nine** production callers, every one destructuring `{ organic }`. Renaming, reshaping or filtering `organic` or `serpFeatures` breaks all nine. This is the single highest-risk change in the plan.
- **Awareness vocabulary is imported, never redefined.** `lib/voice-of-customer.js` already exports `AWARENESS_LEVELS` = `['unaware','problem-aware','solution-aware','product-aware','most-aware']`, which is exactly what `personas.json` uses. Import it. A second copy would silently drift and break the persona join this artifact exists to enable.
- **Seed cap is 40 per run, hard.** Cost is one DataForSEO SERP call per seed. Without the cap a bad GSC week becomes hundreds of unattended paid API calls.
- **Never `notify()` without `category`.** Real signature: `notify({ subject, body, status = 'info', category = '', immediate = false })`. There is no `agent` parameter.
- **Agents must not run on import.** Guard `main()` behind `if (process.argv[1] && process.argv[1].endsWith('demand-miner/index.js'))`, matching `agents/voice-of-customer/index.js`. Tests import the module; an unguarded agent would execute for real.
- **Degrade, never block.** Missing `personas.json` or missing `impression-leaks.json` sets `partial: true` and continues. Both missing: log, exit 0, write nothing.
- **Render fully in memory before the first write.** A renderer throwing mid-way must not leave one artifact new and the others stale.
- **Work in the worktree** `/Users/seanfillmore/Code/Claude/.claude/worktrees/demand-miner`, branch `feature/demand-miner-build`. Use `git -C <worktree> ...` and re-check `git branch --show-current` before every commit — this shell's working directory has been observed reverting to a different checkout between commands.
- **Never run an agent's live network path in a test.** Tests inject stubs. `data/` must be untouched: `git status --short data/` empty at the end of every task.

---

## File Structure

**Create:**
- `lib/demand-questions.js` — the pure brain. Seed derivation and capping, PAA/related-search normalization, dedup with `seen_count`, stage validation, markdown rendering. No I/O, no network, no LLM.
- `agents/demand-miner/index.js` — the I/O shell. Reads seeds, harvests SERPs, one LLM call, writes both artifacts, notifies.
- `tests/lib/demand-questions.test.js`
- `tests/lib/dataforseo-serp-shape.test.js`
- `tests/agents/demand-miner.test.js`

**Modify:**
- `lib/dataforseo.js:131-156` — `getSerpResults` gains `paa` and `relatedSearches`.
- `agents/gsc-query-miner/index.js` — emit `impression-leaks.json` beside the existing `untapped-candidates.json`.
- `scheduler.js` — monthly block, immediately after `voice-of-customer`.
- `CLAUDE.md` — document the new agent and the new feed.

**Artifacts produced at runtime** (gitignored, server-authoritative — do not commit):
- `data/context/demand-questions.json`, `data/context/demand-questions.md`
- `data/reports/demand-miner/seeds-YYYY-MM-DD.json`, `latest.json`
- `data/reports/gsc-query-miner/impression-leaks.json`

---

### Task 1: `getSerpResults` gains `paa` and `relatedSearches`

**Files:**
- Modify: `lib/dataforseo.js:125-156`
- Test: `tests/lib/dataforseo-serp-shape.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `getSerpResults(keyword, depth, opts)` now resolves `{ organic, serpFeatures, paa, relatedSearches }`. `paa` is `Array<{ question: string, source: 'paa' }>`; `relatedSearches` is `Array<{ question: string, source: 'related_search' }>`. Both are `[]` when the SERP has no such box. `organic` and `serpFeatures` are **byte-identical to before**.

- [ ] **Step 1: Confirm the real DataForSEO item shapes before writing anything**

Do not trust this plan's memory of the API. Read the DataForSEO SERP Advanced documentation for the `people_also_ask` and `related_searches` item types, and confirm: the PAA item's nested question array and the field holding the question text, and whether `related_searches` items are bare strings or objects.

Record what you find in your report. If the real shape differs from what Step 3 assumes, **use the real shape** and say so — this repo's standing rule is to read the API docs rather than guess parameters.

- [ ] **Step 2: Write the failing test**

Create `tests/lib/dataforseo-serp-shape.test.js`. Adjust the fixture to whatever Step 1 established:

```js
// tests/lib/dataforseo-serp-shape.test.js
//
// getSerpResults has NINE production callers, every one destructuring { organic }.
// This file's first job is to pin that shape so an additive change stays additive.
// Its second job is to prove paa/relatedSearches are actually extracted.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { extractSerpPayload } from '../../lib/dataforseo.js';

/** A SERP response with organic results, a PAA box, and a related-searches box. */
const FIXTURE_ITEMS = [
  { type: 'organic', rank_group: 1, url: 'https://a.example/1', title: 'A', domain: 'a.example', description: 'first' },
  { type: 'organic', rank_group: 2, url: 'https://b.example/2', title: 'B', domain: 'b.example', description: 'second' },
  {
    type: 'people_also_ask',
    items: [
      { type: 'people_also_ask_element', title: 'Does coconut oil clog pores?' },
      { type: 'people_also_ask_element', title: 'Is coconut oil comedogenic?' },
    ],
  },
  { type: 'related_searches', items: ['coconut oil for dry skin', 'coconut oil breakout'] },
];

test('organic keeps its exact pre-existing shape', () => {
  const { organic } = extractSerpPayload(FIXTURE_ITEMS);
  assert.equal(organic.length, 2);
  assert.deepEqual(organic[0], {
    position: 1, url: 'https://a.example/1', title: 'A', domain: 'a.example', description: 'first',
  });
});

test('serpFeatures keeps its exact pre-existing shape — deduped type names', () => {
  const { serpFeatures } = extractSerpPayload(FIXTURE_ITEMS);
  assert.deepEqual(serpFeatures, ['organic', 'people_also_ask', 'related_searches']);
});

test('paa is extracted as question records', () => {
  const { paa } = extractSerpPayload(FIXTURE_ITEMS);
  assert.deepEqual(paa, [
    { question: 'Does coconut oil clog pores?', source: 'paa' },
    { question: 'Is coconut oil comedogenic?', source: 'paa' },
  ]);
});

test('relatedSearches is extracted as question records', () => {
  const { relatedSearches } = extractSerpPayload(FIXTURE_ITEMS);
  assert.deepEqual(relatedSearches, [
    { question: 'coconut oil for dry skin', source: 'related_search' },
    { question: 'coconut oil breakout', source: 'related_search' },
  ]);
});

test('a SERP with no PAA or related box yields empty arrays, not undefined', () => {
  const { paa, relatedSearches, organic } = extractSerpPayload([FIXTURE_ITEMS[0]]);
  assert.deepEqual(paa, []);
  assert.deepEqual(relatedSearches, []);
  assert.equal(organic.length, 1, 'organic still works when nothing else is present');
});

test('malformed PAA and related items are skipped, not thrown on', () => {
  const messy = [
    { type: 'people_also_ask' },                                  // no items
    { type: 'people_also_ask', items: [{ title: '' }, {}] },       // empty and missing title
    { type: 'related_searches', items: [null, '', 'usable one'] },
  ];
  const { paa, relatedSearches } = extractSerpPayload(messy);
  assert.deepEqual(paa, []);
  assert.deepEqual(relatedSearches, [{ question: 'usable one', source: 'related_search' }]);
});

test('every existing caller destructuring only { organic } is unaffected', () => {
  // The nine callers do `const { organic } = await getSerpResults(...)`. Adding keys
  // cannot break that, but this pins the intent so a future edit that *replaces*
  // rather than *adds* fails here rather than in production.
  const payload = extractSerpPayload(FIXTURE_ITEMS);
  assert.ok('organic' in payload && 'serpFeatures' in payload);
  assert.ok(Array.isArray(payload.organic) && Array.isArray(payload.serpFeatures));
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
cd /Users/seanfillmore/Code/Claude/.claude/worktrees/demand-miner
nvm use
node --test tests/lib/dataforseo-serp-shape.test.js
```

Expected: FAIL — `extractSerpPayload` is not exported.

- [ ] **Step 4: Extract the pure part and add the new fields**

In `lib/dataforseo.js`, replace the body of `getSerpResults` (currently lines 131-156) so the item-shaping logic becomes a separately exported pure function, and the network wrapper calls it. Keep `getSerpResults`'s signature and behaviour identical for existing callers:

```js
/**
 * Shape a raw DataForSEO SERP `items` array into the fleet's payload.
 *
 * Exported separately from getSerpResults so it can be tested without a network
 * call. `organic` and `serpFeatures` are the ORIGINAL contract and must not change:
 * nine production callers destructure `{ organic }`, and one live failure has already
 * been caused by this function's return shape being misread as a bare array.
 *
 * `paa` and `relatedSearches` are additive. Google's People Also Ask box is the
 * purest top-of-funnel signal available and the fleet has been paying for it on every
 * SERP call and discarding it.
 */
export function extractSerpPayload(items = []) {
  const serpFeatures = [...new Set(items.map((i) => i.type).filter(Boolean))];

  const organic = items
    .filter((i) => i.type === 'organic')
    .map((i) => ({
      position: i.rank_group,
      url: i.url,
      title: i.title,
      domain: i.domain,
      description: i.description,
    }));

  const paa = items
    .filter((i) => i.type === 'people_also_ask')
    .flatMap((i) => i.items || [])
    .map((q) => (q && typeof q.title === 'string' ? q.title.trim() : ''))
    .filter(Boolean)
    .map((question) => ({ question, source: 'paa' }));

  const relatedSearches = items
    .filter((i) => i.type === 'related_searches')
    .flatMap((i) => i.items || [])
    .map((q) => (typeof q === 'string' ? q.trim() : (q && typeof q.title === 'string' ? q.title.trim() : '')))
    .filter(Boolean)
    .map((question) => ({ question, source: 'related_search' }));

  return { organic, serpFeatures, paa, relatedSearches };
}
```

Then make `getSerpResults` delegate to it, leaving its own docstring updated to mention the new fields:

```js
export async function getSerpResults(keyword, depth = 10, { device = 'desktop' } = {}) {
  const { result } = await api('/serp/google/organic/live/advanced', {
    keyword,
    location_code: 2840,
    language_code: 'en',
    depth,
    device,
  });
  const taskResult = result[0] || {};
  return extractSerpPayload(taskResult.items || []);
}
```

- [ ] **Step 5: Run the new test and the whole suite**

```bash
node --test tests/lib/dataforseo-serp-shape.test.js
npm test
```

Expected: new file green; full suite still **2093 pass / 0 fail / 0 cancelled** plus the new cases. Any change in the existing count means a caller broke — investigate before continuing, do not proceed.

- [ ] **Step 6: Commit**

```bash
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/demand-miner add lib/dataforseo.js tests/lib/dataforseo-serp-shape.test.js
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/demand-miner commit -m "feat(dataforseo): keep the PAA and related-search boxes we already pay for

getSerpResults filtered items to type === 'organic' and reduced the rest to a
list of type names, so every People Also Ask question the fleet has ever fetched
was discarded. Additive only — organic and serpFeatures are unchanged, pinned by
a regression test, because nine callers destructure { organic }."
```

---

### Task 2: `gsc-query-miner` emits `impression-leaks.json`

**Files:**
- Modify: `agents/gsc-query-miner/index.js` (leak computation at :85, write beside `untapped-candidates.json` at :303)
- Test: `tests/agents/gsc-query-miner-leaks.test.js` (create)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `data/reports/gsc-query-miner/impression-leaks.json`, shaped `{ generated_at, source: 'gsc-query-miner', min_impressions, leaks: Array<{ query, impressions, clicks, position }> }`. Task 4's agent reads this file.

An impression leak is a query with ≥50 impressions and 0 clicks — usually a funnel-stage mismatch, where Google thinks we answer a question our commercial page does not. The agent already computes these as `rawLeaksAll` (line 279) and then discards the structure, persisting them only as rows inside an LLM-written markdown report.

- [ ] **Step 1: Write the failing test**

Create `tests/agents/gsc-query-miner-leaks.test.js`:

```js
// tests/agents/gsc-query-miner-leaks.test.js
//
// The leak set is computed already and thrown away — it survives only as prose rows
// inside an LLM-written markdown report. This pins the structured feed that replaces
// that, using the same shape as the existing untapped-candidates.json feed.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildImpressionLeaksFeed } from '../../agents/gsc-query-miner/leaks-feed.js';

const LEAKS = [
  { query: 'is coconut oil bad for acne', impressions: 900, clicks: 0, position: 12.4 },
  { query: 'natural deodorant rash', impressions: 300, clicks: 0, position: 8.1 },
];

test('the feed carries the leaks and its own provenance', () => {
  const feed = buildImpressionLeaksFeed(LEAKS, { minImpr: 50, now: '2026-08-21T00:00:00.000Z' });
  assert.equal(feed.source, 'gsc-query-miner');
  assert.equal(feed.generated_at, '2026-08-21T00:00:00.000Z');
  assert.equal(feed.min_impressions, 50);
  assert.deepEqual(feed.leaks, LEAKS);
});

test('leaks are ordered highest-impression first, so a consumer capping the list takes the biggest', () => {
  const feed = buildImpressionLeaksFeed([LEAKS[1], LEAKS[0]], { minImpr: 50, now: 'x' });
  assert.deepEqual(feed.leaks.map((l) => l.impressions), [900, 300]);
});

test('an empty cycle still produces a feed, so generated_at stays a liveness signal', () => {
  // Same reasoning the untapped-candidates feed documents: a consumer's staleness
  // guard must be able to tell "ran, found nothing" from "did not run".
  const feed = buildImpressionLeaksFeed([], { minImpr: 50, now: 'x' });
  assert.deepEqual(feed.leaks, []);
  assert.equal(feed.generated_at, 'x');
});

test('only the four fields a consumer needs are carried', () => {
  const noisy = [{ query: 'q', impressions: 100, clicks: 0, position: 5, ctr: 0, extra: 'drop me' }];
  const feed = buildImpressionLeaksFeed(noisy, { minImpr: 50, now: 'x' });
  assert.deepEqual(Object.keys(feed.leaks[0]).sort(), ['clicks', 'impressions', 'position', 'query']);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test tests/agents/gsc-query-miner-leaks.test.js
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Create the pure helper**

Create `agents/gsc-query-miner/leaks-feed.js`. A separate file because `agents/gsc-query-miner/index.js` executes on import, so a test cannot import from it:

```js
// agents/gsc-query-miner/leaks-feed.js
//
// Pure shaping for the impression-leaks feed. Separate from index.js because that
// file runs the agent on import — a test importing it would execute a real run.

/**
 * Shape the already-computed leak set into a durable feed.
 *
 * Mirrors untapped-candidates.json deliberately: same { generated_at, source, ... }
 * envelope, and written even when empty so `generated_at` remains a reliable liveness
 * signal rather than silently going stale on a cycle that found nothing.
 */
export function buildImpressionLeaksFeed(leaks = [], { minImpr, now = new Date().toISOString() } = {}) {
  return {
    generated_at: now,
    source: 'gsc-query-miner',
    min_impressions: minImpr,
    leaks: [...leaks]
      .sort((a, b) => b.impressions - a.impressions)
      .map(({ query, impressions, clicks, position }) => ({ query, impressions, clicks, position })),
  };
}
```

- [ ] **Step 4: Wire it into the agent**

In `agents/gsc-query-miner/index.js`, import the helper and write the feed next to the existing `untapped-candidates.json` write (around line 303). Write it **unconditionally** — the existing untapped write sits inside an `if (keyword-index exists)` branch, and the leaks feed must not inherit that dependency, because it has none:

```js
import { buildImpressionLeaksFeed } from './leaks-feed.js';

// ... after rawLeaksAll is computed (currently line 279):
const leaksPath = join(REPORTS_DIR, 'impression-leaks.json');
writeFileSync(leaksPath, JSON.stringify(buildImpressionLeaksFeed(rawLeaksAll, { minImpr }), null, 2));
console.log(rawLeaksAll.length > 0
  ? `  Impression leaks: ${rawLeaksAll.length} written to ${leaksPath}`
  : `  Impression leaks: none this cycle — wrote empty feed to ${leaksPath}`);
```

Place it so it runs regardless of whether `keyword-index.json` exists. Read the surrounding code and confirm `REPORTS_DIR` is already defined and its directory already created before this point; if `mkdirSync` happens later, move the write after it rather than adding a second `mkdirSync`.

- [ ] **Step 5: Run the tests**

```bash
node --test tests/agents/gsc-query-miner-leaks.test.js
npm test
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/demand-miner status --short data/
```

Expected: green; `data/` clean. Do **not** run `agents/gsc-query-miner/index.js` itself — it calls the live GSC API.

- [ ] **Step 6: Commit**

```bash
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/demand-miner add agents/gsc-query-miner/leaks-feed.js agents/gsc-query-miner/index.js tests/agents/gsc-query-miner-leaks.test.js
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/demand-miner commit -m "feat(gsc-query-miner): persist impression leaks as a structured feed

They were computed and then discarded into prose rows in an LLM-written report.
Written even when empty, for the same reason untapped-candidates.json is: a
consumer must be able to tell 'ran, found nothing' from 'did not run'."
```

---

### Task 3: `lib/demand-questions.js` — seed derivation and the hard cap

**Files:**
- Create: `lib/demand-questions.js`
- Test: `tests/lib/demand-questions.test.js` (create)

**Interfaces:**
- Consumes: the leak feed shape from Task 2.
- Produces:
  - `SEED_CAP` = `40`
  - `deriveSeeds({ leaks, personas }) => { seeds: Array<{ text, origin, personaId }>, partial: boolean }` where `origin` is `'gsc_leak' | 'persona_objection'` and `personaId` is a string or `null`.

- [ ] **Step 1: Write the failing test**

Create `tests/lib/demand-questions.test.js`:

```js
// tests/lib/demand-questions.test.js
//
// The pure brain. No I/O, no network, no LLM — everything here is a plain function
// over plain data, which is why it can be tested exhaustively and cheaply.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { SEED_CAP, deriveSeeds } from '../../lib/demand-questions.js';

const leak = (query, impressions) => ({ query, impressions, clicks: 0, position: 10 });

const personas = [
  { id: 'p1', angles: [{ objection_addressed: 'will it stain my shirts' }, { objection_addressed: 'does it actually work' }] },
  { id: 'p2', angles: [{ objection_addressed: 'is it safe for eczema-prone skin' }] },
];

test('SEED_CAP is 40 — the hard ceiling on paid SERP calls per run', () => {
  assert.equal(SEED_CAP, 40);
});

test('seeds come from both origins, each labelled', () => {
  const { seeds } = deriveSeeds({ leaks: [leak('coconut oil acne', 900)], personas });
  const origins = new Set(seeds.map((s) => s.origin));
  assert.deepEqual([...origins].sort(), ['gsc_leak', 'persona_objection']);
  const fromLeak = seeds.find((s) => s.origin === 'gsc_leak');
  assert.equal(fromLeak.text, 'coconut oil acne');
  assert.equal(fromLeak.personaId, null, 'a leak has no persona');
  const fromPersona = seeds.find((s) => s.origin === 'persona_objection');
  assert.ok(fromPersona.personaId, 'a persona objection carries its persona id');
});

test('GSC leaks are taken highest-impression first', () => {
  const { seeds } = deriveSeeds({
    leaks: [leak('small', 60), leak('huge', 5000), leak('mid', 300)],
    personas: [],
  });
  assert.deepEqual(seeds.map((s) => s.text), ['huge', 'mid', 'small']);
});

test('never more than SEED_CAP seeds, however much input arrives', () => {
  const many = Array.from({ length: 500 }, (_, i) => leak(`q${i}`, 1000 - i));
  const { seeds } = deriveSeeds({ leaks: many, personas });
  assert.equal(seeds.length, SEED_CAP);
});

test('persona objections round-robin, so one persona cannot monopolise the budget', () => {
  // p1 has 30 angles, p2 has 30. A naive concat would spend the whole budget on p1.
  const greedy = [
    { id: 'p1', angles: Array.from({ length: 30 }, (_, i) => ({ objection_addressed: `p1-${i}` })) },
    { id: 'p2', angles: Array.from({ length: 30 }, (_, i) => ({ objection_addressed: `p2-${i}` })) },
  ];
  const { seeds } = deriveSeeds({ leaks: [], personas: greedy });
  const p1 = seeds.filter((s) => s.personaId === 'p1').length;
  const p2 = seeds.filter((s) => s.personaId === 'p2').length;
  assert.equal(seeds.length, SEED_CAP);
  assert.ok(Math.abs(p1 - p2) <= 1, `expected an even split, got p1=${p1} p2=${p2}`);
});

test('missing personas degrades to leaks only and reports partial', () => {
  const { seeds, partial } = deriveSeeds({ leaks: [leak('q', 100)], personas: null });
  assert.equal(partial, true);
  assert.deepEqual(seeds.map((s) => s.origin), ['gsc_leak']);
});

test('missing leaks degrades to personas only and reports partial', () => {
  const { seeds, partial } = deriveSeeds({ leaks: null, personas });
  assert.equal(partial, true);
  assert.ok(seeds.every((s) => s.origin === 'persona_objection'));
});

test('both sources present is not partial', () => {
  const { partial } = deriveSeeds({ leaks: [leak('q', 100)], personas });
  assert.equal(partial, false);
});

test('both sources absent yields no seeds and is not an error', () => {
  const { seeds, partial } = deriveSeeds({ leaks: [], personas: [] });
  assert.deepEqual(seeds, []);
  assert.equal(partial, true);
});

test('blank and duplicate objections are dropped before they cost a SERP call', () => {
  const dupes = [{ id: 'p1', angles: [
    { objection_addressed: 'same thing' },
    { objection_addressed: 'same thing' },
    { objection_addressed: '   ' },
    { objection_addressed: null },
  ] }];
  const { seeds } = deriveSeeds({ leaks: [], personas: dupes });
  assert.deepEqual(seeds.map((s) => s.text), ['same thing']);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test tests/lib/demand-questions.test.js
```

Expected: FAIL — `lib/demand-questions.js` does not exist.

- [ ] **Step 3: Implement**

Create `lib/demand-questions.js`:

```js
// lib/demand-questions.js
//
// The pure brain for agents/demand-miner. No I/O, no network, no LLM — the same
// split lib/voice-of-customer.js and lib/seo-opportunities.js use, so all logic here
// is testable without stubbing anything.

/**
 * Hard ceiling on seeds per run. Cost is ONE paid DataForSEO SERP call per seed, and
 * this agent runs unattended from cron. Without the cap a bad GSC week — a spike in
 * zero-click queries — silently becomes hundreds of paid calls nobody authorised.
 */
export const SEED_CAP = 40;

/**
 * Derive the seed queries to harvest, from the two empirical sources.
 *
 * GSC leaks are taken highest-impression first: those are questions Google already
 * believes we answer and users already decline to click, so they carry the most signal
 * per call. Persona objections round-robin ACROSS personas rather than concatenating —
 * personas.json is rank-ordered, so a straight concat would spend the entire budget on
 * persona 1 and never reach the rest.
 *
 * Missing either source is a degradation, never a failure: `partial` is set and the run
 * continues on whatever is available. Both missing yields no seeds, which the caller
 * treats as "nothing to do", not as an error.
 */
export function deriveSeeds({ leaks, personas } = {}) {
  const haveLeaks = Array.isArray(leaks) && leaks.length > 0;
  const havePersonas = Array.isArray(personas) && personas.length > 0;
  const partial = !haveLeaks || !havePersonas;

  const seen = new Set();
  const take = (text) => {
    const t = typeof text === 'string' ? text.trim() : '';
    if (!t) return null;
    const key = t.toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    return t;
  };

  const leakSeeds = (haveLeaks ? [...leaks] : [])
    .sort((a, b) => b.impressions - a.impressions)
    .map((l) => take(l.query))
    .filter(Boolean)
    .map((text) => ({ text, origin: 'gsc_leak', personaId: null }));

  // Round-robin: one objection from each persona per pass, until all are exhausted.
  const queues = (havePersonas ? personas : []).map((p) => ({
    id: p.id,
    objections: (p.angles || []).map((a) => a && a.objection_addressed),
  }));
  const personaSeeds = [];
  for (let i = 0; queues.some((q) => i < q.objections.length); i++) {
    for (const q of queues) {
      if (i >= q.objections.length) continue;
      const text = take(q.objections[i]);
      if (text) personaSeeds.push({ text, origin: 'persona_objection', personaId: q.id });
    }
  }

  return { seeds: [...leakSeeds, ...personaSeeds].slice(0, SEED_CAP), partial };
}
```

- [ ] **Step 4: Run the tests**

```bash
node --test tests/lib/demand-questions.test.js
npm test
```

Expected: all green, full suite still clean.

Note the round-robin fairness test: with 30 objections each and a 40 cap, the interleave yields 20/20. If it yields 30/10 the loop is concatenating rather than interleaving.

- [ ] **Step 5: Commit**

```bash
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/demand-miner add lib/demand-questions.js tests/lib/demand-questions.test.js
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/demand-miner commit -m "feat(demand-questions): seed derivation with a hard 40-seed cap

Round-robin across personas rather than concatenating: personas.json is
rank-ordered, so a concat would spend the whole budget on persona 1. The cap is
hard because each seed is a paid SERP call made unattended from cron."
```

---

### Task 4: `lib/demand-questions.js` — normalize, dedup, validate

**Files:**
- Modify: `lib/demand-questions.js`
- Test: `tests/lib/demand-questions.test.js` (append)

**Interfaces:**
- Consumes: `deriveSeeds` from Task 3; the `{ question, source }` records from Task 1's `paa`/`relatedSearches`.
- Produces:
  - `normalizeHarvest(harvestResults) => Array<{ text, source, seed, seed_origin, persona_id, seen_count }>` — one record per distinct question, `seen_count` incremented per distinct seed that surfaced it. `harvestResults` is `Array<{ seed: {text,origin,personaId}, paa: [...], relatedSearches: [...] }>`.
  - `validateQuestions(questions)` — throws `Error` on a `stage` outside the five awareness levels; returns the array otherwise.

- [ ] **Step 1: Write the failing test**

Append to `tests/lib/demand-questions.test.js`:

```js
import { normalizeHarvest, validateQuestions } from '../../lib/demand-questions.js';
import { AWARENESS_LEVELS } from '../../lib/voice-of-customer.js';

const seedA = { text: 'coconut oil acne', origin: 'gsc_leak', personaId: null };
const seedB = { text: 'is it safe for eczema', origin: 'persona_objection', personaId: 'p2' };

test('PAA and related searches normalize into one record shape', () => {
  const out = normalizeHarvest([{
    seed: seedA,
    paa: [{ question: 'Does coconut oil clog pores?', source: 'paa' }],
    relatedSearches: [{ question: 'coconut oil for dry skin', source: 'related_search' }],
  }]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    text: 'Does coconut oil clog pores?',
    source: 'paa',
    seed: 'coconut oil acne',
    seed_origin: 'gsc_leak',
    persona_id: null,
    seen_count: 1,
  });
  assert.equal(out[1].source, 'related_search');
});

test('the same question from two different seeds dedupes and increments seen_count', () => {
  const q = { question: 'Does coconut oil clog pores?', source: 'paa' };
  const out = normalizeHarvest([
    { seed: seedA, paa: [q], relatedSearches: [] },
    { seed: seedB, paa: [q], relatedSearches: [] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].seen_count, 2);
});

test('dedup is case- and whitespace-insensitive but keeps the first spelling', () => {
  const out = normalizeHarvest([
    { seed: seedA, paa: [{ question: 'Does Coconut Oil Clog Pores?', source: 'paa' }], relatedSearches: [] },
    { seed: seedB, paa: [{ question: '  does coconut oil clog pores?  ', source: 'paa' }], relatedSearches: [] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].text, 'Does Coconut Oil Clog Pores?');
  assert.equal(out[0].seen_count, 2);
});

test('the same question twice from the SAME seed counts once', () => {
  // seen_count means "how many distinct seeds surfaced this", not "how many times seen".
  const q = { question: 'same', source: 'paa' };
  const out = normalizeHarvest([{ seed: seedA, paa: [q, q], relatedSearches: [] }]);
  assert.equal(out[0].seen_count, 1);
});

test('the first seed to surface a question owns its attribution', () => {
  const q = { question: 'shared', source: 'paa' };
  const out = normalizeHarvest([
    { seed: seedB, paa: [q], relatedSearches: [] },
    { seed: seedA, paa: [q], relatedSearches: [] },
  ]);
  assert.equal(out[0].persona_id, 'p2');
  assert.equal(out[0].seed_origin, 'persona_objection');
});

test('an empty harvest is empty, not a throw', () => {
  assert.deepEqual(normalizeHarvest([]), []);
  assert.deepEqual(normalizeHarvest([{ seed: seedA, paa: [], relatedSearches: [] }]), []);
});

test('validateQuestions accepts every awareness level personas.json uses', () => {
  const qs = AWARENESS_LEVELS.map((stage, i) => ({ text: `q${i}`, stage }));
  assert.equal(validateQuestions(qs), qs);
});

test('validateQuestions rejects a stage outside the five levels', () => {
  assert.throws(
    () => validateQuestions([{ text: 'q', stage: 'considering' }]),
    /stage/i,
    'an invalid stage must throw — it would silently break the personas join',
  );
});

test('validateQuestions rejects a missing stage', () => {
  assert.throws(() => validateQuestions([{ text: 'q' }]), /stage/i);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test tests/lib/demand-questions.test.js
```

Expected: FAIL — `normalizeHarvest` and `validateQuestions` are not exported.

- [ ] **Step 3: Implement**

Append to `lib/demand-questions.js`:

```js
import { AWARENESS_LEVELS } from './voice-of-customer.js';

/**
 * Fold every harvested SERP into one deduped question list.
 *
 * `seen_count` is how many DISTINCT SEEDS surfaced the same question — a crude but real
 * importance signal. The same question twice from one seed counts once; the same question
 * from two seeds counts twice. Attribution belongs to the first seed that surfaced it,
 * so a question stays traceable to where it was found.
 */
export function normalizeHarvest(harvestResults = []) {
  const byKey = new Map();

  for (const { seed, paa = [], relatedSearches = [] } of harvestResults) {
    const seedSeen = new Set();
    for (const item of [...paa, ...relatedSearches]) {
      const text = typeof item?.question === 'string' ? item.question.trim() : '';
      if (!text) continue;
      const key = text.toLowerCase().replace(/\s+/g, ' ');
      if (seedSeen.has(key)) continue;   // same seed, same question — one vote
      seedSeen.add(key);

      const existing = byKey.get(key);
      if (existing) { existing.seen_count += 1; continue; }
      byKey.set(key, {
        text,
        source: item.source,
        seed: seed.text,
        seed_origin: seed.origin,
        persona_id: seed.personaId ?? null,
        seen_count: 1,
      });
    }
  }

  return [...byKey.values()];
}

/**
 * Reject any stage outside the five awareness levels.
 *
 * The levels are IMPORTED from lib/voice-of-customer.js, never redefined here: this
 * artifact's whole purpose is to join to personas.json on `stage` and `persona_id`, and
 * a second copy of the vocabulary would drift and break that join silently.
 */
export function validateQuestions(questions = []) {
  for (const q of questions) {
    if (!AWARENESS_LEVELS.includes(q.stage)) {
      throw new Error(
        `invalid stage ${JSON.stringify(q.stage)} for question ${JSON.stringify(q.text)} — expected one of ${AWARENESS_LEVELS.join(', ')}`,
      );
    }
  }
  return questions;
}
```

- [ ] **Step 4: Run the tests**

```bash
node --test tests/lib/demand-questions.test.js
npm test
```

- [ ] **Step 5: Commit**

```bash
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/demand-miner add lib/demand-questions.js tests/lib/demand-questions.test.js
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/demand-miner commit -m "feat(demand-questions): normalize, dedup with seen_count, validate stage

Awareness levels are imported from lib/voice-of-customer.js rather than
redefined — the artifact exists to join to personas.json on stage, and a second
copy of the vocabulary would drift and break that join without failing."
```

---

### Task 5: `lib/demand-questions.js` — markdown rendering

**Files:**
- Modify: `lib/demand-questions.js`
- Test: `tests/lib/demand-questions.test.js` (append)

**Interfaces:**
- Consumes: validated question records from Task 4.
- Produces: `renderDemandQuestionsMarkdown({ questions, generatedAt, cluster, seedCount, partial }) => string`.

Two rules carried from `voice-of-customer.md`, both load-bearing for a file people grep: **stable heading text** across runs, and **self-contained entries** so a single grep hit is useful on its own.

- [ ] **Step 1: Write the failing test**

Append to `tests/lib/demand-questions.test.js`:

```js
import { renderDemandQuestionsMarkdown } from '../../lib/demand-questions.js';

const RENDER_INPUT = {
  generatedAt: '2026-08-21T00:00:00.000Z',
  cluster: 'skin',
  seedCount: 28,
  partial: false,
  questions: [
    { text: 'Why does my skin react to everything?', stage: 'unaware', source: 'paa', seed: 'sensitive skin', seed_origin: 'gsc_leak', persona_id: null, seen_count: 3 },
    { text: 'Does coconut oil clog pores?', stage: 'problem-aware', source: 'paa', seed: 'coconut oil acne', seed_origin: 'persona_objection', persona_id: 'p4', seen_count: 2 },
  ],
};

test('headings are stable and grouped by funnel stage with counts', () => {
  const md = renderDemandQuestionsMarkdown(RENDER_INPUT);
  assert.match(md, /^# Demand questions/m);
  assert.match(md, /^## unaware \(1\)$/m);
  assert.match(md, /^## problem-aware \(1\)$/m);
});

test('only stages that have questions get a heading', () => {
  const md = renderDemandQuestionsMarkdown(RENDER_INPUT);
  assert.ok(!md.includes('## most-aware'), 'an empty stage must not render an empty section');
});

test('stages render in funnel order, not alphabetical or insertion order', () => {
  const md = renderDemandQuestionsMarkdown(RENDER_INPUT);
  assert.ok(md.indexOf('## unaware') < md.indexOf('## problem-aware'));
});

test('each entry is self-contained — one grep hit carries its own context', () => {
  const md = renderDemandQuestionsMarkdown(RENDER_INPUT);
  const line = md.split('\n').find((l) => l.includes('Does coconut oil clog pores?'));
  assert.ok(line.includes('paa'), 'carries its source');
  assert.ok(line.includes('coconut oil acne'), 'carries the seed that found it');
  assert.ok(line.includes('p4'), 'carries the persona it is attributed to');
  assert.ok(line.includes('2'), 'carries seen_count');
});

test('the header records provenance and the partial flag', () => {
  const md = renderDemandQuestionsMarkdown(RENDER_INPUT);
  assert.ok(md.includes('2026-08-21'));
  assert.ok(md.includes('28'));
  assert.ok(/partial.*no/i.test(md));
});

test('a partial run says so prominently', () => {
  const md = renderDemandQuestionsMarkdown({ ...RENDER_INPUT, partial: true });
  assert.ok(/partial.*yes/i.test(md));
});

test('no questions still renders a valid document', () => {
  const md = renderDemandQuestionsMarkdown({ ...RENDER_INPUT, questions: [] });
  assert.match(md, /^# Demand questions/m);
  assert.ok(md.length > 0);
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test tests/lib/demand-questions.test.js
```

Expected: FAIL — `renderDemandQuestionsMarkdown` is not exported.

- [ ] **Step 3: Implement**

Append to `lib/demand-questions.js`:

```js
/**
 * Render the human-readable, greppable artifact.
 *
 * Two rules carried from voice-of-customer.md, both for the benefit of someone grepping:
 * headings are STABLE across runs, and every entry is SELF-CONTAINED — a single grep hit
 * carries its stage, source, seed, persona and count without needing the lines around it.
 * Stages render in funnel order (AWARENESS_LEVELS), not alphabetically, so the document
 * reads from least to most aware.
 */
export function renderDemandQuestionsMarkdown({ questions = [], generatedAt, cluster, seedCount, partial } = {}) {
  const lines = [
    '# Demand questions',
    '',
    `Generated: ${generatedAt}`,
    `Cluster: ${cluster}`,
    `Seeds harvested: ${seedCount}`,
    `Partial run: ${partial ? 'yes' : 'no'}`,
    '',
    'What people ask before they know we exist. Harvested from Google People Also Ask',
    'and related searches, seeded from GSC impression leaks and persona objections.',
    'Grouped by funnel stage; `seen_count` is how many distinct seeds surfaced the same',
    'question.',
    '',
  ];

  for (const stage of AWARENESS_LEVELS) {
    const inStage = questions.filter((q) => q.stage === stage);
    if (inStage.length === 0) continue;
    lines.push(`## ${stage} (${inStage.length})`, '');
    for (const q of [...inStage].sort((a, b) => b.seen_count - a.seen_count)) {
      const persona = q.persona_id ? `persona ${q.persona_id}` : 'no persona';
      lines.push(`- **${q.text}** — stage: ${stage} · source: ${q.source} · seed: "${q.seed}" (${q.seed_origin}) · ${persona} · seen_count: ${q.seen_count}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: Run the tests**

```bash
node --test tests/lib/demand-questions.test.js
npm test
```

- [ ] **Step 5: Commit**

```bash
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/demand-miner add lib/demand-questions.js tests/lib/demand-questions.test.js
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/demand-miner commit -m "feat(demand-questions): render the greppable markdown artifact

Stable headings and self-contained entries, the two rules voice-of-customer.md
follows, because the value of the file is that one grep hit is useful alone."
```

---

### Task 6: `agents/demand-miner/index.js` — the I/O shell

**Files:**
- Create: `agents/demand-miner/index.js`
- Test: `tests/agents/demand-miner.test.js` (create)

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: `runDemandMiner({ getSerpResults, anthropic, readJson, writeArtifacts, now })` — an injectable entry point returning `{ questions, partial, seedCount }`. `main()` wires the real dependencies and is guarded so importing the module does not run the agent.

Read `agents/voice-of-customer/index.js` first — it is the precedent for this shape, including its `loadEnv`, its `notify` calls, and its `process.argv[1]` guard at the end.

- [ ] **Step 1: Write the failing test**

Create `tests/agents/demand-miner.test.js`:

```js
// tests/agents/demand-miner.test.js
//
// Smoke test with every dependency injected: no network, no LLM, no filesystem writes.
// Importing agents/*/index.js RUNS the agent in this codebase unless it is guarded —
// this file existing and passing is also the proof that guard is in place.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { runDemandMiner } from '../../agents/demand-miner/index.js';

const LEAKS = { leaks: [{ query: 'coconut oil acne', impressions: 900, clicks: 0, position: 12 }] };
const PERSONAS = { personas: [{ id: 'p1', angles: [{ objection_addressed: 'is it safe for eczema' }] }] };

const stubSerp = async () => ({
  organic: [],
  serpFeatures: ['people_also_ask'],
  paa: [{ question: 'Does coconut oil clog pores?', source: 'paa' }],
  relatedSearches: [],
});

/** Returns whatever the LLM is supposed to return: the questions, stage-classified. */
const stubAnthropic = (stages = ['problem-aware']) => ({
  messages: {
    create: async () => ({
      content: [{ type: 'text', text: JSON.stringify({
        questions: [{ text: 'Does coconut oil clog pores?', stage: stages[0] }],
      }) }],
    }),
  },
});

function collectWrites() {
  const written = {};
  return { written, writeArtifacts: (files) => Object.assign(written, files) };
}

test('a full run writes both artifacts', async () => {
  const { written, writeArtifacts } = collectWrites();
  const result = await runDemandMiner({
    getSerpResults: stubSerp,
    anthropic: stubAnthropic(),
    readJson: (p) => (p.includes('impression-leaks') ? LEAKS : PERSONAS),
    writeArtifacts,
    now: '2026-08-21T00:00:00.000Z',
  });

  assert.equal(result.partial, false);
  assert.ok(written.json, 'demand-questions.json rendered');
  assert.ok(written.md, 'demand-questions.md rendered');
  const parsed = JSON.parse(written.json);
  assert.equal(parsed.cluster, 'skin');
  assert.equal(parsed.questions[0].stage, 'problem-aware');
  assert.equal(parsed.questions[0].seed_origin, 'gsc_leak');
});

test('missing personas sets partial and still writes', async () => {
  const { written, writeArtifacts } = collectWrites();
  const result = await runDemandMiner({
    getSerpResults: stubSerp,
    anthropic: stubAnthropic(),
    readJson: (p) => (p.includes('impression-leaks') ? LEAKS : null),
    writeArtifacts,
    now: 'x',
  });
  assert.equal(result.partial, true);
  assert.ok(written.json);
});

test('missing leaks sets partial and still writes', async () => {
  const { written, writeArtifacts } = collectWrites();
  const result = await runDemandMiner({
    getSerpResults: stubSerp,
    anthropic: stubAnthropic(),
    readJson: (p) => (p.includes('impression-leaks') ? null : PERSONAS),
    writeArtifacts,
    now: 'x',
  });
  assert.equal(result.partial, true);
  assert.ok(written.json);
});

test('both sources missing writes nothing and does not throw', async () => {
  const { written, writeArtifacts } = collectWrites();
  const result = await runDemandMiner({
    getSerpResults: stubSerp,
    anthropic: stubAnthropic(),
    readJson: () => null,
    writeArtifacts,
    now: 'x',
  });
  assert.equal(result.questions.length, 0);
  assert.deepEqual(written, {}, 'no seeds is not an error, and must not write an empty artifact');
});

test('a SERP failure skips that seed, sets partial, and continues', async () => {
  const { written, writeArtifacts } = collectWrites();
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error('DataForSEO 502');
    return stubSerp();
  };
  const result = await runDemandMiner({
    getSerpResults: flaky,
    anthropic: stubAnthropic(),
    readJson: (p) => (p.includes('impression-leaks') ? LEAKS : PERSONAS),
    writeArtifacts,
    now: 'x',
  });
  assert.equal(result.partial, true, 'a skipped seed makes the run partial');
  assert.ok(written.json, 'the run still completes');
});

test('malformed LLM output is retried exactly once, then succeeds', async () => {
  const { written, writeArtifacts } = collectWrites();
  let calls = 0;
  const flakyLlm = { messages: { create: async () => {
    calls += 1;
    return calls === 1
      ? { content: [{ type: 'text', text: 'not json at all' }] }
      : { content: [{ type: 'text', text: JSON.stringify({ questions: [{ text: 'Does coconut oil clog pores?', stage: 'problem-aware' }] }) }] };
  } } };
  const result = await runDemandMiner({
    getSerpResults: stubSerp,
    anthropic: flakyLlm,
    readJson: (p) => (p.includes('impression-leaks') ? LEAKS : PERSONAS),
    writeArtifacts,
    now: 'x',
  });
  assert.equal(calls, 2, 'exactly one retry');
  assert.ok(written.json, 'the retry succeeded and the artifact was written');
  assert.equal(result.questions.length, 1);
});

test('malformed LLM output twice throws and writes nothing', async () => {
  const { written, writeArtifacts } = collectWrites();
  let calls = 0;
  const brokenLlm = { messages: { create: async () => {
    calls += 1;
    return { content: [{ type: 'text', text: 'still not json' }] };
  } } };
  await assert.rejects(() => runDemandMiner({
    getSerpResults: stubSerp,
    anthropic: brokenLlm,
    readJson: (p) => (p.includes('impression-leaks') ? LEAKS : PERSONAS),
    writeArtifacts,
    now: 'x',
  }));
  assert.equal(calls, 2, 'one attempt plus one retry, then give up — not an infinite loop');
  assert.deepEqual(written, {}, 'no partial write');
});

test('the JSON envelope matches the artifact contract exactly', async () => {
  const { written, writeArtifacts } = collectWrites();
  await runDemandMiner({
    getSerpResults: stubSerp,
    anthropic: stubAnthropic(),
    readJson: (p) => (p.includes('impression-leaks') ? LEAKS : PERSONAS),
    writeArtifacts,
    now: '2026-08-21T00:00:00.000Z',
  });
  const parsed = JSON.parse(written.json);
  assert.deepEqual(Object.keys(parsed).sort(), ['cluster', 'generated_at', 'partial', 'questions', 'seed_count']);
  assert.deepEqual(Object.keys(parsed.questions[0]).sort(),
    ['persona_id', 'seed', 'seed_origin', 'seen_count', 'source', 'stage', 'text'],
    'the funnel-matrix join depends on stage and persona_id being present under these exact names');
});

test('an invalid stage from the LLM throws rather than writing a broken artifact', async () => {
  const { written, writeArtifacts } = collectWrites();
  await assert.rejects(
    () => runDemandMiner({
      getSerpResults: stubSerp,
      anthropic: stubAnthropic(['considering']),   // not one of the five levels
      readJson: (p) => (p.includes('impression-leaks') ? LEAKS : PERSONAS),
      writeArtifacts,
      now: 'x',
    }),
    /stage/i,
  );
  assert.deepEqual(written, {}, 'no partial write on a validation failure');
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test tests/agents/demand-miner.test.js
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the shell**

Create `agents/demand-miner/index.js`. Read `agents/voice-of-customer/index.js` first and follow its structure — `loadEnv`, the `ROOT` resolution, the `notify` calls, and the `process.argv[1]` guard.

`runDemandMiner` is the injectable core. Write it to this shape:

```js
import { deriveSeeds, normalizeHarvest, validateQuestions, renderDemandQuestionsMarkdown } from '../../lib/demand-questions.js';

const CLUSTER = 'skin';

/**
 * The injectable core. Every dependency is a parameter, so the smoke test needs no
 * network, no LLM and no filesystem. main() below wires the real ones.
 */
export async function runDemandMiner({ getSerpResults, anthropic, readJson, writeArtifacts, now }) {
  const leaksFeed = readJson('data/reports/gsc-query-miner/impression-leaks.json');
  const personasFile = readJson('data/context/personas.json');

  const { seeds, partial: seedPartial } = deriveSeeds({
    leaks: leaksFeed?.leaks ?? null,
    personas: personasFile?.personas ?? personasFile ?? null,
  });
  let partial = seedPartial;

  // No seeds is not an error — log and leave every artifact untouched. Writing an
  // empty artifact would overwrite a good one from a previous run with nothing.
  if (seeds.length === 0) return { questions: [], partial, seedCount: 0 };

  // Per-seed degradation, as the VOC agent does: one bad SERP must not lose the run.
  const harvest = [];
  for (const seed of seeds) {
    try {
      const { paa = [], relatedSearches = [] } = await getSerpResults(seed.text);
      harvest.push({ seed, paa, relatedSearches });
    } catch (err) {
      console.warn(`  seed "${seed.text}" failed: ${err.message} — skipping`);
      partial = true;
    }
  }

  const records = normalizeHarvest(harvest);
  const staged = validateQuestions(await classifyStages({ anthropic, records }));

  // Both artifacts render fully in memory BEFORE the first write, so a renderer throw
  // cannot leave one file new and the other stale.
  const payload = {
    generated_at: now,
    cluster: CLUSTER,
    seed_count: seeds.length,
    partial,
    questions: staged,
  };
  const json = JSON.stringify(payload, null, 2);
  const md = renderDemandQuestionsMarkdown({
    questions: staged, generatedAt: now, cluster: CLUSTER, seedCount: seeds.length, partial,
  });
  writeArtifacts({ json, md });

  return { questions: staged, partial, seedCount: seeds.length };
}
```

`classifyStages({ anthropic, records })` is the one LLM call. It sends the deduped question texts, asks for a stage per question from the five awareness levels, parses the JSON response, and merges each returned `stage` back onto its record by `text`. **It retries exactly once on malformed or schema-violating output, then throws** — the spec requires that retry, and a throw here must happen before any write so a bad classification cannot produce a half-written artifact. Log the retry so a recurring parse failure is visible in the digest rather than silent.

Requirements the tests pin, restated so you can check your own work:

- `runDemandMiner` takes every dependency as a parameter and touches nothing global.
- A per-seed throw is caught, sets `partial`, and continues.
- `validateQuestions` runs **before** any write; a bad stage throws.
- `writeArtifacts({ json, md })` is called **once**, with both artifacts already rendered.
- Zero seeds: return early, call `writeArtifacts` **not at all**.
- The JSON envelope is exactly `{ generated_at, cluster, seed_count, partial, questions }`, and each question carries `{ text, stage, source, seed, seed_origin, persona_id, seen_count }` — this is the artifact contract in the spec, and the funnel-matrix join depends on `stage` and `persona_id` specifically.

`main()` then wires the real dependencies: `getSerpResults` from `lib/dataforseo.js`, an `Anthropic` client from `lib/anthropic.js`, `readJson` reading `data/reports/gsc-query-miner/impression-leaks.json` and `data/context/personas.json` (returning `null` when absent rather than throwing), and a `writeArtifacts` that `mkdirSync`s and writes `data/context/demand-questions.{json,md}` plus `data/reports/demand-miner/seeds-<date>.json` and `latest.json`.

`main()` notifies on completion with `category: 'demand-miner'`, and on a validation failure with `{ status: 'error', immediate: true }` — that one must not wait for the 5 AM digest because it means the artifact is not written.

End the file with the guard:

```js
if (process.argv[1] && process.argv[1].endsWith('demand-miner/index.js')) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 4: Run the tests**

```bash
node --test tests/agents/demand-miner.test.js
npm test
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/demand-miner status --short data/
```

Expected: green, `data/` clean. If `data/` is dirty, the shell is writing during a test — the injected `writeArtifacts` is being bypassed somewhere.

- [ ] **Step 5: Commit**

```bash
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/demand-miner add agents/demand-miner/index.js tests/agents/demand-miner.test.js
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/demand-miner commit -m "feat(demand-miner): the agent shell

Every dependency injectable so the smoke test needs no network, no LLM and no
filesystem. Both artifacts render fully in memory before the first write, so a
renderer throw cannot leave one file new and the other stale."
```

---

### Task 7: Schedule it, document it, verify end to end

**Files:**
- Modify: `scheduler.js` (monthly block, after the `voice-of-customer` step at ~line 421)
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-07-26-demand-miner-design.md` (status line)

**Interfaces:** none.

- [ ] **Step 1: Schedule it**

In `scheduler.js`'s monthly block (`if (new Date().getDate() === 1) {`), add a step immediately **after** the `voice-of-customer` step. Order is load-bearing: this agent reads `personas.json`, which `voice-of-customer` rewrites in the same block, so running before it would seed from last month's personas.

Match the surrounding `runStep(...)` form exactly, including its `indent` option, and add a comment saying why it must follow `voice-of-customer`.

- [ ] **Step 2: Document it in `CLAUDE.md`**

Add a short paragraph in the Architecture section near the other agent descriptions, and add the two new artifacts to the Data Layout Conventions list:

- `data/context/demand-questions.{md,json}` — top-of-funnel demand, monthly, written after `voice-of-customer`; joins to `personas.json` on `stage` and `persona_id`.
- `data/reports/gsc-query-miner/impression-leaks.json` — structured leak feed, written every run even when empty.

State the three things a future reader most needs: that `getSerpResults`'s `paa`/`relatedSearches` are additive and its nine callers depend on `organic`/`serpFeatures` being untouched; that the awareness vocabulary is imported from `lib/voice-of-customer.js` and must not be redefined; and that the 40-seed cap exists because each seed is a paid API call made unattended.

Match the file's voice — dense, specific, explaining what went wrong without the rule. **Verify every claim against the code before writing it**; a wrong line in `CLAUDE.md` is loaded into every future session as ground truth.

- [ ] **Step 3: Update the spec's status line**

Change `**Status:** Approved design, pending implementation plan` to record that it is implemented, naming this plan.

- [ ] **Step 4: Full verification**

```bash
cd /Users/seanfillmore/Code/Claude/.claude/worktrees/demand-miner
nvm use && node --version    # must be v22.x
npm test
git status --short data/
grep -rn "AWARENESS_LEVELS" lib/demand-questions.js    # must be an import, never a redefinition
```

Expected: `# fail 0` **and** `# cancelled 0`; `data/` clean.

- [ ] **Step 5: Dry-run the agent against stub data**

Do **not** run the agent's live path — it makes paid DataForSEO calls and one Anthropic call. Instead confirm the module imports without executing (proving the `process.argv[1]` guard works):

```bash
node -e "import('./agents/demand-miner/index.js').then(() => console.log('imported without running — guard OK'))"
```

Expected: prints the message, exits 0, writes nothing. If the agent runs, the guard is wrong.

- [ ] **Step 6: Commit and open the PR**

```bash
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/demand-miner add scheduler.js CLAUDE.md docs/superpowers/specs/2026-07-26-demand-miner-design.md
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/demand-miner commit -m "feat(demand-miner): schedule monthly and document the contract"
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/demand-miner push -u origin feature/demand-miner-build
```

Then `gh pr create` describing what the agent produces, why `getSerpResults`'s change is additive-only, and the known first-run limitation below.

- [ ] **Step 7: Report the first-run limitation**

`data/reports/gsc-query-miner/` in a local checkout is stale — that data is cron-written on the server and not synced. A first **local** run will therefore seed almost entirely from persona objections and report `partial: true`. That is the designed degradation, not a bug. Say so in the PR: the first meaningful run should happen on the server, after `gsc-query-miner` has written `impression-leaks.json` there at least once.

---

## Success criteria (from the spec — verify before calling this done)

1. A single run produces both artifacts from live data.
2. `demand-questions.md` contains at least one genuinely `unaware` or `problem-aware` question that appears nowhere in `voice-of-customer.md` — proving this reaches a funnel stage the VOC corpus structurally could not.
3. All nine existing `getSerpResults` callers behave identically (suite green).
4. Questions carrying `seed_origin: "gsc_leak"` trace back to a real query in `impression-leaks.json`.
5. "What are people asking that we don't answer?" is answerable by grepping `data/context/demand-questions.md`.

Criteria 1, 2 and 4 require a real run on the server and cannot be closed from a local checkout. Say so explicitly rather than claiming them.
