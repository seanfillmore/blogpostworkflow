// agents/ad-studio/golden-thread.js
//
// "Did the hook become the whole ad?" — the golden-thread defect.
//
// Stefan Georgi, X, 2026-08-31 (adopted into .claude/skills/marketing-copy-hooks-and-formats
// at 9/10, PR #751): the hook's job is to earn attention and stay LOOSELY congruent with the
// rest of the ad. It must NOT become the ad's main theme. After it lands, the body pivots
// onto the reasons the market actually buys, and the hook's premise is paid back once, late,
// as a small bonus.
//
// WHY THIS IS A GATE AND NOT A NOTE IN A PROMPT. The same post names the mechanism that
// makes it a machine problem rather than a writer problem: an LLM builds each line off the
// previous one, so by construction it wants to take your hook and turn it into the theme.
// Every ad this fleet ships is LLM-written. That is the definition of a defect worth
// detecting deterministically rather than asking the model to self-report — the same
// reasoning that put truncation detection in lib/html-output-guards.js instead of trusting
// an editor that asserted "the final section is complete" about content cut off mid-word.
//
// ────────────────────────────────────────────────────────────────────────────────────
// THE MEASURE, AND WHY IT IS NOT "DOES THE HOOK RECUR".
//
// The obvious detector — take the headline's distinctive words, flag them recurring in the
// body — is WRONG here, and measurably so. Run it over the 10 real ads in
// data/creatives/ad-studio and it fires on `manifesto`, `us-vs-them` and `offer-focused`,
// which are three of the six format families in the catalogue and are all perfectly good
// ads. The reason is structural: on those formats the headline IS the buy reason
// ("NOTHING ADDED TO IRRITATE", rows: "No fragrance. No oils added."). Repeating it is not
// a golden thread, it is congruence, which a single static plate is supposed to have.
//
// The golden thread requires the hook's premise to be DIFFERENT FROM the buy reason. So
// what is actually diagnostic is not the hook recurring — it is THE BODY NEVER PIVOTING:
//
//   hookPremise = content words in the hook that are NOT in the product's own selling
//                 vocabulary. Empty  ⇒  the hook is itself a buy reason, there is no
//                 second premise to thread, and the ad PASSES without further analysis.
//   pivot       = distinct selling-vocabulary words the BODY carries.
//   dominance   = body words drawn from hookPremise, as a share of (premise + selling).
//
// A golden thread is a body that carries the premise and not the product: too few pivot
// words, or premise dominance too high. The format exemption above then falls out of the
// arithmetic instead of being a hardcoded list of format keys — the same reason
// lib/cluster-hold.js names no cluster in its logic.
//
// ────────────────────────────────────────────────────────────────────────────────────
// WHAT COUNTS AS "THE REASONS THE MARKET ACTUALLY BUYS", AND THE ONE EXCLUSION.
//
// sellingVocabulary is built from the PDP body, the catalog entry and the persona's angles.
// It deliberately EXCLUDES the brand kit. The brand kit is category-level context — it is
// where `category_ingredient_load` (the EWG 112-ingredient figure) lives, and that figure is
// a HOOK, not a reason anyone buys soap. Folding it in would put the hook's own premise into
// the vocabulary the pivot is measured against, so a fact-hook ad that never pivoted would
// score as though it had. The live `fact-hook` ad in the corpus is exactly this case: its
// headline is "112", and it passes on the strength of a subhead that really does pivot
// ("one ingredient: saponified organic virgin coconut oil, nothing added to irritate
// sensitive skin"), which is the right answer for the right reason.
//
// ────────────────────────────────────────────────────────────────────────────────────
// WHERE THE HOOK ENDS. `statContext` IS HOOK, NOT BODY.
//
// On `fact-hook` the headline is a bare figure and formats.js gives it "a short caption
// directly beneath it naming what the figure counts" — that caption IS the hook, finishing
// the thought the numeral starts. Scoring it as body was the single biggest measurement
// error in building this: it credited the ad for explaining its own statistic, which is
// exactly the elaboration the defect consists of, and it dropped separation to 1.1x.
// HOOK_ZONES holds that exception; every other zone is body.
//
// ────────────────────────────────────────────────────────────────────────────────────
// THRESHOLDS ARE MEASURED, NOT PICKED. Show the working or do not move them.
//
// NEGATIVE corpus: all 9 real ads under data/creatives/ad-studio, every format family this
// agent has shipped, each scored against ITS OWN product vocabulary (the live PDP body for
// that handle, its catalog entry, and the persona recorded in that run's attribution).
// Scoring them against the whole catalogue and every persona at once is NOT a conservative
// shortcut — it inflates the vocabulary to ~591 tokens, at which point almost nothing
// qualifies as a hook premise and the detector silently exempts everything. It was tried;
// it reported a flawless zero and was measuring nothing.
//
// POSITIVE corpus: 4 hand-written golden-thread plates — the hook's premise elaborated
// across every zone with the product's own reasons never stated, which is the shape an LLM
// produces by default. Hand-written adversarial fixtures are the house standard for a
// deterministic copy gate; lib/product-category-terms.js is calibrated the same way
// ("against 17 hand-written bad phrasings it misses 0").
//
//   real ads          pivot 9, 11, 11, 15, 24, 26, 28, 32   (one exempt)
//   adversarial       pivot 4, 4, 2, 1
//
//   MIN_PIVOT_TOKENS       6     Centred in the 4→9 gap: 1.5x clear in both directions.
//                                0 false positives on 9 real ads, 0 misses on 4 adversarial.
//   MAX_PREMISE_DOMINANCE  0.50  A BACKSTOP, not the operative test. Every real ad measures
//                                0.00 and pivot alone decides all 13 cases; dominance has
//                                never been the deciding trigger. It is kept for bodies
//                                longer than a plate's, where an ad can carry the product
//                                AND run the premise throughout. Do not read its headroom
//                                as evidence — it has none, because it has never fired alone.
//
// If a change ever makes a live ad fire, re-measure the corpus before moving a number —
// bending a threshold until it produces the answer somebody wanted is how the $0-cluster
// gate condemned a category that was selling $324.85.
//
// ────────────────────────────────────────────────────────────────────────────────────
// ONE HONEST LIMITATION, STATED RATHER THAN PAPERED OVER.
//
// Georgi's post ships a matched pair — same product, same buyer, same hook, one labelled
// bad and one good. That is the ideal calibration set and THE GATE DOES NOT FIRE ON THE BAD
// ONE. Two separate reasons, both structural rather than tuning problems:
//
//   1. Whole scripts do not separate at all. Both are 11 paragraphs sharing their entire
//      opening — the friend, the mist, the device — and diverging only in the final third,
//      so whole-body overlap reads them as near-identical. The per-paragraph trace shows the
//      real difference is one passage (V2's p8) that V1 simply lacks.
//   2. Isolated to their CLOSES, where they actually differ, the measure reads the right
//      thing — the bad close carries 6 selling words to the good close's 18, a 3x gap — but
//      6 still clears MIN_PIVOT_TOKENS. At long-form length even a body that never pivots
//      accumulates that much incidental product vocabulary, which a floor calibrated on 3-6
//      short plate zones cannot survive.
//
// This agent does not write 11-paragraph scripts. It writes plates of 3-6 short zones, and
// at that scale the measure separates cleanly (real 9-32, adversarial 1-4). So the scope is
// plates, the limitation is recorded, and both halves are pinned in the tests as a KNOWN
// MISS rather than quietly dropped — a long-form surface would need its own floor —
// if someone later teaches this fleet to write long-form scripts, that test is the warning
// that this gate does not yet cover them.
//
// ────────────────────────────────────────────────────────────────────────────────────
// IT IS ADVISORY AFTER ONE REGENERATION, AND THAT IS DELIBERATE.
//
// This is a judgement about quality, not a fact about compliance, so it follows
// critique.js's Part B rather than health-claims.js: one regeneration with the defect named,
// then the copy SHIPS and the finding is recorded. Blocking outright would throw away a
// paid copy call over an opinion, which is the false-positive class that has already cost
// this project real work — three paid-for briefs destroyed by a gate that decided work was
// worthless. A retry is cheap and lands before any render, so it costs one LLM call and
// zero of the $0.13 renders; refusing the concept afterwards would not be.

