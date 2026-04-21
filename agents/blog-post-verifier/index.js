/**
 * Blog Post Verifier Agent
 *
 * Pulls live blog posts from Shopify and validates each one:
 *   1. Outbound link health — HTTP HEAD every external link, flag 404s/timeouts
 *   2. Internal link validity — every internal link must exist in the current sitemap
 *   3. Factual claim verification — Claude cross-checks flagged claims against source content
 *   4. Freshness — flags posts not updated in > 6 months with stale date references
 *   5. Meta quality — checks summary_html (meta description) length and presence
 *
 * Output: data/reports/verifier-report.md
 *
 * Usage:
 *   node agents/blog-post-verifier/index.js            # verify all posts
 *   node agents/blog-post-verifier/index.js <slug>     # verify one post
 *   node agents/blog-post-verifier/index.js --limit 10 # verify N most recent
 */

import Anthropic from '@anthropic-ai/sdk';
import * as cheerio from 'cheerio';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getBlogs, getArticles, getArticle } from '../../lib/shopify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
const SITE_HOST = new URL(config.url).hostname;

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
const slugArg = args.find((a) => !a.startsWith('--'));
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;

// ── helpers ───────────────────────────────────────────────────────────────────

function loadSitemap() {
  try { return JSON.parse(readFileSync(join(ROOT, 'data', 'sitemap-index.json'), 'utf8')); }
  catch { return null; }
}

async function checkUrl(href) {
  try {
    const res = await fetch(href, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEO-Verifier-Bot/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });
    return { ok: res.ok, status: res.status, finalUrl: res.url };
  } catch (e) {
    return { ok: false, status: null, error: e.message };
  }
}

function extractLinks(html) {
  const $ = cheerio.load(html);
  const links = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (!href || href.startsWith('#') || href.startsWith('mailto:')) return;
    links.push({ href, text });
  });
  return links;
}

function categoriseLinks(links) {
  const internal = [];
  const external = [];
  for (const link of links) {
    try {
      const url = new URL(link.href);
      if (url.hostname === SITE_HOST || url.hostname === `www.${SITE_HOST}`) {
        internal.push(link);
      } else {
        external.push(link);
      }
    } catch {
      internal.push(link); // relative URL
    }
  }
  return { internal, external };
}

