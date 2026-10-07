import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  TIERS, UNIT, unitsFor, composition, offerCopy, representativeVariant, sceneUnits,
  choiceLine, heroPrompt, offerPrompt, judge,
} from '../../lib/ladder-gallery.js';

const { bundles } = JSON.parse(readFileSync(new URL('../../config/bundles.json', import.meta.url)));
const B = (h) => bundles.find((b) => b.handle === h);
const V = (h, t) => B(h).variants.find((v) => Object.values(v.options)[0] === t);

test('every tier names a live roster bundle and a described base product', () => {
  for (const [handle, tier] of Object.entries(TIERS)) {
    assert.ok(B(handle), `${handle} missing from config/bundles.json`);
    assert.ok(UNIT[tier.base], `${handle}: no UNIT for ${tier.base}`);
    for (const v of B(handle).variants) assert.ok(unitsFor(tier, v).length > 1, `${handle} ${JSON.stringify(v.options)}`);
  }
});

test('units are what ships: the 12-pack variety is 3 of each, the lip balm tier counts TUBES', () => {
  const soap = unitsFor(TIERS['coconut-bar-soap-12-pack'], V('coconut-bar-soap-12-pack', 'Variety — 3 of each'));
  assert.equal(soap.length, 12);
  assert.equal(composition(soap), '3 × calming lavender, 3 × nourishing tea tree, 3 × refreshing lemongrass, 3 × pure unscented');
  const balm = unitsFor(TIERS['coconut-lip-balm-3-pack'], V('coconut-lip-balm-3-pack', '3x Vanilla Dream'));
  assert.equal(balm.length, 12);
  const variety = unitsFor(TIERS['coconut-lip-balm-3-pack'], V('coconut-lip-balm-3-pack', '3x Variety Pack'));
  assert.equal(composition(variety), '3 × vanilla dream, 3 × sweet tangerine, 3 × coconut breeze, 3 × pure unscented');
});

test('a variety the tier cannot expand throws rather than guessing', () => {
  assert.throws(() => unitsFor({ unitsPer: 1 }, { components: [{ variant: 'Variety Pack', qty: 2 }] }), /does not expand/);
});

test('offer copy mirrors the ladder: free-unit framing only when the price is whole singles', () => {
  const c12 = offerCopy({ tier: TIERS['coconut-bar-soap-12-pack'], unit: UNIT['coconut-soap'], variant: V('coconut-bar-soap-12-pack', 'Variety — 3 of each'), basePrice: 11 });
  assert.deepEqual(c12, { headline: 'BUY 8, GET 4 FREE', price: '$88', sub: '12 bars · $7.33 a bar' });
  const balm = offerCopy({ tier: TIERS['coconut-lip-balm-3-pack'], unit: UNIT['coconut-oil-lip-balm'], variant: V('coconut-lip-balm-3-pack', '3x Pure Unscented'), basePrice: 15 });
  assert.deepEqual(balm, { headline: 'BUY 2, GET 1 FREE', price: '$30', sub: '12 tubes · $2.50 a tube' });
  const hs = offerCopy({ tier: TIERS['coconut-hand-soap-4-pack'], unit: UNIT['organic-foaming-hand-soap'], variant: V('coconut-hand-soap-4-pack', '4x Orange Zest'), basePrice: 13 });
  assert.deepEqual(hs, { headline: '4 BOTTLES FOR $44', price: '$11', sub: 'a bottle' });
});

test('product-level frames draw the mixed variant where one exists', () => {
  assert.match(Object.values(representativeVariant(B('coconut-toothpaste-3-pack')).options)[0], /Variety/);
  assert.equal(Object.values(representativeVariant(B('coconut-lotion-5-pack')).options)[0], '5x Pure Unscented');
  assert.equal(choiceLine(TIERS['coconut-toothpaste-3-pack'], B('coconut-toothpaste-3-pack')), 'One flavor or a mix of each');
  assert.equal(choiceLine(TIERS['coconut-hand-soap-2-pack'], B('coconut-hand-soap-2-pack')), 'Pick your scent');
});

