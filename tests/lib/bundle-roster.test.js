import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateRoster, SKU_BY_HANDLE, economicsRows, loadRoster } from '../../lib/bundle-roster.js';

const CATALOGUE = {
  'coconut-lotion': ['Pure Unscented', 'Coconut Breeze', 'Calming Lavender'],
  'coconut-oil-deodorant': ['Geranium Flower', 'Calming Lavender'],
  'coconut-soap': ['Calming Lavender', 'Pure Unscented'],
};

const bundle = (over = {}) => ({
  handle: 'test-bundle', title: 'Test Bundle', status: 'live', packaging: 0,
  options: [{ name: 'Kit', values: ['Gentle'] }],
  variants: [{
    options: { Kit: 'Gentle' }, price: 59, compareAtPrice: 69, contents: '1 × lotion',
    components: [{ product: 'coconut-lotion', variant: 'Pure Unscented', qty: 1 }],
  }],
  ...over,
});

test('a well-formed bundle validates clean', () => {
  assert.deepEqual(validateRoster({ bundles: [bundle()] }, CATALOGUE), []);
});

test('an unknown component product is rejected', () => {
  const bad = bundle({ variants: [{ ...bundle().variants[0],
    components: [{ product: 'nonexistent-product', variant: 'Pure Unscented', qty: 1 }] }] });
  const errs = validateRoster({ bundles: [bad] }, CATALOGUE);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /nonexistent-product/);
});

test('an unknown variant title is rejected — this is the typo that ships the wrong box', () => {
  const bad = bundle({ variants: [{ ...bundle().variants[0],
    components: [{ product: 'coconut-lotion', variant: 'Unscented', qty: 1 }] }] });
  const errs = validateRoster({ bundles: [bad] }, CATALOGUE);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /Unscented/);
});

test('lotion outside the two-scent rule is rejected', () => {
  const bad = bundle({ variants: [{ ...bundle().variants[0],
    components: [{ product: 'coconut-lotion', variant: 'Calming Lavender', qty: 1 }] }] });
  const errs = validateRoster({ bundles: [bad] }, CATALOGUE);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /two-scent rule/);
});

test('a variant whose options do not match the declared option values is rejected', () => {
  const bad = bundle({ variants: [{ ...bundle().variants[0], options: { Kit: 'Bold' } }] });
  const errs = validateRoster({ bundles: [bad] }, CATALOGUE);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /Bold/);
});

test('duplicate handles are rejected', () => {
  const errs = validateRoster({ bundles: [bundle(), bundle()] }, CATALOGUE);
  assert.ok(errs.some(e => /duplicate handle/i.test(e)));
});

test('every component handle maps to a known SKU key', () => {
  for (const key of Object.values(SKU_BY_HANDLE)) {
    assert.ok(typeof key === 'string' && key.length, `bad SKU key: ${key}`);
  }
  assert.equal(SKU_BY_HANDLE['organic-foaming-hand-soap'], 'pump');
  assert.equal(SKU_BY_HANDLE['coconut-soap'], 'barsoap');
});

const CLEAN_SWAP = {
  handle: 'clean-swap', title: 'The Clean Swap', status: 'live', price: 59, packaging: 0,
  story: 'Entry version of the 90-day.',
  options: [{ name: 'Kit', values: ['Gentle', 'Calm'] }],
  variants: [
    { options: { Kit: 'Gentle' }, price: 59, components: [
      { product: 'coconut-lotion', variant: 'Pure Unscented', qty: 1 },
      { product: 'coconut-soap', variant: 'Pure Unscented', qty: 1 }] },
    { options: { Kit: 'Calm' }, price: 59, components: [
      { product: 'coconut-lotion', variant: 'Pure Unscented', qty: 1 },
      { product: 'coconut-soap', variant: 'Calming Lavender', qty: 1 }] },
  ],
};

test('kits with the same basket collapse to one economics row', () => {
  const rows = economicsRows(CLEAN_SWAP);
  assert.equal(rows.length, 1, 'Gentle and Calm differ only by scent, not by basket');
  assert.equal(rows[0].name, 'The Clean Swap');
  assert.deepEqual(rows[0].items, { lotion: 1, barsoap: 1 });
  assert.equal(rows[0].price, 59);
});

