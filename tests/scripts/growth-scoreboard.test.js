// Tests for scripts/growth-scoreboard.mjs.
//
// THE PREVIOUS VERSION OF THIS FILE WAS THE BUG, NOT A GUARD AGAINST IT. Its
// fixtures carried `conversions` and `revenue` on every GA4 row, and the real
// fetch behind the script (fetchLandingPagesByChannel) never produced either —
// it returns {page, channel, source, sessions}. So `computeScoreboard` summed
// `undefined` into NaN on every production run while every test here passed,
// because the tests pinned a row shape that did not exist. A fixture must be the
// shape the fetch RETURNS, never the shape the consumer wishes it returned.
//
// Every GA4 row below is therefore built by `seg()`, which emits exactly the
// fields lib/ga4.js fetchLandingPageSegments returns: page, channel, source,
// country, sessions, purchases. Orders go through the real attributionRows().
//
// (Salvaged from feature/growth-plan-1m on 2026-08-21 and relocated here so
// `npm test` picks it up; package.json is "type": "module", so importing the
// sibling .mjs is fine.)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeScoreboard, median, scoreboardWindow, channelFamilyOfGa4, channelFamilyOfShopify,
  SMALL_SAMPLE_ORDERS,
} from '../../scripts/growth-scoreboard.mjs';
import { attributionRows } from '../../lib/order-attribution.js';
import { GA4_HOLE_END } from '../../lib/commercial-cvr.js';

const US = 'United States';

/** One row in the exact shape fetchLandingPageSegments returns. */
const seg = (page, sessions, { channel = 'Organic Search', source = 'google', country = US, purchases = 0 } = {}) =>
  ({ page, channel, source, country, sessions, purchases });

/** A raw Shopify order, minimal but real enough for classifyOrder. */
let nextId = 1;
const order = ({ total = 50, landing = '/products/lotion', referrer = 'https://www.google.com/', country = 'US',
  source_name = 'web', cancelled = false } = {}) => ({
  id: nextId++,
  name: `#${nextId}`,
  created_at: '2026-09-01T12:00:00-07:00',
  total_price: String(total),
  source_name,
  landing_site: landing,
  referring_site: referrer,
  cancelled_at: cancelled ? '2026-09-02T00:00:00Z' : null,
  shipping_address: country ? { country_code: country } : null,
  line_items: [],
});

const deepNoNaN = (value, path = 'result') => {
  if (typeof value === 'number') {
    assert.ok(Number.isFinite(value), `${path} is ${value}`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => deepNoNaN(v, `${path}[${i}]`));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) deepNoNaN(v, `${path}.${k}`);
  }
};

// ── the production regression ─────────────────────────────────────────────────

test('REGRESSION: rows without conversions/revenue fields produce no NaN anywhere', () => {
  // The exact shape the old fetch returned — no purchases either. Before the
  // rebuild this made sessions finite and every conversion figure NaN.
  const ga4Rows = [
    { page: '/', channel: 'Direct', source: '(direct)', sessions: 100 },
    { page: '/blogs/news/x', channel: 'Organic Search', source: 'google', sessions: 900 },
  ];
  const orderRows = attributionRows([order({ landing: '/blogs/news/x' }), order({ landing: '/' })]);
  const s = computeScoreboard({ ga4Rows, orderRows });
  deepNoNaN(s);
  assert.equal(s.sessions.all, 1000);
  // No row carried `purchases`, so the cross-check is UNMEASURED, not zero.
  assert.equal(s.tracking.ga4Purchases, null);
  assert.equal(s.tracking.ratio, null);
});

// ── the ladder ────────────────────────────────────────────────────────────────