test('a scene never shows more units than ship, and leads with one of each scent', () => {
  for (const [h, tier] of Object.entries(TIERS)) {
    const s = sceneUnits(tier, B(h));
    assert.ok(s.length <= unitsFor(tier, representativeVariant(B(h))).length, h);
    assert.equal(s.length, tier.sceneUnits, h);
  }
  assert.deepEqual(sceneUnits(TIERS['coconut-bar-soap-12-pack'], B('coconut-bar-soap-12-pack')),
    ['Calming Lavender', 'Nourishing Tea Tree', 'Refreshing Lemongrass', 'Pure Unscented']);
});

test('prompts state the exact count and forbid invented text', () => {
  const tier = TIERS['coconut-bar-soap-12-pack'];
  const units = unitsFor(tier, V('coconut-bar-soap-12-pack', 'Variety — 3 of each'));
  const hero = heroPrompt({ tier, unit: UNIT['coconut-soap'], units });
  assert.match(hero, /SHOW EXACTLY 12 BARS/);
  assert.match(hero, /never 11, never 13/);
  assert.match(hero, /Keep each scent's units together/);
  assert.match(hero, /NO TEXT anywhere/);
  const offer = offerPrompt({ tier, unit: UNIT['coconut-soap'], units, copy: { headline: 'BUY 8, GET 4 FREE', price: '$88', sub: '12 bars · $7.33 a bar' }, checks: ['A', 'B'] });
  assert.match(offer, /"BUY 8, GET 4 FREE"/);
  assert.match(offer, /no stars, no review counts/);
});

const units = ['Calming Lavender', 'Calming Lavender', 'Pure Unscented', 'Pure Unscented'];
const good = { lettering: [], scent_names: ['calming lavender', 'calming lavender', 'pure unscented', 'pure unscented'], our_product_count: 4, matches_reference: 'MATCH', people_present: false, defects: '' };

test('judge passes an exact render', () => {
  assert.deepEqual(judge({ read: good, units }), { ok: true, reasons: [] });
});

test('judge fails a wrong MIX even when every scent appears and the total is right', () => {
  // The first 12-pack trial passed a weaker check while showing 3/4/3/2 for 3/3/3/3.
  const r = judge({ read: { ...good, scent_names: ['calming lavender', 'calming lavender', 'calming lavender', 'pure unscented'] }, units });
  assert.equal(r.ok, false);
  assert.match(r.reasons.join(), /scent mix read as 3 × calming lavender, 1 × pure unscented/);
});

test('judge fails a wrong count, a misspelled label, an UNREADABLE unit, a mismatch, a person', () => {
  assert.match(judge({ read: { ...good, our_product_count: 5 }, units }).reasons.join(), /5 units/);
  assert.equal(judge({ read: { ...good, scent_names: ['calming lavendar', 'calming lavender', 'pure unscented', 'pure unscented'] }, units }).ok, false);
  assert.equal(judge({ read: { ...good, scent_names: ['UNREADABLE', 'calming lavender', 'pure unscented', 'pure unscented'] }, units }).ok, false);
  assert.match(judge({ read: { ...good, matches_reference: 'MISMATCH', mismatch_reason: 'pump top' }, units }).reasons.join(), /pump top/);
  assert.equal(judge({ read: { ...good, people_present: true }, units }).ok, false);
  assert.equal(judge({ read: null, units }).ok, false);
});

test('judge requires every offer string and refuses any text that was not asked for', () => {
  const required = ['BUY 8, GET 4 FREE', '$88'];
  assert.equal(judge({ read: { ...good, lettering: ['BUY 8, GET 4 FREE', '$88'] }, units, required }).ok, true);
  assert.match(judge({ read: { ...good, lettering: ['BUY 8, GET 4 FRE', '$88'] }, units, required }).reasons.join(), /missing or misspelled/);
  const extra = judge({ read: { ...good, lettering: ['BUY 8, GET 4 FREE', '$88', '500+ five-star reviews'] }, units, required });
  assert.equal(extra.ok, false);
  assert.match(extra.reasons.join(), /unrequested text/);
  // No headline was asked for on a hero: any lettering at all fails it.
  assert.equal(judge({ read: { ...good, lettering: ['Stock up'] }, units }).ok, false);
});
