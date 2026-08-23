// tests/lib/keyword-index-untapped-integration.test.js
//
// Sibling of tests/lib/demand-questions-leaks-integration.test.js. Same producer
// agent (gsc-query-miner), same "keyword vs query" landmine documented at the top
// of lib/gsc.js, but a DIFFERENT feed: untapped-candidates.json instead of
// impression-leaks.json, and a DIFFERENT consumer chain: lib/keyword-index/
// dump-readers.js -> lib/keyword-index/merge.js, feeding the next
// keyword-index-builder run instead of demand-miner.
//
// The real chain (see agents/gsc-query-miner/index.js's main()):
//   lib/gsc.js's getTopKeywords rows ({ keyword, impressions, clicks, position })
//     -> tagQueries (agents/gsc-query-miner/lib/index-tagger.js) adds validation_source
//     -> buildUntappedCandidates (same file) shapes { keyword, impressions, position, reason }
//     -> written as { generated_at, source, candidates } to
//        data/reports/gsc-query-miner/untapped-candidates.json
//     -> readUntappedCandidates + buildUntappedMap (lib/keyword-index/dump-readers.js)
//        parse it back and normalize it into a Map keyed by normalize(keyword)
//     -> mergeSources (lib/keyword-index/merge.js) folds that Map into
//        data/keyword-index.json entries, tagged validation_source: 'gsc_untapped'
//
// No existing test ran a real-shaped row through this whole seam: index-tagger.js's
// own tests fixture their own rows, dump-readers.test.js hand-writes
// untapped-candidates.json fixtures directly (never runs buildUntappedCandidates),
// and merge.test.js hand-builds its `untapped` Map directly (never runs
// buildUntappedMap). Each side's fixture matches today by convention, not by proof.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { tagQueries, buildUntappedCandidates } from '../../agents/gsc-query-miner/lib/index-tagger.js';
import { readUntappedCandidates, buildUntappedMap } from '../../lib/keyword-index/dump-readers.js';
import { mergeSources } from '../../lib/keyword-index/merge.js';

// The real row shape lib/gsc.js's getTopKeywords produces (see that file's own
// field-naming-split docstring): { keyword, clicks, impressions, ctr, position }.
// findImpressionLeaks (a local function in gsc-query-miner/index.js) only
// filters/sorts these — it renames nothing — so this is still the input shape
// buildUntappedCandidates actually receives in production.
const REAL_GSC_LEAK_ROWS = [
  { keyword: 'natural deodorant for sensitive skin', clicks: 0, impressions: 900, ctr: 0, position: 22.4 },
  { keyword: 'coconut oil lotion for eczema', clicks: 0, impressions: 400, ctr: 0, position: 31.1 },
];

test('a real-shaped GSC leak row survives buildUntappedCandidates -> untapped-candidates.json -> readUntappedCandidates -> buildUntappedMap -> mergeSources with its actual keyword text', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'untapped-integration-'));
  try {
    // Nothing is in the keyword index yet, so tagQueries tags every row untargeted
    // (validation_source: null) — exactly the state that makes a leak eligible to
    // become an untapped candidate.
    const emptyIndex = { keywords: {} };
    const leaksAll = tagQueries(REAL_GSC_LEAK_ROWS, emptyIndex);

    const candidates = buildUntappedCandidates(leaksAll, [], emptyIndex, { minImpr: 50 });
    assert.equal(candidates.length, 2, `expected both leaks to qualify as untapped candidates, got ${JSON.stringify(candidates)}`);

    // Write the feed exactly as agents/gsc-query-miner/index.js's main() does.
    const reportsDir = join(tmp, 'data', 'reports', 'gsc-query-miner');
    mkdirSync(reportsDir, { recursive: true });
    const now = '2026-08-21T00:00:00.000Z';
    writeFileSync(join(reportsDir, 'untapped-candidates.json'), JSON.stringify({
      generated_at: now,
      source: 'gsc-query-miner',
      candidates,
    }, null, 2));

    // Read it back through the real consumer-side reader.
    const { candidates: readBack, status } = readUntappedCandidates(tmp, { now: new Date(now) });
    assert.equal(status, 'ok');
    assert.equal(readBack.length, 2);
    for (const c of readBack) {
      assert.equal(typeof c.keyword, 'string');
      assert.ok(c.keyword.length > 0, 'candidate must carry real keyword text, not a dropped key');
    }

    const untappedMap = buildUntappedMap(readBack);
    assert.equal(untappedMap.size, 2);

    // Feed into the real merge — this is what the next keyword-index-builder run does.
    const merged = mergeSources({ amazon: {}, gsc: {}, ga4Map: {}, clusters: {}, untapped: untappedMap });
    const entries = Object.values(merged);
    assert.equal(entries.length, 2, `expected both untapped candidates to survive into merged entries, got ${JSON.stringify(entries)}`);

    const keywords = entries.map((e) => e.keyword).sort();
    assert.deepEqual(keywords, [
      'coconut oil lotion for eczema',
      'natural deodorant for sensitive skin',
    ]);
    for (const e of entries) {
      assert.equal(e.validation_source, 'gsc_untapped');
      assert.equal(e.untapped_reason, 'impression_leak');
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a candidate with no keyword text is silently dropped by buildUntappedMap, not merged as a phantom entry', () => {
  // Pins the contract dump-readers.js relies on: readUntappedCandidates already
  // filters out candidates with no keyword text (see its own `typeof c.keyword ===
  // 'string' && c.keyword.trim()` guard), so this exercises buildUntappedMap
  // directly against the shape a broken producer (dropped/undefined `keyword` key)
  // would emit if that filter were ever bypassed.
  const brokenCandidates = [{ keyword: undefined, impressions: 500, position: 20, reason: 'impression_leak' }];
  const map = buildUntappedMap(brokenCandidates);
  assert.equal(map.size, 0, 'a candidate with no keyword text must not produce a map entry');

  const merged = mergeSources({ amazon: {}, gsc: {}, ga4Map: {}, clusters: {}, untapped: map });
  assert.deepEqual(Object.keys(merged), []);
});
