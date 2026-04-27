# meta-optimizer Keyword-Index Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prioritize Amazon-validated low-CTR queries within the daily limit, ground Claude rewrites in cluster-mate keywords + validation tag, stamp `validation_source` on the A/B tracker baseline.

**Architecture:** Two pure helpers in `agents/meta-optimizer/lib/` (`sort.js`, `grounding.js`), one new helper in `lib/keyword-index/consumer.js` (`clusterMatesFor`). Wire all three into `main()` and extend `rewriteMeta`'s signature with an optional `ground` parameter.

**Tech Stack:** Node.js (ESM), `node:test`, existing project conventions.

---

## File Structure

- **Modify:** `lib/keyword-index/consumer.js` — add `clusterMatesFor`.
- **Modify:** `tests/lib/keyword-index/consumer.test.js` — add `clusterMatesFor` test cases.
- **Create:** `agents/meta-optimizer/lib/sort.js` — `sortByValidation`.
- **Create:** `agents/meta-optimizer/lib/grounding.js` — `buildPromptGrounding`.
- **Create:** `tests/agents/meta-optimizer.test.js` — structure tests for the two pure helpers.
- **Modify:** `agents/meta-optimizer/index.js` — gate main(), load index, sort candidates, build grounding per loop, extend `rewriteMeta`, stamp A/B tracker.

---

## Task 1: TDD `clusterMatesFor` in consumer.js

**Files:**
- Modify: `lib/keyword-index/consumer.js`
- Modify: `tests/lib/keyword-index/consumer.test.js`

- [ ] **Step 1: Write failing tests**

Append to `tests/lib/keyword-index/consumer.test.js`:

```js
import { clusterMatesFor } from '../../../lib/keyword-index/consumer.js';

const clusterFixture = {
  keywords: {
    'natural-deodorant':       { slug: 'natural-deodorant',       cluster: 'deodorant', amazon: { purchases: 100 }, gsc: { impressions: 500 } },
    'aluminum-free-deodorant': { slug: 'aluminum-free-deodorant', cluster: 'deodorant', amazon: { purchases: 200 }, gsc: { impressions: 300 } },
    'roll-on-deodorant':       { slug: 'roll-on-deodorant',       cluster: 'deodorant', amazon: null,                gsc: { impressions: 800 } },
    'natural-soap':            { slug: 'natural-soap',            cluster: 'soap',      amazon: { purchases: 50 },   gsc: { impressions: 200 } },
    'orphan':                  { slug: 'orphan',                  cluster: 'unclustered' },
  },
};

test('clusterMatesFor returns [] for null index', () => {
  assert.deepEqual(clusterMatesFor(null, { cluster: 'deodorant' }), []);
});

test('clusterMatesFor returns [] for null entry', () => {
  assert.deepEqual(clusterMatesFor(clusterFixture, null), []);
});

test('clusterMatesFor returns [] for unclustered entry', () => {
  assert.deepEqual(clusterMatesFor(clusterFixture, clusterFixture.keywords.orphan), []);
});

test('clusterMatesFor excludes self by default', () => {
  const mates = clusterMatesFor(clusterFixture, clusterFixture.keywords['natural-deodorant']);
  assert.ok(!mates.some((m) => m.slug === 'natural-deodorant'));
});

test('clusterMatesFor includes self when excludeSelf=false', () => {
  const mates = clusterMatesFor(clusterFixture, clusterFixture.keywords['natural-deodorant'], { excludeSelf: false });
  assert.ok(mates.some((m) => m.slug === 'natural-deodorant'));
});

test('clusterMatesFor sorts by amazon.purchases desc, then gsc.impressions desc', () => {
  const mates = clusterMatesFor(clusterFixture, clusterFixture.keywords['natural-deodorant']);
  // From cluster 'deodorant' (excluding self): aluminum-free (200 amz), roll-on (0 amz, 800 gsc).
  assert.deepEqual(mates.map((m) => m.slug), ['aluminum-free-deodorant', 'roll-on-deodorant']);
});

test('clusterMatesFor respects limit', () => {
  const mates = clusterMatesFor(clusterFixture, clusterFixture.keywords['natural-deodorant'], { limit: 1 });
  assert.equal(mates.length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/lib/keyword-index/consumer.test.js`
