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
 *   5. HEALTH-CLAIM GATE (lib/seo-copy-health-gate.js + lib/seo-copy-gate-loop.js)
 *      — every generated string this agent writes live is checked. A blocking
 *      hit is REGENERATED ONCE with the offending words named, and skipped only
 *      if the retry trips too; gated candidates do not consume --limit but carry
 *      their own equal budget. `--publish-approved` applies copy an earlier run
 *      generated and cannot regenerate, so a hit there REFUSES the write and
 *      leaves the item approved-but-stamped: never dismissed, never deleted.
 *      This agent writes live PRODUCT TITLES, which is the most direct claim a
 *      product can make about itself, and had no claims gate until 2026-08-24.
 *   6. Dry-run shows before/after; --apply pushes to Shopify
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
 *   node agents/product-optimizer/index.js --skip handle-a,handle-b  # exclude specific handles from this run
 *   node agents/product-optimizer/index.js --keyword-override "handle-a=keyword a,handle-b=keyword b"  # override the GSC top query with a chosen keyword (use when GSC top is branded/generic and a stronger long-tail exists)
 *   node agents/product-optimizer/index.js --from-gsc        # queue product meta rewrites from GSC signals
 *   node agents/product-optimizer/index.js --from-gsc --dry-run  # show candidates without queuing
 *   node agents/product-optimizer/index.js --optimize-titles        # queue product title rewrites from GSC signals
 *   node agents/product-optimizer/index.js --optimize-titles --dry-run  # show title candidates without queuing
 *   node agents/product-optimizer/index.js --publish-approved    # push approved meta + titles to Shopify
 *   node agents/product-optimizer/index.js --pages-from-gsc     # queue static page meta rewrites from GSC signals
 *   node agents/product-optimizer/index.js --pages-from-gsc --dry-run  # show page candidates without queuing
 *   node agents/product-optimizer/index.js --expand-faq         # expand FAQ page with GSC question queries
 */

import Anthropic from '../../lib/anthropic.js';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  getProducts,
  getPages,
  getCustomCollections,
  getSmartCollections,
  updateProduct,
  updatePage,
  updateCustomCollection,
  updateSmartCollection,
  upsertMetafield,
} from '../../lib/shopify.js';
import * as gsc from '../../lib/gsc.js';
import { getKeywordIdeas } from '../../lib/dataforseo.js';
import { notify, notifyLatestReport } from '../../lib/notify.js';
import { writeItem, activeSlugs, listQueueItems } from '../performance-engine/lib/queue.js';
import { createMetaTest } from '../../lib/meta-test.js';
import {
  loadIndex,
  lookupByUrl,
  entriesForCluster,
  buildPromptGrounding,
} from '../../lib/keyword-index/consumer.js';
import { clusterForCollection } from '../collection-content-optimizer/lib/cluster-mapper.js';
import { sortProductCandidates } from './lib/sort.js';
import { gateGeneratedCopy } from '../../lib/seo-copy-gate-loop.js';
import {
  SEO_COPY_COMPLIANCE_RULE, checkSeoCopyFields,
  renderGateSkipLines, renderGateRefusalLines, gateSkipSummaryFragment,
} from '../../lib/seo-copy-health-gate.js';

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
const fromGsc = args.includes('--from-gsc');
const pagesFromGsc = args.includes('--pages-from-gsc');
const expandFaq = args.includes('--expand-faq');
const optimizeTitles = args.includes('--optimize-titles');
const publishApproved = args.includes('--publish-approved');
const dryRun = args.includes('--dry-run');
const skipHandles = new Set((getArg('--skip') || '').split(',').map((s) => s.trim()).filter(Boolean));
// Parse --keyword-override "handle-a=keyword a,handle-b=keyword b" → Map(handle → keyword).
// Use when GSC top query is unusable (branded, generic) but a stronger long-tail
// exists in GSC's lower ranks or an external source (DataForSEO, Amazon).
const keywordOverrides = new Map(
  (getArg('--keyword-override') || '')
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf('=');
      return eq === -1 ? null : [pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()];
    })
    .filter(Boolean),
);

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

/**
 * Record one health-claim gate skip and say whether the run should stop.
 *
 * A gated candidate does NOT consume `--limit`: that budget counts pages
 * OPTIMISED, and a gated page was not optimised — spending the cap on nothing
 * is how a run of bad luck silently produces an empty day. But "doesn't count"
 * has to be bounded or it becomes an unbounded walk of the candidate list at
 * two model calls each, so gated candidates carry their own budget of the same
 * size. Worst-case spend is 2× the intended run, never a function of pool size.
 *
 * @returns {boolean} true when the skip budget is exhausted and the caller
 *                    should break out of its loop
 */
function recordGateSkip(skipped, { label, pageUrl, gated }, budget) {
  const words = [...new Set(gated.violations.map((v) => `${v.field}: "${v.match}"`))].join(', ');
  console.log('gated');
  console.log(`    ⊘ health-claim gate: ${words} — skipped after ${gated.attempts} attempt(s), page unchanged`);
  skipped.push({ label, pageUrl, violations: gated.violations, attempts: gated.attempts });
  if (skipped.length >= budget) {
    console.log(`  Health-claim gate: ${skipped.length} skips — at the skip budget, stopping.`);
    return true;
  }
  return false;
}

/**
 * The health-claim gate at a point where REGENERATION IS IMPOSSIBLE.
 *
 * `--publish-approved` runs daily from scheduler.js step 4a and pushes copy an
 * earlier run generated — possibly before this gate existed. There is no prompt
 * here, so a blocking hit refuses the write and stops.
 *
 * The item keeps its `approved` status and its proposed copy: it is refused,
 * not dismissed and not deleted. A gate is allowed to decide copy cannot ship;
 * it is not allowed to decide the work is worthless — that answer permanently
 * destroyed three paid-for content briefs on 2026-08-19. `health_gate` is
 * stamped on the item so the refusal is legible from the queue file itself, and
 * cleared again the moment compliant copy replaces it. Re-checking daily costs
 * nothing: this is regexes, not a model call, so no attempt counter is needed
 * to bound it.
 *
 * @returns {boolean} true when the caller must skip this item
 */
function refuseOnClaims(item, resource, refused, extraFields = {}) {
  const check = checkSeoCopyFields({
    'meta title_tag': item.proposed_meta?.seo_title,
    'meta description_tag': item.proposed_meta?.seo_description,
    'page summary': item.proposed_meta?.summary,
    'product title': item.proposed_title?.new_title,
    ...extraFields,
  });
  if (check.ok) {
    if (item.health_gate) { delete item.health_gate; writeItem(item); }
    return false;
  }
  const words = [...new Set(check.blocking.map((v) => `${v.field}: "${v.match}"`))].join(', ');
  console.error(`REFUSED (health-claim gate): ${words}`);
  item.health_gate = {
    refused_at: new Date().toISOString(),
    refused_by: 'product-optimizer --publish-approved',
    violations: check.blocking,
  };
  writeItem(item); // still `approved` — refused, not dismissed
  refused.push({ label: item.title, resource, violations: check.blocking });
  return true;
}

