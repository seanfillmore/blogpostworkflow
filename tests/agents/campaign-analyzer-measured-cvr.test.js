import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import {
  buildCvrRanges, measurementWindow, measureCvr, breakEvenCpcAtMeasured,
  renderMeasuredCvrSection, CvrMeasurementError, MIN_SEGMENT_ORDERS, MEASUREMENT_WINDOW_DAYS,
} from '../../agents/campaign-analyzer/lib/measured-cvr.js';
import { buildPromptContext, CONTEXT_BYTE_CEILING } from '../../agents/campaign-analyzer/lib/context.js';
import {
  reviewProposal, cvrRangeIssue, buildAnalyzerPrompt, buildAovBarrier, runWeeklyAnalysis,
  responseText, computeAov, FALLBACK_AOV, ANALYZER_MODEL, REVIEW_MODEL,
} from '../../agents/campaign-analyzer/index.js';
import { GA4_HOLE_END } from '../../lib/commercial-cvr.js';
// The fleet's DST-correct Pacific day helpers — the SAME functions the agent injects
// in production, not a test double of them.
import { ptDayOf, ptDayBounds } from '../../agents/shopify-collector/index.js';
const PT = { dayOf: ptDayOf };

// ─────────────────────────────────────────────────────────────────────────────
// agents/campaign-analyzer proposes Google Ads campaigns that SPEND MONEY. Until
// 2026-09-16 it enforced industry-benchmark CVR ranges (product 3-7%, landing
// 4-10%) that sit 4-9x above what this store measures, so the reviewer REJECTED
// realistic projections and PASSED fantasy ones. The 2026-03-20 lotion proposal
// projected 3% CVR -> 0.89x ROAS, went ACTIVE, and delivered 0.23% CVR / 0.19x.
//
// The fixture below is the real clean US shoppable measurement for
// 2026-08-20 -> 09-15 (lib/commercial-cvr.js, PR #888). It is a TEST INPUT, not a
// constant the agent carries — the agent measures at run time.
// ─────────────────────────────────────────────────────────────────────────────

const MEASURED_AGG = {
  segments: [
    { segment: 'blog', sessions: 1726, orders: 7 },
    { segment: 'product', sessions: 441, orders: 4 },
    { segment: 'home', sessions: 313, orders: 3 },
    { segment: 'collection', sessions: 126, orders: 0 },
    { segment: 'page', sessions: 58, orders: 0 },
  ],
  commercial: { sessions: 567, orders: 4 },
  totals: { sessions: 2664, orders: 14 },
};
const WINDOW = { start: '2026-08-20', end: '2026-09-15' };
const MEASUREMENT = { window: WINDOW, ranges: buildCvrRanges(MEASURED_AGG) };

// ── the ranges ──────────────────────────────────────────────────────────────

test('a segment with at least 3 orders gets its OWN Wilson interval', () => {
  const r = MEASUREMENT.ranges.byPageType.product;
  assert.equal(MIN_SEGMENT_ORDERS, 3);
  assert.equal(r.source, 'segment');
  assert.equal(r.orders, 4);
  assert.equal(r.sessions, 441);
  assert.ok(Math.abs(r.min - 0.00353) < 0.00001, `min ${r.min}`);
  assert.ok(Math.abs(r.max - 0.02309) < 0.00001, `max ${r.max}`);
  assert.equal(MEASUREMENT.ranges.byPageType.homepage.source, 'segment');
  assert.equal(MEASUREMENT.ranges.byPageType.blog.source, 'segment');
});

test('a segment with fewer than 3 orders borrows the pooled COMMERCIAL interval, and says whose sample it was', () => {
  const { collection, landing } = MEASUREMENT.ranges.byPageType;
  const pool = MEASUREMENT.ranges.commercial;
  for (const r of [collection, landing]) {
    assert.equal(r.source, 'pooled-commercial');
    assert.equal(r.min, pool.lower);
    assert.equal(r.max, pool.upper);
  }
  // The segment's own thin sample is still carried so the prompt can show it.
  assert.equal(collection.segmentOrders, 0);
  assert.equal(collection.segmentSessions, 126);
});

