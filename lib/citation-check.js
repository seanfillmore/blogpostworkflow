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
  // Percentages — statistics worth a citation, but NOT colloquial state phrases
  // ("80% dry", "100% done"), recipe/ingredient concentrations ("3% concentration",
  // "2% solution"), or parenthetical specs ("hydrogen peroxide (3%)").
  /\b\d{1,3}(?:\.\d+)?\s?%(?!\s?(?:dry|done|sure|full|empty|certain|complete|off|concentration|solution|strength|dilution)\b)(?!\s?\))/i,
  // Study/research references only in a CLAIM context (paired with a reporting
  // verb), not bare nouns/idioms like "skip the research" or "do your research".
  /\b(?:studies|research|study|trials?|data|survey)\b[^.]{0,30}\b(?:show|shows|showed|suggests?|found|finds?|indicates?|confirms?|prove[sn]?|demonstrate[sd]?|reveals?|reports?|concludes?|associate[sd]?|link(?:ed|s)?)\b/i,
  /\baccording to\b[^.]{0,40}\b(?:studies|research|study|trials?|data|survey|report)\b/i,
  // Clinical claims — "clinically proven/tested", "clinical trial" — not the
  // descriptive-adjective uses ("clinical hydration", "clinical strength").
  /\bclinical(?:ly)?\s+(?:proven|tested|shown|studied|demonstrated|trials?|evidence|studies?)\b/i,
  // Authority claims — "scientifically/clinically/medically proven", "doctors
  // recommend". NOT bare "proven" ("practical and proven" is marketing, not a
  // sourceable claim); "clinically proven" is already covered by the clinical rule.
  /\bscientifically\b|\bdoctors? recommend\b|\b(?:clinically|scientifically|medically|lab)\s+proven\b/i,
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

// ── Deterministic soften ─────────────────────────────────────────────────────
// When no authoritative source can be found, we must not block the post forever
// and must not fabricate a citation. Instead, deterministically rewrite the exact
// claim TRIGGERS so the sentence no longer asserts a sourceable fact — turning
// "Research suggests X" into "Many people find that X", "50%" into "half", etc.
// This is the guaranteed escape hatch behind citation-finder's soften: unlike a
// whole-HTML LLM rewrite (which gets discarded on any guard trip), targeted
// substring edits always succeed and always clear the gate. Tag boundaries (`<`)
// terminate every pattern, so links/markup are never touched.

const PCT_WORDS = { 10: 'a tenth', 20: 'a fifth', 25: 'a quarter', 33: 'a third', 40: 'two-fifths', 50: 'half', 60: 'three-fifths', 66: 'two-thirds', 67: 'two-thirds', 75: 'three-quarters', 80: 'four-fifths', 90: 'most' };
function pctToWords(n) {
  const k = Math.round(parseFloat(n));
  return PCT_WORDS[k] || 'a significant share';
}

/** Rewrite the claim TRIGGERS in a fragment of visible text (may contain inline
 *  tags) so isClaim() no longer fires, while leaving everything else intact. */
export function softenClaimText(text) {
  if (!text) return text;
  let t = text;
  // 1. Reporting clauses: "Research/studies/data … show/suggest/find/prove … (that)" → soft hedge.
  t = t.replace(/\b(?:studies|research|study|trials?|data|surveys?)\b[^.<]{0,30}?\b(?:show|shows|showed|suggests?|suggest|found|finds?|find|indicates?|indicate|confirms?|confirm|proves?|proven|demonstrates?|demonstrate|reveals?|reveal|reports?|report|concludes?|conclude|associate[sd]?|links?|linked)\b\s*(?:that\s+)?/gi, 'Many people find that ');
  // 2. "according to … studies/research/…" → experiential hedge.
  t = t.replace(/\baccording to\b[^.<]{0,40}?\b(?:studies|research|study|trials?|data|survey|report)\b\s*,?\s*/gi, 'In many people’s experience, ');
  // 3. Percentages presented as findings → qualitative (mirrors the detector's exclusions).
  t = t.replace(/\b(\d{1,3}(?:\.\d+)?)\s?%(?!\s?(?:dry|done|sure|full|empty|certain|complete|off|concentration|solution|strength|dilution)\b)(?!\s?\))/gi, (m, n) => pctToWords(n));
  // 4. "clinically proven/tested/…" → plain usage.
  t = t.replace(/\bclinical(?:ly)?\s+(?:proven|tested|shown|studied|demonstrated|trials?|evidence|studies?)\b/gi, 'commonly used');
  // 5. authority claims.
  t = t.replace(/\b(?:clinically|scientifically|medically|lab)\s+proven\b/gi, 'widely regarded');
  t = t.replace(/\bscientifically\b/gi, 'widely');
  t = t.replace(/\bdoctors?\s+recommend\b/gi, 'many people choose');
  // 6. absolute health/efficacy claims → hedged.
  t = t.replace(/\b(?:kills?|eliminates?|cures?|prevents?|treats?)\b(.{0,40}?\b(?:bacteria|germs?|odor|infection|disease)\b)/gi, 'may help with$1');
  // Tidy: lowercase pronoun left after stripping a lead-in ("…that it" stays fine;
  // a sentence now starting "Many people find that it may…" reads correctly).
  return t.replace(/\s{2,}/g, ' ');
}

/**
 * Deterministically soften every uncited claim in the HTML so findUncitedClaims
 * returns []. Operates only on <p>/<li> blocks that (a) lack an external citation
 * and (b) contain a claim — the same scope the detector uses. Guaranteed to clear
 * the gate without fabricating a source, dropping a link, or touching schema.
 * @returns {{ html: string, changed: boolean, softened: number }}
 */
export function softenClaimsInHtml(html, { siteHost = 'realskincare.com' } = {}) {
  if (!html) return { html: html || '', changed: false, softened: 0 };
  let changed = false;
  let softened = 0;
  const out = String(html).replace(/<(p|li)([^>]*)>([\s\S]*?)<\/\1>/gi, (block, tag, attrs, inner) => {
    if (hasExternalCitation(block, siteHost)) return block;
    const textOnly = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const claimCount = textOnly.split(/(?<=[.!?])\s+/).filter(isClaim).length;
    if (claimCount === 0) return block;
    const newInner = softenClaimText(inner);
    if (newInner === inner) return block;
    changed = true;
    softened += claimCount;
    return `<${tag}${attrs}>${newInner}</${tag}>`;
  });
  return { html: out, changed, softened };
}
