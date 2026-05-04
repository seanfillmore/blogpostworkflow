/**
 * Technical SEO Agent
 *
 * Reads the DataForSEO on-page crawl results (site-crawler output) and
 * resolves fixable issues via the Shopify API.
 *
 * Commands:
 *   audit                  Produce a prioritised audit report from the latest crawl
 *   fix-meta [--dry-run]   Generate + push missing/bad meta descriptions (blog posts & pages)
 *   fix-links [--dry-run]  Update internal links pointing to 404 pages
 *   fix-redirects [--dry-run] Update internal links pointing to 301 redirected URLs
 *   fix-alt-text [--dry-run]  Generate + insert alt text on <img> tags in blog post bodies
 *   fix-theme-alt [--dry-run] Add alt text to images in JSON theme templates (sections/templates)
 *   create-redirects [--dry-run] Create 301 redirects for known 404 pages
 *   fix-ai-content [--dry-run]  Rewrite high-AI-content pages in data/ai-detection/*.csv
 *   fix-titles [--dry-run]     Shorten title tags that exceed 60 characters
 *   fix-noindex [--dry-run]    Add noindex to ads landing pages and orphan pages
 *   fix-duplicate-tags [--dry-run] Remove duplicate meta/title tags from article body_html
 *   fix-internal-links [--dry-run] Run internal-linker for blog posts with few inbound links
 *   fix-submit-indexing [--dry-run] Submit changed pages to Google Indexing API
 *   fix-noindex-thin [--dry-run]    Add noindex to tag listing and paginated blog pages
 *   fix-all [--dry-run]    Run all fixes in order
 *
 * Requires: ANTHROPIC_API_KEY in .env
 *           data/technical_seo/crawl-results.json (site-crawler output, ≤14 days old)
 *
 * Output:  data/reports/technical-seo-audit.md
 *
 * Shopify token scope: read_products, write_products, read_content, write_content
 */

import Anthropic from '@anthropic-ai/sdk';
import * as cheerio from 'cheerio';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import {
  getBlogs, getArticles, getArticle, updateArticle,
  getPages, getPage, updatePage,
  getRedirects, createRedirect, deleteRedirect,
  upsertMetafield,
  getProducts, getProduct, updateProduct, updateProductImage,
  getCustomCollections, getSmartCollections,
  updateCustomCollection, updateSmartCollection,
  getAllFiles, updateFileAlt,
  getMainThemeId, getThemeAsset, updateThemeAsset, listThemeAssets,
} from '../../lib/shopify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CSV_DIR = join(ROOT, 'data', 'technical_seo');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'technical-seo');

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

const claude = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// ── CSV utility (used only by fix-ai-content for third-party AI detection exports) ──

function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFFFE || text.charCodeAt(0) === 0xFEFF || text.includes('\x00')) {
    text = text.replace(/\x00/g, '').replace(/^\uFEFF|\uFFFE/g, '');
  }
  const lines = text.trim().split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const delimiter = lines[0].includes('\t') ? '\t' : ',';
  const parseRow = (line) => {
    const fields = [];
    let inQuote = false;
    let cur = '';
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === delimiter && !inQuote) { fields.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    fields.push(cur.trim());
    return fields;
  };
  const headers = parseRow(lines[0]).map((h) => h.replace(/^"|"$/g, '').trim().toLowerCase().replace(/\s+/g, '_'));
  return lines.slice(1).map((line) => {
    const values = parseRow(line);
    const row = {};
    headers.forEach((h, i) => { row[h] = (values[i] ?? '').replace(/^"|"$/g, '').trim(); });
    return row;
  });
}

// ── crawl data ────────────────────────────────────────────────────────────────

function loadCrawlResults() {
  const crawlPath = join(CSV_DIR, 'crawl-results.json');
  if (!existsSync(crawlPath)) return null;

  let data;
  try { data = JSON.parse(readFileSync(crawlPath, 'utf8')); } catch { return null; }

  // Check freshness — skip if older than 14 days
  const age = Date.now() - new Date(data.crawled_at).getTime();
  if (age > 14 * 24 * 60 * 60 * 1000) return null;

  const issues = data.issues || {};

  // Map crawl issue categories to Ahrefs CSV key names
  return {
    'Error-404_page': issues.error_404 || [],
    'Warning-indexable-Meta_description_tag_missing_or_empty': issues.meta_missing || [],
    'Warning-indexable-Meta_description_too_long': issues.meta_too_long || [],
    'Warning-indexable-Meta_description_too_short': issues.meta_too_short || [],
    'Warning-indexable-Title_too_long': issues.title_too_long || [],
    'Warning-indexable-H1_tag_missing_or_empty': issues.h1_missing || [],
    'Warning-Missing_alt_text': issues.alt_missing || [],
    'Notice-Redirect_chain': issues.redirect_chain || [],
    'Error-indexable-Multiple_meta_description_tags': issues.duplicate_meta || [],
    'Error-indexable-Multiple_title_tags': issues.duplicate_title || [],
    'Error-indexable-Orphan_page_(has_no_incoming_internal_links)': issues.orphan || [],
    'Notice-indexable-Page_has_only_one_dofollow_incoming_internal_link': issues.single_link || [],
    'Error-indexable-Page_has_links_to_broken_page': issues.links_to_404 || [],
    'Warning-indexable-Page_has_links_to_redirect': issues.links_to_redirect || [],
  };
}

// Memoised access to the crawl snapshot. Every fix command runs in its own
// process, so a single load per command is fine.
let _crawlCache;
function getCrawl() {
  if (_crawlCache === undefined) _crawlCache = loadCrawlResults();
  if (!_crawlCache) {
    console.error('\n  No fresh crawl data found at data/technical_seo/crawl-results.json.');
    console.error('  Run: node agents/site-crawler/index.js');
    process.exit(1);
  }
  return _crawlCache;
}

function loadIssue(key) {
  return getCrawl()[key] || [];
}

// ── URL helpers ───────────────────────────────────────────────────────────────

function urlPath(url) {
  try { return new URL(url).pathname.replace(/\/$/, '') || '/'; }
  catch { return url; }
}

function pageType(url) {
  const p = urlPath(url);
  if (p.startsWith('/blogs/news/')) return 'article';
  if (p.startsWith('/pages/')) return 'page';
  if (p.startsWith('/products/')) return 'product';
  if (p.startsWith('/collections/')) return 'collection';
  return 'other';
}

function isSitePage(url) {
  return url.includes(config.url.replace('https://', '').replace('http://', ''));
}

// ── Shopify resource lookup ───────────────────────────────────────────────────

let _articleIndex = null;
let _pageIndex = null;
let _productIndex = null;
let _collectionIndex = null;

async function getArticleIndex() {
  if (_articleIndex) return _articleIndex;
  console.log('  Loading blog article index from Shopify...');
  const blogs = await getBlogs();
  const index = {};
  for (const blog of blogs) {
    const articles = await getArticles(blog.id);
    for (const a of articles) {
      const path = `/blogs/${blog.handle}/${a.handle}`;
      index[path] = { blogId: blog.id, articleId: a.id, title: a.title, summary_html: a.summary_html };
    }
  }
  _articleIndex = index;
  return index;
}

async function getPageIndex() {
  if (_pageIndex) return _pageIndex;
  console.log('  Loading page index from Shopify...');
  const pages = await getPages();
  const index = {};
  for (const p of pages) {
    index[`/pages/${p.handle}`] = { pageId: p.id, title: p.title };
  }
  _pageIndex = index;
  return index;
}

async function getProductIndex() {
  if (_productIndex) return _productIndex;
  console.log('  Loading product index from Shopify...');
  const products = await getProducts();
  const index = {};
  for (const p of products) {
    index[`/products/${p.handle}`] = { productId: p.id, title: p.title, images: p.images };
  }
  _productIndex = index;
  return index;
}

async function getCollectionIndex() {
  if (_collectionIndex) return _collectionIndex;
  console.log('  Loading collection index from Shopify...');
  const env = loadEnv();
  const SHOP = env.SHOPIFY_STORE;
  const TOKEN = env.SHOPIFY_SECRET;
  const index = {};
  for (const type of ['custom_collections', 'smart_collections']) {
    const res = await fetch(`https://${SHOP}/admin/api/2025-01/${type}.json?limit=250`, {
      headers: { 'X-Shopify-Access-Token': TOKEN },
    });
    if (!res.ok) continue;
    const data = await res.json();
    const key = type === 'custom_collections' ? 'custom_collections' : 'smart_collections';
    for (const c of (data[key] || [])) {
      index[`/collections/${c.handle}`] = { collectionId: c.id, title: c.title, type };
    }
  }
  _collectionIndex = index;
  return index;
}

// ── Claude helpers ────────────────────────────────────────────────────────────

