import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectFounderNotes,
  founderNotesBlock,
  notesUsedIn,
  MAX_USES,
  DEFAULT_NOTE_LIMIT,
} from '../../lib/founder-notes.js';

function note(answer, over = {}) {
  return {
    id: 'fn-2026-W43-1',
    week: '2026-W43',
    asked_at: '2026-10-19T15:35:00Z',
    answered_at: '2026-10-20T10:00:00Z',
    question: 'How did you start?',
    source: { type: 'general', ref: null },
    answer,
    answer_raw: answer,
    redaction: 'ok',
    clusters: [],
    gate: { editorial: 'ok', commercial: 'ok', hits: [] },
    uses: [],
    ...over,
  };
}

test('constants', () => {
  assert.equal(MAX_USES, 2);
  assert.equal(DEFAULT_NOTE_LIMIT, 3);
});

test('select drops failed redaction', () => {
  const n = note('a', { redaction: 'failed' });
  assert.deepEqual(selectFounderNotes([n], { surface: 'editorial' }), []);
});

test('select drops commercial-blocked for commercial, keeps for editorial', () => {
  const n = note('a', { gate: { editorial: 'ok', commercial: 'blocked', hits: [] } });
  assert.deepEqual(selectFounderNotes([n], { surface: 'commercial' }), []);
  assert.equal(selectFounderNotes([n], { surface: 'editorial' }).length, 1);
});

test('select drops notes used MAX_USES times', () => {
  const u = { surface: 'editorial', ref: 'x', at: 'now' };
  assert.deepEqual(selectFounderNotes([note('a', { uses: [u, u] })], { surface: 'editorial' }), []);
  assert.equal(selectFounderNotes([note('a', { uses: [u] })], { surface: 'editorial' }).length, 1);
});

test('ref match outranks a newer cluster match, then general', () => {
  const refN = note('r', { id: 'r', answered_at: '2026-10-01T00:00:00Z', source: { type: 'post', ref: 'slug-a' }, clusters: ['soap'] });
  const clN = note('c', { id: 'c', answered_at: '2026-10-10T00:00:00Z', source: { type: 'product', ref: 'other' }, clusters: ['lotion'] });
  const genN = note('g', { id: 'g', answered_at: '2026-10-20T00:00:00Z' });
  const out = selectFounderNotes([genN, clN, refN], { clusters: ['lotion'], ref: 'slug-a', surface: 'editorial' });
  assert.deepEqual(out.map((n) => n.id), ['r', 'c', 'g']);
});

test('newest first within a group and limit truncates', () => {
  const a = note('a', { id: 'a', answered_at: '2026-10-01T00:00:00Z' });
  const b = note('b', { id: 'b', answered_at: '2026-10-05T00:00:00Z' });
  const c = note('c', { id: 'c', answered_at: '2026-10-03T00:00:00Z' });
  const out = selectFounderNotes([a, b, c], { surface: 'editorial', limit: 2 });
  assert.deepEqual(out.map((n) => n.id), ['b', 'c']);
});

test('toothpaste note not returned for lotion clusters', () => {
  const n = note('a', { clusters: ['toothpaste'], source: { type: 'product', ref: 'p' } });
  assert.deepEqual(selectFounderNotes([n], { clusters: ['lotion'], surface: 'editorial' }), []);
});

test('block is empty for no notes', () => {
  assert.equal(founderNotesBlock([], { surface: 'editorial' }), '');
});

test('editorial and commercial blocks', () => {
  const n = note('I make it in small batches', { question: 'How is it made?' });
  const e = founderNotesBlock([n], { surface: 'editorial' });
  assert.match(e, /FOUNDER NOTES \(Sean's own words, gathered by email\)/);
  assert.match(e, /How is it made\?/);
  assert.match(e, /small batches/);
  assert.match(e, /Sean, Co-Founder of Real Skin Care/);
  assert.match(e, /never name a customer or any private person/i);
  assert.match(e, /never add detail the note does not contain/i);
  const c = founderNotesBlock([n], { surface: 'commercial' });
  assert.match(c, /first person/);
  assert.doesNotMatch(c, /Co-Founder/);
});

test('notesUsedIn detects paraphrase', () => {
  const n = note('I started making lotion in my kitchen and the coconut oil kept separating on me');
  const t = '<p>When I started making lotion in my kitchen the coconut oil kept separating</p>';
  assert.deepEqual(notesUsedIn(t, [n]), [n.id]);
});

test('notesUsedIn ignores topic words only', () => {
  const n = note('I started making lotion in my kitchen and the coconut oil kept separating on me');
  assert.deepEqual(notesUsedIn('coconut oil lotion ingredients', [n]), []);
});

test('long note needs 3 bigrams', () => {
  const n = note('Summer mornings, harvesting fragrant lavender fields, drying bundles carefully before distilling gentle essential extracts');
  const two = 'summer mornings harvesting. Unrelated words entirely here.';
  assert.deepEqual(notesUsedIn(two, [n]), []);
  const three = 'summer mornings harvesting fragrant lavender fields';
  assert.deepEqual(notesUsedIn(three, [n]), [n.id]);
});

test('short note is detected when its phrase appears, not otherwise', () => {
  const n = note('I make it in small batches');
  assert.deepEqual(notesUsedIn('We work in small batches here.', [n]), [n.id]);
  assert.deepEqual(notesUsedIn('We work in large batches here and small shops.', [n]), []);
});

test('single-content-word note matches contiguously; empty note never used', () => {
  assert.deepEqual(notesUsedIn('Made in a kitchen', [note('kitchen')]), ['fn-2026-W43-1']);
  assert.deepEqual(notesUsedIn('anything at all', [note('I am so')]), []);
});

test('html entities do not inject words', () => {
  const n = note('I started making lotion in my kitchen and the coconut oil kept separating on me');
  const t = 'I started making lotion in my kitchen&rsquo;s coconut&nbsp;oil kept separating';
  assert.deepEqual(notesUsedIn(t, [n]), [n.id]);
  const m = note('We make small batches');
  assert.deepEqual(notesUsedIn('small&nbsp;batches', [m]), [m.id]);
});

test('select throws on unknown surface', () => {
  assert.throws(() => selectFounderNotes([], { surface: 'press' }));
  assert.throws(() => selectFounderNotes([], {}));
});
