import { strict as assert } from 'node:assert';
import {
  buildVerifyPrompt,
  parseVerifyResponse,
  diffTranscript,
  evaluateChecks,
  readVolume,
  selectVolumeStrings,
  volumeVerdict,
  normalizeDefects,
  verdictFor,
} from '../../agents/ad-studio/verify.js';
import { formatByKey } from '../../agents/ad-studio/formats.js';
import { CREATIVE_MODELS } from '../../config/creative-models.js';

const pairingFormat = formatByKey('ingredient-callout');   // pairsImagesWithLabels: true
const plainFormat = formatByKey('manifesto');              // pairsImagesWithLabels: false

// A clean set of per-string checks: every string found, quoted back exactly as asked.
function cleanChecks(expected) {
  return expected.map(e => ({ expected: e, found: true, rendered: e }));
}

// ── buildVerifyPrompt ───────────────────────────────────────────────────────────
// Lists every expected string and only asks about pairing when it applies.
const p1 = buildVerifyPrompt({ expected: ['SIX INGREDIENTS.', 'ORGANIC JOJOBA'], format: pairingFormat });
assert.ok(p1.includes('SIX INGREDIENTS.'));
assert.ok(p1.includes('ORGANIC JOJOBA'));
assert.ok(/pairings/.test(p1), 'pairing format must request pairings');
const p2 = buildVerifyPrompt({ expected: ['OUR LOTION'], format: plainFormat });
assert.ok(!/pairings/.test(p2), 'non-pairing format must not request pairings');
// A PLATE is text-free by construction, so it carries no labels — asking a pairing
// format's plate for pairings can only produce noise.
const p3 = buildVerifyPrompt({ expected: ['8 fl. oz. (236ml)'], format: pairingFormat, mode: 'plate' });
assert.ok(!/pairings/.test(p3), 'a plate must not be asked for pairings even on a pairing format');
const p4 = buildVerifyPrompt({ expected: ['SIX INGREDIENTS.'], format: pairingFormat, mode: 'finished' });
assert.ok(/pairings/.test(p4), 'a finished frame of a pairing format must still request pairings');

// ── R1: the prompt asks a POINTED question per string, not for an open transcript ──
// v1 asked "transcribe everything" and then searched the transcript. A vision model
// reading text semantically REPAIRS misspellings on the way out — it reported FORMULA
// where the pixels said FORMLA — so the gate was blind to exactly the corruption class
// it exists to catch. Reverting the prompt to a transcript-first request fails here.
assert.ok(/"checks"/.test(p2), 'the response schema must be driven by per-string checks');
assert.ok(/"found"/.test(p2), 'each string needs an explicit yes/no');
assert.ok(/"rendered"/.test(p2), 'and the literal text of that region when the answer is no');
assert.ok(
  /glyph by glyph/i.test(p2),
  'the prompt must demand a pixel-level read, not a semantic one',
);
// The transcript survives ONLY as secondary diagnostic output.
assert.ok(/"transcript"/.test(p2), 'a transcript is still collected for the proof file');

// ── R2: the volume is asked for on EVERY format, prominent or not ───────────────
// manifesto is productProminent:false. v1 dropped labelStrings wholesale there, so a
// wrong volume was not merely un-demanded, it was un-checked.
assert.ok(/ILLEGIBLE/.test(p2), 'the verifier must be given an explicit "cannot read it" answer');
assert.ok(/productVolume/.test(p2), 'and must be asked for the volume even on a small-product format');

