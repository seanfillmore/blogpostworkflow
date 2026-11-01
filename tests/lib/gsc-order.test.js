import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planOrderedQuery, applyOrder, GSC_MAX_ROW_LIMIT } from '../../lib/gsc-order.js';

test('orderBy never reaches the API; an impressions order widens the fetch', () => {
  const p = planOrderedQuery({ rowLimit: 1, dimensions: ['query'], orderBy: [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }] });
  assert.equal('orderBy' in p.body, false);
  assert.equal(p.body.rowLimit, GSC_MAX_ROW_LIMIT);
  assert.equal(p.requestedLimit, 1);
});

test('the 2026-09-21 case: top query by impressions, not the API\'s click order', () => {
  // API order (clicks desc, all zero here → arbitrary): the junk row came first.
  const apiRows = [
    { keys: ['how do i print all this information'], clicks: 0, impressions: 1 },
    { keys: ['how to make natural moisturizer'], clicks: 0, impressions: 7051 },
    { keys: ['quick moisturizer recipe'], clicks: 0, impressions: 121 },
  ];
  const p = planOrderedQuery({ rowLimit: 1, orderBy: [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }] });
  assert.deepEqual(applyOrder(apiRows, p.order, p.requestedLimit).map((r) => r.keys[0]), ['how to make natural moisturizer']);
});

test('clicks-descending is the native order: no widening, no re-sort', () => {
  const p = planOrderedQuery({ rowLimit: 50, orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }] });
  assert.equal(p.body.rowLimit, 50);
  assert.equal(p.order, null);
});

test('no orderBy passes through untouched', () => {
  const p = planOrderedQuery({ rowLimit: 10 });
  assert.deepEqual(p.body, { rowLimit: 10 });
  assert.equal(applyOrder([1, 2], p.order, p.requestedLimit).length, 2);
});

test('lib/gsc.js routes every query through the plan', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../lib/gsc.js'), 'utf8');
  assert.match(src, /planOrderedQuery\(requested\)/);
  assert.match(src, /applyOrder\(data\.rows \|\| \[\], order, requestedLimit\)/);
});
