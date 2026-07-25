import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  foldRow, finalize, protectedQueries, priceMismatchedQueries,
  convertingQueries, isBrandQuery,
} from '../../lib/amazon-sqp.js';

function row(query, { vol = 100, ourClicks = 0, ourPurch = 0, mktPurch = 0, price = null } = {}) {
  return {
    searchQueryData: { searchQuery: query, searchQueryVolume: vol },
    impressionData: { asinImpressionCount: 10 },
    clickData: { asinClickCount: ourClicks, totalClickCount: 50 },
    cartAddData: { asinCartAddCount: 0 },
    purchaseData: {
      asinPurchaseCount: ourPurch,
      totalPurchaseCount: mktPurch,
      totalMedianPurchasePrice: price === null ? null : { amount: price, currencyCode: 'USD' },
    },
  };
}

function build(rows) {
  const acc = new Map();
  for (const r of rows) foldRow(acc, r);
  return finalize(acc);
}

test('foldRow sums across weeks and averages the median price', () => {
  const rows = build([
    row('coconut lotion', { vol: 100, ourClicks: 2, mktPurch: 1000, price: 10 }),
    row('coconut lotion', { vol: 200, ourClicks: 3, mktPurch: 1500, price: 12 }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].volume, 300);
  assert.equal(rows[0].ourClicks, 5);
  assert.equal(rows[0].marketPurchases, 2500);
  assert.equal(rows[0].marketPrice, 11);
});

test('rows with no purchase price survive with marketPrice null', () => {
  const rows = build([row('obscure query', { price: null })]);
  assert.equal(rows[0].marketPrice, null);
});

test('isBrandQuery catches brand variants including misspellings we have seen', () => {
  for (const q of ['real skin care', 'realskincare', 'real lotion', 'real cocanut lotion', 'REAL SKIN CARE LOTION']) {
    assert.equal(isBrandQuery(q), true, q);
  }
  for (const q of ['coconut lotion', 'organic body lotion', 'nivea']) {
    assert.equal(isBrandQuery(q), false, q);
  }
});

test('priceMismatchedQueries flags a 3x price gap with a real market behind it', () => {
  const rows = build([row('coconut lotion', { vol: 39000, mktPurch: 2700, price: 10.08 })]);
  const out = priceMismatchedQueries(rows, { ourPrice: 30 });
  assert.equal(out.length, 1);
  assert.equal(out[0].query, 'coconut lotion');
  assert.ok(out[0].priceRatio < 0.4);
});

test('priceMismatchedQueries NEVER flags a query that produced a sale', () => {
  // Same brutal price gap, but it sold for us — must be protected.
  const rows = build([row('coconut lotion', { vol: 39000, mktPurch: 2700, ourPurch: 1, price: 10.08 })]);
  assert.equal(priceMismatchedQueries(rows, { ourPrice: 30 }).length, 0);
});

test('priceMismatchedQueries never flags brand queries regardless of price', () => {
  const rows = build([row('real skin care', { vol: 5000, mktPurch: 500, price: 5 })]);
  assert.equal(priceMismatchedQueries(rows, { ourPrice: 30 }).length, 0);
});

test('priceMismatchedQueries ignores thin markets and low volume', () => {
  const thin = build([row('weird query', { vol: 5000, mktPurch: 3, price: 5 })]);
  assert.equal(priceMismatchedQueries(thin, { ourPrice: 30 }).length, 0);
  const lowVol = build([row('weird query', { vol: 10, mktPurch: 500, price: 5 })]);
  assert.equal(priceMismatchedQueries(lowVol, { ourPrice: 30 }).length, 0);
});

test('priceMismatchedQueries leaves queries priced near ours alone', () => {
  // $20.99 vs our $30 is 70% — above the 60% floor, still winnable.
  const rows = build([row('skin so soft', { vol: 34000, mktPurch: 2500, price: 20.99 })]);
  assert.equal(priceMismatchedQueries(rows, { ourPrice: 30 }).length, 0);
});

test('priceMismatchedQueries requires ourPrice', () => {
  assert.throws(() => priceMismatchedQueries([], {}), /ourPrice is required/);
});

test('protectedQueries returns every query that sold, normalised', () => {
  const rows = build([
    row('  Coconut  Lotion ', { ourPurch: 2 }),
    row('never sold', { ourPurch: 0 }),
  ]);
  const p = protectedQueries(rows);
  assert.ok(p.has('coconut lotion'));
  assert.equal(p.has('never sold'), false);
});

test('convertingQueries ranks by our sales and can exclude brand', () => {
  const rows = build([
    row('real skin care', { ourPurch: 4 }),
    row('organic coconut lotion non-greasy', { ourPurch: 2 }),
    row('no sales', { ourPurch: 0 }),
  ]);
  assert.deepEqual(convertingQueries(rows).map((r) => r.ourPurchases), [4, 2]);
  const nonBrand = convertingQueries(rows, { includeBrand: false });
  assert.equal(nonBrand.length, 1);
  assert.equal(nonBrand[0].query, 'organic coconut lotion non-greasy');
});
