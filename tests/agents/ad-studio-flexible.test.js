// tests/agents/ad-studio-flexible.test.js
//
// The 3-2-2 flexible ad. What is under test is mostly REFUSAL: the mode's value is that it
// produces the one structure whose arithmetic works at $30/day, so every way of ending up
// with a different structure has to be a loud error rather than a quiet manifest.

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertFlexibleArgs, parseFlexibleCopyResponse, flexibleZones, renderFlexibleManifest,
  buildFlexibleCopyPrompt, PLATE_COUNT, PRIMARY_TEXT_COUNT, HEADLINE_COUNT,
  HEADLINE_MAX_CHARS, PRIMARY_TEXT_MAX_CHARS,
} from '../../agents/ad-studio/flexible.js';
import { parseArgs, collectFlexiblePlates, FLEXIBLE_DEFAULT_TARGET } from '../../agents/ad-studio/index.js';
import { assertNoHealthClaims } from '../../agents/ad-studio/health-claims.js';

const META45 = { platform: 'meta', ratio: '4:5', mode: 'plate', wantsComp: true };
const OK_ARGS = { formats: ['a', 'b', 'c'], targets: [META45], variations: 1 };

// ── assertFlexibleArgs ──────────────────────────────────────────────────────
assert.doesNotThrow(() => assertFlexibleArgs(OK_ARGS), 'the canonical shape passes');