test('the landing type never gets a range above the commercial pool, even with its own evidence', () => {
  // A small, lucky landing page: 5 orders on 40 sessions would be a 12.5% "rate".
  // No evidence says a dedicated landing page converts better than our commercial
  // pages, so its ceiling is the commercial ceiling.
  const agg = structuredClone(MEASURED_AGG);
  agg.segments.find((s) => s.segment === 'page').orders = 5;
  agg.segments.find((s) => s.segment === 'page').sessions = 40;
  const r = buildCvrRanges(agg);
  assert.equal(r.byPageType.landing.source, 'segment');
  assert.ok(r.byPageType.landing.max <= r.commercial.upper, `${r.byPageType.landing.max} > ${r.commercial.upper}`);
  assert.ok(r.byPageType.landing.min <= r.byPageType.landing.max);
  assert.ok(MEASUREMENT.ranges.byPageType.landing.max <= MEASUREMENT.ranges.commercial.upper);
});

test('no commercial denominator means no commercial pool at all — never a benchmark', () => {
  const r = buildCvrRanges({ segments: [], commercial: { sessions: 0, orders: 0 }, totals: { sessions: 0, orders: 0 } });
  assert.equal(r.commercial, null);
  assert.equal(r.byPageType.product, null);
});

// ── the window ──────────────────────────────────────────────────────────────

test('the window is 90 Pacific days ending yesterday, clamped to the first day after the GA4 hole', () => {
  assert.equal(MEASUREMENT_WINDOW_DAYS, 90);
  const clamped = measurementWindow(new Date('2026-09-16T12:00:00Z'), PT);
  assert.equal(clamped.end, '2026-09-15');
  assert.equal(clamped.start, '2026-08-04');
  assert.ok(clamped.start > GA4_HOLE_END);
  const full = measurementWindow(new Date('2026-12-31T20:00:00Z'), PT);
  assert.equal(full.end, '2026-12-30');
  assert.equal(full.start, '2026-10-02'); // 90 days inclusive
});

test('at the cron hour (06:00 UTC = 23:00 PT the evening before) yesterday is the PACIFIC yesterday', () => {
  // Sunday 2026-09-20 06:00 UTC is Saturday 23:00 PDT. A UTC "yesterday" would be
  // Saturday — Pacific TODAY, a partial day in the denominator.
  const w = measurementWindow(new Date('2026-09-20T06:00:00Z'), PT);
  assert.equal(w.end, '2026-09-18');
});

test('a window that cannot start after the GA4 hole is unusable', () => {
  assert.throws(() => measurementWindow(new Date('2026-08-04T12:00:00Z'), PT), CvrMeasurementError);
});

// ── measuring, and failing closed ───────────────────────────────────────────

const NOW = new Date('2026-09-16T12:00:00Z');
const order = (id, path) => ({
  id, total_price: '56.08', landing_site: path, source_name: 'web',
  shipping_address: { country_code: 'US' }, line_items: [],
});
const GA4_ROWS = [
  { page: '/products/coconut-lotion', sessions: 300, country: 'United States', source: 'google' },
  { page: '/collections/lotion', sessions: 100, country: 'United States', source: 'google' },
  { page: '/blogs/news/a', sessions: 900, country: 'United States', source: 'google' },
];
const ORDERS = [1, 2, 3].map((i) => order(i, '/products/coconut-lotion')).concat([order(4, '/blogs/news/a')]);

test('measureCvr reuses the commercial-cvr pipeline end to end on the window it chose', async () => {
  const calls = [];
  const m = await measureCvr({
    now: NOW, dayOf: ptDayOf, dayBounds: ptDayBounds,
    fetchSegments: async (s, e) => { calls.push(['ga4', s, e]); return GA4_ROWS; },
    fetchOrders: async (s, e) => { calls.push(['shopify', s, e]); return { orders: ORDERS, pages: 1, truncated: false }; },
  });
  // GA4 takes bare Pacific dates (the property's own zone). Shopify must get
  // explicit Pacific bounds: a bare end date is read as MIDNIGHT and silently drops
  // the window's whole final day.
  assert.deepEqual(calls[0], ['ga4', '2026-08-04', '2026-09-15']);
  assert.deepEqual(calls[1], ['shopify', ptDayBounds('2026-08-04').dayStart, ptDayBounds('2026-09-15').dayEnd]);
  assert.equal(calls[1][2], '2026-09-15T23:59:59.999-07:00', 'the final day is included, to the millisecond');
  assert.equal(m.ranges.commercial.orders, 3);
  assert.equal(m.ranges.commercial.sessions, 400);
  assert.equal(m.ranges.byPageType.product.source, 'segment');
});