const BRAND_TERMS = (config.brand_terms || []).map((t) => t.toLowerCase());
const GENERIC_BLOCKLIST = (config.generic_keyword_blocklist || []).map((t) => t.toLowerCase());
// Competitor brand terms — anchoring product copy on a competitor's name is
// always wrong (the SERP listing reads as a redirect to them). Pull the list
// from the AI-citation prompts config since it's already maintained for
// citation tracking and includes name + every common alias.
const COMPETITOR_TERMS = (() => {
  try {
    const aiCfg = JSON.parse(readFileSync(join(ROOT, 'config', 'ai-citation-prompts.json'), 'utf8'));
    const terms = new Set();
    for (const c of (aiCfg.competitors || [])) {
      if (c.name) terms.add(c.name.toLowerCase());
      for (const a of (c.aliases || [])) terms.add(a.toLowerCase());
    }
    return [...terms];
  } catch {
    return [];
  }
})();

// Pick the best keyword to anchor a rewrite on. The default mode used to take
// each URL's #1 GSC query — but #1 is often noise (branded hashtags like
// "#realskincare", umbrella terms like "authentic skincare") that pull
// impressions without commercial intent. This walks the URL's full GSC query
// list, drops queries that hit brand_terms or generic_keyword_blocklist, and
// scores the rest by impressions × position-room (impressions × max(1, 100 -
// position)) so queries that get traffic AND have room to climb win.
//
// Returns { keyword, gscData, source }. `gscData` keeps the impressions /
// position / ctr context the rewrite prompt uses; `source` lets callers log
// where the keyword came from.
function passesAllFilters(kw) {
  const lower = (kw || '').toLowerCase();
  if (!lower) return false;
  if (BRAND_TERMS.some((t) => lower.includes(t))) return false;
  if (COMPETITOR_TERMS.some((t) => lower.includes(t))) return false;
  if (GENERIC_BLOCKLIST.includes(lower)) return false;
  return true;
}

async function pickBestKeyword(url, fallbackTitle) {
  let queries = [];
  try {
    queries = await gsc.getPageKeywords(url, 20, 90);
  } catch {
    // GSC unavailable — fall through to next layer.
  }
  const filtered = queries.filter((q) => passesAllFilters(q.keyword));
  if (filtered.length > 0) {
    filtered.sort((a, b) => {
      const score = (q) => (q.impressions || 0) * Math.max(1, 100 - (q.position || 100));
      return score(b) - score(a);
    });
    const best = filtered[0];
    return {
      keyword: best.keyword,
      gscData: { url, keyword: best.keyword, impressions: best.impressions, position: best.position, ctr: best.ctr },
      source: 'gsc-filtered',
    };
  }

  // Layer 2 fallback: DataForSEO keyword ideas seeded by the product title.
  // Used when GSC has no impressions for this URL or every query was filtered.
  // Picks the highest-volume idea that passes the same filter taxonomy and has
  // verified search volume (>0 reported by DataForSEO).
  const seed = (fallbackTitle || '').toLowerCase().split(/[|–—:]/)[0].trim();
  if (seed && seed.length >= 3) {
    try {
      const ideas = await getKeywordIdeas([seed], { limit: 30 });
      // Require keyword overlap with the seed so DataForSEO doesn't drag the
      // selector off-topic ("foam soap bundle" → "purina pro plan", etc.).
      // Stem the seed by dropping common stop words and short tokens.
      const seedWords = seed.split(/\s+/)
        .map((w) => w.replace(/[^a-z0-9]/g, ''))
        .filter((w) => w.length >= 4 && !['with', 'from', 'best', 'this', 'that'].includes(w));
      const filteredIdeas = (ideas || []).filter((i) => {
        if (!passesAllFilters(i.keyword)) return false;
        // Volume floor — anything under 100/mo is a long-tail variant DFS
        // barely tracks; not worth anchoring product copy on.
        if ((i.volume || 0) < 100) return false;
        // Commercial intent only — filters out informational queries like
        // "cut scrape meaning" and ambiguous brand-name spam like "soap 2 day"
        // (the streaming-piracy site, not a hand soap).
        if (i.intent && !['commercial', 'transactional'].includes(i.intent)) return false;
        const kw = i.keyword.toLowerCase();
        if (seedWords.length && !seedWords.some((w) => kw.includes(w))) return false;
        return true;
      });
      if (filteredIdeas.length > 0) {
        filteredIdeas.sort((a, b) => (b.volume || 0) - (a.volume || 0));
        const best = filteredIdeas[0];
        return {
          keyword: best.keyword,
          gscData: null,
          source: `dataforseo-volume (${best.volume}/mo)`,
        };
      }
    } catch {
      // DataForSEO unavailable — fall through to title fallback.
    }
  }

  // Layer 3 fallback: just use the title.
  return { keyword: (fallbackTitle || '').toLowerCase(), gscData: null, source: 'title-fallback' };
}

// ── claude rewriter ───────────────────────────────────────────────────────────

