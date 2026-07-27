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
  for (const h of ['hand-soap-set', 'clean-swap', 'gift-box', '90-day-clean-swap',
                   'head-to-toe', '99-coconut-reset-digital', 'coconut-bar-soap-4-pack',
                   'sensitive-skin-starter-set']) {
    assert.ok(handles.includes(h), `roster is missing ${h}`);
  }
});

test('the Hand Soap Set grid is complete and lotion is paired correctly', () => {
  const b = loadRoster().bundles.find(x => x.handle === 'hand-soap-set');
  assert.equal(b.variants.length, 15, 'three configurations by five scents');

  for (const v of b.variants) {
    const config = v.options.Configuration;
    const pumps = v.components.filter(c => c.product === 'organic-foaming-hand-soap');
    const total = pumps.reduce((s, c) => s + c.qty, 0);
    assert.equal(total, config.startsWith('3 pumps') ? 3 : 4,
      `${config} / ${v.options.Scent} must contain the right number of pumps`);

    const lotion = v.components.filter(c => c.product === 'coconut-lotion');
    if (config.includes('body lotion')) {
      assert.equal(lotion.length, 1, `${config} must carry a lotion`);
      const expected = v.options.Scent === 'Coconut Breeze' ? 'Coconut Breeze' : 'Pure Unscented';
      assert.equal(lotion[0].variant, expected,
        `${v.options.Scent} must pair with ${expected} lotion`);
    } else {
      assert.equal(lotion.length, 0, `${config} must not carry a lotion`);
    }
  }
});

test('the Gift Box carries the $1 custom box', () => {
  const b = loadRoster().bundles.find(x => x.handle === 'gift-box');
  assert.equal(b.packaging, 1.0);
});