// ── R3: the prompt asks about occlusion and truncation ──────────────────────────
assert.ok(/obscured/.test(p2) && /cut-off/.test(p2), 'occluded and cut-off text must be asked about');
assert.ok(/garbled/.test(p2), 'and garbled glyph runs too');
// ...but scoped to the AD'S copy. Asking about every glyph in the frame made the
// verifier report the bottle's arc-set badge micro-copy on a KNOWN-GOOD control
// ("ORGANIC COCOHUT OIL", "hard to fully confirm") and reject it — the same
// un-transcribable micro-copy that buildLabelStrings already excludes for the same
// reason, and the same failure mode that cost five fix rounds before. A gate that
// fails everything is as useless as one that passes everything.
assert.ok(
  /PRODUCT'S OWN LABEL/.test(p2),
  'the defect check must exclude micro-copy printed on the product itself',
);
assert.ok(
  /merely small, soft or low-resolution/.test(p2),
  'and must not accept "I cannot fully confirm this" as a defect',
);

// ── The verify model is Sonnet, not Haiku ───────────────────────────────────────
// Haiku auto-corrected "TTHAN"/"FORMLA" into clean text and passed the ad on attempt 1.
assert.equal(CREATIVE_MODELS.adStudio.verify, 'claude-sonnet-5');

// ── parseVerifyResponse ─────────────────────────────────────────────────────────
// Handles fenced JSON; defaults the optional fields; REQUIRES checks.
const raw = '```json\n' + JSON.stringify({
  checks: [{ expected: 'SIX INGREDIENTS.', found: true, rendered: 'SIX INGREDIENTS.' }],
  productVolume: '8 fl. oz. (236ml)',
  defects: [],
  transcript: ['SIX INGREDIENTS.', 'ORGANIC JOJOBA'],
  pairings: [{ label: 'ORGANIC JOJOBA', depicts: 'jojoba oil and seeds', matches: true }],
}) + '\n```';
const parsedV = parseVerifyResponse(raw);
assert.deepEqual(parsedV.transcript, ['SIX INGREDIENTS.', 'ORGANIC JOJOBA']);
assert.equal(parsedV.checks.length, 1);
assert.equal(parsedV.productVolume, '8 fl. oz. (236ml)');
assert.equal(parsedV.pairings.length, 1);
assert.deepEqual(parseVerifyResponse(JSON.stringify({ checks: [] })).pairings, []);
assert.deepEqual(parseVerifyResponse(JSON.stringify({ checks: [] })).defects, []);
assert.deepEqual(parseVerifyResponse(JSON.stringify({ checks: [] })).transcript, []);
assert.throws(() => parseVerifyResponse('junk'), /ad-studio.*verify/i);
// A response with a transcript but NO checks cannot be scored — v1's shape must not
// parse into a silent all-clear.
assert.throws(
  () => parseVerifyResponse(JSON.stringify({ transcript: ['A'] })),
  /checks/i,
  'a transcript-only response is no longer scoreable and must throw',
);

// ── diffTranscript — unchanged matching rules, now used to falsify the model ─────
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

// ── Token-boundary anchoring ────────────────────────────────────────────────────
// An unanchored String.includes accepted a SUPERSTRING, which is the worst false pass
// this gate can produce: a render printing "18 fl. oz." on the 8 fl oz bottle shipped a
// false spec through the one gate that exists to stop invented specs.
assert.equal(
  diffTranscript(['8 fl. oz. (236ml)'], ['18 fl. oz. • 236ml']).ok,
  false,
  'an invented volume that CONTAINS the expected one must fail',
);
assert.equal(
  diffTranscript(['2 fl oz (60ml)'], ['12 fl oz 60ml']).ok,
  false,
  '"12 fl oz 60ml" is not "2 fl oz (60ml)"',
);
assert.equal(
  diffTranscript(['real SKIN CARE'], ['unreal SKIN CARE']).ok,
  false,
  'a prefixed token is a different word, not a match',
);
// ...and the same anchoring must hold when the superstring is assembled across runs.
assert.equal(diffTranscript(['8 fl. oz. (236ml)'], ['18 fl. oz.', '236ml']).ok, false);

