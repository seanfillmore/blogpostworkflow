// lib/founder-notes-store.js
//
// I/O for founder notes (data/founder-notes/notes.jsonl) and weekly question
// sets (questions/<week>.json). Server-only, gitignored, backed up offsite.
// Pure logic lives in lib/founder-notes.js.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notesUsedIn } from './founder-notes.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_DIR = 'data/founder-notes';

function resolveDir(dir) {
  return isAbsolute(dir) ? dir : join(ROOT, dir);
}

function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export function loadNotes({ dir = DEFAULT_DIR } = {}) {
  const path = join(resolveDir(dir), 'notes.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

function writeNotes(notes, dir) {
  const text = notes.map((n) => JSON.stringify(n)).join('\n');
  atomicWrite(join(resolveDir(dir), 'notes.jsonl'), text ? `${text}\n` : '');
}

// A single writer at a time is assumed; the race window is read-to-rename.
export function appendNotes(notes, { dir = DEFAULT_DIR } = {}) {
  const all = loadNotes({ dir });
  const have = new Set(all.map((n) => n.id));
  let added = 0;
  for (const n of notes || []) {
    if (have.has(n.id)) continue;
    have.add(n.id);
    all.push(n);
    added++;
  }
  if (added) writeNotes(all, dir);
  return added;
}

export function recordUses(ids, { surface, ref, at }, { dir = DEFAULT_DIR } = {}) {
  const want = new Set(ids || []);
  const notes = loadNotes({ dir });
  let added = 0;
  for (const n of notes) {
    if (!want.has(n.id)) continue;
    n.uses = n.uses || [];
    if (n.uses.some((u) => u.surface === surface && u.ref === ref)) continue;
    n.uses.push({ surface, ref, at });
    added++;
  }
  if (added) writeNotes(notes, dir);
  return added;
}

export function saveQuestionSet(set, { dir = DEFAULT_DIR } = {}) {
  atomicWrite(join(resolveDir(dir), 'questions', `${set.week}.json`), `${JSON.stringify(set, null, 2)}\n`);
}

export function loadQuestionSets({ dir = DEFAULT_DIR } = {}) {
  const qdir = join(resolveDir(dir), 'questions');
  if (!existsSync(qdir)) return [];
  return readdirSync(qdir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(readFileSync(join(qdir, f), 'utf8')));
}

export function askedRefs(sets) {
  const out = { reviews: new Set(), urls: new Set(), slugs: new Set() };
  for (const s of sets || []) {
    for (const q of s.questions || []) {
      const { type, ref } = q.source || {};
      if (!ref) continue;
      if (type === 'review') out.reviews.add(ref);
      else if (type === 'world') out.urls.add(ref);
      else if (type === 'upcoming') out.slugs.add(ref);
    }
  }
  return out;
}

export function stampFounderNoteUses({ text, offered, surface, ref, at }, opts = {}) {
  try {
    const offeredSet = new Set(offered || []);
    const notes = loadNotes(opts).filter((n) => offeredSet.has(n.id));
    const used = notesUsedIn(text, notes);
    if (used.length) recordUses(used, { surface, ref, at }, opts);
    return used;
  } catch (err) {
    console.error(`[founder-notes] usage stamp failed: ${err.message}`);
    return [];
  }
}
