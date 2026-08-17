import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BRIEF_STATES, briefsDir, briefPath, isValidBriefId,
  writeBrief, readBrief, listBriefs, decideBrief, listProductsWithBriefs,
} from '../../lib/ad-brief.js';

const freshRoot = () => mkdtempSync(join(tmpdir(), 'ad-brief-'));

const brief = (over = {}) => ({
  briefId: 'coconut-lotion-p1a1-1786000000000',
  product: 'coconut-lotion',
  state: 'ready',
  score: { total: 70, persona: 30, proof: 25, commercial: 10, headroom: 5 },
  createdAt: '2026-08-16T00:00:00.000Z',
  ...over,
});

// The immutable evidence a decision is checked against. Written once at generation time;
// no decision ever edits it.
const passingGates = { health: { ok: true }, claims: { ok: true } };

test('brief ids may not contain a path separator', () => {
  assert.equal(isValidBriefId('coconut-lotion-p1a1-1786000000000'), true);
  assert.equal(isValidBriefId('../../../etc/passwd'), false);
  assert.equal(isValidBriefId('a/b'), false);
  assert.equal(isValidBriefId('..'), false);
  assert.equal(isValidBriefId(''), false);
});

// The product name is a directory segment and reaches the filesystem from HTTP.
test('a product name with a separator is refused, not joined', () => {
  const root = freshRoot();
  assert.throws(() => briefsDir(root, '../escape'), /product/i);
  assert.throws(() => briefPath(root, 'a/b', 'x'), /product/i);
});

test('write then read round-trips and creates the directory', () => {
  const root = freshRoot();
  writeBrief(root, brief());
  assert.equal(readBrief(root, 'coconut-lotion', brief().briefId).state, 'ready');
});

test('reading a missing or corrupt brief is null, never a throw', () => {
  const root = freshRoot();
  assert.equal(readBrief(root, 'coconut-lotion', 'nope'), null);
  mkdirSync(briefsDir(root, 'coconut-lotion'), { recursive: true });
  writeFileSync(briefPath(root, 'coconut-lotion', 'bad'), '{ not json');
  assert.equal(readBrief(root, 'coconut-lotion', 'bad'), null);
});

test('writeBrief refuses a brief with no id or no product', () => {
  const root = freshRoot();
  assert.throws(() => writeBrief(root, { product: 'x' }), /briefId/);
  assert.throws(() => writeBrief(root, { briefId: 'x' }), /product/);
});

test('writeBrief throws on an out-of-vocabulary state', () => {
  const root = freshRoot();
  assert.throws(() => writeBrief(root, brief({ state: 'shipped' })), /state/i);
});

test('writeBrief accepts a brief with no state field at all', () => {
  const root = freshRoot();
  const { state, ...noState } = brief();
  assert.doesNotThrow(() => writeBrief(root, noState));
});

// The dashboard reads these while the agent writes them.
test('a write leaves no partial file behind', () => {
  const root = freshRoot();
  writeBrief(root, brief());
  writeBrief(root, brief({ state: 'approved' }));
  assert.deepEqual(readdirSync(briefsDir(root, 'coconut-lotion')), [`${brief().briefId}.json`]);
});

test('listBriefs ranks by score, highest first', () => {
  const root = freshRoot();
  writeBrief(root, brief({ briefId: 'lo', score: { total: 20 } }));
  writeBrief(root, brief({ briefId: 'hi', score: { total: 90 } }));
  writeBrief(root, brief({ briefId: 'mid', score: { total: 55 } }));
  assert.deepEqual(listBriefs(root, 'coconut-lotion').map(b => b.briefId), ['hi', 'mid', 'lo']);
});

test('a brief with no score sorts last rather than crashing the list', () => {
  const root = freshRoot();
  writeBrief(root, brief({ briefId: 'scored', score: { total: 10 } }));
  writeBrief(root, brief({ briefId: 'unscored', score: undefined }));
  assert.deepEqual(listBriefs(root, 'coconut-lotion').map(b => b.briefId), ['scored', 'unscored']);
});

test('listBriefs on a product with none is empty, not an error', () => {
  assert.deepEqual(listBriefs(freshRoot(), 'coconut-lotion'), []);
});

