// agents/ad-studio/plate-distinctness.js
//
// "Are these three plates actually three ads?" — the shared-fingerprint defect.
//
// Lorenzo Pravata, X, 2026-09-18 (adopted into
// .claude/skills/marketing-paid-creative-testing at 8/10, PR #929): Meta's retrieval and
// delivery system treats a creative as an ENTITY and recognises variations that share a
// visual fingerprint. Fifty copy-swapped versions of one image enter the auction as ONE
// ticket — they share a learning pool, share delivery, and fatigue on the same curve. Only
// a new scene, subject, format, lighting condition or time of day produces a separate
// entity with its own learning and its own fatigue clock. The field test is blunt: would a
// stranger scrolling with the sound off say "I have seen this one already"?
//
// WHY THIS IS A GATE AND NOT A NOTE IN A PROMPT — and why it is NOT a copy gate.
//
// A plate's visual content does not come from the LLM at all. `render.js` builds the image
// prompt from `format.plateBrief`, a FIXED per-format constant, so what a plate looks like
// is decided entirely by WHICH FORMATS a run picks. No amount of copy variation changes it.
// That makes this a deterministic, pre-render, zero-cost check over a closed catalogue —
// the cheapest gate in the agent — and it makes "ask the model to be more distinct"
// meaningless, because the model was never choosing.
//
// It also closes a stated hole in the `--flexible` contract. `assertFlexibleArgs` already
// refuses two primary texts or two headlines that are not distinct, on the grounds that
// "two phrasings of one angle give the shared pool nothing to learn". The three PLATES had
// no such rule, though they are the half of a 3-2-2 ad the scroller actually sees. The
// adopted tactic says so directly: the flexible ad wants three creatives of the same
// aspect ratio, and those three must still differ in scene, ground or composition, or it
// is a one-creative ad wearing three hats.
//
// ────────────────────────────────────────────────────────────────────────────────────
// THE MEASURE: THREE AXES, IN THE ORDER A SCROLLER READS THEM.
//
// Taken straight from the tactic's own list rather than invented here. Two plates are
// COMPARABLE only when they agree on the first two; otherwise they are distinct and no
// composition arithmetic is done.
//
//   1. SETTING  — `plateSetting`, studio vs scene. A plain colour ground and a real
//                 bathroom counter are not the same picture under any composition.
//   2. GROUND   — the hex in the RESOLVED brief. This is the single most salient thing at
//                 a thumb-flick: near-black, warm sand, brand green and pale grey read as
//                 different ads before any shape is parsed.
//   3. COMPOSITION — Dice over the remaining content words: where the product sits, how
//                 big it is, which areas are left empty.
//
// GROUND IS READ OUT OF THE RESOLVED TEXT, NEVER OFF `format.plateGround`, and that is a
// correctness fix rather than a style choice. `formatForVariation` swaps `plateBrief` and
// leaves `plateGround` alone, so three of `giveaway-entry`'s five variants state their own
// ground in the brief (#AEDEAC green, #000000 charcoal, #EDEDED grey) while declaring
// none. Trusting the declared field would call those variants same-ground as the sand ones
// and compare them on composition, which is exactly backwards — they are the most visually
// distinct set in the catalogue. Every studio surface carries exactly one hex in its
// resolved brief; every scene surface carries none, which is correct, because a scene has
// no colour ground to name.
//
// ────────────────────────────────────────────────────────────────────────────────────
// THRESHOLDS ARE MEASURED — AND THERE IS NO GAP. Read this before moving one.
//
// Measured 2026-09-20 over every RENDERABLE surface: all 14 formats, expanded through
// `formatForVariation` so each of `giveaway-entry`'s 5 plate variants counts separately —
// 18 surfaces, 153 pairs. Partitioned by the axes above:
//
//   different setting        56 pairs   max Dice 0.372   — never comparable
//   different ground         53 pairs   max Dice 0.857   — never comparable
//   SAME setting AND ground  44 pairs   Dice 0.164 → 0.821   ← the only judged population
//
// The 0.857 in the different-ground row is the reason ground is an axis and not just more
// tokens: those two plates share almost all their wording and still look nothing alike.
//
// Inside the judged population the distribution is CONTINUOUS — 0.821, 0.781, 0.754,
// 0.744, 0.722, … — with no gap to hide a threshold in. Unlike `lib/content-mirror.js`,
// whose 0.25 sits in a real measured void, these numbers rest on reading the briefs:
//
//   0.821  giveaway-entry/sand-hero vs spec-panel   SAME PICTURE. Both: sand ground,
//          product right at hero scale, base on the lower third, soft contact shadow,
//          left and top empty, a clear band across the bottom. The prose differs; the
//          photograph does not.
//   0.781  testimonial vs state-contrast            BORDERLINE. Both centred on sand;
//          they differ only in how big the product is.
//   0.744  stat-stack vs spec-panel                 DISTINCT. Centred vs hard right — a
//          different position, which the tactic names as a genuinely new ad.
//
// So `DUPLICATE_MAX` is placed at 0.80 to block the one pair a reading calls unambiguous
// and to leave the borderline pair advisory. That is a JUDGEMENT, recorded as one. If a
// future format makes this fire, re-read both briefs before moving the number — bending a
// threshold until it produces the answer somebody wanted is how the $0-cluster gate
// condemned a category that was selling $324.85.
//
// IT FIRES ON ALMOST NOTHING TODAY, AND THAT IS THE HONEST DESCRIPTION. Exactly one of 153
// pairs is a duplicate, and both its members are reachable together only while a giveaway
// is live. 85% of all three-format combinations pass even at the stricter warn threshold.
// This gate is not here to police today's catalogue — it is here so that the FIFTEENTH
// format, added by copying an existing plateBrief and nudging it, cannot quietly become a
// second copy of a plate we already run. That is the realistic failure, and nothing else
// in the agent would notice it.

