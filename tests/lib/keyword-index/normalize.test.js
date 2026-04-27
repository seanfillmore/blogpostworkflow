import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, slug } from '../../../lib/keyword-index/normalize.js';

test('normalize lowercases', () => {
  assert.equal(normalize('Natural Deodorant'), 'natural deodorant');
});

test('normalize trims surrounding whitespace', () => {
  assert.equal(normalize('  natural deodorant  '), 'natural deodorant');
});

test('normalize collapses internal whitespace', () => {
  assert.equal(normalize('natural    deodorant\tfor   women'), 'natural deodorant for women');
});

test('normalize strips leading/trailing punctuation', () => {
  assert.equal(normalize('"natural deodorant!"'), 'natural deodorant');
});

test('normalize preserves internal apostrophes (preserves brand integrity)', () => {
  assert.equal(normalize("L'Oreal hair"), "l'oreal hair");
});

test('normalize is idempotent', () => {
  const once = normalize('Natural Deodorant for Women');
  const twice = normalize(once);
  assert.equal(once, twice);
});

test('slug converts to URL-friendly key', () => {
  assert.equal(slug('natural deodorant for women'), 'natural-deodorant-for-women');
});

test('slug strips apostrophes (URL-safe)', () => {
  assert.equal(slug("l'oreal hair"), 'loreal-hair');
});
