// tests/lib/bing-keyword-gap.test.js
//
// Fixtures only — no network, no snapshot on disk, no keyword-index.json. The fixture
// numbers are scaled-down versions of the real 2026-08-18 shapes so the assertions
// mean something: one dominant zero-click row at a top position, a handful of ordinary
// clicking rows around it, branded misspellings that the cluster regex lets through,
// and an apex/www host mismatch.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  normalizeUrl, isBranded, hasCleanAngle, aggregateQueries, positionBucket, ctrBaseline,
  logProbZeroClicks, isPhantom, detectPhantoms, findCandidatePage, joinAgainstIndex,
  rankGaps, binomialTailAtMost, estimateCeiling,
  DDG_NEW_CUSTOMER_CVR, GOOGLE_ORGANIC_CVR,
} from '../../lib/bing-keyword-gap.js';

// ── fixtures ──────────────────────────────────────────────────────────────────

/** Mirrors the real feed: one loud silent row, several ordinary clicking rows. */
const SNAPSHOT = {
  date: '2026-08-18',
  site: 'https://realskincare.com/',
  range: { start: '2026-02-17', end: '2026-08-17', days: 177 },
  summary: { clicks: 167, impressions: 13224, ctr: 0.0126 },
  queries: [
    // The phantom: big, top-position, never clicked, across many weeks.
    { query: 'rival brand alternative', date: '2026-02-20', clicks: 0, impressions: 400, ctr: 0, impressionPosition: 2, clickPosition: null },
    { query: 'rival brand alternative', date: '2026-02-27', clicks: 0, impressions: 400, ctr: 0, impressionPosition: 3, clickPosition: null },
    { query: 'rival brand alternative', date: '2026-03-06', clicks: 0, impressions: 400, ctr: 0, impressionPosition: 3, clickPosition: null },
    // Ordinary top-position rows that DO click (~11%).
    { query: 'sls free toothpaste', date: '2026-02-20', clicks: 6, impressions: 50, ctr: 0.12, impressionPosition: 2, clickPosition: null },
    { query: 'natural deodorant no aluminum', date: '2026-02-20', clicks: 5, impressions: 50, ctr: 0.1, impressionPosition: 3, clickPosition: null },
    // A small zero-click row — too small to be called a phantom.
    { query: 'coconut lip balm', date: '2026-02-27', clicks: 0, impressions: 12, ctr: 0, impressionPosition: 2, clickPosition: null },
    // Branded, in three spellings the cluster regex alone does not all catch.
    { query: 'real skincare', date: '2026-02-20', clicks: 8, impressions: 40, ctr: 0.2, impressionPosition: 1, clickPosition: null },
    { query: 'reale skin care', date: '2026-02-27', clicks: 2, impressions: 20, ctr: 0.1, impressionPosition: 1, clickPosition: null },
    // Informational — must not reach the gap list.
    { query: 'what is castile soap', date: '2026-02-20', clicks: 1, impressions: 30, ctr: 0.033, impressionPosition: 6, clickPosition: null },
  ],
  pages: [
    { page: 'https://www.realskincare.com/blogs/news/sls-free-toothpaste-list', date: '2026-02-20', clicks: 6, impressions: 50, ctr: 0.12, impressionPosition: 2, clickPosition: null },
  ],
  coverage: { queries: { rows: 9, dates: 3, distinct: 7, clicks: 22, impressions: 1402, truncatedDates: [] }, pages: {} },
};

/** Only `sls free toothpaste` is already targeted. Keyed by the index's slug(). */
const INDEX = {
  built_at: '2026-08-10T15:31:21.969Z',
  total_keywords: 2,
  by_validation_source: { amazon: 1, gsc_ga4: 1, gsc_untapped: 0 },
  keywords: {
    'sls-free-toothpaste': { keyword: 'sls free toothpaste', slug: 'sls-free-toothpaste', cluster: 'toothpaste', validation_source: 'amazon' },
    'what-is-castile-soap': { keyword: 'what is castile soap', slug: 'what-is-castile-soap', cluster: 'soap', validation_source: 'gsc_ga4' },
  },
};

const BRAND_TERMS = ['real skin care', 'realskincare', 'culina'];

// ── host normalisation ────────────────────────────────────────────────────────