assert.throws(
  () => assertFlexibleArgs({ ...OK_ARGS, formats: ['a', 'b'] }),
  /exactly 3 --formats \(got 2/,
  'two plates is not a 3-2-2'
);

// The specific mistake this guards: three variations of ONE format looks like three
// creatives and is three ads chasing the same buyer.
assert.throws(
  () => assertFlexibleArgs({ ...OK_ARGS, formats: ['a'], variations: 3 }),
  /exactly 3 --formats/,
  'one format with three variations is rejected on the format count first'
);

assert.throws(
  () => assertFlexibleArgs({ ...OK_ARGS, variations: 2 }),
  /fixes --variations at 1 \(got 2/,
  'extra variations would multiply the ads the mode exists to consolidate'
);

// Mixed ratios are the subtle one — the run succeeds, the plates look fine, and the ad
// quietly asks Meta to decide creative and shape at once.
assert.throws(
  () => assertFlexibleArgs({ ...OK_ARGS, targets: [META45, { platform: 'meta', ratio: '1:1' }] }),
  /exactly ONE target \(got 2/,
  'two ratios is two questions'
);

assert.throws(
  () => assertFlexibleArgs({ ...OK_ARGS, targets: [{ platform: 'demand-gen', ratio: '1:1' }] }),
  /Demand Gen has no flexible-ad equivalent/,
  'flexible ads are a Meta format'
);

// ── parseArgs wiring ────────────────────────────────────────────────────────
{
  const args = parseArgs(['--product', 'coconut-lotion', '--flexible', '--formats', 'us-vs-them,manifesto,testimonial']);
  assert.equal(args.flexible, true);
  assert.equal(args.targets.length, 1, 'flexible defaults to a single placement, not the usual three');
  assert.equal(`${args.targets[0].platform}=${args.targets[0].ratio}`, FLEXIBLE_DEFAULT_TARGET);
  assert.equal(args.variations, 1);
}

// A non-flexible run must be completely unaffected — same three Meta placements as before.
{
  const args = parseArgs(['--product', 'coconut-lotion', '--formats', 'us-vs-them']);
  assert.equal(args.flexible, false);
  assert.equal(args.targets.length, 3, 'the ordinary default is untouched');
}

// An explicit --targets still wins over the flexible default, and is still validated.
{
  const args = parseArgs(['--product', 'p', '--flexible', '--formats', 'us-vs-them,manifesto,testimonial', '--targets', 'meta=9:16']);
  assert.equal(args.targets[0].ratio, '9:16');
}

assert.throws(
  () => parseArgs(['--product', 'p', '--flexible', '--formats', 'us-vs-them,manifesto,testimonial', '--targets', 'meta']),
  /exactly ONE target \(got 3/,
  '--targets meta expands to three ratios and must be caught'
);

assert.throws(
  () => parseArgs(['--brief', 'coconut-lotion-1', '--flexible']),
  /mutually exclusive/,
  'brief mode carries one approved concept; say so by name rather than complaining about --formats'
);

// ── parseFlexibleCopyResponse ───────────────────────────────────────────────
const GOOD = JSON.stringify({
  primaryTexts: ['You have tried every bottle on the shelf.', 'Six ingredients. That is the whole list.'],
  headlines: ['Still dry by lunchtime?', 'Six ingredients, nothing else'],
  claims: [{ zone: 'headline2', text: 'Six ingredients', factual: true, sourceId: 'catalog', evidence: '6 clean ingredients' }],
});

{
  const out = parseFlexibleCopyResponse(GOOD);
  assert.equal(out.primaryTexts.length, PRIMARY_TEXT_COUNT);
  assert.equal(out.headlines.length, HEADLINE_COUNT);
  assert.equal(out.claims.length, 1);
}

// Fenced and chatty responses are the norm, not the exception.
assert.doesNotThrow(() => parseFlexibleCopyResponse('Sure!\n```json\n' + GOOD + '\n```'), 'fenced JSON parses');

assert.throws(
  () => parseFlexibleCopyResponse(JSON.stringify({
    primaryTexts: ['a', 'b', 'c'], headlines: ['x', 'y'],
  })),
  /exactly 2 primaryTexts \(got 3/,
  'three texts is a different structure, not a bonus'
);

assert.throws(
  () => parseFlexibleCopyResponse(JSON.stringify({ primaryTexts: ['a', '  '], headlines: ['x', 'y'] })),
  /primaryTexts\[1\] is empty/,
  'a blank field is not a field'
);

// The failure an operator cannot see by reading the manifest: both entries look fine
// alone, and the shared pool has nothing to learn between them.
assert.throws(
  () => parseFlexibleCopyResponse(JSON.stringify({
    primaryTexts: ['Dry skin?', 'dry skin?'], headlines: ['x', 'y'],
  })),
  /primaryTexts are not distinct/,
  'case-only differences are one angle'
);

assert.throws(
  () => parseFlexibleCopyResponse(JSON.stringify({
    primaryTexts: ['a', 'b'], headlines: ['x'.repeat(HEADLINE_MAX_CHARS + 1), 'y'],
  })),
  /exceeds Meta's field limits/,
  'Meta truncates; a truncated headline is a different headline'
);

assert.doesNotThrow(
  () => parseFlexibleCopyResponse(JSON.stringify({
    primaryTexts: ['a'.repeat(PRIMARY_TEXT_MAX_CHARS), 'b'], headlines: ['x'.repeat(HEADLINE_MAX_CHARS), 'y'],
  })),
  'exactly at the limit is allowed'
);

assert.throws(() => parseFlexibleCopyResponse('not json at all'), /was not JSON/);

// ── the gates apply to ad-level copy too ────────────────────────────────────
// The whole reason flexibleZones exists: the health gate is reused UNCHANGED, so a
// disease name in a primary text stops the run exactly as it would on a plate.
{
  const zones = flexibleZones({
    primaryTexts: ['Tried steroids for your eczema?', 'clean'],
    headlines: ['a', 'b'],
  });
  assert.deepEqual(Object.keys(zones), ['primaryText1', 'primaryText2', 'headline1', 'headline2']);
  assert.throws(() => assertNoHealthClaims(zones), /eczema|steroid/i,
    'ad-level copy is subject to the same law as plate copy');
}

// ── the prompt carries the shared rules block ───────────────────────────────
{
  const prompt = buildFlexibleCopyPrompt({
    product: { title: 'Coconut Lotion', handle: 'coconut-lotion', priceLabel: '$30' },
    concepts: [{ format: { key: 'us-vs-them', name: 'Us vs Them', awareness: 'solution-aware' } }],
    sourceIds: ['pdp', 'catalog'],
  });
  assert.match(prompt, /NO HEALTH CLAIMS, in any field/, 'the shared rules block is present, with the ad-level noun');
  assert.match(prompt, /sourceId\s+from: pdp, catalog/, 'only the sources actually held are offered');
  assert.match(prompt, /genuinely DIFFERENT\s+ANGLES/, 'the two-angles requirement is stated, since it is the point');
}

// ── collectFlexiblePlates ───────────────────────────────────────────────────
{
  const root = mkdtempSync(join(tmpdir(), 'flex-'));
  // .jpg, NOT .png. artifactName() ends in ".png" because it is a placement-format label;
  // artifactFilename() rewrites the extension to whatever Gemini actually returned, and
  // the recorded artifact is the real filename. The first version of this fixture used
  // .png — my assumption rather than reality — so it passed while the live run reported
  // all three plates unverified against a run.json that said 2 of 3 passed.
  const results = [
    { conceptSlug: 'us-vs-them', format: 'us-vs-them', variations: [{ n: 1, ok: true, artifacts: [{ artifact: 'meta-plate-4x5.jpg', ok: true }] }] },
    { conceptSlug: 'manifesto', format: 'manifesto', variations: [{ n: 1, ok: false, artifacts: [{ artifact: 'meta-plate-4x5.jpg', ok: false }] }] },
    { conceptSlug: 'testimonial', format: 'testimonial', variations: [{ n: 1, ok: true, artifacts: [{ artifact: 'meta-plate-4x5.webp', ok: true }] }] },
  ];
  const plates = collectFlexiblePlates({ runId: 'r1', results, target: META45, root });
  assert.equal(plates.length, 3);
  assert.deepEqual(plates.map(p => p.verified), [true, false, true],
    'a rejected plate is still listed — the operator has two usable plates and must be told, not silently handed a 2-2-2');
  assert.match(plates[0].file, /r1\/us-vs-them\/v1\/meta-plate-4x5\.jpg$/,
    'the path carries the REAL extension, taken from the recorded artifact rather than rebuilt from the label');
  assert.match(plates[2].file, /meta-plate-4x5\.webp$/, 'any media type Gemini returns is matched');

  // A concept whose target errored before writing anything has no file to point at.
  const errored = collectFlexiblePlates({
    runId: 'r1', target: META45, root,
    results: [{ conceptSlug: 'ghosted', format: 'ghosted', variations: [{ n: 1, ok: false, artifacts: [] }] }],
  });
  assert.equal(errored[0].file, null, 'no invented path for an artifact that was never written');
  assert.equal(errored[0].verified, false);

  // A stray file from an earlier run in the same directory must never be picked up:
  // the list comes from what this run recorded, not from readdir.
  mkdirSync(join(root, 'data', 'creatives', 'ad-studio', 'r1', 'ghost', 'v1'), { recursive: true });
  writeFileSync(join(root, 'data', 'creatives', 'ad-studio', 'r1', 'ghost', 'v1', 'meta-plate-4x5.png'), 'x');
  assert.equal(collectFlexiblePlates({ runId: 'r1', results, target: META45, root }).length, 3,
    'the ghost concept is not in results, so it is not in the ad');
}

// ── renderFlexibleManifest ──────────────────────────────────────────────────
{
  const { json, md } = renderFlexibleManifest({
    runId: 'r1',
    product: { handle: 'coconut-lotion', title: 'Coconut Lotion' },
    variant: null,
    target: META45,
    plates: [
      { format: 'us-vs-them', file: '/tmp/a.jpg', verified: true },
      { format: 'manifesto', file: '/tmp/b.jpg', verified: false },
      { format: 'testimonial', file: null, verified: false },
    ],
    primaryTexts: ['one', 'two'],
    headlines: ['three', 'four'],
    claims: [],
  });

  assert.equal(json.structure.combinations, PLATE_COUNT * PRIMARY_TEXT_COUNT * HEADLINE_COUNT);
  assert.equal(json.structure.combinations, 12, 'the 12 that share one learning pool');
  assert.equal(json.placement.ratio, '4:5');
  assert.match(md, /12 combinations sharing one learning pool/);
  assert.match(md, /Do not create three ads/, 'the instruction that makes or breaks the structure is in the deliverable');
  assert.match(md, /did not pass verification — do not ship/, 'the unverified plate is flagged where the operator will see it');
  assert.match(md, /no artifact produced/, 'a concept that rendered nothing says so rather than listing a path that does not exist');
  assert.match(md, /harvest it by copying its post ID/, 'the winner-harvesting rule travels with the ad');
}

console.log('✓ ad-studio flexible-ad tests pass');
