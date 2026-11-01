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
  const calls = { send: [], escalate: [], addresses: [], sleeps: [], savedDrafts: [], confirms: [], errors: [], order: [] };
  const book = { contacts: [contact('jane'), contact('sam'), contact('lee', { outcome: 'escalated' })] };
  const st = { sends: [], processed: [], escalated: { lee: { at: '2026-10-02T00:00:00Z' } }, ...state };
  // The drafts directory as the dashboard sees it: what the run saved, else what it loaded.
  const disk = new Map(drafts.map((d) => [d.id, d]));
  calls.disk = disk;
  const opts = {
    apply: true, now: NOW, config: { enabled: true, sendVia: 'resend', dailySendCap: 10, dailySendCapRamped: 25, rampAfterDays: 14, draftExpiryDays: 14, minGapMinutes: 10 },
    book, state: st, drafts, postalAddress: ADDR,
    readReplies: async () => { if (imapError) throw imapError; return replies; },
    readSent: async () => sent,
    send: async (m) => { calls.send.push(m); return { messageId: `<s${calls.send.length}@realskincare.com>`, resendId: 'r' }; },
    saveBook: (b) => { opts.book = b; }, saveState: () => {}, saveDraft: (d) => { calls.savedDrafts.push(d); disk.set(d.id, d); },
    readDraft: (id) => disk.get(id) || null,
    escalate: async (c, msg, reason) => { calls.escalate.push({ id: c.id, reason }); },
    onAddress: async (c, p, a) => { calls.addresses.push({ id: c.id, zip: a.zip }); },
    tellSean: async (m) => { calls.escalate.push({ tell: m.subject }); },
    // Never the real Shopify: a test that reaches it fails loudly.
    graphql: async (q) => {
      if (/accessScopes/.test(q)) return { currentAppInstallation: { accessScopes: [{ handle: 'read_orders' }] } };
      if (/^query\(\$q/.test(q)) return { orders: { nodes: [] } };
      throw new Error(`unexpected Shopify call: ${q.slice(0, 60)}`);
    },
    confirmReply: async (msg, kind) => { calls.confirms.push(kind); return true; },
    sleep: async (ms) => { calls.sleeps.push(ms); },
    reportError: async (subject, body) => { calls.errors.push({ subject, body }); },
    log: () => {},
  };
  return { opts, calls };
}
const reply = (from, text, id = `<r-${from}>`) => ({ from: `${from}@example.com`, messageId: id, text, fullText: text, subject: 'Re: Coconut cream', references: [`<${from}@realskincare.com>`], date: '2026-10-05T10:00:00Z', emojiReaction: false, autoSubmitted: false, folder: 'Cold Pitches' });
const approved = (id, over = {}) => approveDraft(newDraft({ kind: 'pitch', contactId: id, to: `${id}@example.com`, subject: 'Hi', text: PITCH_TEXT, concept: 'intro', now: NOW - 3600e3, ...over }), { now: NOW - 1800e3 });