// Anchoring must NOT cost any of the relaxations the gate needs to accept correct
// renders. Each of these still passes.
assert.equal(diffTranscript(['real SKIN CARE'], ['real', 'SKIN CARE']).ok, true);
assert.equal(diffTranscript(['8 fl. oz. (236ml)'], ['8 fl. oz. • 236ml']).ok, true);
assert.equal(diffTranscript(['8 fl. oz. (236ml)'], ['8 FL. OZ.', '(236ML)']).ok, true);
assert.equal(diffTranscript(["THAT'S IT"], ['that’s   it']).ok, true);
// Dropped and substituted words must still fail — this is not per-word or fuzzy matching.
assert.equal(diffTranscript(['No parabens'], ['No sulfates']).ok, false);
assert.equal(diffTranscript(['THE REAL WAY'], ['THE RLALVJAY']).ok, false);

// ── evaluateChecks — the verdict driver (R1) ────────────────────────────────────
// Clean: every string answered yes and quoted back correctly.
assert.deepEqual(evaluateChecks(['A', 'B'], cleanChecks(['A', 'B'])).missing, []);

// A flat "no" is missing, and the reason carries what that region ACTUALLY reads —
// the thing v1's proof.json could never record.
{
  const r = evaluateChecks(
    ['THE MOISTURIZING CLAIM DOES MORE WORK THAN THE FORMULA'],
    [{
      expected: 'THE MOISTURIZING CLAIM DOES MORE WORK THAN THE FORMULA',
      found: false,
      rendered: 'THE MOISTURIZING CLAIM DOES MORE WORK TTHAN THE FORMLA',
    }],
  );
  assert.equal(r.missing.length, 1);
  assert.match(r.details[0].reason, /TTHAN THE FORMLA/, 'the corrupted glyphs must reach the proof file');
}

// THE CENTREPIECE OF R1: a "yes" is not taken on trust. The model may still auto-correct
// its yes/no answer, so its OWN quoted `rendered` text is re-run through the token-
// anchored match — and a yes whose quoted text does not contain the expected string is
// treated as a no. The live failure had exactly this shape.
{
  const r = evaluateChecks(
    ['THE MOISTURIZING CLAIM DOES MORE WORK THAN THE FORMULA'],
    [{
      expected: 'THE MOISTURIZING CLAIM DOES MORE WORK THAN THE FORMULA',
      found: true,                                                        // <- the lie
      rendered: 'THE MOISTURIZING CLAIM DOES MORE WORK TTHAN THE FORMLA', // <- the truth
    }],
  );
  assert.equal(r.missing.length, 1, 'a "found: true" contradicted by its own quoted text must not pass');
  assert.match(r.details[0].reason, /reported present, but the text quoted/);
}

// Fail-closed: an expected string the verifier simply did not answer for is missing.
// A model that skips the awkward string must not thereby pass it.
assert.deepEqual(evaluateChecks(['A', 'B'], cleanChecks(['A'])).missing, ['B']);
assert.deepEqual(evaluateChecks(['A'], []).missing, ['A']);
assert.deepEqual(evaluateChecks(['A'], undefined).missing, ['A']);

// Fail-closed: "found: true" with nothing quoted is unfalsifiable, and an unfalsifiable
// pass is what this rebuild exists to remove.
{
  const r = evaluateChecks(['A'], [{ expected: 'A', found: true, rendered: '' }]);
  assert.deepEqual(r.missing, ['A']);
  assert.match(r.details[0].reason, /quoted no rendered text/);
}

// The relaxations the gate NEEDS still hold through the check path: a lockup quoted as
// one region, separator differences, and case/whitespace differences all pass.
assert.deepEqual(
  evaluateChecks(['real SKIN CARE'], [{ expected: 'real SKIN CARE', found: true, rendered: 'real\nSKIN CARE' }]).missing,
  [],
  'a label split across visual runs but quoted as one region must pass',
);
assert.deepEqual(
  evaluateChecks(['8 fl. oz. (236ml)'], [{ expected: '8 fl. oz. (236ml)', found: true, rendered: '8 FL. OZ. • 236ML' }]).missing,
  [],
  'separator and case differences must not fail a correct render',
);

