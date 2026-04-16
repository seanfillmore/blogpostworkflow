/**
 * Keyword Research Agent
 *
 * Uses DataForSEO to:
 *   1. Audit current rankings and map them against internal pillar pages
 *   2. Find keyword opportunities in the site's core topics
 *   3. Identify competitor keyword gaps
 *   4. Generate a prioritised list of future blog post ideas
 *
 * Requires: data/link-audit.json (run internal-link-auditor first)
 *           DATAFORSEO_PASSWORD in .env
 * Output:   data/keyword-research.json + data/keyword-research-report.md
 * Usage:    node agents/keyword-research/index.js
 */

import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  getTopPages as dfsTopPages,
  getRankedKeywords,
  getCompetitors as dfsCompetitors,
  getKeywordIdeas,
} from '../../lib/dataforseo.js';

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
if (!env.DATAFORSEO_PASSWORD) {
  console.error('Missing DATAFORSEO_PASSWORD in .env');
  process.exit(1);
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

// ── core queries (DataForSEO-backed, reshaped to match downstream consumers) ──

async function getTopPages() {
  const pages = await dfsTopPages(DOMAIN, { limit: 30 });
  return pages.map((p) => ({
    url: p.url,
    sum_traffic: p.traffic ?? 0,
    keywords: p.keywords ?? 0,
    top_keyword: p.topKeyword ?? null,
  }));
}

async function getOrganicKeywords() {
  const kws = await getRankedKeywords(DOMAIN, { limit: 100 });
  return kws.map((k) => ({
    keyword: k.keyword,
    best_position: k.position,
    volume: k.volume ?? 0,
    keyword_difficulty: k.kd ?? null,
    sum_traffic: k.traffic ?? 0,
    best_position_url: k.url?.startsWith('http')
      ? k.url
      : `${config.url.replace(/\/$/, '')}${k.url ?? ''}`,
  }));
}

async function getCompetitors() {
  const comps = await dfsCompetitors(DOMAIN, { limit: 10 });
  return comps.map((c) => ({
    competitor_domain: c.domain,
    keywords_common: c.commonKeywords ?? 0,
    keywords_competitor: c.organicKeywords ?? 0,
    traffic: c.organicTraffic ?? 0,
  }));
}

async function getKeywordOpportunities(seeds) {
  if (!seeds || seeds.length === 0) return [];
  const ideas = await getKeywordIdeas(seeds, { limit: 50 });
  return ideas
    .filter((k) => (k.volume ?? 0) >= 300)
    .filter((k) => (k.kd ?? 0) <= 35)
    .map((k) => ({
      keyword: k.keyword,
      volume: k.volume ?? 0,
      difficulty: k.kd ?? 0,
      traffic_potential: k.trafficPotential ?? 0,
      cpc: k.cpc ?? 0,
    }))
    .sort((a, b) => b.volume - a.volume);
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
  if (/^best /i.test(kw)) return `${kw.replace(/\b\w/g, (c) => c.toUpperCase())}: Complete [Year] Guide`;
  if (/^how to/i.test(kw)) return `${kw.replace(/\b\w/g, (c) => c.toUpperCase())} (Step-by-Step)`;
  if (/^(is |does |can |should )/i.test(kw)) return kw.replace(/\b\w/g, (c) => c.toUpperCase()) + '?';
  return `${kw.replace(/\b\w/g, (c) => c.toUpperCase())}: Everything You Need to Know`;
}

// ── report ────────────────────────────────────────────────────────────────────

function generateReport(data) {
  const lines = [];
  lines.push(`# Keyword Research Report — ${config.name}`);
  lines.push(`Generated: ${new Date().toLocaleString()}\n`);

  lines.push('## Pillar Page Audit');
  lines.push('Are the most internally-linked pages capturing meaningful search traffic?\n');
  lines.push('| Pillar Page | Internal Links | Monthly Traffic | Top Keyword | Vol | Pos | Aligned? |');
  lines.push('|-------------|---------------|-----------------|-------------|-----|-----|----------|');
  for (const p of data.pillar_audit) {
    const aligned = p.seo_aligned ? '✓' : '✗ needs work';
    lines.push(`| [${p.slug}](${p.url}) | ${p.inbound_links} | ${p.monthly_traffic} | ${p.top_keyword || '—'} | ${p.top_keyword_volume || '—'} | ${p.top_keyword_position || '—'} | ${aligned} |`);
  }
  lines.push('');

  lines.push('## Top Competitors');
  lines.push('| Competitor | Common Keywords | Their Keywords | Monthly Traffic |');
  lines.push('|------------|----------------|----------------|-----------------|');
  for (const c of data.competitors) {
    lines.push(`| ${c.competitor_domain} | ${c.keywords_common} | ${c.keywords_competitor?.toLocaleString() || '—'} | ${c.traffic?.toLocaleString() || '—'} |`);
  }
  lines.push('');

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

const SEED_TOPICS = config.seed_topics || [];

async function run() {
  console.log(`\nKeyword Research Agent — ${config.name}\n`);

  const audit = loadAudit();

  console.log('Fetching DataForSEO data (4 queries)...');
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
      provider: 'dataforseo',
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
