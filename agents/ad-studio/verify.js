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

export function buildVerifyPrompt({ expected, format }) {
  const list = expected.map(s => `  - "${s}"`).join('\n');
  const wantsPairings = format.pairsImagesWithLabels;

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
 */
export function diffTranscript(expected, transcript) {
  const haystack = (transcript || []).map(normalizeForMatch).join(' | ');
  const missing = (expected || []).filter(e => !haystack.includes(normalizeForMatch(e)));
  return { ok: missing.length === 0, missing };
}

export function verdictFor({ expected, transcript, pairings, format }) {
  const reasons = [];
  const { missing } = diffTranscript(expected, transcript);
  if (missing.length) {
    reasons.push(`${missing.length} expected string(s) missing or corrupted in the render`);
  }

  let mismatchedPairs = [];
  if (format.pairsImagesWithLabels) {
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