async function generateMetaDescription(title, url, existingMeta = '') {
  const context = existingMeta ? `Current (problematic) meta: "${existingMeta}"` : 'No current meta description.';
  const msg = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `Write a concise, compelling SEO meta description for this page.

Brand: ${config.name} — ${config.brand_description || 'natural skincare and personal care brand'}
Page title: ${title}
Page URL: ${url}
${context}

Rules:
- 140–155 characters (strictly)
- Include the primary keyword from the title naturally
- Include a subtle CTA (e.g., "Shop", "Discover", "Learn")
- No promotional fluff, no all-caps
- Return ONLY the meta description text, nothing else`,
    }],
  });
  return msg.content[0].text.trim().replace(/^["']|["']$/g, '');
}

async function generateSeoTitle(currentTitle, url) {
  const msg = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: `Write a concise SEO title tag for this page.

Brand: ${config.name}
Current title (too long): "${currentTitle}"
Page URL: ${url}

Rules:
- 50–60 characters maximum (strictly)
- Keep the primary keyword from the current title
- Format: [Keyword/Topic] – ${config.name}
- Return ONLY the title text, nothing else`,
    }],
  });
  return msg.content[0].text.trim().replace(/^["']|["']$/g, '');
}

async function generateAltText(imageUrl, pageTitle, pageUrl) {
  const msg = await claude.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 100,
    messages: [{
      role: 'user',
      content: `Write a concise, descriptive SEO alt text for an image on a ${config.name} blog post.

Image URL: ${imageUrl}
Page title: ${pageTitle}
Page URL: ${pageUrl}

Rules:
- 60–100 characters
- Describe what the image likely shows based on the filename and page context
- Include a relevant keyword naturally if it fits
- No "image of" or "photo of" prefix
- Return ONLY the alt text, nothing else`,
    }],
  });
  return msg.content[0].text.trim().replace(/^["']|["']$/g, '');
}

// ── COMMAND: audit ────────────────────────────────────────────────────────────

async function audit() {
  console.log('\nLoading crawl results from DataForSEO...\n');
  const csvs = getCrawl();

  const sections = [];

  sections.push(`# Technical SEO Audit Report — ${config.name}`);
  sections.push(`**Generated:** ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`);
  sections.push('');

  // ── ERRORS ──
  sections.push('## 🔴 Errors (Fix Immediately)\n');

  // 404 pages
  const p404 = csvs['Error-404_page'] || csvs['Error-4XX_page'] || [];
  const blogsWithLinks404 = p404.filter((r) => parseInt(r['no._of_all_inlinks'] || '0') > 0);
  sections.push(`### 1. Broken Pages (404) — ${p404.length} pages`);
  sections.push(`${blogsWithLinks404.length} have inbound internal links (create redirects). ${p404.length - blogsWithLinks404.length} are orphans.\n`);
  sections.push('**Fixable with:** `fix-links` + `create-redirects`');
  sections.push('| PR | URL | Inlinks |');
  sections.push('|----|-----|---------|');
  for (const r of p404.slice(0, 20)) {
    const inlinks = r['no._of_all_inlinks'] || '0';
    sections.push(`| ${r.pr} | ${r.url} | ${inlinks} |`);
  }
  if (p404.length > 20) sections.push(`\n*...and ${p404.length - 20} more*`);
  sections.push('');

  // Pages with links to broken pages
  // Filter out cdn-cgi/l/email-protection — Cloudflare obfuscates footer email addresses into this
  // URL, which Ahrefs flags as a 404. These are false positives in the site template, not fixable
  // by editing article body_html, and grow linearly with every new page published.
  const allLinksTo404 = csvs['Error-indexable-Page_has_links_to_broken_page'] || [];
  const linksTo404 = allLinksTo404.filter((r) => {
    // internal_outlinks_to_4xx contains the broken URL(s); internal_outlinks_codes_(4xx) contains the HTTP code
    const brokenUrl = r.internal_outlinks_to_4xx || r['internal_outlinks_codes_(4xx)'] || '';
    return !brokenUrl.includes('cdn-cgi/l/email-protection');
  });
  const cdnCgiCount = allLinksTo404.length - linksTo404.length;
  sections.push(`### 2. Pages Linking to 404s — ${linksTo404.length} pages`);
  sections.push('**Fixable with:** `fix-links`\n');
  if (cdnCgiCount > 0) {
    sections.push(`> ℹ️ ${cdnCgiCount} pages filtered out — they only link to \`cdn-cgi/l/email-protection\` (Cloudflare email obfuscation in site footer, not fixable via article content)\n`);
  }
  for (const r of linksTo404.slice(0, 15)) {
    const broken = r['internal_outlinks_codes_(4xx)'] || r.internal_outlinks_to_4xx || '';
    sections.push(`- ${r.url} → ${broken.split('\n')[0]}`);
  }
  if (linksTo404.length > 15) sections.push(`\n*...and ${linksTo404.length - 15} more*`);
  sections.push('');

  // Missing meta descriptions (errors = indexable pages)
  const metaMissing = csvs['Warning-indexable-Meta_description_tag_missing_or_empty'] || [];
  const blogMetaMissing = metaMissing.filter((r) => pageType(r.url) === 'article');
  const pageMetaMissing = metaMissing.filter((r) => pageType(r.url) === 'page');
  const productMetaMissing = metaMissing.filter((r) => ['product', 'collection'].includes(pageType(r.url)));
  sections.push(`### 3. Missing Meta Descriptions — ${metaMissing.length} indexable pages`);
  sections.push(`- Blog posts: ${blogMetaMissing.length} (fixable)`);
  sections.push(`- Pages: ${pageMetaMissing.length} (fixable)`);
  sections.push(`- Products/Collections: ${productMetaMissing.length} (**requires write_products scope**)\n`);
  sections.push('**Fixable with:** `fix-meta`\n');

  // Multiple meta descriptions / titles (errors)
  const multiMeta = csvs['Error-indexable-Multiple_meta_description_tags'] || [];
  const multiTitle = csvs['Error-indexable-Multiple_title_tags'] || [];
  sections.push(`### 4. Duplicate Tags — ${multiMeta.length} duplicate meta, ${multiTitle.length} duplicate title`);
  sections.push('These are theme-level issues requiring Liquid template edits — cannot be fixed via REST API.\n');
  if (multiMeta.length) {
    sections.push('Duplicate meta description pages:');
    for (const r of multiMeta) sections.push(`- ${r.url}`);
  }
  if (multiTitle.length) {
    sections.push('Duplicate title pages:');
    for (const r of multiTitle) sections.push(`- ${r.url}`);
  }
  sections.push('');

  // Orphan pages
  const orphans = csvs['Error-indexable-Orphan_page_(has_no_incoming_internal_links)'] || [];
  sections.push(`### 5. Orphan Pages — ${orphans.length} pages (no inbound internal links)`);
  sections.push('Requires manual cross-linking via the blog post writer or internal link auditor.\n');
  for (const r of orphans) sections.push(`- [${r.title || r.url}](${r.url})`);
  sections.push('');

  // ── WARNINGS ──
  sections.push('## 🟡 Warnings (Fix Soon)\n');

  // Meta description too long/short
  const metaTooLong = csvs['Warning-indexable-Meta_description_too_long'] || [];
  const metaTooShort = csvs['Warning-indexable-Meta_description_too_short'] || [];
  sections.push(`### 6. Meta Description Length Issues — ${metaTooLong.length} too long, ${metaTooShort.length} too short`);
  sections.push('**Fixable with:** `fix-meta`\n');
  if (metaTooLong.length) {
    sections.push('Too long (>160 chars):');
    for (const r of metaTooLong.slice(0, 10)) {
      sections.push(`- [${r.title?.split('\n')[0] || r.url}](${r.url}) — ${r.meta_description_length} chars`);
    }
  }
  if (metaTooShort.length) {
    sections.push('\nToo short (<70 chars):');
    for (const r of metaTooShort) {
      sections.push(`- [${r.title?.split('\n')[0] || r.url}](${r.url}) — ${r.meta_description_length} chars`);
    }
  }
  sections.push('');

  // Title too long
  const titleTooLong = csvs['Warning-indexable-Title_too_long'] || [];
  sections.push(`### 7. Title Tags Too Long — ${titleTooLong.length} pages`);
  sections.push('**Fixable with:** `fix-meta` (for blog posts and pages)\n');
  for (const r of titleTooLong.slice(0, 10)) {
    const t = r.title?.split('\n')[0] || r.url;
    sections.push(`- [${t.slice(0, 80)}...](${r.url}) — ${r.title_length} chars`);
  }
  sections.push('');

  // H1 issues
  const h1Missing = csvs['Warning-indexable-H1_tag_missing_or_empty'] || [];
  const multiH1 = csvs['Notice-indexable-Multiple_H1_tags'] || [];
  sections.push(`### 8. H1 Issues — ${h1Missing.length} missing, ${multiH1.length} multiple H1s`);
  sections.push('Blog post H1 issues are fixable by editing body_html.\n');
  if (h1Missing.length) {
    sections.push('Missing H1:');
    for (const r of h1Missing) sections.push(`- ${r.url}`);
  }
  sections.push('');

  // Links to redirected pages
  const linksToRedirect = csvs['Warning-indexable-Page_has_links_to_redirect'] || [];
  sections.push(`### 9. Internal Links to Redirected URLs — ${linksToRedirect.length} pages`);
  sections.push('**Fixable with:** `fix-redirects` (follows redirect chains and updates hrefs)\n');

  // Missing alt text
  const missingAlt = csvs['Warning-Missing_alt_text'] || [];
  const blogAlt = missingAlt.filter((r) => pageType(r.url) === 'article');
  const productAlt = missingAlt.filter((r) => ['product', 'collection'].includes(pageType(r.url)));
  sections.push(`### 10. Missing Image Alt Text — ${missingAlt.length} pages, ~${blogAlt.length} blog posts`);
  sections.push(`- Blog posts: ${blogAlt.length} (fixable via body_html)`);
  sections.push(`- Products: ${productAlt.length} (**requires write_products scope**)`);
  sections.push('**Fixable with:** `fix-alt-text`\n');

  // ── NOTICES ──
  sections.push('## 🔵 Notices (Review & Prioritise)\n');

  const redirectChain = csvs['Notice-Redirect_chain'] || [];
  sections.push(`### 11. Redirect Chains — ${redirectChain.length} chains`);
  sections.push('Each redirect hop costs PageRank. Flatten to single redirects.\n');
  for (const r of redirectChain.slice(0, 10)) sections.push(`- ${r.url}`);
  sections.push('');

  const notInSitemap = csvs['Notice-Indexable_page_not_in_sitemap'] || [];
  sections.push(`### 12. Indexable Pages Not in Sitemap — ${notInSitemap.length} pages`);
  sections.push('Shopify auto-generates the sitemap — these pages may use unusual handles or be excluded by the theme.\n');
  for (const r of notInSitemap.slice(0, 10)) sections.push(`- ${r.url}`);
  sections.push('');

  const singleLink = csvs['Notice-indexable-Page_has_only_one_dofollow_incoming_internal_link'] || [];
  sections.push(`### 13. Pages with Only 1 Inbound Internal Link — ${singleLink.length} pages`);
  sections.push('Prioritise higher-PR pages for additional cross-linking via the blog post writer.\n');

  // ── Additional Issues (remaining CSVs not covered above) ──
  const processedPrefixes = new Set([
    'Error-404', 'Error-4XX', 'Error-indexable-Page_has_links',
    'Warning-indexable-Meta_description', 'Warning-indexable-Title',
    'Warning-indexable-H1', 'Error-indexable-Orphan', 'Error-indexable-Multiple',
    'Warning-3XX', 'Notice-Redirect', 'Error-Broken_redirect',
    'Warning-Missing_alt', 'Error-Image_file_size',
    'Notice-indexable-Page_has_only_one_dofollow',
    'Notice-indexable-Not_in_sitemap',
  ]);

  const allCsvFiles = readdirSync(CSV_DIR).filter(f => f.endsWith('.csv'));
  const unprocessed = allCsvFiles.filter(f => {
    const base = f.replace('.csv', '');
    return !processedPrefixes.has(base) && !Array.from(processedPrefixes).some(p => base.startsWith(p));
  });

  if (unprocessed.length > 0) {
    sections.push('\n## ℹ️ Additional Issues\n');
    for (const f of unprocessed) {
      const rows = loadIssue(f.replace('.csv', ''));
      const cleanName = f.replace('.csv', '').replace(/^(Error|Warning|Notice)-/i, '').replace(/-/g, ' ').replace(/_/g, ' ');
      if (rows.length > 0) {
        sections.push(`### ℹ️ ${cleanName} (${rows.length})\n`);
      }
    }
  }

  // ── Summary ──
  sections.push('---');
  sections.push('## Summary\n');
  sections.push('| Priority | Issue | Count | Agent Command |');
  sections.push('|----------|-------|-------|---------------|');
  sections.push(`| 🔴 Error | Broken 404 pages | ${p404.length} | \`create-redirects\` |`);
  sections.push(`| 🔴 Error | Internal links to 404s | ${linksTo404.length} pages | \`fix-links\` |`);
  sections.push(`| 🔴 Error | Missing meta description | ${metaMissing.length} | \`fix-meta\` |`);
  sections.push(`| 🔴 Error | Duplicate meta/title tags | ${multiMeta.length + multiTitle.length} | Manual (theme) |`);
  sections.push(`| 🔴 Error | Orphan pages | ${orphans.length} | Manual (link building) |`);
  sections.push(`| 🟡 Warning | Meta description too long/short | ${metaTooLong.length + metaTooShort.length} | \`fix-meta\` |`);
  sections.push(`| 🟡 Warning | Title too long | ${titleTooLong.length} | \`fix-meta\` |`);
  sections.push(`| 🟡 Warning | H1 missing/multiple | ${h1Missing.length + multiH1.length} | Manual |`);
  sections.push(`| 🟡 Warning | Internal links to redirects | ${linksToRedirect.length} | \`fix-redirects\` |`);
  sections.push(`| 🟡 Warning | Missing alt text (blog posts) | ${blogAlt.length} | \`fix-alt-text\` |`);
  sections.push(`| 🔵 Notice | Redirect chains | ${redirectChain.length} | Manual |`);
  sections.push(`| 🔵 Notice | Not in sitemap | ${notInSitemap.length} | Investigate |`);
  sections.push('');
  sections.push('### Shopify API Scope Notes\n');
  sections.push('**Current scope:** `read_content`, `write_content`');
  sections.push('Covers: blog articles, static pages, URL redirects\n');
  sections.push('**Missing scope: `read_products`, `write_products`**');
  sections.push(`Required to fix: meta descriptions on ${productMetaMissing.length} collection/product pages, alt text on ${productAlt.length} product image pages\n`);
  sections.push('To add: Shopify Admin → Settings → Apps and sales channels → [your custom app] → Configuration → Access scopes');

  mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = join(REPORTS_DIR, 'technical-seo-audit.md');
  writeFileSync(reportPath, sections.join('\n'));
  console.log(`\n  Report saved: ${reportPath}`);
}

// ── COMMAND: create-redirects ─────────────────────────────────────────────────

async function createRedirects({ dryRun = false } = {}) {
  console.log('\n  Loading 404 pages...');
  const p404 = loadIssue('Error-404_page');
  const pagesWithLinks = p404.filter((r) => {
    const inlinks = parseInt(r['no._of_all_inlinks'] || '0');
    if (inlinks === 0) return false;
    // Cloudflare email-obfuscation URL: lives in the theme footer, served by
    // a CF worker, returns 4xx to crawlers but isn't a real broken page.
    if (r.url?.includes('cdn-cgi/l/email-protection')) return false;
    return true;
  });

  console.log(`  ${pagesWithLinks.length} broken pages with inbound links\n`);

  // Load existing redirects to avoid duplicates
  const existing = await getRedirects();
  const existingPaths = new Set(existing.map((r) => r.path));

  // Load blog index to find best redirect targets
  const articleIndex = await getArticleIndex();
  const validPaths = new Set(Object.keys(articleIndex));

  let created = 0;
  let skipped = 0;

  for (const row of pagesWithLinks) {
    const fromPath = urlPath(row.url);
    if (existingPaths.has(fromPath)) {
      console.log(`  [SKIP] Redirect already exists: ${fromPath}`);
      skipped++;
      continue;
    }

    const type = pageType(row.url);

    // Determine best redirect target based on slug similarity
    let target = null;
    if (type === 'article') {
      // Try to find a matching article by slug words
      const slugWords = fromPath.split('/').pop().split('-').filter((w) => w.length > 3);
      let bestMatch = null;
      let bestScore = 0;
      for (const [path] of Object.entries(articleIndex)) {
        if (path === fromPath) continue; // exclude self
        const score = slugWords.filter((w) => path.includes(w)).length;
        if (score > bestScore) { bestScore = score; bestMatch = path; }
      }
      if (bestScore >= 2) target = bestMatch;
      else target = '/blogs/news'; // fallback to blog index
    } else if (type === 'product') {
      target = '/collections/all';
    } else {
      target = '/';
    }

    console.log(`  ${dryRun ? '[DRY RUN] ' : ''}${fromPath} → ${target}`);
    if (!dryRun) {
      try {
        await createRedirect(fromPath, target);
        created++;
      } catch (e) {
        console.log(`    Error: ${e.message}`);
      }
    } else {
      created++;
    }
  }

  console.log(`\n  ${dryRun ? 'Would create' : 'Created'}: ${created} redirects, skipped: ${skipped}`);
}

// ── COMMAND: prune-zombies ────────────────────────────────────────────────────
//
// A "zombie" redirect is one whose source path returns 200 directly — Shopify's
// redirect table entry never fires because the live page (product/collection/
// article reborn at the same handle) takes precedence. These zombies do nothing
// in the browser but block any new redirect from targeting them ("can't
// redirect to another redirect" 422 from Shopify's POST /redirects.json).
//
// Categorisation by what HEAD returns at the source path (with manual redirect):
//   200      → ZOMBIE (auto-delete: live page wins, redirect is dead weight)
//   3xx→target → ACTIVE (redirect firing as configured)
//   3xx→other  → DRIFT  (target changed elsewhere — surface, do not delete)
//   4xx/5xx  → BROKEN_REDIRECT (source dead AND redirect not catching — surface)

// Pulls every <loc> URL from the live sitemap index + child sitemaps and
// returns a Set of pathnames. The live sitemap is authoritative — derived
// data/sitemap-index.json drifts (typically days to weeks stale) so we don't
// trust it for destructive operations.
async function loadCanonicalSitemapPaths() {
  const base = config.url.replace(/\/$/, '');
  async function fetchXml(url) {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEO-Claude-Bot/1.0)' } });
    if (!r.ok) throw new Error(`sitemap ${url} → ${r.status}`);
    return r.text();
  }
  const indexXml = await fetchXml(`${base}/sitemap.xml`);
  const childUrls = [...indexXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  const paths = new Set();
  for (const child of childUrls) {
    try {
      const xml = await fetchXml(child);
      for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
        const u = m[1].replace(/&amp;/g, '&');
        try { paths.add(new URL(u).pathname.replace(/\/$/, '') || '/'); }
        catch { /* skip malformed */ }
      }
    } catch (e) { console.log(`    [warn] sitemap fetch failed: ${child} — ${e.message}`); }
  }
  return paths;
}

