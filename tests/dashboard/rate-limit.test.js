// tests/dashboard/rate-limit.test.js
// The giveaway write routes are public and unauthenticated, and every
// accepted request creates a real profile in production Klaviyo. This pins
// the in-memory limiter's budget, its window reset, and the memory bound
// that keeps it from repeating the disk-full incident in RAM.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createRateLimiter, getClientIp } from '../../agents/dashboard/lib/rate-limit.js';

test('requests under the budget are allowed', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.check('1.2.3.4'), true, `request ${i + 1} of 5 should be allowed`);
  }
});

test('the request past the budget is refused with no further counting', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });
  for (let i = 0; i < 5; i += 1) limiter.check('1.2.3.4');
  assert.equal(limiter.check('1.2.3.4'), false, 'the 6th request in the window must be refused');
  assert.equal(limiter.check('1.2.3.4'), false, 'refused requests stay refused, not silently readmitted');
});

test('a different key gets its own independent budget', () => {
  const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });
  for (let i = 0; i < 5; i += 1) limiter.check('1.2.3.4');
  assert.equal(limiter.check('1.2.3.4'), false);
  assert.equal(limiter.check('5.6.7.8'), true, 'a second IP must not be punished for the first IP\'s budget');
});

test('the window expires and the budget resets', () => {
  let clock = 0;
  const limiter = createRateLimiter({ windowMs: 60_000, max: 5, now: () => clock });
  for (let i = 0; i < 5; i += 1) limiter.check('1.2.3.4');
  assert.equal(limiter.check('1.2.3.4'), false, 'exhausted within the window');

  clock += 60_001; // one window elapsed
  assert.equal(limiter.check('1.2.3.4'), true, 'a fresh window must reopen the budget');
});

test('expired buckets are pruned rather than retained forever', () => {
  let clock = 0;
  const limiter = createRateLimiter({ windowMs: 1000, max: 5, now: () => clock });
  limiter.check('a');
  limiter.check('b');
  assert.equal(limiter.size(), 2);

  clock += 1001; // both buckets' windows have elapsed
  limiter.check('c'); // any check() call sweeps expired buckets first
  assert.equal(limiter.size(), 1, 'only the still-live key (c) should remain tracked');
});

test('the tracked-key count is capped, evicting the least-recently-touched bucket', () => {
  let clock = 0;
  const limiter = createRateLimiter({
    windowMs: 60_000, max: 5, maxTrackedKeys: 3, now: () => clock,
  });
  limiter.check('a');
  clock += 1;
  limiter.check('b');
  clock += 1;
  limiter.check('c');
  assert.equal(limiter.size(), 3);

  clock += 1;
  limiter.check('d'); // a new 4th key while none have expired yet
  assert.equal(limiter.size(), 3, 'the map must never grow past maxTrackedKeys');

  // 'a' was the least-recently-touched bucket and should have been evicted,
  // so it now starts a fresh budget rather than continuing its old one.
  clock += 1;
  for (let i = 0; i < 5; i += 1) assert.equal(limiter.check('a'), true, 'a fresh budget after eviction');
});

test('getClientIp prefers CF-Connecting-IP, the header Cloudflare sets at its edge', () => {
  const req = {
    headers: { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '198.51.100.1' },
    socket: { remoteAddress: '10.0.0.1' },
  };
  assert.equal(getClientIp(req), '203.0.113.9');
});

test('getClientIp falls back to the first X-Forwarded-For hop when Cloudflare\'s header is absent', () => {
  const req = {
    headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.2' },
    socket: { remoteAddress: '10.0.0.1' },
  };
  assert.equal(getClientIp(req), '198.51.100.1');
});

test('getClientIp falls back to the raw socket address when no proxy header is present', () => {
  const req = { headers: {}, socket: { remoteAddress: '10.0.0.1' } };
  assert.equal(getClientIp(req), '10.0.0.1');
});

test('getClientIp buckets under a fixed key when nothing usable is available, instead of throwing or exempting the request', () => {
  const req = { headers: {}, socket: {} };
  assert.equal(getClientIp(req), 'unknown');
});
