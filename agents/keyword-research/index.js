/**
 * Keyword Research Agent
 *
 * Uses the Ahrefs API to:
 *   1. Audit current rankings and map them against internal pillar pages
 *   2. Find keyword opportunities in the site's core topics
 *   3. Identify competitor keyword gaps
 *   4. Generate a prioritised list of future blog post ideas
 *
 * Requires: data/link-audit.json (run internal-link-auditor first)
 *           AHREFS_API_KEY in .env
 * Output:   data/keyword-research.json + data/keyword-research-report.md
 * Usage:    node agents/keyword-research/index.js
 */

import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

// ── env ───────────────────────────────────────────────────────────────────────

function loadEnv() {
  const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return env;
}

const env = loadEnv();
const AHREFS_KEY = env.AHREFS_API_KEY;
if (!AHREFS_KEY) {
  console.error('Missing AHREFS_API_KEY in .env');
  process.exit(1);
}

// ── ahrefs client ─────────────────────────────────────────────────────────────

const AHREFS_BASE = 'https://api.ahrefs.com/v3';

async function ahrefs(endpoint, params) {
  const qs = new URLSearchParams(params).toString();
  const url = `${AHREFS_BASE}${endpoint}?${qs}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AHREFS_KEY}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ahrefs ${endpoint} → HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

// Convenience: site-explorer endpoint
function siteExplorer(report, params) {
  return ahrefs(`/site-explorer/${report}`, params);
}

// Convenience: keywords-explorer endpoint
function keywordsExplorer(report, params) {
  return ahrefs(`/keywords-explorer/${report}`, params);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function loadAudit() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'data', 'link-audit.json'), 'utf8'));
  } catch {
    console.error('data/link-audit.json not found. Run internal-link-auditor first.');
    process.exit(1);
  }
}

const DOMAIN = new URL(config.url).hostname.replace(/^www\./, '');
const TODAY = new Date().toISOString().split('T')[0];

// ── core queries ──────────────────────────────────────────────────────────────

async function getTopPages() {
  const data = await siteExplorer('pages-by-traffic', {
    target: DOMAIN,
    mode: 'subdomains',
    date: TODAY,
    country: 'us',
    limit: 30,
    select: 'url,sum_traffic,top_keyword,top_keyword_volume,top_keyword_best_position,keywords',
    order_by: 'sum_traffic:desc',
  });
  return data.pages || [];
}

async function getOrganicKeywords() {
  const data = await siteExplorer('organic-keywords', {
    target: DOMAIN,
    mode: 'subdomains',
    date: TODAY,
    country: 'us',
    limit: 100,
    select: 'keyword,best_position,volume,keyword_difficulty,sum_traffic,best_position_url',
    order_by: 'sum_traffic:desc',
  });
  return data.keywords || [];
}

async function getCompetitors() {
  const data = await siteExplorer('organic-competitors', {
    target: DOMAIN,
    mode: 'subdomains',
    date: TODAY,
    country: 'us',
    limit: 10,
    select: 'competitor_domain,keywords_common,keywords_competitor,traffic,value',
    order_by: 'keywords_common:desc',
  });
  return data.competitors || [];
}

async function getKeywordOpportunities(seeds) {
  const data = await keywordsExplorer('matching-terms', {
    country: 'us',
    keywords: seeds.join(','),
    select: 'keyword,volume,difficulty,traffic_potential,cpc',
    limit: 50,
    order_by: 'volume:desc',
    where: JSON.stringify({
      and: [
        { field: 'volume', is: ['gte', 300] },
        { field: 'difficulty', is: ['lte', 35] },
      ],
    }),
  });
  return data.keywords || [];
}

// ── pillar audit ──────────────────────────────────────────────────────────────

function auditPillars(pillarPages, topPages, organicKeywords) {
  const trafficMap = {};
  for (const p of topPages) trafficMap[p.url] = p;

  const keywordMap = {};
  for (const k of organicKeywords) {
    const url = k.best_position_url;
    if (!keywordMap[url]) keywordMap[url] = [];
    keywordMap[url].push(k);
  }

  return pillarPages.filter((p) => p.type === 'blog_post').slice(0, 15).map((p) => {
    const traffic = trafficMap[p.url];
    const keywords = keywordMap[p.url] || [];
    const topKw = keywords[0];
    return {
      url: p.url,
      slug: p.slug,
      inbound_links: p.inbound_count,
      monthly_traffic: traffic?.sum_traffic || 0,
      top_keyword: topKw?.keyword || null,
      top_keyword_volume: topKw?.volume || 0,
      top_keyword_position: topKw?.best_position || null,
      keyword_count: keywords.length,
      seo_aligned: (traffic?.sum_traffic || 0) > 10,
    };
  });
}

// ── blog post ideas ───────────────────────────────────────────────────────────

function generateBlogIdeas(opportunities, existingKeywords) {
  const existingKwSet = new Set(existingKeywords.map((k) => k.keyword.toLowerCase()));

  // Filter to only keywords the site doesn't already rank for
  const gaps = opportunities.filter((k) => !existingKwSet.has(k.keyword.toLowerCase()));

  // Score: volume * (1 / (difficulty + 1)) * log(traffic_potential + 1)
  const scored = gaps.map((k) => ({
    ...k,
    opportunity_score: Math.round(
      (k.volume / (k.difficulty + 1)) * Math.log10((k.traffic_potential || 1) + 1)
    ),
  }));

  scored.sort((a, b) => b.opportunity_score - a.opportunity_score);

  return scored.slice(0, 20).map((k) => ({
    suggested_title: suggestTitle(k.keyword),
    target_keyword: k.keyword,
    search_volume: k.volume,
    keyword_difficulty: k.difficulty,
    traffic_potential: k.traffic_potential,
    opportunity_score: k.opportunity_score,
    cpc_cents: k.cpc,
    page_type: k.volume > 2000 ? 'blog_roundup' : 'blog_informational',
  }));
}

function suggestTitle(keyword) {
  const kw = keyword.trim();
  // "best X" → "Best X: [Year] Guide"
  if (/^best /i.test(kw)) return `${kw.replace(/\b\w/g, (c) => c.toUpperCase())}: Complete [Year] Guide`;
  // "how to" → keep as question
  if (/^how to/i.test(kw)) return `${kw.replace(/\b\w/g, (c) => c.toUpperCase())} (Step-by-Step)`;
  // "is X" / "does X" → question format
  if (/^(is |does |can |should )/i.test(kw)) return kw.replace(/\b\w/g, (c) => c.toUpperCase()) + '?';
  // default → "X: What You Need to Know"
  return `${kw.replace(/\b\w/g, (c) => c.toUpperCase())}: Everything You Need to Know`;
}

// ── report ────────────────────────────────────────────────────────────────────

function generateReport(data) {
  const lines = [];
  lines.push(`# Keyword Research Report — ${config.name}`);
  lines.push(`Generated: ${new Date().toLocaleString()}\n`);

  // Pillar audit
  lines.push('## Pillar Page Audit');
  lines.push('Are the most internally-linked pages capturing meaningful search traffic?\n');
  lines.push('| Pillar Page | Internal Links | Monthly Traffic | Top Keyword | Vol | Pos | Aligned? |');
  lines.push('|-------------|---------------|-----------------|-------------|-----|-----|----------|');
  for (const p of data.pillar_audit) {
    const aligned = p.seo_aligned ? '✓' : '✗ needs work';
    lines.push(`| [${p.slug}](${p.url}) | ${p.inbound_links} | ${p.monthly_traffic} | ${p.top_keyword || '—'} | ${p.top_keyword_volume || '—'} | ${p.top_keyword_position || '—'} | ${aligned} |`);
  }
  lines.push('');

  // Top competitors
  lines.push('## Top Competitors');
  lines.push('| Competitor | Common Keywords | Their Keywords | Monthly Traffic |');
  lines.push('|------------|----------------|----------------|-----------------|');
  for (const c of data.competitors) {
    lines.push(`| ${c.competitor_domain} | ${c.keywords_common} | ${c.keywords_competitor?.toLocaleString() || '—'} | ${c.traffic?.toLocaleString() || '—'} |`);
  }
  lines.push('');

  // Blog post ideas
  lines.push('## Blog Post Opportunities');
  lines.push('Keywords competitors rank for that this site does not yet target, ranked by opportunity score.\n');
  lines.push('| # | Suggested Title | Target Keyword | Volume | KD | Traffic Potential | Score |');
  lines.push('|---|----------------|----------------|--------|-----|-------------------|-------|');
  data.blog_ideas.forEach((idea, i) => {
    lines.push(`| ${i + 1} | ${idea.suggested_title} | ${idea.target_keyword} | ${idea.search_volume.toLocaleString()} | ${idea.keyword_difficulty} | ${idea.traffic_potential?.toLocaleString() || '—'} | ${idea.opportunity_score} |`);
  });
  lines.push('');

  return lines.join('\n');
}

