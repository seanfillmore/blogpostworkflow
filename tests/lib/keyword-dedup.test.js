import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isRejected, isCovered, slugify } from '../../lib/keyword-dedup.js';

test('slugify normalizes to kebab-case', () => {
  assert.equal(slugify('Fluoride Free Toothpaste!'), 'fluoride-free-toothpaste');
});

test('isRejected: exact matchType compares slugs', () => {
  const rej = [{ keyword: 'whitening toothpaste', matchType: 'exact' }];
  assert.equal(isRejected('Whitening Toothpaste', rej), true);
  assert.equal(isRejected('best whitening toothpaste', rej), false);
});

test('isRejected: default matchType is substring', () => {
  const rej = [{ keyword: 'crest' }];
  assert.equal(isRejected('best crest toothpaste', rej), true);
  assert.equal(isRejected('natural toothpaste', rej), false);
});

test('isCovered: exact keyword or slug already in index', () => {
  const index = new Set(['natural-deodorant', 'fluoride free toothpaste']);
  assert.equal(isCovered('Natural Deodorant', index), true);
  assert.equal(isCovered('fluoride free toothpaste', index), true);
});

test('isCovered: fuzzy slug containment (min length 6)', () => {
  const index = new Set(['fluoride-free-toothpaste-2026']);
  assert.equal(isCovered('fluoride free toothpaste', index), true); // substring of indexed slug
});

test('isCovered: short tokens do not fuzzy-match', () => {
  const index = new Set(['abc']);
  assert.equal(isCovered('abcdef', index), false);
});
