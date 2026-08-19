// tests/lib/search-intent.test.js
//
// lib/search-intent.js was extracted from `detectPostType` in
// agents/blog-post-writer/index.js on 2026-08-18 so agents/bing-keyword-gap could ask
// the same question without importing the writer (which would run it).
//
// These cases are the regression for that extraction: the writer's CTA weighting keys
// on the three return values, so a drift here silently changes what every published
// post says. The last block pins the KNOWN hole the Bing corpus exposed, so that if
// somebody later closes it they do so deliberately.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { classifySearchIntent, isCommercialIntent } from '../../lib/search-intent.js';

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

test('KNOWN HOLE: soap-making supply wording reads as product, not diy', () => {
  // These are people sourcing base oils and lye, not buying finished soap. The DIY
  // patterns key on 'how to make' / 'recipe' / 'diy' and none of those appear, so the
  // taxonomy files them as buying intent. Documented in the bing-keyword-gap report
  // rather than patched, because changing it changes agents/blog-post-writer's CTA
  // weighting. If you close this hole, flip these assertions deliberately.
  assert.equal(classifySearchIntent('coconut oil soap base'), 'product');
  assert.equal(classifySearchIntent('coconut oil for soap making'), 'product');
  assert.equal(classifySearchIntent('cold process ginger juice soap percentage'), 'product');
});
