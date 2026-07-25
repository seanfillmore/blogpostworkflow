import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { negativeBlocks, findConflicts, findMissingDemand, buildMarkdown } from '../../agents/shopping-calibrator/index.js';

test('negativeBlocks mirrors Google match semantics', () => {
  assert.equal(negativeBlocks('natural lotion for stretch marks', 'stretch marks', 'PHRASE'), true);
  assert.equal(negativeBlocks('natural lotion for stretch marks', 'stretch marks', 'BROAD'), true);
  assert.equal(negativeBlocks('natural lotion for stretch marks', 'stretch marks', 'EXACT'), false);
  assert.equal(negativeBlocks('stretch marks', 'stretch marks', 'EXACT'), true);
  // BROAD needs every word present, order-independent
  assert.equal(negativeBlocks('marks stretch cream', 'stretch marks', 'BROAD'), true);
  assert.equal(negativeBlocks('coconut lotion', 'stretch marks', 'BROAD'), false);
  assert.equal(negativeBlocks('anything', '', 'PHRASE'), false);
});

test('findConflicts catches a negative blocking a query that sold', () => {
  // The real 2026-07-25 case: BROAD "stretch marks" was blocking a sale.
  const rows = [
    { query: 'natural lotion for stretch marks', ourPurchases: 1 },
    { query: 'coconut lotion', ourPurchases: 0 },
  ];
  const conflicts = findConflicts(rows, [['stretch marks', 'BROAD'], ['nivea', 'PHRASE']]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].query, 'natural lotion for stretch marks');
  assert.equal(conflicts[0].sales, 1);
});

test('findConflicts is silent when negatives only block non-converting queries', () => {
  const rows = [{ query: 'nivea body lotion', ourPurchases: 0 }];
  assert.equal(findConflicts(rows, [['nivea', 'PHRASE']]).length, 0);
});

test('findMissingDemand surfaces converting non-brand queries we have no impressions for', () => {
  const rows = [
    { query: 'paraben chemical free body lotion', ourPurchases: 1, volume: 1 },
    { query: 'organic coconut lotion non-greasy', ourPurchases: 2, volume: 6 },
    { query: 'real skin care', ourPurchases: 4, volume: 235 },
    { query: 'never sold', ourPurchases: 0, volume: 900 },
  ];
  const missing = findMissingDemand(rows, new Set(['paraben chemical free body lotion']));
  // brand excluded, already-seen excluded, non-converting excluded
  assert.deepEqual(missing.map((r) => r.query), ['organic coconut lotion non-greasy']);
});

test('findMissingDemand normalises when comparing against Google search terms', () => {
  const rows = [{ query: 'Organic Coconut Lotion', ourPurchases: 2, volume: 10 }];
  assert.equal(findMissingDemand(rows, new Set(['organic  coconut lotion'])).length, 0);
});

test('buildMarkdown renders every section and reports the brand share', () => {
  const md = buildMarkdown({
    waste: [{ query: 'coconut lotion', volume: 39121, marketPurchases: 2749, marketPrice: 10.08, priceRatio: 0.336 }],
    missing: [{ query: 'paraben chemical free body lotion', ourPurchases: 1, volume: 1, marketPrice: 21.99 }],
    conflicts: [{ query: 'natural lotion for stretch marks', sales: 1, blockedBy: [['stretch marks', 'BROAD']] }],
    converting: [
      { query: 'real skin care', ourPurchases: 6 },
      { query: 'organic coconut lotion non-greasy', ourPurchases: 4 },
    ],
    weeks: 7, ourPrice: 30, applied: true,
  }, '2026-07-25');

  assert.match(md, /Shopping Calibrator — 2026-07-25/);
  assert.match(md, /coconut lotion/);
  assert.match(md, /\$10\.08/);
  assert.match(md, /stretch marks/);
  assert.match(md, /6 \(60%\) came from brand queries/); // 6 of 10
  assert.match(md, /Added as negatives\./);
});

test('buildMarkdown states the all-clear rather than rendering empty tables', () => {
  const md = buildMarkdown({
    waste: [], missing: [], conflicts: [], converting: [], weeks: 7, ourPrice: 30, applied: false,
  }, '2026-07-25');
  assert.match(md, /no high-volume query clears meaningfully below our price/);
  assert.match(md, /no existing negative blocks a query that produced a sale/);
});

test('a PHRASE negative must not be added when it would block a longer converting query', () => {
  // The real trap: "coconut body lotion" clears at $10.77 vs our $30 and looks
  // like safe waste — but as a PHRASE negative it also blocks the brand query
  // "real skin care organic coconut body lotion", which produced a sale.
  const sellers = [
    { query: 'real skin care organic coconut body lotion', ourPurchases: 1 },
    { query: 'organic coconut lotion non-greasy', ourPurchases: 2 },
  ];
  const candidate = 'coconut body lotion';
  const collateral = sellers.filter((s) => negativeBlocks(s.query, candidate, 'PHRASE'));
  assert.equal(collateral.length, 1);
  assert.equal(collateral[0].query, 'real skin care organic coconut body lotion');

  // A candidate with no such overlap is safe.
  const safeCandidate = 'weleda body lotion';
  assert.equal(sellers.filter((s) => negativeBlocks(s.query, safeCandidate, 'PHRASE')).length, 0);
});
