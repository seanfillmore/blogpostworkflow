import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUBSCRIPTION_COPY, fileName, DETACH } from '../../scripts/remove-lotion-subscription-frames-2026-10-06.mjs';

const ROOT = join(import.meta.dirname, '..', '..');

test('the lotion ingredients frame no longer sells a subscription', () => {
  // Lotion sells no new subscriptions since 2026-10-05.
  const src = readFileSync(join(ROOT, 'data/brand/frames/coconut-lotion/ingredients-frame.mjs'), 'utf8');
  assert.doesNotMatch(src.replace(/^\s*\/\/.*$/gm, ''), /Subscribe/);
  const prov = JSON.parse(readFileSync(join(ROOT, 'data/brand/pdp-frames/coconut-lotion/coconut-lotion-ingredients-pdp.provenance.json'), 'utf8'));
  assert.doesNotMatch(prov.alt, SUBSCRIPTION_COPY);
  // The refund guarantee is a real policy and stays.
  assert.match(prov.alt, /30 days with a full refund/);
});

test('the cleanup detaches exactly the two subscription frames', () => {
  assert.deepEqual(DETACH, ['clean-offer.jpg', 'coconut-lotion-ingredients-pdp.jpg']);
  assert.equal(fileName('https://cdn.shopify.com/s/files/1/x/files/clean-offer.jpg?v=12'), 'clean-offer.jpg');
});
