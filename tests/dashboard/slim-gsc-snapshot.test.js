import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { slimGscSnapshot } from '../../agents/dashboard/lib/data-parsers.js';

test('slimGscSnapshot keeps what the browser reads and drops queriesByPage', () => {
  const snap = {
    date: '2026-10-27',
    summary: { clicks: 10, impressions: 1000 },
    topQueries: [{ query: 'a', clicks: 1 }],
    topPages: [{ page: '/x', clicks: 1 }],
    queriesByPage: [{ page: '/x', query: 'a' }],
  };
  const out = slimGscSnapshot(snap);
  assert.deepEqual(Object.keys(out).sort(), ['date', 'summary', 'topPages', 'topQueries']);
  assert.equal(out.topQueries, snap.topQueries);
  assert.ok('queriesByPage' in snap, 'the input is not mutated');
});

test('slimGscSnapshot passes through an unreadable snapshot as null', () => {
  assert.equal(slimGscSnapshot(null), null);
  assert.equal(slimGscSnapshot(undefined), null);
});

test('the browser still never reads queriesByPage (drop is safe only while that holds)', () => {
  const js = readFileSync(new URL('../../agents/dashboard/public/js/dashboard.js', import.meta.url), 'utf8');
  assert.ok(!js.includes('queriesByPage'));
});