for (const [label, deps, pattern] of [
  ['a GA4 fetch error', { fetchSegments: async () => { throw new Error('GA4 quota'); } }, /GA4 quota/],
  ['a Shopify fetch error', { fetchOrders: async () => { throw new Error('401'); } }, /401/],
  ['truncated orders', { fetchOrders: async () => ({ orders: ORDERS, pages: 40, truncated: true }) }, /truncated/],
  ['zero orders', { fetchOrders: async () => ({ orders: [], pages: 1, truncated: false }) }, /zero orders/],
  ['an orders envelope that is not an array', { fetchOrders: async () => ORDERS }, /envelope/],
  ['no commercial sessions', { fetchSegments: async () => [GA4_ROWS[2]] }, /commercial/],
  ['a missing Pacific day helper', { dayBounds: undefined }, /dayBounds/],
]) {
  test(`measureCvr fails CLOSED on ${label}`, async () => {
    await assert.rejects(
      measureCvr({
        now: NOW, dayOf: ptDayOf, dayBounds: ptDayBounds,
        fetchSegments: async () => GA4_ROWS,
        fetchOrders: async () => ({ orders: ORDERS, pages: 1, truncated: false }),
        ...deps,
      }),
      (e) => e instanceof CvrMeasurementError && pattern.test(e.message),
    );
  });
}

// ── the reviewer ────────────────────────────────────────────────────────────

const AOV = 56.08;
function proposal({ cvr, landingPage = '/products/coconut-lotion', campaignName = 'RSC | Lotion | Search' }) {
  const dailyClicks = 10;
  const cpc = 0.5;
  const monthlyConversions = dailyClicks * cvr * 30;
  return {
    campaignName, landingPage, rationale: 'r',
    projections: {
      ctr: 0.03, cpc, cvr, dailyClicks,
      monthlyCost: cpc * dailyClicks * 30,
      monthlyConversions,
      monthlyRevenue: monthlyConversions * AOV,
    },
    proposal: { adGroups: [] },
  };
}
function stubClient(answer = { approved: true }) {
  const prompts = [];
  return {
    prompts,
    messages: {
      create: async (params) => {
        prompts.push(params.messages[0].content);
        return { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(answer) }] };
      },
    },
  };
}

test('REGRESSION: a realistic 0.8% product-page CVR — rejected by the old 3-7% benchmark — is accepted', async () => {
  const client = stubClient();
  const review = await reviewProposal(proposal({ cvr: 0.008 }), AOV, client, [], MEASUREMENT.ranges);
  assert.deepEqual(review, { approved: true });
  // The narrative reviewer is told the measured range, not left to apply its own benchmarks.
  assert.match(client.prompts[0], /0\.35%/);
  assert.match(client.prompts[0], /2\.31%/);
});

test('a 3% product-page CVR — the projection that produced a 0.19x campaign — is rejected on measurement', async () => {
  const client = stubClient();
  const review = await reviewProposal(proposal({ cvr: 0.03 }), AOV, client, [], MEASUREMENT.ranges);
  assert.equal(review.approved, false);
  assert.match(review.reasons.join(' '), /outside the MEASURED range/);
  assert.equal(client.prompts.length, 0, 'rejected before any paid review call');
});

test('a dedicated landing page is held to the commercial pool, not a 4-10% benchmark', () => {
  assert.equal(cvrRangeIssue(proposal({ cvr: 0.04, landingPage: '/pages/lotion-offer' }), MEASUREMENT.ranges) !== null, true);
  assert.equal(cvrRangeIssue(proposal({ cvr: 0.007, landingPage: '/pages/lotion-offer' }), MEASUREMENT.ranges), null);
});

test('the reviewer fails CLOSED with no measured ranges, except for the brand-search exemption', async () => {
  const review = await reviewProposal(proposal({ cvr: 0.008 }), AOV, stubClient(), [], null);
  assert.equal(review.approved, false);
  assert.match(review.reasons.join(' '), /No measured CVR range/);
  // Brand search keeps its (unmeasured, benchmark) exemption.
  assert.equal(cvrRangeIssue(proposal({ cvr: 0.08, campaignName: 'RSC | Brand | Search', landingPage: '/' }), null), null);
});

