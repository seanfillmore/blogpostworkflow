// tests/lib/giveaway-deliverability.test.js
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  assessDeliverability, SPAM_RATE_BLOCK, SPAM_RATE_TARGET, MIN_SAMPLE,
} from '../../lib/giveaway/deliverability.js';
import { windowBounds } from '../../scripts/giveaway/deliverability-check.mjs';

test('a clean domain is cleared to send', () => {
  const r = assessDeliverability({ received: 1000, spam: 0, bounced: 5 });
  assert.equal(r.verdict, 'send');
});

test('REGRESSION: the real 2026-08-24 backfill day is a HOLD, not a pass', () => {
  // 953 received, 3 spam = 0.315% — over Google/Yahoo's 0.30% enforcement line.
  // This is the exact number that stopped the consolation offer going out that
  // week, and the case the whole gate exists for: it looks like "only 3
  // complaints" and is in fact a blocking rate.
  const r = assessDeliverability({ received: 953, spam: 3, bounced: 14 });
  assert.equal(r.verdict, 'hold');
  assert.ok(r.reasons.some((x) => /enforcement line/.test(x)), r.reasons.join('; '));
  assert.ok(Math.abs(r.spamRate - 0.003147) < 1e-5);
});

test('between the target and the enforcement line is caution, not hold', () => {
  // 0.2% — above Google's "keep under 0.1%" but below the 0.3% line.
  const r = assessDeliverability({ received: 1000, spam: 2, bounced: 0 });
  assert.equal(r.verdict, 'caution');
  assert.ok(r.reasons.some((x) => /above the 0.1% target/.test(x)));
});

test('exactly at the enforcement line holds — the threshold is inclusive', () => {
  const r = assessDeliverability({ received: 1000, spam: 3, bounced: 0 });
  assert.equal(r.spamRate, SPAM_RATE_BLOCK);
  assert.equal(r.verdict, 'hold');
});

test('a high bounce rate holds on its own, with clean spam', () => {
  const r = assessDeliverability({ received: 1000, spam: 0, bounced: 25 });
  assert.equal(r.verdict, 'hold');
  assert.ok(r.reasons.some((x) => /bounce rate/.test(x)));
});

test('both failures are reported, not just the first', () => {
  // "spam is fine but bounces are not" is a different fix from either alone, so
  // short-circuiting on the first would hide half the problem.
  const r = assessDeliverability({ received: 1000, spam: 5, bounced: 30 });
  assert.equal(r.verdict, 'hold');
  assert.equal(r.reasons.length, 2);
});

test('a small sample is insufficient-data, never a pass', () => {
  // One complaint in 40 sends is 2.5% and means nothing. Reporting that as a
  // hold would be as wrong as reporting 0 complaints in 40 as a clean bill.
  const r = assessDeliverability({ received: 40, spam: 1, bounced: 0 });
  assert.equal(r.verdict, 'insufficient-data');
  const clean = assessDeliverability({ received: 40, spam: 0, bounced: 0 });
  assert.equal(clean.verdict, 'insufficient-data', 'a quiet small sample is not evidence of health');
});

test('the sample floor is the boundary, not an off-by-one', () => {
  assert.equal(assessDeliverability({ received: MIN_SAMPLE - 1, spam: 0 }).verdict, 'insufficient-data');
  assert.equal(assessDeliverability({ received: MIN_SAMPLE, spam: 0 }).verdict, 'send');
});

test('zero sends does not divide by zero', () => {
  const r = assessDeliverability({});
  assert.equal(r.verdict, 'insufficient-data');
  assert.equal(r.spamRate, null);
});

test('the thresholds are the mailbox providers\' published numbers', () => {
  // Pinned so a future "we really want to send this week" cannot quietly move
  // the line. These are Google/Yahoo bulk-sender requirements, not house style.
  assert.equal(SPAM_RATE_BLOCK, 0.003);
  assert.equal(SPAM_RATE_TARGET, 0.001);
});

test('windowBounds covers whole UTC days through the end of today', () => {
  const { start, end } = windowBounds(new Date('2026-08-24T23:15:00Z'), 7);
  assert.equal(end, '2026-08-25T00:00:00.000Z', 'exclusive end is midnight after today');
  assert.equal(start, '2026-08-18T00:00:00.000Z', '7 whole days back');
});
