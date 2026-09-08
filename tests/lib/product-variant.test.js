// tests/lib/product-variant.test.js
//
// Built from the REAL config/ingredients.json `lotion` entry, because the whole
// defect was a mismatch between that file's structure and how the editor read it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveVariant, variantIngredients } from '../../lib/product-variant.js';
import { ROOT } from '../../lib/posts.js';

const LOTION = JSON.parse(
  readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'),
).lotion;

test('the real config still has the shape this module depends on', () => {
  // If this fails the fixture below is fiction, and so is every assertion under it.
  assert.equal(LOTION.base_ingredients.length, 6, 'the 6-ingredient base is the product name');
  const unscented = LOTION.variations.find((v) => v.id === 'pure-unscented');
  assert.deepEqual(unscented.essential_oils, [], 'Pure Unscented carries no oils');
  assert.ok(LOTION.variations.length >= 5);
  assert.ok(LOTION.variations.some((v) => (v.essential_oils || []).length > 0),
    'at least one scented variant, or there is nothing to scope away');
});

test('THE REGRESSION: an unscented post is not charged with the scented oils', () => {
  // This is the exact input that blocked the post twice: once on 2026-09-06 and
  // again on 2026-09-08 after a correct redraft.
  const { ingredients, variant, scoped } = variantIngredients(
    LOTION, 'best unscented lotion best-unscented-lotion',
  );
  assert.equal(scoped, true);
  assert.equal(variant.id, 'pure-unscented');
  assert.equal(ingredients.length, 6, 'exactly the base — no oils');
  assert.ok(!ingredients.some((i) => /ylang|chamomile|geranium|lavender|rose/i.test(i)),
    'no scented variant oil may appear in an unscented post’s comparison list');
});

test('a scented post still gets its own oils, so the check keeps working', () => {
  // Scoping must not become a way to launder a real contradiction: a post about
  // Calming Lavender IS checked against lavender.
  const { ingredients, variant } = variantIngredients(LOTION, 'calming lavender lotion');
  assert.equal(variant.id, 'calming-lavender');
  assert.ok(ingredients.some((i) => /lavender/i.test(i)));
  // …but not against ANOTHER variant's oils.
  assert.ok(!ingredients.some((i) => /geranium|ylang/i.test(i)));
});

test('longest keyword wins — "lavender rose" is not Calming Lavender', () => {
  // Both variants match on "lavender". First-match would resolve the wrong one
  // and then fault the post for correctly naming rose.
  const v = resolveVariant(LOTION, 'best lavender rose body lotion');
  assert.equal(v.id, 'lavender-and-rose');
});

test('UNMATCHED falls back to the union — the pre-existing behaviour, unchanged', () => {
  // A general post could be about any variant; narrowing on a guess would invent
  // a scope the post never claimed.
  const { ingredients, variant, scoped } = variantIngredients(LOTION, 'best body lotion');
  assert.equal(variant, null);
  assert.equal(scoped, false);
  assert.ok(ingredients.length > 6, 'the union still includes every variant oil');
});

test('scoping can only ever REMOVE ingredients, never add one', () => {
  // The safety property that makes this change one-directional: it can turn a
  // false blocker into a pass and can never manufacture a new blocker.
  const union = variantIngredients(LOTION, 'best body lotion').ingredients;
  for (const text of ['unscented lotion', 'rose petal lotion', 'coconut breeze lotion']) {
    const scoped = variantIngredients(LOTION, text).ingredients;
    assert.ok(scoped.length <= union.length, `${text} widened the list`);
    for (const i of scoped) assert.ok(union.includes(i), `${text} invented "${i}"`);
  }
});

test('degenerate inputs never throw and never claim a scope', () => {
  for (const bad of [null, undefined, {}, { variations: [] }, { variations: null }]) {
    assert.equal(resolveVariant(bad, 'unscented'), null);
    assert.doesNotThrow(() => variantIngredients(bad, 'unscented'));
  }
  assert.equal(resolveVariant(LOTION, ''), null, 'empty text resolves nothing');
  assert.equal(resolveVariant(LOTION, null), null);
  // A product with no variations at all behaves exactly as before.
  const soapish = { base_ingredients: ['a', 'b'] };
  assert.deepEqual(variantIngredients(soapish, 'anything').ingredients, ['a', 'b']);
});

test('matching is on word boundaries, not substrings', () => {
  // "pure" must not be matched out of the middle of another word, or an
  // unrelated post silently acquires a variant scope.
  assert.equal(resolveVariant(LOTION, 'impurities in lotion'), null);
});