test('a reply in a filed folder is read; nothing is followed up automatically any more', async () => {
  const { opts, calls } = world({ replies: [reply('jane', "I'm going to pass at this time.")] });
  await runPressOutreach(opts);
  assert.equal(opts.book.contacts.find((c) => c.id === 'jane').pitches[0].outcome, 'declined');
  assert.deepEqual(calls.send, [], 'sam is due a day-5 follow-up, but only an approved followup draft may send it');
  const sam = opts.book.contacts.find((c) => c.id === 'sam').pitches[0];
  assert.equal(sam.follow_ups_sent, 0);
  assert.equal(opts.state.sends.length, 0);
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
  // 3 approved drafts; ceil(30/10) = 3 sends per run.
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
  assert.equal(opts.book.contacts[0].pitches[0].follow_ups_sent, 2, 'a bump never lowers the follow-up count');
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

const bumpFor = (id) => approveDraft(newDraft({ kind: 'bump', contactId: id, to: `${id}@example.com`, subject: 'Re: Coconut cream', text: `Hi,\n\nBumping this.\n\nSean`, inReplyTo: `<${id}@realskincare.com>`, concept: 'intro', now: NOW - 3600e3 }), { now: NOW - 1800e3 });

test('fix 1: a bump is not sent once the writer replied this run; the draft expires', async () => {
  const { opts, calls } = world({ replies: [reply('jane', "I'm going to pass at this time.")], drafts: [bumpFor('jane')] });
  await runPressOutreach(opts);
  assert.ok(!calls.send.some((m) => m.to === 'jane@example.com'));
  const saved = calls.savedDrafts.find((d) => d.kind === 'bump');
  assert.equal(saved.status, 'expired');
  assert.equal(saved.expired_reason, 'thread moved on');
});

test('fix 1: a bump is held, still approved, while IMAP is down', async () => {
  const err = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
  const { opts, calls } = world({ imapError: err, drafts: [bumpFor('jane')] });
  await runPressOutreach(opts);
  assert.ok(!calls.send.some((m) => m.to === 'jane@example.com'));
  assert.ok(!calls.savedDrafts.some((d) => d.kind === 'bump'), 'left approved for the next run');
});

test('fix 2: a failed address request is not followed by the automatic follow-up', async () => {
  const { opts, calls } = world({ replies: [reply('jane', "I'd love to try them!")] });
  const inner = opts.send;
  opts.send = async (m) => { if (/mailing address/.test(m.text)) throw new Error('resend 500'); return inner(m); };
  await runPressOutreach(opts);
  assert.ok(!calls.send.some((m) => m.to === 'jane@example.com'), 'no follow-up lands on a writer awaiting an answer');
  assert.ok(!opts.state.processed.includes('<r-jane>'));
});

test('fix 4: the lock is taken before the book and state are read', () => {
  const src = readFileSync(new URL('../../agents/press-outreach/index.js', import.meta.url), 'utf8');
  const main = src.slice(src.indexOf('async function main()'));
  const lock = main.indexOf('acquireLock()');
  assert.ok(lock > -1 && lock < main.indexOf('readBook()') && lock < main.indexOf('let state = readState()'));
});

test('fix 5: a book write failing after a send keeps the send recorded and the reply processed', async () => {
  const { opts, calls } = world({ replies: [reply('jane', "I'd love to try them!")] });
  opts.saveState = (s) => { calls.order.push(`state:${s.sends.length}`); };
  opts.saveBook = () => { calls.order.push('book'); throw new Error('disk full'); };
  const r = await runPressOutreach(opts);
  assert.ok(opts.state.processed.includes('<r-jane>'));
  assert.equal(opts.state.sends.filter((s) => s.contact_id === 'jane').length, 1);
  assert.equal(calls.order[0], 'state:1', 'state persisted right after the send, before any book write');
  assert.equal(r.book.contacts.find((c) => c.id === 'jane').pitches[0].outcome, 'sample-accepted');
  assert.ok(!calls.send.some((m) => m.to === 'sam@example.com'), 'no automatic follow-up');
  assert.ok(r.failed.some((f) => /bookkeeping/.test(f.error)));
});

test('fix 6: without write_draft_orders the default onAddress asks Sean for the order and marks the contact escalated', async () => {
  const { opts, calls } = world({ replies: [reply('jane', "I'd love to try them! Ship to:\n12 Example Road\nSpringfield, IL 62704")] });
  delete opts.onAddress;
  const r = await runPressOutreach(opts);
  assert.deepEqual(calls.escalate, [{ tell: 'Press outreach: create a PR Package order for Jane Example' }]);
  assert.equal(opts.state.escalated.jane.kind, 'order-request');
  assert.equal(r.failed.length, 0);
});

test('fix 7: three consecutive send failures report one error; a success resets the counter', async () => {
  const drafts = ['a', 'b', 'c'].map((id) => approved(id));
  const { opts, calls } = world({ drafts, state: { send_failures: 0 } });
  for (const id of ['a', 'b', 'c']) opts.book.contacts.push(fresh(id));
  opts.send = async () => { throw new Error('resend 500'); };
  await runPressOutreach(opts);
  assert.equal(calls.errors.length, 1);
  assert.equal(opts.state.send_failures, 3);

  const ok = world({ state: { send_failures: 2 }, drafts: [approved('a')] });
  ok.opts.book.contacts.push(fresh('a'));
  await runPressOutreach(ok.opts);
  assert.equal(ok.calls.send.length, 1);
  assert.equal(ok.opts.state.send_failures, 0);
  assert.equal(ok.calls.errors.length, 0);
});

test('source: first pitches send only when approved, never via the Gmail connector', () => {
  const src = readFileSync(new URL('../../agents/press-outreach/index.js', import.meta.url), 'utf8');
  assert.match(src, /sendOrder\(/, 'first pitches come from sendOrder (approved only)');
  assert.doesNotMatch(src, /claude_ai_Gmail|gmail\.googleapis/i);
  assert.match(src, /agent: 'press-outreach'/);
  assert.doesNotMatch(src, /@anthropic-ai\/sdk/);
});

test('C2b: a reply Sean already answered by hand is marked processed and not acted on', async () => {
  const { opts, calls } = world({
    replies: [reply('jane', "I'd love to try them!")],
    sent: [{ to: ['jane@example.com'], date: '2026-10-05T12:00:00Z', messageId: '<hand>', subject: 'Re: Coconut cream' }],
  });
  const r = await runPressOutreach(opts);
  assert.ok(opts.state.processed.includes('<r-jane>'));
  assert.ok(!calls.send.some((m) => m.to === 'jane@example.com'));
  assert.equal(calls.escalate.length, 0);
  assert.deepEqual(calls.confirms, []);
  assert.equal(r.replies.length, 0);
});

test('C2b: a reply that came AFTER Sean\'s own message is still handled', async () => {
  const { opts, calls } = world({
    replies: [reply('jane', "I'd love to try them!")],
    sent: [{ to: ['jane@example.com'], date: '2026-10-04T12:00:00Z', messageId: '<hand>', subject: 'Re: Coconut cream' }],
  });
  await runPressOutreach(opts);
  assert.deepEqual(calls.confirms, ['sample-yes']);
});

import { rejectDraft } from '../../lib/press-drafts.js';

test('I3: a draft rejected in the dashboard while the run sleeps is not sent and stays rejected', async () => {
  const [a, b] = ['a', 'b'].map((id) => approved(id));
  const { opts, calls } = world({ drafts: [a, b] });
  for (const id of ['a', 'b']) opts.book.contacts.push(fresh(id));
  opts.book.contacts = opts.book.contacts.filter((c) => ['a', 'b'].includes(c.id)); // no follow-ups in the way
  opts.sleep = async (ms) => { calls.sleeps.push(ms); calls.disk.set(b.id, rejectDraft(b, { now: NOW, reason: 'not now' })); };
  const r = await runPressOutreach(opts);
  assert.deepEqual(calls.send.map((m) => m.to), ['a@example.com']);
  assert.equal(calls.disk.get(b.id).status, 'rejected');
  assert.ok(!calls.savedDrafts.some((d) => d.id === b.id), 'the rejected file is never overwritten');
  assert.ok(r.skipped.some((s) => s.draft_id === b.id && /changed in dashboard/.test(s.reason)));
});

test('I3: an approved draft edited in the dashboard is not sent from the stale copy', async () => {
  const a = approved('a');
  const { opts, calls } = world({ drafts: [a] });
  opts.book.contacts = [fresh('a')];
  calls.disk.set(a.id, { ...a, status: 'pending', subject: 'Edited subject' });
  await runPressOutreach(opts);
  assert.equal(calls.send.length, 0);
  assert.equal(calls.disk.get(a.id).subject, 'Edited subject');
});

test('I3: a gate failure never overwrites a concurrent dashboard edit', async () => {
  const bad = approved('new', { text: 'Hi there. No opt-out line and no address.' });
  const { opts, calls } = world({ drafts: [bad] });
  opts.book.contacts = [fresh('new')];
  calls.disk.set(bad.id, rejectDraft(bad, { now: NOW, reason: 'no' }));
  await runPressOutreach(opts);
  assert.ok(!calls.savedDrafts.some((d) => d.id === bad.id));
  assert.equal(calls.disk.get(bad.id).status, 'rejected');
});

test('I4: every send records its draft id; a draft already in state.sends is repaired, never re-sent', async () => {
  const a = approved('a');
  const one = world({ drafts: [a] });
  one.opts.book.contacts = [fresh('a')];
  await runPressOutreach(one.opts);
  assert.equal(one.opts.state.sends[0].draft_id, a.id);

  const prev = { at: '2026-10-05T18:00:00.000Z', contact_id: 'a', kind: 'pitch', draft_id: a.id, message_id: '<prev@realskincare.com>', resend_id: 'r0', last_event: 'sent' };
  const two = world({ drafts: [a], state: { sends: [prev] } });
  two.opts.book.contacts = [fresh('a')];
  await runPressOutreach(two.opts);
  assert.equal(two.calls.send.length, 0, 'not sent twice');
  const repaired = two.calls.disk.get(a.id);
  assert.equal(repaired.status, 'sent');
  assert.equal(repaired.message_id, '<prev@realskincare.com>');
  const p = two.opts.book.contacts[0].pitches.find((x) => x.draft_id === a.id);
  assert.ok(p, 'the missing pitch record is restored');
  assert.equal(p.message_id, '<prev@realskincare.com>');
});

test('I5: a yes from a contact whose samples already went out escalates; nothing is sent', async () => {
  const { opts, calls } = world({ replies: [reply('jane', 'Absolutely, loved them!')] });
  opts.book.contacts[0].pitches[0].outcome = 'samples-sent';
  await runPressOutreach(opts);
  assert.deepEqual(calls.escalate, [{ id: 'jane', reason: 'reply does not fit the conversation stage' }]);
  assert.ok(!calls.send.some((m) => m.to === 'jane@example.com'));
  assert.deepEqual(calls.addresses, []);
});

test('I5: an address from a contact who never accepted a sample escalates', async () => {
  const { opts, calls } = world({ replies: [reply('jane', "I'd love to try them! Ship to:\n12 Example Road\nSpringfield, IL 62704")] });
  opts.book.contacts[0].pitches[0].outcome = 'replied';
  await runPressOutreach(opts);
  assert.deepEqual(calls.addresses, []);
  assert.deepEqual(calls.escalate, [{ id: 'jane', reason: 'reply does not fit the conversation stage' }]);
});

test('I6: a first pitch to a contact with an open conversation, an escalation or a recent pitch goes back to pending', async () => {
  const drafts = ['jane', 'lee', 'cool'].map((id) => approved(id));
  const { opts, calls } = world({ drafts });
  opts.book.contacts.push(contact('cool', { date: '2026-09-20', outcome: 'declined' }));
  opts.book.contacts.find((c) => c.id === 'lee').pitches[0].outcome = 'declined'; // only the escalation holds lee
  opts.book.contacts = opts.book.contacts.filter((c) => c.id !== 'sam');
  opts.book.contacts[0].pitches[0].follow_ups_sent = 2; // no follow-ups eat the per-run cap
  await runPressOutreach(opts);
  for (const id of ['jane', 'lee', 'cool']) assert.ok(!calls.send.some((m) => m.to === `${id}@example.com` && m.subject === 'Hi'), id);
  const back = (id) => calls.disk.get(drafts.find((d) => d.contact_id === id).id);
  assert.equal(back('jane').status, 'pending');
  assert.deepEqual(back('jane').gate_problems, ['contact has an open conversation']);
  assert.deepEqual(back('lee').gate_problems, ['contact has an open conversation']);
  assert.equal(back('cool').status, 'pending');
  assert.match(back('cool').gate_problems[0], /pitched within 60 days/);
});

test('M1: the send window is re-checked before each send against a moving clock; real send times are recorded', async () => {
  const drafts = ['a', 'b', 'c'].map((id) => approved(id, { now: Date.parse('2026-10-09T22:00:00Z') }));
  for (const d of drafts) d.approved_at = '2026-10-09T22:30:00.000Z';
  const { opts, calls } = world({ drafts });
  opts.book.contacts = ['a', 'b', 'c'].map(fresh);
  let t = Date.parse('2026-10-09T23:40:00Z'); // Friday
  opts.now = () => t;
  opts.sleep = async (ms) => { calls.sleeps.push(ms); t += ms; };
  const r = await runPressOutreach(opts);
  assert.deepEqual(calls.send.map((m) => m.to), ['a@example.com', 'b@example.com'], 'c would go out on Saturday 00:00');
  assert.deepEqual(opts.state.sends.map((s) => s.at), ['2026-10-09T23:40:00.000Z', '2026-10-09T23:50:00.000Z']);
  assert.equal(opts.book.contacts.find((c) => c.id === 'b').pitches[0].last_sent_at, '2026-10-09T23:50:00.000Z');
  assert.ok(r.skipped.some((s) => s.draft_id === drafts[2].id && /send window/.test(s.reason)));
});

test('M2: a failed state write in step 3 is reported, not thrown', async () => {
  const { opts } = world({ sent: [{ to: ['sam@example.com'], date: '2026-10-05T12:00:00Z', messageId: '<hand>', subject: 'Re: Coconut cream' }] });
  opts.saveState = () => { throw new Error('disk full'); };
  const r = await runPressOutreach(opts);
  assert.ok(r.failed.some((f) => /state write failed: disk full/.test(f.error)));
});

test('M6: Sean answering an escalated contact keeps a sample stage', async () => {
  const { opts } = world({ sent: [{ to: ['lee@example.com'], date: '2026-10-05T12:00:00Z', messageId: '<hand>', subject: 'Re: Coconut cream' }] });
  opts.book.contacts.find((c) => c.id === 'lee').pitches[0].outcome = 'samples-sent';
  await runPressOutreach(opts);
  assert.equal(opts.state.escalated.lee, undefined);
  assert.equal(opts.book.contacts.find((c) => c.id === 'lee').pitches[0].outcome, 'samples-sent');
});

test('M3: an auto-pause is recorded in pause_history', () => {
  const src = readFileSync(new URL('../../agents/press-outreach/index.js', import.meta.url), 'utf8');
  const main = src.slice(src.indexOf('async function main()'));
  assert.match(main, /pause_history/);
});

test('a reply from a placed contact is escalated and nothing is sent to the writer', async () => {
  const w = world({ replies: [reply('pat', 'Yes please send samples!')] });
  w.opts.book = { contacts: [contact('pat', { outcome: 'placed', link_earned: { url: 'https://example.com/a', found_at: '2026-10-04T00:00:00Z' } })] };
  const r = await runPressOutreach(w.opts);
  assert.equal(w.calls.send.length, 0);
  assert.equal(w.calls.escalate.length, 1);
  assert.equal(r.escalations.length, 1);
});

test('I2: a first pitch to a placed writer sends after the 60-day cooldown and waits inside it', async () => {
  const daysAgo = (n) => new Date(NOW - n * 86_400_000).toISOString().slice(0, 10);
  const placed = (id, n) => contact(id, { outcome: 'placed', date: daysAgo(n), last_sent_at: `${daysAgo(n)}T17:00:00Z`, follow_ups_sent: 2, link_earned: { url: 'https://example.com/a', found_at: new Date(NOW - 5 * 86_400_000).toISOString(), dofollow: true } });
  const drafts = ['ripe', 'young'].map((id) => approved(id));
  const { opts, calls } = world({ drafts, state: { escalated: {} } });
  opts.book = { contacts: [placed('ripe', 61), placed('young', 59)] };
  await runPressOutreach(opts);
  assert.ok(calls.send.some((m) => m.to === 'ripe@example.com' && m.subject === 'Hi'), 'placed 61 days ago is pitchable');
  assert.ok(!calls.send.some((m) => m.to === 'young@example.com'));
  const back = calls.disk.get(drafts.find((d) => d.contact_id === 'young').id);
  assert.equal(back.status, 'pending');
  assert.match(back.gate_problems[0], /pitched within 60 days/);
});
