/**
 * Collection Creator Agent
 *
 * Identifies keyword opportunities where a dedicated Shopify collection page
 * would rank better than a blog post or no existing page. Generates SEO-optimized
 * collection content and creates the collection in Shopify.
 *
 * Opportunity signals:
 *   - GSC keywords ranking positions 5–50 where the ranking URL is a blog post
 *     but the keyword has clear commercial/transactional intent
 *   - High-volume keywords with collection-type intent that the site doesn't
 *     currently have a collection page for
 *   - Competitor SERP analysis showing collection/category pages outranking blog posts
 *
 * Works in tandem with the blog post pipeline:
 *   - After creating a collection, runs collection-linker to add blog → collection links
 *   - Blog posts that target keywords related to a collection will link back to it
 *
 * Output: data/reports/collection-creator/YYYY-MM.md
 *
 * Usage:
 *   node agents/collection-creator/index.js                          # dry-run: show opportunities
 *   node agents/collection-creator/index.js --apply                  # create collections in Shopify
 *   node agents/collection-creator/index.js --limit 3                # max collections to create
 *   node agents/collection-creator/index.js --min-volume 200         # min monthly search volume
 *   node agents/collection-creator/index.js --gsc-days 90            # GSC lookback window (default 90)
 *   node agents/collection-creator/index.js --from-opportunities     # dry-run from GSC opportunity report
 *   node agents/collection-creator/index.js --from-opportunities --queue  # evaluate & queue for approval
 *   node agents/collection-creator/index.js --publish-approved       # publish approved queue items to Shopify
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  getCustomCollections,
  getSmartCollections,
  createCustomCollection,
  upsertMetafield,
} from '../../lib/shopify.js';
import * as gsc from '../../lib/gsc.js';
import { withRetry } from '../../lib/retry.js';
import { notify, notifyLatestReport } from '../../lib/notify.js';
import { writeItem, activeSlugs, listQueueItems } from '../performance-engine/lib/queue.js';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'collection-creator');
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

const apply     = args.includes('--apply');
const limit     = parseInt(getArg('--limit') ?? '5', 10);
const minVolume = parseInt(getArg('--min-volume') ?? '100', 10);
const gscDays   = parseInt(getArg('--gsc-days') ?? '90', 10);
const fromOpportunities = args.includes('--from-opportunities');
const doQueue           = args.includes('--queue');
const publishApproved   = args.includes('--publish-approved');

// ── Ahrefs ────────────────────────────────────────────────────────────────────

async function ahrefsGet(endpoint, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://api.ahrefs.com/v3${endpoint}?${qs}`, {
    headers: { Authorization: `Bearer ${env.AHREFS_API_KEY}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ahrefs ${endpoint} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function getKeywordMetrics(keyword) {
  try {
    const data = await ahrefsGet('/keywords-explorer/overview', {
      keywords: keyword,
      country: 'us',
      select: 'volume,kd,traffic_potential,cpc',
    });
    const kw = data.keywords?.[0];
    if (!kw) return null;
    return {
      volume: kw.volume ?? 0,
      kd: kw.kd ?? 0,
      trafficPotential: kw.traffic_potential ?? 0,
      cpc: kw.cpc ?? 0,
    };
  } catch {
    return null;
  }
}

async function getSerpOverview(keyword) {
  try {
    const data = await ahrefsGet('/serp-overview', {
      keyword,
      country: 'us',
      top_positions: 10,
      select: 'position,url,title,page_type',
    });
    return data.positions ?? [];
  } catch {
    return [];
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function wordCount(text) {
  return stripHtml(text).split(/\s+/).filter(Boolean).length;
}

/** Returns true if a keyword has commercial/transactional intent for a collection page */
function hasCollectionIntent(keyword) {
  const kw = keyword.toLowerCase();
  // Navigational/transactional patterns suggesting a product listing
  const transactionalPatterns = [
    /^best\b/,
    /^top\b/,
    /^(buy|shop)\b/,
    /\b(for (men|women|kids|babies|sensitive skin|dry skin|oily skin))\b/,
    /\b(products?|brands?|types?|kinds?|options?|picks?)\b/,
    /^natural\s+\w+$/, // "natural deodorant", "natural lotion"
    /^organic\s+\w+$/, // "organic toothpaste"
    /^fluoride.free\b/,
    /^sls.free\b/,
    /^aluminum.free\b/,
    /^clean\s+\w+$/, // "clean beauty", "clean lotion"
    /\b(lotion|deodorant|toothpaste|lip balm|soap|serum|moisturizer|sunscreen)\b/,
  ];
  return transactionalPatterns.some((p) => p.test(kw));
}