async function rewriteProduct(product, keyword, gscData, constraint = '') {
  const currentDesc = stripHtml(product.body_html).slice(0, 2000);
  const currentWords = wordCount(product.body_html);
  const gscNote = gscData?.impressions > 0
    ? `This product page currently ranks around position #${Math.round(gscData.position)} for "${keyword}" with ${gscData.impressions} impressions/90 days and ${(gscData.ctr * 100).toFixed(1)}% CTR.`
    : `No GSC data yet for this page — this is a fresh optimization opportunity.`;

  // Review sentiment context
  let reviewNote = '';
  try {
    const reviewPath = join(ROOT, 'data', 'reports', 'reviews', 'latest.json');
    if (existsSync(reviewPath)) {
      const reviewData = JSON.parse(readFileSync(reviewPath, 'utf8'));
      const sentiment = reviewData.product_sentiment?.[product.handle];
      if (sentiment?.negative_themes?.length > 0) {
        reviewNote = `\nREVIEW FEEDBACK: Customers have mentioned concerns about: ${sentiment.negative_themes.join(', ')}. Address these concerns naturally in the description (e.g., if "thick" → mention lightweight/fast-absorbing).`;
      }
    }
  } catch { /* ignore */ }

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `You are an SEO copywriter for ${config.name} (${config.url}), a natural skincare and personal care brand.

PRODUCT: ${product.title}
TARGET KEYWORD: "${keyword}"
CURRENT DESCRIPTION (${currentWords} words): ${currentDesc || '(none)'}
${gscNote}${reviewNote}

Write an improved product description that:
1. Opens with a compelling hook that includes the target keyword naturally
2. Covers key benefits in 3–5 short paragraphs or a concise benefit list
3. Includes relevant secondary keywords naturally (ingredients, skin type, benefits)
4. Ends with a subtle call to action or reassurance statement
5. Is between 120–200 words — concise but complete
6. Matches ${config.name}'s voice: clean, expert, trustworthy, ingredient-focused
7. Passes AI detection — avoid patterns that trigger AI content flags:
   - Vary sentence length aggressively: mix short punchy sentences with longer ones
   - Lead with a specific concrete detail, NOT a generic opening statement
   - Cut all filler phrases: "designed with care", "made with intention", "more than just",
     "you deserve", "no compromise", "real results", "peace of mind", "feel confident"
   - Use brand-specific details: organic virgin coconut oil, handmade in small batches, specific scents
   - Avoid uniform sentence patterns like "Whether you..." or "If you're looking for..."

Also write:
- SEO title (50–60 chars, includes keyword)
- Meta description (140–155 chars, benefit-driven, includes keyword)

${SEO_COPY_COMPLIANCE_RULE}
${constraint ? `\n${constraint}\n` : ''}
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

async function rewriteCollection(collection, keyword, gscData, constraint = '') {
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
8. Passes AI detection — avoid patterns that trigger AI content flags:
   - Vary sentence length aggressively: mix short punchy sentences with longer ones
   - Lead with a specific concrete detail, NOT a generic opening statement
   - Cut all filler phrases: "designed with care", "made with intention", "more than just",
     "you deserve", "no compromise", "real results", "peace of mind", "feel confident"
   - Use brand-specific details: organic virgin coconut oil, handmade in small batches, specific scents
   - Avoid uniform sentence patterns like "Whether you..." or "If you're looking for..."

Also write:
- SEO title (50–60 chars, includes keyword, format: "[Category] | ${config.name}")
- Meta description (140–155 chars, benefit-driven, includes keyword)

${SEO_COPY_COMPLIANCE_RULE}
${constraint ? `\n${constraint}\n` : ''}
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

// ── meta-only rewriter (GSC mode) ────────────────────────────────────────────

function formatGroundingBlock(ground) {
  if (!ground) return '';
  const lines = [];
  if (ground.validationTag === 'amazon') {
    const conv = ground.conversionShare != null
      ? ` (Amazon conversion share: ${(ground.conversionShare * 100).toFixed(1)}%)`
      : '';
    lines.push(`★ This page is Amazon-validated — verified commercial demand${conv}.`);
  } else if (ground.validationTag === 'gsc_ga4') {
    lines.push(`✓ This page has GSC + GA4 conversion signal — proven to convert on this site.`);
  }
  if (ground.clusterMateKeywords?.length) {
    lines.push(`Cluster-mate queries this page should also surface for: ${ground.clusterMateKeywords.join(', ')}.`);
  }
  return lines.length ? `\n${lines.join('\n')}\n` : '';
}

async function rewriteProductMeta(product, topQueries, gscData, ground, constraint = '') {
  const queriesFormatted = topQueries.slice(0, 5)
    .map((q) => `"${q.keyword}" — ${q.impressions} impr, pos #${Math.round(q.position)}, ${(q.ctr * 100).toFixed(1)}%`)
    .join('\n');

  const groundingBlock = formatGroundingBlock(ground);

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are an SEO specialist for ${config.name} (${config.url}), a natural skincare and personal care brand.

PRODUCT: ${product.title}
CURRENT META TITLE: ${product.currentMetaTitle || '(none — using product title)'}
CURRENT META DESCRIPTION: ${product.currentMetaDesc || '(none — auto-generated by theme)'}

GSC DATA (last 90 days):
  Impressions: ${gscData.impressions}
  Avg position: #${Math.round(gscData.position)}
  CTR: ${(gscData.ctr * 100).toFixed(2)}%

TOP QUERIES:
${queriesFormatted}
${groundingBlock}
Write improved meta tags only (no body content):
- SEO title (50–60 chars, includes top keyword naturally)
- Meta description (140–155 chars, benefit-driven, includes keyword, ends with call-to-action or value prop)

Also provide:
- what_changed: 1-sentence summary of what you changed
- why: 1-sentence explanation of why this change should improve CTR
- projected_impact: 1-sentence estimate of expected improvement

${SEO_COPY_COMPLIANCE_RULE}
${constraint ? `\n${constraint}\n` : ''}
Return ONLY a JSON object:
{
  "seo_title": "...",
  "seo_description": "...",
  "what_changed": "...",
  "why": "...",
  "projected_impact": "..."
}
No explanation, no markdown fences.`,
    }],
  });

  const raw = message.content[0].text.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  return JSON.parse(raw);
}

// ── page meta rewriter (GSC mode) ───────────────────────────────────────────

async function rewritePageMeta(page, topQueries, gscData, constraint = '') {
  const queriesFormatted = topQueries.slice(0, 5)
    .map((q) => `"${q.keyword}" — ${q.impressions} impr, pos #${Math.round(q.position)}, ${(q.ctr * 100).toFixed(1)}%`)
    .join('\n');

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are an SEO specialist for ${config.name} (${config.url}), a natural skincare and personal care brand.

SHOPIFY STATIC PAGE: ${page.title}
PAGE TYPE: Static page (About Us, FAQ, Contact, etc.)
CURRENT META TITLE: ${page.currentMetaTitle || '(none — using page title)'}
CURRENT META DESCRIPTION: ${page.currentMetaDesc || '(none — auto-generated by theme)'}

GSC DATA (last 90 days):
  Impressions: ${gscData.impressions}
  Avg position: #${Math.round(gscData.position)}
  CTR: ${(gscData.ctr * 100).toFixed(2)}%

TOP QUERIES:
${queriesFormatted}

Write improved meta tags and summary for this static page:
- SEO title (50–60 chars, includes top keyword naturally)
- Meta description (140–155 chars, benefit-driven, includes keyword, ends with call-to-action or value prop)
- Summary: a 1–2 sentence page summary suitable for Shopify's summary_html field

Also provide:
- what_changed: 1-sentence summary of what you changed
- why: 1-sentence explanation of why this change should improve CTR
- projected_impact: 1-sentence estimate of expected improvement

${SEO_COPY_COMPLIANCE_RULE}
${constraint ? `\n${constraint}\n` : ''}
Return ONLY a JSON object:
{
  "seo_title": "...",
  "seo_description": "...",
  "summary": "...",
  "what_changed": "...",
  "why": "...",
  "projected_impact": "..."
}
No explanation, no markdown fences.`,
    }],
  });

  const raw = message.content[0].text.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  return JSON.parse(raw);
}

// ── product title rewriter (GSC-driven keyword enrichment) ──────────────────

async function rewriteProductTitle(product, topQueries, gscData, ground, constraint = '') {
  const queriesFormatted = topQueries.slice(0, 8)
    .map((q) => `"${q.keyword}" — ${q.impressions} impr, pos #${Math.round(q.position)}`)
    .join('\n');

  const groundingBlock = formatGroundingBlock(ground);

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `You are a product naming specialist for ${config.name} (${config.url}), a natural skincare and personal care brand.

CURRENT PRODUCT TITLE: "${product.title}"
PRODUCT HANDLE (URL slug — do NOT change): ${product.handle}

GSC DATA (last 90 days for this product page):
  Impressions: ${gscData.impressions}
  Avg position: #${Math.round(gscData.position)}
  CTR: ${(gscData.ctr * 100).toFixed(2)}%

TOP SEARCH QUERIES (what people search to find this product):
${queriesFormatted}
${groundingBlock}

Write an improved product title that:
1. Includes the highest-volume relevant keyword naturally
2. Stays concise — 50–70 characters max
3. Reads as a real product name, not a keyword-stuffed SEO title
4. Keeps the core product identity recognizable (don't rename it completely)
5. Follows the pattern: [Descriptor] [Product Type] [Key Benefit or Variant]
   Example: "Organic Coconut Body Lotion — Deep Moisture for Dry Skin"

DO NOT:
- Add the brand name (Shopify adds it in the <title> tag automatically)
- Add pricing or promotional language
- Make it longer than 70 characters

${SEO_COPY_COMPLIANCE_RULE}
${constraint ? `\n${constraint}\n` : ''}
Return ONLY a JSON object:
{
  "new_title": "...",
  "what_changed": "1-sentence summary of what you changed",
  "why": "1-sentence explanation of why this change should improve discoverability"
}
No explanation, no markdown fences.`,
    }],
  });

  const raw = message.content[0].text.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  return JSON.parse(raw);
}

