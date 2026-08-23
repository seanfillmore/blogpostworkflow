/**
 * llms.txt Generator
 *
 * Builds a curated llms.txt for LLM / AI-search crawlers (Perplexity, ChatGPT,
 * Claude, Google AI overviews, etc.) AND for commerce agents (UCP / Shop skill).
 *
 * Deployment: writes `templates/llms.txt.liquid` into the LIVE (main) theme.
 * Since ~May 2026 Shopify serves `/llms.txt` natively from a platform route;
 * a theme template overrides it (same mechanism as robots.txt.liquid). A custom
 * template REPLACES Shopify's native output — it does not merge — so we prepend
 * Shopify's commerce/UCP preamble (preserved verbatim in commerce-preamble.md)
 * and then append our curated content sections. The whole body is wrapped in
 * {% raw %} so no product/collection text is ever interpreted as Liquid.
 *
 * The old approach (a /pages/llms-txt page + a /llms.txt URL redirect) is dead:
 * Shopify's native route shadows merchant redirects. This run also cleans up
 * that orphaned page + redirect.
 *
 * Selection:
 *   - Blog posts that are CURRENTLY published on Shopify AND have >=100 GSC
 *     impressions in the last 90 days (published state gates first — GSC's
 *     90-day window still counts impressions from before a post was
 *     unpublished, so impressions alone would keep citing a dead URL)
 *   - All active products
 *   - Top 10 collections by organic traffic (DataForSEO)
 *
 * Usage:
 *   node agents/llms-txt-generator/index.js              # generate + deploy to live theme
 *   node agents/llms-txt-generator/index.js --dry-run    # generate only (writes local copy)
 *   node agents/llms-txt-generator/index.js --no-cleanup # skip legacy page/redirect removal
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getBlogs, getArticles,
  getProducts, getCustomCollections, getSmartCollections,
  getPages, deletePage,
  getRedirects, deleteRedirect,
  getMetafields,
  getMainThemeId, getThemeAsset, updateThemeAsset,
} from '../../lib/shopify.js';
import { getRankedKeywords } from '../../lib/dataforseo.js';
import { listAllSlugs, getPostMeta } from '../../lib/posts.js';
import { notify } from '../../lib/notify.js';
import { truncate, selectBlogPosts, buildTemplate } from './selection.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const OUTPUT_DIR = join(ROOT, 'data', 'reports', 'llms-txt');
const PREAMBLE_PATH = join(__dirname, 'commerce-preamble.md');
const TEMPLATE_KEY = 'templates/llms.txt.liquid';

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipCleanup = args.includes('--no-cleanup');

// GSC is optional
let gsc = null;
async function loadGSC() {
  try { gsc = await import('../../lib/gsc.js'); } catch { /* skip */ }
}

async function getMetaDescription(resource, resourceId) {
  try {
    const mfs = await getMetafields(resource, resourceId);
    const found = (mfs || []).find((m) => m.namespace === 'global' && m.key === 'description_tag');
    return found?.value || null;
  } catch {
    return null;
  }
}

/**
 * Ids of articles that are CURRENTLY published, across every blog the store
 * has (not just the blogs referenced by local meta.json — a slug can be
 * missing `shopify_blog_id`, and this must not silently skip its blog).
 *
 * Why this exists: GSC's page-performance API answers "did this URL get
 * impressions in the last 90 days", which stays true for a while after a
 * post is unpublished — the rolling window still contains days when the
 * page was live. Gating on impressions alone therefore keeps citing a page
 * Shopify no longer serves. That is exactly how three hair-cluster posts
 * (RSC sells no hair products) survived a full `llms.txt` regeneration on
 * 2026-08-22, hours after being unpublished: impressions were still >=100,
 * live-published status was never checked. Published state answers "does
 * this URL still resolve to this content"; GSC impressions still decide
 * which of the *published* posts are worth citing. Neither substitutes for
 * the other.
 */
