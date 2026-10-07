import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, gateFailures, renderGrid, renderReviews, transform } from '../../scripts/build-homepage.mjs';
import { loadRoster } from '../../lib/bundle-roster.js';

const cfg = loadConfig();
const roster = loadRoster();

test('every homepage line passes every claim gate', () => {
  assert.deepEqual(gateFailures(cfg), []);
});

test('the grid bakes no price: prices, offers and ratings resolve in Liquid', () => {
  const out = renderGrid(cfg.grid);
  assert.doesNotMatch(out, /\$\d/);
  assert.match(out, /p\.price \| money_without_trailing_zeros/);
  assert.match(out, /metafields\.reviews\.rating/);
});

test('every grid pack is a configured ladder tier', () => {
  for (const c of cfg.grid) {
    const l = roster.ladders.find((x) => x.base === c.base);
    assert.ok(l, `${c.base} has a ladder`);
    assert.ok(l.tiers.includes(c.pack), `${c.pack} is a tier of ${c.base}`);
  }
});

test('the review strip only quotes approved, gated ladder reviews and links on-site', () => {
  const out = renderReviews(cfg, roster);
  assert.equal((out.match(/class="hrs__card"/g) || []).length, 3);
  assert.doesNotMatch(out, /judge\.me\/reviews/);
});

test('transform swaps the three sections in place and drops the old hero CSS', () => {
  const parsed = { order: ['hero-overrides', 'hero', 'product-intro', 'product-line', 'featured-testimonial', 'founder'],
    sections: { 'hero-overrides': {}, hero: {}, 'product-intro': {}, 'product-line': {}, 'featured-testimonial': {}, founder: {} } };
  transform(parsed, cfg, roster);
  assert.deepEqual(parsed.order, ['hero-split', 'product-intro', 'product-grid', 'review-strip', 'founder']);
  assert.equal(parsed.sections['hero-split'].type, 'home-hero-split');
  assert.equal(parsed.sections['hero-split'].block_order.length, cfg.hero.bullets.length);
  // Idempotent: a second pass refreshes rather than throwing.
  assert.doesNotThrow(() => transform(parsed, cfg, roster));
});
