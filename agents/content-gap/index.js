/**
 * Content Gap Agent
 *
 * Identifies content gaps by comparing the site's existing content inventory
 * against Ahrefs CSV exports placed in data/content_gap/.
 *
 * Expected files in data/content_gap/:
 *   top100.csv                      — Ahrefs Content Gap export (competitors vs RSC)
 *   realskincare_organic_keywords.csv — Site's current organic keyword rankings
 *   natural_deodorant.csv           — Keywords Explorer: natural deodorant
 *   natural_toothpaste.csv          — Keywords Explorer: natural toothpaste
 *   natural_body_lotion.csv         — Keywords Explorer: natural body lotion
 *   natural_lip_balm.csv            — Keywords Explorer: natural lip balm
 *   natural_bar_soap.csv            — Keywords Explorer: natural bar soap
 *   natural_hand_soap.csv           — Keywords Explorer: natural hand soap
 *   natural_coconut_oil.csv         — Keywords Explorer: natural coconut oil
 *   top_pages_*.csv                 — Competitor top pages (one file per competitor)
 *
 * Output: data/reports/content-gap-report.md
 *
 * Usage:
 *   node agents/content-gap/index.js
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const DATA_DIR = join(ROOT, 'data', 'content_gap');

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

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// ── CSV parser ────────────────────────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.split('\n');
  const rows = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuote = !inQuote;
      } else if (ch === ',' && !inQuote) {
        fields.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    fields.push(cur.trim());
    rows.push(fields);
  }
  return rows;
}

function csvToObjects(text, skipFirstIfNumber = false) {
  const rows = parseCSV(text);
  if (rows.length < 2) return [];

  // Find header row (skip leading # rows if present)
  let headerIdx = 0;
  if (skipFirstIfNumber && rows[0][0] === '#') headerIdx = 0;

  const headers = rows[headerIdx].map((h) => h.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/__+/g, '_'));
  const objects = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    if (!rows[i].some((v) => v)) continue;
    const obj = {};
    headers.forEach((h, j) => { obj[h] = rows[i][j] || ''; });
    objects.push(obj);
  }
  return objects;
}

// ── load CSV files ────────────────────────────────────────────────────────────

function loadFile(filename) {
  const path = join(DATA_DIR, filename);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function loadKeywordsExplorer(filename) {
  const text = loadFile(filename);
  if (!text) return [];
  const rows = csvToObjects(text, true);
  return rows.map((r) => ({
    keyword: r.keyword || r['#keyword'] || '',
    volume: parseInt(r.volume) || 0,
    difficulty: parseInt(r.difficulty) || 0,
    traffic_potential: parseInt(r.traffic_potential) || 0,
    cpc: parseFloat(r.cpc) || 0,
    intents: r.intents || '',
    parent_keyword: r.parent_keyword || '',
  })).filter((r) => r.keyword);
}

function loadContentGap() {
  const text = loadFile('top100.csv');
  if (!text) return { keywords: [], competitors: [] };

  const rows = csvToObjects(text);
  if (!rows.length) return { keywords: [], competitors: [] };

  // Detect competitor columns (any column ending in ": organic position" or ": url")
  const sampleKeys = Object.keys(rows[0]);
  const competitors = [];
  for (const k of sampleKeys) {
    const m = k.match(/^(.+?)_+organic_position$/i) || k.match(/^(.+?)_+url$/i);
    if (m && !m[1].includes('realskincare')) {
      const name = m[1].replace(/_+/g, '.').replace(/\.$/, '');
      if (!competitors.includes(name)) competitors.push(name);
    }
  }

  const keywords = rows.map((r) => {
    // Find RSC position key
    const rscPosKey = sampleKeys.find((k) => k.includes('realskincare') && k.includes('organic_position'));
    const rscPos = rscPosKey ? parseInt(r[rscPosKey]) || null : null;

    // Find competitor positions
    const compPositions = {};
    for (const comp of competitors) {
      const posKey = sampleKeys.find((k) => k.includes(comp.replace(/\./g, '_')) && k.includes('organic_position'));
      if (posKey) compPositions[comp] = parseInt(r[posKey]) || null;
    }

    return {
      keyword: r.keyword || '',
      volume: parseInt(r.volume) || 0,
      kd: parseInt(r.kd) || 0,
      rsc_position: rscPos,
      competitor_positions: compPositions,
    };
  }).filter((r) => r.keyword);

  return { keywords, competitors };
}

function loadOwnKeywords() {
  const text = loadFile('realskincare_organic_keywords.csv');
  if (!text) return [];
  const rows = csvToObjects(text);
  return rows.map((r) => ({
    keyword: r.keyword || '',
    position: parseInt(r.current_position) || parseInt(r.position) || 0,
    volume: parseInt(r.volume) || 0,
    url: r.current_url || r.url || '',
  })).filter((r) => r.keyword);
}

function loadCompetitorTopPages() {
  const files = readdirSync(DATA_DIR).filter((f) => f.startsWith('top_pages_') && f.endsWith('.csv'));
  const result = {};
  for (const f of files) {
    const competitorName = basename(f, '.csv').replace('top_pages_', '');
    const text = loadFile(f);
    if (!text) continue;
    const rows = csvToObjects(text);
    result[competitorName] = rows.map((r) => ({
      url: r.url || '',
      traffic: parseInt(r.traffic) || 0,
      keywords: parseInt(r.keywords) || 0,
      top_keyword: r.top_keyword || '',
      top_keyword_volume: parseInt(r['top_keyword__volume'] || r.top_keyword_volume) || 0,
    })).filter((r) => r.url).slice(0, 50);
  }
  return result;
}

// ── site performance snapshots ────────────────────────────────────────────────

function loadRecentSnapshots(subdir, days = 30) {
  const dir = join(ROOT, 'data', 'snapshots', subdir);
  if (!existsSync(dir)) return [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f.slice(0, 10) >= cutoff.toISOString().slice(0, 10))
    .sort()
    .map((f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

function loadLatestSnapshot(subdir) {
  const dir = join(ROOT, 'data', 'snapshots', subdir);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (!files.length) return null;
  try { return JSON.parse(readFileSync(join(dir, files[files.length - 1]), 'utf8')); } catch { return null; }
}

function loadSitePerformance() {
  // GSC: aggregate last 30 days of daily snapshots for stable per-page totals
  const gscSnapshots = loadRecentSnapshots('gsc', 30);
  const gscTotals = {};
  for (const snap of gscSnapshots) {
    for (const p of (snap.topPages || [])) {
      const path = p.page.replace(/^https?:\/\/[^/]+/, '') || '/';
      if (!gscTotals[path]) gscTotals[path] = { clicks: 0, impressions: 0, positionSum: 0, positionDays: 0 };
      gscTotals[path].clicks      += p.clicks;
      gscTotals[path].impressions += p.impressions;
      gscTotals[path].positionSum += p.position * p.impressions; // weighted by impressions
      gscTotals[path].positionDays += p.impressions;
    }
  }
  const gscPages = Object.entries(gscTotals)
    .map(([path, t]) => ({
      path,
      clicks: t.clicks,
      impressions: t.impressions,
      ctr: t.impressions ? Math.round(t.clicks / t.impressions * 1000) / 10 : 0,
      position: t.positionDays ? Math.round(t.positionSum / t.positionDays * 10) / 10 : null,
    }))
    .sort((a, b) => b.impressions - a.impressions);
  const gscDateRange = gscSnapshots.length
    ? `${gscSnapshots[0].date} to ${gscSnapshots[gscSnapshots.length - 1].date} (${gscSnapshots.length} days)`
    : null;

  // GA4: aggregate last 30 days of daily snapshots
  const ga4Snapshots = loadRecentSnapshots('ga4', 30);
  const ga4Totals = {};
  for (const snap of ga4Snapshots) {
    for (const p of (snap.topLandingPages || [])) {
      if (!ga4Totals[p.page]) ga4Totals[p.page] = { sessions: 0, conversions: 0, revenue: 0 };
      ga4Totals[p.page].sessions    += p.sessions;
      ga4Totals[p.page].conversions += p.conversions;
      ga4Totals[p.page].revenue     += p.revenue;
    }
  }
  const ga4Pages = Object.entries(ga4Totals)
    .map(([path, t]) => ({ path, sessions: t.sessions, conversions: t.conversions, revenue: Math.round(t.revenue * 100) / 100 }))
    .sort((a, b) => b.sessions - a.sessions);
  const ga4DateRange = ga4Snapshots.length
    ? `${ga4Snapshots[0].date} to ${ga4Snapshots[ga4Snapshots.length - 1].date} (${ga4Snapshots.length} days)`
    : null;

  // Shopify: top products from latest snapshot
  const shopify = loadLatestSnapshot('shopify');
  const topProducts = (shopify?.topProducts || []).slice(0, 10);

  return {
    gscDateRange,
    ga4DateRange,
    gscPages,
    ga4Pages,
    topProducts,
  };
}

// ── content inventory ─────────────────────────────────────────────────────────

function loadInventory() {
  const sitemapPath = join(ROOT, 'data', 'sitemap-index.json');
  const blogIndexPath = join(ROOT, 'data', 'blog-index.json');

  if (!existsSync(sitemapPath)) throw new Error('data/sitemap-index.json not found — run sitemap-indexer first');
  if (!existsSync(blogIndexPath)) throw new Error('data/blog-index.json not found — run sitemap-indexer first');

  const sitemap = JSON.parse(readFileSync(sitemapPath, 'utf8'));
  const blogRaw = JSON.parse(readFileSync(blogIndexPath, 'utf8'));

  const blogs = Array.isArray(blogRaw) ? blogRaw : Object.values(blogRaw);
  const articles = blogs.flatMap((b) => b.articles || []);

  // Include recently written posts not yet in stale blog-index
  const postsDir = join(ROOT, 'data', 'posts');
  if (existsSync(postsDir)) {
    const postFiles = readdirSync(postsDir).filter((f) => f.endsWith('.json'));
    for (const f of postFiles) {
      try {
        const post = JSON.parse(readFileSync(join(postsDir, f), 'utf8'));
        const slug = post.slug || f.replace('.json', '');
        if (!articles.some((a) => a.handle === slug || a.handle?.includes(slug))) {
          articles.push({ id: null, title: post.title || slug, handle: slug, tags: (post.tags || []).join(', '), _local: true });
        }
      } catch { /* skip malformed */ }
    }
  }

  const products = sitemap.pages.filter((p) => p.type === 'product').map((p) => p.slug);
  const collections = sitemap.pages.filter((p) => p.type === 'collection').map((p) => p.slug);

  return { articles, products, collections };
}

