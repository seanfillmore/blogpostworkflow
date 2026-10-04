import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newDraft, approveDraft, rejectDraft, markSent, expireDrafts, sendOrder, loadDrafts, saveDraft } from '../../lib/press-drafts.js';

const T0 = Date.parse('2026-10-05T12:00:00Z'), D = 86_400_000;
const mk = (over = {}) => newDraft({ kind: 'pitch', contactId: 'jane-doe', to: 'jane@example.com', subject: 'Hi', text: 'Body', concept: 'intro', now: T0, ...over });

test('new draft is pending with a stable id', () => {
  const d = mk();
  assert.equal(d.status, 'pending');
  assert.match(d.id, /^\d{8}-jane-doe-pitch$/);
});

test('approve applies edits and keeps created_at (expiry is from creation)', () => {
  const d = approveDraft(mk(), { now: T0 + D, edits: { subject: 'Edited' } });
  assert.equal(d.status, 'approved');
  assert.equal(d.subject, 'Edited');
  assert.equal(d.created_at, new Date(T0).toISOString());
  assert.throws(() => approveDraft(markSent(approveDraft(mk(), { now: T0 }), { now: T0, messageId: '<m>' }), { now: T0 }), /sent/);
});

test('reject needs a reason', () => {
  assert.throws(() => rejectDraft(mk(), { now: T0 }));
  assert.equal(rejectDraft(mk(), { now: T0, reason: 'wrong beat' }).status, 'rejected');
});

test('pending AND approved drafts expire 14 days after creation; sent ones never', () => {
  const pending = mk();
  const approved = approveDraft(mk({ contactId: 'b' }), { now: T0 + 13 * D });
  const sent = markSent(approveDraft(mk({ contactId: 'c' }), { now: T0 }), { now: T0, messageId: '<m>' });
  const { drafts, expired } = expireDrafts([pending, approved, sent], T0 + 14 * D + 1);
  assert.deepEqual(expired.map((d) => d.contact_id).sort(), ['b', 'jane-doe']);
  assert.equal(drafts.find((d) => d.contact_id === 'c').status, 'sent');
});

test('send order: approved only, oldest approval first', () => {
  const a = approveDraft(mk({ contactId: 'a' }), { now: T0 + 2 * D });
  const b = approveDraft(mk({ contactId: 'b' }), { now: T0 + D });
  assert.deepEqual(sendOrder([mk({ contactId: 'p' }), a, b]).map((d) => d.contact_id), ['b', 'a']);
});

test('store round-trips through an injected fs, atomically', () => {
  const files = new Map();
  const fsImpl = {
    mkdirSync() {}, readdirSync: () => [...files.keys()].map((k) => k.split('/').pop()),
    readFileSync: (p) => files.get(p), writeFileSync: (p, s) => files.set(p, s),
    renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
  };
  saveDraft('/d', mk(), fsImpl);
  assert.equal(loadDrafts('/d', fsImpl)[0].contact_id, 'jane-doe');
  assert.ok(![...files.keys()].some((k) => k.includes('.tmp')));
});

test('saveDraft refuses to overwrite a sent draft with a non-sent draft', () => {
  const files = new Map();
  const fsImpl = {
    mkdirSync() {}, readdirSync: () => [...files.keys()].map((k) => k.split('/').pop()),
    readFileSync: (p) => files.get(p), writeFileSync: (p, s) => files.set(p, s),
    renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
  };
  // Save a sent draft first
  const sent = markSent(approveDraft(mk(), { now: T0 }), { now: T0, messageId: '<m>' });
  saveDraft('/d', sent, fsImpl);

  // Try to overwrite it with an approved draft (non-sent) — should throw
  const approved = approveDraft(mk(), { now: T0 + D });
  assert.throws(
    () => saveDraft('/d', approved, fsImpl),
    /cannot overwrite sent draft|already sent/i
  );

  // The sent draft should still be in storage
  assert.equal(loadDrafts('/d', fsImpl)[0].status, 'sent');
});

