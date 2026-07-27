# GSC Query Miner Revival Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Schedule `gsc-query-miner` weekly and close its orphaned `untapped-candidates.json` loop, so zero-click impression leaks reach the keyword index as `gsc_untapped` keywords that drive page optimization but never new content.

**Architecture:** The miner already writes `data/reports/gsc-query-miner/untapped-candidates.json`; nothing reads it. We add a reader in `lib/keyword-index/dump-readers.js` (same pattern as the Amazon dump readers), a third validation source in `lib/keyword-index/merge.js` that fires only when the existing two do not, and a one-line gate in `lib/keyword-index/consumer.js` that keeps these keywords away from `content-strategist`. Then we schedule the miner ahead of the builder in `scheduler.js`.

**Tech Stack:** Node.js ESM, `node:test` + `node:assert/strict`, no new dependencies.

## Global Constraints

- **Branch:** all work on `feature/gsc-query-miner-revival` (already created). Never commit to `main`. Merge via `gh pr create`.
- **Additive only:** the `amazon` and `gsc_ga4` rules in `classifyValidationSource` must not change behavior for any keyword that qualifies today. `gsc_untapped` fires last.
- **Key normalization:** `mergeSources` keys on `normalize()` from `lib/keyword-index/normalize.js`. The miner writes raw GSC query text. Every candidate keyword MUST pass through `normalize()` before use as a key, or lookups miss silently and the build reports success while admitting nothing.
- **Staleness is measured from `generated_at` inside the JSON, never file mtime.** Git checkout rewrites mtimes — that is exactly why the server's March file dates looked like runs and hid a dormant agent for four months.
- **Max age:** 21 days.
- **Test style:** `node:test`, `mkdtempSync` + `rmSync` for temp dirs, matching `tests/lib/keyword-index/dump-readers.test.js`.
- **Run the full suite** (`npm test`) before the final commit. Baseline on this branch is 963 tests, 962 passing; the single pre-existing failure is `tests/agents/priority-tuner.test.js` (stale local `data/reports/seo-impact/` trips a freshness gate — environmental, unrelated).

---

### Task 1: Read the untapped-candidates file

**Files:**
- Modify: `lib/keyword-index/dump-readers.js` (append after `parseSqpDump`, ends line 81)
- Test: `tests/lib/keyword-index/dump-readers.test.js` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `readUntappedCandidates(rootDir, { maxAgeDays = 21, now = new Date() }) -> { candidates: Array<{keyword, impressions, position, reason}>, status: 'ok'|'missing'|'stale'|'malformed', ageDays: number|null }`. Task 2 consumes the candidate array; Task 5 consumes `status` for logging.

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/keyword-index/dump-readers.test.js`. Add `readUntappedCandidates` to the existing import on line 7.

```javascript
function writeCandidates(tmp, generatedAt, candidates) {
  const dir = join(tmp, 'data', 'reports', 'gsc-query-miner');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'untapped-candidates.json'), JSON.stringify({
    generated_at: generatedAt,
    source: 'gsc-query-miner',
    candidates,
  }));
  return dir;
}

const NOW = new Date('2026-07-27T00:00:00Z');
const SAMPLE = [{ keyword: 'coconut for the skin', impressions: 536, position: 11.8, reason: 'impression_leak' }];

