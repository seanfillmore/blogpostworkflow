import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost, priceFor, summarizeRecords } from '../../lib/llm-usage.js';

test('priceFor matches by family, defaults unknown to sonnet', () => {
  assert.equal(priceFor('claude-opus-4-6').output, 75);
  assert.equal(priceFor('claude-sonnet-4-6').output, 15);
  assert.equal(priceFor('claude-haiku-4-5-20251001').output, 5);
  assert.equal(priceFor('mystery-model').output, 15); // sonnet default
});

test('estimateCost: opus 1k in + 1k out = $0.09', () => {
  assert.equal(estimateCost('claude-opus-4-6', { input_tokens: 1000, output_tokens: 1000 }), 0.09);
});

test('estimateCost: sonnet output is 5x cheaper than opus output', () => {
  const opus = estimateCost('claude-opus-4-6', { output_tokens: 1000 });
  const sonnet = estimateCost('claude-sonnet-4-6', { output_tokens: 1000 });
  assert.equal(opus / sonnet, 5);
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
  const recs = [
    { agent: 'blog-post-writer', model: 'claude-sonnet-4-6', input_tokens: 5000, output_tokens: 8000, est_cost_usd: 0.135 },
    { agent: 'cro-analyzer', model: 'claude-opus-4-6', input_tokens: 2000, output_tokens: 4000, est_cost_usd: 0.33 },
    { agent: 'blog-post-writer', model: 'claude-sonnet-4-6', input_tokens: 1000, output_tokens: 1000, est_cost_usd: 0.018 },
  ];
  const s = summarizeRecords(recs);
  assert.equal(s.totalCalls, 3);
  assert.equal(s.byAgent[0].key, 'cro-analyzer'); // most expensive agent first
  assert.equal(s.byAgent.find((a) => a.key === 'blog-post-writer').calls, 2);
  assert.equal(s.byModel[0].key, 'claude-opus-4-6');
  assert.ok(Math.abs(s.totalCost - 0.483) < 1e-6);
});

test('summarizeRecords: empty input is safe', () => {
  const s = summarizeRecords([]);
  assert.equal(s.totalCost, 0);
  assert.equal(s.totalCalls, 0);
  assert.deepEqual(s.byAgent, []);
});
