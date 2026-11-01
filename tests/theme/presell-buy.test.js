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

// ── Fake DOM for bind(): elements keyed by selector ──────────────────────────
function el(attrs = {}) {
  return {
    attrs: { ...attrs }, listeners: {}, hidden: false, disabled: false, textContent: '', value: attrs.value ?? '',
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
    setAttribute(n, v) { this.attrs[n] = String(v); },
    hasAttribute(n) { return n in this.attrs; },
    removeAttribute(n) { delete this.attrs[n]; },
    addEventListener(n, f) { this.listeners[n] = f; },
  };
}
const BUY_TEMPLATES = {
  'data-presell-template': 'Get Coconut Breeze, $28',
  'data-presell-template-multi': 'Get 2 jars of Coconut Breeze, $56',
  'data-presell-template-pack': 'Get 4 jars of Coconut Breeze, $84',
};
function buyDom({ options, selected = 0, max = '3' }) {
  const opts = options.map((o) => el(o));
  const select = el(); select.options = opts; select.selectedIndex = selected;
  Object.defineProperty(select, 'value', { get() { return opts[this.selectedIndex].attrs.value; } });
  const button = el({ 'data-presell-label': '', ...BUY_TEMPLATES });
  const priceLine = el({ 'data-presell-label': '', 'data-presell-template': '$28 for one jar',
    'data-presell-template-multi': '$56 for 2 jars', 'data-presell-template-pack': '$84 for 4 jars (1 free)' });
  // Sticky bar and mid-page CTA carry only the per-jar template and follow the buy button.
  const sticky = el({ 'data-presell-label': '', 'data-presell-template': 'Get Coconut Breeze, $28', 'data-presell-follow': '' });
  const midCta = el({ 'data-presell-label': '', 'data-presell-template': 'Get Coconut Breeze, $28', 'data-presell-follow': '' });
  const title = el({ 'data-presell-label': '', 'data-presell-template': 'Coconut Breeze Moisturizing Body Cream, 4oz' });
  const compare = el(); compare.hidden = true;
  const errorEl = el(); errorEl.hidden = true;
  const stepper = el({ 'data-max': max });
  const dec = el(), inc = el(), out = el(), qtyInput = el({ value: '1' });
  const badge = el(); badge.hidden = true;
  const freeNote = el(); freeNote.hidden = true;
  const form = el({
    action: '/cart/add', 'data-price-token': '$28', 'data-scent-token': 'Coconut Breeze',
    'data-quantity-token': '2', 'data-total-token': '$56', 'data-pack-price-token': '$84', 'data-pack-count': '4',
  });
  const order = [];
  const origAdd = form.addEventListener.bind(form);
  form.addEventListener = (n, f) => { order.push(`listen:${n}`); origAdd(n, f); };
  const origRemove = form.removeAttribute.bind(form);
  form.removeAttribute = (n) => { order.push(`remove:${n}`); origRemove(n); };
  const inForm = {
    'select[name=id]': select, '[data-presell-submit]': button, '[data-presell-error]': errorEl,
    '[data-presell-qty]': stepper, '[data-presell-qty-dec]': dec, '[data-presell-qty-inc]': inc,
    '[data-presell-qty-value]': out, 'input[name=quantity]': qtyInput,
    '[data-presell-pack-badge]': badge, '[data-presell-qty-free]': freeNote,
  };
  form.querySelector = (q) => inForm[q] || null;
  const inDoc = { 'form[data-presell-buy]': form, '[data-presell-compare]': compare };
  const doc = {
    querySelector: (q) => inDoc[q] || null,
    querySelectorAll: (q) => (q === '[data-presell-label][data-presell-template]' ? [midCta, title, priceLine, button, sticky] : []),
  };
  const fetched = [];
  const win = el();
  const winAdd = win.addEventListener.bind(win);
  win.addEventListener = (n, f) => { order.push(`win:${n}`); winAdd(n, f); };
  win.fetch = (u, o) => { fetched.push(JSON.parse(o.body)); return Promise.resolve(ok); };
  win.location = { href: '' };
  return { doc, win, form, select, button, priceLine, sticky, midCta, title, compare, errorEl, stepper, dec, inc, out, qtyInput, badge, freeNote, fetched, order };
}
const BREEZE = { value: '44179428475050', 'data-scent': 'Coconut Breeze', 'data-price': '$28', 'data-price-cents': '2800',
  'data-pack-id': '67602073387178', 'data-pack-price': '$84', 'data-pack-cents': '8400' };
