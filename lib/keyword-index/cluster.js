/**
 * Deterministic cluster assignment for keyword-index entries.
 *
 * The builder previously assigned clusters ONLY by exact-text lookup against the
 * prior index. GSC-discovered queries never matched the seed categories, so they
 * defaulted to 'unclustered' — and because each build seeds clusters from the
 * prior build, that collapse became permanent (every keyword 'unclustered').
 *
 * This module assigns a cluster from the keyword text itself, mapping to Real
 * Skin Care's product categories. First match wins, so order matters: a more
 * specific product (e.g. "coconut oil lotion" → lotion) is caught before the
 * generic ingredient cluster (coconut oil). Genuinely off-topic queries (e.g.
 * brand-name lookups) stay 'unclustered'.
 */

// Ordered list — first match wins. Cluster names match the seed taxonomy.
const RULES = [
  // Branded / navigational queries first — we already rank #1 for our own name,
  // so these don't belong in a product cluster's commercial analysis.
  ['brand', /\b(real\s?skin\s?care|real\s?skincare|realskin)\b/i],
  // PLURALS ARE LOAD-BEARING. `\b` after a bare noun requires a non-word
  // character right after it, so `\bsoap\b` does not match "soaps" and
  // `\btattoo\b` does not match "tattoos" — nine live calendar items ("best
  // soaps for tattoos") fell out of every cluster on 2026-08-23 for exactly that
  // reason, taking their evidence out of the pool the revenue verdict is
  // computed over. Every whole-word product noun below carries `s?`; the stems
  // that already end in a suffix (`moisturi\w+`, `cavit\w*`) do not need it.
  ['deodorant', /\b(deodorants?|antiperspirants?|underarms?|armpits?|body odou?r|sweat|alumin[iu]?m[\s-]?free)\b/i],
  // `cavit` used to be a bare stem here: no query is ever literally "cavit", only
  // "cavity"/"cavities"/"cavitation", so the trailing \b (which requires a
  // non-word character right after whatever alternative matched) could never be
  // satisfied and the alternative was dead code. `cavit\w*` lets \w* consume the
  // rest of the word first, so \b lands on the real word boundary afterward —
  // every other alternative in this rule is already a complete word/phrase, so
  // none of them have the same defect.
  ['toothpaste', /\b(toothpastes?|fluoride|s\.?l\.?s\.?|sodium lauryl sulfate|hydroxyapatite|whiten(?:ing)? teeth|teeth|tooth|enamel|cavit\w*|oral care|mouthwash(?:es)?)\b/i],
  ['lip balm', /\b(lip balms?|lip care|chapped|lips?)\b/i],
  ['soap', /\b(soaps?|body wash(?:es)?|castile|tattoos?)\b/i],
  // Note: "body oil(s)" is included, but bare "oil" is NOT — that would steal
  // generic "coconut oil" queries from the coconut-oil cluster below.
  ['lotion', /\b(lotions?|body cream|body milk|body butters?|body oils?|body care|moisturi\w+|creams?|butters?|eczema|dry skin)\b/i],
  ['hair', /\b(hair|shampoos?|conditioners?|scalp)\b/i],
  ['coconut oil', /\bcoconut(?:\s+oil)?\b/i],
];

/**
 * @param {string} keyword
 * @returns {string} cluster name, or 'unclustered' if nothing matches
 */
export function assignCluster(keyword) {
  const k = String(keyword || '').toLowerCase();
  if (!k.trim()) return 'unclustered';
  for (const [cluster, re] of RULES) {
    if (re.test(k)) return cluster;
  }
  return 'unclustered';
}

// Exposed for tests / introspection.
export const CLUSTER_NAMES = RULES.map(([name]) => name);
