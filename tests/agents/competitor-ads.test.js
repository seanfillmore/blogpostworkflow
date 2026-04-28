import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  truncateForLLM,
  aggregatePatterns,
  buildPatternPrompt,
} from '../../agents/competitor-ads/index.js';

test('truncateForLLM passes through short input', () => {
  assert.equal(truncateForLLM('short'), 'short');
});

test('truncateForLLM appends marker for long input', () => {
  const long = 'x'.repeat(20000);
  const out = truncateForLLM(long, 1000);
  assert.equal(out.length, 1000 + '\n\n[...truncated]'.length);
  assert.ok(out.endsWith('[...truncated]'));
});

test('truncateForLLM handles null input', () => {
  assert.equal(truncateForLLM(null), '');
});

test('aggregatePatterns counts and sorts by frequency', () => {
  const perCompetitor = [
    { patterns: { angles: ['Aluminum free', 'all-day protection'], hooks: [], themes: ['minimal background'] } },
    { patterns: { angles: ['aluminum FREE', 'natural ingredients'], hooks: [], themes: ['minimal background', 'before/after'] } },
    { patterns: { angles: ['aluminum free'], hooks: [], themes: [] } },
  ];
  const out = aggregatePatterns(perCompetitor);
  // case-insensitive aggregation
  assert.equal(out.angles[0].label, 'aluminum free');
  assert.equal(out.angles[0].count, 3);
  assert.equal(out.themes[0].label, 'minimal background');
  assert.equal(out.themes[0].count, 2);
});

test('aggregatePatterns handles empty input', () => {
  const out = aggregatePatterns([]);
  assert.deepEqual(out, { angles: [], hooks: [], themes: [] });
});

test('aggregatePatterns ignores empty strings', () => {
  const out = aggregatePatterns([{ patterns: { angles: ['', '   ', 'real one'], hooks: [], themes: [] } }]);
  assert.equal(out.angles.length, 1);
  assert.equal(out.angles[0].label, 'real one');
});

test('buildPatternPrompt includes the competitor name and the scraped text', () => {
  const p = buildPatternPrompt('Native', 'sample ad copy');
  assert.ok(p.includes('Native'));
  assert.ok(p.includes('sample ad copy'));
  assert.ok(p.includes('"angles"'));
  assert.ok(p.includes('"hooks"'));
  assert.ok(p.includes('"themes"'));
});
