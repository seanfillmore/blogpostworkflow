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
const ahrefsKey = env.AHREFS_API_KEY;

const client = new Anthropic({ apiKey });

// ── Ahrefs REST API ───────────────────────────────────────────────────────────
const AHREFS_BASE = 'https://api.ahrefs.com/v3';

async function ahrefs(endpoint, params) {
  if (!ahrefsKey) return null;
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${AHREFS_BASE}${endpoint}?${qs}`, {
    headers: { Authorization: `Bearer ${ahrefsKey}` },
  });
  if (!res.ok) {
    console.warn(`  Ahrefs ${endpoint} → HTTP ${res.status} (skipping)`);
    return null;
  }
  return res.json();
}

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

function extractH1(html) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? stripTags(m[1]) : null;
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
  const html = article.body_html || '';
  const pageUrl = `https://www.realskincare.com/blogs/news/${handle}`;
  console.log('  Article:', article.title);

  const titleTag      = article.title || '';
  const metaDesc      = article.summary_html ? stripTags(article.summary_html) : '';
  const h1            = extractH1(html);
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

  // Ahrefs keyword overview + SERP for top query
  let kwOverview = null;
  let serpData   = null;
  const topQuery = gscKeywords[0]?.keyword;
  if (topQuery && ahrefsKey) {
    console.log(`  Fetching Ahrefs data for top query: "${topQuery}"...`);
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const todayStr = new Date().toISOString().split('T')[0];
    kwOverview = await ahrefs('/keywords-explorer/overview', {
      keywords: topQuery,
      country: 'us',
      date_from: thirtyDaysAgo,
      date_to: todayStr,
    });
    serpData = await ahrefs('/serp-overview', {
      keyword: topQuery,
      country: 'us',
    });
  }

  // Build findings summary
  const lines = [
    `Article: "${article.title}"`,
    `URL: ${pageUrl}`,
    '',
    '--- On-Page SEO ---',
    `Title tag: "${titleTag}" (${titleTag.length} chars)`,
    `H1: ${h1 ? '"' + h1 + '"' : 'NOT FOUND'}`,
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

  lines.push('', '--- Ahrefs Keyword Data ---');
  if (!topQuery) {
    lines.push('No top query found — no Ahrefs data.');
  } else if (kwOverview) {
    const kd  = kwOverview.keywords?.[0]?.difficulty ?? 'N/A';
    const vol = kwOverview.keywords?.[0]?.volume ?? 'N/A';
    lines.push(`Top query: "${topQuery}" — KD ${kd}, ${vol} monthly searches`);
  } else {
    lines.push(`Ahrefs unavailable or no data for "${topQuery}"`);
  }

  if (serpData?.positions) {
    const top5 = serpData.positions.slice(0, 5);
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
