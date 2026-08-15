import { strict as assert } from 'node:assert';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  renderWithRetry,
  renderTarget,
  renderVariationTargets,
  buildRunReport,
  buildLabelStrings,
  sniffImageMediaType,
  createRenderBudget,
  filterDroppedClaims,
  expectedForFormat,
  parseArgs,
  buildConcept,
  buildConcepts,
  finalizeRunReport,
  DEFAULT_MAX_RENDERS,
  MAX_VARIATIONS,
  ESTIMATED_COST_PER_RENDER_USD,
} from '../../agents/ad-studio/index.js';
import { formatByKey } from '../../agents/ad-studio/formats.js';
import { assertClaimsSourced, buildSourceIndex } from '../../agents/ad-studio/claims.js';
import { PLATFORM_TARGETS } from '../../agents/ad-studio/packaging.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const format = formatByKey('manifesto'); // pairsImagesWithLabels: false

// Real magic bytes, not opaque text — the stubbed fakes returning an arbitrary
// Buffer are exactly what let the hardcoded 'image/png' media_type ship: nothing
// in the test suite exercised bytes that actually needed sniffing. Each buffer
// carries a per-call marker AFTER the signature so individual renders stay
// distinguishable without breaking the magic bytes sniffImageMediaType reads.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

function pngBufferForCall(n) {
  return Buffer.concat([PNG_SIGNATURE, Buffer.from(`-call-${n}`)]);
}

function geminiReturning() {
  let calls = 0;
  return {
    calls: () => calls,
    models: {
      generateContent: async () => {
        calls += 1;
        return { candidates: [{ content: { parts: [{ inlineData: { data: pngBufferForCall(calls).toString('base64') } }] } }] };
      },
    },
  };
}

// Always returns valid JPEG-signature bytes — used to prove renderWithRetry sends
// the media_type it actually sniffed, not a hardcoded assumption.
function geminiReturningJpeg() {
  const bytes = Buffer.concat([JPEG_SIGNATURE, Buffer.from([0, 0, 0, 0, 1, 2, 3, 4])]);
  return {
    models: {
      generateContent: async () => ({
        candidates: [{ content: { parts: [{ inlineData: { data: bytes.toString('base64') } }] } }],
      }),
    },
  };
}

// A verifier that fails the first `failFor` attempts, then passes.
function anthropicFailing(failFor, expected) {
  let calls = 0;
  return {
    calls: () => calls,
    messages: {
      create: async () => {
        calls += 1;
        const transcript = calls <= failFor ? ['GARBLED'] : expected;
        return { content: [{ type: 'text', text: JSON.stringify({ transcript }) }] };
      },
    },
  };
}

// A verifier that captures every request it receives, so the caller can inspect
// exactly what was sent (e.g. the image block's media_type) instead of only the
// parsed reply.
function anthropicCapturing(expected) {
  const requests = [];
  return {
    requests,
    messages: {
      create: async (params) => {
        requests.push(params);
        return { content: [{ type: 'text', text: JSON.stringify({ transcript: expected }) }] };
      },
    },
  };
}

// Simulates the live 400: the verify call itself throws.
function anthropicThrowing(message) {
  return { messages: { create: async () => { throw new Error(message); } } };
}

function geminiReturningRealImage(buf) {
  return {
    models: {
      generateContent: async () => ({
        candidates: [{ content: { parts: [{ inlineData: { data: buf.toString('base64') } }] } }],
      }),
    },
  };
}

const expected = ['OUR LOTION IS SIX INGREDIENTS'];

