import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
// The package is ESM, so a .js asset cannot be require()d as CommonJS. Evaluate it
// the way a classic script would run, with a CommonJS `module` in scope.
const mod = { exports: {} };
new Function('module', readFileSync(new URL('../../theme/assets/presell-buy.js', import.meta.url), 'utf8'))(mod);
const { createBuy, relabel, bind } = mod.exports;

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
test('rejected fetch returns friendly error, not the raw message, no navigation', async () => {
  const h = harness(() => Promise.reject(new Error('Failed to fetch')));
  const r = await h.buy.submit('1');
  assert.equal(r.ok, false);
  assert.ok(r.error && !/Failed to fetch/.test(r.error) && !/\u2014/.test(r.error));
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

test('a throwing navigate does not leave submit stuck', async () => {
  const calls = [];
  const buy = createBuy({ fetch: (u, o) => { calls.push(u); return Promise.resolve(ok); }, navigate: () => { throw new Error('nav'); } });
  assert.equal((await buy.submit('1')).ok, false);
  assert.equal((await buy.submit('1')).ok, false);
  assert.equal(calls.length, 2);
});
test('pageshow persisted re-enables the button and hides the error', async () => {
  const handlers = {};
  const mk = () => ({ listeners: {}, addEventListener(n, f) { this.listeners[n] = f; } });
  const form = mk(), select = mk(), win = mk();
  select.options = [{ getAttribute: () => 'x', text: 'x' }]; select.selectedIndex = 0; select.value = '5';
  const button = { disabled: false };
  const errorEl = { hidden: true, textContent: '' };
  form.getAttribute = () => '';
  form.querySelector = (q) => (q.includes('select') ? select : q.includes('submit') ? button : errorEl);
  const doc = { querySelector: () => form, querySelectorAll: () => [] };
  win.fetch = () => Promise.resolve(ok);
  win.location = { href: '' };
  bind(doc, win);
  form.listeners.submit({ preventDefault() {} });
  assert.equal(button.disabled, true);
  errorEl.hidden = false;
  win.listeners.pageshow({ persisted: false });
  assert.equal(button.disabled, true);
  win.listeners.pageshow({ persisted: true });
  assert.equal(button.disabled, false);
  assert.equal(errorEl.hidden, true);
  await new Promise((r) => setTimeout(r, 5));
});

test('bind drops the form action so the cart-drawer app (OCU) does not hijack the add', () => {
  const mk = () => ({ listeners: {}, addEventListener(n, f) { this.listeners[n] = f; } });
  const form = mk(), select = mk(), win = mk();
  select.options = [{ getAttribute: () => 'x', text: 'x' }]; select.selectedIndex = 0;
  const attrs = { action: '/cart/add' };
  form.getAttribute = (n) => attrs[n] ?? '';
  form.removeAttribute = (n) => { delete attrs[n]; };
  form.querySelector = (q) => (q.includes('select') ? select : q.includes('submit') ? { disabled: false } : { hidden: true });
  bind({ querySelector: () => form, querySelectorAll: () => [] }, win);
  assert.equal('action' in attrs, false);
});

// ── Quantity, 4-pack banner, single-pass relabel (2026-10-19) ───────────────
const { clampQuantity, formatMoney } = mod.exports;

test('submit posts the chosen quantity', async () => {
  const h = harness(ok);
  await h.buy.submit('44179428475050', 3);
  assert.deepEqual(JSON.parse(h.calls[0].opts.body), { items: [{ id: 44179428475050, quantity: 3 }] });
});
test('quantity is clamped to an integer 1..10, default 1', async () => {
  assert.equal(clampQuantity(undefined), 1);
  assert.equal(clampQuantity('0'), 1);
  assert.equal(clampQuantity(-4), 1);
  assert.equal(clampQuantity('abc'), 1);
  assert.equal(clampQuantity(2.9), 2);
  assert.equal(clampQuantity('3'), 3);
  assert.equal(clampQuantity(99), 10);
  const h = harness(ok);
  await h.buy.submit('1', 50);
  assert.equal(JSON.parse(h.calls[0].opts.body).items[0].quantity, 10);
});
test('formatMoney matches money_without_trailing_zeros', () => {
  assert.equal(formatMoney(2800, '$'), '$28');
  assert.equal(formatMoney(5600, '$'), '$56');
  assert.equal(formatMoney(2750 * 2, '$'), '$55');
  assert.equal(formatMoney(2750, '$'), '$27.50');
  assert.equal(formatMoney(8250, '$'), '$82.50');
  assert.equal(formatMoney(2705, '$'), '$27.05');
  assert.equal(formatMoney(123400, '$'), '$1,234');
});
test('relabel is single pass: a replacement is never rescanned for another token', () => {
  const tokens = { quantityToken: '2', totalToken: '$56', scentToken: 'Coconut Breeze' };
  assert.equal(relabel('Get 2 jars of Coconut Breeze, $56', tokens, { quantity: '3', total: '$112', scent: 'Pure Unscented' }),
    'Get 3 jars of Pure Unscented, $112');
  // "$" in a value is literal (split/join semantics, never String.replace patterns).
  assert.equal(relabel('A $28', { priceToken: '$28' }, { price: '$&$1' }), 'A $&$1');
});

// A small fake DOM: elements keyed by selector.
function el(attrs = {}) {
  return {
    attrs: { ...attrs }, listeners: {}, hidden: false, disabled: false, textContent: '', value: attrs.value ?? '',
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    hasAttribute(n) { return n in this.attrs; },
    removeAttribute(n) { delete this.attrs[n]; this.removed = (this.removed || []).concat(n); },
    addEventListener(n, f) { this.listeners[n] = f; },
  };
}
function buyDom({ options, selected = 0, max = '3' }) {
  const opts = options.map((o) => el(o));
  const select = el(); select.options = opts; select.selectedIndex = selected;
  Object.defineProperty(select, 'value', { get() { return opts[this.selectedIndex].attrs.value; } });
  const button = el({ 'data-presell-label': '', 'data-presell-template': 'Get Coconut Breeze, $28', 'data-presell-template-multi': 'Get 2 jars of Coconut Breeze, $56' });
  const priceLine = el({ 'data-presell-label': '', 'data-presell-template': '$28 for one jar', 'data-presell-template-multi': '$56 for 2 jars' });
  const sticky = el({ 'data-presell-label': '', 'data-presell-template': 'Get Coconut Breeze, $28' });
  const packLine = el({ 'data-presell-label': '', 'data-presell-template': '4 jars for $84 ($21 a jar)' });
  const packCta = el({ 'data-presell-label': '', 'data-presell-template': 'Get 4 jars for $84' });
  const errorEl = el(); errorEl.hidden = true;
  const packError = el(); packError.hidden = true;
  const stepper = el({ 'data-max': max });
  const dec = el(), inc = el(), out = el(), qtyInput = el({ value: '1' });
  const banner = el();
  const formAttrs = {
    action: '/cart/add', 'data-price-token': '$28', 'data-scent-token': 'Coconut Breeze',
    'data-quantity-token': '2', 'data-total-token': '$56', 'data-pack-price-token': '$84', 'data-pack-unit-token': '$21',
  };
  const form = el(formAttrs);
  const order = [];
  const origAdd = form.addEventListener.bind(form);
  form.addEventListener = (n, f) => { order.push(`listen:${n}`); origAdd(n, f); };
  const origRemove = form.removeAttribute.bind(form);
  form.removeAttribute = (n) => { order.push(`remove:${n}`); origRemove(n); };
  const inForm = {
    'select[name=id]': select, '[data-presell-submit]': button, '[data-presell-error]': errorEl,
    '[data-presell-qty]': stepper, '[data-presell-qty-dec]': dec, '[data-presell-qty-inc]': inc,
    '[data-presell-qty-value]': out, 'input[name=quantity]': qtyInput,
  };
  form.querySelector = (q) => inForm[q] || null;
  const inDoc = {
    'form[data-presell-buy]': form, '[data-presell-pack]': banner,
    '[data-presell-pack-buy]': packCta, '[data-presell-pack-error]': packError,
  };
  const doc = {
    querySelector: (q) => inDoc[q] || null,
    querySelectorAll: (q) => (q === '[data-presell-label][data-presell-template]' ? [button, priceLine, sticky, packLine, packCta] : []),
  };
  const fetched = [];
  const win = el();
  const winAdd = win.addEventListener.bind(win);
  win.addEventListener = (n, f) => { order.push(`win:${n}`); winAdd(n, f); };
  win.fetch = (u, o) => { fetched.push(JSON.parse(o.body)); return Promise.resolve(ok); };
  win.location = { href: '' };
  return { doc, win, form, select, button, priceLine, sticky, packLine, packCta, errorEl, packError, dec, inc, out, qtyInput, banner, fetched, order };
}
const BREEZE = { value: '44179428475050', 'data-scent': 'Coconut Breeze', 'data-price': '$28', 'data-price-cents': '2800',
  'data-pack-id': '67602073387178', 'data-pack-price': '$84', 'data-pack-unit': '$21', 'data-pack-cents': '8400' };
const UNSCENTED_NOPACK = { value: '45828182114474', 'data-scent': 'Pure Unscented', 'data-price': '$27.50', 'data-price-cents': '2750' };
const flush = () => new Promise((r) => setTimeout(r, 5));

test('stepper: bounds, disabled ends, live label and multiplied price with cents', () => {
  const d = buyDom({ options: [BREEZE, UNSCENTED_NOPACK] });
  bind(d.doc, d.win);
  assert.equal(d.out.textContent, '1');
  assert.equal(d.dec.disabled, true);
  assert.equal(d.inc.disabled, false);
  assert.equal(d.button.textContent, 'Get Coconut Breeze, $28');
  d.inc.listeners.click({ preventDefault() {} });
  assert.equal(d.out.textContent, '2');
  assert.equal(d.qtyInput.value, '2');
  assert.equal(d.button.textContent, 'Get 2 jars of Coconut Breeze, $56');
  assert.equal(d.priceLine.textContent, '$56 for 2 jars');
  assert.equal(d.sticky.textContent, 'Get Coconut Breeze, $28', 'elements without a multi template stay per-jar');
  d.inc.listeners.click({ preventDefault() {} });
  assert.equal(d.out.textContent, '3');
  assert.equal(d.inc.disabled, true);
  d.inc.listeners.click({ preventDefault() {} });
  assert.equal(d.out.textContent, '3', 'max is 3');
  d.select.selectedIndex = 1; d.select.listeners.change();
  assert.equal(d.button.textContent, 'Get 3 jars of Pure Unscented, $82.50');
  d.dec.listeners.click({ preventDefault() {} }); d.dec.listeners.click({ preventDefault() {} }); d.dec.listeners.click({ preventDefault() {} });
  assert.equal(d.out.textContent, '1');
  assert.equal(d.dec.disabled, true);
  assert.equal(d.button.textContent, 'Get Pure Unscented, $27.50');
});
test('buy posts the stepper quantity for the selected single jar', async () => {
  const d = buyDom({ options: [BREEZE] });
  bind(d.doc, d.win);
  d.inc.listeners.click({ preventDefault() {} });
  d.form.listeners.submit({ preventDefault() {} });
  await flush();
  assert.deepEqual(d.fetched, [{ items: [{ id: 44179428475050, quantity: 2 }] }]);
  assert.equal(d.win.location.href, '/checkout');
});
test('pack button posts the selected scent\'s 4-pack variant with quantity 1', async () => {
  const d = buyDom({ options: [BREEZE] });
  bind(d.doc, d.win);
  d.inc.listeners.click({ preventDefault() {} });
  d.packCta.listeners.click({ preventDefault() {} });
  assert.equal(d.packCta.disabled, true);
  assert.equal(d.button.disabled, true, 'double-tap protection covers both buttons');
  d.form.listeners.submit({ preventDefault() {} });
  await flush();
  assert.deepEqual(d.fetched, [{ items: [{ id: 67602073387178, quantity: 1 }] }]);
  assert.equal(d.win.location.href, '/checkout');
});
test('banner shows for a scent with an honest pack and hides for a scent without one', () => {
  const d = buyDom({ options: [BREEZE, UNSCENTED_NOPACK] });
  bind(d.doc, d.win);
  assert.equal(d.banner.hidden, false);
  assert.equal(d.packLine.textContent, '4 jars for $84 ($21 a jar)');
  d.select.selectedIndex = 1; d.select.listeners.change();
  assert.equal(d.banner.hidden, true);
  d.select.selectedIndex = 0; d.select.listeners.change();
  assert.equal(d.banner.hidden, false);
});
test('banner hides when the pack costs more than three singles (no "4th free" claim)', () => {
  const pricey = { ...BREEZE, 'data-pack-cents': '8401', 'data-pack-price': '$84.01' };
  const d = buyDom({ options: [pricey] });
  bind(d.doc, d.win);
  assert.equal(d.banner.hidden, true);
});
test('pack failure shows its own error and re-enables both buttons', async () => {
  const d = buyDom({ options: [BREEZE] });
  d.win.fetch = () => Promise.resolve({ ok: false, status: 422, json: async () => ({ description: 'Sold out.' }) });
  bind(d.doc, d.win);
  d.packCta.listeners.click({ preventDefault() {} });
  await flush();
  assert.equal(d.packError.hidden, false);
  assert.equal(d.packError.textContent, 'Sold out.');
  assert.equal(d.packCta.disabled, false);
  assert.equal(d.button.disabled, false);
});
test('the form action is removed LAST in bind, after every listener is attached', () => {
  const d = buyDom({ options: [BREEZE] });
  bind(d.doc, d.win);
  assert.equal('action' in d.form.attrs, false);
  assert.equal(d.order.at(-1), 'remove:action');
  assert.ok(d.order.includes('listen:submit'));
  assert.ok(d.order.includes('win:pageshow'));
});
