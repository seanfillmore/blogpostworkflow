import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runOutreach, renderSummary, escalationEmail } from '../../agents/creator-outreach/index.js';
import { DEFAULT_CONFIG } from '../../lib/creator-outreach.js';

const NOW = Date.parse('2026-10-02T18:00:00Z');
const order = {
  name: '#2360', createdAt: '2026-09-22T00:00:00Z', tags: ['sample-request', 'trybe'], email: 'lori@example.com',
  note: 'Trybe sample request for Lori Yockim', lineItems: { nodes: [{ title: 'Body Lotion' }] },
  fulfillments: [{ displayStatus: 'DELIVERED', deliveredAt: '2026-09-26T00:00:00Z', trackingInfo: [] }],
};
const inbound = (text, id = '<m1@x>') => ({ messageId: id, from: 'lori@example.com', subject: 'Re: samples', date: '2026-10-02T17:00:00Z', text, references: [] });

function harness({ inbox = [], draft, state = {}, sentFolder = [] } = {}) {
  const sent = [];
  const escalations = [];
  const saves = [];
  const opts = {
    apply: true, now: NOW, config: DEFAULT_CONFIG, state,
    saveState: (s) => saves.push(JSON.parse(JSON.stringify(s))),
    loadOrders: async () => [order], loadSubmissions: async () => [],
    readInbox: async () => inbox,
    readSent: async () => sentFolder,
    send: async (m) => { sent.push(m); return { messageId: `<out${sent.length}@x>` }; },
    draft: draft || (async () => ({ action: 'reply', reply: 'It shipped with USPS and was delivered on the 26th.\nSean', reason: '' })),
    escalate: async (c, msg, row) => { escalations.push(row); },
    log: () => {},
  };
  return { opts, sent, escalations, saves };
}

test('importing the agent does not run it', () => {
  assert.equal(typeof runOutreach, 'function');
});

test('dry run sends nothing and saves nothing', async () => {
  const h = harness();
  const r = await runOutreach({ ...h.opts, apply: false });
  assert.equal(h.sent.length, 0);
  assert.equal(h.saves.length, 0);
  assert.equal(r.scheduled[0].kind, 'welcome');
});

test('a question gets a threaded reply, is processed once, and the reply suppresses a same-run reminder', async () => {
  const state = {};
  const h = harness({ inbox: [inbound('Where is my package?')], state });
  const r = await runOutreach(h.opts);
  assert.equal(r.replies.length, 1);
  assert.equal(h.sent.length, 1, 'no welcome on top of a live conversation');
  assert.equal(h.sent[0].inReplyTo, '<m1@x>');
  assert.equal(h.sent[0].subject, 'Re: samples');
  const again = harness({ inbox: [inbound('Where is my package?')], state });
  await runOutreach(again.opts);
  assert.equal(again.sent.length, 0, 'same Message-ID is never answered twice');
});

test('money questions never reach the model: escalated to Sean, NOTHING sent to the creator, reminders paused', async () => {
  let asked = false;
  const state = {};
  const h = harness({ inbox: [inbound('What do you pay per video?')], state, draft: async () => { asked = true; } });
  const r = await runOutreach(h.opts);
  assert.equal(asked, false);
  assert.equal(r.escalations.length, 1);
  assert.equal(h.escalations.length, 1);
  assert.equal(h.sent.length, 0, 'no holding reply, no welcome: Sean writes the answer');
  assert.equal(state.creators['lori@example.com'].escalatedOpen, true);
  assert.equal(state.creators['lori@example.com'].escalatedAt, '2026-10-02T17:00:00Z');
});

test('a model draft that promises product is refused and escalated, never sent', async () => {
  const h = harness({ inbox: [inbound('Can you tell me about the lotion?')], draft: async () => ({ action: 'reply', reply: 'Sure, I will send you another bottle!', reason: '' }) });
  const r = await runOutreach(h.opts);
  assert.equal(r.replies.length, 0);
  assert.equal(r.escalations[0].suggestion, 'Sure, I will send you another bottle!');
  assert.equal(h.sent.length, 0);
});