import { resolvePlateBrief, formatForVariation } from './formats.js';

/** Words that carry no compositional signal. Deliberately small — "empty", "centred",
 *  "upper", "lower", "left", "right" and "third" are all load-bearing here. */
const STOPWORDS = new Set([
  'the', 'and', 'its', 'with', 'that', 'for', 'from', 'out', 'not', 'are', 'was', 'which',
  'this', 'all', 'any', 'into', 'than', 'then', 'has', 'have',
]);

/** Below this many characters a token is noise rather than vocabulary. */
const MIN_TOKEN_CHARS = 3;

/** @see the threshold derivation in the header. Above this, the plates are one picture. */
export const DUPLICATE_MAX = 0.80;

/**
 * The advisory band. Reported loudly and blocks nothing — the same split, and the same
 * reasoning, as `lib/content-mirror.js`'s DIVERGENT_WARN_MAX: a band we have deliberately
 * chosen not to refuse on should still be visible, because the operator may be about to
 * spend a real budget on two plates that are nearly the same ad.
 */
export const NEAR_DUPLICATE_WARN = 0.70;

/**
 * Below this many content words a brief is not describing a composition, and the check
 * DISARMS for that surface rather than guessing.
 *
 * Same doctrine as `golden-thread.js`'s MIN_SELLING_VOCABULARY and `hold.disarmed`: a
 * check that cannot see its input must say so, never quietly return "clean". The thinnest
 * real brief in the catalogue is 50 content words, so 20 is well below anything genuine
 * and comfortably above an empty or placeholder format.
 */
export const MIN_BRIEF_TOKENS = 20;

function contentTokens(text) {
  return String(text ?? '')
    .replace(/#[0-9a-f]{6}/gi, ' ')   // the ground is its own axis; see the header
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= MIN_TOKEN_CHARS && !STOPWORDS.has(w));
}

/**
 * What a format actually renders as, reduced to the three axes.
 *
 * `variation` is threaded through `formatForVariation` because a variant format renders a
 * DIFFERENT plate per variation — judging `giveaway-entry` by its declaration alone would
 * compare a picture nobody is rendering.
 */
