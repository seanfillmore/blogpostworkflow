// tests/agents/collection-creator-opportunities.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

function hasCollectionIntent(keyword) {
  const kw = keyword.toLowerCase();
  // Informational patterns that disqualify commercial intent
  const informational = [/\bhow to\b/, /\bwhat is\b/, /\bdiy\b/, /\brecipe\b/, /\bmake\b/];
  if (informational.some((p) => p.test(kw))) return false;
  const patterns = [/\bbest\b/, /\bbuy\b/, /\bshop\b/, /\btop\b/, /\borganic\b/, /\bnatural\b/,
    /\bfor (?:women|men|kids|sensitive|oily|dry|acne)\b/,
    /\b(?:deodorant|lotion|soap|toothpaste|lip balm|shampoo)\b/];
  return patterns.some((p) => p.test(kw));
}

function filterOpportunities(opportunities, existingHandles) {
  return opportunities
    .filter((o) => hasCollectionIntent(o.keyword))
    .filter((o) => {
      const potentialHandle = o.keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      return !existingHandles.some((h) => h === potentialHandle || potentialHandle.includes(h) || h.includes(potentialHandle));
    });
}

test('hasCollectionIntent detects commercial keywords', () => {
  assert.equal(hasCollectionIntent('best natural deodorant'), true);
  assert.equal(hasCollectionIntent('buy organic lotion'), true);
  assert.equal(hasCollectionIntent('how to make soap at home'), false);
});

test('filterOpportunities excludes keywords matching existing collections', () => {
  const opps = [
    { keyword: 'natural deodorant', impressions: 500 },
    { keyword: 'organic body lotion', impressions: 300 },
  ];
  const existing = ['natural-deodorant'];
  const result = filterOpportunities(opps, existing);
  assert.equal(result.length, 1);
  assert.equal(result[0].keyword, 'organic body lotion');
});

test('filterOpportunities excludes partial handle matches', () => {
  const opps = [{ keyword: 'coconut oil body lotion', impressions: 400 }];
  const existing = ['coconut-oil-body-lotion'];
  const result = filterOpportunities(opps, existing);
  assert.equal(result.length, 0);
});
