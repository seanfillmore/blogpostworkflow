import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseArgs, buildRunReport, finalizeRunReport, SCORES_PATH,
  findBriefProduct, assertBriefApproved, resolveBriefFormatKey, buildBriefAttribution,
  briefRenderSucceeded,
} from '../../agents/ad-studio/index.js';
import { writeBrief, readBrief, decideBrief } from '../../lib/ad-brief.js';
import { generateBriefs, buildBriefId } from '../../agents/ad-brief/index.js';

const freshRoot = () => mkdtempSync(join(tmpdir(), 'ad-studio-brief-'));

test('--brief is parsed and is absent by default', () => {
  assert.equal(parseArgs(['--product', 'coconut-lotion', '--formats', 'manifesto']).brief, null);
  assert.equal(parseArgs(['--brief', 'coconut-lotion-p1a1-123']).brief, 'coconut-lotion-p1a1-123');
});

// In brief mode the brief supplies the product AND the format, so demanding them again
// would make the operator restate what they already approved — and let the two disagree.
test('--brief mode does not require --product or --formats', () => {
  assert.doesNotThrow(() => parseArgs(['--brief', 'coconut-lotion-p1a1-123']));
});

test('a brief id with a path separator is refused at parse time', () => {
  assert.throws(() => parseArgs(['--brief', '../escape']), /brief/i);
});

// ── the approval boundary ────────────────────────────────────────────────────────────
//
// THE security boundary of the feature. These helpers are extracted out of main() (which
// is unexported, hits the network, and is guarded against running on import) specifically
// so this boundary has direct test coverage rather than none.