test('clean CVR divides by unexcluded sessions only; raw divides by every session', () => {
  const ga4Rows = [
    seg('/products/lotion', 400),                                             // clean
    seg('/products/lotion', 300, { country: 'Singapore' }),                   // non-us
    seg('/', 200, { source: '(not set)', channel: 'Unassigned' }),            // no-source
    seg('/', 50, { source: 'contestgirl.com', channel: 'Referral' }),         // sweepstakes
    seg('/pages/free-soap-giveaway', 50, { source: 'facebook', channel: 'Paid Social' }), // giveaway
  ];
  const orderRows = attributionRows([order(), order()]);
  const s = computeScoreboard({ ga4Rows, orderRows });

  assert.equal(s.sessions.all, 1000);
  assert.equal(s.sessions.clean, 400);
  assert.equal(s.cvr.raw, 2 / 1000);
  assert.equal(s.cvr.clean, 2 / 400);
  const rungs = Object.fromEntries(s.ladder.rungs.map((r) => [r.reason, r.sessions]));
  assert.deepEqual(rungs, {
    'unusable-landing-page': 0, 'non-us': 300, 'no-source': 200, 'sweepstakes-referrer': 50, 'giveaway-lander': 50,
  });
});

test('the ladder sums: all sessions minus every rung equals clean', () => {
  const ga4Rows = [
    seg('/products/lotion', 123),
    seg('(not set)', 17),                          // unusable landing page — a rung, not lost
    seg('/', 40, { country: 'China' }),
  ];
  const s = computeScoreboard({ ga4Rows, orderRows: [] });
  const removed = s.ladder.rungs.reduce((n, r) => n + r.sessions, 0);
  assert.equal(s.sessions.all, 180);
  assert.equal(s.sessions.all - removed, s.sessions.clean);
  assert.equal(s.sessions.clean, 123);
});

// ── orders ────────────────────────────────────────────────────────────────────

test('no-landing-page orders are reported but never enter a CVR numerator', () => {
  const ga4Rows = [seg('/products/lotion', 1000)];
  const orderRows = attributionRows([
    order({ total: 40 }),
    order({ total: 30, landing: null, referrer: null, source_name: 'subscription_contract' }),
    order({ total: 30, landing: null, referrer: null, source_name: 'subscription_contract' }),
  ]);
  const s = computeScoreboard({ ga4Rows, orderRows });
  assert.equal(s.orders.countsAsRevenue, 3);
  assert.equal(s.orders.sessionDriven, 1);
  assert.equal(s.orders.noLandingPage, 2);
  assert.equal(s.orders.noLandingPageRevenue, 60);
  assert.equal(s.cvr.raw, 1 / 1000);
  assert.equal(s.cvr.clean, 1 / 1000);
});

test('cancelled, test and $0 orders do not count', () => {
  const orderRows = attributionRows([
    order({ total: 50 }),
    order({ total: 50, cancelled: true }),
    order({ total: 0 }),
  ]);
  const s = computeScoreboard({ ga4Rows: [seg('/products/lotion', 100)], orderRows });
  assert.equal(s.orders.fetched, 3);
  assert.equal(s.orders.countsAsRevenue, 1);
});

// ── AOV ───────────────────────────────────────────────────────────────────────

test('median on an odd and an even count', () => {
  assert.equal(median([30, 10, 20]), 20);
  assert.equal(median([10, 40, 20, 30]), 25);
  assert.equal(median([]), null);
});

test('mean and median AOV diverge on a skewed month — why both are printed', () => {
  // The shape measured on the live store: at ~0.6 orders/day three $200+ orders
  // moved the 28-day mean from $44 to $67. The median barely moves.
  const totals = [40, 42, 44, 44, 46, 48, 210, 220, 240];
  const orderRows = attributionRows(totals.map((total) => order({ total })));
  const s = computeScoreboard({ ga4Rows: [seg('/products/lotion', 1000)], orderRows });
  assert.equal(s.aov.median, 46);
  assert.equal(s.aov.mean, Math.round((totals.reduce((a, b) => a + b, 0) / totals.length) * 100) / 100);
  assert.ok(s.aov.mean > s.aov.median * 1.9, `mean ${s.aov.mean} vs median ${s.aov.median}`);
});

test('AOV is null, not NaN, with no orders', () => {
  const s = computeScoreboard({ ga4Rows: [seg('/', 10)], orderRows: [] });
  assert.equal(s.aov.mean, null);
  assert.equal(s.aov.median, null);
});