/** Strip site domain from a URL to get the path */
function getPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** True if a URL path is a blog post */
function isBlogPost(path) {
  return path.startsWith('/blogs/');
}

/** True if a URL path is already a collection */
function isCollection(path) {
  return path.startsWith('/collections/');
}

// ── opportunity discovery ─────────────────────────────────────────────────────

/**
 * Get all keywords the site ranks for in GSC positions 5–50
 * where the ranking URL is a blog post (not a collection).
 */
async function getBlogRankingCommercialKeywords(days = 90) {
  console.log(`  Fetching GSC keywords (positions 5–50, last ${days} days)...`);
  const rows = await withRetry(() => gsc.getAllQueryPageRows(2000, days), { label: 'GSC rows' });

  // Group by query, take best position per query
  const byQuery = new Map();
  for (const row of rows) {
    const pos = row.position;
    if (pos < 5 || pos > 50) continue;
    const existing = byQuery.get(row.query);
    if (!existing || pos < existing.position) {
      byQuery.set(row.query, { query: row.query, position: pos, url: row.page, clicks: row.clicks, impressions: row.impressions });
    }
  }

  // Keep only blog-post URLs with commercial intent
  const candidates = [];
  for (const item of byQuery.values()) {
    const path = getPath(item.url);
    if (!isBlogPost(path)) continue;
    if (!hasCollectionIntent(item.query)) continue;
    if (item.impressions < 10) continue; // ignore noise
    candidates.push(item);
  }

  return candidates.sort((a, b) => b.impressions - a.impressions);
}

/**
 * Get all existing collections (custom + smart) indexed by handle.
 */
async function getExistingCollections() {
  console.log('  Fetching existing Shopify collections...');
  const [custom, smart] = await Promise.all([
    getCustomCollections(),
    getSmartCollections(),
  ]);
  const all = [...custom, ...smart];
  const byHandle = new Map(all.map((c) => [c.handle, c]));
  const byTitle  = new Map(all.map((c) => [c.title.toLowerCase(), c]));
  return { all, byHandle, byTitle };
}

/**
 * Score an opportunity: higher = more valuable
 * Uses impressions (GSC) as proxy for volume since we may not always have Ahrefs data.
 */
function scoreOpportunity(item, metrics) {
  const vol = metrics?.volume ?? item.impressions;
  const kd  = metrics?.kd ?? 10; // assume moderate difficulty
  // Prefer high volume, low KD, higher position gap (further from page 1)
  return (vol / (kd + 1)) * (item.position / 10);
}

// ── Claude: evaluate and generate ────────────────────────────────────────────