test('readUntappedCandidates returns candidates from a fresh file', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'untapped-'));
  try {
    writeCandidates(tmp, '2026-07-26T00:00:00Z', SAMPLE);
    const r = readUntappedCandidates(tmp, { now: NOW });
    assert.equal(r.status, 'ok');
    assert.equal(r.candidates.length, 1);
    assert.equal(r.candidates[0].keyword, 'coconut for the skin');
    assert.equal(r.ageDays, 1);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('readUntappedCandidates reports missing when the file is absent', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'untapped-'));
  try {
    const r = readUntappedCandidates(tmp, { now: NOW });
    assert.equal(r.status, 'missing');
    assert.deepEqual(r.candidates, []);
    assert.equal(r.ageDays, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('readUntappedCandidates rejects a file older than maxAgeDays, returning no candidates', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'untapped-'));
  try {
    writeCandidates(tmp, '2026-06-01T00:00:00Z', SAMPLE);
    const r = readUntappedCandidates(tmp, { now: NOW });
    assert.equal(r.status, 'stale');
    assert.deepEqual(r.candidates, []);
    assert.equal(r.ageDays, 56);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('readUntappedCandidates measures age from generated_at, not file mtime', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'untapped-'));
  try {
    const dir = writeCandidates(tmp, '2026-06-01T00:00:00Z', SAMPLE);
    // Touch the file to "now" — a git checkout does exactly this.
    const f = join(dir, 'untapped-candidates.json');
    utimesSync(f, NOW, NOW);
    const r = readUntappedCandidates(tmp, { now: NOW });
    assert.equal(r.status, 'stale');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('readUntappedCandidates treats malformed JSON as malformed, not a throw', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'untapped-'));
  try {
    const dir = join(tmp, 'data', 'reports', 'gsc-query-miner');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'untapped-candidates.json'), '{ not json');
    const r = readUntappedCandidates(tmp, { now: NOW });
    assert.equal(r.status, 'malformed');
    assert.deepEqual(r.candidates, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('readUntappedCandidates treats a missing generated_at as malformed', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'untapped-'));
  try {
    const dir = join(tmp, 'data', 'reports', 'gsc-query-miner');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'untapped-candidates.json'), JSON.stringify({ candidates: SAMPLE }));
    const r = readUntappedCandidates(tmp, { now: NOW });
    assert.equal(r.status, 'malformed');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/lib/keyword-index/dump-readers.test.js`
Expected: FAIL — `readUntappedCandidates is not a function` (or an import error).

- [ ] **Step 3: Implement the reader**

Append to `lib/keyword-index/dump-readers.js`:

```javascript
const UNTAPPED_REL = 'data/reports/gsc-query-miner/untapped-candidates.json';

/**
 * Read the gsc-query-miner's untapped-candidates feed.
 *
 * Age is measured from the `generated_at` field inside the file, never from
 * mtime: a git checkout rewrites mtimes, which is how a dormant agent's stale
 * output previously passed for fresh. A file past `maxAgeDays` returns no
 * candidates, so a dead miner stops injecting demand instead of injecting
 * months-old demand forever.
 *
 * Never throws. A missing or unreadable feed is an absent enhancement, not a
 * build failure — same contract as the optional BA dump.
 */
export function readUntappedCandidates(rootDir = process.cwd(), { maxAgeDays = 21, now = new Date() } = {}) {
  const none = (status, ageDays = null) => ({ candidates: [], status, ageDays });
  const path = join(rootDir, UNTAPPED_REL);
  if (!existsSync(path)) return none('missing');

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return none('malformed');
  }

  const generatedAt = parsed?.generated_at ? Date.parse(parsed.generated_at) : NaN;
  if (Number.isNaN(generatedAt)) return none('malformed');
  if (!Array.isArray(parsed.candidates)) return none('malformed');

  const ageDays = Math.floor((now.getTime() - generatedAt) / 86400000);
  if (ageDays > maxAgeDays) return none('stale', ageDays);

  const candidates = parsed.candidates.filter((c) => c && typeof c.keyword === 'string' && c.keyword.trim());
  return { candidates, status: 'ok', ageDays };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/lib/keyword-index/dump-readers.test.js`
Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add lib/keyword-index/dump-readers.js tests/lib/keyword-index/dump-readers.test.js
git commit -m "feat(keyword-index): read untapped-candidates with a generated_at staleness guard

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Admit untapped candidates as a third validation source

**Files:**
- Modify: `lib/keyword-index/merge.js:20-57` (`classifyValidationSource`, `mergeSources`)
- Test: `tests/lib/keyword-index/merge.test.js` (append)

**Interfaces:**
- Consumes: the candidate array from Task 1.
- Produces: `classifyValidationSource(entry, untapped)` where `untapped` is a `Map<normalizedKey, {impressions, position, reason}>`; `mergeSources({ amazon, gsc, ga4Map, clusters, untapped })`. Entries gain `validation_source: 'gsc_untapped'` and `untapped_reason: 'impression_leak' | 'untapped_cluster'`. Task 3 gates on the `validation_source` value; Task 5 builds the Map.

- [ ] **Step 1: Write the failing tests**

Append to `tests/lib/keyword-index/merge.test.js`:

```javascript
const UNTAPPED = new Map([
  ['coconut for the skin', { impressions: 536, position: 11.8, reason: 'impression_leak' }],
]);