Expected: FAIL — `clusterMatesFor is not a function`.

- [ ] **Step 3: Implement `clusterMatesFor`**

Append to `lib/keyword-index/consumer.js`:

```js
export function clusterMatesFor(index, entry, { limit = 6, excludeSelf = true } = {}) {
  if (!index?.keywords || !entry?.cluster || entry.cluster === 'unclustered') return [];
  const mates = [];
  for (const e of Object.values(index.keywords)) {
    if (!e || e.cluster !== entry.cluster) continue;
    if (excludeSelf && e.slug === entry.slug) continue;
    mates.push(e);
  }
  mates.sort((a, b) => {
    const ap = (a.amazon?.purchases ?? 0) - (b.amazon?.purchases ?? 0);
    if (ap !== 0) return -ap;
    const gi = (a.gsc?.impressions ?? 0) - (b.gsc?.impressions ?? 0);
    return -gi;
  });
  return mates.slice(0, limit);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/lib/keyword-index/consumer.test.js`
Expected: PASS — 22 tests passing (15 prior + 7 new).

- [ ] **Step 5: Commit**

```bash
git add lib/keyword-index/consumer.js tests/lib/keyword-index/consumer.test.js
git commit -m "feat(keyword-index): consumer.clusterMatesFor for cluster-mate retrieval"
```

---

## Task 2: TDD `sortByValidation`

**Files:**
- Create: `agents/meta-optimizer/lib/sort.js`
- Create: `tests/agents/meta-optimizer.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/agents/meta-optimizer.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortByValidation } from '../../agents/meta-optimizer/lib/sort.js';

test('sortByValidation orders amazon-first, then by impressions desc', () => {
  const rows = [
    { keyword: 'a', impressions: 100, validation_source: null },
    { keyword: 'b', impressions: 200, validation_source: 'amazon' },
    { keyword: 'c', impressions: 50,  validation_source: 'amazon' },
    { keyword: 'd', impressions: 300, validation_source: 'gsc_ga4' },
  ];
  const sorted = sortByValidation(rows);
  assert.deepEqual(sorted.map((r) => r.keyword), ['b', 'c', 'd', 'a']);
});

test('sortByValidation handles rows with no validation_source field (live-GSC fallback)', () => {
  const rows = [
    { keyword: 'a', impressions: 100 },
    { keyword: 'b', impressions: 200 },
  ];
  const sorted = sortByValidation(rows);
  assert.deepEqual(sorted.map((r) => r.keyword), ['b', 'a']);
});

test('sortByValidation is stable within a band', () => {
  const rows = [
    { keyword: 'a', impressions: 100, validation_source: 'amazon' },
    { keyword: 'b', impressions: 100, validation_source: 'amazon' },
  ];
  const sorted = sortByValidation(rows);
  assert.deepEqual(sorted.map((r) => r.keyword), ['a', 'b']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/agents/meta-optimizer.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `sortByValidation`**

Create `agents/meta-optimizer/lib/sort.js`:

```js
/**
 * Sort low-CTR candidates so amazon-validated queries land at the top of
 * the daily processing list. Stable within each band; works whether rows
 * carry validation_source (from gsc-opportunity/latest.json) or not
 * (from the live-GSC fallback path).
 */