async function evaluateAndPlanCollections(opportunities, collections) {
  const existingHandles = [...collections.byHandle.keys()].join(', ');
  const existingTitles  = [...collections.all.map((c) => c.title)].join(', ');

  const prompt = `You are an SEO strategist for ${config.name} (${config.url}), a clean beauty and natural skincare ecommerce store.

I have identified keywords where the site ranks with blog posts but the keyword intent suggests a collection (product listing) page would perform better. Your job is to:
1. Evaluate each candidate keyword
2. Decide whether a new collection page is warranted
3. For approved keywords, generate the collection content

**Existing collections (do not duplicate):**
${existingTitles}

**Candidates (ranked by opportunity score):**
${opportunities.map((o, i) => `${i + 1}. "${o.query}" — position ${o.position.toFixed(1)}, ${o.impressions} impressions${o.metrics ? `, vol ${o.metrics.volume}, KD ${o.metrics.kd}` : ''}`).join('\n')}

**Selection criteria — only recommend a new collection if ALL of these are true:**
- The keyword clearly maps to a product category the store sells (deodorant, toothpaste, lotion, lip balm, bar soap, etc.)
- No existing collection already covers this keyword
- A product listing page (PLP) is a better SERP match than a blog post for this keyword
- The opportunity represents meaningful search volume (>100/mo estimated)

**For each keyword you approve, generate a JSON object:**
{
  "keyword": "...",
  "rationale": "...",          // 1–2 sentences on why a collection makes sense
  "title": "...",              // Collection title shown in Shopify (e.g. "Natural Deodorant")
  "handle": "...",             // URL slug (e.g. "natural-deodorant") — must not match existing handles
  "seo_title": "...",          // <60 chars, includes keyword
  "meta_description": "...",   // 120–160 chars, compelling, includes keyword
  "body_html": "..."           // 150–300 words of SEO-optimized collection description in clean HTML
                               // Use <p>, <h2>, <ul> tags. Include the keyword naturally 2–3 times.
                               // Write for the shopper, not search engines. No fluff.
                               //
                               // ANTI-AI-DETECTION RULES (mandatory — AI-flagged content hurts SEO):
                               // - Vary sentence length aggressively: mix short punchy sentences with longer ones
                               // - Lead with a specific concrete detail, NOT a generic statement about the product
                               // - Cut all filler phrases: "designed with care", "made with intention", "more than just",
                               //   "you deserve", "no compromise", "real results", "peace of mind", "feel confident"
                               // - Use brand-specific details: organic virgin coconut oil, handmade in small batches, specific scents
                               // - Avoid uniform sentence patterns like "Whether you..." or "If you're looking for..."
                               // - Write as a knowledgeable person would speak, not a content template
}

Respond ONLY with a valid JSON array of approved collections (may be empty [] if none qualify).
No markdown fences, no explanation outside the JSON.`;

  const message = await withRetry(
    () => client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    }),
    { label: 'Claude collection planner' }
  );

  const raw = message.content[0].text.trim();
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('Claude returned invalid JSON:', raw.slice(0, 500));
    throw new Error(`JSON parse failed: ${e.message}`);
  }
}

// ── create collection ─────────────────────────────────────────────────────────

async function createCollection(spec, collections, dryRun = true) {
  const handle = spec.handle || slugify(spec.title);

  // Safety: check for duplicate handle
  if (collections.byHandle.has(handle)) {
    console.log(`  ⚠️  Handle "${handle}" already exists — skipping`);
    return null;
  }

  if (dryRun) {
    console.log(`  [DRY RUN] Would create collection: "${spec.title}" (/${handle})`);
    return { id: null, title: spec.title, handle, dryRun: true };
  }

  console.log(`  Creating collection: "${spec.title}" (/${handle})...`);
  const collection = await withRetry(
    () => createCustomCollection({
      title: spec.title,
      handle,
      body_html: spec.body_html,
      published: true,
    }),
    { label: `create collection ${handle}` }
  );

  // Set SEO metafields
  if (spec.seo_title) {
    await upsertMetafield('custom_collections', collection.id, 'global', 'title_tag', spec.seo_title);
  }
  if (spec.meta_description) {
    await upsertMetafield('custom_collections', collection.id, 'global', 'description_tag', spec.meta_description);
  }

  console.log(`  ✓ Created: ${config.url}/collections/${handle} (id: ${collection.id})`);
  return collection;
}

// ── report ────────────────────────────────────────────────────────────────────

function buildReport(opportunities, approved, created, runDate) {
  const lines = [
    `# Collection Creator Report — ${runDate}`,
    '',
    `**Site:** ${config.url}`,
    `**Mode:** ${apply ? 'APPLY (live changes)' : 'Dry Run'}`,
    `**Candidates evaluated:** ${opportunities.length}`,
    `**Collections approved:** ${approved.length}`,
    `**Collections created:** ${created.filter(Boolean).length}`,
    '',
    '---',
    '',
    '## Approved Collections',
    '',
  ];

  if (approved.length === 0) {
    lines.push('_No collection opportunities met the criteria this month._', '');
  } else {
    for (const spec of approved) {
      const result = created.find((c) => c?.handle === spec.handle);
      const status = result?.dryRun ? '🔵 Dry Run' : result ? '✅ Created' : '⚠️ Skipped';
      lines.push(
        `### ${spec.title}`,
        '',
        `**Status:** ${status}`,
        `**Handle:** \`/collections/${spec.handle}\``,
        `**Keyword:** ${spec.keyword}`,
        `**Rationale:** ${spec.rationale}`,
        '',
        `**SEO Title:** ${spec.seo_title}`,
        `**Meta Description:** ${spec.meta_description}`,
        '',
        '**Body HTML Preview:**',
        '```html',
        spec.body_html,
        '```',
        '',
        '---',
        '',
      );
    }
  }

  lines.push('## Candidate Keywords Evaluated', '');
  lines.push('| Keyword | Position | Impressions | Volume | KD | Decision |');
  lines.push('|---------|----------|-------------|--------|-----|----------|');
  for (const opp of opportunities) {
    const approvedSpec = approved.find((a) => a.keyword === opp.query);
    const decision = approvedSpec ? '✅ Approved' : '❌ Skipped';
    const vol = opp.metrics?.volume ?? '—';
    const kd  = opp.metrics?.kd ?? '—';
    lines.push(`| ${opp.query} | ${opp.position.toFixed(1)} | ${opp.impressions} | ${vol} | ${kd} | ${decision} |`);
  }

  lines.push('', '---', '');
  if (apply && created.filter(Boolean).length > 0) {
    lines.push(
      '## Next Steps',
      '',
      '1. Run `collection-linker` to add blog → collection links for each new collection',
      '2. Add products to new collections in Shopify admin',
      '3. Verify collection pages render correctly on the storefront',
      '',
    );
  }

  return lines.join('\n');
}