function selectTitleCandidates(products, gscMap, activeQueueSlugs) {
  return products
    .map((p) => {
      const gscEntry = gscMap.get(p.url);
      if (!gscEntry) return null;
      if (gscEntry.impressions < 50) return null;
      if (activeQueueSlugs.has(p.handle)) return null;
      // Check if the top GSC keyword is already in the product title
      const titleLower = p.title.toLowerCase();
      const topKw = (gscEntry.keyword || '').toLowerCase();
      const kwWords = topKw.split(/\s+/).filter((w) => w.length > 3);
      const overlap = kwWords.filter((w) => titleLower.includes(w)).length;
      // If most keyword words are already in the title, skip
      if (kwWords.length > 0 && overlap >= kwWords.length * 0.7) return null;
      return { ...p, gsc: gscEntry };
    })
    .filter(Boolean)
    .sort((a, b) => b.gsc.impressions - a.gsc.impressions);
}

// ── optimize-titles mode ────────────────────────────────────────────────────

async function optimizeTitlesMode() {
  console.log(`\nProduct Optimizer — GSC-driven product title optimization`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (showing candidates only)' : 'QUEUE (writing to performance-queue)'}`);
  console.log(`Limit: ${limit}\n`);

  process.stdout.write('  Fetching products... ');
  const products = await getProducts();
  const productPages = products.map((p) => ({
    type: 'product',
    id: p.id,
    title: p.title,
    handle: p.handle,
    url: `${config.url}/products/${p.handle}`,
    raw: p,
  }));
  console.log(`${products.length} products`);

  process.stdout.write('  Fetching GSC page performance... ');
  const gscPages = await gsc.getQuickWinPages(500, 90);
  const topPages = await gsc.getTopPages(500, 90);
  console.log('done');

  const gscMap = new Map();
  for (const p of gscPages) {
    if (!gscMap.has(p.url)) gscMap.set(p.url, { keyword: p.keyword, ...p });
  }
  for (const p of topPages) {
    if (!gscMap.has(p.page)) gscMap.set(p.page, { keyword: p.page.split('/').pop().replace(/-/g, ' '), url: p.page, ...p });
  }

  const active = activeSlugs();
  const filtered = productPages.filter((p) => !EXCLUDED_HANDLES.has(p.handle));
  const idx = loadIndex(ROOT);
  const rawCandidates = selectTitleCandidates(filtered, gscMap, active);
  const enriched = rawCandidates.map((c) => ({ ...c, idx: productIndexContext(c, idx) }));
  const candidates = sortProductCandidates(enriched).slice(0, limit);

  if (candidates.length === 0) {
    console.log('\n  No title optimization candidates found (top keywords already in titles).');
    return;
  }

  if (idx) {
    const validated = candidates.filter((c) => c.idx.validationTag === 'amazon').length;
    console.log(`  ${validated} of ${candidates.length} candidates are Amazon-validated`);
  }

  console.log(`\n  Found ${candidates.length} candidate(s):\n`);
  for (const c of candidates) {
    const tag = c.idx.validationTag === 'amazon' ? '★ ' : c.idx.validationTag === 'gsc_ga4' ? '✓ ' : '';
    console.log(`  ${tag}"${c.title}" — top query: "${c.gsc.keyword}" (${c.gsc.impressions} impr)`);
  }

  if (dryRun) {
    console.log('\n  Dry run — no queue items written. Remove --dry-run to queue title rewrites.');
    return;
  }

  console.log('');

  const gateSkipped = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    process.stdout.write(`  [${i + 1}/${candidates.length}] "${c.title}"... `);

    try {
      const topQueries = await gsc.getPageKeywords(c.url, 10, 90);
      const ground = buildPromptGrounding(c.idx.entry, c.idx.clusterEntries);

      // ── health-claim gate ────────────────────────────────────────────────
      // The single highest-exposure string this fleet writes: a PRODUCT TITLE
      // is the most direct claim a product can make about itself, it is what
      // Shopify puts in the <title> tag, and it is what a shopper reads first.
      // Nothing checked it before 2026-08-24.
      const gated = await gateGeneratedCopy(
        (constraint) => rewriteProductTitle(c, topQueries, c.gsc, ground, constraint),
        { extract: (p) => ({ 'product title': p?.new_title }), required: ['product title'] },
      );
      if (!gated.ok) {
        if (recordGateSkip(gateSkipped, { label: c.title, pageUrl: c.url, gated }, limit)) break;
        continue;
      }
      const proposed = gated.proposed;

      const item = {
        slug: c.handle,
        title: `${c.title} → ${proposed.new_title}`,
        trigger: 'product-title-rewrite',
        signal_source: {
          type: 'gsc-product-title',
          impressions: c.gsc.impressions,
          position: c.gsc.position,
          ctr: c.gsc.ctr,
          top_queries: topQueries.map((q) => q.keyword),
        },
        proposed_title: {
          new_title: proposed.new_title,
          original_title: c.title,
          handle: c.handle,
        },
        resource_type: 'product',
        resource_id: c.id,
        summary: {
          what_changed: proposed.what_changed,
          why: proposed.why,
        },
        cluster: c.idx.cluster,
        validation_source: c.idx.validationTag,
        amazon_conversion_share: c.idx.conversionShare,
        status: 'pending',
        created_at: new Date().toISOString(),
      };
      writeItem(item);
      console.log(`queued → "${proposed.new_title}"`);
    } catch (e) {
      console.error(`failed: ${e.message}`);
    }
  }

  console.log(`\n  Done — ${candidates.length - gateSkipped.length} title rewrite(s) written to data/performance-queue/`);
  for (const line of renderGateSkipLines(gateSkipped)) console.log(`  ${line}`);
  return { gateSkipped };
}

// ── candidate selection (shared with tests) ──────────────────────────────────

/**
 * Build the per-product keyword-index signal bundle. Returns an object
 * always (never null) so downstream code can read fields without guards.
 */
function productIndexContext(product, idx) {
  if (!idx) return { entry: null, cluster: null, clusterEntries: [], validationTag: null, amazonPurchases: 0, conversionShare: null };
  const entry = lookupByUrl(idx, product.url) || null;
  const cluster = entry?.cluster && entry.cluster !== 'unclustered'
    ? entry.cluster
    : clusterForCollection({ handle: product.handle, title: product.title }, idx);
  const clusterEntries = cluster ? entriesForCluster(idx, cluster, { limit: 8 }) : [];
  return {
    entry,
    cluster,
    clusterEntries,
    validationTag: entry?.validation_source ?? (clusterEntries.some((e) => e.validation_source === 'amazon') ? 'amazon' : null),
    amazonPurchases: entry?.amazon?.purchases ?? 0,
    conversionShare: entry?.amazon?.conversion_share ?? null,
  };
}

