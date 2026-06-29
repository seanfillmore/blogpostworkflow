/**
 * Backlink Opportunity Agent
 *
 * Identifies link-building opportunities by finding high-authority domains that
 * link to competitors but not to this site (link-gap analysis).
 *
 * Strategy:
 *   1. Pull each competitor's referring domains live from DataForSEO
 *   2. Pull our own referring domains and diff against them
 *   3. Score by domain rank, dofollow status, and how many competitors share it
 *   4. Claude categorizes opportunities and suggests outreach angles
 *
 * Competitors come from config/competitors.json. Requires the DataForSEO
 * Backlinks API subscription; when it's inactive the agent degrades gracefully
 * (reports "subscription required" and exits 0) rather than failing.
 *
 * Per-competitor referring-domain pulls are cached daily under
 * data/backlinks/cache/ so re-runs on the same day don't re-bill the API.
 *
 * Usage:
 *   node agents/backlink-opportunity/index.js
 *   node agents/backlink-opportunity/index.js --min-rank 100  # min DataForSEO domain rank (0–1000, default 50)
 *   node agents/backlink-opportunity/index.js --limit 50      # top N results (default 50)
 *
 * Output:
 *   data/reports/backlinks/backlink-opportunities-report.md
 *   data/backlinks/opportunities.json
 */

import Anthropic from '../../lib/anthropic.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { notify, notifyLatestReport } from '../../lib/notify.js';
import { getReferringDomains } from '../../lib/dataforseo.js';
import { classifySource } from '../../lib/pr-targets.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const BACKLINKS_DIR = join(ROOT, 'data', 'backlinks');
const CACHE_DIR = join(BACKLINKS_DIR, 'cache');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'backlinks');

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

const minRank = parseInt(getArg('--min-rank') || '50', 10); // DataForSEO domain rank, 0–1000
const limit = parseInt(getArg('--limit') || '50', 10);
const PER_DOMAIN_LIMIT = 1000; // cap referring domains pulled per target (API is per-row priced)

// ── referring-domain fetch (cached daily) ──────────────────────────────────────

const cleanDomain = (d) => (d || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').toLowerCase();

/**
 * Fetch a target's referring domains, caching the result for the current day.
 * Returns an array of rows, or null if the Backlinks subscription is inactive.
 */
async function fetchReferringDomains(target, today) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = join(CACHE_DIR, `${cleanDomain(target)}-${today}.json`);
  if (existsSync(cachePath)) {
    try { return JSON.parse(readFileSync(cachePath, 'utf8')); } catch { /* re-fetch */ }
  }
  const rows = await getReferringDomains(cleanDomain(target), { limit: PER_DOMAIN_LIMIT });
  if (rows === null) return null; // subscription inactive — signal up
  writeFileSync(cachePath, JSON.stringify(rows, null, 2));
  return rows;
}

// ── opportunity scoring ───────────────────────────────────────────────────────

