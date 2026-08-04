import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { compactJson, headArray, fitSections } from '../../lib/prompt-budget.js';

// Second instance of the same bug class in one week: an agent that bounds its
// input by item COUNT but not by item SIZE, and only discovers the ceiling when
// the API rejects the request. insight-aggregator reached ~370k tokens; cro-analyzer
// reached 1,917,307 against a 1,000,000 limit and has failed every run since.

test('compactJson drops pretty-printing', () => {
  const v = { a: 1, b: [1, 2, 3] };
  assert.equal(compactJson(v), '{"a":1,"b":[1,2,3]}');
  // Pretty-printing a deep object roughly doubles it — free savings before any
  // truncation decision has to be made.
  assert.ok(compactJson(v).length < JSON.stringify(v, null, 2).length);
});

test('headArray keeps the first N and says what it dropped', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ i }));
  const out = headArray(rows, 10);

  assert.equal(out.length, 11, '10 kept plus one marker');
  assert.deepEqual(out.slice(0, 10), rows.slice(0, 10), 'the kept rows are unchanged');
  assert.match(JSON.stringify(out[10]), /90 more/, 'the omission is stated, not silent');
});

test('headArray leaves a short array alone', () => {
  const rows = [{ i: 1 }, { i: 2 }];
  assert.deepEqual(headArray(rows, 10), rows, 'no marker when nothing was dropped');
});

test('headArray tolerates a non-array', () => {
  assert.equal(headArray(null, 5), null);
  assert.equal(headArray(undefined, 5), undefined);
  assert.deepEqual(headArray({ a: 1 }, 5), { a: 1 });
});

test('fitSections passes everything through when under budget', () => {
  const { text, trimmed } = fitSections([
    { label: 'A', body: 'short' },
    { label: 'B', body: 'also short' },
  ], { totalCap: 10_000 });

  assert.match(text, /short/);
  assert.match(text, /also short/);
  assert.deepEqual(trimmed, []);
});

test('fitSections truncates the largest section first and reports it', () => {
  const { text, trimmed } = fitSections([
    { label: 'small', body: 'x'.repeat(100) },
    { label: 'huge', body: 'y'.repeat(10_000) },
  ], { totalCap: 2_000 });

  assert.ok(text.length <= 2_600, `total ${text.length} should be near the cap`);
  assert.match(text, /x{100}/, 'the small section survives intact');
  assert.ok(trimmed.includes('huge'), 'the truncated section is named');
  assert.match(text, /truncated/i, 'the truncation is visible in the prompt itself');
});

test('fitSections drops empty sections', () => {
  const { text } = fitSections([
    { label: 'present', body: 'data' },
    { label: 'absent', body: '' },
  ], { totalCap: 1_000 });

  assert.match(text, /present/);
  assert.ok(!text.includes('absent'), 'an empty section contributes no heading');
});

console.log('✓ prompt-budget tests pass');
