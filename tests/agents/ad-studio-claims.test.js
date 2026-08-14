import { strict as assert } from 'node:assert';
import {
  buildSourceIndex,
  normalizeForMatch,
  validateClaims,
  assertClaimsSourced,
} from '../../agents/ad-studio/claims.js';

const index = buildSourceIndex({
  pdpBody: 'We built this around six ingredients that actually absorb. No mineral oil, no petrolatum, no dimethicone.',
  catalogEntry: { title: 'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients', priceLabel: '$30' },
  brandKit: { palette_hexes: ['#000000', '#EDE5D8'] },
  reviews: ['It absorbed without leaving my skin greasy.'],
});

// normalizeForMatch: case, whitespace, and curly punctuation all fold away.
assert.equal(normalizeForMatch('  No   Mineral OIL. '), 'no mineral oil');
assert.equal(normalizeForMatch("That’s the whole list"), normalizeForMatch("That's the whole list"));

// A factual claim whose evidence appears in its named source passes.
const good = [
  { zone: 'headline', text: 'SIX INGREDIENTS.', factual: true, sourceId: 'catalog', evidence: '6 Clean Ingredients' },
  { zone: 'bottomBar', text: 'NO MINERAL OIL', factual: true, sourceId: 'pdp', evidence: 'no mineral oil' },
  { zone: 'subhead', text: "THAT'S THE WHOLE LIST.", factual: false },
];
const okResult = validateClaims(good, index);
assert.equal(okResult.ok, true);
assert.deepEqual(okResult.violations, []);
assert.doesNotThrow(() => assertClaimsSourced(good, index));

// Missing sourceId on a factual claim.
const noSource = [{ zone: 'headline', text: 'FOUR INGREDIENTS.', factual: true }];
const r1 = validateClaims(noSource, index);
assert.equal(r1.ok, false);
assert.equal(r1.violations.length, 1);
assert.match(r1.violations[0].reason, /no sourceId/i);
assert.equal(r1.violations[0].zone, 'headline');

// sourceId names a source that does not exist.
const badSource = [{ zone: 'headline', text: 'X', factual: true, sourceId: 'invented', evidence: 'x' }];
assert.match(validateClaims(badSource, index).violations[0].reason, /unknown source: invented/i);

// Evidence text is not actually present in the named source.
const badEvidence = [
  { zone: 'bottomBar', text: 'CLINICALLY PROVEN', factual: true, sourceId: 'pdp', evidence: 'clinically proven' },
];
const r2 = validateClaims(badEvidence, index);
assert.equal(r2.ok, false);
assert.match(r2.violations[0].reason, /not found in source/i);

// Evidence matches across punctuation and case differences.
const punct = [
  { zone: 'headline', text: 'SIX INGREDIENTS', factual: true, sourceId: 'catalog', evidence: '6 clean INGREDIENTS' },
];
assert.equal(validateClaims(punct, index).ok, true);

// A factual claim with a sourceId but no evidence string is a violation.
const noEvidence = [{ zone: 'headline', text: 'X', factual: true, sourceId: 'pdp' }];
assert.match(validateClaims(noEvidence, index).violations[0].reason, /no evidence/i);

// assertClaimsSourced throws and names every violating zone.
assert.throws(
  () => assertClaimsSourced([...noSource, ...badEvidence], index),
  err => /headline/.test(err.message) && /bottomBar/.test(err.message)
);

// Reviews are a usable source.
const fromReview = [
  { zone: 'subhead', text: 'ABSORBS WITHOUT GREASE', factual: true, sourceId: 'reviews', evidence: 'without leaving my skin greasy' },
];
assert.equal(validateClaims(fromReview, index).ok, true);

// An empty source set means every factual claim fails — no silent pass.
const emptyIndex = buildSourceIndex({});
assert.equal(validateClaims(good, emptyIndex).ok, false);
