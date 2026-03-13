/**
 * Content Researcher Agent
 *
 * For a given keyword, gathers everything needed to brief a writer:
 *   - Ahrefs related/semantic keywords to cover
 *   - Ahrefs SERP overview (what's ranking, page types, traffic)
 *   - Heading structure scraped from the top 3 organic results
 *   - Internal link candidates from sitemap + blog index
 *   - Claude-synthesised content brief (outline, angle, word count, guidance)
 *
 * Requires: ANTHROPIC_API_KEY in .env
 *           data/ahrefs/<slug>/      Ahrefs CSV exports for the target keyword (required)
 *           data/sitemap-index.json  (run sitemap-indexer first)
 *           data/blog-index.json     (run: npm run blog list)
 *
 * Output:  data/briefs/<slug>.json
 *
 * AHREFS DATA REQUIRED (per keyword):
 *   Place CSV exports in data/ahrefs/<keyword-slug>/
 *   Export these three reports from Ahrefs Keywords Explorer:
 *     1. SERP overview      → "Export" on the SERP Overview tab
 *     2. Matching terms      → "Export" on the Matching Terms tab (filter: vol ≥100, KD ≤40)
 *     3. Volume history      → "Export" on the Overview > Volume History chart
 *
 * Usage:
 *   node agents/content-researcher/index.js --check                   # show data readiness for queued keywords
 *   node agents/content-researcher/index.js "best natural deodorant"  # research one keyword (Ahrefs data required)
 *   node agents/content-researcher/index.js --all                     # process all from keyword-research.json
 *   node agents/content-researcher/index.js "keyword" --allow-fallback  # allow running without Ahrefs data (lower quality)
 */

import Anthropic from '@anthropic-ai/sdk';
import * as cheerio from 'cheerio';
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { withRetry } from '../../lib/retry.js';

