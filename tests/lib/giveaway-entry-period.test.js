// tests/lib/giveaway-entry-period.test.js
//
// The Entry Period closes at one instant, and three things must agree about it:
// the entry routes (stop accepting), the close job (stop the flows, freeze the
// pool) and the snapshot (never overwrite a frozen pool). Getting any of them
// wrong either takes entries after the rules say entries stopped, or closes the
// giveaway early on people who are still entering.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  isEntryPeriodClosed, planEntryPeriodClose, snapshotWriteRefusal,
} from '../../lib/giveaway/entry-period.js';

const CLOSES = '2026-09-14T23:59:59-07:00'; // = 2026-09-15T06:59:59Z

test('the closing instant itself is still inside the Entry Period', () => {
  assert.equal(isEntryPeriodClosed(Date.parse('2026-09-15T06:59:59Z'), CLOSES), false);
});

test('one second after the closing instant the period is closed', () => {
  assert.equal(isEntryPeriodClosed(Date.parse('2026-09-15T07:00:00Z'), CLOSES), true);
});

test('an unparseable close date throws rather than reading as open or closed', () => {
  assert.throws(() => isEntryPeriodClosed(Date.now(), 'September 14'), /entryClosesAt/);
  assert.throws(() => isEntryPeriodClosed(Date.now(), undefined), /entryClosesAt/);
});

const AFTER = Date.parse('2026-09-15T08:05:00Z');
const BEFORE = Date.parse('2026-09-15T05:05:00Z'); // the 2026-08-20 cron bug's instant

test('after close, --apply drafts EVERY live flow — the confirm flow as well as nurture', () => {
  const plan = planEntryPeriodClose({
    nowMs: AFTER,
    entryClosesAt: CLOSES,
    apply: true,
    snapshotExists: false,
    flows: [{ id: 'SajAVS', status: 'live' }, { id: 'VyjCRz', status: 'live' }],
  });
  assert.equal(plan.refused, null);
  assert.deepEqual(plan.toDraft, ['SajAVS', 'VyjCRz']);
  assert.equal(plan.takeSnapshot, true);
});

test('a flow that is already draft is skipped, and does NOT skip the snapshot', () => {
  // The old script exited before the snapshot when the nurture flow was not
  // live, so a flow drafted by hand silently meant no frozen pool.
  const plan = planEntryPeriodClose({
    nowMs: AFTER,
    entryClosesAt: CLOSES,
    apply: true,
    snapshotExists: false,
    flows: [{ id: 'SajAVS', status: 'draft' }, { id: 'VyjCRz', status: 'live' }],
  });
  assert.deepEqual(plan.toDraft, ['VyjCRz']);
  assert.equal(plan.takeSnapshot, true);
});

test('--apply BEFORE the close is refused and touches nothing', () => {
  const plan = planEntryPeriodClose({
    nowMs: BEFORE,
    entryClosesAt: CLOSES,
    apply: true,
    snapshotExists: false,
    flows: [{ id: 'SajAVS', status: 'live' }],
  });
  assert.match(plan.refused, /before/i);
  assert.deepEqual(plan.toDraft, []);
  assert.equal(plan.takeSnapshot, false);
});

test('an existing snapshot is never retaken — the annual cron re-fire must not overwrite the frozen pool', () => {
  const plan = planEntryPeriodClose({
    nowMs: AFTER,
    entryClosesAt: CLOSES,
    apply: true,
    snapshotExists: true,
    flows: [],
  });
  assert.equal(plan.takeSnapshot, false);
});

test('a dry run plans the drafts but takes no snapshot', () => {
  const plan = planEntryPeriodClose({
    nowMs: AFTER,
    entryClosesAt: CLOSES,
    apply: false,
    snapshotExists: false,
    flows: [{ id: 'SajAVS', status: 'live' }],
  });
  assert.equal(plan.refused, null);
  assert.deepEqual(plan.toDraft, ['SajAVS']);
  assert.equal(plan.takeSnapshot, false);
});

test('writing a snapshot over an existing one is refused unless forced', () => {
  assert.equal(snapshotWriteRefusal({ exists: false, force: false }), null);
  assert.match(snapshotWriteRefusal({ exists: true, force: false }), /already exists/);
  assert.equal(snapshotWriteRefusal({ exists: true, force: true }), null);
});
