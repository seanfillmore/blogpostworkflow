// agents/ad-studio/verify.js
//
// Stage 4. Nothing ships unread.
//
// Four checks, all required:
//   1. per-string checks — for each requested string, a POINTED yes/no about that exact
//                          character sequence, plus the literal text of that region
//   2. product volume     — read-or-ILLEGIBLE; illegible passes, WRONG fails
//   3. defects            — finished: text obscured, cut off at the frame edge, or garbled
//                           plate:    any text at all outside the product's own label; an
//                                     EMPTY copy zone is the deliverable, never a defect
//   4. pairing            — an ad whose words are all spelled correctly but whose
//                           pictures sit against the wrong labels
//
// ── Why this file was rebuilt (2026-08-14) ──────────────────────────────────────
//
// v1 asked the model to TRANSCRIBE every string and then looked for the expected text
// inside that transcript. A `manifesto` ad was accepted on attempt 1 whose rendered
// headline read "THE MOISTURIZING CLAIM DOES MORE WORK TTHAN THE FORMLA" and whose
// bottle carried a garbled "CERAMIO OCOCONUT OIL" badge over a "4 FL oz / 118ml"
// volume (the product is 8 fl. oz. / 236ml). The proof.json reported a perfect
// transcript, `missing: []`, `ok: true`.
//
// Three independent defects produced that pass, and each is fixed here:
//
//   R1. Open transcription invites auto-correction. A vision model reading text
//       SEMANTICALLY repairs misspellings on the way out — it reported FORMULA where
//       the pixels said FORMLA, and reconstructed the word "actually" that the bottle
//       was physically sitting on top of. The prompt already said "Do not correct
//       spelling"; it did not help, because the request itself ("transcribe this") is
//       a reading task and reading is where the repair happens.
//
//       So the verdict is no longer driven by a transcript. Each expected string gets
//       its own pointed question — does THIS exact character sequence appear, yes or
//       no, and what does that region actually say — and the model's own quoted
//       `rendered` text is then re-checked mechanically by diffTranscript. That is two
//       independent shots at the same defect: the model has to both answer "yes" AND
//       quote text that survives the token-boundary match. A transcript is still
//       collected, but purely as diagnostic output for proof.json.
//
//   R2. `productProminent: false` removed labelStrings from the expected set WHOLESALE,
//       so a garbled or outright wrong label went completely unchecked. That flag now
//       gates only the non-volume label strings (brand mark, product type, variant
//       name), which genuinely cannot be read off a product rendered "small and
//       understated at the bottom center". The VOLUME is checked on every format, in a
//       shape that tolerates illegibility but not falsehood: ILLEGIBLE passes, a value
//       matching the true volume passes, a value that contradicts it FAILS.
//
//   R3. Nothing looked for occlusion or truncation. The product physically covered the
//       word "actually" in the closing line and the verifier silently reconstructed it.
//       A human would reject an ad whose product sits on top of its own copy; the gate
//       now does too, along with text running off the frame edge and garbled glyph runs.
//
// ── R3a: the defect check is MODE-AWARE (2026-08-14, same day) ──────────────────
//
// R3 shipped asking one question in both modes — "what copy here is not fully legible
// and correct" — and on a PLATE that question has no correct answer. A plate is rendered
// under an instruction to put NO text anywhere except the product's own label and to
// leave every copy zone "completely empty and clean"; Google Demand Gen mixes the text
// assets in at serve time. The emptiness IS the deliverable. Asked what copy was
// illegible, the verifier truthfully answered "the header bars are empty, the list rows
// have no text" and the gate failed 5 of 18 plates on a live run for being exactly right:
//
//   [obscured] "[black rounded bar, left]"   — solid black bar with no text inside it
//   [obscured] "[list items next to X marks]" — four rows with X icons and blank lines
//
// So in plate mode the question is INVERTED, not dropped. Absence of text is never a
// defect; text that is PRESENT anywhere but the product's own label is — the same run
// rendered a bottom bar reading "A LIBCDEFGHIJKLM NOPQRSTUVWXYZ" into a plate that was
// supposed to be clean, and that must keep failing. Stray text on a plate is arguably
// the more serious defect of the two: it cannot be fixed by the copy layer, it ships
// as pixels.
//
// The prompt asks the inverted question, and normalizeDefects backstops it: on a plate,
// a defect entry that quotes no rendered characters (a bracketed description of a region,
// or the word "blank") is a report of ABSENCE and is dropped. Finished mode is untouched
// — obscured, cut off and garbled all still fail there, which is what caught the
// corrupted headline and the bottle sitting on top of its own closing line.
//
// The model was also raised from Haiku to Sonnet (config/creative-models.js). This is
// one vision call guarding a ~$0.13 render that a human would otherwise have to read.