// GSC is optional — gracefully skip if not configured
let gsc = null;
async function loadGSC() {
  try {
    gsc = await import('../../lib/gsc.js');
  } catch { /* Not configured */ }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const BRIEFS_DIR = join(ROOT, 'data', 'briefs');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

// ── feedback loader ────────────────────────────────────────────────────────────

function loadAgentFeedback(agentName) {
  try {
    const feedbackPath = join(ROOT, 'data', 'context', 'feedback.md');
    const content = readFileSync(feedbackPath, 'utf8');
    const marker = `## ${agentName}`;
    const start = content.indexOf(marker);
    if (start === -1) return '';
    const rest = content.slice(start + marker.length);
    const nextSection = rest.search(/\n## [a-z]/);
    const section = nextSection === -1 ? rest : rest.slice(0, nextSection);
    return section.trim();
  } catch {
    return '';
  }
}

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

if (!env.AHREFS_API_KEY) { console.error('Missing AHREFS_API_KEY in .env'); process.exit(1); }
if (!env.ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY in .env'); process.exit(1); }

// ── ahrefs ────────────────────────────────────────────────────────────────────

async function ahrefsGet(endpoint, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`https://api.ahrefs.com/v3${endpoint}?${qs}`, {
    headers: { Authorization: `Bearer ${env.AHREFS_API_KEY}` },
  });
  if (!res.ok) throw new Error(`Ahrefs ${endpoint} → ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getSerpOverview(keyword) {
  try {
    const data = await ahrefsGet('/serp-overview', {
      keyword,
      country: 'us',
      top_positions: 10,
      select: 'position,url,title,domain_rating,traffic,keywords,refdomains,page_type',
    });
    return (data.positions || []).filter((p) => p.url);
  } catch {
    return [];
  }
}

async function getRelatedKeywords(keyword) {
  try {
    const data = await ahrefsGet('/keywords-explorer/matching-terms', {
      keywords: keyword,
      country: 'us',
      limit: 30,
      select: 'keyword,volume,difficulty,traffic_potential',
      order_by: 'volume:desc',
      where: JSON.stringify({ and: [{ field: 'volume', is: ['gte', 100] }, { field: 'difficulty', is: ['lte', 40] }] }),
    });
    return data.keywords || [];
  } catch {
    return [];
  }
}

async function getRelatedKeywordsFallback(keyword) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `List 20 semantically related keywords and long-tail variations for the SEO topic: "${keyword}".
Include variations covering: subtopics, common questions, ingredient-focused terms, problem-focused terms, comparison terms.
Return only a JSON array of strings, no explanation. Example: ["keyword one", "keyword two"]`,
    }],
  });
  try {
    const raw = message.content[0].text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
    const keywords = JSON.parse(raw);
    return keywords.map((k) => ({ keyword: k, volume: null, difficulty: null, traffic_potential: null }));
  } catch {
    return [];
  }
}

// ── ahrefs csv / json loader ──────────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim().toLowerCase());
  return lines.slice(1).map((line) => {
    // Handle quoted fields containing commas
    const fields = [];
    let inQuote = false;
    let cur = '';
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

function num(v) { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return isNaN(n) ? null : n; }

// Get a value from a row by trying multiple possible column names (all lowercased)
function g(row, ...keys) {
  for (const k of keys) if (k in row && row[k] !== '') return row[k];
  return null;
}

function parseSerpCsv(rows) {
  // The first row with no URL is the keyword-level overview summary
  const overviewRow = rows.find((r) => !g(r, 'url'));
  const overview = overviewRow ? {
    volume: num(g(overviewRow, 'volume')),
    keyword_difficulty: num(g(overviewRow, 'difficulty')),
    traffic_potential: num(g(overviewRow, 'traffic potential')),
    global_volume: num(g(overviewRow, 'global volume')),
    cpc_cents: num(g(overviewRow, 'cpc')),
    parent_topic: g(overviewRow, 'parent topic'),
    search_intent: g(overviewRow, 'intents'),
  } : {};

  const skip = ['youtube.com', 'reddit.com', 'facebook.com', 'tiktok.com', 'instagram.com', 'amazon.com'];
  const serp = rows
    .filter((r) => g(r, 'url') && !skip.some((s) => (g(r, 'url') ?? '').includes(s)))
    .map((r) => ({
      position: num(g(r, 'position')),
      url: g(r, 'url'),
      title: g(r, 'title'),
      domain_rating: num(g(r, 'domain rating')),
      traffic: num(g(r, 'traffic')),
      keywords: num(g(r, 'keywords')),
      refdomains: num(g(r, 'referring domains')),
      type: g(r, 'type'),
    }))
    .slice(0, 10);

  return { overview, serp };
}

function parseKeywordsCsv(rows) {
  return rows
    .map((r) => ({
      keyword: g(r, 'keyword'),
      volume: num(g(r, 'volume')),
      difficulty: num(g(r, 'difficulty')),
      traffic_potential: num(g(r, 'traffic potential')),
      cpc: num(g(r, 'cpc')),
    }))
    .filter((r) => r.keyword);
}

function parseVolumeHistoryCsv(rows) {
  const recent = rows.slice(-24);
  const byMonth = {};
  for (const r of recent) {
    const date = g(r, 'date');
    const vol = num(g(r, 'volume', ' volume'));
    if (!date || vol === null) continue;
    const month = new Date(date).getMonth();
    if (!byMonth[month]) byMonth[month] = [];
    byMonth[month].push(vol);
  }
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const seasonality = Object.entries(byMonth)
    .map(([m, vols]) => ({ month: names[+m], avg: Math.round(vols.reduce((a, b) => a + b) / vols.length) }))
    .sort((a, b) => b.avg - a.avg);
  return { peak_month: seasonality[0]?.month, low_month: seasonality[seasonality.length - 1]?.month, seasonality };
}

function loadAhrefsData(keyword) {
  const slug = slugify(keyword);
  const dir = join(ROOT, 'data', 'ahrefs', slug);
  const jsonFile = join(ROOT, 'data', 'ahrefs', `${slug}.json`);

  if (existsSync(dir)) {
    const result = { serp: [], matching_terms: [], overview: {}, volume_history: null };
    const files = readdirSync(dir).filter((f) => extname(f).toLowerCase() === '.csv');

    for (const file of files) {
      const rows = parseCSV(readFileSync(join(dir, file), 'utf8'));
      if (rows.length === 0) continue;
      const headers = Object.keys(rows[0]);

      if (headers.includes('date')) {
        result.volume_history = parseVolumeHistoryCsv(rows);
      } else if (headers.includes('url') || headers.includes('position')) {
        const { overview, serp } = parseSerpCsv(rows);
        Object.assign(result.overview, overview);
        result.serp.push(...serp);
      } else if (headers.includes('keyword')) {
        result.matching_terms.push(...parseKeywordsCsv(rows));
      }
    }
    return result;
  }

  try { return JSON.parse(readFileSync(jsonFile, 'utf8')); } catch { return null; }
}

// ── competitor scraping ───────────────────────────────────────────────────────

async function scrapeHeadings(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEO-Research-Bot/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);

    const title = $('title').text().trim() || $('h1').first().text().trim();
    const headings = [];
    $('h1, h2, h3').each((_, el) => {
      const tag = el.tagName.toLowerCase();
      const text = $(el).text().trim();
      if (text.length > 3 && text.length < 200) headings.push({ tag, text });
    });
    const wordCount = $('body').text().split(/\s+/).length;

    return { url, title, headings: headings.slice(0, 30), word_count: wordCount };
  } catch {
    return null;
  }
}

// ── load context ──────────────────────────────────────────────────────────────

function loadSitemap() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'data', 'sitemap-index.json'), 'utf8'));
  } catch { return null; }
}

function loadBlogIndex() {
  try {
    const blogs = JSON.parse(readFileSync(join(ROOT, 'data', 'blog-index.json'), 'utf8'));
    return blogs.flatMap((b) => b.articles.map((a) => ({
      title: a.title,
      url: `${config.url}/blogs/${b.handle}/${a.handle}`,
      tags: a.tags,
    })));
  } catch { return []; }
}

function getInternalLinkCandidates(keyword, sitemap, articles) {
  const kwWords = keyword.toLowerCase().split(/\s+/);
  const score = (text) => kwWords.filter((w) => text.toLowerCase().includes(w)).length;

  const candidates = [];

  // Products and collections from sitemap
  if (sitemap) {
    for (const page of sitemap.pages) {
      if (!['product', 'collection'].includes(page.type)) continue;
      const s = score(page.slug);
      if (s > 0) candidates.push({ type: page.type, url: page.url, slug: page.slug, relevance: s });
    }
  }

  // Blog posts
  for (const a of articles) {
    const s = score(a.title);
    if (s > 0) candidates.push({ type: 'blog_post', url: a.url, title: a.title, relevance: s });
  }

  return candidates.sort((a, b) => b.relevance - a.relevance).slice(0, 10);
}

// ── claude brief ──────────────────────────────────────────────────────────────

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function generateBrief(keyword, kwData, serpResults, relatedKeywords, competitorContent, internalLinks, volumeHistory, gscData = null) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const competitorSummary = competitorContent
    .filter(Boolean)
    .map((c, i) => `--- Competitor ${i + 1}: ${c.url} (~${c.word_count} words) ---\nTitle: ${c.title}\nHeadings:\n${c.headings.map((h) => `  ${h.tag.toUpperCase()}: ${h.text}`).join('\n')}`)
    .join('\n\n');

  const serpSummary = serpResults
    .slice(0, 8)
    .map((r) => `  Pos ${r.position}: [DR${r.domain_rating ?? '?'}] ${r.title ?? r.url} — ${r.url} (${r.traffic ?? 0} traffic)`)
    .join('\n');

  const relatedSummary = relatedKeywords
    .map((k) => `  ${k.keyword} (vol: ${k.volume ?? '?'}, KD: ${k.difficulty ?? '?'}, TP: ${k.traffic_potential ?? '?'})`)
    .join('\n');

  const internalSummary = internalLinks
    .map((l) => `  [${l.type}] ${l.url}`)
    .join('\n');

  const seasonalityNote = volumeHistory
    ? `Peak month: ${volumeHistory.peak_month}, Low month: ${volumeHistory.low_month}. Top months by search volume: ${volumeHistory.seasonality.slice(0, 4).map((s) => `${s.month} (${s.avg})`).join(', ')}.`
    : 'Not available';

  const gscNote = gscData && gscData.impressions > 0
    ? `The site already appears in Google for this keyword: avg position #${Math.round(gscData.position)}, ${gscData.impressions.toLocaleString()} impressions, ${gscData.clicks} clicks, ${(gscData.ctr * 100).toFixed(1)}% CTR over 90 days. The new post should target outranking existing results and improving CTR.`
    : 'The site has no current GSC impressions for this keyword — this is a fresh ranking opportunity.';

  const prompt = `You are a senior SEO content strategist for a natural skincare and personal care brand called "${config.name}" (${config.url}).

The brand sells natural, organic personal care products — primarily natural toothpaste, coconut oil-based products, natural deodorant, and clean body lotion.

Your job: create a comprehensive content brief for a blog post targeting the keyword below. The brief will be handed directly to a writer who will produce the final post.

---
TARGET KEYWORD: "${keyword}"
Search volume: ${kwData?.search_volume || 'unknown'}/mo
Keyword difficulty: ${kwData?.keyword_difficulty ?? 'unknown'}/100
Traffic potential: ${kwData?.traffic_potential || 'unknown'}/mo
Seasonality: ${seasonalityNote}
---

CURRENT SERP (top 10 ranking pages):
${serpSummary || 'Not available'}

SEMANTIC / RELATED KEYWORDS TO INCORPORATE:
${relatedSummary || 'Not available'}

COMPETITOR CONTENT ANALYSIS (what the top-ranking pages currently cover):
${competitorSummary || 'Not available'}

INTERNAL LINK CANDIDATES (existing site pages to link to where relevant):
${internalSummary || 'None identified'}

SITE'S CURRENT GOOGLE SEARCH CONSOLE PERFORMANCE FOR THIS KEYWORD:
${gscNote}

---

Produce a JSON content brief with exactly this structure:
{
  "target_keyword": string,
  "slug": string (URL-safe, hyphenated),
  "search_intent": "informational" | "commercial" | "transactional" | "navigational",
  "recommended_title": string (60-65 chars, includes keyword, compelling),
  "meta_description": string (150-160 chars, includes keyword, strong CTA),
  "target_word_count": number (based on competitor benchmarks, typically 1500-2500),
  "content_angle": string (1-2 sentences: what makes this post uniquely authoritative and better than competitors),
  "key_differentiators": string[] (3-5 specific things this post must do better than current top results),
  "outline": [
    {
      "section": string (e.g. "Introduction", "H2: What Is Natural Deodorant?"),
      "type": "intro" | "h2" | "h3" | "faq" | "conclusion",
      "word_count_target": number,
      "guidance": string (specific instructions for the writer — what to say, what angle to take, what data/examples to include),
      "keywords_to_include": string[] (semantic keywords to naturally weave in)
    }
  ],
  "semantic_keywords": string[] (all related terms from Ahrefs to use throughout — do NOT include competitor brand names such as Crest, Colgate, Tom's of Maine, Dr. Bronner's, Boka, Marvis, Sensodyne, or any other brand; only include generic descriptive and intent-based keyword variants),
  "internal_links": [
    { "anchor_text": string, "url": string, "placement_guidance": string }
  ],
  "e_e_a_t_signals": string[] (specific ways to demonstrate expertise and trustworthiness),
  "schema_type": "Article" | "HowTo" | "FAQPage" | "Review",
  "writer_notes": string (anything else the writer needs to know: tone, style, brand voice, what to avoid)
}

BRAND POLICY — apply to every brief:
- Do NOT include competitor brand names (Crest, Colgate, Tom's of Maine, Dr. Bronner's, Boka, Marvis, Sensodyne, Dr. Sheffield's, Himalaya, Jason, Wellnesse, etc.) anywhere in semantic_keywords, keywords_to_include, or outline guidance.
- Do NOT instruct the writer to create brand comparison tables or dedicated sections about competitor products.
- Do NOT create sections targeting competitor brand queries (e.g. "What happened to Crest cinnamon toothpaste?").
- The post should position Real Skin Care as the authoritative choice — not as one option among many in a comparison chart.
- Competitor content analysis is provided for structural research only; do not carry competitor brand names into the brief output.
IGNORE THIS CLOSING BRACE — the actual JSON structure ends above
}

Return only the JSON object. No markdown fences, no explanation.${(() => {
  const fb = loadAgentFeedback('content-researcher');
  return fb ? `\n\n---\n\nSTANDING FEEDBACK (from insight-aggregator — apply these rules when building the brief):\n${fb}` : '';
})()}`;

  const message = await withRetry(
    () => client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    }),
    { label: 'content-researcher' }
  );

  const raw = message.content[0].text.trim();
  // Strip any accidental markdown fences
  const json = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');

  let brief;
  try {
    brief = JSON.parse(json);
  } catch (e) {
    throw new Error(`Claude returned invalid JSON for brief: ${e.message}\n\nRaw output (first 500 chars):\n${raw.slice(0, 500)}`);
  }

  // Enrich with raw data for writer reference
  brief.target_keyword = keyword;
  brief.slug = brief.slug || slugify(keyword);
  brief.search_volume = kwData?.search_volume;
  brief.keyword_difficulty = kwData?.keyword_difficulty;
  brief.traffic_potential = kwData?.traffic_potential;
  brief.serp_overview = serpResults.slice(0, 8).map((r) => ({
    position: r.position,
    url: r.url,
    title: r.title,
    domain_rating: r.domain_rating,
    traffic: r.traffic,
  }));

  return brief;
}

// ── competitor URL discovery ───────────────────────────────────────────────────

async function searchCompetitorUrls(keyword) {
  try {
    const q = encodeURIComponent(keyword);
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${q}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SEO-Research-Bot/1.0)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const html = await res.text();
    const $ = cheerio.load(html);
    const urls = [];
    const skip = ['youtube.com', 'reddit.com', 'facebook.com', 'tiktok.com', 'instagram.com', 'amazon.com'];
    $('a.result__a').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      // DuckDuckGo wraps links; extract uddg param or use direct href
      const uddg = new URL('https://x.com' + href).searchParams.get('uddg');
      const url = uddg || (href.startsWith('http') ? href : null);
      if (url && !skip.some((s) => url.includes(s))) urls.push(url);
    });
    return urls.slice(0, 5);
  } catch {
    return [];
  }
}

