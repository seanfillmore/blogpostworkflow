/**
 * Content Gap Agent
 *
 * Identifies content gaps by comparing the site's existing content inventory
 * against live DataForSEO data (competitor rankings, ranked keywords, SERP,
 * and keyword ideas per product category).
 *
 * Output: data/reports/content-gap-report.md
 *
 * Usage:
 *   node agents/content-gap/index.js
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getKeywordIdeas, getCompetitors, getRankedKeywords, getTopPages, getSerpResults } from '../../lib/dataforseo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

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

// ── DataForSEO data fetchers ─────────────────────────────────────────────────

async function fetchKeywordIdeasForCategory(seedKeyword) {
  try {
    const ideas = await getKeywordIdeas([seedKeyword], { limit: 200 });
    return ideas.map((r) => ({
      keyword: r.keyword,
      volume: r.volume,
      difficulty: r.kd,
      traffic_potential: r.volume,
      cpc: r.cpc,
      intents: r.intent || '',
      parent_keyword: '',
    }));
  } catch { return []; }
}

async function fetchContentGap() {
  try {
    const domain = config.url.replace(/^https?:\/\//, '').replace(/\/$/, '');

    // Discover product-level competitors from SERPs instead of domain overlap
    const SEED_KEYWORDS = ['natural deodorant', 'coconut oil toothpaste', 'coconut body lotion', 'natural lip balm', 'natural bar soap'];
    const EDITORIAL = new Set(['amazon.com','walmart.com','target.com','ebay.com','youtube.com','reddit.com','facebook.com','instagram.com','tiktok.com','pinterest.com','wikipedia.org','healthline.com','byrdie.com','allure.com','consumerreports.org','medicalnewstoday.com','clevelandclinic.org','health.com','thegoodtrade.com']);
    const ourDomain = domain.replace(/^www\./, '');
    const domainCounts = new Map();
    for (const kw of SEED_KEYWORDS) {
      try {
        const { organic: results } = await getSerpResults(kw, 10);
        for (const r of results) {
          const d = r.domain.replace(/^www\./, '');
          if (d === ourDomain || EDITORIAL.has(d)) continue;
          domainCounts.set(d, (domainCounts.get(d) || 0) + 1);
        }
      } catch { /* skip */ }
    }
    const compDomains = Array.from(domainCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([d]) => d);

    // Get our keywords
    const ourKeywords = await getRankedKeywords(domain, { limit: 500 });
    const ourSet = new Set(ourKeywords.map((k) => k.keyword.toLowerCase()));

    // Get competitor keywords and find gaps
    const gaps = [];
    for (const comp of compDomains.slice(0, 3)) {
      const compKws = await getRankedKeywords(comp, { limit: 200 });
      for (const kw of compKws) {
        if (!ourSet.has(kw.keyword.toLowerCase()) && kw.volume > 50) {
          gaps.push({
            keyword: kw.keyword,
            volume: kw.volume,
            kd: 0,
            rsc_position: null,
            competitor_positions: { [comp]: kw.position },
          });
        }
      }
    }

    // Dedupe by keyword, keep highest volume
    const seen = new Map();
    for (const g of gaps) {
      const key = g.keyword.toLowerCase();
      if (!seen.has(key) || seen.get(key).volume < g.volume) seen.set(key, g);
    }

    return {
      keywords: Array.from(seen.values()).sort((a, b) => b.volume - a.volume).slice(0, 200),
      competitors: compDomains,
    };
  } catch (err) {
    console.log(`  ⚠️ DataForSEO content gap fetch failed: ${err.message}`);
    return { keywords: [], competitors: [] };
  }
}

async function fetchOwnKeywords() {
  try {
    const domain = config.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const keywords = await getRankedKeywords(domain, { limit: 500 });
    return keywords.map((kw) => ({
      keyword: kw.keyword,
      position: kw.position,
      volume: kw.volume,
      url: kw.url,
    }));
  } catch { return []; }
}

async function fetchCompetitorTopPages() {
  try {
    const domain = config.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const competitors = await getCompetitors(domain, { limit: 5 });
    const result = {};
    for (const comp of competitors.slice(0, 3)) {
      const pages = await getTopPages(comp.domain, { limit: 50 });
      result[comp.domain] = pages.map((p) => ({
        url: 'https://' + comp.domain + p.url,
        traffic: p.traffic,
        keywords: p.keywords,
        top_keyword: p.topKeyword || '',
        top_keyword_volume: 0,
      }));
    }
    return result;
  } catch { return {}; }
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

  // Load inventory
  process.stdout.write('  Loading content inventory... ');
  const inventory = loadInventory();
  console.log(`done (${inventory.articles.length} articles, ${inventory.products.length} products, ${inventory.collections.length} collections)`);

  // Content gap data — live from DataForSEO
  console.log('  Loading content gap data from DataForSEO...');
  const contentGap = await fetchContentGap();
  console.log(`  Content gap: ${contentGap.keywords.length} keywords, competitors: ${contentGap.competitors.join(', ')}`);

  // Own keyword rankings — live from DataForSEO
  console.log('  Loading own keyword rankings...');
  const ownKeywords = await fetchOwnKeywords();
  console.log(`  Own keywords: ${ownKeywords.length}`);

  // Category keyword ideas — live from DataForSEO
  const categories = {
    deodorant: 'natural deodorant',
    toothpaste: 'natural toothpaste',
    body_lotion: 'natural body lotion',
    lip_balm: 'natural lip balm',
    bar_soap: 'natural bar soap',
    hand_soap: 'natural hand soap',
    coconut_oil: 'coconut oil skincare',
  };

  const categoryKeywords = {};
  for (const [cat, seed] of Object.entries(categories)) {
    const kws = await fetchKeywordIdeasForCategory(seed);
    if (kws.length) {
      categoryKeywords[cat] = kws;
      console.log(`  ${cat}: ${kws.length} keywords`);
    }
  }

  // Competitor top pages — live from DataForSEO
  console.log('  Loading competitor top pages...');
  const competitorTopPages = await fetchCompetitorTopPages();
  const compNames = Object.keys(competitorTopPages);
  console.log(`  Competitor pages: ${compNames.join(', ')}`);
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
**Data source:** DataForSEO API
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
