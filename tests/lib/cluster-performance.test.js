import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { clusterPenalties } from '../../lib/cluster-performance.js';

const CFG = { minPosts: 3, flopRateForMaxPenalty: 0.5, maxPenalty: 4 };

test('cluster with high flop rate gets a penalty', () => {
  const entries = [
    { cluster: 'toothpaste', bucket: 'flop' }, { cluster: 'toothpaste', bucket: 'flop' },
    { cluster: 'toothpaste', bucket: 'flop' }, { cluster: 'toothpaste', bucket: 'winner' },
  ];
  const p = clusterPenalties(entries, CFG);
  assert.ok(p.toothpaste.flopRate >= 0.7);
  assert.ok(p.toothpaste.penalty > 0);
});

test('healthy cluster gets no penalty', () => {
  const entries = [
    { cluster: 'deodorant', bucket: 'winner' }, { cluster: 'deodorant', bucket: 'rising' },
    { cluster: 'deodorant', bucket: 'winner' }, { cluster: 'deodorant', bucket: 'flop' },
  ];
  const p = clusterPenalties(entries, CFG);
  assert.equal(p.deodorant.penalty, 0); // flopRate 0.25 < 0.5 floor → no penalty
});

test('clusters below minPosts are not penalized (insufficient data)', () => {
  const entries = [{ cluster: 'soap', bucket: 'flop' }, { cluster: 'soap', bucket: 'flop' }];
  const p = clusterPenalties(entries, CFG);
  assert.equal(p.soap, undefined);
});

test('penalty is capped at maxPenalty', () => {
  const entries = Array.from({ length: 6 }, () => ({ cluster: 'x', bucket: 'flop' }));
  const p = clusterPenalties(entries, CFG);
  assert.ok(p.x.penalty <= CFG.maxPenalty);
});

test('broken counts as a flop; winner/rising do not', () => {
  const entries = [
    { cluster: 'c', bucket: 'broken' }, { cluster: 'c', bucket: 'flop' },
    { cluster: 'c', bucket: 'flop' }, { cluster: 'c', bucket: 'rising' },
  ];
  const p = clusterPenalties(entries, CFG);
  assert.ok(p.c.flopRate >= 0.7);
});

test('empty input → {}', () => {
  assert.deepEqual(clusterPenalties([], CFG), {});
});