// ── ahrefs data readiness check ───────────────────────────────────────────────

function checkAhrefsData(keyword) {
  const slug = slugify(keyword);
  const dir = join(ROOT, 'data', 'ahrefs', slug);
  if (!existsSync(dir)) return { ready: false, slug, dir, files: [], hasSerp: false, hasKeywords: false, hasHistory: false };

  const files = readdirSync(dir).filter((f) => extname(f).toLowerCase() === '.csv');
  let hasSerp = false, hasKeywords = false, hasHistory = false;

  for (const file of files) {
    try {
      const rows = parseCSV(readFileSync(join(dir, file), 'utf8'));
      if (rows.length === 0) continue;
      const headers = Object.keys(rows[0]);
      if (headers.includes('date')) hasHistory = true;
      else if (headers.includes('url') || headers.includes('position')) hasSerp = true;
      else if (headers.includes('keyword')) hasKeywords = true;
    } catch { /* skip unreadable files */ }
  }

  return { ready: hasSerp && hasKeywords, slug, dir, files, hasSerp, hasKeywords, hasHistory };
}

// ── run one keyword ───────────────────────────────────────────────────────────

function findDuplicatePost(keyword) {
  const postsDir = join(ROOT, 'data', 'posts');
  try {
    const files = readdirSync(postsDir).filter((f) => f.endsWith('.json'));
    for (const file of files) {
      try {
        const meta = JSON.parse(readFileSync(join(postsDir, file), 'utf8'));
        if (meta.target_keyword?.toLowerCase() === keyword.toLowerCase()) {
          return { file, meta };
        }
      } catch { /* skip unreadable files */ }
    }
  } catch { /* postsDir missing */ }
  return null;
}

