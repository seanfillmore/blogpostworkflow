import { test } from 'node:test';
import assert from 'node:assert/strict';
import { annotateRows, sortUnmapped } from '../../agents/gsc-opportunity/index.js';

const idx = {
  keywords: {
    'natural-deodorant':       { slug: 'natural-deodorant',       validation_source: 'amazon' },
    'best-soap-for-tattoos':   { slug: 'best-soap-for-tattoos',   validation_source: 'gsc_ga4' },
  },
};

test('annotateRows tags amazon, gsc_ga4, and untagged rows', () => {
  const rows = [
    { keyword: 'natural deodorant', impressions: 500 },
    { keyword: 'best soap for tattoos', impressions: 200 },
    { keyword: 'never seen before',     impressions: 100 },
  ];
  const out = annotateRows(rows, idx);
  assert.equal(out[0].validation_source, 'amazon');
  assert.equal(out[1].validation_source, 'gsc_ga4');
  assert.equal(out[2].validation_source, null);
});

test('annotateRows handles null index by tagging null on every row', () => {
  const rows = [{ keyword: 'foo', impressions: 1 }];
  const out = annotateRows(rows, null);
  assert.equal(out[0].validation_source, null);
});

test('sortUnmapped places amazon-validated rows first, by impressions desc', () => {
  const rows = [
    { keyword: 'q1', impressions: 100, validation_source: null },
    { keyword: 'q2', impressions: 200, validation_source: 'amazon' },
    { keyword: 'q3', impressions: 50,  validation_source: 'amazon' },
    { keyword: 'q4', impressions: 300, validation_source: 'gsc_ga4' },
  ];
  const sorted = sortUnmapped(rows);
  assert.deepEqual(sorted.map((r) => r.keyword), ['q2', 'q3', 'q4', 'q1']);
});

test('sortUnmapped is stable when impressions tie within the same band', () => {
  const rows = [
    { keyword: 'a', impressions: 100, validation_source: 'amazon' },
    { keyword: 'b', impressions: 100, validation_source: 'amazon' },
  ];
  const sorted = sortUnmapped(rows);
  assert.deepEqual(sorted.map((r) => r.keyword), ['a', 'b']);
});