test('findBriefProduct resolves by scanning content, never by parsing the id prefix', () => {
  const root = freshRoot();
  try {
    // Deliberately mismatched: the id itself NAMES "coconut-lotion", but the record is
    // written under a completely different product directory. If findBriefProduct ever
    // trusted the id's own prefix instead of scanning every product's directory, this
    // would resolve to the wrong (or a nonexistent) path.
    writeBrief(root, {
      briefId: 'coconut-lotion-p1a1-999', product: 'unrelated-product', state: 'ready',
      zones: null, claims: null,
    });
    assert.equal(findBriefProduct(root, 'coconut-lotion-p1a1-999'), 'unrelated-product');
    assert.equal(findBriefProduct(root, 'no-such-id-anywhere'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('assertBriefApproved refuses every non-approved state, naming it, and allows only "approved"', () => {
  for (const state of ['ready', 'needs-evidence', 'rejected', 'rendered']) {
    assert.throws(
      () => assertBriefApproved({ state }, 'brief-x'),
      new RegExp(`brief-x[\\s\\S]*${state}`),
      `state "${state}" must be refused by name`,
    );
  }
  assert.doesNotThrow(() => assertBriefApproved({ state: 'approved' }, 'brief-x'));
});

test('resolveBriefFormatKey prefers an operator-chosen format over the proposed one', () => {
  assert.equal(resolveBriefFormatKey({ format: { proposed: 'manifesto', chosen: 'us-vs-them' } }, 'x'), 'us-vs-them');
  assert.equal(resolveBriefFormatKey({ format: { proposed: 'manifesto', chosen: null } }, 'x'), 'manifesto');
  assert.equal(resolveBriefFormatKey({ format: { proposed: 'manifesto' } }, 'x'), 'manifesto', 'chosen may be absent entirely');
});

test('resolveBriefFormatKey refuses a brief with no format, naming the awareness level', () => {
  assert.throws(
    () => resolveBriefFormatKey({ format: { proposed: null, chosen: null }, angle: { awareness: 'unaware' } }, 'brief-y'),
    /brief-y[\s\S]*unaware/,
  );
});

test('briefRenderSucceeded is true only when an artifact was actually accepted', () => {
  assert.equal(briefRenderSucceeded({ totals: { artifacts: { accepted: 3 } } }), true);
  assert.equal(briefRenderSucceeded({ totals: { artifacts: { accepted: 0 } } }), false);
  assert.equal(briefRenderSucceeded({ totals: {} }), false, 'missing artifacts totals must not read as success');
  assert.equal(briefRenderSucceeded(null), false);
});

// ── attribution mapping ──────────────────────────────────────────────────────────────
//
// C1 (Critical, review): agents/ad-brief/index.js writes personaId/angleId at the TOP
// LEVEL of the record, never under a nested persona/angle id — brief.persona?.id ??
// null read as null on every real brief, the exact half-filled stub this task exists to
// prevent. Fixed by preferring the top-level field. These two tests pin both directions:
// the real shape works, and the (never-written, but harmless-to-support) nested shape
// still falls back correctly rather than silently breaking a caller who reads it.

test('buildBriefAttribution reads the top-level personaId/angleId the generator actually writes', () => {
  const attribution = buildBriefAttribution({
    briefId: 'x', personaId: 'p1', angleId: 'p1a1', angle: { awareness: 'problem-aware' },
  }, 'manifesto');
  assert.equal(attribution.personaId, 'p1');
  assert.equal(attribution.angleId, 'p1a1');
  assert.equal(attribution.awareness, 'problem-aware');
  assert.equal(attribution.format, 'manifesto');
});

test('buildBriefAttribution falls back to a nested persona/angle id shape if present', () => {
  const attribution = buildBriefAttribution({
    briefId: 'x', persona: { id: 'pX' }, angle: { id: 'aX', awareness: 'solution-aware' },
  }, 'us-vs-them');
  assert.equal(attribution.personaId, 'pX');
  assert.equal(attribution.angleId, 'aX');
});

// THE regression test for C1: a record produced by the generator's OWN writer
// (agents/ad-brief/index.js's generateBriefs), not a hand-built fixture — a hand-written
// fixture is exactly what let this bug ship undetected the first time. No Anthropic call:
// buildConceptFn is stubbed, same pattern tests/agents/ad-brief.test.js already uses.
test('buildBriefAttribution: every field is non-null against a REAL generator-shaped, approved brief', async () => {
  const root = freshRoot();
  try {
    const product = { handle: 'test-product', title: 'Test Product', priceLabel: '$10', variant: null };
    const persona = { id: 'p9', name: 'Test Persona' };
    const angle = { id: 'p9a1', label: 'Real angle', awareness: 'problem-aware' };
    const now = 1786000000000;
    const buildConceptFn = async () => ({
      ok: true, conceptSlug: 'manifesto', format: { key: 'manifesto' },
      zones: { headline: 'A real, gate-passed headline' }, claims: [],
    });

    const [written] = await generateBriefs({
      selected: [{ persona, angle }], product, pdpBody: '', sourceIndex: {}, reviews: [],
      seoImpact: null, dryRun: false, anthropic: null, root, now, buildConceptFn,
    });

    // Sanity on the fixture itself: confirm it really is the generator's real shape,
    // not something this test quietly hand-built to look like one.
    assert.ok(written.personaId, 'sanity: the generator writes a top-level personaId');
    assert.equal(written.persona, undefined, 'sanity: the generator does NOT write a nested persona object');

    const briefId = buildBriefId(product.handle, angle.id, now);
    decideBrief(root, product.handle, briefId, { state: 'approved' });
    const approved = readBrief(root, product.handle, briefId);
    assert.equal(approved.state, 'approved');

    const formatKey = resolveBriefFormatKey(approved, briefId);
    const attribution = buildBriefAttribution(approved, formatKey);

    for (const [key, value] of Object.entries(attribution)) {
      assert.ok(value !== null && value !== undefined, `attribution.${key} must not be null/undefined (got ${value})`);
    }
    assert.equal(attribution.personaId, 'p9');
    assert.equal(attribution.angleId, 'p9a1');
    assert.equal(attribution.awareness, 'problem-aware');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── attribution propagation into run.json / scores.jsonl ────────────────────────────
//
// THE POINT OF THIS TASK. These fields cannot be reconstructed after an ad has run.

test('buildRunReport carries attribution onto every artifact row', () => {
  const attribution = {
    briefId: 'coconut-lotion-p1a1-123', personaId: 'p1', angleId: 'p1a1',
    awareness: 'problem-aware', format: 'problem-aware',
  };
  const report = buildRunReport({
    runId: 'r1',
    product: { handle: 'coconut-lotion', title: 'Lotion' },
    attribution,
    results: [{
      conceptSlug: 'problem-aware', format: 'problem-aware',
      variations: [{ n: 1, ok: true, artifacts: [{ artifact: 'meta-plate-1x1.png', ok: true, errored: false, score: 4 }] }],
    }],
    renders: 2,
  });
  assert.deepEqual(report.attribution, attribution);
  const row = report.results[0].variations[0].artifacts[0];
  assert.equal(row.attribution.angleId, 'p1a1', 'each artifact must carry its own attribution');
  assert.equal(row.attribution.awareness, 'problem-aware');
});

// A run launched the old way must still work and must say so, rather than carrying a
// half-filled attribution that looks like data.
test('a run with no brief reports attribution as null, not a stub', () => {
  const report = buildRunReport({
    runId: 'r1', product: { handle: 'coconut-lotion' },
    results: [{ conceptSlug: 'manifesto', format: 'manifesto', variations: [{ n: 1, ok: true, artifacts: [] }] }],
    renders: 0,
  });
  assert.equal(report.attribution, null);
});

// I3 (review): finalizeRunReport IS exported and takes a `root` param, so proving
// attribution reaches scores.jsonl — half the deadline-critical output — is cheap and
// was missing. `root` is sandboxed to a temp dir so this never touches the real repo's
// data/reports/ad-studio/scores.jsonl.
test('finalizeRunReport writes attribution onto every scores.jsonl line', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ad-studio-brief-scores-'));
  try {
    const attribution = {
      briefId: 'coconut-lotion-p1a1-123', personaId: 'p1', angleId: 'p1a1',
      awareness: 'problem-aware', format: 'problem-aware',
    };
    const report = finalizeRunReport({
      runDir: tmpDir,
      runId: 'run-brief-1',
      product: { handle: 'coconut-lotion', title: 'Lotion' },
      results: [{
        conceptSlug: 'problem-aware', format: 'problem-aware',
        variations: [{ n: 1, ok: true, artifacts: [{ artifact: 'meta-plate-1x1.png', ok: true, score: 4 }] }],
      }],
      renders: 2,
      budget: null,
      concepts: [{ format: { key: 'problem-aware' } }],
      rejectedConcepts: [],
      attribution,
      root: tmpDir,
    });
    assert.deepEqual(report.attribution, attribution);

    const lines = readFileSync(join(tmpDir, SCORES_PATH), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0].attribution, attribution);
    assert.equal(lines[0].runId, 'run-brief-1');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('an approved brief round-trips through the store for rendering', () => {
  const root = freshRoot();
  try {
    // The real shape agents/ad-brief/index.js writes: personaId/angleId at the top
    // level, plus the full angle object (which itself carries awareness). No `persona`
    // sub-object — see the C1 regression tests above for why that distinction matters.
    writeBrief(root, {
      briefId: 'coconut-lotion-p1a1-123', product: 'coconut-lotion', state: 'approved',
      zones: { headline: 'A real headline' }, claims: [],
      format: { proposed: 'problem-aware', alternatives: [] },
      personaId: 'p1', personaName: 'Test Persona',
      angleId: 'p1a1', angle: { id: 'p1a1', awareness: 'problem-aware' },
      gates: { health: { ok: true }, claims: { ok: true } },
    });
    const b = readBrief(root, 'coconut-lotion', 'coconut-lotion-p1a1-123');
    assert.equal(b.state, 'approved');
    assert.equal(b.zones.headline, 'A real headline');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