export function plateFingerprint(format, variation = 1) {
  const resolved = formatForVariation(format, variation);
  const brief = resolvePlateBrief(resolved);
  const tokens = contentTokens(brief);
  const hex = brief.match(/#[0-9a-f]{6}/i);
  return {
    key: format?.key ?? null,
    variantKey: resolved?.plateVariantKey ?? null,
    label: format?.key + (resolved?.plateVariantKey ? `/${resolved.plateVariantKey}` : ''),
    setting: format?.plateSetting ?? null,
    ground: hex ? hex[0].toUpperCase() : null,
    tokens: new Set(tokens),
    tokenCount: tokens.length,
  };
}

function dice(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/**
 * Compare two fingerprints on the three axes, in order.
 *
 * Returns `comparable: false` when the setting or the ground already separates them — the
 * composition score is then not computed, because it would be measuring nothing. That is
 * the whole reason the 0.857 different-ground pair is not a finding.
 */
export function comparePlates(a, b) {
  if (a.tokenCount < MIN_BRIEF_TOKENS || b.tokenCount < MIN_BRIEF_TOKENS) {
    return {
      comparable: false,
      disarmed: `brief under ${MIN_BRIEF_TOKENS} content words `
        + `(${a.label}: ${a.tokenCount}, ${b.label}: ${b.tokenCount})`,
      reason: 'disarmed',
      similarity: null,
    };
  }
  if (a.setting !== b.setting) {
    return { comparable: false, reason: 'different-setting', similarity: null };
  }
  if (a.ground !== b.ground) {
    return { comparable: false, reason: 'different-ground', similarity: null };
  }
  const similarity = dice(a.tokens, b.tokens);
  const tier = similarity >= DUPLICATE_MAX ? 'duplicate'
    : similarity >= NEAR_DUPLICATE_WARN ? 'near-duplicate'
      : 'distinct';
  return { comparable: true, reason: 'same-setting-and-ground', similarity, tier };
}

/**
 * Every pair in a batch that is not visually distinct, worst first.
 *
 * `formats` is the list a run is about to render. `variations` mirrors the run's own
 * variation count so a multi-variation run is judged on the plates it will actually
 * produce; the default of 1 is what `--flexible` uses.
 *
 * A batch of one is always clean, and says so rather than being an empty special case —
 * "nothing to compare" and "compared and clean" must not render identically.
 */
export function findDuplicatePlates(formats, { variations = 1 } = {}) {
  const surfaces = [];
  for (const f of formats ?? []) {
    for (let v = 1; v <= Math.max(1, variations); v++) {
      surfaces.push(plateFingerprint(f, v));
    }
  }
  const findings = [];
  const disarmed = [];
  for (let i = 0; i < surfaces.length; i++) {
    for (let j = i + 1; j < surfaces.length; j++) {
      const r = comparePlates(surfaces[i], surfaces[j]);
      if (r.reason === 'disarmed') { disarmed.push(r.disarmed); continue; }
      if (!r.comparable || r.tier === 'distinct') continue;
      findings.push({ a: surfaces[i].label, b: surfaces[j].label, similarity: r.similarity, tier: r.tier });
    }
  }
  findings.sort((x, y) => y.similarity - x.similarity);
  return {
    surfaces: surfaces.length,
    compared: surfaces.length > 1,
    duplicates: findings.filter(f => f.tier === 'duplicate'),
    nearDuplicates: findings.filter(f => f.tier === 'near-duplicate'),
    disarmed: disarmed.length ? [...new Set(disarmed)] : null,
  };
}

/** One line per finding, for stdout and for the run report. */
export function renderDistinctnessLines(result) {
  if (!result) return [];
  const lines = [];
  if (result.disarmed) {
    lines.push(`⚠ Plate distinctness is OFF for some plates this run: ${result.disarmed.join('; ')}`);
  }
  for (const d of result.duplicates) {
    lines.push(`✗ ${d.a} and ${d.b} render the same plate (${d.similarity.toFixed(3)}) — one ad, not two`);
  }
  for (const d of result.nearDuplicates) {
    lines.push(`· ${d.a} and ${d.b} are close (${d.similarity.toFixed(3)}) — same ground, similar composition`);
  }
  return lines;
}

/**
 * The refusal message for `--flexible`, which needs to say what to do next.
 *
 * Refusing is right on that path alone: a flexible ad's entire rationale is that twelve
 * combinations feed ONE learning pool, and two plates sharing a fingerprint mean that pool
 * is learning about two ads while paying for three. It costs the operator nothing — the
 * check runs at argument parsing, before a single render — and the fix is to name a
 * different format.
 */
export function duplicatePlateRefusal(result) {
  const worst = result.duplicates[0];
  return `ad-studio: --flexible needs three visually distinct plates, and `
    + `${worst.a} and ${worst.b} are the same picture (composition similarity `
    + `${worst.similarity.toFixed(3)} on an identical ground and setting). Meta treats `
    + `near-identical creatives as ONE delivery entity, so the shared learning pool would `
    + `be funding three plates to learn about two. Swap one for a format with a different `
    + `ground or a different setting.`;
}
