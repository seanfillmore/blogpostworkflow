import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { renderWithRetry, renderTarget, buildRunReport, slugify, buildLabelStrings, sniffImageMediaType } from '../../agents/ad-studio/index.js';
import { formatByKey } from '../../agents/ad-studio/formats.js';

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

// slugify
assert.equal(slugify('SIX INGREDIENTS. That’s the whole list!'), 'six-ingredients-thats-the-whole-list');
assert.equal(slugify('  Multiple   Spaces  '), 'multiple-spaces');

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