test('opt-out is honoured and acknowledged once', async () => {
  const state = {};
  const h = harness({ inbox: [inbound('Please stop emailing me')], state });
  await runOutreach(h.opts);
  assert.equal(state.creators['lori@example.com'].optedOut, true);
  assert.equal(h.sent.length, 1);
});

test('a failed send leaves the message unprocessed for the next run', async () => {
  const state = {};
  const h = harness({ inbox: [inbound('Where is my package?')], state });
  h.opts.send = async () => { throw new Error('smtp down'); };
  const r = await runOutreach(h.opts);
  assert.equal(r.failed.length >= 1, true);
  assert.ok(!(state.processed || []).includes('<m1@x>'));
});

test('scheduled welcome is recorded so it is never sent twice', async () => {
  const state = {};
  const h = harness({ state });
  await runOutreach(h.opts);
  assert.equal(h.sent[0].subject, 'Your Real Skin Care samples + what works best');
  assert.ok(state.creators['lori@example.com'].sent.welcome);
  const again = harness({ state });
  await runOutreach({ ...again.opts, now: NOW + 3 * 3_600_000 });
  assert.equal(again.sent.length, 0);
});

test('summary renders', async () => {
  const h = harness({ inbox: [inbound('What do you pay?')] });
  const r = await runOutreach(h.opts);
  assert.match(renderSummary(r, { apply: true }).subject, /1 escalated/);
});

test('a missing state file refuses --apply without --init (source scan)', () => {
  const src = readFileSync(new URL('../../agents/creator-outreach/index.js', import.meta.url), 'utf8');
  assert.match(src, /if \(apply && !args\.includes\('--init'\)\)/);
});

test('a reply quotes the creator\'s whole message, and a later nudge quotes the reply and threads on IDs she received', async () => {
  const state = {};
  const msg = {
    ...inbound('Where is my package?'),
    references: ['<delivered-welcome@ses>'], fromName: 'Lori Yockim',
    fullText: 'Where is my package?\n\nOn Fri, Sean wrote:\n> Hi Lori,',
  };
  const h = harness({ inbox: [msg], state });
  await runOutreach(h.opts);
  const reply = h.sent[0];
  assert.match(reply.text, /delivered on the 26th\.\nSean\n\nOn .*2026.*, Lori Yockim <lori@example\.com> wrote:\n> Where is my package\?/);
  assert.match(reply.text, /\n>> Hi Lori,$/);
  assert.equal(reply.references, '<delivered-welcome@ses> <m1@x>');
  const rec = state.creators['lori@example.com'];
  assert.deepEqual(rec.threadRefs, ['<delivered-welcome@ses>', '<m1@x>', '<out1@x>']);
  assert.equal(rec.thread.text, reply.text);

  // Eight days later the first nudge is due: it quotes the whole exchange and
  // replies to the creator's own message, an ID that exists in her mailbox.
  rec.sent = { welcome: '2026-09-22T17:00:00Z' };
  rec.lastScheduledAt = '2026-09-22T17:00:00Z';
  const later = harness({ inbox: [], state });
  later.opts.now = Date.parse('2026-10-12T18:00:00Z');
  await runOutreach(later.opts);
  const nudge = later.sent.find((m) => m.inReplyTo);
  assert.ok(nudge, 'a nudge went out');
  assert.equal(nudge.inReplyTo, '<out1@x>');
  assert.match(nudge.references, /^<delivered-welcome@ses> <m1@x> <out1@x>$/);
  assert.match(nudge.text, /Sean at Real Skin Care <sean@realskincare\.com> wrote:\n> It shipped with USPS/);
  assert.match(nudge.text, /\n>> Where is my package\?\n[\s\S]*\n>>> Hi Lori,$/, 'the whole exchange, three levels deep');
});