test('decide sets the state and stamps decidedAt', () => {
  const root = freshRoot();
  writeBrief(root, brief({ gates: passingGates }));
  const out = decideBrief(root, 'coconut-lotion', brief().briefId, { state: 'approved', note: 'good angle' });
  assert.equal(out.state, 'approved');
  assert.equal(out.note, 'good angle');
  assert.ok(Date.parse(out.decidedAt));
});

// The state machine is the whole safety story: only an approved brief renders.
test('decide refuses a state that is not in the vocabulary', () => {
  const root = freshRoot();
  writeBrief(root, brief());
  assert.throws(() => decideBrief(root, 'coconut-lotion', brief().briefId, { state: 'shipped' }), /state/i);
});

// Each iteration sets up its own starting state explicitly, so this proves every state in
// BRIEF_STATES is independently reachable from 'ready' — it does not depend on, and cannot
// be defeated by, the ORDER BRIEF_STATES lists its members in.
test('decide accepts every state in the vocabulary, each set up independently', () => {
  const root = freshRoot();
  for (const s of BRIEF_STATES) {
    const id = `vocab-${s}`;
    writeBrief(root, brief({ briefId: id, state: 'ready', gates: passingGates }));
    assert.doesNotThrow(() => decideBrief(root, 'coconut-lotion', id, { state: s }));
  }
});

// Approval is gated on the immutable `gates` record, not on the mutable `state` field, so
// no walk of intermediate states can launder a floored brief into 'approved'. A single-hop
// check (current.state === 'needs-evidence' && target === 'approved') would miss this: ready
// is not needs-evidence, and approved's target check alone doesn't see where it came from.
test('a two-step transition cannot launder needs-evidence into approved', () => {
  const root = freshRoot();
  writeBrief(root, brief({ state: 'needs-evidence' })); // no gates: matches a floored generation
  decideBrief(root, 'coconut-lotion', brief().briefId, { state: 'ready' });
  assert.throws(
    () => decideBrief(root, 'coconut-lotion', brief().briefId, { state: 'approved' }),
    /gate/i,
  );
});

test('a brief whose gates.claims.ok is false cannot be approved, however its state got there', () => {
  const root = freshRoot();
  writeBrief(root, brief({ state: 'ready', gates: { health: { ok: true }, claims: { ok: false } } }));
  assert.throws(
    () => decideBrief(root, 'coconut-lotion', brief().briefId, { state: 'approved' }),
    /claims/i,
  );
});

test('a brief whose gates.health.ok is false cannot be approved', () => {
  const root = freshRoot();
  writeBrief(root, brief({ state: 'ready', gates: { health: { ok: false }, claims: { ok: true } } }));
  assert.throws(
    () => decideBrief(root, 'coconut-lotion', brief().briefId, { state: 'approved' }),
    /health/i,
  );
});

test('a brief with no gates block cannot be approved', () => {
  const root = freshRoot();
  writeBrief(root, brief({ state: 'ready' }));
  assert.throws(
    () => decideBrief(root, 'coconut-lotion', brief().briefId, { state: 'approved' }),
    /gate/i,
  );
});

// A human changing their mind — including un-rejecting something — is legitimate, as long
// as the immutable evidence backs it.
test('a brief with both gates passing can be approved, from ready and from rejected', () => {
  const root = freshRoot();
  writeBrief(root, brief({ briefId: 'from-ready', state: 'ready', gates: passingGates }));
  assert.doesNotThrow(() => decideBrief(root, 'coconut-lotion', 'from-ready', { state: 'approved' }));

  writeBrief(root, brief({ briefId: 'from-rejected', state: 'rejected', gates: passingGates }));
  assert.doesNotThrow(() => decideBrief(root, 'coconut-lotion', 'from-rejected', { state: 'approved' }));
});

test('decide on a missing brief throws rather than creating one', () => {
  assert.throws(() => decideBrief(freshRoot(), 'coconut-lotion', 'ghost', { state: 'approved' }), /ghost/);
});

test('listProductsWithBriefs enumerates the product directories', () => {
  const root = freshRoot();
  writeBrief(root, brief());
  writeBrief(root, brief({ briefId: 'soap-p5a3-1', product: 'coconut-soap' }));
  assert.deepEqual(listProductsWithBriefs(root).sort(), ['coconut-lotion', 'coconut-soap']);
});
