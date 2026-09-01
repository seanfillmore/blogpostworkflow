import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  replacePhrase, countPhrase, escapeRe, parseArgs, validate, TEXT_FIELDS, LANDERS,
} from '../../scripts/replace-lander-phrase.mjs';

// Sean, 2026-09-01, objected to the ADVERB "singly" and not the noun "singles".
// "twelve singles" reads fine; "buying them singly" does not.

test('the boundary is what keeps singly and singles apart', () => {
  assert.equal(replacePhrase('less than twelve singles', 'singly', 'on their own'), 'less than twelve singles');
  assert.equal(replacePhrase('buying them singly', 'singly', 'on their own'), 'buying them on their own');
  assert.equal(countPhrase('four singles and buying singly', 'singly'), 1);
});

test('every occurrence is replaced, not just the first', () => {
  assert.equal(replacePhrase('singly and singly', 'singly', 'X'), 'X and X');
});

test('a phrase inside a longer word is never touched', () => {
  assert.equal(replacePhrase('singlyish', 'singly', 'X'), 'singlyish');
  assert.equal(countPhrase('presingly', 'singly'), 0);
});

test('regex metacharacters in the phrase are literal', () => {
  assert.equal(escapeRe('$10 (each)'), '\\$10 \\(each\\)');
  assert.equal(replacePhrase('save $10 today', '$10', '$12'), 'save $12 today');
});

test('a non-string field is passed through rather than crashing', () => {
  // Metaobject values are always strings, but a missing field reads undefined and
  // a crash mid-sweep would leave some landers rewritten and some not.
  assert.equal(replacePhrase(undefined, 'a', 'b'), undefined);
  assert.equal(replacePhrase(null, 'a', 'b'), null);
  assert.equal(countPhrase(undefined, 'a'), 0);
});

test('--from and --to are both required, and must differ', () => {
  assert.equal(validate({ from: 'a' }).ok, false);
  assert.equal(validate({ to: 'b' }).ok, false);
  assert.equal(validate({ from: 'a', to: 'a' }).ok, false);
  assert.equal(validate({ from: 'a', to: 'b' }).ok, true);
  assert.equal(validate({ from: 'a', to: '' }).ok, true, 'deleting a phrase is legal');
});

test('parseArgs rejects an unknown flag', () => {
  assert.throws(() => parseArgs(['--force']), /unknown argument/);
  const a = parseArgs(['--from', 'x', '--to', 'y', '--apply']);
  assert.deepEqual([a.from, a.to, a.apply], ['x', 'y', true]);
});

test('the sweep covers the prose fields and every lander', () => {
  for (const k of ['founder_note', 'stats', 'subheading', 'whats_in_it_note', 'buybox_bullets']) {
    assert.ok(TEXT_FIELDS.includes(k), `${k} holds prose and must be swept`);
  }
  assert.equal(Object.keys(LANDERS).length, 6, 'all six bundle landers');
});
