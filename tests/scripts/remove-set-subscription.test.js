import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripSubscriptionCopy, NEW_COPY } from '../../scripts/remove-set-subscription-2026-10-07.mjs';
import { bulletProblems } from '../../scripts/apply-pdp-outcome-bullets.mjs';

const tpl = () => JSON.parse(readFileSync('theme/templates/product.landing-page-sensitive-skin-set-lander.json', 'utf8'));

test('every place the set page sold a subscription is removed', () => {
  const t = tpl();
  const notes = stripSubscriptionCopy(t);
  assert.equal(notes.length, 4);
  assert.equal(t.sections.hero.blocks['guarantee-1'].settings.text, 'Free shipping');
  assert.ok(!t.sections.main.block_order.includes('bonus-banner'));
  assert.doesNotMatch(JSON.stringify(t.sections.main.blocks['tab-details']), /First-subscription bonus/);
  // idempotent
  assert.deepEqual(stripSubscriptionCopy(t), []);
});

test('the replacement copy passes the claim gates', () => {
  assert.deepEqual(bulletProblems(NEW_COPY.heroBadge), []);
  assert.deepEqual(bulletProblems(NEW_COPY.finalStrip.replace(/<[^>]+>/g, '')), []);
});
