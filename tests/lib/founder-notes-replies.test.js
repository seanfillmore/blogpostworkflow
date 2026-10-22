import test from 'node:test';
import assert from 'node:assert/strict';
import { isReplyTo, parseAnswers } from '../../lib/founder-notes-replies.js';

const AGENT_ID = '<abc123def.k9x2@realskincare.com>';
const OUR = '<qq77zz11.m3@realskincare.com>';
const week = '2026-W44';

test('isReplyTo is false for an agent-sent message even with the right subject', () => {
  const m = { messageId: AGENT_ID, inReplyTo: OUR, references: [OUR], subject: 'Re: [FN-2026-W44] hi' };
  assert.equal(isReplyTo(m, { messageId: OUR, week }), false);
});

test('isReplyTo matches by In-Reply-To', () => {
  const m = { messageId: '<x@example.com>', inReplyTo: OUR, references: [], subject: 'hello' };
  assert.equal(isReplyTo(m, { messageId: OUR, week }), true);
});

test('isReplyTo matches by References', () => {
  const m = { messageId: '<x@example.com>', inReplyTo: null, references: ['<a@example.com>', OUR], subject: 'hello' };
  assert.equal(isReplyTo(m, { messageId: OUR, week }), true);
});

test('isReplyTo matches by subject tag only', () => {
  const m = { messageId: '<x@example.com>', references: [], subject: 'Re: Notes [FN-2026-W44]' };
  assert.equal(isReplyTo(m, { messageId: OUR, week }), true);
  assert.equal(isReplyTo({ ...m, subject: 'Re: Notes [FN-2026-W43]' }, { messageId: OUR, week }), false);
});

test('parseAnswers splits numbered answers', () => {
  const r = parseAnswers('1. yes\n\n2) a story\nmore\n', 3);
  assert.deepEqual(r.map((a) => a.index), [1, 2]);
  assert.equal(r[1].answer, 'a story\nmore');
});

test('parseAnswers supports #n markers', () => {
  assert.deepEqual(parseAnswers('#1 hi\n#2 there', 2), [{ index: 1, answer: 'hi' }, { index: 2, answer: 'there' }]);
});

test('parseAnswers with no marker is general', () => {
  assert.deepEqual(parseAnswers('all good this week', 3), [{ index: null, answer: 'all good this week' }]);
});

test('parseAnswers keeps text before first marker as general', () => {
  assert.deepEqual(parseAnswers('Quick note\n1. x', 2), [
    { index: null, answer: 'Quick note' },
    { index: 1, answer: 'x' },
  ]);
});

test('parseAnswers keeps out-of-range marker in previous block', () => {
  assert.deepEqual(parseAnswers('1. a\n7. b', 2), [{ index: 1, answer: 'a\n7. b' }]);
});

test('parseAnswers drops blank answers and empty input', () => {
  assert.deepEqual(parseAnswers('1.\n2. real', 2), [{ index: 2, answer: 'real' }]);
  assert.deepEqual(parseAnswers('', 2), []);
});
