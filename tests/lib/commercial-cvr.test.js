import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLandingPath, segmentOf, aggregateCvr, assertGa4WindowClean,
  sessionExclusion, orderExclusion, isSweepstakesReferrer, isGiveawayPath,
  GA4_HOLE_END, GIVEAWAY_PATHS, EXCLUSION_REASONS, US_GA4_COUNTRY, US_COUNTRY_CODES,
  heroOffers,
} from '../../lib/commercial-cvr.js';

// ─────────────────────────────────────────────────────────────────────────────
// Why this module exists.
//
// The site-wide CVR (0.48-0.82%) has blog sessions in its denominator that
// convert ~0, so it cannot answer "would paid traffic to a PDP pay for itself".
// This splits the rate by landing-page type against Shopify landing_site orders,
// which are ground truth.
//
// The FIRST version of that split was still wrong, and the figures it produced
// -- blog 0.07%, commercial 0.47% (2026-08-04 -> 08-29) and commercial 0.40%
// (2026-08-17 -> 09-13) -- are UNSEGMENTED. They divide real orders by a
// denominator holding bot traffic and giveaway traffic. Do not quote them.
//
// MEASURED by a live end-to-end run on 2026-09-15 for 2026-08-17 -> 2026-09-13.
// Sessions per rung are GA4's; order counts are Shopify `landing_site` orders:
//
//   rung                                   sessions   orders
//   all sessions                             16,782       19
//   non-US (Singapore the largest)            2,886        0
//   US, sessionSource `(not set)`             4,373        0
//   US sweepstakes-aggregator referrers       2,440        0
//   US giveaway funnel, other sources         4,261        0
//   CLEAN US SHOPPABLE                        2,822       17   (2 more have no landing page)
//     of which product+collection               585        4  -> 0.68%
//     blog, for contrast                      1,824        8  -> 0.44%
//
// A further 240 sessions land on a page GA4 truncated past recognition and are
// reported as `unmappedSessions`, outside the ladder: 16,782 + 240 = 17,022.
//
// Engagement rates from the cross-tab that found the rungs, against a 43% site
// average: `(not set)` engages at 2.5% (the bot signature), while the sweepstakes
// and giveaway rungs engage at 86% and 77% — real humans who are not shoppers.
//
// TWO SOURCES, AND THEY DISAGREE ABOUT ORDERS. Counting the same window with
// GA4's `ecommercePurchases` gives commercial 6 orders / 578 sessions = 1.04% and
// blog 4; Shopify says commercial 4 / 585 = 0.68% and blog 8. SHOPIFY WINS ON
// ORDERS — it is ground truth with no modelling, which is why this report joins
// to it. The two attribute the same purchase to different landing pages often
// enough to move the answer at this sample size.
//
// So the honest figure is ~0.7-1.0% ON 4-6 ORDERS. It brackets the 1.03% US-PDP
// figure measured 2026-09-03 by an independent method (the GA4 snapshot's country
// breakdown), so ~1% is corroborated in SHAPE by two paths. No decimal is.
//
// Directional, not a point estimate.
// ─────────────────────────────────────────────────────────────────────────────

test('normalizeLandingPath strips the query string', () => {
  assert.equal(normalizeLandingPath('/products/lotion?utm_source=meta&gclid=abc'), '/products/lotion');
});

test('normalizeLandingPath strips a trailing slash but never reduces the homepage to empty', () => {
  assert.equal(normalizeLandingPath('/collections/soap/'), '/collections/soap');
  assert.equal(normalizeLandingPath('/'), '/');
});

test('normalizeLandingPath returns null for GA4 (not set)', () => {
  assert.equal(normalizeLandingPath('(not set)'), null);
  assert.equal(normalizeLandingPath(''), null);
  assert.equal(normalizeLandingPath(null), null);
});

test('the giveaway lander is its own segment, not a generic /pages/ row', () => {
  // 4,359 sessions -> 0 orders in the measured window. Left inside `page` it
  // drags an unrelated bucket to zero and hides whatever else lives there.
  assert.equal(segmentOf('/pages/free-soap-giveaway'), 'giveaway-lander');
  assert.equal(segmentOf('/pages/about-us'), 'page');
});

