import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankProductsByRelevance, pickRelevantProduct } from '../../agents/featured-product-injector/index.js';
import { classifyPostProduct } from '../../lib/posts.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ING = JSON.parse(readFileSync(join(ROOT, 'config', 'ingredients.json'), 'utf8'));

// The real catalogue shape, including the refill that has no ingredient spec and
// which won a tie on array order before this change.
const CATALOG = [
  { title: 'Foam Soap Refill | 32oz', handle: 'foam-soap-refill-32oz', tags: 'soap' },
  { title: 'Foaming Liquid Coconut Oil Soap | 8oz', handle: 'organic-foaming-hand-soap', tags: 'soap' },
  { title: 'Moisturizing Coconut Soap | 3.4oz', handle: 'coconut-soap', tags: 'soap' },
  { title: 'Natural Coconut Oil Lip Balm | 0.15oz | Four Pack', handle: 'coconut-oil-lip-balm', tags: 'lip' },
  { title: 'Coconut Oil Toothpaste — Natural Oral Care, Fluoride Free', handle: 'coconut-oil-toothpaste', tags: '' },
  { title: 'Coconut Moisturizer | 4oz', handle: 'coconut-moisturizer', tags: '' },
];

const pick = (keyword, title, slug) => pickRelevantProduct(CATALOG, {
  keyword, title, ingredients: ING, postProductKey: classifyPostProduct(keyword, slug || ''),
});

test('a bar-soap post gets the BAR, not the 32oz refill (the array-order tie)', () => {
  const p = pick('coconut soap benefits', 'Coconut Oil Soap Benefits for Healthy, Clean Skin', 'coconut-soap-benefits');
  assert.equal(p.handle, 'coconut-soap');
});

test('"petroleum jelly for LIPS" resolves to the lip balm (the plural gap)', () => {
  // Every product scored 0 before singularize + category match, so the post got
  // NO buy box at all.
  const p = pick('petroleum jelly for lips', 'Petroleum Jelly for Lips: Better Natural Options', 'petroleum-jelly-for-lips');
  assert.ok(p, 'must not decline to inject');
  assert.equal(p.handle, 'coconut-oil-lip-balm');
});

test('a toothpaste post still gets toothpaste', () => {
  const p = pick('can you use coconut oil as toothpaste', 'Can You Use Coconut Oil as Toothpaste?', 'can-you-use-coconut-oil-as-toothpaste');
  assert.equal(p.handle, 'coconut-oil-toothpaste');
});

test('a lip balm post gets the lip balm', () => {
  const p = pick('organic lip balm', 'Best Organic Lip Balm: What to Look For', 'organic-lip-balm');
  assert.equal(p.handle, 'coconut-oil-lip-balm');
});

test('the refill can never win a category tie — it has no ingredient spec', () => {
  const ranked = rankProductsByRelevance(CATALOG, {
    keyword: 'coconut soap benefits', title: '', ingredients: ING, postProductKey: 'bar_soap',
  });
  assert.equal(ranked[0].product.handle, 'coconut-soap');
  assert.equal(ranked.find((r) => r.product.handle === 'foam-soap-refill-32oz').categoryMatch, false);
});

test('with no category signal it falls back to pure token relevance (unchanged)', () => {
  const ranked = rankProductsByRelevance(CATALOG, { keyword: 'toothpaste', title: '' });
  assert.equal(ranked[0].product.handle, 'coconut-oil-toothpaste');
});

test('a genuinely irrelevant post still gets nothing rather than a random product', () => {
  assert.equal(pick('how to build a birdhouse', 'Birdhouse Guide', 'birdhouse'), null);
});
