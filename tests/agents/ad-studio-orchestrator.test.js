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

// A clean verify response: every requested string answered "found", quoted back
// verbatim, the true volume read off the label, no defects. This is the shape the
// verify gate scores — the transcript is diagnostic and decides nothing.
function verifyReply(expected, { volume = '8 fl. oz. (236ml)', garbled = false, extra = {} } = {}) {
  const checks = (expected || []).map(e => ({
    expected: e,
    found: !garbled,
    rendered: garbled ? 'GARBLED' : e,
  }));
  return JSON.stringify({
    checks,
    productVolume: volume,
    defects: [],
    transcript: garbled ? ['GARBLED'] : expected,
    ...extra,
  });
}

// A clean CRITIQUE response (stage 5b): inside the safe zone, legible, decent score.
// Part A passes, so it never changes a verdict these tests are about.
function critiqueReply({ safeZone = 'OK', legibility = 'OK', score = 4 } = {}) {
  return JSON.stringify({ safeZone, safeZoneDetail: '', legibility, legibilityDetail: '', score, reasons: [] });
}

// Is this request the art-direction call rather than the verify call? renderWithRetry
// makes BOTH against the same client, so a stub that answers every request with a verify
// reply hands the critique a response with no safeZone/legibility in it — which
// critiqueVerdict correctly reads as "the check did not run" and fails the frame.
function isCritiqueRequest(params) {
  return (params?.messages?.[0]?.content || [])
    .some(b => b.type === 'text' && /ART DIRECTOR/i.test(b.text || ''));
}