import { normalizeForMatch } from './claims.js';

/**
 * `mode` is 'finished' (Meta baked frame) or 'plate' (Demand Gen, text-free).
 *
 * A PLATE carries no ad copy by construction — buildRenderPrompt's plate branch says
 * "ABSOLUTELY NO TEXT ... anywhere in the image, except the product's own printed
 * label". So a plate has no labels to pair pictures with, and asking for pairings on
 * one can only produce noise. Both this prompt and verdictFor gate the pairing check
 * on mode for that reason; see verdictFor.
 *
 * It is also why the DEFECT question is inverted on a plate (R3a). Asking a plate "what
 * copy here is illegible" has no correct answer — the copy zones are empty on purpose,
 * and the verifier answering honestly failed 5 of 18 plates on a live run. The plate is
 * asked the opposite question instead: what text is PRESENT that should not be. Absence
 * is never reportable; stray glyphs always are.
 *
 * Defaults to 'finished' — the strict side — so a caller that forgets to thread mode
 * through gets the tighter gate, never the looser one.
 *
 * @param {{expected:string[], format:object, mode?:string, volumeStrings?:string[]}} args
 */
export function buildVerifyPrompt({ expected, format, mode = 'finished', volumeStrings = [] }) {
  const list = (expected || []).map(s => `  - "${s}"`).join('\n');
  const wantsPairings = format.pairsImagesWithLabels && mode === 'finished';
  const isPlate = mode === 'plate';

  const intro = isPlate
    ? `You are proofreading a text-free BACKGROUND PLATE before it goes live. It is not a
finished ad: the ad copy is supplied separately and composited over this image at serve
time, so this image was rendered under an instruction to contain NO text of any kind
except the product's own printed label, and to leave every area where copy will later sit
completely empty and clean.`
    : `You are proofreading a finished advertisement image before it goes live.`;

  const defectsSection = isPlate
    ? `3. STRAY TEXT — every headline bar, list row, caption slot and panel in this layout is
   SUPPOSED to be empty. An empty bar, a blank line, a row of icons with nothing written
   beside them: that is this image working exactly as specified.

   DO NOT report absent, missing or blank text. There is no ad copy in this image that
   could be obscured, cut off, truncated or incomplete, and "this bar contains no text" is
   the correct outcome, never a defect. Never describe an empty region in "defects".

   Report the OPPOSITE. List in "defects" every piece of lettering, every word, number or
   glyph run that IS physically rendered anywhere in the image other than on the product's
   own printed label. Placeholder copy ("HEADLINE", "TEXT HERE", "LOREM IPSUM"), alphabet
   or letterform strips, stray captions, invented logos, watermarks, dates, prices: on a
   plate all of it is a defect, whether it is spelled correctly or garbled.

   For each one give "text" — the characters that are actually rendered, quoted glyph by
   glyph, never a description of a region — "issue": "stray-text", and a short "detail"
   saying where in the frame it sits.

   NOT defects, do not report them:
     - text printed on the PRODUCT'S OWN LABEL — the brand mark, the arc-set badge
       micro-copy, the variant name, the volume. The label belongs on the product and is
       supposed to be there; section 2 already covers the one falsifiable part of it.
     - an empty zone, a blank bar, a blank line, or a bare icon with no text beside it.
   Return [] if there is no text anywhere outside the product's own label.`
    : `3. DEFECTS — list every piece of the AD'S OWN TYPESET COPY that is not fully legible
   and correct, in "defects". Report a defect when such text is:
     - overlapped, covered or obscured by another element (including the product itself)
     - running off the edge of the frame, cropped, or cut off
     - garbled: doubled letters, dropped letters, transposed letters, nonsense letter
       runs, or a word that is not correctly spelled
   For each defect give "text" (as rendered, not as you think it was meant) and "issue"
   (one of "obscured", "cut-off", "garbled") and a short "detail".

   NOT defects, do not report them:
     - text printed on the PRODUCT'S OWN LABEL — the brand mark, the arc-set badge
       micro-copy, the variant name, the volume. That label renders small by design and
       its curved micro-copy cannot be read reliably at any render size; the one part of
       it that carries a falsifiable spec is the volume, and section 2 already covers it.
       (This exclusion is about text physically printed on the bottle. Type that belongs
       to the ad's layout — headlines, rules, bottom bars, price/offer badges set on the
       background — is IN scope even when it sits near the product.)
     - text that is merely small, soft or low-resolution but not actually wrong. An
       overlap, a crop or a wrong glyph is a defect; "I cannot fully confirm this" is not.
     - correctly-spelled brand names, deliberate stylistic capitalisation, letterspacing
       and intentional line breaks.
   Return [] if there are none.`;

  return `${intro} This image
was produced by a generative image model. Those models corrupt text constantly: doubled
letters ("TTHAN"), dropped letters ("FORMLA"), invented words ("CERAMIO"), and text that
ends up underneath another object.

Your job is to READ THE PIXELS, glyph by glyph, and report what is physically there.
You are NOT reading for meaning. Do not repair, complete, normalize or auto-correct
anything: if the image says "FORMLA", your answer is "FORMLA". If an object covers part
of a word, report the covered word as covered — never infer what it must have said.

1. STRING CHECKS — for EACH requested string below, answer separately.

${list}

   For each one report:
     "expected"  — the requested string, copied exactly as written above
     "found"     — true only if that exact character sequence is physically present in
                   the image, every character, in order, correctly spelled
     "rendered"  — the literal text of the region where that string appears, or where it
                   was supposed to appear, transcribed glyph by glyph from the pixels.
                   ALWAYS fill this in, even when "found" is true. Use "" only if that
                   region contains no text whatsoever.

   Ignore ONLY these differences when deciding "found": letter case, line breaks and
   spacing, and separator punctuation (a bullet where the request has parentheses).
   Everything else means found: false — a different word, a missing word, an extra word,
   a doubled letter, a dropped letter, a transposed letter.

2. PRODUCT VOLUME — read the volume marking printed on the product itself (the
   "8 fl. oz. (236ml)" style text on the label). Report the literal text you can see in
   "productVolume". If the product is too small, too blurred, angled away, cropped out
   or simply absent, answer exactly "ILLEGIBLE". Never guess it, never infer it from the
   product's proportions, and never copy it from this prompt.

${defectsSection}

4. TRANSCRIPT — every piece of text visible in the image, as rendered. Diagnostic only.
${wantsPairings ? `
5. PAIRINGS — this layout pairs a picture with each label. For every such pair, report the
   label text, a short description of what the picture actually depicts, and whether they
   match.` : ''}

Respond with JSON only:
{
  "checks": [{ "expected": "...", "found": true, "rendered": "..." }],
  "productVolume": "...",
  "defects": [{ "text": "...", "issue": "${isPlate ? 'stray-text' : 'obscured'}", "detail": "..." }],
  "transcript": ["...", "..."]${wantsPairings ? `,
  "pairings": [{ "label": "...", "depicts": "...", "matches": true }]` : ''}
}${volumeStrings.length ? `

(The product's true volume is on file and your "productVolume" answer will be compared
against it. Answering "ILLEGIBLE" when you genuinely cannot read it is correct and is
not a failure — guessing is.)` : ''}`;
}

