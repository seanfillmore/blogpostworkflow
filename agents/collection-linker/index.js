/**
 * Collection & Product Page Linker Agent
 *
 * Scans all blog articles to find natural places to add links pointing to
 * collection and product pages, helping push those pages up in rankings.
 *
 * Two modes:
 *   1. Single target (--url or --keyword): link one specific collection/product page
 *   2. Top targets (--top-targets): auto-select top N pages from keyword CSV
 *
 * Two-pass approach:
 *   1. Topical filter — find blog articles likely to mention the target topic
 *   2. Claude analysis — find natural anchor text already in each article
 *
 * Defaults to dry-run. Requires --apply to write changes to Shopify.
 *
 * Usage:
 *   node agents/collection-linker/index.js --top-targets
 *   node agents/collection-linker/index.js --top-targets --count 15 --apply
 *   node agents/collection-linker/index.js --url "https://www.realskincare.com/collections/fluoride-free-toothpaste" --keyword "fluoride free toothpaste"
 *   node agents/collection-linker/index.js --url "https://www.realskincare.com/collections/fluoride-free-toothpaste" --keyword "fluoride free toothpaste" --apply
 *
 * Options:
 *   --top-targets        Auto-select top N collection/product pages from keyword CSV
 *   --count <n>          Number of targets for --top-targets (default: 10)
 *   --url <url>          Target collection/product URL (for single-target mode)
 *   --keyword <kw>       Target keyword for the page (for single-target mode)
 *   --apply              Write changes to Shopify (default: dry-run only)
 *   --limit <n>          Max blog articles to scan per target (default: 25)
 *   --min-score <n>      Only use suggestions rated ≥ n/10 (default: 7)
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getBlogs, getArticles, updateArticle } from '../../lib/shopify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'collection-linker');
const TRACKER_DIR = join(ROOT, 'data', 'keyword-tracker');

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

const topTargets = args.includes('--top-targets');
const apply = args.includes('--apply');
const limitArg = parseInt(getArg('--limit') ?? '25', 10);
const minScore = parseInt(getArg('--min-score') ?? '7', 10);
const targetCount = parseInt(getArg('--count') ?? '10', 10);
const urlArg = getArg('--url');
const keywordArg = getArg('--keyword');

if (!topTargets && !urlArg) {
  console.error('Usage:');
  console.error('  node agents/collection-linker/index.js --top-targets [--count N] [--apply]');
  console.error('  node agents/collection-linker/index.js --url <url> --keyword <kw> [--apply]');
  process.exit(1);
}

if (urlArg && !keywordArg) {
  console.error('--url requires --keyword');
  process.exit(1);
}

// ── csv helpers ───────────────────────────────────────────────────────────────

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
    .filter((r) => r.keyword && r.url && (r.url.includes('/collections/') || r.url.includes('/products/')));
  return { rows, filename };
}

/**
 * Pick top N collection/product pages by link-building opportunity.
 * Positions 5–20 have most leverage; scored × volume within each tier.
 */
function pickTopTargets(rows, n) {
  const byUrl = new Map();
  for (const r of rows) {
    if (r.position === null) continue;
    const existing = byUrl.get(r.url);
    if (!existing || r.volume > existing.volume) byUrl.set(r.url, r);
  }

  const score = (p) => {
    const vol = p.volume || 0;
    const pos = p.position;
    if (pos >= 5 && pos <= 20)  return vol * 3;
    if (pos >= 1 && pos <= 4)   return vol * 1;
    if (pos >= 21 && pos <= 50) return vol * 2;
    return 0;
  };

  return [...byUrl.values()].sort((a, b) => score(b) - score(a)).slice(0, n);
}

function tierLabel(pos) {
  if (pos <= 4)  return '✅ Page 1';
  if (pos <= 20) return '🚀 Quick win';
  if (pos <= 50) return '🔄 Refresh';
  return '❌ Low rank';
}

function pageType(url) {
  if (url.includes('/collections/')) return 'collection';
  if (url.includes('/products/')) return 'product';
  return 'page';
}

// ── article helpers ───────────────────────────────────────────────────────────

function isTopicallyRelevant(article, keyword) {
  const words = keyword.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  const text = `${article.title} ${article.tags || ''}`.toLowerCase();
  return words.some((w) => text.includes(w));
}

function alreadyLinksTo(bodyHtml, targetUrl) {
  const handle = targetUrl.split('/').pop();
  return bodyHtml.includes(targetUrl) || bodyHtml.includes(handle);
}

// ── claude link finder ────────────────────────────────────────────────────────

async function findLinkOpportunities(article, targetUrl, targetKeyword, targetTitle) {
  const bodyText = article.body_html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 6000);

  const type = pageType(targetUrl);
  const typeLabel = type === 'collection' ? 'product collection page' : 'product page';

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are an SEO editor adding internal links to a blog post on ${config.name}.

TARGET LINK TO ADD:
- Page type: ${typeLabel}
- Keyword: "${targetKeyword}"
- URL: ${targetUrl}
- Page title: ${targetTitle}

ARTICLE BEING EDITED:
- Title: "${article.title}"
- Body text (HTML stripped):
${bodyText}

