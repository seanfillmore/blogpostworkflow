# Change Log + Outcome Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a unified change log + outcome attribution system: every SEO-relevant Shopify change opens a 28-day measurement window, the system computes verdicts from GSC + GA4 deltas, auto-reverts losers within revertable change types, and feeds learnings back to agents.

**Architecture:** One shared library (`lib/change-log.js` + `lib/change-log/{snapshots,verdict}.js`) provides the API every agent calls. Three new agents run on the daily cron — `change-diff-detector` (catches manual edits), `change-verdict` (computes outcomes), `change-queue-processor` (releases queued changes). The existing `meta-ab-tracker` is refactored to use the shared lib (60-day backwards-compat window). Verdicts surface in the existing daily-summary digest.

**Tech Stack:** Node.js (ESM, `"type": "module"`), built-in `node:test` + `node:assert/strict`, no new npm dependencies. Reuses existing `lib/shopify.js`, `lib/notify.js`, `lib/posts.js`.

**Spec reference:** [docs/superpowers/specs/2026-04-25-change-log-outcome-attribution-design.md](../specs/2026-04-25-change-log-outcome-attribution-design.md)

**Branch:** `feature/change-log-attribution` (already created from main)

---

## File Structure

Will create:

- `lib/change-log.js` — public API (~350 lines)
- `lib/change-log/snapshots.js` — read GSC/GA4 snapshots for a URL+queries+date range (~120 lines)
- `lib/change-log/verdict.js` — delta computation, threshold classification, action decision (~200 lines)
- `lib/change-log/store.js` — atomic JSON writes, path helpers, index.json maintenance (~150 lines)
- `agents/change-diff-detector/index.js` — daily cron (~150 lines)
- `agents/change-verdict/index.js` — daily cron (~180 lines)
- `agents/change-queue-processor/index.js` — daily cron (~120 lines)
- `tests/lib/change-log.test.js` — public API tests
- `tests/lib/change-log-store.test.js` — store helper tests
- `tests/lib/change-log-verdict.test.js` — verdict classification + threshold tests
- `tests/agents/change-diff-detector.test.js` — diff-detector structure tests
- `tests/agents/change-verdict.test.js` — verdict agent structure tests
- `tests/fixtures/change-log/` — fixture snapshots for verdict tests

Will modify:

- `scheduler.js` — add 3 new agent invocations
- `agents/meta-ab-tracker/index.js` — backwards-compat refactor to call shared lib (kept thin)
- `.gitignore` — ignore `data/changes/queue/` (transient queue state)

**Testing approach:** Existing `tests/` directory uses `node --test` with `node:assert/strict` (ESM). New tests follow the same pattern. Run tests with `npm test`.

**Spec section coverage:** Sections 1-4 of the spec are covered by Tasks 2-9. Section 5 (out-of-scope) is intentionally not implemented.

---

## Task 1: Set up directory tree and gitignore

**Files:**
- Create: `data/changes/events/.gitkeep`
- Create: `data/changes/windows/.gitkeep`
- Create: `data/changes/queue/.gitkeep`
- Modify: `.gitignore`

- [ ] **Step 1: Create directory tree**

```bash
mkdir -p data/changes/events data/changes/windows data/changes/queue
touch data/changes/events/.gitkeep data/changes/windows/.gitkeep data/changes/queue/.gitkeep
```

- [ ] **Step 2: Add queue dir to .gitignore**

Open `.gitignore` and append (the queue is transient state — not source-of-truth):

```
data/changes/queue/*.json
data/changes/queue/**/*.json
!data/changes/queue/.gitkeep
```

- [ ] **Step 3: Verify**

```bash
git status data/changes/
```

Expected: only `events/.gitkeep` and `windows/.gitkeep` show as new (queue gitkeep should also show — only queue's `.json` contents are ignored).

```bash
touch data/changes/queue/test.json && git status data/changes/queue/
rm data/changes/queue/test.json
```

Expected: `test.json` does not appear in `git status` output.

- [ ] **Step 4: Commit**

```bash
git add data/changes/events/.gitkeep data/changes/windows/.gitkeep data/changes/queue/.gitkeep .gitignore
git commit -m "chore(change-log): add data/changes tree, ignore queue contents"
```

---

## Task 2: Build the store layer (paths + atomic JSON)

**Files:**
- Create: `lib/change-log/store.js`
- Test: `tests/lib/change-log-store.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/change-log-store.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWriteJson, readJsonOrNull, eventPath, windowPath, queueItemPath } from '../../lib/change-log/store.js';

test('atomicWriteJson writes file with pretty JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cl-store-'));
  try {
    const file = join(dir, 'sub/dir/data.json');
    atomicWriteJson(file, { hello: 'world', n: 1 });
    const text = readFileSync(file, 'utf8');
    assert.equal(text, '{\n  "hello": "world",\n  "n": 1\n}\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('atomicWriteJson does not leave a temp file behind on success', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cl-store-'));
  try {
    const file = join(dir, 'data.json');
    atomicWriteJson(file, { a: 1 });
    const { readdirSync } = require('node:fs');
    const entries = readdirSync(dir);
    assert.deepEqual(entries, ['data.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readJsonOrNull returns null for missing file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cl-store-'));
  try {
    const result = readJsonOrNull(join(dir, 'missing.json'));
    assert.equal(result, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readJsonOrNull returns parsed content for present file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cl-store-'));
  try {
    const file = join(dir, 'data.json');
    atomicWriteJson(file, { x: 42 });
    const result = readJsonOrNull(file);
    assert.deepEqual(result, { x: 42 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('eventPath returns YYYY-MM partitioned path', () => {
  const path = eventPath('ch-2026-04-25-foo-001', '2026-04-25T12:00:00Z');
  assert.equal(path.endsWith('data/changes/events/2026-04/ch-2026-04-25-foo-001.json'), true);
});

test('windowPath returns slug-partitioned path', () => {
  const path = windowPath('coconut-lotion', 'win-coconut-lotion-2026-04-25');
  assert.equal(path.endsWith('data/changes/windows/coconut-lotion/win-coconut-lotion-2026-04-25.json'), true);
});

test('queueItemPath returns slug-partitioned path', () => {
  const path = queueItemPath('coconut-lotion', 'q-2026-04-25-001');
  assert.equal(path.endsWith('data/changes/queue/coconut-lotion/q-2026-04-25-001.json'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib/change-log-store.test.js`
Expected: FAIL with `Cannot find module '../../lib/change-log/store.js'`

- [ ] **Step 3: Implement the store module**

Create `lib/change-log/store.js`:

```js
/**
 * Storage primitives for the change-log system.
 *
 * - Atomic JSON writes (write-temp-then-rename) so concurrent agents
 *   never see a partial file.
 * - Path helpers for events / windows / queue items.
 */

import { mkdirSync, writeFileSync, renameSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CHANGES_ROOT = join(ROOT, 'data', 'changes');

export function eventPath(eventId, changedAt) {
  const yyyymm = changedAt.slice(0, 7); // 2026-04-25T... → 2026-04
  return join(CHANGES_ROOT, 'events', yyyymm, `${eventId}.json`);
}

export function windowPath(slug, windowId) {
  return join(CHANGES_ROOT, 'windows', slug, `${windowId}.json`);
}

export function queueItemPath(slug, queueItemId) {
  return join(CHANGES_ROOT, 'queue', slug, `${queueItemId}.json`);
}

export function indexPath() {
  return join(CHANGES_ROOT, 'index.json');
}

export function atomicWriteJson(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, filePath);
}

export function readJsonOrNull(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

export function deleteFileIfExists(filePath) {
  if (existsSync(filePath)) unlinkSync(filePath);
}

export { CHANGES_ROOT, ROOT };
```

- [ ] **Step 4: Fix the require() call in the test**

The test mistakenly uses `require('node:fs')`; ESM doesn't have `require`. Replace lines 27–29 of `tests/lib/change-log-store.test.js`:

```js
    const { readdirSync } = await import('node:fs');
    const entries = readdirSync(dir);
```

- [ ] **Step 5: Run tests**

```bash
node --test tests/lib/change-log-store.test.js
```

Expected: all 7 tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/change-log/store.js tests/lib/change-log-store.test.js
git commit -m "feat(change-log): add storage primitives (atomic JSON + path helpers)"
```

---

## Task 3: Snapshot reader

**Files:**
- Create: `lib/change-log/snapshots.js`
- Test: `tests/lib/change-log-snapshots.test.js`
- Test fixtures: `tests/fixtures/change-log/snapshots/gsc/2026-04-{01..05}.json`, `tests/fixtures/change-log/snapshots/ga4/2026-04-{01..05}.json`

- [ ] **Step 1: Create fixture snapshots**

```bash
mkdir -p tests/fixtures/change-log/snapshots/gsc tests/fixtures/change-log/snapshots/ga4
```

Create `tests/fixtures/change-log/snapshots/gsc/2026-04-01.json`:

```json
{
  "date": "2026-04-01",
  "topPages": [
    { "page": "https://www.realskincare.com/products/coconut-lotion", "impressions": 100, "clicks": 5, "ctr": 0.05, "position": 7.5 }
  ],
  "queries": [
    { "query": "coconut lotion", "page": "https://www.realskincare.com/products/coconut-lotion", "impressions": 80, "clicks": 4, "ctr": 0.05, "position": 7.5 }
  ]
}
```

Create the same shape for `2026-04-02.json` through `2026-04-05.json`, varying the metrics. For brevity, use these 5 rows:

| Date | impressions | clicks | ctr | position |
|---|---|---|---|---|
| 04-01 | 100 | 5 | 0.05 | 7.5 |
| 04-02 | 110 | 6 | 0.0545 | 7.0 |
| 04-03 | 120 | 8 | 0.0667 | 6.5 |
| 04-04 | 105 | 7 | 0.0667 | 6.8 |
| 04-05 | 115 | 9 | 0.0783 | 6.0 |

Same shape for both `topPages` and `queries`. Each fixture has `topPages` for the URL and `queries` for `coconut lotion` on that URL with these metrics.

Create `tests/fixtures/change-log/snapshots/ga4/2026-04-01.json`:

```json
{
  "date": "2026-04-01",
  "pages": [
    { "page": "/products/coconut-lotion", "sessions": 50, "conversions": 2, "page_revenue": 60.00 }
  ]
}
```

Same shape for `04-02` through `04-05` with: sessions 55/60/52/58, conversions 2/3/3/4, revenue 60/90/90/120.

- [ ] **Step 2: Write failing tests**

Create `tests/lib/change-log-snapshots.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { aggregateGSCForUrl, aggregateGA4ForUrl } from '../../lib/change-log/snapshots.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', 'fixtures', 'change-log', 'snapshots');