function buildOpportunities(competitorMap, ourDomains, competitorDomains) {
  const map = new Map();

  for (const [competitor, refdomains] of competitorMap.entries()) {
    for (const rd of refdomains) {
      if (ourDomains.has(rd.domain)) continue;
      // Keep only editorial domains we could actually pitch — drop shorteners,
      // coupon/reward/directory junk, platforms, retailers, and competitors.
      if (classifySource(rd.domain, { competitorDomains }) !== 'pitch') continue;
      if (!map.has(rd.domain)) {
        map.set(rd.domain, { domain: rd.domain, rank: rd.rank, dofollow: rd.dofollow, competitors: [] });
      }
      const entry = map.get(rd.domain);
      entry.competitors.push(competitor);
      // Keep the strongest signal seen for rank/dofollow across competitors.
      if (rd.rank > entry.rank) entry.rank = rd.rank;
      if (rd.dofollow) entry.dofollow = true;
    }
  }

  return [...map.values()]
    .map((opp) => {
      const competitorCount = opp.competitors.length;
      // Multi-competitor overlap is the strongest signal, then authority.
      const score = (competitorCount - 1) * 300 + opp.rank + (opp.dofollow ? 50 : 0);
      return { ...opp, competitorCount, score };
    })
    .filter((opp) => opp.rank >= minRank)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── claude categorization ─────────────────────────────────────────────────────

async function categorizeOpportunities(opportunities, competitors) {
  const topList = opportunities.slice(0, 40).map((o, i) =>
    `${i + 1}. ${o.domain} (rank ${o.rank}, ${o.dofollow ? 'dofollow' : 'nofollow'}, links to ${o.competitorCount} competitor${o.competitorCount > 1 ? 's' : ''}: ${o.competitors.slice(0, 3).join(', ')})`
  ).join('\n');

  const prompt = `You are an SEO link-building strategist for ${config.name} (${config.url}), a ${config.brand_description}.

These are the top backlink opportunities — domains that link to competitors but not to us:

${topList}

Competitors analyzed: ${competitors.join(', ')}

For each domain, infer its type and the most likely reason it links to competitors (e.g. product review, ingredient guide, "best of" roundup, press coverage, directory listing, blogger recommendation, etc.).

Group the opportunities into these categories and provide outreach angle guidance for each:

1. **Editorial / Blog Reviews** — Independent bloggers or content sites reviewing natural products
2. **Roundup Lists** — "Best natural deodorant" / "Top clean beauty brands" style posts
3. **Press & Media** — News sites, magazines, podcasts
4. **Resource Pages & Directories** — Clean beauty directories, ingredient databases, retail guides
5. **Other** — Anything that doesn't fit above

For each category, list the top domains that fit it, and give ONE specific outreach angle (what hook would get them to add a link to ${config.name}).

Format as Markdown. Be specific and direct — skip generic advice.`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  });

  return msg.content[0].text;
}

// ── report ────────────────────────────────────────────────────────────────────

