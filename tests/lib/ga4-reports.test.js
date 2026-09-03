// tests/lib/ga4-reports.test.js
//
// GA4 is stubbed at the fetch boundary and these assert the REQUEST body, because both
// defects they guard are invisible in the response: a report that asks for the wrong
// dimensions still returns 200 with plausible-looking rows, and a `limit` that truncates
// returns exactly as many rows as it was told to. The daily snapshot is the only copy of
// this data once GA4's retention window passes, so a row never asked for is lost for good.
import { strict as assert } from 'node:assert';
import { test, beforeEach, afterEach } from 'node:test';

const realFetch = globalThis.fetch;
let reports = [];

function stubGA4(rowsFor = () => []) {
  reports = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('oauth2.googleapis.com/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: 'stub', expires_in: 3600 }) };
    }
    const body = JSON.parse(opts.body);
    reports.push(body);
    return { ok: true, status: 200, json: async () => ({ rows: rowsFor(body) }) };
  };
}

// Defensive on `dimensions`: fetchGA4Snapshot's summary call sends none, so a stub
// that inspects every request body would otherwise throw before the report it wants.
const dimNames = (body) => (body.dimensions ?? []).map((d) => d.name);
const row = (dims, mets) => ({
  dimensionValues: dims.map((value) => ({ value })),
  metricValues: mets.map((value) => ({ value: String(value) })),
});

beforeEach(() => { stubGA4(); });
afterEach(() => { globalThis.fetch = realFetch; });

test('fetchLandingPagesByChannel asks for sessionSource — the channel group alone cannot see Brave', async () => {
  const { fetchLandingPagesByChannel } = await import('../../lib/ga4.js');
  stubGA4((body) => (dimNames(body).includes('landingPage')
    ? [row(['/collections/x', 'Referral', 'search.brave.com'], [6])]
    : []));

  const rows = await fetchLandingPagesByChannel('2026-07-01', '2026-07-28');
  const body = reports.at(-1);

  assert.deepEqual(dimNames(body), ['landingPage', 'sessionDefaultChannelGroup', 'sessionSource']);
  // The source has to survive into the returned row or the caller cannot rescue it.
  assert.deepEqual(rows, [{
    page: '/collections/x', channel: 'Referral', source: 'search.brave.com', sessions: 6,
  }]);
});

test('fetchLandingPagesByChannel orders and limits by sessions, not by modelled revenue', async () => {
  // Revenue is Shopify's job now. If this limit ever bites it must drop the smallest
  // traffic, not the smallest dollars — and one page now yields a row per channel per
  // source, so the old 1000 was no longer enough headroom.
  const { fetchLandingPagesByChannel } = await import('../../lib/ga4.js');
  await fetchLandingPagesByChannel('2026-07-01', '2026-07-28');
  const body = reports.at(-1);

  assert.deepEqual(body.metrics, [{ name: 'sessions' }]);
  assert.equal(body.orderBys[0].metric.metricName, 'sessions');
  assert.ok(body.limit >= 10000, `limit must leave headroom for the extra dimension, got ${body.limit}`);
});

test('the daily snapshot keeps 25 traffic sources, not the top 5', async () => {
  // At limit 5 the stored 90-day history showed DuckDuckGo at 19 sessions where the
  // live API said 50 — every source outside the top 5 was silently discarded.
  const { fetchGA4Snapshot } = await import('../../lib/ga4.js');
  stubGA4((body) => {
    const dims = body.dimensions ? dimNames(body) : [];
    if (dims.join() === 'sessionSource,sessionMedium') {
      return [
        row(['google', 'organic'], [120, 2, 88.5]),
        row(['duckduckgo', 'organic'], [50, 0, 0]),
        row(['search.brave.com', 'referral'], [6, 0, 0]),
      ];
    }
    return [];
  });

  const snap = await fetchGA4Snapshot('2026-07-01');
  const sources = reports.find((b) => b.dimensions && dimNames(b).join() === 'sessionSource,sessionMedium');

  assert.equal(sources.limit, 25);
  assert.deepEqual(snap.topSources.map((s) => s.source), ['google', 'duckduckgo', 'search.brave.com']);
  assert.equal(snap.topSources[1].sessions, 50);
});