// ── run ───────────────────────────────────────────────────────────────────────

// Core seed topics — loaded from config/site.json so they're configurable per site
const SEED_TOPICS = config.seed_topics || [];

async function run() {
  console.log(`\nKeyword Research Agent — ${config.name}\n`);

  const audit = loadAudit();

  console.log('Fetching Ahrefs data (4 queries)...');
  const [topPages, organicKeywords, competitors, opportunities] = await Promise.all([
    getTopPages(),
    getOrganicKeywords(),
    getCompetitors(),
    getKeywordOpportunities(SEED_TOPICS),
  ]);

  console.log(`  Top pages:          ${topPages.length}`);
  console.log(`  Ranking keywords:   ${organicKeywords.length}`);
  console.log(`  Competitors:        ${competitors.length}`);
  console.log(`  Keyword gaps found: ${opportunities.length}\n`);

  const pillarAudit = auditPillars(audit.pillar_pages, topPages, organicKeywords);
  const blogIdeas = generateBlogIdeas(opportunities, organicKeywords);

  const output = {
    meta: {
      site: config.name,
      generated_at: new Date().toISOString(),
      total_ranking_keywords: organicKeywords.length,
      total_blog_ideas: blogIdeas.length,
    },
    pillar_audit: pillarAudit,
    top_pages: topPages,
    competitors,
    keyword_opportunities: opportunities,
    blog_ideas: blogIdeas,
  };

  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(join(ROOT, 'data', 'keyword-research.json'), JSON.stringify(output, null, 2));
  writeFileSync(join(ROOT, 'data', 'keyword-research-report.md'), generateReport(output));

  console.log('='.repeat(50));
  console.log('KEYWORD RESEARCH COMPLETE');
  console.log('='.repeat(50));
  console.log(`Pillar pages audited: ${pillarAudit.length}`);
  console.log(`Blog post ideas:      ${blogIdeas.length}`);
  const misaligned = pillarAudit.filter((p) => !p.seo_aligned).length;
  console.log(`Misaligned pillars:   ${misaligned}`);
  console.log(`\nOutputs:`);
  console.log(`  data/keyword-research.json`);
  console.log(`  data/keyword-research-report.md`);
}

run().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
