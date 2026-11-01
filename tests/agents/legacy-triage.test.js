import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { classify, BROKEN_STATES } from '../../agents/legacy-triage/index.js';

// A dry run bucketed 46 of 182 posts as "broken — technical fix required".
// Every one of them came from a stale meta.indexing_blocked flag; ZERO had a
// genuine broken indexing state. 32 of the 46 were reported by live GSC data as
// `indexed` — the flag was simply never cleared once the post got indexed
// (indexing-fixer clears it when it RETRIES a post, and an indexed post stops
// being retried). legacy-rebuilder skips the broken bucket permanently, so
// applying that classification would have parked a quarter of the catalogue.

const base = { rankEntry: null, gscMetrics: null, words: 1200 };

test('a genuine broken indexing state is still broken', () => {
  for (const state of BROKEN_STATES) {
    const r = classify({ ...base, meta: {}, indexState: state });
    assert.equal(r.bucket, 'broken', `${state} must classify as broken`);
  }
});

test('a stale indexing_blocked flag does not override live "indexed"', () => {
  const r = classify({ ...base, meta: { indexing_blocked: true }, indexState: 'indexed' });
  assert.notEqual(r.bucket, 'broken', 'Google says it is indexed — the cached flag is stale');
});

test('a stale flag does not override states other agents already own', () => {
  // The agent's own comment: not_found is handled by indexing-fixer and
  // crawled_not_indexed by refresh-runner — neither is broken.
  assert.notEqual(
    classify({ ...base, meta: { indexing_blocked: true }, indexState: 'crawled_not_indexed' }).bucket,
    'broken',
  );
  assert.notEqual(
    classify({ ...base, meta: { indexing_blocked: true }, indexState: 'not_found' }).bucket,
    'broken',
  );
});

test('indexing_blocked still means broken when live state is unknown', () => {
  // With no live signal to contradict it, the flag is the only evidence there is
  // and should still be honoured — this is the case it was written for.
  const r = classify({ ...base, meta: { indexing_blocked: true }, indexState: null });
  assert.equal(r.bucket, 'broken');
  const u = classify({ ...base, meta: { indexing_blocked: true }, indexState: 'unknown' });
  assert.equal(u.bucket, 'broken');
});

test('the broken reason never claims a technical fix is needed on an indexed post', () => {
  const r = classify({ ...base, meta: { indexing_blocked: true }, indexState: 'indexed' });
  assert.ok(
    !/technical fix required/i.test(r.reason || ''),
    `an indexed post must not be labelled a technical fix — got: ${r.reason}`,
  );
});

console.log('✓ legacy-triage tests pass');

// ── the root cause, one agent upstream ──────────────────────────────────────
import { staleBlockedSlugs } from '../../agents/indexing-fixer/index.js';

test('staleBlockedSlugs finds blocked posts whose verdict is now ok', () => {
  const results = [
    { slug: 'now-indexed', verdict: { severity: 'ok' } },
    { slug: 'still-broken', verdict: { severity: 'critical' } },
    { slug: 'ok-and-not-flagged', verdict: { severity: 'ok' } },
  ];
  const metas = {
    'now-indexed': { indexing_blocked: true },
    'still-broken': { indexing_blocked: true },
    'ok-and-not-flagged': {},
  };

  assert.deepEqual(
    staleBlockedSlugs(results, (s) => metas[s]),
    ['now-indexed'],
    'only a resolved post that still carries the flag is swept',
  );
});

test('staleBlockedSlugs tolerates missing metas and empty input', () => {
  assert.deepEqual(staleBlockedSlugs([{ slug: 'x', verdict: { severity: 'ok' } }], () => null), []);
  assert.deepEqual(staleBlockedSlugs([], () => ({})), []);
  assert.deepEqual(staleBlockedSlugs(null, () => ({})), []);
});

import { lockStillHolds, WINNER_MIN_IMPRESSIONS, LOCK_KEEP_MAX_POSITION } from '../../agents/legacy-triage/index.js';

// 2026-09-21: six "winners" locked at 46-195 impressions per 90 days sat on the
// post-performance card as low-demand pages nothing could refresh or retire.
test('a page-1 ranking on almost no demand is not a winner', () => {
  const r = classify({ ...base, meta: {}, indexState: 'indexed', gscMetrics: { position: 5.7, impressions: 87 } });
  assert.notEqual(r.bucket, 'winner');
  const w = classify({ ...base, meta: {}, indexState: 'indexed', gscMetrics: { position: 5.9, impressions: 181102 } });
  assert.equal(w.bucket, 'winner');
});

test('winner floor is the low-demand line, so the two can never both hold', () => {
  assert.equal(WINNER_MIN_IMPRESSIONS, 200);
});

test('lock re-check: demand and still ranking, with hysteresis past page 1', () => {
  assert.equal(lockStillHolds({ position: 11.2, impressions: 16666 }), true, 'sls-free-toothpaste-list stays protected');
  assert.equal(lockStillHolds({ position: 5.7, impressions: 87 }), false, 'coconut-oil-toothpaste: no demand');
  assert.equal(lockStillHolds({ position: 34.7, impressions: 2065 }), false, 'fell off page 2');
  assert.equal(lockStillHolds({ position: LOCK_KEEP_MAX_POSITION, impressions: 200 }), true);
});

test('an unreadable measurement keeps the lock', () => {
  assert.equal(lockStillHolds({ position: null, impressions: null }), true);
});
