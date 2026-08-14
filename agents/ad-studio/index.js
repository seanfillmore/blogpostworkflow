// agents/ad-studio/index.js
//
// Ad Studio — publish-ready static ad creatives for Meta and Google Demand Gen.
//
// Usage:
//   node agents/ad-studio/index.js --product coconut-lotion [--variant coconut-breeze]
//                                 [--formats us-vs-them,manifesto] [--variations 3] [--dry-run]
//
// Stages: angle → copy (+ claim gate) → single-pass render → verify → package.
// See docs/superpowers/specs/2026-08-14-ad-studio-design.md

import { GoogleGenAI } from '@google/genai';
import Anthropic from '../../lib/anthropic.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREATIVE_MODELS } from '../../config/creative-models.js';
import { renderVariation } from './render.js';
import { buildVerifyPrompt, parseVerifyResponse, verdictFor } from './verify.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function slugify(s) {
  return String(s || '')
    .replace(/[‘’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function textOf(msg) {
  return (msg?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

/**
 * Render one variation, verifying after each attempt. Stops at maxAttempts.
 * @returns {Promise<{ok:boolean, buffer:Buffer|null, attempts:number, proof:object}>}
 */
export async function renderWithRetry({ gemini, anthropic, prompt, photoPaths, ratio, expected, format, maxAttempts = 3 }) {
  let attempts = 0;
  let lastProof = { ok: false, reasons: ['no attempt made'], missing: [], mismatchedPairs: [] };
  let lastBuffer = null;

  while (attempts < maxAttempts) {
    attempts += 1;
    lastBuffer = await renderVariation(gemini, { prompt, photoPaths, ratio });

    const msg = await anthropic.messages.create({
      model: CREATIVE_MODELS.adStudio.verify,
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: lastBuffer.toString('base64') } },
          { type: 'text', text: buildVerifyPrompt({ expected, format }) },
        ],
      }],
    });

    const { transcript, pairings } = parseVerifyResponse(textOf(msg));
    lastProof = verdictFor({ expected, transcript, pairings, format });
    lastProof.transcript = transcript;
    if (lastProof.ok) return { ok: true, buffer: lastBuffer, attempts, proof: lastProof };
  }

  return { ok: false, buffer: lastBuffer, attempts, proof: lastProof };
}

export function buildRunReport({ runId, product, results }) {
  let accepted = 0;
  let rejected = 0;
  const conceptsWithNoAcceptedVariation = [];

  for (const c of results) {
    const okCount = c.variations.filter(v => v.ok).length;
    accepted += okCount;
    rejected += c.variations.length - okCount;
    if (okCount === 0) conceptsWithNoAcceptedVariation.push(c.conceptSlug);
  }

  return {
    runId,
    generatedAt: new Date().toISOString(),
    product: { handle: product.handle, title: product.title },
    models: CREATIVE_MODELS.adStudio,
    totals: { accepted, rejected, concepts: results.length },
    conceptsWithNoAcceptedVariation,
    results,
  };
}

async function main() {
  // Parses argv, loads product manifest + PDP + persona + brand kit, then for each
  // selected format: copy → assertClaimsSourced (hard stop) → for each of N variations,
  // for each PLATFORM_TARGET, buildRenderPrompt + renderWithRetry → write artifacts,
  // copy.json and proof.json into variationDir → write run.json from buildRunReport.
  // Demand Gen text assets come from buildDemandGenAssets(zones).
  throw new Error('main() is implemented in Task 9 alongside the end-to-end run');
}

// Guard: importing this module must not run the agent.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}
