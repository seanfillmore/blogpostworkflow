// The nudge policy. What matters here is RESTRAINT: a repeated consent request to someone
// ignoring it is indistinguishable from spam, and a complaint against the sending domain
// costs far more than the eight entries this is chasing.
import assert from 'node:assert/strict';
import test from 'node:test';
import { selectNudgeTargets, MIN_HOURS_BETWEEN, MAX_NUDGES }
  from '../../scripts/giveaway/nudge-unconfirmed.mjs';

const HOUR = 36e5;
const NOW = new Date('2026-08-22T12:00:00Z').getTime();
const p = (email, props) => ({ email, properties: props });

test('nudges only unconfirmed entrants past the quiet period', () => {
  const { due, skipped } = selectNudgeTargets({
    now: NOW,
    confirmedEmails: ['done@x.com'],
    submitted: [
      p('done@x.com',   { gv_entered_at: new Date(NOW - 72 * HOUR).toISOString() }),
      p('waiting@x.com',{ gv_entered_at: new Date(NOW - 72 * HOUR).toISOString() }),
      p('fresh@x.com',  { gv_entered_at: new Date(NOW - 2 * HOUR).toISOString() }),
    ],
  });
  assert.deepEqual(due.map(d => d.email), ['waiting@x.com']);
  assert.equal(due[0].nudgeNumber, 1);
  assert.match(skipped.find(s => s.email === 'done@x.com').why, /confirmed/);
  assert.match(skipped.find(s => s.email === 'fresh@x.com').why, /only 2\.0h/);
});

// The stamp is the memory. Without it a re-run re-sends to everyone, every run.
test('respects the gap between nudges and the lifetime cap', () => {
  const entered = new Date(NOW - 240 * HOUR).toISOString();
  const { due, skipped } = selectNudgeTargets({
    now: NOW, confirmedEmails: [],
    submitted: [
      p('recent@x.com', { gv_entered_at: entered, gv_confirm_nudges: 1, gv_last_nudge_at: new Date(NOW - 3 * HOUR).toISOString() }),
      p('ready@x.com',  { gv_entered_at: entered, gv_confirm_nudges: 1, gv_last_nudge_at: new Date(NOW - 60 * HOUR).toISOString() }),
      p('maxed@x.com',  { gv_entered_at: entered, gv_confirm_nudges: MAX_NUDGES, gv_last_nudge_at: new Date(NOW - 500 * HOUR).toISOString() }),
    ],
  });
  assert.deepEqual(due.map(d => d.email), ['ready@x.com']);
  assert.equal(due[0].nudgeNumber, 2, 'counts up from the stamp, not from zero');
  assert.match(skipped.find(s => s.email === 'maxed@x.com').why, new RegExp(`capped at ${MAX_NUDGES}`));
});

// gv_confirmed_at is durable proof; the SUBSCRIBED set is a point-in-time read. Someone who
// confirmed and later unsubscribed must never be chased again — see reconcile.js.
test('a confirmed-then-unsubscribed entrant is left alone', () => {
  const { due } = selectNudgeTargets({
    now: NOW, confirmedEmails: [],
    submitted: [p('gone@x.com', {
      gv_entered_at: new Date(NOW - 300 * HOUR).toISOString(),
      gv_confirmed_at: new Date(NOW - 290 * HOUR).toISOString(),
    })],
  });
  assert.deepEqual(due, [], 'confirmation is history, not current consent');
});

test('the quiet period is measured from entry when no nudge has been sent', () => {
  const justUnder = selectNudgeTargets({
    now: NOW, confirmedEmails: [],
    submitted: [p('a@x.com', { gv_entered_at: new Date(NOW - (MIN_HOURS_BETWEEN - 1) * HOUR).toISOString() })],
  });
  assert.equal(justUnder.due.length, 0);
  const justOver = selectNudgeTargets({
    now: NOW, confirmedEmails: [],
    submitted: [p('a@x.com', { gv_entered_at: new Date(NOW - (MIN_HOURS_BETWEEN + 1) * HOUR).toISOString() })],
  });
  assert.equal(justOver.due.length, 1);
});
