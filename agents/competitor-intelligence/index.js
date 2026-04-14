// agents/competitor-intelligence/index.js
/**
 * Competitor Intelligence Agent
 *
 * Pulls top competitor pages from Ahrefs REST API, scrapes structure,
 * takes screenshots, runs Claude vision analysis, writes optimization briefs.
 *
 * Usage:
 *   node agents/competitor-intelligence/index.js
 *
 * Requires in .env: ANTHROPIC_API_KEY, SHOPIFY_STORE, SHOPIFY_SECRET, DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import puppeteer from 'puppeteer';
import { getProducts, getCustomCollections, getSmartCollections, getMetafields } from '../../lib/shopify.js';
import { matchCompetitorUrl } from './matcher.js';
import { extractPageStructure } from './scraper.js';
import { deduplicateChanges } from './brief-writer.js';
import { getCompetitors as fetchCompetitors, getTopPages as fetchTopPages, getSerpResults } from '../../lib/dataforseo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const env = {};
    for (const l of lines) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return env;
  } catch { return {}; }
}

const env = loadEnv();
const STORE          = env.SHOPIFY_STORE || process.env.SHOPIFY_STORE;
const SCREENSHOTS_DIR = join(ROOT, 'data', 'competitor-intelligence', 'screenshots');
const BRIEFS_DIR      = join(ROOT, 'data', 'competitor-intelligence', 'briefs');
const SITEMAP_PATH    = join(ROOT, 'data', 'sitemap-index.json');

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY });

// ── DataForSEO API ────────────────────────────────────────────────────────────

async function getCompetitors() {
  // Discover competitors from SERPs for our product keywords — these are the
  // domains actually competing for the same commercial queries, not editorial sites.
  const PRODUCT_KEYWORDS = [
    'coconut oil deodorant', 'natural deodorant',
    'coconut oil toothpaste', 'fluoride free toothpaste',
    'coconut body lotion', 'organic body lotion',
    'coconut oil lip balm', 'natural lip balm',
    'natural bar soap', 'coconut oil soap',
  ];

  const EDITORIAL = new Set([
    'amazon.com', 'walmart.com', 'target.com', 'ebay.com',
    'youtube.com', 'reddit.com', 'facebook.com', 'instagram.com', 'tiktok.com',
    'pinterest.com', 'wikipedia.org', 'twitter.com',
    'healthline.com', 'byrdie.com', 'allure.com', 'consumerreports.org',
    'medicalnewstoday.com', 'clevelandclinic.org', 'health.com',
    'thegoodtrade.com', 'thehormonedietitian.com',
  ]);

  const OUR_DOMAIN = (env.SHOPIFY_STORE || '').replace('.myshopify.com', '.com') || 'realskincare.com';
  const domainCounts = new Map();

  console.log('  Discovering competitors from SERPs...');
  for (const kw of PRODUCT_KEYWORDS) {
    try {
      const { organic: results } = await getSerpResults(kw, 10);
      for (const r of results) {
        const d = r.domain.replace(/^www\./, '');
        if (d === OUR_DOMAIN.replace(/^www\./, '') || EDITORIAL.has(d)) continue;
        domainCounts.set(d, (domainCounts.get(d) || 0) + 1);
      }
    } catch { /* skip failed SERP */ }
  }

  // Sort by frequency (appears in most SERPs = most relevant competitor)
  const sorted = Array.from(domainCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);

  console.log(`  Found ${sorted.length} product competitors:`);
  for (const [d, count] of sorted.slice(0, 10)) console.log(`    ${d} (${count} keyword overlaps)`);

  return sorted.map(([domain]) => ({ domain }));
}

async function getTopPages(domain) {
  const pages = await fetchTopPages(domain, { limit: 200 });
  return pages.map(p => ({
    url: 'https://' + domain + p.url,
    traffic_value: p.traffic,
    keywords: p.keywords,
  }));
}

// ── Puppeteer screenshot ───────────────────────────────────────────────────────

async function takeScreenshot(url, outputPath, browser) {
  const ownBrowser = !browser;
  if (ownBrowser) browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.screenshot({ path: outputPath, fullPage: true });
    await page.close();
    return outputPath;
  } catch (err) {
    console.warn(`  [screenshot] Failed for ${url}: ${err.message}`);
    return null;
  } finally {
    if (ownBrowser) await browser.close();
  }
}

