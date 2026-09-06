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
 * HEALTH-CLAIM GATE (lib/seo-copy-health-gate.js + lib/seo-copy-gate-loop.js):
 * the generated body is 450-650 words of marketing copy plus a 4-6 question FAQ
 * block — the largest regulated surface any SEO agent here writes. Measured
 * against the 10 bodies this agent has already produced, 5 trip the blocking
 * tier (eczema, rosacea, dermatitis, "treatment", "prevention") while 0 of their
 * titles or meta descriptions do, so the body is where this gate does its work.
 * Generation regenerates ONCE with the offending words named; --publish-approved
 * cannot regenerate, so it refuses the write and leaves the item in place.
 *
 * Usage:
 *   node agents/collection-content-optimizer/index.js                           # dry run
 *   node agents/collection-content-optimizer/index.js --queue                   # write to queue
 *   node agents/collection-content-optimizer/index.js --limit 3                 # top 3 only
 *   node agents/collection-content-optimizer/index.js --handle "vegan-body-lotion"  # single collection
 *   node agents/collection-content-optimizer/index.js --publish-approved        # push approved to Shopify
 *   node agents/collection-content-optimizer/index.js --dry-run                 # alias for default
 */

import Anthropic from '../../lib/anthropic.js';
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
import { loadIndex, entriesForCluster, loadCategoryCompetitors } from '../../lib/keyword-index/consumer.js';
import { clusterForCollection } from './lib/cluster-mapper.js';
import { validateCollectionSpec } from '../../lib/collection-validation.js';
import { buildCollectionPageSchema, buildBreadcrumb } from '../../lib/schema-builders.js';
import { assertHtmlComplete } from '../../lib/html-output-guards.js';
import { gateGeneratedCopy } from '../../lib/seo-copy-gate-loop.js';
import {
  SEO_COPY_COMPLIANCE_RULE, checkSeoCopyFields,
  renderGateSkipLines, renderGateRefusalLines, gateSkipSummaryFragment,
} from '../../lib/seo-copy-health-gate.js';

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

async function generateCollectionContent(collection, topQueries, gscData, relatedPosts, ingredients, indexGround, constraint = '') {
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

  const clusterMatesBlock = indexGround?.clusterMates?.length
    ? `\nCLUSTER-MATE QUERIES (other terms this collection should surface for):\n${indexGround.clusterMates.map((m) => `- ${m.keyword}`).join('\n')}\n`
    : '';

  const competitorsBlock = indexGround?.competitors?.length
    ? `\nCOMPETITORS DOMINATING THIS CLUSTER:\n${indexGround.competitors.map((c) => `- ${c.domain}${c.avg_position != null ? ` (avg position ${c.avg_position})` : ''}`).join('\n')}\n`
    : '';

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
${clusterMatesBlock}${competitorsBlock}
Write a comprehensive collection page description that:
1. Opens with a compelling first paragraph that directly answers what users searching the top query are looking for — lead with a specific concrete detail, NOT a generic brand statement
2. Includes a short BUYING GUIDE section (h2: "How to Choose…" or "What to Look For") — 2-3 brief paragraphs covering decision factors: skin type, key ingredient tradeoffs, format (stick/roll-on/cream/etc.), when to use
3. Highlights key differentiators of ${config.name}'s products in this collection (natural ingredients, handmade in small batches, specific hero ingredients like organic virgin coconut oil, specific scents)
4. Includes 2-3 internal links to the related blog posts listed above (use exact URLs)
5. Mentions specific ingredients when relevant to build topical authority
6. Ends with a 4-6 question FAQ section formatted as pairs of <h2>Question?</h2><p>Answer.</p> — questions should reflect real queries shoppers type (e.g. "Does natural deodorant really work?", "How long does it take to work?", "Is it safe for sensitive skin?") — answers 2-4 sentences, conversational, ingredient-specific
7. Is between 450-650 words total
8. Uses clean semantic HTML: <p>, <h2>, <h3>, <ul>/<li> tags
9. Matches ${config.name}'s voice: clean, expert, trustworthy, ingredient-focused
10. Passes AI detection — avoid patterns that trigger AI content flags:
    - Vary sentence length aggressively: mix short punchy sentences with longer ones
    - Cut all filler phrases: "designed with care", "made with intention", "more than just",
      "you deserve", "no compromise", "real results", "peace of mind", "feel confident"
    - Use brand-specific details: organic virgin coconut oil, handmade in small batches, specific scents
    - Avoid uniform sentence patterns like "Whether you..." or "If you're looking for..."
    - No exclamation marks in body copy
    - Cluster-mate queries to surface for: ${clusterMatesBlock ? 'see CLUSTER-MATE QUERIES above' : 'n/a — weave in natural variants of the top query'}

Also write:
- seo_title (50-60 chars, includes top keyword, format: "[Category] | ${config.name}")
- seo_description (140-155 chars, benefit-driven, includes top keyword)
- what_changed: 1-sentence summary of what was added
- why: 1-sentence explanation of why this should improve rankings
- projected_impact: 1-sentence estimate of expected improvement

${SEO_COPY_COMPLIANCE_RULE}
${constraint ? `\n${constraint}\n` : ''}
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

  // Guard the body_html FIELD, not the raw response — the response is JSON, so
  // the block-tag check would be meaningless against the envelope. stop_reason
  // is already handled above (and a truncated envelope fails JSON.parse first),
  // so this adds the unclosed-href and mid-prose checks on the HTML that ships.
  assertHtmlComplete({ html: parsed.body_html });

  return parsed;
}