test('normalizeUrl collapses the apex/www split between Bing and GSC', () => {
  assert.equal(normalizeUrl('https://realskincare.com/'), 'realskincare.com');
  assert.equal(normalizeUrl('https://www.realskincare.com/blogs/news/x'), 'realskincare.com/blogs/news/x');
  // The two forms the two feeds actually use must compare equal.
  assert.equal(normalizeUrl('https://realskincare.com/blogs/news/x'), normalizeUrl('https://www.realskincare.com/blogs/news/x/'));
  assert.equal(normalizeUrl(null), null);
});

// ── branded separation ────────────────────────────────────────────────────────

test('isBranded catches the cluster rule, the config terms, and the misspellings', () => {
  assert.equal(isBranded('real skincare', BRAND_TERMS), true);       // cluster.js brand rule
  assert.equal(isBranded('real skin care reviews', BRAND_TERMS), true);
  assert.equal(isBranded('culina cast iron soap', BRAND_TERMS), true); // separate brand, must never appear
  // The two the cluster regex alone lets through as 'unclustered' — both real,
  // 42 and 16 impressions in the 2026-08-18 snapshot.
  assert.equal(isBranded('reale skin care', BRAND_TERMS), true);
  assert.equal(isBranded('real skin', BRAND_TERMS), true);
});

test('isBranded does not swallow ordinary product queries', () => {
  for (const q of ['sls free toothpaste', 'natural deodorant', 'coconut oil soap', 'dry skin lotion', 'best skin cream']) {
    assert.equal(isBranded(q, BRAND_TERMS), false, q);
  }
});

// ── clean-ingredient angle ────────────────────────────────────────────────────

test('hasCleanAngle tags the language the privacy audience uses', () => {
  for (const q of ['non toxic body lotion', 'aluminum free deodorant', 'sls-free toothpaste', 'natural lip balm', 'organic coconut lotion', 'toothpaste without fluoride', 'clean body lotion']) {
    assert.equal(hasCleanAngle(q), true, q);
  }
  for (const q of ['coconut oil soap base', 'sweat stains', 'lip balm tin']) {
    assert.equal(hasCleanAngle(q), false, q);
  }
});

// ── aggregation ───────────────────────────────────────────────────────────────

test('aggregateQueries sums per query and weights position by impressions', () => {
  const rows = aggregateQueries(SNAPSHOT);
  const phantom = rows.find((r) => r.key === 'rival brand alternative');
  assert.equal(phantom.impressions, 1200);
  assert.equal(phantom.clicks, 0);
  assert.equal(phantom.weeks, 3);
  assert.equal(phantom.firstSeen, '2026-02-20');
  assert.equal(phantom.lastSeen, '2026-03-06');
  // (2*400 + 3*400 + 3*400) / 1200 = 2.67 → rounded to 2.7
  assert.equal(phantom.position, 2.7);
});

test('aggregateQueries never divides by zero on an impressionless row', () => {
  const rows = aggregateQueries({ queries: [{ query: 'x', date: '2026-01-01', clicks: 0, impressions: 0, impressionPosition: null }] });
  assert.equal(rows[0].ctr, 0);
  assert.equal(rows[0].position, null);
});

// ── baseline ──────────────────────────────────────────────────────────────────

test('positionBucket puts positions in the right band', () => {
  assert.equal(positionBucket(1), '1-3');
  assert.equal(positionBucket(3), '1-3');
  assert.equal(positionBucket(4.9), '4-5');
  assert.equal(positionBucket(9), '6-10');
  assert.equal(positionBucket(40), '11+');
  assert.equal(positionBucket(null), null);
});

test('ctrBaseline honours excludeKeys — the difference the phantom makes', () => {
  const rows = aggregateQueries(SNAPSHOT);
  const withPhantom = ctrBaseline(rows);
  const without = ctrBaseline(rows, { excludeKeys: ['rival brand alternative'] });
  // Included, the 1,200 silent impressions crush the bucket; excluded, it is healthy.
  assert.ok(withPhantom['1-3'].ctr < 0.02, `got ${withPhantom['1-3'].ctr}`);
  assert.ok(without['1-3'].ctr > 0.09, `got ${without['1-3'].ctr}`);
});