async function pruneZombies({ dryRun = false } = {}) {
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const onlyPaths = onlyArg ? new Set(onlyArg.slice('--only='.length).split(',').map((s) => s.trim())) : null;
  const includeSuspicious = args.includes('--include-suspicious');

  console.log('\n  Fetching live sitemap for canonical-URL verification...');
  let canonicalPaths;
  try {
    canonicalPaths = await loadCanonicalSitemapPaths();
    console.log(`    ${canonicalPaths.size} URLs in live sitemap`);
  } catch (e) {
    console.error(`    Sitemap fetch FAILED: ${e.message}`);
    console.error('    Refusing to proceed without canonical verification.');
    process.exit(1);
  }

  console.log('\n  Loading redirect table from Shopify...');
  let redirects = await getRedirects();
  if (onlyPaths) {
    redirects = redirects.filter((r) => onlyPaths.has(r.path));
    console.log(`    Filtered to ${redirects.length} of ${onlyPaths.size} requested paths`);
  } else {
    console.log(`    ${redirects.length} redirects to audit`);
  }

  const UA = 'Mozilla/5.0 (compatible; SEO-Claude-Bot/1.0; redirect-audit)';
  const base = config.url.replace(/\/$/, '');

  async function probe(path, attempt = 0) {
    const url = base + path;
    try {
      const r = await fetch(url, { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': UA } });
      // Retry rate-limit AND 5xx — Shopify often 503s under load and these
      // are not "broken redirects," they're transient. Without retry we'd
      // delete or surface live redirects as if they were dead.
      if ((r.status === 429 || r.status >= 500) && attempt < 3) {
        await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
        return probe(path, attempt + 1);
      }
      return { status: r.status, location: r.headers.get('location') || '' };
    } catch (e) { return { status: null, error: e.message }; }
  }

  const zombies = [];           // 200 + in sitemap → CONFIRMED, auto-delete
  const suspicious = [];        // 200 + NOT in sitemap → MEDIUM, surface for review
  const drifted = [];
  const broken = [];
  const active = [];
  const errored = [];

  let idx = 0;
  async function worker() {
    while (idx < redirects.length) {
      const r = redirects[idx++];
      const probed = await probe(r.path);
      if (probed.status == null) { errored.push({ ...r, error: probed.error }); }
      else if (probed.status === 200) {
        const norm = r.path.replace(/\/$/, '') || '/';
        const inSitemap = canonicalPaths.has(norm);
        if (inSitemap) zombies.push({ ...r, observed: 200, in_sitemap: true });
        else suspicious.push({ ...r, observed: 200, in_sitemap: false });
      }
      else if (probed.status >= 300 && probed.status < 400) {
        const loc = probed.location || '';
        // Compare normalising trailing slash and protocol/host
        const target = r.target.replace(/\/$/, '');
        const locPath = loc.replace(/^https?:\/\/[^/]+/, '').replace(/\/$/, '');
        if (locPath === target || loc.endsWith(target)) active.push(r);
        else drifted.push({ ...r, observed_location: loc });
      } else if (probed.status >= 400) {
        broken.push({ ...r, observed: probed.status });
      } else {
        errored.push({ ...r, observed: probed.status });
      }
      await new Promise((res) => setTimeout(res, 200));
    }
  }
  console.log('\n  Probing each source path (concurrency=4, 200ms gap)...');
  await Promise.all(Array(4).fill(0).map(worker));

  console.log(`\n  Results:`);
  console.log(`    ZOMBIE (in sitemap)     ${zombies.length}  ← auto-delete candidates`);
  console.log(`    SUSPICIOUS (200, no sitemap) ${suspicious.length}  ← review (use --include-suspicious to delete)`);
  console.log(`    ACTIVE                  ${active.length}`);
  console.log(`    DRIFT                   ${drifted.length}  (target changed — review)`);
  console.log(`    BROKEN_REDIRECT         ${broken.length}  (source dead, redirect not firing — review)`);
  console.log(`    ERROR                   ${errored.length}`);

  const toDelete = includeSuspicious ? [...zombies, ...suspicious] : zombies;
  if (toDelete.length > 0) {
    console.log(`\n  ${dryRun ? 'Would delete' : 'Deleting'} (${toDelete.length})${includeSuspicious ? ' — including suspicious' : ''}:`);
    let deleted = 0;
    for (const z of toDelete) {
      console.log(`    ${dryRun ? '[DRY RUN] ' : ''}${z.path}  →  ${z.target}  ${z.in_sitemap ? '[in sitemap]' : '[NOT in sitemap]'}`);
      if (!dryRun) {
        try { await deleteRedirect(z.id); deleted++; }
        catch (e) { console.log(`      ERROR deleting: ${e.message}`); }
      } else { deleted++; }
    }
    console.log(`\n  ${dryRun ? 'Would delete' : 'Deleted'}: ${deleted} redirects`);
  }

  if (suspicious.length > 0 && !includeSuspicious) {
    console.log(`\n  Suspicious (200 but NOT in live sitemap — review):`);
    for (const s of suspicious) console.log(`    ${s.path}  →  ${s.target}`);
  }

  if (drifted.length > 0) {
    console.log(`\n  Drifted (target changed since redirect was created — manual review):`);
    for (const d of drifted) console.log(`    ${d.path}  →  configured: ${d.target}  |  observed: ${d.observed_location}`);
  }
  if (broken.length > 0) {
    console.log(`\n  Broken redirects (source ${broken[0].observed}, but Shopify isn't firing the redirect):`);
    for (const b of broken) console.log(`    ${b.path}  →  ${b.target}  (source returns ${b.observed})`);
  }

  // Persist a report so the daily digest / reviewer can pick it up
  mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = join(REPORTS_DIR, 'redirect-audit.json');
  writeFileSync(reportPath, JSON.stringify({
    audited_at: new Date().toISOString(),
    dry_run: dryRun,
    sitemap_size: canonicalPaths.size,
    total_audited: redirects.length,
    counts: { zombies: zombies.length, suspicious: suspicious.length, active: active.length, drifted: drifted.length, broken: broken.length, errored: errored.length },
    zombies: zombies.map((z) => ({ id: z.id, path: z.path, target: z.target })),
    suspicious: suspicious.map((s) => ({ id: s.id, path: s.path, target: s.target })),
    drifted, broken, errored,
  }, null, 2));
  console.log(`\n  Report saved: ${reportPath}`);
}

// ── COMMAND: fix-links ────────────────────────────────────────────────────────

async function fixBrokenLinks({ dryRun = false } = {}) {
  console.log('\n  Loading pages with links to 404s...');
  const rows = loadIssue('Error-indexable-Page_has_links_to_broken_page');

  // Also load link details
  const linkRows = loadIssue('Error-indexable-Page_has_links_to_broken_page-links');
  // Build: sourceUrl → Set of broken hrefs
  // Skip cdn-cgi/l/email-protection — Cloudflare obfuscates footer email addresses into this URL.
  // Ahrefs flags it as a 404 on every page with the footer email. It lives in the theme template,
  // not in article body_html, so it cannot be fixed by editing article content.
  const brokenBySource = {};
  for (const r of linkRows) {
    const src = r.source_url || r.source || r.url || '';
    const target = r.target_url || r.url_to || r.target || r.broken_url || '';
    if (!src || !target) continue;
    if (target.includes('cdn-cgi/l/email-protection')) continue;
    if (!brokenBySource[src]) brokenBySource[src] = new Set();
    brokenBySource[src].add(target);
  }

  // If link file format differs, fall back to parsing the broken URL column from main file
  if (Object.keys(brokenBySource).length === 0) {
    for (const r of rows) {
      const src = r.url;
      const targets = (r['internal_outlinks_codes_(4xx)'] || r.internal_outlinks_to_4xx || '')
        .split('\n').map((s) => s.trim()).filter(Boolean);
      if (src && targets.length) {
        brokenBySource[src] = new Set(targets);
      }
    }
  }

  const articleIndex = await getArticleIndex();
  const blogs = await getBlogs();
  const blogByHandle = {};
  for (const blog of blogs) blogByHandle[blog.handle] = blog.id;

  console.log(`  ${rows.length} pages to process\n`);
  let fixed = 0;

  for (const row of rows) {
    const src = row.url;
    const type = pageType(src);
    if (!['article', 'page', 'product', 'collection'].includes(type)) {
      continue; // silently skip non-fixable types
    }

    const brokenSet = brokenBySource[src] || new Set();
    if (brokenSet.size === 0) continue; // no broken link details

    // Load body from the appropriate resource
    let body = '';
    let resourceId = null;
    let blogId = null;

    const path = urlPath(src);
    let resourceType = type;
    if (type === 'article') {
      const entry = articleIndex[path];
      if (!entry) continue;
      blogId = entry.blogId;
      resourceId = entry.articleId;
      const full = await getArticle(blogId, resourceId);
      body = full.body_html || '';
    } else if (type === 'page') {
      const pIdx = await getPageIndex();
      const entry = pIdx[path];
      if (!entry) continue;
      resourceId = entry.pageId;
      body = (await getPage(resourceId)).body_html || '';
    } else if (type === 'product') {
      const handle = path.split('/').pop();
      const products = await getProducts({ handle });
      if (!products[0]) continue;
      resourceId = products[0].id;
      body = products[0].body_html || '';
    } else if (type === 'collection') {
      const handle = path.split('/').pop();
      const [custom, smart] = await Promise.all([getCustomCollections({ handle }), getSmartCollections({ handle })]);
      const col = custom[0] || smart[0];
      if (!col) continue;
      resourceId = col.id;
      resourceType = custom[0] ? 'custom_collection' : 'smart_collection';
      body = col.body_html || '';
    }

    const $ = cheerio.load(body);
    let changes = 0;

    $('a[href]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;

      // Match both absolute and relative versions
      const hrefPath = href.startsWith('http') ? urlPath(href) : href.replace(/\/$/, '');
      const isBroken = [...brokenSet].some((b) => {
        const bp = b.startsWith('http') ? urlPath(b) : b.replace(/\/$/, '');
        return bp === hrefPath;
      });

      if (!isBroken) return;

      // Try to find a matching live article
      const slugWords = hrefPath.split('/').pop().split('-').filter((w) => w.length > 3);
      let bestMatch = null;
      let bestScore = 0;
      for (const [path] of Object.entries(articleIndex)) {
        const score = slugWords.filter((w) => path.includes(w)).length;
        if (score > bestScore) { bestScore = score; bestMatch = `${config.url}${path}`; }
      }

      if (bestScore >= 2 && bestMatch) {
        console.log(`    Fix: ${href} → ${bestMatch}`);
        $(el).attr('href', bestMatch);
      } else {
        // Remove the link, keep anchor text
        $(el).replaceWith($(el).text());
        console.log(`    Remove: ${href} (no match found)`);
      }
      changes++;
    });

    if (changes === 0) {
      console.log(`  [OK]  ${urlPath(src)} — no broken links found in body`);
      continue;
    }

    const newBody = $('body').html() || body;
    console.log(`  ${dryRun ? '[DRY RUN] ' : ''}${urlPath(src)} — ${changes} link(s) fixed`);

    if (!dryRun) {
      try {
        if (type === 'article') await updateArticle(blogId, resourceId, { body_html: newBody });
        else if (type === 'page') await updatePage(resourceId, { body_html: newBody });
        else if (type === 'product') await updateProduct(resourceId, { body_html: newBody });
        else if (resourceType === 'custom_collection') await updateCustomCollection(resourceId, { body_html: newBody });
        else if (resourceType === 'smart_collection') await updateSmartCollection(resourceId, { body_html: newBody });
        fixed++;
      } catch (e) {
        console.log(`    Error: ${e.message}`);
      }
    } else {
      fixed++;
    }
  }

  console.log(`\n  ${dryRun ? 'Would fix' : 'Fixed'}: ${fixed} pages`);
}

// ── COMMAND: fix-redirects ────────────────────────────────────────────────────

async function fixRedirectLinks({ dryRun = false } = {}) {
  console.log('\n  Loading pages with links to redirected URLs...');
  const rows = loadIssue('Warning-indexable-Page_has_links_to_redirect');

  // Build source → broken redirect hrefs map from the -links file
  const linkRows = loadIssue('Warning-indexable-Page_has_links_to_redirect-links');
  const redirectBySource = {};
  for (const r of linkRows) {
    const src = r.source_url || r.source || r.url || '';
    const target = r.target_url || r.url_to || r.target || '';
    if (!src || !target) continue;
    if (!redirectBySource[src]) redirectBySource[src] = new Set();
    redirectBySource[src].add(target);
  }

  // Also fall back to parsing from main file
  if (Object.keys(redirectBySource).length === 0) {
    for (const r of rows) {
      const src = r.url;
      const targets = (r['internal_outlinks_codes_(3xx)'] || r.internal_outlinks_to_3xx || '')
        .split('\n').map((s) => s.trim()).filter(Boolean);
      if (src && targets.length) redirectBySource[src] = new Set(targets);
    }
  }

  // Load existing Shopify redirects to build resolution map
  console.log('  Loading Shopify redirect table...');
  const redirects = await getRedirects();
  const redirectMap = {};
  for (const r of redirects) {
    redirectMap[r.path] = r.target.startsWith('http') ? r.target : `${config.url}${r.target}`;
  }

  // Also resolve via HTTP follow (for external redirects)
  async function resolveRedirect(url) {
    const path = urlPath(url);
    if (redirectMap[path]) return redirectMap[path];
    try {
      const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(5000) });
      return res.url !== url ? res.url : null;
    } catch { return null; }
  }

  const articleIndex = await getArticleIndex();
  const pageIdx = await getPageIndex();
  console.log(`  ${rows.length} pages to process\n`);
  let fixed = 0;

  for (const row of rows) {
    const src = row.url;
    const type = pageType(src);
    if (!['article', 'page', 'collection', 'product'].includes(type)) { console.log(`  [SKIP] ${type}: ${src}`); continue; }

    const redirectSet = redirectBySource[src] || new Set();
    if (redirectSet.size === 0) { console.log(`  [SKIP] No redirect details for: ${urlPath(src)}`); continue; }

    let body = '';
    let resourceId = null;
    let blogId = null;
    let resourceType = null;

    if (type === 'article') {
      const path = urlPath(src);
      const entry = articleIndex[path];
      if (!entry) { console.log(`  [SKIP] Article not found: ${path}`); continue; }
      blogId = entry.blogId;
      resourceId = entry.articleId;
      const full = await getArticle(blogId, resourceId);
      body = full.body_html || '';
    } else if (type === 'page') {
      const path = urlPath(src);
      const entry = pageIdx[path];
      if (!entry) { console.log(`  [SKIP] Page not found: ${path}`); continue; }
      resourceId = entry.pageId;
      const full = await getPage(resourceId);
      body = full.body_html || '';
    } else if (type === 'collection') {
      const handle = urlPath(src).split('/').pop();
      const [custom, smart] = await Promise.all([
        getCustomCollections({ handle }),
        getSmartCollections({ handle }),
      ]);
      const col = custom[0] || smart[0];
      if (!col) { console.log(`  [SKIP] Collection not found: ${handle}`); continue; }
      body = col.body_html || '';
      resourceId = col.id;
      resourceType = custom[0] ? 'custom_collection' : 'smart_collection';
    } else if (type === 'product') {
      const handle = urlPath(src).split('/').pop();
      const products = await getProducts({ handle });
      if (!products[0]) { console.log(`  [SKIP] Product not found: ${handle}`); continue; }
      body = products[0].body_html || '';
      resourceId = products[0].id;
      resourceType = 'product';
    }

    const $ = cheerio.load(body);
    let changes = 0;

    for (const redirectUrl of redirectSet) {
      const final = await resolveRedirect(redirectUrl);
      if (!final || final === redirectUrl) continue;

      const redirectPath = urlPath(redirectUrl);

      $('a[href]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;
        const hrefPath = href.startsWith('http') ? urlPath(href) : href;
        if (hrefPath === redirectPath || href === redirectUrl) {
          $(el).attr('href', final);
          changes++;
          console.log(`    Update: ${redirectUrl} → ${final}`);
        }
      });
    }

    if (changes === 0) { console.log(`  [OK]  ${urlPath(src)}`); continue; }

    const newBody = $('body').html() || body;
    console.log(`  ${dryRun ? '[DRY RUN] ' : ''}${urlPath(src)} — ${changes} redirect link(s) updated`);

    if (!dryRun) {
      if (type === 'article') {
        await updateArticle(blogId, resourceId, { body_html: newBody });
      } else if (type === 'page') {
        await updatePage(resourceId, { body_html: newBody });
      } else if (resourceType === 'custom_collection') {
        await updateCustomCollection(resourceId, { body_html: newBody });
      } else if (resourceType === 'smart_collection') {
        await updateSmartCollection(resourceId, { body_html: newBody });
      } else if (type === 'product') {
        await updateProduct(resourceId, { body_html: newBody });
      }
      fixed++;
    } else { fixed++; }
  }

  console.log(`\n  ${dryRun ? 'Would fix' : 'Fixed'}: ${fixed} pages`);
}

