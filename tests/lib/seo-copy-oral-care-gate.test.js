/**
 * Oral-care claims in the copy gates (2026-09-13, narrowed the same day by operator ruling).
 *
 * Toothpaste orders started arriving through blog posts, and the copy beside those buy
 * boxes said "Support natural remineralization with Real Skin Care's…". Nothing caught it.
 * The first version of the fix also blocked NAMING (dental conditions, the noun
 * "remineralization") and "safe for kids", and the operator overruled both. These tests pin
 * the line as ruled: naming a condition or a mechanism passes on every surface, "safe for
 * kids" is not a claim at all, and only a toothpaste preventing, fighting or treating a
 * dental condition, repairing enamel or supporting remineralization blocks.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import * as gate from '../../lib/seo-copy-health-gate.js';
import { hasHealthClaim } from '../../agents/ad-studio/health-claims.js';
import { PLAN } from '../../scripts/remediate-toothpaste-safety-claims.mjs';

const {
  checkSeoCopy,
  checkSeoCopyFields,
  seoCopyConstraint,
  BLOCKING_CATEGORIES,
  ORAL_CARE_COMPLIANCE_RULE,
  SEO_COPY_COMPLIANCE_RULE,
  EDITORIAL_SURFACE,
} = gate;

const EDITORIAL = { surface: EDITORIAL_SURFACE };
const blocks = (copy, opts) => checkSeoCopy(copy, opts).ok === false;

/** Commercial is the strict default, and hasHealthClaim is what ads, the PDP builder and personas use. */
function passesEverywhere(t) {
  assert.equal(checkSeoCopy({ meta: t }).ok, true, `commercial: ${t}`);
  assert.equal(checkSeoCopy({ meta: t }, EDITORIAL).ok, true, `editorial: ${t}`);
  assert.equal(hasHealthClaim(t), false, `shared vocabulary: ${t}`);
}

describe('operator ruling 2026-09-13: naming is not claiming', () => {
  test('the brand-foundation statements Sean ruled on pass on every surface', () => {
    for (const t of [
      'Sodium bicarbonate neutralizes the acidic oral environment that cavity-causing bacteria need to thrive.',
      'Particularly soothing for inflamed gum tissue — useful for customers with gingivitis.',
      'Glycerin and sorbitol coat your teeth and may interfere with natural remineralization.',
      'Non-cariogenic — does not feed the bacteria responsible for tooth decay the way sucrose does.',
    ]) passesEverywhere(t);
  });

  test('articles and product copy may name dental conditions and mechanisms', () => {
    for (const t of [
      'Best Natural Toothpaste for Cavity-Prone Teeth',
      'What Causes Gum Disease?',
      'Fluoride-Free Toothpaste and Tooth Decay: What to Know',
      'A gentle coconut oil toothpaste for sensitive gums.',
      "Fluoride's role in remineralization, explained.",
      'Hydroxyapatite is a marketing-friendly remineralizer we leave out.',
    ]) passesEverywhere(t);
  });

  test('"safe for kids" is not a claim: every RSC product is', () => {
    for (const t of [
      "Real Skin Care's formula is safe for kids.",
      'Safe for kids and adults.',
      'Is this soap safe for kids and frequent use? Yes.',
      'A kid-safe hand soap the whole family can use.',
    ]) passesEverywhere(t);
    assert.deepEqual(Object.keys(gate).filter((k) => /CHILD_SAFETY/.test(k)), [], 'no child-safety rule may come back');
  });
});

describe('claiming a toothpaste fixes teeth still blocks on every surface', () => {
  for (const t of [
    "Support natural remineralization with Real Skin Care's All Natural Coconut Oil Toothpaste.",
    'Toothpaste That Remineralizes Enamel',
    'Rebuilds Tooth Enamel Naturally',
    'Strengthens Enamel Without Fluoride',
    'Anti-Cavity Coconut Oil Toothpaste',
    'Cavity Protection Without Fluoride',
    'Protects Against Tooth Decay',
    'Fights Gum Disease Naturally',
    'Stops Tooth Decay',
    'Toothpaste That Prevents Cavities',
    'Helps with cavities and sensitive gums',
  ]) {
    test(`"${t}"`, () => {
      assert.ok(blocks({ title: t }, EDITORIAL), 'editorial');
      assert.ok(blocks({ title: t }), 'commercial');
      assert.ok(hasHealthClaim(t), 'and the shared vocabulary');
    });
  }

  test('`oral-drug-claim` is a blocking category', () => {
    assert.ok(BLOCKING_CATEGORIES.has('oral-drug-claim'));
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
    test(`"${t}"`, () => passesEverywhere(t));
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
  test('the first-generation rule includes it, permits naming, and says nothing about kids', () => {
    assert.ok(SEO_COPY_COMPLIANCE_RULE.includes(ORAL_CARE_COMPLIANCE_RULE));
    assert.match(ORAL_CARE_COMPLIANCE_RULE, /MAY name cavities/);
    assert.doesNotMatch(ORAL_CARE_COMPLIANCE_RULE, /kids|children|pediatric|swallow/i);
  });

  test('the retry carries the rule for an oral claim, and not for an unrelated miss', () => {
    const r = checkSeoCopy({ title: 'Strengthens Enamel Naturally' });
    assert.ok(seoCopyConstraint(r.blocking).includes(ORAL_CARE_COMPLIANCE_RULE));
    const heal = checkSeoCopy({ title: 'Soap That Heals Tattoos' });
    assert.ok(!seoCopyConstraint(heal.blocking).includes(ORAL_CARE_COMPLIANCE_RULE));
  });
});
