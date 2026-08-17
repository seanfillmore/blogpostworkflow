import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseArgs, buildRunReport, finalizeRunReport, SCORES_PATH, ROOT,
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

// ── source guards: the deadline-critical fixes are wired into main(), not just proven ──
//
// C1's whole history is a correctly-implemented thing bound to the wrong field — a
// function existing and being tested elsewhere is not evidence it is CALLED at the right
// place. `assertBriefApproved`, `assertNoHealthClaims` and `briefRenderSucceeded` all have
// full unit coverage already, and all three call sites live inside main(), which is
// unexported, hits the network, and is guarded against running on import — so no call site
// had any test that would notice its own deletion. Same idiom
// tests/agents/ad-studio-orchestrator.test.js already uses for exactly this reason (see its
// sweepDiskBudget/job.start source guards): read the source text, pin presence AND — where
// order matters — ordering.

// THE APPROVAL BOUNDARY, and the last of the three to get a guard (code review 2026-08-17).
// It is the most security-relevant of them: "only an approved brief renders" is the entire
// compliance argument for letting a human steer ad copy, and
// agents/dashboard/routes/ad-brief.js's own /render handler explicitly leans on it —
// "the real, unbypassable enforcement is agents/ad-studio/index.js's own
// assertBriefApproved()". A route that delegates enforcement to a call nothing pins is a
// route relying on a comment.
test('main() calls assertBriefApproved before it resolves the format — the approval boundary is wired in, not just unit-tested', () => {
  const SRC = readFileSync(join(ROOT, 'agents', 'ad-studio', 'index.js'), 'utf8');

  const approvedIdx = SRC.indexOf('assertBriefApproved(brief, args.brief);');
  const chosenFormatIdx = SRC.indexOf('const chosenFormat = selectFormats([attribution.format])[0];');

  assert.ok(
    approvedIdx > -1,
    'main() must call assertBriefApproved(brief, args.brief) — without it, --brief renders any ' +
    'brief on disk regardless of state, and routes/ad-brief.js delegates the real enforcement ' +
    'to exactly this call',
  );
  assert.ok(chosenFormatIdx > -1, 'sanity: the brief-mode format resolution must still exist');
  assert.ok(
    approvedIdx < chosenFormatIdx,
    'assertBriefApproved must run BEFORE the format is resolved — it is the first thing that ' +
    'happens to a brief, ahead of the format resolution the health-gate guard below anchors on, ' +
    'so an unapproved brief is refused before any of its fields are acted on',
  );
});
test('main() re-derives the health gate on the copy actually about to render, before anything paid happens', () => {
  const SRC = readFileSync(join(ROOT, 'agents', 'ad-studio', 'index.js'), 'utf8');

  const chosenFormatIdx = SRC.indexOf('const chosenFormat = selectFormats([attribution.format])[0];');
  const healthGateIdx = SRC.indexOf('assertNoHealthClaims(brief.zones);');
  const conceptsAssignIdx = SRC.indexOf('concepts = [{ format: chosenFormat, zones: brief.zones, claims: brief.claims || [] }];');

  assert.ok(chosenFormatIdx > -1, 'sanity: the brief-mode format resolution must still exist');
  assert.ok(conceptsAssignIdx > -1, 'sanity: the brief-mode concept assignment must still exist');
  assert.ok(
    healthGateIdx > -1,
    'main() must call assertNoHealthClaims(brief.zones) — nothing binds a brief\'s stored ' +
    'gates.health.ok to its zones, so this is the only thing that actually re-proves the ' +
    'gate against the copy about to render',
  );
  assert.ok(
    chosenFormatIdx < healthGateIdx && healthGateIdx < conceptsAssignIdx,
    'assertNoHealthClaims must run AFTER the format is resolved but BEFORE the concept is ' +
    'built — i.e. before the render loop can spend anything on copy that was never re-checked',
  );
});

