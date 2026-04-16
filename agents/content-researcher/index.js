/**
 * Content Researcher Agent
 *
 * For a given keyword, gathers everything needed to brief a writer:
 *   - DataForSEO related/semantic keywords to cover
 *   - DataForSEO SERP overview (what's ranking)
 *   - Heading structure scraped from the top 3 organic results
 *   - Internal link candidates from sitemap + blog index
 *   - Claude-synthesised content brief (outline, angle, word count, guidance)
 *
 * Requires: ANTHROPIC_API_KEY, DATAFORSEO_PASSWORD in .env
 *           data/sitemap-index.json  (run sitemap-indexer first)
 *           data/blog-index.json     (run: npm run blog list)
 *
 * Output:  data/briefs/<slug>.json
 *
 * Usage:
 *   node agents/content-researcher/index.js --check                   # list briefs ready / already-written
 *   node agents/content-researcher/index.js "best natural deodorant"  # research one keyword
 *   node agents/content-researcher/index.js --all                     # process all from keyword-research.json
 */

import Anthropic from '@anthropic-ai/sdk';
import * as cheerio from 'cheerio';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { withRetry } from '../../lib/retry.js';
import { loadKeywordIndex, analyzeGaps } from '../../lib/keyword-index.js';
import { listAllSlugs, getPostMeta, getContentPath, POSTS_DIR } from '../../lib/posts.js';
import {
  fetchSerpData,
  fetchRelatedKeywords,
  fetchKeywordOverview,
  computeVolumeHistory,
} from './keyword-data.js';

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