// The substituted-word and superstring regressions, expressed through the check path.
assert.deepEqual(
  evaluateChecks(['No parabens'], [{ expected: 'No parabens', found: true, rendered: 'No sulfates' }]).missing,
  ['No parabens'],
);
assert.deepEqual(
  evaluateChecks(['8 fl. oz. (236ml)'], [{ expected: '8 fl. oz. (236ml)', found: true, rendered: '18 fl. oz. • 236ml' }]).missing,
  ['8 fl. oz. (236ml)'],
  'a superstring volume must fail through the check path too',
);

// Checks are matched by normalized expected text, so re-typed punctuation still lines up.
assert.deepEqual(
  evaluateChecks(["THAT'S IT"], [{ expected: 'that’s it', found: true, rendered: "THAT'S IT" }]).missing,
  [],
);
// ...and fall back to position when the model returned one check per string, in order,
// but re-worded the `expected` field.
assert.deepEqual(
  evaluateChecks(['A', 'B'], [
    { expected: 'first string', found: true, rendered: 'A' },
    { expected: 'second string', found: true, rendered: 'B' },
  ]).missing,
  [],
);

// A pure-punctuation expectation is unverifiable either way and must not be a failure.
assert.deepEqual(evaluateChecks(['...'], []).missing, []);

// ── Volume: illegible passes, wrong FAILS (R2) ──────────────────────────────────
assert.deepEqual(readVolume('8 fl. oz. (236ml)'), { oz: 8, ml: 236 });
assert.deepEqual(readVolume('4 FL oz / 118ml'), { oz: 4, ml: 118 });
assert.deepEqual(readVolume('real SKIN CARE'), { oz: null, ml: null });
assert.deepEqual(selectVolumeStrings(['real SKIN CARE', '8 fl. oz. (236ml)', 'coconut breeze']), ['8 fl. oz. (236ml)']);

const TRUE_VOLUME = ['8 fl. oz. (236ml)'];

// The legitimate small-product case — the whole reason productProminent existed.
assert.equal(volumeVerdict('ILLEGIBLE', TRUE_VOLUME).ok, true);
assert.equal(volumeVerdict('illegible', TRUE_VOLUME).ok, true);
assert.equal(volumeVerdict('not visible', TRUE_VOLUME).ok, true);
assert.equal(volumeVerdict('', TRUE_VOLUME).ok, true);
assert.equal(volumeVerdict('ILLEGIBLE', TRUE_VOLUME).status, 'illegible');

// A correct read passes, through every punctuation the label and the model might use.
assert.equal(volumeVerdict('8 fl. oz. (236ml)', TRUE_VOLUME).ok, true);
assert.equal(volumeVerdict('8 FL OZ • 236 ML', TRUE_VOLUME).ok, true);
// Half a read is still a correct read: the ml marking can be turned away from camera.
assert.equal(volumeVerdict('8 fl oz', TRUE_VOLUME).ok, true);

// THE R2 FAILURE, live: the render printed a volume off a different SKU entirely and
// productProminent:false meant nothing looked at it.
{
  const v = volumeVerdict('4 FL oz / 118ml', TRUE_VOLUME);
  assert.equal(v.ok, false, 'a volume that contradicts the product must FAIL');
  assert.equal(v.status, 'mismatch');
}
assert.equal(volumeVerdict('18 fl. oz. • 236ml', TRUE_VOLUME).ok, false, 'an inflated ounce count must fail');
assert.equal(volumeVerdict('8 fl. oz. (118ml)', TRUE_VOLUME).ok, false, 'a contradicted ml count must fail on its own');

