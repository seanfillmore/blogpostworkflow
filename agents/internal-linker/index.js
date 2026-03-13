/**
 * Internal Linker Agent
 *
 * Two modes:
 *
 * 1. Single-post mode (--slug):
 *    After publishing a new post, scans all existing Shopify articles to find
 *    natural places to add a link pointing to the new post.
 *
 * 2. Top-targets mode (--top-targets):
 *    Reads the latest organic keywords CSV to identify the top N pages ranked
 *    as internal-link quick wins (positions 5–20, scored by volume), then runs
 *    link analysis for each and produces a combined opportunity report.
 *
 * Two-pass approach (both modes):
 *   1. Title/tag filter  — quick local scan to find topically relevant articles
 *   2. Claude analysis   — for each candidate, find 1–2 natural insertion points
 *
 * Defaults to --dry-run. Requires --apply to write changes to Shopify.
 *
 * Usage:
 *   node agents/internal-linker/index.js --slug fluoride-free-toothpaste
 *   node agents/internal-linker/index.js --slug fluoride-free-toothpaste --apply
 *   node agents/internal-linker/index.js --top-targets
 *   node agents/internal-linker/index.js --top-targets --count 10
 *
 * Options:
 *   --slug <slug>    Target post to build inbound links TO
 *   --top-targets    Analyze top N quick-win targets from keyword CSV
 *   --count <n>      Number of targets for --top-targets (default: 10)
 *   --apply          Write changes to Shopify (default: dry-run only)
 *   --limit <n>      Max articles to scan per target (default: 20)
 *   --min-score <n>  Only apply suggestions rated ≥ n/10 (default: 7)
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getBlogs, getArticles, getArticle, updateArticle } from '../../lib/shopify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'internal-linker');
const POSTS_DIR = join(ROOT, 'data', 'posts');

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

const slugArg = getArg('--slug');
const topTargets = args.includes('--top-targets');
const apply = args.includes('--apply');
const limitArg = parseInt(getArg('--limit') ?? '20', 10);
const minScore = parseInt(getArg('--min-score') ?? '7', 10);
const targetCount = parseInt(getArg('--count') ?? '10', 10);

if (!slugArg && !topTargets) {
  console.error('Usage:');
  console.error('  node agents/internal-linker/index.js --slug <slug> [--apply] [--limit N]');
  console.error('  node agents/internal-linker/index.js --top-targets [--count N]');
  process.exit(1);
}

// ── csv helpers ───────────────────────────────────────────────────────────────

const TRACKER_DIR = join(ROOT, 'data', 'keyword-tracker');

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const fields = [];
    let inQuote = false, cur = '';
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === ',' && !inQuote) { fields.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    fields.push(cur.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = fields[i]?.replace(/^"|"$/g, '') ?? ''; });
    return row;
  });
}

function num(v) {
  const n = parseFloat(String(v ?? '').replace(/,/g, ''));
  return isNaN(n) ? null : n;
}

function gCol(row, ...keys) {
  for (const k of keys) if (k in row && row[k] !== '') return row[k];
  return null;
}

/**
 * Load the latest keyword CSV and return an array of
 * { keyword, position, volume, url } rows with numeric fields.
 */
function loadKeywordCsv() {
  if (!existsSync(TRACKER_DIR)) return { rows: [], filename: null };
  const files = readdirSync(TRACKER_DIR)
    .filter((f) => f.endsWith('.csv') || f.endsWith('.tsv'))
    .sort((a, b) => statSync(join(TRACKER_DIR, b)).mtimeMs - statSync(join(TRACKER_DIR, a)).mtimeMs);
  if (files.length === 0) return { rows: [], filename: null };
  const filename = files[0];
  const rows = parseCSV(readFileSync(join(TRACKER_DIR, filename), 'utf8'))
    .map((row) => ({
      keyword: gCol(row, 'keyword', 'keywords', 'query', 'term') || '',
      position: num(gCol(row, 'current position', 'position', 'rank', 'pos')),
      volume: num(gCol(row, 'volume', 'search volume', 'vol', 'monthly volume')) ?? 0,
      url: gCol(row, 'current url', 'url', 'landing page', 'page') || '',
    }))
    .filter((r) => r.keyword && r.url);
  return { rows, filename };
}

