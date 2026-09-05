import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectReminderTargets,
  projectReminderOutcome,
  FIRST_REMINDER,
  MIN_HOURS_SINCE_ENTRY,
  MIN_HOURS_BEFORE_DEADLINE,
} from '../../lib/giveaway/confirm-reminder.js';

const REMINDED_BEFORE = new Date('2026-08-25T14:00:00Z');
const NOW = new Date('2026-09-05T18:00:00Z');
const DEADLINE = new Date('2026-09-15T06:59:59Z'); // 2026-09-14T23:59:59-07:00

const p = (email, created, over = {}) => ({
  email,
  createdAt: created === null ? null : new Date(created),
  isTest: false,
  ...over,
});

test('only entrants who joined after the first reminder are asked again', () => {
  const { due, skipped } = selectReminderTargets({
    unconfirmed: [
      p('before@x.com', '2026-08-20T00:00:00Z'),
      p('after@x.com', '2026-08-30T00:00:00Z'),
    ],
    alreadyRemindedBefore: REMINDED_BEFORE,
    now: NOW,
    deadline: DEADLINE,
  });

  assert.deepEqual(due.map(d => d.email), ['after@x.com']);
  assert.match(skipped.find(s => s.email === 'before@x.com').reason, /already reminded once/);
});

test('someone who entered exactly at the send instant is treated as already reminded', () => {
  // The boundary matters: the campaign went to the segment as it stood at that
  // instant, so anyone at or before it was in it.
  const { due } = selectReminderTargets({
    unconfirmed: [p('boundary@x.com', REMINDED_BEFORE.toISOString())],
    alreadyRemindedBefore: REMINDED_BEFORE,
    now: NOW,
    deadline: DEADLINE,
  });
  assert.equal(due.length, 0);
});

test('a very recent entrant is left to the confirm flow first', () => {
  const justEntered = new Date(NOW.getTime() - 3 * 3_600_000).toISOString();
  const { due, skipped } = selectReminderTargets({
    unconfirmed: [p('fresh@x.com', justEntered)],
    alreadyRemindedBefore: REMINDED_BEFORE,
    now: NOW,
    deadline: DEADLINE,
  });

  assert.equal(due.length, 0);
  assert.match(skipped[0].reason, /confirm flow still working/);
  assert.equal(MIN_HOURS_SINCE_ENTRY, 48);
});

test('test inboxes are excluded — they inflate every rate measured against the send', () => {
  const { due, skipped } = selectReminderTargets({
    unconfirmed: [
      p('real@x.com', '2026-08-30T00:00:00Z'),
      p('fillmoreecommercesolutions+gvtest-r2-a@gmail.com', '2026-08-30T00:00:00Z', { isTest: true }),
    ],
    alreadyRemindedBefore: REMINDED_BEFORE,
    now: NOW,
    deadline: DEADLINE,
  });

  assert.deepEqual(due.map(d => d.email), ['real@x.com']);
  assert.equal(skipped.find(s => s.reason === 'test profile').email,
    'fillmoreecommercesolutions+gvtest-r2-a@gmail.com');
});

test('an undateable profile is skipped, because the failure direction is "did not pester"', () => {
  const { due, skipped } = selectReminderTargets({
    unconfirmed: [p('nodate@x.com', null)],
    alreadyRemindedBefore: REMINDED_BEFORE,
    now: NOW,
    deadline: DEADLINE,
  });

  assert.equal(due.length, 0, 'an unknown entry date must never be mailed on the optimistic reading');
  assert.match(skipped[0].reason, /cannot prove they were not already reminded/);
});

test('the whole run halts near the deadline, distinguishably from "nobody was eligible"', () => {
  const nearClose = new Date(DEADLINE.getTime() - 6 * 3_600_000);
  const { due, skipped, halted } = selectReminderTargets({
    unconfirmed: [p('eligible@x.com', '2026-08-30T00:00:00Z')],
    alreadyRemindedBefore: REMINDED_BEFORE,
    now: nearClose,
    deadline: DEADLINE,
  });

  assert.equal(due.length, 0);
  assert.ok(halted, 'a caller must be able to tell "too late" from "nothing to do"');
  assert.match(halted, /entry period closes/);
  assert.equal(skipped.length, 1);
  assert.equal(MIN_HOURS_BEFORE_DEADLINE, 12);
});

test('a run comfortably before the deadline does not halt', () => {
  const { halted } = selectReminderTargets({
    unconfirmed: [p('eligible@x.com', '2026-08-30T00:00:00Z')],
    alreadyRemindedBefore: REMINDED_BEFORE,
    now: NOW,
    deadline: DEADLINE,
  });
  assert.equal(halted, null);
});

test('the projection reports the complaint rate against the published thresholds', () => {
  const out = projectReminderOutcome(1600);

  // 33/487 clicked, and a click IS the confirmation on this mechanism.
  assert.equal(out.expectedConfirmations, Math.round(1600 * (33 / 487)));
  assert.ok(out.expectedConfirmations > 100 && out.expectedConfirmations < 120,
    `expected ~108 confirmations, got ${out.expectedConfirmations}`);

  // 1/487 = 0.205% — above the 0.1% target, below the 0.3% enforcement line.
  assert.equal(out.aboveComplaintTarget, true);
  assert.equal(out.aboveComplaintEnforcement, false,
    'the first send was under the enforcement threshold; if this flips, do not send');
});

test('the measured first-reminder numbers are pinned, since every projection rests on them', () => {
  assert.equal(FIRST_REMINDER.recipients, 489);
  assert.equal(FIRST_REMINDER.delivered, 487);
  assert.equal(FIRST_REMINDER.clicksUnique, 33);
  assert.equal(FIRST_REMINDER.spamComplaints, 1);
  assert.equal(FIRST_REMINDER.campaignId, '01M0RZM53084R8VEM8A2MS63PZ');
});