// ── the giveaway funnel is five pages, not one ───────────────────────────────
//
// Found on the first live end-to-end run, 2026-08-17 -> 09-13. An exact-set test
// caught only the lander itself, leaving ~1,385 zero-order sessions in the
// generic `page` bucket: /pages/giveaway-confirmed (1,192) and
// /pages/giveaway-entered (377) are the POST-ENTRY funnel — people who have just
// entered a free giveaway, with no purchase intent whatever — plus
// /pages/giveaway-official-rules (30).
//
// GA4's `landingPage` dimension also TRUNCATES some URLs mid-path, which is how
// `/pages/free-soap-givea=`, `/pages/giveaway-entere=` and `/pages/givea=` come
// to exist. Those are real sessions with a mangled label. Anyone who later tries
// to match a giveaway path by literal equality will miss them.

test('every landing page in the giveaway funnel is a giveaway-lander', () => {
  for (const p of [
    '/pages/free-soap-giveaway',
    '/pages/giveaway-confirmed',
    '/pages/giveaway-entered',
    '/pages/giveaway-official-rules',
    // GA4 truncation artifacts — real sessions, mangled labels.
    '/pages/free-soap-givea=',
    '/pages/giveaway-entere=',
    '/pages/givea=',
  ]) {
    assert.equal(segmentOf(p), 'giveaway-lander', p);
  }
});

test('real live /pages/ that are NOT the giveaway stay in the page bucket', () => {
  // A false positive here removes real traffic from the denominator, which makes
  // CVR read too HIGH. Same doctrine as SWEEPSTAKES_TOKENS: narrow, and widened
  // only against a measured list.
  for (const p of ['/pages/about-us', '/pages/veterans', '/pages/faqs', '/pages/refund-policy-1']) {
    assert.equal(segmentOf(p), 'page', p);
  }
});

test('the giveaway rule is scoped to /pages/, so a product handle cannot trip it', () => {
  assert.equal(segmentOf('/products/giveaway-soap-bundle'), 'product');
  assert.equal(segmentOf('/collections/giveaway'), 'collection');
  assert.equal(segmentOf('/blogs/news/our-giveaway-winners'), 'blog');
});

test('the exported path set and the predicate agree about the original lander', () => {
  // GIVEAWAY_PATHS stays exported for callers, but matching goes through the
  // predicate. Two spellings of the same rule that could disagree is the bug.
  for (const p of GIVEAWAY_PATHS) assert.equal(isGiveawayPath(p), true, p);
  assert.equal(isGiveawayPath('/pages/giveaway-confirmed'), true);
  assert.equal(isGiveawayPath('/pages/about-us'), false);
  assert.equal(isGiveawayPath(null), false);
});

test('segmentOf uses the same page-type vocabulary as order attribution', () => {
  assert.equal(segmentOf('/'), 'home');
  assert.equal(segmentOf('/blogs/news/best-soap'), 'blog');
  assert.equal(segmentOf('/products/lotion'), 'product');
  assert.equal(segmentOf('/collections/deodorant'), 'collection');
  assert.equal(segmentOf('/cart/12345'), 'other');
});

test('aggregateCvr joins GA4 sessions to Shopify orders per segment', () => {
  const out = aggregateCvr({
    ga4Rows: [
      { page: '/products/lotion', sessions: 700 },
      { page: '/products/cream?utm=x', sessions: 45 },
      { page: '/blogs/news/a', sessions: 7665 },
    ],
    orderRows: [
      { landingPath: '/products/lotion', total: 50, countsAsRevenue: true },
      { landingPath: '/blogs/news/a', total: 30, countsAsRevenue: true },
    ],
  });

  const product = out.segments.find((s) => s.segment === 'product');
  assert.equal(product.sessions, 745);
  assert.equal(product.orders, 1);
  assert.equal(product.revenue, 50);

  const blog = out.segments.find((s) => s.segment === 'blog');
  assert.equal(blog.sessions, 7665);
  assert.equal(blog.cvr, 1 / 7665);
});

test('aggregateCvr rolls product+collection into a commercial figure', () => {
  const out = aggregateCvr({
    ga4Rows: [
      { page: '/products/lotion', sessions: 745 },
      { page: '/collections/soap', sessions: 111 },
    ],
    orderRows: [
      { landingPath: '/products/lotion', total: 40, countsAsRevenue: true },
      { landingPath: '/products/lotion', total: 60, countsAsRevenue: true },
    ],
  });
  assert.equal(out.commercial.sessions, 856);
  assert.equal(out.commercial.orders, 2);
  assert.equal(out.commercial.revenue, 100);
  assert.ok(Math.abs(out.commercial.cvr - 2 / 856) < 1e-12);
});