/**
 * Pick the top N pages to boost via internal links.
 * Scoring: pages with positions 5–20 have highest link-building leverage.
 * Within those, rank by volume (proxy for traffic potential).
 * Falls back to positions 21–50 if fewer than N quick-win pages exist.
 */
function pickTopTargets(rows, n) {
  // Group keywords by URL, keeping best (highest-volume) keyword per URL
  const byUrl = new Map();
  for (const r of rows) {
    if (!r.url || r.position === null) continue;
    const existing = byUrl.get(r.url);
    if (!existing || r.volume > existing.volume) byUrl.set(r.url, r);
  }

  const pages = [...byUrl.values()];

  // Score: position 5–20 = best internal-link leverage
  const score = (p) => {
    const pos = p.position;
    const vol = p.volume || 0;
    if (pos >= 5 && pos <= 20)  return vol * 3;  // quick-win tier
    if (pos >= 1 && pos <= 4)   return vol * 1;  // already page 1 — protect
    if (pos >= 21 && pos <= 50) return vol * 2;  // refresh tier
    return 0;
  };

  return pages.sort((a, b) => score(b) - score(a)).slice(0, n);
}

/** Extract the slug (last path segment) from a full URL. */
function urlToSlug(url) {
  try { return new URL(url).pathname.split('/').filter(Boolean).pop(); }
  catch { return url.split('/').filter(Boolean).pop(); }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function loadTargetPost(slug) {
  const metaPath = join(POSTS_DIR, `${slug}.json`);
  if (!existsSync(metaPath)) {
    console.error(`Post metadata not found: ${metaPath}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(metaPath, 'utf8'));
}

function buildTargetUrl(meta) {
  // Use canonical domain URL (not myshopify.com)
  const handle = meta.shopify_handle || slug;
  const blogHandle = meta.shopify_blog_handle || 'news';
  return `${config.url}/blogs/${blogHandle}/${handle}`;
}

/**
 * Quick relevance filter: would this article plausibly mention topics
 * related to the target keyword? Uses title + tags only (no Shopify fetch).
 */
function isTopicallyRelevant(article, targetKeyword) {
  const targetWords = targetKeyword.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const articleText = `${article.title} ${(article.tags || '')}`.toLowerCase();
  // At least one meaningful word overlaps
  return targetWords.some((w) => articleText.includes(w));
}

/**
 * Check if article body already links to the target URL.
 */
function alreadyLinksTo(bodyHtml, targetUrl) {
  const slug = targetUrl.split('/').pop();
  return bodyHtml.includes(targetUrl) || bodyHtml.includes(slug);
}

// ── claude link finder ────────────────────────────────────────────────────────

async function findLinkOpportunities(article, targetPost, targetUrl) {
  const bodyText = article.body_html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are an SEO editor adding internal links to a blog post on ${config.name}.

TARGET LINK TO ADD:
- Title: "${targetPost.title}"
- URL: ${targetUrl}
- Keyword: ${targetPost.target_keyword}
- Description: ${targetPost.meta_description || targetPost.target_keyword}

ARTICLE BEING EDITED:
- Title: "${article.title}"
- Body text (HTML stripped):
${bodyText}

Find up to 2 natural places in this article where a link to the target URL would genuinely help the reader. The anchor text must already exist as a phrase in the article body — you are NOT adding new sentences, only wrapping existing text in a link.

Rules:
- Only use text that ALREADY EXISTS verbatim in the article
- The phrase must be directly relevant to the target post topic
- Do not link the same phrase twice
- Do not suggest links in headings (H1/H2/H3)
- Rate each suggestion 1–10 for how natural it feels (10 = reader would clearly benefit)

Return a JSON array. If no natural opportunities exist, return [].
Each item: { "anchor_text": "exact phrase from article", "reason": "why this link fits", "score": 8 }
Return ONLY valid JSON, no markdown.`,
    }],
  });

  try {
    const raw = message.content[0].text.trim()
      .replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
    const suggestions = JSON.parse(raw);
    return Array.isArray(suggestions) ? suggestions.filter((s) => s.score >= minScore) : [];
  } catch {
    return [];
  }
}