// ── GA4 purchases cross-check ─────────────────────────────────────────────────

test('GA4-vs-Shopify ratio is null (not Infinity/NaN) at zero orders', () => {
  const s = computeScoreboard({ ga4Rows: [seg('/products/lotion', 500, { purchases: 3 })], orderRows: [] });
  assert.equal(s.tracking.ga4Purchases, 3);
  assert.equal(s.tracking.ratio, null);
});

test('GA4-vs-Shopify ratio is GA4 purchases over session-driven Shopify orders', () => {
  const ga4Rows = [
    seg('/products/lotion', 500, { purchases: 3 }),
    seg('/', 100, { country: 'Singapore', purchases: 1 }), // counts: the ratio is ALL traffic
  ];
  const orderRows = attributionRows([
    order(), order(), order(), order(),
    order({ landing: null, referrer: null, source_name: 'subscription_contract' }), // not session-driven
  ]);
  const s = computeScoreboard({ ga4Rows, orderRows });
  assert.equal(s.tracking.ga4Purchases, 4);
  assert.equal(s.tracking.shopifySessionDrivenOrders, 4);
  assert.equal(s.tracking.ratio, 1);
});

// ── channels ──────────────────────────────────────────────────────────────────

test('channel families crosswalk two different classifiers, and unknowns fall to other', () => {
  assert.equal(channelFamilyOfGa4('Organic Shopping'), 'organic-search');
  assert.equal(channelFamilyOfGa4('Paid Social'), 'paid');
  assert.equal(channelFamilyOfGa4('Unassigned'), 'other');
  assert.equal(channelFamilyOfGa4('Something GA4 Invents Next Year'), 'other');
  assert.equal(channelFamilyOfShopify('paid-search'), 'paid');
  assert.equal(channelFamilyOfShopify('subscription'), 'other');
});

test('AI assistants are their own family on BOTH sides — GA4 emits an `AI Assistant` group', () => {
  // Found on the first live run (2026-09-16): GA4 reported 35 clean sessions under
  // `AI Assistant`, which the first crosswalk filed as `other` while Shopify's
  // ai-assistant orders went to `referral` — the same traffic split across two rows.
  assert.equal(channelFamilyOfGa4('AI Assistant'), 'ai-assistant');
  assert.equal(channelFamilyOfShopify('ai-assistant'), 'ai-assistant');
});

test('by-channel uses CLEAN traffic on both sides of the join', () => {
  const ga4Rows = [
    seg('/products/lotion', 300),                                          // organic-search, clean
    seg('/products/lotion', 100, { channel: 'Direct', source: '(direct)' }), // direct, clean
    seg('/products/lotion', 900, { country: 'Singapore' }),                // excluded
  ];
  const orderRows = attributionRows([
    order(),                                       // organic-search, clean
    order({ referrer: null }),                     // direct, clean
    order({ country: 'SG' }),                      // non-us order: excluded from the clean side
  ]);
  const s = computeScoreboard({ ga4Rows, orderRows });
  const by = Object.fromEntries(s.byChannel.map((c) => [c.family, c]));
  assert.equal(by['organic-search'].sessions, 300);
  assert.equal(by['organic-search'].orders, 1);
  assert.equal(by['organic-search'].cvr, 1 / 300);
  assert.equal(by.direct.sessions, 100);
  assert.equal(by.direct.orders, 1);
  const sumSessions = s.byChannel.reduce((n, c) => n + c.sessions, 0);
  const sumOrders = s.byChannel.reduce((n, c) => n + c.orders, 0);
  assert.equal(sumSessions, s.sessions.clean);
  assert.equal(sumOrders, s.orders.clean);
});

test('a family with orders but no sessions has a null CVR, never Infinity', () => {
  const s = computeScoreboard({
    ga4Rows: [seg('/products/lotion', 100)],
    orderRows: attributionRows([order({ referrer: 'https://chatgpt.com/' })]),
  });
  const ai = s.byChannel.find((c) => c.family === 'ai-assistant');
  assert.equal(ai.orders, 1);
  assert.equal(ai.cvr, null);
});

