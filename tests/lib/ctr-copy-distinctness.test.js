import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessDistinctness,
  contentTokens,
  ctrElements,
  tokenOverlap,
  DEFAULT_MAX_TOKEN_OVERLAP,
  DEFAULT_MIN_TITLE_TOKENS,
} from '../../lib/ctr-copy-distinctness.js';

// The two REAL rewrites below are verbatim from
// data/reports/meta-ab/meta-ab-tracker.json, 2026-08-24 run. They are the
// reason this module exists, so they are the first two tests.

test('REAL case: the tattoo-soap adjective shuffle is refused as a paraphrase', () => {
  const d = assessDistinctness({
    originalTitle: 'Best Soap for Tattoos: Clean, Gentle, Fragrance-Free',
    proposedTitle: 'Best Soap for Tattoos: Gentle, Clean & Fragrance-Free',
  });
  assert.equal(d.ok, false);
  // Identical token SETS — the rewrite only changed word order.
  assert.equal(d.titleOverlap, 1);
  assert.ok(d.reasons.some((r) => r.includes('paraphrase')), `reasons: ${d.reasons.join(' | ')}`);
  assert.ok(d.reasons.some((r) => r.includes('100% > 70%')));
  // It also carries nothing new, so rule 4 fires too.
  assert.deepEqual(d.newElements, []);
  assert.ok(d.reasons.some((r) => r.includes('no new CTR-bearing element')));
});

test('REAL case: the coconut-deodorant question rewrite PASSES — a finding, not the intended verdict', () => {
  // "Coconut Oil Deodorant That Actually Works" → "…: Does It Actually Work?"
  // The brief expected this to fail rule 3 on overlap. It does not, and the
  // test asserts the ACTUAL behaviour rather than the expectation:
  //   original tokens  {coconut, oil, deodorant, actually, works}
  //   proposed tokens  {coconut, oil, deodorant, does, actually, work}
  //   Jaccard = 4/7 = 0.571, comfortably under the 0.70 ceiling — because
  //   'that'/'it' are stopwords and 'works'/'work' are DIFFERENT tokens (there
  //   is no stemmer, deliberately: stemming is where a deterministic,
  //   hand-checkable score stops being either).
  // So the gate lets this one through on the strength of its new 'question'
  // element. That is a real gap: this module can tell a paraphrase from a
  // material change, but it cannot tell a material change from a WORSE one —
  // turning a commercial assertion into a question is a treatment worth
  // measuring, and measuring is what the A/B loop is for.
  const d = assessDistinctness({
    originalTitle: 'Coconut Oil Deodorant That Actually Works',
    proposedTitle: 'Coconut Oil Deodorant: Does It Actually Work?',
  });
  assert.ok(d.newElements.includes('question'));
  assert.ok(
    d.titleOverlap <= DEFAULT_MAX_TOKEN_OVERLAP,
    `overlap ${d.titleOverlap} unexpectedly above the ceiling`,
  );
  assert.equal(d.ok, true);
  assert.deepEqual(d.reasons, []);
});

test('a genuinely material rewrite passes, carrying a year and a count', () => {
  const d = assessDistinctness({
    originalTitle: 'Best Soap for Tattoos: Clean, Gentle, Fragrance-Free',
    proposedTitle: 'Best Soap for Tattoos in 2026: 7 Fragrance-Free Picks Artists Recommend',
  });
  assert.equal(d.ok, true);
  assert.deepEqual(d.reasons, []);
  assert.ok(d.newElements.includes('year'));
  assert.ok(d.newElements.includes('number'));
  assert.ok(d.titleOverlap < DEFAULT_MAX_TOKEN_OVERLAP);
});

test('an identical title is refused with the identity reason', () => {
  const title = 'Best Soap for Tattoos: Clean, Gentle, Fragrance-Free';
  const d = assessDistinctness({ originalTitle: title, proposedTitle: title });
  assert.equal(d.ok, false);
  assert.ok(d.reasons.includes('proposed title is identical to the original'));
});

test('case and whitespace do not disguise an identical title', () => {
  const d = assessDistinctness({
    originalTitle: 'Best Soap for Tattoos',
    proposedTitle: '  best soap FOR tattoos  ',
  });
  assert.equal(d.ok, false);
  assert.ok(d.reasons.includes('proposed title is identical to the original'));
});

test('an empty or undefined proposed title is refused, not thrown on', () => {
  for (const proposedTitle of [undefined, '', '   ', 'Soap']) {
    const d = assessDistinctness({ originalTitle: 'Best Soap for Tattoos', proposedTitle });
    assert.equal(d.ok, false, `expected refusal for ${JSON.stringify(proposedTitle)}`);
    assert.ok(d.reasons.includes('proposed title is empty or too short'));
  }
});

test('a missing input object does not throw', () => {
  const d = assessDistinctness(undefined);
  assert.equal(d.ok, false);
  assert.equal(d.metaOverlap, null);
});