// Sean, 2026-10-03: a flagged email "should have come straight to my email and
// let me craft the response". These pin the whole handoff.
test('a reported reaction goes to Sean only: the creator receives nothing', async () => {
  const state = {};
  const h = harness({ inbox: [inbound('I got a rash on my arm after using it')], state });
  const r = await runOutreach(h.opts);
  assert.equal(h.sent.length, 0);
  assert.equal(h.escalations.length, 1);
  assert.deepEqual(r.escalations[0].reasons, ['a skin reaction or health concern']);
});

test('while a creator waits on Sean, every new message goes to Sean and the model is never asked', async () => {
  let asked = false;
  const state = { creators: { 'lori@example.com': { escalatedOpen: true, escalatedAt: '2026-10-02T16:00:00Z' } } };
  const h = harness({ inbox: [inbound('Also, it arrived today, thanks!')], state, draft: async () => { asked = true; } });
  const r = await runOutreach(h.opts);
  assert.equal(asked, false);
  assert.equal(h.sent.length, 0);
  assert.equal(r.escalations[0].reasons[0], 'a new message while this creator is waiting on you');
  assert.equal(state.creators['lori@example.com'].escalatedAt, '2026-10-02T17:00:00Z', 'the clock moves to her newest message');
});

test('Sean replying from Hushmail clears the flag; an older Sent message does not', async () => {
  const flagged = () => ({ creators: { 'lori@example.com': { escalatedOpen: true, escalatedAt: '2026-10-03T14:34:31Z' } } });
  const before = flagged();
  const stale = harness({ state: before, sentFolder: [{ to: ['lori@example.com'], date: '2026-10-03T14:00:00Z', messageId: '<old@hush>' }] });
  await runOutreach({ ...stale.opts, now: Date.parse('2026-10-03T18:00:00Z') });
  assert.equal(before.creators['lori@example.com'].escalatedOpen, true, 'sent before her message: not an answer to it');

  const after = flagged();
  const h = harness({ state: after, sentFolder: [{ to: ['lori@example.com'], date: '2026-10-03T16:25:32Z', messageId: '<sean@hush>' }] });
  const r = await runOutreach({ ...h.opts, now: Date.parse('2026-10-03T18:00:00Z') });
  const rec = after.creators['lori@example.com'];
  assert.equal(rec.escalatedOpen, false);
  assert.equal(rec.escalationResolvedAt, '2026-10-03T16:25:32Z');
  assert.deepEqual(rec.seanMessageIds, ['<sean@hush>']);
  assert.equal(r.resolved.length, 1);
  assert.match(renderSummary(r, { apply: true }).body, /Sean replied, so the agent picked these creators back up/);
});

test('a creator answering SEAN\'s own email goes back to Sean, not the model', async () => {
  let asked = false;
  const state = { creators: { 'lori@example.com': { seanMessageIds: ['<sean@hush>'] } } };
  const msg = { ...inbound('Oh that is great to know, thanks!'), inReplyTo: '<sean@hush>', references: ['<sean@hush>'] };
  const h = harness({ inbox: [msg], state, draft: async () => { asked = true; } });
  const r = await runOutreach(h.opts);
  assert.equal(asked, false);
  assert.equal(h.sent.length, 0);
  assert.equal(r.escalations[0].reasons[0], 'a reply to your own email');
});

test('a heart on Sean\'s email is still just a heart', async () => {
  const state = { creators: { 'lori@example.com': { escalatedOpen: true, escalatedAt: '2026-10-01T00:00:00Z' } } };
  const h = harness({ inbox: [{ ...inbound('x reacted via Gmail'), emojiReaction: true }], state });
  const r = await runOutreach(h.opts);
  assert.equal(r.escalations.length, 0);
  assert.equal(h.escalations.length, 0);
});

test('the escalation email says nothing was sent and carries the full message', () => {
  const e = escalationEmail({ name: 'Lori Y', email: 'l@x' }, { subject: 'Re: s', text: 'rash', fullText: 'rash\n\nOn Fri, Sean wrote:\n> hi' }, { reasons: ['a skin reaction or health concern'] });
  assert.match(e.body, /Nothing was sent to them/);
  assert.match(e.body, /> hi/);
  assert.doesNotMatch(e.body, /holding reply|--resolve/);
});