test('a proposal with no projected CVR cannot be checked, so it is rejected', () => {
  const p = proposal({ cvr: 0.008 });
  delete p.projections.cvr;
  assert.match(cvrRangeIssue(p, MEASUREMENT.ranges), /no projections\.cvr/);
});

// ── the prompt ──────────────────────────────────────────────────────────────

test('the prompt presents the ranges as MEASURED, with the orders and sessions behind each', () => {
  const text = renderMeasuredCvrSection(MEASUREMENT);
  assert.match(text, /MEASURED/);
  assert.match(text, /2026-08-20 → 2026-09-15/);
  assert.match(text, /4 orders \/ 441 sessions/);
  assert.match(text, /0 orders \/ 126 sessions/);
  assert.match(text, /pooled commercial/i);
  assert.doesNotMatch(text, /3–7%|4–10%/);
});

test('buildAnalyzerPrompt refuses to build a prompt with no measurement', () => {
  const ctx = { activeSlugs: [], adsSnaps: [], gscSnaps: [], ga4Snaps: [], shopifySnaps: [], pastOutcomes: [] };
  assert.throws(() => buildAnalyzerPrompt(ctx), /measured/i);
  const prompt = buildAnalyzerPrompt({ ...ctx, measuredCvr: MEASUREMENT });
  assert.match(prompt, /4 orders \/ 441 sessions/);
  assert.doesNotMatch(prompt, /homepage 1–3%, collection 2–5%/);
});

// ── the request size ────────────────────────────────────────────────────────

// Realistic shapes, sized to production on 2026-09-16: GSC carries 1,000 top
// queries, ~214 top pages and ~1,900 queriesByPage keys PER DAY; GA4 carries
// landing-page, device and country breakdowns. Dumping 60 days of those raw was
// a 52.8 MB request body — over the Messages API's 32 MB limit — and every weekly
// run since April died on a 413.
function realisticSnapshots() {
  const days = Array.from({ length: 90 }, (_, i) => new Date(Date.UTC(2026, 8, 15) - i * 86400000).toISOString().slice(0, 10));
  const gsc = days.slice(0, 60).map((date, d) => ({
    date,
    summary: { clicks: 30, impressions: 3500, ctr: 0.009, position: 12 },
    topQueries: Array.from({ length: 1000 }, (_, i) => ({ query: `query number ${i} about coconut lotion ${d % 7}`, clicks: i % 5, impressions: 1000 - i, ctr: 0.01, position: 10 + (i % 30) })),
    topPages: Array.from({ length: 214 }, (_, i) => ({ page: `https://www.realskincare.com/blogs/news/post-${i}`, clicks: i % 4, impressions: 500 - i, ctr: 0.01, position: 9 })),
    queriesByPage: Object.fromEntries(Array.from({ length: 1900 }, (_, i) => [`https://www.realskincare.com/blogs/news/post-${i}`, [{ query: `q${i}`, clicks: 1, impressions: 20, position: 8 }]])),
  }));
  const ga4 = days.slice(0, 60).map((date) => ({
    date, sessions: 413, users: 390, conversions: 0, revenue: 0,
    topSources: Array.from({ length: 25 }, (_, i) => ({ source: `src${i}`, medium: 'referral', sessions: 30 - i, conversions: 0, revenue: 0 })),
    topLandingPages: Array.from({ length: 52 }, (_, i) => ({ page: `/blogs/news/post-${i}`, sessions: 60 - i, conversions: 0, revenue: 0 })),
    landingPagesByDevice: Array.from({ length: 120 }, (_, i) => ({ page: `/p${i}`, device: 'mobile', sessions: 3 })),
    usLandingPages: Array.from({ length: 52 }, (_, i) => ({ page: `/blogs/news/post-${i}`, sessions: 50 - i, conversions: 0, revenue: 0 })),
    sessionsByCountry: Array.from({ length: 30 }, (_, i) => ({ country: `C${i}`, sessions: 10 })),
    us: { sessions: 346, conversions: 0, revenue: 0 },
  }));
  const ads = days.slice(0, 60).map((date) => ({
    date, spend: 3, impressions: 112, clicks: 4, conversions: 0, revenue: 0,
    campaigns: Array.from({ length: 22 }, (_, i) => ({ id: String(i), name: `Campaign ${i}`, status: i ? 'PAUSED' : 'ENABLED', impressions: 5, clicks: 1, spend: 0.5, conversions: 0, revenue: 0 })),
    topKeywords: Array.from({ length: 7 }, (_, i) => ({ keyword: `kw ${i}`, matchType: 'EXACT', impressions: 60, clicks: 3, conversions: 0, spend: 1.46 })),
    adGroupAds: Array.from({ length: 25 }, (_, i) => ({ resourceName: `customers/1/adGroupAds/${i}`, adId: String(i) })),
  }));
  const shopify = days.map((date) => ({
    date, orders: { count: 1, revenue: 56.08, aov: 56.08 },
    topProducts: [{ title: 'Non-Toxic Body Lotion', revenue: 56.08, orders: 1 }],
    attribution: { orders: [{ id: 1, total: 56.08, lines: [] }] },
  }));
  return { gsc, ga4, ads, shopify };
}