// Passes on the first attempt: one render, one verify.
{
  const g = geminiReturning();
  const a = anthropicFailing(0, expected);
  const r = await renderWithRetry({ gemini: g, anthropic: a, prompt: 'P', photoPaths: [], ratio: '1:1', expected, format, maxAttempts: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
  assert.equal(g.calls(), 1);
  assert.equal(a.calls(), 1);
  assert.equal(r.buffer.toString('latin1').slice(PNG_SIGNATURE.length), '-call-1');
  assert.equal(r.mediaType, 'image/png');
}

// renderWithRetry must sniff the real media_type off the render bytes rather than
// assume PNG — the live run's Anthropic 400 ("image was specified using the
// image/png media type, but the image appears to be a image/jpeg image") happened
// because nothing upstream of this test caught that assumption.
{
  const g = geminiReturningJpeg();
  const a = anthropicCapturing(expected);
  const r = await renderWithRetry({ gemini: g, anthropic: a, prompt: 'P', photoPaths: [], ratio: '1:1', expected, format, maxAttempts: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.mediaType, 'image/jpeg');
  const imageBlock = a.requests[0].messages[0].content.find(b => b.type === 'image');
  assert.equal(imageBlock.source.media_type, 'image/jpeg', 'must send the sniffed type, not a hardcoded image/png');
}

// Fails twice then passes: 3 renders, 3 verifies, ok.
{
  const g = geminiReturning();
  const a = anthropicFailing(2, expected);
  const r = await renderWithRetry({ gemini: g, anthropic: a, prompt: 'P', photoPaths: [], ratio: '1:1', expected, format, maxAttempts: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
  assert.equal(g.calls(), 3);
}

// Never passes: stops at maxAttempts, reports not-ok, and still returns the proof.
{
  const g = geminiReturning();
  const a = anthropicFailing(99, expected);
  const r = await renderWithRetry({ gemini: g, anthropic: a, prompt: 'P', photoPaths: [], ratio: '1:1', expected, format, maxAttempts: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.attempts, 3);
  assert.equal(g.calls(), 3, 'must not exceed the retry budget');
  assert.ok(r.proof.reasons.length > 0);
  assert.deepEqual(r.proof.missing, expected);
}

// buildRunReport summarises accepted vs rejected and never hides a rejection.
const report = buildRunReport({
  runId: 'run-1',
  product: { handle: 'coconut-lotion', title: 'Lotion' },
  results: [
    { conceptSlug: 'a', format: 'manifesto', variations: [{ n: 1, ok: true, attempts: 1 }, { n: 2, ok: false, attempts: 3, proof: { reasons: ['x'] } }] },
    { conceptSlug: 'b', format: 'us-vs-them', variations: [{ n: 1, ok: false, attempts: 3, proof: { reasons: ['y'] } }] },
  ],
});
assert.equal(report.runId, 'run-1');
assert.equal(report.product.handle, 'coconut-lotion');
assert.equal(report.totals.accepted, 1);
assert.equal(report.totals.rejected, 2);
assert.deepEqual(report.conceptsWithNoAcceptedVariation, ['b']);

// buildLabelStrings: the catalog title is marketing/SEO copy, not label text — it
// must never enter labelStrings, even though a caller might still pass a
// catalogEntry around for other purposes (product.title, priceLabel, claim
// sourcing). Fix round 1: this was a Critical finding — the title was leaking in,
// which both told the render prompt to print it on the bottle AND made the verify
// gate require it to appear, rejecting a correctly-rendered bottle every time.
{
  const ls = buildLabelStrings({
    manifestEntry: {
      productDescription: 'An 8 fl. oz. (236ml) bottle with "real SKIN CARE" near the top and "moisturizing body lotion" beneath.',
    },
    catalogEntry: { title: 'Non-Toxic Body Lotion Made With Only 6 Clean Ingredients' },
    variant: 'coconut-breeze',
  });
  assert.ok(ls.includes('8 fl. oz. (236ml)'), 'volume marking must be captured');
  assert.ok(ls.includes('real SKIN CARE'), 'quoted label text must be captured');
  assert.ok(ls.includes('coconut breeze'), 'variant name is on the label');
  assert.ok(
    !ls.some(s => /Non-Toxic Body Lotion Made With Only/.test(s)),
    'the catalog marketing title is NOT printed on the bottle and must never enter labelStrings'
  );
  assert.ok(ls.length > 0, 'empty labelStrings must never be produced for a well-formed entry');
}

// buildLabelStrings: badge arc micro-copy is excluded (fix round 5). It is decorative,
// carries no falsifiable spec, and the verify gate's vision model cannot transcribe 8px
// curved text reliably — requiring it burned three paid renders per target.
//
// Run against the REAL manifest entry, not a hand-written fixture: a fixture would prove
// only that the regex matches the sentence someone wrote for the test.
{
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, 'data', 'product-images', 'manifest.json'), 'utf8')
  );
  const lotion = manifest.find(p => p.handle === 'coconut-lotion');
  const ls = buildLabelStrings({ manifestEntry: lotion, variant: 'coconut-breeze' });

  // THE GUARD. If a future widening of the badge exclusion swallows either of these,
  // labelStrings stops doing the one job it exists for — stopping the image model
  // inventing a product spec (design probe: "6 fl. oz." rendered on a 2 fl oz bottle).
  assert.ok(ls.includes('8 fl. oz. (236ml)'), 'VOLUME MARKING must survive the badge exclusion');
  assert.ok(ls.includes('coconut breeze'), 'VARIANT NAME must survive the badge exclusion');
  assert.ok(ls.includes('real SKIN CARE'), 'brand mark must survive the badge exclusion');
  assert.ok(ls.includes('moisturizing body lotion'), 'product type must survive the badge exclusion');

  assert.ok(
    !ls.some(s => /essential oils/i.test(s)),
    'the circular badge inscription must NOT enter labelStrings'
  );
  assert.deepEqual(ls, ['real SKIN CARE', 'moisturizing body lotion', '8 fl. oz. (236ml)', 'coconut breeze']);
}

// The exclusion is keyed on the badge NOUN sitting against the quote, on either side —
// the manifest writes it both ways. Anything else quoted is kept.
{
  const before = buildLabelStrings({
    manifestEntry: { productDescription: 'A label with a small circular badge noting "Organic Coconut Oil + Essential Oils," and "moisturizing body lotion" beneath, 8 fl. oz. (236ml).' },
    variant: null,
  });
  assert.deepEqual(before, ['moisturizing body lotion', '8 fl. oz. (236ml)']);

  const after = buildLabelStrings({
    manifestEntry: { productDescription: 'A label with the brand name "real SKIN CARE", a small circular "Organic Coconut Oil & Essential Oils" badge, and "hand soap" in smaller type.' },
    variant: null,
  });
  assert.deepEqual(after, ['real SKIN CARE', 'hand soap']);
}

// Regression: an earlier, looser version of this rule matched the badge noun ANYWHERE in
// the preceding text, so the noun sitting just after one quote reached forward and ate the
// NEXT quoted string — silently dropping "hand soap" and "toothpaste", which are product
// types and very much spec-bearing. Assert the reach is bounded.
{
  const ls = buildLabelStrings({
    manifestEntry: { productDescription: 'A tube with a small "REAL" badge in the center, a botanical illustration, and the product name text above the word "toothpaste" near the crimp seal.' },
    variant: null,
  });
  assert.ok(ls.includes('toothpaste'), 'a badge earlier in the sentence must not suppress a later, unrelated string');
  assert.ok(!ls.includes('REAL'), 'the badge inscription itself is still excluded');
}

// Every manifest entry that produced label strings before the exclusion must still
// produce some — an empty list aborts the run, so an over-broad rule would take a
// product offline rather than merely lose a string.
{
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, 'data', 'product-images', 'manifest.json'), 'utf8')
  );
  const rscWithLabels = manifest.filter(p => /"/.test(p.productDescription || ''));
  assert.ok(rscWithLabels.length >= 10, 'sanity: the manifest should have many labelled entries');
  for (const entry of rscWithLabels) {
    const ls = buildLabelStrings({ manifestEntry: entry, variant: null });
    assert.ok(ls.length > 0, `badge exclusion must not empty labelStrings for ${entry.handle}`);
  }
}

// A catalogEntry with no title, or no catalogEntry at all, must not throw and must
// not change behavior — buildLabelStrings never reads catalogEntry any more.
{
  const withCatalog = buildLabelStrings({
    manifestEntry: { productDescription: 'A "real SKIN CARE" 2 fl oz (60ml) bottle.' },
    catalogEntry: { title: 'Some Marketing Title' },
    variant: 'unscented',
  });
  const withoutCatalog = buildLabelStrings({
    manifestEntry: { productDescription: 'A "real SKIN CARE" 2 fl oz (60ml) bottle.' },
    variant: 'unscented',
  });
  assert.deepEqual([...withCatalog].sort(), [...withoutCatalog].sort(), 'catalogEntry must be irrelevant to the result');
}

// sniffImageMediaType: the fix for the live 400. No silent default — an
// unrecognized signature must throw, never fall back to a guess.
assert.equal(
  sniffImageMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])),
  'image/png'
);
assert.equal(
  sniffImageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])),
  'image/jpeg'
);
assert.equal(
  sniffImageMediaType(Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), // RIFF....WEBP
  'image/webp'
);
assert.throws(
  () => sniffImageMediaType(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])),
  /unrecognized image type/i
);
assert.throws(
  () => sniffImageMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47])), // too short even though it starts like a PNG
  /too short/i
);