// ── the sample warning ────────────────────────────────────────────────────────

test('small-sample flag fires under 30 clean orders', () => {
  assert.equal(SMALL_SAMPLE_ORDERS, 30);
  const s = computeScoreboard({ ga4Rows: [seg('/products/lotion', 100)], orderRows: attributionRows([order()]) });
  assert.equal(s.smallSample, true);
});

// ── the production ladder, end to end ─────────────────────────────────────────

test('the measured 2026-08-20 → 09-15 ladder reproduces clean ≈ 2,701 sessions at ≈ 0.52%', () => {
  // Measured through lib/commercial-cvr.js (PR #888): 18,201 sessions; non-US
  // 2,744; `(not set)` source 2,857; sweepstakes referrers 2,580; giveaway funnel
  // 7,319 → 2,701 clean US shoppable sessions, 14 orders. The old scoreboard read
  // ~0.08% off the same window — 14 orders over every session.
  const ga4Rows = [
    seg('/products/coconut-lotion', 700, { purchases: 5 }),
    seg('/collections/lotion', 201, { channel: 'Direct', source: '(direct)' }),
    seg('/blogs/news/toothpaste-without-sls', 1500, { purchases: 6 }),
    seg('/', 300, { channel: 'Direct', source: '(direct)', purchases: 2 }),
    seg('/products/coconut-lotion', 2744, { country: 'Singapore' }),
    seg('/', 2857, { source: '(not set)', channel: 'Unassigned' }),
    seg('/', 2580, { source: 'contestgirl.com', channel: 'Referral' }),
    seg('/pages/free-soap-giveaway', 5128, { source: 'facebook', channel: 'Paid Social' }),
    seg('/pages/giveaway-confirmed', 2191, { source: '(direct)', channel: 'Direct' }),
  ];
  const clean = [
    ...Array.from({ length: 5 }, () => order({ landing: '/products/coconut-lotion', total: 44 })),
    ...Array.from({ length: 7 }, () => order({ landing: '/blogs/news/toothpaste-without-sls', total: 38 })),
    ...Array.from({ length: 2 }, () => order({ landing: '/', referrer: null, total: 220 })),
  ];
  const renewals = Array.from({ length: 2 }, () =>
    order({ landing: null, referrer: null, source_name: 'subscription_contract', total: 30 }));
  const s = computeScoreboard({ ga4Rows, orderRows: attributionRows([...clean, ...renewals]) });

  assert.equal(s.sessions.all, 18201);
  assert.equal(s.sessions.clean, 2701);
  assert.equal(s.orders.clean, 14);
  assert.equal(s.orders.noLandingPage, 2);
  assert.equal(Number((s.cvr.clean * 100).toFixed(2)), 0.52);
  assert.equal(Number((s.cvr.raw * 100).toFixed(2)), 0.08);
  assert.equal(s.tracking.ratio, 13 / 14);
  assert.equal(s.smallSample, true);
  deepNoNaN(s);
});

// ── the window ────────────────────────────────────────────────────────────────

test('the default window is 28 days ending YESTERDAY, so no partial day is in the denominator', () => {
  const w = scoreboardWindow({ yesterday: '2026-09-15' });
  assert.deepEqual(w, { start: '2026-08-19', end: '2026-09-15', days: 28, requestedDays: 28, clamped: false });
});

test('the default window clamps forward out of the GA4 hole', () => {
  const w = scoreboardWindow({ yesterday: '2026-08-20' });
  const firstClean = new Date(Date.parse(GA4_HOLE_END) + 86400000).toISOString().slice(0, 10);
  assert.equal(w.start, firstClean);
  assert.equal(w.clamped, true);
  assert.equal(w.days, 17);
});

test('an explicit [days] is never clamped — the CLI refuses it instead', () => {
  const w = scoreboardWindow({ days: 60, yesterday: '2026-09-15' });
  assert.equal(w.start, '2026-07-18');
  assert.equal(w.clamped, false);
  assert.ok(w.start <= GA4_HOLE_END);
});
