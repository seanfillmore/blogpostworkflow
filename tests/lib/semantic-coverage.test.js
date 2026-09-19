import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRankedIndex,
  buildAuthoredIndex,
  classifyRankedCoverage,
  describeMatch,
  renderRankedCoverageLines,
  slugifyKeyword,
  AUTO_COVERED,
  POSSIBLE_DUPLICATE,
  UNCOVERED,
  SEMANTIC_THRESHOLD,
  TIER_EXACT,
  TIER_RANKED_PHRASE,
  TIER_AUTHORED_SEMANTIC,
} from '../../lib/ranked-coverage.js';
import { similarity } from '../../lib/cannibalization-guard.js';

// TIER 3 — the residual gap the two ranked tiers cannot see.
//
// PR #919's tiers drop 15 of 17 live candidate topics. The survivor,
// "best soap to clean new tattoo", is a near-duplicate of the tattoo flagship,
// whose AUTHORED target keyword is "best soap to use on new tattoo". They differ
// by one word in the middle, so no substring rule in either direction reaches
// it — the same shape as the duplicate article retired in PR #912.

const GAP_CANDIDATE = 'best soap to clean new tattoo';
const FLAGSHIP_KEYWORD = 'best soap to use on new tattoo';
const FLAGSHIP_SLUG = 'best-soap-for-tattoos';

const AUTHORED = buildAuthoredIndex([
  { keyword: FLAGSHIP_KEYWORD, slug: FLAGSHIP_SLUG, source: 'post' },
  { keyword: 'natural body lotion without chemicals', slug: 'natural-body-lotion', source: 'brief' },
  { keyword: 'aluminum free deodorant', slug: 'aluminum-free-deodorant', source: 'post' },
]);

// A ranked index that deliberately does NOT hold either phrasing, so tiers 1
// and 2 are live but genuinely blind to the gap — the real situation.
const RANKED = buildRankedIndex([
  { query: 'best antibacterial soap for tattoos', page: 'https://www.realskincare.com/blogs/news/x-2', impressions: 266, position: 6.3, clicks: 2 },
], { pageSlug: () => FLAGSHIP_SLUG });

// ─────────────────────────────────────────────────────────────────────────────
// The gap, and the threshold that decides it
// ─────────────────────────────────────────────────────────────────────────────

test('THE RESIDUAL GAP: caught at 0.6, the established fleet default', () => {
  const v = classifyRankedCoverage(GAP_CANDIDATE, RANKED, { authored: AUTHORED });
  assert.equal(v.status, POSSIBLE_DUPLICATE);
  assert.equal(v.tier, TIER_AUTHORED_SEMANTIC);
  assert.equal(v.match.keyword, FLAGSHIP_KEYWORD);
  assert.equal(v.match.slug, FLAGSHIP_SLUG);
});

test('THE RESIDUAL GAP: the ranked tiers alone cannot see it', () => {
  // No substring relation in EITHER direction, and it is no ranked query.
  assert.equal(` ${GAP_CANDIDATE} `.includes(` ${FLAGSHIP_KEYWORD} `), false);
  assert.equal(` ${FLAGSHIP_KEYWORD} `.includes(` ${GAP_CANDIDATE} `), false);
  assert.equal(classifyRankedCoverage(GAP_CANDIDATE, RANKED).status, UNCOVERED,
    'without the authored index this is exactly the hole PR #919 left');
});

test('THE THRESHOLD IS A FLOOR, NOT A STARTING POINT — the gap escapes at 0.7', () => {
  // Measured: {soap, clean, new, tattoo} vs {soap, use, new, tattoo} share 3 of
  // 5 union tokens after stopword removal. It sits EXACTLY on 0.6 and is caught
  // only because the comparison is `>=`, so any tightening at all loses the one
  // case this tier exists for. If this assertion ever has to be relaxed, the
  // threshold table in the module header has to be re-measured first.
  assert.equal(similarity(GAP_CANDIDATE, FLAGSHIP_KEYWORD).toFixed(2), '0.60');
  assert.equal(SEMANTIC_THRESHOLD, 0.6);
  assert.ok(similarity(GAP_CANDIDATE, FLAGSHIP_KEYWORD) >= SEMANTIC_THRESHOLD);
  assert.ok(similarity(GAP_CANDIDATE, FLAGSHIP_KEYWORD) < 0.7, 'at 0.7 the gap escapes — the row in the header table');
});

