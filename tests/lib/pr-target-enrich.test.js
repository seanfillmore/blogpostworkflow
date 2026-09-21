import test from 'node:test';
import assert from 'node:assert/strict';
import {
  articleDateSource, unreachableCurrencyReason, planAuthorChecks, enrichmentCounts,
} from '../../lib/pr-target-enrich.js';

// ── articleDateSource ────────────────────────────────────────────────────────

test('a real article URL we received is the only checkable source', () => {
  assert.equal(articleDateSource({ topUrl: 'https://elle.com/a', outcome: 'ok' }), 'article');
});

test('no article URL still means homepage — the pre-existing guard is intact', () => {
  // A homepage `dateModified` is the SITE's and is always fresh; reading it as
  // article freshness would certify exactly the dead targets the check demotes.
  assert.equal(articleDateSource({ topUrl: null, outcome: 'ok' }), 'homepage');
});

test('a page we never received is UNREACHABLE, not a page with no dates', () => {
  for (const outcome of ['blocked', 'timeout', 'rate-limited', 'not-found', 'network-error', 'server-error']) {
    assert.equal(articleDateSource({ topUrl: 'https://elle.com/a', outcome }), 'unreachable', outcome);
    assert.equal(articleDateSource({ topUrl: null, outcome }), 'unreachable', outcome);
  }
});

test('unreachableCurrencyReason carries the outcome into the reason histogram', () => {
  assert.equal(unreachableCurrencyReason('blocked'), 'article-blocked');
  assert.equal(unreachableCurrencyReason('timeout'), 'article-timeout');
  assert.equal(unreachableCurrencyReason('rate-limited'), 'article-rate-limited');
  // Never an empty suffix: a reason of "article-" names nothing.
  assert.equal(unreachableCurrencyReason(null), 'article-network-error');
  assert.equal(unreachableCurrencyReason(''), 'article-network-error');
});

// ── planAuthorChecks ─────────────────────────────────────────────────────────

const row = (author, url, extra = {}) => ({ author, author_url: url, ...extra });

test('the budget is spent in RANK ORDER, whatever order the fetches finished', () => {
  const rows = [
    row('A Person', 'https://a.test/author/a'),
    row('B Person', 'https://b.test/author/b'),
    row('C Person', 'https://c.test/author/c'),
  ];
  const plan = planAuthorChecks(rows, { budget: 2 });
  assert.deepEqual(plan.funded.map((g) => g.url), ['https://a.test/author/a', 'https://b.test/author/b']);
  assert.deepEqual(plan.unfunded.map((g) => g.url), ['https://c.test/author/c']);
});

test('planning is a pure function of the ranked list — identical inputs, identical spend', () => {
  const build = () => Array.from({ length: 20 }, (_, i) => row(`P${i}`, `https://s${i}.test/author/p${i}`));
  const a = planAuthorChecks(build(), { budget: 7 });
  const b = planAuthorChecks(build(), { budget: 7 });
  assert.deepEqual(a.funded.map((g) => g.url), b.funded.map((g) => g.url));
  assert.deepEqual(a.unfunded.map((g) => g.url), b.unfunded.map((g) => g.url));
});

test('rows naming the same author page share ONE fetch', () => {
  const shared = 'https://hearst.test/author/nicole';
  const rows = [row('Nicole S', shared), row('Other P', 'https://b.test/author/o'), row('Nicole S', shared)];
  const plan = planAuthorChecks(rows, { budget: 10 });
  assert.equal(plan.funded.length, 2, 'two distinct pages, three rows');
  assert.equal(plan.funded[0].rows.length, 2);
  assert.equal(plan.funded[0].url, shared);
});

test('a duplicate of an already-funded page is never pushed past the budget', () => {
  const shared = 'https://a.test/author/a';
  const rows = [row('A', shared), row('B', 'https://b.test/author/b'), row('A again', shared)];
  const plan = planAuthorChecks(rows, { budget: 1 });
  assert.equal(plan.funded.length, 1);
  assert.equal(plan.funded[0].rows.length, 2, 'both rows on the funded page are answered by its one fetch');
  assert.equal(plan.unfunded.length, 1);
});