// ── phantom detection ─────────────────────────────────────────────────────────

test('logProbZeroClicks is a log probability, negative and finite at scale', () => {
  const rows = aggregateQueries(SNAPSHOT);
  const base = ctrBaseline(rows, { excludeKeys: ['rival brand alternative'] });
  const phantom = rows.find((r) => r.key === 'rival brand alternative');
  const lp = logProbZeroClicks(phantom, base);
  assert.ok(Number.isFinite(lp), 'must not underflow to -Infinity');
  assert.ok(lp < -100, `expected deeply improbable, got ${lp}`);
});

test('detectPhantoms finds the anomaly and returns a baseline with it removed', () => {
  const rows = aggregateQueries(SNAPSHOT);
  const { keys, rows: found, baseline } = detectPhantoms(rows);
  assert.deepEqual([...keys], ['rival brand alternative']);
  assert.equal(found.length, 1);
  assert.ok(baseline['1-3'].ctr > 0.09, 'returned baseline must have the phantom removed');
  // And that removal is not cosmetic — self-inclusive is 7x lower here.
  assert.ok(ctrBaseline(rows)['1-3'].ctr < 0.02);
});

test('leave-one-out is load-bearing: a big enough phantom hides from a naive baseline', () => {
  // The regression this pins. When the silent row dominates its bucket hard enough, a
  // self-inclusive baseline concludes "nothing at this position clicks much" — which is
  // a statement about the phantom itself — and the row escapes detection. Holding it out
  // asks the only question that means anything: what do its PEERS do?
  const rows = aggregateQueries({
    queries: [
      { query: 'silent giant', date: '2026-02-20', clicks: 0, impressions: 10000, ctr: 0, impressionPosition: 2, clickPosition: null },
      { query: 'ordinary a', date: '2026-02-20', clicks: 3, impressions: 25, ctr: 0.12, impressionPosition: 2, clickPosition: null },
      { query: 'ordinary b', date: '2026-02-20', clicks: 2, impressions: 25, ctr: 0.08, impressionPosition: 3, clickPosition: null },
    ],
  });
  const giant = rows.find((r) => r.key === 'silent giant');

  const naive = ctrBaseline(rows);
  assert.equal(isPhantom(giant, naive), false, 'self-inclusive baseline misses it');

  const loo = ctrBaseline(rows, { excludeKeys: ['silent giant'] });
  assert.equal(isPhantom(giant, loo), true, 'against its peers it is impossible');
  assert.deepEqual([...detectPhantoms(rows).keys], ['silent giant']);
});

test('detectPhantoms does not flag small zero-click rows or anything that clicked', () => {
  const rows = aggregateQueries(SNAPSHOT);
  const { keys } = detectPhantoms(rows);
  assert.equal(keys.has('coconut lip balm'), false, '12 impressions is not enough to conclude anything');
  assert.equal(keys.has('sls free toothpaste'), false, 'it clicked, so it is real');
});

test('detectPhantoms returns nothing on a feed with no anomaly', () => {
  const clean = { queries: SNAPSHOT.queries.filter((q) => q.query !== 'rival brand alternative') };
  const { keys, rows } = detectPhantoms(aggregateQueries(clean));
  assert.equal(keys.size, 0);
  assert.equal(rows.length, 0);
});

// ── page candidates ───────────────────────────────────────────────────────────

test('findCandidatePage prefers a page Bing already ranks, then the blog index', () => {
  const hit = findCandidatePage('sls free toothpaste', { pages: SNAPSHOT.pages });
  assert.equal(hit.source, 'bing-indexed');
  assert.match(hit.url, /sls-free-toothpaste-list/);

  const blogIndex = [{ handle: 'news', articles: [{ title: 'Natural Lip Balm: Best Ingredients', handle: 'natural-lip-balm-best-ingredients' }] }];
  const fromBlog = findCandidatePage('natural lip balm ingredients', { pages: [], blogIndex });
  assert.equal(fromBlog.source, 'blog-index');

  assert.equal(findCandidatePage('something we have never written about', { pages: SNAPSHOT.pages }), null);
});

// ── the join ──────────────────────────────────────────────────────────────────

