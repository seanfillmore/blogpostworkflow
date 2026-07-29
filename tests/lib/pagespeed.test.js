import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePsiResult, diffSnapshots, fetchPageSpeed, band, summarizeMarkdown } from '../../lib/pagespeed.js';

// Minimal PSI-shaped fixture (mirrors the real runPagespeed response shape).
function psiFixture({ score = 0.4, withField = false } = {}) {
  const audits = {
    'first-contentful-paint': { numericValue: 2100, displayValue: '2.1 s', score: 0.81 },
    'largest-contentful-paint': { numericValue: 4900, displayValue: '4.9 s', score: 0.29 },
    'total-blocking-time': { numericValue: 8510, displayValue: '8,510 ms', score: 0 },
    'cumulative-layout-shift': { numericValue: 0, displayValue: '0', score: 1 },
    'speed-index': { numericValue: 13900, displayValue: '13.9 s', score: 0.01 },
    'interactive': { numericValue: 34100, displayValue: '34.1 s', score: 0 },
    'mainthread-work-breakdown': { numericValue: 26500, displayValue: '26.5 s' },
    'bootup-time': { numericValue: 13900, displayValue: '13.9 s' },
    'unused-javascript': { numericValue: 150, displayValue: 'Est savings of 1,693 KiB',
      details: { type: 'opportunity', overallSavingsBytes: 1693 * 1024, overallSavingsMs: 150 } },
    'unused-css-rules': { numericValue: 20, displayValue: 'Est savings of 28 KiB',
      details: { type: 'opportunity', overallSavingsBytes: 28 * 1024, overallSavingsMs: 20 } },
    'render-blocking-resources': { numericValue: 0, details: { type: 'opportunity', overallSavingsMs: 0 } },
  };
  const result = {
    lighthouseResult: {
      lighthouseVersion: '13.4.0',
      categories: { performance: { score } },
      audits,
    },
  };
  if (withField) {
    result.loadingExperience = {
      overall_category: 'AVERAGE',
      metrics: {
        LARGEST_CONTENTFUL_PAINT_MS: { percentile: 3200, category: 'AVERAGE' },
        CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 5, category: 'GOOD' },
        INTERACTION_TO_NEXT_PAINT: { percentile: 210, category: 'AVERAGE' },
        FIRST_CONTENTFUL_PAINT_MS: { percentile: 2100, category: 'AVERAGE' },
      },
    };
  }
  return result;
}

test('parsePsiResult extracts score and lab Core Web Vitals', () => {
  const r = parsePsiResult(psiFixture(), { url: 'https://x.com/', strategy: 'mobile' });
  assert.equal(r.url, 'https://x.com/');
  assert.equal(r.strategy, 'mobile');
  assert.equal(r.score, 40); // 0.4 * 100, rounded
  assert.equal(r.metrics.lcp, 4900);
  assert.equal(r.metrics.tbt, 8510);
  assert.equal(r.metrics.cls, 0);
  assert.equal(r.metrics.fcp, 2100);
});

test('parsePsiResult returns field:null when CrUX data is absent', () => {
  const r = parsePsiResult(psiFixture({ withField: false }), { url: 'https://x.com/', strategy: 'mobile' });
  assert.equal(r.field, null);
});

test('parsePsiResult populates field data (p75) when CrUX data is present', () => {
  const r = parsePsiResult(psiFixture({ withField: true }), { url: 'https://x.com/', strategy: 'mobile' });
  assert.equal(r.field.category, 'AVERAGE');
  assert.equal(r.field.lcp, 3200);
  assert.equal(r.field.inp, 210);
  assert.equal(r.field.cls, 5);
});

test('parsePsiResult surfaces top opportunities sorted by savings, largest first', () => {
  const r = parsePsiResult(psiFixture(), { url: 'https://x.com/', strategy: 'mobile' });
  assert.ok(r.opportunities.length >= 1);
  // unused-javascript (1693 KiB) must rank above unused-css-rules (28 KiB)
  assert.equal(r.opportunities[0].id, 'unused-javascript');
  assert.equal(r.opportunities[0].savingsKib, 1693);
  // zero-savings opportunities (render-blocking here) are dropped
  assert.ok(!r.opportunities.some(o => o.id === 'render-blocking-resources'));
});

