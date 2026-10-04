// agents/ad-concepts/concepts.js
//
// Pure gates shared by the structure pipeline's evidence screening and copy gate: competitor
// names, verbatim claim sourcing, and the deterministic variant gate. The invented-concept
// stage that used to live here (concept prompt, judge, picker) was retired on 2026-10-03 in
// favour of the structure library (docs/superpowers/specs/2026-10-03-ad-structures-design.md).
import { assertClaimsSourced, normalizeForMatch, sourceText } from '../ad-studio/claims.js';

const NATIVE_NOT_A_BRAND = '(?![-\\u2010-\\u2015]|\\s+(?:feed|ads?|format|look|screenshot|post)\\b)';

// Competitor names are proper nouns: case-SENSITIVE on word boundaries. "Native" is also an
// ordinary word and one of our own family names ("native-screenshot"), so it is not counted
// when a hyphen or a format word follows it.
export function mentionsCompetitor(text, name) {
  if (!name) return false;
  const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tail = name === 'Native' ? NATIVE_NOT_A_BRAND : '';
  return new RegExp(`(?<![\\w])${esc}(?![\\w])${tail}`).test(text);
}

/** Every competitor name the text mentions, by the same rule the pre-gate uses. */
export function namedCompetitors(text, competitorNames = []) {
  return (competitorNames || []).filter(n => mentionsCompetitor(String(text || ''), n));
}

/** Claim text is its own evidence quote; the index is normalized to match. */
export function checkClaimsSourced(claims, sourceIndex) {
  const index = Object.fromEntries(Object.entries(sourceIndex || {}).map(([k, v]) => [k, normalizeForMatch(sourceText(v))]));
  const gateClaims = (claims || []).map(c => ({ zone: 'concept', text: c.text, factual: true, sourceId: c.sourceId, evidence: c.text }));
  try { assertClaimsSourced(gateClaims, index); } catch (e) {
    return { ok: false, reasons: [`unsourced claim: ${String(e.message).split('\n').slice(1).join(' ').trim()}`] };
  }
  return { ok: true, reasons: [] };
}

/**
 * Deterministic variant gate. The PDP and catalog describe the whole product LINE, so the claim
 * gate passes "Tasting notes: lavender." on a tea tree bar (live run 2, 2026-10-03). A sibling's
 * scent term is its variant key minus its first word ("calming-lavender" -> "lavender",
 * "pure-unscented" -> "unscented"); a term that also appears in our own scent term is never
 * flagged. A scented variant may not say "nothing added". No variant: a no-op.
 */
const UNSCENTED_RE = /unscented|fragrance[\s-]?free|no[\s-]?scent/i;
const scentTerm = (key) => String(key || '').split('-').slice(1).join(' ').trim().toLowerCase();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function variantConflicts(text, { variant = null, siblingVariants = [] } = {}) {
  if (!variant) return [];
  const t = String(text || '');
  const own = scentTerm(variant);
  const out = [];
  const seen = new Set();
  for (const sib of siblingVariants || []) {
    const term = scentTerm(sib);
    if (!term || seen.has(term) || (own && own.includes(term))) continue;
    seen.add(term);
    if (new RegExp(`\\b${escRe(term).replace(/ /g, '\\s+')}\\b`, 'i').test(t)) out.push(`variant conflict: names "${term}" (a different variant)`);
  }
  if (!UNSCENTED_RE.test(variant) && /\bnothing added\b/i.test(t)) {
    out.push(`variant conflict: says "nothing added" on a scented variant (${variant})`);
  }
  return out;
}