// ── COMMAND: fix-meta ─────────────────────────────────────────────────────────

async function fixMeta({ dryRun = false } = {}) {
  console.log('\n  Collecting meta description issues...');

  const missing = loadIssue('Warning-indexable-Meta_description_tag_missing_or_empty');
  const tooLong = loadIssue('Warning-indexable-Meta_description_too_long');
  const tooShort = loadIssue('Warning-indexable-Meta_description_too_short');

  // Combine all: missing + bad length
  const all = [
    ...missing.map((r) => ({ ...r, issue: 'missing' })),
    ...tooLong.map((r) => ({ ...r, issue: 'too_long' })),
    ...tooShort.map((r) => ({ ...r, issue: 'too_short' })),
  ];

  // Deduplicate by URL (prefer missing > too_long > too_short)
  const seen = new Set();
  const toFix = [];
  for (const r of all) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);

    const path = urlPath(r.url);
    // Skip unfixable URLs before processing
    if (path.includes('/tagged/')) continue;                        // tag listing pages — not editable
    if (path === '/blogs/news' || path === '/blogs/news/') continue; // blog index
    if (path === '/' || path === '') continue;                      // homepage
    if (path === '/collections' || path === '/collections/') continue; // collections index
    if (path === '/collections/all') continue;                      // all-products page

    const type = pageType(r.url);
    if (!['article', 'page', 'product', 'collection'].includes(type)) continue;

    toFix.push(r);
  }

  const articleIndex = await getArticleIndex();
  const pageIdx = await getPageIndex();
  const productIdx = await getProductIndex();
  const collectionIdx = await getCollectionIndex();

  const env = loadEnv();
  const SHOP = env.SHOPIFY_STORE;
  const TOKEN = env.SHOPIFY_SECRET;

  console.log(`  ${toFix.length} fixable pages with meta description issues (${all.length - toFix.length} unfixable filtered)\n`);
  let fixed = 0;

  for (const row of toFix) {
    const type = pageType(row.url);
    const path = urlPath(row.url);
    const pageTitle = row.title?.split('\n')[0] || path;
    const existingMeta = row.meta_description || '';

    process.stdout.write(`  ${path} [${row.issue}] → generating meta... `);
    const newMeta = await generateMetaDescription(pageTitle, row.url, existingMeta);
    console.log(`(${newMeta.length} chars)`);

    if (!dryRun) {
      try {
        if (type === 'article') {
          const entry = articleIndex[path];
          if (!entry) { console.log(`    [SKIP] Article not found`); continue; }
          await updateArticle(entry.blogId, entry.articleId, { summary_html: `<p>${newMeta}</p>` });
          fixed++;
        } else if (type === 'page') {
          const entry = pageIdx[path];
          if (!entry) { console.log(`    [SKIP] Page not found`); continue; }
          await upsertMetafield('pages', entry.pageId, 'global', 'description_tag', newMeta);
          fixed++;
        } else if (type === 'product') {
          const entry = productIdx[path];
          if (!entry) { console.log(`    [SKIP] Product not found`); continue; }
          await upsertMetafield('products', entry.productId, 'global', 'description_tag', newMeta);
          fixed++;
        } else if (type === 'collection') {
          const entry = collectionIdx[path];
          if (!entry) { console.log(`    [SKIP] Collection not found`); continue; }
          const resource = entry.type === 'custom_collections' ? 'custom_collections' : 'smart_collections';
          await upsertMetafield(resource, entry.collectionId, 'global', 'description_tag', newMeta);
          fixed++;
        }
      } catch (e) {
        console.log(`    Error: ${e.message}`);
      }
    } else {
      console.log(`    Would set: "${newMeta}"`);
      fixed++;
    }
  }

  console.log(`\n  ${dryRun ? 'Would fix' : 'Fixed'}: ${fixed} meta descriptions`);

  // ── Title tags too long ──────────────────────────────────────────────────
  console.log('\n  Collecting title tag issues...');
  const titleTooLong = loadIssue('Warning-indexable-Title_too_long');
  const titleToFix = titleTooLong.filter((r) => ['product', 'collection'].includes(pageType(r.url)));
  console.log(`  ${titleToFix.length} products/collections with title tags too long\n`);
  let titleFixed = 0;

  for (const row of titleToFix) {
    const type = pageType(row.url);
    const path = urlPath(row.url);
    const currentTitle = row.title?.split('\n')[0] || path;
    process.stdout.write(`  ${path} [title_too_long] → generating title... `);
    const newTitle = await generateSeoTitle(currentTitle, row.url);
    console.log(`(${newTitle.length} chars)`);

    if (!dryRun) {
      try {
        if (type === 'product') {
          const entry = productIdx[path];
          if (!entry) { console.log(`    [SKIP] Product not found`); continue; }
          await upsertMetafield('products', entry.productId, 'global', 'title_tag', newTitle);
          titleFixed++;
        } else if (type === 'collection') {
          const entry = collectionIdx[path];
          if (!entry) { console.log(`    [SKIP] Collection not found`); continue; }
          const resource = entry.type === 'custom_collections' ? 'custom_collections' : 'smart_collections';
          await upsertMetafield(resource, entry.collectionId, 'global', 'title_tag', newTitle);
          titleFixed++;
        }
      } catch (e) {
        console.log(`    Error: ${e.message}`);
      }
    } else {
      console.log(`    Would set: "${newTitle}"`);
      titleFixed++;
    }
  }

  console.log(`\n  ${dryRun ? 'Would fix' : 'Fixed'}: ${titleFixed} title tags`);
}

