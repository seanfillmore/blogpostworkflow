import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyRankedCoverage, sortUnmapped, loadRankedIndex, slugifyKeyword } from '../../agents/gsc-opportunity/index.js';
import { buildRankedIndex } from '../../lib/ranked-coverage.js';

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

test('lib/calendar-coverage.js is NOT reachable from this agent', () => {
  // Deliberate scope boundary. gsc-opportunity decides what gets PROPOSED;
  // calendar-coverage decides what gets CLEARED from an existing calendar, and
  // CLAUDE.md records that path over-firing and silently destroying 12 of 19
  // scheduled items. Making the clearing path more aggressive is the specific
  // harm this change avoids.
  const src = readFileSync(new URL('../../agents/gsc-opportunity/index.js', import.meta.url), 'utf8');
  assert.equal(/calendar-coverage/.test(src), false);
});
