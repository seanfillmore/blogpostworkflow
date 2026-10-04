import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runPressOutreach, escalationEmail, renderSummary } from '../../agents/press-outreach/index.js';
import { newDraft, approveDraft } from '../../lib/press-drafts.js';

const NOW = Date.parse('2026-10-06T18:00:00Z');
const ADDR = '1 Example Way, Testville, WY 00000';
const PITCH_TEXT = `Hi.\n\nIf this isn't a fit, just reply "no thanks" and I won't follow up.\n\nSean\nReal Skin Care\nrealskincare.com\n${ADDR}`;

const contact = (id, pitchOver = {}, over = {}) => ({
  id, name: `${id[0].toUpperCase()}${id.slice(1)} Example`, status: 'active', domains: ['example.com'],
  channels: [{ type: 'email', address: `${id}@example.com`, verified: true, source: 'https://example.com' }],
  pitches: [{ date: '2026-10-01', concept: 'intro', outcome: 'sent', subject: 'Coconut cream', message_id: `<${id}@realskincare.com>`, last_sent_at: '2026-10-01T17:00:00Z', follow_ups_sent: 0, ...pitchOver }],
  ...over,
});
const fresh = (id) => ({ id, name: `${id[0].toUpperCase()}${id.slice(1)} Example`, status: 'active', domains: ['example.com'], channels: [{ type: 'email', address: `${id}@example.com`, verified: true, source: 'https://example.com' }], pitches: [] });

function world({ replies = [], sent = [], drafts = [], state = {}, imapError = null } = {}) {
  const calls = { send: [], escalate: [], addresses: [], sleeps: [], savedDrafts: [], confirms: [] };
  const book = { contacts: [contact('jane'), contact('sam'), contact('lee', { outcome: 'escalated' })] };
  const st = { sends: [], processed: [], escalated: { lee: { at: '2026-10-02T00:00:00Z' } }, ...state };
  const opts = {
    apply: true, now: NOW, config: { enabled: true, sendVia: 'resend', dailySendCap: 10, dailySendCapRamped: 25, rampAfterDays: 14, draftExpiryDays: 14, minGapMinutes: 10 },
    book, state: st, drafts, postalAddress: ADDR,
    readReplies: async () => { if (imapError) throw imapError; return replies; },
    readSent: async () => sent,
    send: async (m) => { calls.send.push(m); return { messageId: `<s${calls.send.length}@realskincare.com>`, resendId: 'r' }; },
    saveBook: (b) => { opts.book = b; }, saveState: () => {}, saveDraft: (d) => { calls.savedDrafts.push(d); },
    escalate: async (c, msg, reason) => { calls.escalate.push({ id: c.id, reason }); },
    onAddress: async (c, p, a) => { calls.addresses.push({ id: c.id, zip: a.zip }); },
    confirmReply: async (msg, kind) => { calls.confirms.push(kind); return true; },
    sleep: async (ms) => { calls.sleeps.push(ms); },
    log: () => {},
  };
  return { opts, calls };
}
const reply = (from, text, id = `<r-${from}>`) => ({ from: `${from}@example.com`, messageId: id, text, fullText: text, subject: 'Re: Coconut cream', references: [`<${from}@realskincare.com>`], date: '2026-10-05T10:00:00Z', emojiReaction: false, autoSubmitted: false, folder: 'Cold Pitches' });
const approved = (id, over = {}) => approveDraft(newDraft({ kind: 'pitch', contactId: id, to: `${id}@example.com`, subject: 'Hi', text: PITCH_TEXT, concept: 'intro', now: NOW - 3600e3, ...over }), { now: NOW - 1800e3 });

test('a reply in a filed folder stops that contact\'s follow-up', async () => {
  const { opts, calls } = world({ replies: [reply('jane', "I'm going to pass at this time.")] });
  await runPressOutreach(opts);
  assert.equal(opts.book.contacts.find((c) => c.id === 'jane').pitches[0].outcome, 'declined');
  assert.deepEqual(calls.send.map((m) => m.to), ['sam@example.com'], 'only sam gets the day-5 follow-up');
  assert.equal(calls.send[0].inReplyTo, '<sam@realskincare.com>');
  assert.equal(calls.send[0].subject, 'Re: Coconut cream');
  assert.ok(calls.send[0].references.includes('<sam@realskincare.com>'));
  const sam = opts.book.contacts.find((c) => c.id === 'sam').pitches[0];
  assert.equal(sam.follow_ups_sent, 1);
  assert.equal(sam.last_sent_at, new Date(NOW).toISOString());
  assert.equal(opts.state.sends.length, 1);
  assert.equal(opts.state.sends[0].last_event, 'sent');
});