if (!env.ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY in .env'); process.exit(1); }
if (!env.DATAFORSEO_PASSWORD) { console.error('Missing DATAFORSEO_PASSWORD in .env'); process.exit(1); }

// ── last-resort keyword fallback (used when DataForSEO returns no matching terms) ──

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

/**
 * Load historical flop verdicts for posts in the same topical area. When
 * briefing a new post similar to an existing flop, the researcher should
 * surface what didn't work last time so the new post avoids the same
 * pattern. See docs/signal-manifest.md.
 *
 * Matches on the first cluster token of the keyword (e.g., "best natural
 * deodorant" → "deodorant") and returns any per-post review with a
 * non-ON_TRACK verdict.
 */
function loadRelatedFlops(keyword) {
  const lowerKw = (keyword || '').toLowerCase();
  const clusters = ['deodorant', 'toothpaste', 'lotion', 'soap', 'lip balm', 'coconut oil', 'shampoo', 'sunscreen', 'body wash', 'moisturizer', 'serum'];
  const matchedCluster = clusters.find((c) => lowerKw.includes(c));
  if (!matchedCluster) return [];

  const flops = [];
  try {
    for (const slug of listAllSlugs()) {
      try {
        const meta = getPostMeta(slug);
        if (!meta) continue;
        const postKw = (meta.target_keyword || '').toLowerCase();
        if (!postKw.includes(matchedCluster)) continue;
        const review = meta.performance_review || {};
        for (const [key, r] of Object.entries(review)) {
          if (r && r.verdict && r.verdict !== 'ON_TRACK') {
            flops.push({
              slug: meta.slug,
              target_keyword: meta.target_keyword,
              milestone: key,
              verdict: r.verdict,
              reason: r.reason,
            });
            break; // one per post is enough
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* ignore */ }
  return flops;
}

async function generateBrief(keyword, kwData, serpResults, relatedKeywords, competitorContent, internalLinks, volumeHistory, gscData = null) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const competitorSummary = competitorContent
    .filter(Boolean)
    .map((c, i) => `--- Competitor ${i + 1}: ${c.url} (~${c.word_count} words) ---\nTitle: ${c.title}\nHeadings:\n${c.headings.map((h) => `  ${h.tag.toUpperCase()}: ${h.text}`).join('\n')}`)
    .join('\n\n');

  const serpSummary = serpResults
    .slice(0, 8)
    .map((r) => {
      const desc = r.description ? ` — ${r.description.slice(0, 160)}` : '';
      return `  Pos ${r.position}: ${r.title ?? r.url} (${r.domain ?? ''})${desc}\n    ${r.url}`;
    })
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

  // Historical flops in the same cluster — teach the writer what not to repeat.
  const flops = loadRelatedFlops(keyword);
  const flopNote = flops.length === 0
    ? 'No prior flops in this cluster.'
    : flops.map((f) => `  - "${f.target_keyword}" (${f.slug}) — ${f.milestone} verdict ${f.verdict}: ${f.reason}`).join('\n');

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

HISTORICAL FLOPS IN THIS CLUSTER (lessons from posts that underperformed — do not repeat these patterns):
${flopNote}

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
  "semantic_keywords": string[] (all related terms to use throughout — do NOT include competitor brand names such as Crest, Colgate, Tom's of Maine, Dr. Bronner's, Boka, Marvis, Sensodyne, or any other brand; only include generic descriptive and intent-based keyword variants),
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
    domain: r.domain,
    description: r.description,
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

// ── run one keyword ───────────────────────────────────────────────────────────

function findDuplicatePost(keyword) {
  try {
    for (const slug of listAllSlugs()) {
      try {
        const meta = getPostMeta(slug);
        if (meta && meta.target_keyword?.toLowerCase() === keyword.toLowerCase()) {
          return { file: `${slug}/meta.json`, meta };
        }
      } catch { /* skip unreadable files */ }
    }
  } catch { /* postsDir missing */ }
  return null;
}

async function researchKeyword(keyword, kwData = {}) {
  const slug = slugify(keyword);
  const outputPath = join(BRIEFS_DIR, `${slug}.json`);

  // Check for existing brief — skip gracefully if already researched
  if (existsSync(outputPath)) {
    console.log(`\n  Brief already exists: ${outputPath}`);
    console.log('  Skipping — delete the brief file to re-research.\n');
    return;
  }

  // Check for existing post targeting the same keyword
  const duplicate = findDuplicatePost(keyword);
  if (duplicate) {
    const { file, meta } = duplicate;
    const status = meta.shopify_status ?? 'unknown';
    const publishAt = meta.shopify_publish_at ? ` (publishes ${meta.shopify_publish_at.slice(0, 10)})` : '';
    console.log(`\n  Existing post found for "${keyword}":`);
    console.log(`    File:    data/posts/${file}`);
    console.log(`    Title:   ${meta.title ?? '(no title)'}`);
    console.log(`    Status:  ${status}${publishAt}`);
    if (meta.shopify_url) console.log(`    URL:     ${meta.shopify_url}`);
    console.log(`\n  No brief generated. Update the existing post instead.\n`);
    return;
  }

  console.log(`\n  Keyword: "${keyword}"`);

  // Load keyword index for cluster-wide intelligence (supplementary context)
  const index = loadKeywordIndex();
  const gaps = analyzeGaps(slug, index);
  const clusterName = index.keywords[slug]?.cluster;
  const cluster = clusterName ? index.clusters[clusterName] : null;

  // Fetch SERP live from DataForSEO
  process.stdout.write('  Fetching SERP from DataForSEO... ');
  const serpResults = await fetchSerpData(keyword, { limit: 10 });
  console.log(`${serpResults.length} results`);

  // Fetch related keywords live, fall back to cluster data then Claude if empty
  process.stdout.write('  Fetching related keywords from DataForSEO... ');
  let relatedKeywords = await fetchRelatedKeywords(keyword);
  if (relatedKeywords.length < 20 && cluster?.all_matching_terms?.length > 0) {
    const existing = new Set(relatedKeywords.map((k) => k.keyword));
    const extras = cluster.all_matching_terms.filter((k) => !existing.has(k.keyword));
    relatedKeywords = [...relatedKeywords, ...extras];
  }
  if (relatedKeywords.length === 0) {
    process.stdout.write('(using Claude fallback) ');
    relatedKeywords = await getRelatedKeywordsFallback(keyword);
  }
  console.log(`${relatedKeywords.length} keywords`);

  // Fetch overview + volume history if the caller didn't pre-supply numbers
  if (kwData.search_volume == null) {
    process.stdout.write('  Fetching keyword overview... ');
    const overview = await fetchKeywordOverview(keyword);
    if (overview.volume != null) kwData.search_volume = overview.volume;
    kwData.__volumeHistory = computeVolumeHistory(overview.monthlySearches);
    console.log(`${kwData.search_volume ?? 'unknown'}/mo`);
  }
  const volumeHistory = kwData.__volumeHistory ?? null;

  // Scrape top 3 organic results; fall back to DuckDuckGo search if SERP unavailable
  let topUrls = serpResults.slice(0, 3).map((r) => r.url).filter(Boolean);

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
  const brief = await generateBrief(keyword, kwData, serpResults, relatedKeywords, competitorContent, internalLinks, volumeHistory, gscData);
  console.log('done');

  brief.data_sources = {
    provider: 'dataforseo',
    cluster: clusterName || null,
    cluster_terms: cluster?.all_matching_terms?.length || 0,
    niche_terms: gaps.niche_terms || 0,
    gaps: gaps.missing || [],
  };

  mkdirSync(BRIEFS_DIR, { recursive: true });
  writeFileSync(outputPath, JSON.stringify(brief, null, 2));
  console.log(`  Saved: ${outputPath}`);

  return brief;
}

// ── brief queue report ────────────────────────────────────────────────────────

function runCheck() {
  console.log(`\nContent Researcher — Brief Queue Status\n`);

  // Load brief queue from content calendar
  const calendarPath = join(ROOT, 'data', 'reports', 'content-calendar.md');
  const briefsDir = BRIEFS_DIR;

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

  const pending = [];
  for (const keyword of queuedKeywords) {
    const slug = slugify(keyword);
    const hasBrief = existsSync(join(briefsDir, `${slug}.json`));
    const hasPost = existsSync(getContentPath(slug));

    const icon = hasPost ? '✅' : hasBrief ? '📝' : '⬜';
    const label = hasPost ? 'post written' : hasBrief ? 'brief exists' : 'pending';
    console.log(`  ${icon} [${label.padEnd(12)}] "${keyword}"`);
    if (!hasPost && !hasBrief) pending.push({ keyword, slug });
  }

  console.log(`\n  ── Summary ─────────────────────────────────────────────────────`);
  console.log(`  Pending briefs:   ${pending.length}`);
  console.log(`  Briefs written:   ${queuedKeywords.length - pending.length}\n`);

  if (pending.length > 0) {
    console.log(`  Run next:`);
    for (const kw of pending.slice(0, 5)) {
      console.log(`    node agents/content-researcher/index.js "${kw.keyword}"`);
    }
    console.log('');
  }
}

// ── main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

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
      });
    }
  } else if (args[0] && !args[0].startsWith('--')) {
    const keyword = args[0];
    await researchKeyword(keyword, {});
  } else {
    console.error('Usage:');
    console.error('  node agents/content-researcher/index.js --check');
    console.error('  node agents/content-researcher/index.js "keyword to research"');
    console.error('  node agents/content-researcher/index.js --all');
    process.exit(1);
  }

  console.log('\nContent research complete.');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
