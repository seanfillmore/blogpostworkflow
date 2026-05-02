// agents/pdp-builder/lib/assemble-product.js
import { execSync } from 'node:child_process';
import { buildProductSystemPrompt } from './prompt-builder.js';
import {
  validateLengths,
  validateBrandTermExclusion,
} from './validators.js';

const CLAUDE_MODEL = 'claude-opus-4-7';

function gitSha() {
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}

function parseClaudeJson(response) {
  const text = response?.content?.find((b) => b.type === 'text')?.text || '';
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  return JSON.parse(cleaned);
}

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

  const response = await claudeClient.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [
      { role: 'user', content: `Generate PDP content for product handle "${product.handle}". Output JSON only.` },
    ],
  });

  let proposed;
  try { proposed = parseClaudeJson(response); }
  catch (e) {
    return {
      type: 'pdp-product',
      slug: product.handle,
      status: 'needs_rework',
      generated_at: new Date().toISOString(),
      foundation_version: gitSha(),
      proposed: null,
      validation: { passed: false, errors: [`Claude response not valid JSON: ${e.message}`], warnings: [] },
    };
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
