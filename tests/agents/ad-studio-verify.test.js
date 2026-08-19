import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
import {
  buildVerifyPrompt,
  scentVerdict,
  parseVerifyResponse,
  diffTranscript,
  evaluateChecks,
  readVolume,
  selectVolumeStrings,
  volumeVerdict,
  normalizeDefects,
  verdictFor,
  normalizeInventoryKind,
  inventoryVerdict,
  isUnresolvedObject,
} from '../../agents/ad-studio/verify.js';
import { formatByKey } from '../../agents/ad-studio/formats.js';
import { CREATIVE_MODELS } from '../../config/creative-models.js';

const pairingFormat = formatByKey('ingredient-callout');   // pairsImagesWithLabels: true
const plainFormat = formatByKey('manifesto');              // pairsImagesWithLabels: false

// A clean set of per-string checks: every string found, quoted back exactly as asked.
function cleanChecks(expected) {
  return expected.map(e => ({ expected: e, found: true, rendered: e }));
}

// A clean scene inventory for a single-unit product: the product, and the ground it
// stands on. Plate-mode assertions carry it so each one still tests the thing it names —
// inventoryVerdict fails an EMPTY inventory on a plate as "unreported", so leaving it off
// would make every plate assertion below pass or fail for the wrong reason.
const CLEAN_INVENTORY = [
  { object: 'a white lotion bottle, centre right', kind: 'product-unit' },
  { object: 'a flat sand-coloured surface', kind: 'surface' },
];

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

// found:false is taken at face value even when the quoted text WOULD have matched. The
// model's own "no" is never overturned into a pass — the re-check exists to falsify a
// "yes", not to rescue a "no". (Nothing pinned this branch: every other corrupted-string
// case in this file also has garbled `rendered` text, so the diffTranscript re-check was
// catching them and this line could be deleted with the suite still green.)
{
  const r = evaluateChecks(['SIX INGREDIENTS.'], [
    { expected: 'SIX INGREDIENTS.', found: false, rendered: 'SIX INGREDIENTS.' },
  ]);
  assert.deepEqual(r.missing, ['SIX INGREDIENTS.'], 'a "no" answer must fail even when the quoted text matches');
}

// ── Volume: illegible passes, wrong FAILS (R2) ──────────────────────────────────
assert.deepEqual(readVolume('8 fl. oz. (236ml)'), { oz: 8, ml: 236, wtOz: null, g: null });
assert.deepEqual(readVolume('4 FL oz / 118ml'), { oz: 4, ml: 118, wtOz: null, g: null });
assert.deepEqual(readVolume('real SKIN CARE'), { oz: null, ml: null, wtOz: null, g: null });
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

// ── R2b: volumeVerdict is now the ONLY check on the volume, so it must carry the load ──
//
// The separator cases. Every one of these is a real string a live run read off the
// physical label, and every one used to be failed by the per-string check while
// volumeVerdict simultaneously reported "match" in the same verdict. They must pass.
for (const read of ['8 fl. oz - 236ml', '8 fl. oz ~ 236ml', '8 fl. oz • 236ml', '8 fl oz • 236ml', '8 fl. oz · 236ml']) {
  const v = volumeVerdict(read, TRUE_VOLUME);
  assert.equal(v.ok, true, `"${read}" differs from the manifest only by punctuation and must pass`);
  assert.equal(v.status, 'match');
}

// The contradiction cases. With the per-string check no longer offering a second
// opinion, a wrong number must fail HERE or it ships.
for (const read of ['18 fl. oz. • 236ml', '4 fl. oz (118ml)', '0 fl. oz. • 236ml', '8 fl. oz • 230ml']) {
  const v = volumeVerdict(read, TRUE_VOLUME);
  assert.equal(v.ok, false, `"${read}" contradicts the product and must FAIL`);
  assert.equal(v.status, 'mismatch');
}

// THE 0-vs-8 CASE, in the exact live shape (top-x-review/v1/plate-1_91x1.jpg).
// The verifier answered "productVolume": "ILLEGIBLE" while transcribing "0 fl. oz. •
// 236ml" off the same pixels in the same call — a misrendered 8. Before R2b the
// per-string check happened to catch that; it no longer looks at the volume at all, so
// volumeVerdict falls back to the response's own transcript when it has no direct
// reading. Note "0" must not be treated as absent: readVolume returns 0, not null.
assert.deepEqual(readVolume('0 fl. oz. • 236ml'), { oz: 0, ml: 236, wtOz: null, g: null });
{
  const v = volumeVerdict('ILLEGIBLE', TRUE_VOLUME, [
    'real', 'SKIN CARE', 'ORGANIC', 'pure unscented', 'moisturizing body lotion', '0 fl. oz. • 236ml',
  ]);
  assert.equal(v.ok, false, 'a transcribed volume that contradicts the product must FAIL, not pass as illegible');
  assert.equal(v.status, 'mismatch');
  assert.equal(v.source, 'transcript');
  assert.equal(v.read, '0 fl. oz. • 236ml');
}

// The transcript scan can only FAIL a render, never pass one — these are the frames from
// the same live run that must be unaffected.
{
  // Genuinely illegible, nothing volume-shaped anywhere in the frame (manifesto plate).
  const v = volumeVerdict('ILLEGIBLE', TRUE_VOLUME, ['real', 'SKIN CARE', 'pure unscented', 'moisturizing body lotion']);
  assert.equal(v.ok, true, 'an illegible volume with no contradiction anywhere still passes');
  assert.equal(v.status, 'illegible');
}
{
  // Direct answer unreadable, but the transcript AGREES — a partial read is a correct
  // read (problem-aware finished-1x1 transcribed "fl. oz. • 236ml", no ounce digit).
  const v = volumeVerdict('ILLEGIBLE', TRUE_VOLUME, ['fl. oz. • 236ml', '8 fl oz']);
  assert.equal(v.ok, true, 'a transcript that agrees must never fail a render');
  assert.equal(v.status, 'illegible');
}
// ── The transcript scan is UNCONDITIONAL (2026-08-15) ────────────────────────────────
//
// This block previously asserted the opposite: that a correct direct reading was never
// overturned by the transcript. That assertion encoded the bug. It is exactly the shape
// of the plate that passed on 2026-08-15 — the response carried BOTH "8 fl. oz • 236ml"
// (correct, read off the hero bottle) and "8 fl. oz . 230ml" (wrong, printed on a ghost
// second bottle), and because the direct answer was right the scan never ran.
//
// The old justification for gating it was that the scan "can only ever FAIL a render,
// never pass one" — which is an argument for always running it. One unit in the frame
// reading correctly says nothing about the others.
{
  const v = volumeVerdict('8 fl. oz. • 236ml', TRUE_VOLUME, ['8 fl. oz . 230ml']);
  assert.equal(v.ok, false, 'a contradicting transcript must fail even when the direct reading is correct');
  assert.equal(v.status, 'mismatch');
  assert.equal(v.source, 'transcript');
  assert.equal(v.read, '8 fl. oz . 230ml');
}
{
  // A correct direct reading with a transcript that agrees is still a clean pass — the
  // scan must not have become noisy in the process.
  const v = volumeVerdict('8 fl. oz. • 236ml', TRUE_VOLUME, ['8 fl. oz. • 236ml', 'real SKIN CARE']);
  assert.equal(v.ok, true, 'an agreeing transcript must not fail a correct render');
  assert.equal(v.status, 'match');
  assert.equal(v.source, 'reported');
}
{
  // A WRONG direct reading is still reported as itself, not attributed to the transcript
  // — it is the more actionable line for a human triaging the reject.
  const v = volumeVerdict('4 fl. oz. • 118ml', TRUE_VOLUME, ['4 fl. oz. • 118ml']);
  assert.equal(v.ok, false);
  assert.equal(v.source, 'reported', 'a wrong direct reading is reported as the direct reading');
  assert.equal(v.read, '4 fl. oz. • 118ml');
}

