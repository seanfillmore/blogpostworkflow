/**
 * Technical SEO Agent
 *
 * Reads Ahrefs site audit CSV exports and resolves fixable issues via the Shopify API.
 *
 * Commands:
 *   audit                  Parse all CSVs, produce a prioritised audit report
 *   compare [--apply] [--fix]  Diff latest ZIP against current CSVs; write delta report
 *                          --apply: replace current CSVs with the new ZIP after comparing
 *                          --fix:   run repairs for all new issues after applying (requires --apply)
 *   fix-meta [--dry-run]   Generate + push missing/bad meta descriptions (blog posts & pages)
 *   fix-links [--dry-run]  Update internal links pointing to 404 pages
 *   fix-redirects [--dry-run] Update internal links pointing to 301 redirected URLs
 *   fix-alt-text [--dry-run]  Generate + insert alt text on <img> tags in blog post bodies
 *   create-redirects [--dry-run] Create 301 redirects for known 404 pages
 *   fix-ai-content [--dry-run]  Rewrite high-AI-content pages in data/ai-detection/*.csv
 *   fix-all [--dry-run]    Run all fixes in order
 *
 * Requires: ANTHROPIC_API_KEY in .env
 *           data/technical_seo/*.csv  (Ahrefs site audit export)
 *
 * Output:  data/reports/technical-seo-audit.md
 *          data/reports/technical-seo/technical-seo-delta-report.md  (compare)
 *
 * Shopify token scope: read_products, write_products, read_content, write_content
 */

