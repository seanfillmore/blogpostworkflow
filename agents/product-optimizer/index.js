/**
 * Product & Collection Optimizer Agent
 *
 * Reviews product and collection page content for SEO quality. Identifies
 * thin descriptions, missing SEO fields, and weak copy, then uses Claude
 * to rewrite them with GSC keyword context.
 *
 * Strategy:
 *   1. Fetch all products and collections from Shopify
 *   2. Cross-reference GSC to find which URLs have impressions (have traffic potential)
 *   3. Flag pages with thin body copy (<100 words), missing meta titles, or low CTR
 *   4. Claude rewrites the description and SEO fields for flagged pages
 *   5. Dry-run shows before/after; --apply pushes to Shopify
 *
 * Output: data/reports/product-optimizer-report.md
 *
 * Usage:
 *   node agents/product-optimizer/index.js                   # dry run — products + collections
 *   node agents/product-optimizer/index.js --apply           # write changes to Shopify
 *   node agents/product-optimizer/index.js --type products   # products only
 *   node agents/product-optimizer/index.js --type collections # collections only
 *   node agents/product-optimizer/index.js --min-words 150   # stricter thin content threshold
 *   node agents/product-optimizer/index.js --limit 10        # max pages to rewrite
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  getProducts,
  getCustomCollections,
  getSmartCollections,
  updateProduct,
  updateCustomCollection,
  updateSmartCollection,
  upsertMetafield,
} from '../../lib/shopify.js';
import * as gsc from '../../lib/gsc.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'product-optimizer');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

// ── env ───────────────────────────────────────────────────────────────────────

function loadEnv() {
  const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return env;
}

const env = loadEnv();
if (!env.ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY in .env'); process.exit(1); }

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// ── args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

const apply = args.includes('--apply');
const typeArg = getArg('--type') || 'both'; // products | collections | both
const minWords = parseInt(getArg('--min-words') ?? '80', 10);
const limit = parseInt(getArg('--limit') ?? '20', 10);

// Handles of internal/system collections that should never be optimized
const EXCLUDED_HANDLES = new Set([
  'main-menu-3',
  'home-page-collection',
  'reelup-do-not-delete',
  'bundle-builder-products',
  'live-collection',                          // "THE ONE COLLECTION" — internal display collection
  'on-sale',                                  // generic sale page — low-value SEO target
  'all-products',                             // catch-all page
  'popular',                                  // algorithmic collection
  'best-sellers',                             // algorithmic collection
  'for-shopify-performance-tracking',         // Faire analytics — do not modify
]);

// Also exclude any collection whose title contains these strings (case-insensitive)
const EXCLUDED_TITLE_PATTERNS = [
  'do not delete',
  'do not modify',
  'shopify performance',
  'faire',
];

// ── helpers ───────────────────────────────────────────────────────────────────

function wordCount(html) {
  if (!html) return 0;
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 0).length;
}

function stripHtml(html) {
  return (html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── claude rewriter ───────────────────────────────────────────────────────────

async function rewriteProduct(product, keyword, gscData) {
  const currentDesc = stripHtml(product.body_html).slice(0, 2000);
  const currentWords = wordCount(product.body_html);
  const gscNote = gscData?.impressions > 0
    ? `This product page currently ranks around position #${Math.round(gscData.position)} for "${keyword}" with ${gscData.impressions} impressions/90 days and ${(gscData.ctr * 100).toFixed(1)}% CTR.`
    : `No GSC data yet for this page — this is a fresh optimization opportunity.`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `You are an SEO copywriter for ${config.name} (${config.url}), a natural skincare and personal care brand.

PRODUCT: ${product.title}
TARGET KEYWORD: "${keyword}"
CURRENT DESCRIPTION (${currentWords} words): ${currentDesc || '(none)'}
${gscNote}

Write an improved product description that:
1. Opens with a compelling hook that includes the target keyword naturally
2. Covers key benefits in 3–5 short paragraphs or a concise benefit list
3. Includes relevant secondary keywords naturally (ingredients, skin type, benefits)
4. Ends with a subtle call to action or reassurance statement
5. Is between 120–200 words — concise but complete
6. Matches ${config.name}'s voice: clean, expert, trustworthy, ingredient-focused

Also write:
- SEO title (50–60 chars, includes keyword)
- Meta description (140–155 chars, benefit-driven, includes keyword)

Return ONLY a JSON object:
{
  "body_html": "<p>...</p>",
  "seo_title": "...",
  "seo_description": "..."
}
No explanation, no markdown fences.`,
    }],
  });

  const raw = message.content[0].text.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  return JSON.parse(raw);
}

async function rewriteCollection(collection, keyword, gscData) {
  const currentDesc = stripHtml(collection.body_html).slice(0, 2000);
  const currentWords = wordCount(collection.body_html);
  const gscNote = gscData?.impressions > 0
    ? `This collection page currently ranks around position #${Math.round(gscData.position)} for "${keyword}" with ${gscData.impressions} impressions/90 days and ${(gscData.ctr * 100).toFixed(1)}% CTR.`
    : `No GSC data yet for this page — fresh optimization opportunity.`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `You are an SEO copywriter for ${config.name} (${config.url}), a natural skincare and personal care brand.

COLLECTION PAGE: ${collection.title}
TARGET KEYWORD: "${keyword}"
CURRENT DESCRIPTION (${currentWords} words): ${currentDesc || '(none)'}
${gscNote}

Write an improved collection page description that:
1. Opens with the target keyword naturally in the first sentence
2. Explains what this collection is and who it's for (2–3 sentences)
3. Highlights 2–3 key differentiators of ${config.name}'s products in this category
4. Includes secondary keywords naturally (ingredients, benefits, skin types)
5. Ends with a brief reassurance (natural ingredients, no harsh chemicals, etc.)
6. Is 100–160 words total
7. Uses ${config.name}'s voice: clean, knowledgeable, not salesy

Also write:
- SEO title (50–60 chars, includes keyword, format: "[Category] | ${config.name}")
- Meta description (140–155 chars, benefit-driven, includes keyword)

Return ONLY a JSON object:
{
  "body_html": "<p>...</p>",
  "seo_title": "...",
  "seo_description": "..."
}
No explanation, no markdown fences.`,
    }],
  });

  const raw = message.content[0].text.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  return JSON.parse(raw);
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nProduct & Collection Optimizer — ${config.name}`);
  console.log(`Mode: ${apply ? 'APPLY (will update Shopify)' : 'DRY RUN (use --apply to write changes)'}`);
  console.log(`Target: ${typeArg} | Min words: ${minWords} | Limit: ${limit}\n`);

  // ── Build page inventory ───────────────────────────────────────────────────

  const pages = []; // { type, id, collectionType, title, handle, body_html, url }

  if (typeArg !== 'collections') {
    process.stdout.write('  Fetching products... ');
    const products = await getProducts();
    for (const p of products) {
      const url = `${config.url}/products/${p.handle}`;
      pages.push({ type: 'product', id: p.id, title: p.title, handle: p.handle, body_html: p.body_html || '', url, raw: p });
    }
    console.log(`${products.length} products`);
  }

  if (typeArg !== 'products') {
    process.stdout.write('  Fetching collections... ');
    const [custom, smart] = await Promise.all([getCustomCollections(), getSmartCollections()]);
    for (const c of custom) {
      const url = `${config.url}/collections/${c.handle}`;
      pages.push({ type: 'collection', collectionType: 'custom', id: c.id, title: c.title, handle: c.handle, body_html: c.body_html || '', url, raw: c });
    }
    for (const c of smart) {
      const url = `${config.url}/collections/${c.handle}`;
      pages.push({ type: 'collection', collectionType: 'smart', id: c.id, title: c.title, handle: c.handle, body_html: c.body_html || '', url, raw: c });
    }
    console.log(`${custom.length + smart.length} collections (${custom.length} custom, ${smart.length} smart)`);
  }

  // ── Fetch GSC keyword data for all URLs ────────────────────────────────────

  process.stdout.write('  Fetching GSC page performance... ');
  const gscPages = await gsc.getQuickWinPages(500, 90);
  // Also get top pages for those outside positions 5-50
  const topPages = await gsc.getTopPages(500, 90);
  console.log('done');

  // Build URL → best keyword + metrics map
  const gscMap = new Map();
  for (const p of gscPages) {
    if (!gscMap.has(p.url)) gscMap.set(p.url, { keyword: p.keyword, ...p });
  }
  // Fill in any remaining with top pages data
  for (const p of topPages) {
    if (!gscMap.has(p.page)) gscMap.set(p.page, { keyword: p.page.split('/').pop().replace(/-/g, ' '), url: p.page, ...p });
  }

  // ── Score and select candidates ────────────────────────────────────────────

  const candidates = pages
    .filter((page) => {
      if (EXCLUDED_HANDLES.has(page.handle)) return false;
      const titleLower = page.title.toLowerCase();
      if (EXCLUDED_TITLE_PATTERNS.some((p) => titleLower.includes(p))) return false;
      return true;
    })
    .map((page) => {
      const wc = wordCount(page.body_html);
      const gscEntry = gscMap.get(page.url);
      const isThin = wc < minWords;
      const hasGscData = !!gscEntry;
      // Prioritize: thin content with impressions > thin without > thick with very low CTR
      let score = 0;
      if (isThin) score += 100;
      if (hasGscData) score += (gscEntry.impressions || 0) / 10;
      if (hasGscData && gscEntry.ctr < 0.03) score += 50;
      return { ...page, wc, gscEntry, isThin, score };
    })
    .filter((p) => p.isThin || (p.gscEntry && p.gscEntry.ctr < 0.025 && p.gscEntry.impressions > 50))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (candidates.length === 0) {
    console.log(`\n  No optimization candidates found (all pages have ${minWords}+ words and acceptable CTR).`);
    process.exit(0);
  }

  console.log(`\n  Found ${candidates.length} candidate(s) to optimize:\n`);
  for (const c of candidates) {
    const gscInfo = c.gscEntry
      ? `GSC: pos #${Math.round(c.gscEntry.position)}, ${c.gscEntry.impressions} impr, ${(c.gscEntry.ctr * 100).toFixed(1)}% CTR`
      : 'No GSC data';
    console.log(`  [${c.type}] "${c.title}" — ${c.wc} words | ${gscInfo}`);
  }
  console.log('');

  // ── Process candidates ─────────────────────────────────────────────────────

  const results = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const keyword = candidate.gscEntry?.keyword || candidate.title.toLowerCase();
    const gscData = candidate.gscEntry || null;

    process.stdout.write(`  [${i + 1}/${candidates.length}] "${candidate.title}"... `);

    try {
      let proposed;
      if (candidate.type === 'product') {
        proposed = await rewriteProduct(candidate.raw, keyword, gscData);
      } else {
        proposed = await rewriteCollection(candidate.raw, keyword, gscData);
      }
      console.log(`done (${wordCount(proposed.body_html)} words)`);

      const result = {
        ...candidate,
        keyword,
        proposed,
        applied: false,
      };

      if (apply) {
        try {
          if (candidate.type === 'product') {
            await updateProduct(candidate.id, { body_html: proposed.body_html });
            // SEO fields via metafields
            await upsertMetafield('products', candidate.id, 'global', 'title_tag', proposed.seo_title);
            await upsertMetafield('products', candidate.id, 'global', 'description_tag', proposed.seo_description);
          } else if (candidate.collectionType === 'custom') {
            await updateCustomCollection(candidate.id, { body_html: proposed.body_html });
            await upsertMetafield('custom_collections', candidate.id, 'global', 'title_tag', proposed.seo_title);
            await upsertMetafield('custom_collections', candidate.id, 'global', 'description_tag', proposed.seo_description);
          } else {
            await updateSmartCollection(candidate.id, { body_html: proposed.body_html });
            await upsertMetafield('smart_collections', candidate.id, 'global', 'title_tag', proposed.seo_title);
            await upsertMetafield('smart_collections', candidate.id, 'global', 'description_tag', proposed.seo_description);
          }
          result.applied = true;
          console.log(`    ✓ Updated in Shopify`);
        } catch (e) {
          console.error(`    ✗ Shopify error: ${e.message}`);
        }
      }

      results.push(result);
    } catch (e) {
      console.error(`failed: ${e.message}`);
    }
  }

  // ── Build report ───────────────────────────────────────────────────────────

  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const lines = [];

  lines.push(`# Product & Collection Optimizer Report — ${config.name}`);
  lines.push(`**Run date:** ${now}`);
  lines.push(`**Mode:** ${apply ? 'Applied' : 'Dry run'}`);
  lines.push(`**Pages optimized:** ${results.length}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const r of results) {
    const status = apply ? (r.applied ? '✅ Applied' : '⚠️ Failed') : '💡 Proposed';
    const gscLine = r.gscEntry
      ? `#${Math.round(r.gscEntry.position)} pos | ${r.gscEntry.impressions} impressions | ${(r.gscEntry.ctr * 100).toFixed(1)}% CTR`
      : 'No GSC data';

    lines.push(`## ${status} — ${r.type === 'product' ? '🛒' : '📁'} "${r.title}"`);
    lines.push(`**URL:** [${r.url}](${r.url})`);
    lines.push(`**Keyword:** "${r.keyword}" | **GSC:** ${gscLine} | **Before:** ${r.wc} words`);
    lines.push('');
    lines.push('**Description — Before:**');
    lines.push(`> ${stripHtml(r.body_html).slice(0, 300) || '*(empty)*'}`);
    lines.push('');
    lines.push('**Description — After:**');
    lines.push(`> ${stripHtml(r.proposed.body_html).slice(0, 300)}`);
    lines.push('');
    lines.push(`| | Before | After |`);
    lines.push(`|---|---|---|`);
    lines.push(`| SEO Title | ${r.raw.title} | ${r.proposed.seo_title} |`);
    lines.push(`| Meta Desc | *(from theme)* | ${r.proposed.seo_description} |`);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  if (!apply && results.length > 0) {
    lines.push('## To Apply Changes');
    lines.push('```bash');
    lines.push('node agents/product-optimizer/index.js --apply');
    lines.push('```');
  }

  mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = join(REPORTS_DIR, 'product-optimizer-report.md');
  writeFileSync(reportPath, lines.join('\n'));

  console.log(`\n  Report: ${reportPath}`);
  console.log(`  Pages ${apply ? 'updated' : 'analyzed'}: ${results.length}`);
  if (!apply && results.length > 0) {
    console.log('  Run with --apply to push changes to Shopify');
  }
}

main()
  .then(() => notify({ subject: 'Product Optimizer completed', body: 'Product Optimizer ran successfully.', status: 'success' }))
  .catch((err) => {
    notify({ subject: 'Product Optimizer failed', body: err.message || String(err), status: 'error' });
    console.error('Error:', err.message);
    process.exit(1);
  });
