import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOfferRequest, planReplies, awaitingReply, genCodes, replyText, OUR_IG_ID } from '../../lib/instagram-dm.js';
import { runOnce } from '../../agents/instagram-dm/index.js';
import { checkSeoCopyFields } from '../../lib/seo-copy-health-gate.js';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const at = (h) => new Date(NOW - h * 3_600_000).toISOString();
const them = (id, text, h, user = 'jane', uid = 'u1') => ({ id, created_time: at(h), from: { id: uid, username: user }, message: text });
const us = (id, text, h) => ({ id, created_time: at(h), from: { id: OUR_IG_ID, username: 'realskincare_com' }, message: text });

test('isOfferRequest: only the keyword itself, never a sentence that mentions it', () => {
  for (const t of ['Natural', 'natural', 'NATURAL!', 'Natural please', 'natural 🙂', ' Natural. ']) assert.ok(isOfferRequest(t), t);
  for (const t of ['Love that you made a natural skincare brand!', 'Is your deodorant natural?', 'natural?', 'I want something natural for my kids please', '', 'Hello']) assert.equal(isOfferRequest(t), false, t);
});

test('planReplies: new requester gets the next pool code; the same account always gets the same code back', () => {
  const convs = [{ id: 'c1', messages: [them('m1', 'Natural', 1)] }, { id: 'c2', messages: [them('m2', 'natural please', 2, 'bob', 'u2')] }];
  const r = planReplies(convs, { pool: ['IG10-AAA', 'IG10-BBB'], assigned: { u2: { code: 'IG10-OLD' } }, handled: {} }, { now: NOW });
  assert.deepEqual(r.sends.map((s) => [s.username, s.code, s.reused]), [['jane', 'IG10-AAA', false], ['bob', 'IG10-OLD', true]]);
});

test('planReplies: skips handled, already-answered-by-Sean, and older-than-24h requests (the last go to the digest)', () => {
  const convs = [
    { id: 'c1', messages: [them('m1', 'Natural', 1)] },
    { id: 'c2', messages: [them('m2', 'Natural', 3, 'bob', 'u2'), us('m3', 'Here you go: FIRST20', 2)] },
    { id: 'c3', messages: [them('m4', 'Natural', 30, 'cat', 'u3')] },
  ];
  const r = planReplies(convs, { pool: ['IG10-AAA'], assigned: {}, handled: { m1: true } }, { now: NOW });
  assert.equal(r.sends.length, 0);
  assert.deepEqual(r.stale.map((s) => s.username).sort(), ['bob', 'cat'], 'bob: a thread Sean wrote in; cat: past 24 h');
});

test('planReplies: an empty pool never sends a blank code', () => {
  const r = planReplies([{ id: 'c1', messages: [them('m1', 'Natural', 1)] }], { pool: [], assigned: {}, handled: {} }, { now: NOW });
  assert.equal(r.sends.length, 0);
  assert.match(r.stale[0].reason, /pool empty/);
});

test('awaitingReply: threads whose last word is the customer\'s, newest first, with the 24 h window', () => {
  const convs = [
    { id: 'c1', messages: [us('a', 'Hi Kate, I read your article', 50), them('b', 'Would love to try it!', 30, 'kate')] },
    { id: 'c2', messages: [them('c', 'Question about shipping', 2, 'dan')] },
    { id: 'c3', messages: [them('d', 'thanks', 5, 'eve'), us('e', 'You are welcome', 4)] },
  ];
  const w = awaitingReply(convs, { handled: {} }, { now: NOW });
  assert.deepEqual(w.map((x) => [x.username, x.canReply]), [['dan', true], ['kate', false]]);
});

test('genCodes are unique, prefixed and avoid taken codes; the reply passes the claim gate and has no dashes', () => {
  const codes = genCodes(300, Math.random, new Set(['IG10-AAAAAAA']));
  assert.equal(new Set(codes).size, 300);
  assert.ok(codes.every((c) => /^IG10-[A-HJ-NP-Z2-9]{7}$/.test(c)));
  const t = replyText('IG10-ABCDEFG');
  assert.match(t, /IG10-ABCDEFG/);
  assert.doesNotMatch(t, /[–—]/);
  assert.equal(checkSeoCopyFields({ reply: t }).blocking.length, 0);
});

