// agents/pdp-builder/lib/assemble-product.js
import { buildProductSystemPrompt } from './prompt-builder.js';
import {
  validateLengths,
  validateBrandTermExclusion,
  validateNoFabricatedIngredients,
} from './validators.js';
import { CLAUDE_MODEL, gitSha, parseClaudeJson, MAX_PARSE_RETRIES } from './util.js';

/**
 * Product mode: generates per-SKU SEO title, meta description, body_html,
 * and optional metafield overrides.
 *
 * @param {Object} args
 * @param {Object} args.foundation
 * @param {string} args.clusterName
 * @param {Object} args.product       { handle, title, ... }
 * @param {Object} args.claudeClient
 */
export async function assembleProduct({ foundation, clusterName, product, claudeClient }) {
  const systemPrompt = buildProductSystemPrompt({ foundation, clusterName, product });

  let proposed = null;
  let lastRawText = '';
  let lastError = null;
  const totalAttempts = MAX_PARSE_RETRIES + 1;
  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const response = await claudeClient.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        { role: 'user', content: `Generate PDP content for product handle "${product.handle}". Output JSON only.` },
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
          type: 'pdp-product',
          slug: product.handle,
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

  const errors = [];

  const lengths = validateLengths({
    seoTitle:        proposed.seoTitle,
    metaDescription: proposed.metaDescription,
    bodyHtml:        proposed.bodyHtml,
  });
  if (!lengths.valid) errors.push(...lengths.errors);

  for (const [field, text] of [
    ['seoTitle',        proposed.seoTitle],
    ['metaDescription', proposed.metaDescription],
    ['bodyHtml',        proposed.bodyHtml],
  ]) {
    const e = validateBrandTermExclusion({ text, field });
    if (!e.valid) errors.push(...e.errors);
  }

  // Ingredient-fabrication scan over body_html prose
  if (proposed.bodyHtml) {
    const fab = validateNoFabricatedIngredients({ text: proposed.bodyHtml });
    if (!fab.valid) {
      for (const f of fab.flagged) {
        errors.push(`bodyHtml: contains avoided ingredient "${f.term}" — context: "${f.context}"`);
      }
    }
  }

  return {
    type: 'pdp-product',
    slug: product.handle,
    status: errors.length === 0 ? 'pending' : 'needs_rework',
    generated_at: new Date().toISOString(),
    foundation_version: gitSha(),
    proposed,
    validation: { passed: errors.length === 0, errors, warnings: [] },
  };
}
