import { LENGTH_LIMITS, SHOP_NAME as SHOP } from '../../../lib/seo-copy-length.js';
const TITLE_MAX = LENGTH_LIMITS.title.max;

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
 * The voice-of-customer block, or nothing at all.
 *
 * Returns [] when data/context/voice-of-customer.md has not been generated yet,
 * so a pdp-builder run before the VOC agent's first run produces a
 * byte-identical prompt to the one it produced before this feature existed.
 *
 * The framing matters: this is internal research into what customers object to,
 * not copy. Verbatim reproduction of a complaint about our own product on a PDP
 * would be worse than not having the research at all.
 */
function voiceOfCustomerSection(foundation) {
  const voc = String(foundation?.voiceOfCustomer || '').trim();
  if (!voc) return [];
  return [
    `# Voice of customer (INTERNAL RESEARCH — not copy)`,
    `Scope: this research covers the skin cluster ONLY — coconut lotion, body lotion,`,
    `coconut moisturizer, coconut bar soap and foaming hand soap. If the page you are`,
    `writing is not one of those, disregard this section entirely; an objection does not`,
    `transfer across categories.`,
    `Real objections, phrases and triggers mined from our reviews and outside discussion.`,
    `Use it to decide which hesitation this page must answer and which proof to lead with.`,
    `Never quote it verbatim on the page, and never restate a complaint about our own`,
    `products as fact — answer the underlying worry instead.`,
    voc,
    ``,
  ];
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
    ...voiceOfCustomerSection(foundation),
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
 * Human-readable savings table. Handed to the model as the ONLY permitted source
 * of price arithmetic — it never sees a figure it is allowed to round or invent.
 */
function savingsBriefing(facts) {
  const rows = facts.variants.map((v) => {
    const parts = v.components
      .map((c) => `${c.qty}x ${c.productName} [${c.scent}] @ $${c.unitPrice} (sold as: "${c.shopifyProductTitle}")`)
      .join(' + ');
    return `  - "${v.title}": $${v.price}. Contains ${parts}. Sum of parts $${v.partsTotal}. ` +
      `Saving $${v.savings} (${v.savingsPct}%). Per unit $${v.pricePerUnit}.`;
  });

  const s = facts.savings;
  const headline = !s.claimable
    ? `SAVINGS: NOT CLAIMABLE. At least one option costs the same as or more than its parts. ` +
      `Say NOTHING about saving, value, discount, or being cheaper than buying singly. ` +
      `Sell the set on convenience and fit instead.`
    : s.uniform
      ? `SAVINGS: every option saves exactly $${s.minSavings} against buying the same items singly.`
      : `SAVINGS: options save between $${s.minSavings} and $${s.maxSavings} against buying the ` +
        `same items singly. If you give one number, use $${s.minSavings} and word it as "at least".`;

  return [headline, '', 'Per-option arithmetic (already computed — do not recompute, do not round):', ...rows].join('\n');
}

/**
 * Builds the system prompt for bundle mode.
 *
 * A bundle spans several clusters, so unlike cluster/product mode there is no
 * single cluster POV or ingredient spec — the prompt carries every involved
 * cluster's POV and spec, and the fact sheet fixes exactly what is in the box.
 */
export function buildBundleSystemPrompt({ foundation, facts }) {
  const povs = [];
  const specs = {};
  const stories = {};
  for (const cluster of facts.clusters) {
    const spec = foundation.ingredientsByCluster[cluster];
    if (!spec) throw new Error(`prompt-builder: cluster "${cluster}" not in ingredientsByCluster`);
    specs[cluster] = spec;
    povs.push(extractClusterPOV(foundation.clusterPOVs, cluster));
    Object.assign(stories, relevantIngredientStories(foundation.ingredientStories, spec));
  }

  const scentChoices = [...new Set(
    facts.variants.flatMap((v) => v.components.map((c) => `${c.productName}: ${c.scent}`)),
  )].sort();

  return [
    `You are the content writer for Real Skin Care, a premium natural skincare brand.`,
    `You are writing the product description for a BUNDLE — a set of several products sold as one item.`,
    ``,
    `# Voice and POV`,
    foundation.voice,
    ``,
    `# Cluster POVs for every product in this box`,
    povs.join('\n\n'),
    ``,
    `# Hero ingredient stories (use these — do not invent ingredient claims)`,
    JSON.stringify(stories, null, 2),
    ``,
    `# Comparison framework`,
    foundation.comparisonFramework,
    ``,
    `# Founder narrative (tone reference only)`,
    foundation.founderNarrative,
    ``,
    `# Cluster product specs (every ingredient claim must come from these lists)`,
    JSON.stringify(specs, null, 2),
    ``,
    `# THE FACT SHEET — the only permitted description of what is in this box`,
    `Handle: ${facts.handle}`,
    `Title:  ${facts.title}`,
    `Options the shopper picks between: ${facts.variants.map((v) => `"${v.title}"`).join(', ')}`,
    `Scents actually shipped: ${scentChoices.join('; ')}`,
    ``,
    savingsBriefing(facts),
    ``,
    ...voiceOfCustomerSection(foundation),
    `# Your task`,
    `Write the Shopify product description for this bundle. Output JSON with keys:`,
    `  seoTitle:        string, STRICTLY 50-${TITLE_MAX} characters INCLUSIVE as RENDERED — count carefully.`,
    `                   The storefront appends " \u2013 ${SHOP}" unless your title already contains "${SHOP}".`,
    `  metaDescription: string, STRICTLY 140-160 characters INCLUSIVE — count carefully.`,
    `  bodyHtml:        string of HTML, 150-320 words of body text.`,
    ``,
    `The bodyHtml must, in this order:`,
    `  1. Open with one bold sentence naming what the box is and who it is for.`,
    `  2. Say what problem buying these piecemeal creates, and how the set removes it.`,
    `  3. A "What's in the box" <h3> followed by a <ul> listing every item with its quantity,`,
    `     size or format, and one concrete ingredient-led reason it earns its place.`,
    `  4. Explain the option choice in plain terms so nobody has to guess what "Gentle" or`,
    `     "Variety" means. Account for EVERY option in the list — if the options vary along`,
    `     two axes (size and scent, say), name every level of both. Do not describe a`,
    `     three-way choice as a two-way one, and do not quietly drop an option.`,
    `  5. A closing line that gives a reason to buy today, ending with a clear call to action.`,
    ``,
    `# Hard rules — a violation is rejected, not edited`,
    `- HEALTH CLAIMS: these are COSMETICS. Never name a medical condition (eczema, dermatitis,`,
    `  acne, psoriasis, infection, wound...). Never name a drug, prescription, steroid or`,
    `  "over-the-counter". Never say heal, cure, treat, remedy, prevent, reverse, therapy or`,
    `  therapeutic — not even about something harmless like preventing dryness; use different`,
    `  wording. Never claim clinical, dermatologist, doctor or FDA backing. You MAY say what`,
    `  the products do to the appearance and feel of skin: moisturize, hydrate, soothe, soften,`,
    `  nourish, absorb, non-greasy, for dry or sensitive skin.`,
    `- COMPONENTS: name only the products listed in the fact sheet. Do not add an item, and`,
    `  do not restate a component's pack size from its format alone — the "sold as" title is`,
    `  authoritative, so a component sold as a four pack is four, not one.`,
    `- USAGE: do not invent handling, storage or application instructions. If the cluster POV`,
    `  does not state it, do not tell the customer to do it.`,
    `- SIZES: state a volume or weight ONLY if it appears in a component's "sold as" title.`,
    `  If a component has no size there, describe the container without a number.`,
    `- SCENTS: name only scents in "Scents actually shipped" above.`,
    `- INGREDIENTS: only what the cluster specs list. When you contrast an ingredient we do`,
    `  NOT use, frame it with explicit negation ("no X", "without X", "unlike X").`,
    `- MONEY: the only dollar figures you may print are the ones in the arithmetic above.`,
    `  Do not print any percentage at all — not for savings, and not in phrases like`,
    `  "100% natural". Express any saving in dollars.`,
    `- ORIGIN: the products are made in the USA. Never name a city or state.`,
    `- Do not mention subscriptions, refill plans, shipping thresholds, guarantees or return`,
    `  windows — none of that is in the fact sheet.`,
    `- Do not name or allude to any competitor brand, and do not use the phrases "clean beauty",`,
    `  "natural skincare", "organic skincare" or bare "skincare".`,
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
    ...voiceOfCustomerSection(foundation),
    `# Your task`,
    `Generate per-SKU content for this product's PDP. Output JSON with keys:`,
    `  seoTitle:           string, STRICTLY 50-${TITLE_MAX} characters INCLUSIVE — count carefully. Format: "[Variant/Type] [Product] | [Differentiator] | ${SHOP}"`,
    "                      Keeping the brand INSIDE the title is what stops the storefront appending it again.",
    `  metaDescription:    string, STRICTLY 140-160 characters INCLUSIVE — count carefully.`,
    `  bodyHtml:           string (HTML; 120-180 words of marketing prose: hook + 4 benefit bullets). When mentioning ingredients we DON'T use as a contrast point, frame them with explicit negation ("unlike X", "instead of X", "no X") so the validator recognizes the comparison.`,
    `  metafieldOverrides: object (optional; only include if SKU-specific data warrants overriding cluster defaults; keys: hero_ingredients_override, faq_additional, free_from, sensitive_skin_notes, scent_notes)`,
    ``,
    `Output JSON only, no preamble. Every ingredient mentioned must come from the cluster spec above.`,
  ].join('\n');
}