// The prompt must not invite the ILLEGIBLE-vs-transcribed contradiction in the first
// place: ILLEGIBLE means no characters readable, not "the number looks wrong".
{
  const p = buildVerifyPrompt({ expected: ['A'], format: plainFormat });
  assert.ok(
    /ILLEGIBLE" means you cannot make out ANY characters/.test(p),
    'the prompt must define ILLEGIBLE as "no characters readable"',
  );
  assert.ok(
    /even if the number looks wrong/i.test(p),
    'and must tell the model to quote a wrong-looking volume rather than hide it behind ILLEGIBLE',
  );
}

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
  mode: 'plate', sceneInventory: CLEAN_INVENTORY,
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
    pairings: [], format: pairingFormat, mode: 'plate', sceneInventory: CLEAN_INVENTORY,
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

// ── R3a: the defect check is MODE-AWARE ─────────────────────────────────────────
//
// A plate is rendered under "ABSOLUTELY NO TEXT ... Leave every area where copy would sit
// completely empty and clean" — Demand Gen mixes the text assets in at serve time, so the
// EMPTINESS is the deliverable. Asked the finished-frame question ("what copy here is not
// fully legible"), the verifier truthfully reported the empty header bars and blank list
// rows and the gate failed 5 of 18 plates on a live run for being exactly right.

