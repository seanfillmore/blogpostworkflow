import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ordersToCheck, isEligible, pruneState, orderWindow, MIN_AGE_DAYS, MAX_AGE_DAYS, SOLICITATION_ACTION,
} from '../../lib/amazon-review-requests.js';

const eligible = { _links: { actions: [{ name: SOLICITATION_ACTION, href: '/x/productReviewAndSellerFeedback' }] } };
const requested = { _links: { actions: [] }, _embedded: { actions: [] } };

test('eligible only when Amazon still offers the review-request action', () => {
  assert.equal(isEligible(eligible), true);
  assert.equal(isEligible(requested), false, 'empty actions = already requested by any tool, never re-sent');
  assert.equal(isEligible(null), false);
});

test('each order is checked once: sent and not-eligible are final, unseen and shipped only', () => {
  const orders = [
    { AmazonOrderId: 'a', OrderStatus: 'Shipped' },
    { AmazonOrderId: 'b', OrderStatus: 'Shipped' },
    { AmazonOrderId: 'c', OrderStatus: 'Shipped' },
    { AmazonOrderId: 'd', OrderStatus: 'Canceled' },
  ];
  const state = { a: { result: 'sent' }, b: { result: 'not-eligible' } };
  assert.deepEqual(ordersToCheck(orders, state).map((o) => o.AmazonOrderId), ['c']);
});

test('the window starts at day 10 so the existing follow-up tool goes first', () => {
  const now = Date.parse('2026-10-31T00:00:00Z');
  const w = orderWindow(now);
  assert.equal(MIN_AGE_DAYS, 10);
  assert.equal(w.createdBefore, '2026-10-21T00:00:00.000Z');
  assert.equal(w.createdAfter, new Date(now - MAX_AGE_DAYS * 864e5).toISOString());
});

test('state older than the retention window is pruned', () => {
  const now = Date.parse('2026-10-31T00:00:00Z');
  const s = pruneState({ old: { at: '2026-09-01T00:00:00Z' }, recent: { at: '2026-10-20T00:00:00Z' } }, now);
  assert.deepEqual(Object.keys(s), ['recent']);
});
