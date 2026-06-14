// lib/cannibalization-guard.js
// Pure semantic near-duplicate detection for keywords, to prevent cluster
// cannibalization at planning time (exact-match dedup misses "sls free toothpaste"
// vs "toothpaste without sls"). Token-set similarity with light stopword removal.

const STOP = new Set(['the', 'a', 'an', 'for', 'to', 'of', 'and', 'or', 'with', 'without', 'best', 'top', 'in', 'on', 'is', 'are', 'your', 'you', 'how', 'what', 'vs']);

// Audience/segment qualifiers that make two otherwise-similar keywords target
// DIFFERENT readers — these are legitimately separate posts, not cannibalization.
// e.g. "natural deodorant" vs "natural deodorant for women" vs "...for men" vs
// "...for sensitive skin" are a deliberate segment split, not duplicates.
const SEGMENTS = [
  ['women', 'womens', 'woman', 'female', 'her'],
  ['men', 'mens', 'man', 'male', 'him'],
  ['kids', 'kid', 'children', 'child', 'toddler', 'baby', 'babies'],
  ['teens', 'teen', 'teenage'],
  ['sensitive'],
];

function coreTokens(s) {
  const toks = (String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => !STOP.has(t));
  return new Set(toks.length ? toks : (String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []));
}

/** The set of segment-group indices a keyword targets (e.g. {0} for "...for women"). */
function segmentSet(s) {
  const toks = new Set(String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []);
  const out = new Set();
  SEGMENTS.forEach((group, i) => { if (group.some((g) => toks.has(g))) out.add(i); });
  return out;
}

/** True if a and b target different audience segments (→ NOT cannibalization). */
export function differentSegments(a, b) {
  const A = segmentSet(a), B = segmentSet(b);
  if (A.size === 0 && B.size === 0) return false;
  if (A.size !== B.size) return true;
  for (const x of A) if (!B.has(x)) return true;
  return false;
}

/** Jaccard: intersection over union of core token sets, 0..1. */
export function similarity(a, b) {
  const A = coreTokens(a), B = coreTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * @returns {string|null} the first existing keyword whose similarity to `keyword`
 *   meets `threshold` (default 0.6), else null.
 */
export function findSemanticDuplicate(keyword, existing, { threshold = 0.6 } = {}) {
  if (!keyword) return null;
  let best = null, bestScore = 0;
  for (const e of (existing || [])) {
    if (differentSegments(keyword, e)) continue; // different audience → not a duplicate
    const s = similarity(keyword, e);
    if (s >= threshold && s > bestScore) { best = e; bestScore = s; }
  }
  return best;
}