test('aggregateCvr excludes non-revenue orders from the numerator', () => {
  // Admin previews, TEST-discount orders, cancellations and $0 orders are
  // classified with countsAsRevenue:false rather than dropped upstream.
  const out = aggregateCvr({
    ga4Rows: [{ page: '/products/lotion', sessions: 100 }],
    orderRows: [
      { landingPath: '/products/lotion', total: 50, countsAsRevenue: true },
      { landingPath: '/products/lotion', total: 999, countsAsRevenue: false },
    ],
  });
  const product = out.segments.find((s) => s.segment === 'product');
  assert.equal(product.orders, 1);
  assert.equal(product.revenue, 50);
});

test('orders with no landing page are counted apart, never as a zero-session segment', () => {
  // Subscription renewals and app-channel orders have no web session at all.
  // Bucketing them as a segment would invent a division by zero sessions.
  const out = aggregateCvr({
    ga4Rows: [{ page: '/products/lotion', sessions: 100 }],
    orderRows: [
      { landingPath: null, total: 37.42, countsAsRevenue: true },
      { landingPath: '/products/lotion', total: 50, countsAsRevenue: true },
    ],
  });
  assert.equal(out.noLandingPage.orders, 1);
  assert.equal(out.noLandingPage.revenue, 37.42);
  assert.ok(!out.segments.some((s) => s.segment === null));
});

test('a segment with sessions but no orders reports 0% rather than null', () => {
  const out = aggregateCvr({
    ga4Rows: [{ page: '/collections/soap', sessions: 111 }],
    orderRows: [],
  });
  const collection = out.segments.find((s) => s.segment === 'collection');
  assert.equal(collection.orders, 0);
  assert.equal(collection.cvr, 0);
});

test('a segment with orders but zero sessions reports a null CVR, not Infinity', () => {
  const out = aggregateCvr({
    ga4Rows: [],
    orderRows: [{ landingPath: '/products/lotion', total: 50, countsAsRevenue: true }],
  });
  const product = out.segments.find((s) => s.segment === 'product');
  assert.equal(product.sessions, 0);
  assert.equal(product.cvr, null);
});

test('assertGa4WindowClean refuses a window starting inside the GA4 hole', () => {
  // The property was trashed 2026-07-27 -> 08-03; restoring it does not recover
  // discarded hits. Sessions go missing from the DENOMINATOR only, so a window
  // spanning the hole reports CVR too HIGH -- the dangerous direction.
  assert.throws(() => assertGa4WindowClean('2026-07-20'), /GA4/);
  assert.throws(() => assertGa4WindowClean(GA4_HOLE_END), /GA4/);
  assert.doesNotThrow(() => assertGa4WindowClean('2026-08-04'));
});

test('the giveaway path list is exported so callers cannot silently disagree about it', () => {
  assert.ok(GIVEAWAY_PATHS.has('/pages/free-soap-giveaway'));
});

// ── the exclusion ladder ─────────────────────────────────────────────────────
//
// Every test below exists because the denominator used to hold traffic that
// could never have bought anything. The DIRECTION of a mistake here is what
// matters: excluding real traffic shrinks the denominator and makes CVR read
// too HIGH, which is the same failure direction assertGa4WindowClean already
// refuses. So every rule is written to fire only on positive evidence.

test('a non-US session is excluded on its own evidence', () => {
  assert.equal(sessionExclusion({ country: 'Singapore', source: 'google', page: '/products/lotion' }), 'non-us');
});

test('an explicit `(not set)` source is excluded — it is the bot signature', () => {
  // 4,382 sessions at 2.5% engagement against a 43% site average. Nothing a
  // human does looks like that.
  assert.equal(
    sessionExclusion({ country: US_GA4_COUNTRY, source: '(not set)', page: '/products/lotion' }),
    'no-source',
  );
});

