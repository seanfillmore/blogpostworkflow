/**
 * Pure-logic tests for the 3-second-test listing audit.
 *
 * The qualifier fixtures are REAL customer search terms from the 2026-08-03 →
 * 2026-09-01 Sponsored Products search-term report, because both bugs these tests pin
 * were produced by real query phrasing and neither would have appeared in an invented
 * fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractQualifiers, surfaceConfirms, findsIngredientList, aplusText,
  MIN_QUALIFIER_CLICKS,
} from '../../scripts/amazon/listing-3-second-audit.mjs';

test('a qualifier is the noun before "free", not the shopper\'s whole phrasing', () => {
  // THE BUG THIS PINS: capturing two words turned one criterion into four —
  // "aluminum free", "deodorant aluminum free", "women aluminum free",
  // "womens aluminum free" — and since the listing confirms only the canonical form,
  // three of the four were counted as content gaps. Failure count went 8 → 41.
  for (const q of ['womens deodorant aluminum free', 'women aluminum free', 'aluminum free deodorant']) {
    assert.deepEqual(extractQualifiers(q).filter((x) => x.endsWith('free')), ['aluminum free'],
      `"${q}" should yield exactly one criterion`);
  }
});

test('exclusion, negation and standing criteria are all recognised', () => {
  assert.ok(extractQualifiers('fluoride-free toothpaste').includes('fluoride free'));
  assert.ok(extractQualifiers('deodorant without aluminum').includes('without aluminum'));
  assert.ok(extractQualifiers('unscented body lotion').includes('unscented'));
  assert.ok(extractQualifiers('organic natural lotion').includes('organic'));
});

test('the product noun is never treated as a criterion', () => {
  // "body free" / "lotion free" are not things a shopper is asking for.
  const q = extractQualifiers('body free lotion free skin free');
  assert.deepEqual(q.filter((x) => x.endsWith('free')), []);
});

test('an empty or junk term yields nothing rather than a phantom qualifier', () => {
  assert.deepEqual(extractQualifiers(''), []);
  assert.deepEqual(extractQualifiers('   '), []);
  assert.deepEqual(extractQualifiers('b09qjfbpj1'), []);
});

test('a surface confirms a criterion however the copy phrases it', () => {
  const bullets = 'ALUMINUM-FREE formula. Free of parabens. Contains no baking soda.';
  assert.ok(surfaceConfirms(bullets, 'aluminum free'), 'hyphenated');
  assert.ok(surfaceConfirms(bullets, 'paraben free'), '"free of X" confirms "X free"');
  assert.ok(surfaceConfirms(bullets, 'baking free'), '"no X" confirms "X free"');
  assert.equal(surfaceConfirms(bullets, 'fluoride free'), false, 'absent criteria stay absent');
});

test('surfaceConfirms is false on an empty surface, never throws', () => {
  assert.equal(surfaceConfirms('', 'aluminum free'), false);
  assert.equal(surfaceConfirms(null, 'aluminum free'), false);
  assert.equal(surfaceConfirms(undefined, 'organic'), false);
});

test('an ingredient LIST needs a label AND an enumeration, not the word "ingredients"', () => {
  // Marketing copy that merely says "ingredients" is not the verification detail a
  // sceptical buyer needs, which is the whole point of the tactic.
  assert.equal(findsIngredientList('Made with clean ingredients you can trust.').found, false);
  assert.equal(findsIngredientList('Only the best ingredients!').found, false);
  // A labelled enumeration is.
  const real = 'Ingredients: Cocos Nucifera Oil, Simmondsia Chinensis Seed Oil, '
    + 'Butyrospermum Parkii Butter, Tocopherol, Aloe Barbadensis Leaf Juice';
  const r = findsIngredientList(real);
  assert.equal(r.found, true);
  assert.ok(r.count >= 4);
});

test('a labelled list too short to be a real declaration is not counted', () => {
  const r = findsIngredientList('Ingredients: water, oil');
  assert.equal(r.found, false);
  assert.match(r.reason, /only \d+ item/);
});

test('aplusText flattens nested module text and tolerates a missing tree', () => {
  const doc = { contentDocument: { contentModuleList: [
    { standardText: { body: { value: 'Aluminum free formula' } } },
    { standardFourImageText: { block1: { body: { value: 'Made in the USA' } } } },
  ] } };
  const t = aplusText(doc);
  assert.match(t, /Aluminum free formula/);
  assert.match(t, /Made in the USA/);
  assert.equal(aplusText(null), '');
  assert.equal(aplusText({}), '');
});

test('the click floor is a real floor, not decoration', () => {
  assert.ok(MIN_QUALIFIER_CLICKS >= 3,
    'a 1-click term is one shopper\'s phrasing and must not be reported as a content gap');
});

test('an absent qualifier the PRODUCT contradicts is a negation, not a content gap', async () => {
  const { contradictsProduct } = await import('../../scripts/amazon/listing-3-second-audit.mjs');
  // The real case: "unscented" searches reached the COCONUT BREEZE lotion through a
  // shared ad group. Writing "unscented" on it would be a false claim, so the fix is
  // a negative keyword. Reporting it as a listing gap sends the operator to lie.
  assert.equal(contradictsProduct('unscented', { scent: 'Coconut Breeze' }),
    'product scent is "Coconut Breeze"');
  // The sibling variant genuinely IS unscented — that one is a real content gap.
  assert.equal(contradictsProduct('unscented', { scent: 'Unscented' }), null);
  // Only PROVABLE contradictions are asserted; anything else stays a gap for a human.
  assert.equal(contradictsProduct('aluminum free', { scent: 'Coconut Breeze' }), null);
  assert.equal(contradictsProduct('unscented', {}), null, 'no attribute = no claim either way');
  assert.equal(contradictsProduct('unscented', null), null);
});