// ── Shopify ID resolution (sitemap never includes shopify_id, always fetched) ──

async function resolveShopifyId(slug, type) {
  if (type === 'product') {
    const products = await getProducts({ handle: slug });
    const id = products?.[0]?.id || null;
    return { id, resource: 'products' };
  }
  const custom = await getCustomCollections({ handle: slug });
  if (custom?.[0]?.id) return { id: custom[0].id, resource: 'custom_collections' };
  const smart = await getSmartCollections({ handle: slug });
  return { id: smart?.[0]?.id || null, resource: 'smart_collections' };
}

// ── Current page content snapshot ─────────────────────────────────────────────

async function fetchCurrentContent(shopify_id, resource) {
  const items = resource === 'products'
    ? await getProducts({ ids: shopify_id })
    : await getCustomCollections({ ids: shopify_id });
  const item = items?.[0];

  const metafields = await getMetafields(resource, shopify_id);
  const meta_title = metafields.find(m => m.namespace === 'global' && m.key === 'title_tag')?.value || '';
  const meta_description = metafields.find(m => m.namespace === 'global' && m.key === 'description_tag')?.value || '';

  return {
    title: item?.title || '',
    meta_title,
    meta_description,
    body_html: item?.body_html || '',
    theme_sections: [], // Theme section snapshot omitted — populated on demand if needed
  };
}

// ── Claude vision analysis ─────────────────────────────────────────────────────

