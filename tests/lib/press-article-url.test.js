import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pitchPageReason } from '../../lib/press-article-url.js';

test('the three 2026-10-05 link-gap homepages are refused', () => {
  for (const u of ['https://adlibrary.com/', 'https://promizi.com/', 'https://searchlabz.com']) {
    assert.match(pitchPageReason(u), /homepage/, u);
  }
});

test('real editorial targets pass, including sections named shop and features', () => {
  for (const u of [
    'https://www.wired.com/gallery/best-natural-deodorants',
    'https://nymag.com/strategist/article/best-body-butters.html',
    'https://fortune.com/article/best-deodorants',
    'https://thedaleydose.com/non-toxic-body-lotion',
    'https://www.today.com/shop/best-coconut-oil-for-skin-rcna183439',
    'https://www.thegoodtrade.com/features/all-natural-body-lotion',
    'https://www.breastcancer.org/risk/risk-factors/antiperspirants',
  ]) assert.equal(pitchPageReason(u), null, u);
});

test('listing, product, pricing, signup and unparseable pages are refused', () => {
  assert.match(pitchPageReason('https://dermapproved.com/categories/body-care'), /listing/);
  assert.match(pitchPageReason('https://incidecoder.com/products/the-body-shop-coconut-body-lotion'), /product/);
  assert.match(pitchPageReason('https://tool.example/pricing'), /pricing/);
  assert.match(pitchPageReason('https://mag.example/join-premium-membership'), /signup/);
  assert.match(pitchPageReason(null), /no usable URL/);
  assert.match(pitchPageReason('not a url'), /no usable URL/);
});