function selectProductMetaCandidates(products, gscMap, activeQueueSlugs) {
  return products
    .map((p) => {
      const gscEntry = gscMap.get(p.url);
      if (!gscEntry) return null;
      if (gscEntry.impressions < 100) return null;
      if (gscEntry.ctr >= 0.01) return null;
      if (activeQueueSlugs.has(p.handle)) return null;
      return { ...p, gsc: gscEntry };
    })
    .filter(Boolean)
    .sort((a, b) => b.gsc.impressions - a.gsc.impressions);
}

function buildProductMetaQueueItem(product, gscData, topQueries, proposedMeta) {
  return {
    slug: product.handle,
    title: `${product.title} — Meta Rewrite`,
    trigger: 'product-meta-rewrite',
    signal_source: {
      type: 'gsc-product-meta',
      impressions: gscData.impressions,
      position: gscData.position,
      ctr: gscData.ctr,
      top_queries: topQueries.map((q) => q.keyword),
    },
    proposed_meta: {
      seo_title: proposedMeta.seo_title,
      seo_description: proposedMeta.seo_description,
      original_title: product.title,
      original_description: product.metaDescription || null,
    },
    resource_type: 'product',
    resource_id: product.id,
    summary: {
      what_changed: proposedMeta.what_changed,
      why: proposedMeta.why,
      projected_impact: proposedMeta.projected_impact,
    },
    status: 'pending',
    created_at: new Date().toISOString(),
  };
}

// ── from-gsc mode ────────────────────────────────────────────────────────────

async function fromGscMode() {
  console.log(`\nProduct Optimizer — GSC-driven meta rewrite mode`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (showing candidates only)' : 'QUEUE (writing to performance-queue)'}`);
  console.log(`Limit: ${limit}\n`);

  // Fetch products from Shopify
  process.stdout.write('  Fetching products... ');
  const products = await getProducts();
  const productPages = products.map((p) => ({
    type: 'product',
    id: p.id,
    title: p.title,
    handle: p.handle,
    body_html: p.body_html || '',
    url: `${config.url}/products/${p.handle}`,
    metaDescription: null,
    raw: p,
  }));
  console.log(`${products.length} products`);

  // Fetch GSC data
  process.stdout.write('  Fetching GSC page performance... ');
  const gscPages = await gsc.getQuickWinPages(500, 90);
  const topPages = await gsc.getTopPages(500, 90);
  console.log('done');

  // Build URL → GSC map
  const gscMap = new Map();
  for (const p of gscPages) {
    if (!gscMap.has(p.url)) gscMap.set(p.url, { keyword: p.keyword, ...p });
  }
  for (const p of topPages) {
    if (!gscMap.has(p.page)) gscMap.set(p.page, { keyword: p.page.split('/').pop().replace(/-/g, ' '), url: p.page, ...p });
  }

  // Filter candidates
  const active = activeSlugs();
  const filtered = productPages.filter((p) => {
    if (EXCLUDED_HANDLES.has(p.handle)) return false;
    const titleLower = p.title.toLowerCase();
    if (EXCLUDED_TITLE_PATTERNS.some((pat) => titleLower.includes(pat))) return false;
    return true;
  });

  const idx = loadIndex(ROOT);
  const rawCandidates = selectProductMetaCandidates(filtered, gscMap, active);
  const enriched = rawCandidates.map((c) => ({ ...c, idx: productIndexContext(c, idx) }));
  const candidates = sortProductCandidates(enriched).slice(0, limit);

  if (candidates.length === 0) {
    console.log('\n  No GSC-driven meta rewrite candidates found.');
    return;
  }

  if (idx) {
    const validated = candidates.filter((c) => c.idx.validationTag === 'amazon').length;
    console.log(`  ${validated} of ${candidates.length} candidates are Amazon-validated`);
  }

  console.log(`\n  Found ${candidates.length} candidate(s):\n`);
  for (const c of candidates) {
    const tag = c.idx.validationTag === 'amazon' ? '★ ' : c.idx.validationTag === 'gsc_ga4' ? '✓ ' : '';
    console.log(`  ${tag}"${c.title}" — ${c.gsc.impressions} impr, pos #${Math.round(c.gsc.position)}, ${(c.gsc.ctr * 100).toFixed(2)}% CTR`);
  }

  if (dryRun) {
    console.log('\n  Dry run — no queue items written. Remove --dry-run to queue rewrites.');
    return;
  }

  console.log('');

  // Process each candidate
  const gateSkipped = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    process.stdout.write(`  [${i + 1}/${candidates.length}] "${c.title}"... `);

    try {
      const topQueries = await gsc.getPageKeywords(c.url, 10, 90);
      const ground = buildPromptGrounding(c.idx.entry, c.idx.clusterEntries);
      const gated = await gateGeneratedCopy(
        (constraint) => rewriteProductMeta(
          { title: c.title, currentMetaTitle: null, currentMetaDesc: null },
          topQueries, c.gsc, ground, constraint,
        ),
        { extract: (p) => ({ title: p?.seo_title, meta: p?.seo_description }), required: ['title'] },
      );
      if (!gated.ok) {
        if (recordGateSkip(gateSkipped, { label: c.title, pageUrl: c.url, gated }, limit)) break;
        continue;
      }
      const proposed = gated.proposed;

      const item = buildProductMetaQueueItem(c, c.gsc, topQueries, proposed);
      item.cluster = c.idx.cluster;
      item.validation_source = c.idx.validationTag;
      item.amazon_conversion_share = c.idx.conversionShare;
      writeItem(item);
      console.log('queued');
    } catch (e) {
      console.error(`failed: ${e.message}`);
    }
  }

  console.log(`\n  Done — ${candidates.length - gateSkipped.length} item(s) written to data/performance-queue/`);
  for (const line of renderGateSkipLines(gateSkipped)) console.log(`  ${line}`);
  return { gateSkipped };
}

// ── pages-from-gsc mode ─────────────────────────────────────────────────────

