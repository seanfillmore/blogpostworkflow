import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAsin, isRsc } from '../../../lib/keyword-index/asin-classifier.js';

test('classifyAsin returns "culina" when title contains "culina"', () => {
  assert.equal(classifyAsin({ asin: 'B01', title: 'Culina cast iron soap' }), 'culina');
});

test('classifyAsin returns "culina" when title contains "cast iron" (case-insensitive)', () => {
  assert.equal(classifyAsin({ asin: 'B01', title: 'Cast Iron Cleaning Brush' }), 'culina');
});

test('classifyAsin returns "rsc" for non-Culina products', () => {
  assert.equal(classifyAsin({ asin: 'B01', title: 'Natural Deodorant for Women' }), 'rsc');
  assert.equal(classifyAsin({ asin: 'B02', title: 'REAL Coconut Lotion' }), 'rsc');
});

test('classifyAsin handles missing title (defaults to rsc — defensible default)', () => {
  assert.equal(classifyAsin({ asin: 'B01' }), 'rsc');
});

test('isRsc is true for RSC-classified ASINs', () => {
  assert.equal(isRsc({ asin: 'B01', title: 'Lotion' }), true);
});

test('isRsc is false for Culina-classified ASINs', () => {
  assert.equal(isRsc({ asin: 'B01', title: 'Culina seasoning' }), false);
});
