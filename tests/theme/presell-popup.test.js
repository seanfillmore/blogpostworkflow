// tests/theme/presell-popup.test.js
//
// The pre-sell page (sections/presell-listicle.liquid) is paid ad traffic with
// one job, so the site's Klaviyo "30% off your first order" popup is switched
// off on this page only (Sean, 2026-10-19). Klaviyo's Forms API cannot edit a
// form's display targeting, so it is done here: presell.css hides Klaviyo POPUP
// and FLYOUT dialogs on arrival, and presell-buy.js's blockPopups() closes them
// through Klaviyo's own close button (so Klaviyo releases its scroll lock) on
// its `klaviyoForms` open event, with a MutationObserver as the fallback.
//
// Measured on live 2026-10-19: div[role=dialog][aria-label="POPUP Form"] >
// ... > div[data-testid=POPUP] > ... > form[data-testid=klaviyo-form-UHDGhw],
// close button button.klaviyo-close-form, scroll lock = body class
// klaviyo-prevent-body-scrolling.
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const mod = { exports: {} };
new Function('module', readFileSync(new URL('../../theme/assets/presell-buy.js', import.meta.url), 'utf8'))(mod);
const { blockPopups } = mod.exports;
const css = readFileSync(new URL('../../theme/assets/presell.css', import.meta.url), 'utf8');

// ── A tiny DOM: enough of closest / querySelector(All) / classList ───────────
function node(tag, attrs = {}, children = []) {
  const n = {
    tag, attrs: { ...attrs }, children: [], parent: null, clicks: 0, style: {},
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    click() { this.clicks++; if (this.onclick) this.onclick(); },
  };
  for (const c of children) { c.parent = n; n.children.push(c); }
  return n;
}
function matches(n, sel) {
  return sel.split(',').some((one) => {
    const s = one.trim();
    if (s === '.klaviyo-close-form') return (n.attrs.class || '').split(/\s+/).includes('klaviyo-close-form');
    let m = s.match(/^\[data-testid="(\w+)"\]$/);
    if (m) return n.attrs['data-testid'] === m[1];
    m = s.match(/^div\[role="dialog"\]$/);
    if (m) return n.tag === 'div' && n.attrs.role === 'dialog';
    throw new Error(`stub selector not supported: ${s}`);
  });
}
function all(root, sel, out = []) {
  for (const c of root.children) { if (matches(c, sel)) out.push(c); all(c, sel, out); }
  return out;
}
function wire(n) {
  n.querySelectorAll = (sel) => all(n, sel);
  n.querySelector = (sel) => all(n, sel)[0] || null;
  n.closest = (sel) => { let e = n; while (e) { if (matches(e, sel)) return e; e = e.parent; } return null; };
  n.children.forEach(wire);
  return n;
}
function classList(initial) {
  const set = new Set(initial);
  return { contains: (c) => set.has(c), remove: (c) => set.delete(c), add: (c) => set.add(c), has: set };
}

/** Klaviyo popup exactly as measured on live; close releases the lock like Klaviyo does. */
function klaviyoDialog(kind, body) {
  const close = node('button', { class: 'klaviyo-close-form go1', 'aria-label': 'Close dialog' });
  const dialog = node('div', { role: 'dialog', 'aria-label': `${kind} Form` }, [
    node('div', {}, [node('div', { 'data-testid': kind }, [node('form', { 'data-testid': 'klaviyo-form-UHDGhw' }), close])]),
  ]);
  // Like Klaviyo: closing removes the dialog and releases the scroll lock.
  close.onclick = () => {
    if (dialog.parent) dialog.parent.children = dialog.parent.children.filter((c) => c !== dialog);
    body.classList.remove('klaviyo-prevent-body-scrolling');
  };
  return { dialog, close };
}

function page({ withPopup = null, lockedButNoClose = false } = {}) {
  const body = node('body');
  body.classList = classList(withPopup || lockedButNoClose ? ['template-page', 'klaviyo-prevent-body-scrolling'] : ['template-page']);
  const themeClose = node('button', { class: 'klaviyo-close-form' }); // a decoy inside a theme dialog
  const cart = node('div', { role: 'dialog', 'aria-label': 'Your Cart', class: 'ocu-cart-drawer' }, [themeClose]);
  const search = node('div', { role: 'dialog', 'aria-label': 'Search our site' }, [node('button', { class: 'modal__close' })]);
  const embedClose = node('button', { class: 'klaviyo-close-form' });
  const embed = node('div', { class: 'klaviyo-form-Xr4S7X' }, [node('form', { 'data-testid': 'klaviyo-form-Xr4S7X' }), embedClose]);
  body.children.push(cart, search, embed); cart.parent = search.parent = embed.parent = body;
  let popup = null;
  if (withPopup) { popup = klaviyoDialog(withPopup, body); body.children.push(popup.dialog); popup.dialog.parent = body; }
  wire(body);
  const html = node('html'); html.style = {};
  const listeners = {};
  const observers = [];
  const win = {
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    MutationObserver: class { constructor(cb) { this.cb = cb; observers.push(this); } observe(target, opts) { this.target = target; this.opts = opts; } },
    setTimeout: (fn) => fn(),
  };
  const doc = { body, documentElement: html, querySelector: (s) => body.querySelector(s), querySelectorAll: (s) => body.querySelectorAll(s) };
  const addPopup = (kind) => { const p = klaviyoDialog(kind, body); body.children.push(p.dialog); p.dialog.parent = body; wire(p.dialog); body.classList.add('klaviyo-prevent-body-scrolling'); return p; };
  const fire = (type, detail) => (listeners[type] || []).forEach((fn) => fn({ detail }));
  const mutate = () => observers.forEach((o) => o.cb([{ addedNodes: [] }]));
  return { body, html, doc, win, popup, themeClose, embedClose, listeners, observers, addPopup, fire, mutate };
}