// ── from-opportunities mode ──────────────────────────────────────────────────

/**
 * --from-opportunities mode:
 * Reads GSC opportunity report, filters to collection-intent keywords,
 * excludes existing collections & active queue items, then either
 * shows candidates (dry run) or queues them for approval.
 */
async function fromOpportunitiesMode() {
  const runDate = new Date().toISOString().slice(0, 10);
  console.log(`\n=== Collection Creator (from-opportunities) — ${runDate} ===\n`);

  // 1. Read the GSC opportunity report
  const oppPath = join(ROOT, 'data', 'reports', 'gsc-opportunity', 'latest.json');
  if (!existsSync(oppPath)) {
    console.error(`Missing opportunity report: ${oppPath}`);
    console.error('Run the GSC opportunity agent first.');
    process.exit(1);
  }
  const oppData = JSON.parse(readFileSync(oppPath, 'utf8'));

  // 2. Flatten all sections, tagging each with _section
  const allOpps = [];
  for (const section of ['low_ctr', 'page_2', 'unmapped']) {
    if (Array.isArray(oppData[section])) {
      for (const item of oppData[section]) {
        allOpps.push({ ...item, _section: section });
      }
    }
  }
  console.log(`  Loaded ${allOpps.length} total opportunities from latest.json`);

  // 3. Filter to commercial-intent keywords
  const commercial = allOpps.filter((o) => hasCollectionIntent(o.keyword));
  console.log(`  ${commercial.length} have collection intent`);

  // 4. Fetch existing collections from Shopify
  const collections = await getExistingCollections();
  const existingHandles = [...collections.byHandle.keys()];
  console.log(`  ${existingHandles.length} existing collection handles`);

  // 5. Filter out keywords matching existing collection handles (exact or partial)
  const noExisting = commercial.filter((o) => {
    const potentialHandle = slugify(o.keyword);
    return !existingHandles.some((h) => h === potentialHandle || potentialHandle.includes(h) || h.includes(potentialHandle));
  });
  console.log(`  ${noExisting.length} after excluding existing collections`);

  // 6. Exclude slugs already in active performance queue
  const active = activeSlugs();
  const filtered = noExisting.filter((o) => !active.has(slugify(o.keyword)));
  console.log(`  ${filtered.length} after excluding active queue items`);

  // 7. Sort by impressions descending, take top N
  const candidates = filtered
    .sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0))
    .slice(0, limit);

  if (candidates.length === 0) {
    console.log('\nNo collection opportunities found. Exiting.');
    return;
  }

  // 8. Dry run (no --queue flag): show candidates and exit
  if (!doQueue) {
    console.log(`\n  Top ${candidates.length} candidates (dry run — add --queue to send to Claude):\n`);
    for (const c of candidates) {
      console.log(`    • "${c.keyword}" — ${c.impressions ?? 0} impressions, pos ${(c.position ?? 0).toFixed(1)}, section: ${c._section}`);
    }
    return;
  }

  // 9. Queue mode: send to Claude for evaluation
  console.log(`\n  Sending ${candidates.length} candidates to Claude for evaluation...\n`);

  // Adapt candidates to the format evaluateAndPlanCollections expects (query field)
  const adapted = candidates.map((c) => ({
    query: c.keyword,
    position: c.position ?? 0,
    impressions: c.impressions ?? 0,
    clicks: c.clicks ?? 0,
    metrics: null,
    _original: c,
  }));

  const specs = await evaluateAndPlanCollections(adapted, collections);
  console.log(`  Claude approved ${specs.length} collection(s)\n`);

  // 10. Write queue items for each approved spec
  let queued = 0;
  for (const spec of specs) {
    // Find the matching original opportunity
    const opportunity = candidates.find(
      (c) => c.keyword === spec.keyword || slugify(c.keyword) === spec.handle
    ) || candidates[0];

    const item = {
      slug: spec.handle,
      title: `New Collection: ${spec.title}`,
      trigger: 'collection-gap',
      signal_source: {
        type: 'gsc-collection-gap',
        keyword: opportunity.keyword,
        impressions: opportunity.impressions,
        position: opportunity.position,
        source_section: opportunity._section,
      },
      proposed_collection: {
        title: spec.title,
        handle: spec.handle,
        body_html: spec.body_html,
        seo_title: spec.seo_title,
        seo_description: spec.seo_description || spec.meta_description,
      },
      summary: {
        what_changed: `Proposed new collection targeting '${opportunity.keyword}' (${opportunity.impressions} impressions).`,
        why: `GSC shows commercial-intent demand with no matching collection page.`,
        projected_impact: `New collection page could capture clicks currently going to blog posts.`,
      },
      resource_type: 'new-collection',
      status: 'pending',
      created_at: new Date().toISOString(),
    };

    writeItem(item);
    console.log(`  Queued: ${spec.handle} (${opportunity.keyword})`);
    queued++;
  }

  console.log(`\n  ${queued} collection(s) queued for approval in data/performance-queue/`);
}