test('yes plus address goes to onAddress, never asks for the address again', async () => {
  const { opts, calls } = world({ replies: [reply('jane', "I'd love to try them! Ship to:\n12 Example Road\nSpringfield, IL 62704")] });
  await runPressOutreach(opts);
  assert.deepEqual(calls.addresses, [{ id: 'jane', zip: '62704' }]);
  assert.ok(!calls.send.some((m) => m.to === 'jane@example.com'));
  assert.equal(opts.book.contacts.find((c) => c.id === 'jane').pitches[0].outcome, 'sample-accepted');
});

test('escalate sends nothing to the writer; an escalated contact\'s next mail goes to Sean', async () => {
  const { opts, calls } = world({ replies: [reply('sam', 'What is your rate for a feature?'), reply('lee', 'Thanks!')] });
  const r = await runPressOutreach(opts);
  assert.deepEqual(calls.escalate.map((e) => e.id).sort(), ['lee', 'sam']);
  assert.ok(!calls.send.some((m) => ['sam@example.com', 'lee@example.com'].includes(m.to)));
  assert.ok(opts.state.escalated.sam);
  assert.equal(r.escalations.length, 2);
  assert.ok(opts.state.processed.includes('<r-sam>') && opts.state.processed.includes('<r-lee>'));
});

test('Sean writing to a contact himself counts as a touch: no automatic follow-up', async () => {
  const { opts, calls } = world({ sent: [{ to: ['sam@example.com'], date: '2026-10-05T12:00:00Z', messageId: '<hand>', subject: 'Re: Coconut cream' }] });
  await runPressOutreach(opts);
  assert.ok(!calls.send.some((m) => m.to === 'sam@example.com'));
  const p = opts.book.contacts.find((c) => c.id === 'sam').pitches[0];
  assert.equal(p.follow_ups_sent, 2);
  assert.equal(p.last_sent_at, '2026-10-05T12:00:00Z');
});

test('Sean answering an escalated contact clears the escalation', async () => {
  const { opts } = world({ sent: [{ to: ['lee@example.com'], date: '2026-10-05T12:00:00Z', messageId: '<hand>', subject: 'Re: Coconut cream' }] });
  await runPressOutreach(opts);
  assert.equal(opts.state.escalated.lee, undefined);
  assert.equal(opts.book.contacts.find((c) => c.id === 'lee').pitches[0].outcome, 'replied');
});

test('IMAP down: no follow-ups, but approved first pitches still go', async () => {
  const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  const d = approveDraft(newDraft({ kind: 'pitch', contactId: 'new', to: 'new@example.com', subject: 'Hi', text: PITCH_TEXT, concept: 'intro', now: NOW - 3600e3 }), { now: NOW - 1800e3 });
  const { opts, calls } = world({ imapError: err, drafts: [d] });
  opts.book.contacts.push(fresh('new'));
  const r = await runPressOutreach(opts);
  assert.equal(r.imapDown, true);
  assert.deepEqual(calls.send.map((m) => m.to), ['new@example.com']);
  const p = opts.book.contacts.find((c) => c.id === 'new').pitches[0];
  assert.equal(p.message_id, '<s1@realskincare.com>');
  assert.equal(p.follow_ups_sent, 0);
  assert.equal(p.draft_id, d.id);
  assert.equal(calls.savedDrafts.at(-1).status, 'sent');
  assert.equal(opts.state.first_sent_at, new Date(NOW).toISOString());
});

test('a non-transient read error is not swallowed', async () => {
  const { opts } = world({ imapError: new Error('Invalid credentials') });
  await assert.rejects(runPressOutreach(opts), /Invalid credentials/);
});