async function researchKeyword(keyword, kwData = {}, { allowFallback = false } = {}) {
  const slug = slugify(keyword);
  const outputPath = join(BRIEFS_DIR, `${slug}.json`);

  // Check for existing post targeting the same keyword
  const duplicate = findDuplicatePost(keyword);
  if (duplicate) {
    const { file, meta } = duplicate;
    const status = meta.shopify_status ?? 'unknown';
    const publishAt = meta.shopify_publish_at ? ` (publishes ${meta.shopify_publish_at.slice(0, 10)})` : '';
    console.error(`\n  ✗ Duplicate keyword detected: "${keyword}"`);
    console.error(`  An existing post already targets this keyword:`);
    console.error(`    File:    data/posts/${file}`);
    console.error(`    Title:   ${meta.title ?? '(no title)'}`);
    console.error(`    Status:  ${status}${publishAt}`);
    if (meta.shopify_url) console.error(`    URL:     ${meta.shopify_url}`);
    console.error(`\n  No brief generated. Update the existing post instead.\n`);
    process.exit(1);
  }

  // Load manually-provided Ahrefs data if available
  const ahrefsData = loadAhrefsData(keyword);
  if (ahrefsData) {
    console.log(`\n  Keyword: "${keyword}" (using Ahrefs data from data/ahrefs/${slug}/)`);
    if (ahrefsData.overview) Object.assign(kwData, {
      search_volume: kwData.search_volume ?? ahrefsData.overview.volume,
      keyword_difficulty: kwData.keyword_difficulty ?? ahrefsData.overview.keyword_difficulty,
      traffic_potential: kwData.traffic_potential ?? ahrefsData.overview.traffic_potential,
    });
  } else {
    // No Ahrefs data — gate unless fallback is explicitly allowed
    if (!allowFallback) {
      const dir = join(ROOT, 'data', 'ahrefs', slug);
      console.error(`\n  ✗ Missing Ahrefs data for "${keyword}"`);
      console.error(`\n  Required: place CSV exports in ${dir}/`);
      console.error('  Exports needed from Ahrefs Keywords Explorer:');
      console.error(`    1. SERP overview  → search "${keyword}" → SERP Overview tab → Export`);
      console.error(`    2. Matching terms → Matching Terms tab → Export (vol ≥100, KD ≤40)`);
      console.error(`    3. Volume history → Overview tab → Volume History chart → Export`);
      console.error('\n  Run with --allow-fallback to use Claude-generated keywords instead (lower quality).');
      console.error('  Run with --check to see data status for all queued keywords.\n');
      process.exit(1);
    }
    console.log(`\n  Keyword: "${keyword}" (⚠️  no Ahrefs data — using fallbacks)`);
  }

  process.stdout.write('  Fetching SERP overview... ');
  let serpResults = ahrefsData?.serp?.filter((r) => r.url) ?? [];
  if (serpResults.length === 0) serpResults = await getSerpOverview(keyword);
  console.log(`${serpResults.length} results`);

  process.stdout.write('  Fetching related keywords... ');
  let relatedKeywords = ahrefsData?.matching_terms?.filter((k) => k.keyword) ?? [];
  if (relatedKeywords.length === 0) relatedKeywords = await getRelatedKeywords(keyword);
  if (relatedKeywords.length === 0) {
    process.stdout.write('(using Claude fallback) ');
    relatedKeywords = await getRelatedKeywordsFallback(keyword);
  }
  console.log(`${relatedKeywords.length} keywords`);

  // Scrape top 3 organic results; fall back to DuckDuckGo search if SERP unavailable
  const typeStr = (r) => (Array.isArray(r.type) ? r.type.join(',') : r.type ?? '').toLowerCase();
  let topUrls = serpResults
    .filter((r) => !r.type || !typeStr(r).includes('paid'))
    .slice(0, 3)
    .map((r) => r.url)
    .filter(Boolean);

  if (topUrls.length === 0) {
    process.stdout.write('  No SERP data — searching for competitor pages... ');
    topUrls = await searchCompetitorUrls(keyword);
    console.log(`${topUrls.length} found`);
  }

  process.stdout.write(`  Scraping ${topUrls.length} competitor pages... `);
  const competitorContent = await Promise.all(topUrls.map(scrapeHeadings));
  const scraped = competitorContent.filter(Boolean).length;
  console.log(`${scraped} scraped`);

  // Load internal link context
  const sitemap = loadSitemap();
  const articles = loadBlogIndex();
  const internalLinks = getInternalLinkCandidates(keyword, sitemap, articles);

  // Fetch GSC performance for this keyword (shows if site already ranks for it)
  let gscData = null;
  if (gsc) {
    try {
      gscData = await gsc.getKeywordPerformance(keyword, 90);
      if (gscData.impressions > 0) {
        console.log(`  GSC: ${gscData.impressions} impressions, position #${Math.round(gscData.position)}, ${(gscData.ctr * 100).toFixed(1)}% CTR`);
      }
    } catch { /* skip */ }
  }

  process.stdout.write('  Generating content brief with Claude... ');
  const brief = await generateBrief(keyword, kwData, serpResults, relatedKeywords, competitorContent, internalLinks, ahrefsData?.volume_history, gscData);
  console.log('done');

  mkdirSync(BRIEFS_DIR, { recursive: true });
  writeFileSync(outputPath, JSON.stringify(brief, null, 2));
  console.log(`  Saved: ${outputPath}`);

  return brief;
}

