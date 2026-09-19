import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateRankedQueries,
  buildRankedIndex,
  classifyRankedCoverage,
  normalizeQuery,
  renderRankedCoverageLines,
  AUTO_COVERED,
  POSSIBLE_DUPLICATE,
  UNCOVERED,
  RANKED_POS_MAX,
  RANKED_MIN_IMPRESSIONS,
  RANKED_WINDOW_DAYS,
} from '../../lib/ranked-coverage.js';

// The incident this exists to prevent, in its real shape.
//
// On 2026-09-06 `calendar-runner` spent a full paid pipeline on
// `best-soap-for-tattoos-what-to-use-for-safe-healing-3`, a third-generation
// duplicate of the winner at `…-2`. Every figure in WINNER_QUERIES below is the
// real, measured 28-day rollup from data/snapshots/gsc/ (2026-08-18 →
// 2026-09-15), impression-weighted position.
const WINNER_PAGE = 'https://www.realskincare.com/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing-2';
const WINNER_SLUG = 'best-soap-for-tattoos';

const WINNER_QUERIES = [
  { query: 'best soap for tattoos', impressions: 972, position: 9.1 },
  { query: 'best antibacterial soap for tattoos', impressions: 266, position: 6.3 },
  { query: 'best soap to use on new tattoo', impressions: 251, position: 7.6 },
  { query: 'soap for tattoos', impressions: 242, position: 10.3 },
  { query: 'best soap for tattoo', impressions: 133, position: 11.5 },
  { query: 'tattoo soap', impressions: 215, position: 18.9 },
];

const DUPLICATE_KEYWORD = 'best soap for tattoos what to use for safe healing';

const rows = (list) => list.map((r) => ({ page: WINNER_PAGE, clicks: 0, ...r }));

const indexOf = (list, opts = {}) => buildRankedIndex(rows(list), {
  pageSlug: () => WINNER_SLUG,
  ...opts,
});

// ─────────────────────────────────────────────────────────────────────────────
// Tier 1 — exact
// ─────────────────────────────────────────────────────────────────────────────

test('exact: a candidate that IS a ranked query above both floors is auto-covered', () => {
  const idx = indexOf(WINNER_QUERIES);
  const v = classifyRankedCoverage('best soap for tattoos', idx);
  assert.equal(v.status, AUTO_COVERED);
  assert.equal(v.match.page, WINNER_PAGE);
  assert.equal(v.match.impressions, 972);
});

test('exact: matching ignores case and extra whitespace, and nothing else', () => {
  const idx = indexOf(WINNER_QUERIES);
  assert.equal(classifyRankedCoverage('  BEST   Soap For Tattoos ', idx).status, AUTO_COVERED);
  // No stemming, no punctuation stripping — widening the normaliser widens the
  // whole check, and widening is the direction that kills planned content.
  assert.equal(classifyRankedCoverage('best soap for tattoo!', idx).status, UNCOVERED);
});

// ─────────────────────────────────────────────────────────────────────────────
// The floors
// ─────────────────────────────────────────────────────────────────────────────

test('a ranked query below the impression floor covers nothing', () => {
  const idx = indexOf([{ query: 'best soap for tattoos', impressions: RANKED_MIN_IMPRESSIONS - 1, position: 3 }]);
  assert.equal(idx.available, false);
  assert.match(idx.disarmed, /no ranked query cleared/);
  assert.equal(classifyRankedCoverage('best soap for tattoos', idx).status, UNCOVERED);
  assert.equal(classifyRankedCoverage(DUPLICATE_KEYWORD, idx).status, UNCOVERED);
});

test('a ranked query below the position floor covers nothing', () => {
  const idx = indexOf([{ query: 'best soap for tattoos', impressions: 5000, position: RANKED_POS_MAX + 0.1 }]);
  assert.equal(idx.available, false);
  assert.equal(classifyRankedCoverage('best soap for tattoos', idx).status, UNCOVERED);
});

test('position 20 is inside the floor and position 10 would have excluded the winner\'s own queries', () => {
  // Finding 2: `soap for tattoos` (10.3) and `best soap for tattoo` (11.5) are
  // queries the winner demonstrably owns. A position-10 floor drops both.
  const at20 = indexOf(WINNER_QUERIES);
  const at10 = indexOf(WINNER_QUERIES, { posMax: 10 });
  assert.equal(at20.byQuery.has('soap for tattoos'), true);
  assert.equal(at20.byQuery.has('best soap for tattoo'), true);
  assert.equal(at10.byQuery.has('soap for tattoos'), false);
  assert.equal(at10.byQuery.has('best soap for tattoo'), false);
  assert.equal(at20.byQuery.has('tattoo soap'), true, 'position 18.9 is inside 20');
});

// ─────────────────────────────────────────────────────────────────────────────
// Tier 2 — substring, and the tattoo case specifically
// ─────────────────────────────────────────────────────────────────────────────