/** Words that carry no topical signal. Kept small on purpose — an over-long list starts
 *  deleting real product vocabulary ("free", "no", "clean" are all load-bearing here). */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'did', 'do', 'does',
  'for', 'from', 'get', 'got', 'had', 'has', 'have', 'he', 'her', 'him', 'his', 'how', 'i',
  'if', 'in', 'into', 'is', 'it', 'its', 'just', 'me', 'my', 'not', 'of', 'on', 'or', 'our',
  'out', 'she', 'so', 'some', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'to', 'up', 'was', 'we', 'were', 'what', 'when', 'which', 'who', 'will',
  'with', 'you', 'your', 'about', 'after', 'all', 'also', 'any', 'because', 'before',
  'every', 'like', 'more', 'most', 'much', 'now', 'one', 'only', 'other', 'over', 'said',
  'same', 'still', 'such', 'than', 'too', 'very', 'well', 'why', 'would', 'really', 'actually',
]);

/** Below this many characters a token is noise rather than vocabulary. */
const MIN_TOKEN_CHARS = 3;

/** @see the threshold derivation in the header. */
export const MIN_PIVOT_TOKENS = 6;
export const MAX_PREMISE_DOMINANCE = 0.50;

/**
 * Zones that finish the hook's thought rather than answering it. See the header — on
 * `fact-hook` the headline is a bare numeral and statContext is its caption, so treating
 * that caption as body credits the ad for elaborating its own statistic.
 */