function extractJson(raw) {
  const s = String(raw || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : s;
  try { return JSON.parse(candidate); } catch { /* fall through */ }
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try { return JSON.parse(candidate.slice(first, last + 1)); } catch { /* fall through */ }
  }
  return null;
}

/**
 * `checks` is the verdict driver and is REQUIRED — a response without it cannot be
 * scored, and defaulting it to [] would silently score every render as "everything
 * missing" while looking like a parse success. `transcript` is diagnostic and is
 * allowed to be absent (v1 required it; it no longer decides anything).
 */
export function parseVerifyResponse(raw) {
  const obj = extractJson(raw);
  if (!obj || !Array.isArray(obj.checks)) {
    throw new Error('ad-studio: could not parse verify response as JSON with a checks array');
  }
  return {
    checks: obj.checks,
    productVolume: typeof obj.productVolume === 'string' ? obj.productVolume : '',
    defects: Array.isArray(obj.defects) ? obj.defects : [],
    transcript: Array.isArray(obj.transcript) ? obj.transcript : [],
    pairings: Array.isArray(obj.pairings) ? obj.pairings : [],
  };
}

/**
 * The match is ANCHORED AT TOKEN BOUNDARIES. A plain String.includes accepts a
 * superstring, which is the single worst false pass this gate can produce:
 *
 *   expected "8 fl. oz. (236ml)"  vs rendered "18 fl. oz. • 236ml"   → passed
 *   expected "2 fl oz (60ml)"     vs rendered "12 fl oz 60ml"        → passed
 *   expected "real SKIN CARE"     vs rendered "unreal SKIN CARE"     → passed
 *
 * i.e. a render printing an invented volume on the bottle sailed through the one gate
 * that exists to stop invented specs. A match may therefore neither start nor end
 * mid-token. Whitespace is the only boundary: the hyphen is NOT one, because
 * normalizeForMatch keeps "cold-pressed" as a single token on purpose.
 */