test('joinAgainstIndex marks index membership on the index own slug key', () => {
  const joined = joinAgainstIndex(aggregateQueries(SNAPSHOT), INDEX, { brandTerms: BRAND_TERMS, pages: SNAPSHOT.pages });
  const targeted = joined.find((r) => r.key === 'sls free toothpaste');
  assert.equal(targeted.targeted, true);
  assert.equal(targeted.validationSource, 'amazon');

  const gap = joined.find((r) => r.key === 'natural deodorant no aluminum');
  assert.equal(gap.targeted, false);
  assert.equal(gap.validationSource, null);
});

test('joinAgainstIndex tags branded, intent, cluster, clean angle and phantom', () => {
  const joined = joinAgainstIndex(aggregateQueries(SNAPSHOT), INDEX, { brandTerms: BRAND_TERMS, pages: SNAPSHOT.pages });
  const byKey = Object.fromEntries(joined.map((r) => [r.key, r]));

  assert.equal(byKey['reale skin care'].branded, true);
  assert.equal(byKey['rival brand alternative'].phantom, true);
  assert.equal(byKey['what is castile soap'].intent, 'informational');
  assert.equal(byKey['what is castile soap'].commercial, false);
  assert.equal(byKey['natural deodorant no aluminum'].cleanAngle, true);
  assert.equal(byKey['natural deodorant no aluminum'].cluster, 'deodorant');
});

test('joinAgainstIndex tolerates a missing index rather than throwing', () => {
  const joined = joinAgainstIndex(aggregateQueries(SNAPSHOT), null, { brandTerms: BRAND_TERMS });
  assert.equal(joined.every((r) => r.targeted === false), true);
});

// ── ranking ───────────────────────────────────────────────────────────────────

test('rankGaps excludes branded, targeted, informational and phantom rows', () => {
  const joined = joinAgainstIndex(aggregateQueries(SNAPSHOT), INDEX, { brandTerms: BRAND_TERMS, pages: SNAPSHOT.pages });
  const keys = rankGaps(joined).map((g) => g.key);
  assert.ok(!keys.includes('real skincare'), 'branded');
  assert.ok(!keys.includes('reale skin care'), 'branded misspelling');
  assert.ok(!keys.includes('sls free toothpaste'), 'already targeted');
  assert.ok(!keys.includes('what is castile soap'), 'informational');
  assert.ok(!keys.includes('rival brand alternative'), 'phantom');
  assert.ok(keys.includes('natural deodorant no aluminum'), 'a genuine gap must survive');
});

test('rankGaps scores on expected clicks, so a loud silent row cannot outrank a real one', () => {
  // A 5,000-impression row at position 40 (a bucket that never clicks in this feed)
  // must rank below a 50-impression row at position 2.
  const rows = aggregateQueries({
    queries: [
      ...SNAPSHOT.queries,
      { query: 'loud but hopeless', date: '2026-02-20', clicks: 0, impressions: 5000, ctr: 0, impressionPosition: 40, clickPosition: null },
    ],
  });
  const ranked = rankGaps(joinAgainstIndex(rows, INDEX, { brandTerms: BRAND_TERMS }));
  const loud = ranked.find((r) => r.key === 'loud but hopeless');
  const real = ranked.find((r) => r.key === 'natural deodorant no aluminum');
  assert.equal(loud.score, 0, 'a bucket with no observed CTR yields no expected clicks');
  assert.ok(ranked.indexOf(real) < ranked.indexOf(loud), 'volume must not beat plausibility');
});

test('rankGaps applies the clean-angle multiplier', () => {
  const rows = aggregateQueries({
    queries: [
      { query: 'aluminum free deodorant', date: '2026-02-20', clicks: 0, impressions: 100, ctr: 0, impressionPosition: 2, clickPosition: null },
      { query: 'deodorant stick holder', date: '2026-02-20', clicks: 0, impressions: 100, ctr: 0, impressionPosition: 2, clickPosition: null },
      { query: 'anchor', date: '2026-02-20', clicks: 10, impressions: 100, ctr: 0.1, impressionPosition: 2, clickPosition: null },
    ],
  });
  const ranked = rankGaps(joinAgainstIndex(rows, INDEX, { brandTerms: BRAND_TERMS }));
  const clean = ranked.find((r) => r.key === 'aluminum free deodorant');
  const plain = ranked.find((r) => r.key === 'deodorant stick holder');
  assert.equal(clean.expectedClicks, plain.expectedClicks, 'same impressions and position');
  assert.ok(clean.score > plain.score, 'the clean-ingredient angle must win the tie');
  assert.equal(Math.round((clean.score / plain.score) * 10) / 10, 1.5);
});