test('main() only marks a brief "rendered" when briefRenderSucceeded(report) is true', () => {
  const SRC = readFileSync(join(ROOT, 'agents', 'ad-studio', 'index.js'), 'utf8');

  const guardIdx = SRC.indexOf('if (brief && briefRenderSucceeded(report)) {');
  assert.ok(
    guardIdx > -1,
    'the rendered transition must be gated on briefRenderSucceeded(report) — without it, a ' +
    'run that lost every render attempt (a Gemini outage, a --max-renders stop) still marks ' +
    'the brief "rendered", and assertBriefApproved then refuses it by name forever',
  );

  // The guarded branch must be the one that actually performs the transition, not a
  // decoy — decideBrief(..., { state: 'rendered' }) must appear inside this if-block,
  // before the next top-level `} else if (brief) {`.
  const elseIdx = SRC.indexOf('} else if (brief) {', guardIdx);
  assert.ok(elseIdx > guardIdx, 'sanity: the "nothing accepted" branch must still exist');
  const guardedBlock = SRC.slice(guardIdx, elseIdx);
  assert.match(
    guardedBlock, /decideBrief\(ROOT, handle, brief\.briefId, \{ state: 'rendered'/,
    'the guarded branch must be the one that calls decideBrief with state: \'rendered\'',
  );
});

// The advisory from review: renders that happened before a run came up empty were still
// paid for. Record the run id even though the brief stays 'approved' and retryable, so an
// operator retrying later sees the prior spend instead of a clean record with no trace of
// it.
test('a run that produced nothing still leaves a trace of the spend, without changing state', () => {
  const SRC = readFileSync(join(ROOT, 'agents', 'ad-studio', 'index.js'), 'utf8');
  const elseIdx = SRC.indexOf('} else if (brief) {');
  assert.ok(elseIdx > -1, 'sanity: the "nothing accepted" branch must still exist');
  const nextBraceIdx = SRC.indexOf('\n  }', elseIdx);
  const elseBlock = SRC.slice(elseIdx, nextBraceIdx);
  assert.match(
    elseBlock, /failedRunIds:\s*\[\s*\.\.\.\(current\.failedRunIds \|\| \[\]\),\s*runId\s*\]/,
    'a run with nothing accepted must still append the run id to failedRunIds — the spend ' +
    'happened even though nothing was accepted',
  );
  assert.doesNotMatch(
    elseBlock, /state:\s*'rendered'/,
    'recording the failed spend must not change state — the brief stays approved and retryable',
  );
});

// Review finding: the failedRunIds write above had no try/catch — writeBrief throws on
// any fs error (ENOSPC is the realistic trigger; this project has already lost four days
// of cron to a full disk), and an uncaught throw here would divert the run into the
// top-level catch INSTEAD of finishing normally, skipping flushArchive() and — the actual
// incident — skipping sweepDiskBudget() at exactly the moment disk pressure is the
// plausible cause. A bookkeeping write must not be able to suppress the disk sweep.
//
// This is asserted as a source guard rather than by actually injecting a throwing
// writeBrief. writeBrief is a plain named import (`import { ..., writeBrief, ... } from
// '../../lib/ad-brief.js'`), not an injectable parameter, and main() is unexported, hits
// the network, and is guarded against running on import — so there is no path to this
// branch that does not go through a real run. Node's test-runner module mocking
// (`node:test`'s `mock.module`) could reach it, but it requires
// `--experimental-test-module-mocks`, a flag nothing else in this repo's test suite uses
// (`npm test` runs plain `node --test`) — adding it here would mean this one test needs a
// different invocation than every other test in the file to even run, which is worse than
// the source guard it would replace. The source guard is the honest option: it fails if
// the try/catch is removed, moved to not cover the writeBrief call, or replaced with a
// catch that re-throws.
test('the failedRunIds write is wrapped so it cannot throw out of main() and skip the disk sweep', () => {
  const SRC = readFileSync(join(ROOT, 'agents', 'ad-studio', 'index.js'), 'utf8');
  const elseIdx = SRC.indexOf('} else if (brief) {');
  assert.ok(elseIdx > -1, 'sanity: the "nothing accepted" branch must still exist');

  const tryIdx = SRC.indexOf('try {', elseIdx);
  const writeBriefIdx = SRC.indexOf('writeBrief(ROOT, { ...current, failedRunIds:', elseIdx);
  assert.ok(tryIdx > -1, 'the failedRunIds write must be inside a try block');
  assert.ok(writeBriefIdx > -1, 'sanity: the failedRunIds write must still exist');
  assert.ok(tryIdx < writeBriefIdx, 'the try must open BEFORE the writeBrief call it is meant to guard');

  const catchMatch = SRC.slice(writeBriefIdx).match(/\} catch \(err\) \{[\s\S]*?\n    \}/);
  assert.ok(
    catchMatch,
    'the try around the failedRunIds write must be followed by a catch — an fs error must ' +
    'not propagate out of this branch',
  );
  const catchBody = catchMatch[0];
  assert.doesNotMatch(
    catchBody, /\bthrow\b/,
    'the catch must not re-throw — a bookkeeping failure must fall through to ' +
    'flushArchive()/sweepDiskBudget() below, not into the top-level catch that skips them',
  );
  assert.match(catchBody, /console\.warn\(/, 'the catch must at least log, so the failure is not silent');

  // Confirm the disk sweep is still reachable after this whole branch, i.e. nothing
  // between here and sweepDiskBudget() depends on this write having succeeded.
  assert.match(SRC.slice(elseIdx), /sweepDiskBudget\(\);/, 'sanity: normal completion must still reach the disk sweep');
});

// Ledger #6: the job event must not claim a copy call happened in the one mode whose whole
// promise is that none did. Brief mode reuses the approved strings and makes zero Anthropic
// copy calls, but the per-concept progress event was reported as `stage: 'copy'` either way —
// so the Briefs panel told the operator "copy — ok" for work that never occurred. A source
// guard, for the same reason as the three above: the emit sits inside main().
test('main() reports the copy stage as "approved-copy" in brief mode — no copy call happened', () => {
  const SRC = readFileSync(join(ROOT, 'agents', 'ad-studio', 'index.js'), 'utf8');

  assert.match(
    SRC, /const copyStage = brief \? 'approved-copy' : 'copy';/,
    'brief mode must relabel the copy stage — reporting "copy" claims a paid copy call that ' +
    'brief mode never makes',
  );
  assert.match(
    SRC, /job\.event\(\{ stage: copyStage, concept: c\.format\.key, state: 'ok' \}\)/,
    'and the emit must actually use the relabelled stage, not a leftover literal',
  );
  // 'ok' is load-bearing: the Briefs view colours anything other than 'ok'/'accepted' as a
  // failure, so relabelling the STATE instead would have painted a healthy run red.
  assert.doesNotMatch(
    SRC, /stage: copyStage, concept: c\.format\.key, state: '(?!ok')/,
    'the state must stay "ok" — the view treats any other value as a failure',
  );
});