// ── data readiness report ─────────────────────────────────────────────────────

function runCheck() {
  console.log(`\nContent Researcher — Ahrefs Data Readiness Check\n`);

  // Load brief queue from content calendar
  const calendarPath = join(ROOT, 'data', 'reports', 'content-calendar.md');
  const briefsDir = BRIEFS_DIR;
  const postsDir = join(ROOT, 'data', 'posts');

  // Collect keywords from calendar brief queue (lines starting with "- **Keyword:**")
  let queuedKeywords = [];
  if (existsSync(calendarPath)) {
    const calendar = readFileSync(calendarPath, 'utf8');
    const matches = [...calendar.matchAll(/\*\*Keyword:\*\*\s*`?([^`\n]+)`?/g)];
    queuedKeywords = matches.map((m) => m[1].trim());
  }

  if (queuedKeywords.length === 0) {
    console.log('  No queued keywords found in data/reports/content-calendar.md');
    console.log('  Run: npm run strategist\n');
    return;
  }

  console.log(`  Checking ${queuedKeywords.length} queued keyword(s) from content calendar:\n`);

  const ready = [];
  const missing = [];

  for (const keyword of queuedKeywords) {
    const slug = slugify(keyword);
    const hasBrief = existsSync(join(briefsDir, `${slug}.json`));
    const hasPost = existsSync(join(postsDir, `${slug}.html`));
    const status = checkAhrefsData(keyword);

    const statusIcon = hasPost ? '✅' : hasBrief ? '📝' : status.ready ? '✓ ' : '✗ ';
    const label = hasPost ? 'post written' : hasBrief ? 'brief exists' : status.ready ? 'data ready' : 'DATA MISSING';

    const csvStatus = [
      status.hasSerp     ? '✓ SERP'     : '✗ SERP',
      status.hasKeywords ? '✓ Keywords' : '✗ Keywords',
      status.hasHistory  ? '✓ History'  : '  History (optional)',
    ].join('  ');

    console.log(`  ${statusIcon} [${label.padEnd(12)}] "${keyword}"`);
    if (!hasPost && !hasBrief) {
      console.log(`     ${csvStatus}`);
      if (!status.ready) {
        console.log(`     → Place CSVs in: data/ahrefs/${slug}/`);
      }
    }

    if (!hasPost && !hasBrief) {
      (status.ready ? ready : missing).push({ keyword, slug, ...status });
    }
  }

  console.log(`\n  ── Summary ─────────────────────────────────────────────────────`);
  console.log(`  Ready to brief:   ${ready.length}`);
  console.log(`  Missing data:     ${missing.length}`);

  if (missing.length > 0) {
    console.log(`\n  ── Ahrefs Export Instructions ──────────────────────────────────`);
    console.log('  For each keyword below, export 2–3 CSVs from Ahrefs Keywords Explorer');
    console.log('  and place them in the folder shown:\n');
    for (const kw of missing) {
      console.log(`  Keyword: "${kw.keyword}"`);
      console.log(`  Folder:  data/ahrefs/${kw.slug}/`);
      if (!kw.hasSerp)     console.log(`    ✗ SERP Overview  → search keyword → "SERP Overview" tab → Export`);
      if (!kw.hasKeywords) console.log(`    ✗ Matching Terms → "Matching Terms" tab → Export (vol ≥100, KD ≤40)`);
      if (!kw.hasHistory)  console.log(`    + Volume History → Overview → Volume History chart → Export (optional)`);
      console.log('');
    }
  }

  if (ready.length > 0) {
    console.log(`\n  ── Ready to Run ────────────────────────────────────────────────`);
    for (const kw of ready) {
      console.log(`  node agents/content-researcher/index.js "${kw.keyword}"`);
    }
    console.log('');
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const allowFallback = args.includes('--allow-fallback');

async function main() {
  console.log(`\nContent Researcher Agent — ${config.name}\n`);

  await loadGSC();
  if (gsc) {
    console.log('  GSC connected — will include site performance data in briefs');
  }

  if (args[0] === '--check') {
    runCheck();
    return;
  }

  if (args[0] === '--all') {
    // Process all blog ideas from keyword-research.json
    let ideas;
    try {
      const kr = JSON.parse(readFileSync(join(ROOT, 'data', 'keyword-research.json'), 'utf8'));
      ideas = kr.blog_ideas;
    } catch {
      console.error('data/keyword-research.json not found. Run keyword-research first.');
      process.exit(1);
    }

    console.log(`Processing ${ideas.length} keyword ideas...\n`);
    for (const idea of ideas) {
      const slug = slugify(idea.target_keyword);
      const outputPath = join(BRIEFS_DIR, `${slug}.json`);
      if (existsSync(outputPath)) {
        console.log(`  [SKIP] Brief already exists: ${slug}`);
        continue;
      }
      await researchKeyword(idea.target_keyword, {
        search_volume: idea.search_volume,
        keyword_difficulty: idea.keyword_difficulty,
        traffic_potential: idea.traffic_potential,
      }, { allowFallback });
    }
  } else if (args[0] && !args[0].startsWith('--')) {
    const keyword = args[0];
    await researchKeyword(keyword, {}, { allowFallback });
  } else {
    console.error('Usage:');
    console.error('  node agents/content-researcher/index.js --check');
    console.error('  node agents/content-researcher/index.js "keyword to research"');
    console.error('  node agents/content-researcher/index.js "keyword" --allow-fallback');
    console.error('  node agents/content-researcher/index.js --all');
    process.exit(1);
  }

  console.log('\nContent research complete.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
