import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBroadcast, recordBroadcast, holdUntilDelivered, isExpired } from '../../lib/creator-broadcast.js';
import { sendMail } from '../../lib/hushmail.js';

// FAKE DATA ONLY: invented people on example.com.
const msg = (email) => ({ email, subject: 'Ideas', body: 'Hi' });
const state = {
  creators: {
    'ok@example.com': {},
    'flagged@example.com': { escalatedOpen: true },
    'resolved@example.com': { escalatedOpen: false },
    'done@example.com': { broadcasts: { 'cream-ideas': { at: '2026-10-20T00:00:00Z' } } },
  },
};

test('sends to known, unflagged creators and skips the rest with a reason', () => {
  const { send, skipped } = planBroadcast(
    [msg('OK@example.com'), msg('flagged@example.com'), msg('resolved@example.com'), msg('done@example.com'), msg('stranger@example.com'), msg('ok@example.com')],
    state, 'cream-ideas');
  assert.deepEqual(send.map((s) => s.email), ['ok@example.com', 'resolved@example.com']);
  assert.deepEqual(Object.fromEntries(skipped.map((s) => [s.email, s.reason.split(' ')[0]])), {
    'flagged@example.com': 'open', 'done@example.com': 'already', 'stranger@example.com': 'not', 'ok@example.com': 'duplicate',
  });
});

test('another broadcast id is not blocked by an earlier one', () => {
  const { send } = planBroadcast([msg('done@example.com')], state, 'lotion-ideas');
  assert.equal(send.length, 1);
});

test('refuses a malformed id or message', () => {
  assert.throws(() => planBroadcast([], state, 'Bad Id'), /broadcast id/);
  assert.throws(() => planBroadcast([{ email: 'ok@example.com', subject: 'S' }], state, 'x'), /needs email, subject and body/);
});

test('recording marks the broadcast and restarts the scheduled-mail gap', () => {
  const rec = recordBroadcast({ broadcasts: { old: { at: 'a' } } }, 'cream-ideas', { at: 't', messageId: '<m>', subject: 'S', attachments: ['b.pdf'] });
  assert.deepEqual(Object.keys(rec.broadcasts), ['old', 'cream-ideas']);
  assert.equal(rec.lastScheduledAt, 't');
});

test('a planned message is accepted by sendMail as-is (the 2026-10-20 bug: it lacked "to")', async () => {
  const { send } = planBroadcast([msg('ok@example.com')], state, 'cream-ideas');
  let body;
  await sendMail({ user: 'sean@realskincare.com', pass: 'x' }, { ...send[0].message, attachments: [{ filename: 'b.pdf', content: Buffer.from('x') }] }, {
    via: 'resend', resendKey: 'k',
    fetchImpl: async (_u, init) => { body = JSON.parse(init.body); return { ok: true, text: async () => '{"id":"r"}' }; },
    appendSent: async () => {},
  });
  assert.deepEqual(body.to, ['ok@example.com']);
  assert.equal(body.text, 'Hi');
});

// FAKE DATA ONLY: invented sample orders.
const order = (email, fulfillments, extra = {}) => ({ email, tags: ['sample-request', 'trybe'], note: 'Trybe sample request for Test Person', fulfillments, ...extra });
const NOW = Date.parse('2026-10-24T12:00:00Z');

test('holds a message until the sample is delivered and old enough', () => {
  const orders = [
    order('ready@example.com', [{ status: 'SUCCESS', displayStatus: 'DELIVERED', deliveredAt: '2026-10-17T10:00:00Z' }]),
    order('fresh@example.com', [{ status: 'SUCCESS', displayStatus: 'DELIVERED', deliveredAt: '2026-10-22T10:00:00Z' }]),
    order('transit@example.com', [{ status: 'SUCCESS', displayStatus: 'IN_TRANSIT' }]),
    order('notsample@example.com', [{ status: 'SUCCESS', displayStatus: 'DELIVERED', deliveredAt: '2026-10-01T10:00:00Z' }], { tags: ['wholesale'] }),
  ];
  const { ready, waiting } = holdUntilDelivered(
    [msg('Ready@example.com'), msg('fresh@example.com'), msg('transit@example.com'), msg('notsample@example.com'), msg('noorder@example.com')],
    orders, { now: NOW, afterDays: 5 });
  assert.deepEqual(ready.map((m) => m.email), ['Ready@example.com']);
  assert.deepEqual(waiting.map((w) => w.email), ['fresh@example.com', 'transit@example.com', 'notsample@example.com', 'noorder@example.com']);
  assert.match(waiting[0].reason, /waiting until 5 days/);
});

test('a creator with an older delivered sample is ready even while a newer one is in transit', () => {
  const orders = [
    order('two@example.com', [{ status: 'SUCCESS', displayStatus: 'DELIVERED', deliveredAt: '2026-10-02T10:00:00Z' }]),
    order('two@example.com', [{ status: 'SUCCESS', displayStatus: 'IN_TRANSIT' }]),
  ];
  assert.equal(holdUntilDelivered([msg('two@example.com')], orders, { now: NOW, afterDays: 5 }).ready.length, 1);
});

test('expiry is inclusive of its own day and rejects a malformed date', () => {
  assert.equal(isExpired(undefined, NOW), false);
  assert.equal(isExpired('2026-10-24', NOW), false);
  assert.equal(isExpired('2026-10-23', NOW), true);
  assert.throws(() => isExpired('Nov 15', NOW), /YYYY-MM-DD/);
});