test('a sweepstakes-aggregator referrer is excluded — real humans, not shoppers', () => {
  assert.equal(
    sessionExclusion({ country: US_GA4_COUNTRY, source: 'contestgirl.com', page: '/pages/free-soap-giveaway' }),
    'sweepstakes-referrer',
  );
  // sweepsadvantage arrives bare, with no TLD, in the measured window.
  assert.equal(
    sessionExclusion({ country: US_GA4_COUNTRY, source: 'sweepsadvantage', page: '/blogs/news/a' }),
    'sweepstakes-referrer',
  );
});

test('the giveaway lander is excluded whatever sent the traffic to it', () => {
  assert.equal(
    sessionExclusion({ country: US_GA4_COUNTRY, source: 'facebook', page: '/pages/free-soap-giveaway' }),
    'giveaway-lander',
  );
});

test('a row with NO country and NO source is never excluded', () => {
  // Both the back-compat case (every existing GA4 row carries neither) and the
  // conservative direction: unknown means keep, because excluding real traffic
  // inflates CVR.
  assert.equal(sessionExclusion({ page: '/products/lotion' }), null);
  assert.equal(sessionExclusion({ country: null, source: null, page: '/products/lotion' }), null);
  assert.equal(sessionExclusion({ country: '', source: '', page: '/products/lotion' }), null);
  // An UNKNOWN country is not a non-US country. GA4 spells `(not set)` here too.
  assert.equal(sessionExclusion({ country: '(not set)', source: 'google', page: '/products/lotion' }), null);
});

test('a US session from an ordinary source on a product page survives', () => {
  assert.equal(
    sessionExclusion({ country: US_GA4_COUNTRY, source: 'google', page: '/products/lotion' }),
    null,
  );
});

test('rung ORDER: a non-US giveaway session is attributed to non-us, never counted twice', () => {
  // The rungs are a LADDER, not a set of tags. A session can satisfy several and
  // must land on exactly one, or the printed ladder does not sum to the total.
  assert.equal(
    sessionExclusion({ country: 'Singapore', source: 'contestgirl.com', page: '/pages/free-soap-giveaway' }),
    'non-us',
  );
  assert.deepEqual(EXCLUSION_REASONS, ['non-us', 'no-source', 'sweepstakes-referrer', 'giveaway-lander']);
});

test('the sweepstakes rule does not fire on bare `contest` or `prize`', () => {
  // Deliberately narrow. A false positive here removes real traffic from the
  // denominator, which makes CVR read too high.
  assert.equal(isSweepstakesReferrer('contestofchampions.com'), false);
  assert.equal(isSweepstakesReferrer('prizepicks.com'), false);
  assert.equal(isSweepstakesReferrer('google.com'), false);
  assert.equal(isSweepstakesReferrer(null), false);
  assert.equal(isSweepstakesReferrer('freebieshark.com'), true);
});

test('an order is excluded on ITS OWN evidence, and an unknown country is kept', () => {
  // Filtering only sessions would drop non-US from the denominator while keeping
  // every order in the numerator — CVR reads too high, the dangerous direction.
  assert.equal(orderExclusion({ country: 'SG', landingPath: '/products/lotion' }), 'non-us');
  assert.equal(orderExclusion({ country: 'US', landingPath: '/products/lotion' }), null);
  assert.equal(orderExclusion({ country: null, landingPath: '/products/lotion' }), null);
  assert.equal(orderExclusion({ landingPath: '/products/lotion' }), null);
  assert.equal(
    orderExclusion({ country: 'US', referrerHost: 'sweepstakestoday.com', landingPath: '/products/lotion' }),
    'sweepstakes-referrer',
  );
  assert.equal(orderExclusion({ country: 'US', landingPath: '/pages/free-soap-giveaway' }), 'giveaway-lander');
  assert.ok(US_COUNTRY_CODES.has('US'), 'Shopify uses ISO-2 where GA4 spells the country out');
});

test('a non-US order leaves the clean numerator and lands in its rung', () => {
  const out = aggregateCvr({
    ga4Rows: [
      { page: '/products/lotion', country: 'United States', source: 'google', sessions: 100 },
      { page: '/products/lotion', country: 'Singapore', source: 'google', sessions: 900 },
    ],
    orderRows: [
      { landingPath: '/products/lotion', country: 'US', total: 50, countsAsRevenue: true },
      { landingPath: '/products/lotion', country: 'SG', total: 40, countsAsRevenue: true },
      // No country at all — kept, same rule as the sessions side.
      { landingPath: '/products/lotion', total: 10, countsAsRevenue: true },
    ],
  });
  const product = out.segments.find((s) => s.segment === 'product');
  assert.equal(product.sessions, 100);
  assert.equal(product.orders, 2, 'the US order and the unknown-country order');
  assert.equal(product.revenue, 60);

  const nonUs = out.excluded.find((e) => e.reason === 'non-us');
  assert.equal(nonUs.sessions, 900);
  assert.equal(nonUs.orders, 1);
  assert.equal(nonUs.revenue, 40);
});

