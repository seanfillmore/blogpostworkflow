import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBackfill, parseSet } from '../../agents/press-outreach/index.js';

const NOW = Date.parse('2026-10-05T18:00:00Z');
const contact = (id, pitchOver = {}) => ({
  id, name: `${id[0].toUpperCase()}${id.slice(1)} Example`, status: 'active', domains: ['example.com'],
  channels: [{ type: 'email', address: `${id}@example.com`, verified: true, source: 'https://example.com' }],
  pitches: [{ date: '2026-09-20', concept: 'intro', outcome: 'sent', subject: 'Coconut cream', follow_ups_sent: 0, ...pitchOver }],
});
const copy = (id, over = {}) => ({ to: [`${id}@example.com`], date: '2026-09-20T17:00:00Z', messageId: `<${id}-sent@realskincare.com>`, subject: 'coconut CREAM', ...over });
const reply = (id, text) => ({ from: `${id}@example.com`, messageId: `<r-${id}>`, text, subject: 'Re: Coconut cream', date: '2026-09-25T10:00:00Z' });

test('a sent pitch with a Sent copy gets a message_id patch and a follow-up candidate (no fixed-template bump)', () => {
  const r = planBackfill({ book: { contacts: [contact('jane')] }, sentCopies: [copy('jane')], replies: [], now: NOW });
  assert.equal(r.patches.length, 1);
  assert.equal(r.patches[0].id, 'jane');
  assert.equal(r.patches[0].patch.message_id, '<jane-sent@realskincare.com>');
  assert.equal(r.patches[0].patch.last_sent_at, '2026-09-20T17:00:00.000Z');
  assert.equal(r.drafts, undefined, 'no drafts are written by the plan');
  assert.deepEqual(r.followUps, [{ contactId: 'jane', subject: 'Re: coconut CREAM', inReplyTo: '<jane-sent@realskincare.com>', references: ['<jane-sent@realskincare.com>'] }]);
});

test('a pitch with no Sent copy gets a note and no draft', () => {
  const r = planBackfill({ book: { contacts: [contact('sam')] }, sentCopies: [copy('sam', { subject: 'Something else' })], replies: [], now: NOW });
  assert.equal(r.followUps.length, 0);
  assert.equal(r.patches.length, 0);
  assert.ok(r.notes.some((n) => /sam/.test(n) && /no Sent copy/.test(n)));
});

test('a decline reply patches declined and makes no draft', () => {
  const r = planBackfill({ book: { contacts: [contact('lee')] }, sentCopies: [copy('lee')], replies: [reply('lee', 'Thanks, but not interested.')], now: NOW });
  assert.equal(r.followUps.length, 0);
  assert.ok(r.patches.some((p) => p.id === 'lee' && p.patch.outcome === 'declined'));
});

test('a yes reply is reported in notes, not patched, and gets no follow-up', () => {
  const r = planBackfill({ book: { contacts: [contact('kim')] }, sentCopies: [copy('kim')], replies: [reply('kim', 'Yes please, send me the samples!')], now: NOW });
  assert.equal(r.followUps.length, 0);
  assert.ok(!r.patches.some((p) => p.patch.outcome));
  assert.ok(r.notes.some((n) => /kim/.test(n) && /NOT acted on/.test(n)));
});

test('a recent pitch or an existing pending draft makes no follow-up', () => {
  const recent = contact('ann', { date: '2026-10-01' });
  const r1 = planBackfill({ book: { contacts: [recent] }, sentCopies: [copy('ann', { date: '2026-10-01T17:00:00Z' })], replies: [], now: NOW });
  assert.equal(r1.followUps.length, 0);
  const r2 = planBackfill({ book: { contacts: [contact('bob')] }, sentCopies: [copy('bob')], replies: [], now: NOW, drafts: [{ contact_id: 'bob', status: 'pending' }] });
  assert.equal(r2.followUps.length, 0);
});

test('parseSet reads id=outcome:order and rejects a bad outcome', () => {
  assert.deepEqual(parseSet('x=samples-sent:#2373'), { id: 'x', outcome: 'samples-sent', sampleOrder: '#2373' });
  assert.deepEqual(parseSet('x=declined'), { id: 'x', outcome: 'declined', sampleOrder: null });
  assert.throws(() => parseSet('x=bogus'), /must be one of/);
});

test('a later "Re: <subject>" Sent message, or one before the pitch date, is never the thread id', () => {
  const r = planBackfill({
    book: { contacts: [contact('jane')] },
    sentCopies: [
      copy('jane', { subject: 'Re: Coconut cream', date: '2026-09-28T10:00:00Z', messageId: '<later-reply@x>' }),
      copy('jane', { subject: 'Coconut cream', date: '2026-09-10T10:00:00Z', messageId: '<too-early@x>' }),
      copy('jane', { messageId: '<right@x>', date: '2026-09-21T10:00:00Z', subject: 'Coconut cream' }),
      copy('jane', { messageId: '<right-but-later@x>', date: '2026-09-22T10:00:00Z', subject: 'Coconut cream' }),
    ],
    replies: [], now: NOW,
  });
  assert.equal(r.patches[0].patch.message_id, '<right@x>');
});

test('a blank pitch subject gives a note and no patch, never a date-only match', () => {
  const r = planBackfill({ book: { contacts: [contact('jane', { subject: '' })] }, sentCopies: [copy('jane')], replies: [], now: NOW });
  assert.equal(r.patches.length, 0);
  assert.equal(r.followUps.length, 0);
  assert.ok(r.notes.some((n) => /cannot match the Sent copy safely/.test(n)));
});