// ── country breakdown ────────────────────────────────────────────────────────
//
// Added 2026-09-03 after a paid-budget analysis was built on a site-wide 0.090%
// conversion rate that was almost entirely composition: 51% of sessions landed on
// blog posts, 38% on a giveaway page, and ~30% of PRODUCT-page sessions were non-US
// (China 159 + Singapore 55, zero orders between them). US-only product-page CVR was
// 1.03% — 11x the headline number. Without country on the snapshot every future CVR
// read repeats that mistake, because the snapshot is the only copy once GA4's
// retention window passes.
//
// Deliberately NOT a GA4 "data filter": those permanently drop the rows and cannot be
// undone retroactively. Same reason data/briefs/_dropped/ moves instead of deleting.

test('fetchGA4Snapshot asks for the country dimension and returns sessionsByCountry', async () => {
  const { fetchGA4Snapshot } = await import('../../lib/ga4.js');
  stubGA4((body) => (dimNames(body).includes('country')
    ? [row(['United States'], [582, 6, 588]), row(['Singapore'], [135, 0, 0])]
    : []));
  const snap = await fetchGA4Snapshot('2026-09-01');
  const asked = reports.some((b) => dimNames(b).includes('country'));
  assert.equal(asked, true, 'no report asked for country');
  assert.deepEqual(snap.sessionsByCountry, [
    { country: 'United States', sessions: 582, conversions: 6, revenue: 588 },
    { country: 'Singapore', sessions: 135, conversions: 0, revenue: 0 },
  ]);
});

test('fetchGA4Snapshot derives a us block from the country rows without an extra call', async () => {
  const { fetchGA4Snapshot } = await import('../../lib/ga4.js');
  stubGA4((body) => (dimNames(body).includes('country')
    ? [row(['United States'], [582, 6, 588]), row(['China'], [106, 0, 0])]
    : []));
  const snap = await fetchGA4Snapshot('2026-09-01');
  assert.equal(snap.us.sessions, 582);
  assert.equal(snap.us.conversions, 6);
  assert.equal(snap.us.revenue, 588);
  // 6/582 = 1.031% — the number the whole paid-media decision turns on.
  assert.equal(snap.us.conversionRate, 1.031);
});

test('us block is zeroed, never undefined, when GA4 returns no US row', async () => {
  const { fetchGA4Snapshot } = await import('../../lib/ga4.js');
  stubGA4((body) => (dimNames(body).includes('country') ? [row(['Singapore'], [4, 0, 0])] : []));
  const snap = await fetchGA4Snapshot('2026-09-01');
  // A consumer dividing by us.sessions must get 0, not a TypeError on undefined.
  assert.deepEqual(snap.us, { sessions: 0, conversions: 0, revenue: 0, conversionRate: 0 });
});

test('usLandingPages is filtered to the US in the REQUEST, not after the fact', async () => {
  const { fetchGA4Snapshot } = await import('../../lib/ga4.js');
  stubGA4(() => []);
  await fetchGA4Snapshot('2026-09-01');
  const filtered = reports.filter((b) => b.dimensionFilter);
  assert.equal(filtered.length, 1, 'expected exactly one country-filtered report');
  const f = filtered[0].dimensionFilter.filter;
  assert.equal(f.fieldName, 'country');
  assert.equal(f.stringFilter.value, 'United States');
  assert.deepEqual(dimNames(filtered[0]), ['landingPage']);
});

test('the country report is not truncated below the long tail', async () => {
  const { fetchGA4Snapshot } = await import('../../lib/ga4.js');
  stubGA4(() => []);
  await fetchGA4Snapshot('2026-09-01');
  const countryReport = reports.find((b) => dimNames(b).includes('country') && !b.dimensionFilter);
  // The Shopify cross-check hit a 1,000-row cap and lost ~3% of sessions in the tail.
  assert.ok((countryReport.limit ?? 0) >= 250, `country limit too low: ${countryReport.limit}`);
});
