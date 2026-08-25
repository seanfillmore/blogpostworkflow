/**
 * The OTC-phrasing carve-out: two correct rules that used to contradict each other.
 *
 *   agents/ad-studio/health-claims.js  — "over-the-counter" is a DRUG reference and an
 *                                        ad has no legitimate reason to use it. Blocked
 *                                        outright, and these tests pin that it still is.
 *   lib/seo-copy-health-gate.js        — inherits the same patterns for SEO copy, where
 *                                        several pages exist precisely to explain that an
 *                                        antiperspirant is a regulated OTC drug and a
 *                                        deodorant is a cosmetic.
 *
 * The line is the one PR #633 and PR #661 already drew twice: "the product does X" is a
 * claim; "here is information about X" is not. So a brand-governed phrase blocks and a
 * category reference does not.
 *
 * Most of the "must pass" strings below are VERBATIM live prose, pulled read-only from
 * the corpus on 2026-08-24. They are the measurement, not illustrations.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  findHealthClaims,
  hasHealthClaim,
  assertNoHealthClaims,
  HEALTH_CLAIM_PATTERNS,
} from '../../agents/ad-studio/health-claims.js';
import {
  checkSeoCopy,
  checkSeoCopyFields,
  findSeoCopyClaims,
  seoCopyConstraint,
  ADVISORY_CATEGORIES,
  BLOCKING_CATEGORIES,
  REGULATORY_REFERENCE_CATEGORY,
  SEO_COPY_COMPLIANCE_RULE,
} from '../../lib/seo-copy-health-gate.js';
import { findBrandGovernedPhrases } from '../../lib/product-category-terms.js';

/** Verbatim live sentences, 2026-08-24 read-only pull. Every one must PASS the SEO gate. */
const LIVE_CATEGORY_REFERENCES = [
  'In the United States, the FDA classifies antiperspirants as over-the-counter drugs because they alter a bodily function.',
  'The FDA classifies antiperspirants as over-the-counter drugs, not cosmetics, specifically because aluminum compounds alter a body function (sweating).',
  'Under 21 CFR Part 350, the FDA classifies antiperspirants as over-the-counter (OTC) drugs — not cosmetics.',
  'Because it changes a body function, the FDA classifies it as an OTC drug.',
  'Antiperspirant is classified as an over-the-counter drug by the FDA — not a cosmetic.',
  'The FDA banned triclosan from over-the-counter hand soaps in 2016 after manufacturers could not prove it was safe for long-term use.',
  'Colloidal oatmeal: finely ground oat that is recognized by the FDA as an over-the-counter skin protectant.',
  "The FDA's OTC monograph formally recognizes colloidal oatmeal as a skin protectant, which is a meaningful distinction.",
  'FDA — 21 CFR Part 350: Antiperspirant Drug Products for Over-the-Counter Human Use.',
];

describe('the AD-COPY gate is unchanged — "over-the-counter" still blocks outright', () => {
  test('the drug pattern still matches every OTC spelling', () => {
    const drug = HEALTH_CLAIM_PATTERNS.find((p) => p.category === 'drug');
    for (const s of ['over-the-counter', 'over the counter', 'OTC', 'otc']) {
      assert.ok(drug.pattern.test(s), `drug pattern must still match ${JSON.stringify(s)}`);
    }
  });

  test('hasHealthClaim is true for a pure category reference — an ad may not say it either', () => {
    for (const s of LIVE_CATEGORY_REFERENCES) {
      assert.equal(hasHealthClaim(s), true, `ad gate must still block: ${s}`);
    }
  });

  test('findHealthClaims still reports it as `drug`', () => {
    const hits = findHealthClaims('Antiperspirants are regulated as over-the-counter drugs.');
    assert.ok(hits.some((h) => h.category === 'drug'));
  });

  test('assertNoHealthClaims still throws on ad copy carrying it', () => {
    assert.throws(
      () => assertNoHealthClaims({ headline: 'Not an over-the-counter antiperspirant' }),
      /Health claim gate failed/,
    );
  });

  test('and on the OTC abbreviation alone', () => {
    assert.throws(() => assertNoHealthClaims({ body: ['Unlike OTC formulas.'] }), /Health claim gate failed/);
  });
});

describe('SEO copy — a regulatory category reference is ADVISORY, not blocking', () => {
  for (const s of LIVE_CATEGORY_REFERENCES) {
    test(`passes: ${s.slice(0, 62)}…`, () => {
      const r = checkSeoCopyFields({ meta: s });
      assert.equal(r.ok, true, JSON.stringify(r.blocking));
    });
  }

  test('the hit is still REPORTED, under its own advisory category', () => {
    const r = findSeoCopyClaims('The FDA classifies antiperspirants as over-the-counter drugs.');
    assert.deepEqual(r.blocking, []);
    assert.equal(r.advisory.length, 1);
    assert.equal(r.advisory[0].category, REGULATORY_REFERENCE_CATEGORY);
    assert.match(r.advisory[0].match, /over-the-counter/i);
  });

  test('the advisory category is declared advisory and is not blocking', () => {
    assert.ok(ADVISORY_CATEGORIES.has(REGULATORY_REFERENCE_CATEGORY));
    assert.equal(BLOCKING_CATEGORIES.has(REGULATORY_REFERENCE_CATEGORY), false);
  });

  test('realistic explainer titles are no longer refused', () => {
    const titles = [
      'Deodorant vs Antiperspirant: Cosmetic or Over-the-Counter Drug?',
      'Is Natural Deodorant an OTC Drug? What the FDA Monograph Says',
      'Aluminum-Free Deodorant: Why It Is Not an Over-the-Counter Antiperspirant',
    ];
    for (const title of titles) {
      assert.equal(checkSeoCopy({ title }).ok, true, title);
    }
  });

  test('a demoted OTC hit does not rescue a real claim in the same string', () => {
    const r = findSeoCopyClaims(
      'Antiperspirants are over-the-counter drugs; our balm heals eczema.',
    );
    assert.equal(r.blocking.length >= 2, true);
    assert.ok(r.blocking.some((h) => h.category === 'therapeutic'));
    assert.ok(r.blocking.some((h) => h.category === 'disease'));
    assert.ok(r.advisory.some((h) => h.category === REGULATORY_REFERENCE_CATEGORY));
  });
});

