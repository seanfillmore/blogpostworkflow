import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  listRuns, readRun, classifyOutcome, summariseChecks, readJudgement, writeDecision,
} from '../../agents/dashboard/lib/ad-studio-runs.js';

const base = mkdtempSync(join(tmpdir(), 'ad-studio-ui-'));

function makeRun(runId, { report = null, concepts = {} } = {}) {
  const runDir = join(base, runId);
  mkdirSync(runDir, { recursive: true });
  if (report) writeFileSync(join(runDir, 'run.json'), JSON.stringify(report));
  for (const [slug, cfg] of Object.entries(concepts)) {
    const cDir = join(runDir, slug);
    mkdirSync(join(cDir, 'v1'), { recursive: true });
    if (cfg.copy) writeFileSync(join(cDir, 'copy.json'), JSON.stringify(cfg.copy));
    writeFileSync(join(cDir, 'v1', 'proof.json'), JSON.stringify(cfg.proof || {}));
    for (const f of cfg.files || []) writeFileSync(join(cDir, 'v1', f), 'IMG');
  }
  return runDir;
}

// ── classifyOutcome: an API error is NOT a quality judgement ─────────────────────────
//
// The two call for opposite responses. A 503 shown as "rejected" sends the operator
// hunting a quality problem that is not there — which is exactly what the run totals did
// before they were split (7 of 9 good plates reported as "1 accepted / 2 rejected").
assert.equal(classifyOutcome({ ok: true }).state, 'accepted');
assert.equal(classifyOutcome({ ok: false, reasons: ['volume WRONG'] }).state, 'rejected');
assert.deepEqual(classifyOutcome({ ok: false, reasons: ['volume WRONG'] }).reasons, ['volume WRONG']);
assert.equal(classifyOutcome({ ok: false, error: '503 UNAVAILABLE' }).state, 'errored');
assert.equal(classifyOutcome(null).state, 'missing');
// An errored entry is errored even if `ok` is somehow absent rather than false.
assert.equal(classifyOutcome({ error: 'boom' }).state, 'errored');

// ── summariseChecks: everything that ran, including what passed ──────────────────────
{
  const checks = summariseChecks({
    volume: { ok: true, status: 'match', read: '8 fl. oz • 236ml' },
    fidelity: { ok: true, status: 'match', mismatches: [] },
    inventory: {
      ok: true, status: 'clean', expectedUnits: 1,
      units: [{ object: 'a bottle' }], strays: [], unresolved: [],
    },
  });
  assert.equal(checks.length, 3);
  assert.ok(checks.every(c => c.ok));
  assert.match(checks[0].detail, /236ml/);
  assert.match(checks[2].detail, /1\/1 product unit/);
}

// A check that did not run is omitted, never rendered as a failure.
assert.deepEqual(summariseChecks({ fidelity: { status: 'no-reference' } }), []);
assert.deepEqual(summariseChecks({ inventory: { status: 'not-applicable' } }), []);
assert.deepEqual(summariseChecks({}), []);
assert.deepEqual(summariseChecks(null), []);

// Unresolved objects are shown but labelled as not counted — otherwise a human reads one
// as a defect the gate ignored, when the gate deliberately treats it as background.
{
  const [inv] = summariseChecks({
    inventory: {
      ok: true, status: 'clean', expectedUnits: 1, units: [{ object: 'bottle' }],
      strays: [], unresolved: [{ object: 'a blurred shape at the top edge' }],
    },
  });
  assert.match(inv.detail, /not counted/);
  assert.match(inv.detail, /blurred shape/);
}

// ── listRuns ────────────────────────────────────────────────────────────────────────
makeRun('b-run-2026-08-16T10-00-00-000Z', {
  report: {
    generatedAt: '2026-08-16T10:00:00.000Z',
    product: { handle: 'coconut-lotion', title: 'Lotion' },
    totals: { artifacts: { accepted: 2, rejected: 1, errored: 0, total: 3 } },
    cost: { renders: 4, estimatedUsd: 0.52 },
    results: [{ conceptSlug: 'manifesto' }],
    rejectedConcepts: [],
  },
});
// A crashed run has no run.json. It is LISTED, not hidden — its images exist and are often
// the ones worth looking at, and dropping it silently reads as "nothing happened".
makeRun('a-run-crashed');

{
  const runs = listRuns(base);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].runId, 'b-run-2026-08-16T10-00-00-000Z', 'newest first');
  assert.equal(runs[0].artifacts.accepted, 2);
  assert.equal(runs[1].incomplete, true);
  // null, not 0 — "we do not know" and "none" are different answers on screen.
  assert.equal(runs[1].artifacts, null);
}
assert.deepEqual(listRuns(join(base, 'nope')), []);
assert.deepEqual(listRuns(''), []);

