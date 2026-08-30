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

// All three apostrophe code points fold identically. Written as \u escapes, not glyphs:
// U+02BC and U+2019 are indistinguishable by eye, and U+02BC was silently dropped from
// this class once already.
const folded = ['\u0027', '\u2019', '\u02BC'].map(a => normalizeForMatch(`That${a}s it`));
assert.equal(folded[1], folded[0], 'U+2019 must fold like U+0027');
assert.equal(folded[2], folded[0], 'U+02BC must fold like U+0027');
assert.equal(folded[0], 'thats it');
assert.equal(normalizeForMatch('‘quoted’'), 'quoted');

// Separator glyphs fold to a space, so the volume as PRINTED on the bottle matches the
// volume as WRITTEN in prose. Each line is annotated with the glyph's name, since a
// bullet, a middle dot and a period are hard to tell apart in a diff.
assert.equal(normalizeForMatch('8 fl. oz. • 236ml'), '8 fl oz 236ml');   // BULLET
assert.equal(normalizeForMatch('8 fl. oz. · 236ml'), '8 fl oz 236ml');   // MIDDLE DOT
assert.equal(normalizeForMatch('8 fl. oz. | 236ml'), '8 fl oz 236ml');   // VERTICAL LINE
assert.equal(normalizeForMatch('8 fl. oz. (236ml)'), '8 fl oz 236ml');

// A word-joining hyphen is NOT a separator and must survive, or "cold-pressed" would
// match sources that merely contain the two words apart.
assert.equal(normalizeForMatch('Cold-Pressed'), 'cold-pressed');
assert.notEqual(normalizeForMatch('Cold-Pressed'), normalizeForMatch('Cold Pressed'));

// A JOINING "+" folds — the label badge sets these as separate curved runs.
assert.equal(normalizeForMatch('Organic Coconut Oil + Essential Oils'), 'organic coconut oil essential oils');
assert.equal(normalizeForMatch('+ ESSENTIAL OILS'), 'essential oils');
// ...but a "+" attached to its token means "or more" and MUST survive, or an inflated
// claim would resolve against a source that never made it.
assert.equal(normalizeForMatch('20+ years'), '20+ years');
assert.notEqual(normalizeForMatch('20+ years'), normalizeForMatch('20 years'));
const plusIndex = buildSourceIndex({ pdpBody: 'Trusted by 20 years of customers' });
assert.equal(
  validateClaims([{ zone: 'badge', text: '20+ YEARS', factual: true, sourceId: 'pdp', evidence: '20+ years' }], plusIndex).ok,
  false,
  '"20+ years" must not resolve against a source that says "20 years"',
);

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

// Folding separator glyphs must NOT make the claim gate accept an invented number. The
// gate's founding failure was a 6 fl. oz. volume on a 2 fl. oz. bottle; the widening
// only erases the glyph BETWEEN tokens, never the tokens themselves.
const volumeIndex = buildSourceIndex({ catalogEntry: { title: 'Body Lotion', size: '8 fl. oz. (236ml)' } });
assert.equal(
  validateClaims([{ zone: 'label', text: '8 FL OZ', factual: true, sourceId: 'catalog', evidence: '8 fl. oz. • 236ml' }], volumeIndex).ok,
  true,
  'the same volume written with a bullet must resolve against the prose form',
);
assert.equal(
  validateClaims([{ zone: 'label', text: '6 FL OZ', factual: true, sourceId: 'catalog', evidence: '6 fl. oz. • 236ml' }], volumeIndex).ok,
  false,
  'an invented volume must still fail, separator glyphs or not',
);
assert.equal(
  validateClaims([{ zone: 'label', text: 'X', factual: true, sourceId: 'catalog', evidence: '• | ·' }], volumeIndex).ok,
  false,
  'a claim made only of separator glyphs normalizes to empty and must not match everything',
);

// ── "/" is a separator, not a character (2026-08-16) ────────────────────────────────
//
// The verify prompt promises that LINE BREAKS are ignored when deciding whether an
// expected string is present. The mechanical re-check did not honour that: a two-line
// brand mark quoted back as "real / SKIN CARE" never matched the expected
// "real SKIN CARE", and an offer-focused 1:1 plate that was entirely correct burned all
// three paid attempts and lost its placement. "|" and "•" were already stripped; "/" was
// the one the model actually reached for.
assert.equal(normalizeForMatch('real / SKIN CARE'), 'real skin care');
assert.equal(normalizeForMatch('real | SKIN CARE'), 'real skin care');
assert.equal(normalizeForMatch('real \\ SKIN CARE'), 'real skin care');
assert.equal(normalizeForMatch('real ⁄ SKIN CARE'), 'real skin care');
assert.equal(normalizeForMatch('real\nSKIN CARE'), 'real skin care');
// The un-separated form is unchanged — this widens what matches, it does not move it.
assert.equal(normalizeForMatch('real SKIN CARE'), 'real skin care');