test('runOnce --apply: records each send at once (code leaves the pool); a failed send changes nothing', async () => {
  const { normalizeState } = await import('../../lib/instagram-dm.js');
  const state = normalizeState({ pool: ['IG10-AAA', 'IG10-BBB'], assigned: {}, handled: {}, sent: [] });
  const convs = [{ id: 'c1', messages: [them('m1', 'Natural', 1)] }, { id: 'c2', messages: [them('m2', 'Natural', 1, 'bob', 'u2')] }];
  const saves = [];
  const run = await runOnce({ apply: true, conversations: convs, state, now: NOW, save: (s) => saves.push(JSON.parse(JSON.stringify(s))), log: () => {},
    send: async ({ recipientId }) => { if (recipientId === 'u2') throw new Error('outside window'); } });
  assert.deepEqual(run.done.map((d) => d.outcome), ['sent', 'failed']);
  assert.deepEqual(state.offers.natural.pool, ['IG10-BBB']);
  assert.equal(state.offers.natural.assigned.u1.code, 'IG10-AAA');
  assert.equal(state.offers.natural.assigned.u2, undefined);
  assert.equal(state.handled.m2, undefined, 'a failed send is retried next run');
  assert.equal(saves.length, 1);
  const dry = await runOnce({ apply: false, conversations: convs, state: normalizeState({ pool: ['X'], assigned: {}, handled: {}, sent: [] }), now: NOW, send: async () => { throw new Error('must not send'); } });
  assert.ok(dry.done.every((d) => d.outcome === 'would-send'));
});

test('THANKS: its own offer, code prefix and reply; the same person can hold one code of each offer', async () => {
  const { offerRequested, OFFERS, normalizeState } = await import('../../lib/instagram-dm.js');
  for (const t of ['THANKS', 'thanks!', 'Thanks so much']) assert.equal(offerRequested(t), 'thanks', t);
  assert.equal(offerRequested('Natural'), 'natural');
  assert.equal(offerRequested('thanks for the samples, I will post soon'), null);
  const st = normalizeState({ offers: { natural: { pool: ['IG10-A'], assigned: {} }, thanks: { pool: ['TY10-A'], assigned: {} } } });
  const r = planReplies([{ id: 'c1', messages: [them('m1', 'Natural', 3)] }, { id: 'c2', messages: [them('m2', 'THANKS', 1)] }], st, { now: NOW });
  assert.deepEqual(r.sends.map((x) => [x.offer, x.code]), [['natural', 'IG10-A'], ['thanks', 'TY10-A']]);
  const t = OFFERS.thanks.reply('TY10-ABCDEFG');
  assert.match(t, /\$10 off your next order of \$55 or more/);
  assert.match(t, /shipping is still free/);
  assert.doesNotMatch(t, /[–—]/);
  assert.equal(checkSeoCopyFields({ reply: t }).blocking.length, 0);
  assert.equal(OFFERS.thanks.discount.minimumRequirement.subtotal.greaterThanOrEqualToSubtotal, '55.00', '$55 - $10 stays on the $45 free-shipping rate');
});

test('a thread Sean wrote in is never auto-answered, but the agent\'s own earlier reply does not count as Sean', async () => {
  const { OFFERS } = await import('../../lib/instagram-dm.js');
  const outreach = [{ id: 'c1', messages: [us('a', 'Hi Kate, I read your article and loved it', 40), them('b', 'Thanks!', 1, 'kate')] }];
  const r1 = planReplies(outreach, { offers: { thanks: { pool: ['TY10-A'], assigned: {} } } }, { now: NOW });
  assert.equal(r1.sends.length, 0);
  assert.match(r1.stale[0].reason, /thread you wrote in/);
  const repeat = [{ id: 'c2', messages: [them('x', 'Natural', 30), us('y', OFFERS.natural.reply('IG10-OLD'), 29), them('z', 'thanks', 1)] }];
  const r2 = planReplies(repeat, { offers: { thanks: { pool: ['TY10-B'], assigned: {} } } }, { now: NOW });
  assert.deepEqual(r2.sends.map((x) => x.code), ['TY10-B']);
  const empty = [{ id: 'c3', messages: [us('e', '', 5000), them('f', 'Natural', 1)] }];
  assert.equal(planReplies(empty, { pool: ['IG10-C'] }, { now: NOW }).sends.length, 1, 'an empty (attachment) message from us does not make it Sean\'s thread');
});

test('normalizeState reads the pre-THANKS state as offers.natural', async () => {
  const { normalizeState } = await import('../../lib/instagram-dm.js');
  const s = normalizeState({ discount_id: 'gid://d', pool: ['IG10-A'], assigned: { u1: { code: 'IG10-Z' } }, handled: { m: true }, sent: [1] });
  assert.deepEqual(s.offers.natural, { discount_id: 'gid://d', pool: ['IG10-A'], assigned: { u1: { code: 'IG10-Z' } } });
  assert.deepEqual(s.offers.thanks, { discount_id: null, pool: [], assigned: {} });
  assert.deepEqual(s.handled, { m: true });
});