// ── COMMAND: fix-alt-text ─────────────────────────────────────────────────────

async function fixAltText({ dryRun = false } = {}) {
  console.log('\n  Loading pages with missing alt text...');
  const rows = loadIssue('Warning-Missing_alt_text');

  const articleRows = rows.filter((r) => pageType(r.url) === 'article');
  const productRows = rows.filter((r) => pageType(r.url) === 'product');
  console.log(`  ${articleRows.length} blog posts, ${productRows.length} product pages with missing alt text\n`);

  const articleIndex = await getArticleIndex();
  const productIdx = await getProductIndex();
  let fixed = 0;

  // ── Blog post images (in body_html) ──────────────────────────────────────
  for (const row of articleRows) {
    const path = urlPath(row.url);
    const entry = articleIndex[path];
    if (!entry) { console.log(`  [SKIP] Article not found: ${path}`); continue; }

    const article = await getArticle(entry.blogId, entry.articleId);
    const body = article.body_html || '';
    const $ = cheerio.load(body);

    const imgs = $('img').filter((_, el) => {
      const alt = $(el).attr('alt');
      return !alt || alt.trim() === '';
    });

    if (imgs.length === 0) { console.log(`  [OK]  ${path}`); continue; }

    console.log(`  ${path} — ${imgs.length} image(s) without alt text`);

    let changes = 0;
    for (let i = 0; i < imgs.length; i++) {
      const el = imgs[i];
      const src = $(el).attr('src') || '';
      process.stdout.write(`    img ${i + 1}/${imgs.length}: generating alt... `);
      const alt = await generateAltText(src, article.title, row.url);
      console.log(`"${alt}"`);
      $(el).attr('alt', alt);
      changes++;
    }

    const newBody = $('body').html() || body;
    console.log(`  ${dryRun ? '[DRY RUN] ' : ''}${path} — ${changes} alt text(s) added`);

    if (!dryRun) {
      try {
        await updateArticle(entry.blogId, entry.articleId, { body_html: newBody });
        fixed++;
      } catch (e) {
        console.log(`    Error: ${e.message}`);
      }
    } else { fixed++; }
  }

  // ── Product images (via Shopify product images API) ──────────────────────
  for (const row of productRows) {
    const path = urlPath(row.url);
    const entry = productIdx[path];
    if (!entry) { console.log(`  [SKIP] Product not found: ${path}`); continue; }

    const imagesWithoutAlt = (entry.images || []).filter((img) => !img.alt || img.alt.trim() === '');
    if (imagesWithoutAlt.length === 0) { console.log(`  [OK]  ${path}`); continue; }

    console.log(`  ${path} — ${imagesWithoutAlt.length} product image(s) without alt text`);

    for (let i = 0; i < imagesWithoutAlt.length; i++) {
      const img = imagesWithoutAlt[i];
      process.stdout.write(`    img ${i + 1}/${imagesWithoutAlt.length}: generating alt... `);
      const alt = await generateAltText(img.src || '', entry.title, row.url);
      console.log(`"${alt}"`);

      if (!dryRun) {
        try {
          await updateProductImage(entry.productId, img.id, { alt });
          fixed++;
        } catch (e) {
          console.log(`    Error: ${e.message}`);
        }
      } else { fixed++; }
    }
  }

  // ── Hero images in Shopify Files ─────────────────────────────────────────
  console.log('\n  Checking hero images in Shopify Files...');
  const POSTS_DIR = join(ROOT, 'data', 'posts');
  const postFiles = existsSync(POSTS_DIR)
    ? readdirSync(POSTS_DIR).filter((f) => f.endsWith('.json'))
    : [];

  // Build a map of CDN URL (without query string) → post metadata
  const cdnToPost = new Map();
  for (const f of postFiles) {
    try {
      const meta = JSON.parse(readFileSync(join(POSTS_DIR, f), 'utf8'));
      if (meta.shopify_image_url) {
        const baseUrl = meta.shopify_image_url.split('?')[0];
        cdnToPost.set(baseUrl, meta);
      }
    } catch { /* skip */ }
  }

  if (cdnToPost.size === 0) {
    console.log('  No posts with hero images found.');
  } else {
    const allFiles = await getAllFiles();
    const heroFiles = allFiles.filter((f) => {
      const baseUrl = f.url.split('?')[0];
      return cdnToPost.has(baseUrl);
    });

    const missingAlt = heroFiles.filter((f) => !f.alt || f.alt.trim() === '');
    console.log(`  ${heroFiles.length} hero image(s) found, ${missingAlt.length} missing alt text\n`);

    for (const file of missingAlt) {
      const baseUrl = file.url.split('?')[0];
      const meta = cdnToPost.get(baseUrl);
      process.stdout.write(`  ${meta.target_keyword || meta.title}: generating alt... `);
      const alt = await generateAltText(file.url, meta.title, meta.shopify_url || '');
      console.log(`"${alt}"`);

      if (!dryRun) {
        try {
          await updateFileAlt(file.id, alt);
          fixed++;
        } catch (e) {
          console.log(`    Error: ${e.message}`);
        }
      } else { fixed++; }
    }
  }

  // ── Fix Shopify Files alt text (from Ahrefs missing alt CSV) ─────────────
  console.log('\n  Checking Shopify Files for missing alt text...');
  const altLinkRows = loadIssue('Warning-Missing_alt_text-links');
  const missingAltUrls = new Set(altLinkRows
    .filter(r => (r.alt_attribute || r.alt || '') === '')
    .map(r => r.target_url || r.url || '')
    .filter(u => u.includes('cdn.shopify.com') || u.includes('cdn/shop'))
  );

  {
    console.log(`  ${missingAltUrls.size} CDN images flagged by Ahrefs. Checking all Shopify Files...`);
    const allFiles = await getAllFiles();
    const filesWithoutAlt = allFiles.filter(f => !f.alt || !f.alt.trim());
    const totalToFix = filesWithoutAlt.length;
    console.log(`  ${totalToFix} Shopify Files have no alt text`);
    let fileFixed = 0;
    let fileErrors = 0;
    const startTime = Date.now();

    // Write progress file so the dashboard can show a live progress bar
    const progressPath = join(REPORTS_DIR, 'alt-text-progress.json');
    function writeProgress() {
      const elapsed = Date.now() - startTime;
      const rate = fileFixed > 0 ? elapsed / fileFixed : 0; // ms per file
      const remaining = (totalToFix - fileFixed - fileErrors) * rate;
      try {
        writeFileSync(progressPath, JSON.stringify({
          status: 'running',
          started_at: new Date(startTime).toISOString(),
          completed: fileFixed,
          errors: fileErrors,
          total: totalToFix,
          elapsed_ms: elapsed,
          estimated_remaining_ms: Math.round(remaining),
          updated_at: new Date().toISOString(),
        }));
      } catch { /* ignore */ }
    }

    writeProgress();

    for (const file of filesWithoutAlt) {
      const fileUrlBase = file.url.split('?')[0];

      // Generate alt text from the filename
      const filename = fileUrlBase.split('/').pop().replace(/\.[^.]+$/, '').replace(/[_-]/g, ' ');
      const altText = filename.length > 5 ? filename : 'Product image';

      if (!dryRun) {
        try {
          await updateFileAlt(file.id, altText);
          fileFixed++;
          if (fileFixed % 10 === 0) {
            writeProgress();
            console.log(`  Progress: ${fileFixed}/${totalToFix} files updated...`);
          }
        } catch (e) {
          fileErrors++;
          console.log(`    Error: ${e.message}`);
          if (e.message?.includes('429') || e.message?.includes('Throttled')) {
            console.log('    Rate limited — waiting 5s...');
            await new Promise(r => setTimeout(r, 5000));
          }
        }
      } else {
        fileFixed++;
      }
    }

    // Write final progress
    try {
      writeFileSync(progressPath, JSON.stringify({
        status: 'complete',
        started_at: new Date(startTime).toISOString(),
        completed: fileFixed,
        errors: fileErrors,
        total: totalToFix,
        elapsed_ms: Date.now() - startTime,
        estimated_remaining_ms: 0,
        updated_at: new Date().toISOString(),
      }));
    } catch { /* ignore */ }

    console.log(`  ${dryRun ? 'Would fix' : 'Fixed'}: ${fileFixed} Shopify Files alt text`);
    fixed += fileFixed;
  }

  console.log(`\n  ${dryRun ? 'Would fix' : 'Fixed'}: ${fixed} images across blog posts, products, hero files, and Shopify Files`);
}

