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
  writeBrief(root, brief());
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
  for (const s of BRIEF_STATES) {
    assert.doesNotThrow(() => decideBrief(root, 'coconut-lotion', brief().briefId, { state: s }));
  }
});

// A brief the gates floored must not be approvable by anyone, including a crafted request.
test('a needs-evidence brief cannot be approved directly', () => {
  const root = freshRoot();
  writeBrief(root, brief({ state: 'needs-evidence' }));
  assert.throws(
    () => decideBrief(root, 'coconut-lotion', brief().briefId, { state: 'approved' }),
    /needs-evidence/i,
  );
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