function includesAtTokenBoundary(haystack, needle) {
  if (!needle) return false;
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) return false;
    const end = i + needle.length;
    const startsClean = i === 0 || haystack[i - 1] === ' ';
    const endsClean = end === haystack.length || haystack[end] === ' ';
    if (startsClean && endsClean) return true;
    from = i + 1;
  }
}

/**
 * Mechanical containment test: does every expected string appear in `runs`?
 *
 * No longer the primary gate (see the R1 note at the top of this file) — it is now the
 * VERIFIER of the model's own quoted `rendered` text inside evaluateChecks, and the
 * diagnostic diff against the secondary transcript. Its matching rules are unchanged
 * and must stay unchanged; every relaxation and every anchor in here was paid for.
 *
 * `runs` is checked against TWO joins of the same normalized strings, and either one
 * satisfies a match:
 *
 *   1. joined by ' | ' — preserves run boundaries (the original behaviour)
 *   2. joined by a single space — lets one expected string span *consecutive* runs
 *
 * (2) exists because the vision model reports a visual lockup as separate runs: the
 * label "real SKIN CARE" comes back as ["real", "SKIN CARE"], and "Organic Coconut Oil
 * + Essential Oils" as two runs, even though the image is correct. A live run rejected
 * 6/6 correct renders on that formatting alone.
 *
 * This relaxes run-boundary whitespace and NOTHING else. Each expected string must
 * still appear as one contiguous, correctly-spelled, correctly-ordered sequence of
 * characters. Deliberately not per-word matching and not a similarity score: the gate's
 * value is that it caught a bottom bar the model had silently rewritten, and either of
 * those would let that through.
 */
export function diffTranscript(expected, transcript) {
  const runs = (transcript || []).map(normalizeForMatch).filter(Boolean);
  const byRun = runs.join(' | ');
  const flowed = runs.join(' ');
  const missing = (expected || []).filter(e => {
    const needle = normalizeForMatch(e);
    // An expected string with no matchable text (pure punctuation) is unverifiable
    // either way; it was never a failure before the anchoring and must not become one,
    // or a stray glyph in a zone would burn three paid renders proving nothing.
    if (!needle) return false;
    return !includesAtTokenBoundary(byRun, needle) && !includesAtTokenBoundary(flowed, needle);
  });
  return { ok: missing.length === 0, missing };
}