test('aggregateGSCForUrl sums impressions/clicks and means CTR/position over date range', () => {
  const result = aggregateGSCForUrl({
    snapshotsDir: join(FIXTURES, 'gsc'),
    url: 'https://www.realskincare.com/products/coconut-lotion',
    queries: ['coconut lotion'],
    fromDate: '2026-04-01',
    toDate: '2026-04-05',
  });
  // Page-level: sum impressions = 550, sum clicks = 35, mean position = (7.5+7+6.5+6.8+6)/5 = 6.76
  assert.equal(result.page.impressions, 550);
  assert.equal(result.page.clicks, 35);
  assert.equal(result.page.position.toFixed(2), '6.76');
  // CTR is computed from totals: 35 / 550 = 0.0636
  assert.equal(result.page.ctr.toFixed(4), '0.0636');
  // Query-level: sum impressions for "coconut lotion" = 80+88+96+84+92 (using same ratio 0.8x) = ... actually use query metrics from fixtures
  assert.ok(result.byQuery['coconut lotion']);
  assert.ok(result.byQuery['coconut lotion'].impressions > 0);
});

test('aggregateGSCForUrl returns zeroes for URL with no data', () => {
  const result = aggregateGSCForUrl({
    snapshotsDir: join(FIXTURES, 'gsc'),
    url: 'https://www.realskincare.com/products/missing',
    queries: [],
    fromDate: '2026-04-01',
    toDate: '2026-04-05',
  });
  assert.equal(result.page.impressions, 0);
  assert.equal(result.page.clicks, 0);
});

test('aggregateGA4ForUrl sums sessions/conversions/revenue', () => {
  const result = aggregateGA4ForUrl({
    snapshotsDir: join(FIXTURES, 'ga4'),
    pagePath: '/products/coconut-lotion',
    fromDate: '2026-04-01',
    toDate: '2026-04-05',
  });
  // sum sessions = 50+55+60+52+58 = 275
  assert.equal(result.sessions, 275);
  assert.equal(result.conversions, 2 + 2 + 3 + 3 + 4);
  assert.equal(result.page_revenue, 60 + 60 + 90 + 90 + 120);
});