test('genuinely different baskets produce a row each, named by configuration', () => {
  const handSoap = {
    handle: 'hand-soap-set', title: 'Hand Soap Set', status: 'live', packaging: 0, story: 'Pumps.',
    options: [
      { name: 'Configuration', values: ['4 pumps', '4 pumps + body lotion'] },
      { name: 'Scent', values: ['Pure Unscented'] },
    ],
    variants: [
      { options: { Configuration: '4 pumps', Scent: 'Pure Unscented' }, price: 44,
        components: [{ product: 'organic-foaming-hand-soap', variant: 'Pure Unscented', qty: 4 }] },
      { options: { Configuration: '4 pumps + body lotion', Scent: 'Pure Unscented' }, price: 72,
        components: [
          { product: 'organic-foaming-hand-soap', variant: 'Pure Unscented', qty: 4 },
          { product: 'coconut-lotion', variant: 'Pure Unscented', qty: 1 }] },
    ],
  };
  const rows = economicsRows(handSoap);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.name),
    ['Hand Soap Set — 4 pumps', 'Hand Soap Set — 4 pumps + body lotion']);
  assert.deepEqual(rows[0].items, { pump: 4 });
  assert.deepEqual(rows[1].items, { pump: 4, lotion: 1 });
  assert.equal(rows[1].price, 72);
});

test('packaging and status carry onto every row', () => {
  const rows = economicsRows({ ...CLEAN_SWAP, packaging: 1.0, status: 'proposed' });
  assert.equal(rows[0].packaging, 1.0);
  assert.equal(rows[0].status, 'proposed');
});

test('the real roster has all eight bundles', () => {
  const handles = loadRoster().bundles.map(b => b.handle);
  for (const h of ['coconut-hand-soap-4-pack', 'clean-swap', 'gift-box', '90-day-clean-swap',
                   'head-to-toe', '99-coconut-reset-digital', 'coconut-bar-soap-4-pack',
                   'sensitive-skin-starter-set']) {
    assert.ok(handles.includes(h), `roster is missing ${h}`);
  }
});

test('the hand soap ladder tiers are pump-only and complete on scent', () => {
  // Replaced the Hand Soap Set's Configuration × Scent grid on 2026-09-05. That
  // product was a SET — it carried "3 pumps + body lotion" and "4 pumps + body
  // lotion" configurations — and it sold nothing in 365 days. It is now two
  // plain ladder rungs on the liquid soap PDP, matching bar soap / deodorant /
  // toothpaste, so the property worth asserting changed shape with it: a rung
  // holds N of ONE product, one variant per scent, and nothing else.
  const roster = loadRoster();
  const ladder = roster.ladders.find(l => l.base === 'organic-foaming-hand-soap');
  assert.ok(ladder, 'the liquid soap PDP must have a ladder');

  for (const handle of ladder.tiers.filter(h => h !== ladder.base)) {
    const b = roster.bundles.find(x => x.handle === handle);
    assert.ok(b, `roster is missing ladder tier ${handle}`);

    // Derived from the handle, not a literal: a repricing or a renamed rung
    // must not be able to pass by quietly changing what "4-pack" contains.
    const units = Number(handle.match(/-(\d+)-pack$/)[1]);
    const scents = b.options.find(o => o.name === 'Scent').values;
    assert.equal(b.options.length, 1, `${handle} must have exactly one option axis`);
    assert.equal(b.variants.length, scents.length,
      `${handle} must offer one variant per scent`);

    for (const v of b.variants) {
      assert.ok(scents.includes(v.options.Scent), `${handle}: stray variant ${v.options.Scent}`);

      // Pump-only. Anything else here would make the rung a set again, and the
      // ladder's per-unit price ("$11.00 each") would be describing a basket.
      const others = v.components.filter(c => c.product !== 'organic-foaming-hand-soap');
      assert.equal(others.length, 0,
        `${handle} / ${v.options.Scent} carries a non-pump component: ${others.map(c => c.product).join(', ')}`);

      const total = v.components.reduce((s, c) => s + c.qty, 0);
      assert.equal(total, units, `${handle} / ${v.options.Scent} must contain ${units} pumps`);

      // Sean, 2026-08-02 (90f13d7a): "don't offer variety at all" — about hand
      // soap specifically. The three sibling tier products keep their
      // "Variety — one of each"; these must not grow one back.
      assert.ok(!/variety|one of each/i.test(v.options.Scent),
        `${handle} is offering a mixed set again: ${v.options.Scent}`);
    }
  }
});

test('the Gift Box carries the $1 custom box', () => {
  const b = loadRoster().bundles.find(x => x.handle === 'gift-box');
  assert.equal(b.packaging, 1.0);
});

test('validateRoster surfaces ladder errors alongside bundle errors', () => {
  const roster = {
    bundles: [{ handle: 'p4', status: 'live', variants: [{ components: [{ product: 'coconut-soap', variant: 'a', qty: 4 }] }] }],
    ladders: [{ base: 'coconut-soap', tiers: ['coconut-soap', 'p4'], default: 'nope' }],
  };
  const errors = validateRoster(roster, { 'coconut-soap': ['a'] }, { 'coconut-soap': { status: 'ACTIVE' }, p4: { status: 'ACTIVE' } });
  assert.ok(errors.some((e) => /default "nope" is not one of the tiers/.test(e)));
});

test('a roster with no ladders key is still valid', () => {
  const roster = { bundles: [] };
  assert.deepEqual(validateRoster(roster, {}, {}), []);
});
