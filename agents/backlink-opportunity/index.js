/**
 * Backlink Opportunity Agent
 *
 * Identifies link-building opportunities by finding high-DR domains that link
 * to competitors but not to this site (link gap analysis).
 *
 * Strategy:
 *   1. Read competitor referring-domain CSV exports from data/backlinks/competitors/
 *   2. Diff against our current referring domain snapshot
 *   3. Score by DR, dofollow status, and how many competitors share the domain
 *   4. Claude categorizes opportunities and suggests outreach angles
 *
 * Setup:
 *   1. In Ahrefs → Site Explorer → <competitor domain> → Referring Domains
 *   2. Export as CSV → save to data/backlinks/competitors/<competitor>.csv
 *      (e.g. data/backlinks/competitors/nativecos.csv)
 *   3. Repeat for each competitor, then run this agent
 *   4. Ensure data/backlinks/snapshots/ has at least one snapshot (run backlink-monitor first)
 *
 * Usage:
 *   node agents/backlink-opportunity/index.js
 *   node agents/backlink-opportunity/index.js --min-dr 20   # filter by DR (default: 20)
 *   node agents/backlink-opportunity/index.js --limit 50    # top N results (default: 50)
 *
 * Output:
 *   data/reports/backlink-opportunities-report.md
 *   data/backlinks/opportunities.json
 *
 * CSV format expected (Ahrefs default Referring Domains export):
 *   Domain, Domain Rating, First seen, Last seen, Dofollow, Links to target
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const BACKLINKS_DIR = join(ROOT, 'data', 'backlinks');
const COMPETITORS_DIR = join(BACKLINKS_DIR, 'competitors');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'backlinks');
const SNAPSHOTS_DIR = join(BACKLINKS_DIR, 'snapshots');

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

const minDr = parseInt(getArg('--min-dr') || '20', 10);
const limit = parseInt(getArg('--limit') || '50', 10);

// ── CSV parsing ───────────────────────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const raw = lines[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim().toLowerCase());
  return lines.slice(1).map((line) => {
    const cols = [];
    let cur = '';
    let inQuote = false;
    for (const ch of line) {
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === ',' && !inQuote) { cols.push(cur); cur = ''; }
      else { cur += ch; }
    }
    cols.push(cur);
    const obj = {};
    raw.forEach((h, i) => { obj[h] = (cols[i] || '').replace(/^"|"$/g, '').trim(); });
    return obj;
  });
}

function normalizeRow(row) {
  const domain = (row['referring domain'] || row['domain'] || '').toLowerCase();
  const dr = parseFloat(row['domain rating'] || row['dr'] || '0') || 0;
  const dofollow = (row['dofollow'] || '').toLowerCase() === 'true' || row['dofollow'] === '1';
  return { domain, dr, dofollow };
}

function loadCSV(filepath) {
  const rows = parseCSV(readFileSync(filepath, 'utf8'));
  return rows.map(normalizeRow).filter((r) => r.domain);
}

// ── our backlink snapshot ──────────────────────────────────────────────────────

function loadLatestSnapshot() {
  if (!existsSync(SNAPSHOTS_DIR)) return { domains: new Set(), date: null };
  const files = readdirSync(SNAPSHOTS_DIR).filter((f) => f.endsWith('.csv')).sort().reverse();
  if (files.length === 0) return { domains: new Set(), date: null };

  const snapshotPath = join(SNAPSHOTS_DIR, files[0]);
  const snapshotDate = files[0].replace('.csv', '');
  const rows = loadCSV(snapshotPath);
  return { domains: new Set(rows.map((r) => r.domain)), date: snapshotDate };
}

// ── competitor CSVs ───────────────────────────────────────────────────────────

function loadCompetitorCSVs() {
  if (!existsSync(COMPETITORS_DIR)) return new Map();

  const files = readdirSync(COMPETITORS_DIR).filter((f) => f.endsWith('.csv'));
  const map = new Map();

  for (const file of files) {
    const name = basename(file, '.csv'); // e.g. "nativecos" from "nativecos.csv"
    const rows = loadCSV(join(COMPETITORS_DIR, file));
    map.set(name, rows);
  }

  return map;
}

// ── opportunity scoring ───────────────────────────────────────────────────────

function buildOpportunities(competitorMap, ourDomains) {
  const map = new Map();

  for (const [competitor, refdomains] of competitorMap.entries()) {
    for (const rd of refdomains) {
      if (ourDomains.has(rd.domain)) continue;
      if (!map.has(rd.domain)) {
        map.set(rd.domain, { domain: rd.domain, dr: rd.dr, dofollow: rd.dofollow, competitors: [] });
      }
      map.get(rd.domain).competitors.push(competitor);
    }
  }

  return [...map.values()]
    .map((opp) => {
      const competitorCount = opp.competitors.length;
      const score = opp.dr + (opp.dofollow ? 10 : 0) + (competitorCount - 1) * 15;
      return { ...opp, competitorCount, score };
    })
    .filter((opp) => opp.dr >= minDr)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ── claude categorization ─────────────────────────────────────────────────────

async function categorizeOpportunities(opportunities, competitors) {
  const topList = opportunities.slice(0, 40).map((o, i) =>
    `${i + 1}. ${o.domain} (DR ${o.dr}, ${o.dofollow ? 'dofollow' : 'nofollow'}, links to ${o.competitorCount} competitor${o.competitorCount > 1 ? 's' : ''}: ${o.competitors.slice(0, 3).join(', ')})`
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

function buildReport(opportunities, competitors, categorization, ourDomainCount, snapshotDate) {
  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const multiCompetitor = opportunities.filter((o) => o.competitorCount > 1);

  const lines = [
    `# Backlink Opportunity Report — ${config.name}`,
    `**Run date:** ${now}`,
    `**Our backlink snapshot:** ${snapshotDate} (${ourDomainCount} referring domains)`,
    `**Competitors analyzed:** ${competitors.join(', ')}`,
    `**Opportunities found:** ${opportunities.length} (DR ≥ ${minDr}, top ${limit})`,
    `**Linking to 2+ competitors:** ${multiCompetitor.length}`,
    '',
    '---',
    '',
    '## Priority Opportunities',
    '',
    '> Sorted by score (DR + dofollow bonus + competitor overlap). Domains linking to multiple competitors are the strongest signals.',
    '',
    '| # | Domain | DR | Dofollow | Competitors | Score |',
    '|---|---|---|---|---|---|',
    ...opportunities.slice(0, 30).map((o, i) =>
      `| ${i + 1} | ${o.domain} | ${o.dr} | ${o.dofollow ? '✅' : '—'} | ${o.competitorCount} (${o.competitors.slice(0, 2).join(', ')}${o.competitors.length > 2 ? '…' : ''}) | ${o.score} |`
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
    '1. In Ahrefs → Site Explorer → <competitor> → Referring Domains → Export CSV',
    `2. Save to \`data/backlinks/competitors/<competitor>.csv\``,
    '3. Run: `node agents/backlink-opportunity/index.js`',
  ];

  return lines.join('\n');
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nBacklink Opportunity Agent — ${config.name}`);
  console.log(`Settings: DR ≥ ${minDr}, top ${limit} results\n`);

  mkdirSync(REPORTS_DIR, { recursive: true });
  mkdirSync(COMPETITORS_DIR, { recursive: true });

  // Load our snapshot
  process.stdout.write('  Loading our backlink snapshot... ');
  const { domains: ourDomains, date: snapshotDate } = loadLatestSnapshot();
  if (ourDomains.size === 0) {
    console.log('\n  ⚠️  No backlink snapshot found. Run this first:');
    console.log('  npm run backlinks');
    process.exit(1);
  }
  console.log(`${ourDomains.size} domains (snapshot: ${snapshotDate})`);

  // Load competitor CSVs
  process.stdout.write('  Loading competitor CSVs... ');
  const competitorMap = loadCompetitorCSVs();

  if (competitorMap.size === 0) {
    console.log('\n  ⚠️  No competitor CSV files found.');
    console.log(`  Add files to: data/backlinks/competitors/`);
    console.log('  Steps:');
    console.log('    1. Ahrefs → Site Explorer → <competitor domain> → Referring Domains');
    console.log('    2. Export CSV → save as data/backlinks/competitors/<name>.csv');
    console.log('    3. Repeat for each competitor, then re-run');
    process.exit(1);
  }

  const competitors = [...competitorMap.keys()];
  const totalRefdomains = [...competitorMap.values()].reduce((sum, r) => sum + r.length, 0);
  console.log(`${competitorMap.size} competitors, ${totalRefdomains.toLocaleString()} total referring domains`);
  competitors.forEach((c) => {
    console.log(`    ${c}: ${competitorMap.get(c).length} domains`);
  });

  // Find opportunities
  process.stdout.write('\n  Computing link gap... ');
  const opportunities = buildOpportunities(competitorMap, ourDomains);
  console.log(`${opportunities.length} opportunities (DR ≥ ${minDr})`);

  if (opportunities.length === 0) {
    console.log('  No opportunities found. Try lowering --min-dr or add more competitor CSVs.');
    process.exit(0);
  }

  const multiCount = opportunities.filter((o) => o.competitorCount > 1).length;
  console.log(`  Linking to 2+ competitors: ${multiCount}`);

  // Claude categorization
  process.stdout.write('\n  Categorizing with Claude... ');
  const categorization = await categorizeOpportunities(opportunities, competitors);
  console.log('done');

  // Save JSON
  const opportunitiesPath = join(BACKLINKS_DIR, 'opportunities.json');
  writeFileSync(opportunitiesPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    snapshotDate,
    competitors,
    minDr,
    opportunities: opportunities.map(({ domain, dr, dofollow, competitors: comps, competitorCount, score }) => ({
      domain, dr, dofollow, competitors: comps, competitorCount, score,
    })),
  }, null, 2));

  // Write report
  const report = buildReport(opportunities, competitors, categorization, ourDomains.size, snapshotDate);
  const reportPath = join(REPORTS_DIR, 'backlink-opportunities-report.md');
  writeFileSync(reportPath, report);

  console.log(`\n  Opportunities saved: ${opportunitiesPath}`);
  console.log(`  Report saved:        ${reportPath}`);
  console.log(`\n  Top 5 opportunities:`);
  opportunities.slice(0, 5).forEach((o, i) => {
    console.log(`    ${i + 1}. ${o.domain} (DR ${o.dr}, ${o.competitorCount} competitor${o.competitorCount > 1 ? 's' : ''})`);
  });
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
