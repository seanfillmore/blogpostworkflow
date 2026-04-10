#!/usr/bin/env node
/**
 * Collection Content Optimizer Agent
 *
 * Generates SEO-optimized descriptions (300-500 words) for collection pages
 * that have high GSC impressions but poor ranking/CTR, typically because
 * they only have a title and product grid with no body content.
 *
 * Uses GSC data to target the actual queries users search, the topical map
 * for internal links to related blog posts, and ingredients config for
 * product accuracy.
 *
 * All changes queue through data/performance-queue/ for human approval.
 *
 * Usage:
 *   node agents/collection-content-optimizer/index.js                           # dry run
 *   node agents/collection-content-optimizer/index.js --queue                   # write to queue
 *   node agents/collection-content-optimizer/index.js --limit 3                 # top 3 only
 *   node agents/collection-content-optimizer/index.js --handle "vegan-body-lotion"  # single collection
 *   node agents/collection-content-optimizer/index.js --publish-approved        # push approved to Shopify
 *   node agents/collection-content-optimizer/index.js --dry-run                 # alias for default
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getCustomCollections,
  getSmartCollections,
  updateCustomCollection,
  updateSmartCollection,
  upsertMetafield,
} from '../../lib/shopify.js';
import * as gsc from '../../lib/gsc.js';
import { writeItem, activeSlugs, listQueueItems } from '../performance-engine/lib/queue.js';
import { notify, notifyLatestReport } from '../../lib/notify.js';
import { createMetaTest } from '../../lib/meta-test.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CONTENT_DIR = join(ROOT, 'data', 'collection-content');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'collection-content-optimizer');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

// -- env ----------------------------------------------------------------------

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

// -- args ---------------------------------------------------------------------

const args = process.argv.slice(2);

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

const doQueue = args.includes('--queue');
const publishApproved = args.includes('--publish-approved');
const limit = parseInt(getArg('--limit') ?? '5', 10);
const singleHandle = getArg('--handle');

// -- exclusions ---------------------------------------------------------------

const EXCLUDED_HANDLES = new Set([
  'main-menu-3',
  'home-page-collection',
  'reelup-do-not-delete',
  'bundle-builder-products',
  'live-collection',
  'on-sale',
  'all-products',
  'popular',
  'best-sellers',
  'for-shopify-performance-tracking',
]);

const EXCLUDED_TITLE_PATTERNS = [
  'do not delete',
  'do not modify',
  'shopify performance',
  'faire',
];

// -- helpers ------------------------------------------------------------------

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

function loadTopicalMap() {
  const path = join(ROOT, 'data', 'topical-map.json');
  if (!existsSync(path)) return { clusters: [] };
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return { clusters: [] }; }
}

function loadIngredients() {
  const path = join(ROOT, 'config', 'ingredients.json');
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return {}; }
}

function findRelatedBlogPosts(topicalMap, collectionHandle) {
  const searchTerms = collectionHandle.replace(/-/g, ' ').toLowerCase().split(' ')
    .filter((w) => w.length > 3);
  const results = [];
  for (const cluster of topicalMap.clusters || []) {
    for (const article of cluster.articles || []) {
      const titleLower = article.title.toLowerCase();
      if (searchTerms.some((t) => titleLower.includes(t))) {
        results.push({ url: article.url, title: article.title, cluster: cluster.tag });
      }
    }
  }
  return results.slice(0, 5);
}

function findRelevantIngredients(ingredientsConfig, collectionHandle) {
  const handleTerms = collectionHandle.replace(/-/g, ' ').toLowerCase();
  const matches = [];
  for (const [key, product] of Object.entries(ingredientsConfig)) {
    const nameMatch = product.name.toLowerCase().split(' ').some((w) => handleTerms.includes(w));
    const keyMatch = handleTerms.includes(key);
    if (nameMatch || keyMatch) {
      matches.push({ product: product.name, base_ingredients: product.base_ingredients || [] });
    }
  }
  return matches;
}

// -- candidate selection (shared with tests) ----------------------------------

function selectCollectionCandidates(collections, gscResults, activeQueueSlugs, candidateLimit = 5) {
  return collections
    .map((c) => {
      const gscEntry = gscResults.get(c.url);
      if (!gscEntry) return null;
      if (gscEntry.impressions < 500) return null;
      if (gscEntry.position <= 10 && gscEntry.ctr >= 0.005) return null; // already performing well
      if (activeQueueSlugs.has(c.handle)) return null;
      return { ...c, gsc: gscEntry };
    })
    .filter(Boolean)
    .sort((a, b) => b.gsc.impressions - a.gsc.impressions)
    .slice(0, candidateLimit);
}

// -- claude content generator -------------------------------------------------

async function generateCollectionContent(collection, topQueries, gscData, relatedPosts, ingredients) {
  const currentDesc = stripHtml(collection.body_html).slice(0, 2000);
  const currentWords = wordCount(collection.body_html);

  const queriesFormatted = topQueries.slice(0, 10)
    .map((q) => `"${q.keyword}" - ${q.impressions} impr, pos #${Math.round(q.position)}, ${(q.ctr * 100).toFixed(1)}%`)
    .join('\n');

  const relatedPostsFormatted = relatedPosts.length > 0
    ? relatedPosts.map((p) => `- [${p.title}](${p.url})`).join('\n')
    : '(none found)';

  const ingredientsFormatted = ingredients.length > 0
    ? ingredients.map((i) => `- ${i.product}: ${i.base_ingredients.join(', ')}`).join('\n')
    : '(none matched)';

  const gscNote = gscData?.impressions > 0
    ? `This collection page currently ranks around position #${Math.round(gscData.position)} for its top queries with ${gscData.impressions} impressions/90 days and ${(gscData.ctr * 100).toFixed(2)}% CTR.`
    : `No GSC data yet for this page.`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are an SEO copywriter for ${config.name} (${config.url}), a natural skincare and personal care brand.

COLLECTION PAGE: ${collection.title}
HANDLE: ${collection.handle}
CURRENT DESCRIPTION (${currentWords} words): ${currentDesc || '(none — just a title and product grid)'}
${gscNote}

TOP 10 SEARCH QUERIES (from Google Search Console):
${queriesFormatted}

RELATED BLOG POSTS (use for internal linking):
${relatedPostsFormatted}

RELEVANT INGREDIENTS:
${ingredientsFormatted}

Write a comprehensive collection page description that:
1. Opens with a compelling first paragraph that naturally includes the top search queries
2. Explains what this collection offers and who it's for
3. Highlights key differentiators of ${config.name}'s products in this category (natural ingredients, handmade, etc.)
4. Includes 2-3 internal links to the related blog posts listed above (use exact URLs)
5. Mentions specific ingredients when relevant to build topical authority
6. Ends with reassurance about product quality and natural ingredients
7. Is between 300-500 words total
8. Uses clean semantic HTML: <p>, <h2>, <h3>, <ul>/<li> tags
9. Matches ${config.name}'s voice: clean, expert, trustworthy, ingredient-focused
10. Passes AI detection — avoid patterns that trigger AI content flags:
    - Vary sentence length aggressively: mix short punchy sentences with longer ones
    - Lead with a specific concrete detail, NOT a generic opening statement
    - Cut all filler phrases: "designed with care", "made with intention", "more than just",
      "you deserve", "no compromise", "real results", "peace of mind", "feel confident"
    - Use brand-specific details: organic virgin coconut oil, handmade in small batches, specific scents
    - Avoid uniform sentence patterns like "Whether you..." or "If you're looking for..."
    - No exclamation marks in body copy

Also write:
- seo_title (50-60 chars, includes top keyword, format: "[Category] | ${config.name}")
- seo_description (140-155 chars, benefit-driven, includes top keyword)
- what_changed: 1-sentence summary of what was added
- why: 1-sentence explanation of why this should improve rankings
- projected_impact: 1-sentence estimate of expected improvement

Return ONLY a JSON object:
{
  "body_html": "<p>...</p>",
  "seo_title": "...",
  "seo_description": "...",
  "what_changed": "...",
  "why": "...",
  "projected_impact": "..."
}
No explanation, no markdown fences.`,
    }],
  });

  if (message.stop_reason === 'max_tokens') {
    throw new Error('Claude output truncated (max_tokens) — skipping');
  }

  const raw = message.content[0].text.trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
  const parsed = JSON.parse(raw);

  if (/href="[^"]*$/.test(parsed.body_html)) {
    throw new Error('Unclosed href detected — output likely truncated');
  }

  return parsed;
}

// -- publish approved ---------------------------------------------------------

async function publishApprovedCollections() {
  console.log(`\nCollection Content Optimizer — publishing approved content\n`);

  const items = listQueueItems().filter(
    (i) => i.trigger === 'collection-content' && i.status === 'approved',
  );

  if (items.length === 0) {
    console.log('  No approved collection-content items found.');
    return;
  }

  console.log(`  Found ${items.length} approved item(s) to publish:\n`);

  let published = 0;
  for (const item of items) {
    process.stdout.write(`  "${item.title}"... `);

    // Validate required fields
    if (!item.resource_id || !item.proposed_html_path || !item.collection_type) {
      console.error('skipped: missing resource_id, proposed_html_path, or collection_type');
      continue;
    }

    if (!existsSync(item.proposed_html_path)) {
      console.error(`skipped: HTML file not found at ${item.proposed_html_path}`);
      continue;
    }

    try {
      const html = readFileSync(item.proposed_html_path, 'utf8');
      const resourceType = item.collection_type === 'custom' ? 'custom_collections' : 'smart_collections';

      if (item.collection_type === 'custom') {
        await updateCustomCollection(item.resource_id, { body_html: html });
      } else {
        await updateSmartCollection(item.resource_id, { body_html: html });
      }

      // Upsert SEO meta fields
      if (item.proposed_meta?.seo_title) {
        await upsertMetafield(resourceType, item.resource_id, 'global', 'title_tag', item.proposed_meta.seo_title);
      }
      if (item.proposed_meta?.seo_description) {
        await upsertMetafield(resourceType, item.resource_id, 'global', 'description_tag', item.proposed_meta.seo_description);
      }

      item.status = 'published';
      item.published_at = new Date().toISOString();
      writeItem(item);
      console.log('published');
      published++;

      // Auto-create A/B test
      try {
        await createMetaTest({
          slug: item.slug,
          url: `${config.url}/collections/${item.slug}`,
          resourceType: 'collection',
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

  console.log(`\n  Done — ${published}/${items.length} collection content update(s) pushed to Shopify.`);
}

// -- main ---------------------------------------------------------------------

async function main() {
  console.log(`\nCollection Content Optimizer — ${config.name}`);
  console.log(`Mode: ${doQueue ? 'QUEUE (writing to performance-queue)' : 'DRY RUN (use --queue to write changes)'}`);
  console.log(`Limit: ${limit}${singleHandle ? ` | Handle: ${singleHandle}` : ''}\n`);

  // Fetch all collections (custom + smart)
  process.stdout.write('  Fetching collections... ');
  const [custom, smart] = await Promise.all([getCustomCollections(), getSmartCollections()]);

  const collections = [];
  for (const c of custom) {
    collections.push({
      id: c.id,
      title: c.title,
      handle: c.handle,
      body_html: c.body_html || '',
      url: `${config.url}/collections/${c.handle}`,
      collectionType: 'custom',
    });
  }
  for (const c of smart) {
    collections.push({
      id: c.id,
      title: c.title,
      handle: c.handle,
      body_html: c.body_html || '',
      url: `${config.url}/collections/${c.handle}`,
      collectionType: 'smart',
    });
  }
  console.log(`${collections.length} collections (${custom.length} custom, ${smart.length} smart)`);

  // Filter exclusions
  const filtered = collections.filter((c) => {
    if (EXCLUDED_HANDLES.has(c.handle)) return false;
    const titleLower = c.title.toLowerCase();
    if (EXCLUDED_TITLE_PATTERNS.some((pat) => titleLower.includes(pat))) return false;
    if (singleHandle && c.handle !== singleHandle) return false;
    return true;
  });

  // Fetch GSC performance for each collection URL
  process.stdout.write('  Fetching GSC page performance... ');
  const gscMap = new Map();
  for (const c of filtered) {
    try {
      const perf = await gsc.getPagePerformance(c.url, 90);
      if (perf) gscMap.set(c.url, perf);
    } catch {
      // Skip pages with no GSC data
    }
  }
  console.log(`${gscMap.size} pages with GSC data`);

  // Select candidates
  const active = activeSlugs();
  const candidates = selectCollectionCandidates(filtered, gscMap, active, limit);

  if (candidates.length === 0) {
    console.log('\n  No collection content optimization candidates found.');
    console.log('  (Requires >= 500 impressions AND position > 10 or CTR < 0.5%, not already in queue)');
    return;
  }

  console.log(`\n  Found ${candidates.length} candidate(s):\n`);
  for (const c of candidates) {
    const wc = wordCount(c.body_html);
    console.log(`  "${c.title}" — ${c.gsc.impressions} impr, pos #${Math.round(c.gsc.position)}, ${(c.gsc.ctr * 100).toFixed(2)}% CTR, ${wc} words`);
  }

  if (!doQueue) {
    console.log('\n  Dry run — no queue items written. Use --queue to generate content and queue for review.');
    return;
  }

  // Load supporting data
  const topicalMap = loadTopicalMap();
  const ingredientsConfig = loadIngredients();

  mkdirSync(CONTENT_DIR, { recursive: true });
  mkdirSync(REPORTS_DIR, { recursive: true });

  console.log('');

  let queued = 0;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    process.stdout.write(`  [${i + 1}/${candidates.length}] "${c.title}"... `);

    try {
      // Get top queries for this specific page
      const topQueries = await gsc.getPageKeywords(c.url, 10, 90);

      // Find related blog posts and ingredients
      const relatedPosts = findRelatedBlogPosts(topicalMap, c.handle, c.title);
      const ingredients = findRelevantIngredients(ingredientsConfig, c.handle);

      // Generate content via Claude
      const proposed = await generateCollectionContent(c, topQueries, c.gsc, relatedPosts, ingredients);
      const wc = wordCount(proposed.body_html);
      console.log(`done (${wc} words)`);

      // Save HTML to data/collection-content/
      const htmlPath = join(CONTENT_DIR, `${c.handle}.html`);
      writeFileSync(htmlPath, proposed.body_html);

      // Write queue item
      const item = {
        slug: c.handle,
        title: `${c.title} — Collection Content`,
        trigger: 'collection-content',
        signal_source: {
          type: 'gsc-collection-content',
          impressions: c.gsc.impressions,
          position: c.gsc.position,
          ctr: c.gsc.ctr,
          top_queries: topQueries.map((q) => q.keyword),
        },
        proposed_html_path: htmlPath,
        proposed_meta: {
          seo_title: proposed.seo_title,
          seo_description: proposed.seo_description,
          original_title: c.title,
          original_description: null,
        },
        backup_html: c.body_html || '',
        resource_type: 'collection',
        resource_id: c.id,
        collection_type: c.collectionType,
        summary: {
          what_changed: proposed.what_changed,
          why: proposed.why,
          projected_impact: proposed.projected_impact,
        },
        status: 'pending',
        created_at: new Date().toISOString(),
      };

      writeItem(item);
      queued++;
    } catch (e) {
      console.error(`failed: ${e.message}`);
    }
  }

  console.log(`\n  Done — ${queued}/${candidates.length} item(s) written to data/performance-queue/`);
}

// -- entry point --------------------------------------------------------------

const run = publishApproved ? publishApprovedCollections : main;

run()
  .then(() => notifyLatestReport('Collection Content Optimizer completed', REPORTS_DIR))
  .catch((err) => {
    notify({ subject: 'Collection Content Optimizer failed', body: err.message || String(err), status: 'error' });
    console.error('Error:', err.message);
    process.exit(1);
  });