test('an opt-out reply is patched even when no Sent copy was found', () => {
  const r = planBackfill({ book: { contacts: [contact('lee')] }, sentCopies: [], replies: [reply('lee', 'Please remove me, do not contact me again.')], now: NOW });
  assert.ok(r.patches.some((p) => p.id === 'lee' && p.contactStatus === 'do_not_contact'));
  assert.ok(r.patches.some((p) => p.id === 'lee' && p.patch.outcome === 'declined'));
  assert.equal(r.followUps.length, 0);
});

test('C1: a backfilled pitch gets no automatic follow-ups; only an approved followup draft sends', async () => {
  const { runPressOutreach } = await import('../../agents/press-outreach/index.js');
  const { updatePitch, MAX_FOLLOW_UPS } = await import('../../lib/press-contacts.js');
  const { newDraft, approveDraft } = await import('../../lib/press-drafts.js');
  let book = { contacts: [contact('jane'), contact('sam')] };
  const plan = planBackfill({ book, sentCopies: [copy('jane'), copy('sam')], replies: [], now: NOW });
  for (const { id, patch } of plan.patches) {
    assert.equal(patch.follow_ups_sent, MAX_FOLLOW_UPS, 'a patched thread id comes with follow-ups maxed');
    book = updatePitch(book, id, patch);
  }
  const c = plan.followUps.find((f) => f.contactId === 'jane');
  const fu = approveDraft(newDraft({ kind: 'followup', n: 1, contactId: 'jane', to: 'jane@example.com', subject: c.subject, text: 'Hi Jane,\n\nYour lip balm list made me think of ours. Would a tube help?\n\nSean', inReplyTo: c.inReplyTo, references: c.references, concept: 'intro', now: NOW }), { now: NOW });
  const RUN = Date.parse('2026-10-06T18:00:00Z');
  const sends = [];
  const disk = new Map([[fu.id, fu]]);
  await runPressOutreach({
    apply: true, now: RUN, config: { enabled: true, sendVia: 'resend', dailySendCap: 10, dailySendCapRamped: 25, rampAfterDays: 14, draftExpiryDays: 14, minGapMinutes: 10 },
    book, state: { sends: [], processed: [], escalated: {} }, drafts: [fu], postalAddress: '1 Example Way, Testville, WY 00000',
    readReplies: async () => [], readSent: async () => [],
    send: async (m) => { sends.push(m); return { messageId: `<s${sends.length}@realskincare.com>`, resendId: 'r' }; },
    saveBook: () => {}, saveState: () => {}, saveDraft: (d) => disk.set(d.id, d), readDraft: (id) => disk.get(id),
    escalate: async () => {}, confirmReply: async () => true, sleep: async () => {}, reportError: async () => {}, log: () => {},
    graphql: async () => { throw new Error('unexpected Shopify call'); },
  });
  assert.deepEqual(sends.map((m) => m.to), ['jane@example.com'], 'one message total: the approved follow-up');
  assert.equal(sends[0].inReplyTo, '<jane-sent@realskincare.com>');
});

test('C2a: the backfill marks every reply it read from a book contact as processed', async () => {
  const { applyBackfill } = await import('../../agents/press-outreach/index.js');
  const saleam = { ...contact('saleam', { outcome: 'samples-sent' }) };
  const book = { contacts: [contact('jane'), saleam] };
  const replies = [reply('jane', 'Thanks, but not interested.'), { ...reply('saleam', 'Got them, thank you!'), messageId: '<r-saleam>' }, { ...reply('stranger', 'hi'), messageId: '<r-stranger>' }];
  const plan = planBackfill({ book, sentCopies: [copy('jane')], replies, now: NOW });
  assert.deepEqual(plan.processed.sort(), ['<r-jane>', '<r-saleam>']);
  const out = applyBackfill({ book, plan, state: { sends: [], processed: ['<old>'], escalated: {} } });
  assert.deepEqual(out.state.processed.sort(), ['<old>', '<r-jane>', '<r-saleam>']);
  const again = applyBackfill({ book, plan, state: out.state });
  assert.equal(again.state.processed.length, 3, 'idempotent');
  assert.equal(out.book.contacts.find((c) => c.id === 'jane').pitches[0].outcome, 'declined');
});

test('C2a: no state file yet: the backfill creates one holding the processed replies', async () => {
  const { applyBackfill } = await import('../../agents/press-outreach/index.js');
  const book = { contacts: [contact('jane')] };
  const plan = planBackfill({ book, sentCopies: [copy('jane')], replies: [reply('jane', 'Yes please, send me the samples!')], now: NOW });
  const out = applyBackfill({ book, plan, state: null, now: NOW });
  assert.deepEqual(out.state.processed, ['<r-jane>']);
  assert.deepEqual(out.state.sends, []);
});

test('C2a: --init reads replies like a run and marks them all processed, classifying nothing', async () => {
  const { initState } = await import('../../agents/press-outreach/index.js');
  const book = { contacts: [contact('jane'), contact('saleam', { outcome: 'samples-sent' }), contact('gone', { outcome: 'declined' })] };
  let q;
  const state = await initState({ book, now: NOW, readReplies: async (query) => { q = query; return [reply('jane', 'Yes please!'), reply('saleam', 'Here is my address'), { ...reply('x', 'hi'), messageId: null }]; } });
  assert.deepEqual(q.senders.sort(), ['jane@example.com', 'saleam@example.com']);
  assert.equal(q.since.toISOString(), new Date(NOW - 45 * 86_400_000).toISOString());
  assert.deepEqual(state.processed.sort(), ['<r-jane>', '<r-saleam>']);
  assert.deepEqual(state.sends, []);
  assert.deepEqual(state.escalated, {});
});
