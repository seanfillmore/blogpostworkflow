import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyReply, extractUsAddress } from '../../lib/press-replies.js';

const m = (text, over = {}) => ({ text, emojiReaction: false, autoSubmitted: false, ...over });

// Paraphrase of the real 2026-09-25 reply shape (invented address).
const YES_WITH_ADDRESS = `Hi Sean,\n\nThanks so much for reaching out. I'd love to sample the soap and body cream.\n\nHere is my shipping address:\n12 Example Road, Apt 3B\nSpringfield, IL 62704\n\nLooking forward to testing these out!`;

test('a yes that carries the address goes straight to address-given', () => {
  const r = classifyReply(m(YES_WITH_ADDRESS));
  assert.equal(r.kind, 'address-given');
  assert.equal(r.address.zip, '62704');
  assert.deepEqual(r.address.lines, ['12 Example Road, Apt 3B', 'Springfield, IL 62704']);
});

test('a yes with no address is sample-yes', () => {
  assert.equal(classifyReply(m("Sure, I'd love to try them!")).kind, 'sample-yes');
});

test('decline and opt-out', () => {
  assert.equal(classifyReply(m("I'm going to pass at this time, at max capacity.")).kind, 'decline');
  assert.equal(classifyReply(m('No thanks.')).kind, 'opt-out');
  assert.equal(classifyReply(m('Please remove me from your list')).kind, 'opt-out');
});

test('money, terms, claims or a question escalate even alongside a yes', () => {
  for (const t of [
    "Happy to try it! What's your rate for a sponsored placement?",
    'Love to. Do you have an affiliate program?',
    'Does the deodorant stop sweating?',
    'Is it safe for eczema?',
    'Can you send hi-res photos?',
    'This is the third email, stop spamming me',
  ]) assert.equal(classifyReply(m(t)).kind, 'escalate', t);
});

test('unclassifiable means escalate, never a guess', () => {
  assert.equal(classifyReply(m('Interesting, let me think about it.')).kind, 'escalate');
});

test('auto-replies and emoji reactions are ignored', () => {
  assert.equal(classifyReply(m('I am out of office', { autoSubmitted: true })).kind, 'ignore');
  assert.equal(classifyReply(m('Jane reacted via Gmail', { emojiReaction: true })).kind, 'ignore');
});

test('a bare address only counts when we asked for one', () => {
  const t = '12 Example Road\nSpringfield, IL 62704';
  assert.equal(classifyReply(m(t), { awaitingAddress: true }).kind, 'address-given');
  assert.equal(classifyReply(m(t)).kind, 'escalate');
});

test('two addresses is ambiguous', () => {
  assert.equal(extractUsAddress('1 A St\nX, NY 10001\nor\n2 B St\nY, CA 90001'), null);
});

test('opt-out with negated send verbs', () => {
  assert.equal(classifyReply(m('Please do not send me any more emails.')).kind, 'opt-out');
  assert.equal(classifyReply(m("Please don't email me anymore.")).kind, 'opt-out');
  assert.equal(classifyReply(m('Stop contacting me.')).kind, 'opt-out');
  assert.equal(classifyReply(m('Never send us any more messages.')).kind, 'opt-out');
});

test('conditional or deferred yes escalates', () => {
  assert.equal(classifyReply(m("I'd love to but I am slammed until January.")).kind, 'escalate');
  assert.equal(classifyReply(m('I would love to try the lotion but I only cover makeup')).kind, 'escalate');
  assert.equal(classifyReply(m('Sure. Send me your press kit first.')).kind, 'escalate');
});

test('word boundary fix: yes/sure with punctuation', () => {
  assert.equal(classifyReply(m('Yes! Please send the lotion.')).kind, 'sample-yes');
  assert.equal(classifyReply(m('Sure, I can try them.')).kind, 'sample-yes');
  assert.equal(classifyReply(m('Absolutely, sounds great!')).kind, 'sample-yes');
});

test('address without cue is sample-yes, not address-given', () => {
  const t = "I'd love to try them!\n\nJane Doe\n350 Fifth Ave\nNew York, NY 10118";
  assert.equal(classifyReply(m(t)).kind, 'sample-yes');
});

test('address with cue is address-given', () => {
  const t = "I'd love to try them! Here is my shipping address:\n350 Fifth Ave\nNew York, NY 10118";
  const r = classifyReply(m(t));
  assert.equal(r.kind, 'address-given');
  assert.equal(r.address.zip, '10118');
});
