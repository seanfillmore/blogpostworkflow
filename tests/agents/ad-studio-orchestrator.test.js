import { strict as assert } from 'node:assert';
import { renderWithRetry, buildRunReport, slugify, buildLabelStrings, sniffImageMediaType } from '../../agents/ad-studio/index.js';
import { formatByKey } from '../../agents/ad-studio/formats.js';

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