// A verifier that fails the first `failFor` attempts, then passes.
//
// `calls()` counts VERIFY calls only. A frame that passes verify also costs one critique
// call, and folding the two together would make every existing "one render, one verify"
// assertion read as two verifies.
function anthropicFailing(failFor, expected, critique = {}) {
  let calls = 0;
  let critiques = 0;
  return {
    calls: () => calls,
    critiques: () => critiques,
    messages: {
      create: async (params) => {
        if (isCritiqueRequest(params)) {
          critiques += 1;
          return { content: [{ type: 'text', text: critiqueReply(critique) }] };
        }
        calls += 1;
        return { content: [{ type: 'text', text: verifyReply(expected, { garbled: calls <= failFor }) }] };
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
        if (isCritiqueRequest(params)) return { content: [{ type: 'text', text: critiqueReply() }] };
        return { content: [{ type: 'text', text: verifyReply(expected) }] };
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
  unitCount: 1,
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
  assert.equal(result.artifact, 'demand-gen-plate-1_91x1.png');
  assert.equal(result.proofEntry.requestRatio, '16:9', 'must request a ratio Gemini actually supports, not 1.91:1 directly');
  assert.equal(result.proofEntry.cropped, true);

  const meta = await sharp(result.buffer).metadata();
  const deliveredRatio = meta.width / meta.height;
  assert.ok(Math.abs(deliveredRatio - 1.91) < 0.01, `delivered ratio ${deliveredRatio} must be within a pixel of 1.91:1`);
}

// Success path with NO crop: a native ratio (1:1) is requested and delivered as-is.
{
  const target = { platform: 'meta', ratio: '1:1', mode: 'plate', wantsComp: false };
  const result = await renderTarget({
    gemini: geminiReturning(),
    anthropic: anthropicFailing(0, expectedFinished),
    target, format, zones, product, brandKit, photoPaths: [],
    expectedFinished, expectedPlate,
  });
  assert.equal(result.ok, true);
  assert.equal(result.proofEntry.requestRatio, '1:1');
  assert.equal(result.proofEntry.cropped, false);
  assert.equal(result.artifact, 'meta-plate-1x1.png');
}

// Failure path: the verify call itself throws (this is exactly what happened live —
// an Anthropic 400 on the media_type mismatch). renderTarget must resolve, not
// reject, with ok:false, buffer:null and the error message recorded — this is the
// assertion that proves one target's failure can be recorded and the caller can
// move on to the next target instead of the whole run dying.
{
  const target = { platform: 'meta', ratio: '4:5', mode: 'plate', wantsComp: false };
  const result = await renderTarget({
    gemini: geminiReturning(),
    anthropic: anthropicThrowing('mock 400: media type mismatch'),
    target, format, zones, product, brandKit, photoPaths: [],
    expectedFinished, expectedPlate,
  });
  assert.equal(result.ok, false);
  assert.equal(result.buffer, null, 'a failed target must not produce bytes to write');
  assert.equal(result.artifact, 'meta-plate-4x5.png', 'falls back to the un-renamed base artifact name when no mediaType was ever sniffed');
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

// THE PAIRING CHECK IS NOW DORMANT, and that is a deliberate consequence worth stating.
//
// It was the design's centrepiece: it caught an ad where every word was spelled correctly
// and jojoba oil was captioned as coconut oil. It can only fire on a frame that pairs a
// PICTURE with a LABEL — and no rendered artifact does that any more. The plate is
// explicitly rendered with no icons, no ingredient photographs and no captions (the
// operator places those in Photoshop), so there are no pairs on it to mismatch.
//
// The check itself is intact and still tested at the verdictFor level in
// ad-studio-verify.test.js. It fires again the moment any format renders paired imagery.
// What must NOT happen is renderTarget demanding pairings from a plate: that is the exact
// shape that once made every Demand Gen plate of a pairing format an unavoidable hard
// fail, 54 renders (~$7) that could not succeed.
{
  const target = { platform: 'meta', ratio: '1:1', mode: 'plate', wantsComp: false };
  const result = await renderTarget({
    gemini: geminiReturning(),
    anthropic: anthropicFailing(0, expectedPlate),
    target, format: pairingFormat, zones, product, brandKit, photoPaths: [],
    expectedFinished, expectedPlate,
  });
  assert.equal(result.ok, true, 'a plate of a pairing format must not be asked for pairings');
  assert.equal(result.proofEntry.attempts, 1, 'and must not burn retries on an impossible demand');
  assert.ok(!result.proofEntry.reasons.some(r => /pairing/i.test(r)));
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
    target: { platform: 'meta', ratio: '1:1', mode: 'plate', wantsComp: false },
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
  // The budget counts GENERATIVE CALLS, and a comp is one: the first target spends one
  // render on its plate and one on the comp derived from it, which exhausts a ceiling of
  // 2 and leaves the other five targets unfunded.
  assert.equal(g.calls(), 2, 'exactly the budget was spent, no more');
  const plates = out.artifacts.filter(a => /-plate-/.test(a.name));
  const comps = out.artifacts.filter(a => /-comp-/.test(a.name));
  const guides = out.artifacts.filter(a => /^guide-/.test(a.name));
  assert.equal(plates.length, 1, 'only the funded target produced a plate');
  assert.equal(comps.length, 1, 'and its comp');
  assert.equal(guides.length, 1, 'a guide ships beside every plate and costs no render');
  assert.equal(out.ok, false, 'a budget-stopped variation is not an accepted one');
  assert.equal(out.skipped.length, PLATFORM_TARGETS.length - 1, 'every dropped artifact is named');
  assert.deepEqual(
    out.skipped,
    ['meta-plate-4x5.png', 'meta-plate-9x16.png', 'demand-gen-plate-1_91x1.png',
     'demand-gen-plate-1x1.png', 'demand-gen-plate-4x5.png'],
  );
  assert.equal(
    Object.keys(out.proofByArtifact).length,
    PLATFORM_TARGETS.length,
    'proof.json must still account for every target, skipped ones included',
  );
  assert.equal(out.proofByArtifact['demand-gen-plate-4x5.png'].skipped, true);
  assert.ok(out.proofByArtifact['demand-gen-plate-4x5.png'].reasons.some(r => /budget/i.test(r)));
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
  // One render per plate, plus one more for each comp derived from an accepted plate.
  const funded = PLATFORM_TARGETS.filter(t => t.ratio !== '1.91:1');
  assert.equal(g.calls(), funded.length + funded.filter(t => t.wantsComp).length);
}

// ── parseArgs: cost flags ───────────────────────────────────────────────────────
{
  // --formats is now REQUIRED, so every invocation below names one. Omitting it used to
  // mean the whole six-format rotation — 108 renders, ~$14, from an untouched flag.
  const F = ['--formats', 'ingredient-callout'];
  const a = parseArgs(['--product', 'coconut-lotion', ...F]);
  assert.equal(a.variations, 1, 'the default run is one variation, not three');
  assert.equal(a.maxRenders, DEFAULT_MAX_RENDERS, 'a run always has a ceiling, flag or no flag');

  assert.equal(parseArgs(['--product', 'x', ...F, '--max-renders', '12']).maxRenders, 12);
  assert.throws(() => parseArgs(['--product', 'x', ...F, '--max-renders', '0']), /--max-renders must be a positive integer/);
  assert.throws(() => parseArgs(['--product', 'x', ...F, '--max-renders', 'lots']), /--max-renders must be a positive integer/);

  // --variations multiplies by the selected targets; unbounded is an unbounded bill.
  assert.throws(() => parseArgs(['--product', 'x', ...F, '--variations', '100']), new RegExp(`--variations must be ${MAX_VARIATIONS} or fewer`));
  assert.equal(parseArgs(['--product', 'x', ...F, '--variations', String(MAX_VARIATIONS)]).variations, MAX_VARIATIONS);
  assert.throws(() => parseArgs(['--product', 'x', ...F, '--variations', '0']), /positive integer/);
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

  // Every NON-volume label string is still demanded back on a prominent format —
  // that half of the rule is untouched by R2b and is what stops a garbled brand mark.
  const prominent = expectedForFormat({ zones: { headline: 'Six Ingredients.' }, format: formatByKey('us-vs-them'), product });
  assert.deepEqual(prominent.finished, ['Six Ingredients.', 'real SKIN CARE'], 'a hero-sized product must still prove its label');
  assert.deepEqual(prominent.plate, ['real SKIN CARE']);

  // ...but the VOLUME is now surfaced for EVERY format, prominent or not. This is the
  // R2 fix: productProminent:false used to strip labelStrings wholesale, so a wrong
  // volume on a small product was not merely un-demanded, it was un-checked — which is
  // how a manifesto frame shipped "4 FL oz / 118ml" on an 8 fl. oz. bottle. Reverting
  // expectedForFormat to gate volumeStrings behind the flag fails here.
  const volumes = product.labelStrings.filter(s => /fl\.?\s*oz/i.test(s));
  assert.ok(volumes.length > 0, 'the fixture must carry a volume marking for this to prove anything');
  assert.deepEqual(nonProminent.volumeStrings, volumes, 'a small-product format must still get the true volume');
  assert.deepEqual(prominent.volumeStrings, volumes);
  // Only volume-shaped strings — the brand mark is not a volume claim.
  assert.ok(!nonProminent.volumeStrings.includes('real SKIN CARE'));
}

// ── R2b: a volume marking NEVER enters the per-string expected set, in either mode ──
// The volume was being asserted twice by two mechanisms of different strictness, and
// they disagreed inside one verdict. Live, us-vs-them/v1/plate-1_91x1.jpg:
//
//   reasons: "8 fl. oz. (236ml)" — not present — that region reads "8 fl. oz - 236ml"
//   volume:  { "status": "match" }
//
// volumeVerdict tolerates the separator by design (the manifest and the bottle print it
// differently); the per-string check demands the literal sequence and fails it. Three
// targets in one run were rejected for carrying a CORRECT volume. Reverting the
// subtraction in expectedForFormat fails here.
{
  const volumeShaped = s => /fl\.?\s*oz/i.test(s) || /\d\s*m\s*l\b/i.test(s);
  const multiVolumeProduct = {
    ...product,
    labelStrings: ['real SKIN CARE', 'moisturizing body lotion', '8 fl. oz. (236ml)', '236ml'],
  };

  for (const key of ['us-vs-them', 'ingredient-callout', 'offer-focused', 'manifesto', 'problem-aware', 'top-x-review']) {
    const f = formatByKey(key);
    const out = expectedForFormat({
      zones: { headline: 'Six Ingredients.' }, format: f, product: multiVolumeProduct,
    });
    for (const mode of ['finished', 'plate']) {
      for (const s of out[mode]) {
        assert.ok(!volumeShaped(s), `${key}/${mode}: volume string "${s}" must not be in the expected set`);
        assert.ok(!out.volumeStrings.includes(s), `${key}/${mode}: "${s}" is checked by volumeVerdict already`);
      }
    }
    // ...and every volume marking is still handed to volumeVerdict, on every format.
    assert.deepEqual(out.volumeStrings, ['8 fl. oz. (236ml)', '236ml'], `${key}: the volume is still checked`);
    // Non-volume label strings survive untouched where the product is legible.
    if (f.productProminent) {
      assert.deepEqual(out.plate, ['real SKIN CARE', 'moisturizing body lotion'], `${key}: non-volume label strings must survive`);
    }
  }
}

// ── R2b end to end: a matching volume with a different separator must now PASS ──────
// The exact live shape — a plate whose only "missing" string was the volume, quoted
// back as "8 fl. oz - 236ml" against a manifest that writes "8 fl. oz. (236ml)".
{
  const prominentFormat = formatByKey('us-vs-them');
  const { finished: eFinished, plate: ePlate, volumeStrings } = expectedForFormat({
    zones: { headline: 'Six Ingredients.' }, format: prominentFormat, product,
  });
  const anthropicSeparatorVolume = {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify({
          checks: ePlate.map(e => ({ expected: e, found: true, rendered: e })),
          productVolume: '8 fl. oz - 236ml',
          defects: [],
          transcript: [...ePlate, '8 fl. oz - 236ml'],
        }) }],
      }),
    },
  };
  const result = await renderTarget({
    gemini: geminiReturning(),
    anthropic: anthropicSeparatorVolume,
    // 1:1 rather than the live frame's 1.91:1 purely so no crop runs: cropToRatio needs
    // real image bytes and this suite's stubs are magic-byte fakes.
    target: { platform: 'demand-gen', ratio: '1:1', mode: 'plate' },
    format: prominentFormat, zones, product, brandKit, photoPaths: [],
    expectedFinished: eFinished, expectedPlate: ePlate, volumeStrings,
  });
  assert.equal(result.ok, true, 'a volume differing only by separator must pass');
  assert.equal(result.proofEntry.volume.status, 'match');
  assert.deepEqual(result.proofEntry.missing, [], 'and must not be reported missing by the per-string check');
  assert.equal(result.proofEntry.attempts, 1, 'and must not burn retries proving a correct volume');
}

