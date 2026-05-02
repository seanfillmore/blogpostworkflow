// agents/pdp-builder/lib/assemble-cluster.js
import { buildClusterSystemPrompt } from './prompt-builder.js';
import {
  validateIngredients,
  validateLengths,
  validateBrandTermExclusion,
} from './validators.js';
import { CLAUDE_MODEL, gitSha, parseClaudeJson, MAX_PARSE_RETRIES } from './util.js';

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

  let proposed = null;
  let lastRawText = '';
  let lastError = null;
  const totalAttempts = MAX_PARSE_RETRIES + 1;
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const response = await claudeClient.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        { role: 'user', content: `Generate the cluster content for ${clusterName}. Output JSON only.` },
      ],
    });
    lastRawText = response?.content?.find((b) => b.type === 'text')?.text || '';
    try {
      proposed = parseClaudeJson(response);
      break; // success
    } catch (e) {
      lastError = e;
      if (attempt === totalAttempts) {
        return {
          type: 'pdp-cluster',
          slug: clusterName,
          status: 'needs_rework',
          generated_at: new Date().toISOString(),
          foundation_version: gitSha(),
          proposed: null,
          raw_response: lastRawText,
          validation: { passed: false, errors: [`Claude response not valid JSON after ${totalAttempts} attempts: ${e.message}`], warnings: [] },
        };
      }
    }
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
