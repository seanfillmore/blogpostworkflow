import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBroadcast, recordBroadcast } from '../../lib/creator-broadcast.js';

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