Find up to 2 natural places in this article where a link to the target ${typeLabel} would genuinely help the reader — e.g. when the article mentions "${targetKeyword}" or closely related terms, and a reader would benefit from being able to shop/browse that category directly.

The anchor text must already exist as a phrase in the article body — you are NOT adding new sentences, only wrapping existing text in a link.

Rules:
- Only use text that ALREADY EXISTS verbatim in the article
- The phrase must be directly relevant to the target keyword/category
- Do not link the same phrase twice
- Do not suggest links in headings (H1/H2/H3)
- Prefer product/category keyword phrases over generic words like "here" or "this"
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

function injectLink(html, anchorText, url, title) {
  const escaped = anchorText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`(?<!<[^>]*)\\b(${escaped})\\b`, 'i');
  const idx = html.search(regex);
  if (idx === -1) return { html, applied: false };

  const before = html.slice(Math.max(0, idx - 300), idx).toLowerCase();
  const lastAOpen = before.lastIndexOf('<a ');
  const lastAClose = before.lastIndexOf('</a>');
  const lastHOpen = Math.max(before.lastIndexOf('<h1'), before.lastIndexOf('<h2'), before.lastIndexOf('<h3'));
  const lastHClose = Math.max(before.lastIndexOf('</h1>'), before.lastIndexOf('</h2>'), before.lastIndexOf('</h3>'));

  if (lastAOpen > lastAClose) return { html, applied: false };
  if (lastHOpen > lastHClose) return { html, applied: false };

  const safeTitle = title.replace(/"/g, '&quot;');
  const linked = html.replace(regex, `<a href="${url}" title="${safeTitle}">$1</a>`);
  return { html: linked, applied: linked !== html };
}

// ── per-target analysis ───────────────────────────────────────────────────────

