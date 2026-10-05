import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPressOutreach } from '../../agents/press-outreach/index.js';
import { newDraft, approveDraft } from '../../lib/press-drafts.js';

// FAKE DATA ONLY: invented people on example.com.
const NOW = Date.parse('2026-10-06T18:00:00Z');

const contact = (id, pitchOver = {}) => ({
  id, name: `${id[0].toUpperCase()}${id.slice(1)} Example`, status: 'active', domains: ['example.com'],
  channels: [{ type: 'email', address: `${id}@example.com`, verified: true, source: 'https://example.com' }],
  pitches: [{ date: '2026-10-01', concept: 'intro', outcome: 'sent', subject: 'Coconut cream', message_id: `<${id}@realskincare.com>`, references: [], last_sent_at: '2026-10-01T17:00:00Z', follow_ups_sent: 0, ...pitchOver }],
});

function world({ replies = [], drafts = [], imapError = null, contacts = null } = {}) {
  const calls = { send: [], savedDrafts: [] };
  const disk = new Map(drafts.map((d) => [d.id, d]));
  const opts = {
    apply: true, now: NOW, config: { enabled: true, sendVia: 'resend', dailySendCap: 10, dailySendCapRamped: 25, rampAfterDays: 14, draftExpiryDays: 14, minGapMinutes: 10 },
    book: { contacts: contacts || [contact('jane'), contact('sam')] },
    state: { sends: [], processed: [], escalated: {} }, drafts, postalAddress: '1 Example Way, Testville, WY 00000',
    readReplies: async () => { if (imapError) throw imapError; return replies; },
    readSent: async () => [],
    send: async (m) => { calls.send.push(m); return { messageId: `<s${calls.send.length}@realskincare.com>`, resendId: 'r' }; },
    saveBook: (b) => { opts.book = b; }, saveState: () => {},
    saveDraft: (d) => { calls.savedDrafts.push(d); disk.set(d.id, d); }, readDraft: (id) => disk.get(id) || null,
    escalate: async () => {}, tellSean: async () => {}, onAddress: async () => {},
    graphql: async () => { throw new Error('unexpected Shopify call'); },
    confirmReply: async () => true, sleep: async () => {}, reportError: async () => {}, log: () => {},
  };
  return { opts, calls };
}

const followup = (id, n, over = {}) => approveDraft(newDraft({
  kind: 'followup', n, contactId: id, to: `${id}@example.com`, subject: 'Re: Coconut cream',
  text: `Hi ${id},\n\nYour cold weather list made me think of our Rose Petal lotion. Would a bottle help your next one?\n\nSean`,
  inReplyTo: `<${id}@realskincare.com>`, references: [`<${id}@realskincare.com>`], concept: 'intro', now: NOW - 3600e3, ...over,
}), { now: NOW - 1800e3 });

test('a due follow-up is NOT sent by the 30-minute run without an approved draft', async () => {
  const { opts, calls } = world();
  const r = await runPressOutreach(opts);
  assert.deepEqual(calls.send, []);
  assert.deepEqual(r.followUps, []);
  for (const c of opts.book.contacts) assert.equal(c.pitches[0].follow_ups_sent, 0);
});

test('an approved followup sends threaded under the pitch and sets follow_ups_sent = max(existing, n)', async () => {
  const { opts, calls } = world({ drafts: [followup('jane', 2)], contacts: [contact('jane', { follow_ups_sent: 1 })] });
  const r = await runPressOutreach(opts);
  assert.equal(calls.send.length, 1);
  const m = calls.send[0];
  assert.equal(m.to, 'jane@example.com');
  assert.equal(m.subject, 'Re: Coconut cream');
  assert.equal(m.inReplyTo, '<jane@realskincare.com>');
  assert.ok(m.references.includes('<jane@realskincare.com>'));
  const p = opts.book.contacts[0].pitches[0];
  assert.equal(p.follow_ups_sent, 2);
  assert.equal(p.last_sent_at, new Date(NOW).toISOString());
  assert.equal(calls.savedDrafts.at(-1).status, 'sent');
  assert.equal(opts.state.sends[0].kind, 'followup');
  assert.deepEqual(r.followUps.map((f) => [f.id, f.n]), [['jane', 2]]);
});

test('a first follow-up never lowers a count already at 2 (redrafted September bumps)', async () => {
  const { opts, calls } = world({ drafts: [followup('jane', 1)], contacts: [contact('jane', { follow_ups_sent: 2 })] });
  await runPressOutreach(opts);
  assert.equal(calls.send.length, 1);
  assert.equal(opts.book.contacts[0].pitches[0].follow_ups_sent, 2);
});

test('an approved followup expires, unsent, once the writer replied ("thread moved on")', async () => {
  const reply = { from: 'jane@example.com', messageId: '<r-jane>', text: "I'm going to pass at this time.", fullText: "I'm going to pass at this time.", subject: 'Re: Coconut cream', references: ['<jane@realskincare.com>'], date: '2026-10-05T10:00:00Z', emojiReaction: false, autoSubmitted: false };
  const { opts, calls } = world({ replies: [reply], drafts: [followup('jane', 1)] });
  const r = await runPressOutreach(opts);
  assert.ok(!calls.send.some((m) => m.to === 'jane@example.com'));
  const saved = calls.savedDrafts.find((d) => d.kind === 'followup');
  assert.equal(saved.status, 'expired');
  assert.equal(saved.expired_reason, 'thread moved on');
  assert.ok(r.expired.some((e) => e.reason === 'thread moved on'));
});

test('an approved followup is held, still approved, while IMAP is down', async () => {
  const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  const { opts, calls } = world({ imapError: err, drafts: [followup('jane', 1)] });
  const r = await runPressOutreach(opts);
  assert.deepEqual(calls.send, []);
  assert.ok(!calls.savedDrafts.some((d) => d.kind === 'followup'));
  assert.ok(r.skipped.some((s) => /followup held/.test(s.reason)));
});