test('classifyValidationSource is "gsc_untapped" when the key is untapped and nothing else qualifies', () => {
  const entry = { amazon: null, gsc: { impressions: 536, clicks: 0 }, ga4: { conversions: 0 } };
  const r = classifyValidationSource(entry, UNTAPPED, 'coconut for the skin');
  assert.equal(r, 'gsc_untapped');
});

test('classifyValidationSource still returns null for a non-untapped key with no signal', () => {
  const entry = { amazon: null, gsc: { impressions: 536, clicks: 0 }, ga4: { conversions: 0 } };
  const r = classifyValidationSource(entry, UNTAPPED, 'some other query');
  assert.equal(r, null);
});

test('classifyValidationSource prefers "amazon" over "gsc_untapped" for the same key', () => {
  const entry = { amazon: { clicks: 5, purchases: 0 }, gsc: null, ga4: null };
  const r = classifyValidationSource(entry, UNTAPPED, 'coconut for the skin');
  assert.equal(r, 'amazon');
});

test('classifyValidationSource prefers "gsc_ga4" over "gsc_untapped" for the same key', () => {
  const entry = { amazon: null, gsc: { impressions: 536 }, ga4: { conversions: 4 } };
  const r = classifyValidationSource(entry, UNTAPPED, 'coconut for the skin');
  assert.equal(r, 'gsc_ga4');
});

test('classifyValidationSource keeps its old behavior when no untapped map is passed', () => {
  assert.equal(classifyValidationSource({ amazon: null, gsc: {}, ga4: { conversions: 0 } }), null);
  assert.equal(classifyValidationSource({ amazon: { clicks: 3 }, gsc: null, ga4: null }), 'amazon');
});

test('mergeSources admits an untapped key that has a GSC aggregate but no conversions', () => {
  const gsc = { 'coconut for the skin': { impressions: 536, clicks: 0, ctr: 0, position: 11.8, top_page: '/blogs/news/x', pages: [] } };
  const out = mergeSources({ amazon: {}, gsc, ga4Map: {}, clusters: {}, untapped: UNTAPPED });
  const e = out['coconut-for-the-skin'];
  assert.ok(e, 'entry should exist');
  assert.equal(e.validation_source, 'gsc_untapped');
  assert.equal(e.untapped_reason, 'impression_leak');
  assert.equal(e.amazon, null);
  assert.equal(e.gsc.impressions, 536);
});

test('mergeSources admits an untapped key with no GSC aggregate by synthesising one', () => {
  const out = mergeSources({ amazon: {}, gsc: {}, ga4Map: {}, clusters: {}, untapped: UNTAPPED });
  const e = out['coconut-for-the-skin'];
  assert.ok(e, 'entry should exist even with no GSC row');
  assert.equal(e.validation_source, 'gsc_untapped');
  assert.equal(e.gsc.impressions, 536);
  assert.equal(e.gsc.clicks, 0);
  assert.equal(e.gsc.position, 11.8);
});