test('THE TATTOO CASE: the duplicate is FLAGGED, never silently dropped', () => {
  const idx = indexOf(WINNER_QUERIES);
  const v = classifyRankedCoverage(DUPLICATE_KEYWORD, idx);

  assert.equal(v.status, POSSIBLE_DUPLICATE);
  assert.notEqual(v.status, AUTO_COVERED, 'a flagged candidate must never be treated as covered');
  // The evidence a human needs to make the call without re-running anything.
  assert.equal(v.match.page, WINNER_PAGE);
  assert.equal(v.match.query, 'best soap for tattoos');
  assert.equal(v.match.impressions, 972);
  // Two of the six winner queries are whole-phrase substrings of the candidate:
  // "best soap for tattoos" and "soap for tattoos". "best soap for tattoo" is
  // NOT — the candidate says "tattoos" — which is the whole-word rule working.
  assert.deepEqual(v.matches.map((m) => m.query).sort(), ['best soap for tattoos', 'soap for tattoos']);
});

test('exact matching ALONE would not have caught it — the duplicate is no ranked query', () => {
  // Finding 1, and the reason the substring tier has to exist at all.
  const idx = indexOf(WINNER_QUERIES);
  assert.equal(idx.byQuery.has(normalizeQuery(DUPLICATE_KEYWORD)), false);
});

test('containment is one-directional: a longer ranked query does not cover a shorter candidate', () => {
  const idx = indexOf([{ query: 'best natural deodorant for men', impressions: 500, position: 4 }]);
  assert.equal(classifyRankedCoverage('deodorant', idx).status, UNCOVERED);
  assert.equal(classifyRankedCoverage('best natural deodorant for men and women', idx).status, POSSIBLE_DUPLICATE);
});

test('containment is whole-phrase, so a word fragment never matches', () => {
  const idx = indexOf([{ query: 'oil', impressions: 500, position: 4 }]);
  assert.equal(classifyRankedCoverage('boiling water for soap', idx).status, UNCOVERED);
  assert.equal(classifyRankedCoverage('coconut oil deodorant', idx).status, POSSIBLE_DUPLICATE);
});