async function getPublishedArticleIds() {
  const publishedIds = new Set();
  const blogs = await getBlogs();
  for (const blog of blogs) {
    let sinceId = 0;
    for (;;) {
      const articles = await getArticles(blog.id, {
        limit: 250,
        since_id: sinceId,
        fields: 'id,published_at',
      });
      if (!articles.length) break;
      for (const a of articles) {
        if (a.published_at) publishedIds.add(a.id);
      }
      sinceId = articles[articles.length - 1].id;
      if (articles.length < 250) break;
    }
  }
  return publishedIds;
}

/**
 * I/O only: fetch every locally-known post's published state (Shopify) and
 * GSC impressions, and hand the raw rows to the pure selectBlogPosts() (see
 * ./selection.js) to apply the actual published+impressions gates. The GSC
 * fetch is skipped for posts we already know are unpublished — same
 * short-circuit the original inline version used, to avoid spending a call
 * on a page selectBlogPosts() will reject regardless of what it returns.
 */
async function gatherBlogPostCandidates() {
  const candidates = [];
  const slugs = listAllSlugs();
  const publishedIds = await getPublishedArticleIds();

  for (const slug of slugs) {
    const meta = getPostMeta(slug);
    if (!meta || !meta.shopify_article_id) continue;

    const isPublished = publishedIds.has(meta.shopify_article_id);
    const url = `${config.url}/blogs/${meta.shopify_blog_handle || 'news'}/${meta.shopify_handle || slug}`;

    let impressions = 0;
    if (isPublished && gsc) {
      try {
        const perf = await gsc.getPagePerformance(url, 90);
        impressions = perf?.impressions ?? 0;
      } catch { /* skip */ }
    }

    candidates.push({
      url,
      title: meta.title || slug.replace(/-/g, ' '),
      description: meta.meta_description || meta.summary || '',
      impressions,
      isPublished,
    });
  }
  return candidates;
}

async function selectProducts() {
  const products = await getProducts();
  const active = products.filter((p) => p.status === 'active');
  const out = [];
  for (const p of active) {
    const metaDesc = await getMetaDescription('products', p.id);
    out.push({
      url: `${config.url}/products/${p.handle}`,
      title: p.title,
      description: metaDesc ? truncate(metaDesc) : truncate(p.body_html || ''),
    });
  }
  return out;
}

async function selectTopCollections() {
  const domain = config.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  let rankedKeywords = [];
  try {
    rankedKeywords = await getRankedKeywords(domain, { limit: 500 });
  } catch { /* skip */ }

  // Aggregate traffic by collection URL
  const collectionTraffic = new Map();
  for (const kw of rankedKeywords) {
    const path = kw.url || '';
    if (!path.startsWith('/collections/')) continue;
    collectionTraffic.set(path, (collectionTraffic.get(path) || 0) + (kw.traffic || 0));
  }

  // Fetch all collections for metadata
  const [custom, smart] = await Promise.all([getCustomCollections(), getSmartCollections()]);
  const allCollections = [...custom, ...smart];
  const byHandle = new Map(allCollections.map((c) => [c.handle, c]));

  const topPaths = Array.from(collectionTraffic.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([path]) => path);

  const topTen = [];
  for (const path of topPaths) {
    const handle = path.replace('/collections/', '');
    const coll = byHandle.get(handle);
    if (!coll) continue;
    const metaDesc = await getMetaDescription('collections', coll.id);
    topTen.push({
      url: `${config.url}${path}`,
      title: coll.title,
      description: metaDesc ? truncate(metaDesc) : truncate(coll.body_html || ''),
    });
  }

  return topTen;
}

function loadCommercePreamble() {
  // Shopify's native commerce/UCP block. Preserved verbatim because a custom
  // template REPLACES the native /llms.txt rather than merging with it.
  return readFileSync(PREAMBLE_PATH, 'utf8').trimEnd();
}

