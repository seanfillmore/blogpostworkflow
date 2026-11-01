import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recomputeSnapshot,
  reconciliationMismatches,
  citationUrlsForCell,
  cellCounts,
} from '../../lib/citation-baseline-recompute.js';

const R = (t) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${t}`;
const CFG = {
  brand: { name: 'Real Skin Care', domain: 'realskincare.com' },
  competitors: [
    { name: 'Native', domain: 'nativecos.com' },
    { name: "Tom's of Maine", domain: 'tomsofmaine.com' },
  ],
};

/** A 3-run Gemini cell whose union of citation URLs is all redirects. */
const geminiCell = (tokens, { cited_runs = 0, runs_with_citations = 3 } = {}) => ({
  cited: cited_runs > 0,
  mentioned: false,
  citations: ['vertexaisearch.cloud.google.com'],
  citation_urls: tokens.map(R),
  competitor_mentions: [],
  competitor_citations: [],
  runs: 3,
  runs_ok: 3,
  runs_with_citations,
  cited_runs,
  mentioned_runs: 0,
});

const snapshotOf = (responsesPerPrompt, sources, extra = {}) => ({
  date: '2026-09-20',
  sources,
  sampling: { runs_per_core_cell: 3 },
  results: responsesPerPrompt.map((responses, i) => ({ prompt: `p${i}`, responses })),
  summary: { citation_rate: {} },
  ...extra,
});

// ── cellCounts: both snapshot generations ────────────────────────────────────

test('cellCounts reads the sampled shape directly', () => {
  assert.deepEqual(cellCounts({ cited_runs: 2, runs_with_citations: 3 }), { citedRuns: 2, citationDenominator: 3 });
});

test('cellCounts falls back to the LEGACY one-run-per-cell shape', () => {
  assert.deepEqual(cellCounts({ cited: true }), { citedRuns: 1, citationDenominator: 1 });
  assert.deepEqual(cellCounts({ cited: false }), { citedRuns: 0, citationDenominator: 1 });
  assert.deepEqual(cellCounts({ cited: null }), { citedRuns: 0, citationDenominator: 0 },
    'a cell with no citations at all is excluded from the denominator, as it always was');
  assert.deepEqual(cellCounts({}), { citedRuns: 0, citationDenominator: 0 });
});

// ── citationUrlsForCell: the three stored shapes ─────────────────────────────

test('citationUrlsForCell substitutes resolutions into citation_urls', () => {
  const resp = { citation_urls: [R('a'), 'https://www.gq.com/x'] };
  assert.deepEqual(
    citationUrlsForCell(resp, new Map([[R('a'), 'https://www.realskincare.com/x']])),
    ['https://www.realskincare.com/x', 'https://www.gq.com/x'],
  );
});

test('citationUrlsForCell prefers a STORED resolution where this run could not resolve', () => {
  const resp = {
    citation_urls: [R('a'), R('b')],
    citation_urls_resolved: ['https://www.realskincare.com/x', 'https://www.nativecos.com/y'],
  };
  // Nothing resolved live — the tokens have expired — but the snapshot kept them.
  assert.deepEqual(citationUrlsForCell(resp, new Map()), [
    'https://www.realskincare.com/x',
    'https://www.nativecos.com/y',
  ]);
});

test('citationUrlsForCell falls back to bare DOMAINS on a pre-2026-06-21 snapshot', () => {
  const resp = { citations: ['realskincare.com', 'gq.com'] };
  assert.deepEqual(citationUrlsForCell(resp, new Map()), ['realskincare.com', 'gq.com']);
});

test('citationUrlsForCell returns [] when a cell carries nothing', () => {
  assert.deepEqual(citationUrlsForCell({}, new Map()), []);
  assert.deepEqual(citationUrlsForCell(null, new Map()), []);
});

// ── the headline correction ──────────────────────────────────────────────────

test('a Gemini cell resolving to the brand moves the rate off zero', () => {
  const snap = snapshotOf(
    [
      { gemini: geminiCell(['a', 'b']) },
      { gemini: geminiCell(['c']) },
    ],
    ['gemini'],
  );
  const resolved = new Map([[R('a'), 'https://www.realskincare.com/blogs/news/x']]);
  const out = recomputeSnapshot(snap, resolved, CFG);
  const g = out.engines.gemini;

  assert.equal(g.citation_rate_original, 0, 'the stored figure is 0, as shipped');
  assert.equal(g.n, 6);
  assert.equal(g.cells_newly_cited, 1);
  assert.equal(g.citation_rate_corrected_min, parseFloat((1 / 6).toFixed(4)));
  assert.equal(g.citation_rate_corrected_max, parseFloat((3 / 6).toFixed(4)));
  assert.equal(g.exact, false, 'a 3-run cell can only be bounded, never pinned');
  assert.equal(g.changed, true);
});

test('AT ONE RUN PER CELL THE RECOMPUTATION IS EXACT — both bounds agree', () => {
  const cell = geminiCell(['a'], { runs_with_citations: 1 });
  cell.runs = 1;
  const snap = snapshotOf([{ gemini: cell }], ['gemini']);
  const out = recomputeSnapshot(snap, new Map([[R('a'), 'https://www.realskincare.com/x']]), CFG);
  const g = out.engines.gemini;
  assert.equal(g.exact, true);
  assert.equal(g.citation_rate_corrected_min, 1);
  assert.equal(g.citation_rate_corrected_max, 1);
});

test('an UNRESOLVED redirect changes nothing and is counted, not swallowed', () => {
  const snap = snapshotOf([{ gemini: geminiCell(['a', 'b']) }], ['gemini']);
  const out = recomputeSnapshot(snap, new Map(), CFG);
  const g = out.engines.gemini;
  assert.equal(g.cells_newly_cited, 0);
  assert.equal(g.citation_rate_corrected_min, g.citation_rate_original);
  assert.equal(g.redirects_seen, 2);
  assert.equal(g.redirects_unresolved, 2, 'so "recovered nothing" cannot be read as "found nothing"');
  assert.equal(g.changed, false);
});

test('a cell ALREADY counted as cited is not double-counted', () => {
  const snap = snapshotOf([{ gemini: geminiCell(['a'], { cited_runs: 2 }) }], ['gemini']);
  const out = recomputeSnapshot(snap, new Map([[R('a'), 'https://www.realskincare.com/x']]), CFG);
  const g = out.engines.gemini;
  assert.equal(g.cells_newly_cited, 0);
  assert.equal(g.citation_rate_corrected_min, parseFloat((2 / 3).toFixed(4)));
  assert.equal(g.citation_rate_corrected_max, parseFloat((2 / 3).toFixed(4)));
});

test('an ENGINE WITH NO REDIRECTS is byte-identical before and after', () => {
  const perplexity = {
    cited: true,
    citations: ['realskincare.com'],
    citation_urls: ['https://www.realskincare.com/x'],
    competitor_citations: ['Native'],
    runs: 3, runs_ok: 3, runs_with_citations: 3, cited_runs: 1, mentioned_runs: 0,
  };
  const out = recomputeSnapshot(snapshotOf([{ perplexity }], ['perplexity']), new Map(), CFG);
  const p = out.engines.perplexity;
  assert.equal(p.changed, false);
  assert.equal(p.citation_rate_corrected_min, p.citation_rate_original);
  assert.equal(p.citation_rate_corrected_max, p.citation_rate_original);
  assert.equal(p.redirects_seen, 0);
});

test('an errored cell is excluded from every denominator', () => {
  const snap = snapshotOf(
    [{ gemini: { error: 'API 429', cited: null, citations: [], competitor_citations: [] } }],
    ['gemini'],
  );
  const out = recomputeSnapshot(snap, new Map(), CFG);
  assert.equal(out.engines.gemini.n, 0);
  assert.equal(out.engines.gemini.citation_rate_original, null);
});

// ── competitor tallies are EXACT, always ─────────────────────────────────────

test('competitor citations are recovered per CELL and are exact even at 3 runs', () => {
  const snap = snapshotOf(
    [
      { gemini: geminiCell(['a']) },
      { gemini: geminiCell(['b']) },
    ],
    ['gemini'],
  );
  const resolved = new Map([
    [R('a'), 'https://www.tomsofmaine.com/products/x'],
    [R('b'), 'https://www.tomsofmaine.com/products/y'],
  ]);
  const out = recomputeSnapshot(snap, resolved, CFG);
  assert.deepEqual(out.top_competitor_citations_original, {});
  assert.deepEqual(out.top_competitor_citations_corrected, { "Tom's of Maine": 2 });
});

test('competitor tallies are sorted by count descending', () => {
  const snap = snapshotOf(
    [
      { gemini: geminiCell(['a']) },
      { gemini: geminiCell(['b']) },
      { gemini: geminiCell(['c']) },
    ],
    ['gemini'],
  );
  const out = recomputeSnapshot(snap, new Map([
    [R('a'), 'https://www.nativecos.com/x'],
    [R('b'), 'https://www.tomsofmaine.com/x'],
    [R('c'), 'https://www.tomsofmaine.com/y'],
  ]), CFG);
  assert.deepEqual(Object.keys(out.top_competitor_citations_corrected), ["Tom's of Maine", 'Native']);
});

// ── the self-check ───────────────────────────────────────────────────────────

test('reconciliationMismatches is empty when the recomputed ORIGINAL matches the stored summary', () => {
  const snap = snapshotOf([{ gemini: geminiCell(['a'], { cited_runs: 1 }) }], ['gemini'], {
    summary: { citation_rate: { gemini: parseFloat((1 / 3).toFixed(4)) } },
  });
  const out = recomputeSnapshot(snap, new Map(), CFG);
  assert.deepEqual(reconciliationMismatches(out), []);
});

test('reconciliationMismatches NAMES an engine whose stored summary disagrees', () => {
  const snap = snapshotOf([{ gemini: geminiCell(['a'], { cited_runs: 1 }) }], ['gemini'], {
    summary: { citation_rate: { gemini: 0.9 } },
  });
  assert.deepEqual(reconciliationMismatches(recomputeSnapshot(snap, new Map(), CFG)), ['gemini']);
});

test('recomputeSnapshot tolerates an empty or malformed snapshot', () => {
  assert.deepEqual(recomputeSnapshot({}, new Map(), CFG).engines, {});
  assert.deepEqual(recomputeSnapshot(null, new Map(), CFG).engines, {});
});
