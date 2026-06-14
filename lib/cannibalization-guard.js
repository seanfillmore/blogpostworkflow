// lib/cannibalization-guard.js
// Pure semantic near-duplicate detection for keywords, to prevent cluster
// cannibalization at planning time (exact-match dedup misses "sls free toothpaste"
// vs "toothpaste without sls"). Token-set similarity with light stopword removal.

const STOP = new Set(['the', 'a', 'an', 'for', 'to', 'of', 'and', 'or', 'with', 'without', 'best', 'top', 'in', 'on', 'is', 'are', 'your', 'you', 'how', 'what', 'vs']);

function coreTokens(s) {
  const toks = (String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => !STOP.has(t));
  return new Set(toks.length ? toks : (String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []));
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
    const s = similarity(keyword, e);
    if (s >= threshold && s > bestScore) { best = e; bestScore = s; }
  }
  return best;
}