// A volume written with a slash normalises the same way the label prints it, so the
// literal and the rendered form agree instead of differing on punctuation alone.
assert.equal(normalizeForMatch('8 fl. oz / 236ml'), normalizeForMatch('8 fl. oz • 236ml'));
assert.equal(normalizeForMatch('4 FL oz / 118ml'), '4 fl oz 118ml');

// Symmetry is what makes this safe for the CLAIM GATE: the same normalisation runs on the
// evidence and on the source, so a slash cannot make an unsourced claim look sourced.
{
  const index = buildSourceIndex({ pdpBody: 'Built on six ingredients / no fillers at all.' });
  const ok = validateClaims(
    [{ zone: 'headline', text: 'Six ingredients', factual: true, sourceId: 'pdp', evidence: 'six ingredients / no fillers' }],
    index,
  );
  assert.equal(ok.ok, true, 'evidence and source normalise identically');

  const bad = validateClaims(
    [{ zone: 'headline', text: 'Clinically proven', factual: true, sourceId: 'pdp', evidence: 'clinically proven / dermatologist tested' }],
    index,
  );
  assert.equal(bad.ok, false, 'and a claim that is genuinely absent still fails');
}

// ── one serialization for a structured source (2026-08-25) ───────────────────────────
//
// THE BUG. buildSourceIndex used `JSON.stringify(x)`; copy.js's sourceBlock showed the
// writer `JSON.stringify(x, null, 1)`. normalizeForMatch DELETES `"` and `:` and then
// collapses whitespace, so those two are not interchangeable: compact JSON glues a key to
// its value (`pricelabel$88`), indented JSON leaves a space (`pricelabel $88`). A writer
// quoting a contiguous span exactly as shown produced a needle that matched the text it was
// shown and not the text being searched — two of three concepts on the first
// coconut-bar-soap-12-pack run were rejected for claims that were true and correctly
// attributed. The gate was not wrong about them; it was reading a different document.
{
  const { sourceText } = await import('../../agents/ad-studio/claims.js');
  const catalogEntry = {
    title: 'Coconut Bar Soap — 12-Pack',
    price: 88,
    priceLabel: '$88',
    compareAtPrice: 132,
    compareAtLabel: '$132',
    savingsLabel: '$44',
  };
  const index = buildSourceIndex({ catalogEntry });

  // THE INVARIANT: anything a writer can read off the displayed source is findable in the
  // index. Asserted against sourceText's own output, which is what sourceBlock renders.
  const shown = sourceText(catalogEntry);
  for (const span of ['"priceLabel": "$88"', '"compareAtLabel": "$132"', '"savingsLabel": "$44"']) {
    assert.ok(shown.includes(span), `the writer is shown ${span} verbatim`);
    assert.equal(
      validateClaims([{ zone: 'offerBadge', text: 'x', factual: true, sourceId: 'catalog', evidence: span }], index).ok,
      true,
      `and a claim quoting ${span} is sourced`,
    );
  }

  // Quoting the VALUE alone still works — that path never broke and must not start.
  assert.equal(
    validateClaims([{ zone: 'offerBadge', text: '$88', factual: true, sourceId: 'catalog', evidence: '$88' }], index).ok,
    true,
  );

  // AND THE FIX TIGHTENS RATHER THAN LOOSENS. Gluing tokens is what let a span straddling
  // two unrelated fields count as contiguous; separated, it cannot.
  assert.equal(
    validateClaims([{ zone: 'offerBadge', text: 'nonsense', factual: true, sourceId: 'catalog', evidence: '$88compareAtLabel' }], index).ok,
    false,
    'a span straddling two fields is not evidence',
  );
  assert.equal(
    validateClaims([{ zone: 'offerBadge', text: 'invented', factual: true, sourceId: 'catalog', evidence: '$77' }], index).ok,
    false,
    'and a price that is simply not there still fails',
  );

  // A prose source has one representation and is passed through untouched.
  assert.equal(sourceText('saponified coconut oil, nothing else'), 'saponified coconut oil, nothing else');
}