// Nothing on file to compare against is not a failure — there is no claim to falsify.
assert.equal(volumeVerdict('6 fl oz', []).ok, true);
assert.equal(volumeVerdict('6 fl oz', ['real SKIN CARE']).ok, true);
// Text with no volume number in it is another flavour of "could not read it".
assert.equal(volumeVerdict('the label is turned away', TRUE_VOLUME).ok, true);

// ── Defects: occluded, cut-off and garbled text (R3) ────────────────────────────
assert.deepEqual(normalizeDefects([]), []);
assert.deepEqual(normalizeDefects(undefined), []);
// An entry with no text carries nothing a human could act on and is not a failure.
assert.deepEqual(normalizeDefects([{ issue: 'obscured' }, { text: '   ' }]), []);
{
  const d = normalizeDefects([{ text: 'actually', issue: 'OBSCURED', detail: 'covered by the bottle' }]);
  assert.deepEqual(d, [{ text: 'actually', issue: 'obscured', detail: 'covered by the bottle' }]);
}
assert.equal(normalizeDefects([{ text: 'x', issue: 'weird' }])[0].issue, 'unspecified');

// ── verdictFor ──────────────────────────────────────────────────────────────────
// All good.
const good = verdictFor({
  expected: ['SIX INGREDIENTS.', 'ORGANIC JOJOBA'],
  checks: cleanChecks(['SIX INGREDIENTS.', 'ORGANIC JOJOBA']),
  productVolume: '8 fl. oz. (236ml)',
  volumeStrings: TRUE_VOLUME,
  defects: [],
  transcript: ['SIX INGREDIENTS.', 'ORGANIC JOJOBA'],
  pairings: [{ label: 'ORGANIC JOJOBA', depicts: 'jojoba seeds', matches: true }],
  format: pairingFormat,
});
assert.equal(good.ok, true);
assert.deepEqual(good.reasons, []);

// R1 end to end: the live manifesto frame. Every glyph the model quoted back is wrong
// in exactly the way the image was wrong, and the verdict must be ok:false.
{
  const v = verdictFor({
    expected: ['THE MOISTURIZING CLAIM DOES MORE WORK THAN THE FORMULA'],
    checks: [{
      expected: 'THE MOISTURIZING CLAIM DOES MORE WORK THAN THE FORMULA',
      found: false,
      rendered: 'THE MOISTURIZING CLAIM DOES MORE WORK TTHAN THE FORMLA',
    }],
    productVolume: 'ILLEGIBLE',
    volumeStrings: TRUE_VOLUME,
    format: plainFormat,
  });
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some(r => /TTHAN THE FORMLA/.test(r)), 'the verdict must name the corrupted text');
}

// R2 end to end on a productProminent:false format — the exact live shape. The ad copy
// is perfect and there are no expected label strings at all, and it must STILL fail on
// a contradicted volume.
{
  const v = verdictFor({
    expected: ['Six ingredients that actually absorb into skin.'],
    checks: cleanChecks(['Six ingredients that actually absorb into skin.']),
    productVolume: '4 FL oz / 118ml',
    volumeStrings: TRUE_VOLUME,
    format: plainFormat,   // manifesto — productProminent: false
  });
  assert.equal(v.ok, false, 'a wrong volume must fail even where the label is not demanded back');
  assert.ok(v.reasons.some(r => /volume marking is WRONG/i.test(r)));
  assert.ok(v.reasons.some(r => /4 FL oz \/ 118ml/.test(r)));
  assert.equal(v.volume.status, 'mismatch');
}
// ...and the same format with an unreadable volume passes, which is why the flag exists.
assert.equal(
  verdictFor({
    expected: ['A'], checks: cleanChecks(['A']),
    productVolume: 'ILLEGIBLE', volumeStrings: TRUE_VOLUME, format: plainFormat,
  }).ok,
  true,
  'a product rendered too small to read must still be able to pass',
);

