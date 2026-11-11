import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertedPaths, cannibalizationWinners, removalEligibility, removalCandidates } from '../../lib/low-demand-removal.js';
import { LOCK_LOCKED, LOCK_UNREADABLE, LOCK_UNLOCKED, LOCK_NO_POST } from '../../lib/post-lock.js';

const ctx = () => ({
  lockState: LOCK_UNLOCKED, ctrHandles: new Set(), converted: new Set(), winners: new Set(),
  redirectTargets: new Set(), ordersOk: true,
});
const row = { slug: 'foo', url: 'https://www.realskincare.com/blogs/news/foo', action: 'no-demand' };

test('convertedPaths strips query, host and trailing slash', () => {
  const s = convertedPaths([{ landing_site: '/blogs/news/foo?utm=x' }, { landing_site: 'https://www.realskincare.com/blogs/news/foo/' }, {}]);
  assert.deepEqual([...s], ['/blogs/news/foo']);
});

test('cannibalizationWinners picks max-impressions url per conflict', () => {
  const w = cannibalizationWinners({ conflicts: [{ urls: [{ url: 'https://x/blogs/news/a', impressions: 5 }, { url: 'https://x/blogs/news/b', impressions: 9 }] }] });
  assert.deepEqual([...w], ['b']);
  assert.equal(cannibalizationWinners(null).size, 0);
});

test('eligible row ok; lock states', () => {
  assert.deepEqual(removalEligibility(row, ctx()), { ok: true });
  assert.equal(removalEligibility(row, { ...ctx(), lockState: LOCK_NO_POST }).ok, true);
  const a = removalEligibility(row, { ...ctx(), lockState: LOCK_LOCKED });
  const b = removalEligibility(row, { ...ctx(), lockState: LOCK_UNREADABLE });
  assert.equal(a.ok, false); assert.equal(b.ok, false); assert.notEqual(a.reason, b.reason);
});

test('each refusal has a distinct reason', () => {
  const cases = [
    { ctrHandles: new Set(['foo']) },
    { converted: new Set(['/blogs/news/foo']) },
    { winners: new Set(['foo']) },
    { redirectTargets: new Set(['/blogs/news/foo']) },
    { ordersOk: false },
  ];
  const reasons = cases.map((c) => { const r = removalEligibility(row, { ...ctx(), ...c }); assert.equal(r.ok, false); return r.reason; });
  assert.equal(new Set(reasons).size, 5);
  assert.equal(reasons[4], 'order history unreadable');
  assert.equal(removalEligibility({ ...row, action: 'demote' }, ctx()).ok, false);
});

test('slug fallback when no url', () => {
  const r = removalEligibility({ slug: 'foo', action: 'no-demand' }, { ...ctx(), winners: new Set(['foo']) });
  assert.equal(r.ok, false);
});

test('removalCandidates caps at 5 in order', () => {
  const flops = Array.from({ length: 7 }, (_, i) => ({ slug: `p${i}`, action: 'no-demand' }));
  flops.splice(1, 0, { slug: 'bad', action: 'auto-refresh' });
  const { take, skipped } = removalCandidates(flops, ctx());
  assert.deepEqual(take.map((r) => r.slug), ['p0', 'p1', 'p2', 'p3', 'p4']);
  assert.deepEqual(skipped.map((s) => s.reason).filter((r) => r === 'cap'), ['cap', 'cap']);
  assert.equal(skipped.find((s) => s.slug === 'bad').reason !== 'cap', true);
});