test('outside the window or paused: nothing sends', async () => {
  const sat = world(); sat.opts.now = Date.parse('2026-10-10T18:00:00Z');
  await runPressOutreach(sat.opts);
  assert.equal(sat.calls.send.length, 0);
  const paused = world({ state: { paused: { at: 'x', reason: 'complaint' } } });
  await runPressOutreach(paused.opts);
  assert.equal(paused.calls.send.length, 0);
});

test('dry run sends and saves nothing', async () => {
  const { opts, calls } = world({ replies: [reply('sam', 'What is your rate?')], drafts: [approved('jane')] });
  let saved = false; opts.apply = false; opts.saveBook = () => { saved = true; };
  await runPressOutreach(opts);
  assert.equal(calls.send.length, 0);
  assert.equal(calls.escalate.length, 0);
  assert.equal(calls.savedDrafts.length, 0);
  assert.equal(saved, false);
});

test('model does not confirm a sample-yes: escalated, nothing sent to the writer', async () => {
  const { opts, calls } = world({ replies: [reply('jane', "I'd love to try them!")] });
  opts.confirmReply = async () => false;
  await runPressOutreach(opts);
  assert.deepEqual(calls.escalate, [{ id: 'jane', reason: 'model did not confirm sample-yes' }]);
  assert.ok(!calls.send.some((m) => m.to === 'jane@example.com'));
  assert.equal(opts.book.contacts.find((c) => c.id === 'jane').pitches[0].outcome, 'escalated');
});

test('a throwing confirmer escalates too', async () => {
  const { opts, calls } = world({ replies: [reply('jane', "I'm going to pass at this time.")] });
  opts.confirmReply = async () => { throw new Error('truncated'); };
  await runPressOutreach(opts);
  assert.deepEqual(calls.escalate, [{ id: 'jane', reason: 'model did not confirm decline' }]);
});

test('confirmed sample-yes asks for the address, threaded under the reply', async () => {
  const { opts, calls } = world({ replies: [reply('jane', "I'd love to try them!")] });
  await runPressOutreach(opts);
  assert.deepEqual(calls.confirms, ['sample-yes']);
  const ask = calls.send.find((m) => m.to === 'jane@example.com');
  assert.ok(ask, 'asked for the address');
  assert.equal(ask.inReplyTo, '<r-jane>');
  assert.match(ask.text, /mailing address/);
  assert.equal(opts.book.contacts.find((c) => c.id === 'jane').pitches[0].outcome, 'sample-accepted');
});

test('sample-yes with the cap spent stays unprocessed for the next run', async () => {
  const today = new Date(NOW).toISOString();
  const sends = Array.from({ length: 10 }, (_, i) => ({ at: today, contact_id: 'x', kind: 'pitch', message_id: `<x${i}>`, resend_id: null, last_event: 'sent' }));
  const { opts, calls } = world({ replies: [reply('jane', "I'd love to try them!")], state: { sends } });
  await runPressOutreach(opts);
  assert.equal(calls.send.length, 0);
  assert.ok(!opts.state.processed.includes('<r-jane>'));
});

test('opt-out marks do_not_contact and sends nothing', async () => {
  const { opts, calls } = world({ replies: [reply('jane', 'No thanks.')] });
  await runPressOutreach(opts);
  const jane = opts.book.contacts.find((c) => c.id === 'jane');
  assert.equal(jane.status, 'do_not_contact');
  assert.equal(jane.pitches[0].outcome, 'declined');
  assert.ok(!calls.send.some((m) => m.to === 'jane@example.com'));
});

test('spacing: sleeps minGapMinutes between sends, never before the first, and caps sends per run', async () => {
  const drafts = ['a', 'b', 'c'].map((id) => approved(id));
  const { opts, calls } = world({ drafts });
  for (const id of ['a', 'b', 'c']) opts.book.contacts.push(fresh(id));
  await runPressOutreach(opts);
  // jane + sam follow-ups are due, plus 3 drafts; ceil(30/10) = 3 sends per run.
  assert.equal(calls.send.length, 3);
  assert.deepEqual(calls.sleeps, [600_000, 600_000]);
});