export const HOOK_ZONES = Object.freeze(new Set(['headline', 'statContext']));

/**
 * Below this many selling words the check DISARMS instead of judging.
 *
 * This gate cannot tell "the ad never pivoted" from "we have no vocabulary to detect a pivot
 * with". Given an empty pdpBody and no persona the selling set is empty, EVERY headline word
 * becomes a hook premise, and the check fires on every concept — turning one copy call into
 * two for the whole run. That is not hypothetical: it is what the orchestrator test does
 * (`pdpBody: ''`), and it failed loudly, which is the only reason this guard exists.
 *
 * 40 is well below the floor of anything real — measured across the live catalogue, the
 * thinnest product vocabulary is 104 tokens (coconut-lotion) and the richest 114
 * (coconut-soap) — and comfortably above what an empty or placeholder PDP yields. A product
 * whose real PDP is under 40 content words has a bigger problem than this gate.
 *
 * Same shape as every other gate in this fleet: fail OPEN, and say so rather than reporting
 * a clean run. `disarmed` is why callers must never read `goldenThread === false` as "checked
 * and fine" — see lib/cluster-hold.js's `hold.disarmed` for the identical rule.
 */
export const MIN_SELLING_VOCABULARY = 40;

/**
 * Content words of a string, lightly stemmed.
 *
 * Stemming is a single trailing-'s' strip and nothing more. It exists so "ingredient" and
 * "ingredients" are one token — the plural gap that made `\bsoap\b` miss "soaps" in
 * lib/keyword-index/cluster.js. A real stemmer would collapse "conditioned"/"conditioner",
 * which are different claims on this catalogue, so the aggressive version is not wanted.
 *
 * Digits are KEPT: "112" is the entire headline of the live fact-hook ad, and dropping
 * numerics would make that ad's hook premise empty and auto-pass it for the wrong reason.
 */
export function contentTokens(text) {
  const flat = Array.isArray(text) ? text.join(' ') : String(text ?? '');
  return new Set(
    flat
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
      .split(/[\s-]+/)
      .map(w => w.replace(/s$/, ''))
      .filter(w => w.length >= MIN_TOKEN_CHARS && !STOPWORDS.has(w)),
  );
}

/** Every token in `parts`, as one set. Each part may be a string or an array of strings. */
export function vocabularyOf(...parts) {
  const out = new Set();
  for (const p of parts) for (const t of contentTokens(p)) out.add(t);
  return out;
}

/**
 * Build the selling vocabulary — "the reasons the market actually buys".
 *
 * The brand kit is NOT a parameter, and that omission is the point; see the header.
 */
export function sellingVocabulary({ pdpBody = '', catalogEntry = null, persona = null } = {}) {
  const catalogText = catalogEntry ? JSON.stringify(catalogEntry) : '';
  const angles = persona && Array.isArray(persona.angles) ? persona.angles : [];
  return vocabularyOf(pdpBody, catalogText, angles, persona?.name ?? '');
}

/**
 * @param {object}   args
 * @param {string|string[]} args.hook     The opening — a plate's headline, or the first
 *                                        sentence of a primary text.
 * @param {string|string[]} args.body     Everything after it.
 * @param {Set<string>}     args.selling  From sellingVocabulary().
 * @returns {{goldenThread:boolean, reason:string|null, hookPremise:string[],
 *            pivotTokens:string[], pivot:number, dominance:number, exempt:boolean,
 *            disarmed:boolean, disarmedReason?:string}}
 *
 * NEVER read `goldenThread === false` as "checked and clean" — check `disarmed` first.
 */
