// agents/ad-studio/health-claims.js
//
// A SECOND hard gate, beside the sourcing gate in claims.js. They answer different
// questions and neither substitutes for the other:
//
//   claims.js       — "can this statement be traced to a source we hold?"
//   health-claims.js — "is this statement one a COSMETIC is allowed to make at all?"
//
// ── Why sourcing is not enough ──────────────────────────────────────────────────────
//
// On 2026-08-16 the `testimonial` format produced a verbatim, correctly-sourced customer
// review:
//
//   "I have tried prescription strength lotions, steroids, you name it, and everything
//    under the sun over the counter to no avail.... Until Real Skin Care!!!!"
//
// The sourcing gate passed it, correctly — it IS a real quote from a named source. But
// "it came from a review" is not a defence:
//
//   - FTC Endorsement Guides (16 CFR 255): an advertiser is responsible for claims
//     CONVEYED by an endorsement and must substantiate them as if it made them directly.
//     Republishing a customer's words makes them the advertiser's claim.
//   - FDA: a cosmetic becomes an unapproved DRUG based on intended use, and intended use
//     is evidenced by marketing material — testimonials explicitly included. Eczema is a
//     disease; a quote saying prescription treatment and steroids failed "to no avail...
//     Until Real Skin Care" says this lotion succeeded where drugs did not.
//   - Meta holds advertisers responsible for all ad content including third-party quotes.
//     Its enforcement is automated and inconsistent, which is the trap: passing review is
//     not a safe harbour, and the FDA exposure does not depend on whether Meta noticed.
//
// So this gate runs on EVERY zone of EVERY format, not just testimonial. Any format can
// write "heals dry, cracked skin"; the testimonial one merely made it visible.
//
// ── What is deliberately NOT blocked ────────────────────────────────────────────────
//
// Ordinary cosmetic language is the whole point of the product and stays: moisturize,
// hydrate, soothe, soften, nourish, absorb, dry skin, sensitive skin, flaky, itchy,
// irritation, barrier, non-greasy. A cosmetic may say what it DOES to the appearance and
// feel of skin. It may not say what it TREATS.
//
// Word boundaries are load-bearing: "heal" must not fire on "healthy", and "cure" must not
// fire on "manicure". The tests pin both.

/**
 * Grouped so a rejection can say WHY, which is what makes it actionable to a human and to
 * the copy model on the next attempt.
 */
export const HEALTH_CLAIM_PATTERNS = [
  {
    category: 'disease',
    why: 'names a medical condition — a cosmetic that claims to address a disease is an unapproved drug',
    pattern: /\b(eczema|psoriasis|dermatitis|rosacea|acne|keratosis|ichthyosis|hives|shingles|impetigo|cellulitis|ringworm|scabies|melanoma|infection|infected|fungal|fungus|staph|wound|wounds|ulcer|lesion|lesions)\b/i,
  },
  {
    category: 'drug',
    why: 'names a drug or a prescription treatment, which frames the product as an alternative to one',
    pattern: /\b(steroids?|cortisone|hydrocortisone|prescriptions?|prescribed|antibiotics?|antifungals?|antihistamines?|medications?|medicated|medicinal|pharmaceuticals?|over[- ]the[- ]counter|otc)\b/i,
  },
  {
    category: 'therapeutic',
    why: 'claims a therapeutic effect — cosmetics may say what they do to skin\'s appearance and feel, never what they treat, heal, cure or prevent',
    pattern: /\b(heals?|healed|healing|cures?|cured|curing|treats?|treated|treating|treatment|remedy|remedies|reverses?|reversed|reversing|prevents?|prevented|preventing|prevention|therapeutic|therapy|diagnos\w*)\b/i,
  },
  {
    category: 'substantiation',
    why: 'asserts clinical or regulatory backing that would have to be substantiated exactly as worded',
    pattern: /\b(clinically\s+(proven|tested|shown)|dermatologist[- ]?(tested|approved|recommended)|fda[- ]?(approved|cleared)|medically\s+(proven|approved)|doctor[- ]?(approved|recommended))\b/i,
  },
];

/**
 * Every health-claim hit in one string.
 *
 * @param {string} text
 * @returns {{category:string, why:string, match:string}[]}
 */
export function findHealthClaims(text) {
  const s = String(text ?? '');
  if (!s.trim()) return [];
  const hits = [];
  for (const { category, why, pattern } of HEALTH_CLAIM_PATTERNS) {
    const m = s.match(new RegExp(pattern.source, 'gi'));
    if (m) hits.push({ category, why, match: m[0] });
  }
  return hits;
}

/**
 * Does this string carry any language a cosmetic must not use?
 * @param {string} text
 */
export function hasHealthClaim(text) {
  return findHealthClaims(text).length > 0;
}

/**
 * HARD GATE. Throws if any zone carries disease, drug, therapeutic or substantiation
 * language. No override flag, deliberately — same posture as assertClaimsSourced, and for
 * a stronger reason: an unsourced claim costs a re-render, a drug claim on a cosmetic is a
 * regulatory problem that outlives the campaign.
 *
 * Runs on the ZONES, which are the strings that actually get set into the ad. Checking the
 * claims array instead would miss pure-persuasion copy, which carries no claim entry at
 * all and is exactly where "heals dry skin" would land.
 *
 * @param {Record<string, string|string[]>} zones
 * @throws {Error} message begins "Health claim gate failed" so callers can match on it
 */
export function assertNoHealthClaims(zones) {
  const violations = [];
  for (const [zone, value] of Object.entries(zones || {})) {
    const parts = Array.isArray(value) ? value : [value];
    for (const part of parts) {
      for (const hit of findHealthClaims(part)) {
        violations.push({ zone, text: String(part), ...hit });
      }
    }
  }
  if (!violations.length) return;

  const lines = violations.map(v => `  [${v.zone}] "${v.match}" — ${v.why}`);
  throw new Error(
    `Health claim gate failed — ${violations.length} disallowed health claim(s):\n${lines.join('\n')}\n` +
    `A cosmetic may describe how it changes the appearance and feel of skin. It may not ` +
    `name a disease, name a drug, or claim to treat, heal, cure or prevent anything — and ` +
    `quoting a customer does not change that, because an advertiser is responsible for the ` +
    `claims an endorsement conveys.`
  );
}

/**
 * Drop reviews the writer must not quote, before it ever sees them.
 *
 * Prevention as well as detection. The gate above would catch a disease quote after the
 * copy call, but that costs a call and an attempt for a choice the writer never needed to
 * make — the same "detection without prevention burns retries" lesson the safe-zone block
 * and the physical description both taught. A review set of 26 has plenty of quotes that
 * are just as persuasive without condition language.
 *
 * @param {string[]} reviews
 * @returns {string[]}
 */
export function selectQuotableReviews(reviews) {
  return (reviews || []).filter(r => !hasHealthClaim(r));
}
