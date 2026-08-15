// agents/ad-studio/critique.js
//
// Stage 5b. "Is this frame USABLE?" — asked separately from "is every fact on it correct?"
//
// verify.js answers the second question: text, volume, product fidelity, image/label
// pairing. It has never answered the first. A frame can pass every check it has and still
// be unrunnable — a headline sitting underneath Instagram's own UI chrome, or body copy
// set in a tone the background swallows on a phone.
//
// WHY THIS IS A SEPARATE CALL, NOT MORE SECTIONS IN buildVerifyPrompt.
// That prompt's central instruction is "You are NOT reading for meaning. Do not repair,
// complete, normalize or auto-correct anything" — a deliberately literal pixel read,
// arrived at over five fix rounds after a vision model auto-corrected FORMLA into FORMULA
// and passed a corrupted ad. Art direction is the opposite instruction: step back, judge
// the whole. Asking one call to do both contradicts its own framing and puts a gate that
// took five rounds to stabilise at risk. It runs only on frames that ALREADY passed
// verify, so it is never paid for on a frame that was going to be rejected anyway.
//
// THE TWO PARTS BEHAVE DIFFERENTLY, AND THAT IS THE DESIGN.
//
//   PART A — objective defects, HARD FAIL, feeds the existing retry loop.
//     Safe zone and legibility. Both are facts about whether the ad can be read in the
//     placement it will be served in, not opinions about whether it is good.
//
//   PART B — subjective quality, RECORDED, never blocks.
//     A 1-5 score with notes. Making "is this a good ad?" a hard fail would reject good
//     work and pay for three attempts doing it — exactly the false-positive class that
//     cost two rounds on the fidelity check, where a first cut rejected a real photograph
//     of the product over a gloss highlight. The score exists to RANK accepted frames for
//     the operator, which is the job the Ad Studio UI spec says the operator's time
//     actually goes to.

/**
 * Ratios where the platform draws its own UI over the creative, so copy placed there is
 * invisible in the real placement even though it rendered perfectly.
 *
 * Meta unified Facebook/Instagram Stories and Reels onto a single 9:16 safe zone in
 * March 2026: top 14%, sides 6%, bottom 20% for Stories and up to 35% for Reels.
 *
 * ONLY 9:16 IS GATED. On 1:1 and 4:5 nothing is drawn over the image, so the same copy
 * placement is a margin preference rather than a defect — and gating a preference costs
 * three paid renders every time it fires.
 *
 * The gate uses the STORIES depth (bottom fifth), not the Reels depth. Reels' bottom 35%
 * plus the top 14% puts half the frame off-limits, and these six formats were not laid
 * out for that; demanding it would fail nearly every vertical frame. A frame that clears
 * Stories but not Reels is reported in the notes, where a human can weigh it.
 */
export const SAFE_ZONE_RATIOS = {
  '9:16': {
    top: 0.14,
    bottom: 0.20,
    sides: 0.06,
    // Stated to the model as fractions, never as percentages — see buildCritiquePrompt.
    topFraction: 'top one-seventh',
    bottomFraction: 'bottom one-fifth',
    reelsBottomFraction: 'bottom third',
  },
};

const VIOLATION_RE = /^(violation|violates?|violated|yes|fail(ed|s)?|bad|unsafe|no)\.?$/i;
const OK_RE = /^(ok|okay|clear|clean|pass(ed|es)?|fine|safe|none|good)\.?$/i;

/**
 * Three-valued, and unrecognised answers read as cannot-tell rather than as defects —
 * the same asymmetry as normalizeFidelityVerdict and ILLEGIBLE_RE in verify.js. A missed
 * check costs one unverified property; a wording slip read as a defect costs three paid
 * renders of a frame that was fine.
 */
export function normalizeZoneVerdict(verdict) {
  const v = String(verdict ?? '').trim();
  if (VIOLATION_RE.test(v)) return 'violation';
  if (OK_RE.test(v)) return 'ok';
  return 'cannot-tell';
}

