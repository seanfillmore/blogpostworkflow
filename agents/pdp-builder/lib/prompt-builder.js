// agents/pdp-builder/lib/prompt-builder.js

/**
 * Extracts a single cluster's section from cluster-povs.md.
 * The markdown convention: "## <cluster-name>" headings, content until next "## " or EOF.
 */
function extractClusterPOV(clusterPOVsMarkdown, clusterName) {
  const re = new RegExp(`##\\s+${clusterName}\\b([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
  const m = clusterPOVsMarkdown.match(re);
  if (!m) throw new Error(`prompt-builder: cluster "${clusterName}" not found in cluster-povs.md`);
  return `## ${clusterName}${m[1]}`.trim();
}

/**
 * Filters ingredient stories down to those relevant to a cluster.
 * Heuristic: an ingredient is relevant if its name appears (case-insensitive)
 * in the cluster's base_ingredients or any variation's essential_oils list.
 */
function relevantIngredientStories(ingredientStories, clusterSpec) {
  if (!clusterSpec) return {};
  const allowed = [];
  for (const ing of (clusterSpec.base_ingredients || [])) allowed.push(ing.toLowerCase());
  for (const v of (clusterSpec.variations || [])) {
    for (const oil of (v.essential_oils || [])) allowed.push(oil.toLowerCase());
  }
  const out = {};
  for (const [key, story] of Object.entries(ingredientStories)) {
    if (!story?.name) continue;
    const name = story.name.toLowerCase();
    // Match if the story name and any config entry share a substring relationship
    // in either direction. Handles drift like "Wildcrafted Myrrh" (story) ↔
    // "wildcrafted myrrh powder" (config) without requiring exact alignment.
    const matched = allowed.some((a) => a === name || a.includes(name) || name.includes(a));
    if (matched) out[key] = story;
  }
  return out;
}

/**
 * Builds the system prompt for cluster mode. The agent uses this to generate
 * the cluster template's content blocks (FAQs, ingredient cards, mechanism,
 * founder, free-from, badges, etc.).
 */
export function buildClusterSystemPrompt({ foundation, clusterName }) {
  const clusterSpec = foundation.ingredientsByCluster[clusterName];
  if (!clusterSpec) throw new Error(`prompt-builder: cluster "${clusterName}" not in ingredientsByCluster`);
  const pov = extractClusterPOV(foundation.clusterPOVs, clusterName);
  const ingredients = relevantIngredientStories(foundation.ingredientStories, clusterSpec);

  return [
    `You are the content writer for Real Skin Care, a premium natural skincare brand.`,
    ``,
    `# Voice and POV`,
    foundation.voice,
    ``,
    `# Cluster POV`,
    pov,
    ``,
    `# Hero ingredient stories (use these — do not invent ingredient claims)`,
    JSON.stringify(ingredients, null, 2),
    ``,
    `# Comparison framework`,
    foundation.comparisonFramework,
    ``,
    `# Founder narrative (exemplar tone for the founder block)`,
    foundation.founderNarrative,
    ``,
    `# Cluster product spec (every ingredient claim must come from this list)`,
    JSON.stringify(clusterSpec, null, 2),
    ``,
    `# Your task`,
    `Generate the content for the ${clusterName} cluster's product-page template.`,
    `Output a single JSON object with these keys:`,
    `  hookLine:        string (1-2 sentences setting the page's worldview)`,
    `  ingredientCards: array of 3 objects { name, role, story } (story 40-60 words). The "name" field MUST be copied verbatim from one of the .name values in the Hero ingredient stories above — do not rephrase, do not add qualifiers like "Cold-Pressed" or "Organic" if they are not in the canonical .name. Use the canonical names exactly so they match the cluster product spec.`,
    `  mechanismBlock:  string (80-100 words, "How this actually protects sensitive skin"). Stay strictly within these word bounds.`,
    `  founderBlock:    string (60-80 words inclusive, in the family "we" voice from the Founder narrative section above — not solo "I" voice. Stay strictly within 60-80 words; count carefully.) Sign with "— Sean" at the end.`,
    `  freeFrom:        array of 4-6 short callout strings (e.g., "No SLS", "No fluoride")`,
    `  faq:             array of 7 objects { question, answer } (answers 30-80 words)`,
    `  badges:          array of 4 short strings (cert/promise labels)`,
    `  guarantees:      array of 4 short strings`,
    ``,
    `Output JSON only, no preamble.`,
  ].join('\n');
}

/**
 * Builds the system prompt for product mode. Used to generate per-SKU SEO
 * title, meta description, body_html, and metafield overrides.
 */
export function buildProductSystemPrompt({ foundation, clusterName, product }) {
  const clusterSpec = foundation.ingredientsByCluster[clusterName];
  if (!clusterSpec) throw new Error(`prompt-builder: cluster "${clusterName}" not in ingredientsByCluster`);
  const pov = extractClusterPOV(foundation.clusterPOVs, clusterName);
  const ingredients = relevantIngredientStories(foundation.ingredientStories, clusterSpec);

  return [
    `You are the content writer for Real Skin Care, a premium natural skincare brand.`,
    ``,
    `# Voice and POV`,
    foundation.voice,
    ``,
    `# Cluster POV`,
    pov,
    ``,
    `# Hero ingredient stories`,
    JSON.stringify(ingredients, null, 2),
    ``,
    `# Comparison framework`,
    foundation.comparisonFramework,
    ``,
    `# Product`,
    `Handle: ${product.handle}`,
    `Title:  ${product.title || ''}`,
    `Cluster spec: ${JSON.stringify(clusterSpec, null, 2)}`,
    ``,
    `# Your task`,
    `Generate per-SKU content for this product's PDP. Output JSON with keys:`,
    `  seoTitle:           string (50-70 chars; format: "[Variant/Type] [Product] | [Differentiator] | Real Skin Care")`,
    `  metaDescription:    string (140-160 chars)`,
    `  bodyHtml:           string (HTML; 120-180 words of marketing prose: hook + 4 benefit bullets)`,
    `  metafieldOverrides: object (optional; only include if SKU-specific data warrants overriding cluster defaults; keys: hero_ingredients_override, faq_additional, free_from, sensitive_skin_notes, scent_notes)`,
    ``,
    `Output JSON only, no preamble. Every ingredient mentioned must come from the cluster spec above.`,
  ].join('\n');
}