/**
 * Score the per-string checks. THIS is the verdict driver.
 *
 * A pointed "does this exact sequence appear, yes or no" is much harder to auto-correct
 * through than "transcribe everything", but it is still one model answer. So the
 * model's "yes" is not taken on trust: the `rendered` text it quotes for that region is
 * re-run through diffTranscript's token-anchored match, and a "yes" whose own quoted
 * text does not contain the expected string is treated as a NO. The model has to get
 * both halves wrong in the same direction for a corrupted string to survive.
 *
 * Fail-closed, three ways, all of them cheap to recover from (a retry is one render):
 *   - an expected string with no check at all → missing. A model that skips the awkward
 *     string must not thereby pass it.
 *   - found:true with an empty `rendered` → missing, "quoted no rendered text". There is
 *     nothing to falsify the claim against, and an unfalsifiable pass is what this whole
 *     rebuild exists to remove.
 *   - found:true whose `rendered` fails the token-anchored match → missing.
 *
 * Checks are matched to expected strings by NORMALIZED expected text first, then
 * positionally when the model returned exactly one check per expected string in order.
 * Keying on the raw string would break on any punctuation the model re-typed.
 *
 * @returns {{missing:string[], details:{expected:string, rendered:string, reason:string}[]}}
 */
export function evaluateChecks(expected, checks) {
  const list = Array.isArray(checks) ? checks : [];
  const byExpected = new Map();
  for (const c of list) {
    const key = normalizeForMatch(c?.expected);
    if (key && !byExpected.has(key)) byExpected.set(key, c);
  }
  const positional = list.length === (expected || []).length;

  const missing = [];
  const details = [];

  (expected || []).forEach((e, i) => {
    const needle = normalizeForMatch(e);
    // Pure-punctuation expectations are unverifiable either way — same carve-out
    // diffTranscript makes, for the same reason.
    if (!needle) return;

    const check = byExpected.get(needle) || (positional ? list[i] : null);
    const rendered = typeof check?.rendered === 'string' ? check.rendered : '';

    if (!check) {
      missing.push(e);
      details.push({ expected: e, rendered: '', reason: 'the verifier returned no check for this string' });
      return;
    }
    if (check.found !== true) {
      missing.push(e);
      details.push({
        expected: e,
        rendered,
        reason: rendered
          ? `not present — that region reads "${rendered}"`
          : 'not present — the verifier reported no text in that region',
      });
      return;
    }
    if (!normalizeForMatch(rendered)) {
      missing.push(e);
      details.push({ expected: e, rendered, reason: 'reported present but the verifier quoted no rendered text' });
      return;
    }
    if (!diffTranscript([e], [rendered]).ok) {
      missing.push(e);
      details.push({
        expected: e,
        rendered,
        reason: `reported present, but the text quoted from that region is "${rendered}"`,
      });
    }
  });

  return { missing, details };
}

// "8 fl. oz. (236ml)" / "2 fl oz (60ml)" / "4 FL oz / 118ml" — the volume marking is
// stated with wildly inconsistent punctuation in the manifest prose, on the physical
// label, and in whatever the vision model types back. Compare the NUMBERS, not the
// string: separator and abbreviation differences must never fail a render, and a
// wrong number must always fail one.
const OZ_RE = /(\d+(?:\.\d+)?)\s*fl\.?\s*oz/i;
const ML_RE = /(\d+(?:\.\d+)?)\s*m\s*l\b/i;

// Answers that mean "I could not read it". The prompt asks for exactly "ILLEGIBLE";
// the synonyms are here because a model that types "not visible" has still told us it
// could not read the label, and punishing the wording rather than the answer would
// burn three paid renders on a product that is small BY DESIGN.
const ILLEGIBLE_RE = /^(illegible|unreadable|not\s*(visible|legible|readable|present)|none|absent|n\/?a|unknown)\.?$/i;

export function readVolume(text) {
  const s = String(text || '');
  const oz = s.match(OZ_RE);
  const ml = s.match(ML_RE);
  return {
    oz: oz ? Number(oz[1]) : null,
    ml: ml ? Number(ml[1]) : null,
  };
}

/**
 * Volume markings out of a product's labelStrings, so index.js does not have to know
 * the shape of a volume string in two places.
 */
export function selectVolumeStrings(labelStrings) {
  return (labelStrings || []).filter(s => {
    const v = readVolume(s);
    return v.oz !== null || v.ml !== null;
  });
}

