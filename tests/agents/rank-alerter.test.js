import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots } from '../../agents/rank-alerter/index.js';

const makeSnap = (queries, pages) => ({
  topQueries: queries,
  topPages: pages || [],
});

test('detects rank drops of 5+ positions', () => {
  const prev = makeSnap([{ query: 'best deodorant', position: 5, clicks: 10, impressions: 100, ctr: 0.1 }]);
  const curr = makeSnap([{ query: 'best deodorant', position: 11, clicks: 5, impressions: 100, ctr: 0.05 }]);
  const result = diffSnapshots(curr, prev);
  assert.equal(result.drops.length, 1);
  assert.equal(result.drops[0].query, 'best deodorant');
  assert.equal(result.drops[0].delta, 6);
});

test('detects new page 1 entries', () => {
  const prev = makeSnap([{ query: 'natural soap', position: 14, clicks: 2, impressions: 50, ctr: 0.04 }]);
  const curr = makeSnap([{ query: 'natural soap', position: 7, clicks: 8, impressions: 50, ctr: 0.16 }]);
  const result = diffSnapshots(curr, prev);
  assert.equal(result.gains.length, 1);
  assert.equal(result.gains[0].query, 'natural soap');
});

test('detects traffic drops of 20%+', () => {
  const prev = makeSnap([], [{ page: '/blogs/news/best-deodorant', clicks: 100 }]);
  const curr = makeSnap([], [{ page: '/blogs/news/best-deodorant', clicks: 75 }]);
  const result = diffSnapshots(curr, prev);
  assert.equal(result.trafficDrops.length, 1);
  assert.ok(result.trafficDrops[0].pctDrop >= 20);
});

test('ignores small changes', () => {
  const prev = makeSnap([{ query: 'foo', position: 5, clicks: 10, impressions: 100, ctr: 0.1 }]);
  const curr = makeSnap([{ query: 'foo', position: 7, clicks: 9, impressions: 100, ctr: 0.09 }]);
  const result = diffSnapshots(curr, prev);
  assert.equal(result.drops.length, 0);
});