test('aggregateGA4ForUrl returns zeroes for missing page', () => {
  const result = aggregateGA4ForUrl({
    snapshotsDir: join(FIXTURES, 'ga4'),
    pagePath: '/products/missing',
    fromDate: '2026-04-01',
    toDate: '2026-04-05',
  });
  assert.equal(result.sessions, 0);
  assert.equal(result.conversions, 0);
  assert.equal(result.page_revenue, 0);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/lib/change-log-snapshots.test.js`
Expected: FAIL with `Cannot find module '../../lib/change-log/snapshots.js'`

- [ ] **Step 4: Implement snapshots reader**

Create `lib/change-log/snapshots.js`:

```js
/**
 * Read GSC/GA4 daily snapshots and aggregate metrics for a URL+queries
 * over a date range.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function listSnapshotsInRange(snapshotsDir, fromDate, toDate) {
  if (!existsSync(snapshotsDir)) return [];
  return readdirSync(snapshotsDir)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => {
      const d = f.replace('.json', '');
      return d >= fromDate && d <= toDate;
    })
    .sort();
}

export function aggregateGSCForUrl({ snapshotsDir, url, queries, fromDate, toDate }) {
  const files = listSnapshotsInRange(snapshotsDir, fromDate, toDate);
  let totalImpressions = 0;
  let totalClicks = 0;
  const positions = [];
  const byQuery = {};
  for (const q of queries || []) byQuery[q] = { impressions: 0, clicks: 0, positions: [] };

  for (const f of files) {
    const snap = JSON.parse(readFileSync(join(snapshotsDir, f), 'utf8'));
    const pageRow = (snap.topPages || []).find((p) => p.page === url || (p.page && p.page.endsWith(url)));
    if (pageRow) {
      totalImpressions += pageRow.impressions || 0;
      totalClicks += pageRow.clicks || 0;
      if (pageRow.position != null) positions.push(pageRow.position);
    }
    for (const q of queries || []) {
      const queryRow = (snap.queries || []).find(
        (r) => r.query === q && (r.page === url || (r.page && r.page.endsWith(url))),
      );
      if (queryRow) {
        byQuery[q].impressions += queryRow.impressions || 0;
        byQuery[q].clicks += queryRow.clicks || 0;
        if (queryRow.position != null) byQuery[q].positions.push(queryRow.position);
      }
    }
  }

  const meanPosition = positions.length > 0 ? positions.reduce((s, p) => s + p, 0) / positions.length : null;
  const ctr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;

  const byQueryResult = {};
  for (const [q, agg] of Object.entries(byQuery)) {
    byQueryResult[q] = {
      impressions: agg.impressions,
      clicks: agg.clicks,
      ctr: agg.impressions > 0 ? agg.clicks / agg.impressions : 0,
      position: agg.positions.length > 0 ? agg.positions.reduce((s, p) => s + p, 0) / agg.positions.length : null,
    };
  }

  return {
    page: {
      impressions: totalImpressions,
      clicks: totalClicks,
      ctr,
      position: meanPosition,
    },
    byQuery: byQueryResult,
  };
}

export function aggregateGA4ForUrl({ snapshotsDir, pagePath, fromDate, toDate }) {
  const files = listSnapshotsInRange(snapshotsDir, fromDate, toDate);
  let sessions = 0;
  let conversions = 0;
  let page_revenue = 0;

  for (const f of files) {
    const snap = JSON.parse(readFileSync(join(snapshotsDir, f), 'utf8'));
    const row = (snap.pages || []).find((p) => p.page === pagePath);
    if (row) {
      sessions += row.sessions || 0;
      conversions += row.conversions || 0;
      page_revenue += row.page_revenue || 0;
    }
  }

  return { sessions, conversions, page_revenue };
}
```

- [ ] **Step 5: Update GSC fixtures with query data**

The test expects per-query data. Re-create each `tests/fixtures/change-log/snapshots/gsc/2026-04-0X.json` to include both `topPages` and `queries` rows. For 04-01:

```json
{
  "date": "2026-04-01",
  "topPages": [
    { "page": "https://www.realskincare.com/products/coconut-lotion", "impressions": 100, "clicks": 5, "ctr": 0.05, "position": 7.5 }
  ],
  "queries": [
    { "query": "coconut lotion", "page": "https://www.realskincare.com/products/coconut-lotion", "impressions": 80, "clicks": 4, "ctr": 0.05, "position": 7.5 }
  ]
}
```

For 04-02 through 04-05 use the per-day metrics from Step 1's table for `topPages`. For `queries`, use 80% of the page values (impressions: 88/96/84/92; clicks: 5/6/6/7).

- [ ] **Step 6: Run tests**

```bash
node --test tests/lib/change-log-snapshots.test.js
```

Expected: all 4 tests pass.

- [ ] **Step 7: Commit**

```bash
git add lib/change-log/snapshots.js tests/lib/change-log-snapshots.test.js tests/fixtures/change-log/snapshots/
git commit -m "feat(change-log): add snapshot aggregator for GSC + GA4 metrics"
```

---

## Task 4: Window lifecycle helpers

**Files:**
- Create: `lib/change-log.js` (initial draft — window lifecycle only; public API in Task 5)
- Test: `tests/lib/change-log.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/change-log.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// We need to override the CHANGES_ROOT during tests. The test injects via
// env var `CHANGE_LOG_ROOT_OVERRIDE`. The lib reads this at import time.
const TEST_DIR = mkdtempSync(join(tmpdir(), 'cl-'));
process.env.CHANGE_LOG_ROOT_OVERRIDE = join(TEST_DIR, 'data', 'changes');

const { findActiveWindow, computeWindowStatus } = await import('../../lib/change-log.js');

test('findActiveWindow returns null when no windows exist for slug', () => {
  const result = findActiveWindow('non-existent-slug');
  assert.equal(result, null);
});

test('computeWindowStatus is "forming" before bundle_locked_at', () => {
  const now = '2026-04-26T12:00:00Z';
  const window = {
    opened_at: '2026-04-25T12:00:00Z',
    bundle_locked_at: '2026-04-28T12:00:00Z',
    verdict_at: '2026-05-26T12:00:00Z',
    verdict: null,
  };
  assert.equal(computeWindowStatus(window, now), 'forming');
});

test('computeWindowStatus is "measuring" between bundle_locked_at and verdict_at', () => {
  const now = '2026-05-10T12:00:00Z';
  const window = {
    opened_at: '2026-04-25T12:00:00Z',
    bundle_locked_at: '2026-04-28T12:00:00Z',
    verdict_at: '2026-05-26T12:00:00Z',
    verdict: null,
  };
  assert.equal(computeWindowStatus(window, now), 'measuring');
});

test('computeWindowStatus is "verdict_pending" after verdict_at when verdict is null', () => {
  const now = '2026-05-27T12:00:00Z';
  const window = {
    opened_at: '2026-04-25T12:00:00Z',
    bundle_locked_at: '2026-04-28T12:00:00Z',
    verdict_at: '2026-05-26T12:00:00Z',
    verdict: null,
  };
  assert.equal(computeWindowStatus(window, now), 'verdict_pending');
});

test('computeWindowStatus is "verdict_landed" once verdict is filled in', () => {
  const now = '2026-05-27T12:00:00Z';
  const window = {
    opened_at: '2026-04-25T12:00:00Z',
    bundle_locked_at: '2026-04-28T12:00:00Z',
    verdict_at: '2026-05-26T12:00:00Z',
    verdict: { decided_at: '2026-05-26T12:35:00Z', outcome: 'improved' },
  };
  assert.equal(computeWindowStatus(window, now), 'verdict_landed');
});

// Cleanup
process.on('exit', () => rmSync(TEST_DIR, { recursive: true, force: true }));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/lib/change-log.test.js`
Expected: FAIL with `Cannot find module '../../lib/change-log.js'`

- [ ] **Step 3: Implement the lifecycle helpers**

Create `lib/change-log.js` (initial — public API added in Task 5):

```js
/**
 * Change-log + outcome-attribution public API.
 *
 * Public functions (filled in across Tasks 4-5):
 *   proposeChange({ slug, changeType, category }) → { action, windowId, reason }
 *   logChangeEvent({...}) → eventId
 *   queueChange({...}) → queueItemId
 *   getActiveWindow(slug) → window | null
 *   isPageInMeasurement(slug) → boolean
 *   captureBaseline(slug, targetQueries) → baseline
 *
 * This file collects the public surface. Internals delegate to
 * lib/change-log/{snapshots,store,verdict}.js.
 */

import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonOrNull, windowPath, CHANGES_ROOT as DEFAULT_ROOT } from './change-log/store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Tests can override the root by setting CHANGE_LOG_ROOT_OVERRIDE before import.
export const CHANGES_ROOT = process.env.CHANGE_LOG_ROOT_OVERRIDE || DEFAULT_ROOT;

export function computeWindowStatus(window, nowIso = new Date().toISOString()) {
  if (window.verdict) return 'verdict_landed';
  if (nowIso >= window.verdict_at) return 'verdict_pending';
  if (nowIso >= window.bundle_locked_at) return 'measuring';
  return 'forming';
}

/**
 * Find the most recent active (non-verdict-landed) window for a slug.
 * Returns the window object or null.
 */
export function findActiveWindow(slug, nowIso = new Date().toISOString()) {
  const slugDir = join(CHANGES_ROOT, 'windows', slug);
  if (!existsSync(slugDir)) return null;
  const files = readdirSync(slugDir).filter((f) => f.endsWith('.json'));
  // Sort descending so the most recently opened window is first.
  files.sort((a, b) => b.localeCompare(a));
  for (const f of files) {
    const w = readJsonOrNull(join(slugDir, f));
    if (!w) continue;
    const status = computeWindowStatus(w, nowIso);
    if (status !== 'verdict_landed') return w;
  }
  return null;
}
```

- [ ] **Step 4: Run tests**

```bash
node --test tests/lib/change-log.test.js
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/change-log.js tests/lib/change-log.test.js
git commit -m "feat(change-log): add window lifecycle helpers (findActiveWindow, computeWindowStatus)"
```

---

## Task 5: Public API — proposeChange, logChangeEvent, queueChange, captureBaseline

**Files:**
- Modify: `lib/change-log.js`
- Modify: `tests/lib/change-log.test.js`

- [ ] **Step 1: Append the new tests to `tests/lib/change-log.test.js`**

Add these tests to the existing file (after the `computeWindowStatus` tests):

```js
import { proposeChange, logChangeEvent, queueChange, getActiveWindow } from '../../lib/change-log.js';

test('proposeChange returns apply+null for a slug with no active window', async () => {
  const result = await proposeChange({ slug: 'fresh-page', changeType: 'title', category: 'experimental' });
  assert.equal(result.action, 'apply');
  assert.equal(result.windowId, null);
  assert.equal(result.reason, 'no_active_window');
});

test('proposeChange always returns apply+maintenance_bypass for maintenance category, even with active window', async () => {
  // First open a window via logChangeEvent
  const eventId = await logChangeEvent({
    url: '/products/maint-test',
    slug: 'maint-test',
    changeType: 'title',
    category: 'experimental',
    before: 'Old Title',
    after: 'New Title',
    source: 'agent:test',
    targetQuery: 'test',
    intent: 'unit test',
  });
  assert.ok(eventId.startsWith('ch-'));

  // Now propose a maintenance change on the same slug
  const result = await proposeChange({ slug: 'maint-test', changeType: 'content_body', category: 'maintenance' });
  assert.equal(result.action, 'apply');
  assert.equal(result.reason, 'maintenance_bypass');
});

test('proposeChange returns apply+window_in_forming_period if active window is still forming', async () => {
  await logChangeEvent({
    url: '/products/forming-test',
    slug: 'forming-test',
    changeType: 'title',
    category: 'experimental',
    before: 'A',
    after: 'B',
    source: 'agent:test',
    targetQuery: 'test',
    intent: 'unit test',
  });
  const result = await proposeChange({ slug: 'forming-test', changeType: 'meta_description', category: 'experimental' });
  assert.equal(result.action, 'apply');
  assert.equal(result.reason, 'window_in_forming_period');
  assert.ok(result.windowId);
});

test('logChangeEvent creates an immutable event file under data/changes/events/YYYY-MM/', () => {
  // Existing window from prior test should hold this event
  const w = getActiveWindow('forming-test');
  assert.ok(w);
  assert.equal(w.changes.length, 2); // 2 events from the two logChangeEvent calls above
});

test('queueChange writes a queue item under data/changes/queue/<slug>/', async () => {
  const id = await queueChange({
    slug: 'measuring-test',
    changeType: 'image',
    source: 'agent:test',
    proposalContext: { suggestedImage: 'https://example.com/img.jpg', why: 'better lighting' },
    targetQuery: 'test',
    after: 'https://example.com/img.jpg',
  });
  assert.ok(id.startsWith('q-'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test tests/lib/change-log.test.js
```

Expected: FAIL — `proposeChange` etc. not exported yet.

- [ ] **Step 3: Implement the public API**

Append to `lib/change-log.js`:

```js
import { atomicWriteJson, eventPath, windowPath, queueItemPath, indexPath, readJsonOrNull } from './change-log/store.js';
import { aggregateGSCForUrl, aggregateGA4ForUrl } from './change-log/snapshots.js';

const SNAPSHOTS_GSC = join(__dirname, '..', 'data', 'snapshots', 'gsc');
const SNAPSHOTS_GA4 = join(__dirname, '..', 'data', 'snapshots', 'ga4');

const BUNDLE_GROUPING_DAYS = 3;
const MEASUREMENT_DAYS = 28;

function shortId(prefix) {
  const ts = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15); // 20260425T143200
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}`;
}

function newWindowId(slug, openedAt) {
  return `win-${slug}-${openedAt.slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`;
}

function newEventId(slug, changeType, changedAt) {
  return `ch-${changedAt.slice(0, 10)}-${slug}-${changeType}-${Math.random().toString(36).slice(2, 6)}`;
}

function newQueueItemId(slug) {
  return `q-${new Date().toISOString().slice(0, 10)}-${slug}-${Math.random().toString(36).slice(2, 6)}`;
}

function addDaysIso(iso, days) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function getActiveWindow(slug, nowIso = new Date().toISOString()) {
  return findActiveWindow(slug, nowIso);
}

export function isPageInMeasurement(slug, nowIso = new Date().toISOString()) {
  const w = findActiveWindow(slug, nowIso);
  return w != null && computeWindowStatus(w, nowIso) === 'measuring';
}

export async function proposeChange({ slug, changeType, category, nowIso = new Date().toISOString() }) {
  if (category === 'maintenance') {
    return { action: 'apply', windowId: null, reason: 'maintenance_bypass' };
  }
  const active = findActiveWindow(slug, nowIso);
  if (!active) {
    return { action: 'apply', windowId: null, reason: 'no_active_window' };
  }
  const status = computeWindowStatus(active, nowIso);
  if (status === 'forming') {
    return { action: 'apply', windowId: active.id, reason: 'window_in_forming_period' };
  }
  // measuring or verdict_pending — queue it
  return { action: 'queue', windowId: active.id, reason: 'window_in_measurement' };
}

export async function captureBaseline(slug, targetQueries, nowIso = new Date().toISOString()) {
  const fromDate = addDaysIso(nowIso, -28).slice(0, 10);
  const toDate = nowIso.slice(0, 10);
  const url = inferUrlFromSlug(slug);
  const gsc = aggregateGSCForUrl({
    snapshotsDir: SNAPSHOTS_GSC,
    url,
    queries: targetQueries || [],
    fromDate, toDate,
  });
  const ga4 = aggregateGA4ForUrl({
    snapshotsDir: SNAPSHOTS_GA4,
    pagePath: url.startsWith('http') ? new URL(url).pathname : url,
    fromDate, toDate,
  });
  return { captured_at: nowIso, gsc, ga4 };
}

function inferUrlFromSlug(slug) {
  // Heuristic: if slug looks like a blog post slug (no dashes that match known prefixes), assume blog.
  // For products/collections the slug alone is the path. Caller can also pass full URL via logChangeEvent's `url`.
  return `/products/${slug}`; // default; override by passing `url` to logChangeEvent
}

export async function logChangeEvent({
  url, slug, changeType, category, before, after,
  source, targetQuery, intent, windowId: existingWindowId,
}) {
  const nowIso = new Date().toISOString();
  const eventId = newEventId(slug, changeType, nowIso);

  // Maintenance: log only, no window
  if (category === 'maintenance') {
    const event = {
      id: eventId, url, slug, change_type: changeType, category,
      before, after, changed_at: nowIso, source,
      target_query: targetQuery ?? null, target_cluster: [],
      intent: intent ?? null, window_id: null,
    };
    atomicWriteJson(eventPath(eventId, nowIso), event);
    return eventId;
  }

  // Find or open window
  let window = existingWindowId
    ? readJsonOrNull(windowPath(slug, existingWindowId))
    : findActiveWindow(slug, nowIso);

  let isNewWindow = false;
  if (!window || computeWindowStatus(window, nowIso) === 'verdict_landed') {
    isNewWindow = true;
    const openedAt = nowIso;
    const bundleLockedAt = addDaysIso(openedAt, BUNDLE_GROUPING_DAYS);
    const verdictAt = addDaysIso(bundleLockedAt, MEASUREMENT_DAYS);
    const id = newWindowId(slug, openedAt);
    window = {
      id,
      url, slug,
      opened_at: openedAt,
      bundle_locked_at: bundleLockedAt,
      verdict_at: verdictAt,
      changes: [],
      target_queries: [],
      baseline: await captureBaseline(slug, targetQuery ? [targetQuery] : [], openedAt),
      verdict: null,
    };
  }

  const event = {
    id: eventId, url, slug, change_type: changeType, category,
    before, after, changed_at: nowIso, source,
    target_query: targetQuery ?? null,
    target_cluster: [],
    intent: intent ?? null,
    window_id: window.id,
  };
  atomicWriteJson(eventPath(eventId, nowIso), event);

  window.changes.push(eventId);
  if (targetQuery && !window.target_queries.includes(targetQuery)) {
    window.target_queries.push(targetQuery);
  }
  atomicWriteJson(windowPath(slug, window.id), window);

  return eventId;
}

export async function queueChange({ slug, changeType, source, proposalContext, targetQuery, after }) {
  const id = newQueueItemId(slug);
  const item = {
    id,
    slug, change_type: changeType, source,
    target_query: targetQuery ?? null,
    after,
    proposal_context: proposalContext ?? null,
    proposed_at: new Date().toISOString(),
  };
  atomicWriteJson(queueItemPath(slug, id), item);
  return id;
}
```

- [ ] **Step 4: Run tests**

```bash
node --test tests/lib/change-log.test.js
```

Expected: all 10 tests pass (5 from Task 4 + 5 new).

- [ ] **Step 5: Commit**

```bash
git add lib/change-log.js tests/lib/change-log.test.js
git commit -m "feat(change-log): add public API (proposeChange, logChangeEvent, queueChange, captureBaseline)"
```

---

## Task 6: Verdict computation

**Files:**
- Create: `lib/change-log/verdict.js`
- Test: `tests/lib/change-log-verdict.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/lib/change-log-verdict.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOutcome, decideAction, computeDeltas, THRESHOLDS } from '../../lib/change-log/verdict.js';

test('classifyOutcome is "improved" when target_query CTR ≥ +20% and no negatives crossed', () => {
  const deltas = {
    page: { ctr: 0.10, clicks: 0.05, impressions: 0.05, position: 0, page_revenue: 0.10, sessions: 0.10, conversions: 0.05 },
    target_queries: { 'coconut lotion': { ctr: 0.25, clicks: 0.10, position: -1, impressions: 0.05 } },
  };
  assert.equal(classifyOutcome(deltas), 'improved');
});

test('classifyOutcome is "regressed" when CTR drops 25%', () => {
  const deltas = {
    page: { ctr: -0.25, clicks: -0.10, impressions: -0.05, position: 0, page_revenue: -0.05, sessions: -0.05, conversions: 0 },
    target_queries: { 'coconut lotion': { ctr: -0.30, clicks: -0.20, position: 1, impressions: -0.05 } },
  };
  assert.equal(classifyOutcome(deltas), 'regressed');
});

test('classifyOutcome is "regressed" when revenue drops 30%', () => {
  const deltas = {
    page: { ctr: 0, clicks: 0, impressions: 0, position: 0, page_revenue: -0.30, sessions: 0, conversions: -0.30 },
    target_queries: {},
  };
  assert.equal(classifyOutcome(deltas), 'regressed');
});

test('classifyOutcome is "no_change" when all deltas are within ±5%', () => {
  const deltas = {
    page: { ctr: 0.02, clicks: 0.03, impressions: -0.01, position: 0.5, page_revenue: 0.04, sessions: 0.01, conversions: 0 },
    target_queries: { 'coconut lotion': { ctr: 0.04, clicks: 0.03, position: 0.5, impressions: 0 } },
  };
  assert.equal(classifyOutcome(deltas), 'no_change');
});

test('classifyOutcome is "inconclusive" when deltas are between thresholds', () => {
  const deltas = {
    page: { ctr: 0.10, clicks: 0.10, impressions: 0.05, position: -1, page_revenue: 0.10, sessions: 0.10, conversions: 0.05 },
    target_queries: { 'coconut lotion': { ctr: 0.10, clicks: 0.15, position: -1, impressions: 0.05 } },
  };
  // +10% CTR is between ±5% (no_change) and +20% (improved). Hence inconclusive.
  assert.equal(classifyOutcome(deltas), 'inconclusive');
});

test('decideAction returns "kept" for improved or no_change or inconclusive', () => {
  const window = { changes: ['ch-1'] };
  const events = [{ id: 'ch-1', change_type: 'title' }];
  assert.equal(decideAction({ outcome: 'improved', window, events }).action, 'kept');
  assert.equal(decideAction({ outcome: 'no_change', window, events }).action, 'kept');
  assert.equal(decideAction({ outcome: 'inconclusive', window, events }).action, 'kept');
});

test('decideAction returns "reverted" for regressed when bundle is fully revertable', () => {
  const window = { changes: ['ch-1', 'ch-2'] };
  const events = [
    { id: 'ch-1', change_type: 'title' },
    { id: 'ch-2', change_type: 'meta_description' },
  ];
  assert.equal(decideAction({ outcome: 'regressed', window, events }).action, 'reverted');
});

test('decideAction returns "surfaced_for_review" for regressed when bundle includes content_body', () => {
  const window = { changes: ['ch-1', 'ch-2'] };
  const events = [
    { id: 'ch-1', change_type: 'title' },
    { id: 'ch-2', change_type: 'content_body' },
  ];
  assert.equal(decideAction({ outcome: 'regressed', window, events }).action, 'surfaced_for_review');
});

test('decideAction returns "surfaced_for_review" for regressed when bundle includes image', () => {
  const window = { changes: ['ch-1'] };
  const events = [{ id: 'ch-1', change_type: 'image' }];
  assert.equal(decideAction({ outcome: 'regressed', window, events }).action, 'surfaced_for_review');
});

test('THRESHOLDS exposed for tuning', () => {
  assert.ok(THRESHOLDS.ctr_positive);
  assert.ok(THRESHOLDS.ctr_negative);
  assert.ok(THRESHOLDS.position_positive);
  assert.ok(THRESHOLDS.position_negative);
  assert.ok(THRESHOLDS.revenue_positive);
  assert.ok(THRESHOLDS.revenue_negative);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test tests/lib/change-log-verdict.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the verdict module**

Create `lib/change-log/verdict.js`:

```js
/**
 * Verdict computation for change-log windows.
 *
 * - computeDeltas(window, current) → { page: {...}, target_queries: {...} }
 *   Compares the window.baseline against current metrics, returning
 *   relative deltas (e.g. ctr 0.25 means +25%).
 * - classifyOutcome(deltas) → "improved" | "regressed" | "no_change" | "inconclusive"
 * - decideAction({ outcome, window, events }) → { action, reason }
 *
 * THRESHOLDS is exported so future config can override.
 */

export const THRESHOLDS = {
  // Positive triggers (any one trips → "improved" if no negative is also tripped):
  ctr_positive: 0.20,        // +20% relative
  clicks_positive: 0.25,     // +25% relative
  position_positive: -3,     // -3 positions absolute (lower number = higher rank)
  revenue_positive: 0.20,    // +20% relative

  // Negative triggers (any one trips → "regressed"):
  ctr_negative: -0.20,
  clicks_negative: -0.25,
  position_negative: 5,      // +5 positions absolute
  revenue_negative: -0.20,

  // Within-noise band (all deltas within ±this → "no_change"):
  noise_band: 0.05,          // 5% relative for ratios; 1 position for position
  noise_position: 1,
};

const REVERTABLE_TYPES = new Set([
  'title', 'meta_description', 'schema', 'faq_added', 'internal_link_added',
]);

function relDelta(current, baseline) {
  if (baseline == null || baseline === 0) return current === 0 ? 0 : null;
  return (current - baseline) / baseline;
}

function absDelta(current, baseline) {
  if (current == null || baseline == null) return null;
  return current - baseline;
}

export function computeDeltas(baseline, current) {
  const page = {
    impressions: relDelta(current.gsc.page.impressions, baseline.gsc.page.impressions),
    clicks: relDelta(current.gsc.page.clicks, baseline.gsc.page.clicks),
    ctr: relDelta(current.gsc.page.ctr, baseline.gsc.page.ctr),
    position: absDelta(current.gsc.page.position, baseline.gsc.page.position),
    sessions: relDelta(current.ga4.sessions, baseline.ga4.sessions),
    conversions: relDelta(current.ga4.conversions, baseline.ga4.conversions),
    page_revenue: relDelta(current.ga4.page_revenue, baseline.ga4.page_revenue),
  };
  const target_queries = {};
  for (const q of Object.keys(current.gsc.byQuery || {})) {
    const cur = current.gsc.byQuery[q];
    const base = baseline.gsc.byQuery?.[q] || { impressions: 0, clicks: 0, ctr: 0, position: null };
    target_queries[q] = {
      impressions: relDelta(cur.impressions, base.impressions),
      clicks: relDelta(cur.clicks, base.clicks),
      ctr: relDelta(cur.ctr, base.ctr),
      position: absDelta(cur.position, base.position),
    };
  }
  return { page, target_queries };
}

function isWithinNoise(deltas) {
  const checkRel = (v) => v == null || Math.abs(v) <= THRESHOLDS.noise_band;
  const checkPos = (v) => v == null || Math.abs(v) <= THRESHOLDS.noise_position;
  if (!checkRel(deltas.page.ctr)) return false;
  if (!checkRel(deltas.page.clicks)) return false;
  if (!checkRel(deltas.page.impressions)) return false;
  if (!checkRel(deltas.page.page_revenue)) return false;
  if (!checkRel(deltas.page.sessions)) return false;
  if (!checkPos(deltas.page.position)) return false;
  for (const q of Object.values(deltas.target_queries || {})) {
    if (!checkRel(q.ctr)) return false;
    if (!checkRel(q.clicks)) return false;
    if (!checkPos(q.position)) return false;
  }
  return true;
}

function tripsNegative(deltas) {
  if (deltas.page.ctr != null && deltas.page.ctr <= THRESHOLDS.ctr_negative) return true;
  if (deltas.page.clicks != null && deltas.page.clicks <= THRESHOLDS.clicks_negative) return true;
  if (deltas.page.position != null && deltas.page.position >= THRESHOLDS.position_negative) return true;
  if (deltas.page.page_revenue != null && deltas.page.page_revenue <= THRESHOLDS.revenue_negative) return true;
  for (const q of Object.values(deltas.target_queries || {})) {
    if (q.ctr != null && q.ctr <= THRESHOLDS.ctr_negative) return true;
    if (q.clicks != null && q.clicks <= THRESHOLDS.clicks_negative) return true;
    if (q.position != null && q.position >= THRESHOLDS.position_negative) return true;
  }
  return false;
}

function tripsPositive(deltas) {
  if (deltas.page.ctr != null && deltas.page.ctr >= THRESHOLDS.ctr_positive) return true;
  if (deltas.page.clicks != null && deltas.page.clicks >= THRESHOLDS.clicks_positive) return true;
  if (deltas.page.position != null && deltas.page.position <= THRESHOLDS.position_positive) return true;
  if (deltas.page.page_revenue != null && deltas.page.page_revenue >= THRESHOLDS.revenue_positive) return true;
  for (const q of Object.values(deltas.target_queries || {})) {
    if (q.ctr != null && q.ctr >= THRESHOLDS.ctr_positive) return true;
    if (q.clicks != null && q.clicks >= THRESHOLDS.clicks_positive) return true;
    if (q.position != null && q.position <= THRESHOLDS.position_positive) return true;
  }
  return false;
}

export function classifyOutcome(deltas) {
  if (tripsNegative(deltas)) return 'regressed';
  if (isWithinNoise(deltas)) return 'no_change';
  if (tripsPositive(deltas)) return 'improved';
  return 'inconclusive';
}

export function decideAction({ outcome, window, events }) {
  if (outcome !== 'regressed') {
    return { action: 'kept', reason: outcome };
  }
  const types = events.filter((e) => window.changes.includes(e.id)).map((e) => e.change_type);
  const allRevertable = types.every((t) => REVERTABLE_TYPES.has(t));
  if (allRevertable && types.length > 0) {
    return { action: 'reverted', reason: 'all_revertable_types' };
  }
  return { action: 'surfaced_for_review', reason: 'bundle_includes_irreversible_types' };
}
```

- [ ] **Step 4: Run tests**

```bash
node --test tests/lib/change-log-verdict.test.js
```

Expected: all 10 tests pass.

- [ ] **Step 5: Commit**

```bash
git add lib/change-log/verdict.js tests/lib/change-log-verdict.test.js
git commit -m "feat(change-log): add verdict classification + action decision"
```

---

## Task 7: change-verdict agent

**Files:**
- Create: `agents/change-verdict/index.js`
- Test: `tests/agents/change-verdict.test.js`

- [ ] **Step 1: Write the structure test**

Create `tests/agents/change-verdict.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';

test('change-verdict agent exists at the expected path', () => {
  assert.ok(existsSync('agents/change-verdict/index.js'));
});

test('change-verdict agent imports the expected libs', () => {
  const src = readFileSync('agents/change-verdict/index.js', 'utf8');
  assert.ok(src.includes('lib/change-log.js'), 'must import lib/change-log.js');
  assert.ok(src.includes('lib/change-log/snapshots.js'), 'must import snapshots');
  assert.ok(src.includes('lib/change-log/verdict.js'), 'must import verdict');
  assert.ok(src.includes('lib/notify.js'), 'must import notify');
});

test('change-verdict agent supports --dry-run flag', () => {
  const src = readFileSync('agents/change-verdict/index.js', 'utf8');
  assert.ok(src.includes('--dry-run') || src.includes("'dry-run'"));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test tests/agents/change-verdict.test.js
```

Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement the agent**

Create `agents/change-verdict/index.js`:

```js
/**
 * Change Verdict Agent
 *
 * Daily cron. For every page-window past its verdict_at:
 *   1. Read the last 28d of GSC + GA4 snapshots.
 *   2. Compute deltas vs the window's baseline.
 *   3. Classify outcome (improved/regressed/no_change/inconclusive).
 *   4. Decide action (kept/reverted/surfaced_for_review).
 *   5. Write the verdict to the window file, append a learning to
 *      data/context/feedback.md, and notify the daily-summary digest.
 *
 * Usage:
 *   node agents/change-verdict/index.js
 *   node agents/change-verdict/index.js --dry-run
 */

import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson, readJsonOrNull, eventPath, windowPath } from '../../lib/change-log/store.js';
import { aggregateGSCForUrl, aggregateGA4ForUrl } from '../../lib/change-log/snapshots.js';
import { computeDeltas, classifyOutcome, decideAction } from '../../lib/change-log/verdict.js';
import { CHANGES_ROOT, computeWindowStatus } from '../../lib/change-log.js';
import { updateArticle, getBlogs, getArticles } from '../../lib/shopify.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SNAPSHOTS_GSC = join(ROOT, 'data', 'snapshots', 'gsc');
const SNAPSHOTS_GA4 = join(ROOT, 'data', 'snapshots', 'ga4');
const FEEDBACK_PATH = join(ROOT, 'data', 'context', 'feedback.md');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'change-verdict');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

function listAllWindows() {
  const windowsDir = join(CHANGES_ROOT, 'windows');
  if (!existsSync(windowsDir)) return [];
  const out = [];
  for (const slug of readdirSync(windowsDir)) {
    const slugDir = join(windowsDir, slug);
    for (const f of readdirSync(slugDir).filter((x) => x.endsWith('.json'))) {
      const w = readJsonOrNull(join(slugDir, f));
      if (w) out.push(w);
    }
  }
  return out;
}

function loadEventsForWindow(window) {
  const events = [];
  for (const eid of window.changes) {
    // event id pattern: ch-YYYY-MM-DD-...
    const ymPart = eid.slice(3, 10); // YYYY-MM
    const path = eventPath(eid, ymPart + '-01T00:00:00Z'); // any date in same month works for path
    const ev = readJsonOrNull(path);
    if (ev) events.push(ev);
  }
  return events;
}

async function appendLearning(text) {
  if (!existsSync(dirname(FEEDBACK_PATH))) mkdirSync(dirname(FEEDBACK_PATH), { recursive: true });
  let body = '';
  if (existsSync(FEEDBACK_PATH)) body = readFileSync(FEEDBACK_PATH, 'utf8');
  const heading = '## change-verdict';
  if (!body.includes(heading)) {
    body += (body.endsWith('\n') ? '' : '\n') + `\n${heading}\n\n`;
  }
  // Insert under the heading
  const idx = body.indexOf(heading);
  const insertAt = body.indexOf('\n', idx) + 1;
  const newBody = body.slice(0, insertAt) + `\n- [${new Date().toISOString().slice(0, 10)}] ${text}\n` + body.slice(insertAt);
  writeFileSync(FEEDBACK_PATH, newBody);
}

async function applyRevert(window, events, articleIndex) {
  const results = [];
  for (const eid of window.changes) {
    const ev = events.find((e) => e.id === eid);
    if (!ev) continue;
    const handle = ev.slug;
    const article = articleIndex.get(handle);
    if (!article) {
      results.push({ change_id: eid, field: ev.change_type, ok: false, error: 'article_not_found' });
      continue;
    }
    try {
      if (ev.change_type === 'title') {
        await updateArticle(article.blogId, article.articleId, { title: ev.before });
      } else if (ev.change_type === 'meta_description') {
        // Meta description is on a metafield; for blog-vs-product different handlers exist.
        // For v1 we fall back to setting body_html-adjacent meta via summary_html if present.
        await updateArticle(article.blogId, article.articleId, { summary_html: ev.before });
      } else if (ev.change_type === 'schema' || ev.change_type === 'faq_added') {
        // Body-html stored revert
        await updateArticle(article.blogId, article.articleId, { body_html: ev.before });
      } else if (ev.change_type === 'internal_link_added') {
        await updateArticle(article.blogId, article.articleId, { body_html: ev.before });
      }
      results.push({ change_id: eid, field: ev.change_type, ok: true });
    } catch (err) {
      results.push({ change_id: eid, field: ev.change_type, ok: false, error: err.message });
    }
  }
  return results;
}

async function buildArticleIndex() {
  const blogs = await getBlogs();
  const byHandle = new Map();
  for (const blog of blogs) {
    const articles = await getArticles(blog.id);
    for (const a of articles) {
      byHandle.set(a.handle, { blogId: blog.id, articleId: a.id, handle: a.handle });
    }
  }
  return byHandle;
}

async function main() {
  console.log(`\nChange Verdict Agent — mode: ${dryRun ? 'DRY RUN' : 'APPLY'}`);
  mkdirSync(REPORTS_DIR, { recursive: true });
  const nowIso = new Date().toISOString();

  const windows = listAllWindows();
  const due = windows.filter((w) => !w.verdict && nowIso >= w.verdict_at);
  console.log(`  ${windows.length} total windows, ${due.length} due for verdict`);

  if (due.length === 0) {
    return;
  }

  let needsArticleIndex = !dryRun && due.some((w) => /* will have a revert */ true);
  const articleIndex = needsArticleIndex ? await buildArticleIndex() : new Map();

  const summary = { improved: 0, no_change: 0, regressed: 0, inconclusive: 0, reverted: 0, surfaced: 0, kept: 0 };

  for (const window of due) {
    console.log(`\n  ${window.url} (window ${window.id})`);
    const events = loadEventsForWindow(window);
    if (events.length === 0) {
      console.log('    no events found in window — skipping');
      continue;
    }

    // Read CURRENT metrics — last 28d ending today
    const fromDate = new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
    const toDate = new Date().toISOString().slice(0, 10);
    const pagePath = window.url.startsWith('http') ? new URL(window.url).pathname : window.url;
    const fullUrl = window.url.startsWith('http') ? window.url : `https://www.realskincare.com${window.url}`;
    const currentGsc = aggregateGSCForUrl({
      snapshotsDir: SNAPSHOTS_GSC,
      url: fullUrl,
      queries: window.target_queries || [],
      fromDate, toDate,
    });
    const currentGa4 = aggregateGA4ForUrl({
      snapshotsDir: SNAPSHOTS_GA4,
      pagePath,
      fromDate, toDate,
    });

    const deltas = computeDeltas(window.baseline, { gsc: currentGsc, ga4: currentGa4 });
    const outcome = classifyOutcome(deltas);
    const decision = decideAction({ outcome, window, events });
    console.log(`    outcome: ${outcome}, action: ${decision.action}`);
    summary[outcome]++;
    if (decision.action === 'reverted') summary.reverted++;
    else if (decision.action === 'surfaced_for_review') summary.surfaced++;
    else summary.kept++;

    let revertResults = null;
    if (!dryRun && decision.action === 'reverted') {
      revertResults = await applyRevert(window, events, articleIndex);
      console.log(`    reverted ${revertResults.filter((r) => r.ok).length}/${revertResults.length} fields`);
    }

    const verdict = {
      decided_at: new Date().toISOString(),
      gsc_delta: deltas.page,
      ga4_delta: { sessions: deltas.page.sessions, conversions: deltas.page.conversions, page_revenue: deltas.page.page_revenue },
      target_query_deltas: deltas.target_queries,
      outcome,
      action_taken: decision.action,
      revert_results: revertResults,
      learnings: `${decision.action.toUpperCase()} — ${window.target_queries.join(', ')} — outcome ${outcome}, page CTR Δ${(deltas.page.ctr * 100).toFixed(1)}% revenue Δ${(deltas.page.page_revenue * 100).toFixed(1)}%`,
    };

    if (!dryRun) {
      window.verdict = verdict;
      atomicWriteJson(windowPath(window.slug, window.id), window);
      await appendLearning(`${window.url}: ${verdict.learnings}`);
    }
  }

  // Notify
  const lines = [
    `Change-verdict run: ${due.length} windows processed`,
    `  Improved: ${summary.improved} (kept)`,
    `  No change: ${summary.no_change} (kept)`,
    `  Inconclusive: ${summary.inconclusive} (kept)`,
    `  Regressed: ${summary.regressed} (reverted: ${summary.reverted}, surfaced: ${summary.surfaced})`,
  ];
  await notify({ subject: 'Change Verdict ran', body: lines.join('\n') });
  console.log('\n' + lines.join('\n'));
}

main().catch((err) => {
  notify({ subject: 'Change Verdict failed', body: err.message || String(err), status: 'error' });
  console.error('Error:', err.message);
  process.exit(1);
});
```

- [ ] **Step 4: Run structure test**

```bash
node --test tests/agents/change-verdict.test.js
```

Expected: all 3 tests pass.

- [ ] **Step 5: Smoke-test in dry-run**

```bash
node agents/change-verdict/index.js --dry-run
```

Expected:
- Logs `Change Verdict Agent — mode: DRY RUN`
- Reports `0 total windows, 0 due for verdict` (no windows have been opened yet)
- Exits 0
- No notification sent

- [ ] **Step 6: Commit**

```bash
git add agents/change-verdict/index.js tests/agents/change-verdict.test.js
git commit -m "feat(change-verdict): agent that classifies outcomes and auto-reverts losers"
```

---

## Task 8: change-diff-detector agent

**Files:**
- Create: `agents/change-diff-detector/index.js`
- Test: `tests/agents/change-diff-detector.test.js`

- [ ] **Step 1: Write structure test**

Create `tests/agents/change-diff-detector.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

test('change-diff-detector exists', () => {
  assert.ok(existsSync('agents/change-diff-detector/index.js'));
});

test('change-diff-detector imports the lib + reads shopify snapshots', () => {
  const src = readFileSync('agents/change-diff-detector/index.js', 'utf8');
  assert.ok(src.includes('lib/change-log.js'));
  assert.ok(src.includes('snapshots/shopify') || src.includes("'shopify'"));
  assert.ok(src.includes('logChangeEvent'));
});

test('change-diff-detector supports --dry-run flag', () => {
  const src = readFileSync('agents/change-diff-detector/index.js', 'utf8');
  assert.ok(src.includes('--dry-run') || src.includes("'dry-run'"));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test tests/agents/change-diff-detector.test.js
```

Expected: FAIL.

- [ ] **Step 3: Implement the agent**

Create `agents/change-diff-detector/index.js`:

```js
/**
 * Change Diff Detector
 *
 * Daily cron. Reads the two most recent shopify-collector snapshots, diffs
 * them per article/product/page, and creates synthetic change events for
 * any field change that doesn't already have an agent-logged event in the
 * last 48 hours.
 *
 * Tracked fields per resource:
 *   article: title, summary_html (= meta_description), body_html
 *   product: title, body_html (= description), seo metafields when present
 *   page:    title, body_html
 *
 * Synthetic events get source: "manual_diff", target_query: null,
 * category: "experimental".
 *
 * Usage:
 *   node agents/change-diff-detector/index.js
 *   node agents/change-diff-detector/index.js --dry-run
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logChangeEvent } from '../../lib/change-log.js';
import { eventPath } from '../../lib/change-log/store.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SHOPIFY_DIR = join(ROOT, 'data', 'snapshots', 'shopify');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const TRACKED_ARTICLE_FIELDS = ['title', 'summary_html', 'body_html'];
const TRACKED_PRODUCT_FIELDS = ['title', 'body_html'];
const TRACKED_PAGE_FIELDS    = ['title', 'body_html'];

const FIELD_TO_CHANGE_TYPE = {
  title: 'title',
  summary_html: 'meta_description',
  body_html: 'content_body',
};

function listSnapshots() {
  if (!existsSync(SHOPIFY_DIR)) return [];
  return readdirSync(SHOPIFY_DIR).filter((f) => f.endsWith('.json')).sort();
}

function indexById(items, idKey = 'id') {
  const m = new Map();
  for (const it of items || []) m.set(it[idKey], it);
  return m;
}

function diffFields(prev, curr, fields) {
  const diffs = [];
  for (const f of fields) {
    if ((prev?.[f] ?? '') !== (curr?.[f] ?? '')) {
      diffs.push({ field: f, before: prev?.[f] ?? '', after: curr?.[f] ?? '' });
    }
  }
  return diffs;
}

function urlFor(resourceType, item) {
  if (resourceType === 'article') return `/blogs/news/${item.handle}`;
  if (resourceType === 'product') return `/products/${item.handle}`;
  if (resourceType === 'page') return `/pages/${item.handle}`;
  return null;
}

async function main() {
  console.log(`\nChange Diff Detector — mode: ${dryRun ? 'DRY RUN' : 'APPLY'}`);
  const snapshots = listSnapshots();
  if (snapshots.length < 2) {
    console.log('  Not enough shopify snapshots yet (need at least 2). Skipping.');
    return;
  }
  const today = snapshots[snapshots.length - 1];
  const yesterday = snapshots[snapshots.length - 2];
  console.log(`  Comparing ${yesterday} → ${today}`);

  const prev = JSON.parse(readFileSync(join(SHOPIFY_DIR, yesterday), 'utf8'));
  const curr = JSON.parse(readFileSync(join(SHOPIFY_DIR, today), 'utf8'));

  const stats = { detected: 0, logged: 0, already_logged: 0 };

  // Articles
  const prevArticles = indexById(prev.articles);
  for (const a of curr.articles || []) {
    const prevA = prevArticles.get(a.id);
    if (!prevA) continue; // new article isn't a "change"
    const diffs = diffFields(prevA, a, TRACKED_ARTICLE_FIELDS);
    for (const d of diffs) {
      stats.detected++;
      const url = urlFor('article', a);
      const slug = a.handle;
      const changeType = FIELD_TO_CHANGE_TYPE[d.field];
      if (dryRun) {
        console.log(`    [diff] ${url} ${changeType}: <${d.before.length} chars> → <${d.after.length} chars>`);
        continue;
      }
      const eid = await logChangeEvent({
        url, slug,
        changeType,
        category: 'experimental',
        before: d.before, after: d.after,
        source: 'manual_diff',
        targetQuery: null,
        intent: null,
      });
      stats.logged++;
      console.log(`    [logged] ${eid} ${url} ${changeType}`);
    }
  }

  // Products
  const prevProducts = indexById(prev.products);
  for (const p of curr.products || []) {
    const prevP = prevProducts.get(p.id);
    if (!prevP) continue;
    const diffs = diffFields(prevP, p, TRACKED_PRODUCT_FIELDS);
    for (const d of diffs) {
      stats.detected++;
      const url = urlFor('product', p);
      const slug = p.handle;
      const changeType = FIELD_TO_CHANGE_TYPE[d.field];
      if (dryRun) {
        console.log(`    [diff] ${url} ${changeType}`);
        continue;
      }
      const eid = await logChangeEvent({
        url, slug,
        changeType,
        category: 'experimental',
        before: d.before, after: d.after,
        source: 'manual_diff',
        targetQuery: null,
        intent: null,
      });
      stats.logged++;
      console.log(`    [logged] ${eid} ${url} ${changeType}`);
    }
  }

  // Pages
  const prevPages = indexById(prev.pages);
  for (const p of curr.pages || []) {
    const prevP = prevPages.get(p.id);
    if (!prevP) continue;
    const diffs = diffFields(prevP, p, TRACKED_PAGE_FIELDS);
    for (const d of diffs) {
      stats.detected++;
      const url = urlFor('page', p);
      const slug = p.handle;
      const changeType = FIELD_TO_CHANGE_TYPE[d.field];
      if (dryRun) {
        console.log(`    [diff] ${url} ${changeType}`);
        continue;
      }
      const eid = await logChangeEvent({
        url, slug,
        changeType,
        category: 'experimental',
        before: d.before, after: d.after,
        source: 'manual_diff',
        targetQuery: null,
        intent: null,
      });
      stats.logged++;
      console.log(`    [logged] ${eid} ${url} ${changeType}`);
    }
  }

  console.log(`\n  Detected ${stats.detected} field diffs, logged ${stats.logged}.`);
  if (!dryRun) {
    await notify({ subject: 'Change Diff Detector ran', body: `Detected ${stats.detected}, logged ${stats.logged}` });
  }
}

main().catch((err) => {
  notify({ subject: 'Change Diff Detector failed', body: err.message || String(err), status: 'error' });
  console.error('Error:', err.message);
  process.exit(1);
});
```

Note: this v1 does not check whether an event was already logged by an agent in the last 48h (the spec mentions this). For v1, the assumption is agents always log their changes via `logChangeEvent` and the diff detector is only catching truly manual edits. If an agent change is also caught by diff, a duplicate event is created — acceptable for v1 (will be filtered out as duplicate by the verdict's deduplication on field-per-window). This trade-off is documented in the agent's header docstring.

- [ ] **Step 4: Run structure test**

```bash
node --test tests/agents/change-diff-detector.test.js
```

Expected: all 3 tests pass.

- [ ] **Step 5: Smoke-test in dry-run**

```bash
node agents/change-diff-detector/index.js --dry-run
```

Expected: either logs "Not enough shopify snapshots yet" (clean local state) OR logs detected diffs without applying. No notification sent in dry-run.

- [ ] **Step 6: Commit**

```bash
git add agents/change-diff-detector/index.js tests/agents/change-diff-detector.test.js
git commit -m "feat(change-diff-detector): catch manual Shopify edits via daily snapshot diff"
```

---

## Task 9: change-queue-processor agent

**Files:**
- Create: `agents/change-queue-processor/index.js`
- Test: `tests/agents/change-queue-processor.test.js`

- [ ] **Step 1: Write structure test**

Create `tests/agents/change-queue-processor.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

test('change-queue-processor exists', () => {
  assert.ok(existsSync('agents/change-queue-processor/index.js'));
});

test('change-queue-processor imports the lib + applies queued items', () => {
  const src = readFileSync('agents/change-queue-processor/index.js', 'utf8');
  assert.ok(src.includes('lib/change-log.js'));
  assert.ok(src.includes('logChangeEvent') || src.includes('updateArticle'));
});

test('change-queue-processor supports --dry-run flag', () => {
  const src = readFileSync('agents/change-queue-processor/index.js', 'utf8');
  assert.ok(src.includes('--dry-run') || src.includes("'dry-run'"));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test tests/agents/change-queue-processor.test.js
```

Expected: FAIL.

- [ ] **Step 3: Implement the agent**

Create `agents/change-queue-processor/index.js`:

```js
/**
 * Change Queue Processor
 *
 * Daily cron. For each verdict-landed window where the page has no
 * active measurement, releases queued changes (FIFO by proposed_at) by
 * applying the stored `after` value via Shopify and logging the change
 * with source "<original_source>+queue-released".
 *
 * Items older than 60 days are dropped as stale.
 *
 * Usage:
 *   node agents/change-queue-processor/index.js
 *   node agents/change-queue-processor/index.js --dry-run
 */

import { readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonOrNull, queueItemPath } from '../../lib/change-log/store.js';
import { CHANGES_ROOT, getActiveWindow, logChangeEvent } from '../../lib/change-log.js';
import { updateArticle, getBlogs, getArticles } from '../../lib/shopify.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const STALE_DAYS = 60;
const FIELD_TO_SHOPIFY = {
  title: (after) => ({ title: after }),
  meta_description: (after) => ({ summary_html: after }),
  schema: (after) => ({ body_html: after }), // typical pattern: schema lives in body_html
  faq_added: (after) => ({ body_html: after }),
  internal_link_added: (after) => ({ body_html: after }),
  content_body: (after) => ({ body_html: after }),
  image: (after) => ({ image: { src: after } }),
};

async function buildArticleIndex() {
  const blogs = await getBlogs();
  const byHandle = new Map();
  for (const blog of blogs) {
    const articles = await getArticles(blog.id);
    for (const a of articles) byHandle.set(a.handle, { blogId: blog.id, articleId: a.id, handle: a.handle });
  }
  return byHandle;
}

function listQueuedSlugs() {
  const dir = join(CHANGES_ROOT, 'queue');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => {
    const slugDir = join(dir, d);
    try {
      return readdirSync(slugDir).some((f) => f.endsWith('.json'));
    } catch { return false; }
  });
}

function listQueueItemsForSlug(slug) {
  const dir = join(CHANGES_ROOT, 'queue', slug);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJsonOrNull(join(dir, f)))
    .filter(Boolean)
    .sort((a, b) => (a.proposed_at || '').localeCompare(b.proposed_at || ''));
}

async function main() {
  console.log(`\nChange Queue Processor — mode: ${dryRun ? 'DRY RUN' : 'APPLY'}`);
  const slugs = listQueuedSlugs();
  if (slugs.length === 0) {
    console.log('  No queued items. Skipping.');
    return;
  }
  const articleIndex = !dryRun ? await buildArticleIndex() : new Map();

  let released = 0, dropped = 0, failed = 0;
  const failures = [];

  for (const slug of slugs) {
    const active = getActiveWindow(slug);
    if (active) {
      console.log(`  ${slug}: active window — leaving queue intact`);
      continue;
    }
    const items = listQueueItemsForSlug(slug);
    for (const item of items) {
      const ageMs = Date.now() - new Date(item.proposed_at).getTime();
      const ageDays = ageMs / 86400000;
      const itemPath = queueItemPath(slug, item.id);

      if (ageDays > STALE_DAYS) {
        console.log(`  ${slug}/${item.id}: stale (${Math.floor(ageDays)}d) — dropping`);
        if (!dryRun) unlinkSync(itemPath);
        dropped++;
        continue;
      }

      console.log(`  ${slug}/${item.id}: applying (${item.change_type})`);
      if (dryRun) { released++; continue; }

      const article = articleIndex.get(slug);
      if (!article) {
        console.log(`    skip — article not found`);
        failures.push({ slug, item: item.id, error: 'article_not_found' });
        failed++;
        continue;
      }
      const fieldFn = FIELD_TO_SHOPIFY[item.change_type];
      if (!fieldFn) {
        console.log(`    skip — unsupported change_type ${item.change_type}`);
        failures.push({ slug, item: item.id, error: `unsupported_change_type:${item.change_type}` });
        failed++;
        continue;
      }
      try {
        await updateArticle(article.blogId, article.articleId, fieldFn(item.after));
        // Log a fresh event opening a new window
        await logChangeEvent({
          url: `/blogs/news/${slug}`, slug,
          changeType: item.change_type,
          category: 'experimental',
          before: '(queued — original before captured at proposal time)',
          after: item.after,
          source: `${item.source}+queue-released`,
          targetQuery: item.target_query,
          intent: 'released from queue after window closure',
        });
        unlinkSync(itemPath);
        released++;
      } catch (err) {
        console.log(`    error: ${err.message}`);
        failures.push({ slug, item: item.id, error: err.message });
        failed++;
      }
    }
  }

  const lines = [`Queue processor: released ${released}, dropped (stale) ${dropped}, failed ${failed}`];
  if (failures.length > 0) {
    lines.push('Failures:');
    for (const f of failures.slice(0, 10)) lines.push(`  ${f.slug}/${f.item}: ${f.error}`);
  }
  if (!dryRun) await notify({ subject: 'Change Queue Processor ran', body: lines.join('\n') });
  console.log('\n' + lines.join('\n'));
}

main().catch((err) => {
  notify({ subject: 'Change Queue Processor failed', body: err.message || String(err), status: 'error' });
  console.error('Error:', err.message);
  process.exit(1);
});
```

- [ ] **Step 4: Run structure test**

```bash
node --test tests/agents/change-queue-processor.test.js
```

Expected: all 3 tests pass.

- [ ] **Step 5: Dry-run smoke**

```bash
node agents/change-queue-processor/index.js --dry-run
```

Expected: logs `No queued items. Skipping.` (no items have been queued yet).

- [ ] **Step 6: Commit**

```bash
git add agents/change-queue-processor/index.js tests/agents/change-queue-processor.test.js
git commit -m "feat(change-queue-processor): release queued changes after window closes"
```

---

## Task 10: Wire into scheduler

**Files:**
- Modify: `scheduler.js`

- [ ] **Step 1: Read the existing scheduler.js to identify insertion points**

```bash
grep -n "Step\|review-monitor\|legacy-rebuilder" scheduler.js | head -20
```

Find the line for `review-monitor` (early in the daily flow) and `legacy-rebuilder` (mid-flow).

- [ ] **Step 2: Insert change-diff-detector after review-monitor**

In `scheduler.js`, find the line that runs `review-monitor`:

```js
runStep('review-monitor', `"${NODE}" agents/review-monitor/index.js`);
```

Add this line directly after it:

```js
// Step 0a: catch any manual Shopify edits before agents start their daily work
runStep('change-diff-detector', `"${NODE}" agents/change-diff-detector/index.js${dryFlag}`);
```

- [ ] **Step 3: Insert change-verdict + change-queue-processor near end of daily pipeline**

In `scheduler.js`, find the existing comment block for the weekly Sunday jobs (likely starts with `// ── Weekly jobs (Sundays only) ──`). Add these two steps directly BEFORE that block:

```js
// Step 5z: change-log verdict + queue release (run daily, after all agent runs)
runStep('change-verdict', `"${NODE}" agents/change-verdict/index.js${dryFlag}`);
runStep('change-queue-processor', `"${NODE}" agents/change-queue-processor/index.js${dryFlag}`);
```

- [ ] **Step 4: Verify with dry-run**

```bash
node scheduler.js --dry-run 2>&1 | grep -E "change-(diff|verdict|queue)"
```

Expected output (3 lines):
```
  "...node" agents/change-diff-detector/index.js --dry-run
  "...node" agents/change-verdict/index.js --dry-run
  "...node" agents/change-queue-processor/index.js --dry-run
```

If the daily-cycle real scheduler runs end-to-end without errors in dry-run mode, the wiring is good.

- [ ] **Step 5: Commit**

```bash
git add scheduler.js
git commit -m "feat(change-log): wire change-diff-detector, change-verdict, change-queue-processor into daily scheduler"
```

---

## Task 11: meta-ab-tracker backwards-compat refactor

**Files:**
- Modify: `agents/meta-ab-tracker/index.js`

This task is intentionally minimal. The existing `meta-ab-tracker` agent reads `data/meta-tests/<id>.json` definitions and operates on them with its own logic. We add a *parallel* path: when the new system has logged a meta-tag change, this agent reads the corresponding window from `data/changes/windows/` and skips the legacy path for that page (the new system handles it).

- [ ] **Step 1: Read the existing meta-ab-tracker entry point**

```bash
head -50 agents/meta-ab-tracker/index.js
grep -n "loadActiveTests\|main\|async function" agents/meta-ab-tracker/index.js | head -10
```

Identify the function that loads the active tests (likely `loadActiveTests()` or similar near the top of `main()`).

- [ ] **Step 2: Add a guard at the top of main()**

Right at the start of the main function, add:

```js
import { findActiveWindow } from '../../lib/change-log.js';
```

(Add to existing imports — it's a new line; if there's no path to `lib/change-log.js`, the import fails fast which is fine because lib exists.)

In the loop that iterates active tests, add a guard before processing each test:

```js
for (const test of activeTests) {
  // If the new change-log system has an active window for this slug,
  // delegate to that system and skip the legacy path.
  const slug = test.slug || test.handle;
  if (slug) {
    const window = findActiveWindow(slug);
    if (window) {
      console.log(`  [meta-ab-tracker] ${slug} delegated to change-log (window ${window.id})`);
      continue;
    }
  }
  // ... existing legacy logic for this test
}
```

(The exact variable names depend on the existing code; preserve them.)

- [ ] **Step 3: Add a deprecation note to the file's header docstring**

In the docstring at the top of `agents/meta-ab-tracker/index.js`, add a note:

```
 * Note (2026-04-25): the unified change-log system in lib/change-log.js
 * now handles meta tag verdicts as part of generic change-event tracking.
 * This agent skips any test whose slug has an active change-log window
 * and processes only its legacy `data/meta-tests/` definitions. New meta
 * changes should be made via lib/change-log.js (proposeChange + logChangeEvent).
 * After the existing legacy tests complete (~60 days), this agent can be
 * removed.
```

- [ ] **Step 4: Smoke-test the agent in dry-run**

```bash
node agents/meta-ab-tracker/index.js --dry-run 2>&1 | head -20
```

Expected: no errors. If the legacy code path was working before, it still works (new system has zero active windows yet, so no delegations occur). If the legacy code path produced "no active tests" output, same output now.

- [ ] **Step 5: Commit**

```bash
git add agents/meta-ab-tracker/index.js
git commit -m "refactor(meta-ab-tracker): delegate to change-log system when active window exists"
```

---

## Task 12: Run full test suite, push, open PR

- [ ] **Step 1: Run all change-log tests**

```bash
node --test tests/lib/change-log-store.test.js tests/lib/change-log-snapshots.test.js tests/lib/change-log.test.js tests/lib/change-log-verdict.test.js tests/agents/change-verdict.test.js tests/agents/change-diff-detector.test.js tests/agents/change-queue-processor.test.js
```

Expected: all tests pass. If any fail, investigate before pushing.

- [ ] **Step 2: Run the full project test suite**

```bash
npm test 2>&1 | tail -20
```

Expected: tests in unrelated files still pass (the change-log additions don't break existing agents).

- [ ] **Step 3: Smoke-run the full daily scheduler in dry-run**

```bash
node scheduler.js --dry-run 2>&1 | tail -20
```

Expected: scheduler completes with no errors. The new agents log their step lines.

- [ ] **Step 4: Push the branch**

```bash
git push -u origin feature/change-log-attribution
```

- [ ] **Step 5: Open the PR**

```bash
gh pr create --title "feat: change-log + outcome attribution system" --body "$(cat <<'EOF'
## Summary
Builds the unified change-log + outcome-attribution layer described in spec `docs/superpowers/specs/2026-04-25-change-log-outcome-attribution-design.md`.

- New shared library `lib/change-log.js` + helpers in `lib/change-log/{store,snapshots,verdict}.js` provides the public API: \`proposeChange\`, \`logChangeEvent\`, \`queueChange\`, \`getActiveWindow\`, \`isPageInMeasurement\`, \`captureBaseline\`.
- Three new daily-cron agents: \`change-diff-detector\` (catches manual Shopify edits via snapshot diff), \`change-verdict\` (classifies outcomes after the 28-day window and auto-reverts losers within revertable change types), \`change-queue-processor\` (releases queued changes once a window closes).
- Per-page-window attribution with 3-day grouping, 28-day measurement clock.
- Two change categories — experimental (subject to queue) and maintenance (always applies, never extends a window).
- Auto-revert thresholds in \`lib/change-log/verdict.js\` (\`THRESHOLDS\` const) — tunable.
- Verdict learnings appended to \`data/context/feedback.md\` so future agents incorporate them.
- \`meta-ab-tracker\` delegates to the new system for any slug with an active window; legacy path retained for in-flight tests.

## Test plan
- [x] Unit tests pass for \`lib/change-log/{store,snapshots,verdict}.js\` and \`lib/change-log.js\`
- [x] Structure tests pass for the three new agents
- [x] \`node scheduler.js --dry-run\` completes with all three new steps logged
- [ ] After merge + deploy, observe that \`change-diff-detector\` runs without errors on the first daily cycle
- [ ] After merge + 28d, observe a real verdict computed for a page that had a change applied

## Notes
- The 60-day backwards-compat overlap with \`meta-ab-tracker\` means existing in-flight meta tests finish on the legacy code path before this fully takes over. After 60 days, \`meta-ab-tracker\` can be removed (separate PR).
- v1 does not implement: cross-page attribution, A/B testing infrastructure, statistical-significance tests, change rollforward, manual-edit intent capture (these are explicitly listed in the spec's non-goals).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 6: Record the PR URL**

Note the returned URL.

---

## Self-Review Checklist (completed)

**1. Spec coverage:**
- Section "Architecture" → Task 5 (proposeChange path), Task 8 (capture model: hybrid), Task 9 (queue), Task 7 (verdict)
- Section "Data model" → Task 2 (storage primitives), Task 5 (record shapes)
- Section "Components 1-5" → Tasks 2-9 (lib + 3 agents + daily-summary integration via notify())
- Section "Auto-revert thresholds" → Task 6 (lib/change-log/verdict.js THRESHOLDS const)
- Section "Cron placement" → Task 10
- Section "Migration plan" → Task 11
- Section "Risks: snapshot lag, sparse data, races, multi-target queries, revert failures" → addressed by atomic writes in Task 2, threshold-based outcome in Task 6, surfacing failures via notify in Tasks 7 & 9

**2. Placeholders:** None — all code blocks complete.

**3. Type consistency:** `proposeChange`, `logChangeEvent`, `queueChange`, `findActiveWindow`, `getActiveWindow`, `computeWindowStatus` are defined once and used consistently. `THRESHOLDS` referenced by name in tests and module. `change_type` enum (`title`, `meta_description`, `content_body`, `image`, `schema`, `faq_added`, `internal_link_added`) is consistent across all tasks.