/**
 * Tolerant of ILLEGIBLE, intolerant of WRONG. See R2 at the top of this file.
 *
 * `productProminent: false` used to strip labelStrings out of the expected set
 * entirely, which is how "4 FL oz / 118ml" shipped on an 8 fl. oz. bottle. The reason
 * that flag existed is real — no vision model can read a 6pt volume marking off a
 * product rendered "small and understated at the bottom center", and demanding it back
 * fails every attempt and burns the retries — but the response to "cannot read it" is
 * to accept "cannot read it", not to stop asking.
 *
 *   ILLEGIBLE / no digits readable        → pass  (the legitimate small-product case)
 *   a number that agrees with the truth   → pass
 *   a number that contradicts the truth   → FAIL
 *
 * Only the dimensions the model actually reported are compared: reading "8 fl. oz."
 * off a bottle whose ml marking is turned away is a correct read, not a mismatch.
 *
 * @returns {{ok:boolean, status:string, read:string, expected:string[]}}
 */
export function volumeVerdict(productVolume, volumeStrings) {
  const read = String(productVolume || '').trim();
  const truths = (volumeStrings || []).map(readVolume).filter(v => v.oz !== null || v.ml !== null);

  // Nothing on file to compare against — this product's manifest entry carries no
  // volume marking, so there is no claim to falsify. (index.js already aborts a run
  // whose labelStrings come back empty for the separate, stronger reason that an
  // unnamed label is how the image model invents a volume in the first place.)
  if (truths.length === 0) return { ok: true, status: 'no-volume-on-file', read, expected: [] };

  const expectedList = (volumeStrings || []).filter(s => {
    const v = readVolume(s);
    return v.oz !== null || v.ml !== null;
  });

  if (!read || ILLEGIBLE_RE.test(read)) return { ok: true, status: 'illegible', read, expected: expectedList };

  const got = readVolume(read);
  // The model typed something, but no volume number can be pulled out of it. That is
  // not a contradicted spec — it is another flavour of "could not read it".
  if (got.oz === null && got.ml === null) return { ok: true, status: 'illegible', read, expected: expectedList };

  const agrees = truths.some(t =>
    (got.oz === null || t.oz === null || got.oz === t.oz) &&
    (got.ml === null || t.ml === null || got.ml === t.ml)
  );

  return {
    ok: agrees,
    status: agrees ? 'match' : 'mismatch',
    read,
    expected: expectedList,
  };
}

const DEFECT_ISSUES = new Set(['obscured', 'cut-off', 'garbled', 'stray-text']);

// Does this string quote any actual rendered character? Letters and digits only —
// "—", "___" and "[]" quote nothing.
const HAS_GLYPH_RE = /[\p{L}\p{N}]/u;
// A whole-string bracket wrap is the model DESCRIBING a region, not quoting glyphs off
// it: "[black rounded bar, left]", "(the four list rows)". Every false positive in the
// live plate run had this exact shape. The plate prompt tells the model to quote
// characters "glyph by glyph, never a description of a region", so a bracket wrap is a
// reliable tell — and this test runs on plates ONLY, where a bracketed report can only
// mean "there is nothing here". In finished mode "[the closing line]" may well be a real
// occlusion report and is left alone.
const BRACKETED_DESCRIPTION_RE = /^[[(<][\s\S]*[\])>]$/;
// The same statement in words rather than brackets.
const ABSENCE_WORD_RE = /^(blank|empty|none|nothing|no\s+text|not\s+present|absent|missing|n\/?a)\.?$/i;

/**
 * A defect entry that reports the ABSENCE of text rather than quoting text that is
 * present. Only meaningful on a plate, where absence is the specification (R3a).
 */
function isAbsenceReport(text) {
  const t = String(text || '').trim();
  if (!HAS_GLYPH_RE.test(t)) return true;
  if (BRACKETED_DESCRIPTION_RE.test(t)) return true;
  return ABSENCE_WORD_RE.test(t);
}

/**
 * Any reported defect fails the render. A human would reject an ad whose product sits
 * on top of its own closing line — the live manifesto frame did exactly that and the
 * verifier reconstructed the covered word instead of reporting it.
 *
 * Entries with no `text` at all are dropped: an empty object carries nothing a human
 * could act on from the proof file, and treating it as a failure would make a model
 * formatting slip indistinguishable from a real occlusion.
 *
 * On a PLATE (R3a) entries that report an absence are dropped as well. The plate is
 * specified empty wherever copy will later be set, so "this bar has no text in it" is
 * the deliverable and must never fail a render — while text that IS rendered on a plate
 * still fails, because it cannot be fixed by the copy layer. `mode` defaults to
 * 'finished', the strict side, so a caller that forgets to thread it keeps the full
 * obscured/cut-off/garbled gate.
 */
