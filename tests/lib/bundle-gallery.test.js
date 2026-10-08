import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  BUNDLES, PRODUCT, kitUnits, sceneUnitsOf, composition, productCount, offerCopy, scopeSuffix,
  heroPrompt, judgeBundle, label,
} from '../../lib/bundle-gallery.js';
import { UNIT } from '../../lib/ladder-gallery.js';

const { bundles } = JSON.parse(readFileSync(new URL('../../config/bundles.json', import.meta.url)));
const kit = (h, v) => bundles.find((b) => b.handle === h).variants.find((x) => Object.values(x.options)[0] === v);

test('every bundle is in the roster and every component has a product description', () => {
  for (const h of Object.keys(BUNDLES)) {
    const b = bundles.find((x) => x.handle === h);
    assert.ok(b, h);
    for (const v of b.variants) for (const c of v.components) {
      assert.ok(PRODUCT[c.product], `${h}: no PRODUCT for ${c.product}`);
      assert.ok(UNIT[c.product], `${h}: no UNIT description for ${c.product}`);
    }
  }
});

test('a lip balm four-pack is FOUR tubes in the picture but ONE product in the count', () => {
  const k = kit('gift-box', 'Gentle');
  const units = kitUnits(k);
  assert.equal(units.filter((u) => u.product === 'coconut-oil-lip-balm').length, 4);
  assert.equal(units.length, 7);
  assert.equal(productCount(k), 4);
  assert.equal(offerCopy(k, { kitLabel: 'Gentle kit' }).headline, '4 FULL-SIZE PRODUCTS');
});

test('units come tallest first and a scene shows one of each product', () => {
  const k = kit('head-to-toe', 'Fresh');
  assert.equal(kitUnits(k)[0].product, 'organic-foaming-hand-soap');
  assert.equal(sceneUnitsOf(k).length, 7);
  assert.equal(new Set(sceneUnitsOf(kit('90-day-clean-swap', 'Calm')).map((u) => u.product)).size, 4);
});

test('offer copy states the live roster prices and refuses a claim it cannot make', () => {
  const c = offerCopy(kit('90-day-clean-swap', 'Gentle'), { kitLabel: 'Gentle kit' });
  assert.deepEqual(c, { headline: '12 FULL-SIZE PRODUCTS', price: '$144', sub: '$207 bought separately', checks: ['Gentle kit', 'Free shipping'] });
  assert.throws(() => offerCopy({ components: [], price: 40, compareAtPrice: 50 }, { kitLabel: 'x' }), /45/);
  assert.throws(() => offerCopy({ components: [], price: 60, compareAtPrice: 60 }, { kitLabel: 'x' }), /saving/);
});

test('scope suffix matches the bundle-landing gang format', () => {
  assert.equal(scopeSuffix('Kit', 'Gentle'), '#kit_gentle');
  assert.equal(scopeSuffix('Scent', 'Coconut Breeze'), '#scent_coconut-breeze');
});

test('the scale line names the tallest and shortest items actually in the kit', () => {
  const p = heroPrompt({ bundle: BUNDLES['clean-swap'], units: kitUnits(kit('clean-swap', 'Gentle')) });
  assert.match(p, /the body lotion is the tallest item and the bar soap the shortest/);
  assert.doesNotMatch(p, /hand soap is the tallest/);
  assert.match(p, /SHOW EXACTLY 4 ITEMS/);
});

test('the gift box hero never puts products inside the mailer', () => {
  const p = heroPrompt({ bundle: BUNDLES['gift-box'], units: kitUnits(kit('gift-box', 'Calm')) });
  assert.match(p, /NO product is inside it/);
});

const units = kitUnits(kit('clean-swap', 'Fresh'));
const good = {
  lettering: [], our_product_count: 4, matches_reference: 'MATCH', people_present: false, defects: '',
  items: ['body lotion coconut breeze', 'toothpaste fresh mint', 'deodorant geranium flower', 'bar soap nourishing tea tree'],
};

test('judgeBundle passes the exact kit and fails a swapped scent on one product', () => {
  assert.equal(judgeBundle({ read: good, units }).ok, true);
  const swapped = { ...good, items: ['body lotion pure unscented', ...good.items.slice(1)] };
  const r = judgeBundle({ read: swapped, units });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /scent mix/);
});

test('judgeBundle tells products apart that share a scent name', () => {
  const g = kitUnits(kit('clean-swap', 'Gentle'));
  assert.ok(g.map(label).includes('body lotion pure unscented') && g.map(label).includes('bar soap pure unscented'));
  const read = { ...good, items: ['body lotion pure unscented', 'toothpaste fresh mint', 'deodorant calming lavender', 'body lotion pure unscented'] };
  assert.equal(judgeBundle({ read, units: g }).ok, false);
});