export function findGoldenThread({ hook, body, selling }) {
  const hookTokens = contentTokens(hook);
  const bodyTokens = contentTokens(body);
  const sell = selling instanceof Set ? selling : new Set(selling ?? []);

  // Too little vocabulary to judge against — disarm rather than condemn everything.
  if (sell.size < MIN_SELLING_VOCABULARY) {
    return {
      goldenThread: false, exempt: false, disarmed: true,
      disarmedReason: `only ${sell.size} selling words available (needs ${MIN_SELLING_VOCABULARY}) — no product vocabulary to detect a pivot against`,
      reason: null, hookPremise: [], pivotTokens: [], pivot: 0, dominance: 0,
    };
  }

  const hookPremise = [...hookTokens].filter(t => !sell.has(t));

  // The hook is built entirely out of selling vocabulary, so there is no second premise
  // that COULD become the theme. Congruence here is correct, not a defect.
  if (hookPremise.length === 0) {
    return {
      goldenThread: false, exempt: true, disarmed: false, reason: null,
      hookPremise: [], pivotTokens: [], pivot: 0, dominance: 0,
    };
  }

  const premiseSet = new Set(hookPremise);
  const pivotTokens = [...bodyTokens].filter(t => sell.has(t) && !premiseSet.has(t));
  const bodyPremise = [...bodyTokens].filter(t => premiseSet.has(t));

  const pivot = pivotTokens.length;
  const denom = bodyPremise.length + pivot;
  const dominance = denom === 0 ? 1 : bodyPremise.length / denom;

  const thin = pivot < MIN_PIVOT_TOKENS;
  const dominated = dominance > MAX_PREMISE_DOMINANCE;

  let reason = null;
  if (thin || dominated) {
    const bits = [];
    if (thin) bits.push(`the body carries only ${pivot} of the product's own selling words (needs ${MIN_PIVOT_TOKENS})`);
    if (dominated) bits.push(`${Math.round(dominance * 100)}% of its topical words come from the hook's premise (ceiling ${Math.round(MAX_PREMISE_DOMINANCE * 100)}%)`);
    reason = `The hook's premise (${hookPremise.slice(0, 6).join(', ')}) became the ad's theme: ${bits.join(', and ')}.`;
  }

  return {
    goldenThread: Boolean(reason), exempt: false, disarmed: false, reason,
    hookPremise, pivotTokens, pivot, dominance,
  };
}

/**
 * A plate's zones split into hook and body, in the format's own declaration order.
 *
 * Every format in formats.js has a headline — that file states the invariant explicitly
 * ("it keeps this format inside the invariant that every format has one") — and it is
 * always the hook. HOOK_ZONES adds the one caption zone that finishes the headline's
 * thought instead of answering it.
 */
export function splitPlateZones(zones, format) {
  const keys = format?.zones ?? Object.keys(zones ?? {});
  const pick = want => keys.filter(k => HOOK_ZONES.has(k) === want).map(k => zones?.[k]).filter(Boolean);
  return { hook: pick(true), body: pick(false) };
}

/**
 * A primary text split into hook and body: the first sentence opens, the rest carries.
 *
 * Falls back to treating the whole string as the hook with an empty body when it is a
 * single sentence — which then cannot pivot, and is reported as such rather than passed.
 */
export function splitPrimaryText(text) {
  const s = String(text ?? '').trim();
  const m = s.match(/^([\s\S]*?[.!?])\s+([\s\S]+)$/);
  return m ? { hook: m[1], body: m[2] } : { hook: s, body: '' };
}

/** The instruction that goes in the FIRST copy prompt, so most runs never need the retry. */
export const GOLDEN_THREAD_RULE = `
GOLDEN THREAD — do not let the hook become the whole ad.
The headline's job is to earn attention and open the door. It must NOT become the ad's
main theme. Once it has landed, the remaining zones pivot to the reasons this buyer
actually buys THIS product — the specific benefits in the product page copy above — and
not to elaborations of the headline's premise. If the headline rests on an outside fact,
a statistic or a startling claim, you may call back to it ONCE, late, as a small bonus
line to keep the ad congruent; never as the closing argument. When the headline is itself
a product benefit, this rule does not apply and normal congruence is correct.`.trim();

/**
 * The line added to the RETRY prompt. Names the offending premise, per the same policy
 * lib/seo-copy-health-gate.js uses: a blocked first attempt costs a regeneration with the
 * offending words quoted, never a silently dropped candidate.
 */
export function goldenThreadRetryNote(finding) {
  return `
YOUR PREVIOUS ATTEMPT HAD A GOLDEN THREAD AND WAS REJECTED.
${finding.reason}
Keep the headline. Rewrite the other zones so they carry this product's own benefits
instead of continuing the headline's premise. At most one short callback to that premise,
and not in the closing line.`.trim();
}
