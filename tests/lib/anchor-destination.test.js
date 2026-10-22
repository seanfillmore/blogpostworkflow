import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { alignAnchorText, alignProductAnchors, productHandleOf } from '../../lib/anchor-destination.js';

// Every distinct live text measured on 2026-10-22, with what it must become.
const CASES = [
  ['natural bar soap collection', 'coconut-soap', 'natural bar soap'],
  ['natural deodorant collection', 'coconut-oil-deodorant', 'natural deodorant'],
  ["Real Skin Care's natural deodorant collection", 'coconut-oil-deodorant', "Real Skin Care's natural deodorant"],
  ['natural lip balm collection', 'coconut-oil-lip-balm', 'natural lip balm'],
  ['fluoride-free toothpaste collection', 'coconut-oil-toothpaste', 'fluoride-free toothpaste'],
  ['Real Skin Care Toothpaste Collection', 'coconut-oil-toothpaste', 'Real Skin Care Toothpaste'],
  ['Shop the Collection', 'coconut-oil-toothpaste', 'Shop the Toothpaste'],
  ['Browse Collection', 'coconut-soap', 'Browse the Bar Soap'],
  ['Browse Collection', 'coconut-lotion', 'Browse the Lotion'],
  ['Browse our SLS-free collection', 'coconut-oil-toothpaste', 'Browse our SLS-free toothpaste'],
  ['Real Skin Care collection', 'coconut-lotion', 'Real Skin Care lotion'],
  ['collection', 'coconut-oil-toothpaste', 'toothpaste'],
  ['full natural deodorant collection', 'coconut-oil-deodorant', 'natural deodorant'],
  ["Real Skin Care's full natural toothpaste collection", 'coconut-oil-toothpaste', "Real Skin Care's natural toothpaste"],
  ['Lip Balm Collection', 'coconut-oil-lip-balm', 'Lip Balm'],
  ['Browse our full collection of natural deodorants for kids and the whole family.', 'coconut-oil-deodorant',
    'Browse our natural deodorants for kids and the whole family.'],
];

test('every measured live text becomes text that matches the product', () => {
  for (const [from, handle, to] of CASES) assert.equal(alignAnchorText(from, handle), to, from);
});

test('unknown product, or text without "collection", is left alone', () => {
  assert.equal(alignAnchorText('Shop the Collection', 'some-new-product'), null);
  assert.equal(alignAnchorText('Shop Now', 'coconut-soap'), null);
  assert.equal(alignAnchorText('recollection of summer', 'coconut-soap'), null);
});

test('productHandleOf reads absolute, relative and collection-nested product links only', () => {
  assert.equal(productHandleOf('https://www.realskincare.com/products/coconut-soap'), 'coconut-soap');
  assert.equal(productHandleOf('/collections/x/products/coconut-soap?v=1'), 'coconut-soap');
  assert.equal(productHandleOf('/collections/natural-bar-soap'), null);
});

test('alignProductAnchors keeps attributes and inner tags, and skips JSON-LD and collection links', () => {
  const html = [
    '<p>Try our <a href="https://www.realskincare.com/products/coconut-soap" title="t">natural bar soap collection</a>.</p>',
    '<a style="x" href="/products/coconut-oil-toothpaste"><strong>Shop the Collection</strong></a>',
    '<a href="/collections/non-toxic-body-lotion">lotion collection</a>',
    '<script type="application/ld+json">{"a":"<a href=\\"/products/coconut-soap\\">bar soap collection</a>"}</script>',
  ].join('\n');
  const { html: out, changes } = alignProductAnchors(html);
  assert.equal(changes.length, 2);
  assert.match(out, /title="t">natural bar soap<\/a>/);
  assert.match(out, /<a style="x" href="\/products\/coconut-oil-toothpaste"><strong>Shop the Toothpaste<\/strong><\/a>/);
  assert.match(out, /lotion collection<\/a>/);
  assert.match(out, /bar soap collection<\/a>"\}/);
  assert.deepEqual(alignProductAnchors(out).changes, []);
});

test('onlyHrefs limits the change to the links just repointed', () => {
  const html = '<a href="/products/coconut-soap">soap collection</a> <a href="/products/coconut-lotion">lotion collection</a>';
  const { changes } = alignProductAnchors(html, { onlyHrefs: new Set(['/products/coconut-lotion']) });
  assert.deepEqual(changes.map((c) => c.href), ['/products/coconut-lotion']);
});

test('rewriteRedirectLinks retexts a link it repoints from a collection to a product', async () => {
  const { rewriteRedirectLinks } = await import('../../lib/redirect-links.js');
  const map = new Map([['/collections/natural-bar-soap', '/products/coconut-soap']]);
  const html = '<p><a href="https://www.realskincare.com/collections/natural-bar-soap">natural bar soap collection</a> and <a href="/products/coconut-lotion">lotion collection</a></p>';
  const r = rewriteRedirectLinks(html, map);
  assert.match(r.html, /products\/coconut-soap">natural bar soap<\/a>/);
  assert.match(r.html, /lotion collection<\/a>/, 'an anchor it did not repoint is not its business');
  assert.equal(r.retexted.length, 1);
});

test('shortProductName keeps the product name and drops the descriptor', async () => {
  const { shortProductName } = await import('../../lib/anchor-destination.js');
  assert.equal(shortProductName('Coconut Oil Toothpaste — Natural Oral Care, Fluoride Free'), 'Coconut Oil Toothpaste');
  assert.equal(shortProductName('Non-Toxic Body Lotion Made With Only 6 Clean Ingredients'), 'Non-Toxic Body Lotion');
  assert.equal(shortProductName('Best Coconut Oil Deodorant — All Natural Formula | 2oz'), 'Best Coconut Oil Deodorant');
  assert.equal(shortProductName('Coconut Moisturizer | 4oz'), 'Coconut Moisturizer');
  assert.equal(shortProductName('Coconut Lip Balm'), 'Coconut Lip Balm');
});

test('buyButtonText fixes title-derived labels only', async () => {
  const { buyButtonText } = await import('../../lib/anchor-destination.js');
  const t = 'Coconut Oil Toothpaste — Natural Oral Care, Fluoride Free';
  assert.equal(buyButtonText('Shop Coconut Oil Toothpaste — Natural Oral Care, Fluoride Fr →', t), 'Shop Coconut Oil Toothpaste →');
  assert.equal(buyButtonText('Shop Non-Toxic Body Lotion Made With Only 6 Clean Ingredient →', 'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients'), 'Shop Non-Toxic Body Lotion →');
  assert.equal(buyButtonText('Shop Now →', t), null);
  assert.equal(buyButtonText('Add to Cart', t), null);
  assert.equal(buyButtonText('Shop Coconut Oil Toothpaste →', t), null);
});

test('alignBuyButtons rewrites a truncated buy-box label from the live title', async () => {
  const { alignBuyButtons } = await import('../../lib/anchor-destination.js');
  const html = '<a href="https://www.realskincare.com/products/coconut-oil-toothpaste" style="background:#1e1b4b">Shop Coconut Oil Toothpaste — Natural Oral Care, Fluoride Fr →</a> <a href="/products/coconut-oil-toothpaste">Shop Now</a>';
  const { html: out, changes } = alignBuyButtons(html, new Map([['coconut-oil-toothpaste', 'Coconut Oil Toothpaste — Natural Oral Care, Fluoride Free']]));
  assert.equal(changes.length, 1);
  assert.match(out, /background:#1e1b4b">Shop Coconut Oil Toothpaste →<\/a>/);
  assert.match(out, />Shop Now<\/a>/);
});