test('rawTotals holds everything while totals and commercial hold only clean traffic', () => {
  const out = aggregateCvr({
    ga4Rows: [
      { page: '/products/lotion', country: 'United States', source: 'google', sessions: 100 },
      { page: '/products/lotion', country: 'Singapore', source: 'google', sessions: 900 },
      { page: '/blogs/news/a', country: 'United States', source: '(not set)', sessions: 4000 },
      { page: '/pages/free-soap-giveaway', country: 'United States', source: 'facebook', sessions: 2000 },
    ],
    orderRows: [
      { landingPath: '/products/lotion', country: 'US', total: 50, countsAsRevenue: true },
      { landingPath: '/products/lotion', country: 'SG', total: 40, countsAsRevenue: true },
    ],
  });

  assert.equal(out.totals.sessions, 100);
  assert.equal(out.commercial.sessions, 100);
  assert.equal(out.commercial.orders, 1);
  assert.equal(out.rawTotals.sessions, 7000);
  assert.equal(out.rawTotals.orders, 2);

  const excludedSessions = out.excluded.reduce((n, e) => n + e.sessions, 0);
  assert.equal(out.rawTotals.sessions, out.totals.sessions + excludedSessions,
    'the ladder must sum: a reader has to see how the raw total becomes the clean one');
});

test('revenue reconciles across clean, excluded and no-landing-page', () => {
  const out = aggregateCvr({
    ga4Rows: [{ page: '/products/lotion', country: 'United States', source: 'google', sessions: 100 }],
    orderRows: [
      { landingPath: '/products/lotion', country: 'US', total: 50, countsAsRevenue: true },
      { landingPath: '/products/lotion', country: 'SG', total: 40, countsAsRevenue: true },
      { landingPath: '/pages/free-soap-giveaway', country: 'US', total: 20, countsAsRevenue: true },
      { landingPath: null, country: 'US', total: 37.42, countsAsRevenue: true },
      { landingPath: '/products/lotion', country: 'US', total: 999, countsAsRevenue: false },
    ],
  });
  const excludedRevenue = out.excluded.reduce((n, e) => n + e.revenue, 0);
  const total = out.totals.revenue + excludedRevenue + out.noLandingPage.revenue;
  assert.equal(Math.round(total * 100) / 100, 147.42);
  assert.equal(out.rawTotals.revenue, 147.42);
});

// ── the regression test for the actual bug ───────────────────────────────────

