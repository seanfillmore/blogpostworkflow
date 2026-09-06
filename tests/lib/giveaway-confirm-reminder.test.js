import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectReminderTargets,
  projectReminderOutcome,
  FIRST_REMINDER,
  REMINDER_SENDS,
  LATEST_REMINDER,
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

test('yield is sized from the LATEST send, not the first or an average', () => {
  const out = projectReminderOutcome(1000);

  // #2 confirmed 22/896 = 2.46%, less than half #1's 6.78%. Each reminder mails
  // a colder cohort, so the newest number is the only one describing who is left.
  assert.equal(out.basis.yieldFrom, '#2');
  assert.equal(out.expectedConfirmations, Math.round(1000 * (22 / 896)));
  assert.ok(out.expectedConfirmations > 20 && out.expectedConfirmations < 30,
    `expected ~25 per 1,000, got ${out.expectedConfirmations}`);

  // Sizing from #1 would have promised ~68 — nearly 3x what the last send produced.
  const fromFirstOnly = projectReminderOutcome(1000, [REMINDER_SENDS[0]]);
  assert.ok(fromFirstOnly.expectedConfirmations > out.expectedConfirmations * 2.5,
    'the old single-send basis over-promised by well over 2x');
});

test('complaints are sized from the WORST send, because the risk is asymmetric', () => {
  const out = projectReminderOutcome(1000);

  // Both sends, worst wins: 3/896 = 0.335% beats 1/487 = 0.205%.
  assert.equal(out.basis.complaintsFrom, '#2');
  assert.equal(out.spamRate, 3 / 896);

  // Order must not matter — it is a max, not "the last one".
  const reversed = projectReminderOutcome(1000, [REMINDER_SENDS[1], REMINDER_SENDS[0]]);
  assert.equal(reversed.spamRate, out.spamRate, 'worst-send selection is order-independent');
});

test('the enforcement flag fires on current evidence — the whole point of the change', () => {
  const now = projectReminderOutcome(1000);
  assert.equal(now.aboveComplaintTarget, true);
  assert.equal(now.aboveComplaintEnforcement, true,
    '0.335% is above the 0.3% Google/Yahoo line; the guard must say so');

  // The defect being fixed: sized from #1 alone it reported "below enforcement",
  // under-warning at exactly the moment it mattered.
  const oldBasis = projectReminderOutcome(1000, [REMINDER_SENDS[0]]);
  assert.equal(oldBasis.aboveComplaintEnforcement, false,
    'reproduces the under-warning the single-send basis produced');
});

test('the measured sends are pinned, since every projection rests on them', () => {
  assert.equal(REMINDER_SENDS.length, 2);
  assert.equal(FIRST_REMINDER, REMINDER_SENDS[0], 'back-compatible alias still points at #1');
  assert.equal(LATEST_REMINDER, REMINDER_SENDS[1]);

  assert.equal(REMINDER_SENDS[0].delivered, 487);
  assert.equal(REMINDER_SENDS[0].clicksUnique, 33);
  assert.equal(REMINDER_SENDS[0].spamComplaints, 1);

  assert.equal(REMINDER_SENDS[1].delivered, 896);
  assert.equal(REMINDER_SENDS[1].clicksUnique, 22);
  assert.equal(REMINDER_SENDS[1].spamComplaints, 3);
});