// ── the premise test ──────────────────────────────────────────────────────────

test('binomialTailAtMost matches hand-computed values', () => {
  // P(0 | n=253, p=0.0288) = 0.9712^253
  assert.ok(Math.abs(binomialTailAtMost(0, 253, DDG_NEW_CUSTOMER_CVR) - Math.pow(1 - DDG_NEW_CUSTOMER_CVR, 253)) < 1e-12);
  // P(<=1 | n=10, p=0.5) = 11/1024
  assert.ok(Math.abs(binomialTailAtMost(1, 10, 0.5) - 11 / 1024) < 1e-12);
  assert.equal(binomialTailAtMost(0, 0, 0.5), 1);
});

test('the premise test rejects DDG rate for Bing sessions but not the Google rate', () => {
  const atDdg = binomialTailAtMost(0, 253, DDG_NEW_CUSTOMER_CVR);
  const atGoogle = binomialTailAtMost(0, 253, GOOGLE_ORGANIC_CVR);
  assert.ok(atDdg < 0.001, `0 orders on 253 sessions rejects 2.88% (p=${atDdg})`);
  assert.ok(atGoogle > 0.05, `0.60% survives the same evidence (p=${atGoogle})`);
});

// ── the ceiling ───────────────────────────────────────────────────────────────

test('estimateCeiling is built from the DAILY feed, never the sampled query rows', () => {
  const c = estimateCeiling({ snapshot: SNAPSHOT, nonBrandedClickShare: 0.75, cvr: GOOGLE_ORGANIC_CVR });
  // 167 clicks / 177 days * 30.437 = 28.7/mo (reported rounded, carried full-precision)
  assert.equal(c.monthlyClicks, 28.7);
  assert.equal(c.monthlyNonBrandedClicks, 21.5);
  // upliftFactor 2.0 → incremental equals current
  assert.equal(c.incrementalClicks, 21.5);
  // Dollars must come off the UNROUNDED click figure — rounding at each step and then
  // multiplying is how a ceiling drifts. 21.538... not the displayed 21.5.
  const exact = (167 / 177) * 30.437 * 0.75;
  assert.equal(c.monthlyRevenue, Math.round(exact * GOOGLE_ORGANIC_CVR * 50.46 * 100) / 100);
  // Annual is 12x the exact monthly, not 12x the DISPLAYED monthly — off by a cent here.
  assert.equal(c.annualRevenue, Math.round(exact * GOOGLE_ORGANIC_CVR * 50.46 * 12 * 100) / 100);
  assert.notEqual(c.annualRevenue, Math.round(c.monthlyRevenue * 12 * 100) / 100);
  // Sanity: the sampled query impressions (1,402) must play no part in the dollars.
  assert.equal(c.totalClicks, SNAPSHOT.summary.clicks);
});

test('estimateCeiling stays finite on a snapshot with no window', () => {
  const c = estimateCeiling({ snapshot: { range: { days: 0 }, summary: { clicks: 0 } }, nonBrandedClickShare: 0.8 });
  assert.equal(c.monthlyClicks, 0);
  assert.equal(c.monthlyRevenue, 0);
});

test('a higher CVR assumption scales the ceiling linearly and nothing else', () => {
  const lo = estimateCeiling({ snapshot: SNAPSHOT, nonBrandedClickShare: 0.75, cvr: GOOGLE_ORGANIC_CVR });
  const hi = estimateCeiling({ snapshot: SNAPSHOT, nonBrandedClickShare: 0.75, cvr: DDG_NEW_CUSTOMER_CVR });
  assert.equal(lo.incrementalClicks, hi.incrementalClicks);
  const ratio = hi.monthlyRevenue / lo.monthlyRevenue;
  assert.ok(Math.abs(ratio - DDG_NEW_CUSTOMER_CVR / GOOGLE_ORGANIC_CVR) < 0.01, `got ${ratio}`);
});
