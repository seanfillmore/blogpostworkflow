import { strict as assert } from 'node:assert';
import {
  buildVerifyPrompt,
  parseVerifyResponse,
  diffTranscript,
  verdictFor,
} from '../../agents/ad-studio/verify.js';
import { formatByKey } from '../../agents/ad-studio/formats.js';

const pairingFormat = formatByKey('ingredient-callout');   // pairsImagesWithLabels: true
const plainFormat = formatByKey('manifesto');              // pairsImagesWithLabels: false

// buildVerifyPrompt lists every expected string and only asks about pairing when it applies.
const p1 = buildVerifyPrompt({ expected: ['SIX INGREDIENTS.', 'ORGANIC JOJOBA'], format: pairingFormat });
assert.ok(p1.includes('SIX INGREDIENTS.'));
assert.ok(p1.includes('ORGANIC JOJOBA'));
assert.ok(/pairings/.test(p1), 'pairing format must request pairings');
const p2 = buildVerifyPrompt({ expected: ['OUR LOTION'], format: plainFormat });
assert.ok(!/pairings/.test(p2), 'non-pairing format must not request pairings');

// parseVerifyResponse handles fenced JSON and defaults pairings to an empty array.
const raw = '```json\n' + JSON.stringify({
  transcript: ['SIX INGREDIENTS.', 'ORGANIC JOJOBA'],
  pairings: [{ label: 'ORGANIC JOJOBA', depicts: 'jojoba oil and seeds', matches: true }],
}) + '\n```';
const parsedV = parseVerifyResponse(raw);
assert.deepEqual(parsedV.transcript, ['SIX INGREDIENTS.', 'ORGANIC JOJOBA']);
assert.equal(parsedV.pairings.length, 1);
assert.deepEqual(parseVerifyResponse(JSON.stringify({ transcript: ['A'] })).pairings, []);
assert.throws(() => parseVerifyResponse('junk'), /ad-studio.*verify/i);

// diffTranscript: exact match passes.
assert.deepEqual(diffTranscript(['A', 'B'], ['A', 'B']), { ok: true, missing: [] });

// Case, whitespace and curly punctuation differences do NOT count as failures.
assert.equal(diffTranscript(["THAT'S IT"], ['that’s   it']).ok, true);

// A corrupted glyph run is missing.
const corrupted = diffTranscript(['THE REAL WAY', 'Lauric acid kills odor bacteria'], ['THE RLALVJAY', 'Lauric acid klls odor bactera']);
assert.equal(corrupted.ok, false);
assert.equal(corrupted.missing.length, 2);

// A silently REWRITTEN bottom-bar string must still fail. Every glyph is spelled
// correctly and the layout looks right; the words are simply not the ones that were
// claim-gated. This is the defect the gate exists for — the run-boundary relaxation
// below must not reach it.
assert.equal(diffTranscript(['No parabens'], ['No sulfates']).ok, false);
assert.deepEqual(diffTranscript(['No parabens'], ['No sulfates']).missing, ['No parabens']);

// Run-boundary relaxation. The vision model reports a single visual lockup as separate
// runs; the text IS present and correct, so this must PASS.
assert.equal(diffTranscript(['real SKIN CARE'], ['real', 'SKIN CARE']).ok, true);
assert.equal(
  diffTranscript(['Organic Coconut Oil + Essential Oils'], ['ORGANIC COCONUT OIL', '+', 'ESSENTIAL OILS']).ok,
  true,
);
// The real live case: the badge's "+" sits on a curved arc and the transcriber drops it
// entirely, reporting only the two ingredient runs. The label is correct; this must pass.
assert.equal(
  diffTranscript(['Organic Coconut Oil + Essential Oils'], ['ORGANIC COCONUT OIL', 'ESSENTIAL OILS']).ok,
  true,
);
// A duplicated word is a REAL render defect (the 9x16 frame of the live run stuttered
// "sink sink") and must still fail — the relaxations must not reach it.
assert.equal(
  diffTranscript(['Cold-pressed coconut and jojoba that sink into skin.'],
                 ['Cold-pressed coconut and jojoba that sink sink into skin.']).ok,
  false,
);

// Separator glyphs fold: the bottle prints "•", the manifest prose writes "( )".
assert.equal(diffTranscript(['8 fl. oz. (236ml)'], ['8 fl. oz. • 236ml']).ok, true);
// ...and the same string split across runs on that separator.
assert.equal(diffTranscript(['8 fl. oz. (236ml)'], ['8 fl. oz.', '•', '236ml']).ok, true);

