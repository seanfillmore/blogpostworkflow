import { strict as assert } from 'node:assert';
import { PLATFORM_TARGETS, selectTargets } from '../../agents/ad-studio/packaging.js';
import { parseArgs, DEFAULT_VARIATIONS } from '../../agents/ad-studio/index.js';
import { scoreRows, summariseRun, readBaselineFrom, rankArtifacts } from '../../agents/ad-studio/baseline.js';

// ── selectTargets — render only what was asked for ──────────────────────────────────
//
// Every variation used to render all six platform targets, forced. The floor for "show me
// one ad style" was therefore 6 renders (~$0.78), half of it Demand Gen plates that are
// only useful if a Demand Gen campaign is actually running.
assert.equal(PLATFORM_TARGETS.length, 6);
assert.equal(selectTargets('all').length, 6);

const meta = selectTargets('meta');
assert.equal(meta.length, 3);
assert.ok(meta.every(t => t.platform === 'meta' && t.mode === 'plate' && t.wantsComp));

const dg = selectTargets('demand-gen');
assert.equal(dg.length, 3);
assert.ok(dg.every(t => t.platform === 'demand-gen' && t.mode === 'plate'));

// Comma-separated, and platform=ratio for a single placement.
assert.equal(selectTargets('meta,demand-gen').length, 6);
const one = selectTargets('meta=9:16');
assert.equal(one.length, 1);
assert.equal(one[0].ratio, '9:16');
assert.equal(one[0].platform, 'meta');
// Order follows PLATFORM_TARGETS, not the order the user typed — output paths and the
// progress tree stay stable however the flag is written.
assert.deepEqual(selectTargets('demand-gen,meta').map(t => t.platform + t.ratio),
                 selectTargets('meta,demand-gen').map(t => t.platform + t.ratio));
// Duplicates collapse rather than rendering the same target twice.
assert.equal(selectTargets('meta,meta,meta=1:1').length, 3);

// An unknown token is a typo that would otherwise silently render the wrong set — or,
// worse, nothing. Name the valid values.
assert.throws(() => selectTargets('facebook'), /facebook/);
assert.throws(() => selectTargets('facebook'), /meta/);
assert.throws(() => selectTargets('meta=2:3'), /2:3/);
assert.throws(() => selectTargets(''), /--targets/);

// ── parseArgs — the expensive path must be the one you type deliberately ─────────────
const base = ['--product', 'coconut-lotion'];

// --formats is REQUIRED. Omitting it used to mean the whole six-format rotation: 108
// renders, ~$14, from a flag the operator never touched.
assert.throws(() => parseArgs(base), /--formats is required/);
// ...and the error names the keys, so the fix does not require reading formats.js.
assert.throws(() => parseArgs(base), /ingredient-callout/);
assert.throws(() => parseArgs([...base, '--formats', '']), /--formats is required/);
assert.throws(() => parseArgs([...base, '--formats', 'not-a-format']), /not-a-format/);

const a = parseArgs([...base, '--formats', 'ingredient-callout']);
assert.deepEqual(a.formats, ['ingredient-callout']);

// One variation, all three Meta placements.
assert.equal(DEFAULT_VARIATIONS, 1);
assert.equal(a.variations, 1);
assert.equal(a.targets.length, 3);
assert.ok(a.targets.every(t => t.platform === 'meta'));
// 9:16 is BACK. It was pulled when the gate hard-failed copy inside Meta's Stories/Reels
// UI bands — correct, but unsatisfiable, because every layoutBrief runs a headline to the
// top edge and the image model fills the frame whatever the prompt says (6 of 6 live
// failures). A plate carries no copy to place, so there is nothing left to violate: the
// bands ship as guide-9x16.svg and the type is set against them by hand.
assert.ok(a.targets.some(t => t.ratio === '9:16'), '9:16 renders again now that type is set by hand');
assert.equal(selectTargets('meta=9:16').length, 1);

// Opting up is explicit.
assert.equal(parseArgs([...base, '--formats', 'ingredient-callout', '--variations', '3']).variations, 3);
assert.equal(parseArgs([...base, '--formats', 'ingredient-callout', '--targets', 'all']).targets.length, 6);

// --dry-run renders nothing, so it must not require a target set to be meaningful.
assert.equal(parseArgs([...base, '--formats', 'ingredient-callout', '--dry-run']).dryRun, true);