// -- schema helpers -----------------------------------------------------------

// `extractFaqPairs` used to live here — a byte-identical copy of
// collection-creator's — and fed a `FAQPage` node. Both went on 2026-08-24:
// Google REMOVED the FAQ rich result from Search
// (`developers.google.com/search/docs/appearance/structured-data/faqpage` 301s
// to `/search/updates#removing-faq-rich-result`; `.../how-to` 301s to its own
// deprecation note; `.../article` still returns 200, so the 301s are the
// features being retired and not a docs reshuffle). The heuristic had exactly
// one caller and is deleted rather than left dead.

function stripExistingSchemas(html) {
  return (html || '').replace(/<script\s+type="application\/ld\+json"[\s\S]*?<\/script>/gi, '').trimStart();
}

/**
 * TWO NODES, AND NEITHER IS A DUPLICATE (measured live 2026-08-24).
 * All 5 published collection pages were fetched and their JSON-LD parsed: the
 * theme publishes `Organization` on a collection and nothing else — no
 * CollectionPage, no BreadcrumbList. That is what makes this different from the
 * blog change, where the injector's `Article` was a second copy of the theme's.
 * These two are the only copies there are, so they stay.
 *
 * It no longer takes the body: the only thing it read the prose for was the
 * retired FAQ node, and a builder that cannot see the body cannot grow a
 * body-conditional type back by accident — the same reasoning as
 * `buildPostSchemas` in lib/schema-builders.js.
 */