test('a Klaviyo open event closes the popup through its own close button', () => {
  const p = page();
  blockPopups(p.doc, p.win);
  const pop = p.addPopup('POPUP');
  p.fire('klaviyoForms', { type: 'open', formId: 'UHDGhw' });
  assert.equal(pop.close.clicks, 1);
  assert.equal(p.body.classList.contains('klaviyo-prevent-body-scrolling'), false, 'scroll lock released');
});

test('the MutationObserver fallback closes a popup or flyout that appears without an event', () => {
  for (const kind of ['POPUP', 'FLYOUT']) {
    const p = page();
    blockPopups(p.doc, p.win);
    assert.equal(p.observers.length, 1);
    assert.equal(p.observers[0].target, p.body);
    assert.deepEqual(p.observers[0].opts, { childList: true, subtree: true });
    const pop = p.addPopup(kind);
    p.mutate();
    assert.equal(pop.close.clicks, 1, kind);
  }
});

test('a popup already open when the script binds is closed at once', () => {
  const p = page({ withPopup: 'POPUP' });
  blockPopups(p.doc, p.win);
  assert.equal(p.popup.close.clicks, 1);
});

test('theme dialogs and the embedded Klaviyo form are never touched', () => {
  const p = page();
  blockPopups(p.doc, p.win);
  p.addPopup('POPUP');
  p.fire('klaviyoForms', { type: 'open', formId: 'UHDGhw' });
  p.mutate();
  p.fire('klaviyoForms', { type: 'open', formId: 'Xr4S7X' });
  assert.equal(p.themeClose.clicks, 0, 'a close button inside the cart drawer');
  assert.equal(p.embedClose.clicks, 0, 'the embedded signup form');
});

test('other klaviyoForms events (viewedStep, close, submit) do nothing', () => {
  const p = page();
  blockPopups(p.doc, p.win);
  const pop = p.addPopup('POPUP');
  for (const type of ['viewedStep', 'close', 'submit']) p.fire('klaviyoForms', { type, formId: 'UHDGhw' });
  assert.equal(pop.close.clicks, 0);
});

test('the scroll lock is removed even if Klaviyo does not release it on close', () => {
  const p = page();
  blockPopups(p.doc, p.win);
  const pop = p.addPopup('POPUP');
  pop.close.onclick = null; // Klaviyo kept the lock
  p.body.style.overflow = 'hidden';
  p.html.style.overflow = 'hidden';
  p.fire('klaviyoForms', { type: 'open', formId: 'UHDGhw' });
  assert.equal(p.body.classList.contains('klaviyo-prevent-body-scrolling'), false);
  assert.equal(p.body.style.overflow, '');
  assert.equal(p.html.style.overflow, '');
});

test('without a Klaviyo lock, an overflow the theme set (cart drawer) is left alone', () => {
  const p = page();
  p.body.style.overflow = 'hidden';
  blockPopups(p.doc, p.win);
  p.mutate();
  assert.equal(p.body.style.overflow, 'hidden');
});

test('a popup that stays open is clicked again on a timer, at most 5 times in all', () => {
  const p = page();
  const timers = [];
  p.win.setTimeout = (fn, ms) => { timers.push(ms); fn(); };
  blockPopups(p.doc, p.win);
  const pop = p.addPopup('POPUP');
  pop.close.onclick = null; // Klaviyo ignores the click (e.g. not mounted yet)
  p.fire('klaviyoForms', { type: 'open', formId: 'UHDGhw' });
  p.mutate(); p.mutate();
  assert.equal(pop.close.clicks, 5);
  assert.ok(timers.length >= 4 && timers.every((ms) => ms >= 300), `retry delays ${timers}`);
});

test('once a popup closes, no further clicks are made', () => {
  const p = page();
  blockPopups(p.doc, p.win);
  const pop = p.addPopup('POPUP');
  pop.close.onclick = () => { // Klaviyo removes the dialog on close
    p.body.children = p.body.children.filter((c) => c !== pop.dialog);
    p.body.classList.remove('klaviyo-prevent-body-scrolling');
  };
  p.fire('klaviyoForms', { type: 'open', formId: 'UHDGhw' });
  p.mutate();
  assert.equal(pop.close.clicks, 1);
});

test('presell.css hides Klaviyo POPUP/FLYOUT dialogs on arrival and never locks scrolling', () => {
  for (const kind of ['POPUP', 'FLYOUT']) {
    assert.ok(css.includes(`div[role="dialog"][aria-label="${kind} Form"]`), `${kind} dialog selector`);
  }
  const rule = css.match(/div\[role="dialog"\]\[aria-label="POPUP Form"\][^{]*{([^}]*)}/);
  // NOT display:none: measured on live 2026-10-19, Klaviyo ignores a click on
  // its close button while the dialog is display:none, so the popup would stay
  // open (invisibly) with the scroll lock on. Invisible and inert instead.
  assert.ok(rule && /visibility:\s*hidden\s*!important/.test(rule[1]) && /opacity:\s*0\s*!important/.test(rule[1])
    && /pointer-events:\s*none\s*!important/.test(rule[1]), rule && rule[1]);
  assert.ok(!/display:\s*none/.test(rule[1]), 'display:none blocks Klaviyo\'s close');
  assert.match(css, /body\.klaviyo-prevent-body-scrolling\s*{[^}]*overflow-y:\s*auto\s*!important/);
  // Only Klaviyo's own dialog labels: nothing that matches the cart drawer,
  // search, or an embedded form.
  assert.ok(!/klaviyo-form-Xr4S7X|\[role="dialog"\]\s*{|ocu-cart|Your Cart/.test(css));
});