test('rows with no person or no author page are unchecked, never funded', () => {
  const rows = [
    row(null, 'https://a.test/author/a'),
    row('Has Person', null),
    row('Both', 'https://c.test/author/c'),
  ];
  const plan = planAuthorChecks(rows, { budget: 10 });
  assert.equal(plan.unchecked.length, 2);
  assert.deepEqual(plan.funded.map((g) => g.url), ['https://c.test/author/c']);
});

test('a budget of zero funds nothing and loses nobody', () => {
  const rows = [row('A', 'https://a.test/x'), row('B', 'https://b.test/y')];
  const plan = planAuthorChecks(rows, { budget: 0 });
  assert.equal(plan.funded.length, 0);
  assert.equal(plan.unfunded.length, 2, 'over budget is a REPORTED skip, not a silent drop');
  // Every input row is accounted for exactly once across the three buckets.
  const seen = [...plan.unchecked, ...plan.funded.flatMap((g) => g.rows), ...plan.unfunded.flatMap((g) => g.rows)];
  assert.equal(seen.length, rows.length);
});

test('every row lands in exactly one bucket, always', () => {
  const rows = [
    row('A', 'https://a.test/1'), row(null, null), row('B', 'https://b.test/2'),
    row('C', 'https://a.test/1'), row('D', null), row('E', 'https://e.test/3'),
  ];
  const plan = planAuthorChecks(rows, { budget: 2 });
  const all = [...plan.unchecked, ...plan.funded.flatMap((g) => g.rows), ...plan.unfunded.flatMap((g) => g.rows)];
  assert.equal(all.length, rows.length);
  assert.equal(new Set(all).size, rows.length);
});

test('planAuthorChecks survives empty and malformed input', () => {
  for (const input of [null, undefined, [], [null, undefined, {}]]) {
    const plan = planAuthorChecks(input, { budget: 5 });
    assert.equal(plan.funded.length, 0);
  }
});

// ── enrichmentCounts ─────────────────────────────────────────────────────────

test('enrichmentCounts keeps "never fetched", "refused" and "read" apart', () => {
  const counts = enrichmentCounts([
    { enriched: true, enrich_fetch: 'ok', article_date_source: 'article', author: 'A' },
    { enriched: true, enrich_fetch: 'blocked', article_date_source: 'unreachable' },
    { enriched: true, enrich_fetch: 'timeout', article_date_source: 'unreachable' },
    { enriched: true, enrich_fetch: 'ok', article_date_source: 'homepage', author_rejected: 'team-byline' },
    { enriched: false, enrich_fetch: 'not-attempted', article_date_source: null },
  ]);
  assert.equal(counts.total, 5);
  assert.equal(counts.enriched, 4);
  assert.equal(counts.not_attempted, 1);
  assert.equal(counts.fetched_ok, 2);
  assert.equal(counts.fetch_failed, 2);
  assert.equal(counts.freshness_checkable, 1);
  assert.equal(counts.freshness_unknown_homepage, 1);
  assert.equal(counts.freshness_unknown_unreachable, 2);
  assert.equal(counts.with_person_byline, 1);
  assert.equal(counts.non_person_bylines, 1);
});

test('a row past the budget is never counted as a failed fetch', () => {
  // "We did not look" and "we looked and were refused" need different fixes.
  const counts = enrichmentCounts([
    { enriched: false, enrich_fetch: 'not-attempted' },
    { enriched: false, enrich_fetch: 'not-attempted' },
  ]);
  assert.equal(counts.fetch_failed, 0);
  assert.equal(counts.not_attempted, 2);
});

test('the two freshness-unknown reasons never collapse into one number', () => {
  // A snapshot with no article URL is a permanent property of the data; a
  // publisher refusing us is transient. One number cannot be acted on.
  const counts = enrichmentCounts([
    { enriched: true, enrich_fetch: 'ok', article_date_source: 'homepage' },
    { enriched: true, enrich_fetch: 'blocked', article_date_source: 'unreachable' },
  ]);
  assert.notEqual(counts.freshness_unknown_homepage, counts.freshness_unknown_unreachable + 1);
  assert.equal(counts.freshness_unknown_homepage, 1);
  assert.equal(counts.freshness_unknown_unreachable, 1);
});

test('enrichmentCounts handles nothing at all', () => {
  const counts = enrichmentCounts(null);
  assert.equal(counts.total, 0);
  assert.equal(counts.enriched, 0);
  assert.equal(counts.fetch_failed, 0);
});
