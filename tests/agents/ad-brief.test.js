import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  AWARENESS_TO_FORMAT_AWARENESS, formatsForAngle, personaProjection, angleRelevance,
  buildBriefId, parseArgs,
} from '../../agents/ad-brief/index.js';
import { FORMATS } from '../../agents/ad-studio/formats.js';

// ── the awareness join ──────────────────────────────────────────────────────────────
//
// formats.js tags each format problem|solution|product; persona angles carry
// unaware|problem-aware|solution-aware|product-aware|most-aware. This is the join that
// lets a brief propose its own format instead of a rotation choosing for it.

test('a problem-aware angle proposes a problem-awareness format', () => {
  const { proposed, alternatives } = formatsForAngle({ awareness: 'problem-aware' }, FORMATS);
  const all = [proposed, ...alternatives];
  assert.ok(proposed, 'a problem-aware angle must get a format');
  for (const key of all) {
    assert.equal(FORMATS.find(f => f.key === key).awareness, 'problem');
  }
});

test('a solution-aware angle proposes a solution-awareness format', () => {
  const { proposed } = formatsForAngle({ awareness: 'solution-aware' }, FORMATS);
  assert.equal(FORMATS.find(f => f.key === proposed).awareness, 'solution');
});

test('a product-aware angle proposes a product-awareness format', () => {
  const { proposed } = formatsForAngle({ awareness: 'product-aware' }, FORMATS);
  assert.equal(FORMATS.find(f => f.key === proposed).awareness, 'product');
});

// THE KNOWN GAP, pinned so it is countable rather than inferred. No format covers
// `unaware` or `most-aware`, and by the headroom argument those are the most valuable
// angles we hold. When a format is finally built for either level, this test tells you.
test('unaware and most-aware angles have NO format and say so', () => {
  assert.equal(formatsForAngle({ awareness: 'unaware' }, FORMATS).proposed, null);
  assert.equal(formatsForAngle({ awareness: 'most-aware' }, FORMATS).proposed, null);
  assert.equal(AWARENESS_TO_FORMAT_AWARENESS['unaware'], null);
  assert.equal(AWARENESS_TO_FORMAT_AWARENESS['most-aware'], null);
});

test('the proposal is deterministic — the same angle always proposes the same format', () => {
  const a = formatsForAngle({ awareness: 'problem-aware' }, FORMATS);
  const b = formatsForAngle({ awareness: 'problem-aware' }, FORMATS);
  assert.deepEqual(a, b);
});

test('an unknown awareness value yields no format rather than throwing', () => {
  assert.equal(formatsForAngle({ awareness: 'banana' }, FORMATS).proposed, null);
  assert.equal(formatsForAngle({}, FORMATS).proposed, null);
});

// ── persona projection ──────────────────────────────────────────────────────────────
//
// copy.js's buildCopyPrompt wants { name, angles: [flat strings] }. Ad Studio passes ALL
// of a persona's angles, which tells the writer to address five things at once. A brief
// is ONE angle, and the projection is what makes the copy specific to it.

test('the projection carries exactly one angle, not the persona whole', () => {
  const persona = {
    name: 'The Ingredient-Label Reader',
    angles: [
      { id: 'p2a1', label: 'One ingredient', objection_addressed: 'is it really one thing?', proof: 'the label' },
      { id: 'p2a2', label: '125 chemicals a day', objection_addressed: 'x', proof: 'y' },
    ],
  };
  const p = personaProjection(persona, persona.angles[0]);
  assert.equal(p.name, 'The Ingredient-Label Reader');
  assert.equal(p.angles.length, 1);
  assert.match(p.angles[0], /One ingredient/);
  assert.ok(!p.angles[0].includes('125 chemicals'), 'must not leak the other angles');
});

test('the projection folds in the objection so the copy answers it', () => {
  const angle = { id: 'x', label: 'L', objection_addressed: "I've tried everything", proof: 'P' };
  const p = personaProjection({ name: 'N', angles: [angle] }, angle);
  assert.match(p.angles[0], /tried everything/);
});

test('the projection survives an angle missing its optional fields', () => {
  const angle = { id: 'x', label: 'Just a label' };
  const p = personaProjection({ name: 'N', angles: [angle] }, angle);
  assert.equal(typeof p.angles[0], 'string');
  assert.match(p.angles[0], /Just a label/);
});

// ── relevance ───────────────────────────────────────────────────────────────────────
//
// personas.json is cluster-scoped, so a lotion-specific angle would otherwise be briefed
// against bar soap and produce nonsense at one Opus call apiece.

test('a soap angle is relevant to soap and not to lotion', () => {
  const angle = { label: 'The bar you put out for guests', proof: 'a bar of soap by the sink' };
  assert.equal(angleRelevance(angle, { handle: 'coconut-soap', title: 'Coconut Bar Soap' }), true);
  assert.equal(angleRelevance(angle, { handle: 'coconut-lotion', title: 'Coconut Lotion' }), false);
});

test('an angle naming no product stays relevant to everything', () => {
  const angle = { label: 'After prescriptions failed', proof: 'reviewer with eczema' };
  assert.equal(angleRelevance(angle, { handle: 'coconut-lotion', title: 'Coconut Lotion' }), true);
  assert.equal(angleRelevance(angle, { handle: 'coconut-soap', title: 'Coconut Bar Soap' }), true);
});

// ── ids and args ────────────────────────────────────────────────────────────────────
test('a brief id is safe as a filename and carries product and angle', () => {
  const id = buildBriefId('coconut-lotion', 'p1a1', 1786000000000);
  assert.match(id, /^[\w.-]+$/);
  assert.match(id, /coconut-lotion/);
  assert.match(id, /p1a1/);
});

test('--product is required', () => {
  assert.throws(() => parseArgs([]), /--product/);
});

test('--angles is parsed as a list and defaults to empty (meaning all relevant)', () => {
  assert.deepEqual(parseArgs(['--product', 'coconut-lotion']).angles, []);
  assert.deepEqual(parseArgs(['--product', 'coconut-lotion', '--angles', 'p1a1, p5a3']).angles, ['p1a1', 'p5a3']);
});

test('--dry-run is off by default', () => {
  assert.equal(parseArgs(['--product', 'coconut-lotion']).dryRun, false);
  assert.equal(parseArgs(['--product', 'coconut-lotion', '--dry-run']).dryRun, true);
});