const UNSCENTED_NOPACK = { value: '45828182114474', 'data-scent': 'Pure Unscented', 'data-price': '$27.50', 'data-price-cents': '2750' };
const flush = () => new Promise((r) => setTimeout(r, 5));
const click = (b) => b.listeners.click({ preventDefault() {} });
const submit = async (d) => { d.form.listeners.submit({ preventDefault() {} }); await flush(); };
const choose = (d, i) => { d.select.selectedIndex = i; d.select.listeners.change(); };

test('stepper 1-3 without a pack: bounds, disabled ends, label and price x qty with cents', () => {
  const d = buyDom({ options: [UNSCENTED_NOPACK] });
  bind(d.doc, d.win);
  assert.equal(d.out.textContent, '1');
  assert.equal(d.dec.disabled, true);
  assert.equal(d.button.textContent, 'Get Pure Unscented, $27.50');
  click(d.inc);
  assert.equal(d.out.textContent, '2');
  assert.equal(d.qtyInput.value, '2');
  assert.equal(d.button.textContent, 'Get 2 jars of Pure Unscented, $55');
  assert.equal(d.priceLine.textContent, '$55 for 2 jars');
  click(d.inc); click(d.inc);
  assert.equal(d.out.textContent, '3', 'max 3 without a pack');
  assert.equal(d.inc.disabled, true);
  assert.equal(d.button.textContent, 'Get 3 jars of Pure Unscented, $82.50');
  assert.equal(d.badge.hidden, true, 'no badge without a pack');
  assert.equal(d.freeNote.hidden, true, 'no free-jar note without a pack');
});

test('with an honest pack: max 4, badge shown, "add a 4th" note at 3, pack price and strike-through at 4', () => {
  const d = buyDom({ options: [BREEZE] });
  bind(d.doc, d.win);
  assert.equal(d.badge.hidden, false);
  assert.equal(d.freeNote.hidden, true, 'qty 1');
  assert.equal(d.compare.hidden, true);
  click(d.inc); click(d.inc);
  assert.equal(d.out.textContent, '3');
  assert.equal(d.inc.disabled, false, 'a 4th is allowed');
  assert.equal(d.freeNote.hidden, false, 'qty 3 invites the free 4th');
  assert.equal(d.button.textContent, 'Get 3 jars of Coconut Breeze, $84');
  click(d.inc);
  assert.equal(d.out.textContent, '4');
  assert.equal(d.inc.disabled, true);
  assert.equal(d.freeNote.hidden, true, 'qty 4 has it');
  assert.equal(d.button.textContent, 'Get 4 jars of Coconut Breeze, $84');
  assert.equal(d.priceLine.textContent, '$84 for 4 jars (1 free)');
  assert.equal(d.compare.hidden, false);
  assert.equal(d.compare.textContent, '$112', 'four singles, struck through');
  click(d.inc);
  assert.equal(d.out.textContent, '4', 'max is 4');
  click(d.dec);
  assert.equal(d.compare.hidden, true);
  assert.equal(d.button.textContent, 'Get 3 jars of Coconut Breeze, $84');
});

