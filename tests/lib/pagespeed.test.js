import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePsiResult, diffSnapshots, fetchPageSpeed } from '../../lib/pagespeed.js';

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
  const fakeFetch = (url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
  });
  await assert.rejects(
    fetchPageSpeed('https://x.com/', 'mobile', { apiKey: 'k', retries: 0, timeoutMs: 20, backoffMs: 0, fetchImpl: fakeFetch }),
    /abort/i,
  );
});
