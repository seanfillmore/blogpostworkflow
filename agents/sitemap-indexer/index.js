/**
 * Sitemap Indexer Agent
 *
 * Fetches and parses all Shopify sitemaps for the configured site.
 * Outputs a structured JSON index of all pages categorized by type.
 *
 * Output saved to: data/sitemap-index.json
 * Usage: node agents/sitemap-indexer/index.js
 */

import { XMLParser } from 'fast-xml-parser';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ['url', 'sitemap'].includes(name),
});

async function fetchXML(url) {
  console.log(`  Fetching: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function classifyUrl(url) {
  const path = new URL(url).pathname;
  if (path.startsWith('/products/')) return 'product';
  if (path.startsWith('/collections/')) return 'collection';
  if (path.startsWith('/blogs/') && path.split('/').length > 3) return 'blog_post';
  if (path.startsWith('/blogs/')) return 'blog_index';
  if (path.startsWith('/pages/')) return 'page';
  if (path === '/') return 'homepage';
  return 'other';
}

function parseUrls(xml, sourceType) {
  const parsed = parser.parse(xml);
  const urlset = parsed.urlset;
  if (!urlset || !urlset.url) return [];

  return urlset.url.map((entry) => {
    const url = entry.loc;
    const record = {
      url,
      type: classifyUrl(url),
      lastmod: entry.lastmod || null,
      changefreq: entry.changefreq || null,
    };

    // Extract slug from URL path
    const path = new URL(url).pathname;
    const parts = path.split('/').filter(Boolean);
    record.slug = parts[parts.length - 1] || '/';

    // Product-specific: pull image data if present
    if (sourceType === 'products' && entry['image:image']) {
      const img = Array.isArray(entry['image:image'])
        ? entry['image:image'][0]
        : entry['image:image'];
      record.image = {
        url: img['image:loc'] || null,
        title: img['image:title'] || null,
        caption: img['image:caption'] || null,
      };
    }

    return record;
  });
}

async function fetchSitemapIndex(indexUrl) {
  const xml = await fetchXML(indexUrl);
  const parsed = parser.parse(xml);
  const sitemapIndex = parsed.sitemapindex;
  if (!sitemapIndex || !sitemapIndex.sitemap) {
    throw new Error('No sitemaps found in sitemap index');
  }
  return sitemapIndex.sitemap.map((s) => s.loc);
}

function typeFromSitemapUrl(url) {
  if (url.includes('sitemap_products')) return 'products';
  if (url.includes('sitemap_collections')) return 'collections';
  if (url.includes('sitemap_blogs')) return 'blogs';
  if (url.includes('sitemap_pages')) return 'pages';
  return 'other';
}

async function run() {
  console.log(`\nSitemap Indexer — ${config.name}`);
  console.log(`Site: ${config.url}\n`);

  // Step 1: Fetch sitemap index
  console.log('Fetching sitemap index...');
  const sitemapUrls = await fetchSitemapIndex(config.sitemap);
  console.log(`Found ${sitemapUrls.length} sub-sitemaps\n`);

  // Step 2: Fetch and parse each sub-sitemap
  const allPages = [];
  const summary = {};

  for (const sitemapUrl of sitemapUrls) {
    const type = typeFromSitemapUrl(sitemapUrl);
    console.log(`Parsing ${type} sitemap...`);
    const xml = await fetchXML(sitemapUrl);
    const pages = parseUrls(xml, type);
    allPages.push(...pages);
    summary[type] = pages.length;
    console.log(`  → ${pages.length} URLs\n`);
  }

  // Step 3: Build index
  const index = {
    meta: {
      site: config.name,
      url: config.url,
      generated_at: new Date().toISOString(),
      total_pages: allPages.length,
      summary,
    },
    pages: allPages,
  };

  // Step 4: Write output
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  const outputPath = join(ROOT, 'data', 'sitemap-index.json');
  writeFileSync(outputPath, JSON.stringify(index, null, 2));

  // Step 5: Print summary
  console.log('='.repeat(50));
  console.log('SITEMAP INDEX COMPLETE');
  console.log('='.repeat(50));
  console.log(`Total pages indexed: ${allPages.length}`);
  for (const [type, count] of Object.entries(summary)) {
    console.log(`  ${type.padEnd(15)} ${count}`);
  }
  console.log(`\nOutput: ${outputPath}`);
}

run().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
