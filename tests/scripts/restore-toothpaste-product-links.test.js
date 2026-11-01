import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restoreFromBackup } from '../../scripts/restore-toothpaste-product-links-2026-10-03.mjs';

const W = 'https://www.realskincare.com/blogs/news/can-you-use-coconut-oil-as-toothpaste';

test('restores only anchors that were product links before the rewrite', () => {
  const backup = `<a href="https://www.realskincare.com/products/coconut-oil-toothpaste">Add to Cart</a>
<a href="/blogs/news/can-you-use-coconut-oil-as-toothpaste">guide</a>
<a href="/collections/best-sellers/products/coconut-oil-toothpaste">Shop</a>`;
  const current = `<a href="${W}">Add to Cart</a>
<a href="/blogs/news/can-you-use-coconut-oil-as-toothpaste">guide</a>
<a href="/blogs/news/can-you-use-coconut-oil-as-toothpaste">Shop</a>`;
  const r = restoreFromBackup(current, backup);
  assert.equal(r.restored, 2);
  assert.match(r.html, /href="https:\/\/www\.realskincare\.com\/products\/coconut-oil-toothpaste">Add to Cart/);
  assert.match(r.html, /href="\/blogs\/news\/can-you-use-coconut-oil-as-toothpaste">guide/, 'a link that always pointed at the post is untouched');
  assert.match(r.html, /href="\/products\/coconut-oil-toothpaste">Shop/);
});

test('matches by identity when links were added since, and leaves ambiguous identities alone', () => {
  const backup = `<a href="/products/coconut-oil-toothpaste" style="x">Add to Cart</a>
<a href="/products/coconut-oil-toothpaste">toothpaste</a><a href="${W}">toothpaste</a>`;
  const current = `<a href="/blogs/news/new">new link</a><a href="${W}" style="x">Add to Cart</a>
<a href="${W}">toothpaste</a><a href="${W}">toothpaste</a>`;
  const r = restoreFromBackup(current, backup);
  assert.equal(r.restored, 1, 'only the unambiguous buy button');
  assert.match(r.html, /href="https:\/\/www\.realskincare\.com\/products\/coconut-oil-toothpaste" style="x">Add to Cart/);
});

test('a buy button pointing at the blog post is restored even with no backup evidence', () => {
  const r = restoreFromBackup(`<a href="${W}" class="b">Add to Cart</a><a href="${W}">read the guide</a>`, '');
  assert.equal(r.restored, 1);
  assert.match(r.html, /read the guide/);
  assert.match(r.html, /can-you-use-coconut-oil-as-toothpaste">read the guide/);
});
