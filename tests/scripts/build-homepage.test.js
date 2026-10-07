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
  const parsed = { order: ['hero-overrides', 'hero', 'product-intro', 'product-line', 'thesis', 'exclusion-grid', 'featured-testimonial', 'founder-anchor', 'founder'],
    sections: { 'hero-overrides': {}, hero: {}, 'product-intro': {}, 'product-line': {}, thesis: { blocks: { 'thesis-body': { settings: {} } } }, 'exclusion-grid': {}, 'featured-testimonial': {}, 'founder-anchor': {}, founder: { blocks: { 'founder-body': { settings: {} } } }, 'closing-cta': {} } };
  parsed.order.push('closing-cta');
  transform(parsed, cfg, roster);
  assert.ok(parsed.order.includes('set-offer'));
  assert.equal(parsed.sections['hero-split'].type, 'home-hero-split');
  assert.equal(parsed.sections['hero-split'].block_order.length, cfg.hero.bullets.length);
  // Idempotent: a second pass refreshes rather than throwing.
  assert.doesNotThrow(() => transform(parsed, cfg, roster));
});

test('the UGC strip always carries the disclosure and only Shopify-hosted videos', async () => {
  const { renderUgc } = await import('../../scripts/build-homepage.mjs');
  const out = renderUgc(cfg.ugc);
  assert.match(out, /Creators received free product and may earn a commission\./);
  assert.equal((out.match(/class="ugc__video"/g) || []).length, cfg.ugc.videos.length);
  assert.match(out, /preload="none"/);
  assert.throws(() => renderUgc({ ...cfg.ugc, disclosure: '' }), /disclosure/);
  assert.throws(() => renderUgc({ ...cfg.ugc, videos: [{ ...cfg.ugc.videos[0], src: 'https://example.com/x.mp4' }] }), /Shopify CDN/);
});

test('excluded Trybe videos stay out of the strip', () => {
  const ids = cfg.ugc.videos.map((v) => v.trybe_id);
  for (const bad of ['099e1e5d', '89268673', '37fbdc30']) assert.ok(!ids.some((i) => i.includes(bad)), bad);
});

test('transform places the UGC strip before the founder anchor and bands both rich-text sections', () => {
  const parsed = { order: ['hero', 'product-intro', 'product-line', 'thesis', 'exclusion-grid', 'featured-testimonial', 'founder-anchor', 'founder'],
    sections: { hero: {}, 'product-intro': {}, 'product-line': {}, thesis: { blocks: { 'thesis-body': { settings: {} } } }, 'exclusion-grid': {}, 'featured-testimonial': {}, 'founder-anchor': {}, founder: { blocks: { 'founder-body': { settings: {} } } }, 'closing-cta': {} } };
  parsed.order.push('closing-cta');
  transform(parsed, cfg, roster);
  assert.equal(parsed.order[parsed.order.indexOf('founder-anchor') - 1], 'ugc-strip');
  for (const s of ['product-intro', 'thesis']) assert.ok(parsed.sections[s].block_order.includes('band-style'), s);
});

test('UGC cards carry no creator name or shop link (Sean, 2026-10-06)', async () => {
  const { renderUgc } = await import('../../scripts/build-homepage.mjs');
  const out = renderUgc(cfg.ugc);
  assert.doesNotMatch(out, /ugc__cap|ugc__shop|Shop →/);
  for (const v of cfg.ugc.videos) assert.ok(!out.includes(`>${v.creator} ·`), v.creator);
});

test('the set offer bakes no price and adds the live variant', async () => {
  const { renderSetOffer } = await import('../../scripts/build-homepage.mjs');
  const out = renderSetOffer(cfg.set_offer);
  assert.doesNotMatch(out, /\$\d/);
  assert.match(out, /data-variant="\{\{ sv\.id \}\}"/);
  assert.match(out, /sv\.compare_at_price \| minus: sv\.price \| money/);
  assert.equal((out.match(/<li>/g) || []).length, cfg.set_offer.bullets.length);
});

test('the set offer is pinned directly after the exclusion grid', () => {
  const parsed = { order: ['hero', 'product-intro', 'product-line', 'thesis', 'exclusion-grid', 'featured-testimonial', 'founder-anchor', 'founder', 'closing-cta'],
    sections: { hero: {}, 'product-intro': {}, 'product-line': {}, thesis: { blocks: { 'thesis-body': { settings: {} } } }, 'exclusion-grid': {}, 'featured-testimonial': {}, 'founder-anchor': {}, founder: { blocks: { 'founder-body': { settings: {} } } }, 'closing-cta': {} } };
  transform(parsed, cfg, roster);
  assert.equal(parsed.order[parsed.order.indexOf('exclusion-grid') + 1], 'set-offer');
});

test('founder: no em dashes in the live copy override, and its custom_css is one scoped rule per entry', () => {
  const cfg = loadConfig();
  const o = cfg.text_overrides.find((x) => x.section === 'founder' && x.block === 'founder-body');
  assert.ok(o, 'founder-body override present');
  assert.ok(!o.value.includes('—'), 'no em dash');
  const sc = cfg.section_css.find((x) => x.section === 'founder');
  assert.ok(Array.isArray(sc.css) && sc.css.every((r) => (r.match(/\{/g) || []).length === 1), 'one rule per entry');
});