// ── COMMAND: fix-ai-content ───────────────────────────────────────────────────

async function fixAiContent({ dryRun = false } = {}) {
  const AI_DETECTION_DIR = join(ROOT, 'data', 'ai-detection');

  // Load all CSVs from data/ai-detection/
  let rows = [];
  try {
    const files = readdirSync(AI_DETECTION_DIR).filter((f) => f.endsWith('.csv'));
    for (const f of files) {
      rows.push(...parseCSV(readFileSync(join(AI_DETECTION_DIR, f), 'utf8')));
    }
  } catch {
    console.log('  No files found in data/ai-detection/');
    return;
  }

  // Filter to High/Very high AI content, collections and pages only
  const toFix = rows.filter((r) => {
    const level = (r.ai_content_level || '').toLowerCase();
    return (level === 'high' || level === 'very high') && ['collection', 'page'].includes(pageType(r.url));
  });

  console.log(`\n  ${toFix.length} pages with high AI content to rewrite\n`);

  const collectionIdx = await getCollectionIndex();
  const pageIdx = await getPageIndex();
  const env = loadEnv();
  const SHOP = env.SHOPIFY_STORE;
  const TOKEN = env.SHOPIFY_SECRET;

  let fixed = 0;

  for (const row of toFix) {
    const type = pageType(row.url);
    const path = urlPath(row.url);
    const handle = path.split('/').pop();

    // Fetch current body_html
    let body = '';
    let resourceId = null;
    let resourceType = null;

    if (type === 'collection') {
      // Try both collection types
      for (const ct of ['custom_collections', 'smart_collections']) {
        const res = await fetch(`https://${SHOP}/admin/api/2025-01/${ct}.json?handle=${handle}`, {
          headers: { 'X-Shopify-Access-Token': TOKEN },
        });
        const data = await res.json();
        const col = (data[ct] || [])[0];
        if (col) { body = col.body_html || ''; resourceId = col.id; resourceType = ct; break; }
      }
    } else {
      const entry = pageIdx[path];
      if (!entry) { console.log(`  [SKIP] Page not found: ${path}`); continue; }
      const res = await fetch(`https://${SHOP}/admin/api/2025-01/pages/${entry.pageId}.json`, {
        headers: { 'X-Shopify-Access-Token': TOKEN },
      });
      const data = await res.json();
      body = data.page?.body_html || '';
      resourceId = entry.pageId;
      resourceType = 'pages';
    }

    if (!body) { console.log(`  [SKIP] No content: ${path}`); continue; }

    // Preserve schema-injector and links blocks — only rewrite visible prose
    const schemaMatch = body.match(/<!-- schema-injector -->[\s\S]*?<!-- schema-injector -->/);
    const schemaBlock = schemaMatch ? schemaMatch[0] : '';
    const contentOnly = schemaBlock ? body.replace(schemaBlock, '').trim() : body;

    console.log(`  ${path} — rewriting ${contentOnly.length} chars of content...`);

    const msg = await claude.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `You are rewriting collection page content for ${config.name}, a natural skincare brand. The content has been flagged by AI detection tools as obviously AI-generated. Rewrite it to sound authentically human while keeping the same SEO structure and keyword focus.

Page URL: ${row.url}
Brand: ${config.name} — handmade in the USA, organic coconut oil-based skincare, paraben-free, vegan, cruelty-free

RULES for avoiding AI detection:
- Vary sentence length aggressively — mix 5-word sentences with 20-word ones in the same paragraph
- Lead with a specific concrete detail, not a generic statement or question
- Cut all generic filler phrases: "designed with care", "made with intention", "more than just", "you deserve", "no compromise", "real results", "peace of mind", "feel confident", "clean beauty"
- Write in active voice with direct, specific language about what the product actually does
- Use brand-specific details: handmade in small batches, organic virgin coconut oil, specific scents (lavender, rose, unscented options)
- FAQs should sound like real customer questions, not scripted Q&A pairs — vary the answer length and tone
- Some paragraphs should be 1-2 sentences. Others 3-4. Never uniform.
- Avoid starting multiple sections with "Whether you..." or "If you're looking for..."
- Keep all HTML tags, heading hierarchy (H2/H3/H4), class attributes, and the <!---Split---> divider exactly as-is
- Preserve the <ul class="links"> block and <div class="faq-block"> structure but rewrite the text inside FAQ answers
- Do NOT rewrite the links list text or hrefs — keep those exactly as-is
- Return ONLY the rewritten HTML, no preamble

CURRENT CONTENT:
${contentOnly}`,
      }],
    });

    const rewritten = msg.content[0].text.trim();
    const newBody = schemaBlock ? `${schemaBlock}\n${rewritten}` : rewritten;

    if (dryRun) {
      console.log(`  [DRY RUN] Would update ${path}`);
      console.log(rewritten.slice(0, 300) + '...\n');
      fixed++;
      continue;
    }

    try {
      if (type === 'collection') {
        const colType = resourceType === 'custom_collections' ? 'custom_collections' : 'smart_collections';
        await fetch(`https://${SHOP}/admin/api/2025-01/${colType}/${resourceId}.json`, {
          method: 'PUT',
          headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ [colType.slice(0, -1)]: { id: resourceId, body_html: newBody } }),
        });
      } else {
        await fetch(`https://${SHOP}/admin/api/2025-01/pages/${resourceId}.json`, {
          method: 'PUT',
          headers: { 'X-Shopify-Access-Token': TOKEN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ page: { id: resourceId, body_html: newBody } }),
        });
      }
      console.log(`  [DONE] ${path}`);
      fixed++;
    } catch (e) {
      console.log(`  [ERROR] ${path}: ${e.message}`);
    }
  }

  console.log(`\n  ${dryRun ? 'Would rewrite' : 'Rewrote'}: ${fixed} pages`);
}

// ── COMMAND: fix-titles ──────────────────────────────────────────────────────

async function fixTitles({ dryRun = false } = {}) {
  console.log('\n  Fixing title tags that are too long (>60 chars)...');
  const rows = loadIssue('Warning-indexable-Title_too_long');
  if (rows.length === 0) { console.log('  No title length issues found.'); return; }

  const articleIndex = await getArticleIndex();
  const pageIdx = await getPageIndex();
  let fixed = 0;

  for (const row of rows) {
    const url = row.url;
    if (!url) continue;
    const type = pageType(url);
    const path = urlPath(url);
    const currentTitle = row.title || '';

    if (currentTitle.length <= 60) continue; // already fine

    // Generate a shorter title (truncate smartly at word boundary, add ellipsis or brand)
    let newTitle = currentTitle.slice(0, 57);
    const lastSpace = newTitle.lastIndexOf(' ');
    if (lastSpace > 40) newTitle = newTitle.slice(0, lastSpace);
    // Don't add ellipsis — just let it be a clean cut with brand
    if (!newTitle.includes(config.name)) newTitle += ' | ' + config.name;
    if (newTitle.length > 60) newTitle = newTitle.slice(0, 60);

    console.log(`  ${dryRun ? '[DRY RUN] ' : ''}${path}: "${currentTitle.slice(0, 50)}..." → "${newTitle}"`);

    if (!dryRun) {
      try {
        if (type === 'article') {
          const entry = articleIndex[path];
          if (entry) {
            await upsertMetafield('articles', entry.articleId, 'global', 'title_tag', newTitle);
            fixed++;
          }
        } else if (type === 'page') {
          const entry = pageIdx[path];
          if (entry) {
            await upsertMetafield('pages', entry.pageId, 'global', 'title_tag', newTitle);
            fixed++;
          }
        } else if (type === 'product') {
          const handle = path.split('/').pop();
          const products = await getProducts({ handle });
          if (products[0]) {
            await upsertMetafield('products', products[0].id, 'global', 'title_tag', newTitle);
            fixed++;
          }
        }
      } catch (e) {
        console.log(`    Error: ${e.message}`);
      }
    } else {
      fixed++;
    }
  }

  console.log(`\n  ${dryRun ? 'Would fix' : 'Fixed'}: ${fixed} title tags`);
}