test('a pack priced over three singles is not offered: max 3, no badge', () => {
  const d = buyDom({ options: [{ ...BREEZE, 'data-pack-cents': '8401', 'data-pack-price': '$84.01' }] });
  bind(d.doc, d.win);
  assert.equal(d.badge.hidden, true);
  click(d.inc); click(d.inc); click(d.inc);
  assert.equal(d.out.textContent, '3');
  assert.equal(d.freeNote.hidden, true);
});

test('quantities 1-3 post the single jar with the quantity', async () => {
  for (const n of [1, 2, 3]) {
    const d = buyDom({ options: [BREEZE] });
    bind(d.doc, d.win);
    for (let i = 1; i < n; i++) click(d.inc);
    await submit(d);
    assert.deepEqual(d.fetched, [{ items: [{ id: 44179428475050, quantity: n }] }], `qty ${n}`);
    assert.equal(d.win.location.href, '/checkout');
  }
});

test('quantity 4 posts the scent\'s 4-pack variant with quantity 1', async () => {
  const d = buyDom({ options: [BREEZE] });
  bind(d.doc, d.win);
  click(d.inc); click(d.inc); click(d.inc);
  await submit(d);
  assert.deepEqual(d.fetched, [{ items: [{ id: 67602073387178, quantity: 1 }] }]);
  assert.equal(d.win.location.href, '/checkout');
});

test('switching from 4 to a scent without a pack drops to 3 and relabels as singles', async () => {
  const d = buyDom({ options: [BREEZE, UNSCENTED_NOPACK] });
  bind(d.doc, d.win);
  click(d.inc); click(d.inc); click(d.inc);
  assert.equal(d.out.textContent, '4');
  choose(d, 1);
  assert.equal(d.out.textContent, '3');
  assert.equal(d.qtyInput.value, '3');
  assert.equal(d.inc.disabled, true);
  assert.equal(d.badge.hidden, true);
  assert.equal(d.compare.hidden, true);
  assert.equal(d.button.textContent, 'Get 3 jars of Pure Unscented, $82.50');
  await submit(d);
  assert.deepEqual(d.fetched, [{ items: [{ id: 45828182114474, quantity: 3 }] }]);
});

test('the sticky bar and mid-page CTA follow the buy button\'s quantity and price', () => {
  const d = buyDom({ options: [BREEZE] });
  bind(d.doc, d.win);
  assert.equal(d.sticky.textContent, 'Get Coconut Breeze, $28');
  click(d.inc);
  assert.equal(d.sticky.textContent, 'Get 2 jars of Coconut Breeze, $56');
  assert.equal(d.midCta.textContent, 'Get 2 jars of Coconut Breeze, $56');
  click(d.inc); click(d.inc);
  assert.equal(d.sticky.textContent, 'Get 4 jars of Coconut Breeze, $84');
  assert.equal(d.title.textContent, 'Coconut Breeze Moisturizing Body Cream, 4oz', 'no multi template, stays');
});

test('double-tap protection and failure recovery on the buy button', async () => {
  const d = buyDom({ options: [BREEZE] });
  d.win.fetch = (u, o) => { d.fetched.push(JSON.parse(o.body)); return Promise.resolve({ ok: false, status: 422, json: async () => ({ description: 'Sold out.' }) }); };
  bind(d.doc, d.win);
  d.form.listeners.submit({ preventDefault() {} });
  assert.equal(d.button.disabled, true);
  d.form.listeners.submit({ preventDefault() {} });
  await flush();
  assert.equal(d.fetched.length, 1);
  assert.equal(d.errorEl.hidden, false);
  assert.equal(d.errorEl.textContent, 'Sold out.');
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

for (const bad of ['', 'abc', '0']) {
  test(`stepper base max falls back to 3 when data-max is ${JSON.stringify(bad)}`, () => {
    const d = buyDom({ options: [UNSCENTED_NOPACK], max: bad });
    bind(d.doc, d.win);
    click(d.inc); click(d.inc); click(d.inc);
    assert.equal(d.out.textContent, '3');
    assert.equal(d.inc.disabled, true);
  });
}