function checkInternalLinks(internalLinks, sitemap) {
  if (!sitemap) return [];
  const sitemapUrls = new Set(sitemap.pages?.map((p) => p.url) || []);
  const issues = [];
  for (const link of internalLinks) {
    // Normalize: strip trailing slash, strip fragment
    const normalized = link.href.replace(/#.*$/, '').replace(/\/$/, '');
    const found = [...sitemapUrls].some((u) => u.replace(/\/$/, '') === normalized);
    if (!found) issues.push(link);
  }
  return issues;
}

function detectStaleYears(html) {
  const currentYear = new Date().getFullYear();
  const text = html.replace(/<[^>]+>/g, ' ');
  const staleYears = [];
  for (let year = 2020; year < currentYear - 1; year++) {
    if (new RegExp(`\\b${year}\\b`).test(text)) {
      staleYears.push(year);
    }
  }
  return staleYears;
}

function checkMetaQuality(article) {
  const issues = [];
  const meta = article.summary_html?.replace(/<[^>]+>/g, '').trim() || '';
  if (!meta) {
    issues.push('Missing meta description (summary_html is empty)');
  } else if (meta.length < 120) {
    issues.push(`Meta description too short (${meta.length} chars, target 140–155)`);
  } else if (meta.length > 160) {
    issues.push(`Meta description too long (${meta.length} chars, target 140–155)`);
  }
  return issues;
}

function checkFreshness(article) {
  const updatedAt = new Date(article.updated_at);
  const monthsOld = (Date.now() - updatedAt) / (1000 * 60 * 60 * 24 * 30);
  return monthsOld > 6 ? Math.round(monthsOld) : null;
}

async function verifyClaimsWithClaude(article) {
  const text = article.body_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are a fact-checker reviewing a blog post for a natural skincare brand.

Read the following post and identify any specific factual claims that:
1. Reference a specific statistic, study, or scientific finding
2. Make a comparative claim (e.g., "X is 3x more effective than Y")
3. State something as medical fact (e.g., "aluminum causes X")

For each claim, assess whether it is:
- LIKELY_ACCURATE — common, verifiable, non-controversial
- NEEDS_REVIEW — specific enough to warrant verification; may be outdated or overstated
- CONCERNING — appears exaggerated, unsupported, or could expose the brand to liability

Return a JSON array of objects: [{"claim": "...", "verdict": "LIKELY_ACCURATE|NEEDS_REVIEW|CONCERNING", "note": "..."}]
Return [] if no specific claims warrant review.
Return ONLY valid JSON, no markdown.

POST TITLE: ${article.title}

POST TEXT:
${text.slice(0, 8000)}`,
    }],
  });

  try {
    const raw = msg.content[0].text.trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// ── per-article verification ──────────────────────────────────────────────────

async function verifyArticle(article, blogHandle, sitemap) {
  const url = `${config.url}/blogs/${blogHandle}/${article.handle}`;
  const result = {
    title: article.title,
    url,
    handle: article.handle,
    updated_at: article.updated_at,
    brokenExternal: [],
    internalIssues: [],
    metaIssues: [],
    staleYears: [],
    claimsToReview: [],
    monthsOld: null,
  };

  const links = extractLinks(article.body_html);
  const { internal, external } = categoriseLinks(links);

  // 1. Check external links (parallel, capped at 10 at a time)
  process.stdout.write('  links');
  const externalUnique = [...new Map(external.map((l) => [l.href, l])).values()];
  const chunkSize = 10;
  for (let i = 0; i < externalUnique.length; i += chunkSize) {
    const chunk = externalUnique.slice(i, i + chunkSize);
    const checks = await Promise.all(chunk.map(async (link) => ({ ...link, check: await checkUrl(link.href) })));
    result.brokenExternal.push(...checks.filter((c) => !c.check.ok));
  }

  // 2. Internal links vs sitemap
  process.stdout.write(' internal');
  result.internalIssues = checkInternalLinks(internal, sitemap);

  // 3. Meta quality
  result.metaIssues = checkMetaQuality(article);

  // 4. Freshness
  result.monthsOld = checkFreshness(article);

  // 5. Stale years in text
  result.staleYears = detectStaleYears(article.body_html);

  // 6. Claim verification (only if post has suspicious claims)
  process.stdout.write(' claims');
  result.claimsToReview = await verifyClaimsWithClaude(article);

  return result;
}

// ── report builder ────────────────────────────────────────────────────────────

function buildReport(results, generatedAt) {
  const totalIssues = results.reduce((sum, r) =>
    sum + r.brokenExternal.length + r.internalIssues.length + r.metaIssues.length +
    r.claimsToReview.filter((c) => c.verdict !== 'LIKELY_ACCURATE').length, 0);

  const lines = [
    `# Blog Post Verification Report — ${config.name}`,
    `**Generated:** ${generatedAt}`,
    `**Posts verified:** ${results.length}`,
    `**Total issues found:** ${totalIssues}`,
    '',
    '---',
    '',
  ];

  // Summary table
  lines.push('## Summary\n');
  lines.push('| Post | Broken Links | Internal Issues | Meta Issues | Stale Years | Claims to Review |');
  lines.push('|------|-------------|-----------------|-------------|-------------|-----------------|');
  for (const r of results) {
    const claimsFlag = r.claimsToReview.filter((c) => c.verdict !== 'LIKELY_ACCURATE').length;
    const ageFlag = r.monthsOld ? ` *(${r.monthsOld}mo old)*` : '';
    const freshFlag = r.staleYears.length > 0 ? ` ⚠️ ${r.staleYears.join(', ')}` : '';
    lines.push(
      `| [${r.title}](${r.url})${ageFlag} | ${r.brokenExternal.length} | ${r.internalIssues.length} | ${r.metaIssues.length} | ${freshFlag || '—'} | ${claimsFlag} |`
    );
  }
  lines.push('');

  // Per-post detail (only posts with issues)
  const postsWithIssues = results.filter((r) =>
    r.brokenExternal.length || r.internalIssues.length || r.metaIssues.length ||
    r.staleYears.length || r.claimsToReview.some((c) => c.verdict !== 'LIKELY_ACCURATE')
  );

  if (postsWithIssues.length === 0) {
    lines.push('## ✅ All posts passed verification\n');
    return lines.join('\n');
  }

  lines.push('---\n');
  lines.push('## Issue Details\n');

  for (const r of postsWithIssues) {
    lines.push(`### [${r.title}](${r.url})`);
    lines.push(`*Updated: ${new Date(r.updated_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}*\n`);

    if (r.brokenExternal.length) {
      lines.push('**🔴 Broken External Links:**');
      for (const l of r.brokenExternal) {
        lines.push(`- \`${l.href}\` — "${l.text}" (${l.check.status ?? l.check.error})`);
      }
      lines.push('');
    }

    if (r.internalIssues.length) {
      lines.push('**🟠 Internal Links Not in Sitemap:**');
      for (const l of r.internalIssues) {
        lines.push(`- \`${l.href}\` — "${l.text}"`);
      }
      lines.push('');
    }

    if (r.metaIssues.length) {
      lines.push('**🟡 Meta Description Issues:**');
      for (const issue of r.metaIssues) {
        lines.push(`- ${issue}`);
      }
      lines.push('');
    }

    if (r.staleYears.length) {
      lines.push(`**🕐 Stale Year References:** ${r.staleYears.join(', ')} found in post text — consider updating.`);
      lines.push('');
    }

    const reviewClaims = r.claimsToReview.filter((c) => c.verdict !== 'LIKELY_ACCURATE');
    if (reviewClaims.length) {
      lines.push('**🔍 Claims Requiring Review:**');
      for (const c of reviewClaims) {
        const icon = c.verdict === 'CONCERNING' ? '🔴' : '🟡';
        lines.push(`- ${icon} **${c.verdict}:** "${c.claim}"`);
        if (c.note) lines.push(`  - *${c.note}*`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nBlog Post Verifier — ${config.name}\n`);

  const sitemap = loadSitemap();
  if (!sitemap) console.warn('  ⚠️  No sitemap-index.json found — internal link checks will be skipped.');

  // Fetch all blogs + articles from Shopify
  process.stdout.write('  Fetching blogs from Shopify... ');
  const blogs = await getBlogs();
  console.log(`${blogs.length} blog(s)`);

  let articles = [];
  for (const blog of blogs) {
    process.stdout.write(`  Fetching articles from "${blog.title}"... `);
    const blogArticles = await getArticles(blog.id);
    articles.push(...blogArticles.map((a) => ({ ...a, blogHandle: blog.handle, blogId: blog.id })));
    console.log(`${blogArticles.length} articles`);
  }

  // Filter by slug if provided — fall back to shopify_handle from meta if slug doesn't match
  if (slugArg) {
    articles = articles.filter((a) => a.handle === slugArg || a.handle.includes(slugArg));
    if (articles.length === 0) {
      try {
        const { getPostMeta } = await import('../../lib/posts.js');
        const meta = getPostMeta(slugArg);
        if (meta?.shopify_handle) {
          articles = (await Promise.all(blogs.map((b) => getArticles(b.id)))).flat();
          articles = articles.filter((a) => a.handle === meta.shopify_handle);
        }
      } catch { /* proceed to error */ }
    }
    if (articles.length === 0) {
      console.error(`No article found matching slug: ${slugArg}`);
      process.exit(1);
    }
  }

  // Apply limit (most recent first)
  articles.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
  if (limit) articles = articles.slice(0, limit);

  console.log(`\n  Verifying ${articles.length} post(s)...\n`);

  const results = [];
  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    process.stdout.write(`  [${i + 1}/${articles.length}] "${article.title.slice(0, 50)}"... `);
    const result = await verifyArticle(article, article.blogHandle, sitemap);
    results.push(result);
    const issueCount = result.brokenExternal.length + result.internalIssues.length +
      result.metaIssues.length + result.claimsToReview.filter((c) => c.verdict !== 'LIKELY_ACCURATE').length;
    console.log(` ${issueCount > 0 ? `⚠️  ${issueCount} issue(s)` : '✓'}`);
  }

  // Build and save report
  const generatedAt = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const report = buildReport(results, generatedAt);

  mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = join(REPORTS_DIR, 'verifier-report.md');
  writeFileSync(reportPath, report);

  const totalIssues = results.reduce((sum, r) =>
    sum + r.brokenExternal.length + r.internalIssues.length + r.metaIssues.length +
    r.claimsToReview.filter((c) => c.verdict !== 'LIKELY_ACCURATE').length, 0);

  console.log(`\n  Report saved: ${reportPath}`);
  console.log(`  Total issues: ${totalIssues} across ${results.length} post(s)`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
