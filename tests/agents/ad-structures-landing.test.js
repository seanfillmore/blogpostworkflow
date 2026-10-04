import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fetchLanding, parseOffer, verifyOffer, valueLines } from '../../agents/ad-concepts/landing.js';

const body = {
  product: {
    title: 'Sensitive Skin Moisturizing Set | Real Skin Care',
    handle: 'sensitive-skin-starter-set',
    variants: [{ title: 'Default', price: '46.80', compare_at_price: '58.00' }, { title: 'B', price: '10.00', compare_at_price: null }],
  },
};
const stub = (status = 200) => async (url) => ({ ok: status === 200, status, json: async () => body, _url: url });

test('fetchLanding parses prices to numbers', async () => {
  const l = await fetchLanding('sensitive-skin-starter-set', { fetchImpl: stub() });
  assert.equal(l.variants[0].price, 46.8);
  assert.equal(l.variants[0].compareAt, 58);
  assert.equal(l.variants[1].compareAt, null);
  assert.match(l.url, /\/products\/sensitive-skin-starter-set$/);
});
test('fetchLanding throws on 404 naming url', async () => {
  await assert.rejects(fetchLanding('nope', { fetchImpl: stub(404) }), /products\/nope\.json/);
});
test('parseOffer', () => {
  assert.deepEqual(parseOffer('$46.80 was $58'), { price: 46.8, wasPrice: 58 });
  assert.throws(() => parseOffer('$46.80'));
  assert.throws(() => parseOffer('$58 was $46.80'));
});
test('verifyOffer exact to the cent', async () => {
  const l = await fetchLanding('x', { fetchImpl: stub() });
  const ok = verifyOffer({ price: 46.8, wasPrice: 58 }, l);
  assert.equal(ok.ok, true);
  assert.equal(ok.band, 'SENSITIVE SKIN MOISTURIZING SET $46.80 (WAS $58)');
  assert.ok(!ok.band.includes('—'));
  const bad = verifyOffer({ price: 46.79, wasPrice: 58 }, l);
  assert.equal(bad.ok, false);
  assert.ok(bad.reason);
});
test('valueLines from fixtures', () => {
  const v = valueLines({
    brandKit: { free_shipping_threshold: 45, manufacturing: 'handmade, made in the USA' },
    catalogEntry: { title: 'Lotion Made With only 6 clean ingredients' },
  });
  assert.deepEqual(v, ['FREE SHIPPING ON ORDERS OVER $45', 'MADE IN THE USA', 'ONLY 6 CLEAN INGREDIENTS']);
  assert.deepEqual(valueLines({ brandKit: {}, catalogEntry: {} }), []);
});
test('valueLines from real files', () => {
  const brandKit = JSON.parse(readFileSync('data/brand/brand-kit.json', 'utf8'));
  const cat = JSON.parse(readFileSync('data/brand/product-catalog.json', 'utf8'));
  const v = valueLines({ brandKit, catalogEntry: cat.products['coconut-lotion'] });
  assert.ok(v.includes('FREE SHIPPING ON ORDERS OVER $45'));
  assert.ok(v.includes('MADE IN THE USA'));
  assert.ok(v.includes('ONLY 6 CLEAN INGREDIENTS'));
});