// ── The volume is threaded all the way to the verdict, and a WRONG one fails ─────
// End-to-end proof that R2 is wired, not just implemented: a manifesto (productProminent
// false) finished frame whose ad copy is perfect but whose bottle reads 4 fl oz must be
// rejected, and must burn its retries trying rather than shipping.
{
  const manifestoProduct = { ...product, labelStrings: ['real SKIN CARE', '8 fl. oz. (236ml)'] };
  const { finished: mFinished, plate: mPlate, volumeStrings } = expectedForFormat({
    zones: { headline: 'Six Ingredients.' }, format, product: manifestoProduct,
  });
  assert.deepEqual(mFinished, ['Six Ingredients.'], 'manifesto demands no label strings back');

  const anthropicWrongVolume = {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify({
          checks: mFinished.map(e => ({ expected: e, found: true, rendered: e })),
          productVolume: '4 FL oz / 118ml',
          defects: [],
          transcript: mFinished,
        }) }],
      }),
    },
  };
  const result = await renderTarget({
    gemini: geminiReturning(),
    anthropic: anthropicWrongVolume,
    target: { platform: 'meta', ratio: '1:1', mode: 'plate', wantsComp: false },
    format, zones, product: manifestoProduct, brandKit, photoPaths: [],
    expectedFinished: mFinished, expectedPlate: mPlate, volumeStrings,
  });
  assert.equal(result.ok, false, 'a contradicted volume must fail even where the label is not demanded back');
  assert.equal(result.proofEntry.volume.status, 'mismatch');
  assert.ok(result.proofEntry.reasons.some(r => /volume marking is WRONG/i.test(r)));
  assert.equal(result.proofEntry.attempts, 3, 'and must spend its retries trying to get a correct one');
}