async function backupExistingTemplate(themeId) {
  try {
    const existing = await getThemeAsset(themeId, TEMPLATE_KEY);
    if (existing) {
      const backupPath = join(OUTPUT_DIR, `${TEMPLATE_KEY.replace(/\//g, '_')}.backup`);
      writeFileSync(backupPath, existing);
      console.log(`  Backed up existing template → ${backupPath}`);
    }
  } catch (err) {
    // getThemeAsset throws HTTP 404 when the asset doesn't exist yet — expected.
    if (!/HTTP 404/.test(err.message)) throw err;
    console.log('  No existing custom template (using Shopify native default) — creating fresh.');
  }
}

async function deployToTheme(template) {
  const themeId = await getMainThemeId();
  console.log(`  Live theme id: ${themeId}`);
  await backupExistingTemplate(themeId);
  await updateThemeAsset(themeId, TEMPLATE_KEY, template);
  console.log(`  Wrote ${TEMPLATE_KEY} to live theme.`);
}

async function cleanupLegacy() {
  // Remove the dead /pages/llms-txt page + /llms.txt redirect from the old approach.
  let removed = 0;
  try {
    const pages = await getPages();
    const legacy = pages.find((p) => p.handle === 'llms-txt');
    if (legacy) {
      await deletePage(legacy.id);
      console.log(`  Deleted legacy page /pages/llms-txt (id: ${legacy.id})`);
      removed++;
    }
  } catch (err) {
    console.log(`  Legacy page cleanup skipped: ${err.message}`);
  }
  try {
    const redirects = await getRedirects({ path: '/llms.txt' });
    for (const r of redirects.filter((r) => r.path === '/llms.txt')) {
      await deleteRedirect(r.id);
      console.log(`  Deleted legacy redirect /llms.txt → ${r.target} (id: ${r.id})`);
      removed++;
    }
  } catch (err) {
    console.log(`  Legacy redirect cleanup skipped: ${err.message}`);
  }
  if (removed === 0) console.log('  No legacy page/redirect to clean up.');
}

async function main() {
  console.log('\nllms.txt Generator\n');

  await loadGSC();

  console.log('  Selecting content...');
  const [blogCandidates, products, collections] = await Promise.all([
    gatherBlogPostCandidates(),
    selectProducts(),
    selectTopCollections(),
  ]);
  const blogPosts = selectBlogPosts(blogCandidates);
  console.log(`  Blog posts (>=100 impressions): ${blogPosts.length}`);
  console.log(`  Products (active): ${products.length}`);
  console.log(`  Top collections by traffic: ${collections.length}`);

  const template = buildTemplate({
    preamble: loadCommercePreamble(),
    brandName: config.name,
    blogPosts,
    products,
    collections,
  });

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const localPath = join(OUTPUT_DIR, 'llms.txt.liquid');
  writeFileSync(localPath, template);
  console.log(`\n  Saved local copy: ${localPath}`);

  if (dryRun) {
    console.log('\nDry run — no Shopify changes.');
    return;
  }

  console.log('\n  Deploying to live theme...');
  await deployToTheme(template);

  if (!skipCleanup) {
    console.log('\n  Cleaning up legacy page/redirect...');
    await cleanupLegacy();
  }

  await notify({
    subject: `llms.txt deployed: ${blogPosts.length + products.length + collections.length} curated items`,
    body: `Wrote ${TEMPLATE_KEY} to live theme. Blog: ${blogPosts.length}, Products: ${products.length}, Collections: ${collections.length}.`,
    status: 'success',
  });

  console.log('\nDone.');
}

if (process.argv[1] && process.argv[1].endsWith('llms-txt-generator/index.js')) {
  main().catch((err) => {
    notify({ subject: 'llms.txt Generator failed', body: err.message, status: 'error' });
    console.error('Error:', err.message);
    process.exit(1);
  });
}