function buildSchemaBlock(collection, gen) {
  const collUrl = `${config.url}/collections/${collection.handle}`;
  const schemas = [
    buildCollectionPageSchema({ name: collection.title, description: gen.seo_description, url: collUrl }),
    buildBreadcrumb([
      { name: 'Home', url: config.url },
      { name: 'Collections', url: `${config.url}/collections` },
      { name: collection.title, url: collUrl },
    ]),
  ];
  return schemas.map((s) => `<script type="application/ld+json">\n${JSON.stringify(s)}\n</script>`).join('\n');
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
  const refused = [];
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
      const rawHtml = readFileSync(item.proposed_html_path, 'utf8');

      // ── health-claim gate, no retry available ─────────────────────────────
      // This drain runs daily from scheduler.js step 4b and publishes copy an
      // earlier `--queue` run generated — possibly before the gate above
      // existed. There is no prompt here, so a blocking hit REFUSES the write
      // and stops. The item keeps its `approved` status and its HTML: it is not
      // dismissed and not deleted, because a gate may decide copy cannot ship
      // and may not decide the work is worthless (see data/briefs/_dropped/ for
      // what the other answer cost). Re-running `--queue` regenerates it under
      // the gate; the check itself is regexes, so re-checking daily is free.
      const compliance = checkSeoCopyFields({
        title: item.proposed_meta?.seo_title,
        meta: item.proposed_meta?.seo_description,
        body: rawHtml,
      });
      if (!compliance.ok) {
        const words = [...new Set(compliance.blocking.map((v) => `${v.field}: "${v.match}"`))].join(', ');
        console.error(`REFUSED (health-claim gate): ${words}`);
        item.health_gate = {
          refused_at: new Date().toISOString(),
          refused_by: 'collection-content-optimizer --publish-approved',
          violations: compliance.blocking,
        };
        writeItem(item); // still `approved` — refused, not dismissed
        refused.push({ label: item.title, resource: `collections/${item.slug}`, violations: compliance.blocking });
        continue;
      }
      if (item.health_gate) { delete item.health_gate; } // cleared by a compliant regeneration

      const resourceType = item.collection_type === 'custom' ? 'custom_collections' : 'smart_collections';

      // Strip any previously-embedded schema blocks to avoid duplication on re-runs,
      // then prepend fresh schema (CollectionPage + BreadcrumbList).
      //
      // THE STRIP IS ALSO THE ATTRITION MECHANISM. It is type-agnostic — every
      // ld+json block goes, whatever it holds — so a collection that passes
      // through here again sheds any retired FAQPage its body carried, as a side
      // effect of work already happening on it. That is what lets "stop emitting,
      // do not sweep the corpus" be a drain rather than a permanent residue.
      const strippedHtml = stripExistingSchemas(rawHtml);
      const collectionForSchema = {
        title: item.proposed_meta?.original_title || item.title,
        handle: item.slug,
      };
      const genForSchema = { seo_description: item.proposed_meta?.seo_description || '' };
      const schemaBlock = buildSchemaBlock(collectionForSchema, genForSchema);
      const html = schemaBlock + '\n' + strippedHtml;

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
  for (const line of renderGateRefusalLines(refused)) console.log(`  ${line}`);
  return { refused };
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
  const rawCandidates = selectCollectionCandidates(filtered, gscMap, active, limit * 3);

  const idx = loadIndex(ROOT);
  const competitors = loadCategoryCompetitors(ROOT);

  const ranked = rawCandidates.map((c) => {
    const cluster = clusterForCollection(c, idx);
    const clusterEntries = cluster ? entriesForCluster(idx, cluster, { limit: 8 }) : [];
    const isAmazonValidated = clusterEntries.some((e) => e.validation_source === 'amazon');
    return { ...c, cluster, clusterEntries, isAmazonValidated };
  }).sort((a, b) => {
    const av = a.isAmazonValidated ? 0 : 1;
    const bv = b.isAmazonValidated ? 0 : 1;
    if (av !== bv) return av - bv;
    return b.gsc.impressions - a.gsc.impressions;
  });

  const candidates = ranked.slice(0, limit);
  if (idx) {
    const validated = candidates.filter((c) => c.isAmazonValidated).length;
    console.log(`  ${validated} of ${candidates.length} candidates map to an Amazon-validated cluster`);
  }

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
  const gateSkipped = [];
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
      const indexGround = c.cluster ? {
        clusterMates: c.clusterEntries.filter((e) => e.keyword),
        competitors: (competitors[c.cluster] || []).slice(0, 3),
      } : null;
      // ── health-claim gate ──────────────────────────────────────────────
      // A collection body is 450-650 words of marketing copy on a commercial
      // page, plus a 4-6 question FAQ block — by some distance the largest
      // regulated surface any of these agents writes, and the one most likely
      // to answer "is this good for eczema?" in the product's own voice.
      // Measured against the 10 bodies this agent has already generated, 5 trip
      // the blocking tier (eczema, rosacea, dermatitis, "treatment",
      // "prevention"), so the retry here is load-bearing, not decorative.
      // SEO_COPY_COMPLIANCE_RULE is already in the first prompt for that reason.
      const gated = await gateGeneratedCopy(
        (constraint) => generateCollectionContent(c, topQueries, c.gsc, relatedPosts, ingredients, indexGround, constraint),
        {
          extract: (p) => ({ title: p?.seo_title, meta: p?.seo_description, body: p?.body_html }),
          required: ['title', 'body'],
          // `meta` is the SERP snippet; the truncation check rides inside the
          // existing two-attempt budget (lib/seo-copy-length.js). `body` is a
          // 450-650 word collection description with no SERP limit, and `title`
          // is not declared because the theme appends a suffix to the rendered
          // <title> — a flat 60 here would certify titles that truncate.
          lengths: { meta: 'description' },
        },
      );

      if (!gated.ok) {
        const words = [...new Set(gated.violations.map((v) => `${v.field}: "${v.match}"`))].join(', ');
        console.log('gated');
        console.log(`  ⊘ health-claim gate: ${words} — skipped after ${gated.attempts} attempt(s), nothing queued`);
        gateSkipped.push({ label: c.title, pageUrl: c.url, violations: gated.violations, attempts: gated.attempts });
        // Not counted against the run's candidate budget — a gated collection
        // was not optimised — but bounded by its OWN equal budget, or a bad pool
        // becomes an unbounded walk at two 4k-token calls each.
        if (gateSkipped.length >= limit) {
          console.log(`\n  Health-claim gate: ${gateSkipped.length} skips — at the skip budget, stopping.`);
          break;
        }
        continue;
      }

      const proposed = gated.proposed;
      const wc = wordCount(proposed.body_html);
      console.log(gated.attempts > 1 ? `done (${wc} words, regenerated once — health-claim gate)` : `done (${wc} words)`);
      if (gated.advisory.length) {
        const words = [...new Set(gated.advisory.map((v) => `${v.field}: "${v.match}"`))].join(', ');
        console.log(`    · advisory (not blocked): ${words}`);
      }

      // Validate generated content — hard block on thin/invalid output
      const vSpec = {
        title: c.title,
        handle: c.handle,
        seo_title: proposed.seo_title,
        meta_description: proposed.seo_description,
        body_html: proposed.body_html,
      };
      const v = validateCollectionSpec(vSpec, { existingHandles: new Set() });
      if (!v.ok) {
        console.warn(`  [SKIP] invalid content for "${c.title}": ${v.errors.join('; ')}`);
        continue;
      }

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
        cluster: c.cluster ?? null,
        validation_source: c.isAmazonValidated ? 'amazon' : null,
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
  for (const line of renderGateSkipLines(gateSkipped)) console.log(`  ${line}`);
  return { gateSkipped };
}