// ── rankArtifacts — the frame worth looking at is the first line you read ────────────
const results = [
  { conceptSlug: 'ingredient-callout', variations: [
    { n: 1, ok: true, artifacts: [
      { artifact: 'finished-1x1.png', ok: true, score: 3 },
      { artifact: 'finished-4x5.png', ok: true, score: 5 },
    ] },
    { n: 2, ok: false, artifacts: [{ artifact: 'finished-1x1.png', ok: false, score: 4 }] },
  ] },
  { conceptSlug: 'manifesto', variations: [
    { n: 1, ok: true, artifacts: [{ artifact: 'finished-1x1.png', ok: true, score: 4 }] },
  ] },
];

const ranked = rankArtifacts(results);
// Best first, and ONLY accepted frames — a rejected frame is not a candidate to ship,
// whatever an art director thought of its composition.
assert.deepEqual(ranked.map(r => r.score), [5, 4, 3]);
assert.equal(ranked[0].conceptSlug, 'ingredient-callout');
assert.equal(ranked[0].artifact, 'finished-4x5.png');
assert.ok(!ranked.some(r => r.score === 4 && r.conceptSlug === 'ingredient-callout'),
  'the rejected v2 frame must not appear in the ranking');

// An unscored accepted frame (plate, or a critique that could not answer) sorts last
// rather than being dropped — it still shipped, it just carries no opinion.
const withNull = rankArtifacts([{ conceptSlug: 'x', variations: [{ n: 1, ok: true, artifacts: [
  { artifact: 'a.png', ok: true, score: null },
  { artifact: 'b.png', ok: true, score: 2 },
] }] }]);
assert.deepEqual(withNull.map(r => r.artifact), ['b.png', 'a.png']);

// ── the score baseline ──────────────────────────────────────────────────────────────
const rows = scoreRows({ runId: 'r1', product: { handle: 'coconut-lotion' }, results });
// One row per SCORED artifact, accepted or not — a rejected frame's score is still
// evidence about what this pipeline produces, which is what a baseline is for.
assert.equal(rows.length, 4);
assert.ok(rows.every(r => r.runId === 'r1' && r.product === 'coconut-lotion'));
assert.ok(rows.every(r => typeof r.format === 'string' && typeof r.score === 'number'));
assert.equal(rows.filter(r => r.ok === false).length, 1);

// summariseRun compares this run to the rolling baseline, and is HONEST when the
// baseline is too thin to mean anything. Early runs must not read as a trend.
const thin = summariseRun(rows, { n: 4, mean: 3.5, byFormat: {} });
assert.equal(thin.n, 4);
assert.equal(thin.mean, 4);
assert.equal(thin.baselineThin, true, 'a handful of frames is not a baseline');

const fat = summariseRun(rows, { n: 120, mean: 3.5, byFormat: { 'ingredient-callout': { n: 80, mean: 3.2 } } });
assert.equal(fat.baselineThin, false);
assert.equal(fat.baselineN, 120);
assert.equal(fat.delta, 0.5);

// A run with nothing scored reports no mean rather than 0 — 0 would read as "terrible"
// when it means "not measured".
const empty = summariseRun([], { n: 0, mean: null, byFormat: {} });
assert.equal(empty.mean, null);
assert.equal(empty.n, 0);

// readBaselineFrom parses JSONL, skips malformed lines rather than throwing, and reports
// per-format means — scores are only comparable within a format, since a manifesto frame
// and a us-vs-them frame are not being judged on the same thing.
const jsonl = [
  JSON.stringify({ runId: 'a', format: 'manifesto', score: 4 }),
  'not json at all',
  JSON.stringify({ runId: 'a', format: 'manifesto', score: 2 }),
  JSON.stringify({ runId: 'b', format: 'us-vs-them', score: 5 }),
  JSON.stringify({ runId: 'b', format: 'us-vs-them' }),
].join('\n');
const b = readBaselineFrom(jsonl);
assert.equal(b.n, 3, 'rows without a numeric score are not observations');
assert.equal(b.mean, Number(((4 + 2 + 5) / 3).toFixed(2)));
assert.equal(b.byFormat.manifesto.n, 2);
assert.equal(b.byFormat.manifesto.mean, 3);
assert.equal(readBaselineFrom('').n, 0);
assert.equal(readBaselineFrom('').mean, null);
