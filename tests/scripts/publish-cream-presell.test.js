import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardVerdict, FILES, PAGE } from '../../scripts/presell/publish-cream-presell.mjs';

test('new file: absent → write, equal → already, anything else → refuse', () => {
  assert.equal(guardVerdict({ current: undefined, before: null, target: 'N' }), 'write');
  assert.equal(guardVerdict({ current: 'N', before: null, target: 'N' }), 'already');
  assert.equal(guardVerdict({ current: 'X', before: null, target: 'N' }), 'refuse');
});

test('existing file: only the known before (or the new content) may be overwritten', () => {
  assert.equal(guardVerdict({ current: 'B', before: 'B', target: 'N' }), 'write');
  assert.equal(guardVerdict({ current: 'N', before: 'B', target: 'N' }), 'already');
  assert.equal(guardVerdict({ current: 'B2', before: 'B', target: 'N' }), 'refuse');
  assert.equal(guardVerdict({ current: undefined, before: 'B', target: 'N' }), 'refuse');
});

test('ships exactly the five files and the noindex page', () => {
  assert.deepEqual(FILES.map((f) => f.key).sort(), [
    'assets/presell-buy.js', 'assets/presell.css', 'sections/presell-listicle.liquid',
    'templates/page.presell-cream.json', 'templates/product.landing-page-cream.json',
  ]);
  assert.equal(FILES.filter((f) => f.before).length, 1);
  assert.equal(PAGE.template_suffix, 'presell-cream');
  assert.equal(PAGE.handle, 'coconut-body-cream');
});
