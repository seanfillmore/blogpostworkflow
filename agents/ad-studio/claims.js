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
 */
export function normalizeForMatch(s) {
  return String(s || '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .toLowerCase()
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
    if (!body.includes(normalizeForMatch(c.evidence))) {
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
