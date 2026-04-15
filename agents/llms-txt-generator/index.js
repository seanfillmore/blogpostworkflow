/**
 * llms.txt Generator
 *
 * Builds a curated llms.txt file listing the site's best content for LLM
 * crawlers (Perplexity, Anthropic, etc.). Deploys to Shopify as a page
 * at /pages/llms-txt with a redirect from /llms.txt.
 *
 * Selection:
 *   - Blog posts with ≥100 GSC impressions in last 90 days
 *   - All active products
 *   - Top 10 collections by organic traffic (DataForSEO)
 *
 * Usage:
 *   node agents/llms-txt-generator/index.js              # generate + deploy
 *   node agents/llms-txt-generator/index.js --dry-run    # generate only
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getProducts, getCustomCollections, getSmartCollections,
  getPages, createPage, updatePage,
  getRedirects, createRedirect,
  getMetafields,
} from '../../lib/shopify.js';
import { getRankedKeywords } from '../../lib/dataforseo.js';
import { listAllSlugs, getPostMeta } from '../../lib/posts.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const OUTPUT_DIR = join(ROOT, 'data', 'reports', 'llms-txt');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

// GSC is optional
let gsc = null;
async function loadGSC() {
  try { gsc = await import('../../lib/gsc.js'); } catch { /* skip */ }
}

function truncate(text, max = 160) {
  if (!text) return '';
  const clean = text
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).replace(/\s\S*$/, '') + '…';
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

async function selectBlogPosts() {
  const selected = [];
  const slugs = listAllSlugs();
  for (const slug of slugs) {
    const meta = getPostMeta(slug);
    if (!meta || !meta.shopify_article_id) continue;

    const url = `${config.url}/blogs/${meta.shopify_blog_handle || 'news'}/${meta.shopify_handle || slug}`;

    let impressions = 0;
    if (gsc) {
      try {
        const perf = await gsc.getPagePerformance(url, 90);
        impressions = perf?.impressions ?? 0;
      } catch { /* skip */ }
    }

    if (impressions >= 100) {
      selected.push({
        url,
        title: meta.title || slug.replace(/-/g, ' '),
        description: truncate(meta.meta_description || meta.summary || ''),
        impressions,
      });
    }
  }
  return selected.sort((a, b) => b.impressions - a.impressions);
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

function buildLlmsTxt({ blogPosts, products, collections }) {
  const lines = [];
  lines.push(`# ${config.name}`);
  lines.push('');
  lines.push(`> Natural coconut-based skincare and personal care products handcrafted with clean ingredients.`);
  lines.push('');

  if (products.length > 0) {
    lines.push('## Products');
    lines.push('');
    for (const p of products) {
      lines.push(`- [${p.title}](${p.url})${p.description ? ': ' + p.description : ''}`);
    }
    lines.push('');
  }

  if (collections.length > 0) {
    lines.push('## Collections');
    lines.push('');
    for (const c of collections) {
      lines.push(`- [${c.title}](${c.url})${c.description ? ': ' + c.description : ''}`);
    }
    lines.push('');
  }

  if (blogPosts.length > 0) {
    lines.push('## Blog Posts');
    lines.push('');
    for (const b of blogPosts) {
      lines.push(`- [${b.title}](${b.url})${b.description ? ': ' + b.description : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function deployToShopify(content) {
  // Find existing /pages/llms-txt or create it
  const pages = await getPages();
  const existing = pages.find((p) => p.handle === 'llms-txt');
  const body_html = `<pre style="white-space:pre-wrap;font-family:monospace">${content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;

  let pageId;
  if (existing) {
    await updatePage(existing.id, { title: 'llms.txt', body_html });
    pageId = existing.id;
    console.log(`  Updated page /pages/llms-txt (id: ${pageId})`);
  } else {
    const created = await createPage({ title: 'llms.txt', handle: 'llms-txt', body_html, published: true });
    pageId = created.id;
    console.log(`  Created page /pages/llms-txt (id: ${pageId})`);
  }

  // Ensure /llms.txt redirect exists
  const redirects = await getRedirects({ path: '/llms.txt' });
  const hasRedirect = redirects.some((r) => r.path === '/llms.txt');
  if (!hasRedirect) {
    await createRedirect('/llms.txt', '/pages/llms-txt');
    console.log('  Created redirect /llms.txt → /pages/llms-txt');
  } else {
    console.log('  Redirect /llms.txt already exists');
  }
}

async function main() {
  console.log('\nllms.txt Generator\n');

  await loadGSC();

  console.log('  Selecting content...');
  const [blogPosts, products, collections] = await Promise.all([
    selectBlogPosts(),
    selectProducts(),
    selectTopCollections(),
  ]);
  console.log(`  Blog posts (≥100 impressions): ${blogPosts.length}`);
  console.log(`  Products (active): ${products.length}`);
  console.log(`  Top collections by traffic: ${collections.length}`);

  const content = buildLlmsTxt({ blogPosts, products, collections });

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const localPath = join(OUTPUT_DIR, 'llms.txt');
  writeFileSync(localPath, content);
  console.log(`\n  Saved: ${localPath}`);

  if (dryRun) {
    console.log('\nDry run — no Shopify changes.');
    return;
  }

  console.log('\n  Deploying to Shopify...');
  await deployToShopify(content);

  await notify({
    subject: `llms.txt generated: ${blogPosts.length + products.length + collections.length} items`,
    body: `Blog: ${blogPosts.length}, Products: ${products.length}, Collections: ${collections.length}`,
    status: 'success',
  });

  console.log('\nDone.');
}

main().catch((err) => {
  notify({ subject: 'llms.txt Generator failed', body: err.message, status: 'error' });
  console.error('Error:', err.message);
  process.exit(1);
});
