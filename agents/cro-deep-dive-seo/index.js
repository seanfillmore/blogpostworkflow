#!/usr/bin/env node
/**
 * CRO Deep Dive — SEO & Discovery
 *
 * Analyzes a blog post's title, meta description, keyword alignment,
 * internal links, and competitive SERP position.
 *
 * Usage:
 *   node agents/cro-deep-dive-seo/index.js --handle <handle> --item "<title>"
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getBlogs, getArticles } from '../../lib/shopify.js';
import { notify } from '../../lib/notify.js';
import { getSearchVolume, getSerpResults } from '../../lib/dataforseo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'cro', 'deep-dive');

const args = process.argv.slice(2);
const handle = args[args.indexOf('--handle') + 1];
const item   = args[args.indexOf('--item') + 1] || '';

if (!handle) {
  console.error('Usage: node index.js --handle <article-handle> --item "<title>"');
  process.exit(1);
}

function loadEnv() {
  try {
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
  } catch { return {}; }
}

const env = loadEnv();
const apiKey = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY in .env');

const client = new Anthropic({ apiKey });

// ── Shopify fetch ─────────────────────────────────────────────────────────────
async function fetchArticle(handle) {
  const blogs    = await getBlogs();
  const blog     = blogs.find(b => b.handle === 'news');
  if (!blog) throw new Error('Blog "news" not found');
  const articles = await getArticles(blog.id, { limit: 250 });
  const article  = articles.find(a => a.handle === handle);
  if (!article) throw new Error(`Article not found: ${handle}`);
  return article;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────
function stripTags(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extract article body content, stripping JSON-LD schema scripts and meta tags.
 * The blog-post-writer stores a full HTML document in body_html; <article> wraps
 * the actual content. Without this, word counts and element positions are off.
 */
function extractArticleContent(html) {
  const articleStart = html.indexOf('<article');
  const articleEnd = html.lastIndexOf('</article>');
  if (articleStart !== -1 && articleEnd > articleStart) {
    const afterTag = html.indexOf('>', articleStart);
    return html.slice(afterTag + 1, articleEnd);
  }
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<meta[^>]*/gi, '')
    .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, '');
}