// R3 end to end: the product physically covered the word "actually" in the closing line
// and v1 silently reconstructed it.
{
  const v = verdictFor({
    expected: ['Six ingredients that actually absorb into skin.'],
    checks: cleanChecks(['Six ingredients that actually absorb into skin.']),
    productVolume: 'ILLEGIBLE',
    volumeStrings: TRUE_VOLUME,
    defects: [{ text: 'actually', issue: 'obscured', detail: 'the bottle sits on top of this word' }],
    format: plainFormat,
  });
  assert.equal(v.ok, false, 'text covered by the product must fail the render');
  assert.ok(v.reasons.some(r => /obscured/i.test(r) && /actually/.test(r)));
  assert.equal(v.defects.length, 1);
}
// Cut-off and garbled text fail the same way.
assert.equal(
  verdictFor({
    expected: ['A'], checks: cleanChecks(['A']), volumeStrings: TRUE_VOLUME,
    defects: [{ text: 'ABSORB INTO SKI', issue: 'cut-off', detail: 'runs off the right edge' }],
    format: plainFormat,
  }).ok,
  false,
);
assert.equal(
  verdictFor({
    expected: ['A'], checks: cleanChecks(['A']), volumeStrings: TRUE_VOLUME,
    defects: [{ text: 'CERAMIO OCOCONUT OIL', issue: 'garbled', detail: 'badge text is nonsense' }],
    format: plainFormat,
  }).ok,
  false,
  'a garbled badge must fail the render',
);

