// agents/ad-studio/verify.js
//
// Stage 4. Nothing ships unread.
//
// Two checks, both required for formats that pair pictures with words:
//   1. text diff   — catches corrupted glyph runs (THE RLALVJAY, bactera)
//   2. pairing     — catches an ad where every word is spelled correctly but the
//                    supporting images sit against the wrong labels
//
// Check 2 exists because a text-only gate demonstrably passes a broken ad.

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
 * Defaults to 'finished' — the strict side — so a caller that forgets to thread mode
 * through gets the tighter gate, never the looser one.
 */
export function buildVerifyPrompt({ expected, format, mode = 'finished' }) {
  const list = (expected || []).map(s => `  - "${s}"`).join('\n');
  const wantsPairings = format.pairsImagesWithLabels && mode === 'finished';

  return `You are proofreading a finished advertisement image before it goes live.

Transcribe EVERY piece of text visible in the image, exactly as rendered — including any
text printed on the product itself. Do not correct spelling; report what is actually there.

For reference, the copy that was requested is:
${list}
${wantsPairings ? `
This layout pairs a picture with each label. For every such pair, report the label text, a
short description of what the picture actually depicts, and whether they match.` : ''}

Respond with JSON only:
{
  "transcript": ["...", "..."]${wantsPairings ? `,
  "pairings": [{ "label": "...", "depicts": "...", "matches": true }]` : ''}
}`;
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

export function parseVerifyResponse(raw) {
  const obj = extractJson(raw);
  if (!obj || !Array.isArray(obj.transcript)) {
    throw new Error('ad-studio: could not parse verify response as JSON with a transcript');
  }
  return { transcript: obj.transcript, pairings: Array.isArray(obj.pairings) ? obj.pairings : [] };
}

/**
 * Every expected string must appear somewhere in the transcript. Extra rendered text is
 * not a failure; missing or corrupted expected text is.
 *
 * The transcript is checked against TWO joins of the same normalized runs, and either
 * one satisfies a match:
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
 *
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
 */
export function verdictFor({ expected, transcript, pairings, format, mode = 'finished' }) {
  const reasons = [];
  const { missing } = diffTranscript(expected, transcript);
  if (missing.length) {
    reasons.push(`${missing.length} expected string(s) missing or corrupted in the render`);
  }

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

  return { ok: reasons.length === 0, reasons, missing, mismatchedPairs };
}
