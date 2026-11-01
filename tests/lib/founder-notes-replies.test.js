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

import { parseInlineReply, hasInlineMarkers } from '../../lib/founder-notes-replies.js';

const INLINE = [
  'On Mon, Oct 26, 2026 at 8:35 AM Sean <founder@example.com>',
  'wrote:',
  '',
  '> Reply under each number. Skip any you like.',
  '>',
  '> 1. What was your reaction to this review?',
  '>',
  '>    "Invented review text here." (Pat, 5 stars)',
  '',
  'Loved it, we hear that a lot.',
  'Second line.',
  '',
  '> 2. Your take on the news?',
  '>    Some headline',
  '',
  '> 3. Anything on the upcoming post?',
  '',
].join('\n');

test('parseInlineReply assigns unquoted text under each quoted question', () => {
  assert.deepEqual(parseInlineReply(INLINE, 3), [
    { index: 1, answer: 'Loved it, we hear that a lot.\nSecond line.' },
  ]);
  assert.equal(hasInlineMarkers(INLINE, 3), true);
  assert.equal(hasInlineMarkers('1. plain', 3), false);
});

test('parseInlineReply sends a top-post through parseAnswers and drops attribution', () => {
  const text = ['Quick general note', '', 'On Mon, Oct 26, 2026, at 8:35 AM, Sean <founder@example.com> wrote:', '> 1. Q one', 'one', '> #2 Q two', 'two'].join('\n');
  assert.deepEqual(parseInlineReply(text, 2), [
    { index: null, answer: 'Quick general note' },
    { index: 1, answer: 'one' },
    { index: 2, answer: 'two' },
  ]);
});

test('parseInlineReply ignores out-of-range quoted markers and blank answers', () => {
  const text = ['> 1) Q', '', '> 9. not ours', 'still answer one'].join('\n');
  assert.deepEqual(parseInlineReply(text, 2), [{ index: 1, answer: 'still answer one' }]);
});
