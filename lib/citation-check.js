// lib/citation-check.js
// Deterministic fact-check gate: find claim-like sentences (statistics, study/
// research references, strong health/efficacy claims) that lack a nearby outbound
// citation link. Addresses the recurring "factual concerns" editor flags by making
// the omission visible. Pure (no I/O).

// Sentences that genuinely assert a sourceable fact. Tightened to avoid flagging
// ordinary prose that merely contains a trigger word: "skip the research",
// "clinical hydration", "pat skin 80% dry" are NOT citation-worthy claims, but the
// old bare-word patterns flagged them anyway (spurious YMYL gate blocks).
const CLAIM_PATTERNS = [
  // Percentages — but not colloquial physical-state phrases ("80% dry", "100% done").
  /\b\d{1,3}(?:\.\d+)?\s?%(?!\s?(?:dry|done|sure|full|empty|certain|complete|off)\b)/i,
  // Study/research references only in a CLAIM context (paired with a reporting
  // verb), not bare nouns/idioms like "skip the research" or "do your research".
  /\b(?:studies|research|study|trials?|data|survey)\b[^.]{0,30}\b(?:show|shows|showed|suggests?|found|finds?|indicates?|confirms?|prove[sn]?|demonstrate[sd]?|reveals?|reports?|concludes?|associate[sd]?|link(?:ed|s)?)\b/i,
  /\baccording to\b[^.]{0,40}\b(?:studies|research|study|trials?|data|survey|report)\b/i,
  // Clinical claims — "clinically proven/tested", "clinical trial" — not the
  // descriptive-adjective uses ("clinical hydration", "clinical strength").
  /\bclinical(?:ly)?\s+(?:proven|tested|shown|studied|demonstrated|trials?|evidence|studies?)\b/i,
  // Authority claims.
  /\bproven\b|\bscientifically\b|\bdoctors? recommend/i,
  // Health/efficacy claims.
  /\b(?:kills?|eliminates?|cures?|prevents?|treats?)\b.{0,40}\b(?:bacteria|germs?|odor|infection|disease)\b/i,
];

function isClaim(sentence) {
  return CLAIM_PATTERNS.some((re) => re.test(sentence));
}

// External citation = an <a href> to an http(s) URL whose host is not the site host.
function hasExternalCitation(paragraphHtml, siteHost) {
  const re = /href="(https?:\/\/[^"]+)"/gi;
  let m;
  while ((m = re.exec(paragraphHtml)) !== null) {
    try {
      const host = new URL(m[1]).host.replace(/^www\./, '');
      if (!siteHost || host !== siteHost.replace(/^www\./, '')) return true;
    } catch { /* ignore */ }
  }
  return false;
}

/**
 * @param {string} html
 * @param {{siteHost?:string, maxFindings?:number}} [opts]
 * @returns {Array<{text:string}>} claim sentences lacking a nearby external citation
 */
export function findUncitedClaims(html, { siteHost = 'realskincare.com', maxFindings = 12 } = {}) {
  if (!html) return [];
  const findings = [];
  // Examine each paragraph/list-item block; a citation anywhere in the same block counts.
  const blocks = String(html).match(/<(p|li)[^>]*>[\s\S]*?<\/\1>/gi) || [];
  for (const block of blocks) {
    if (hasExternalCitation(block, siteHost)) continue;
    const textOnly = block.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // split into sentences
    const sentences = textOnly.split(/(?<=[.!?])\s+/);
    for (const s of sentences) {
      if (isClaim(s)) {
        findings.push({ text: s.slice(0, 200) });
        if (findings.length >= maxFindings) return findings;
      }
    }
  }
  return findings;
}
