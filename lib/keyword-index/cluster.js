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
  ['deodorant', /\b(deodorant|antiperspirant|underarm|armpit|body odou?r|sweat|alumin[iu]?m[\s-]?free)\b/i],
  ['toothpaste', /\b(toothpaste|fluoride|s\.?l\.?s\.?|sodium lauryl sulfate|hydroxyapatite|whiten(?:ing)? teeth|teeth|tooth|enamel|cavit|oral care|mouthwash)\b/i],
  ['lip balm', /\b(lip balm|lip care|chapped|lips?)\b/i],
  ['soap', /\b(soap|body wash|castile|tattoo)\b/i],
  // Note: "body oil(s)" is included, but bare "oil" is NOT — that would steal
  // generic "coconut oil" queries from the coconut-oil cluster below.
  ['lotion', /\b(lotions?|body cream|body milk|body butters?|body oils?|body care|moisturi\w+|creams?|butters?|eczema|dry skin)\b/i],
  ['hair', /\b(hair|shampoo|conditioner|scalp)\b/i],
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
