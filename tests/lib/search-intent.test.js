// tests/lib/search-intent.test.js
//
// lib/search-intent.js was extracted from `detectPostType` in
// agents/blog-post-writer/index.js on 2026-08-18 so agents/bing-keyword-gap could ask
// the same question without importing the writer (which would run it).
//
// These cases are the regression for that extraction: the writer's CTA weighting keys
// on the return values, so a drift here silently changes what every published post says.
//
// 2026-08-18: the last block used to PIN the known hole — soap-making supply queries
// classified as `product`, i.e. as buyers — with a note saying that whoever closed it
// should flip these assertions deliberately. That is what happened. The block below is
// the same three queries, now asserting `supply` and asserting they are NOT commercial,
// so the closed hole cannot silently reopen.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { classifySearchIntent, isCommercialIntent, SEARCH_INTENT_TYPES } from '../../lib/search-intent.js';

test('DIY wording classifies as diy, and beats the informational patterns', () => {
  for (const q of [
    'how to make natural deodorant',
    'coconut oil soap recipe',
    'diy body butter',
    'homemade toothpaste',
    'natural moisturizer at home',
    'step-by-step lip balm tutorial',
  ]) {
    assert.equal(classifySearchIntent(q), 'diy', q);
  }
  // 'what is' would be informational on its own; 'recipe' is checked first.
  assert.equal(classifySearchIntent('what is a castile soap recipe'), 'diy');
});

test('question and concept wording classifies as informational', () => {
  for (const q of [
    'why does natural deodorant stop working',
    'what is castile soap',
    'when was deodorant invented',
    'benefits of coconut oil',
    'how does fluoride work',
  ]) {
    assert.equal(classifySearchIntent(q), 'informational', q);
  }
});

test('everything else is product — the buying bucket', () => {
  for (const q of [
    'best natural deodorant',
    'sls free toothpaste',
    'dr bronner alternative',
    'coconut oil body lotion for dry skin',
  ]) {
    assert.equal(classifySearchIntent(q), 'product', q);
    assert.equal(isCommercialIntent(q), true, q);
  }
  assert.equal(isCommercialIntent('how to make soap'), false);
  assert.equal(isCommercialIntent('what is castile soap'), false);
});

test('empty and nullish input does not throw and defaults to product', () => {
  assert.equal(classifySearchIntent(''), 'product');
  assert.equal(classifySearchIntent(null), 'product');
  assert.equal(classifySearchIntent(undefined), 'product');
});

test('CLOSED HOLE (was pinned as product): soap-making supply wording reads as supply', () => {
  // These three are the exact queries the previous version of this file pinned as
  // `product`. They are people sourcing base oils and lye, not buying finished soap, and
  // they now classify as `supply` — non-commercial, and no buy-CTA weighting in the
  // writer. The pin is kept rather than deleted so the hole cannot silently reopen.
  assert.equal(classifySearchIntent('coconut oil soap base'), 'supply');
  assert.equal(classifySearchIntent('coconut oil for soap making'), 'supply');
  assert.equal(classifySearchIntent('cold process ginger juice soap percentage'), 'supply');
  for (const q of ['coconut oil soap base', 'coconut oil for soap making', 'cold process ginger juice soap percentage']) {
    assert.equal(isCommercialIntent(q), false, q);
  }
});

test('supply covers the raw-material and maker-process vocabulary from the Bing feed', () => {
  for (const q of [
    'coconut oil soap base',
    'cold process soap',
    'soap base for melt and pour',
    'lye calculator',
    'base oils for soap making',
    'what percentage of coconut oil should there be in a cold process ginger juice soap',
    'sodium hydroxide for soap',
    'soap making supplies',
    'melt-and-pour soap base',
    'superfatting soap',
  ]) {
    assert.equal(classifySearchIntent(q), 'supply', q);
    assert.equal(isCommercialIntent(q), false, q);
  }
});

test('supply is checked before diy, so a maker-process query is not a shortcut-CTA post', () => {
  // Both signals fire on this one. The supply reading wins because the reader is after a
  // raw material we do not stock, so 'prefer a shortcut? buy the finished bar' is not a
  // real alternative for them — where it IS one for a plain DIY reader.
  assert.equal(classifySearchIntent('cold process soap recipe'), 'supply');
  assert.equal(classifySearchIntent('how to make melt and pour soap'), 'supply');
  // A DIY query with no raw-material vocabulary is untouched by the new bucket.
  assert.equal(classifySearchIntent('coconut oil soap recipe'), 'diy');
  assert.equal(classifySearchIntent('how to make natural deodorant'), 'diy');
});

test('true buyer queries did NOT regress out of product when supply was added', () => {
  // The regression guard for the fix itself: the supply patterns must key on material
  // and process words, never on the category nouns our own PDPs and collections target.
  for (const q of [
    'coconut oil soap',
    'natural bar soap for men',
    'best coconut oil deodorant',
    'non toxic body lotion',
    'coconut bar soap',
    'foaming hand soap',
    'best soap for tattoos',
    'sls free toothpaste',
    'shea butter body cream',
    'castile soap for sensitive skin',
    'lip balm tin',
  ]) {
    assert.equal(classifySearchIntent(q), 'product', q);
    assert.equal(isCommercialIntent(q), true, q);
  }
});

test('SEARCH_INTENT_TYPES lists every value the classifier can return', () => {
  // Consumers branch on this list; a type missing from it is a type a consumer will not
  // have handled. Checked against actual classifier output, not against itself.
  const observed = new Set([
    classifySearchIntent('coconut oil soap base'),
    classifySearchIntent('how to make natural deodorant'),
    classifySearchIntent('what is castile soap'),
    classifySearchIntent('best natural deodorant'),
  ]);
  assert.deepEqual([...observed].sort(), [...SEARCH_INTENT_TYPES].sort());
});
