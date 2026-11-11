import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertedPaths, cannibalizationWinners, removalEligibility, removalCandidates, isPermanentSkip } from '../../lib/low-demand-removal.js';
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
  const { take, skipped } = removalCandidates(flops, { ...ctx(), lockStateFor: () => LOCK_UNLOCKED });
  assert.deepEqual(take.map((r) => r.slug), ['p0', 'p1', 'p2', 'p3', 'p4']);
  assert.deepEqual(skipped.map((s) => s.reason).filter((r) => r === 'cap'), ['cap', 'cap']);
  assert.equal(skipped.find((s) => s.slug === 'bad').reason !== 'cap', true);
});

test('missing context fails closed', () => {
  for (const f of ['ctrHandles', 'converted', 'winners', 'redirectTargets']) {
    const c = ctx(); delete c[f];
    assert.equal(removalEligibility(row, c).reason, `missing context: ${f}`);
  }
  const c = ctx(); delete c.ordersOk;
  assert.equal(removalEligibility(row, c).reason, 'missing context: ordersOk');
  assert.equal(removalEligibility(row, { ...ctx(), lockState: undefined }).reason, 'missing context: lockState');
  assert.equal(removalEligibility(row, { ...ctx(), lockState: 'bogus' }).ok, false);
});

test('removalCandidates refuses rows with no known lock state', () => {
  const f = [{ slug: 'a', action: 'no-demand' }];
  assert.equal(removalCandidates(f, ctx()).take.length, 0);
  assert.equal(removalCandidates(f, { ...ctx(), lockStateFor: () => 'weird' }).take.length, 0);
  assert.equal(removalCandidates(f, { ...ctx(), lockStateFor: () => { throw new Error('x'); } }).take.length, 0);
  assert.equal(removalCandidates(f, { ...ctx(), lockStateFor: () => LOCK_NO_POST }).take.length, 1);
});

test('non-article urls and empty slugs refused', () => {
  for (const r of [
    { slug: 'x', url: 'https://www.realskincare.com/products/foo', action: 'no-demand' },
    { slug: 'x', url: 'https://www.realskincare.com/blogs/news', action: 'no-demand' },
    { slug: 'x', url: 'https://www.realskincare.com/blogs/other/foo', action: 'no-demand' },
    { slug: '  ', action: 'no-demand' }, { action: 'no-demand' },
  ]) assert.equal(removalEligibility(r, ctx()).reason, 'not a blog article');
});

test('path normalization on converted and redirect targets', () => {
  const c = { ...ctx(), converted: new Set(['/Blogs/News/Foo/']) };
  assert.equal(removalEligibility(row, c).ok, false);
  const d = { ...ctx(), redirectTargets: new Set(['https://www.realskincare.com/blogs/news/foo?x=1']) };
  assert.equal(removalEligibility(row, d).ok, false);
  assert.equal(removalEligibility({ slug: 'f%6Fo', action: 'no-demand' }, { ...ctx(), winners: new Set(['foo']) }).ok, false);
});

test('isPermanentSkip: permanent policy refusals are kept; everything else is retryable', () => {
  for (const r of ['target of an existing redirect', 'cannibalization winner', 'locked winner', 'lock state unreadable',
    'in a CTR experiment', 'has converted (order landed here)', 'no same-cluster target',
    'no same-cluster target (the post matches no product cluster)', 'not a blog article']) {
    assert.equal(isPermanentSkip(r), true, r);
  }
  for (const r of ['redirect pick unparseable', 'target /x returned 404, not 200', 'order history unreadable', 'cap',
    'missing context: winners', 'something brand new', '', undefined, 'redirect pick failed: boom']) {
    assert.equal(isPermanentSkip(r), false, String(r));
  }
});

test('isPermanentSkip matches the exact reasons removalEligibility emits', () => {
  const permanent = [
    removalEligibility(row, { ...ctx(), lockState: LOCK_LOCKED }),
    removalEligibility(row, { ...ctx(), lockState: LOCK_UNREADABLE }),
    removalEligibility(row, { ...ctx(), ctrHandles: new Set(['foo']) }),
    removalEligibility(row, { ...ctx(), converted: new Set(['/blogs/news/foo']) }),
    removalEligibility(row, { ...ctx(), winners: new Set(['foo']) }),
    removalEligibility(row, { ...ctx(), redirectTargets: new Set(['/blogs/news/foo']) }),
    removalEligibility({ ...row, url: 'https://x/pages/foo' }, ctx()),
  ];
  for (const v of permanent) assert.equal(v.ok, false), assert.equal(isPermanentSkip(v.reason), true, v.reason);
  assert.equal(isPermanentSkip(removalEligibility(row, { ...ctx(), ordersOk: false }).reason), false);
  assert.equal(isPermanentSkip(removalEligibility(row, { ...ctx(), winners: undefined }).reason), false);
});