function buildReport(opportunities, competitors, categorization, ourDomainCount) {
  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const multiCompetitor = opportunities.filter((o) => o.competitorCount > 1);

  const lines = [
    `# Backlink Opportunity Report — ${config.name}`,
    `**Run date:** ${now}`,
    `**Data source:** DataForSEO Backlinks API (live referring domains)`,
    `**Our referring domains:** ${ourDomainCount}`,
    `**Competitors analyzed:** ${competitors.join(', ')}`,
    `**Opportunities found:** ${opportunities.length} (rank ≥ ${minRank}, top ${limit})`,
    `**Linking to 2+ competitors:** ${multiCompetitor.length}`,
    '',
    '---',
    '',
    '## Priority Opportunities',
    '',
    '> Sorted by score (competitor overlap + domain rank + dofollow bonus). Domains linking to multiple competitors are the strongest signals.',
    '',
    '| # | Domain | Rank | Dofollow | Competitors | Score |',
    '|---|---|---|---|---|---|',
    ...opportunities.slice(0, 30).map((o, i) =>
      `| ${i + 1} | ${o.domain} | ${o.rank} | ${o.dofollow ? '✅' : '—'} | ${o.competitorCount} (${o.competitors.slice(0, 2).join(', ')}${o.competitors.length > 2 ? '…' : ''}) | ${o.score} |`
    ),
    '',
    '---',
    '',
    '## Categorized Opportunities & Outreach Angles',
    '',
    categorization,
    '',
    '---',
    '',
    '## How to Use This Report',
    '1. Start with domains linking to 2+ competitors — they already cover this niche',
    '2. Focus on editorial/blog and roundup categories first (highest conversion rate)',
    '3. For each target, find the specific page linking to competitors and replicate the pitch',
    '4. Track outreach manually in `data/backlinks/outreach.json`',
    '',
    '## How to Refresh',
    'Run: `node agents/backlink-opportunity/index.js` — it pulls competitor referring domains live from DataForSEO (cached daily). Edit `config/competitors.json` to change the competitor set.',
  ];

  return lines.join('\n');
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nBacklink Opportunity Agent — ${config.name}`);
  console.log(`Settings: rank ≥ ${minRank}, top ${limit} results\n`);

  mkdirSync(REPORTS_DIR, { recursive: true });

  const today = new Date().toISOString().slice(0, 10);
  const competitorConfig = JSON.parse(readFileSync(join(ROOT, 'config', 'competitors.json'), 'utf8'));
  const ourDomain = cleanDomain(config.url);

  // Our referring domains first — also tells us if the subscription is active.
  process.stdout.write('  Fetching our referring domains from DataForSEO... ');
  const ourRows = await fetchReferringDomains(ourDomain, today);
  if (ourRows === null) {
    console.log('\n  ⚠️ DataForSEO Backlinks API subscription is inactive — cannot run link-gap analysis.');
    console.log('  Activate it at https://app.dataforseo.com/backlinks-subscription to enable this agent.');
    notify({
      subject: 'Backlink Opportunity skipped — Backlinks subscription inactive',
      body: 'getReferringDomains returned no data (DataForSEO Backlinks API subscription required). Activate the subscription to enable competitor link-gap analysis.',
      status: 'info',
    });
    return;
  }
  const ourDomains = new Set(ourRows.map((r) => r.domain));
  console.log(`${ourDomains.size} referring domains`);

  // Competitor referring domains.
  const competitorMap = new Map();
  for (const c of competitorConfig) {
    process.stdout.write(`  ${c.name} (${c.domain})... `);
    const rows = await fetchReferringDomains(c.domain, today);
    if (rows === null) {
      console.log('subscription inactive — aborting');
      return;
    }
    competitorMap.set(c.name, rows);
    console.log(`${rows.length} referring domains`);
  }

  const competitors = [...competitorMap.keys()];
  const competitorDomains = competitorConfig.map((c) => c.domain);

  // Find opportunities.
  process.stdout.write('\n  Computing link gap... ');
  const opportunities = buildOpportunities(competitorMap, ourDomains, competitorDomains);
  console.log(`${opportunities.length} opportunities (rank ≥ ${minRank})`);

  if (opportunities.length === 0) {
    console.log('  No opportunities found. Try lowering --min-rank or adding competitors to config/competitors.json.');
    const report = buildReport([], competitors, '_No opportunities found at the current rank threshold._', ourDomains.size);
    writeFileSync(join(REPORTS_DIR, 'backlink-opportunities-report.md'), report);
    return;
  }

  const multiCount = opportunities.filter((o) => o.competitorCount > 1).length;
  console.log(`  Linking to 2+ competitors: ${multiCount}`);

  // Claude categorization.
  process.stdout.write('\n  Categorizing with Claude... ');
  const categorization = await categorizeOpportunities(opportunities, competitors);
  console.log('done');

  // Save JSON.
  const opportunitiesPath = join(BACKLINKS_DIR, 'opportunities.json');
  writeFileSync(opportunitiesPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    competitors,
    minRank,
    opportunities: opportunities.map(({ domain, rank, dofollow, competitors: comps, competitorCount, score }) => ({
      domain, rank, dofollow, competitors: comps, competitorCount, score,
    })),
  }, null, 2));

  // Write report.
  const report = buildReport(opportunities, competitors, categorization, ourDomains.size);
  const reportPath = join(REPORTS_DIR, 'backlink-opportunities-report.md');
  writeFileSync(reportPath, report);

  console.log(`\n  Opportunities saved: ${opportunitiesPath}`);
  console.log(`  Report saved:        ${reportPath}`);
  console.log(`\n  Top 5 opportunities:`);
  opportunities.slice(0, 5).forEach((o, i) => {
    console.log(`    ${i + 1}. ${o.domain} (rank ${o.rank}, ${o.competitorCount} competitor${o.competitorCount > 1 ? 's' : ''})`);
  });
}

main()
  .then(() => notifyLatestReport('Backlink Opportunity completed', join(ROOT, 'data', 'reports', 'backlinks')))
  .catch((err) => {
    notify({ subject: 'Backlink Opportunity failed', body: err.message || String(err), status: 'error' });
    console.error('Error:', err.message);
    process.exit(1);
  });
