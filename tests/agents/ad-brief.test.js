import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AWARENESS_TO_FORMAT_AWARENESS, formatsForAngle, personaProjection, angleRelevance,
  buildBriefId, parseArgs, gatesFromRejection, assertClusterCoverage, generateBriefs, PRIZE_FRAMINGS,
} from '../../agents/ad-brief/index.js';
import { FORMATS } from '../../agents/ad-studio/formats.js';
import { readBrief } from '../../lib/ad-brief.js';
import { createJobReporter } from '../../agents/ad-studio/index.js';
import { writeJob, readJob } from '../../lib/ad-studio-job.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

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

// THE GAP IS CLOSED (2026-08-18). This test used to pin `unaware` and `most-aware` to NO
// format, and its own comment said that when a format was finally built for either level
// this test is what would tell you. It did. `fact-hook` and `spec-panel` now cover them, so
// the assertion is inverted rather than deleted: every Schwartz level must resolve to a
// format, because a level silently falling back to null is how the highest-scoring angle we
// hold went unrenderable for a month without anything failing.
test('every awareness level resolves to a format — no level is unrenderable', () => {
  for (const level of Object.keys(AWARENESS_TO_FORMAT_AWARENESS)) {
    const { proposed } = formatsForAngle({ awareness: level }, FORMATS);
    assert.ok(proposed, `"${level}" must resolve to a format`);
    assert.equal(
      FORMATS.find(f => f.key === proposed).awareness,
      AWARENESS_TO_FORMAT_AWARENESS[level],
      `"${level}" must propose a format tagged for its own awareness level, never a near neighbour`,
    );
  }
});