// verdictFor: text is perfect but a picture is captioned wrongly — must FAIL.
// This is the probe-3 two-pass failure; a text-only gate passes it.
const misPaired = verdictFor({
  expected: ['ORGANIC JOJOBA', 'COLD-PRESSED VIRGIN COCONUT OIL'],
  checks: cleanChecks(['ORGANIC JOJOBA', 'COLD-PRESSED VIRGIN COCONUT OIL']),
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

// The pairing check is independent of the per-string checks: a render whose every
// string is verified present must still fail on pairing.
const misPairedTextClean = verdictFor({
  expected: ['ORGANIC JOJOBA', 'COLD-PRESSED VIRGIN COCONUT OIL'],
  checks: cleanChecks(['ORGANIC JOJOBA', 'COLD-PRESSED VIRGIN COCONUT OIL']),
  pairings: [{ label: 'ORGANIC JOJOBA', depicts: 'a spoon of red palm oil', matches: false }],
  format: pairingFormat,
});
assert.deepEqual(misPairedTextClean.missing, [], 'the text really is all present');
assert.equal(misPairedTextClean.ok, false);
assert.equal(misPairedTextClean.mismatchedPairs.length, 1);

// A pairing format that reports no pairings at all cannot silently pass.
const noPairings = verdictFor({
  expected: ['ORGANIC JOJOBA'],
  checks: cleanChecks(['ORGANIC JOJOBA']),
  pairings: [],
  format: pairingFormat,
});
assert.equal(noPairings.ok, false);
assert.ok(noPairings.reasons.some(r => /no pairings reported/i.test(r)));

// ── Pairing applies to FINISHED frames only ─────────────────────────────────────
// A PLATE of a pairing format has no labels at all (buildRenderPrompt's plate branch
// forbids every glyph except the product's own label), so `pairings: []` is the CORRECT
// answer and must pass. Before this, every Demand Gen plate of us-vs-them and
// ingredient-callout was an unavoidable hard fail: 54 renders (~$7) on a default run
// that could not succeed, with both concepts reported as fully failed.
const plateOfPairingFormat = verdictFor({
  expected: ['8 fl. oz. (236ml)'],
  checks: cleanChecks(['8 fl. oz. (236ml)']),
  productVolume: '8 fl. oz. (236ml)',
  volumeStrings: TRUE_VOLUME,
  pairings: [],
  format: pairingFormat,
  mode: 'plate',
});
assert.equal(plateOfPairingFormat.ok, true, 'a plate cannot be required to report pairings');
assert.deepEqual(plateOfPairingFormat.reasons, []);

// The finished frame of that same format is unchanged — still a hard fail with no pairings.
const finishedNoPairings = verdictFor({
  expected: ['ORGANIC JOJOBA'],
  checks: cleanChecks(['ORGANIC JOJOBA']),
  pairings: [],
  format: pairingFormat,
  mode: 'finished',
});
assert.equal(finishedNoPairings.ok, false);
assert.ok(finishedNoPairings.reasons.some(r => /no pairings reported/i.test(r)));

// ...and a finished frame with MISMATCHED pairings still fails, mode or no mode.
const finishedMismatched = verdictFor({
  expected: ['ORGANIC JOJOBA'],
  checks: cleanChecks(['ORGANIC JOJOBA']),
  pairings: [{ label: 'ORGANIC JOJOBA', depicts: 'a spoon of red palm oil', matches: false }],
  format: pairingFormat,
  mode: 'finished',
});
assert.equal(finishedMismatched.ok, false);
assert.equal(finishedMismatched.mismatchedPairs.length, 1);

// Omitting mode entirely keeps the STRICT behaviour — a caller that forgets to thread
// it must never fall through to the looser gate.
assert.equal(
  verdictFor({ expected: ['A'], checks: cleanChecks(['A']), pairings: [], format: pairingFormat }).ok,
  false,
  'mode defaults to finished, the strict side',
);

// Text is still checked on a plate: the product's own label must be right.
assert.equal(
  verdictFor({
    expected: ['8 fl. oz. (236ml)'],
    checks: [{ expected: '8 fl. oz. (236ml)', found: true, rendered: '18 fl. oz. • 236ml' }],
    pairings: [], format: pairingFormat, mode: 'plate',
  }).ok,
  false,
  'dropping the pairing requirement must not drop the text check',
);

// A non-pairing format ignores pairings entirely.
const plain = verdictFor({ expected: ['A'], checks: cleanChecks(['A']), pairings: [], format: plainFormat });
assert.equal(plain.ok, true);

// Missing text fails and names what is missing.
const missing = verdictFor({
  expected: ['A', 'B'],
  checks: cleanChecks(['A']),
  pairings: [], format: plainFormat,
});
assert.equal(missing.ok, false);
assert.deepEqual(missing.missing, ['B']);

// A verdict with NO checks at all fails closed — the empty-response case must never
// read as an all-clear.
assert.equal(verdictFor({ expected: ['A'], format: plainFormat }).ok, false);

// The transcript is recorded but decides nothing: a transcript that "misses" everything
// cannot fail a render whose per-string checks all passed...
{
  const v = verdictFor({
    expected: ['A'], checks: cleanChecks(['A']), transcript: [], format: plainFormat,
  });
  assert.equal(v.ok, true, 'the transcript is diagnostic only');
  assert.deepEqual(v.transcriptDiff.missing, ['A'], '...but it is still recorded for the proof file');
}
// ...and a perfect transcript cannot rescue a failed per-string check. This is R1 in one
// assertion: the auto-corrected transcript is exactly what v1 trusted.
{
  const v = verdictFor({
    expected: ['THE REAL WAY'],
    checks: [{ expected: 'THE REAL WAY', found: false, rendered: 'THE RLALVJAY' }],
    transcript: ['THE REAL WAY'],
    format: plainFormat,
  });
  assert.equal(v.ok, false, 'a clean transcript must not overturn a failed per-string check');
}

// Task 2's suite pinned only ingredient-callout/us-vs-them/manifesto. Pin the rest:
// a silent flip of any of these would disable or wrongly enable the pairing check.
assert.equal(formatByKey('problem-aware').pairsImagesWithLabels, false);
assert.equal(formatByKey('top-x-review').pairsImagesWithLabels, false);
assert.equal(formatByKey('offer-focused').pairsImagesWithLabels, false);