test('parsePsiResult captures key diagnostics', () => {
  const r = parsePsiResult(psiFixture(), { url: 'https://x.com/', strategy: 'mobile' });
  assert.equal(r.diagnostics.mainThreadMs, 26500);
  assert.equal(r.diagnostics.unusedJsKib, 1693);
});

// ---- diffSnapshots ----

function snap(pages) {
  return { date: '2026-07-24', pages };
}
const page = (over = {}) => ({
  url: 'https://x.com/', strategy: 'mobile', score: 50,
  metrics: { lcp: 4000, cls: 0, tbt: 5000, fcp: 2000, si: 10000, tti: 20000 },
  field: null, opportunities: [], diagnostics: {},
  ...over,
});

test('diffSnapshots flags a regression when score drops beyond the dead-band', () => {
  const cur = snap([page({ score: 40 })]);
  const prev = snap([page({ score: 50 })]);
  const d = diffSnapshots(cur, prev, { deadBand: 3 });
  assert.equal(d.regressions.length, 1);
  assert.equal(d.regressions[0].delta, -10);
  assert.equal(d.improvements.length, 0);
});

test('diffSnapshots flags an improvement when score climbs beyond the dead-band', () => {
  const cur = snap([page({ score: 62 })]);
  const prev = snap([page({ score: 50 })]);
  const d = diffSnapshots(cur, prev, { deadBand: 3 });
  assert.equal(d.improvements.length, 1);
  assert.equal(d.improvements[0].delta, 12);
  assert.equal(d.regressions.length, 0);
});

test('diffSnapshots ignores score noise within the dead-band', () => {
  const cur = snap([page({ score: 51 })]);
  const prev = snap([page({ score: 50 })]);
  const d = diffSnapshots(cur, prev, { deadBand: 3 });
  assert.equal(d.regressions.length, 0);
  assert.equal(d.improvements.length, 0);
});

test('diffSnapshots treats a page with no prior baseline as new, not a regression', () => {
  const cur = snap([page({ url: 'https://x.com/new', score: 30 })]);
  const prev = snap([page({ url: 'https://x.com/', score: 90 })]);
  const d = diffSnapshots(cur, prev, { deadBand: 3 });
  assert.equal(d.regressions.length, 0);
  assert.equal(d.newPages.length, 1);
  assert.equal(d.newPages[0].url, 'https://x.com/new');
});

test('diffSnapshots returns empty diff when there is no previous snapshot', () => {
  const cur = snap([page()]);
  const d = diffSnapshots(cur, null, { deadBand: 3 });
  assert.deepEqual(d.regressions, []);
  assert.deepEqual(d.improvements, []);
});

// ---- Core Web Vitals bands ----

test('band classifies each lab vital at its threshold boundaries', () => {
  // Boundaries are inclusive on the "good" side, matching Google's definitions.
  assert.equal(band('lcp', 2500), 'good');
  assert.equal(band('lcp', 2501), 'needs-improvement');
  assert.equal(band('lcp', 4000), 'needs-improvement');
  assert.equal(band('lcp', 4001), 'poor');
  assert.equal(band('cls', 0.1), 'good');
  assert.equal(band('cls', 0.25), 'needs-improvement');
  assert.equal(band('cls', 0.2689), 'poor');
  assert.equal(band('tbt', 200), 'good');
  assert.equal(band('tbt', 601), 'poor');
  assert.equal(band('lcp', null), null);
  assert.equal(band('si', 1000), null); // not a vital — no band
});

test('diffSnapshots flags a Core Web Vital regression even when the score IMPROVES', () => {
  // The 2026-07-26 bug: homepage score rose 35 -> 42 and the report called it a
  // 🟢 improvement on the same run CLS went 0.0000 -> 0.2689 (good -> poor).
  const cur = snap([page({ score: 42, metrics: { ...page().metrics, cls: 0.2689 } })]);
  const prev = snap([page({ score: 35, metrics: { ...page().metrics, cls: 0 } })]);
  const d = diffSnapshots(cur, prev, { deadBand: 3 });

  assert.equal(d.improvements.length, 1, 'score improvement is still reported');
  const cls = d.metricRegressions.find(m => m.metric === 'cls');
  assert.ok(cls, 'the CLS band regression must be surfaced');
  assert.equal(cls.fromBand, 'good');
  assert.equal(cls.toBand, 'poor');
  assert.equal(cls.to, 0.2689);
});