/**
 * @param {{ratio:string, format:object, zones:object}} args
 */
export function buildCritiquePrompt({ ratio, format, zones = {} }) {
  const safe = SAFE_ZONE_RATIOS[ratio];
  const copyList = Object.entries(zones || {})
    .map(([zone, value]) => `  ${zone}: ${Array.isArray(value) ? value.join(' / ') : value}`)
    .join('\n');

  // Fractions, not percentages. A vision model estimates "is this in the top seventh of
  // the frame" far more reliably than "is this in the top 14%", and the entire value of
  // this check rests on that estimate being trustworthy. "14%" invites a confident guess.
  const safeZoneSection = safe
    ? `1. SAFE ZONE — this is a VERTICAL ${ratio} frame, served in Instagram and Facebook
   Stories and Reels. The platform draws its OWN interface over the creative: the account
   name and "Ad" label across the ${safe.topFraction} of the frame, and the like / comment /
   share / audio controls across the ${safe.bottomFraction}. Anything the advertiser puts
   there is covered up in the real placement.

   Look at the AD'S OWN TYPESET COPY — headlines, body copy, bottom bars, price or offer
   badges. Ignore the product itself and any background imagery; a bottle may sit anywhere.

   Answer "safeZone":
     "VIOLATION"    — some of the ad's typeset copy sits inside the ${safe.topFraction} or
                      the ${safe.bottomFraction} of the frame.
     "OK"           — all of the ad's typeset copy sits between those two bands.
     "CANNOT_TELL"  — you genuinely cannot judge the position.
   In "safeZoneDetail", name the copy and say which band it sits in.

   Separately: Reels reserves a deeper bottom band than Stories does — roughly the
   ${safe.reelsBottomFraction}. If the copy clears the ${safe.bottomFraction} but sits inside
   the ${safe.reelsBottomFraction}, that is NOT a violation; mention it in "reasons" instead.

`
    : '';

  const n = safe ? 2 : 1;

  return `You are an ART DIRECTOR reviewing a finished advertisement before it goes live.
You are not proofreading it — the spelling and the facts have already been checked by
someone else, and you should not comment on them. Judge whether this frame WORKS.

The copy that was commissioned for this frame:
${copyList || '  (none supplied)'}

${safeZoneSection}${n}. LEGIBILITY AT THUMB SIZE — this ad will be seen on a phone, roughly the size
   of a playing card, while the viewer is scrolling. Can the ad's typeset copy actually be
   READ at that size?

   Answer "legibility":
     "VIOLATION"    — some of the ad's typeset copy cannot be read at that size: too
                      little contrast against what sits behind it, or set far too small.
     "OK"           — all of the ad's typeset copy is comfortably readable.
     "CANNOT_TELL"  — you genuinely cannot judge it.
   In "legibilityDetail", name the copy and say what makes it hard to read.

   Judge CONTRAST and SIZE only. Do not report a typeface you dislike, a colour you would
   not have chosen, or copy that is merely small but still readable. Text printed on the
   product's own label is out of scope entirely — it is part of the product, not the ad.

${n + 1}. QUALITY — score this frame 1 to 5 as an advertisement. 5 is one you would run
   today; 1 is one you would throw away. Weigh whether the eye lands on the right thing
   first, whether the headline earns attention, and whether the layout looks deliberate
   rather than assembled. Put your reasoning in "reasons" as short phrases.

   This score does NOT decide whether the frame ships — it ranks frames for a human who
   will choose between them. Score honestly. A 2 is a useful answer.

Respond with JSON only:
{
${safe ? `  "safeZone": "OK",
  "safeZoneDetail": "",
` : ''}  "legibility": "OK",
  "legibilityDetail": "",
  "score": 4,
  "reasons": ["...", "..."]
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

export function parseCritiqueResponse(raw) {
  const obj = extractJson(raw);
  if (!obj) throw new Error('ad-studio: could not parse critique response as JSON');
  return {
    safeZone: typeof obj.safeZone === 'string' ? obj.safeZone : undefined,
    safeZoneDetail: typeof obj.safeZoneDetail === 'string' ? obj.safeZoneDetail : '',
    legibility: typeof obj.legibility === 'string' ? obj.legibility : undefined,
    legibilityDetail: typeof obj.legibilityDetail === 'string' ? obj.legibilityDetail : '',
    score: obj.score,
    reasons: Array.isArray(obj.reasons) ? obj.reasons.filter(r => typeof r === 'string') : [],
  };
}

/**
 * A score is 1-5 or it is nothing. Never coerce a missing or malformed score to 0 — the
 * whole point of the number is to rank accepted frames for the operator, and a 0 would
 * sort a frame that was never scored below a frame genuinely judged terrible.
 */
function readScore(score) {
  const n = typeof score === 'number' ? score : Number(score);
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r >= 1 && r <= 5 ? r : null;
}

/**
 * PART A fails, PART B is recorded. See the header.
 *
 * `mode` defaults to 'finished' — the side that has checks — so a caller that forgets to
 * thread it does not silently switch the gate off.
 *
 * @param {{safeZone?:string, safeZoneDetail?:string, legibility?:string,
 *          legibilityDetail?:string, score?:any, reasons?:string[],
 *          mode?:string, ratio?:string}} args
 * @returns {{ok:boolean, status:string, reasons:string[], notes:string[],
 *            score:number|null, safeZone:string, legibility:string}}
 */
export function critiqueVerdict({
  safeZone, safeZoneDetail = '', legibility, legibilityDetail = '',
  score, reasons = [], mode = 'finished', ratio = '',
} = {}) {
  const notes = (reasons || []).filter(r => typeof r === 'string' && r.trim()).map(r => r.trim());
  const readScoreValue = readScore(score);

  // A PLATE carries no typeset copy by construction — buildRenderPrompt's plate branch
  // forbids all text except the product's own label. Both hard checks are about the ad's
  // copy, so neither has an answerable question here. Asking anyway is the mistake that
  // made every plate of a pairing format an unavoidable hard fail.
  if (mode === 'plate') {
    return {
      ok: true, status: 'not-applicable', reasons: [], notes,
      score: readScoreValue, safeZone: 'not-applicable', legibility: 'not-applicable',
    };
  }

  const zoneGated = Boolean(SAFE_ZONE_RATIOS[ratio]);
  const zone = normalizeZoneVerdict(safeZone);
  const legib = normalizeZoneVerdict(legibility);

  // Neither hard check answered. A silent all-clear is indistinguishable from a stage
  // that was never wired up — the pairing check's precedent, and fidelityVerdict's.
  if (safeZone === undefined && legibility === undefined) {
    return {
      ok: false, status: 'unreported',
      reasons: ['the layout critique reported neither a safe-zone nor a legibility answer'],
      notes, score: readScoreValue, safeZone: zone, legibility: legib,
    };
  }

  const failures = [];

  // Only gated ratios can fail on placement. On 1:1 and 4:5 a "VIOLATION" answer is a
  // margin opinion about a frame nothing is drawn over; it is kept as a note.
  if (zone === 'violation') {
    if (zoneGated) {
      failures.push(`ad copy sits inside the platform safe zone${safeZoneDetail ? ` — ${safeZoneDetail}` : ''}`);
    } else {
      notes.push(`safe-zone note (not gated on ${ratio || 'this ratio'})${safeZoneDetail ? `: ${safeZoneDetail}` : ''}`);
    }
  }

  if (legib === 'violation') {
    failures.push(`ad copy is not legible at thumb size${legibilityDetail ? ` — ${legibilityDetail}` : ''}`);
  }

  return {
    ok: failures.length === 0,
    status: failures.length ? 'defect' : 'ok',
    reasons: failures,
    notes,
    score: readScoreValue,
    safeZone: zone,
    legibility: legib,
  };
}