async function analyzeWithVision(screenshotPath, structureData, targetSlug) {
  if (!screenshotPath || !existsSync(screenshotPath)) {
    return { ...structureData, conversion_patterns: [], recommended_changes: [] };
  }

  const imageData = readFileSync(screenshotPath).toString('base64');
  const prompt = `You are analyzing a competitor product/collection page to identify patterns that drive conversions.

Target store slug: ${targetSlug}
Extracted structure: ${JSON.stringify(structureData, null, 2)}

Return ONLY valid JSON with this exact schema:
{
  "conversion_patterns": ["string — observation about what makes this page effective"],
  "recommended_changes": [
    {
      "type": "meta_title | meta_description | body_html | theme_section",
      "label": "string — short descriptive label",
      "proposed": "string — the actual proposed content",
      "rationale": "string — why this change would improve conversions"
    }
  ]
}`;

  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } },
        { type: 'text', text: prompt },
      ],
    }],
  });

  try {
    const text = msg.content.find(b => b.type === 'text')?.text || '{}';
    const json = JSON.parse(text.replace(/```json|```/g, '').trim());
    return { ...structureData, ...json };
  } catch {
    console.warn('  [vision] Failed to parse Claude response — no changes generated for this page');
    return { ...structureData, conversion_patterns: [], recommended_changes: [] };
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  mkdirSync(BRIEFS_DIR, { recursive: true });

  if (!existsSync(SITEMAP_PATH)) throw new Error('sitemap-index.json not found — run: npm run sitemap');
  const sitemap = JSON.parse(readFileSync(SITEMAP_PATH, 'utf8'));
  const sitemapPages = sitemap.pages.filter(p => p.type === 'product' || p.type === 'collection');
  console.log(`Loaded sitemap: ${sitemapPages.length} product/collection pages`);

  const competitors = await getCompetitors();
  console.log(`Found ${competitors.length} product competitors from SERP analysis`);

  // Accumulate results per store slug before writing briefs
  const briefMap = new Map(); // slug → { type, competitors[], allChanges[] }

  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    for (const competitor of competitors) {
      const domain = competitor.domain;
      if (!domain) continue;
      console.log(`\nProcessing: ${domain}`);

      let topPages = [];
      try {
        topPages = await getTopPages(domain);
      } catch (err) {
        console.warn(`  [dataforseo] ${err.message}`);
        continue;
      }

      // Filter client-side to product/collection URLs, sort by traffic_value desc, top 5
      const filtered = topPages
        .filter(p => /\/products\/|\/collections\//.test(p.url))
        .sort((a, b) => (b.traffic_value || 0) - (a.traffic_value || 0))
        .slice(0, 5);

      console.log(`  ${filtered.length} relevant pages (from ${topPages.length} total)`);

      for (const page of filtered) {
        const match = matchCompetitorUrl(page.url, sitemapPages);
        if (!match) { console.log(`  skip (no match): ${page.url}`); continue; }

        const { slug, type } = match;
        const slugTokens = slug.split('-').filter(t => t.length > 2);
        console.log(`  matched: ${page.url} → ${slug}`);

        if (!briefMap.has(slug)) {
          briefMap.set(slug, { slug, type, competitors: [], allChanges: [] });
        }
        const acc = briefMap.get(slug);

        // Scrape competitor page
        let structure = { h1: '', section_order: [], cta_text: '', description_words: 0, benefit_format: 'prose', keyword_in_h1: false, keyword_in_first_paragraph: false };
        try {
          const res = await fetch(page.url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' } });
          if (res.ok) {
            structure = extractPageStructure(await res.text(), slugTokens);
          } else {
            console.warn(`  [scrape] HTTP ${res.status} — skipping`);
          }
        } catch (err) {
          console.warn(`  [scrape] ${err.message}`);
        }

        // Screenshot competitor
        const domainSlug = domain.replace(/\./g, '-');
        const screenshotFile = `${domainSlug}-${slug}.png`;
        const screenshotSaved = await takeScreenshot(page.url, join(SCREENSHOTS_DIR, screenshotFile), browser);

        // Claude vision
        const analysis = await analyzeWithVision(screenshotSaved, structure, slug);
        const taggedChanges = (analysis.recommended_changes || []).map(c => ({
          ...c, fromTrafficValue: page.traffic_value || 0,
        }));

        acc.competitors.push({
          domain,
          url: page.url,
          traffic_value: page.traffic_value || 0,
          screenshot: screenshotSaved
            ? join('data', 'competitor-intelligence', 'screenshots', screenshotFile)
            : null,
          analysis: {
            h1: analysis.h1,
            section_order: analysis.section_order,
            cta_text: analysis.cta_text,
            description_words: analysis.description_words,
            keyword_in_h1: analysis.keyword_in_h1,
            keyword_in_first_paragraph: analysis.keyword_in_first_paragraph,
            benefit_format: analysis.benefit_format,
            conversion_patterns: analysis.conversion_patterns || [],
            recommended_changes: [],
          },
        });
        acc.allChanges.push(...taggedChanges);
      }
    }

    // Write briefs
    for (const [slug, acc] of briefMap) {
      if (!acc.competitors.length) continue;

      // Resolve shopify_id via Shopify API (sitemap never includes it)
      const { id: shopify_id, resource } = await resolveShopifyId(slug, acc.type);
      console.log(`\n${slug}: shopify_id=${shopify_id}`);

      let current = { title: '', meta_title: '', meta_description: '', body_html: '', theme_sections: [] };
      if (shopify_id) {
        try { current = await fetchCurrentContent(shopify_id, resource); }
        catch (err) { console.warn(`  [shopify] ${err.message}`); }
      }

      // Screenshot store page
      const storeUrl = `https://${STORE}/${acc.type === 'product' ? 'products' : 'collections'}/${slug}`;
      const storeSaved = await takeScreenshot(storeUrl, join(SCREENSHOTS_DIR, `store-${slug}.png`), browser);

      // Deduplicate and tag with display-only current values
      const proposed_changes = deduplicateChanges(acc.allChanges).map(c => {
        const currentVal = c.type === 'meta_title' ? current.meta_title
                         : c.type === 'meta_description' ? current.meta_description
                         : c.type === 'body_html' ? current.body_html
                         : undefined; // theme_section: no inline current
        return currentVal !== undefined ? { ...c, current: currentVal } : c;
      });

      const brief = {
        slug,
        page_type: acc.type,
        shopify_id,
        generated_at: new Date().toISOString(),
        status: 'pending',
        store_screenshot: storeSaved
          ? join('data', 'competitor-intelligence', 'screenshots', `store-${slug}.png`)
          : null,
        current,
        competitors: acc.competitors.sort((a, b) => b.traffic_value - a.traffic_value),
        proposed_changes,
      };

      writeFileSync(join(BRIEFS_DIR, `${slug}.json`), JSON.stringify(brief, null, 2));
      console.log(`  brief written: ${proposed_changes.length} proposed changes`);
    }
  } finally {
    await browser.close();
  }

  console.log('\nCompetitor intelligence complete.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