test('THE TWO MEASURED FALSE POSITIVES land in the FLAGGED tier, never auto-covered', () => {
  // These are the reason tier 2 surfaces a decision instead of acting. Both are
  // legitimately distinct topics — a competitor-brand comparison and an audience
  // facet — swallowed by a short generic ranked query. Both figures are real.
  const idx = buildRankedIndex([
    { query: 'deodorant alternatives', page: 'https://www.realskincare.com/blogs/news/best-native-deodorant-alternatives-natural-options-that-work', impressions: 61, position: 11.9, clicks: 0 },
    { query: 'coconut oil deodorant', page: 'https://www.realskincare.com/blogs/news/coconut-oil-deodorant', impressions: 290, position: 10.5, clicks: 0 },
  ], { pageSlug: (p) => p.split('/').pop() });

  for (const kw of ["best schmidt's deodorant alternatives", 'coconut oil deodorant for men']) {
    const v = classifyRankedCoverage(kw, idx);
    assert.equal(v.status, POSSIBLE_DUPLICATE, `${kw} must be flagged`);
    assert.notEqual(v.status, AUTO_COVERED, `${kw} must NEVER be auto-covered — it is a distinct topic`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Self-match
// ─────────────────────────────────────────────────────────────────────────────

test('self-match: a candidate is never covered by its OWN page', () => {
  // lib/calendar-coverage.js had to solve exactly this: on 2026-08-19 the
  // coverage check cleared calendar items as "already covered" by the draft
  // generated FROM them.
  const idx = indexOf(WINNER_QUERIES);

  const flagged = classifyRankedCoverage(DUPLICATE_KEYWORD, idx, { selfSlug: 'some-other-post' });
  assert.equal(flagged.status, POSSIBLE_DUPLICATE);

  const self = classifyRankedCoverage(DUPLICATE_KEYWORD, idx, { selfSlug: WINNER_SLUG });
  assert.equal(self.status, UNCOVERED, 'the winner cannot flag its own topic as a duplicate of itself');
  assert.deepEqual(self.selfMatches.map((m) => m.query).sort(), ['best soap for tattoos', 'soap for tattoos'],
    'the excluded self-matches are still reported, not discarded');
});

test('self-match is applied to the EXACT tier too, not just the flagged one', () => {
  const idx = indexOf(WINNER_QUERIES);
  assert.equal(classifyRankedCoverage('best soap for tattoos', idx, { selfSlug: WINNER_SLUG }).status, UNCOVERED);
  assert.equal(classifyRankedCoverage('best soap for tattoos', idx, { selfSlug: 'elsewhere' }).status, AUTO_COVERED);
});

test('a second page ranking for the same query still covers, even when one match is self', () => {
  const idx = buildRankedIndex([
    { query: 'best soap for tattoos', page: WINNER_PAGE, impressions: 972, position: 9.1, clicks: 0 },
    { query: 'best soap for tattoos', page: 'https://www.realskincare.com/blogs/news/other', impressions: 88, position: 12, clicks: 0 },
  ], { pageSlug: (p) => (p === WINNER_PAGE ? WINNER_SLUG : 'other') });
  const v = classifyRankedCoverage('best soap for tattoos', idx, { selfSlug: WINNER_SLUG });
  assert.equal(v.status, AUTO_COVERED);
  assert.equal(v.match.slug, 'other');
});

// ─────────────────────────────────────────────────────────────────────────────
// Fail-open
// ─────────────────────────────────────────────────────────────────────────────

test('FAIL OPEN: missing, empty and malformed snapshots all cover NOTHING', () => {
  // The opposite direction — "assume covered" — would silently stop every
  // content proposal the fleet makes.
  for (const input of [undefined, null, [], 'nonsense', [{}], [{ queriesByPage: null }]]) {
    const idx = buildRankedIndex(aggregateRankedQueries(input));
    assert.equal(idx.available, false, `${JSON.stringify(input)} must not be available`);
    assert.ok(idx.disarmed, 'a disarmed gate has to SAY it is disarmed');
    assert.equal(classifyRankedCoverage(DUPLICATE_KEYWORD, idx).status, UNCOVERED);
    assert.equal(classifyRankedCoverage('best soap for tattoos', idx).status, UNCOVERED);
  }
});

test('FAIL OPEN: a null / undefined index covers nothing rather than throwing', () => {
  for (const idx of [null, undefined, {}, { available: true }]) {
    assert.equal(classifyRankedCoverage('anything at all', idx).status, UNCOVERED);
  }
});

test('an empty or blank candidate is never covered', () => {
  const idx = indexOf(WINNER_QUERIES);
  for (const kw of ['', '   ', null, undefined]) {
    assert.equal(classifyRankedCoverage(kw, idx).status, UNCOVERED);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────────────────────

test('aggregation sums impressions and weights position BY impressions', () => {
  const [row] = aggregateRankedQueries([
    { queriesByPage: [{ query: 'Best Soap For Tattoos', page: WINNER_PAGE, clicks: 1, impressions: 90, position: 8 }] },
    { queriesByPage: [{ query: 'best soap for tattoos', page: WINNER_PAGE, clicks: 0, impressions: 10, position: 28 }] },
  ]);
  assert.equal(row.impressions, 100);
  assert.equal(row.clicks, 1);
  // A 10-impression day at rank 28 must not drag a 90-impression day at rank 8
  // to the unweighted mean of 18 — that is how a real page loses its own topic.
  assert.equal(row.position, 10);
  assert.equal(row.days, 2);
});

test('a row with no impressions gets an infinite position and can never enter the index', () => {
  const [row] = aggregateRankedQueries([{ queriesByPage: [{ query: 'q', page: 'p', impressions: 0, position: 1 }] }]);
  assert.equal(row.position, Number.POSITIVE_INFINITY);
  assert.equal(buildRankedIndex([row]).available, false);
});

test('rows missing a query or a page are skipped rather than indexed under an empty key', () => {
  const out = aggregateRankedQueries([{ queriesByPage: [
    { query: '', page: WINNER_PAGE, impressions: 900, position: 1 },
    { query: 'q', page: '', impressions: 900, position: 1 },
    { query: 'q', page: WINNER_PAGE, impressions: 900, position: 1 },
  ] }]);
  assert.equal(out.length, 1);
});

test('a page whose slug cannot be resolved is still indexed, just without self-match protection', () => {
  const idx = buildRankedIndex(rows(WINNER_QUERIES), { pageSlug: () => { throw new Error('boom'); } });
  assert.equal(idx.available, true);
  assert.equal(idx.entries[0].slug, null);
  assert.equal(classifyRankedCoverage(DUPLICATE_KEYWORD, idx, { selfSlug: WINNER_SLUG }).status, POSSIBLE_DUPLICATE);
});

// ─────────────────────────────────────────────────────────────────────────────
// Reporting
// ─────────────────────────────────────────────────────────────────────────────

test('rendered evidence names the page, the query, the position and the impressions', () => {
  const idx = indexOf(WINNER_QUERIES);
  const v = classifyRankedCoverage(DUPLICATE_KEYWORD, idx);
  const text = renderRankedCoverageLines([{ keyword: DUPLICATE_KEYWORD, match: v.match }]).join('\n');
  assert.match(text, /best soap for tattoos what to use for safe healing/);
  assert.match(text, /data\/posts\/best-soap-for-tattoos/);
  assert.match(text, /position 9\.1/);
  assert.match(text, new RegExp(`972 impressions/${RANKED_WINDOW_DAYS}d`));
});

test('the constants carry the values the measurement derived', () => {
  assert.equal(RANKED_POS_MAX, 20);
  assert.equal(RANKED_MIN_IMPRESSIONS, 50);
  assert.equal(RANKED_WINDOW_DAYS, 28);
});