// The two new levels each have exactly ONE format, so `proposed` is forced and there is no
// alternative to offer. Pinned because the moment a second format joins either level, the
// zone-shape rule in lib/ad-brief.js decides whether it is switchable — and that is a
// decision someone has to make deliberately rather than discover from a dropdown.
test('unaware and most-aware each resolve to their single dedicated format', () => {
  assert.deepEqual(formatsForAngle({ awareness: 'unaware' }, FORMATS), {
    proposed: 'fact-hook', alternatives: [],
  });
  assert.deepEqual(formatsForAngle({ awareness: 'most-aware' }, FORMATS), {
    proposed: 'spec-panel', alternatives: [],
  });
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

// THE LIVE BUG (code review, 2026-08-17). angleRelevance used to pool label + proof +
// objection_addressed into one set and match on ANY of them, so "The winter survival
// cream" (label: cream) got briefed against coconut-soap because its `proof` field
// happens to mention "hand soap users" as one more data point about who likes it. The
// label is the angle's SUBJECT; proof and objection are supporting prose that can name a
// different product in passing without being about it — when the label names a product
// category, that category decides alone, and nothing in proof can add to or override it.
test('a label naming one product category decides relevance even when proof mentions a different one (the live p5a2 bug)', () => {
  const angle = {
    label: 'The winter survival cream',
    proof: 'A Wisconsin family uses it as their whole-household winter moisturizer, calling it ' +
      'long-lasting and non-greasy; hand soap users say it keeps winter hands from getting irritated.',
  };
  assert.equal(
    angleRelevance(angle, { handle: 'coconut-soap', title: 'Moisturizing Coconut Soap' }),
    false,
    'proof mentioning soap in passing must not override what the label is about'
  );
  assert.equal(
    angleRelevance(angle, { handle: 'coconut-lotion', title: 'Non-Toxic Body Lotion' }),
    true,
    '"cream" and "lotion" are the same product category'
  );
});

// The label is silent here ("After prescriptions failed" names no product), so the fix
// falls back to proof + objection_addressed — but only a category named in BOTH counts as
// decisive. Reproduces the real p1a1 angle: objection_addressed only reaches "lotion"
// inside a skeptical customer's rhetorical aside ("...so why would a coconut lotion?"),
// with nothing in proof to corroborate it. A category named in only one of the two
// supporting fields is exactly the "mentioned in passing" case this fix exists to stop
// trusting, so this must stay relevant to every product, not narrow to lotion.
test('a category named in only one of proof/objection_addressed does not decide — only agreement between both does', () => {
  const angle = {
    label: 'After prescriptions failed',
    proof: 'Verified reviewer with severe eczema reports going from hourly reapplication to twice a day.',
    objection_addressed: "'I've already tried everything, so why would a coconut lotion?'",
  };
  assert.equal(angleRelevance(angle, { handle: 'coconut-lotion', title: 'Coconut Lotion' }), true);
  assert.equal(angleRelevance(angle, { handle: 'coconut-soap', title: 'Coconut Bar Soap' }), true);
});

// The corroboration case actually firing: both supporting fields independently name the
// same category, with the label silent.
test('a category named in BOTH proof and objection_addressed decides, when the label is silent', () => {
  const angle = {
    label: 'Absorbs before you get dressed',
    proof: 'Buyers who hate slow-absorbing, sticky lotion report quick absorption with no oily look.',
    objection_addressed: "'I hate waiting for lotion to sink in.'",
  };
  assert.equal(angleRelevance(angle, { handle: 'coconut-lotion', title: 'Coconut Lotion' }), true);
  assert.equal(angleRelevance(angle, { handle: 'coconut-soap', title: 'Coconut Bar Soap' }), false);
});

// "bar" and "wash" are how a soap gets talked about without ever saying "soap" — the real
// catalog title is "Moisturizing Coconut Soap", which never contains the literal word
// "bar". Without category grouping, a label-decisive "bar" would fail to match the very
// product it is obviously about.
test('"bar" and "soap" are the same product category', () => {
  const angle = { label: 'The bar you put out for guests' };
  assert.equal(angleRelevance(angle, { handle: 'coconut-soap', title: 'Moisturizing Coconut Soap' }), true);
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

// --prize-framing decides which components of a multi-component prize an ad leads with.
// Null by default: absent, the copy prompt is byte-identical to what it was before the
// option existed, and the writer picks its own emphasis.
test('--prize-framing defaults to null and accepts only known values', () => {
  assert.equal(parseArgs(['--product', 'coconut-soap']).prizeFraming, null);
  for (const v of PRIZE_FRAMINGS) {
    assert.equal(parseArgs(['--product', 'coconut-soap', '--prize-framing', v]).prizeFraming, v);
  }
});

// Rejected BY NAME rather than ignored. A typo'd framing that silently fell back to
// "writer chooses" would produce a run indistinguishable from the one asked for — and the
// entire point of the option is running two framings against each other, so a run that
// quietly is not the framing you named corrupts the comparison it exists to serve.
test('an unknown --prize-framing throws and names the valid values', () => {
  assert.throws(
    () => parseArgs(['--product', 'coconut-soap', '--prize-framing', 'both']),
    /unknown --prize-framing "both" — one of: soap, full/,
  );
});

// The flag-shaped-value rule applies here like every other value flag: `--prize-framing
// --dry-run` shifts the whole argument list by one, which is how a job file called
// `--job-id.json` got claimed while the real job sat pending.
test('--prize-framing refuses a flag-shaped value', () => {
  assert.throws(
    () => parseArgs(['--product', 'coconut-soap', '--prize-framing', '--dry-run']),
    /that is a flag, not a value/,
  );
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

// ── variant threading (fix/ad-brief-variant-copy) ───────────────────────────────────
//
// generateBriefs must pass the product's variant through to buildConceptFn so the copy
// prompt can be scoped to the exact bottle being briefed, not the whole product line.

test('generateBriefs passes product.variant through to buildConceptFn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ad-brief-test-'));
  try {
    const product = { handle: 'coconut-soap', title: 'Coconut Bar Soap', priceLabel: '$12', variant: 'pure-unscented' };
    const persona = { id: 'p9', name: 'Test Persona' };
    const angle = { id: 'p9a1', label: 'Angle A', awareness: 'problem-aware' };

    let seenVariant;
    const buildConceptFn = async ({ variant }) => {
      seenVariant = variant;
      return { ok: true, conceptSlug: 'manifesto', format: { key: 'manifesto' }, zones: { headline: 'H' }, claims: [] };
    };

    await generateBriefs({
      selected: [{ persona, angle }], product, pdpBody: '', sourceIndex: {}, reviews: [], seoImpact: null,
      dryRun: false, anthropic: null, root, now: 1786000000000, buildConceptFn,
    });

    assert.equal(seenVariant, 'pure-unscented');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generateBriefs passes variant: null through when the product has none', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ad-brief-test-'));
  try {
    const product = { handle: 'coconut-lotion', title: 'Coconut Lotion', priceLabel: '$30', variant: null };
    const persona = { id: 'p9', name: 'Test Persona' };
    const angle = { id: 'p9a1', label: 'Angle A', awareness: 'problem-aware' };

    let seenVariant = 'not-set';
    const buildConceptFn = async ({ variant }) => {
      seenVariant = variant;
      return { ok: true, conceptSlug: 'manifesto', format: { key: 'manifesto' }, zones: { headline: 'H' }, claims: [] };
    };

    await generateBriefs({
      selected: [{ persona, angle }], product, pdpBody: '', sourceIndex: {}, reviews: [], seoImpact: null,
      dryRun: false, anthropic: null, root, now: 1786000000000, buildConceptFn,
    });

    assert.equal(seenVariant, null);
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

// ── --job-id (code review, 2026-08-17) ──────────────────────────────────────────────
//
// Before this, the dashboard route (routes/ad-brief.js) had to write the job's pid and
// terminal status ITSELF, from 'exit'/'error' listeners on the in-memory ChildProcess,
// because this agent had no way to claim the job file the way agents/ad-studio/index.js
// does. That broke under a `pm2 restart` (every deploy runs one): the detached, unref()'d
// child keeps running, but the route's listeners die with the route's own process, so
// nobody was left to write the terminal status and a job that finished correctly sat at
// 'running' forever. Adding --job-id here, wired through createJobReporter — the SAME
// reporter agents/ad-studio/index.js uses, imported rather than reimplemented — lets this
// agent claim and finish its own job file, restoring the one-writer contract
// lib/ad-studio-job.js's header describes.

test('--job-id is parsed, validated the same way as Ad Studio\'s, and defaults to null', () => {
  assert.equal(parseArgs(['--product', 'coconut-lotion']).jobId, null);
  assert.equal(parseArgs(['--product', 'coconut-lotion', '--job-id', 'ad-brief-coconut-lotion-123']).jobId, 'ad-brief-coconut-lotion-123');
  assert.throws(
    () => parseArgs(['--product', 'coconut-lotion', '--job-id', '../../etc/passwd']),
    /invalid --job-id/,
  );
});

// A VALUE THAT STARTS WITH A DASH IS A MISSING VALUE (code review 2026-08-17). This is the
// argv half of the fix whose route half is lib/ad-brief.js's checkSegment. The concrete
// failure: `--angles --job-id` shifted the argument list by one, so `get('--job-id')` returned
// the literal string `--job-id`, which passed isValidJobId (a dash is an ordinary filename
// character) and made the agent claim a job file named `--job-id.json` while the dashboard's
// real job stayed 'pending' — after the 60s pending grace a second click launched a second
// PAID Anthropic batch.
test('a flag-shaped value is refused rather than read as a value', () => {
  // The exact shape the route used to emit for {angles: ["--job-id"]}.
  assert.throws(
    () => parseArgs(['--product', 'coconut-lotion', '--angles', '--job-id', '--job-id', 'ad-brief-real-1']),
    /is a flag, not a value/,
  );
  assert.throws(() => parseArgs(['--product', '--dry-run']), /is a flag, not a value/);
  assert.throws(() => parseArgs(['--product', 'coconut-lotion', '--variant', '--job-id']), /is a flag, not a value/);
  assert.throws(() => parseArgs(['--product', 'coconut-lotion', '--angles', 'p1a1,-x']), /is a flag, not a value/);
  assert.throws(() => parseArgs(['--product', 'coconut-lotion', '--job-id', '-x']), /is a flag, not a value/);
  // Dashes anywhere but the front are untouched — every real handle and job id is full of them.
  assert.equal(parseArgs(['--product', 'coconut-lotion', '--job-id', 'ad-brief-coconut-lotion-1']).jobId,
    'ad-brief-coconut-lotion-1');
  assert.deepEqual(parseArgs(['--product', 'coconut-lotion', '--angles', 'p1a1,p5a3']).angles, ['p1a1', 'p5a3']);
});

test('with no --job-id, createJobReporter is a no-op and nothing is written to the job store', () => {
  const root = mkdtempSync(join(tmpdir(), 'ad-brief-job-'));
  try {
    const args = parseArgs(['--product', 'coconut-lotion']);
    assert.equal(args.jobId, null);

    // Every method exercised, exactly as main() would call them across a run's lifecycle.
    const job = createJobReporter({ root, jobId: args.jobId });
    job.start({ pid: 12345 });
    job.event({ stage: 'brief', angleId: 'p1a1' });
    job.finish({ totals: { briefs: 1 } });
    job.fail(new Error('simulated'));

    // jobsDir() is `<root>/data/reports/ad-studio/jobs` — it must not even exist, because
    // a no-op reporter must never create the directory, let alone a file in it.
    assert.equal(existsSync(join(root, 'data', 'reports', 'ad-studio', 'jobs')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('with --job-id, job.start() claims the file (status running, pid) and generateBriefs reports per-angle progress', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ad-brief-job-'));
  try {
    const args = parseArgs(['--product', 'coconut-lotion', '--job-id', 'test-job-1']);

    // What the ROUTE writes, once, before spawning — updateJob (which job.start() calls
    // under the hood) requires an existing job file to patch, same as every other job in
    // this project's history (see lib/ad-studio-job.js's PATCH SEMANTICS doc).
    writeJob(root, { jobId: 'test-job-1', status: 'pending', createdAt: new Date().toISOString(), pid: null });

    const job = createJobReporter({ root, jobId: args.jobId });

    // What main() does immediately after parseArgs, before .env, before a single network
    // call — see the source-inspection regression guard below for the ordering proof.
    job.start({ pid: process.pid });

    const claimed = readJob(root, 'test-job-1');
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.pid, process.pid);

    const product = { handle: 'test-product', title: 'Test Product', priceLabel: '$10', variant: null };
    const persona = { id: 'p9', name: 'Test Persona' };
    const angle = { id: 'p9a1', label: 'Angle A', awareness: 'problem-aware' };
    const buildConceptFn = async () => (
      { ok: true, conceptSlug: 'manifesto', format: { key: 'manifesto' }, zones: { headline: 'H' }, claims: [] }
    );

    await generateBriefs({
      selected: [{ persona, angle }], product, pdpBody: '', sourceIndex: {}, reviews: [], seoImpact: null,
      dryRun: false, anthropic: null, root, now: 1786000000000, buildConceptFn, job,
    });

    const after = readJob(root, 'test-job-1');
    assert.equal(after.events.length, 1, 'one angle processed, one progress event');
    assert.equal(after.events[0].stage, 'brief');
    assert.equal(after.events[0].angleId, 'p9a1');
    assert.equal(after.events[0].state, 'ready');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Regression guard: main() must claim the job file before it does anything else ───
//
// Mirrors tests/agents/ad-studio-orchestrator.test.js's identical guard for
// agents/ad-studio/index.js almost verbatim — see that file's comment for the full
// history (a reviewer once deleted the equivalent line there and 75/75 tests still
// passed). main() here is not exported, loads real personas/manifest/catalog data by a
// hardcoded ROOT, and reaches the live network via fetchPdpBody — so, like that guard,
// this reads the source rather than calling main().
{
  const SRC = readFileSync(join(REPO_ROOT, 'agents', 'ad-brief', 'index.js'), 'utf8');

  const mainStart = SRC.indexOf('async function main() {');
  const guardStart = SRC.indexOf('if (process.argv[1] === fileURLToPath(import.meta.url)) {');
  assert.ok(mainStart > -1, 'sanity: main() must still exist');
  assert.ok(guardStart > mainStart, 'sanity: the import guard must still exist, after main()');
  const mainBody = SRC.slice(mainStart, guardStart);

  // The boot claim is the unqualified call — `{ pid: process.pid }`. Matches ad-studio's
  // own guard test's anchor string exactly.
  const bootClaimIndex = mainBody.indexOf('job.start({ pid: process.pid });');
  assert.ok(
    bootClaimIndex > -1,
    'main() must claim the job file with job.start({ pid: process.pid }) before anything else',
  );

  // Anchor: fetchPdpBody() is the first thing in main() that reaches the network. Everything
  // between the claim and here (loadEnv, personas, the manifest, the catalog, the brand kit)
  // is a local file read.
  const anchorIndex = mainBody.indexOf('await fetchPdpBody(site.url, handle);');
  assert.ok(anchorIndex > -1, 'sanity: the fetchPdpBody call must still exist in main()');

  assert.ok(
    bootClaimIndex < anchorIndex,
    'the job-file claim must happen before the first network call (fetchPdpBody) — moving ' +
    'it later reopens the window where a second /generate call pays for a second run',
  );
}

// ── giveaways (added 2026-08-18) ────────────────────────────────────────────────────
//
// Three things switch on together while an Entry Period is open, and all three switch off
// together the moment it closes: the `giveaway` claim source, the giveaway block in the copy
// prompt, and the `giveaway-entry` format. The tests below pin BOTH states, because "no
// giveaway means byte-identical to before" is the half that is easy to break silently.

test('with no giveaway, the awareness join is exactly what it always was', () => {
  // The default is false — every existing caller, and every day outside an Entry Period.
  assert.equal(formatsForAngle({ awareness: 'product-aware' }, FORMATS).proposed, 'offer-focused');
  assert.deepEqual(formatsForAngle({ awareness: 'product-aware' }, FORMATS).alternatives, []);
  // Explicitly false must agree with the default, or the two paths could drift.
  assert.deepEqual(
    formatsForAngle({ awareness: 'product-aware' }, FORMATS, { giveawayLive: false }),
    formatsForAngle({ awareness: 'product-aware' }, FORMATS),
  );
  // The other two awareness levels have no giveaway format at all, live or not.
  for (const live of [false, true]) {
    assert.equal(formatsForAngle({ awareness: 'problem-aware' }, FORMATS, { giveawayLive: live }).proposed, 'manifesto');
    assert.equal(formatsForAngle({ awareness: 'solution-aware' }, FORMATS, { giveawayLive: live }).proposed, 'us-vs-them');
  }
});

test('with a giveaway live, a product-aware angle proposes the entry ad and keeps the sales ad as an alternative', () => {
  const { proposed, alternatives } = formatsForAngle({ awareness: 'product-aware' }, FORMATS, { giveawayLive: true });
  assert.equal(proposed, 'giveaway-entry');
  assert.deepEqual(alternatives, ['offer-focused'], 'the sales ad stays reachable — flexibility on creatives');
});

test('generateBriefs hands the giveaway to the copy stage, and picks the giveaway format', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ad-brief-gv-'));
  try {
    const product = { handle: 'coconut-soap', title: 'Moisturizing Coconut Soap', priceLabel: '$12', variant: 'pure-unscented' };
    const persona = { id: 'p5', name: 'Household switcher' };
    const angle = { id: 'p5a3', label: 'The bar you put out for guests', awareness: 'product-aware' };
    const giveaway = { name: 'Win 36 Free Bars', closesOn: 'September 14, 2026', text: 'Thirty-six (36) bars' };

    const seen = [];
    const buildConceptFn = async (args) => {
      seen.push(args);
      return { ok: true, conceptSlug: args.format.key, format: { key: args.format.key }, zones: { headline: 'H' }, claims: [] };
    };

    const [brief] = await generateBriefs({
      selected: [{ persona, angle }], product, pdpBody: '', sourceIndex: {}, reviews: [],
      seoImpact: null, dryRun: false, anthropic: null, root, now: 1786000000001, buildConceptFn, giveaway,
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].giveaway, giveaway, 'the loaded giveaway must reach buildConcept, or the prompt says nothing');
    assert.equal(seen[0].format.key, 'giveaway-entry', 'and the format resolved must be the entry ad');
    assert.equal(brief.format.proposed, 'giveaway-entry');
    assert.deepEqual(brief.format.alternatives, ['offer-focused']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generateBriefs with NO giveaway passes null through and proposes the sales ad', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ad-brief-nogv-'));
  try {
    const product = { handle: 'coconut-soap', title: 'Moisturizing Coconut Soap', priceLabel: '$12', variant: null };
    const persona = { id: 'p5', name: 'Household switcher' };
    const angle = { id: 'p5a3', label: 'The bar you put out for guests', awareness: 'product-aware' };

    const seen = [];
    const buildConceptFn = async (args) => {
      seen.push(args);
      return { ok: true, conceptSlug: args.format.key, format: { key: args.format.key }, zones: { headline: 'H' }, claims: [] };
    };

    const [brief] = await generateBriefs({
      selected: [{ persona, angle }], product, pdpBody: '', sourceIndex: {}, reviews: [],
      seoImpact: null, dryRun: false, anthropic: null, root, now: 1786000000002, buildConceptFn,
    });

    assert.equal(seen[0].giveaway, null, 'no giveaway must reach the copy prompt as null, not undefined-by-omission');
    assert.equal(seen[0].format.key, 'offer-focused');
    assert.equal(brief.format.proposed, 'offer-focused');
    assert.deepEqual(brief.format.alternatives, [], 'the giveaway format is not even offered as an alternative');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
