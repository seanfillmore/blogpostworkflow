import test from 'node:test';
import assert from 'node:assert/strict';

import { swapSoapItems } from '../../scripts/build-soap-collection-nav.mjs';

const SOAP = { title: 'Soap', type: 'COLLECTION', url: '/collections/soap', items: [] };

/** The live desktop menu as measured on 2026-09-02, before the swap. */
const desktopBefore = () => [
  { title: 'Lotion', url: '/products/coconut-lotion' },
  { title: 'Body Cream', url: '/products/coconut-moisturizer' },
  { title: 'Toothpaste', url: '/products/coconut-oil-toothpaste' },
  { title: 'Deodorant', url: '/products/coconut-oil-deodorant' },
  { title: 'Liquid Soap', url: '/products/organic-foaming-hand-soap' },
  { title: 'Bar Soap', url: '/products/coconut-soap' },
  { title: 'Lip Balm', url: '/products/coconut-oil-lip-balm' },
  { title: 'Sets & Bundles', url: '/collections/sets-and-bundles' },
];

test('Soap lands where the first soap link sat, not at the end of the menu', () => {
  const out = swapSoapItems(desktopBefore(), SOAP);
  assert.deepEqual(out.map((i) => i.title), [
    'Lotion', 'Body Cream', 'Toothpaste', 'Deodorant',
    'Soap', 'Lip Balm', 'Sets & Bundles',
  ]);
  // Appending would push soap behind Lip Balm and Sets & Bundles. Position is
  // the whole point: soap sits between Deodorant and Lip Balm.
  assert.equal(out[4].url, '/collections/soap');
});

test('both soap PDP links are removed', () => {
  const out = swapSoapItems(desktopBefore(), SOAP);
  const urls = out.map((i) => i.url);
  assert.ok(!urls.includes('/products/organic-foaming-hand-soap'));
  assert.ok(!urls.includes('/products/coconut-soap'));
});

test('re-running is idempotent — it never leaves two Soap links', () => {
  const once = swapSoapItems(desktopBefore(), SOAP);
  const twice = swapSoapItems(once, SOAP);
  assert.deepEqual(twice.map((i) => i.title), once.map((i) => i.title));
  assert.equal(twice.filter((i) => i.url === '/collections/soap').length, 1);
});

test('a menu with no soap links gets Soap appended rather than silently skipped', () => {
  const out = swapSoapItems([{ title: 'About Us', url: '/pages/about-us-1' }], SOAP);
  assert.deepEqual(out.map((i) => i.title), ['About Us', 'Soap']);
});

test('non-soap items keep their order and their fields', () => {
  const out = swapSoapItems(desktopBefore(), SOAP);
  const lotion = out.find((i) => i.title === 'Lotion');
  assert.equal(lotion.url, '/products/coconut-lotion');
  assert.equal(out.at(-1).title, 'Sets & Bundles');
});

test('an absolute URL for a soap PDP is matched too, not just the relative path', () => {
  const out = swapSoapItems([
    { title: 'Bar Soap', url: 'https://www.realskincare.com/products/coconut-soap' },
    { title: 'Lip Balm', url: '/products/coconut-oil-lip-balm' },
  ], SOAP);
  assert.deepEqual(out.map((i) => i.title), ['Soap', 'Lip Balm']);
});
