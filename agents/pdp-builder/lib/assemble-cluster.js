// agents/pdp-builder/lib/assemble-cluster.js
import { buildClusterSystemPrompt } from './prompt-builder.js';
import {
  validateIngredients,
  validateLengths,
  validateBrandTermExclusion,
} from './validators.js';
import { CLAUDE_MODEL, gitSha, parseClaudeJson } from './util.js';

/**
 * Cluster mode: generates the content for a cluster template.
 *
 * @param {Object} args
 * @param {Object} args.foundation     loaded Foundation object
 * @param {string} args.clusterName    e.g. "toothpaste"
 * @param {Object} args.claudeClient   Anthropic SDK client (injectable for tests)
 * @returns {Promise<Object>}          queue item ready for write
 */
export async function assembleCluster({ foundation, clusterName, claudeClient }) {
  const systemPrompt = buildClusterSystemPrompt({ foundation, clusterName });

  const response = await claudeClient.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [
      { role: 'user', content: `Generate the cluster content for ${clusterName}. Output JSON only.` },
    ],
  });

  let proposed;
  try { proposed = parseClaudeJson(response); }
  catch (e) {
    return {
      type: 'pdp-cluster',
      slug: clusterName,
      status: 'needs_rework',
      generated_at: new Date().toISOString(),
      foundation_version: gitSha(),
      proposed: null,
      validation: { passed: false, errors: [`Claude response not valid JSON: ${e.message}`], warnings: [] },
    };
  }

  // ── Validate ──────────────────────────────────────────────────────
  const errors = [];

  // Ingredient validation: every ingredient card's name must be in the spec.
  const claimedIngredients = (proposed.ingredientCards || []).map((c) => c.name);
  const ing = validateIngredients({
    cluster: clusterName,
    claimedIngredients,
    ingredientsByCluster: foundation.ingredientsByCluster,
  });
  if (!ing.valid) errors.push(`Fabricated ingredients: ${ing.fabricated.join(', ')}`);

  // Length validation
  const lengths = validateLengths({
    ingredientCards: proposed.ingredientCards,
    mechanismBlock:  proposed.mechanismBlock,
    founderBlock:    proposed.founderBlock,
    faq:             proposed.faq,
  });
  if (!lengths.valid) errors.push(...lengths.errors);

  // Brand-term exclusion across all generated text fields
  const textFields = [
    ['hookLine', proposed.hookLine],
    ['mechanismBlock', proposed.mechanismBlock],
    ['founderBlock', proposed.founderBlock],
    ...((proposed.ingredientCards || []).map((c, i) => [`ingredientCards[${i}].story`, c.story])),
    ...((proposed.faq || []).map((qa, i) => [`faq[${i}].answer`, qa.answer])),
  ];
  for (const [field, text] of textFields) {
    const e = validateBrandTermExclusion({ text, field });
    if (!e.valid) errors.push(...e.errors);
  }

  return {
    type: 'pdp-cluster',
    slug: clusterName,
    status: errors.length === 0 ? 'pending' : 'needs_rework',
    generated_at: new Date().toISOString(),
    foundation_version: gitSha(),
    proposed,
    validation: { passed: errors.length === 0, errors, warnings: [] },
  };
}
