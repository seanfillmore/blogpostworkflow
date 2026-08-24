// tests/lib/giveaway-nurture-schedule.test.js
//
// The bug these guard against: every nurture email was on one relative-to-entry
// clock, but the last two are about the CONTEST clock, which is the same date
// for everyone. A day-20 entrant received "entries close September 14" on day 40
// — nine days after the winner was drawn — soliciting referrals and uploads that
// could no longer be credited to anything.
//
// The split is therefore load-bearing, not cosmetic: onboarding emails stay
// relative to entry, deadline emails become fixed-date campaigns.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  FLOW_DELAYS_HOURS,
  splitNurtureFiles,
  flowDelayDeltas,
  campaignSchedule,
  EXTERNAL_EMAILS,
} from '../../lib/giveaway/nurture-schedule.js';

const ALL = ['01-confirm.html', '02-referral.html', '03-angle.html', '04-ugc.html', '05-reminder.html', '06-final-call.html'];

test('the four onboarding emails stay in the flow; the two deadline emails do not', () => {
  const { flow, campaigns } = splitNurtureFiles(ALL);
  assert.deepEqual(flow, ['01-confirm.html', '02-referral.html', '03-angle.html', '04-ugc.html']);
  assert.deepEqual(campaigns, ['05-reminder.html', '06-final-call.html'],
    'a deadline email left in the relative flow is what sent "entries close" after the draw');
});

test('an unexpected nurture file throws rather than being silently dropped', () => {
  assert.throws(() => splitNurtureFiles([...ALL, '99-surprise.html']), /99-surprise/,
    'an unclassified email would otherwise reach neither the flow nor a campaign, and nobody would notice');
});

test('templates owned by another builder are tolerated and stay out of both buckets', () => {
  // Real files: 00-confirm-request.html belongs to build-confirm-flow.mjs and
  // 07-referral-pending.html to build-referral-audit-flow.mjs. Both sit in the
  // nurture directory, and before EXTERNAL_EMAILS existed each one threw
  // "unclassified nurture email" and stopped the nurture flow being rebuilt.
  const { flow, campaigns } = splitNurtureFiles([...ALL, ...EXTERNAL_EMAILS]);
  assert.deepEqual(flow, ['01-confirm.html', '02-referral.html', '03-angle.html', '04-ugc.html']);
  assert.deepEqual(campaigns, ['05-reminder.html', '06-final-call.html']);
  for (const f of EXTERNAL_EMAILS) {
    assert.ok(!flow.includes(f) && !campaigns.includes(f),
      `${f} belongs to another builder and must not be sent by the nurture flow or a deadline campaign`);
  }
});

test('a missing nurture file throws — a short flow must not build quietly', () => {
  assert.throws(() => splitNurtureFiles(ALL.filter((f) => f !== '03-angle.html')), /03-angle/);
});

test('flow delays cover only the onboarding emails', () => {
  assert.deepEqual(FLOW_DELAYS_HOURS, [0.5, 48, 144, 288],
    'd20 and d28 belonged to the deadline emails and must not remain in the flow');
});

test('delays convert from absolute-hours-since-entry to between-send deltas', () => {
  // Klaviyo time-delays are relative to the previous action, not to the trigger.
  assert.deepEqual(flowDelayDeltas([0.5, 48, 144, 288]), [47.5, 96, 144]);
});

test('deadline campaigns are scheduled from the close date, not hardcoded', () => {
  const s = campaignSchedule('2026-09-14T23:59:00-06:00');
  assert.equal(s.length, 2);
  assert.equal(s[0].file, '05-reminder.html');
  assert.equal(s[1].file, '06-final-call.html');
  assert.equal(s[0].sendAt.slice(0, 10), '2026-09-11', 'reminder lands 3 days before close');
  assert.equal(s[1].sendAt.slice(0, 10), '2026-09-13', 'final call lands 1 day before close');
});

test('every campaign send lands strictly before the close', () => {
  const close = '2026-09-14T23:59:00-06:00';
  const closeMs = new Date(close).getTime();
  for (const c of campaignSchedule(close)) {
    assert.ok(new Date(c.sendAt).getTime() < closeMs,
      `${c.file} must not send after entries close — that is the original bug`);
  }
});

test('moving the close date moves the campaigns with it', () => {
  const s = campaignSchedule('2026-10-31T23:59:00-06:00');
  assert.equal(s[0].sendAt.slice(0, 10), '2026-10-28');
  assert.equal(s[1].sendAt.slice(0, 10), '2026-10-30');
});

test('an invalid close date throws rather than producing Invalid Date sends', () => {
  assert.throws(() => campaignSchedule('not-a-date'), /close/i);
});
