import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRODUCT_CATEGORY_MISNOMERS,
  findProductCategoryMisnomers,
  sanitizeProductCategoryTerm,
  PRODUCT_CATEGORY_COMPLIANCE_RULE,
} from '../../lib/product-category-terms.js';

// ── Arm A — brand-attached misnomer (blocks) ─────────────────────────────────────

test('flags "our antiperspirant"', () => {
  const hits = findProductCategoryMisnomers('Try our antiperspirant.');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].term, 'antiperspirant');
  assert.equal(hits[0].correct, 'deodorant');
  assert.match(hits[0].match, /our antiperspirant/i);
});

test('flags "Real Skin Care\'s natural antiperspirant"', () => {
  const hits = findProductCategoryMisnomers(
    "Start with Real Skin Care's natural antiperspirant, made without aluminum.",
  );
  assert.equal(hits.length, 1);
});

test('flags a curly apostrophe in the brand possessive', () => {
  const hits = findProductCategoryMisnomers('Real Skin Care’s antiperspirant is aluminum-free.');
  assert.equal(hits.length, 1);
});

test('flags "our aluminum-free antiperspirant" through up to three modifiers', () => {
  assert.equal(findProductCategoryMisnomers('our aluminum-free antiperspirant works').length, 1);
  assert.equal(
    findProductCategoryMisnomers('our best-selling coconut oil antiperspirant.').length,
    1,
  );
});

test('flags the plural', () => {
  assert.equal(findProductCategoryMisnomers('our antiperspirants are clean.').length, 1);
});

test('flags RSC\'s possessive', () => {
  assert.equal(findProductCategoryMisnomers("RSC's antiperspirant.").length, 1);
});

// ── Arm A — the category references it MUST NOT touch ────────────────────────────
//
// Every string below is drawn from live realskincare.com copy (or is the exact shape
// of it). These pages RANK for the query; a rule that fires here silently kills the
// copy on regeneration, which is the failure PR #633 was built to avoid.

const CATEGORY_REFERENCES = [
  'Natural Deodorant vs. Antiperspirant: What’s the Actual Difference?',
  'Under 21 CFR Part 350, the FDA classifies antiperspirants as over-the-counter (OTC) drugs.',
  'Conventional antiperspirants suppress sweat gland activity over time.',
  'Switching away from aluminum-based antiperspirants is the single most effective change.',
  'Aluminum salts are the active ingredient in antiperspirants.',
  'Is there really no such thing as an aluminum-free antiperspirant?',
  'When Was Antiperspirant Invented? (1903 and Beyond)',
  'Travel Size Antiperspirant: What to Know Before You Pack',
  'Unlike traditional antiperspirants, which block sweat glands, our formula absorbs moisture.',
  'Most people find they don’t miss conventional antiperspirant at all.',
  'your old antiperspirant may have masked the problem',
  'It takes four weeks to adjust after quitting antiperspirant.',
  'a 24-hour antiperspirant claim is a drug claim',
];

for (const s of CATEGORY_REFERENCES) {
  test(`category reference is untouched: ${s.slice(0, 60)}`, () => {
    assert.deepEqual(findProductCategoryMisnomers(s), []);
  });
}

// The two shapes that made the naive "brand token within N words" rule unusable —
// both are live strings, and both are about an ARTICLE we wrote, not a product we sell.
test('a possessive whose head noun is not the term is left alone', () => {
  assert.deepEqual(
    findProductCategoryMisnomers(
      'read more about the distinction in our deep-dive on aluminum-free antiperspirant: what it is',
    ),
    [],
  );
  assert.deepEqual(
    findProductCategoryMisnomers('check our natural deodorant vs antiperspirant guide'),
    [],
  );
});

test('a preposition or conjunction inside the gap breaks the attachment', () => {
  assert.deepEqual(findProductCategoryMisnomers('our take on antiperspirant'), []);
  assert.deepEqual(findProductCategoryMisnomers('our deodorant and antiperspirant coverage'), []);
});

test('"our" must be a whole word — "your", "four", "hour" never match', () => {
  assert.deepEqual(findProductCategoryMisnomers('your antiperspirant'), []);
  assert.deepEqual(findProductCategoryMisnomers('four antiperspirant brands'), []);
  assert.deepEqual(findProductCategoryMisnomers('24-hour antiperspirant protection'), []);
});

test('empty and non-string inputs are safe', () => {
  assert.deepEqual(findProductCategoryMisnomers(''), []);
  assert.deepEqual(findProductCategoryMisnomers(null), []);
  assert.deepEqual(findProductCategoryMisnomers(undefined), []);
});

test('every occurrence is returned, not just the first', () => {
  const hits = findProductCategoryMisnomers('Our antiperspirant is clean. Our antiperspirant works.');
  assert.equal(hits.length, 2);
});

// ── Arm B — sanitize product-subject copy (never blocks) ─────────────────────────

test('sanitize rewrites the term to the accurate category', () => {
  assert.equal(sanitizeProductCategoryTerm('travel size antiperspirant'), 'travel size deodorant');
  assert.equal(
    sanitizeProductCategoryTerm('aluminum free antiperspirant what it is does it work'),
    'aluminum free deodorant what it is does it work',
  );
});

test('sanitize preserves the plural and the letter case it found', () => {
  assert.equal(sanitizeProductCategoryTerm('Antiperspirants'), 'Deodorants');
  assert.equal(sanitizeProductCategoryTerm('ANTIPERSPIRANT'), 'DEODORANT');
  assert.equal(sanitizeProductCategoryTerm('Antiperspirant'), 'Deodorant');
});

test('sanitize leaves text with no misnomer byte-identical', () => {
  const s = 'best natural deodorant for sensitive skin';
  assert.equal(sanitizeProductCategoryTerm(s), s);
});

test('sanitize is idempotent', () => {
  const once = sanitizeProductCategoryTerm('our antiperspirant');
  assert.equal(sanitizeProductCategoryTerm(once), once);
});

test('sanitize never leaves the term behind, and its output passes Arm A', () => {
  const out = sanitizeProductCategoryTerm("Real Skin Care's natural antiperspirant");
  assert.doesNotMatch(out, /antiperspirant/i);
  assert.deepEqual(findProductCategoryMisnomers(out), []);
});

test('sanitize handles empty and non-string input', () => {
  assert.equal(sanitizeProductCategoryTerm(''), '');
  assert.equal(sanitizeProductCategoryTerm(null), '');
  assert.equal(sanitizeProductCategoryTerm(undefined), '');
});

// ── the table and the prompt rule ────────────────────────────────────────────────

test('every misnomer entry carries a correction and a written reason', () => {
  assert.ok(PRODUCT_CATEGORY_MISNOMERS.length >= 1);
  for (const m of PRODUCT_CATEGORY_MISNOMERS) {
    assert.equal(typeof m.term, 'string');
    assert.equal(typeof m.correct, 'string');
    assert.ok(m.why.length > 40, `${m.term} needs a real reason`);
    assert.ok(m.pattern instanceof RegExp);
  }
});

test('the compliance rule names the word and the reason a writer needs', () => {
  assert.match(PRODUCT_CATEGORY_COMPLIANCE_RULE, /antiperspirant/i);
  assert.match(PRODUCT_CATEGORY_COMPLIANCE_RULE, /deodorant/i);
  // It must also permit the category reference, or a model will over-correct the
  // very pages that rank for the query.
  assert.match(PRODUCT_CATEGORY_COMPLIANCE_RULE, /categor/i);
});