// ── coverage check ────────────────────────────────────────────────────────────

function isCovered(keyword, articles) {
  const kw = keyword.toLowerCase();
  return articles.some((a) => {
    const title = (a.title || '').toLowerCase();
    const handle = (a.handle || '').toLowerCase();
    const words = kw.split(' ').filter((w) => w.length > 3);
    const matches = words.filter((w) => title.includes(w) || handle.includes(w));
    return matches.length >= Math.min(2, words.length);
  });
}

// ── claude analysis ────────────────────────────────────────────────────────────

async function analyzeGaps({ inventory, contentGap, ownKeywords, categoryKeywords, competitorTopPages, sitePerformance }) {
  // Build concise summaries for the prompt
  const inventorySummary = {
    blog_posts: inventory.articles.map((a) => a.title),
    products: inventory.products,
    collections: inventory.collections,
  };

  // Top gap keywords: competitors rank, RSC doesn't (or ranks > 20)
  const gapKeywords = contentGap.keywords
    .filter((k) => {
      const rscRanks = k.rsc_position && k.rsc_position <= 20;
      const competitorRanks = Object.values(k.competitor_positions).some((p) => p && p <= 20);
      return !rscRanks && competitorRanks && k.volume >= 100;
    })
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 80)
    .map((k) => ({
      keyword: k.keyword,
      volume: k.volume,
      kd: k.kd,
      rsc_pos: k.rsc_position || 'not ranking',
      competitors: Object.entries(k.competitor_positions)
        .filter(([, p]) => p)
        .map(([c, p]) => `${c}:#${p}`)
        .join(', '),
    }));

  // Uncovered category keywords
  const uncoveredByCategory = {};
  for (const [cat, keywords] of Object.entries(categoryKeywords)) {
    uncoveredByCategory[cat] = keywords
      .filter((k) => !isCovered(k.keyword, inventory.articles) && k.volume >= 100)
      .sort((a, b) => (b.traffic_potential || b.volume) - (a.traffic_potential || a.volume))
      .slice(0, 20)
      .map((k) => ({ keyword: k.keyword, volume: k.volume, kd: k.difficulty, traffic_potential: k.traffic_potential }));
  }

  // Competitor content themes (top pages summarized)
  const competitorThemes = {};
  for (const [comp, pages] of Object.entries(competitorTopPages)) {
    competitorThemes[comp] = pages
      .filter((p) => p.traffic > 50)
      .slice(0, 15)
      .map((p) => `${p.top_keyword} (${p.traffic} traffic, ${p.keywords} kw) — ${p.url}`);
  }

  // What RSC already ranks for (to exclude from gaps)
  const ownTopKeywords = ownKeywords
    .filter((k) => k.position <= 20 && k.volume >= 100)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 50)
    .map((k) => `${k.keyword} (#${k.position}, ${k.volume}/mo)`);

  // Pages with high impressions but low CTR — opportunity to update titles/meta
  const lowCtrPages = (sitePerformance.gscPages || [])
    .filter((p) => p.impressions >= 100 && p.ctr < 3)
    .map((p) => `${p.path} — ${p.impressions} impr, ${p.ctr}% CTR, pos ${p.position}`);

  // Pages already getting traction — candidates for cluster content
  const tractionPages = (sitePerformance.gscPages || [])
    .filter((p) => p.clicks >= 2)
    .map((p) => `${p.path} — ${p.clicks} clicks, ${p.impressions} impr, pos ${p.position}`);

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: `You are an SEO strategist performing a data-driven content gap analysis for ${config.name} (${config.url}), a natural skincare and personal care brand. Products: natural deodorant (roll-on), toothpaste, body lotion, coconut oil products, lip balm, soap.

## CURRENT CONTENT INVENTORY
Blog posts (${inventorySummary.blog_posts.length} total):
${inventorySummary.blog_posts.join('\n')}

Collections (${inventorySummary.collections.length}): ${inventorySummary.collections.slice(0, 30).join(', ')}
Products: ${inventorySummary.products.join(', ')}

## KEYWORDS RSC ALREADY RANKS FOR (top 50 by volume)
${ownTopKeywords.join('\n')}

## SITE PERFORMANCE — GSC TOP PAGES (${sitePerformance.gscDateRange || 'latest snapshot'})
${sitePerformance.gscPages.map((p) => `${p.path} — ${p.clicks} clicks, ${p.impressions} impr, ${p.ctr}% CTR, pos ${p.position}`).join('\n') || 'No data'}

## PAGES WITH HIGH IMPRESSIONS BUT LOW CTR (title/meta optimization candidates)
${lowCtrPages.join('\n') || 'None'}

## PAGES ALREADY GETTING TRACTION (cluster content candidates)
${tractionPages.join('\n') || 'None'}

## GA4 TOP LANDING PAGES BY SESSIONS (${sitePerformance.ga4DateRange || 'latest snapshot'})
${sitePerformance.ga4Pages.map((p) => `${p.path} — ${p.sessions} sessions, ${p.conversions} conversions`).join('\n') || 'No data'}

## TOP SELLING PRODUCTS (Shopify)
${sitePerformance.topProducts.map((p) => `${p.title || p.name || JSON.stringify(p)}`).join('\n') || 'No data'}

## CONTENT GAP: KEYWORDS COMPETITORS RANK FOR (RSC does not rank top 20)
${JSON.stringify(gapKeywords, null, 2)}

## UNCOVERED KEYWORDS BY CATEGORY (from Keywords Explorer)
${JSON.stringify(uncoveredByCategory, null, 2)}

## COMPETITOR TOP PAGES (what drives their traffic)
${JSON.stringify(competitorThemes, null, 2)}

---

Produce a comprehensive, data-driven content gap report in Markdown. Base every recommendation on the actual data above — cite keyword volumes and KD scores. Structure the report as:

## 1. Executive Summary
5 bullet points identifying the biggest, most actionable gaps backed by data.

## 2. Priority Gap Table
Markdown table sorted High → Medium → Low.
Columns: Priority | Category | Suggested Title | Target Keyword | Volume | KD | RSC Position | Competitor | Stage | Content Type

Only include keywords where:
- Volume ≥ 200
- KD ≤ 40
- Not currently covered by RSC content
Limit to the 30 most impactful opportunities.

## 3. Buyer Journey Analysis
Which stages (TOF/MOF/BOF) are underserved? Use actual post titles and keyword data as evidence.

## 4. Quick Wins (top 5)
KD ≤ 10, Volume ≥ 300. Include exact keyword, volume, KD, and why it's winnable.

## 5. Cluster Opportunities (based on site traction)
Which existing posts are gaining impressions or clicks and should have cluster content written around them? What supporting articles would strengthen those topics?

## 6. CTR Optimization Targets
Which published posts have strong impression counts but low CTR (< 3%)? Suggest specific title or meta description rewrites for the top 3.

## 7. Competitor Insights
What content strategies are Tom's, Dr. Bronner's, and OSEA using that RSC is not? What topics drive their traffic that RSC ignores?

## 8. Strategic Recommendations
5 concrete recommendations with the specific keywords to target first.`,
    }],
  });

  return message.content[0].text.trim();
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nContent Gap Agent — ${config.name}\n`);

  if (!existsSync(DATA_DIR)) {
    console.error(`data/content_gap/ not found. Create it and add Ahrefs CSV exports.`);
    process.exit(1);
  }

  // Load inventory
  process.stdout.write('  Loading content inventory... ');
  const inventory = loadInventory();
  console.log(`done (${inventory.articles.length} articles, ${inventory.products.length} products, ${inventory.collections.length} collections)`);

  // Load content gap CSV
  process.stdout.write('  Loading content gap data (top100.csv)... ');
  const contentGap = loadContentGap();
  console.log(`done (${contentGap.keywords.length} keywords, competitors: ${contentGap.competitors.join(', ')})`);

  // Load own keywords
  process.stdout.write('  Loading RSC organic keywords... ');
  const ownKeywords = loadOwnKeywords();
  console.log(`done (${ownKeywords.length} keywords)`);

  // Load category keywords from Keywords Explorer files
  const categoryFiles = {
    deodorant: 'natural_deodorant.csv',
    toothpaste: 'natural_toothpaste.csv',
    body_lotion: 'natural_body_lotion.csv',
    lip_balm: 'natural_lip_balm.csv',
    bar_soap: 'natural_bar_soap.csv',
    hand_soap: 'natural_hand_soap.csv',
    coconut_oil: 'natural_coconut_oil.csv',
  };

  const categoryKeywords = {};
  for (const [cat, file] of Object.entries(categoryFiles)) {
    const kws = loadKeywordsExplorer(file);
    if (kws.length) {
      categoryKeywords[cat] = kws;
      console.log(`  Loaded ${cat}: ${kws.length} keywords`);
    } else {
      console.log(`  Skipped ${cat}: file not found or empty`);
    }
  }

  // Load competitor top pages
  process.stdout.write('  Loading competitor top pages... ');
  const competitorTopPages = loadCompetitorTopPages();
  const compNames = Object.keys(competitorTopPages);
  console.log(`done (${compNames.join(', ')})`);

  // Load site performance from snapshots
  process.stdout.write('  Loading site performance snapshots (GSC, GA4, Shopify)... ');
  const sitePerformance = loadSitePerformance();
  console.log(`done (GSC: ${sitePerformance.gscPages.length} pages over ${sitePerformance.gscDateRange || 'n/a'}, GA4: ${sitePerformance.ga4Pages.length} pages)`);

  // Run Claude analysis
  console.log('\n  Analyzing gaps with Claude...');
  const report = await analyzeGaps({ inventory, contentGap, ownKeywords, categoryKeywords, competitorTopPages, sitePerformance });

  // Save report
  mkdirSync(join(ROOT, 'data', 'reports', 'content-gap'), { recursive: true });
  const reportPath = join(ROOT, 'data', 'reports', 'content-gap', 'content-gap-report.md');
  const header = `# Content Gap Analysis — ${config.name}
**Generated:** ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
**Site:** ${config.url}
**Ahrefs files:** ${readdirSync(DATA_DIR).filter((f) => f.endsWith('.csv')).join(', ')}
**GSC:** ${sitePerformance.gscDateRange || 'n/a'} | **GA4:** ${sitePerformance.ga4DateRange || 'n/a'}

---

`;
  writeFileSync(reportPath, header + report);
  console.log(`\n  Report saved: ${reportPath}`);
}

main().then(() => {
  console.log('\nContent gap analysis complete.');
}).catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