test('mergeSources without an untapped map produces the same entries as before', () => {
  const gsc = { 'coconut for the skin': { impressions: 536, clicks: 0, ctr: 0, position: 11.8, top_page: '/x', pages: [] } };
  const out = mergeSources({ amazon: {}, gsc, ga4Map: {}, clusters: {} });
  assert.equal(Object.keys(out).length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/lib/keyword-index/merge.test.js`
Expected: FAIL — `gsc_untapped` assertions fail (returns `null`), and the `mergeSources` entries are `undefined`.

- [ ] **Step 3: Implement**

Replace `classifyValidationSource` and `mergeSources` in `lib/keyword-index/merge.js`:

```javascript
export function classifyValidationSource(entry, untapped = null, key = null) {
  const amz = entry.amazon;
  if (amz && ((amz.clicks ?? 0) > 0 || (amz.purchases ?? 0) > 0)) return 'amazon';
  const ga = entry.ga4;
  if (!amz && ga && (ga.conversions ?? 0) > 0) return 'gsc_ga4';
  // Third source, checked last so no keyword that qualifies above is reclassified.
  // These have NOT cleared the revenue bar the other two encode — they are demand
  // Google already shows us for and nobody clicks. See the 2026-07-27 spec.
  if (untapped && key && untapped.has(key)) return 'gsc_untapped';
  return null;
}

export function mergeSources({ amazon, gsc, ga4Map, clusters, untapped = null }) {
  const allKeys = new Set([
    ...Object.keys(amazon || {}),
    ...Object.keys(gsc || {}),
    ...(untapped ? untapped.keys() : []),
  ]);
  const out = {};
  for (const key of allKeys) {
    const amz = amazon?.[key] || null;
    const cand = untapped?.get(key) || null;
    // An untapped candidate with no GSC row still carries its own impressions
    // and position from the miner — synthesise the aggregate so consumers see
    // the demand rather than a null.
    const g = gsc?.[key] || (cand
      ? { impressions: cand.impressions ?? 0, clicks: 0, ctr: 0, position: cand.position ?? null, top_page: null, pages: [] }
      : null);
    const ga = g?.top_page ? ga4ForUrl(ga4Map, g.top_page) : null;
    const candidate = { amazon: amz, gsc: g, ga4: ga };
    const validation_source = classifyValidationSource(candidate, untapped, key);
    if (!validation_source) continue;

    const slug = toSlug(key);
    const keyword = amz?.query || key;
    const priorCluster = clusters?.[key];
    const cluster = (priorCluster && priorCluster !== 'unclustered')
      ? priorCluster
      : assignCluster(keyword);
    out[slug] = {
      keyword,
      slug,
      cluster,
      validation_source,
      amazon: amz,
      gsc: g,
      ga4: ga,
      market: null,
    };
    if (validation_source === 'gsc_untapped' && cand?.reason) {
      out[slug].untapped_reason = cand.reason;
    }
  }
  return out;
}
```

Also update the file's header docstring qualification list to add:
```
 *   - gsc_untapped (only if neither above): key present in the miner's
 *     untapped-candidates feed. Demand we rank for but nobody clicks.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/lib/keyword-index/merge.test.js`
Expected: PASS, including all pre-existing tests — proof the two original rules are unchanged.

- [ ] **Step 5: Commit**

```bash
git add lib/keyword-index/merge.js tests/lib/keyword-index/merge.test.js
git commit -m "feat(keyword-index): admit impression leaks as gsc_untapped

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Gate untapped keywords out of new-content discovery

**Files:**
- Modify: `lib/keyword-index/consumer.js:120-142` (`unmappedIndexEntries`)
- Test: `tests/lib/keyword-index/consumer.test.js` (append)

**Interfaces:**
- Consumes: the `validation_source: 'gsc_untapped'` value produced by Task 2.
- Produces: no signature change. `unmappedIndexEntries` simply never returns a `gsc_untapped` entry.

- [ ] **Step 1: Write the failing test**

Append to `tests/lib/keyword-index/consumer.test.js`:

```javascript
const gatedFixture = {
  keywords: {
    'natural-deodorant':    { slug: 'natural-deodorant',    keyword: 'natural deodorant',    validation_source: 'amazon',       amazon: { purchases: 100 } },
    'natural-bar-soap':     { slug: 'natural-bar-soap',     keyword: 'natural bar soap',     validation_source: 'gsc_ga4',      ga4: { conversions: 5 } },
    'coconut-for-the-skin': { slug: 'coconut-for-the-skin', keyword: 'coconut for the skin', validation_source: 'gsc_untapped', gsc: { impressions: 536 } },
  },
};

test('unmappedIndexEntries excludes gsc_untapped entries so content-strategist cannot brief them', () => {
  const out = unmappedIndexEntries(gatedFixture, new Set());
  assert.ok(!out.some((e) => e.slug === 'coconut-for-the-skin'), 'gsc_untapped must not reach new-content discovery');
});

test('unmappedIndexEntries still returns amazon and gsc_ga4 entries alongside a gated one', () => {
  const out = unmappedIndexEntries(gatedFixture, new Set());
  assert.deepEqual(out.map((e) => e.slug), ['natural-deodorant', 'natural-bar-soap']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/lib/keyword-index/consumer.test.js`
Expected: FAIL — `coconut-for-the-skin` is returned.

- [ ] **Step 3: Implement**

In `lib/keyword-index/consumer.js`, inside the `for` loop of `unmappedIndexEntries`, immediately after the `if (!e?.slug) continue;` line:

```javascript
    // gsc_untapped = demand we rank for but nobody clicks. It has not cleared
    // the index's revenue bar, so it may drive optimization of existing pages
    // but must never commission a new one — top-of-funnel content is gated
    // behind the Traffic phase. Delete this line when that phase opens.
    if (e.validation_source === 'gsc_untapped') continue;
```

Also extend the function's docstring to state that `gsc_untapped` entries are excluded and why.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/lib/keyword-index/consumer.test.js`
Expected: PASS, including pre-existing sort-order tests.

- [ ] **Step 5: Commit**

```bash
git add lib/keyword-index/consumer.js tests/lib/keyword-index/consumer.test.js
git commit -m "feat(keyword-index): gate gsc_untapped out of new-content discovery

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Stop the report's display cap from truncating the data feed

**Files:**
- Modify: `agents/gsc-query-miner/index.js:85-90` (`findImpressionLeaks`) and the `main()` analysis block around lines 277-300
- Test: `tests/agents/gsc-query-miner.test.js` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `findImpressionLeaks(queries, limit = Infinity)`. The report path passes no limit and slices for display itself; `buildUntappedCandidates` receives the full set.

**Context:** `findImpressionLeaks` slices to 50 internally, and `buildUntappedCandidates` derives from that already-truncated array — a cap meant to keep a markdown table readable is silently bounding a machine-readable feed. Note that `formatLeaks` already slices to 30 for display, so removing the 50-cap does not enlarge the Claude prompt; token cost is unchanged.

- [ ] **Step 1: Write the failing test**

Append to `tests/agents/gsc-query-miner.test.js`:

```javascript
import { buildUntappedCandidates } from '../../agents/gsc-query-miner/lib/index-tagger.js';

test('buildUntappedCandidates is not bounded at 50 when the leak set is larger', () => {
  const leaks = Array.from({ length: 80 }, (_, i) => ({
    keyword: `leak query ${i}`,
    impressions: 500 - i,
    clicks: 0,
    position: 40,
  }));
  const out = buildUntappedCandidates(leaks, [], null, { minImpr: 50 });
  assert.equal(out.length, 80, 'every qualifying leak should reach the feed');
});
```

- [ ] **Step 2: Run test to verify it passes already, then find the real cap**

Run: `node --test tests/agents/gsc-query-miner.test.js`
Expected: PASS. `buildUntappedCandidates` itself has no cap — the truncation happens upstream in `findImpressionLeaks`, which is not exported. This test is a regression guard for the pure function; the upstream fix is verified in Step 4 by running the agent.

- [ ] **Step 3: Implement the upstream fix**

In `agents/gsc-query-miner/index.js`, change `findImpressionLeaks` to take a limit:

```javascript
function findImpressionLeaks(queries, limit = Infinity) {
  return queries
    .filter((q) => q.impressions >= minImpr && q.clicks === 0)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit);
}
```

In `main()`, replace the single `rawLeaks` line with two, and feed the full set to the candidate builder while the report keeps its 50:

```javascript
  const rawLeaksAll = findImpressionLeaks(allQueries);          // full set — data feed
  const rawLeaks = rawLeaksAll.slice(0, 50);                    // capped — report/prompt
```

Then, where the tagging happens, tag both:

```javascript
  const leaks = tagQueries(rawLeaks, idx);
  const leaksAll = tagQueries(rawLeaksAll, idx);
```

and change the `buildUntappedCandidates` call to use the full set:

```javascript
    const untapped = buildUntappedCandidates(leaksAll, clusters, idx, { minImpr });
```

Leave `generateAnalysis(leaks, ...)` and the report body on the capped `leaks`. Update the console summary line to report the true count:

```javascript
  console.log(`    Impression leaks:        ${leaksAll.length} queries (${leaksAll.reduce((s, q) => s + q.impressions, 0).toLocaleString()} impressions wasted)`);
```

- [ ] **Step 4: Verify against the live agent**

Run: `node agents/gsc-query-miner/index.js`
Expected: the "Impression leaks" summary count is now greater than 50 (the 2026-07-27 run reported exactly 50, the cap), and "Untapped candidates: N written" reports N greater than the previous 47. Confirm the report table still shows 30 rows:

```bash
grep -c '^| ' data/reports/gsc-query-miner/gsc-query-mining-report.md
```

- [ ] **Step 5: Commit**

```bash
git add agents/gsc-query-miner/index.js tests/agents/gsc-query-miner.test.js data/reports/gsc-query-miner/
git commit -m "fix(gsc-query-miner): keep the report's display cap out of the data feed

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Wire the builder stage and schedule the miner

**Files:**
- Modify: `agents/keyword-index-builder/index.js:24` (import), `:154-172` (new stage after the GSC stage, before Stage 4 merge), `:183-184` (source tally)
- Modify: `scheduler.js` (insert before the `keyword-index-builder` step, currently line 233)
- Test: `tests/agents/keyword-index-builder.test.js` (append)

**Interfaces:**
- Consumes: `readUntappedCandidates` (Task 1), `mergeSources({..., untapped})` (Task 2).
- Produces: a `gsc_untapped` count in `keyword-index.json`'s `by_validation_source`.

- [ ] **Step 1: Write the failing test**

Append to `tests/agents/keyword-index-builder.test.js`:

```javascript
import { normalize } from '../../lib/keyword-index/normalize.js';
import { mergeSources } from '../../lib/keyword-index/merge.js';

// The builder converts the miner's raw query strings into normalized Map keys.
// This is the step that silently no-ops if normalization is skipped.
function buildUntappedMap(candidates) {
  const m = new Map();
  for (const c of candidates || []) {
    const key = normalize(c.keyword);
    if (key) m.set(key, { impressions: c.impressions, position: c.position, reason: c.reason });
  }
  return m;
}

test('untapped candidates are normalized before use as merge keys', () => {
  // Raw GSC text with trailing punctuation and mixed case — normalize() strips both.
  const candidates = [{ keyword: '  Coconut For The Skin.  ', impressions: 536, position: 11.8, reason: 'impression_leak' }];
  const untapped = buildUntappedMap(candidates);
  assert.ok(untapped.has('coconut for the skin'), 'key must be normalized');

  const out = mergeSources({ amazon: {}, gsc: {}, ga4Map: {}, clusters: {}, untapped });
  assert.ok(out['coconut-for-the-skin'], 'a raw-text candidate must still produce an entry');
  assert.equal(out['coconut-for-the-skin'].validation_source, 'gsc_untapped');
});

test('an empty candidate list produces no untapped entries', () => {
  const out = mergeSources({ amazon: {}, gsc: {}, ga4Map: {}, clusters: {}, untapped: buildUntappedMap([]) });
  assert.equal(Object.keys(out).length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/agents/keyword-index-builder.test.js`
Expected: FAIL if Task 2 is not yet merged into the branch; PASS once it is. If it passes immediately, that is correct — this test guards the normalization contract, and Step 3 makes the builder honor it.

- [ ] **Step 3: Implement the builder stage**

Add `readUntappedCandidates` to the existing `dump-readers.js` import on line 24:

```javascript
import { findLatestSqpDump, findLatestBaDump, parseSqpDump, readUntappedCandidates } from '../../lib/keyword-index/dump-readers.js';
```

Add `normalize` to the imports:

```javascript
import { normalize } from '../../lib/keyword-index/normalize.js';
```

Insert after the GSC-stage abort block (which ends around line 164) and before the Stage 3 GA4 join:

```javascript
  // Stage 2b: untapped candidates from gsc-query-miner.
  // These are queries with impressions and zero clicks — they can never satisfy
  // classifyValidationSource's amazon/ga4 conversion bar, so this feed is the
  // only path by which they reach the index. Optional input: a missing, stale,
  // or malformed file degrades to zero candidates and never fails the build.
  const untappedFeed = readUntappedCandidates(ROOT);
  const untapped = new Map();
  for (const c of untappedFeed.candidates) {
    const key = normalize(c.keyword);
    if (key) untapped.set(key, { impressions: c.impressions, position: c.position, reason: c.reason });
  }
  if (untappedFeed.status === 'ok') {
    console.log(`  Untapped: ${untapped.size} candidates (feed ${untappedFeed.ageDays}d old)`);
  } else {
    console.warn(`  Untapped: feed ${untappedFeed.status}${untappedFeed.ageDays != null ? ` (${untappedFeed.ageDays}d old)` : ''} — no untapped keywords this build.`);
  }
```

Pass it into the Stage 4 merge:

```javascript
  const entries = mergeSources({ amazon: amazonMap, gsc: gscMap, ga4Map, clusters, untapped });
```

Update the source tally initializer so the new source always appears, even at zero:

```javascript
  const bySource = { amazon: 0, gsc_ga4: 0, gsc_untapped: 0 };
```

- [ ] **Step 4: Run the builder locally and the full suite**

```bash
node agents/keyword-index-builder/index.js --dry-run
npm test
```

Expected: the dry run logs an `Untapped:` line; `npm test` shows 962+ passing with only the known pre-existing `priority-tuner` failure. Note: untapped candidates carry ≥100 impressions so they pass `passesEnrichThreshold` (GSC impressions > 100) and get DataForSEO volume lookups — roughly one extra batched call per build, which is negligible spend.

- [ ] **Step 5: Add the scheduler entry**

In `scheduler.js`, insert immediately **before** the `keyword-index-builder` step (currently line 233):

```javascript
// gsc-query-miner — WEEKLY (Sundays), immediately before the index build so a
// fresh untapped-candidates feed is on disk when the builder reads it. Surfaces
// queries with impressions and zero clicks, which the index's conversion-based
// qualification can never admit on its own. One Anthropic call per run.
if (new Date().getDay() === 0) {
  runStep('gsc-query-miner', `"${NODE}" agents/gsc-query-miner/index.js`);
} else {
  log('  gsc-query-miner: skipped (weekly, Sundays only)');
}
```

- [ ] **Step 6: Verify the scheduler entry parses and is ordered correctly**

```bash
node --check scheduler.js
grep -n -A2 'gsc-query-miner' scheduler.js
grep -n 'keyword-index-builder' scheduler.js
```

Expected: `node --check` is silent; the `gsc-query-miner` line number is lower than the `keyword-index-builder` line number.

- [ ] **Step 7: Commit and open the PR**

```bash
git add agents/keyword-index-builder/index.js scheduler.js tests/agents/keyword-index-builder.test.js
git commit -m "feat(keyword-index): ingest untapped candidates; schedule the miner weekly

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
git push -u origin feature/gsc-query-miner-revival
gh pr create --title "feat: revive gsc-query-miner and close the untapped-candidates loop" --body "$(cat <<'EOF'
## Summary

`agents/gsc-query-miner` has never been scheduled — it appears nowhere in `scheduler.js` in the repo's history, nor in the server crontab. It also writes `untapped-candidates.json` "for the next index build to ingest," which nothing ingests.

A live run found **50 impression leaks carrying 15,037 impressions and zero clicks**, led by `coconut lotion` (1,111 impressions, position 30) on the SKU with a paid engine behind it.

## Why the index cannot see these on its own

`classifyValidationSource` admits a keyword only on Amazon clicks/purchases or GA4 conversions on its top page. A zero-click query produces no sessions, so no conversions, so it is never admitted — the index is blind by construction to impression leaks. Of the miner's 47 candidates, 41 were absent from the live index.

## What changed

- `readUntappedCandidates` in `lib/keyword-index/dump-readers.js`, with a 21-day staleness guard measured from `generated_at` rather than mtime (a git checkout rewrites mtimes — that is how this agent looked alive for four months)
- `classifyValidationSource` gains `gsc_untapped`, checked last so nothing that qualifies today is reclassified
- `unmappedIndexEntries` excludes `gsc_untapped`, so these keywords drive meta/collection/refresh optimization but can never commission a new post — top-of-funnel content stays behind the Traffic phase gate
- The miner's 50-row display cap no longer truncates the machine-readable feed
- Weekly Sunday scheduler entry, ordered before the index build

Spec: `docs/superpowers/specs/2026-07-27-gsc-query-miner-revival-design.md`
Plan: `docs/superpowers/plans/2026-07-27-gsc-query-miner-revival.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 8: Deploy and verify on the server**

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && git pull && pm2 restart seo-dashboard'
ssh root@137.184.119.230 'cd ~/seo-claude && node agents/gsc-query-miner/index.js'
ssh root@137.184.119.230 'cd ~/seo-claude && node agents/keyword-index-builder/index.js'
ssh root@137.184.119.230 'cd ~/seo-claude && node -e "
const k=require(\"./data/keyword-index.json\");
console.log(k.by_validation_source);
"'
```

Expected: `gsc_untapped` is greater than zero, and `amazon` / `gsc_ga4` counts match the prior build (52 / 1468 as of 2026-07-18). A changed `amazon` or `gsc_ga4` count means the additive-only constraint was violated — stop and investigate.

Then confirm the gate holds:

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && node --input-type=module -e "
import { readFileSync } from \"node:fs\";
import { unmappedIndexEntries } from \"./lib/keyword-index/consumer.js\";
const idx = JSON.parse(readFileSync(\"data/keyword-index.json\", \"utf8\"));
const out = unmappedIndexEntries(idx, new Set(), { limit: 500 });
console.log(\"untapped leaking into content discovery:\", out.filter((e) => e.validation_source === \"gsc_untapped\").length);
"'
```

(`require` is unavailable under `--input-type=module`; the import specifier must be
relative for Node to resolve it from the project root.)

Expected: `0`.

---

## Self-Review

Checked against the spec:

| Spec requirement | Task |
|---|---|
| Schedule the miner weekly, before the builder | 5 (Steps 5-6) |
| Builder ingests `untapped-candidates.json` | 5 (Step 3) |
| `gsc_untapped` third source, checked last | 2 |
| Existing `amazon` / `gsc_ga4` rules unchanged | 2 (precedence tests), 5 (Step 8 count check) |
| Key normalization through `normalize()` | 5 (Step 1 test, Step 3) |
| `unmappedIndexEntries` gate | 3 |
| Display cap out of the data feed | 4 |
| 21-day staleness guard from `generated_at` | 1 |
| Missing / malformed feed never fatal | 1 (status tests), 5 (Step 3 warn path) |
| Miner failure notifies as error | already implemented in the agent's existing `notify` call — no task needed |
| Success criterion: non-zero `gsc_untapped`, unchanged other counts | 5 (Step 8) |
| Success criterion: no untapped topic in briefs | 3, verified in 5 (Step 8) |

**Known deviation:** Task 4's Step 2 expects the new test to PASS rather than fail, because `buildUntappedCandidates` is already uncapped — the truncation is upstream in a non-exported function. The test is a regression guard; the real fix is verified by running the agent in Step 4. This is called out rather than faked into a red-green cycle.