// ── COMMAND: fix-noindex ─────────────────────────────────────────────────────

async function fixNoindex({ dryRun = false } = {}) {
  console.log('\n  Checking for pages that should be noindexed...');

  // Load orphan pages — these may include ads landing pages
  const orphanRows = loadIssue('Error-indexable-Orphan_page_(has_no_incoming_internal_links)');
  const pageIdx = await getPageIndex();
  let fixed = 0;

  // Pages with Replo/landing-page templates are likely ads landing pages
  const allPages = await getPages();
  const landingPages = allPages.filter(p => {
    const suffix = p.template_suffix || '';
    return suffix.includes('replo') || suffix.includes('landing');
  });

  // Combine orphan pages and landing pages
  const toNoindex = new Set();
  for (const row of orphanRows) {
    const type = pageType(row.url || '');
    if (type === 'page') toNoindex.add(urlPath(row.url));
  }
  for (const p of landingPages) {
    toNoindex.add(`/pages/${p.handle}`);
  }

  if (toNoindex.size === 0) { console.log('  No pages need noindexing.'); return; }

  console.log(`  Found ${toNoindex.size} page(s) to noindex:\n`);

  const themeId = await getMainThemeId();
  if (!themeId) { console.error('  Could not find main theme.'); return; }

  for (const pagePath of toNoindex) {
    const handle = pagePath.split('/').pop();
    const page = allPages.find(p => p.handle === handle);
    if (!page) { console.log(`  [SKIP] Page not found: ${pagePath}`); continue; }

    // Check if already noindexed via metafield
    console.log(`  ${dryRun ? '[DRY RUN] ' : ''}Noindex: ${pagePath} (${page.title})`);

    if (!dryRun) {
      try {
        // Add noindex via the seo.hidden metafield (Shopify's built-in SEO exclusion)
        await upsertMetafield('pages', page.id, 'seo', 'hidden', '1', 'number_integer');
        fixed++;
      } catch (e) {
        console.log(`    Error: ${e.message}`);
      }
    } else {
      fixed++;
    }
  }

  console.log(`\n  ${dryRun ? 'Would noindex' : 'Noindexed'}: ${fixed} pages`);
}

// ── COMMAND: fix-duplicate-tags ──────────────────────────────────────────────

async function fixDuplicateTags({ dryRun = false } = {}) {
  console.log('\n  Fixing duplicate meta/title tags in article HTML...');

  const metaRows = loadIssue('Error-indexable-Multiple_meta_description_tags');
  const titleRows = loadIssue('Error-indexable-Multiple_title_tags');
  const allUrls = new Set([
    ...metaRows.map(r => r.url).filter(Boolean),
    ...titleRows.map(r => r.url).filter(Boolean),
  ]);

  if (allUrls.size === 0) { console.log('  No duplicate tag issues found.'); return; }

  const articleIndex = await getArticleIndex();
  let fixed = 0;

  for (const url of allUrls) {
    const type = pageType(url);
    if (type !== 'article') {
      console.log(`  [SKIP] ${type}: ${url} — theme-level issue, cannot fix via REST API`);
      continue;
    }

    const path = urlPath(url);
    const entry = articleIndex[path];
    if (!entry) { console.log(`  [SKIP] Article not found: ${path}`); continue; }

    const full = await getArticle(entry.blogId, entry.articleId);
    let body = full.body_html || '';

    // Remove any <meta> or <title> tags that crept into body_html
    const origLen = body.length;
    body = body.replace(/<meta[^>]*name=["']description["'][^>]*>/gi, '');
    body = body.replace(/<title[^>]*>[\s\S]*?<\/title>/gi, '');
    // Also remove stray <head> blocks
    body = body.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');

    if (body.length === origLen) {
      console.log(`  [OK] ${path} — no duplicate tags in body_html`);
      continue;
    }

    console.log(`  ${dryRun ? '[DRY RUN] ' : ''}${path} — removed ${origLen - body.length} chars of duplicate tags`);

    if (!dryRun) {
      try {
        await updateArticle(entry.blogId, entry.articleId, { body_html: body });
        fixed++;
      } catch (e) {
        console.log(`    Error: ${e.message}`);
      }
    } else {
      fixed++;
    }
  }

  console.log(`\n  ${dryRun ? 'Would fix' : 'Fixed'}: ${fixed} pages with duplicate tags`);
}

// ── COMMAND: fix-internal-links ──────────────────────────────────────────────

async function fixInternalLinks({ dryRun = false } = {}) {
  console.log('\n  Adding internal links to pages with few inbound links...');

  const orphanRows = loadIssue('Error-indexable-Orphan_page_(has_no_incoming_internal_links)');
  // Also include pages with only 1 inbound link
  const lowLinkRows = loadIssue('Warning-Pages_with_only_1_inbound_internal_link') || [];

  const urls = [
    ...orphanRows.map(r => r.url).filter(Boolean),
    ...lowLinkRows.map(r => r.url).filter(Boolean),
  ].filter(url => pageType(url) === 'article'); // only fix blog posts — internal-linker handles articles

  if (urls.length === 0) { console.log('  No blog posts need internal links.'); return; }

  console.log(`  ${urls.length} blog post(s) need more internal links\n`);

  for (const url of urls) {
    const handle = urlPath(url).split('/').pop();
    console.log(`  ${dryRun ? '[DRY RUN] ' : ''}Running internal-linker for: ${handle}`);
    if (!dryRun) {
      try {
        execSync(`node agents/internal-linker/index.js --slug ${handle} --apply`, { cwd: ROOT, stdio: 'pipe' });
        console.log(`    ✓ Internal links added for ${handle}`);
      } catch (e) {
        console.log(`    Error: ${e.message?.split('\n')[0] || e}`);
      }
    }
  }

  console.log(`\n  ${dryRun ? 'Would process' : 'Processed'}: ${urls.length} posts`);
}

// ── COMMAND: fix-theme-alt ────────────────────────────────────────────────────

async function fixThemeAlt({ dryRun = false } = {}) {
  console.log('\n  Fixing missing alt text in theme JSON templates...');

  const themeId = await getMainThemeId();
  if (!themeId) { console.error('  Could not find main theme.'); return; }

  const allAssets = await listThemeAssets(themeId);
  const jsonAssets = allAssets.filter(a =>
    (a.key.startsWith('templates/') || a.key.startsWith('sections/')) && a.key.endsWith('.json')
  );

  console.log(`  Checking ${jsonAssets.length} JSON template files...`);
  let totalFixed = 0;

  for (const asset of jsonAssets) {
    const rawVal = await getThemeAsset(themeId, asset.key);
    if (!rawVal || !rawVal.includes('shop_images')) continue;

    let data;
    try { data = JSON.parse(rawVal); } catch { continue; }
    let modified = false;

    // Recursively walk all objects looking for settings with image but no alt
    function addMissingAlt(obj) {
      if (!obj || typeof obj !== 'object') return;
      if (typeof obj.image === 'string' && obj.image.includes('shop_images') && !('alt' in obj)) {
        const filename = obj.image.split('/').pop()
          .replace(/\.[^.]+$/, '')           // strip extension
          .replace(/[_-]/g, ' ')             // underscores/hyphens to spaces
          .replace(/\s+[a-f0-9]{8,}.*$/, '') // strip UUID suffixes
          .trim();
        obj.alt = filename || 'Image';
        modified = true;
        totalFixed++;
      }
      for (const val of Object.values(obj)) {
        if (typeof val === 'object') addMissingAlt(val);
      }
    }
    addMissingAlt(data);

    if (modified && !dryRun) {
      console.log(`  Updating: ${asset.key}`);
      await updateThemeAsset(themeId, asset.key, JSON.stringify(data, null, 2));
    } else if (modified) {
      console.log(`  [DRY RUN] Would update: ${asset.key}`);
    }
  }

  console.log(`\n  ${dryRun ? 'Would fix' : 'Fixed'}: ${totalFixed} image alt text in theme templates`);
}

// ── COMMAND: fix-submit-indexing ─────────────────────────────────────────────

async function fixSubmitIndexing({ dryRun = false } = {}) {
  console.log('\n  Submitting changed pages to Google Indexing API...');

  const rows = loadIssue('Notice-Pages_to_submit_to_IndexNow');
  if (rows.length === 0) { console.log('  No pages to submit.'); return; }

  // Filter to real content pages only — skip tag pages, pagination, blog index
  const eligible = rows.filter(r => {
    const url = r.url || '';
    if (url.includes('/tagged/')) return false;
    if (url.includes('?page=')) return false;
    if (url.endsWith('/blogs/news') || url.endsWith('/blogs/news/')) return false;
    return url.includes('realskincare.com');
  });

  console.log(`  ${eligible.length} eligible pages (${rows.length - eligible.length} filtered — tag/pagination/index pages)`);

  const { submitUrlForIndexing, getQuotaStatus } = await import('../../lib/gsc-indexing.js');
  let quota = getQuotaStatus();
  const remaining = quota.submission.remaining;
  console.log(`  Indexing API quota remaining: ${remaining}/${quota.submission.cap}`);

  if (remaining <= 0) {
    console.log('  Quota exhausted for today — will retry tomorrow.');
    console.log(`  ${eligible.length} pages pending submission.`);
    return;
  }

  const toSubmit = eligible.slice(0, remaining);
  console.log(`  Submitting ${toSubmit.length} of ${eligible.length} (daily limit: ${quota.submission.cap})\n`);

  let submitted = 0;
  for (const row of toSubmit) {
    const url = row.url;
    if (!url) continue;

    console.log(`  ${dryRun ? '[DRY RUN] ' : ''}Submit: ${url}`);
    if (!dryRun) {
      try {
        await submitUrlForIndexing(url, 'URL_UPDATED');
        submitted++;
      } catch (e) {
        if (e.message?.includes('quota') || e.message?.includes('self-limit') || e.message?.includes('exhausted')) {
          console.log(`  Quota hit — stopping. ${submitted} submitted so far.`);
          break;
        }
        console.log(`    Error: ${e.message}`);
      }
    } else {
      submitted++;
    }
  }

  const pendingRemaining = eligible.length - submitted;
  console.log(`\n  ${dryRun ? 'Would submit' : 'Submitted'}: ${submitted} pages to Indexing API`);
  if (pendingRemaining > 0) {
    console.log(`  ${pendingRemaining} pages remaining — will continue in next run (daily quota: ${quota.submission.cap}).`);
  }
}

// ── COMMAND: fix-noindex-thin ────────────────────────────────────────────────

async function fixNoindexThin({ dryRun = false } = {}) {
  console.log('\n  Adding noindex to tag listing pages and paginated blog pages...');

  const themeId = await getMainThemeId();
  if (!themeId) { console.error('  Could not find main theme.'); return; }

  // Check the blog template's main section for existing noindex logic
  const blogSectionKey = 'sections/main-blog.liquid';
  let blogSection = await getThemeAsset(themeId, blogSectionKey);

  if (!blogSection) {
    // Try alternate names
    const altKeys = ['sections/blog-posts.liquid', 'sections/main-blog-posts.liquid'];
    for (const key of altKeys) {
      blogSection = await getThemeAsset(themeId, key);
      if (blogSection) break;
    }
  }

  if (!blogSection) {
    console.log('  Could not find blog section template. Checking layout/theme.liquid instead...');

    // Add noindex via the main layout for tagged/paginated
    const layoutKey = 'layout/theme.liquid';
    const layout = await getThemeAsset(themeId, layoutKey);
    if (!layout) { console.error('  Could not find layout/theme.liquid'); return; }

    if (layout.includes('noindex-tag-pagination')) {
      console.log('  Noindex logic already present in layout.');
      return;
    }

    // Add noindex meta tag for tagged and paginated pages
    const noindexSnippet = `
  {%- comment -%}noindex-tag-pagination: added by technical-seo agent{%- endcomment -%}
  {%- if current_tags or current_page > 1 -%}
    <meta name="robots" content="noindex, follow">
  {%- endif -%}`;

    // Insert right before </head>
    const insertPoint = layout.indexOf('</head>');
    if (insertPoint === -1) { console.error('  Could not find </head> in layout'); return; }

    const newLayout = layout.slice(0, insertPoint) + noindexSnippet + '\n  ' + layout.slice(insertPoint);

    console.log(`  ${dryRun ? '[DRY RUN] ' : ''}Adding noindex meta tag to layout/theme.liquid for tagged and paginated pages`);
    if (!dryRun) {
      await updateThemeAsset(themeId, layoutKey, newLayout);
      console.log('  ✓ Updated layout/theme.liquid');
    }
    return;
  }

  console.log('  Found blog section, checking for noindex...');
  // Similar logic but in the section file
  if (blogSection.includes('noindex-tag-pagination')) {
    console.log('  Noindex logic already present.');
    return;
  }

  console.log(`  ${dryRun ? '[DRY RUN] ' : ''}Noindex logic will be added to layout/theme.liquid`);

  // Fall through to layout approach
  const layoutKey = 'layout/theme.liquid';
  const layout = await getThemeAsset(themeId, layoutKey);
  if (!layout) { console.error('  Could not find layout/theme.liquid'); return; }

  if (layout.includes('noindex-tag-pagination')) {
    console.log('  Noindex logic already present in layout.');
    return;
  }

  const noindexSnippet = `
  {%- comment -%}noindex-tag-pagination: added by technical-seo agent{%- endcomment -%}
  {%- if current_tags or current_page > 1 -%}
    <meta name="robots" content="noindex, follow">
  {%- endif -%}`;

  const insertPoint = layout.indexOf('</head>');
  if (insertPoint === -1) { console.error('  Could not find </head> in layout'); return; }

  const newLayout = layout.slice(0, insertPoint) + noindexSnippet + '\n  ' + layout.slice(insertPoint);

  if (!dryRun) {
    await updateThemeAsset(themeId, layoutKey, newLayout);
    console.log('  ✓ Updated layout/theme.liquid — tag pages and paginated pages will now have noindex');
  }
}

// ── COMMAND: fix-all ──────────────────────────────────────────────────────────

async function fixAll({ dryRun = false } = {}) {
  console.log('\n  Running all fixes in priority order...\n');
  await createRedirects({ dryRun });
  await fixBrokenLinks({ dryRun });
  await fixRedirectLinks({ dryRun });
  await fixMeta({ dryRun });
  await fixTitles({ dryRun });
  await fixDuplicateTags({ dryRun });
  await fixAltText({ dryRun });
  await fixThemeAlt({ dryRun });
  await fixNoindex({ dryRun });
  await fixNoindexThin({ dryRun });
  await fixInternalLinks({ dryRun });
  await fixSubmitIndexing({ dryRun });
  console.log('\n  All fixes complete.');
}

// ── main ──────────────────────────────────────────────────────────────────────

const [,, command, ...args] = process.argv;
const dryRun = args.includes('--dry-run');

const USAGE = `
Technical SEO Agent — ${config.name}

Usage:
  node agents/technical-seo/index.js audit
  node agents/technical-seo/index.js fix-meta [--dry-run]
  node agents/technical-seo/index.js fix-links [--dry-run]
  node agents/technical-seo/index.js fix-redirects [--dry-run]
  node agents/technical-seo/index.js fix-alt-text [--dry-run]
  node agents/technical-seo/index.js fix-theme-alt [--dry-run]
  node agents/technical-seo/index.js create-redirects [--dry-run]
  node agents/technical-seo/index.js prune-zombies [--apply] [--only=path1,path2] [--include-suspicious]
  node agents/technical-seo/index.js fix-ai-content [--dry-run]
  node agents/technical-seo/index.js fix-titles [--dry-run]
  node agents/technical-seo/index.js fix-noindex [--dry-run]
  node agents/technical-seo/index.js fix-duplicate-tags [--dry-run]
  node agents/technical-seo/index.js fix-internal-links [--dry-run]
  node agents/technical-seo/index.js fix-submit-indexing [--dry-run]
  node agents/technical-seo/index.js fix-noindex-thin [--dry-run]
  node agents/technical-seo/index.js fix-all [--dry-run]
`.trim();

// ── fix results tracking ─────────────────────────────────────────────────────

function captureFixResults(command, dryRun) {
  // Capture console.log output during the fix to extract results
  const log = [];
  const origLog = console.log;
  console.log = (...args) => {
    const line = args.join(' ');
    log.push(line);
    origLog.apply(console, args);
  };
  return {
    finish() {
      console.log = origLog;

      const actions = [];
      const skipped = [];
      const errors = [];
      const manual = [];
      let totalFixed = 0;
      let totalSkipped = 0;

      for (const line of log) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Summary lines: "Fixed: N pages" / "Created: N redirects, skipped: M" / "Noindexed: N pages" / "Processed: N posts"
        const fixedMatch = trimmed.match(/(?:Fixed|Created|Would fix|Would create|Noindexed|Would noindex|Processed|Would process):\s*(\d+)/);
        if (fixedMatch) {
          const n = parseInt(fixedMatch[1], 10);
          totalFixed += n;
          actions.push({ action: trimmed, status: dryRun ? 'would-fix' : 'fixed', count: n });
          // Also extract skipped from "Created: N, skipped: M" pattern
          const skipMatch = trimmed.match(/skipped:\s*(\d+)/);
          if (skipMatch) totalSkipped += parseInt(skipMatch[1], 10);
          continue;
        }

        // Individual fix lines: "Fix: /old → /new" or "path — N link(s) fixed" or "Noindex: /path"
        if (trimmed.includes('link(s) fixed') || /^\s*Fix:/.test(line) || /^Noindex:/.test(trimmed) || /^Internal links added/.test(trimmed)) {
          actions.push({ action: trimmed, status: dryRun ? 'would-fix' : 'fixed' });
          continue;
        }

        // Skip lines
        if (/^\[SKIP\]/.test(trimmed)) { skipped.push(trimmed); totalSkipped++; continue; }

        // Error lines
        if (/^Error:|^✗/.test(trimmed)) { errors.push(trimmed); continue; }

        // Manual attention
        if (/theme-level|cannot be fixed|manual|requires liquid/i.test(trimmed)) { manual.push(trimmed); continue; }
      }

      const result = {
        command,
        dry_run: dryRun,
        ran_at: new Date().toISOString(),
        total_fixed: totalFixed,
        total_skipped: totalSkipped,
        total_errors: errors.length,
        total_manual: manual.length,
        actions: actions.slice(0, 20),
        skipped: skipped.slice(0, 10),
        errors: errors.slice(0, 10),
        manual: manual.slice(0, 10),
      };

      return result;
    },
  };
}

function writeFixResults(results) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const path = join(REPORTS_DIR, 'fix-results.json');

  // Append to existing results (keep last 10 runs)
  let history = [];
  try { history = JSON.parse(readFileSync(path, 'utf8')); } catch { /* start fresh */ }
  if (!Array.isArray(history)) history = [];
  history.unshift(results);
  history = history.slice(0, 10);

  writeFileSync(path, JSON.stringify(history, null, 2));
  console.log(`  Fix results saved to ${path}`);
}