test('first pitches: an approved draft that no longer passes the gate goes back to pending', async () => {
  const bad = approved('new', { text: 'Hi there. No opt-out line and no address.' });
  const { opts, calls } = world({ drafts: [bad] });
  opts.book.contacts.push(fresh('new'));
  await runPressOutreach(opts);
  assert.ok(!calls.send.some((m) => m.to === 'new@example.com'));
  const saved = calls.savedDrafts.find((d) => d.id === bad.id);
  assert.equal(saved.status, 'pending');
  assert.ok(saved.gate_problems.length > 0);
});

test('first pitches need the postal address, which reaches the copy gate', async () => {
  const other = approved('new', { text: PITCH_TEXT.replace(ADDR, '9 Other St, Elsewhere, CO 80000') });
  const { opts, calls } = world({ drafts: [other] });
  opts.book.contacts.push(fresh('new'));
  await runPressOutreach(opts);
  assert.ok(!calls.send.some((m) => m.to === 'new@example.com'), 'a different address fails the gate');

  const none = world({ drafts: [approved('new')] });
  none.opts.book.contacts.push(fresh('new'));
  none.opts.postalAddress = null;
  const r = await runPressOutreach(none.opts);
  assert.ok(!none.calls.send.some((m) => m.to === 'new@example.com'));
  assert.ok(r.skipped.some((s) => /postal address/.test(s.reason)));
});

test('a bump threads under its in_reply_to and records the follow-up', async () => {
  const bump = approveDraft(newDraft({ kind: 'bump', contactId: 'jane', to: 'jane@example.com', subject: 'Re: Coconut cream', text: 'Hi Jane,\n\nBumping this.\n\nSean', inReplyTo: '<jane@realskincare.com>', concept: 'intro', now: NOW - 3600e3 }), { now: NOW - 1800e3 });
  const { opts, calls } = world({ drafts: [bump], replies: [] });
  opts.book.contacts[0].pitches[0].follow_ups_sent = 2; // no auto follow-up for jane
  await runPressOutreach(opts);
  const m = calls.send.find((x) => x.to === 'jane@example.com');
  assert.equal(m.inReplyTo, '<jane@realskincare.com>');
  assert.equal(opts.book.contacts[0].pitches[0].follow_ups_sent, 1);
});

test('an expired draft that collides with a sent copy does not crash the run', async () => {
  const old = newDraft({ kind: 'pitch', contactId: 'new', to: 'new@example.com', subject: 'Hi', text: PITCH_TEXT, concept: 'intro', now: NOW - 20 * 86_400_000 });
  const { opts } = world({ drafts: [old] });
  opts.saveDraft = () => { throw new Error('cannot overwrite sent draft'); };
  const r = await runPressOutreach(opts);
  assert.equal(r.expired.length, 1);
});

test('escalationEmail carries the reason, outlet, subject and full message', () => {
  const c = contact('jane');
  const e = escalationEmail(c, { fullText: 'Full body here', text: 'Full' }, 'money or terms');
  assert.equal(e.subject, 'Press outreach: Jane Example needs your reply');
  for (const s of ['money or terms', 'example.com', 'Coconut cream', 'Full body here', 'Reply to them from Hushmail']) assert.ok(e.body.includes(s), s);
});

test('renderSummary lists pending drafts with the dashboard link', () => {
  const pending = [newDraft({ kind: 'pitch', contactId: 'jane', to: 'jane@example.com', subject: 'Hi', text: 'x', concept: 'intro', now: NOW })];
  const r = { replies: [], escalations: [], followUps: [], sent: [], skipped: [], expired: [], failed: [], paused: false, imapDown: false };
  const s = renderSummary(r, { apply: true, drafts: pending, dashboardUrl: 'https://dash.example.com' });
  assert.match(s.body, /1 pitch(es)? waiting for approval: https:\/\/dash\.example\.com\/#outreach/);
});

test('source: first pitches send only when approved, never via the Gmail connector', () => {
  const src = readFileSync(new URL('../../agents/press-outreach/index.js', import.meta.url), 'utf8');
  assert.match(src, /sendOrder\(/, 'first pitches come from sendOrder (approved only)');
  assert.doesNotMatch(src, /claude_ai_Gmail|gmail\.googleapis/i);
  assert.match(src, /agent: 'press-outreach'/);
  assert.doesNotMatch(src, /@anthropic-ai\/sdk/);
});
