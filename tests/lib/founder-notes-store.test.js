import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadNotes, appendNotes, recordUses, saveQuestionSet, loadQuestionSets,
  askedRefs, stampFounderNoteUses,
} from '../../lib/founder-notes-store.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'fn-store-'));
const note = (id, answer) => ({ id, week: '2026-W43', answer, uses: [], clusters: [] });

test('loadNotes on a missing file is []', () => {
  assert.deepEqual(loadNotes({ dir: join(tmp(), 'nope') }), []);
});

test('appendNotes twice with the same id leaves one row', () => {
  const dir = tmp();
  appendNotes([note('a', 'x')], { dir });
  appendNotes([note('a', 'x'), note('b', 'y')], { dir });
  assert.deepEqual(loadNotes({ dir }).map((n) => n.id), ['a', 'b']);
  rmSync(dir, { recursive: true });
});

test('recordUses adds a use and is idempotent for the same surface+ref', () => {
  const dir = tmp();
  appendNotes([note('a', 'x')], { dir });
  const u = { surface: 'blog', ref: 'slug-1', at: '2026-10-21' };
  assert.equal(recordUses(['a', 'zzz'], u, { dir }), 1);
  assert.equal(recordUses(['a'], u, { dir }), 0);
  assert.equal(recordUses(['a'], { ...u, ref: 'slug-2' }, { dir }), 1);
  assert.equal(loadNotes({ dir })[0].uses.length, 2);
});

test('question sets round trip, one file per week', () => {
  const dir = tmp();
  saveQuestionSet({ week: '2026-W43', sent_at: 'a', message_id: 'm', questions: [{ n: 1, text: 'q', source: { type: 'review', ref: 'r1' } }], replies: [] }, { dir });
  saveQuestionSet({ week: '2026-W44', sent_at: 'b', message_id: 'm2', questions: [{ n: 1, text: 'q', source: { type: 'world', ref: 'https://example.com/p' } }, { n: 2, text: 'q', source: { type: 'upcoming', ref: 's1' } }], replies: [] }, { dir });
  const sets = loadQuestionSets({ dir });
  assert.equal(sets.length, 2);
  const r = askedRefs(sets);
  assert.ok(r.reviews.has('r1'));
  assert.ok(r.urls.has('https://example.com/p'));
  assert.ok(r.slugs.has('s1'));
});

test('stampFounderNoteUses stamps offered matches only', () => {
  const dir = tmp();
  const a = 'Our coconut lotion goes on slowly because nothing synthetic helps it spread quickly';
  const b = 'The cream melts into warm hands before touching the skin every morning';
  appendNotes([note('a', a), note('b', b)], { dir });
  const used = stampFounderNoteUses({ text: `${a}. ${b}.`, offered: ['a'], surface: 'blog', ref: 's', at: 't' }, { dir });
  assert.deepEqual(used, ['a']);
  const n = loadNotes({ dir });
  assert.equal(n.find((x) => x.id === 'a').uses.length, 1);
  assert.equal(n.find((x) => x.id === 'b').uses.length, 0);
});

test('stampFounderNoteUses returns [] when the dir is unreadable', () => {
  const dir = tmp();
  writeFileSync(join(dir, 'notes.jsonl'), '{not json\n');
  assert.deepEqual(stampFounderNoteUses({ text: 'x', offered: ['a'], surface: 's', ref: 'r', at: 't' }, { dir }), []);
});

test('appendNotes dedupes within a single batch', () => {
  const dir = tmp();
  assert.equal(appendNotes([note('a', 'x'), note('a', 'x'), note('b', 'y')], { dir }), 2);
  assert.deepEqual(loadNotes({ dir }).map((n) => n.id), ['a', 'b']);
});