import Anthropic from '@anthropic-ai/sdk';
import * as cheerio from 'cheerio';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, statSync, rmSync, renameSync, copyFileSync } from 'fs';
import { execSync } from 'child_process';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import {
  getBlogs, getArticles, getArticle, updateArticle,
  getPages, getPage, updatePage,
  getRedirects, createRedirect,
  upsertMetafield,
  getProducts, getProduct, updateProduct, updateProductImage,
  getAllFiles, updateFileAlt,
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

// ── CSV parsing ───────────────────────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  // Parse header — handle quoted fields
  const parseRow = (line) => {
    const fields = [];
    let inQuote = false;
    let cur = '';
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === ',' && !inQuote) { fields.push(cur.trim()); cur = ''; }
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

function loadCSV(filename) {
  // Try exact match first (filename without extension), then prefix match excluding -links variants
  const files = readdirSync(CSV_DIR).filter((f) => f.endsWith('.csv'));
  const exact = files.find((f) => f === `${filename}.csv`);
  const match = exact || files.find((f) => f.startsWith(filename) && !f.includes('-links'));
  if (!match) return [];
  try {
    return parseCSV(readFileSync(join(CSV_DIR, match), 'utf8'));
  } catch { return []; }
}

function loadAllCSVs() {
  const files = readdirSync(CSV_DIR).filter((f) => f.endsWith('.csv'));
  const result = {};
  for (const f of files) {
    const key = f.replace('.csv', '');
    try { result[key] = parseCSV(readFileSync(join(CSV_DIR, f), 'utf8')); }
    catch { result[key] = []; }
  }
  return result;
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
  console.log('\nLoading all Ahrefs CSV files...\n');
  const csvs = loadAllCSVs();

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
  const p404 = loadCSV('Error-404_page');
  const pagesWithLinks = p404.filter((r) => {
    const inlinks = parseInt(r['no._of_all_inlinks'] || '0');
    return inlinks > 0;
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

// ── COMMAND: fix-links ────────────────────────────────────────────────────────

async function fixBrokenLinks({ dryRun = false } = {}) {
  console.log('\n  Loading pages with links to 404s...');
  const rows = loadCSV('Error-indexable-Page_has_links_to_broken_page');

  // Also load link details
  const linkRows = loadCSV('Error-indexable-Page_has_links_to_broken_page-links');
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
    if (!['article', 'page'].includes(type)) {
      console.log(`  [SKIP] ${type}: ${src}`);
      continue;
    }

    const brokenSet = brokenBySource[src] || new Set();
    if (brokenSet.size === 0) {
      console.log(`  [SKIP] No broken link details for: ${urlPath(src)}`);
      continue;
    }

    // Load article/page body
    let body = '';
    let resourceId = null;
    let blogId = null;

    if (type === 'article') {
      const path = urlPath(src);
      const entry = articleIndex[path];
      if (!entry) { console.log(`  [SKIP] Article not found: ${path}`); continue; }
      blogId = entry.blogId;
      resourceId = entry.articleId;
      const full = await getArticle(blogId, resourceId);
      body = full.body_html || '';
    } else {
      const path = urlPath(src);
      const pageIdx = await getPageIndex();
      const entry = pageIdx[path];
      if (!entry) { console.log(`  [SKIP] Page not found: ${path}`); continue; }
      resourceId = entry.pageId;
      const full = await getPage(resourceId);
      body = full.body_html || '';
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
      if (type === 'article') {
        await updateArticle(blogId, resourceId, { body_html: newBody });
      } else {
        await updatePage(resourceId, { body_html: newBody });
      }
      fixed++;
    } else {
      fixed++;
    }
  }

  console.log(`\n  ${dryRun ? 'Would fix' : 'Fixed'}: ${fixed} pages`);
}

// ── COMMAND: fix-redirects ────────────────────────────────────────────────────

async function fixRedirectLinks({ dryRun = false } = {}) {
  console.log('\n  Loading pages with links to redirected URLs...');
  const rows = loadCSV('Warning-indexable-Page_has_links_to_redirect');

  // Build source → broken redirect hrefs map from the -links file
  const linkRows = loadCSV('Warning-indexable-Page_has_links_to_redirect-links');
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
    if (!['article', 'page'].includes(type)) { console.log(`  [SKIP] ${type}: ${src}`); continue; }

    const redirectSet = redirectBySource[src] || new Set();
    if (redirectSet.size === 0) { console.log(`  [SKIP] No redirect details for: ${urlPath(src)}`); continue; }

    let body = '';
    let resourceId = null;
    let blogId = null;

    if (type === 'article') {
      const path = urlPath(src);
      const entry = articleIndex[path];
      if (!entry) { console.log(`  [SKIP] Article not found: ${path}`); continue; }
      blogId = entry.blogId;
      resourceId = entry.articleId;
      const full = await getArticle(blogId, resourceId);
      body = full.body_html || '';
    } else {
      const path = urlPath(src);
      const entry = pageIdx[path];
      if (!entry) { console.log(`  [SKIP] Page not found: ${path}`); continue; }
      resourceId = entry.pageId;
      const full = await getPage(resourceId);
      body = full.body_html || '';
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
      } else {
        await updatePage(resourceId, { body_html: newBody });
      }
      fixed++;
    } else { fixed++; }
  }

  console.log(`\n  ${dryRun ? 'Would fix' : 'Fixed'}: ${fixed} pages`);
}

// ── COMMAND: fix-meta ─────────────────────────────────────────────────────────

async function fixMeta({ dryRun = false } = {}) {
  console.log('\n  Collecting meta description issues...');

  const missing = loadCSV('Warning-indexable-Meta_description_tag_missing_or_empty');
  const tooLong = loadCSV('Warning-indexable-Meta_description_too_long');
  const tooShort = loadCSV('Warning-indexable-Meta_description_too_short');

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
    if (!seen.has(r.url)) { seen.add(r.url); toFix.push(r); }
  }

  const articleIndex = await getArticleIndex();
  const pageIdx = await getPageIndex();
  const productIdx = await getProductIndex();
  const collectionIdx = await getCollectionIndex();

  // Build a lookup: URL path → collection resource type ('custom_collections' or 'smart_collections')
  const env = loadEnv();
  const SHOP = env.SHOPIFY_STORE;
  const TOKEN = env.SHOPIFY_SECRET;

  console.log(`  ${toFix.length} pages with meta description issues\n`);
  let fixed = 0;

  for (const row of toFix) {
    const type = pageType(row.url);
    const path = urlPath(row.url);
    const pageTitle = row.title?.split('\n')[0] || path;
    const existingMeta = row.meta_description || '';

    if (!['article', 'page', 'product', 'collection'].includes(type)) {
      console.log(`  [SKIP] unsupported type (${type}): ${path}`);
      continue;
    }

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
  const titleTooLong = loadCSV('Warning-indexable-Title_too_long');
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
  const rows = loadCSV('Warning-Missing_alt_text');

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

  console.log(`\n  ${dryRun ? 'Would fix' : 'Fixed'}: ${fixed} images across blog posts, products, and hero files`);
}

// ── COMMAND: compare ─────────────────────────────────────────────────────────

// Issue categories with their CSV filenames and severity
const ISSUE_CATEGORIES = [
  { key: 'p404',            file: 'Error-404_page',                                                   label: 'Broken Pages (404)',                    severity: '🔴' },
  { key: 'linksTo404',      file: 'Error-indexable-Page_has_links_to_broken_page',                    label: 'Pages Linking to 404s',                 severity: '🔴' },
  { key: 'metaMissing',     file: 'Warning-indexable-Meta_description_tag_missing_or_empty',           label: 'Missing Meta Descriptions',             severity: '🔴' },
  { key: 'multiMeta',       file: 'Error-indexable-Multiple_meta_description_tags',                   label: 'Duplicate Meta Description Tags',        severity: '🔴' },
  { key: 'multiTitle',      file: 'Error-indexable-Multiple_title_tags',                              label: 'Duplicate Title Tags',                   severity: '🔴' },
  { key: 'orphans',         file: 'Error-indexable-Orphan_page_(has_no_incoming_internal_links)',      label: 'Orphan Pages',                           severity: '🔴' },
  { key: 'metaTooLong',     file: 'Warning-indexable-Meta_description_too_long',                      label: 'Meta Descriptions Too Long',             severity: '🟡' },
  { key: 'metaTooShort',    file: 'Warning-indexable-Meta_description_too_short',                     label: 'Meta Descriptions Too Short',            severity: '🟡' },
  { key: 'titleTooLong',    file: 'Warning-indexable-Title_too_long',                                 label: 'Title Tags Too Long',                    severity: '🟡' },
  { key: 'h1Missing',       file: 'Warning-indexable-H1_tag_missing_or_empty',                        label: 'H1 Missing/Empty',                       severity: '🟡' },
  { key: 'multiH1',         file: 'Notice-indexable-Multiple_H1_tags',                                label: 'Multiple H1 Tags',                       severity: '🟡' },
  { key: 'linksToRedirect', file: 'Warning-indexable-Page_has_links_to_redirect',                     label: 'Internal Links to Redirected URLs',      severity: '🟡' },
  { key: 'missingAlt',      file: 'Warning-Missing_alt_text',                                         label: 'Missing Image Alt Text',                 severity: '🟡' },
  { key: 'redirectChain',   file: 'Notice-Redirect_chain',                                            label: 'Redirect Chains',                        severity: '🔵' },
  { key: 'notInSitemap',    file: 'Notice-Indexable_page_not_in_sitemap',                             label: 'Indexable Pages Not in Sitemap',         severity: '🔵' },
  { key: 'singleInlink',    file: 'Notice-indexable-Page_has_only_one_dofollow_incoming_internal_link', label: 'Pages with Only 1 Inbound Link',       severity: '🔵' },
];

function loadCSVsFromDir(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.csv'));
  const result = {};
  for (const f of files) {
    const key = f.replace('.csv', '');
    try { result[key] = parseCSV(readFileSync(join(dir, f), 'utf8')); }
    catch { result[key] = []; }
  }
  return result;
}

function getUrlSet(csvs, filename) {
  // Try exact match first, then prefix match excluding -links variants
  const files = Object.keys(csvs);
  const exact = files.find((f) => f === filename);
  const match = exact || files.find((f) => f.startsWith(filename) && !f.includes('-links'));
  if (!match) return new Set();
  return new Set((csvs[match] || []).map((r) => r.url).filter(Boolean));
}

async function compare({ apply = false, fix = false } = {}) {
  // ── Find the newest unextracted ZIP ─────────────────────────────────────────
  const zips = readdirSync(CSV_DIR)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => ({ name: f, mtime: statSync(join(CSV_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime); // newest first

  if (zips.length === 0) {
    console.error('  No ZIP files found in', CSV_DIR);
    process.exit(1);
  }

  const newestZip = zips[0];
  console.log(`\n  New data: ${newestZip.name}`);

  // ── Load the existing (old) CSVs ─────────────────────────────────────────────
  console.log('  Loading existing CSV data (baseline)...');
  const oldCsvs = loadCSVsFromDir(CSV_DIR);
  const oldCsvCount = Object.values(oldCsvs).reduce((s, rows) => s + rows.length, 0);
  console.log(`  Old baseline: ${Object.keys(oldCsvs).filter((k) => !k.endsWith('-links')).length} issue files`);

  // ── Extract new ZIP to staging dir ──────────────────────────────────────────
  const STAGING_DIR = join(CSV_DIR, '_staging');
  if (existsSync(STAGING_DIR)) rmSync(STAGING_DIR, { recursive: true });
  mkdirSync(STAGING_DIR, { recursive: true });

  console.log(`  Extracting ${newestZip.name}...`);
  try {
    execSync(`unzip -q "${join(CSV_DIR, newestZip.name)}" -d "${STAGING_DIR}"`);
  } catch (e) {
    console.error('  Failed to extract ZIP:', e.message);
    process.exit(1);
  }

  // ── Load new CSVs ──────────────────────────────────────────────────────────
  console.log('  Loading new CSV data...');
  const newCsvs = loadCSVsFromDir(STAGING_DIR);
  console.log(`  New snapshot: ${Object.keys(newCsvs).filter((k) => !k.endsWith('-links')).length} issue files`);

  // ── Diff each category ────────────────────────────────────────────────────
  console.log('\n  Computing diffs...\n');

  const diffResults = [];
  let totalResolved = 0;
  let totalNew = 0;

  for (const cat of ISSUE_CATEGORIES) {
    const oldUrls = getUrlSet(oldCsvs, cat.file);
    const newUrls = getUrlSet(newCsvs, cat.file);

    const resolved = [...oldUrls].filter((u) => !newUrls.has(u));
    const added    = [...newUrls].filter((u) => !oldUrls.has(u));
    const unchanged = oldUrls.size + newUrls.size > 0 ? [...oldUrls].filter((u) => newUrls.has(u)).length : 0;

    totalResolved += resolved.length;
    totalNew += added.length;

    diffResults.push({
      ...cat,
      oldCount: oldUrls.size,
      newCount: newUrls.size,
      resolved,
      added,
      unchanged,
    });
  }

  // ── Write delta report ────────────────────────────────────────────────────
  const lines = [];
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  lines.push(`# Technical SEO Delta Report — ${config.name}`);
  lines.push(`**Compared:** Previous audit → ${newestZip.name.replace(/\.zip$/, '')}`);
  lines.push(`**Generated:** ${date}`);
  lines.push('');

  // Summary table
  lines.push('## Summary\n');
  lines.push('| Severity | Issue | Before | After | Resolved | New Issues |');
  lines.push('|----------|-------|--------|-------|----------|------------|');
  for (const d of diffResults) {
    if (d.oldCount === 0 && d.newCount === 0) continue;
    const resolvedCell = d.resolved.length > 0 ? `✅ ${d.resolved.length}` : '—';
    const addedCell    = d.added.length > 0    ? `🚨 ${d.added.length}`    : '—';
    lines.push(`| ${d.severity} | ${d.label} | ${d.oldCount} | ${d.newCount} | ${resolvedCell} | ${addedCell} |`);
  }
  lines.push('');
  lines.push(`**Net change:** ${totalResolved} issues resolved, ${totalNew} new issues introduced`);
  lines.push('');

  // Detail sections
  const withChanges = diffResults.filter((d) => d.resolved.length > 0 || d.added.length > 0);

  if (withChanges.length === 0) {
    lines.push('> No changes detected between the two audits.');
  } else {
    lines.push('---');
    lines.push('');

    for (const d of withChanges) {
      lines.push(`## ${d.severity} ${d.label}`);
      lines.push(`Before: **${d.oldCount}** → After: **${d.newCount}** (${d.unchanged} unchanged)\n`);

      if (d.resolved.length > 0) {
        lines.push(`### ✅ Resolved (${d.resolved.length})`);
        for (const url of d.resolved) lines.push(`- ${url}`);
        lines.push('');
      }

      if (d.added.length > 0) {
        lines.push(`### 🚨 New Issues (${d.added.length})`);
        for (const url of d.added) lines.push(`- ${url}`);
        lines.push('');
      }
    }
  }

  mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = join(REPORTS_DIR, 'technical-seo-delta-report.md');
  writeFileSync(reportPath, lines.join('\n'), 'utf8');

  console.log(`  Delta report saved: ${reportPath}`);
  console.log(`\n  ${totalResolved} issues resolved, ${totalNew} new issues introduced\n`);

  // ── Apply: replace old CSVs with new ones ─────────────────────────────────
  if (apply) {
    console.log('  Applying new CSVs (replacing old data)...');
    // Remove old CSVs
    for (const f of readdirSync(CSV_DIR).filter((f) => f.endsWith('.csv'))) {
      rmSync(join(CSV_DIR, f));
    }
    // Copy new CSVs from staging
    for (const f of readdirSync(STAGING_DIR).filter((f) => f.endsWith('.csv'))) {
      copyFileSync(join(STAGING_DIR, f), join(CSV_DIR, f));
    }
    console.log(`  Replaced ${Object.keys(newCsvs).length} CSV files.\n`);
  }

  // Cleanup staging
  rmSync(STAGING_DIR, { recursive: true });

  // ── Fix: run repairs against the new data ─────────────────────────────────
  if (fix) {
    if (!apply) {
      console.warn('  Warning: --fix requires --apply. Skipping fixes (no new CSVs were loaded).');
      return;
    }

    // Determine which fix commands are needed based on what changed
    const hasNew404s         = diffResults.find((d) => d.key === 'p404')?.added.length > 0;
    const hasNewLinksTo404s  = diffResults.find((d) => d.key === 'linksTo404')?.added.length > 0;
    const hasNewMetaIssues   = ['metaMissing', 'metaTooLong', 'metaTooShort'].some(
      (k) => diffResults.find((d) => d.key === k)?.added.length > 0
    );
    const hasNewRedirectLinks = diffResults.find((d) => d.key === 'linksToRedirect')?.added.length > 0;
    const hasNewAltIssues    = diffResults.find((d) => d.key === 'missingAlt')?.added.length > 0;

    const planned = [];
    if (hasNew404s)          planned.push('create-redirects');
    if (hasNewLinksTo404s)   planned.push('fix-links');
    if (hasNewRedirectLinks) planned.push('fix-redirects');
    if (hasNewMetaIssues)    planned.push('fix-meta');
    if (hasNewAltIssues)     planned.push('fix-alt-text');

    if (planned.length === 0) {
      console.log('  No new fixable issues — no repairs needed.');
      return;
    }

    console.log(`\n══════════════════════════════════════════════`);
    console.log('  Running repairs for new issues');
    console.log(`  Steps: ${planned.join(' → ')}`);
    console.log(`══════════════════════════════════════════════\n`);

    if (hasNew404s)          await createRedirects();
    if (hasNewLinksTo404s)   await fixBrokenLinks();
    if (hasNewRedirectLinks) await fixRedirectLinks();
    if (hasNewMetaIssues)    await fixMeta();
    if (hasNewAltIssues)     await fixAltText();

    console.log('\n  All repairs complete.');
  }
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

// ── COMMAND: fix-all ──────────────────────────────────────────────────────────

async function fixAll({ dryRun = false } = {}) {
  console.log('\n  Running all fixes in priority order...\n');
  await createRedirects({ dryRun });
  await fixBrokenLinks({ dryRun });
  await fixRedirectLinks({ dryRun });
  await fixMeta({ dryRun });
  await fixAltText({ dryRun });
  console.log('\n  All fixes complete.');
}

// ── main ──────────────────────────────────────────────────────────────────────

const [,, command, ...args] = process.argv;
const dryRun = args.includes('--dry-run');

const USAGE = `
Technical SEO Agent — ${config.name}

Usage:
  node agents/technical-seo/index.js audit
  node agents/technical-seo/index.js compare [--apply] [--fix]
  node agents/technical-seo/index.js fix-meta [--dry-run]
  node agents/technical-seo/index.js fix-links [--dry-run]
  node agents/technical-seo/index.js fix-redirects [--dry-run]
  node agents/technical-seo/index.js fix-alt-text [--dry-run]
  node agents/technical-seo/index.js create-redirects [--dry-run]
  node agents/technical-seo/index.js fix-ai-content [--dry-run]
  node agents/technical-seo/index.js fix-all [--dry-run]
`.trim();

async function main() {
  console.log(`\nTechnical SEO Agent — ${config.name}`);

  switch (command) {
    case 'audit':
      await audit();
      break;
    case 'compare': {
      const apply = args.includes('--apply');
      const fix   = args.includes('--fix');
      await compare({ apply, fix });
      break;
    }
    case 'fix-meta':
      await fixMeta({ dryRun });
      break;
    case 'fix-links':
      await fixBrokenLinks({ dryRun });
      break;
    case 'fix-redirects':
      await fixRedirectLinks({ dryRun });
      break;
    case 'fix-alt-text':
      await fixAltText({ dryRun });
      break;
    case 'create-redirects':
      await createRedirects({ dryRun });
      break;
    case 'fix-ai-content':
      await fixAiContent({ dryRun });
      break;
    case 'fix-all':
      await fixAll({ dryRun });
      break;
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
