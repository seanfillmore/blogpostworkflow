import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost, priceFor, summarizeRecords } from '../../lib/llm-usage.js';

test('priceFor matches by family, defaults unknown to sonnet', () => {
  assert.equal(priceFor('claude-opus-4-6').output, 25);
  assert.equal(priceFor('claude-sonnet-4-6').output, 15);
  assert.equal(priceFor('claude-haiku-4-5-20251001').output, 5);
  assert.equal(priceFor('mystery-model').output, 15); // sonnet default
});

// Every Opus this fleet actually calls is $5/$25. The table previously carried
// $15/$75 — correct for Opus 3 / 4.0 / 4.1, none of which are in use — so every
// Opus cost ever logged read exactly 3x high.
test('priceFor: all Opus versions in use price at 5/25', () => {
  for (const m of ['claude-opus-4-6', 'claude-opus-4-7', 'claude-opus-5']) {
    assert.equal(priceFor(m).input, 5, `${m} input`);
    assert.equal(priceFor(m).output, 25, `${m} output`);
  }
});

test('priceFor: cache rates derive from input (1.25x write, 0.1x read)', () => {
  const opus = priceFor('claude-opus-5');
  assert.equal(opus.cacheWrite, 6.25);
  assert.equal(opus.cacheRead, 0.5);
});

test('estimateCost: opus 1k in + 1k out = $0.03', () => {
  assert.equal(estimateCost('claude-opus-4-6', { input_tokens: 1000, output_tokens: 1000 }), 0.03);
});

test('estimateCost: opus output is ~1.7x sonnet, not 5x', () => {
  const opus = estimateCost('claude-opus-4-6', { output_tokens: 1000 });
  const sonnet = estimateCost('claude-sonnet-4-6', { output_tokens: 1000 });
  assert.equal(opus, 0.025);
  assert.equal(sonnet, 0.015);
});

test('estimateCost: cache reads are far cheaper than fresh input', () => {
  const fresh = estimateCost('claude-sonnet-4-6', { input_tokens: 10000 });
  const cached = estimateCost('claude-sonnet-4-6', { cache_read_input_tokens: 10000 });
  assert.ok(cached < fresh / 5, 'cache read should be ~10% of input cost');
});

test('estimateCost: empty usage is 0', () => {
  assert.equal(estimateCost('claude-sonnet-4-6', {}), 0);
  assert.equal(estimateCost('claude-sonnet-4-6'), 0);
});

test('summarizeRecords: aggregates cost by agent and model, ranked desc', () => {
  // est_cost_usd here is what estimateCost returns for these token counts at
  // corrected rates. Note the ranking flip this fixes: the opus call was booked at
  // $0.33 and topped both rankings, but it actually costs $0.11, so two sonnet
  // calls out-cost it. This is the whole reason the bug mattered — the "most
  // expensive agent" ranking a spend-cut decision reads was inverted.
  const recs = [
    { agent: 'blog-post-writer', model: 'claude-sonnet-4-6', input_tokens: 5000, output_tokens: 8000, est_cost_usd: 0.135 },
    { agent: 'cro-analyzer', model: 'claude-opus-4-6', input_tokens: 2000, output_tokens: 4000, est_cost_usd: 0.11 },
    { agent: 'blog-post-writer', model: 'claude-sonnet-4-6', input_tokens: 1000, output_tokens: 1000, est_cost_usd: 0.018 },
  ];
  const s = summarizeRecords(recs);
  assert.equal(s.totalCalls, 3);
  assert.equal(s.byAgent[0].key, 'blog-post-writer'); // 0.153 vs cro-analyzer's 0.11
  assert.equal(s.byAgent.find((a) => a.key === 'blog-post-writer').calls, 2);
  assert.equal(s.byModel[0].key, 'claude-sonnet-4-6');
  assert.ok(Math.abs(s.totalCost - 0.263) < 1e-6);
});

// The Opus correction is worthless for the spend-cut decision if it only applies to
// rows written after the fix — that decision reads weeks of history. Token counts are
// stored on every row, so cost is recomputed from them at read time and the whole
// archive reprices at once.
test('summarizeRecords: recomputes from tokens, ignoring a stale stored cost', () => {
  const s = summarizeRecords([
    // 3x-high value written by the old table; tokens are the same either way.
    { agent: 'cro-analyzer', model: 'claude-opus-4-6', input_tokens: 2000, output_tokens: 4000, est_cost_usd: 0.33 },
  ]);
  assert.ok(Math.abs(s.totalCost - 0.11) < 1e-6, 'stale 0.33 is repriced to 0.11');
});

// Not every row is guaranteed to carry token counts, so the stored value stays the
// fallback rather than silently becoming zero.
test('summarizeRecords: falls back to stored cost when tokens are absent', () => {
  const s = summarizeRecords([{ agent: 'a', model: 'claude-opus-4-6', est_cost_usd: 0.42 }]);
  assert.ok(Math.abs(s.totalCost - 0.42) < 1e-6);
});

test('estimateCost matches the fixture costs above', () => {
  assert.equal(estimateCost('claude-sonnet-4-6', { input_tokens: 5000, output_tokens: 8000 }), 0.135);
  assert.equal(estimateCost('claude-opus-4-6', { input_tokens: 2000, output_tokens: 4000 }), 0.11);
  assert.equal(estimateCost('claude-sonnet-4-6', { input_tokens: 1000, output_tokens: 1000 }), 0.018);
});

test('summarizeRecords: empty input is safe', () => {
  const s = summarizeRecords([]);
  assert.equal(s.totalCost, 0);
  assert.equal(s.totalCalls, 0);
  assert.deepEqual(s.byAgent, []);
});