// renderTarget — round 3's fix for "a render failure for ONE target must not abort
// the whole run." Fixtures shared across the block below.
const product = {
  handle: 'coconut-lotion',
  title: 'Lotion',
  priceLabel: '$30',
  labelStrings: ['real SKIN CARE', '8 fl. oz. (236ml)'],
};
const brandKit = { palette_hexes: ['#000000', '#EDE5D8'] };
const zones = { headline: 'Six Ingredients.' };
const expectedFinished = ['Six Ingredients.', ...product.labelStrings];
const expectedPlate = [...product.labelStrings];

// Success path WITH a crop: a demand-gen 1.91:1 plate is requested from Gemini as
// 16:9 (the only thing Gemini will accept) and must come back center-cropped to
// within a pixel of the real 1.91:1 delivery ratio.
{
  const source = await sharp({
    create: { width: 1600, height: 900, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).png().toBuffer();
  const target = { platform: 'demand-gen', ratio: '1.91:1', mode: 'plate' };

  const result = await renderTarget({
    gemini: geminiReturningRealImage(source),
    anthropic: anthropicFailing(0, expectedPlate),
    target, format, zones, product, brandKit, photoPaths: [],
    expectedFinished, expectedPlate,
  });

  assert.equal(result.ok, true);
  assert.ok(result.buffer, 'a successful render must produce a buffer to write');
  assert.equal(result.artifact, 'plate-1_91x1.png');
  assert.equal(result.proofEntry.requestRatio, '16:9', 'must request a ratio Gemini actually supports, not 1.91:1 directly');
  assert.equal(result.proofEntry.cropped, true);

  const meta = await sharp(result.buffer).metadata();
  const deliveredRatio = meta.width / meta.height;
  assert.ok(Math.abs(deliveredRatio - 1.91) < 0.01, `delivered ratio ${deliveredRatio} must be within a pixel of 1.91:1`);
}

// Success path with NO crop: a native ratio (1:1) is requested and delivered as-is.
{
  const target = { platform: 'meta', ratio: '1:1', mode: 'finished' };
  const result = await renderTarget({
    gemini: geminiReturning(),
    anthropic: anthropicFailing(0, expectedFinished),
    target, format, zones, product, brandKit, photoPaths: [],
    expectedFinished, expectedPlate,
  });
  assert.equal(result.ok, true);
  assert.equal(result.proofEntry.requestRatio, '1:1');
  assert.equal(result.proofEntry.cropped, false);
  assert.equal(result.artifact, 'finished-1x1.png');
}

// Failure path: the verify call itself throws (this is exactly what happened live —
// an Anthropic 400 on the media_type mismatch). renderTarget must resolve, not
// reject, with ok:false, buffer:null and the error message recorded — this is the
// assertion that proves one target's failure can be recorded and the caller can
// move on to the next target instead of the whole run dying.
{
  const target = { platform: 'meta', ratio: '4:5', mode: 'finished' };
  const result = await renderTarget({
    gemini: geminiReturning(),
    anthropic: anthropicThrowing('mock 400: media type mismatch'),
    target, format, zones, product, brandKit, photoPaths: [],
    expectedFinished, expectedPlate,
  });
  assert.equal(result.ok, false);
  assert.equal(result.buffer, null, 'a failed target must not produce bytes to write');
  assert.equal(result.artifact, 'finished-4x5.png', 'falls back to the un-renamed base artifact name when no mediaType was ever sniffed');
  assert.match(result.proofEntry.error, /mock 400: media type mismatch/);
  assert.equal(result.proofEntry.ok, false);
}

// A ratio with no RENDER_RATIO_MAP entry is a config bug, not a transient render
// failure — every future call with that same ratio would fail identically, so this
// is the one case that's allowed to reject the whole run rather than being caught
// and recorded per-target.
{
  const target = { platform: 'demand-gen', ratio: '21:9', mode: 'plate' };
  await assert.rejects(
    () => renderTarget({
      gemini: geminiReturning(),
      anthropic: anthropicFailing(0, expectedPlate),
      target, format, zones, product, brandKit, photoPaths: [],
      expectedFinished, expectedPlate,
    }),
    /no render-ratio mapping/i
  );
}

// ── mode is threaded from the platform target all the way to verdictFor ─────────
// A PLATE of a format that pairs images with labels carries no labels, so the vision
// model reports no pairings — and a verdict that demands pairings there can NEVER pass.
// On a default run that was us-vs-them + ingredient-callout × 3 plate targets × 3
// variations × 3 attempts = 54 renders (~$7) that could not succeed, with both concepts
// reported as fully failed even though their Meta frames were fine.
const pairingFormat = formatByKey('ingredient-callout'); // pairsImagesWithLabels: true
{
  const target = { platform: 'demand-gen', ratio: '1:1', mode: 'plate' };
  const result = await renderTarget({
    gemini: geminiReturning(),
    // Returns a transcript and NO pairings — exactly what a text-free plate produces.
    anthropic: anthropicFailing(0, expectedPlate),
    target, format: pairingFormat, zones, product, brandKit, photoPaths: [],
    expectedFinished, expectedPlate,
  });
  assert.equal(result.ok, true, 'a plate of a pairing format must be able to pass');
  assert.equal(result.proofEntry.attempts, 1, 'and must not burn the retry budget getting there');
}

// The finished frame of that same format is unchanged: no pairings is still a hard fail.
{
  const target = { platform: 'meta', ratio: '1:1', mode: 'finished' };
  const result = await renderTarget({
    gemini: geminiReturning(),
    anthropic: anthropicFailing(0, expectedFinished),
    target, format: pairingFormat, zones, product, brandKit, photoPaths: [],
    expectedFinished, expectedPlate,
  });
  assert.equal(result.ok, false, 'a finished pairing frame with no pairings must still fail');
  assert.equal(result.proofEntry.attempts, 3, 'and must exhaust its attempts trying');
  assert.ok(result.proofEntry.reasons.some(r => /no pairings reported/i.test(r)));
}

// ── Render budget ───────────────────────────────────────────────────────────────
// createRenderBudget counts ATTEMPTS, retries included.
{
  const b = createRenderBudget(2);
  assert.equal(b.exhausted(), false);
  assert.equal(b.take(), true);
  assert.equal(b.take(), true);
  assert.equal(b.take(), false, 'the ceiling is hard');
  assert.equal(b.used(), 2, 'a refused take must not be counted');
  assert.equal(b.exhausted(), true);
}

// renderWithRetry stops mid-retry when the budget runs out instead of spending 3
// attempts, and says so rather than reporting a plain verification failure.
{
  const g = geminiReturning();
  const a = anthropicFailing(99, expected);
  const budget = createRenderBudget(1);
  const r = await renderWithRetry({
    gemini: g, anthropic: a, prompt: 'P', photoPaths: [], ratio: '1:1',
    expected, format, maxAttempts: 3, budget,
  });
  assert.equal(r.attempts, 1, 'the budget, not maxAttempts, decided when to stop');
  assert.equal(g.calls(), 1, 'no render may happen after the ceiling is hit');
  assert.equal(r.ok, false);
  assert.equal(r.budgetStopped, true);
  assert.ok(r.proof.reasons.some(x => /budget exhausted/i.test(x)));
  assert.equal(budget.used(), 1);
}

// A budget already spent means the render never happens at all — and renderTarget
// reports that as a budget stop with no bytes, not as a verification failure.
{
  const g = geminiReturning();
  const budget = createRenderBudget(0);
  const result = await renderTarget({
    gemini: g,
    anthropic: anthropicFailing(0, expectedFinished),
    target: { platform: 'meta', ratio: '1:1', mode: 'finished' },
    format, zones, product, brandKit, photoPaths: [],
    expectedFinished, expectedPlate, budget,
  });
  assert.equal(g.calls(), 0, 'not one paid call past the ceiling');
  assert.equal(result.ok, false);
  assert.equal(result.buffer, null);
  assert.equal(result.proofEntry.budgetStopped, true);
}

// renderVariationTargets: the ceiling stops further renders and NAMES what was dropped.
{
  const g = geminiReturning();
  const budget = createRenderBudget(2);
  const out = await renderVariationTargets({
    gemini: g,
    anthropic: anthropicFailing(0, expectedFinished),
    targets: PLATFORM_TARGETS,
    format, zones, product, brandKit, photoPaths: [],
    // Both modes expect the same strings here so the stub verifier passes either way.
    expectedFinished, expectedPlate: expectedFinished,
    budget,
  });
  assert.equal(g.calls(), 2, 'exactly the budget was spent, no more');
  assert.equal(out.artifacts.length, 2, 'only the funded targets produced bytes');
  assert.equal(out.ok, false, 'a budget-stopped variation is not an accepted one');
  assert.equal(out.skipped.length, PLATFORM_TARGETS.length - 2, 'every dropped artifact is named');
  assert.deepEqual(
    out.skipped,
    ['finished-9x16.png', 'plate-1_91x1.png', 'plate-1x1.png', 'plate-4x5.png'],
  );
  assert.equal(
    Object.keys(out.proofByArtifact).length,
    PLATFORM_TARGETS.length,
    'proof.json must still account for every target, skipped ones included',
  );
  assert.equal(out.proofByArtifact['plate-4x5.png'].skipped, true);
  assert.ok(out.proofByArtifact['plate-4x5.png'].reasons.some(r => /budget/i.test(r)));
}

// With no budget the same call renders every target — proves the assertions above are
// about the ceiling and not about some unrelated early exit.
{
  const g = geminiReturning();
  const out = await renderVariationTargets({
    gemini: g,
    anthropic: anthropicFailing(0, expectedFinished),
    targets: PLATFORM_TARGETS.filter(t => t.ratio !== '1.91:1'), // the crop path needs a real image
    format, zones, product, brandKit, photoPaths: [],
    expectedFinished, expectedPlate: expectedFinished,
  });
  assert.equal(out.skipped.length, 0);
  assert.equal(out.ok, true);
  assert.equal(g.calls(), PLATFORM_TARGETS.length - 1);
}

// ── parseArgs: cost flags ───────────────────────────────────────────────────────
{
  const a = parseArgs(['--product', 'coconut-lotion']);
  assert.equal(a.variations, 3);
  assert.equal(a.maxRenders, DEFAULT_MAX_RENDERS, 'a run always has a ceiling, flag or no flag');

  assert.equal(parseArgs(['--product', 'x', '--max-renders', '12']).maxRenders, 12);
  assert.throws(() => parseArgs(['--product', 'x', '--max-renders', '0']), /--max-renders must be a positive integer/);
  assert.throws(() => parseArgs(['--product', 'x', '--max-renders', 'lots']), /--max-renders must be a positive integer/);

  // --variations multiplies by 6 targets and 6 formats; unbounded is an unbounded bill.
  assert.throws(() => parseArgs(['--product', 'x', '--variations', '100']), new RegExp(`--variations must be ${MAX_VARIATIONS} or fewer`));
  assert.equal(parseArgs(['--product', 'x', '--variations', String(MAX_VARIATIONS)]).variations, MAX_VARIATIONS);
  assert.throws(() => parseArgs(['--product', 'x', '--variations', '0']), /positive integer/);
}

// ── run.json carries the run's cost and any budget stop ─────────────────────────
{
  const r = buildRunReport({
    runId: 'run-2',
    product: { handle: 'coconut-lotion', title: 'Lotion' },
    results: [{ conceptSlug: 'a', format: 'manifesto', variations: [{ n: 1, ok: true }] }],
    renders: 54,
    budget: { maxRenders: 54, stopped: true, skipped: ['a/v3/plate-4x5.png', 'b/v1/finished-1x1.png'] },
  });
  assert.equal(r.cost.renders, 54);
  assert.equal(r.cost.perRenderUsd, ESTIMATED_COST_PER_RENDER_USD);
  assert.equal(r.cost.estimatedUsd, 7.02, '54 renders at $0.13');
  assert.equal(r.budget.stopped, true, 'a truncated run must never read as a complete one');
  assert.equal(r.budget.skippedCount, 2);
  assert.deepEqual(r.budget.skipped, ['a/v3/plate-4x5.png', 'b/v1/finished-1x1.png']);

  const clean = buildRunReport({
    runId: 'run-3',
    product: { handle: 'coconut-lotion', title: 'Lotion' },
    results: [{ conceptSlug: 'a', format: 'manifesto', variations: [{ n: 1, ok: true }] }],
    renders: 6,
  });
  assert.equal(clean.cost.estimatedUsd, 0.78);
  assert.equal(clean.budget, null);
}

// ── The dropped-copy claim filter is zone-aware ─────────────────────────────────
// Keying on claim TEXT alone filtered a claim on a STRING zone whose wording happened to
// match an item truncated out of a different ARRAY zone. That zone still renders, so an
// unsourced claim would have reached a paid render with the gate none the wiser.
{
  const dropped = [{ zone: 'listItems', items: ['Kills odor bacteria'] }];
  const claims = [{ zone: 'bottomBar', text: 'Kills odor bacteria', factual: true, sourceId: 'pdp', evidence: 'nothing like this in the source' }];

  const kept = filterDroppedClaims(claims, dropped);
  assert.equal(kept.length, 1, 'a claim on a zone that still renders must stay gated');
  assert.throws(
    () => assertClaimsSourced(kept, { pdp: 'cold-pressed coconut oil and jojoba' }),
    /Claim gate failed/,
  );

  // The claim actually truncated away is still filtered out — it will never render.
  const sameZone = filterDroppedClaims(
    [{ zone: 'listItems', text: 'Kills odor bacteria', factual: true }],
    dropped,
  );
  assert.deepEqual(sameZone, []);

  // No truncation at all → claims pass through untouched.
  assert.equal(filterDroppedClaims(claims, []).length, 1);
}

// ── labelStrings are only demanded back where the product is legible ────────────
// manifesto renders the product "small and understated at the bottom center"; requiring
// a vision model to read "8 fl. oz. (236ml)" off it is unsatisfiable, and every attempt
// costs a render.
{
  const nonProminent = expectedForFormat({ zones: { headline: 'Six Ingredients.' }, format: formatByKey('manifesto'), product });
  assert.deepEqual(nonProminent.finished, ['Six Ingredients.'], 'no labelStrings on a non-prominent layout');
  assert.deepEqual(nonProminent.plate, []);

  const prominent = expectedForFormat({ zones: { headline: 'Six Ingredients.' }, format: formatByKey('us-vs-them'), product });
  assert.deepEqual(prominent.finished, ['Six Ingredients.', ...product.labelStrings], 'a hero-sized product must still prove its label');
  assert.deepEqual(prominent.plate, [...product.labelStrings]);
}

// ── Claim-gate failure isolation ─────────────────────────────────────────────────
// Real incident: a run of 4 concepts hit an unsourced claim on the FIRST one and
// assertClaimsSourced's throw propagated out of main() uncaught, aborting the whole
// run — manifesto, problem-aware and top-x-review never even got a copy call, and no
// run.json was written. Fix mirrors renderTarget/renderVariationTargets: buildConcept
// tries assertClaimsSourced and turns ONLY its failure into a structured rejection;
// buildConcepts loops and never itself catches anything, so an unrelated error still
// aborts the run.

// A stub Anthropic client for the copy call. Reads the format key out of the prompt
// (buildCopyPrompt always writes "FORMAT: <key> —") so each format gets a distinct,
// controllable response without needing a real model.
function anthropicCopyStub({ badFormatKey, evidenceOk, evidenceBad }) {
  let calls = 0;
  const promptsSeen = [];
  return {
    calls: () => calls,
    promptsSeen,
    messages: {
      create: async (params) => {
        calls += 1;
        const prompt = params.messages[0].content;
        promptsSeen.push(prompt);
        const m = prompt.match(/FORMAT: ([\w-]+)/);
        const key = m ? m[1] : null;
        const isBad = key === badFormatKey;
        const zones = { headline: `Headline for ${key}` };
        const claims = [{
          zone: 'headline',
          text: `Headline for ${key}`,
          factual: true,
          sourceId: 'catalog',
          evidence: isBad ? evidenceBad : evidenceOk,
        }];
        return { content: [{ type: 'text', text: JSON.stringify({ zones, claims }) }] };
      },
    },
  };
}

const claimGateProduct = { handle: 'coconut-lotion', title: 'Lotion', priceLabel: '$30', labelStrings: ['x'] };
const claimGateSourceIndex = buildSourceIndex({ catalogEntry: { title: 'Six Clean Ingredients Lotion' } });

// buildConcept: the claim gate's own failure is turned into a structured rejection,
// not a throw — but ONLY when the failure is actually assertClaimsSourced's. Its
// message ("Claim gate failed — N unsourced claim(s)...") is unchanged from
// claims.js, unmodified by this fix.
{
  const goodFormat = formatByKey('us-vs-them');
  const badFormat = formatByKey('manifesto');

  const goodAnthropic = anthropicCopyStub({ badFormatKey: null, evidenceOk: 'Six Clean Ingredients' });
  const goodResult = await buildConcept({
    anthropic: goodAnthropic, format: goodFormat, product: claimGateProduct, pdpBody: '', persona: null, sourceIndex: claimGateSourceIndex,
  });
  assert.equal(goodResult.ok, true);
  assert.equal(goodResult.conceptSlug, 'us-vs-them');
  assert.equal(goodResult.format.key, 'us-vs-them', 'the full format object is carried through for the render stage');

  const badAnthropic = anthropicCopyStub({ badFormatKey: 'manifesto', evidenceBad: 'this phrase appears nowhere in any source' });
  const badResult = await buildConcept({
    anthropic: badAnthropic, format: badFormat, product: claimGateProduct, pdpBody: '', persona: null, sourceIndex: claimGateSourceIndex,
  });
  assert.equal(badResult.ok, false, 'a claim-gate failure must not throw out of buildConcept');
  assert.equal(badResult.conceptSlug, 'manifesto');
  assert.equal(badResult.violations.length, 1);
  assert.match(badResult.violations[0].reason, /evidence not found/);
  assert.match(badResult.error, /^Claim gate failed/, 'assertClaimsSourced\'s own message, unchanged');
}

// buildConcept: an error that is NOT the claim gate must still surface. Simulated by
// an Anthropic client whose copy call itself throws (a network failure, a live 500) —
// this must propagate, not be swallowed as if it were an unsourced claim.
{
  const throwingAnthropic = { messages: { create: async () => { throw new Error('mock network failure: ECONNRESET'); } } };
  await assert.rejects(
    () => buildConcept({
      anthropic: throwingAnthropic, format: formatByKey('us-vs-them'), product: claimGateProduct, pdpBody: '', persona: null, sourceIndex: claimGateSourceIndex,
    }),
    /mock network failure/,
    'only the claim gate\'s own failure may be caught — everything else must surface',
  );
}

// buildConcepts: THE isolation test. 3 concepts, the MIDDLE one has an unsourced
// claim. The other two must still be attempted and still succeed — the whole point
// of the fix is that one bad concept does not cost the copy already generated (and
// paid for) on the others.
{
  const formats = [formatByKey('us-vs-them'), formatByKey('manifesto'), formatByKey('problem-aware')];
  const anthropic = anthropicCopyStub({
    badFormatKey: 'manifesto',
    evidenceOk: 'Six Clean Ingredients',
    evidenceBad: 'this phrase appears nowhere in any source',
  });

  const { concepts, rejectedConcepts } = await buildConcepts({
    anthropic, formats, product: claimGateProduct, pdpBody: '', persona: null, sourceIndex: claimGateSourceIndex,
  });

  assert.equal(anthropic.calls(), 3, 'all 3 concepts must be attempted — the failure on #2 must not stop #3 from even being asked for');
  assert.equal(concepts.length, 2, 'the two good concepts render');
  assert.deepEqual(concepts.map(c => c.format.key).sort(), ['problem-aware', 'us-vs-them']);
  assert.equal(rejectedConcepts.length, 1);
  assert.equal(rejectedConcepts[0].conceptSlug, 'manifesto', 'the run report must name exactly which concept was rejected');
  assert.ok(rejectedConcepts[0].violations.length > 0, 'and carry the violations that failed it');
  assert.match(rejectedConcepts[0].violations[0].reason, /evidence not found/);
}

// buildRunReport: a rejected concept is named in the report with its violations —
// impossible to read run.json and think it succeeded or was never requested.
{
  const r = buildRunReport({
    runId: 'run-4',
    product: { handle: 'coconut-lotion', title: 'Lotion' },
    results: [{ conceptSlug: 'us-vs-them', format: 'us-vs-them', variations: [{ n: 1, ok: true }] }],
    renders: 6,
    rejectedConcepts: [{
      conceptSlug: 'manifesto',
      format: 'manifesto',
      violations: [{ zone: 'headline', text: 'Headline for manifesto', reason: 'evidence not found in source catalog: "this phrase appears nowhere in any source"' }],
      error: 'Claim gate failed — 1 unsourced claim(s). Nothing was rendered.',
    }],
  });
  assert.equal(r.rejectedConcepts.length, 1);
  assert.equal(r.rejectedConcepts[0].conceptSlug, 'manifesto');
  assert.match(r.rejectedConcepts[0].violations[0].reason, /evidence not found/);
  assert.equal(r.totals.requested, 2, 'requested = rendered + rejected — a rejected concept must still count as asked-for');

  // A run with no rejections carries an empty (not missing) rejectedConcepts list.
  const clean = buildRunReport({
    runId: 'run-5',
    product: { handle: 'coconut-lotion', title: 'Lotion' },
    results: [{ conceptSlug: 'us-vs-them', format: 'us-vs-them', variations: [{ n: 1, ok: true }] }],
  });
  assert.deepEqual(clean.rejectedConcepts, []);
  assert.equal(clean.totals.requested, 1);
}

// finalizeRunReport: a run where EVERY concept fails the claim gate (concepts: [])
// must still write run.json to disk AND fail the run (throw, so main()'s existing
// catch()/process.exit(1) path fires) — a silent empty success would look like a
// clean run of zero concepts instead of a total claim-gate rejection.
{
  const tmpDir = mkdtempSync(join(tmpdir(), 'ad-studio-test-'));
  try {
    assert.throws(
      () => finalizeRunReport({
        runDir: tmpDir,
        runId: 'run-all-rejected',
        product: { handle: 'coconut-lotion', title: 'Lotion' },
        results: [], // nothing rendered — every concept was rejected before render
        renders: 0,
        budget: null,
        concepts: [], // nothing survived the gate
        rejectedConcepts: [
          { conceptSlug: 'us-vs-them', format: 'us-vs-them', violations: [{ zone: 'headline', text: 'A', reason: 'evidence not found in source catalog: "x"' }], error: 'Claim gate failed — 1 unsourced claim(s).' },
          { conceptSlug: 'manifesto', format: 'manifesto', violations: [{ zone: 'headline', text: 'B', reason: 'evidence not found in source catalog: "y"' }], error: 'Claim gate failed — 1 unsourced claim(s).' },
        ],
      }),
      /every requested concept.*rejected by the claim gate/i,
      'a run where every concept fails the gate must throw (so the process exits non-zero)',
    );

    const written = JSON.parse(readFileSync(join(tmpDir, 'run.json'), 'utf8'));
    assert.equal(written.results.length, 0);
    assert.equal(written.rejectedConcepts.length, 2, 'run.json must still be written, naming every rejected concept');
    assert.deepEqual(written.rejectedConcepts.map(c => c.conceptSlug).sort(), ['manifesto', 'us-vs-them']);
    assert.equal(written.totals.requested, 2, 'both requested concepts are accounted for even though neither rendered');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// finalizeRunReport: a PARTIAL rejection (some concepts rendered) must NOT throw —
// only a total wipeout does. run.json is still written either way.
{
  const tmpDir = mkdtempSync(join(tmpdir(), 'ad-studio-test-'));
  try {
    const report = finalizeRunReport({
      runDir: tmpDir,
      runId: 'run-partial',
      product: { handle: 'coconut-lotion', title: 'Lotion' },
      results: [{ conceptSlug: 'us-vs-them', format: 'us-vs-them', variations: [{ n: 1, ok: true }] }],
      renders: 6,
      budget: null,
      concepts: [{ format: { key: 'us-vs-them' } }],
      rejectedConcepts: [{ conceptSlug: 'manifesto', format: 'manifesto', violations: [{ zone: 'headline', text: 'B', reason: 'evidence not found' }], error: 'Claim gate failed — 1 unsourced claim(s).' }],
    });
    assert.equal(report.rejectedConcepts.length, 1);
    assert.equal(report.results.length, 1);
    const written = JSON.parse(readFileSync(join(tmpDir, 'run.json'), 'utf8'));
    assert.equal(written.rejectedConcepts[0].conceptSlug, 'manifesto');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}
