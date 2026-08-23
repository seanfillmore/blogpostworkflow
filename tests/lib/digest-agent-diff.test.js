import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentNameOf, diffAgentSets } from '../../lib/digest-agent-diff.js';

test('agentNameOf prefers an explicit agent field', () => {
  assert.equal(agentNameOf({ agent: 'Editor', subject: 'something else' }), 'editor');
});

test('agentNameOf falls back to the subject lead phrase', () => {
  assert.equal(agentNameOf({ subject: 'Post Performance: 2 reviews, 1 flop' }), 'post performance');
  assert.equal(agentNameOf({ subject: 'Ad Studio run complete — Coconut Soap' }), 'ad studio run complete');
});

test('agentNameOf returns null when nothing identifies the record', () => {
  assert.equal(agentNameOf({}), null);
  assert.equal(agentNameOf({ subject: '   ' }), null);
  assert.equal(agentNameOf(null), null);
  assert.equal(agentNameOf('not an object'), null);
});

test('agentNameOf ignores a blank agent field and uses the subject', () => {
  assert.equal(agentNameOf({ agent: '   ', subject: 'GSC Collector completed' }), 'gsc collector completed');
});

test('diffAgentSets reports agents present in a baseline but missing today', () => {
  const r = diffAgentSets(new Set(['editor', 'publisher']), [new Set(['editor', 'publisher', 'rank tracker'])]);
  assert.deepEqual(r.missing, ['rank tracker']);
  assert.deepEqual(r.added, []);
});

test('diffAgentSets unions the baselines rather than intersecting them', () => {
  // 'bing collector' runs weekly — it appears on only ONE baseline day, and must
  // still be part of the baseline, or the check silently stops watching it.
  const r = diffAgentSets(
    new Set(['editor']),
    [new Set(['editor', 'bing collector']), new Set(['editor'])],
  );
  assert.deepEqual(r.missing, ['bing collector']);
  assert.equal(r.baselineSize, 2);
});

test('diffAgentSets reports newly-appearing agents separately', () => {
  const r = diffAgentSets(new Set(['editor', 'demand miner']), [new Set(['editor'])]);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.added, ['demand miner']);
});

test('diffAgentSets: empty today means everything in the baseline is missing', () => {
  const r = diffAgentSets(new Set(), [new Set(['a', 'b'])]);
  assert.deepEqual(r.missing, ['a', 'b']);
});

test('diffAgentSets tolerates junk inputs without throwing', () => {
  assert.doesNotThrow(() => diffAgentSets(null, null));
  const r = diffAgentSets(null, [null, undefined, new Set(['a'])]);
  assert.deepEqual(r.missing, ['a']);
});