// The plate prompt asks the INVERTED question. Reverting section 3 to the finished-frame
// wording fails every one of these.
const platePrompt = buildVerifyPrompt({ expected: ['8 fl. oz. (236ml)'], format: pairingFormat, mode: 'plate' });
assert.ok(
  /DO NOT report absent, missing or blank text/i.test(platePrompt),
  'a plate must never be asked to report missing text',
);
assert.ok(
  /stray-text/.test(platePrompt),
  'a plate is asked instead about text that IS present where none was asked for',
);
assert.ok(
  /blank bar|empty zone/i.test(platePrompt),
  'and is told explicitly that an empty zone is not a defect',
);
assert.ok(
  !/AD'S OWN TYPESET COPY/.test(platePrompt),
  'the finished-frame defect question must not be asked of a plate at all',
);
// The product's own label stays out of scope on a plate too — that carve-out is what
// stopped the verifier rejecting a known-good control on its arc-set badge micro-copy.
assert.ok(/PRODUCT'S OWN LABEL/.test(platePrompt));

// The FINISHED prompt is untouched: it still asks about occlusion, truncation and
// garbling, which is what caught the corrupted headline and the bottle sitting on the
// word "actually".
const finishedPrompt = buildVerifyPrompt({ expected: ['A'], format: plainFormat, mode: 'finished' });
assert.ok(/AD'S OWN TYPESET COPY/.test(finishedPrompt));
assert.ok(/obscured/.test(finishedPrompt) && /cut-off/.test(finishedPrompt) && /garbled/.test(finishedPrompt));
assert.ok(!/stray-text/.test(finishedPrompt), 'the plate question must not leak into a finished frame');

// normalizeDefects: on a plate, an entry that quotes no rendered characters is a report
// of ABSENCE and is dropped. These are the four verbatim entries from the live proof.json.
const LIVE_PLATE_FALSE_POSITIVES = [
  { text: '[black rounded bar, left]', issue: 'obscured', detail: 'Left header bar is a solid black rounded rectangle with no visible text inside it.' },
  { text: '[black rounded bar, right]', issue: 'obscured', detail: 'Right header bar is a solid black rounded rectangle with no visible text inside it.' },
  { text: '[list items next to X marks]', issue: 'obscured', detail: 'Four rows on the left marked with X icons have no accompanying text, just blank lines.' },
  { text: '[list items next to check marks]', issue: 'obscured', detail: 'Four rows on the right marked with checkmark icons have no accompanying text, just blank lines.' },
];
assert.deepEqual(normalizeDefects(LIVE_PLATE_FALSE_POSITIVES, 'plate'), []);
assert.deepEqual(normalizeDefects([{ text: '(the four list rows)' }, { text: '—' }, { text: 'blank' }], 'plate'), []);
// ...but text that IS rendered survives, and its reported issue is kept as-is.
assert.deepEqual(
  normalizeDefects([{ text: 'A LIBCDEFGHIJKLM NOPQRSTUVWXYZ', issue: 'garbled', detail: 'bottom bar' }], 'plate'),
  [{ text: 'A LIBCDEFGHIJKLM NOPQRSTUVWXYZ', issue: 'garbled', detail: 'bottom bar' }],
);
assert.equal(normalizeDefects([{ text: 'HEADLINE TEXT HERE', issue: 'stray-text' }], 'plate').length, 1);
assert.equal(normalizeDefects([{ text: 'x', issue: 'stray-text' }])[0].issue, 'stray-text');
// The absence filter is PLATE-ONLY. On a finished frame "[the closing line]" may well be
// a real occlusion report, and mode defaults to the strict side.
assert.equal(normalizeDefects(LIVE_PLATE_FALSE_POSITIVES, 'finished').length, 4);
assert.equal(normalizeDefects(LIVE_PLATE_FALSE_POSITIVES).length, 4, 'mode defaults to finished');

// verdictFor, plate mode: THE FALSE POSITIVE. Empty copy zones described back as defects
// must produce ok:true — this is plate-1_91x1.jpg of the live run, which is a correct plate.
{
  const v = verdictFor({
    expected: ['8 fl. oz. (236ml)'],
    checks: cleanChecks(['8 fl. oz. (236ml)']),
    productVolume: '8 fl. oz. • 236ml',
    volumeStrings: TRUE_VOLUME,
    defects: LIVE_PLATE_FALSE_POSITIVES,
    pairings: [],
    format: pairingFormat,
    mode: 'plate', sceneInventory: CLEAN_INVENTORY,
  });
  assert.equal(v.ok, true, 'a plate\'s deliberately-empty copy zones are not defects');
  assert.deepEqual(v.reasons, []);
  assert.deepEqual(v.defects, []);
}

// verdictFor, plate mode: THE GENUINE DEFECT. Stray text rendered into a plate that was
// specified clean must still fail — this is plate-1x1.jpg of the same run.
{
  const v = verdictFor({
    expected: ['8 fl. oz. (236ml)'],
    checks: cleanChecks(['8 fl. oz. (236ml)']),
    productVolume: '8 fl. oz • 236ml',
    volumeStrings: TRUE_VOLUME,
    defects: [{
      text: 'A LIBCDEFGHIJKLM NOPQRSTUVWXYZ',
      issue: 'garbled',
      detail: 'Bottom bar alphabet strip is malformed.',
    }],
    pairings: [],
    format: pairingFormat,
    mode: 'plate', sceneInventory: CLEAN_INVENTORY,
  });
  assert.equal(v.ok, false, 'text rendered into a text-free plate must fail');
  assert.equal(v.defects.length, 1);
  assert.ok(v.reasons.some(r => /A LIBCDEFGHIJKLM/.test(r)));
  assert.ok(v.reasons.some(r => /no text except the product's own label/i.test(r)));
}
// Correctly-spelled placeholder copy on a plate fails too — garbling is not the point,
// presence is. The copy layer cannot remove pixels.
assert.equal(
  verdictFor({
    expected: ['8 fl. oz. (236ml)'], checks: cleanChecks(['8 fl. oz. (236ml)']),
    volumeStrings: TRUE_VOLUME, pairings: [], format: pairingFormat, mode: 'plate', sceneInventory: CLEAN_INVENTORY,
    defects: [{ text: 'HEADLINE TEXT HERE', issue: 'stray-text', detail: 'top left bar' }],
  }).ok,
  false,
  'a cleanly-spelled placeholder headline is still stray text on a plate',
);

// FINISHED mode is unchanged by all of the above — asserted through the same entry point.
assert.equal(
  verdictFor({
    expected: ['Six ingredients that actually absorb into skin.'],
    checks: cleanChecks(['Six ingredients that actually absorb into skin.']),
    volumeStrings: TRUE_VOLUME, format: plainFormat, mode: 'finished',
    defects: [{ text: 'actually', issue: 'obscured', detail: 'the bottle sits on top of this word' }],
  }).ok,
  false,
  'obscured copy still fails a finished frame',
);
assert.equal(
  verdictFor({
    expected: ['A'], checks: cleanChecks(['A']), volumeStrings: TRUE_VOLUME,
    format: plainFormat, mode: 'finished',
    defects: [{ text: 'CERAMIO OCOCONUT OIL', issue: 'garbled', detail: 'badge text is nonsense' }],
  }).ok,
  false,
  'garbled copy still fails a finished frame',
);
{
  const v = verdictFor({
    expected: ['THE MOISTURIZING CLAIM DOES MORE WORK THAN THE FORMULA'],
    checks: [{
      expected: 'THE MOISTURIZING CLAIM DOES MORE WORK THAN THE FORMULA',
      found: true,
      rendered: 'THE MOISTURIZING CLAIM DOES MORE WORK TTHAN THE FORMLA',
    }],
    productVolume: 'ILLEGIBLE', volumeStrings: TRUE_VOLUME,
    format: plainFormat, mode: 'finished',
  });
  assert.equal(v.ok, false, 'the corrupted-headline case still fails in finished mode');
  assert.ok(v.reasons.some(r => /TTHAN THE FORMLA/.test(r)));
}

// The VOLUME check is untouched in both modes: illegible passes, a contradicted number fails.
for (const mode of ['plate', 'finished']) {
  assert.equal(
    verdictFor({
      expected: ['A'], checks: cleanChecks(['A']), productVolume: 'ILLEGIBLE',
      volumeStrings: TRUE_VOLUME, format: plainFormat, mode,
      sceneInventory: CLEAN_INVENTORY,
    }).ok,
    true,
    `an illegible volume passes in ${mode} mode`,
  );
  const wrong = verdictFor({
    expected: ['A'], checks: cleanChecks(['A']), productVolume: '4 FL oz / 118ml',
    volumeStrings: TRUE_VOLUME, format: plainFormat, mode,
  });
  assert.equal(wrong.ok, false, `a contradicted volume fails in ${mode} mode`);
  assert.equal(wrong.volume.status, 'mismatch');

  // R2b: and the transcript fallback is WIRED THROUGH verdictFor, not just implemented
  // in volumeVerdict — the live 0-vs-8 frame, whole. The expected set no longer carries
  // the volume, so nothing but volumeVerdict can catch this.
  const zeroOz = verdictFor({
    expected: ['A'], checks: cleanChecks(['A']), productVolume: 'ILLEGIBLE',
    transcript: ['real', 'SKIN CARE', 'moisturizing body lotion', '0 fl. oz. • 236ml'],
    volumeStrings: TRUE_VOLUME, format: plainFormat, mode,
  });
  assert.equal(zeroOz.ok, false, `a transcribed 0 fl. oz. on an 8 fl. oz. product fails in ${mode} mode`);
  assert.equal(zeroOz.volume.status, 'mismatch');
  assert.ok(zeroOz.reasons.some(r => /volume marking is WRONG/i.test(r) && /0 fl\. oz\./.test(r)));
}

// Task 2's suite pinned only ingredient-callout/us-vs-them/manifesto. Pin the rest:
// a silent flip of any of these would disable or wrongly enable the pairing check.
assert.equal(formatByKey('problem-aware').pairsImagesWithLabels, false);
assert.equal(formatByKey('top-x-review').pairsImagesWithLabels, false);
assert.equal(formatByKey('offer-focused').pairsImagesWithLabels, false);

// ── R4: PRODUCT FIDELITY — the render is compared against the reference photographs ──
//
// The failure this exists for: a live ingredient-callout frame rendered a SQUAT, WIDE
// bottle with a short disc cap, the brand mark in the middle of the label, no leaf
// illustration and the volume set in black on white with no black accent bar. The real
// bottle is tall and slim with a tall flip-top cap, the brand mark at the top, a leaf
// below the badge, and the volume reversed out of a black bar. Every expected STRING was
// present and correctly spelled, so the text gate had nothing to fail — accepted, one
// attempt. Nothing in the gate had ever looked at the product's physical form.
//
// The verdict follows volumeVerdict's proven shape (R2): tolerant of "cannot tell",
// intolerant of "wrong". A pointed question per attribute, never an open "does this
// match?" — R1's whole finding is that an open question gets auto-corrected towards yes.
import {
  FIDELITY_ATTRIBUTES,
  normalizeFidelityVerdict,
  fidelityVerdict,
} from '../../agents/ad-studio/verify.js';

const REF = { hasReference: true };
const allMatch = () => FIDELITY_ATTRIBUTES.map(a => ({ attribute: a.key, verdict: 'MATCH', detail: '' }));

// Every attribute is asked about the RENDER against the REFERENCE, and each is coarse
// enough to survive a product rendered small. A silent shrinking of this list would
// narrow the gate without failing anything.
assert.ok(FIDELITY_ATTRIBUTES.length >= 5, 'fidelity must ask about at least 5 attributes');
for (const a of FIDELITY_ATTRIBUTES) {
  assert.ok(a.key && a.label && a.ask, `attribute ${a.key} needs key, label and ask`);
}
assert.ok(FIDELITY_ATTRIBUTES.some(a => a.key === 'silhouette'), 'must check body shape/proportion');
assert.ok(FIDELITY_ATTRIBUTES.some(a => a.key === 'closure'), 'must check the cap');
assert.ok(FIDELITY_ATTRIBUTES.some(a => a.key === 'labelLayout'), 'must check label element order');
assert.ok(FIDELITY_ATTRIBUTES.some(a => a.key === 'labelGraphics'), 'must check bars/illustrations/badges');

// normalizeFidelityVerdict — tolerant of wording, intolerant of falsehood.
assert.equal(normalizeFidelityVerdict('MATCH'), 'match');
assert.equal(normalizeFidelityVerdict('yes'), 'match');
assert.equal(normalizeFidelityVerdict('MISMATCH'), 'mismatch');
assert.equal(normalizeFidelityVerdict('no'), 'mismatch');
assert.equal(normalizeFidelityVerdict('wrong'), 'mismatch');
assert.equal(normalizeFidelityVerdict('different'), 'mismatch');
assert.equal(normalizeFidelityVerdict('CANNOT_TELL'), 'cannot-tell');
assert.equal(normalizeFidelityVerdict('cannot tell'), 'cannot-tell');
assert.equal(normalizeFidelityVerdict('too small to judge'), 'cannot-tell');
// An answer nobody anticipated is NOT read as a failure — only an explicit "wrong" is.
// Erring towards cannot-tell here costs a missed check; erring the other way rejects
// good renders at $0.13 a retry on a model wording slip.
assert.equal(normalizeFidelityVerdict('banana'), 'cannot-tell');
assert.equal(normalizeFidelityVerdict(''), 'cannot-tell');
assert.equal(normalizeFidelityVerdict(undefined), 'cannot-tell');

// No reference photographs were sent → the question was never asked, so it cannot fail.
// index.js already warns loudly when a product has no reference photos at all.
assert.equal(fidelityVerdict([], { hasReference: false }).ok, true);
assert.equal(fidelityVerdict([], { hasReference: false }).status, 'no-reference');

// The happy path.
const fidClean = fidelityVerdict(allMatch(), REF);
assert.equal(fidClean.ok, true);
assert.equal(fidClean.status, 'match');
assert.equal(fidClean.mismatches.length, 0);

// THE REGRESSION. A squat bottle with the wrong cap fails, and says which attribute and why.
const fidSquat = fidelityVerdict([
  { attribute: 'silhouette', verdict: 'MISMATCH', detail: 'render is squat and wide; the reference bottle is tall and slim' },
  { attribute: 'closure', verdict: 'MISMATCH', detail: 'short disc cap; the reference has a tall flip-top' },
  { attribute: 'labelLayout', verdict: 'MATCH', detail: '' },
  { attribute: 'labelGraphics', verdict: 'MISMATCH', detail: 'no black accent bar and no leaf illustration' },
  { attribute: 'colorFinish', verdict: 'MATCH', detail: '' },
], REF);
assert.equal(fidSquat.ok, false, 'a wrong bottle shape must fail the render');
assert.equal(fidSquat.status, 'mismatch');
assert.equal(fidSquat.mismatches.length, 3);
assert.ok(fidSquat.mismatches.some(m => m.attribute === 'silhouette' && /tall and slim/.test(m.detail)));

// Tolerant of illegibility — the manifesto / problem-aware case, where the product is
// rendered deliberately small. Same reasoning as volumeVerdict's ILLEGIBLE pass: the
// response to "cannot read it" is to accept it, not to stop asking.
const fidSmall = fidelityVerdict(
  FIDELITY_ATTRIBUTES.map(a => ({ attribute: a.key, verdict: 'CANNOT_TELL', detail: 'product too small' })),
  REF,
);
assert.equal(fidSmall.ok, true, 'a product too small to judge must pass, not fail');
assert.equal(fidSmall.status, 'cannot-tell');

// Mixed cannot-tell and match still passes; one mismatch anywhere still fails.
assert.equal(fidelityVerdict([
  { attribute: 'silhouette', verdict: 'MATCH' },
  { attribute: 'closure', verdict: 'CANNOT_TELL' },
], REF).ok, true);
assert.equal(fidelityVerdict([
  { attribute: 'silhouette', verdict: 'MATCH' },
  { attribute: 'closure', verdict: 'CANNOT_TELL' },
  { attribute: 'labelGraphics', verdict: 'MISMATCH', detail: 'accent bar missing' },
], REF).ok, false, 'one mismatch fails the whole verdict');

// Attributes the model simply did not answer are cannot-tell, not failures.
assert.equal(fidelityVerdict([{ attribute: 'silhouette', verdict: 'MATCH' }], REF).ok, true);

// But a response that answers NOTHING while reference photos were supplied is a check
// that silently did not run — the same shape as "no pairings reported for a layout that
// pairs images with labels", and treated the same way: it fails and retries.
const fidNone = fidelityVerdict([], REF);
assert.equal(fidNone.ok, false, 'reference photos sent but no fidelity answers must fail');
assert.equal(fidNone.status, 'unreported');

// Unknown attribute keys are recorded, never crash, and a MISMATCH on one still fails.
const fidOdd = fidelityVerdict([{ attribute: 'nozzleAngle', verdict: 'MISMATCH', detail: 'x' }], REF);
assert.equal(fidOdd.ok, false);

// ── R4 wired through verdictFor, in BOTH modes ─────────────────────────────────────
// A plate is nothing BUT the product, so fidelity matters at least as much there as on
// a finished frame. Unlike the defect question (R3a) this one does not invert.
for (const mode of ['finished', 'plate']) {
  const good = verdictFor({
    expected: ['A'], checks: cleanChecks(['A']), format: plainFormat, mode,
    fidelity: allMatch(), hasReference: true, sceneInventory: CLEAN_INVENTORY,
  });
  assert.equal(good.ok, true, `a faithful product passes in ${mode} mode`);
  assert.equal(good.fidelity.status, 'match');

  const bad = verdictFor({
    expected: ['A'], checks: cleanChecks(['A']), format: plainFormat, mode,
    fidelity: [{ attribute: 'silhouette', verdict: 'MISMATCH', detail: 'squat, not tall and slim' }],
    hasReference: true,
  });
  assert.equal(bad.ok, false, `a wrong product shape fails in ${mode} mode`);
  assert.ok(bad.reasons.some(r => /product does not match the reference/i.test(r)));
  assert.ok(bad.reasons.some(r => /squat, not tall and slim/.test(r)), 'the reason must say what is wrong');
}

// A caller that forgets to thread hasReference through gets the check switched OFF, not
// a hard fail on every render. That direction is deliberate: the OTHER direction turns
// every target of a product with no reference photos into 3 failed paid attempts.
assert.equal(verdictFor({
  expected: ['A'], checks: cleanChecks(['A']), format: plainFormat, mode: 'finished',
}).ok, true);

// ── R4 in the prompt: pointed per-attribute questions, and a labelled image order ────
const physical = 'An 8 fl. oz. white plastic cylindrical squeeze bottle with a black flip-top cap.';
const pf = buildVerifyPrompt({
  expected: ['SIX INGREDIENTS.'], format: plainFormat, mode: 'finished',
  physicalDescription: physical, referenceCount: 2,
});
assert.ok(/REFERENCE PHOTOGRAPH/i.test(pf), 'the prompt must name the reference photographs');
assert.ok(/RENDER UNDER TEST/i.test(pf), 'the prompt must name which image is the render');
assert.ok(pf.includes(physical), 'the physical description on file must be in the prompt');
for (const a of FIDELITY_ATTRIBUTES) {
  assert.ok(pf.includes(a.label), `the prompt must ask about "${a.label}" specifically`);
}
assert.ok(/CANNOT_TELL/.test(pf), 'the prompt must offer the cannot-tell answer');
// The trap R1 documents: an open "does the product match?" gets auto-corrected to yes.
assert.ok(
  !/does the product match|is this the same product\?/i.test(pf),
  'the prompt must never ask one open match question',
);
// Without reference photographs there is nothing to compare against and the section
// must not appear at all — an unanswerable question burns retries.
const pfNone = buildVerifyPrompt({ expected: ['A'], format: plainFormat, referenceCount: 0 });
assert.ok(!/RENDER UNDER TEST/i.test(pfNone), 'no fidelity section without reference photographs');

// ── R4a: the false-positive guards, derived from live runs against real photographs ──
//
// The first cut of this check rejected a real PHOTOGRAPH of the product. It reported
// "an additional silver/metallic band" and "a grey gradient at the shoulder" as label
// graphics — both of them gloss and glare, neither of them ink. A check that fails a
// genuine photo of the bottle would fail every well-lit render, at three paid attempts
// each. Two narrowings fixed it, and both must survive:
const guarded = buildVerifyPrompt({
  expected: ['A'], format: plainFormat, referenceCount: 2,
  physicalDescription: 'A white bottle.',
});

// 1. Photographic styling can never be a mismatch. The render is an advertisement, lit
//    and staged on purpose; the reference is a product photograph.
for (const styling of ['lighting', 'gloss', 'highlight', 'reflection', 'shadow', 'crop', 'angle']) {
  assert.ok(
    new RegExp(styling, 'i').test(guarded),
    `the prompt must name "${styling}" as something that is never a mismatch`,
  );
}

// 2. The question is asked ABOUT THE REFERENCE'S elements — missing, moved or reshaped —
//    not about extra elements appearing in the render. Every false positive found was an
//    "extra" that turned out to be a highlight. An extra printed graphic is both rarer
//    and less harmful than a missing one; this asymmetry is deliberate.
assert.ok(
  /missing, moved or reshaped/i.test(guarded),
  'labelGraphics must ask about reference elements going missing, not about extras appearing',
);
assert.ok(
  /never an extra element/i.test(guarded),
  'the prompt must tell the verifier not to report extra elements',
);

// 3. containerColour judges base colour only. It was "colours and finish" and read a warm
//    highlight as a finish change on a bottle that was simply lit differently.
const colour = FIDELITY_ATTRIBUTES.find(a => a.key === 'containerColour');
assert.ok(colour, 'the colour attribute must be base-colour only, not finish');
assert.ok(/base colour only/i.test(colour.ask));

// ── R2c: NET WEIGHT is a volume marking too ─────────────────────────────────────────
//
// readVolume understood fluid ounces and millilitres and nothing else, so every product
// marked by WEIGHT was invisible to the volume gate. Found by auditing what the pipeline
// actually extracts for each product in data/product-images/manifest.json:
//
//   coconut-oil-lip-balm  labelStrings: ["real SKIN CARE", "0.15 oz • 4.25g"]  volume: 0
//   coconut-soap          the bar prints "3.4 oz • 84g"                        volume: 0
//
// Two failures came out of that, not one:
//
//   1. volumeVerdict had nothing on file, returned "no-volume-on-file", and PASSED any
//      weight the image model cared to invent.
//   2. Worse, because expectedForFormat only subtracts recognised volume markings from
//      the expected set, "0.15 oz • 4.25g" stayed in it — so the lip balm's weight was
//      checked by the STRICT literal per-string matcher instead. That is the exact
//      mechanism R2b removed for the lotion after it rejected three correct renders over
//      "8 fl. oz. (236ml)" vs "8 fl. oz - 236ml". A product marked by weight was getting
//      the strictness the design had already rejected.
assert.deepEqual(readVolume('0.15 oz • 4.25g'), { oz: null, ml: null, wtOz: 0.15, g: 4.25 });
assert.deepEqual(readVolume('3.4 oz • 84g'), { oz: null, ml: null, wtOz: 3.4, g: 84 });
assert.deepEqual(readVolume('NET WT 3.4 OZ'), { oz: null, ml: null, wtOz: 3.4, g: null });

// FLUID ounces must never be read as weight ounces. "8 fl. oz." has "fl." between the
// number and "oz", which the weight pattern cannot cross — if it ever could, every lotion
// would carry a phantom weight reading that nothing on the label supports.
assert.equal(readVolume('8 fl. oz. (236ml)').wtOz, null);
assert.equal(readVolume('4 FL oz / 118ml').wtOz, null);
// ...and millilitres must never be read as grams.
assert.equal(readVolume('8 fl. oz. (236ml)').g, null);

// A weight marking now reaches selectVolumeStrings, so it is gated by volumeVerdict
// (numeric, punctuation-tolerant) and subtracted from the literal expected set.
assert.deepEqual(selectVolumeStrings(['real SKIN CARE', '0.15 oz • 4.25g']), ['0.15 oz • 4.25g']);
assert.deepEqual(selectVolumeStrings(['real SKIN CARE', 'hand & body soap', '3.4 oz • 84g']), ['3.4 oz • 84g']);

// And it is judged with the same tolerance: illegible passes, wrong fails, punctuation
// never decides. The lip balm bottle prints "0.15 oz - 4.25g"; the manifest writes a
// bullet. Same numbers, so it must pass.
const LIP = ['0.15 oz • 4.25g'];
assert.equal(volumeVerdict('0.15 oz - 4.25g', LIP).ok, true, 'punctuation must not fail a correct weight');
assert.equal(volumeVerdict('ILLEGIBLE', LIP).ok, true, 'an unreadable weight still passes');
const wrongWeight = volumeVerdict('0.5 oz • 14g', LIP);
assert.equal(wrongWeight.ok, false, 'a weight that contradicts the label must fail');
assert.equal(wrongWeight.status, 'mismatch');
// Only the dimensions actually reported are compared — reading the ounces off a tube
// whose gram marking is turned away is a correct read, not a mismatch.
assert.equal(volumeVerdict('0.15 oz', LIP).ok, true);
assert.equal(volumeVerdict('0.9 oz', LIP).ok, false);

// ── R5. SCENE INVENTORY ─────────────────────────────────────────────────────────────
//
// The 2026-08-15 plate carried a ghost second bottle, a wood slice, greenery and a
// coconut, and passed every check in this file. Each had a reason not to see it:
// FIDELITY_ATTRIBUTES are phrased about *the* product, singular, so the verifier silently
// picked one unit and judged that; the volume transcript scan was gated behind "no direct
// reading"; and the stray-text rule correctly exempts text on the product's own label,
// which exempted the ghost bottle's wrong volume twice over.
//
// The generalisable shape: EVERY CHECK ASSUMED EXACTLY ONE PRODUCT IN THE FRAME.

// normalizeInventoryKind — the asymmetry is the OPPOSITE of the fidelity verdict's, on
// purpose. There, an unrecognised word is read as cannot-tell. Here it is read as
// "other", because the model has already told us an object exists and the only question
// is which bucket it lands in — reading "prop" or "garnish" as surface would silently
// drop it from the gate, which is how the ghost bottle got through.
assert.equal(normalizeInventoryKind('product-unit'), 'product-unit');
assert.equal(normalizeInventoryKind('product unit'), 'product-unit');
assert.equal(normalizeInventoryKind('bottle'), 'product-unit');
assert.equal(normalizeInventoryKind('surface'), 'surface');
assert.equal(normalizeInventoryKind('background'), 'surface');
assert.equal(normalizeInventoryKind('other'), 'other');
assert.equal(normalizeInventoryKind('prop'), 'other', 'an unanticipated word is a stray, not a surface');
assert.equal(normalizeInventoryKind('garnish'), 'other');
assert.equal(normalizeInventoryKind(''), 'other');
assert.equal(normalizeInventoryKind(undefined), 'other');

const ONE_UNIT = [
  { object: 'a white lotion bottle, centre', kind: 'product-unit' },
  { object: 'a flat sand surface', kind: 'surface' },
];

// A clean single-unit plate.
{
  const v = inventoryVerdict(ONE_UNIT, { expectedUnits: 1, mode: 'plate' });
  assert.equal(v.ok, true);
  assert.equal(v.status, 'clean');
  assert.equal(v.units.length, 1);
}

// THE INCIDENT: a ghost second bottle. This is what nothing was counting.
{
  const v = inventoryVerdict([
    ...ONE_UNIT,
    { object: 'a second, half-faded bottle behind the first', kind: 'product-unit' },
  ], { expectedUnits: 1, mode: 'plate' });
  assert.equal(v.ok, false, 'a ghost second bottle must fail');
  assert.equal(v.status, 'wrong-unit-count');
  assert.equal(v.units.length, 2);
}

// THE INCIDENT, other half: props and scene dressing.
{
  const v = inventoryVerdict([
    ...ONE_UNIT,
    { object: 'a slice of wood under the bottle', kind: 'other' },
    { object: 'a coconut, left', kind: 'other' },
    { object: 'sprigs of greenery', kind: 'other' },
  ], { expectedUnits: 1, mode: 'plate' });
  assert.equal(v.ok, false, 'props on a plate must fail');
  assert.equal(v.status, 'stray-objects');
  assert.equal(v.strays.length, 3);
  assert.ok(v.strays.some(s => /wood/.test(s.object)), 'the stray must be named, not just counted');
}

// A GENUINE MULTI-UNIT PRODUCT. foam-soap-bundle is three bottles, both starter sets are
// multi-item and the lip balm is a four-pack: a hard-coded "exactly one" would reject
// every correct render of them. This is the ghost-bottle assumption read from the other
// side, and one number answers both.
{
  const threeBottles = [
    { object: 'an 8 oz foaming pump bottle, left', kind: 'product-unit' },
    { object: 'a 32 oz refill bottle, centre', kind: 'product-unit' },
    { object: 'an 8 oz foaming pump bottle, right', kind: 'product-unit' },
    { object: 'a flat sand surface', kind: 'surface' },
  ];
  assert.equal(inventoryVerdict(threeBottles, { expectedUnits: 3, mode: 'plate' }).ok, true,
    'a three-piece bundle rendered as three pieces must pass');
  assert.equal(inventoryVerdict(threeBottles, { expectedUnits: 1, mode: 'plate' }).ok, false,
    'and would have been rejected by a hard-coded "exactly one"');
  // Too FEW is a defect as well — a bundle rendered short is not the product.
  const v = inventoryVerdict(ONE_UNIT, { expectedUnits: 3, mode: 'plate' });
  assert.equal(v.ok, false, 'a bundle rendered with one bottle must fail');
  assert.equal(v.status, 'wrong-unit-count');
}

// An EMPTY inventory on a plate is unreported, not clean. Scoring an unanswered question
// as a pass is how a gate becomes decorative — same posture as fidelityVerdict.
{
  const v = inventoryVerdict([], { expectedUnits: 1, mode: 'plate' });
  assert.equal(v.ok, false);
  assert.equal(v.status, 'unreported');
}
// Entries with no object text carry nothing a human could act on and are dropped, which
// leaves an all-junk inventory reading as unreported rather than as clean.
assert.equal(inventoryVerdict([{ kind: 'product-unit' }], { expectedUnits: 1, mode: 'plate' }).status, 'unreported');

// FINISHED frames are not inventoried. Their layoutBrief asks for columns, rules,
// ingredient cut-outs and a styled scene, so "does this object belong" has no answer.
for (const inv of [[], ONE_UNIT, [{ object: 'a coconut', kind: 'other' }]]) {
  const v = inventoryVerdict(inv, { expectedUnits: 1, mode: 'finished' });
  assert.equal(v.ok, true, 'a finished frame is never failed by the inventory');
  assert.equal(v.status, 'not-applicable');
}

// Wired through verdictFor, and the reason names the object.
{
  const v = verdictFor({
    expected: ['A'], checks: cleanChecks(['A']), format: plainFormat, mode: 'plate',
    volumeStrings: TRUE_VOLUME, productVolume: 'ILLEGIBLE', unitCount: 1,
    sceneInventory: [...ONE_UNIT, { object: 'a slice of wood', kind: 'other' }],
  });
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some(r => /a plate must not contain/i.test(r)));
  assert.ok(v.reasons.some(r => /slice of wood/.test(r)), 'the stray object must appear in the reasons');
  assert.equal(v.inventory.status, 'stray-objects');
}
{
  const v = verdictFor({
    expected: ['A'], checks: cleanChecks(['A']), format: plainFormat, mode: 'plate',
    volumeStrings: TRUE_VOLUME, productVolume: 'ILLEGIBLE', unitCount: 1,
    sceneInventory: [...ONE_UNIT, { object: 'a faded duplicate bottle', kind: 'product-unit' }],
  });
  assert.equal(v.ok, false);
  assert.ok(v.reasons.some(r => /shows 2 unit\(s\).*expected 1/.test(r)));
  assert.ok(v.reasons.some(r => /faded duplicate/.test(r)));
}
// unitCount defaults to 1 in verdictFor, so a caller that forgets to thread it gets the
// single-unit gate rather than no gate — the same posture as `mode` defaulting to
// 'finished'.
{
  const v = verdictFor({
    expected: ['A'], checks: cleanChecks(['A']), format: plainFormat, mode: 'plate',
    volumeStrings: TRUE_VOLUME, productVolume: 'ILLEGIBLE',
    sceneInventory: [...ONE_UNIT, { object: 'a second bottle', kind: 'product-unit' }],
  });
  assert.equal(v.ok, false, 'a missing unitCount must not switch the inventory gate off');
}

// The prompt asks for it on plates and not on finished frames, and never tells the
// verifier how many units to expect — that would be R1's exact failure mode, an open
// question answered towards the number in the prompt. The comparison lives in code.
{
  const platePrompt = buildVerifyPrompt({ expected: ['A'], format: plainFormat, mode: 'plate', unitCount: 3 });
  assert.ok(/SCENE INVENTORY/.test(platePrompt), 'a plate must be asked for a scene inventory');
  assert.ok(/sceneInventory/.test(platePrompt), 'and the response shape must name the field');
  assert.ok(/product-unit/.test(platePrompt) && /"other"/.test(platePrompt), 'the kinds must be enumerated');
  // A unit must be RESOLVED to be counted — closure and body both made out. The first
  // live run showed why: an open "list everything, including anything faint or ghosted"
  // question confabulated a second bottle on the empty 9:16 gradient in 9 of 9 vision
  // calls. See the note above UNRESOLVED_RE.
  assert.ok(/closure \(cap, pump or lid\)/i.test(platePrompt), 'a counted unit needs a resolvable closure');
  assert.ok(/does not\s+meet that bar/i.test(platePrompt), 'an unresolvable shape must be excluded, not counted');
  assert.ok(/shadows/i.test(platePrompt), 'shadows must be explicitly out of scope');
  assert.ok(/PRINTED ON the product's own label/i.test(platePrompt),
    'label artwork must be out of scope — it was classified as a stray in 4 of 6 live calls');
  assert.ok(!/\b3\b/.test(platePrompt.split('SCENE INVENTORY')[1] || ''),
    'the prompt must never disclose the expected unit count');

  const finishedPrompt = buildVerifyPrompt({ expected: ['A'], format: plainFormat, mode: 'finished' });
  assert.ok(!/SCENE INVENTORY/.test(finishedPrompt), 'a finished frame is not inventoried');
}

// parseVerifyResponse carries it through, and absent → [] so inventoryVerdict decides
// what empty means rather than the parser.
{
  const parsed = parseVerifyResponse(JSON.stringify({
    checks: [], sceneInventory: [{ object: 'a bottle', kind: 'product-unit' }],
  }));
  assert.deepEqual(parsed.sceneInventory, [{ object: 'a bottle', kind: 'product-unit' }]);
  assert.deepEqual(parseVerifyResponse(JSON.stringify({ checks: [] })).sceneInventory, []);
}

// ── labelGraphics is narrowed to shape and placement ────────────────────────────────
//
// It used to invite a judgement on the badge as a whole, and the badge carries arc-set
// micro-copy no vision model reads reliably at render size. Sean eyeballed both live
// rejects 2026-08-15: the 9:16 badge "looks fine" — a FALSE POSITIVE costing three paid
// attempts — and the 4:5 badge was "definitely garbled", but that frame was independently
// rejected for stray "HOIXIM HEADLINE" text baked into a plate. Narrowing loses no true
// positive. Same exclusion buildLabelStrings already applies, for the same reason.
{
  const lg = FIDELITY_ATTRIBUTES.find(a => a.key === 'labelGraphics');
  assert.ok(lg, 'labelGraphics must still exist');
  assert.ok(/SHAPE AND POSITION ONLY/i.test(lg.ask), 'labelGraphics must be scoped to shape and position');
  assert.ok(/never whether the small text/i.test(lg.ask), 'and must explicitly exclude micro-copy spelling');
  assert.ok(/illegible at render size/i.test(lg.ask), 'and say why');
  assert.ok(/shape/i.test(lg.label) && /placement/i.test(lg.label), 'the label shown to the model must say so too');
}

// ── The stray rule follows plateSetting; the unit count never does ───────────────────
//
// The first cut of the inventory failed ANY `other` object on any plate. That is right
// for a studio plate and wrong for a scene one: `problem-aware` is specified as an
// everyday moment and `top-x-review` as an editorial still life, so a counter edge or a
// soft background object is the deliverable. Sean, 2026-08-15: "there should be a scene
// when it is appropriate and everything meshes together."
//
// What does NOT relax is the unit count. A ghost second bottle is wrong in a bathroom too.
{
  const sceneish = [
    { object: 'a white lotion bottle on the counter', kind: 'product-unit' },
    { object: 'a bathroom counter', kind: 'surface' },
    { object: 'a folded towel, far left', kind: 'other' },
  ];

  const studio = inventoryVerdict(sceneish, { expectedUnits: 1, mode: 'plate', setting: 'studio' });
  assert.equal(studio.ok, false, 'a stray object fails a STUDIO plate');
  assert.equal(studio.status, 'stray-objects');

  const scene = inventoryVerdict(sceneish, { expectedUnits: 1, mode: 'plate', setting: 'scene' });
  assert.equal(scene.ok, true, 'the same object is the deliverable on a SCENE plate');
  assert.equal(scene.status, 'clean-with-scene');
  assert.equal(scene.strays.length, 1, 'and is still RECORDED, so a prop pile is visible in proof.json');

  // The unit count is absolute in both settings.
  const ghostInAScene = inventoryVerdict([
    ...sceneish,
    { object: 'a second, faded bottle behind the first', kind: 'product-unit' },
  ], { expectedUnits: 1, mode: 'plate', setting: 'scene' });
  assert.equal(ghostInAScene.ok, false, 'a ghost bottle fails even where props are allowed');
  assert.equal(ghostInAScene.status, 'wrong-unit-count');

  // setting defaults to 'studio', the strict side — a caller that forgets to thread it
  // gets the tighter gate, never the looser one. Same posture as `mode`.
  assert.equal(
    inventoryVerdict(sceneish, { expectedUnits: 1, mode: 'plate' }).ok,
    false,
    'setting defaults to studio, the strict side',
  );
}

// Wired through verdictFor from format.plateSetting, not from a parameter the caller
// has to remember.
{
  const sceneFormat = formatByKey('problem-aware');   // plateSetting: 'scene'
  const studioFormat = formatByKey('manifesto');      // plateSetting: 'studio'
  const withProp = [
    { object: 'a white lotion bottle', kind: 'product-unit' },
    { object: 'a bedside table', kind: 'surface' },
    { object: 'a ceramic lamp base at the edge of the table', kind: 'other' },
  ];
  const args = {
    expected: ['A'], checks: cleanChecks(['A']), mode: 'plate',
    volumeStrings: TRUE_VOLUME, productVolume: 'ILLEGIBLE', unitCount: 1,
    sceneInventory: withProp,
  };
  assert.equal(verdictFor({ ...args, format: sceneFormat }).ok, true, 'problem-aware may have a lamp in shot');
  assert.equal(verdictFor({ ...args, format: studioFormat }).ok, false, 'manifesto may not');
}

// The render prompt says the right thing for each setting — a scene format must not be
// handed the blanket "NO PROPS AND NO SCENE DRESSING" that flattened it the first time.
{
  const p = buildVerifyPrompt({ expected: ['A'], format: formatByKey('problem-aware'), mode: 'plate' });
  assert.ok(/SCENE INVENTORY/.test(p), 'a scene plate is still inventoried — the unit count still matters');
}

// ── The resolution bar applies to EVERY bucket (first live run, 2026-08-15) ──────────
//
// The 9:16 plate's large empty gradient produced a confabulated second bottle in 9 of 9
// vision calls across three prompt wordings. Direct pixel inspection — the upper 45% of
// the frame, greyscaled and contrast-stretched — showed only gradient and the main
// bottle's cap. There was nothing there.
//
// Two things that did NOT work, and are worth not re-attempting:
//   - de-biasing the wording. Removing "if there is a second bottle you are unsure about,
//     list it" left it at 3/3. The bias was not the mechanism.
//   - majority voting. The confabulation is CONSISTENT, not random, so N calls buy the
//     same wrong answer N times.
//
// Making the count pointed moved it out of 'product-unit' and straight into 'other',
// where the stray rule would have failed the same correct frame for a different reason.
// What the model does do reliably is SAY it cannot resolve the thing — so that is what
// is filtered, in code, in every bucket. Same shape and justification as isAbsenceReport.
assert.equal(isUnresolvedObject('a blurred, out-of-focus second bottle in the upper background'), true);
assert.equal(isUnresolvedObject('second, blurred/out-of-focus white bottle, upper portion of frame'), true);
assert.equal(isUnresolvedObject('a faint shape near the top edge'), true);
assert.equal(isUnresolvedObject('possibly a second bottle'), true);
assert.equal(isUnresolvedObject('a white lotion bottle with black cap, centre right'), false);
assert.equal(isUnresolvedObject('a slice of wood under the bottle'), false);
assert.equal(isUnresolvedObject(''), false);

{
  // The exact live inventory that failed a correct 9:16 frame. It must now pass, and the
  // hedged entry must survive in `unresolved` so a human reading proof.json still sees it.
  const live = [
    { object: 'white lotion bottle with black cap, centered lower-right, front label visible', kind: 'product-unit' },
    { object: 'blurred, out-of-focus second bottle shape in upper background, no distinct cap/body separation', kind: 'other' },
    { object: 'beige/tan gradient background surface', kind: 'surface' },
  ];
  const v = inventoryVerdict(live, { expectedUnits: 1, mode: 'plate', setting: 'studio' });
  assert.equal(v.ok, true, 'a correct frame must not be failed by a shape the model could not resolve');
  assert.equal(v.status, 'clean');
  assert.equal(v.units.length, 1);
  assert.equal(v.strays.length, 0, 'the hedged object must not count as a stray');
  assert.equal(v.unresolved.length, 1, 'but it must be RECORDED, never silently dropped');
}

{
  // A RESOLVED second unit still fails — the filter must not have swallowed the bug the
  // inventory exists for. The real 2026-08-15 ghost carried a readable wrong volume
  // ("8 fl. oz . 230ml"), so it was substantial enough to describe without hedging.
  const realGhost = [
    { object: 'white lotion bottle with black cap and label, centre', kind: 'product-unit' },
    { object: 'a second bottle behind and right of the first, its own cap and label visible', kind: 'product-unit' },
    { object: 'a flat sand surface', kind: 'surface' },
  ];
  const v = inventoryVerdict(realGhost, { expectedUnits: 1, mode: 'plate', setting: 'studio' });
  assert.equal(v.ok, false, 'a resolved second unit must still fail');
  assert.equal(v.status, 'wrong-unit-count');
}
// A resolved PROP still fails a studio plate too — the wood slice and the coconut were
// never hedged descriptions.
assert.equal(
  inventoryVerdict([
    { object: 'a white lotion bottle with black cap', kind: 'product-unit' },
    { object: 'a slice of wood under the bottle', kind: 'other' },
  ], { expectedUnits: 1, mode: 'plate', setting: 'studio' }).ok,
  false,
  'a resolved prop must still fail a studio plate',
);
// An inventory of NOTHING BUT hedged entries is unreported, not clean — the model did not
// answer the question, and scoring an unanswered question as a pass is how a gate goes
// quiet.
{
  const v = inventoryVerdict(
    [{ object: 'a faint blurred shape, possibly a bottle', kind: 'product-unit' }],
    { expectedUnits: 1, mode: 'plate', setting: 'studio' },
  );
  assert.equal(v.ok, false);
  assert.equal(v.status, 'unreported');
  assert.equal(v.unresolved.length, 1);
}

// ── scent on an unscented label (2026-08-18) ────────────────────────────────────────
//
// A manifesto 9:16 plate came back with the badge reading "ORGANIC COCONUT OIL + ESSENTIAL
// OILS" on the PURE UNSCENTED bar — a variant whose entire proposition is that it has none.
// It passed every gate: labelGraphics is deliberately narrowed to shape and placement
// (badge micro-copy garbles often enough that checking it literally rejected good frames),
// and nothing else reads the badge. That narrowing is still right for GARBLED text, which is
// illegible noise; this is legible, plausible and false.
//
// Shape is copied from volumeVerdict on purpose: TOLERATE ILLEGIBILITY, REFUSE FALSEHOOD.

test('scentVerdict fails a legible scent reading on an unscented variant', () => {
  const v = scentVerdict('ORGANIC COCONUT OIL + ESSENTIAL OILS', { variant: 'pure-unscented' });
  assert.equal(v.ok, false);
  assert.equal(v.status, 'scent-on-unscented');
  assert.match(v.read, /ESSENTIAL OILS/);
});

// ILLEGIBLE is the accepted cost of badge-sized type — the same bargain volumeVerdict
// strikes. Failing on it would reject the many correct frames whose badge simply cannot be
// resolved, which is exactly why labelGraphics was narrowed in the first place.
test('scentVerdict tolerates an unreadable or empty badge', () => {
  for (const read of ['ILLEGIBLE', '', '   ', 'NONE', 'none']) {
    assert.equal(scentVerdict(read, { variant: 'pure-unscented' }).ok, true, `must pass: "${read}"`);
  }
});

// On a SCENTED variant a badge naming its oil is correct, and there is no truth on file to
// compare a specific oil against — so the check does not run at all rather than guessing.
test('scentVerdict does not run on a scented variant', () => {
  const v = scentVerdict('ESSENTIAL OILS', { variant: 'coconut-breeze' });
  assert.equal(v.ok, true);
  assert.equal(v.status, 'not-unscented');
});

test('scentVerdict recognises every unscented variant spelling and named oils', () => {
  for (const variant of ['pure-unscented', 'Unscented', 'fragrance-free', 'fragrance free', 'no-scent']) {
    assert.equal(scentVerdict('lavender essential oil', { variant }).ok, false, `must fire for: ${variant}`);
  }
  for (const read of ['Fragrance', 'parfum', 'peppermint', 'tea tree oil', 'Scented']) {
    assert.equal(scentVerdict(read, { variant: 'pure-unscented' }).ok, false, `must catch: ${read}`);
  }
});

// A legible reading naming nothing we recognise as a scent is not a falsehood we can prove,
// so it passes. The check only ever fails on evidence, never on absence of it.
test('scentVerdict passes a legible badge that names no scent', () => {
  assert.equal(scentVerdict('ORGANIC COCONUT OIL', { variant: 'pure-unscented' }).ok, true);
  assert.equal(scentVerdict('MADE WITH ORGANIC COCONUT OIL', { variant: 'pure-unscented' }).ok, true);
});

// End to end through verdictFor: a scent falsehood must actually fail a render, because
// Photoshop cannot repaint a product label.
test('verdictFor rejects a plate whose label names a scent on an unscented variant', () => {
  const bad = verdictFor({
    expected: [], checks: [], format: formatByKey('manifesto'), mode: 'plate',
    labelScent: 'ORGANIC COCONUT OIL + ESSENTIAL OILS', variant: 'pure-unscented',
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.reasons.some(r => /names a scent ingredient on an UNSCENTED variant/.test(r)),
    `reasons must name the failure: ${JSON.stringify(bad.reasons)}`);
  assert.equal(bad.scent.ok, false);

  const good = verdictFor({
    expected: [], checks: [], format: formatByKey('manifesto'), mode: 'plate',
    labelScent: 'ILLEGIBLE', variant: 'pure-unscented',
  });
  assert.equal(good.scent.ok, true);
});

// ── the scent gate must be REACHED, not merely correct (2026-08-18) ─────────────────
//
// PR #541 shipped scentVerdict unit-tested, wired into verdictFor, and COMPLETELY INERT:
// the `product` object main() builds carried no `variant`, so renderTarget passed
// `product.variant === undefined`, scentVerdict read "not an unscented variant", and every
// frame passed. Six real plates went through it before a proof.json showed `scent:
// undefined` and gave it away.
//
// "The function is tested" is assurance that it works, not that it is reached. These two
// assertions are about REACHABILITY, so they fail if the wiring is removed even though
// scentVerdict itself stays green.

// 1. The verdict must carry `scent` — proofEntry copies NAMED fields, so a check missing
//    from the persisted record is a check nobody can audit after the run.
test('verdictFor returns a scent verdict that the proof record can persist', () => {
  const v = verdictFor({
    expected: [], checks: [], format: formatByKey('giveaway-entry'), mode: 'plate',
    labelScent: 'NONE', variant: 'pure-unscented',
  });
  assert.ok('scent' in v, 'verdictFor must expose `scent` or proofEntry cannot record it');
  assert.equal(v.scent.status, 'clean');
});

// 2. THE INERTNESS TEST. Drop the variant — exactly what the missing product key did — and
//    the identical falsehood must stop failing. If this ever asserts `ok: false`, the gate
//    has started firing without a variant and the guard below has lost its meaning.
test('without a variant the gate is inert — which is why product must carry one', () => {
  const args = {
    expected: [], checks: [], format: formatByKey('giveaway-entry'), mode: 'plate',
    labelScent: 'ORGANIC COCONUT OIL + ESSENTIAL OILS',
  };
  assert.equal(verdictFor({ ...args, variant: undefined }).scent.ok, true,
    'no variant means nothing to falsify — this is the bug shape, pinned so it stays visible');
  assert.equal(verdictFor({ ...args, variant: 'pure-unscented' }).scent.ok, false,
    'with the variant the same label text must fail');
});

// 3. THE SOURCE GUARD. The two above pass whether or not main() actually sets it, so this
//    reads the source and proves the product object carries `variant`. Delete that line and
//    this test goes red — which the unit tests above would not.
test('main() builds a product object that carries its variant', () => {
  const src = readFileSync(join(REPO_ROOT, 'agents', 'ad-studio', 'index.js'), 'utf8');
  const block = src.slice(src.indexOf('const product = {'), src.indexOf('const product = {') + 1400);
  assert.match(block, /^\s*variant,\s*$/m,
    'the product object must carry `variant`, or scentVerdict can never see an unscented variant');
  assert.match(src, /scent: r\.proof\.scent,/,
    'proofEntry must persist the scent verdict, or the check is invisible on disk');
});