test('saveDraft allows a sent draft to overwrite its approved version (normal markSent flow)', () => {
  const files = new Map();
  const fsImpl = {
    mkdirSync() {}, readdirSync: () => [...files.keys()].map((k) => k.split('/').pop()),
    readFileSync: (p) => files.get(p), writeFileSync: (p, s) => files.set(p, s),
    renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
  };
  // Save an approved draft
  const approved = approveDraft(mk(), { now: T0 });
  saveDraft('/d', approved, fsImpl);

  // Now overwrite with a sent version of the same draft — should succeed
  const sent = markSent(approved, { now: T0 + D, messageId: '<m>' });
  saveDraft('/d', sent, fsImpl);

  assert.equal(loadDrafts('/d', fsImpl)[0].status, 'sent');
});

test('approveDraft on a rejected draft changes mind, dropping rejected metadata', () => {
  const d = rejectDraft(mk(), { now: T0, reason: 'wrong beat' });
  assert.equal(d.status, 'rejected');
  assert.equal(d.rejected_reason, 'wrong beat');

  const reconsidered = approveDraft(d, { now: T0 + D });
  assert.equal(reconsidered.status, 'approved');
  assert.equal(reconsidered.rejected_reason, undefined);
  assert.equal(reconsidered.rejected_at, undefined);
});

test('M4: a corrupt draft file is skipped and named, not thrown', () => {
  const files = new Map([['/d/good.json', JSON.stringify(mk())], ['/d/bad.json', '{"id": "half-writ']]);
  const fsImpl = { readdirSync: () => ['good.json', 'bad.json'], readFileSync: (p) => files.get(p) };
  const errors = [];
  const out = loadDrafts('/d', fsImpl, { onError: (name, err) => errors.push({ name, err }) });
  assert.equal(out.length, 1);
  assert.equal(out[0].contact_id, 'jane-doe');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].name, 'bad.json');
  assert.doesNotThrow(() => loadDrafts('/d', fsImpl), 'no callback: still does not throw');
});

const memFs = () => {
  const files = new Map();
  return {
    files,
    mkdirSync() {}, readdirSync: () => [...files.keys()].map((k) => k.split('/').pop()),
    readFileSync: (p) => files.get(p), writeFileSync: (p, s) => files.set(p, s),
    renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a); },
  };
};

test('I2: saveDraft refuses to overwrite an APPROVED draft with a different, newer draft', () => {
  const fsImpl = memFs();
  const approved = approveDraft(mk(), { now: T0 + 1000 });
  saveDraft('/d', approved, fsImpl);
  // A second run the same day builds a fresh pending draft with the same id.
  const fresh = mk({ now: T0 + 3600_000, subject: 'Second run' });
  assert.equal(fresh.id, approved.id);
  assert.throws(() => saveDraft('/d', fresh, fsImpl), /cannot overwrite approved draft/);
  assert.equal(loadDrafts('/d', fsImpl)[0].status, 'approved');
  assert.equal(loadDrafts('/d', fsImpl)[0].subject, 'Hi');
});

test('I2: the same approved draft may still be edited back to pending, rejected or sent', () => {
  for (const next of [
    (a) => { const n = { ...a, status: 'pending', edited: true }; delete n.approved_at; return n; },
    (a) => rejectDraft(a, { now: T0 + D, reason: 'changed mind' }),
    (a) => approveDraft(a, { now: T0 + D, edits: { subject: 'Edited' } }),
    (a) => markSent(a, { now: T0 + D, messageId: '<m>' }),
  ]) {
    const fsImpl = memFs();
    const approved = approveDraft(mk(), { now: T0 });
    saveDraft('/d', approved, fsImpl);
    assert.doesNotThrow(() => saveDraft('/d', next(approved), fsImpl));
  }
});