export function sortByValidation(rows) {
  const band = (r) => (r.validation_source === 'amazon' ? 0 : 1);
  return [...rows].sort((a, b) => {
    const db = band(a) - band(b);
    if (db !== 0) return db;
    return (b.impressions ?? 0) - (a.impressions ?? 0);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/agents/meta-optimizer.test.js`
Expected: PASS — 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add agents/meta-optimizer/lib/sort.js tests/agents/meta-optimizer.test.js
git commit -m "feat(meta-optimizer): sortByValidation pure helper"
```

---

## Task 3: TDD `buildPromptGrounding`

**Files:**
- Create: `agents/meta-optimizer/lib/grounding.js`
- Modify: `tests/agents/meta-optimizer.test.js`

- [ ] **Step 1: Write failing tests**

Append to `tests/agents/meta-optimizer.test.js`:

```js
import { buildPromptGrounding } from '../../agents/meta-optimizer/lib/grounding.js';

test('buildPromptGrounding returns null when no index entry', () => {
  assert.equal(buildPromptGrounding(null, []), null);
});

test('buildPromptGrounding extracts validation_source + cluster mate keywords', () => {
  const entry = { validation_source: 'amazon', amazon: { conversion_share: 0.12 } };
  const mates = [{ keyword: 'aluminum free deodorant' }, { keyword: 'natural roll-on deodorant' }];
  const g = buildPromptGrounding(entry, mates);
  assert.equal(g.validationTag, 'amazon');
  assert.equal(g.conversionShare, 0.12);
  assert.deepEqual(g.clusterMateKeywords, ['aluminum free deodorant', 'natural roll-on deodorant']);
});

test('buildPromptGrounding handles entry with no amazon block', () => {
  const entry = { validation_source: 'gsc_ga4' };
  const g = buildPromptGrounding(entry, []);
  assert.equal(g.validationTag, 'gsc_ga4');
  assert.equal(g.conversionShare, null);
  assert.deepEqual(g.clusterMateKeywords, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/agents/meta-optimizer.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `buildPromptGrounding`**

Create `agents/meta-optimizer/lib/grounding.js`:

```js
/**
 * Build the optional grounding object passed to rewriteMeta. Returns null
 * when there is no index entry for the candidate keyword (preserves the
 * original prompt byte-for-byte). When present, surfaces the validation
 * tag, the Amazon conversion share (when available), and up to N
 * cluster-mate keywords for the rewriter to weave into the title/meta.
 */
export function buildPromptGrounding(indexEntry, clusterMates) {
  if (!indexEntry) return null;
  return {
    validationTag: indexEntry.validation_source ?? null,
    conversionShare: indexEntry.amazon?.conversion_share ?? null,
    clusterMateKeywords: (clusterMates || []).map((m) => m.keyword).filter(Boolean),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/agents/meta-optimizer.test.js`
Expected: PASS — 6 tests passing.

- [ ] **Step 5: Commit**

```bash
git add agents/meta-optimizer/lib/grounding.js tests/agents/meta-optimizer.test.js
git commit -m "feat(meta-optimizer): buildPromptGrounding pure helper"
```

---

## Task 4: Gate `main()` in meta-optimizer for safe importing

**Files:**
- Modify: `agents/meta-optimizer/index.js`

- [ ] **Step 1: Wrap the bottom-of-file `main()` invocation**

Find the existing trailing `main()` call (around line 516). Replace with:

```js
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(/* existing catch */);
}
```

(Preserve the existing `.catch` handler intact.)

`fileURLToPath` is already imported near the top.

- [ ] **Step 2: Smoke check syntax**

Run: `node -c agents/meta-optimizer/index.js`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add agents/meta-optimizer/index.js
git commit -m "refactor(meta-optimizer): gate main() behind import.meta.url check"
```

---

## Task 5: Wire helpers into `main()` and extend `rewriteMeta`

**Files:**
- Modify: `agents/meta-optimizer/index.js`

- [ ] **Step 1: Add imports near the top**

Add to the import block:

```js
import { loadIndex, lookupByKeyword, clusterMatesFor } from '../../lib/keyword-index/consumer.js';
import { sortByValidation } from './lib/sort.js';
import { buildPromptGrounding } from './lib/grounding.js';
```

- [ ] **Step 2: Sort candidates immediately after they are loaded**

In `main()`, find where `lowCtrPages` is finalized (after the gsc-opportunity-or-fallback block). Add directly after:

```js
const sortedCandidates = sortByValidation(lowCtrPages);
const idx = loadIndex(ROOT);
if (idx) {
  const amazonCount = sortedCandidates.filter((r) => r.validation_source === 'amazon').length;
  console.log(`  ${amazonCount} of ${sortedCandidates.length} candidates are Amazon-validated`);
}
```

Replace the loop header `for (const item of lowCtrPages)` with `for (const item of sortedCandidates)`.

- [ ] **Step 3: Build grounding per candidate inside the loop**

After the existing `const { keyword, impressions, ctr, position } = item;` line, add:

```js
const indexEntry = lookupByKeyword(idx, keyword);
const ground = buildPromptGrounding(indexEntry, clusterMatesFor(idx, indexEntry, { limit: 6 }));
```

Replace the `rewriteMeta` call:

```js
const proposed = await rewriteMeta(currentTitle, currentMeta, keyword, position, impressions, ctr, ground);
```

Add `validation_source: ground?.validationTag ?? null` to the `result` object near the existing `applied: false`.

- [ ] **Step 4: Extend `rewriteMeta` signature + prompt**

Replace the function signature:

```js
async function rewriteMeta(currentTitle, currentMeta, keyword, position, impressions, ctr, ground) {
```

Inside the function, just before the `const message = await client.messages.create(...)` call, build optional grounding lines:

```js
const groundingLines = [];
if (ground?.validationTag === 'amazon') {
  const conv = ground.conversionShare != null
    ? ` (Amazon conversion share: ${(ground.conversionShare * 100).toFixed(1)}%)`
    : '';
  groundingLines.push(`This query is Amazon-validated — verified commercial demand${conv}.`);
} else if (ground?.validationTag === 'gsc_ga4') {
  groundingLines.push(`This query has GSC + GA4 conversion signal — proven to convert on this site.`);
}
if (ground?.clusterMateKeywords?.length) {
  groundingLines.push(`Cluster-mate queries this page should also surface for: ${ground.clusterMateKeywords.join(', ')}.`);
}
const groundingBlock = groundingLines.length ? `\n${groundingLines.join('\n')}\n` : '';
```

Inject `${groundingBlock}` into the prompt template right after the `CURRENT CTR: ...` line and before `Write an improved title...`.

- [ ] **Step 5: Stamp `validation_source` onto the A/B tracker baseline**

Find the section that writes to `meta-ab-tracker.json` (search for `meta-ab-tracker` in the file). Each pushed tracker entry should include the field:

```js
tracker.push({
  // ... existing fields ...
  validation_source: r.validation_source ?? null,
});
```

(`r.validation_source` was added to the result object in Step 3.)

- [ ] **Step 6: Run all tests**

Run: `npm test 2>&1 | tail -10`
Expected: PASS — full suite green (162+ tests).

- [ ] **Step 7: Commit**

```bash
git add agents/meta-optimizer/index.js
git commit -m "feat(meta-optimizer): keyword-index grounding + amazon-validated priority"
```

---

## Task 6: Push and open PR

- [ ] **Step 1: Verify clean branch**

```bash
git status && git log --oneline main..HEAD
```

Expected: clean tree; ~6 commits ahead of main.

- [ ] **Step 2: Push**

```bash
git push -u origin feature/meta-optimizer-keyword-index
```

- [ ] **Step 3: Open PR**

```bash
gh pr create --title "feat(meta-optimizer): keyword-index grounding + amazon-validated priority" --body "..."
```

PR body summarizes the changes and links to the spec.

---

## Self-Review Notes

- Spec coverage:
  - §1 sort ★-first → Task 2 + Task 5 step 2 ✓
  - §2 cluster-mate retrieval → Task 1 + Task 5 step 3 ✓
  - §3 extend rewriteMeta → Task 5 step 4 ✓
  - §4 stamp A/B tracker → Task 5 step 5 ✓
  - §5 stale-years untouched → no task; correctly out of scope ✓
- Placeholder scan: clean.
- Type consistency: helper names match across tasks (`sortByValidation`, `buildPromptGrounding`, `clusterMatesFor`, `loadIndex`, `lookupByKeyword`).
