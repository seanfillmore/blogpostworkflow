import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripSubscriptionCopy, NEW_COPY } from '../../scripts/remove-set-subscription-2026-10-07.mjs';
import { bulletProblems } from '../../scripts/apply-pdp-outcome-bullets.mjs';

const tpl = () => JSON.parse(readFileSync('theme/templates/product.landing-page-sensitive-skin-set-lander.json', 'utf8'));

/**
 * The four subscription spots exactly as the template carried them before the
 * 2026-10-07 removal (from `git show eb85ee94^:theme/templates/...`), trimmed to
 * the blocks the function touches. The test used to run on the COMMITTED template,
 * but that commit already stored the cleaned version, so it failed from the day it
 * was written: there was nothing left to strip.
 */
const beforeRemoval = () => ({
  sections: {
    hero: { blocks: { 'guarantee-1': { settings: { text: 'Free shipping on subscription' } } } },
    main: {
      block_order: ['title', 'bonus-banner', 'tab-details'],
      blocks: {
        title: { settings: {} },
        'bonus-banner': { type: 'custom_liquid', settings: { custom_liquid: '<div>🎁 First subscription order includes:</div>' } },
        'tab-details': { settings: { content: '<p>Two products.</p><p><strong>First-subscription bonus.</strong> Subscribe and your first order ships with a free Pure Unscented Lip Balm and a free Unscented Bar Soap.</p>' } },
      },
    },
    'final-cta-strip': { blocks: { 'fc-text': { settings: { text: '<p>Your first subscription order ships with a free Pure Unscented Lip Balm and a free Unscented Bar Soap.</p>' } } } },
  },
});

test('every place the set page sold a subscription is removed', () => {
  const t = beforeRemoval();
  const notes = stripSubscriptionCopy(t);
  assert.equal(notes.length, 4);
  assert.equal(t.sections.hero.blocks['guarantee-1'].settings.text, 'Free shipping');
  assert.ok(!t.sections.main.block_order.includes('bonus-banner'));
  assert.ok(!('bonus-banner' in t.sections.main.blocks));
  assert.doesNotMatch(JSON.stringify(t.sections.main.blocks['tab-details']), /First-subscription bonus/);
  assert.match(t.sections.main.blocks['tab-details'].settings.content, /Two products/, 'only the bonus paragraph goes');
  assert.equal(t.sections['final-cta-strip'].blocks['fc-text'].settings.text, NEW_COPY.finalStrip);
  // idempotent
  assert.deepEqual(stripSubscriptionCopy(t), []);
});

test('the committed set template no longer sells a subscription', () => {
  // A regression check on the real file: a theme sync that brought the offer back
  // would make this return edits again.
  assert.deepEqual(stripSubscriptionCopy(tpl()), []);
});

test('the replacement copy passes the claim gates', () => {
  assert.deepEqual(bulletProblems(NEW_COPY.heroBadge), []);
  assert.deepEqual(bulletProblems(NEW_COPY.finalStrip.replace(/<[^>]+>/g, '')), []);
});