test('the second live survivor is a genuine near-duplicate and is flagged too', () => {
  const v = classifyRankedCoverage('best body lotion without chemicals', RANKED, { authored: AUTHORED });
  assert.equal(v.status, POSSIBLE_DUPLICATE);
  assert.equal(v.tier, TIER_AUTHORED_SEMANTIC);
  assert.equal(v.match.keyword, 'natural body lotion without chemicals');
});

test('an unrelated candidate is still uncovered', () => {
  assert.equal(classifyRankedCoverage('how to clean a cast iron skillet', RANKED, { authored: AUTHORED }).status, UNCOVERED);
});

// ─────────────────────────────────────────────────────────────────────────────
// The tier may never cover silently
// ─────────────────────────────────────────────────────────────────────────────

test('TIER 3 CAN NEVER RETURN AUTO_COVERED — not even on an identical keyword', () => {
  // Semantic similarity is the weakest of the three signals, so it gets the
  // weakest consequence. Only an EXACT ranked query may cover a candidate
  // silently; everything else surfaces a decision.
  const cases = [
    GAP_CANDIDATE,
    FLAGSHIP_KEYWORD,                      // similarity 1.0
    'aluminum free deodorant',             // similarity 1.0, different entry
    'best body lotion without chemicals',
  ];
  for (const kw of cases) {
    const v = classifyRankedCoverage(kw, buildRankedIndex([]), { authored: AUTHORED });
    assert.notEqual(v.status, AUTO_COVERED, `${kw} must never be auto-covered by the semantic tier`);
    if (v.status !== UNCOVERED) assert.equal(v.status, POSSIBLE_DUPLICATE);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Precedence
// ─────────────────────────────────────────────────────────────────────────────

test('PRECEDENCE: exact > ranked phrase > authored semantic', () => {
  const page = 'https://www.realskincare.com/blogs/news/winner';
  const idx = buildRankedIndex([
    { query: 'best soap to clean new tattoo', page, impressions: 500, position: 4, clicks: 3 },
    { query: 'soap to clean', page, impressions: 300, position: 6, clicks: 1 },
  ], { pageSlug: () => 'winner' });

  // All three tiers would fire on this candidate. Tier 1 wins.
  const exact = classifyRankedCoverage(GAP_CANDIDATE, idx, { authored: AUTHORED });
  assert.equal(exact.status, AUTO_COVERED);
  assert.equal(exact.tier, TIER_EXACT);

  // Drop the exact query: tier 2 wins over tier 3.
  const phraseOnly = buildRankedIndex([
    { query: 'soap to clean', page, impressions: 300, position: 6, clicks: 1 },
  ], { pageSlug: () => 'winner' });
  const phrase = classifyRankedCoverage(GAP_CANDIDATE, phraseOnly, { authored: AUTHORED });
  assert.equal(phrase.status, POSSIBLE_DUPLICATE);
  assert.equal(phrase.tier, TIER_RANKED_PHRASE);
  assert.equal(phrase.match.query, 'soap to clean');

  // Drop that too: tier 3 is what is left.
  const semantic = classifyRankedCoverage(GAP_CANDIDATE, buildRankedIndex([]), { authored: AUTHORED });
  assert.equal(semantic.tier, TIER_AUTHORED_SEMANTIC);
});

test('the tiers degrade INDEPENDENTLY — a disarmed ranked index does not switch tier 3 off', () => {
  const dead = buildRankedIndex([]);
  assert.equal(dead.available, false);
  assert.equal(classifyRankedCoverage(GAP_CANDIDATE, dead, { authored: AUTHORED }).tier, TIER_AUTHORED_SEMANTIC);
  // ...and an absent authored index does not switch tiers 1-2 off.
  const v = classifyRankedCoverage('best antibacterial soap for tattoos', RANKED, { authored: buildAuthoredIndex([]) });
  assert.equal(v.status, AUTO_COVERED);
});

// ─────────────────────────────────────────────────────────────────────────────
// Self-match — what keeps this tier honest
// ─────────────────────────────────────────────────────────────────────────────

test('SELF-MATCH: a candidate is never flagged against the brief or post it came from', () => {
  const v = classifyRankedCoverage(FLAGSHIP_KEYWORD, buildRankedIndex([]), {
    authored: AUTHORED,
    selfSlug: FLAGSHIP_SLUG,
  });
  assert.equal(v.status, UNCOVERED, 'the flagship cannot duplicate itself');
  // Excluded, not discarded: a reader has to be able to tell "we excluded its
  // own brief" from "nothing was similar".
  assert.deepEqual(v.selfMatches.map((m) => m.keyword), [FLAGSHIP_KEYWORD]);
  assert.equal(v.selfMatches[0].tier, TIER_AUTHORED_SEMANTIC);
});

test('SELF-MATCH works through the KEYWORD slug, not just the file slug', () => {
  // The two candidates that first read as false positives on the live pool turn
  // out to be EXISTING BRIEFS matching themselves. A candidate's own slug is
  // derived from its keyword, so the authored entry has to be comparable the
  // same way — and it is not, the moment punctuation is involved.
  const kw = "best schmidt's deodorant alternatives";
  assert.equal(slugifyKeyword(kw), 'best-schmidt-s-deodorant-alternatives');
  const authored = buildAuthoredIndex([
    // Filed under a DIFFERENT slug than its keyword slugifies to — the real shape.
    { keyword: kw, slug: 'best-schmidts-deodorant-alternatives', source: 'brief' },
  ]);
  const v = classifyRankedCoverage(kw, buildRankedIndex([]), { authored, selfSlug: slugifyKeyword(kw) });
  assert.equal(v.status, UNCOVERED, 'a brief must recognise itself even when its filename differs');

  // The same keyword authored on a DIFFERENT page is still a real collision.
  const other = classifyRankedCoverage(kw, buildRankedIndex([]), { authored, selfSlug: 'something-else' });
  assert.equal(other.status, POSSIBLE_DUPLICATE);
});

test('SELF-MATCH does not hide a real collision behind the self entry', () => {
  // `findSemanticDuplicate` breaks ties with `>`, so the FIRST entry to reach a
  // tying score wins. Filtering the self entry out BEFORE the call is what stops
  // a self-match winning the tie and reporting "no duplicate" — the defect
  // lib/calendar-coverage.js had to fix on the calendar side.
  const authored = buildAuthoredIndex([
    { keyword: 'aluminum free deodorant', slug: 'mine', source: 'brief' },
    { keyword: 'aluminum free deodorant', slug: 'theirs', source: 'post' },
  ]);
  const v = classifyRankedCoverage('aluminum free deodorant', buildRankedIndex([]), { authored, selfSlug: 'mine' });
  assert.equal(v.status, POSSIBLE_DUPLICATE);
  assert.equal(v.match.slug, 'theirs');
});

test('the differentSegments guard is inherited, not re-implemented', () => {
  // "natural deodorant for women" vs "...for men" is a deliberate segment split,
  // which is exactly the false-positive class this tier risks. The guard comes
  // from lib/cannibalization-guard.js along with the similarity function.
  const authored = buildAuthoredIndex([{ keyword: 'natural deodorant for men', slug: 'mens', source: 'post' }]);
  assert.equal(classifyRankedCoverage('natural deodorant for women', buildRankedIndex([]), { authored }).status, UNCOVERED);
  assert.equal(classifyRankedCoverage('the natural deodorant for men', buildRankedIndex([]), { authored }).status, POSSIBLE_DUPLICATE);
});

// ─────────────────────────────────────────────────────────────────────────────
// Fail-open
// ─────────────────────────────────────────────────────────────────────────────

test('FAIL OPEN: an unreadable, empty or absent authored set flags NOTHING', () => {
  for (const input of [undefined, null, [], 'nonsense', [{}], [{ keyword: '' }], [{ keyword: null }]]) {
    const authored = buildAuthoredIndex(input);
    assert.equal(authored.available, false, `${JSON.stringify(input)} must not be available`);
    assert.ok(authored.disarmed, 'a disarmed tier has to SAY it is disarmed');
    const v = classifyRankedCoverage(GAP_CANDIDATE, buildRankedIndex([]), { authored });
    assert.equal(v.status, UNCOVERED);
  }
});

test('FAIL OPEN: a malformed authored index is ignored rather than thrown on', () => {
  for (const authored of [{}, { available: true }, { available: true, entries: 'nope' }]) {
    assert.equal(classifyRankedCoverage(GAP_CANDIDATE, buildRankedIndex([]), { authored }).status, UNCOVERED);
  }
});

test('omitting the authored index entirely leaves PR #919 behaviour byte-identical', () => {
  const page = 'https://www.realskincare.com/blogs/news/x-2';
  const idx = buildRankedIndex([
    { query: 'best soap for tattoos', page, impressions: 972, position: 9.1, clicks: 5 },
  ], { pageSlug: () => FLAGSHIP_SLUG });
  assert.equal(classifyRankedCoverage('best soap for tattoos', idx).status, AUTO_COVERED);
  assert.equal(classifyRankedCoverage('best soap for tattoos today', idx).status, POSSIBLE_DUPLICATE);
  assert.equal(classifyRankedCoverage(GAP_CANDIDATE, idx).status, UNCOVERED);
});

// ─────────────────────────────────────────────────────────────────────────────
// The index itself
// ─────────────────────────────────────────────────────────────────────────────

test('buildAuthoredIndex normalises keywords and de-duplicates keyword+slug pairs', () => {
  const idx = buildAuthoredIndex([
    { keyword: '  Best   Soap For Tattoos ', slug: 'a', source: 'post' },
    { keyword: 'best soap for tattoos', slug: 'a', source: 'brief' },  // same decision, twice
    { keyword: 'best soap for tattoos', slug: 'b', source: 'brief' },  // a genuine second entry
  ]);
  assert.equal(idx.entries.length, 2);
  assert.deepEqual(idx.entries.map((e) => e.slug), ['a', 'b']);
  assert.equal(idx.entries[0].keyword, 'best soap for tattoos');
  assert.equal(idx.entries[0].keywordSlug, 'best-soap-for-tattoos');
});

test('buildAuthoredIndex accepts a bare string entry, with no slug and so no self-match', () => {
  const idx = buildAuthoredIndex([FLAGSHIP_KEYWORD]);
  assert.equal(idx.available, true);
  assert.equal(idx.entries[0].slug, null);
  assert.equal(classifyRankedCoverage(GAP_CANDIDATE, buildRankedIndex([]), { authored: idx }).status, POSSIBLE_DUPLICATE);
});

// ─────────────────────────────────────────────────────────────────────────────
// Reporting — the two tiers need different remedies, so they must read differently
// ─────────────────────────────────────────────────────────────────────────────

test('evidence names WHICH TIER fired, and where to go and look', () => {
  const v = classifyRankedCoverage(GAP_CANDIDATE, buildRankedIndex([]), { authored: AUTHORED });
  const d = describeMatch(v.match);
  assert.equal(d.tier, TIER_AUTHORED_SEMANTIC);
  assert.equal(d.signal, 'authored keyword');
  assert.equal(d.matched, FLAGSHIP_KEYWORD);
  assert.equal(d.where, `data/posts/${FLAGSHIP_SLUG}`);
  assert.match(d.evidence, /similarity 0\.60/);

  const text = renderRankedCoverageLines([{ keyword: GAP_CANDIDATE, match: v.match }]).join('\n');
  assert.match(text, new RegExp(GAP_CANDIDATE));
  assert.match(text, /authored target keyword/);
  assert.match(text, new RegExp(`data/posts/${FLAGSHIP_SLUG}`));
  assert.doesNotMatch(text, /ranked query/, 'a semantic hit must not read as a page that already ranks');
});

test('a brief is located at its brief path, not a post path', () => {
  const v = classifyRankedCoverage('best body lotion without chemicals', buildRankedIndex([]), { authored: AUTHORED });
  assert.equal(describeMatch(v.match).where, 'data/briefs/natural-body-lotion.json');
});

test('the ranked evidence line is unchanged, tier field or not', () => {
  const page = 'https://www.realskincare.com/blogs/news/x-2';
  const idx = buildRankedIndex([
    { query: 'best soap for tattoos', page, impressions: 972, position: 9.1, clicks: 5 },
  ], { pageSlug: () => FLAGSHIP_SLUG });
  const v = classifyRankedCoverage('best soap for tattoos and piercings', idx);
  const text = renderRankedCoverageLines([{ keyword: v.keyword, match: v.match }]).join('\n');
  assert.match(text, /ranked query "best soap for tattoos" already lands on data\/posts\/best-soap-for-tattoos — position 9\.1, 972 impressions\/28d/);

  // A match read back out of a previous run's latest.json has no `tier`; it must
  // still render as the ranked line it is.
  const legacy = { ...v.match };
  delete legacy.tier;
  assert.equal(describeMatch(legacy).signal, 'ranked query');
});

test('describeMatch tolerates a null match rather than throwing', () => {
  assert.equal(describeMatch(null), null);
  assert.deepEqual(renderRankedCoverageLines([{ keyword: 'x', match: null }]), ['  "x" — flagged, no evidence recorded']);
});
