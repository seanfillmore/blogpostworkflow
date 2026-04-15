/**
 * Specificity Audit
 *
 * Scans product descriptions for vague marketing language, fetches Judge.me
 * reviews for context, and asks Claude to produce a rewritten description
 * sourced from concrete review claims. Results queued for approval via
 * the performance queue.
 *
 * Usage:
 *   node agents/specificity-audit/index.js              # audit + queue
 *   node agents/specificity-audit/index.js --dry-run    # audit only
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProducts } from '../../lib/shopify.js';
import { resolveExternalId, fetchProductReviews } from '../../lib/judgeme.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const QUEUE_DIR = join(ROOT, 'data', 'performance-queue');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
const flags = JSON.parse(readFileSync(join(ROOT, 'config', 'specificity-flags.json'), 'utf8'));

function loadEnv() {
  const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
  const env = {};
  for (const l of lines) {
    const t = l.trim(); if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('='); if (i === -1) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}
const env = loadEnv();
const SHOP_DOMAIN = env.SHOPIFY_STORE;
const JUDGEME_TOKEN = env.JUDGEME_API_TOKEN;

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

function findFlaggedPhrases(html) {
  const text = (html || '').toLowerCase().replace(/<[^>]+>/g, ' ');
  const found = [];
  for (const phrase of flags.vague_phrases) {
    const re = new RegExp(`\\b${phrase.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
    if (re.test(text)) found.push(phrase);
  }
  return found;
}

async function fetchReviews(handle) {
  if (!SHOP_DOMAIN || !JUDGEME_TOKEN) return [];
  try {
    const externalId = await resolveExternalId(handle, SHOP_DOMAIN, JUDGEME_TOKEN);
    if (!externalId) return [];
    const reviews = await fetchProductReviews(externalId, SHOP_DOMAIN, JUDGEME_TOKEN);
    return reviews
      .filter((r) => r.body && r.body.length > 40 && r.rating >= 4)
      .map((r) => r.body)
      .slice(0, 10);
  } catch {
    return [];
  }
}

function extractSchemaBlock(html) {
  if (!html) return { schemaBlock: '', body: '' };
  const re = /\s*<!--\s*schema-injector\s*-->[\s\S]*?<!--\s*schema-injector\s*-->\s*/i;
  const match = html.match(re);
  if (!match) return { schemaBlock: '', body: html };
  return { schemaBlock: match[0], body: html.replace(re, '') };
}

async function rewriteDescription(product, flaggedPhrases, reviews) {
  const { schemaBlock, body } = extractSchemaBlock(product.body_html);

  const prompt = `You are rewriting a product description for ${config.name}, a natural skincare brand.

CURRENT PRODUCT: ${product.title}
CURRENT DESCRIPTION (HTML):
${body}

FLAGGED VAGUE PHRASES TO REPLACE:
${flaggedPhrases.join(', ')}

CUSTOMER REVIEWS (SOURCE OF SPECIFIC CLAIMS):
${reviews.map((r, i) => `${i + 1}. ${r}`).join('\n\n')}

Rewrite the description with these rules:
1. Replace every vague flagged phrase with a specific, concrete claim — use actual language and observations from the customer reviews above.
2. Keep the same overall length and structure (headings, lists, paragraphs).
3. Preserve brand voice: warm, conversational, 8th-grade reading level. Short sentences. No em-dashes.
4. Keep any existing <h2>, <h3>, <ul>, <li> tags. Keep ingredient lists exactly as they are.
5. Do NOT invent claims not supported by the reviews.
6. Do NOT mention competitor brands.

Output ONLY the rewritten HTML body. No explanation, no code fence, no preamble.`;

  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });
  if (res.stop_reason === 'max_tokens') throw new Error('Rewrite truncated at max_tokens');
  const rewritten = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return schemaBlock ? `${schemaBlock.trim()}\n${rewritten}` : rewritten;
}

async function main() {
  console.log('\nSpecificity Audit\n');

  const products = await getProducts();
  console.log(`  Fetched ${products.length} product(s)`);

  const flagged = [];
  for (const p of products) {
    if (p.status !== 'active') continue;
    const phrases = findFlaggedPhrases(p.body_html);
    if (phrases.length > 0) flagged.push({ product: p, phrases });
  }
  console.log(`  Flagged: ${flagged.length} product(s) with vague language\n`);

  if (flagged.length === 0) {
    console.log('  Nothing to do.');
    return;
  }

  mkdirSync(QUEUE_DIR, { recursive: true });
  let queued = 0;
  for (const { product, phrases } of flagged) {
    console.log(`  [${product.handle}] flagged: ${phrases.join(', ')}`);

    const reviews = await fetchReviews(product.handle);
    if (reviews.length < 2) {
      console.log(`    Skipped — only ${reviews.length} quality review(s), need 2+ for review-sourced rewrite`);
      continue;
    }

    if (dryRun) {
      console.log(`    Would rewrite using ${reviews.length} review(s)`);
      continue;
    }

    let newHtml;
    try {
      newHtml = await rewriteDescription(product, phrases, reviews);
    } catch (err) {
      console.log(`    Rewrite failed: ${err.message}`);
      continue;
    }

    const queueItem = {
      slug: product.handle,
      title: `Product Rewrite: ${product.title}`,
      trigger: 'product-description-rewrite',
      resource_type: 'product',
      resource_id: product.id,
      current_body_html: product.body_html,
      proposed_body_html: newHtml,
      flagged_phrases: phrases,
      review_sample_count: reviews.length,
      signal_source: { type: 'specificity-audit', reviews_analyzed: reviews.length },
      summary: {
        what_changed: `Rewrote description replacing ${phrases.length} vague phrase(s) with claims sourced from ${reviews.length} customer review(s).`,
        why: 'LLMs cite concrete claims, not marketing abstractions. Reviewers describe products more specifically than marketing copy.',
        projected_impact: 'Increases citation likelihood in ChatGPT/Perplexity responses to product queries.',
      },
      status: 'pending',
      created_at: new Date().toISOString(),
    };

    writeFileSync(join(QUEUE_DIR, `${product.handle}.json`), JSON.stringify(queueItem, null, 2));
    console.log(`    Queued rewrite (${phrases.length} phrases → ${reviews.length} reviews)`);
    queued++;
  }

  await notify({
    subject: `Specificity Audit: ${queued} product rewrites queued`,
    body: `Flagged ${flagged.length} products, queued ${queued} rewrites for approval.`,
    status: 'success',
  });

  console.log(`\nDone. ${queued} rewrite(s) queued for approval.`);
}

main().catch((err) => {
  notify({ subject: 'Specificity Audit failed', body: err.message, status: 'error' });
  console.error('Error:', err.message);
  process.exit(1);
});