// ── readRun: plate and comp are paired ───────────────────────────────────────────────
//
// Judging plates alone judges the wrong artifact — the operator rebuilds from the comp.
const runId = 'c-run-2026-08-16T12-00-00-000Z';
makeRun(runId, {
  report: {
    generatedAt: '2026-08-16T12:00:00.000Z',
    product: { handle: 'coconut-lotion', title: 'Lotion' },
    totals: { artifacts: { accepted: 1, rejected: 1, errored: 0, total: 2 } },
    results: [{ conceptSlug: 'manifesto' }],
    rejectedConcepts: [{ conceptSlug: 'testimonial', error: 'Health claim gate failed — eczema' }],
  },
  concepts: {
    manifesto: {
      copy: { zones: { headline: 'SIX INGREDIENTS.', rows: ['a', 'b'] }, claims: [] },
      files: ['meta-plate-1x1.jpg', 'meta-comp-1x1.jpg', 'meta-plate-4x5.jpg'],
      proof: {
        'meta-plate-1x1.jpg': { ok: true, attempts: 1, volume: { ok: true, status: 'match', read: '8 fl. oz' } },
        'meta-plate-4x5.jpg': { ok: false, attempts: 3, reasons: ['product volume marking is WRONG'] },
      },
    },
  },
});

{
  const run = readRun(base, runId);
  assert.equal(run.runId, runId);
  assert.equal(run.concepts.length, 1);

  const c = run.concepts[0];
  assert.deepEqual(c.copy, { headline: 'SIX INGREDIENTS.', rows: ['a', 'b'] });

  const targets = c.variations[0].targets;
  assert.equal(targets.length, 2, 'one target per PLATE, comps are not separate tiles');

  const oneToOne = targets.find(t => t.ratio === '1x1');
  assert.equal(oneToOne.plate, 'meta-plate-1x1.jpg');
  assert.equal(oneToOne.comp, 'meta-comp-1x1.jpg', 'the comp is paired to its plate');
  assert.equal(oneToOne.compTrusted, false, 'the comp re-renders the product and drifts it');
  assert.equal(oneToOne.outcome.state, 'accepted');
  assert.equal(oneToOne.key, `manifesto/v1/meta-plate-1x1.jpg`);

  const fourFive = targets.find(t => t.ratio === '4x5');
  assert.equal(fourFive.comp, null, 'a plate with no comp on disk reports null, not a broken path');
  assert.equal(fourFive.outcome.state, 'rejected');
  assert.deepEqual(fourFive.outcome.reasons, ['product volume marking is WRONG']);

  // A gate-rejected concept never rendered and has no directory — without this it would
  // vanish and the operator would see fewer concepts than requested, with no reason.
  assert.equal(run.gateRejected.length, 1);
  assert.equal(run.gateRejected[0].conceptSlug, 'testimonial');
  assert.match(run.gateRejected[0].error, /Health claim gate/);
}

assert.equal(readRun(base, 'does-not-exist'), null);

// ── Decisions live in a SIDECAR, never in proof.json ─────────────────────────────────
//
// proof.json is the gate's record of what it found. An override says "I am shipping this
// anyway" — a different fact — and writing one into the other destroys the only evidence
// of the disagreement.
{
  const runDir = join(base, runId);
  const proofPath = join(runDir, 'manifesto', 'v1', 'proof.json');
  const before = readFileSync(proofPath, 'utf8');

  const key = 'manifesto/v1/meta-plate-4x5.jpg';
  writeDecision(runDir, key, { keep: true, override: true, note: 'ugly but usable' }, '2026-08-16T13:00:00.000Z');

  assert.equal(readFileSync(proofPath, 'utf8'), before, 'proof.json must be untouched');
  assert.ok(existsSync(join(runDir, 'judgement.json')));

  const j = readJudgement(runDir);
  assert.equal(j.decisions[key].keep, true);
  assert.equal(j.decisions[key].override, true);
  assert.equal(j.decisions[key].note, 'ugly but usable');
  assert.equal(j.updatedAt, '2026-08-16T13:00:00.000Z');

  // The decision comes back attached to its frame.
  const run = readRun(base, runId);
  const t = run.concepts[0].variations[0].targets.find(x => x.key === key);
  assert.equal(t.decision.keep, true);
  assert.equal(run.keptCount, 1);

  // Decisions accumulate rather than replacing the file.
  writeDecision(runDir, 'manifesto/v1/meta-plate-1x1.jpg', { keep: true }, '2026-08-16T13:05:00.000Z');
  assert.equal(Object.keys(readJudgement(runDir).decisions).length, 2);
  assert.equal(readRun(base, runId).keptCount, 2);

  // Discarding flips it back without losing the record that a decision was made.
  writeDecision(runDir, key, { keep: false }, '2026-08-16T13:10:00.000Z');
  assert.equal(readJudgement(runDir).decisions[key].keep, false);
  assert.equal(readRun(base, runId).keptCount, 1);

  // A note is bounded — this file is written from an HTTP body.
  writeDecision(runDir, key, { keep: true, note: 'x'.repeat(900) }, '2026-08-16T13:20:00.000Z');
  assert.equal(readJudgement(runDir).decisions[key].note.length, 500);
}

assert.throws(() => writeDecision(join(base, 'nope'), 'a/b/c', { keep: true }), /no such run directory/);

// A run with no judgement file yet is not an error.
assert.deepEqual(readJudgement(join(base, 'a-run-crashed')).decisions, {});

rmSync(base, { recursive: true, force: true });