async function pagesFromGscMode() {
  console.log(`\nProduct Optimizer — GSC-driven static page meta rewrite mode`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (showing candidates only)' : 'QUEUE (writing to performance-queue)'}`);
  console.log(`Limit: ${limit}\n`);

  // Fetch pages from Shopify
  process.stdout.write('  Fetching pages... ');
  const pages = await getPages();
  const pageEntries = pages.map((p) => ({
    type: 'page',
    id: p.id,
    title: p.title,
    handle: p.handle,
    body_html: p.body_html || '',
    url: `${config.url}/pages/${p.handle}`,
    raw: p,
  }));
  console.log(`${pages.length} pages`);

  // Fetch GSC data
  process.stdout.write('  Fetching GSC page performance... ');
  const gscPages = await gsc.getQuickWinPages(500, 90);
  const topPages = await gsc.getTopPages(500, 90);
  console.log('done');

  // Build URL → GSC map
  const gscMap = new Map();
  for (const p of gscPages) {
    if (!gscMap.has(p.url)) gscMap.set(p.url, { keyword: p.keyword, ...p });
  }
  for (const p of topPages) {
    if (!gscMap.has(p.page)) gscMap.set(p.page, { keyword: p.page.split('/').pop().replace(/-/g, ' '), url: p.page, ...p });
  }

  // Non-commercial pages that should never be rewritten for SEO
  const SKIP_HANDLES = new Set([
    'privacy-policy', 'privacy-policy-1',
    'terms-of-service', 'terms-of-service-1',
    'refund-policy', 'refund-policy-1',
    'shipping-policy', 'shipping-policy-1',
    'track-order',
    'contact', 'contact-1', 'contact-us',
    'about-us', 'about-us-1',
    'wholesale-inquiry',
    'veterans',
  ]);

  // Filter candidates: >=50 impressions, CTR < 2%, not in active queue, not non-commercial
  const active = activeSlugs();
  const candidates = pageEntries
    .map((p) => {
      if (SKIP_HANDLES.has(p.handle)) return null;
      const gscEntry = gscMap.get(p.url);
      if (!gscEntry) return null;
      if (gscEntry.impressions < 50) return null;
      if (gscEntry.ctr >= 0.02) return null;
      if (active.has(p.handle)) return null;
      return { ...p, gsc: gscEntry };
    })
    .filter(Boolean)
    .sort((a, b) => b.gsc.impressions - a.gsc.impressions)
    .slice(0, limit);

  if (candidates.length === 0) {
    console.log('\n  No GSC-driven page meta rewrite candidates found.');
    return;
  }

  console.log(`\n  Found ${candidates.length} candidate(s):\n`);
  for (const c of candidates) {
    console.log(`  "${c.title}" — ${c.gsc.impressions} impr, pos #${Math.round(c.gsc.position)}, ${(c.gsc.ctr * 100).toFixed(2)}% CTR`);
  }

  if (dryRun) {
    console.log('\n  Dry run — no queue items written. Remove --dry-run to queue rewrites.');
    return;
  }

  console.log('');

  // Process each candidate
  const gateSkipped = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    process.stdout.write(`  [${i + 1}/${candidates.length}] "${c.title}"... `);

    try {
      const topQueries = await gsc.getPageKeywords(c.url, 10, 90);
      // `summary` is checked as well as title/meta: it is written to Shopify's
      // summary_html, which the theme renders on the page itself.
      const gated = await gateGeneratedCopy(
        (constraint) => rewritePageMeta(
          { title: c.title, currentMetaTitle: null, currentMetaDesc: null },
          topQueries, c.gsc, constraint,
        ),
        {
          extract: (p) => ({ title: p?.seo_title, meta: p?.seo_description, 'page summary': p?.summary }),
          required: ['title'],
        },
      );
      if (!gated.ok) {
        if (recordGateSkip(gateSkipped, { label: c.title, pageUrl: c.url, gated }, limit)) break;
        continue;
      }
      const proposed = gated.proposed;

      const item = {
        slug: c.handle,
        title: `${c.title} — Page Meta Rewrite`,
        trigger: 'page-meta-rewrite',
        signal_source: {
          type: 'gsc-page-meta',
          impressions: c.gsc.impressions,
          position: c.gsc.position,
          ctr: c.gsc.ctr,
          top_queries: topQueries.map((q) => q.keyword),
        },
        proposed_meta: {
          seo_title: proposed.seo_title,
          seo_description: proposed.seo_description,
          summary: proposed.summary || null,
          original_title: c.title,
          original_description: null,
        },
        resource_type: 'page',
        resource_id: c.id,
        summary: {
          what_changed: proposed.what_changed,
          why: proposed.why,
          projected_impact: proposed.projected_impact,
        },
        status: 'pending',
        created_at: new Date().toISOString(),
      };
      writeItem(item);
      console.log('queued');
    } catch (e) {
      console.error(`failed: ${e.message}`);
    }
  }

  console.log(`\n  Done — ${candidates.length - gateSkipped.length} item(s) written to data/performance-queue/`);
  for (const line of renderGateSkipLines(gateSkipped)) console.log(`  ${line}`);
  return { gateSkipped };
}

// ── expand-faq mode ─────────────────────────────────────────────────────────

async function expandFaqMode() {
  console.log(`\nProduct Optimizer — FAQ expansion mode\n`);

  // Fetch pages from Shopify
  process.stdout.write('  Fetching pages... ');
  const pages = await getPages();
  console.log(`${pages.length} pages`);

  // Find FAQ page
  const faqPage = pages.find(
    (p) => p.handle === 'faq' || p.handle === 'faqs' || p.title.toLowerCase().includes('faq'),
  );

  if (!faqPage) {
    console.log('  No FAQ page found (looked for handle "faq", "faqs", or title containing "faq").');
    return;
  }

  console.log(`  Found FAQ page: "${faqPage.title}" (handle: ${faqPage.handle})`);

  const faqUrl = `${config.url}/pages/${faqPage.handle}`;

  // Get GSC queries for this page
  process.stdout.write('  Fetching GSC queries for FAQ page... ');
  const queries = await gsc.getPageKeywords(faqUrl, 50, 90);
  console.log(`${queries.length} queries`);

  // Filter to question queries
  const questionQueries = queries.filter(
    (q) => /^(who|what|where|when|why|how)\b/i.test(q.keyword) || q.keyword.includes('?'),
  );

  if (questionQueries.length === 0) {
    console.log('  No question-type queries found in GSC data for this page.');
    return;
  }

  console.log(`  Found ${questionQueries.length} question queries:\n`);
  for (const q of questionQueries.slice(0, 10)) {
    console.log(`    "${q.keyword}" — ${q.impressions} impr, pos #${Math.round(q.position)}`);
  }
  if (questionQueries.length > 10) console.log(`    ... and ${questionQueries.length - 10} more`);

  // Send to Claude for FAQ expansion
  process.stdout.write('\n  Generating expanded FAQ content... ');

  const queriesFormatted = questionQueries
    .map((q) => `"${q.keyword}" — ${q.impressions} impressions, position #${Math.round(q.position)}`)
    .join('\n');

  const existingBody = faqPage.body_html || '';

  // The gate needs to be able to REGENERATE this, so the prompt lives in a
  // function that takes a constraint like every other rewriter here. An FAQ
  // answer is the highest-risk long text this agent writes — a real shopper
  // question is "can I use this on eczema?", and answering it in the product's
  // own voice is precisely what FDA intended-use doctrine reads as a drug claim.
  const generateFaq = async (constraint = '') => {
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are an SEO specialist for ${config.name} (${config.url}), a natural skincare and personal care brand.

EXISTING FAQ PAGE HTML:
${existingBody}

NEW QUESTION QUERIES FROM GOOGLE SEARCH CONSOLE:
${queriesFormatted}

Expand this FAQ page by:
1. Keep ALL existing Q&A sections intact
2. Add new Q&A sections for the question queries above that aren't already covered
3. Write clear, helpful answers (2–4 sentences each) in ${config.name}'s voice: clean, expert, trustworthy
4. Include relevant internal links where appropriate (use ${config.url} as base)

Also write:
- SEO title (50–60 chars, includes "FAQ" naturally)
- Meta description (140–155 chars, mentions FAQ and key topics)
- what_changed: summary of questions added
- why: why these additions should improve search visibility
- projected_impact: expected improvement

${SEO_COPY_COMPLIANCE_RULE}
${constraint ? `\n${constraint}\n` : ''}
Return ONLY a JSON object:
{
  "body_html": "<the full expanded FAQ HTML>",
  "seo_title": "...",
  "seo_description": "...",
  "what_changed": "...",
  "why": "...",
  "projected_impact": "..."
}
No explanation, no markdown fences.`,
    }],
  });

  const raw = message.content[0].text.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
    return JSON.parse(raw);
  };

  const gated = await gateGeneratedCopy(generateFaq, {
    extract: (p) => ({ title: p?.seo_title, meta: p?.seo_description, 'faq body': p?.body_html }),
    required: ['title', 'faq body'],
  });
  if (!gated.ok) {
    const words = [...new Set(gated.violations.map((v) => `${v.field}: "${v.match}"`))].join(', ');
    console.log('gated');
    console.log(`  \u2298 health-claim gate: ${words} — skipped after ${gated.attempts} attempt(s), nothing queued`);
    return { gateSkipped: [{ label: faqPage.title, pageUrl: faqUrl, violations: gated.violations }] };
  }
  const proposed = gated.proposed;
  console.log(gated.attempts > 1 ? 'done (regenerated once — health-claim gate)' : 'done');

  // Save HTML to data/page-content/faq.html
  const pageContentDir = join(ROOT, 'data', 'page-content');
  mkdirSync(pageContentDir, { recursive: true });
  const htmlPath = join(pageContentDir, 'faq.html');
  writeFileSync(htmlPath, proposed.body_html);
  console.log(`  Saved expanded HTML to ${htmlPath}`);

  // Write queue item
  const item = {
    slug: faqPage.handle,
    title: `${faqPage.title} — FAQ Expansion`,
    trigger: 'faq-expansion',
    signal_source: {
      type: 'gsc-faq-questions',
      question_count: questionQueries.length,
      top_questions: questionQueries.slice(0, 5).map((q) => q.keyword),
    },
    proposed_meta: {
      seo_title: proposed.seo_title,
      seo_description: proposed.seo_description,
    },
    proposed_html_path: htmlPath,
    // NO `faq_schema` HERE ANY MORE (retired 2026-08-24). This mode used to ask
    // Claude for a `FAQPage` JSON-LD block and stamp it onto the queue item —
    // and NOTHING ever read it: `--publish-approved` below pushes `body_html`
    // and the two SEO metafields, and never looks at the field. So it was a
    // dead payload, and the prompt line that produced it was an open invitation
    // to embed the same dead markup inside `body_html`, where it WOULD have
    // shipped. Google REMOVED the FAQ rich result from Search
    // (`.../structured-data/faqpage` 301s to
    // `/search/updates#removing-faq-rich-result`; `.../how-to` likewise;
    // `.../article` still 200s, so the 301s are the features being retired).
    // The FAQ prose this mode writes is the point and is untouched.
    resource_type: 'page',
    resource_id: faqPage.id,
    summary: {
      what_changed: proposed.what_changed,
      why: proposed.why,
      projected_impact: proposed.projected_impact,
    },
    status: 'pending',
    created_at: new Date().toISOString(),
  };
  writeItem(item);
  console.log(`  Queue item written to data/performance-queue/`);

  console.log(`\n  Done — review the expanded FAQ at ${htmlPath} and approve in the queue.`);
  return { gateSkipped: [] };
}