export function normalizeDefects(defects, mode = 'finished') {
  return (defects || [])
    .filter(d => d && typeof d.text === 'string' && d.text.trim())
    .filter(d => mode !== 'plate' || !isAbsenceReport(d.text))
    .map(d => ({
      text: d.text.trim(),
      issue: DEFECT_ISSUES.has(String(d.issue || '').toLowerCase()) ? String(d.issue).toLowerCase() : 'unspecified',
      detail: typeof d.detail === 'string' ? d.detail : '',
    }));
}

/**
 * The pairing requirement applies to FINISHED frames only.
 *
 * A plate is text-free by construction, so it carries no labels, so the vision model
 * correctly reports `pairings: []` — and requiring pairings there made every Demand Gen
 * plate of a pairing format a guaranteed hard fail: 2 formats × 3 plate targets ×
 * 3 variations × 3 attempts = 54 renders (~$7) that could not succeed, with both
 * concepts reported as fully failed even though their Meta frames were fine.
 *
 * For finished frames the check is unchanged and stays exactly as strict — it is the
 * design's centrepiece, the one thing that catches an ad where every word is spelled
 * correctly and jojoba oil is captioned as coconut oil. `mode` defaults to 'finished'
 * so a caller that omits it gets the strict path.
 *
 * @param {{expected:string[], checks:object[], productVolume?:string, defects?:object[],
 *          transcript?:string[], pairings?:object[], format:object, mode?:string,
 *          volumeStrings?:string[]}} args
 */
export function verdictFor({
  expected, checks, productVolume = '', defects = [], transcript = [],
  pairings, format, mode = 'finished', volumeStrings = [],
}) {
  const reasons = [];

  // 1. Per-string checks — the verdict driver (R1).
  const { missing, details } = evaluateChecks(expected, checks);
  if (missing.length) {
    reasons.push(`${missing.length} expected string(s) missing or corrupted in the render`);
    for (const d of details) reasons.push(`  "${d.expected}" — ${d.reason}`);
  }

  // 2. Product volume — illegible passes, wrong fails, on EVERY format (R2).
  const volume = volumeVerdict(productVolume, volumeStrings);
  if (!volume.ok) {
    reasons.push(
      `product volume marking is WRONG — the render shows "${volume.read}", ` +
      `the product is ${volume.expected.join(' / ')}`
    );
  }

  // 3. Text defects (R3), mode-aware (R3a): on a finished frame, copy that is obscured,
  //    cut off or garbled; on a plate, copy that exists at all outside the product label.
  const reportedDefects = normalizeDefects(defects, mode);
  if (reportedDefects.length) {
    reasons.push(mode === 'plate'
      ? `${reportedDefects.length} text defect(s) — a plate must carry no text except the product's own label`
      : `${reportedDefects.length} text defect(s) — obscured, cut off, or garbled text`);
    for (const d of reportedDefects) reasons.push(`  [${d.issue}] "${d.text}"${d.detail ? ` — ${d.detail}` : ''}`);
  }

  // 4. Image/label pairing — unchanged, still the design's centrepiece.
  let mismatchedPairs = [];
  if (format.pairsImagesWithLabels && mode === 'finished') {
    if (!pairings || pairings.length === 0) {
      reasons.push('no pairings reported for a layout that pairs images with labels');
    } else {
      mismatchedPairs = pairings.filter(p => p.matches === false);
      if (mismatchedPairs.length) {
        reasons.push(`${mismatchedPairs.length} image/label pairing mismatch(es)`);
      }
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    missing,
    checkDetails: details,
    volume,
    defects: reportedDefects,
    mismatchedPairs,
    // Secondary diagnostic only — see R1. Recorded in proof.json so a human reading a
    // failure can see what the model thought the frame said, but it decides nothing.
    transcriptDiff: diffTranscript(expected, transcript),
  };
}