// ── publish-approved mode ────────────────────────────────────────────────────

/**
 * --publish-approved mode:
 * Reads approved collection-gap queue items and creates them in Shopify.
 */
async function publishApprovedCollections() {
  const runDate = new Date().toISOString().slice(0, 10);
  console.log(`\n=== Collection Creator (publish-approved) — ${runDate} ===\n`);

  // 1. Find approved collection-gap items
  const items = listQueueItems().filter(
    (i) => i.trigger === 'collection-gap' && i.status === 'approved'
  );

  if (items.length === 0) {
    console.log('No approved collection-gap items in the queue. Exiting.');
    return;
  }

  console.log(`  Found ${items.length} approved collection(s) to publish\n`);

  let successCount = 0;

  for (const item of items) {
    const pc = item.proposed_collection;
    if (!pc || !pc.title || !pc.handle || !pc.body_html) {
      console.error(`  Skipping "${item.slug}" — missing required proposed_collection fields`);
      continue;
    }

    try {
      // 2. Create the collection in Shopify
      console.log(`  Creating collection: "${pc.title}" (/collections/${pc.handle})...`);
      const newCollection = await withRetry(
        () => createCustomCollection({
          title: pc.title,
          handle: pc.handle,
          body_html: pc.body_html,
          published: true,
        }),
        { label: `create collection ${pc.handle}` }
      );

      // 3. Set SEO metafields
      if (pc.seo_title) {
        await upsertMetafield('custom_collections', newCollection.id, 'global', 'title_tag', pc.seo_title);
      }
      if (pc.seo_description) {
        await upsertMetafield('custom_collections', newCollection.id, 'global', 'description_tag', pc.seo_description);
      }

      console.log(`  Created: ${config.url}/collections/${pc.handle} (id: ${newCollection.id})`);

      // 4. Run collection-linker for the new collection
      const keyword = item.signal_source?.keyword || pc.title;
      try {
        execSync(
          `"${process.execPath}" agents/collection-linker/index.js --url "${config.url}/collections/${pc.handle}" --keyword "${keyword}" --apply`,
          { stdio: 'inherit', cwd: ROOT }
        );
      } catch (linkErr) {
        console.error(`  Warning: collection-linker failed for ${pc.handle}:`, linkErr.message);
      }

      // 5. Update queue item status
      item.status = 'published';
      item.published_at = new Date().toISOString();
      writeItem(item);

      successCount++;
      console.log(`  Published and linked: ${pc.handle}\n`);
    } catch (err) {
      console.error(`  Failed to create "${pc.title}":`, err.message);
    }
  }

  console.log(`\n  ${successCount}/${items.length} collection(s) published successfully`);
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const runDate = new Date().toISOString().slice(0, 10);
  console.log(`\n=== Collection Creator — ${runDate} ===\n`);

  mkdirSync(REPORTS_DIR, { recursive: true });

  // 1. Fetch existing collections
  const collections = await getExistingCollections();
  console.log(`  Found ${collections.all.length} existing collections\n`);

  // 2. Find GSC keyword candidates
  let opportunities = [];
  try {
    const candidates = await getBlogRankingCommercialKeywords(gscDays);
    console.log(`  Found ${candidates.length} blog-ranking commercial keywords\n`);

    // 3. Enrich with Ahrefs metrics (best-effort, don't fail if unavailable)
    const top = candidates.slice(0, 40); // cap API calls
    console.log(`  Fetching Ahrefs metrics for top ${top.length} candidates...`);
    const enriched = await Promise.all(
      top.map(async (c) => {
        const metrics = env.AHREFS_API_KEY
          ? await getKeywordMetrics(c.query).catch(() => null)
          : null;
        return { ...c, metrics };
      })
    );

    // 4. Filter by minimum volume and score
    opportunities = enriched
      .filter((o) => {
        const vol = o.metrics?.volume ?? o.impressions;
        return vol >= minVolume;
      })
      .sort((a, b) => scoreOpportunity(b, b.metrics) - scoreOpportunity(a, a.metrics))
      .slice(0, 20); // feed at most 20 to Claude

    console.log(`  ${opportunities.length} opportunities after volume filter (min ${minVolume})\n`);
  } catch (err) {
    console.error('  GSC fetch failed:', err.message);
    console.log('  Continuing with empty opportunity set...\n');
  }

  if (opportunities.length === 0) {
    console.log('No keyword opportunities found this run. Saving empty report.\n');
    const report = buildReport([], [], [], runDate);
    const reportPath = join(REPORTS_DIR, `${runDate}.md`);
    writeFileSync(reportPath, report);
    console.log(`Report saved: ${reportPath}`);
    return;
  }

  // 5. Claude evaluates candidates and generates collection specs
  console.log(`Sending ${opportunities.length} candidates to Claude for evaluation...\n`);
  let approved = [];
  try {
    approved = await evaluateAndPlanCollections(opportunities, collections);
    console.log(`  Claude approved ${approved.length} collection(s)\n`);
  } catch (err) {
    console.error('Claude evaluation failed:', err.message);
    process.exit(1);
  }

  // 6. Apply limit
  if (approved.length > limit) {
    console.log(`  Capping to ${limit} collections (--limit ${limit})\n`);
    approved = approved.slice(0, limit);
  }

  // 7. Create collections (or dry-run)
  const created = [];
  for (const spec of approved) {
    try {
      const result = await createCollection(spec, collections, !apply);
      created.push(result);
    } catch (err) {
      console.error(`  Failed to create "${spec.title}":`, err.message);
      created.push(null);
    }
  }

  // 8. Save report
  const report = buildReport(opportunities, approved, created, runDate);
  const reportPath = join(REPORTS_DIR, `${runDate}.md`);
  writeFileSync(reportPath, report);
  console.log(`\nReport saved: ${reportPath}`);

  // 9. Print summary
  const createdCount = created.filter(Boolean).length;
  if (apply && createdCount > 0) {
    console.log(`\n✅ Created ${createdCount} collection(s) in Shopify`);
    console.log('\nNext: run collection-linker to add internal links from blog posts:');
    for (const c of created.filter(Boolean)) {
      if (!c.dryRun) {
        console.log(`  node agents/collection-linker/index.js --url ${config.url}/collections/${c.handle} --apply`);
      }
    }
  } else if (!apply) {
    console.log(`\n🔵 Dry run complete — ${approved.length} collection(s) would be created`);
    console.log('  Re-run with --apply to create them in Shopify');
  }
}

const run = fromOpportunities ? fromOpportunitiesMode
  : publishApproved ? publishApprovedCollections
  : main;

run()
  .then(() => notifyLatestReport('Collection Creator completed', join(ROOT, 'data', 'reports', 'collection-creator')))
  .catch((err) => {
    notify({ subject: 'Collection Creator failed', body: err.message || String(err), status: 'error' });
    console.error('Error:', err.message);
    process.exit(1);
  });
