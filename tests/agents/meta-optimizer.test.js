import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortByValidation } from '../../agents/meta-optimizer/lib/sort.js';

test('sortByValidation orders amazon-first, then by impressions desc', () => {
  const rows = [
    { keyword: 'a', impressions: 100, validation_source: null },
    { keyword: 'b', impressions: 200, validation_source: 'amazon' },
    { keyword: 'c', impressions: 50,  validation_source: 'amazon' },
    { keyword: 'd', impressions: 300, validation_source: 'gsc_ga4' },
  ];
  const sorted = sortByValidation(rows);
  assert.deepEqual(sorted.map((r) => r.keyword), ['b', 'c', 'd', 'a']);
});

test('sortByValidation handles rows with no validation_source field', () => {
  const rows = [
    { keyword: 'a', impressions: 100 },
    { keyword: 'b', impressions: 200 },
  ];
  const sorted = sortByValidation(rows);
  assert.deepEqual(sorted.map((r) => r.keyword), ['b', 'a']);
});

test('sortByValidation is stable within a band', () => {
  const rows = [
    { keyword: 'a', impressions: 100, validation_source: 'amazon' },
    { keyword: 'b', impressions: 100, validation_source: 'amazon' },
  ];
  const sorted = sortByValidation(rows);
  assert.deepEqual(sorted.map((r) => r.keyword), ['a', 'b']);
});