describe('SEO copy — a BRAND-GOVERNED OTC phrase still blocks', () => {
  const BAD = [
    'Our over-the-counter formula keeps you dry',
    'our OTC formula',
    'Our over-the-counter deodorant is aluminum-free',
    "Real Skin Care's over-the-counter formula",
    "Real Skin Care's OTC deodorant",
    'Real Skin Care over-the-counter deodorant',
    'Our pick for over the counter deodorant: Coconut Oil Deodorant',
    'Our top pick for OTC deodorant: Coconut Oil Deodorant',
  ];
  for (const s of BAD) {
    test(`blocks: ${s}`, () => {
      const r = checkSeoCopyFields({ title: s });
      assert.equal(r.ok, false, `should have blocked: ${s}`);
      assert.ok(r.blocking.some((h) => /over[- ]the[- ]counter|otc/i.test(h.match)));
      assert.equal(r.blocking[0].category, 'drug');
    });
  }

  test('the block survives the retry constraint naming the word', () => {
    const r = checkSeoCopyFields({ title: 'Our over-the-counter formula' });
    const c = seoCopyConstraint(r.blocking);
    assert.match(c, /over-the-counter/i);
    // and it must TELL the model the category reference is fine, or the retry strips the
    // phrase out of the FDA explanation and the rewrite is worse than the block.
    assert.match(c, /category/i);
  });
});

describe('SEO copy — the shapes that must NOT be flagged, from the live corpus', () => {
  const GOOD = [
    'our deep-dive on over-the-counter antiperspirant rules',
    'check our natural deodorant vs over-the-counter antiperspirant guide',
    'our guide to OTC drug classification',
    'Real Skin Care explains how the FDA regulates over-the-counter antiperspirants',
    'Our deodorant is a cosmetic, not an over-the-counter drug',
    'Real Skin Care deodorant is not an over-the-counter antiperspirant',
    'never call our product an over-the-counter drug',
    'Our pick for over-the-counter quitters: Coconut Oil Deodorant',
  ];
  for (const s of GOOD) {
    test(`passes: ${s}`, () => {
      assert.equal(checkSeoCopyFields({ meta: s }).ok, true, `should not have blocked: ${s}`);
    });
  }
});

describe('the compliance rule states BOTH halves', () => {
  test('the first-generation rule permits the category explanation', () => {
    assert.match(SEO_COPY_COMPLIANCE_RULE, /over-the-counter/i);
    assert.match(SEO_COPY_COMPLIANCE_RULE, /MAY|SHOULD/);
  });
});

describe('the brand-governance matcher is SHARED, not re-implemented', () => {
  test('findBrandGovernedPhrases works for an arbitrary term', () => {
    const src = String.raw`(?:over[-\s]the[-\s]counter|otc)`;
    assert.equal(findBrandGovernedPhrases('our OTC formula', src).length, 1);
    assert.equal(findBrandGovernedPhrases('our guide to OTC rules', src).length, 0);
  });

  test('it still produces the antiperspirant rule unchanged', () => {
    const src = String.raw`antiperspirants?`;
    assert.equal(findBrandGovernedPhrases("Real Skin Care's antiperspirant formula", src).length, 1);
    assert.equal(
      findBrandGovernedPhrases('our deep-dive on aluminum-free antiperspirant: what it is', src).length,
      0,
    );
  });
});

describe('documented, deliberate misses — pinned so they stay visible', () => {
  // The gap rule treats a determiner as opening a new noun phrase, which is what makes
  // "our deodorant is NOT an over-the-counter drug" safe. The positive form is collateral.
  // Left as a miss on purpose: the negation is copy this brand genuinely writes and must
  // never lose, the positive form is a sentence no writer produces (it is false about the
  // product and contradicts every brief), and reaching it would cost the negation.
  test('"our deodorant is an over-the-counter drug" is NOT caught', () => {
    assert.equal(checkSeoCopyFields({ meta: 'Our deodorant is an over-the-counter drug.' }).ok, true);
  });

  // PRODUCT_NOUNS is a whitelist of things RSC physically sells and `drug` is not one.
  // Adding it would flag "Real Skin Care explains over-the-counter drugs" — a real
  // sentence — so the whitelist's unknown-means-allow asymmetry is kept.
  test('"our over-the-counter drug" is NOT caught', () => {
    assert.equal(checkSeoCopyFields({ meta: 'our over-the-counter drug' }).ok, true);
  });
});

describe('the rest of the `drug` vocabulary is deliberately untouched', () => {
  for (const s of [
    'Our formula outperforms prescription treatments',
    'Stronger than prescription strength lotions',
    'Our medicated deodorant',
    'A steroid-free alternative to hydrocortisone that works better',
  ]) {
    test(`still blocks: ${s}`, () => {
      assert.equal(checkSeoCopyFields({ meta: s }).ok, false, s);
    });
  }
});
