# gsc-opportunity Keyword-Index Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Annotate the daily GSC opportunity report with `validation_source` from `data/keyword-index.json`, re-rank the unmapped section ★-first, and bias the calendar inbox push toward Amazon-validated rows.

**Architecture:** Introduce a small shared `lib/keyword-index/consumer.js` with four pure helpers (TDD). Refactor `agents/gsc-opportunity/index.js` to import them, rename the misleading `loadKeywordIndex` to `loadCoveredKeywords`, add a Source column to all three report tables, re-sort the unmapped section, and propagate `validation_source` into the inbox upserts and `latest.json`.

**Tech Stack:** Node.js (ESM), `node:test` runner with `node:assert/strict`, project-style imports (relative paths).

---

## File Structure

- **Create:** `lib/keyword-index/consumer.js` — four exported helpers (`loadIndex`, `lookupByKeyword`, `lookupByUrl`, `validationTag`).
- **Create:** `tests/lib/keyword-index/consumer.test.js` — unit tests for the four helpers.
- **Modify:** `agents/gsc-opportunity/index.js` — rename, annotate, re-sort, propagate.
- **Create:** `tests/agents/gsc-opportunity.test.js` — pure-function structure tests for the new annotate + re-sort logic.

The agent's `main()` orchestrator stays untested (live GSC fetch). All new logic is extracted into pure helpers that can be tested in isolation.

---

## Task 1: TDD `loadIndex()`

**Files:**
- Create: `lib/keyword-index/consumer.js`
- Create: `tests/lib/keyword-index/consumer.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/keyword-index/consumer.test.js` (creating the file):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadIndex, _resetCacheForTests } from '../../../lib/keyword-index/consumer.js';