// ...and an ILLEGIBLE volume on that same format passes, which is the legitimate case
// productProminent was created for. A gate that fails everything is as useless as one
// that passes everything.
{
  const manifestoProduct = { ...product, labelStrings: ['real SKIN CARE', '8 fl. oz. (236ml)'] };
  const { finished: mFinished, plate: mPlate, volumeStrings } = expectedForFormat({
    zones: { headline: 'Six Ingredients.' }, format, product: manifestoProduct,
  });
  const anthropicIllegible = {
    messages: {
      create: async (params) => ({
        content: [{ type: 'text', text: isCritiqueRequest(params) ? critiqueReply() : JSON.stringify({
          checks: mFinished.map(e => ({ expected: e, found: true, rendered: e })),
          productVolume: 'ILLEGIBLE',
          defects: [],
          transcript: mFinished,
        }) }],
      }),
    },
  };
  const result = await renderTarget({
    gemini: geminiReturning(),
    anthropic: anthropicIllegible,
    target: { platform: 'meta', ratio: '1:1', mode: 'plate', wantsComp: false },
    format, zones, product: manifestoProduct, brandKit, photoPaths: [],
    expectedFinished: mFinished, expectedPlate: mPlate, volumeStrings,
  });
  assert.equal(result.ok, true, 'a product rendered too small to read must still be able to pass');
  assert.equal(result.proofEntry.attempts, 1);
}

// ── R3 is wired: reported occlusion fails the target and reaches proof.json ──────
{
  const anthropicOccluded = {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify({
          checks: expectedFinished.map(e => ({ expected: e, found: true, rendered: e })),
          productVolume: 'ILLEGIBLE',
          defects: [{ text: 'actually', issue: 'obscured', detail: 'the bottle sits on top of this word' }],
          transcript: expectedFinished,
        }) }],
      }),
    },
  };
  const result = await renderTarget({
    gemini: geminiReturning(),
    anthropic: anthropicOccluded,
    target: { platform: 'meta', ratio: '1:1', mode: 'plate', wantsComp: false },
    format, zones, product, brandKit, photoPaths: [],
    expectedFinished, expectedPlate,
  });
  assert.equal(result.ok, false, 'text covered by the product must fail the render');
  assert.deepEqual(result.proofEntry.defects, [
    { text: 'actually', issue: 'obscured', detail: 'the bottle sits on top of this word' },
  ]);
}