// -- entry point --------------------------------------------------------------

const run = publishApproved ? publishApprovedCollections : main;

/**
 * A gate skip or refusal has to reach the 5 AM digest, and this agent writes no
 * markdown report — `notifyLatestReport` would say "no report generated this
 * run" and the skip would exist only in a cron log nobody reads. So an extra
 * DEFERRED notification is sent, and only when there is something to say.
 * Never `immediate: true`, and never `status: 'error'`: the gate refusing a
 * claim is the policy working, not a failure.
 */
async function notifyGateOutcome(outcome) {
  const lines = [
    ...renderGateSkipLines(outcome?.gateSkipped || []),
    ...renderGateRefusalLines(outcome?.refused || []),
  ];
  if (!lines.length) return;
  const n = (outcome?.gateSkipped?.length || 0) + (outcome?.refused?.length || 0);
  await notify({
    subject: `Collection Content Optimizer: ${n} health-claim gate ${n === 1 ? 'block' : 'blocks'}`,
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
        `Collection Content Optimizer completed${gateSkipSummaryFragment([
          ...(outcome?.gateSkipped || []), ...(outcome?.refused || []),
        ])}`,
        REPORTS_DIR,
      );
    })
    .catch((err) => {
      notify({ subject: 'Collection Content Optimizer failed', body: err.message || String(err), status: 'error' });
      console.error('Error:', err.message);
      process.exit(1);
    });
}
