import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
// The package is ESM, so a .js asset cannot be require()d as CommonJS. Evaluate it
// the way a classic script would run, with a CommonJS `module` in scope.
const mod = { exports: {} };
new Function('module', readFileSync(new URL('../../theme/assets/presell-buy.js', import.meta.url), 'utf8'))(mod);
const { createBuy, relabel } = mod.exports;

function harness(response) {
  const calls = []; const nav = [];
  const fetch = (url, opts) => { calls.push({ url, opts }); return typeof response === 'function' ? response() : Promise.resolve(response); };
  return { calls, nav, buy: createBuy({ fetch, navigate: (u) => nav.push(u) }) };
}
const ok = { ok: true, status: 200, json: async () => ({}) };

test('posts JSON to /cart/add.js then navigates to checkout once', async () => {
  const h = harness(ok);
  const r = await h.buy.submit('44179428475050');
  assert.deepEqual(r, { ok: true });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, '/cart/add.js');
  assert.equal(h.calls[0].opts.method, 'POST');
  assert.equal(h.calls[0].opts.headers['Content-Type'], 'application/json');
  assert.equal(h.calls[0].opts.headers.Accept, 'application/json');
  assert.deepEqual(JSON.parse(h.calls[0].opts.body), { items: [{ id: 44179428475050, quantity: 1 }] });
  assert.deepEqual(h.nav, ['/checkout']);
});
test('non-2xx returns Shopify description and never navigates', async () => {
  const h = harness({ ok: false, status: 422, json: async () => ({ status: 422, message: 'Cart Error', description: 'Sold out.' }) });
  const r = await h.buy.submit('1');
  assert.deepEqual(r, { ok: false, error: 'Sold out.' });
  assert.equal(h.nav.length, 0);
});
test('non-2xx without a body gets a friendly fallback', async () => {
  const h = harness({ ok: false, status: 500, json: async () => { throw new Error('x'); } });
  const r = await h.buy.submit('1');
  assert.equal(r.ok, false);
  assert.ok(r.error && !/—/.test(r.error));
  assert.equal(h.nav.length, 0);
});
test('rejected fetch returns error, no navigation', async () => {
  const h = harness(() => Promise.reject(new Error('offline')));
  const r = await h.buy.submit('1');
  assert.equal(r.ok, false);
  assert.ok(r.error);
  assert.equal(h.nav.length, 0);
});
test('double submit while pending posts once', async () => {
  let release; const h = harness(() => new Promise((res) => { release = () => res(ok); }));
  const a = h.buy.submit('1'); const b = await h.buy.submit('1');
  assert.equal(b.ok, false);
  release(); await a;
  assert.equal(h.calls.length, 1);
  assert.equal(h.nav.length, 1);
});
test('changed select id is posted', async () => {
  const h = harness(ok);
  await h.buy.submit('777');
  assert.equal(JSON.parse(h.calls[0].opts.body).items[0].id, 777);
});
test('submit works again after a failure', async () => {
  let n = 0; const h = harness(() => Promise.resolve(n++ ? ok : { ok: false, status: 422, json: async () => ({ description: 'No.' }) }));
  assert.equal((await h.buy.submit('1')).ok, false);
  assert.equal((await h.buy.submit('1')).ok, true);
});
test('relabel swaps scent and price tokens', () => {
  assert.equal(relabel('Get Coconut Breeze for $28', { priceToken: '$28', scentToken: 'Coconut Breeze' }, { scent: 'Lavender', price: '$30' }), 'Get Lavender for $30');
  assert.equal(relabel('Buy', { priceToken: '@@a', scentToken: '@@b' }, { scent: 'X', price: '$1' }), 'Buy');
});
