import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AWARENESS_TO_FORMAT_AWARENESS, formatsForAngle, personaProjection, angleRelevance,
  buildBriefId, parseArgs, gatesFromRejection, assertClusterCoverage, generateBriefs,
} from '../../agents/ad-brief/index.js';
import { FORMATS } from '../../agents/ad-studio/formats.js';
import { readBrief } from '../../lib/ad-brief.js';

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

// ── gates ───────────────────────────────────────────────────────────────────────────
//
// The most safety-critical logic in this file: a wrong gates block is how unsourced or
// disallowed ad copy reaches a paid render. buildConcept runs assertNoHealthClaims BEFORE
// assertClaimsSourced, so on a rejection exactly one of the two ever ran.

test('a health-gate rejection marks health failed and leaves claims true (it never ran)', () => {
  const result = {
    ok: false,
    conceptSlug: 'manifesto',
    format: 'manifesto',
    violations: [{ zone: 'copy', text: '', reason: 'disallowed health claim' }],
    error: 'Health claim gate failed — 1 disallowed health claim(s):\n  [headline] "heals eczema" — names a medical condition',
  };
  const gates = gatesFromRejection(result);
  assert.equal(gates.health.ok, false);
  assert.equal(gates.claims.ok, true);
  assert.deepEqual(gates.claims.unsourced, []);
});

test('a sourcing-gate rejection marks claims failed, carries the unsourced entries, and leaves health true', () => {
  const violations = [{ zone: 'headline', text: 'FOUR INGREDIENTS', reason: 'factual claim with no sourceId' }];
  const result = {
    ok: false,
    conceptSlug: 'us-vs-them',
    format: 'us-vs-them',
    violations,
    error: 'Claim gate failed for "us-vs-them": 1 unsourced claim(s).',
  };
  const gates = gatesFromRejection(result);
  assert.equal(gates.health.ok, true);
  assert.equal(gates.claims.ok, false);
  assert.deepEqual(gates.claims.unsourced, violations);
});

test('an unrecognised rejection shape fails safe — never both gates ok:true', () => {
  const result = { ok: false, conceptSlug: 'x', format: 'x', violations: [], error: 'Some unrelated error from a renamed message' };
  const gates = gatesFromRejection(result);
  assert.ok(
    !(gates.health.ok === true && gates.claims.ok === true),
    'an unknown gate outcome must never look like both gates passed'
  );
  // Fails CLOSED, not just "not open": a brief whose gate outcome is unknown must not
  // be mistaken for one that passed either specific check.
  assert.equal(gates.health.ok, false);
  assert.equal(gates.claims.ok, false);
});

// ── cluster guard ───────────────────────────────────────────────────────────────────

test('a product outside the personas cluster aborts, naming the cluster and pointing at voice-of-customer', () => {
  const personasData = { cluster: 'skin', personas: [] };
  const clusterHandles = { skin: ['coconut-lotion', 'coconut-soap'] };
  assert.throws(
    () => assertClusterCoverage('coconut-oil-toothpaste', personasData, clusterHandles),
    (err) => {
      assert.match(err.message, /skin/);
      assert.match(err.message, /coconut-oil-toothpaste/);
      assert.match(err.message, /agents\/voice-of-customer/);
      return true;
    }
  );
});

test('a product inside the personas cluster does not throw', () => {
  const personasData = { cluster: 'skin', personas: [] };
  const clusterHandles = { skin: ['coconut-lotion', 'coconut-soap'] };
  assert.doesNotThrow(() => assertClusterCoverage('coconut-lotion', personasData, clusterHandles));
});

test('an unknown cluster (no handle list at all) aborts too, not just an unlisted handle', () => {
  const personasData = { cluster: 'oral-care', personas: [] };
  assert.throws(() => assertClusterCoverage('coconut-oil-toothpaste', personasData, { skin: ['coconut-lotion'] }), /oral-care/);
});

// ── per-angle persistence survives a later exception ───────────────────────────────
//
// All writes used to happen in one batch after the whole per-angle loop finished, so an
// exception on angle 2 (a transient API error, a malformed copy response — anything
// outside buildConcept's own gate try/catch) discarded angle 1's brief even though it
// had already passed both gates and cost real Anthropic spend. generateBriefs persists
// each brief immediately, inside the loop, so an interruption costs at most the angle in
// flight.

test('a mid-run exception does not discard a brief already written for an earlier angle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ad-brief-test-'));
  try {
    const product = { handle: 'test-product', title: 'Test Product', priceLabel: '$10', variant: null };
    const persona = { id: 'p9', name: 'Test Persona' };
    const angleA = { id: 'p9a1', label: 'Angle A', awareness: 'problem-aware' };
    const angleB = { id: 'p9a2', label: 'Angle B', awareness: 'problem-aware' };
    const selected = [{ persona, angle: angleA }, { persona, angle: angleB }];

    let calls = 0;
    const buildConceptFn = async () => {
      calls += 1;
      if (calls === 1) {
        return { ok: true, conceptSlug: 'manifesto', format: { key: 'manifesto' }, zones: { headline: 'H' }, claims: [] };
      }
      throw new Error('simulated transient failure — not a gate rejection');
    };

    const now = 1786000000000;

    await assert.rejects(
      () => generateBriefs({
        selected, product, pdpBody: '', sourceIndex: {}, reviews: [], seoImpact: null,
        dryRun: false, anthropic: null, root, now, buildConceptFn,
      }),
      /simulated transient failure/
    );

    assert.equal(calls, 2, 'both angles should have been attempted before the throw surfaced');

    const briefIdA = buildBriefId(product.handle, angleA.id, now);
    const savedA = readBrief(root, product.handle, briefIdA);
    assert.ok(savedA, "angle A's brief must be on disk despite angle B throwing afterward");
    assert.equal(savedA.state, 'ready');
    assert.equal(savedA.gates.health.ok, true);
    assert.equal(savedA.gates.claims.ok, true);

    const briefIdB = buildBriefId(product.handle, angleB.id, now);
    const savedB = readBrief(root, product.handle, briefIdB);
    assert.equal(savedB, null, "angle B never completed, so it must not exist on disk");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generateBriefs in --dry-run mode calls buildConceptFn zero times and writes nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ad-brief-test-'));
  try {
    const product = { handle: 'test-product', title: 'Test Product', priceLabel: '$10', variant: null };
    const persona = { id: 'p9', name: 'Test Persona' };
    const angle = { id: 'p9a1', label: 'Angle A', awareness: 'problem-aware' };

    let calls = 0;
    const buildConceptFn = async () => { calls += 1; return { ok: true }; };

    const out = await generateBriefs({
      selected: [{ persona, angle }], product, pdpBody: '', sourceIndex: {}, reviews: [], seoImpact: null,
      dryRun: true, anthropic: null, root, now: 1786000000000, buildConceptFn,
    });

    assert.equal(calls, 0);
    assert.equal(out.length, 1);
    assert.equal(out[0].pending, true);
    assert.equal(readBrief(root, product.handle, out[0].briefId), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