// ── html link injector ────────────────────────────────────────────────────────

/**
 * Insert a link around the first occurrence of anchor_text in the HTML,
 * skipping occurrences already inside an <a> tag or heading.
 * Returns { html, applied } — applied is true if a replacement was made.
 */
function injectLink(html, anchorText, url, title) {
  // Escape special regex chars in anchor text
  const escaped = anchorText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Match the anchor text NOT already inside an <a> tag
  // We do a simple pass: find the text, check context, replace first match
  const regex = new RegExp(`(?<!<[^>]*)\\b(${escaped})\\b`, 'i');

  // Check it's not inside a heading or existing link by scanning the surrounding HTML
  const idx = html.search(regex);
  if (idx === -1) return { html, applied: false };

  // Look backwards for unclosed <a or <h1/h2/h3 tags
  const before = html.slice(Math.max(0, idx - 300), idx).toLowerCase();
  const lastAOpen = before.lastIndexOf('<a ');
  const lastAClose = before.lastIndexOf('</a>');
  const lastHOpen = Math.max(
    before.lastIndexOf('<h1'), before.lastIndexOf('<h2'), before.lastIndexOf('<h3')
  );
  const lastHClose = Math.max(
    before.lastIndexOf('</h1>'), before.lastIndexOf('</h2>'), before.lastIndexOf('</h3>')
  );

  // Skip if inside an open <a> or heading
  if (lastAOpen > lastAClose) return { html, applied: false };
  if (lastHOpen > lastHClose) return { html, applied: false };

  const safeTitle = title.replace(/"/g, '&quot;');
  const linked = html.replace(regex, `<a href="${url}" title="${safeTitle}">$1</a>`);

  return { html: linked, applied: linked !== html };
}

// ── per-target analysis ───────────────────────────────────────────────────────

/**
 * Run the full two-pass analysis for a single target post against allArticles.
 * Returns { targetMeta, targetUrl, toProcess, results, totalLinksAdded }.
 */
async function analyzeTarget(slug, allArticles, preloadedMeta = null) {
  const targetMeta = preloadedMeta || loadTargetPost(slug);
  const targetUrl = buildTargetUrl(targetMeta);
  const targetKeyword = targetMeta.target_keyword || slug.replace(/-/g, ' ');

  // Exclude target from candidates
  const pool = allArticles.filter((a) => a.handle !== (targetMeta.shopify_handle || slug));

  // Pass 1: topical filter
  const candidates = pool.filter((a) => {
    if (alreadyLinksTo(a.body_html || '', targetUrl)) return false;
    return isTopicallyRelevant(a, targetKeyword);
  });

  const toProcess = candidates.slice(0, limitArg);
  const results = [];
  let totalLinksAdded = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const article = toProcess[i];
    process.stdout.write(`    [${i + 1}/${toProcess.length}] "${article.title.slice(0, 50)}"... `);

    const suggestions = await findLinkOpportunities(article, targetMeta, targetUrl);

    if (suggestions.length === 0) {
      console.log('no opportunities');
      results.push({ article, suggestions: [], linksAdded: 0 });
      continue;
    }

    let updatedHtml = article.body_html;
    let linksAdded = 0;

    for (const s of suggestions) {
      const { html: newHtml, applied } = injectLink(
        updatedHtml, s.anchor_text, targetUrl, targetMeta.title
      );
      if (applied) { updatedHtml = newHtml; linksAdded++; s.applied = true; }
      else { s.applied = false; }
    }

    if (apply && linksAdded > 0) {
      try {
        await updateArticle(article.blogId, article.id, { body_html: updatedHtml });
        totalLinksAdded += linksAdded;
        console.log(`+${linksAdded} applied`);
      } catch (e) {
        console.log(`ERROR: ${e.message}`);
        linksAdded = 0;
      }
    } else if (linksAdded > 0) {
      console.log(`${linksAdded} found`);
      totalLinksAdded += linksAdded;
    } else {
      console.log('no insertable text');
    }

    results.push({ article, suggestions, linksAdded: apply ? linksAdded : 0 });
  }

  return { targetMeta, targetUrl, slug, toProcess, results, totalLinksAdded };
}

