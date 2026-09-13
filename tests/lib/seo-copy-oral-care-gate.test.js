/**
 * Oral-care and child-safety vocabulary in the copy gates (2026-09-13).
 *
 * Toothpaste orders started arriving through blog posts, and the copy beside those buy
 * boxes said "Support natural remineralization with Real Skin Care's…" and "Real Skin
 * Care's formula is safe for kids". Nothing caught either. These tests pin what now
 * blocks, what deliberately does not, and — as much — that the wording the remediation
 * replaced those claims WITH still passes, so the gate can never refuse its own fix.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkSeoCopy,
  checkSeoCopyFields,
  seoCopyConstraint,
  BLOCKING_CATEGORIES,
  ADVISORY_CATEGORIES,
  CHILD_SAFETY_CATEGORY,
  CHILD_SAFETY_MENTIONED_CATEGORY,
  ORAL_CARE_COMPLIANCE_RULE,
  SEO_COPY_COMPLIANCE_RULE,
  EDITORIAL_SURFACE,
} from '../../lib/seo-copy-health-gate.js';
import { hasHealthClaim } from '../../agents/ad-studio/health-claims.js';
import { PLAN } from '../../scripts/remediate-toothpaste-safety-claims.mjs';

const EDITORIAL = { surface: EDITORIAL_SURFACE };
const blocks = (copy, opts) => checkSeoCopy(copy, opts).ok === false;

describe('the live incident strings now block', () => {
  test('the glycerin buy-box CTA and SERP description', () => {
    assert.ok(blocks({ meta: "Support natural remineralization with Real Skin Care's All Natural Coconut Oil Toothpaste." }, EDITORIAL));
    assert.ok(blocks({ meta: 'Learn why many dentists recommend glycerin-free toothpaste. Discover the benefits for remineralization, sensitivity, and clean oral care.' }, EDITORIAL));
  });

  test('the families SERP description that called our formula safe for kids', () => {
    assert.ok(blocks({ meta: 'Discover the best natural toothpaste for families in 2025. Safe for kids and adults, Real Skin Care’s All Natural formula offers clean, effective oral care.' }, EDITORIAL));
  });

  test('the live foaming-hand-soap collection FAQ is refused on regeneration', () => {
    const r = checkSeoCopyFields({ body: '<p>Is this soap safe for kids and frequent use? Yes. The formula is free of sulfates.</p>' });
    assert.equal(r.ok, false);
    assert.equal(r.blocking[0].category, CHILD_SAFETY_CATEGORY);
  });
});

describe('enamel-repair and anticavity claims block on every surface', () => {
  for (const t of [
    'Toothpaste That Remineralizes Enamel',
    'Rebuilds Tooth Enamel Naturally',
    'Strengthens Enamel Without Fluoride',
    'Anti-Cavity Coconut Oil Toothpaste',
    'Cavity Protection Without Fluoride',
    'Protects Against Tooth Decay',
  ]) {
    test(`"${t}"`, () => {
      assert.ok(blocks({ title: t }, EDITORIAL), 'editorial');
      assert.ok(blocks({ title: t }), 'commercial');
      assert.ok(hasHealthClaim(t), 'and the ad gate, which shares the pattern');
    });
  }

  test('`oral-drug-claim` is a blocking category', () => {
    assert.ok(BLOCKING_CATEGORIES.has('oral-drug-claim'));
  });
});

describe('dental conditions follow the existing surface rule', () => {
  test('an ARTICLE may name cavities or gum disease', () => {
    for (const t of ['Best Natural Toothpaste for Cavity-Prone Teeth', 'What Causes Gum Disease?', 'Fluoride-Free Toothpaste and Tooth Decay: What to Know']) {
      assert.equal(checkSeoCopy({ title: t }, EDITORIAL).ok, true, t);
    }
  });

  test('claiming to fix one blocks even editorially', () => {
    for (const t of ['Toothpaste That Prevents Cavities', 'Fights Gum Disease Naturally', 'Stops Tooth Decay']) {
      assert.ok(blocks({ title: t }, EDITORIAL), t);
    }
  });

  test('PRODUCT copy may not name them at all', () => {
    assert.ok(blocks({ meta: 'A gentle coconut oil toothpaste for cavity-prone teeth.' }));
    assert.ok(blocks({ meta: 'Soothing for inflamed gums.' }));
  });
});

describe('child safety: commercial blocks, an editorial QUESTION does not', () => {
  test('a category question an article ranks for stays writable', () => {
    for (const t of ['Is Natural Deodorant Safe for Kids?', 'Kid-Safe Deodorant: What Parents Should Know']) {
      const r = checkSeoCopy({ title: t }, EDITORIAL);
      assert.equal(r.ok, true, t);
      assert.equal(r.advisory[0].category, CHILD_SAFETY_MENTIONED_CATEGORY, 'still reported');
    }
    assert.ok(ADVISORY_CATEGORIES.has(CHILD_SAFETY_MENTIONED_CATEGORY));
  });

  test('the same words beside the brand block editorially', () => {
    assert.ok(blocks({ meta: "Real Skin Care's formula is safe for kids." }, EDITORIAL));
    assert.ok(blocks({ meta: 'Our toothpaste is safe to swallow.' }, EDITORIAL));
  });

  test('product copy blocks every spelling', () => {
    for (const t of ['Safe for kids and adults.', 'Safe if swallowed.', 'A child-safe formula.', 'Safer for toddlers.']) {
      assert.ok(blocks({ meta: t }), t);
    }
  });

  test('the replacement wording passes on BOTH surfaces', () => {
    const t = 'Ask your pediatric dentist which toothpaste suits your child, and supervise young kids while they brush.';
    assert.equal(checkSeoCopy({ meta: t }).ok, true);
    assert.equal(checkSeoCopy({ meta: t }, EDITORIAL).ok, true);
  });

  test('child safety is NOT in the shared ad/persona vocabulary — measured collateral', () => {
    // personas.json carries "kid-safe hand soap" in a persona SUMMARY; sanitizePersonas
    // drops a whole persona on a summary hit. See the gate header.
    assert.equal(hasHealthClaim('kid-safe hand soap'), false);
    assert.equal(hasHealthClaim('Is this actually safe for kids?'), false);
  });
});

describe('ordinary cosmetic toothpaste language is untouched', () => {
  for (const t of [
    'Gentle on enamel, with a baking soda polish',
    'Baking soda is softer than enamel',
    'Neutralizes oral acid and freshens breath',
    'Polishes away surface stains',
    'A fluoride-free, SLS-free gel for sensitive mouths',
  ]) {
    test(`"${t}"`, () => {
      assert.equal(checkSeoCopy({ meta: t }).ok, true, 'commercial');
      assert.equal(hasHealthClaim(t), false, 'ad gate');
    });
  }
});

describe('the gate may never refuse its own remediation', () => {
  test('every AFTER in the 2026-09-12 toothpaste plan still passes the editorial gate', () => {
    for (const e of PLAN) {
      const r = checkSeoCopyFields({ [e.surface]: e.after }, EDITORIAL);
      assert.equal(r.ok, true, `${e.id}: ${JSON.stringify(r.blocking)}`);
    }
  });
});

describe('the prompts carry the rule, in both directions', () => {
  test('the first-generation rule includes it', () => {
    assert.ok(SEO_COPY_COMPLIANCE_RULE.includes(ORAL_CARE_COMPLIANCE_RULE));
    assert.match(ORAL_CARE_COMPLIANCE_RULE, /MAY explain what fluoride or hydroxyapatite does/);
    assert.match(ORAL_CARE_COMPLIANCE_RULE, /ask a pediatric dentist/);
  });

  test('the retry names the replacement wording for an oral or child-safety miss', () => {
    for (const title of ['Strengthens Enamel Naturally', 'Safe for kids and adults']) {
      const r = checkSeoCopy({ title });
      assert.ok(seoCopyConstraint(r.blocking).includes(ORAL_CARE_COMPLIANCE_RULE), title);
    }
    // …and does not bolt it onto an unrelated miss.
    const heal = checkSeoCopy({ title: 'Soap That Heals Tattoos' });
    assert.ok(!seoCopyConstraint(heal.blocking).includes(ORAL_CARE_COMPLIANCE_RULE));
  });
});