test('diffSnapshots reports a vital sitting in the poor band even with no change', () => {
  // A persistently broken vital must keep being reported, not go silent after
  // the first day because the delta is zero.
  const metrics = { ...page().metrics, lcp: 24000 };
  const d = diffSnapshots(snap([page({ metrics })]), snap([page({ metrics })]), { deadBand: 3 });
  assert.equal(d.metricRegressions.length, 0, 'no band change, so not a new regression');
  assert.ok(d.failing.some(f => f.metric === 'lcp' && f.band === 'poor'));
});

test('diffSnapshots ignores large raw metric swings inside the same band', () => {
  // Lab LCP/TBT swing ~4x run-to-run on the same URL, so raw deltas are noise.
  // Only a band crossing is a signal.
  const cur = snap([page({ metrics: { ...page().metrics, lcp: 16000 } })]);
  const prev = snap([page({ metrics: { ...page().metrics, lcp: 4500 } })]);
  const d = diffSnapshots(cur, prev, { deadBand: 3 });
  assert.equal(d.metricRegressions.length, 0, 'poor -> poor is not a new regression');
});

test('diffSnapshots flags a vital recovering out of the poor band as an improvement', () => {
  const cur = snap([page({ metrics: { ...page().metrics, cls: 0.0357 } })]);
  const prev = snap([page({ metrics: { ...page().metrics, cls: 0.2689 } })]);
  const d = diffSnapshots(cur, prev, { deadBand: 3 });
  const cls = d.metricImprovements.find(m => m.metric === 'cls');
  assert.ok(cls);
  assert.equal(cls.fromBand, 'poor');
  assert.equal(cls.toBand, 'good');
});

test('summarizeMarkdown cannot present a page as purely improved while a vital regressed', () => {
  const cur = snap([page({ score: 42, metrics: { ...page().metrics, cls: 0.2689 } })]);
  const prev = snap([page({ score: 35, metrics: { ...page().metrics, cls: 0 } })]);
  const md = summarizeMarkdown(cur, diffSnapshots(cur, prev, { deadBand: 3 }));

  assert.match(md, /Core Web Vital regressions/i);
  assert.match(md, /CLS/);
  // The score-improvement line must carry the caveat, so a skim cannot mislead.
  const improvementLine = md.split('\n').find(l => l.includes('35 → 42'));
  assert.ok(improvementLine, 'score improvement still listed');
  assert.match(improvementLine, /vital regressed/i);
});

// ---- fetchPageSpeed (injectable fetch, retry, timeout) ----

test('fetchPageSpeed returns parsed JSON on a successful response', async () => {
  const fakeFetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: 1 }) });
  const r = await fetchPageSpeed('https://x.com/', 'mobile', { apiKey: 'k', fetchImpl: fakeFetch });
  assert.deepEqual(r, { ok: 1 });
});

test('fetchPageSpeed retries on 429 then throws after exhausting retries', async () => {
  let calls = 0;
  const fakeFetch = async () => { calls++; return { ok: false, status: 429, text: async () => '' }; };
  await assert.rejects(
    fetchPageSpeed('https://x.com/', 'mobile', { apiKey: 'k', retries: 2, backoffMs: 0, fetchImpl: fakeFetch }),
    /429/,
  );
  assert.equal(calls, 3); // initial attempt + 2 retries
});

test('fetchPageSpeed aborts a hung request via timeout and surfaces the error', async () => {
  // AbortSignal.timeout() schedules an UNREF'd timer, so with a stubbed fetch
  // there is nothing else keeping the event loop alive and it can drain before
  // the abort fires — the test then never settles and node:test reports it as
  // cancelledByParent (seen on the server's Node 22, though not on Node 25).
  // A real run always has a pending socket holding the loop open; this keep-alive
  // stands in for it. Without it this assertion silently stops being exercised.
  const keepAlive = setInterval(() => {}, 5);
  try {
    const fakeFetch = (url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
    });
    await assert.rejects(
      fetchPageSpeed('https://x.com/', 'mobile', { apiKey: 'k', retries: 0, timeoutMs: 20, backoffMs: 0, fetchImpl: fakeFetch }),
      /abort/i,
    );
  } finally {
    clearInterval(keepAlive);
  }
});