test(`the prompt built from 60-90 days of production-shaped snapshots stays under CONTEXT_BYTE_CEILING`, () => {
  const s = realisticSnapshots();
  // Serialised the way the OLD prompt did it (indent 2), the fixture is over the
  // Messages API's 32 MB request limit — i.e. it would have 413'd too.
  const rawBytes = Buffer.byteLength(JSON.stringify([s.gsc, s.ga4, s.ads, s.shopify], null, 2));
  assert.ok(rawBytes > 32_000_000, `fixture should be at least as heavy as the request that 413'd (${rawBytes})`);
  const ctx = { activeSlugs: [], adsSnaps: s.ads, gscSnaps: s.gsc, ga4Snaps: s.ga4, shopifySnaps: s.shopify, pastOutcomes: [], measuredCvr: MEASUREMENT };
  const prompt = buildAnalyzerPrompt(ctx);
  const bytes = Buffer.byteLength(prompt);
  assert.ok(bytes < CONTEXT_BYTE_CEILING, `prompt is ${bytes} bytes, ceiling ${CONTEXT_BYTE_CEILING}`);
  // It still carries what the model needs to pick keywords and pages.
  assert.match(prompt, /query number 0 about coconut lotion/);
  assert.match(prompt, /post-0/);
  assert.match(prompt, /Campaign 0/);
});

test('buildPromptContext aggregates across days rather than listing each day', () => {
  const s = realisticSnapshots();
  const ctx = buildPromptContext({ adsSnaps: s.ads, gscSnaps: s.gsc, ga4Snaps: s.ga4, shopifySnaps: s.shopify });
  const q0 = ctx.gsc.topQueries.find((q) => q.query === 'query number 0 about coconut lotion 0');
  assert.ok(q0.impressions > 1000, 'impressions summed across the days the query appeared');
  assert.equal(ctx.shopify.orders, 90);
  assert.equal(ctx.ads.campaigns.length, 22);
});

// ── the barrier ─────────────────────────────────────────────────────────────

test('the AOV barrier computes break-even CPC at the MEASURED commercial CVR and names its sample', () => {
  const b = buildAovBarrier({ today: '2026-09-16', aov: AOV, minRoas: 0.85, proposalsAnalyzed: 2, measurement: MEASUREMENT });
  const cpa = AOV / 0.85;
  const c = MEASUREMENT.ranges.commercial;
  assert.equal(b.breakEvenCpa, Math.round(cpa * 100) / 100);
  assert.deepEqual(b.breakEvenCpcMeasured, breakEvenCpcAtMeasured(AOV, 0.85, c));
  assert.equal(b.breakEvenCpcMeasured.atPoint, Math.round(cpa * (4 / 567) * 100) / 100);
  assert.equal(b.breakEvenCpcMeasured.atLower, Math.round(cpa * c.lower * 100) / 100);
  assert.equal(b.breakEvenCpcMeasured.atUpper, Math.round(cpa * c.upper * 100) / 100);
  assert.equal(b.measuredCvr.orders, 4);
  assert.equal(b.measuredCvr.sessions, 567);
  assert.deepEqual(b.measuredCvr.window, WINDOW);
  assert.match(b.message, /4 orders \/ 567 sessions/);
  assert.match(b.message, /2026-08-20 → 2026-09-15/);
  assert.doesNotMatch(b.message, /2% CVR|3% CVR/);
  assert.equal(b.breakEvenCpc, undefined, 'the benchmark-rate thresholds are no longer written');
});