async function runFixWithTracking(fixFn, commandName) {
  const tracker = captureFixResults(commandName, dryRun);
  await fixFn({ dryRun });
  const results = tracker.finish();
  writeFixResults(results);

  // Auto-re-run audit after fixes so dashboard counts update
  if (!dryRun) {
    console.log('\n  Re-running audit to update issue counts...');
    await audit();
  }

  return results;
}

async function main() {
  console.log(`\nTechnical SEO Agent — ${config.name}`);

  switch (command) {
    case 'audit':
      await audit();
      break;
    case 'fix-meta':
      await runFixWithTracking(fixMeta, 'fix-meta');
      break;
    case 'fix-links':
      await runFixWithTracking(fixBrokenLinks, 'fix-links');
      break;
    case 'fix-redirects':
      await runFixWithTracking(fixRedirectLinks, 'fix-redirects');
      break;
    case 'fix-alt-text':
      await runFixWithTracking(fixAltText, 'fix-alt-text');
      break;
    case 'fix-theme-alt':
      await runFixWithTracking(fixThemeAlt, 'fix-theme-alt');
      break;
    case 'create-redirects':
      await runFixWithTracking(createRedirects, 'create-redirects');
      break;
    case 'prune-zombies':
      // prune-zombies uses --apply (action verb) instead of --dry-run because
      // deleting redirects is destructive and the safe default must be no-op.
      await runFixWithTracking((opts) => pruneZombies({ dryRun: !args.includes('--apply') }), 'prune-zombies');
      break;
    case 'fix-ai-content':
      await runFixWithTracking(fixAiContent, 'fix-ai-content');
      break;
    case 'fix-titles':
      await runFixWithTracking(fixTitles, 'fix-titles');
      break;
    case 'fix-noindex':
      await runFixWithTracking(fixNoindex, 'fix-noindex');
      break;
    case 'fix-duplicate-tags':
      await runFixWithTracking(fixDuplicateTags, 'fix-duplicate-tags');
      break;
    case 'fix-internal-links':
      await runFixWithTracking(fixInternalLinks, 'fix-internal-links');
      break;
    case 'fix-submit-indexing':
      await runFixWithTracking(fixSubmitIndexing, 'fix-submit-indexing');
      break;
    case 'fix-noindex-thin':
      await runFixWithTracking(fixNoindexThin, 'fix-noindex-thin');
      break;
    case 'fix-all': {
      const tracker = captureFixResults('fix-all', dryRun);
      await fixAll({ dryRun });
      const results = tracker.finish();
      writeFixResults(results);
      if (!dryRun) {
        console.log('\n  Re-running audit to update issue counts...');
        await audit();
      }
      break;
    }
    default:
      console.error('\n' + USAGE);
      process.exit(1);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