// ── R1 is wired: proof.json records what each region ACTUALLY reads ──────────────
// v1's proof.json held only an auto-corrected transcript, so a human reading a failure
// could not see the corruption. checkDetails is what makes a rejection actionable.
{
  const anthropicCorrupted = {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: JSON.stringify({
          // The live shape: the model claims the string is present while quoting text
          // that proves it is not. The quoted text falsifies the claim.
          checks: expectedFinished.map(e => ({ expected: e, found: true, rendered: 'TTHAN THE FORMLA' })),
          productVolume: 'ILLEGIBLE',
          defects: [],
          transcript: expectedFinished,   // <- the auto-corrected transcript v1 trusted
        }) }],
      }),
    },
  };
  const result = await renderTarget({
    gemini: geminiReturning(),
    anthropic: anthropicCorrupted,
    target: { platform: 'meta', ratio: '1:1', mode: 'plate', wantsComp: false },
    format, zones, product, brandKit, photoPaths: [],
    expectedFinished, expectedPlate,
  });
  assert.equal(result.ok, false, 'a clean transcript must not overturn a falsified per-string check');
  assert.ok(result.proofEntry.checkDetails.some(d => /TTHAN THE FORMLA/.test(d.reason)));
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

// ── Stage 5b after the plate-first change: nothing fails on layout any more ─────────
//
// PR #486 made the safe zone a hard fail and PR #488 measured it failing 6 of 6 vertical
// frames — correctly, because every layoutBrief runs a headline to the frame edge and the
// image model fills the frame whatever the prompt says.
//
// That whole conflict dissolves once the shipping artifact is a text-free plate. A plate
// has no copy to place badly, so the safe zone cannot fail it; the bands ship as a guide
// SVG and the operator sets type against them by hand. The comp still gets an opinion,
// because the 1-5 score is what the ranking and the baseline are built on — but it can
// never fail anything, since retrying a comp buys a differently-imperfect comp at $0.13
// and the plate it came from has already been accepted.
{
  const zonesX = { headline: 'Six Ingredients.' };
  const { finished: fx, plate: px, volumeStrings: vx } = expectedForFormat({
    zones: zonesX, format, product,
  });

  // A 9:16 plate renders and passes. This is the exact target that could not succeed
  // before, at three paid attempts every time.
  const aVert = anthropicFailing(0, px, { safeZone: 'VIOLATION' });
  const vert = await renderTarget({
    gemini: geminiReturning(), anthropic: aVert,
    target: { platform: 'meta', ratio: '9:16', mode: 'plate', wantsComp: false },
    format, zones: zonesX, product, brandKit, photoPaths: [],
    expectedFinished: fx, expectedPlate: px, volumeStrings: vx,
  });
  assert.equal(vert.ok, true, 'a 9:16 plate must render — it carries no copy to misplace');
  assert.equal(vert.proofEntry.attempts, 1, 'and must not burn retries on a check it cannot fail');
  assert.equal(aVert.critiques(), 0, 'a plate is never art-directed');

  // Every plate ships with its safe-zone guide, and the guide costs no render.
  assert.ok(vert.extras.some(e => e.name === 'guide-9x16.svg'), 'the safe zone ships as a guide');
  const guide = vert.extras.find(e => e.name === 'guide-9x16.svg').buffer.toString('utf8');
  assert.ok(/SAFE ZONE/.test(guide));
  assert.ok(/Platform UI covers this band/.test(guide), '9:16 guide must mark the UI bands');

  // A feed ratio gets a guide too, but a plain bleed margin rather than platform bands —
  // nothing is drawn over a feed image.
  const sq = await renderTarget({
    gemini: geminiReturning(), anthropic: anthropicFailing(0, px),
    target: { platform: 'meta', ratio: '1:1', mode: 'plate', wantsComp: false },
    format, zones: zonesX, product, brandKit, photoPaths: [],
    expectedFinished: fx, expectedPlate: px, volumeStrings: vx,
  });
  const sqGuide = sq.extras.find(e => e.name === 'guide-1x1.svg').buffer.toString('utf8');
  assert.ok(!/Platform UI covers this band/.test(sqGuide), 'no platform bands on a feed ratio');
}