function countInternalLinks(html) {
  const matches = html.match(/href="\/collections\/|href="\/products\//g);
  return matches ? matches.length : 0;
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('CRO Deep Dive — SEO & Discovery\n');
  console.log('  Handle:', handle);
  console.log('  Item:', item);

  console.log('  Fetching article from Shopify...');
  const article = await fetchArticle(handle);
  // Extract article body only — body_html may contain a full HTML document
  // (meta tags, JSON-LD schema scripts) written by the blog-post-writer
  const html = extractArticleContent(article.body_html || '');
  const pageUrl = `https://www.realskincare.com/blogs/news/${handle}`;
  console.log('  Article:', article.title);

  const titleTag      = article.title || '';
  const metaDesc      = article.summary_html ? stripTags(article.summary_html) : '';
  // H1 is rendered by the Shopify theme from article.title — it is never in body_html
  const h1            = article.title || '';
  const internalLinks = countInternalLinks(html);

  // GSC per-page keyword data
  console.log('  Fetching GSC keywords for this page...');
  let gscKeywords = [];
  try {
    const { getPageKeywords } = await import('../../lib/gsc.js');
    gscKeywords = await getPageKeywords(pageUrl, 5, 90);
    console.log(`  GSC keywords: ${gscKeywords.length} found`);
  } catch (e) {
    console.warn('  GSC unavailable:', e.message);
  }

  // DataForSEO keyword volume + SERP for top query
  let kwVolume = null;
  let serpData = null;
  const topQuery = gscKeywords[0]?.keyword;
  if (topQuery) {
    console.log(`  Fetching DataForSEO data for top query: "${topQuery}"...`);
    try {
      const [vol] = await getSearchVolume([topQuery]);
      if (vol) kwVolume = { volume: vol.volume, cpc: vol.cpc, competition: vol.competition };
    } catch (e) {
      console.warn(`  DataForSEO volume lookup failed: ${e.message}`);
    }
    try {
      serpData = await getSerpResults(topQuery, 10);
    } catch (e) {
      console.warn(`  DataForSEO SERP lookup failed: ${e.message}`);
    }
  }

  // Build findings summary
  const lines = [
    `Article: "${article.title}"`,
    `URL: ${pageUrl}`,
    '',
    '--- On-Page SEO ---',
    `Title tag: "${titleTag}" (${titleTag.length} chars)`,
    `H1 (Shopify theme renders article.title as H1): "${h1}"`,
    `Meta description: ${metaDesc ? '"' + metaDesc.slice(0, 200) + (metaDesc.length > 200 ? '...' : '') + '" (' + metaDesc.length + ' chars)' : 'MISSING'}`,
    `Internal links to collections/products: ${internalLinks}`,
    '',
    '--- GSC Performance (top 5 queries for this page, 90 days) ---',
  ];

  if (gscKeywords.length === 0) {
    lines.push('No GSC data available for this page.');
  } else {
    gscKeywords.forEach((k, i) => {
      const ctrPct = (k.ctr * 100).toFixed(1);
      lines.push(`${i + 1}. "${k.keyword}" — ${k.impressions} impressions, #${k.position?.toFixed(1)} avg position, ${ctrPct}% CTR`);
    });
  }

  lines.push('', '--- DataForSEO Keyword Data ---');
  if (!topQuery) {
    lines.push('No top query found — no keyword data.');
  } else if (kwVolume) {
    const cpc = kwVolume.cpc != null ? `, $${kwVolume.cpc.toFixed(2)} CPC` : '';
    lines.push(`Top query: "${topQuery}" — ${kwVolume.volume ?? 'N/A'} monthly searches${cpc}`);
  } else {
    lines.push(`DataForSEO unavailable or no data for "${topQuery}"`);
  }

  if (serpData?.organic?.length) {
    const top5 = serpData.organic.slice(0, 5);
    lines.push(`SERP top 5 for "${topQuery}":`);
    top5.forEach((p, i) => {
      const isSite = p.url?.includes('realskincare.com');
      lines.push(`  ${i + 1}. ${p.url}${isSite ? ' <- OUR PAGE' : ''}`);
    });
  }

  const findingsSummary = lines.join('\n');
  console.log('\nFindings:\n' + findingsSummary);

  console.log('\n  Generating report with Claude...');
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `You are a senior SEO analyst. You have automated findings from a blog post analysis.

ACTION ITEM BEING ANALYZED: "${item}"

AUTOMATED FINDINGS:
${findingsSummary}

Write the report in this exact format:

## SEO & Discovery Deep Dive — ${article.title}
**Page:** ${pageUrl}
**Action Item Analyzed:** ${item}

### What We Found
[3-6 bullet points with specific numbers. Flag: keyword not in title/H1/meta, meta too long/short, low CTR vs position, few internal links, competitor patterns from SERP.]

### Action Plan
[3-5 numbered specific actions. For title rewrites, provide the actual rewritten title in quotes. For meta descriptions, provide the actual suggested copy (<=160 chars). For internal links, name which collections/products to link to. For featured snippet opportunity, suggest the exact paragraph structure.]

Base all recommendations on the data. Do not invent issues not present in the findings.`,
    }],
  });

  if (!response.content?.[0]?.text) throw new Error('Claude returned empty content');
  const reportContent = response.content[0].text;

  mkdirSync(REPORTS_DIR, { recursive: true });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const reportPath = join(REPORTS_DIR, `${today}-seo-${handle}.md`);
  writeFileSync(reportPath, reportContent);
  console.log('\n  Saved to:', reportPath);
  console.log('\n' + reportContent);

  await notify({
    subject: `CRO Deep Dive SEO: ${handle}`,
    body: reportContent,
    status: 'success',
  }).catch(() => {});

  console.log('\n  Done.');
}

main().catch(async err => {
  console.error('Error:', err.message);
  await notify({ subject: 'CRO Deep Dive SEO failed', body: err.message, status: 'error' }).catch(() => {});
  process.exit(1);
});
