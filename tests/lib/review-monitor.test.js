// tests/lib/review-monitor.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

function classifyReview(rating) {
  if (rating >= 4) return 'positive';
  if (rating === 3) return 'neutral';
  return 'negative';
}

const COMPLAINT_PATTERNS = ['thick', 'greasy', 'smell', 'irritat', 'burn', 'broke out', 'rash', 'sticky', 'dry', 'oily'];

function extractComplaintThemes(body) {
  const lower = body.toLowerCase();
  return COMPLAINT_PATTERNS.filter((p) => lower.includes(p));
}

test('classifyReview: 5 stars = positive', () => {
  assert.equal(classifyReview(5), 'positive');
  assert.equal(classifyReview(4), 'positive');
});

test('classifyReview: 3 stars = neutral', () => {
  assert.equal(classifyReview(3), 'neutral');
});

test('classifyReview: 1-2 stars = negative', () => {
  assert.equal(classifyReview(2), 'negative');
  assert.equal(classifyReview(1), 'negative');
});

test('extractComplaintThemes finds matching patterns', () => {
  const themes = extractComplaintThemes('This lotion is too thick and greasy for my skin');
  assert.deepEqual(themes, ['thick', 'greasy']);
});

test('extractComplaintThemes returns empty for positive review', () => {
  const themes = extractComplaintThemes('Love this product! Smooth and light.');
  assert.deepEqual(themes, []);
});

test('extractComplaintThemes handles partial matches', () => {
  const themes = extractComplaintThemes('Caused irritation on my face');
  assert.deepEqual(themes, ['irritat']);
});
