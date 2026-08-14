// agents/ad-studio/claims.js
//
// The claim gate. Every factual string that will be rendered into an ad must name a
// source and quote the evidence in it. Unsourced claims stop the run BEFORE anything
// renders — there is deliberately no override flag.
//
// This exists because invented specs are cheap to produce and expensive to catch:
// during design probes a human wrote an unverified "FOUR INGREDIENTS" headline and the
// image model invented a "6 fl. oz." volume on a 2 fl oz bottle. Same failure class as
// the Blum/Texas origin drift — a plausible number nobody checked.

/**
 * Fold case, whitespace and curly punctuation so evidence matching survives the
 * cosmetic differences between PDP copy and ad copy.
 *
 * The apostrophe class carries three code points on purpose: U+2018, U+2019 and
 * U+02BC (MODIFIER LETTER APOSTROPHE, which some renderers emit for a typographic
 * apostrophe). Dropping any of them makes "that’s" and "that's" different strings.
 *
 * Separator glyphs — U+2022 bullet, U+00B7 middle dot, U+007C pipe — fold to a
 * space, not to nothing: the bottle prints "8 fl. oz. • 236ml" where the manifest
 * prose writes "8 fl. oz. (236ml)". They separate tokens, so they must become the
 * same whitespace the prose already uses, then collapse below. Word-joining
 * hyphens (U+002D) are deliberately NOT folded — "cold-pressed" must stay one
 * token — and the en/em dash fold to "-" is unchanged.
 *
 * "+" is folded ONLY where it joins two things ("Organic Coconut Oil + Essential
 * Oils", which the label sets as separate runs on a curved badge). A "+" attached
 * to the token on its left is left alone, because there it means "or more" and is
 * load-bearing: "20+ years" must never match a source that says "20 years".
 */
export function normalizeForMatch(s) {
  return String(s || '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[•·|]/g, ' ')
    .toLowerCase()
    .replace(/(^|[^a-z0-9])\+/g, '$1 ')
    .replace(/[.,;:!?"'()\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {{pdpBody?:string, brandKit?:object, catalogEntry?:object, reviews?:string[]}} sources
 * @returns {Record<string,string>} sourceId → normalized searchable text
 */
export function buildSourceIndex({ pdpBody, brandKit, catalogEntry, reviews } = {}) {
  const index = {};
  if (pdpBody) index.pdp = normalizeForMatch(pdpBody);
  if (brandKit) index.brandKit = normalizeForMatch(JSON.stringify(brandKit));
  if (catalogEntry) index.catalog = normalizeForMatch(JSON.stringify(catalogEntry));
  if (reviews && reviews.length) index.reviews = normalizeForMatch(reviews.join(' '));
  return index;
}

/**
 * @param {{zone:string, text:string, factual:boolean, sourceId?:string, evidence?:string}[]} claims
 * @param {Record<string,string>} index
 * @returns {{ok:boolean, violations:{zone:string,text:string,reason:string}[]}}
 */
export function validateClaims(claims, index) {
  const violations = [];
  for (const c of claims || []) {
    if (!c.factual) continue;
    if (!c.sourceId) {
      violations.push({ zone: c.zone, text: c.text, reason: 'factual claim with no sourceId' });
      continue;
    }
    const body = index[c.sourceId];
    if (body === undefined) {
      violations.push({ zone: c.zone, text: c.text, reason: `unknown source: ${c.sourceId}` });
      continue;
    }
    if (!c.evidence) {
      violations.push({ zone: c.zone, text: c.text, reason: 'factual claim with no evidence quote' });
      continue;
    }
    // An evidence quote made only of punctuation or separator glyphs normalizes to the
    // empty string, and `''` is a substring of every source — it would pass the gate
    // while proving nothing. Reject it before the substring test, not after.
    const needle = normalizeForMatch(c.evidence);
    if (!needle) {
      violations.push({
        zone: c.zone,
        text: c.text,
        reason: `evidence quote contains no matchable text: "${c.evidence}"`,
      });
      continue;
    }
    if (!body.includes(needle)) {
      violations.push({
        zone: c.zone,
        text: c.text,
        reason: `evidence not found in source ${c.sourceId}: "${c.evidence}"`,
      });
    }
  }
  return { ok: violations.length === 0, violations };
}

/** Throws listing every violation. There is no override. */
export function assertClaimsSourced(claims, index) {
  const { ok, violations } = validateClaims(claims, index);
  if (ok) return;
  const lines = violations.map(v => `  [${v.zone}] "${v.text}" — ${v.reason}`);
  throw new Error(
    `Claim gate failed — ${violations.length} unsourced claim(s). Nothing was rendered.\n${lines.join('\n')}`
  );
}
