import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BRIEF_STATES, briefsDir, briefPath, isValidBriefId,
  writeBrief, readBrief, listBriefs, decideBrief, listProductsWithBriefs, chooseFormat,
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

// The gate check has to live at the single write point, not only inside decideBrief —
// writeBrief is a side door onto the same file, and in a later task its inputs originate
// from an HTTP handler. Only an approved brief is ever rendered into a paid image, so this
// is the security boundary of the whole feature.
test('writeBrief refuses an approved record with no gates block', () => {
  const root = freshRoot();
  assert.throws(() => writeBrief(root, brief({ state: 'approved' })), /gate/i);
});

test('writeBrief refuses an approved record whose gates.claims.ok is false', () => {
  const root = freshRoot();
  assert.throws(
    () => writeBrief(root, brief({ state: 'approved', gates: { health: { ok: true }, claims: { ok: false } } })),
    /gate/i,
  );
});

test('writeBrief refuses an approved record whose gates.health.ok is false', () => {
  const root = freshRoot();
  assert.throws(
    () => writeBrief(root, brief({ state: 'approved', gates: { health: { ok: false }, claims: { ok: true } } })),
    /gate/i,
  );
});

// Truthy is not the same as === true. A gate value of 1 or 'true' must not slip past a
// strict comparison the way it would past a plain if (gates.health.ok) check.
test('writeBrief refuses an approved record whose gate values are truthy but not boolean true', () => {
  const root = freshRoot();
  assert.throws(
    () => writeBrief(root, brief({ state: 'approved', gates: { health: { ok: 1 }, claims: { ok: true } } })),
    /gate/i,
  );
  assert.throws(
    () => writeBrief(root, brief({ state: 'approved', gates: { health: { ok: true }, claims: { ok: 'true' } } })),
    /gate/i,
  );
});

test('writeBrief accepts an approved record whose gates both pass', () => {
  const root = freshRoot();
  assert.doesNotThrow(() => writeBrief(root, brief({ state: 'approved', gates: passingGates })));
});

// A needs-evidence brief legitimately has failing (or absent) gates and must still be
// writable — the invariant is scoped to 'approved' records only, not every record.
test('writeBrief still accepts non-approved records regardless of their gates, including none at all', () => {
  const root = freshRoot();
  assert.doesNotThrow(() => writeBrief(root, brief({ briefId: 'a', state: 'needs-evidence' })));
  assert.doesNotThrow(() => writeBrief(root, brief({ briefId: 'b', state: 'ready', gates: { health: { ok: false }, claims: { ok: false } } })));
  assert.doesNotThrow(() => writeBrief(root, brief({ briefId: 'c', state: 'rejected' })));
});

// The dashboard reads these while the agent writes them.
test('a write leaves no partial file behind', () => {
  const root = freshRoot();
  writeBrief(root, brief());
  writeBrief(root, brief({ state: 'approved', gates: passingGates }));
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

// decideBrief's own gate check happens before it ever calls writeBrief, so a legitimate
// approval should sail through writeBrief's invariant too — confirm that end to end rather
// than assume it, because if writeBrief's check ever regressed to disagree with decideBrief's,
// every real approval would break along with the attack it's meant to stop.
test('a legitimate decideBrief approval still round-trips end to end', () => {
  const root = freshRoot();
  writeBrief(root, brief({ state: 'ready', gates: passingGates }));
  const out = decideBrief(root, 'coconut-lotion', brief().briefId, { state: 'approved' });
  assert.equal(out.state, 'approved');
  assert.equal(readBrief(root, 'coconut-lotion', brief().briefId).state, 'approved');
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

// ── chooseFormat — the operator's override, and the boundary that keeps it honest ──
//
// resolveBriefFormatKey (agents/ad-studio/index.js) reads `format.chosen ?? proposed`
// at render time; this is the only function that ever writes `format.chosen`. Its own
// security property is narrower than decide's approval gate but just as load-bearing:
// the key must come from THIS brief's own proposed+alternatives (what the awareness
// join actually produced for its angle), never the global format table, or an operator
// could point an unaware angle's copy at a product-aware layout and silently defeat the
// join lib/ad-brief-score.js's headroom weighting exists to protect.

// Real keys from agents/ad-studio/formats.js (testimonial, manifesto, stat-stack) —
// chooseFormat itself never reads the global FORMATS table, only the brief's own
// proposed+alternatives, but using real keys here keeps the fixture honest against
// what agents/ad-brief/index.js's formatsForAngle() would actually have produced.
const withFormat = (over = {}) => brief({
  format: { proposed: 'testimonial', alternatives: ['manifesto', 'stat-stack'] },
  ...over,
});

test('chooseFormat accepts a listed alternative', () => {
  const root = freshRoot();
  writeBrief(root, withFormat());
  const out = chooseFormat(root, 'coconut-lotion', brief().briefId, 'manifesto');
  assert.equal(out.format.chosen, 'manifesto');
});

test('chooseFormat accepts the proposed key itself', () => {
  const root = freshRoot();
  writeBrief(root, withFormat());
  const out = chooseFormat(root, 'coconut-lotion', brief().briefId, 'testimonial');
  assert.equal(out.format.chosen, 'testimonial');
});

test('chooseFormat refuses a real format key this brief never proposed', () => {
  const root = freshRoot();
  writeBrief(root, withFormat());
  // "ingredient-callout" is a real key elsewhere in FORMATS, just not one of THIS
  // brief's own proposed/alternatives — the whole point of scoping to the brief record
  // rather than the global table.
  assert.throws(
    () => chooseFormat(root, 'coconut-lotion', brief().briefId, 'ingredient-callout'),
    /not a format available/,
  );
});

test('chooseFormat refuses a made-up format key', () => {
  const root = freshRoot();
  writeBrief(root, withFormat());
  assert.throws(
    () => chooseFormat(root, 'coconut-lotion', brief().briefId, 'not-a-real-format'),
    /not a format available/,
  );
});

test('chooseFormat refuses a brief with no proposed format — nothing to choose among', () => {
  const root = freshRoot();
  writeBrief(root, brief({ format: { proposed: null, alternatives: [] } }));
  assert.throws(
    () => chooseFormat(root, 'coconut-lotion', brief().briefId, 'before-after'),
    /no proposed format/,
  );
});

test('chooseFormat leaves state and gates untouched — a parameter change, not a decision', () => {
  const root = freshRoot();
  writeBrief(root, withFormat({ state: 'approved', gates: passingGates }));
  const out = chooseFormat(root, 'coconut-lotion', brief().briefId, 'testimonial');
  assert.equal(out.state, 'approved');
  assert.deepEqual(out.gates, passingGates);
  // Round-trips too, not just the return value.
  const reread = readBrief(root, 'coconut-lotion', brief().briefId);
  assert.equal(reread.state, 'approved');
  assert.equal(reread.format.chosen, 'testimonial');
});

test('chooseFormat on a missing brief throws rather than creating one', () => {
  assert.throws(() => chooseFormat(freshRoot(), 'coconut-lotion', 'ghost', 'before-after'), /ghost/);
});