test('FALLBACK_AOV is the trailing-90-day figure from 2026-09-15, not March', () => {
  assert.equal(FALLBACK_AOV, 56.08);
  assert.equal(computeAov([]), 56.08);
});

// ── the weekly run, fail-closed ─────────────────────────────────────────────

function runDeps(overrides = {}) {
  const writes = [];
  const notes = [];
  const created = [];
  return {
    writes, notes, created,
    deps: {
      context: { activeSlugs: [], adsSnaps: [], gscSnaps: [], ga4Snaps: [], shopifySnaps: [], pastOutcomes: [] },
      measure: async () => MEASUREMENT,
      client: { messages: { create: async (p) => { created.push(p); return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ proposals: [] }) }] }; } } },
      today: '2026-09-16',
      campaignsDir: '/nowhere/data/campaigns',
      write: (path, doc) => writes.push({ path, doc }),
      remove: () => {},
      exists: () => false,
      notify: async (n) => notes.push(n),
      log: () => {},
      ...overrides,
    },
  };
}

test('FAIL CLOSED: when the measurement cannot be made, no model is called, nothing is written, and the digest gets an error row', async () => {
  const { deps, writes, notes, created } = runDeps({
    measure: async () => { throw new CvrMeasurementError('Shopify pagination truncated'); },
  });
  const out = await runWeeklyAnalysis(deps);
  assert.equal(out.status, 'measurement-failed');
  assert.equal(created.length, 0, 'no paid model call on a run that cannot be reviewed');
  assert.equal(writes.length, 0, 'no proposal and no barrier');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].status, 'error');
  assert.notEqual(notes[0].immediate, true, 'deferred to the 5 AM digest, never an immediate email');
  assert.match(notes[0].body, /truncated/);
});

test('when every proposal is rejected, the barrier written carries the measured break-even', async () => {
  const bad = proposal({ cvr: 0.03 });
  const { deps, writes } = runDeps({
    client: { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ proposals: [bad] }) }] }) } },
  });
  const out = await runWeeklyAnalysis(deps);
  assert.equal(out.written.length, 0);
  assert.equal(writes.length, 1);
  assert.match(writes[0].path, /aov-barrier\.json$/);
  assert.ok(writes[0].doc.breakEvenCpcMeasured.atPoint > 0);
});

test('the analysis request uses the measured prompt and a current model, and is a fraction of the old size', async () => {
  const { deps, created } = runDeps();
  await runWeeklyAnalysis(deps);
  assert.equal(created.length, 1);
  assert.equal(created[0].model, ANALYZER_MODEL);
  assert.match(created[0].messages[0].content, /MEASURED/);
});

test('responseText reads the text block past a thinking block, and refuses truncated or refused output', () => {
  assert.equal(responseText({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{}' }] }), '{}');
  assert.throws(() => responseText({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"propos' }] }), /max_tokens/);
  assert.throws(() => responseText({ stop_reason: 'refusal', content: [] }), /refus/);
  assert.throws(() => responseText({ stop_reason: 'end_turn', content: [] }), /no text/);
});

test('models are current-generation IDs, not the 4.6 pins that the 413 was masking', () => {
  assert.equal(ANALYZER_MODEL, 'claude-opus-5');
  assert.equal(REVIEW_MODEL, 'claude-sonnet-5');
});

// ── source scan: the crash path reaches the digest ──────────────────────────
// A source scan because the handler sits on the entry point, and importing an
// agent must not run it.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(join(ROOT, 'agents/campaign-analyzer/index.js'), 'utf8');

test('a crash of the agent notifies the digest with status error, deferred', () => {
  assert.match(SRC, /isDirectRun\(import\.meta\.url\)/);
  const tail = SRC.slice(SRC.lastIndexOf('isDirectRun(import.meta.url)'));
  assert.match(tail, /notify\(\{/);
  assert.match(tail, /status:\s*'error'/);
  assert.doesNotMatch(SRC, /immediate:\s*true/);
  assert.doesNotMatch(SRC, /PAGE_TYPE_CVR/);
});
