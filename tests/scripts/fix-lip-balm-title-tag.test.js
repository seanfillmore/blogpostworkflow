import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TITLE_TAG, gateAfter, decide } from '../../scripts/fix-lip-balm-title-tag-2026-10-05.mjs';
import { renderTitle } from '../../lib/seo-copy-length.js';

test('new title clears the claim and length gates', () => {
  assert.doesNotThrow(() => gateAfter());
  assert.ok(renderTitle(TITLE_TAG.after).length <= 60);
});

test('beeswax is a real lip balm ingredient', () => {
  const ing = JSON.parse(readFileSync(new URL('../../config/ingredients.json', import.meta.url)));
  assert.ok(ing.lip_balm.base_ingredients.some((i) => /beeswax/i.test(i)));
});

test('decide refuses a live value it did not expect', () => {
  assert.equal(decide(TITLE_TAG.before), 'apply');
  assert.equal(decide(TITLE_TAG.after), 'already-applied');
  assert.equal(decide('Something else'), 'refuse');
  assert.equal(decide(null), 'refuse');
});