test('loadIndex returns null when file missing', () => {
  _resetCacheForTests();
  const dir = mkdtempSync(join(tmpdir(), 'kwi-'));
  try {
    assert.equal(loadIndex(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadIndex parses a valid keyword-index.json', () => {
  _resetCacheForTests();
  const dir = mkdtempSync(join(tmpdir(), 'kwi-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'keyword-index.json'), JSON.stringify({
      built_at: '2026-04-27T00:00:00.000Z',
      keywords: { 'foo': { keyword: 'foo', slug: 'foo', cluster: 'soap', validation_source: 'amazon' } },
    }));
    const idx = loadIndex(dir);
    assert.equal(idx.keywords.foo.cluster, 'soap');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/lib/keyword-index/consumer.test.js`
Expected: FAIL — `Cannot find module '.../consumer.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/keyword-index/consumer.js`:

```js
/**
 * Consumer-side helpers for reading data/keyword-index.json.
 * All functions are pure; loadIndex caches the parsed file per process.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let cached = null;
let cachedRoot = null;

export function loadIndex(rootDir) {
  if (!rootDir) throw new Error('loadIndex requires rootDir');
  if (cached !== null && cachedRoot === rootDir) return cached;
  const path = join(rootDir, 'data', 'keyword-index.json');
  if (!existsSync(path)) {
    cached = null;
    cachedRoot = rootDir;
    return null;
  }
  cached = JSON.parse(readFileSync(path, 'utf8'));
  cachedRoot = rootDir;
  return cached;
}

// Test-only: clear the in-process cache.
export function _resetCacheForTests() {
  cached = null;
  cachedRoot = null;
}
```

Note: tests must call `_resetCacheForTests()` between scenarios that use different roots. Update the second test to import and call it before `loadIndex`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/lib/keyword-index/consumer.test.js`
Expected: PASS — 2 tests passing.

- [ ] **Step 5: Commit**

```bash
git add lib/keyword-index/consumer.js tests/lib/keyword-index/consumer.test.js
git commit -m "feat(keyword-index): consumer.loadIndex with file caching"
```

---

## Task 2: TDD `lookupByKeyword()`

**Files:**
- Modify: `lib/keyword-index/consumer.js`
- Modify: `tests/lib/keyword-index/consumer.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/keyword-index/consumer.test.js`:

```js
import { lookupByKeyword } from '../../../lib/keyword-index/consumer.js';

const fixture = {
  keywords: {
    'natural-deodorant': { keyword: 'natural deodorant', slug: 'natural-deodorant', validation_source: 'amazon' },
    'best-soap-for-tattoos': { keyword: 'best soap for tattoos', slug: 'best-soap-for-tattoos', validation_source: 'gsc_ga4' },
  },
};

test('lookupByKeyword exact slug match', () => {
  const e = lookupByKeyword(fixture, 'natural-deodorant');
  assert.equal(e?.slug, 'natural-deodorant');
});

test('lookupByKeyword normalized-slug match from raw keyword', () => {
  const e = lookupByKeyword(fixture, 'Natural Deodorant');
  assert.equal(e?.slug, 'natural-deodorant');
});

test('lookupByKeyword case-insensitive fallback', () => {
  const e = lookupByKeyword(fixture, 'BEST SOAP FOR TATTOOS!');
  assert.equal(e?.slug, 'best-soap-for-tattoos');
});

test('lookupByKeyword miss returns null', () => {
  assert.equal(lookupByKeyword(fixture, 'something we never see'), null);
});

test('lookupByKeyword null index returns null', () => {
  assert.equal(lookupByKeyword(null, 'foo'), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/lib/keyword-index/consumer.test.js`
Expected: FAIL — `lookupByKeyword is not a function`.

- [ ] **Step 3: Implement `lookupByKeyword`**

Append to `lib/keyword-index/consumer.js`:

```js
import { slug as toSlug } from './normalize.js';

export function lookupByKeyword(index, keyword) {
  if (!index?.keywords || !keyword) return null;
  const direct = index.keywords[keyword];
  if (direct) return direct;
  const slugKey = toSlug(keyword);
  return index.keywords[slugKey] || null;
}
```

`toSlug` already lowercases, strips punctuation, and collapses whitespace, which subsumes the case-insensitive fallback.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/lib/keyword-index/consumer.test.js`
Expected: PASS — 7 tests passing.

- [ ] **Step 5: Commit**

```bash
git add lib/keyword-index/consumer.js tests/lib/keyword-index/consumer.test.js
git commit -m "feat(keyword-index): consumer.lookupByKeyword with slug normalization"
```

---

## Task 3: TDD `lookupByUrl()`

**Files:**
- Modify: `lib/keyword-index/consumer.js`
- Modify: `tests/lib/keyword-index/consumer.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/keyword-index/consumer.test.js`:

```js
import { lookupByUrl } from '../../../lib/keyword-index/consumer.js';

const urlFixture = {
  keywords: {
    'natural-deodorant': {
      slug: 'natural-deodorant',
      gsc: { top_page: 'https://www.realskincare.com/blogs/news/best-natural-deodorant', position: 8 },
    },
    'orphan-no-gsc': {
      slug: 'orphan-no-gsc',
      gsc: null,
    },
  },
};

test('lookupByUrl matches gsc.top_page exactly', () => {
  const e = lookupByUrl(urlFixture, 'https://www.realskincare.com/blogs/news/best-natural-deodorant');
  assert.equal(e?.slug, 'natural-deodorant');
});

test('lookupByUrl miss returns null', () => {
  assert.equal(lookupByUrl(urlFixture, 'https://example.com/other'), null);
});

test('lookupByUrl skips entries with null gsc', () => {
  // Just confirms an entry with no gsc.top_page can never match.
  assert.equal(lookupByUrl(urlFixture, ''), null);
});

test('lookupByUrl null index returns null', () => {
  assert.equal(lookupByUrl(null, 'https://x'), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/lib/keyword-index/consumer.test.js`
Expected: FAIL — `lookupByUrl is not a function`.

- [ ] **Step 3: Implement `lookupByUrl`**

Append to `lib/keyword-index/consumer.js`:

```js
export function lookupByUrl(index, url) {
  if (!index?.keywords || !url) return null;
  for (const entry of Object.values(index.keywords)) {
    if (entry?.gsc?.top_page === url) return entry;
  }
  return null;
}
```

Linear scan is fine — keyword count is in the low thousands.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/lib/keyword-index/consumer.test.js`
Expected: PASS — 11 tests passing.

- [ ] **Step 5: Commit**

```bash
git add lib/keyword-index/consumer.js tests/lib/keyword-index/consumer.test.js
git commit -m "feat(keyword-index): consumer.lookupByUrl by gsc.top_page"
```

---

## Task 4: TDD `validationTag()`

**Files:**
- Modify: `lib/keyword-index/consumer.js`
- Modify: `tests/lib/keyword-index/consumer.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/keyword-index/consumer.test.js`:

```js
import { validationTag } from '../../../lib/keyword-index/consumer.js';

test('validationTag returns amazon for amazon-validated entry', () => {
  assert.equal(validationTag({ validation_source: 'amazon' }), 'amazon');
});

test('validationTag returns gsc_ga4 for gsc_ga4-validated entry', () => {
  assert.equal(validationTag({ validation_source: 'gsc_ga4' }), 'gsc_ga4');
});

test('validationTag returns null for null entry', () => {
  assert.equal(validationTag(null), null);
});

test('validationTag returns null for entry with no validation_source', () => {
  assert.equal(validationTag({ slug: 'x' }), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/lib/keyword-index/consumer.test.js`
Expected: FAIL — `validationTag is not a function`.

- [ ] **Step 3: Implement `validationTag`**

Append to `lib/keyword-index/consumer.js`:

```js
export function validationTag(entry) {
  if (!entry) return null;
  if (entry.validation_source === 'amazon') return 'amazon';
  if (entry.validation_source === 'gsc_ga4') return 'gsc_ga4';
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/lib/keyword-index/consumer.test.js`
Expected: PASS — 15 tests passing.

- [ ] **Step 5: Commit**

```bash
git add lib/keyword-index/consumer.js tests/lib/keyword-index/consumer.test.js
git commit -m "feat(keyword-index): consumer.validationTag accessor"
```

---

## Task 5: Rename `loadKeywordIndex` → `loadCoveredKeywords` in agent

**Files:**
- Modify: `agents/gsc-opportunity/index.js:62-80`

- [ ] **Step 1: Read the current function**

Run: `grep -n "loadKeywordIndex\|isMapped" agents/gsc-opportunity/index.js`
Expected: shows definitions at lines 62 and 82 and call sites at line 111 and inside `isMapped`.

- [ ] **Step 2: Rename the function and its call**

Edit `agents/gsc-opportunity/index.js`:
- Replace `function loadKeywordIndex()` with `function loadCoveredKeywords()`.
- Update the comment at the top of the function: `// Build a set of keywords already targeted by an existing brief or post.` stays accurate.
- Update the single call site `const index = loadKeywordIndex();` to `const covered = loadCoveredKeywords();`.
- Update `isMapped(r.keyword, index)` to `isMapped(r.keyword, covered)`.
- Inside `isMapped(keyword, index)`, rename the parameter to `covered` for clarity: `function isMapped(keyword, covered) { ... }`. Update internal references (`index.has` → `covered.has`, `for (const target of index)` → `for (const target of covered)`).

- [ ] **Step 3: Run existing tests + smoke**

Run: `node --test tests/**/*.test.js 2>&1 | tail -10`
Expected: PASS — no tests touch this function name today, so nothing breaks.

Run: `node -c agents/gsc-opportunity/index.js`
Expected: no syntax errors.

- [ ] **Step 4: Commit**

```bash
git add agents/gsc-opportunity/index.js
git commit -m "refactor(gsc-opportunity): rename loadKeywordIndex to loadCoveredKeywords"
```

---

## Task 6: TDD report annotation helpers + extract pure logic

**Files:**
- Modify: `agents/gsc-opportunity/index.js`
- Create: `tests/agents/gsc-opportunity.test.js`

The agent's `main()` mixes I/O with sort + tag logic. Extract two pure functions, test them, then call them from `main()`.

- [ ] **Step 1: Write the failing tests**

Create `tests/agents/gsc-opportunity.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotateRows, sortUnmapped } from '../../agents/gsc-opportunity/index.js';

const idx = {
  keywords: {
    'natural-deodorant':       { slug: 'natural-deodorant',       validation_source: 'amazon' },
    'best-soap-for-tattoos':   { slug: 'best-soap-for-tattoos',   validation_source: 'gsc_ga4' },
  },
};

test('annotateRows tags amazon, gsc_ga4, and untagged rows', () => {
  const rows = [
    { keyword: 'natural deodorant', impressions: 500 },
    { keyword: 'best soap for tattoos', impressions: 200 },
    { keyword: 'never seen before',     impressions: 100 },
  ];
  const out = annotateRows(rows, idx);
  assert.equal(out[0].validation_source, 'amazon');
  assert.equal(out[1].validation_source, 'gsc_ga4');
  assert.equal(out[2].validation_source, null);
});

test('annotateRows handles null index by tagging null on every row', () => {
  const rows = [{ keyword: 'foo', impressions: 1 }];
  const out = annotateRows(rows, null);
  assert.equal(out[0].validation_source, null);
});

test('sortUnmapped places amazon-validated rows first, by impressions desc', () => {
  const rows = [
    { keyword: 'q1', impressions: 100, validation_source: null },
    { keyword: 'q2', impressions: 200, validation_source: 'amazon' },
    { keyword: 'q3', impressions: 50,  validation_source: 'amazon' },
    { keyword: 'q4', impressions: 300, validation_source: 'gsc_ga4' },
  ];
  const sorted = sortUnmapped(rows);
  assert.deepEqual(sorted.map((r) => r.keyword), ['q2', 'q3', 'q4', 'q1']);
});

test('sortUnmapped is stable when impressions tie within the same band', () => {
  const rows = [
    { keyword: 'a', impressions: 100, validation_source: 'amazon' },
    { keyword: 'b', impressions: 100, validation_source: 'amazon' },
  ];
  const sorted = sortUnmapped(rows);
  assert.deepEqual(sorted.map((r) => r.keyword), ['a', 'b']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/agents/gsc-opportunity.test.js`
Expected: FAIL — `annotateRows is not exported` / `sortUnmapped is not exported`.

- [ ] **Step 3: Implement and export the helpers**

Edit `agents/gsc-opportunity/index.js`:

Add at the top, after existing imports:

```js
import { lookupByKeyword, validationTag } from '../../lib/keyword-index/consumer.js';
```

Add these exports above `async function main()`:

```js
export function annotateRows(rows, index) {
  return rows.map((r) => ({
    ...r,
    validation_source: validationTag(lookupByKeyword(index, r.keyword)),
  }));
}

export function sortUnmapped(rows) {
  const band = (r) => (r.validation_source === 'amazon' ? 0 : 1);
  return [...rows].sort((a, b) => {
    const db = band(a) - band(b);
    if (db !== 0) return db;
    return b.impressions - a.impressions;
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/agents/gsc-opportunity.test.js`
Expected: PASS — 4 tests passing.

- [ ] **Step 5: Commit**

```bash
git add agents/gsc-opportunity/index.js tests/agents/gsc-opportunity.test.js
git commit -m "feat(gsc-opportunity): add annotateRows + sortUnmapped helpers"
```

---

## Task 7: Wire annotation + re-rank into `main()`

**Files:**
- Modify: `agents/gsc-opportunity/index.js`

- [ ] **Step 1: Edit `main()` to use the new helpers**

In `main()`, after the GSC fetches and rejection filtering and before computing `unmapped`, load the index once:

```js
const idx = loadIndex(ROOT);
const lowCTRTagged = annotateRows(lowCTR, idx);
const page2Tagged = annotateRows(page2, idx);
```

Add the import at the top of the file (sibling import to consumer helpers, already added in Task 6):

```js
import { loadIndex } from '../../lib/keyword-index/consumer.js';
```

(consumer.js already exports `loadIndex` — extend the existing import statement instead of adding a new one).

After the existing `unmapped` computation, replace the slice with:

```js
const unmappedTagged = annotateRows(unmapped, idx);
const unmappedSorted = sortUnmapped(unmappedTagged);
```

Replace downstream references to `unmapped` with `unmappedSorted`, `lowCTR` with `lowCTRTagged`, and `page2` with `page2Tagged` everywhere they're used to render the report or `latest.json`.

- [ ] **Step 2: Add the Source column to all three tables**

Update the three table-building blocks. For each:

Replace the header line:
```js
lines.push('| Query | Impressions | Clicks | CTR | Position |');
lines.push('|-------|-------------|--------|-----|----------|');
```

With (low-CTR + page-2 tables):
```js
lines.push('| Query | Impressions | Clicks | CTR | Position | Source |');
lines.push('|-------|-------------|--------|-----|----------|--------|');
```

For the unmapped table (which doesn't have Clicks/CTR columns):
```js
lines.push('| Query | Impressions | Position | Source |');
lines.push('|-------|-------------|----------|--------|');
```

Add a tag-symbol helper near the top of the file:

```js
function sourceSymbol(tag) {
  if (tag === 'amazon') return '★';
  if (tag === 'gsc_ga4') return '✓';
  return '—';
}
```

Update the row-building lines for low-CTR and page-2 to include the new column:

```js
lines.push(`| ${r.keyword} | ${r.impressions} | ${r.clicks} | ${(r.ctr * 100).toFixed(1)}% | ${r.position.toFixed(1)} | ${sourceSymbol(r.validation_source)} |`);
```

Unmapped row:

```js
lines.push(`| ${r.keyword} | ${r.impressions} | ${r.position.toFixed(1)} | ${sourceSymbol(r.validation_source)} |`);
```

- [ ] **Step 3: Update `latest.json` to use tagged arrays**

Replace:
```js
writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify({
  generated_at: new Date().toISOString(),
  low_ctr: lowCTR.slice(0, 20),
  page_2: page2.slice(0, 20),
  unmapped,
}, null, 2));
```

With:
```js
writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify({
  generated_at: new Date().toISOString(),
  low_ctr: lowCTRTagged.slice(0, 20),
  page_2: page2Tagged.slice(0, 20),
  unmapped: unmappedSorted,
}, null, 2));
```

- [ ] **Step 4: Update calendar-inbox upserts to include `validation_source`**

In the inbox loop, change the iteration source from `unmapped` to `unmappedSorted` and add the field:

```js
for (const r of unmappedSorted.slice(0, 15)) {
  const slug = r.keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (existingSlugs.has(slug)) continue;
  upsertItem({
    slug,
    keyword: r.keyword,
    title: '',
    source: 'gsc_opportunity',
    status: 'review',
    volume: null,
    kd: null,
    impressions: r.impressions,
    publish_date: null,
    added_at: new Date().toISOString(),
    validation_source: r.validation_source,
  });
  inboxAdded++;
}
```

- [ ] **Step 5: Run all tests**

Run: `node --test tests/**/*.test.js 2>&1 | tail -15`
Expected: PASS — no regressions.

- [ ] **Step 6: Smoke run**

Run: `node -c agents/gsc-opportunity/index.js`
Expected: no syntax errors.

(Live GSC fetch is gated by env, can't smoke-run end-to-end without credentials. The existing `latest.json` shape is verified via the structure tests.)

- [ ] **Step 7: Commit**

```bash
git add agents/gsc-opportunity/index.js
git commit -m "feat(gsc-opportunity): annotate report rows + re-rank unmapped via keyword-index"
```

---

## Task 8: Push branch + open PR

**Files:** None (git operations).

- [ ] **Step 1: Confirm branch is clean and complete**

Run: `git status && git log --oneline main..HEAD`
Expected: working tree clean; 5–7 commits ahead of main.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin feature/gsc-opportunity-keyword-index
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --title "feat(gsc-opportunity): keyword-index annotation + re-rank" --body "$(cat <<'EOF'
## Summary
- Adds `lib/keyword-index/consumer.js` with four reusable helpers (`loadIndex`, `lookupByKeyword`, `lookupByUrl`, `validationTag`) for the broader consumer-wiring rollout.
- Renames the misleading `loadKeywordIndex` → `loadCoveredKeywords` in `agents/gsc-opportunity/index.js`.
- Annotates every row in the daily report with a Source column (★ Amazon / ✓ GSC / —).
- Re-ranks the unmapped section ★-first to surface Amazon-validated content candidates at the top.
- Biases the calendar inbox push toward Amazon-validated rows automatically (unmapped is sorted first).
- Adds `validation_source` to `latest.json` rows for downstream consumers.

Spec: `docs/superpowers/specs/2026-04-27-gsc-opportunity-keyword-index-wiring-design.md`

This is the first of 9 consumer-wiring PRs (overview: PR #160).

## Test plan
- [x] `tests/lib/keyword-index/consumer.test.js` — 15 unit tests for the four helpers
- [x] `tests/agents/gsc-opportunity.test.js` — 4 structure tests for annotate + re-sort
- [ ] Verify next 6:30 AM PT cron run produces an annotated report
- [ ] Spot-check `latest.json` for `validation_source` field on all rows

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

- [ ] **Step 4: Mark plan task complete in MEMORY/todo tracker.**

---

## Self-Review Notes

- Spec coverage:
  - §1 rename → Task 5 ✓
  - §2 consumer.js helpers → Tasks 1–4 ✓
  - §3 report annotation + re-rank → Tasks 6–7 ✓
  - §4 inbox push → Task 7 ✓
  - §5 latest.json → Task 7 ✓
  - §Tests → consumer + agent tests in Tasks 1–6 ✓
- Placeholder scan: clean. No TBD/TODO/etc.
- Type consistency: helper names match across tasks (`loadIndex`, `lookupByKeyword`, `lookupByUrl`, `validationTag`, `annotateRows`, `sortUnmapped`).