// Relaxing run boundaries must NOT relax ordering: reversed runs are still missing.
assert.equal(diffTranscript(['real SKIN CARE'], ['SKIN CARE', 'real']).ok, false);
// Nor may it bridge NON-consecutive runs — an expected string cannot be assembled out
// of fragments that have other text between them.
assert.equal(diffTranscript(['real SKIN CARE'], ['real', 'BODY LOTION', 'SKIN CARE']).ok, false);
// Nor may it accept a partially-corrupted lockup.
assert.equal(diffTranscript(['real SKIN CARE'], ['real', 'SKN CARE']).ok, false);

// Extra text in the render does not fail the diff — only missing expected strings do.
assert.equal(diffTranscript(['A'], ['A', 'SOMETHING EXTRA']).ok, true);

// verdictFor: all good.
const good = verdictFor({
  expected: ['SIX INGREDIENTS.', 'ORGANIC JOJOBA'],
  transcript: ['SIX INGREDIENTS.', 'ORGANIC JOJOBA'],
  pairings: [{ label: 'ORGANIC JOJOBA', depicts: 'jojoba seeds', matches: true }],
  format: pairingFormat,
});
assert.equal(good.ok, true);
assert.deepEqual(good.reasons, []);

// verdictFor: text is perfect but a picture is captioned wrongly — must FAIL.
// This is the probe-3 two-pass failure; a text-only gate passes it.
const misPaired = verdictFor({
  expected: ['ORGANIC JOJOBA', 'COLD-PRESSED VIRGIN COCONUT OIL'],
  transcript: ['ORGANIC JOJOBA', 'COLD-PRESSED VIRGIN COCONUT OIL'],
  pairings: [
    { label: 'COLD-PRESSED VIRGIN COCONUT OIL', depicts: 'a dish of golden jojoba oil', matches: false },
    { label: 'ORGANIC JOJOBA', depicts: 'a spoon of red palm oil', matches: false },
  ],
  format: pairingFormat,
});
assert.equal(misPaired.ok, false);
assert.equal(misPaired.mismatchedPairs.length, 2);
assert.ok(misPaired.reasons.some(r => /pairing/i.test(r)));

// The pairing check is independent of the run-boundary relaxation: a transcript whose
// text now passes the diff BECAUSE it was split across runs must still fail on pairing.
const misPairedSplitRuns = verdictFor({
  expected: ['ORGANIC JOJOBA', 'COLD-PRESSED VIRGIN COCONUT OIL'],
  transcript: ['ORGANIC', 'JOJOBA', 'COLD-PRESSED', 'VIRGIN COCONUT OIL'],
  pairings: [{ label: 'ORGANIC JOJOBA', depicts: 'a spoon of red palm oil', matches: false }],
  format: pairingFormat,
});
assert.deepEqual(misPairedSplitRuns.missing, [], 'split runs must not be reported missing');
assert.equal(misPairedSplitRuns.ok, false);
assert.equal(misPairedSplitRuns.mismatchedPairs.length, 1);

// A pairing format that reports no pairings at all cannot silently pass.
const noPairings = verdictFor({
  expected: ['ORGANIC JOJOBA'],
  transcript: ['ORGANIC JOJOBA'],
  pairings: [],
  format: pairingFormat,
});
assert.equal(noPairings.ok, false);
assert.ok(noPairings.reasons.some(r => /no pairings reported/i.test(r)));

// A non-pairing format ignores pairings entirely.
const plain = verdictFor({ expected: ['A'], transcript: ['A'], pairings: [], format: plainFormat });
assert.equal(plain.ok, true);

// Missing text fails and names what is missing.
const missing = verdictFor({ expected: ['A', 'B'], transcript: ['A'], pairings: [], format: plainFormat });
assert.equal(missing.ok, false);
assert.deepEqual(missing.missing, ['B']);

// Task 2's suite pinned only ingredient-callout/us-vs-them/manifesto. Pin the rest:
// a silent flip of any of these would disable or wrongly enable the pairing check.
assert.equal(formatByKey('problem-aware').pairsImagesWithLabels, false);
assert.equal(formatByKey('top-x-review').pairsImagesWithLabels, false);
assert.equal(formatByKey('offer-focused').pairsImagesWithLabels, false);
