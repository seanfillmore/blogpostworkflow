/**
 * Send policy for the double-opt-in confirmation nudge.
 *
 * The rule these tests exist to protect is "never nudge someone who has already
 * confirmed". A confirmation request sent to someone who already confirmed is
 * not a no-op — it reads as broken, invites a spam complaint against the sending
 * domain, and undermines the one email in this campaign whose whole job is to be
 * believed. The cap and the gap protect the same thing from the other direction.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectNudgeTargets, MIN_HOURS_BETWEEN, MAX_NUDGES } from '../../scripts/giveaway/nudge-unconfirmed.mjs';

const NOW = Date.parse('2026-08-25T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 36e5).toISOString();

const entrant = (email, props = {}) => ({
  email,
  properties: { gv_entered_at: hoursAgo(72), ...props },
});

const reasons = (skipped, email) => skipped.find((s) => s.email === email)?.why ?? null;

test('an unconfirmed entrant past the gap is due', () => {
  const { due } = selectNudgeTargets({
    submitted: [entrant('a@x.com')], confirmedEmails: [], now: NOW,
  });
  assert.equal(due.length, 1);
  assert.equal(due[0].email, 'a@x.com');
  assert.equal(due[0].nudgeNumber, 1);
});

test('someone on the confirmed list is never nudged', () => {
  const { due, skipped } = selectNudgeTargets({
    submitted: [entrant('a@x.com')], confirmedEmails: ['a@x.com'], now: NOW,
  });
  assert.equal(due.length, 0);
  assert.equal(reasons(skipped, 'a@x.com'), 'confirmed');
});

test('confirmed matching is case-insensitive — a case difference must not leak a nudge', () => {
  const { due } = selectNudgeTargets({
    submitted: [entrant('Alice@X.com')], confirmedEmails: ['alice@x.com'], now: NOW,
  });
  assert.equal(due.length, 0, 'a case mismatch must not defeat the confirmed check');
});

test('the gv_confirmed_at stamp alone is enough to skip, even if the list read missed them', () => {
  // The list read and the stamp are two independent sightings of the same fact.
  // Klaviyo pagination or a mid-run confirmation can drop someone from the
  // former; the stamp is what makes the check survive that.
  const { due, skipped } = selectNudgeTargets({
    submitted: [entrant('a@x.com', { gv_confirmed_at: hoursAgo(1) })],
    confirmedEmails: [], now: NOW,
  });
  assert.equal(due.length, 0);
  assert.equal(reasons(skipped, 'a@x.com'), 'confirmed');
});

test('nobody is contacted twice inside the minimum gap', () => {
  const { due, skipped } = selectNudgeTargets({
    submitted: [entrant('a@x.com', {
      gv_confirm_nudges: 1, gv_last_nudge_at: hoursAgo(MIN_HOURS_BETWEEN - 1),
    })],
    confirmedEmails: [], now: NOW,
  });
  assert.equal(due.length, 0);
  assert.match(reasons(skipped, 'a@x.com'), /since last contact/);
});

test('a fresh entry is measured from entry, so it is not nudged immediately', () => {
  const { due } = selectNudgeTargets({
    submitted: [entrant('a@x.com', { gv_entered_at: hoursAgo(2) })],
    confirmedEmails: [], now: NOW,
  });
  assert.equal(due.length, 0, 'entering is itself the last contact');
});

test('the cap is absolute — someone who never confirms is eventually left alone', () => {
  const { due, skipped } = selectNudgeTargets({
    submitted: [entrant('a@x.com', {
      gv_confirm_nudges: MAX_NUDGES, gv_last_nudge_at: hoursAgo(500),
    })],
    confirmedEmails: [], now: NOW,
  });
  assert.equal(due.length, 0);
  assert.match(reasons(skipped, 'a@x.com'), /capped/);
});

test('nudge numbers increment so the cap can actually be reached', () => {
  const { due } = selectNudgeTargets({
    submitted: [entrant('a@x.com', {
      gv_confirm_nudges: 2, gv_last_nudge_at: hoursAgo(MIN_HOURS_BETWEEN + 1),
    })],
    confirmedEmails: [], now: NOW,
  });
  assert.equal(due[0].nudgeNumber, 3);
});

test('a mixed batch splits correctly', () => {
  const { due } = selectNudgeTargets({
    submitted: [
      entrant('due@x.com'),
      entrant('confirmed@x.com'),
      entrant('fresh@x.com', { gv_entered_at: hoursAgo(1) }),
      entrant('capped@x.com', { gv_confirm_nudges: MAX_NUDGES }),
    ],
    confirmedEmails: ['confirmed@x.com'], now: NOW,
  });
  assert.deepEqual(due.map((d) => d.email), ['due@x.com']);
});
