import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyRankedCoverage, sortUnmapped, loadRankedIndex, slugifyKeyword, loadAuthoredCoverage } from '../../agents/gsc-opportunity/index.js';
import { buildRankedIndex, buildAuthoredIndex, TIER_AUTHORED_SEMANTIC, TIER_RANKED_PHRASE } from '../../lib/ranked-coverage.js';

// The wiring half of PR: `lib/ranked-coverage.js` decides, this agent has to act
// on the decision in the one way the design permits — auto-covered rows leave
// the unmapped list, flagged rows STAY in it and are demoted.

const WINNER_PAGE = 'https://www.realskincare.com/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing-2';

const INDEX = buildRankedIndex([
  { query: 'best soap for tattoos', page: WINNER_PAGE, impressions: 972, position: 9.1, clicks: 5 },
  { query: 'soap for tattoos', page: WINNER_PAGE, impressions: 242, position: 10.3, clicks: 1 },
], { pageSlug: () => 'best-soap-for-tattoos-what-to-use-for-safe-healing-2' });

const row = (keyword, impressions, extra = {}) => ({ keyword, impressions, position: 30, clicks: 0, ctr: 0, ...extra });

test('an auto-covered candidate LEAVES the unmapped list', () => {
  const { unmapped, autoCovered, flagged } = applyRankedCoverage([row('best soap for tattoos', 900)], INDEX);
  assert.equal(unmapped.length, 0);
  assert.equal(autoCovered.length, 1);
  assert.equal(flagged.length, 0);
  assert.equal(autoCovered[0].ranked_match.page, WINNER_PAGE);
});

test('a flagged candidate STAYS in the unmapped list, carrying its evidence', () => {
  // The whole point of the second tier: the tattoo duplicate must be visible as
  // a decision, and must not be deleted by an agent that cannot make it.
  const kw = 'best soap for tattoos what to use for safe healing';
  const { unmapped, autoCovered, flagged } = applyRankedCoverage([row(kw, 400)], INDEX);
  assert.equal(unmapped.length, 1, 'never dropped');
  assert.equal(autoCovered.length, 0, 'never treated as covered');
  assert.equal(unmapped[0].possible_duplicate, true);
  assert.equal(unmapped[0].ranked_match.query, 'best soap for tattoos');
  assert.equal(flagged[0].keyword, kw);
});

test('an uncovered candidate passes through unchanged and unflagged', () => {
  const { unmapped } = applyRankedCoverage([row('aluminum free deodorant', 300)], INDEX);
  assert.equal(unmapped.length, 1);
  assert.equal(unmapped[0].possible_duplicate, undefined);
});

test('self-match: a candidate whose own slug is the ranked page is left alone', () => {
  // `selfSlugFor` defaults to the same slugification the ideas inbox uses, so a
  // candidate filed at the ranked page's own slug is the same work, not a duplicate.
  const kw = 'best soap for tattoos what to use for safe healing 2';
  assert.equal(slugifyKeyword(kw), 'best-soap-for-tattoos-what-to-use-for-safe-healing-2', 'that IS the winner\'s own handle');
  const { unmapped, flagged } = applyRankedCoverage([row(kw, 400)], INDEX);
  assert.equal(flagged.length, 0);
  assert.equal(unmapped[0].possible_duplicate, undefined);
});

test('FAIL OPEN: a disarmed index changes nothing — every row stays, unflagged', () => {
  const dead = buildRankedIndex([]);
  assert.equal(dead.available, false);
  const rows = [row('best soap for tattoos', 900), row('anything', 100)];
  const { unmapped, autoCovered, flagged } = applyRankedCoverage(rows, dead);
  assert.equal(unmapped.length, 2);
  assert.equal(autoCovered.length, 0);
  assert.equal(flagged.length, 0);
});

test('loadRankedIndex fails open on a directory that does not exist', () => {
  const idx = loadRankedIndex({ dir: '/nonexistent/gsc/snapshots' });
  assert.equal(idx.available, false);
  assert.match(idx.disarmed, /ranked-query coverage is OFF/);
  assert.equal(idx.files, 0);
});

test('sortUnmapped demotes a flagged row below every clean row, whatever its source', () => {
  // Demote, never drop — the `lib/ctr-opportunity.js` rule. A flagged
  // Amazon-validated row with the most impressions still sorts last.
  const rows = [
    { keyword: 'dup-amazon', impressions: 9000, validation_source: 'amazon', possible_duplicate: true },
    { keyword: 'clean-none', impressions: 10, validation_source: null },
    { keyword: 'clean-amazon', impressions: 20, validation_source: 'amazon' },
  ];
  assert.deepEqual(sortUnmapped(rows).map((r) => r.keyword), ['clean-amazon', 'clean-none', 'dup-amazon']);
});

