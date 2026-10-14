import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carryPaidItems } from '../../lib/calendar-carry.js';

const NOW = new Date('2026-10-14T12:00:00Z'); // Wednesday
const item = (slug, date) => ({ slug, keyword: slug.replace(/-/g, ' '), publish_date: date });
const cleared = (slug, reason = 'not_reproposed', postLive = false) => ({ slug, reason, postLive });

test('carries a not-reproposed item that has a brief', () => {
  const out = carryPaidItems({
    newItems: [item('a', '2026-10-19T15:00:00.000Z')],
    cleared: [cleared('paid')],
    previous: [item('paid', '2026-10-22T15:00:00.000Z')],
    hasPaidWork: (s) => s === 'paid',
    now: NOW,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].slug, 'paid');
  assert.equal(out[0].publish_date, '2026-10-22T15:00:00.000Z'); // future and free: kept
  assert.match(out[0].carried_reason, /paid work/);
});

test('an idea with no brief or draft is NOT carried', () => {
  const out = carryPaidItems({
    newItems: [], cleared: [cleared('idea')], previous: [item('idea', '2026-10-22T15:00:00.000Z')],
    hasPaidWork: () => false, now: NOW,
  });
  assert.equal(out.length, 0);
});

test('a filter verdict is honoured: covered, rejected, dud and completed stay cleared', () => {
  for (const reason of ['already_covered', 'rejected', 'cluster_dud', 'possible_duplicate', 'completed']) {
    const out = carryPaidItems({
      newItems: [], cleared: [cleared('x', reason)], previous: [item('x', '2026-10-22T15:00:00.000Z')],
      hasPaidWork: () => true, now: NOW,
    });
    assert.equal(out.length, 0, reason);
  }
});

test('an overdue or colliding item is re-slotted AFTER the plan, one per Mon/Thu, never two a day', () => {
  const out = carryPaidItems({
    newItems: [item('a', '2026-10-19T15:00:00.000Z'), item('b', '2026-10-22T15:00:00.000Z')],
    cleared: [cleared('old1'), cleared('old2'), cleared('clash')],
    previous: [
      item('old1', '2026-10-01T15:00:00.000Z'),
      item('old2', '2026-10-02T15:00:00.000Z'),
      item('clash', '2026-10-19T15:00:00.000Z'),
    ],
    hasPaidWork: () => true, now: NOW,
  });
  const dates = out.map((o) => o.publish_date.slice(0, 10));
  assert.deepEqual(dates, ['2026-10-26', '2026-10-29', '2026-11-02']);
  for (const d of dates) assert.ok([1, 4].includes(new Date(d + 'T15:00:00Z').getUTCDay()));
});

test('a hasPaidWork that throws fails closed for that item, not the run', () => {
  const out = carryPaidItems({
    newItems: [], cleared: [cleared('boom')], previous: [item('boom', '2026-10-22T15:00:00.000Z')],
    hasPaidWork: () => { throw new Error('disk'); }, now: NOW,
  });
  assert.equal(out.length, 0);
});

test('an undated backlog item stays undated, so pipeline-prioritizer still decides when', () => {
  const out = carryPaidItems({
    newItems: [item('a', '2026-10-19T15:00:00.000Z')],
    cleared: [cleared('idea')], previous: [{ slug: 'idea', keyword: 'idea', publish_date: null }],
    hasPaidWork: () => true, now: NOW,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].publish_date, null);
});