test('lostElements is ADVISORY — it never flips ok on an otherwise-good rewrite', () => {
  const d = assessDistinctness({
    originalTitle: 'Best Soap for Tattoos: Clean, Gentle, Fragrance-Free',
    proposedTitle: 'Tattoo Aftercare Soap in 2026: 7 Picks Artists Trust',
  });
  assert.equal(d.ok, true);
  assert.deepEqual(d.reasons, []);
  assert.deepEqual(d.lostElements, ['superlative', 'audience', 'negation']);
  assert.equal(d.advisory.length, 1);
  assert.ok(d.advisory[0].includes('superlative'));
  assert.ok(d.advisory[0].includes('may be deliberate'));
  // The loss must not leak into reasons — that is the whole distinction.
  assert.ok(!d.reasons.some((r) => r.includes('drops')));
});

test('metaOverlap is null unless BOTH metas are present', () => {
  const base = {
    originalTitle: 'Best Soap for Tattoos: Clean, Gentle, Fragrance-Free',
    proposedTitle: 'Tattoo Soap in 2026: 7 Fragrance-Free Picks',
  };
  assert.equal(assessDistinctness(base).metaOverlap, null);
  assert.equal(assessDistinctness({ ...base, originalMeta: 'Gentle soap.' }).metaOverlap, null);
  assert.equal(assessDistinctness({ ...base, proposedMeta: 'Gentle soap.' }).metaOverlap, null);
  const both = assessDistinctness({
    ...base,
    originalMeta: 'A gentle fragrance-free soap for fresh tattoos.',
    proposedMeta: 'A gentle fragrance-free soap for fresh tattoos.',
  });
  assert.equal(both.metaOverlap, 1);
});

test('options override the thresholds', () => {
  const input = {
    originalTitle: 'Coconut Oil Deodorant That Actually Works',
    proposedTitle: 'Coconut Oil Deodorant: Does It Actually Work?',
  };
  assert.equal(assessDistinctness(input).ok, true);
  // A stricter ceiling turns the same rewrite into a paraphrase.
  const strict = assessDistinctness(input, { maxTokenOverlap: 0.4 });
  assert.equal(strict.ok, false);
  assert.ok(strict.reasons.some((r) => r.includes('token overlap 57% > 40%')));
  // A stricter length floor refuses a short-but-material title.
  const short = assessDistinctness(
    { originalTitle: 'Coconut Oil Deodorant', proposedTitle: 'Deodorant 2026 Picks' },
    { minTitleTokens: 9 },
  );
  assert.ok(short.reasons.includes('proposed title is empty or too short'));
});

test('the exported defaults are the documented ones', () => {
  assert.equal(DEFAULT_MAX_TOKEN_OVERLAP, 0.7);
  assert.equal(DEFAULT_MIN_TITLE_TOKENS, 3);
});

// --- tokenOverlap ----------------------------------------------------------

test('tokenOverlap is 1 for identical and 0 for disjoint', () => {
  assert.equal(tokenOverlap('Best Soap for Tattoos', 'Best Soap for Tattoos'), 1);
  assert.equal(tokenOverlap('Coconut Deodorant Guide', 'Fluoride Toothpaste Picks'), 0);
});

test('tokenOverlap ignores word order, punctuation and brand tokens', () => {
  assert.equal(tokenOverlap('Gentle, Clean Soap', 'Clean Gentle Soap!'), 1);
  assert.equal(tokenOverlap('Coconut Lip Balm', 'Coconut Lip Balm | Real Skin Care'), 1);
});

test('tokenOverlap treats two empty inputs as identical and one empty as disjoint', () => {
  assert.equal(tokenOverlap('', ''), 1);
  assert.equal(tokenOverlap(undefined, undefined), 1);
  assert.equal(tokenOverlap('', 'Best Soap for Tattoos'), 0);
});

// --- contentTokens ---------------------------------------------------------

test('contentTokens lowercases, splits hyphens and drops stopwords + brand tokens', () => {
  assert.deepEqual(contentTokens('Best Soap for Tattoos: Clean, Gentle, Fragrance-Free'), [
    'best',
    'soap',
    'tattoos',
    'clean',
    'gentle',
    'fragrance',
    'free',
  ]);
  // 'real', 'skin', 'care' are brand tokens; 'the'/'of' are stopwords.
  assert.deepEqual(contentTokens('The Best of Real Skin Care'), ['best']);
  assert.deepEqual(contentTokens(undefined), []);
});

test("contentTokens KEEPS 'best', 'without', 'no' and 'free' — they are the CTR words", () => {
  assert.deepEqual(contentTokens('Toothpaste without SLS'), ['toothpaste', 'without', 'sls']);
  assert.deepEqual(contentTokens('Deodorant with No Aluminum'), ['deodorant', 'no', 'aluminum']);
  assert.ok(contentTokens('Fragrance-Free Soap').includes('free'));
});

// --- ctrElements -----------------------------------------------------------

test('ctrElements: number, and a year is NOT double-counted as one', () => {
  assert.ok(ctrElements('7 Picks Dermatologists Rate').includes('number'));
  assert.ok(ctrElements('12 Options Worth Trying').includes('number'));
  assert.ok(!ctrElements('Best Natural Soap 2026').includes('number'));
  assert.ok(ctrElements('Best Natural Soap 2026: 7 Picks').includes('number'));
});