test('sortUnmapped is unchanged when nothing is flagged', () => {
  const rows = [
    { keyword: 'q1', impressions: 100, validation_source: null },
    { keyword: 'q2', impressions: 200, validation_source: 'amazon' },
    { keyword: 'q3', impressions: 50, validation_source: 'amazon' },
    { keyword: 'q4', impressions: 300, validation_source: 'gsc_ga4' },
  ];
  assert.deepEqual(sortUnmapped(rows).map((r) => r.keyword), ['q2', 'q3', 'q4', 'q1']);
});

// ─────────────────────────────────────────────────────────────────────────────
// Tier 3 wiring
// ─────────────────────────────────────────────────────────────────────────────

const AUTHORED = buildAuthoredIndex([
  { keyword: 'best soap to use on new tattoo', slug: 'best-soap-for-tattoos', source: 'post' },
]);

test('a semantically-duplicate candidate STAYS in the unmapped list, tier recorded', () => {
  const kw = 'best soap to clean new tattoo';
  const { unmapped, autoCovered, flagged } = applyRankedCoverage([row(kw, 400)], INDEX, { authored: AUTHORED });
  assert.equal(unmapped.length, 1, 'never dropped');
  assert.equal(autoCovered.length, 0, 'the semantic tier may never cover');
  assert.equal(unmapped[0].possible_duplicate, true);
  assert.equal(unmapped[0].duplicate_tier, TIER_AUTHORED_SEMANTIC);
  assert.equal(unmapped[0].ranked_match.keyword, 'best soap to use on new tattoo');
  assert.equal(flagged[0].tier, TIER_AUTHORED_SEMANTIC);
});

test('a ranked-phrase hit still wins over a semantic one, and says which fired', () => {
  const kw = 'best soap for tattoos what to use for safe healing';
  const { flagged } = applyRankedCoverage([row(kw, 400)], INDEX, { authored: AUTHORED });
  assert.equal(flagged[0].tier, TIER_RANKED_PHRASE);
  assert.equal(flagged[0].match.query, 'best soap for tattoos');
});

test('FAIL OPEN: both indexes disarmed changes nothing — every row stays, unflagged', () => {
  const rows = [row('best soap to clean new tattoo', 400), row('anything', 100)];
  const { unmapped, autoCovered, flagged } = applyRankedCoverage(rows, buildRankedIndex([]), { authored: buildAuthoredIndex([]) });
  assert.equal(unmapped.length, 2);
  assert.equal(autoCovered.length, 0);
  assert.equal(flagged.length, 0);
  assert.equal(unmapped[0].possible_duplicate, undefined);
});

test('the semantic tier runs even when the ranked index is disarmed', () => {
  const { unmapped, flagged } = applyRankedCoverage([row('best soap to clean new tattoo', 400)], buildRankedIndex([]), { authored: AUTHORED });
  assert.equal(flagged.length, 1);
  assert.equal(unmapped[0].duplicate_tier, TIER_AUTHORED_SEMANTIC);
});

test('self-match: a candidate is not flagged against the brief it came from', () => {
  // `selfSlugFor` defaults to slugifying the candidate's own keyword, and
  // `buildAuthoredIndex` slugifies each authored keyword the same way — which is
  // what lets an existing brief recognise ITSELF rather than reading as a
  // false positive. Both of the candidates that first looked like false
  // positives on the live pool were exactly this.
  const kw = 'coconut oil deodorant for men';
  const authored = buildAuthoredIndex([{ keyword: kw, slug: 'coconut-oil-deodorant-for-men', source: 'brief' }]);
  const { unmapped, flagged } = applyRankedCoverage([row(kw, 400)], buildRankedIndex([]), { authored });
  assert.equal(flagged.length, 0);
  assert.equal(unmapped[0].possible_duplicate, undefined);
});

test('loadAuthoredCoverage fails open on a briefs directory that does not exist', () => {
  const entries = loadAuthoredCoverage({ briefsDir: '/nonexistent/briefs', slugs: [] });
  assert.deepEqual(entries, []);
  assert.equal(buildAuthoredIndex(entries).available, false);
});

test('loadAuthoredCoverage carries the slug beside every keyword', () => {
  // Without the slug there is no self-match, and without self-match the tier
  // flags every existing brief against itself.
  const entries = loadAuthoredCoverage({ slugs: [] });
  for (const e of entries) {
    assert.equal(typeof e.keyword, 'string');
    assert.ok(e.keyword.length > 0);
    assert.equal(typeof e.slug, 'string');
    assert.equal(e.source, 'brief');
  }
});

test('lib/calendar-coverage.js is NOT reachable from this agent', () => {
  // Deliberate scope boundary. gsc-opportunity decides what gets PROPOSED;
  // calendar-coverage decides what gets CLEARED from an existing calendar, and
  // CLAUDE.md records that path over-firing and silently destroying 12 of 19
  // scheduled items. Making the clearing path more aggressive is the specific
  // harm this change avoids.
  const src = readFileSync(new URL('../../agents/gsc-opportunity/index.js', import.meta.url), 'utf8');
  assert.equal(/calendar-coverage/.test(src), false);
});
