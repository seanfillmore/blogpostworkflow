// agents/pdp-builder/lib/assemble-bundle.js
//
// Bundle mode. Generates the Shopify description (plus SEO title and meta
// description) for a multi-product set, from a fact sheet derived entirely from
// live Shopify data.
//
// Two things differ from product mode and both are deliberate:
//
//  1. Validation failures RETRY with the failures fed back, up to
//     MAX_VALIDATION_RETRIES. Product mode treats a validation failure as a
//     signal and stops. For a bundle the most common failure is a word count or
//     a stray percentage, and the health-claim gate must never be satisfied by
//     someone editing the output by hand later — so the agent regenerates against
//     the specific violation, and if it still fails it says so loudly with
//     status "needs_rework". It never publishes either way.
//  2. It runs the health-claim gate from agents/ad-studio/health-claims.js. That
//     gate exists because a cosmetic that claims to treat something is an
//     unapproved drug, and that is not a per-surface question — it applies to a
//     PDP exactly as it applies to an ad.

import { buildBundleSystemPrompt } from './prompt-builder.js';
import {
  validateLengths,
  validateBundleLengths,
  validateBrandTermExclusion,
  validateNoFabricatedIngredients,
  validateNoHealthClaims,
  validateBundleComponents,
  validateNoFabricatedSizes,
  validateSavingsClaim,
} from './validators.js';
import { CLAUDE_MODEL, gitSha, parseClaudeJson, MAX_PARSE_RETRIES } from './util.js';

export const MAX_VALIDATION_RETRIES = 2;

/**
 * Runs every gate over one generated payload.
 * @returns {string[]} errors — empty means clean
 */
export function validateBundleContent({ proposed, facts, ingredientsByCluster }) {
  const errors = [];

  const lengths = validateLengths({
    seoTitle: proposed.seoTitle,
    metaDescription: proposed.metaDescription,
  });
  if (!lengths.valid) errors.push(...lengths.errors);

  const bodyLen = validateBundleLengths({ bodyHtml: proposed.bodyHtml });
  if (!bodyLen.valid) errors.push(...bodyLen.errors);

  for (const [field, text] of [
    ['seoTitle',        proposed.seoTitle],
    ['metaDescription', proposed.metaDescription],
    ['bodyHtml',        proposed.bodyHtml],
  ]) {
    const brand = validateBrandTermExclusion({ text, field });
    if (!brand.valid) errors.push(...brand.errors);

    // HARD GATE — every generated string, not just the body.
    const health = validateNoHealthClaims({ text, field });
    if (!health.valid) errors.push(...health.errors);
  }

  if (proposed.bodyHtml) {
    const fab = validateNoFabricatedIngredients({ text: proposed.bodyHtml });
    if (!fab.valid) {
      for (const f of fab.flagged) {
        errors.push(`bodyHtml: contains avoided ingredient "${f.term}" — context: "${f.context}"`);
      }
    }
    const comps = validateBundleComponents({ text: proposed.bodyHtml, facts, ingredientsByCluster });
    if (!comps.valid) errors.push(...comps.errors);

    const sizes = validateNoFabricatedSizes({ text: proposed.bodyHtml, facts });
    if (!sizes.valid) errors.push(...sizes.errors);

    const savings = validateSavingsClaim({ text: proposed.bodyHtml, facts });
    if (!savings.valid) errors.push(...savings.errors);
  } else {
    errors.push('bodyHtml: missing');
  }

  return errors;
}

function queueItem({ facts, proposed, errors, rawResponse = null, attempts }) {
  return {
    type: 'pdp-bundle',
    slug: facts?.handle ?? null,
    status: errors.length === 0 ? 'pending' : 'needs_rework',
    generated_at: new Date().toISOString(),
    foundation_version: gitSha(),
    attempts,
    facts,
    proposed,
    ...(rawResponse ? { raw_response: rawResponse } : {}),
    validation: { passed: errors.length === 0, errors, warnings: [] },
  };
}

/**
 * @param {Object} args
 * @param {Object} args.foundation    loadFoundation() output
 * @param {Object} args.facts         buildBundleFacts() output
 * @param {Object} args.claudeClient
 */
export async function assembleBundle({ foundation, facts, claudeClient }) {
  const systemPrompt = buildBundleSystemPrompt({ foundation, facts });
  const ingredientsByCluster = foundation.ingredientsByCluster;

  const messages = [{
    role: 'user',
    content: `Write the bundle description for "${facts.handle}". Output JSON only.`,
  }];

  let attempts = 0;
  let lastErrors = ['no attempt completed'];
  let lastProposed = null;
  let lastRaw = '';

  for (let round = 0; round <= MAX_VALIDATION_RETRIES; round++) {
    // Inner loop: JSON parse failures are transient model quirks, not signal.
    let proposed = null;
    let parseError = null;
    for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
      attempts += 1;
      const response = await claudeClient.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 3000,
        system: systemPrompt,
        messages,
      });
      lastRaw = response?.content?.find((b) => b.type === 'text')?.text || '';
      try {
        proposed = parseClaudeJson(response);
        parseError = null;
        break;
      } catch (e) {
        parseError = e;
      }
    }
    if (parseError) {
      return queueItem({
        facts,
        proposed: null,
        rawResponse: lastRaw,
        attempts,
        errors: [`Claude response not valid JSON after ${MAX_PARSE_RETRIES + 1} attempts: ${parseError.message}`],
      });
    }

    lastProposed = proposed;
    const errors = validateBundleContent({ proposed, facts, ingredientsByCluster });
    if (errors.length === 0) return queueItem({ facts, proposed, errors: [], attempts });

    lastErrors = errors;
    if (round === MAX_VALIDATION_RETRIES) break;

    messages.push({ role: 'assistant', content: JSON.stringify(proposed) });
    messages.push({
      role: 'user',
      content:
        `That draft was rejected. Fix every point below and output the COMPLETE corrected JSON ` +
        `object again — same keys, no commentary:\n` +
        errors.map((e) => `- ${e}`).join('\n'),
    });
  }

  return queueItem({ facts, proposed: lastProposed, errors: lastErrors, attempts });
}
