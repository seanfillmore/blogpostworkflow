import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLandingPath, segmentOf, aggregateCvr, assertGa4WindowClean,
  GA4_HOLE_END, GIVEAWAY_PATHS,
} from '../../lib/commercial-cvr.js';

// ─────────────────────────────────────────────────────────────────────────────
// Why this module exists.
//
// The site-wide CVR (0.48-0.82%) has blog sessions in its denominator that
// convert ~0, so it cannot answer "would paid traffic to a PDP pay for itself".
// This splits the rate by landing-page type against Shopify landing_site orders,
// which are ground truth.
//
// Measured 2026-08-04 -> 08-29: blog 7,665 sessions / 5 orders = 0.07%;
// commercial 856 / 4 = 0.47%. The finding is that commercial is NOT better than
// site-wide -- blog contamination was not hiding a healthy PDP.
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