// ── publish-approved mode ────────────────────────────────────────────────────

async function publishApprovedProducts() {
  console.log(`\nProduct Optimizer — publishing approved meta rewrites\n`);

  // Refusals collected across all four item kinds this mode publishes.
  const refused = [];

  const items = listQueueItems().filter(
    (i) => i.trigger === 'product-meta-rewrite' && i.status === 'approved',
  );

  if (items.length === 0) {
    console.log('  No approved product-meta-rewrite items found.');
    return;
  }

  console.log(`  Found ${items.length} approved item(s) to publish:\n`);

  let published = 0;
  for (const item of items) {
    process.stdout.write(`  "${item.title}"... `);
    if (!item.resource_id || !item.proposed_meta?.seo_title || !item.proposed_meta?.seo_description) {
      console.error('skipped: missing resource_id or proposed_meta');
      continue;
    }
    if (refuseOnClaims(item, `products/${item.slug}`, refused)) continue;
    try {
      await upsertMetafield('products', item.resource_id, 'global', 'title_tag', item.proposed_meta.seo_title);
      await upsertMetafield('products', item.resource_id, 'global', 'description_tag', item.proposed_meta.seo_description);

      item.status = 'published';
      item.published_at = new Date().toISOString();
      writeItem(item);
      console.log('published');
      published++;

      // Auto-create A/B test
      try {
        await createMetaTest({
          slug: item.slug,
          url: `${config.url}/products/${item.slug}`,
          resourceType: 'product',
          resourceId: item.resource_id,
          originalTitle: item.proposed_meta.original_title,
          newTitle: item.proposed_meta.seo_title,
        });
      } catch (e) {
        console.warn(`  A/B test creation failed: ${e.message}`);
      }
    } catch (e) {
      console.error(`failed: ${e.message}`);
    }
  }

  console.log(`\n  Done — ${published}/${items.length} product meta rewrite(s) pushed to Shopify.`);

  // Handle page-meta-rewrite items
  const pageMetaItems = listQueueItems().filter(
    (i) => i.trigger === 'page-meta-rewrite' && i.status === 'approved',
  );

  if (pageMetaItems.length > 0) {
    console.log(`\n  Found ${pageMetaItems.length} approved page-meta-rewrite item(s):\n`);
    let pagePublished = 0;
    for (const item of pageMetaItems) {
      process.stdout.write(`  "${item.title}"... `);
      if (!item.resource_id || !item.proposed_meta?.seo_title || !item.proposed_meta?.seo_description) {
        console.error('skipped: missing resource_id or proposed_meta');
        continue;
      }
      if (refuseOnClaims(item, `pages/${item.slug}`, refused)) continue;
      try {
        await upsertMetafield('pages', item.resource_id, 'global', 'title_tag', item.proposed_meta.seo_title);
        await upsertMetafield('pages', item.resource_id, 'global', 'description_tag', item.proposed_meta.seo_description);

        item.status = 'published';
        item.published_at = new Date().toISOString();
        writeItem(item);
        console.log('published');
        pagePublished++;

        // Auto-create A/B test
        try {
          await createMetaTest({
            slug: item.slug,
            url: `${config.url}/pages/${item.slug}`,
            resourceType: 'page',
            resourceId: item.resource_id,
            originalTitle: item.proposed_meta.original_title,
            newTitle: item.proposed_meta.seo_title,
          });
        } catch (e) {
          console.warn(`  A/B test creation failed: ${e.message}`);
        }
      } catch (e) {
        console.error(`failed: ${e.message}`);
      }
    }
    console.log(`\n  Done — ${pagePublished}/${pageMetaItems.length} page meta rewrite(s) pushed to Shopify.`);
  }

  // Handle faq-expansion items
  const faqItems = listQueueItems().filter(
    (i) => i.trigger === 'faq-expansion' && i.status === 'approved',
  );

  if (faqItems.length > 0) {
    console.log(`\n  Found ${faqItems.length} approved faq-expansion item(s):\n`);
    let faqPublished = 0;
    for (const item of faqItems) {
      process.stdout.write(`  "${item.title}"... `);
      if (!item.resource_id || !item.proposed_html_path) {
        console.error('skipped: missing resource_id or proposed_html_path');
        continue;
      }
      let html;
      try {
        html = readFileSync(item.proposed_html_path, 'utf8');
      } catch (e) {
        console.error(`skipped: ${e.message}`);
        continue;
      }
      // The FAQ body is checked too, not just its meta — the answers are the
      // copy, and they are what an "is this safe for my eczema?" query gets.
      if (refuseOnClaims(item, `pages/${item.slug}`, refused, { 'faq body': html })) continue;
      try {
        await updatePage(item.resource_id, { body_html: html });

        if (item.proposed_meta?.seo_title) {
          await upsertMetafield('pages', item.resource_id, 'global', 'title_tag', item.proposed_meta.seo_title);
        }
        if (item.proposed_meta?.seo_description) {
          await upsertMetafield('pages', item.resource_id, 'global', 'description_tag', item.proposed_meta.seo_description);
        }

        item.status = 'published';
        item.published_at = new Date().toISOString();
        writeItem(item);
        console.log('published');
        faqPublished++;
      } catch (e) {
        console.error(`failed: ${e.message}`);
      }
    }
    console.log(`\n  Done — ${faqPublished}/${faqItems.length} FAQ expansion(s) pushed to Shopify.`);
  }

  // Handle product-title-rewrite items
  const titleItems = listQueueItems().filter(
    (i) => i.trigger === 'product-title-rewrite' && i.status === 'approved',
  );

  if (titleItems.length > 0) {
    console.log(`\n  Found ${titleItems.length} approved product-title-rewrite item(s):\n`);
    let titlePublished = 0;
    for (const item of titleItems) {
      process.stdout.write(`  "${item.proposed_title?.original_title}" → "${item.proposed_title?.new_title}"... `);
      if (!item.resource_id || !item.proposed_title?.new_title || !item.proposed_title?.handle) {
        console.error('skipped: missing resource_id, new_title, or handle');
        continue;
      }
      if (refuseOnClaims(item, `products/${item.slug}`, refused)) continue;
      try {
        await updateProduct(item.resource_id, {
          title: item.proposed_title.new_title,
          handle: item.proposed_title.handle,
        });

        item.status = 'published';
        item.published_at = new Date().toISOString();
        writeItem(item);
        console.log('published');
        titlePublished++;
      } catch (e) {
        console.error(`failed: ${e.message}`);
      }
    }
    console.log(`\n  Done — ${titlePublished}/${titleItems.length} product title rewrite(s) pushed to Shopify.`);
  }

  for (const line of renderGateRefusalLines(refused)) console.log(`  ${line}`);
  return { refused };
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
      if (skipHandles.has(page.handle)) return false;
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
  const gateSkipped = [];

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const overrideKeyword = keywordOverrides.get(candidate.handle);
    let keyword;
    let gscData;
    let keywordSource = 'gsc-top';
    if (overrideKeyword) {
      keyword = overrideKeyword;
      gscData = candidate.gscEntry || null;
      keywordSource = 'override';
    } else {
      const picked = await pickBestKeyword(candidate.url, candidate.title);
      keyword = picked.keyword;
      gscData = picked.gscData || candidate.gscEntry || null;
      keywordSource = picked.source;
    }
    if (overrideKeyword) {
      console.log(`    (keyword overridden: "${overrideKeyword}")`);
    } else if (keywordSource === 'gsc-filtered') {
      console.log(`    (keyword from filtered GSC long tail: "${keyword}")`);
    } else if (keywordSource.startsWith('dataforseo-volume')) {
      console.log(`    (keyword from DataForSEO ${keywordSource.replace('dataforseo-volume ', '')}: "${keyword}")`);
    } else if (keywordSource === 'title-fallback') {
      console.log(`    (no GSC or DataForSEO match; fell back to title: "${keyword}")`);
    }

    process.stdout.write(`  [${i + 1}/${candidates.length}] "${candidate.title}"... `);

    try {
      // This is the only mode that writes a live BODY on --apply, with no queue
      // and no human in between, so the gate covers body_html as well as the two
      // SEO fields. Measured against the current live copy on 2026-08-24: 1 of
      // 19 product bodies and 32 of 82 collection bodies carry blocking-tier
      // language today, so the retry earns its keep here.
      const gated = await gateGeneratedCopy(
        (constraint) => (candidate.type === 'product'
          ? rewriteProduct(candidate.raw, keyword, gscData, constraint)
          : rewriteCollection(candidate.raw, keyword, gscData, constraint)),
        {
          extract: (p) => ({ title: p?.seo_title, meta: p?.seo_description, body: p?.body_html }),
          required: ['title', 'body'],
        },
      );
      if (!gated.ok) {
        if (recordGateSkip(gateSkipped, { label: candidate.title, pageUrl: candidate.url, gated }, limit)) break;
        continue;
      }
      const proposed = gated.proposed;
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

  // The report IS the digest body, so a skip that is not written here reaches
  // nobody. A skip is the gate working — it is never `status: 'error'`.
  const skipLines = renderGateSkipLines(gateSkipped);
  if (skipLines.length) {
    lines.push('## Health-claim gate — skipped');
    lines.push('');
    lines.push(skipLines[0]);
    lines.push('');
    for (const s of gateSkipped) {
      lines.push(`- **${s.label}** (${s.pageUrl}) — ${[...new Set(s.violations.map((v) => `${v.field}: "${v.match}"`))].join(', ')}`);
    }
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
  if (gateSkipped.length) console.log(`  Health-claim gate: ${gateSkipped.length} candidate(s) skipped (page unchanged)`);
  if (!apply && results.length > 0) {
    console.log('  Run with --apply to push changes to Shopify');
  }
  return { gateSkipped };
}

const run = pagesFromGsc ? pagesFromGscMode
  : expandFaq ? expandFaqMode
  : optimizeTitles ? optimizeTitlesMode
  : fromGsc ? fromGscMode
  : publishApproved ? publishApprovedProducts
  : main;

/**
 * Gate skips and refusals must reach the 5 AM digest. Four of the six modes
 * write no markdown report at all, so `notifyLatestReport` would say "no report
 * generated this run" and the skip would live only in a cron log nobody reads.
 * DEFERRED, never `immediate: true`, and `status: 'success'` — the gate
 * refusing a claim is the policy working, not a failure.
 */
async function notifyGateOutcome(outcome) {
  const lines = [
    ...renderGateSkipLines(outcome?.gateSkipped || []),
    ...renderGateRefusalLines(outcome?.refused || []),
  ];
  if (!lines.length) return;
  const n = (outcome?.gateSkipped?.length || 0) + (outcome?.refused?.length || 0);
  await notify({
    subject: `Product Optimizer: ${n} health-claim gate ${n === 1 ? 'block' : 'blocks'}`,
    body: lines.join('\n'),
    status: 'success',
    category: 'pipeline',
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run()
    .then(async (outcome) => {
      await notifyGateOutcome(outcome);
      return notifyLatestReport(
        `Product Optimizer completed${gateSkipSummaryFragment([
          ...(outcome?.gateSkipped || []), ...(outcome?.refused || []),
        ])}`,
        join(ROOT, 'data', 'reports', 'product-optimizer'),
      );
    })
    .catch((err) => {
      notify({ subject: 'Product Optimizer failed', body: err.message || String(err), status: 'error' });
      console.error('Error:', err.message);
      process.exit(1);
    });
}
