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
  assert.deepEqual(r.stale.map((s) => s.username), ['cat']);
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
  const state = { pool: ['IG10-AAA', 'IG10-BBB'], assigned: {}, handled: {}, sent: [] };
  const convs = [{ id: 'c1', messages: [them('m1', 'Natural', 1)] }, { id: 'c2', messages: [them('m2', 'Natural', 1, 'bob', 'u2')] }];
  const saves = [];
  const run = await runOnce({ apply: true, conversations: convs, state, now: NOW, save: (s) => saves.push(JSON.parse(JSON.stringify(s))), log: () => {},
    send: async ({ recipientId }) => { if (recipientId === 'u2') throw new Error('outside window'); } });
  assert.deepEqual(run.done.map((d) => d.outcome), ['sent', 'failed']);
  assert.deepEqual(state.pool, ['IG10-BBB']);
  assert.equal(state.assigned.u1.code, 'IG10-AAA');
  assert.equal(state.assigned.u2, undefined);
  assert.equal(state.handled.m2, undefined, 'a failed send is retried next run');
  assert.equal(saves.length, 1);
  const dry = await runOnce({ apply: false, conversations: convs, state: { pool: ['X'], assigned: {}, handled: {}, sent: [] }, now: NOW, send: async () => { throw new Error('must not send'); } });
  assert.ok(dry.done.every((d) => d.outcome === 'would-send'));
});