/** Build a per-target section for a report. */
function buildTargetSection(analysis, rankRow) {
  const { targetMeta, targetUrl, slug, toProcess, results, totalLinksAdded } = analysis;
  const withOpportunities = results.filter((r) => r.suggestions.length > 0);
  const withNone = results.filter((r) => r.suggestions.length === 0);
  const lines = [];

  if (rankRow) {
    const pos = rankRow.position != null ? `#${rankRow.position}` : 'unranked';
    const vol = rankRow.volume ? ` | vol ${rankRow.volume.toLocaleString()}` : '';
    lines.push(`**Keyword:** ${rankRow.keyword}  |  **Position:** ${pos}${vol}`);
  }
  lines.push(`**Target URL:** ${targetUrl}`);
  lines.push(`**Articles scanned:** ${toProcess.length} | **Links ${apply ? 'added' : 'identified'}:** ${totalLinksAdded}`);
  lines.push('');

  if (withOpportunities.length > 0) {
    for (const r of withOpportunities) {
      const articleUrl = `${config.url}/blogs/${r.article.blogHandle}/${r.article.handle}`;
      lines.push(`#### [${r.article.title}](${articleUrl})\n`);
      for (const s of r.suggestions) {
        const icon = apply ? (s.applied ? '✅' : '⚠️ not inserted') : '💡';
        lines.push(`- ${icon} **"${s.anchor_text}"** (score: ${s.score}/10)`);
        lines.push(`  - ${s.reason}`);
      }
      lines.push('');
    }
  } else {
    lines.push('_No link opportunities found for this target._\n');
  }

  if (!apply && totalLinksAdded > 0) {
    lines.push('```bash');
    lines.push(`node agents/internal-linker/index.js --slug ${slug} --apply`);
    lines.push('```\n');
  }

  return lines;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nInternal Linker — ${config.name}`);
  console.log(`Mode: ${apply ? 'APPLY (will update Shopify)' : 'DRY RUN (use --apply to write changes)'}\n`);

  // Fetch all articles once (shared across targets)
  process.stdout.write('  Fetching blogs... ');
  const blogs = await getBlogs();
  console.log(`${blogs.length} blog(s)`);

  let allArticles = [];
  for (const blog of blogs) {
    process.stdout.write(`  Fetching "${blog.title}" articles... `);
    const articles = await getArticles(blog.id);
    allArticles.push(...articles.map((a) => ({ ...a, blogId: blog.id, blogHandle: blog.handle })));
    console.log(`${articles.length}`);
  }

  // ── Mode A: single slug ────────────────────────────────────────────────────

  if (slugArg) {
    const slug = slugArg;

    // Load metadata — prefer local JSON, fall back to live Shopify article
    let targetMeta;
    const metaPath = join(POSTS_DIR, `${slug}.json`);
    if (existsSync(metaPath)) {
      targetMeta = loadTargetPost(slug);
    } else {
      const shopifyArticle = allArticles.find((a) => a.handle === slug);
      if (!shopifyArticle) {
        console.error(`Post not found locally or in Shopify: ${slug}`);
        process.exit(1);
      }
      targetMeta = {
        title: shopifyArticle.title,
        target_keyword: slug.replace(/-/g, ' '),
        shopify_handle: shopifyArticle.handle,
        shopify_blog_handle: shopifyArticle.blogHandle,
        meta_description: shopifyArticle.summary_html?.replace(/<[^>]+>/g, '') || '',
      };
      console.log(`  (No local metadata — using live Shopify article)`);
    }

    const targetUrl = buildTargetUrl(targetMeta);
    const targetKeyword = targetMeta.target_keyword || slug.replace(/-/g, ' ');

    console.log(`\n  Target post: "${targetMeta.title}"`);
    console.log(`  URL:         ${targetUrl}`);
    console.log(`  Keyword:     ${targetKeyword}\n`);

    const analysis = await analyzeTarget(slug, allArticles, targetMeta);
    const { toProcess, results, totalLinksAdded } = analysis;
    const withOpportunities = results.filter((r) => r.suggestions.length > 0);
    const withNone = results.filter((r) => r.suggestions.length === 0);

    const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const lines = [];
    lines.push(`# Internal Linker Report — "${targetMeta.title}"`);
    lines.push(`**Target URL:** ${targetUrl}`);
    lines.push(`**Run date:** ${now}`);
    lines.push(`**Mode:** ${apply ? 'Applied' : 'Dry run'}`);
    lines.push(`**Articles scanned:** ${toProcess.length} | **Links ${apply ? 'added' : 'identified'}:** ${totalLinksAdded}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    if (withOpportunities.length > 0) {
      lines.push(`## ${apply ? 'Links Added' : 'Link Opportunities'}\n`);
      for (const r of withOpportunities) {
        const articleUrl = `${config.url}/blogs/${r.article.blogHandle}/${r.article.handle}`;
        lines.push(`### [${r.article.title}](${articleUrl})\n`);
        for (const s of r.suggestions) {
          const icon = apply ? (s.applied ? '✅' : '⚠️ not inserted') : '💡';
          lines.push(`- ${icon} **"${s.anchor_text}"** (score: ${s.score}/10)`);
          lines.push(`  - ${s.reason}`);
        }
        lines.push('');
      }
    }

    if (!apply && withOpportunities.length > 0) {
      lines.push('---\n');
      lines.push('## To Apply These Changes\n');
      lines.push('```bash');
      lines.push(`node agents/internal-linker/index.js --slug ${slug} --apply`);
      lines.push('```\n');
    }

    if (withNone.length > 0) {
      lines.push(`## No Opportunities Found (${withNone.length} articles)\n`);
      for (const r of withNone) lines.push(`- ${r.article.title}`);
      lines.push('');
    }

    mkdirSync(REPORTS_DIR, { recursive: true });
    const reportPath = join(REPORTS_DIR, `${slug}-internal-links.md`);
    writeFileSync(reportPath, lines.join('\n'));

    console.log(`\n  Report saved: ${reportPath}`);
    console.log(`  Links ${apply ? 'added' : 'identified'}: ${totalLinksAdded} across ${withOpportunities.length} article(s)`);
    if (!apply && totalLinksAdded > 0) {
      console.log(`\n  Run with --apply to write these to Shopify:`);
      console.log(`    node agents/internal-linker/index.js --slug ${slug} --apply`);
    }
    return;
  }

  // ── Mode B: top targets from GSC (or CSV fallback) ───────────────────────

  let targets = [];
  let dataSource = 'csv';

  // Try GSC first (live data, no manual exports needed)
  let gsc = null;
  try {
    gsc = await import('../../lib/gsc.js');
    process.stdout.write('\n  Fetching quick-win pages from Google Search Console... ');
    const gscPages = await gsc.getQuickWinPages(targetCount * 3, 90);
    const blogPages = gscPages
      .filter((p) => p.url.includes('/blogs/'))
      .map((p) => ({ keyword: p.keyword, position: p.position, volume: p.impressions, url: p.url }));
    targets = pickTopTargets(blogPages, targetCount);
    dataSource = 'gsc';
    console.log(`${gscPages.length} pages found, ${targets.length} blog targets selected`);
  } catch {
    console.log('\n  GSC unavailable — falling back to keyword CSV');
  }

  // CSV fallback
  if (targets.length === 0) {
    const { rows: csvRows, filename: csvFile } = loadKeywordCsv();
    if (csvRows.length === 0) {
      console.error('No data source available. Configure GSC (npm run gsc-auth) or drop an Ahrefs CSV in data/keyword-tracker/.');
      process.exit(1);
    }
    console.log(`\n  Keyword CSV: ${csvFile} (${csvRows.length} rows)`);
    targets = pickTopTargets(csvRows, targetCount);
    dataSource = csvFile;
  }

  if (targets.length === 0) {
    console.error('No rankable targets found.');
    process.exit(1);
  }

  const tierLabel = (pos) => {
    if (pos <= 4)  return '✅ Page 1';
    if (pos <= 20) return '🚀 Quick win';
    if (pos <= 50) return '🔄 Refresh';
    return '❌ Low rank';
  };

  console.log(`\n  Top ${targets.length} targets selected:\n`);
  targets.forEach((t, i) => {
    const vol = t.volume ? ` (${dataSource === 'gsc' ? 'impr' : 'vol'} ${t.volume.toLocaleString()})` : '';
    console.log(`  ${i + 1}. [#${Math.round(t.position)}] ${t.keyword}${vol} — ${tierLabel(t.position)}`);
    console.log(`     ${t.url}`);
  });
  console.log('');

  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const reportLines = [];
  reportLines.push(`# Internal Link Opportunity Report — Top ${targets.length} Keyword Targets`);
  reportLines.push(`**Run date:** ${now}`);
  reportLines.push(`**Mode:** ${apply ? 'Applied' : 'Dry run'}`);
  reportLines.push(`**Source:** ${dataSource === 'gsc' ? 'Google Search Console (live)' : dataSource}`);
  reportLines.push('');
  reportLines.push('## How targets are scored');
  reportLines.push('Pages ranked **5–20** earn the highest score (best internal-link leverage).');
  reportLines.push('Positions **1–4** are protected (page 1). Positions **21–50** are refresh candidates.');
  reportLines.push('Within each tier, pages are ranked by monthly search volume.');
  reportLines.push('');
  reportLines.push('---');
  reportLines.push('');

  let grandTotal = 0;

  // Build a handle→article map for quick lookup
  const articleByHandle = new Map(allArticles.map((a) => [a.handle, a]));

  for (let t = 0; t < targets.length; t++) {
    const row = targets[t];
    const handle = urlToSlug(row.url);
    const isBlogUrl = row.url.includes('/blogs/');

    console.log(`\n  ── Target ${t + 1}/${targets.length}: "${row.keyword}" [#${row.position}] ──`);
    console.log(`     URL: ${row.url}`);

    // Skip collection/product pages — we can only link between blog articles
    if (!isBlogUrl) {
      console.log(`     ⚠️  Not a blog post (collection/product) — skipping`);
      reportLines.push(`## ${t + 1}. "${row.keyword}" — #${row.position}`);
      reportLines.push(`**URL:** ${row.url}`);
      reportLines.push(`_Skipped: target is a collection or product page, not a blog post._\n`);
      reportLines.push('---\n');
      continue;
    }

    // Build synthetic meta from Shopify article data (no local JSON required)
    const shopifyArticle = articleByHandle.get(handle);
    let targetMeta;

    if (shopifyArticle) {
      // Use live Shopify data
      targetMeta = {
        title: shopifyArticle.title,
        target_keyword: row.keyword,
        shopify_handle: shopifyArticle.handle,
        shopify_blog_handle: shopifyArticle.blogHandle,
        meta_description: shopifyArticle.summary_html?.replace(/<[^>]+>/g, '') || '',
      };
    } else {
      // Fall back to local metadata if available
      const metaPath = join(POSTS_DIR, `${handle}.json`);
      if (!existsSync(metaPath)) {
        console.log(`     ⚠️  Article not found in Shopify or local metadata — skipping`);
        reportLines.push(`## ${t + 1}. "${row.keyword}" — #${row.position}`);
        reportLines.push(`**URL:** ${row.url}`);
        reportLines.push(`_Skipped: article not found in Shopify._\n`);
        reportLines.push('---\n');
        continue;
      }
      targetMeta = JSON.parse(readFileSync(metaPath, 'utf8'));
      targetMeta.target_keyword = targetMeta.target_keyword || row.keyword;
    }

    // Run analysis using synthetic meta
    let analysis;
    try {
      // Temporarily inject meta into POSTS_DIR so analyzeTarget can load it
      // Instead, call the analysis core directly with our synthetic meta
      const targetUrl = `${config.url}/blogs/${targetMeta.shopify_blog_handle || 'news'}/${targetMeta.shopify_handle || handle}`;
      const targetKeyword = targetMeta.target_keyword || row.keyword;
      const pool = allArticles.filter((a) => a.handle !== (targetMeta.shopify_handle || handle));
      const candidates = pool.filter((a) => {
        if (alreadyLinksTo(a.body_html || '', targetUrl)) return false;
        return isTopicallyRelevant(a, targetKeyword);
      });
      const toProcess = candidates.slice(0, limitArg);

      console.log(`     "${targetMeta.title.slice(0, 60)}"`);
      console.log(`     ${candidates.length} candidate(s), processing ${toProcess.length}`);

      const results = [];
      let totalLinksAdded = 0;

      for (let i = 0; i < toProcess.length; i++) {
        const article = toProcess[i];
        process.stdout.write(`    [${i + 1}/${toProcess.length}] "${article.title.slice(0, 50)}"... `);

        const suggestions = await findLinkOpportunities(article, targetMeta, targetUrl);
        if (suggestions.length === 0) {
          console.log('no opportunities');
          results.push({ article, suggestions: [], linksAdded: 0 });
          continue;
        }

        let updatedHtml = article.body_html;
        let linksAdded = 0;
        for (const s of suggestions) {
          const { html: newHtml, applied } = injectLink(updatedHtml, s.anchor_text, targetUrl, targetMeta.title);
          if (applied) { updatedHtml = newHtml; linksAdded++; s.applied = true; }
          else { s.applied = false; }
        }

        if (apply && linksAdded > 0) {
          try {
            await updateArticle(article.blogId, article.id, { body_html: updatedHtml });
            totalLinksAdded += linksAdded;
            console.log(`+${linksAdded} applied`);
          } catch (e) {
            console.log(`ERROR: ${e.message}`);
            linksAdded = 0;
          }
        } else if (linksAdded > 0) {
          console.log(`${linksAdded} found`);
          totalLinksAdded += linksAdded;
        } else {
          console.log('no insertable text');
        }
        results.push({ article, suggestions, linksAdded: apply ? linksAdded : 0 });
      }

      analysis = { targetMeta, targetUrl, slug: handle, toProcess, results, totalLinksAdded };
    } catch (e) {
      console.log(`     ERROR: ${e.message}`);
      reportLines.push(`## ${t + 1}. "${row.keyword}" — #${row.position}`);
      reportLines.push(`**URL:** ${row.url}`);
      reportLines.push(`_Error during analysis: ${e.message}_\n`);
      reportLines.push('---\n');
      continue;
    }

    grandTotal += analysis.totalLinksAdded;

    reportLines.push(`## ${t + 1}. "${row.keyword}" — ${tierLabel(row.position)}\n`);
    reportLines.push(...buildTargetSection(analysis, row));
    reportLines.push('---\n');
  }

  reportLines.push('');
  reportLines.push(`## Summary`);
  reportLines.push(`**Total links ${apply ? 'applied' : 'identified'}:** ${grandTotal} across ${targets.length} target pages`);
  if (!apply) {
    reportLines.push('');
    reportLines.push('To apply all changes, run each target individually with `--apply`:');
    reportLines.push('```bash');
    targets.forEach((row) => {
      reportLines.push(`node agents/internal-linker/index.js --slug ${urlToSlug(row.url)} --apply`);
    });
    reportLines.push('```');
  }

  mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = join(REPORTS_DIR, 'top-targets-internal-links.md');
  writeFileSync(reportPath, reportLines.join('\n'));

  console.log(`\n  Report saved: ${reportPath}`);
  console.log(`  Total links ${apply ? 'applied' : 'identified'}: ${grandTotal}`);
}

main().then(() => {
  console.log('\nInternal linking complete.');
}).catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