async function analyzeTarget(targetUrl, targetKeyword, targetTitle, allArticles) {
  const pool = allArticles.filter((a) => !alreadyLinksTo(a.body_html || '', targetUrl));

  const candidates = pool.filter((a) => isTopicallyRelevant(a, targetKeyword));
  const toProcess = candidates.slice(0, limitArg);

  const results = [];
  let totalLinksAdded = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const article = toProcess[i];
    process.stdout.write(`    [${i + 1}/${toProcess.length}] "${article.title.slice(0, 50)}"... `);

    const suggestions = await findLinkOpportunities(article, targetUrl, targetKeyword, targetTitle);

    if (suggestions.length === 0) {
      console.log('no opportunities');
      results.push({ article, suggestions: [], linksAdded: 0 });
      continue;
    }

    let updatedHtml = article.body_html;
    let linksAdded = 0;

    for (const s of suggestions) {
      const { html: newHtml, applied } = injectLink(updatedHtml, s.anchor_text, targetUrl, targetTitle);
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

  return { targetUrl, targetKeyword, targetTitle, candidates, toProcess, results, totalLinksAdded };
}

function buildTargetSection(analysis, row) {
  const { targetUrl, targetKeyword, targetTitle, toProcess, results, totalLinksAdded } = analysis;
  const withOpportunities = results.filter((r) => r.suggestions.length > 0);
  const lines = [];

  if (row) {
    const pos = row.position != null ? `#${row.position}` : 'unranked';
    const vol = row.volume ? ` | vol ${row.volume.toLocaleString()}` : '';
    lines.push(`**Keyword:** ${targetKeyword}  |  **Position:** ${pos}${vol}`);
  }
  lines.push(`**Target URL:** ${targetUrl}`);
  lines.push(`**Page type:** ${pageType(targetUrl)}`);
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
    lines.push(`node agents/collection-linker/index.js --url "${targetUrl}" --keyword "${targetKeyword}" --apply`);
    lines.push('```\n');
  }

  return lines;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nCollection & Product Linker — ${config.name}`);
  console.log(`Mode: ${apply ? 'APPLY (will update Shopify)' : 'DRY RUN (use --apply to write changes)'}\n`);

  // Fetch all blog articles once
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
  console.log('');

  // ── Mode A: single URL ─────────────────────────────────────────────────────

  if (urlArg) {
    const targetUrl = urlArg;
    const targetKeyword = keywordArg;
    const handle = targetUrl.split('/').filter(Boolean).pop();
    const targetTitle = targetKeyword
      .split(' ')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    console.log(`  Target:  ${targetUrl}`);
    console.log(`  Keyword: ${targetKeyword}\n`);

    const analysis = await analyzeTarget(targetUrl, targetKeyword, targetTitle, allArticles);
    const { toProcess, results, totalLinksAdded } = analysis;
    const withOpportunities = results.filter((r) => r.suggestions.length > 0);
    const withNone = results.filter((r) => r.suggestions.length === 0);

    const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const lines = [];
    lines.push(`# Collection/Product Linker Report — "${targetKeyword}"`);
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
      lines.push(`node agents/collection-linker/index.js --url "${targetUrl}" --keyword "${targetKeyword}" --apply`);
      lines.push('```\n');
    }

    if (withNone.length > 0) {
      lines.push(`## No Opportunities Found (${withNone.length} articles)\n`);
      for (const r of withNone) lines.push(`- ${r.article.title}`);
      lines.push('');
    }

    mkdirSync(REPORTS_DIR, { recursive: true });
    const safeHandle = handle.replace(/[^a-z0-9-]/gi, '-');
    const reportPath = join(REPORTS_DIR, `${safeHandle}-collection-links.md`);
    writeFileSync(reportPath, lines.join('\n'));

    console.log(`\n  Report saved: ${reportPath}`);
    console.log(`  Links ${apply ? 'added' : 'identified'}: ${totalLinksAdded} across ${withOpportunities.length} article(s)`);
    if (!apply && totalLinksAdded > 0) {
      console.log(`\n  Run with --apply to write these to Shopify:`);
      console.log(`    node agents/collection-linker/index.js --url "${targetUrl}" --keyword "${targetKeyword}" --apply`);
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
    process.stdout.write('\n  Fetching collection/product quick-wins from Google Search Console... ');
    const gscPages = await gsc.getQuickWinPages(targetCount * 3, 90);
    const collectionPages = gscPages
      .filter((p) => p.url.includes('/collections/') || p.url.includes('/products/'))
      .map((p) => ({ keyword: p.keyword, position: p.position, volume: p.impressions, url: p.url }));
    targets = pickTopTargets(collectionPages, targetCount);
    dataSource = 'gsc';
    console.log(`${gscPages.length} pages found, ${targets.length} collection/product targets selected`);
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
    console.log(`  Keyword CSV: ${csvFile} (${csvRows.length} collection/product rows)`);
    targets = pickTopTargets(csvRows, targetCount);
    dataSource = csvFile;
  }

  if (targets.length === 0) {
    console.error('No rankable targets found.');
    process.exit(1);
  }

  console.log(`\n  Top ${targets.length} targets selected:\n`);
  targets.forEach((t, i) => {
    const vol = t.volume ? ` (${dataSource === 'gsc' ? 'impr' : 'vol'} ${t.volume.toLocaleString()})` : '';
    console.log(`  ${i + 1}. [#${Math.round(t.position)}] ${t.keyword}${vol} — ${tierLabel(t.position)}`);
    console.log(`     ${t.url}`);
  });
  console.log('');

  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const reportLines = [];
  reportLines.push(`# Collection & Product Link Opportunity Report — Top ${targets.length} Targets`);
  reportLines.push(`**Run date:** ${now}`);
  reportLines.push(`**Mode:** ${apply ? 'Applied' : 'Dry run'}`);
  reportLines.push(`**Source:** ${dataSource === 'gsc' ? 'Google Search Console (live)' : dataSource}`);
  reportLines.push('');
  reportLines.push('## Scoring');
  reportLines.push('Positions **5–20** = Quick win (most leverage for internal links).');
  reportLines.push('Positions **21–50** = Refresh candidate. Positions **1–4** = Page 1 (protect).');
  reportLines.push('Ranked within tiers by monthly search volume.');
  reportLines.push('');
  reportLines.push('---');
  reportLines.push('');

  let grandTotal = 0;

  for (let t = 0; t < targets.length; t++) {
    const row = targets[t];
    const targetUrl = row.url;
    const targetKeyword = row.keyword;
    const targetTitle = targetKeyword
      .split(' ')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    console.log(`\n  ── Target ${t + 1}/${targets.length}: "${targetKeyword}" [#${row.position}] ──`);
    console.log(`     ${targetUrl}`);

    let analysis;
    try {
      analysis = await analyzeTarget(targetUrl, targetKeyword, targetTitle, allArticles);
    } catch (e) {
      console.log(`     ERROR: ${e.message}`);
      reportLines.push(`## ${t + 1}. "${targetKeyword}" — #${row.position}`);
      reportLines.push(`**URL:** ${targetUrl}`);
      reportLines.push(`_Error: ${e.message}_\n`);
      reportLines.push('---\n');
      continue;
    }

    grandTotal += analysis.totalLinksAdded;
    reportLines.push(`## ${t + 1}. "${targetKeyword}" — ${tierLabel(row.position)}\n`);
    reportLines.push(...buildTargetSection(analysis, row));
    reportLines.push('---\n');
  }

  reportLines.push('');
  reportLines.push('## Summary');
  reportLines.push(`**Total links ${apply ? 'applied' : 'identified'}:** ${grandTotal} across ${targets.length} target pages`);
  if (!apply && grandTotal > 0) {
    reportLines.push('');
    reportLines.push('To apply all changes, run each target with `--apply`:');
    reportLines.push('```bash');
    targets.forEach((row) => {
      reportLines.push(`node agents/collection-linker/index.js --url "${row.url}" --keyword "${row.keyword}" --apply`);
    });
    reportLines.push('```');
  }

  mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = join(REPORTS_DIR, 'top-collection-links.md');
  writeFileSync(reportPath, reportLines.join('\n'));

  console.log(`\n  Report saved: ${reportPath}`);
  console.log(`  Total links ${apply ? 'applied' : 'identified'}: ${grandTotal}`);
}

main().then(() => {
  console.log('\nCollection linking complete.');
}).catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