test('the ladder arithmetic: segmenting moves commercial from 0.40% to 1.04% on one order set', () => {
  // A CONSTRUCTED fixture, not a transcript of a live run. It carries the
  // GA4-`ecommercePurchases` order counts (6 commercial / 9 blog), because those
  // are what the original cross-tab measured and they make the exclusion
  // arithmetic legible. The SCRIPT joins to Shopify instead and reads 4 / 8 on
  // the same window — see the two-sources note at the top of this file. What is
  // being pinned here is the ladder's behaviour, not either rate.
  //
  // The rungs sum to 17,009; the live window's 17,022 includes 13 further
  // sessions not reconstructed here because they change no verdict.
  const ga4Rows = [
    // clean US shoppable — 2,935
    { page: '/products/coconut-lotion', country: 'United States', source: 'google', sessions: 400 },
    { page: '/collections/soap', country: 'United States', source: 'google', sessions: 178 },
    { page: '/blogs/news/best-body-lotion', country: 'United States', source: 'google', sessions: 1800 },
    { page: '/', country: 'United States', source: 'google', sessions: 557 },
    // non-US — 2,975, Singapore the largest single country
    { page: '/products/coconut-lotion', country: 'Singapore', source: 'google', sessions: 522 },
    { page: '/blogs/news/best-body-lotion', country: 'China', source: 'google', sessions: 2453 },
    // US, sessionSource (not set) — 4,382 at 2.5% engagement
    { page: '/collections/soap', country: 'United States', source: '(not set)', sessions: 400 },
    { page: '/blogs/news/best-body-lotion', country: 'United States', source: '(not set)', sessions: 3982 },
    // US sweepstakes aggregators — 2,471
    { page: '/pages/free-soap-giveaway', country: 'United States', source: 'contestgirl.com', sessions: 1200 },
    { page: '/pages/free-soap-giveaway', country: 'United States', source: 'sweepsadvantage', sessions: 800 },
    { page: '/blogs/news/best-body-lotion', country: 'United States', source: 'freebieshark.com', sessions: 471 },
    // US giveaway lander, other sources — 4,246
    { page: '/pages/free-soap-giveaway', country: 'United States', source: 'facebook', sessions: 4246 },
  ];

  const orderRows = [
    ...Array.from({ length: 6 }, () => ({
      landingPath: '/products/coconut-lotion', country: 'US', total: 50, countsAsRevenue: true,
    })),
    ...Array.from({ length: 9 }, () => ({
      landingPath: '/blogs/news/best-body-lotion', country: 'US', total: 30, countsAsRevenue: true,
    })),
    { landingPath: '/products/coconut-lotion', country: 'SG', total: 40, countsAsRevenue: true },
    { landingPath: '/pages/free-soap-giveaway', country: 'US', total: 20, countsAsRevenue: true },
  ];

  const out = aggregateCvr({ ga4Rows, orderRows });

  assert.equal(out.rawTotals.sessions, 17009);
  assert.equal(out.rawTotals.orders, 17);
  assert.deepEqual(
    out.excluded.map((e) => [e.reason, e.sessions]),
    [['non-us', 2975], ['no-source', 4382], ['sweepstakes-referrer', 2471], ['giveaway-lander', 4246]],
  );
  assert.equal(out.totals.sessions, 2935);
  assert.equal(out.totals.orders, 15);

  // THE FINDING. 578 clean commercial sessions, 6 orders.
  assert.equal(out.commercial.sessions, 578);
  assert.equal(out.commercial.orders, 6);
  assert.equal((out.commercial.cvr * 100).toFixed(2), '1.04');

  // What the same orders read against the UNSEGMENTED commercial denominator —
  // 578 clean + 522 non-US + 400 bot = 1,500 — which is the number paid-media
  // decisions were being made from. 2.6x too low.
  const rawCommercialSessions = ga4Rows
    .filter((r) => ['product', 'collection'].includes(segmentOf(r.page)))
    .reduce((n, r) => n + r.sessions, 0);
  assert.equal(rawCommercialSessions, 1500);
  assert.equal(((out.commercial.orders / rawCommercialSessions) * 100).toFixed(2), '0.40');
});

// The offer contributions were hand-copied into scripts/commercial-page-cvr.mjs
// and went stale: the Coconut Reset sat at "$119 / $47" while the roster had
// repriced it to $121 with a $78.56 contribution, and the Sensitive Skin Set at
// $25 against a real $27.95. A break-even CPC computed from a contribution 40%
// too low tells you paid traffic is unaffordable when it is not. So the numbers
// are now DERIVED from the same rows `bundle-economics` prints, and this is the
// join that keeps them honest.
test('heroOffers reads contribution off the economics rows', () => {
  const rows = [
    { name: 'The 90-Day Coconut Reset', price: 121, contrib: 78.56 },
    { name: 'Sensitive Skin Moisturizing Set', price: 46.8, contrib: 27.95 },
    { name: 'Something Else', price: 10, contrib: 1 },
  ];
  const offers = heroOffers(rows, ['The 90-Day Coconut Reset', 'Sensitive Skin Moisturizing Set']);
  assert.equal(offers.length, 2);
  assert.equal(offers[0].contribution, 78.56);
  assert.match(offers[0].label, /Coconut Reset/);
  assert.match(offers[0].label, /\$121/, 'the label carries the price it was computed at');
});

test('a hero offer missing from the roster THROWS rather than scoring zero', () => {
  // Silently dropping it would print a break-even table with one column missing,
  // which reads like the offer is unaffordable rather than absent.
  assert.throws(
    () => heroOffers([{ name: 'A', price: 1, contrib: 1 }], ['Not In Roster']),
    /Not In Roster/,
  );
});