test('ctrElements: year', () => {
  assert.ok(ctrElements('Best Natural Soap 2026').includes('year'));
  assert.ok(!ctrElements('Best Natural Soap').includes('year'));
  assert.ok(!ctrElements('Soap for 1990s Skin').includes('year'));
});

test('ctrElements: bracket covers (), [], a pipe separator and a dash qualifier', () => {
  assert.ok(ctrElements('Natural Soap Guide (Updated)').includes('bracket'));
  assert.ok(ctrElements('[Guide] Natural Soap').includes('bracket'));
  assert.ok(ctrElements('Natural Soap Guide | Real Skin Care').includes('bracket'));
  assert.ok(ctrElements('Natural Soap Guide — What to Know').includes('bracket'));
  assert.ok(ctrElements('Natural Soap Guide – What to Know').includes('bracket'));
  assert.ok(!ctrElements('Natural Soap Guide: What to Know').includes('bracket'));
});

test('ctrElements: question', () => {
  assert.ok(ctrElements('Does Coconut Oil Really Work?').includes('question'));
  assert.ok(ctrElements('Does Coconut Oil Really Work?  ').includes('question'));
  assert.ok(!ctrElements('Coconut Oil Really Works').includes('question'));
});

test('ctrElements: superlative', () => {
  for (const w of ['Best', 'Top', 'Ultimate', 'Complete', 'Definitive', 'Safest', 'Gentlest', 'Strongest', 'Cheapest']) {
    assert.ok(ctrElements(`${w} Natural Soap`).includes('superlative'), w);
  }
  assert.ok(!ctrElements('Natural Soap Guide').includes('superlative'));
});

test('ctrElements: audience is presence-only here', () => {
  assert.ok(ctrElements('Natural Soap for Sensitive Skin').includes('audience'));
  assert.ok(ctrElements('Deodorant for Men').includes('audience'));
  assert.ok(!ctrElements('Natural Soap Guide').includes('audience'));
});

test('assessDistinctness counts audience as new only when the "for X" phrase changes', () => {
  const same = assessDistinctness({
    originalTitle: 'Natural Soap for Sensitive Skin',
    proposedTitle: 'Gentle Bar Soap for Sensitive Skin',
  });
  assert.ok(!same.newElements.includes('audience'));
  const changed = assessDistinctness({
    originalTitle: 'Natural Deodorant for Men',
    proposedTitle: 'Natural Deodorant for Women',
  });
  assert.ok(changed.newElements.includes('audience'));
  const added = assessDistinctness({
    originalTitle: 'Natural Deodorant Guide',
    proposedTitle: 'Natural Deodorant Guide for Beginners',
  });
  assert.ok(added.newElements.includes('audience'));
});

test('ctrElements: negation', () => {
  assert.ok(ctrElements('Deodorant Without Aluminum').includes('negation'));
  assert.ok(ctrElements('Toothpaste with No Fluoride').includes('negation'));
  assert.ok(ctrElements('Soap Free of Sulfates').includes('negation'));
  assert.ok(ctrElements('Fragrance-Free Bar Soap').includes('negation'));
  assert.ok(ctrElements('Skip the Aluminum').includes('negation'));
  assert.ok(ctrElements('Avoid These Ingredients').includes('negation'));
  assert.ok(ctrElements('Never Reapply Again').includes('negation'));
  // 'no' must not fire inside another word.
  assert.ok(!ctrElements('Nourishing Bar Soap').includes('negation'));
});

test('ctrElements: timeframe', () => {
  assert.ok(ctrElements('Clear Results in 7 Days').includes('timeframe'));
  assert.ok(ctrElements('Two Weeks to Softer Hands').includes('timeframe'));
  assert.ok(ctrElements('Works in 10 Minutes').includes('timeframe'));
  assert.ok(ctrElements('Overnight Lip Repair').includes('timeframe'));
  assert.ok(ctrElements('Softer Hands in 24 Hours').includes('timeframe'));
  assert.ok(ctrElements('One Pump Per Day').includes('timeframe'));
  assert.ok(!ctrElements('Natural Soap Guide').includes('timeframe'));
});

test('ctrElements returns [] for empty input and is deterministically ordered', () => {
  assert.deepEqual(ctrElements(''), []);
  assert.deepEqual(ctrElements('   '), []);
  assert.deepEqual(ctrElements(undefined), []);
  assert.deepEqual(ctrElements(null), []);
  const title = 'Best Soap for Tattoos in 2026 (Updated): 7 Fragrance-Free Picks — Results in 14 Days?';
  const expected = [
    'number',
    'year',
    'bracket',
    'question',
    'superlative',
    'audience',
    'negation',
    'timeframe',
  ];
  assert.deepEqual(ctrElements(title), expected);
  // Repeat calls must not drift (no /g regex carrying lastIndex).
  assert.deepEqual(ctrElements(title), expected);
  assert.deepEqual(ctrElements('Best Natural Soap 2026'), ['year', 'superlative']);
});
