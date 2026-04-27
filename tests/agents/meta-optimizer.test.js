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

import { buildPromptGrounding } from '../../agents/meta-optimizer/lib/grounding.js';

test('buildPromptGrounding returns null when no index entry', () => {
  assert.equal(buildPromptGrounding(null, []), null);
});

test('buildPromptGrounding extracts validation_source + cluster mate keywords', () => {
  const entry = { validation_source: 'amazon', amazon: { conversion_share: 0.12 } };
  const mates = [{ keyword: 'aluminum free deodorant' }, { keyword: 'natural roll-on deodorant' }];
  const g = buildPromptGrounding(entry, mates);
  assert.equal(g.validationTag, 'amazon');
  assert.equal(g.conversionShare, 0.12);
  assert.deepEqual(g.clusterMateKeywords, ['aluminum free deodorant', 'natural roll-on deodorant']);
});

test('buildPromptGrounding handles entry with no amazon block', () => {
  const entry = { validation_source: 'gsc_ga4' };
  const g = buildPromptGrounding(entry, []);
  assert.equal(g.validationTag, 'gsc_ga4');
  assert.equal(g.conversionShare, null);
  assert.deepEqual(g.clusterMateKeywords, []);
});
