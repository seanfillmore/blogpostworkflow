/**
 * GSC Query Mining Agent
 *
 * Mines Google Search Console data to surface four classes of opportunity:
 *
 *   1. Impression Leaks   — queries getting 50+ impressions but 0 clicks.
 *                           Google thinks you're relevant; searchers disagree.
 *                           Fix: better title/meta, or write dedicated content.
 *
 *   2. Near-Misses        — queries at positions 4–10 with 50+ impressions.
 *                           Small improvements (title, internal links, content
 *                           depth) can push these into the top 3 and multiply clicks.
 *
 *   3. Cannibalization    — queries where 2+ of your pages compete for the
 *                           same SERP slot, splitting signals. One page should
 *                           canonicalize or redirect to the other.
 *
 *   4. Untapped Clusters  — topic groups with aggregate impressions but no
 *                           dominant ranking page — content gaps signaled by
 *                           Google itself, not guessed from keyword tools.
 *
 * Claude writes the final analysis: interprets patterns, assigns actions,
 * and produces a prioritized recommendation list.
 *
 * Usage:
 *   node agents/gsc-query-miner/index.js
 *   node agents/gsc-query-miner/index.js --days 28       # shorter window (default: 90)
 *   node agents/gsc-query-miner/index.js --min-impr 30   # impression threshold (default: 50)
 *
 * Output: data/reports/gsc-query-mining-report.md
 */

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
import { notify } from '../../lib/notify.js';
  getTopKeywords,
  getAllQueryPageRows,
} from '../../lib/gsc.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'gsc-query-miner');

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

const days = parseInt(getArg('--days') || '90', 10);
const minImpr = parseInt(getArg('--min-impr') || '50', 10);

// ── analysis functions ────────────────────────────────────────────────────────

function findImpressionLeaks(queries) {
  return queries
    .filter((q) => q.impressions >= minImpr && q.clicks === 0)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 50);
}

function findNearMisses(queries) {
  return queries
    .filter((q) => q.position >= 4 && q.position <= 10 && q.impressions >= minImpr)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, 30);
}

function findCannibalization(queryPageRows) {
  // Group by query → collect all pages ranking for it
  const byQuery = new Map();
  for (const row of queryPageRows) {
    if (!byQuery.has(row.query)) byQuery.set(row.query, []);
    byQuery.get(row.query).push(row);
  }

  return [...byQuery.entries()]
    .filter(([, pages]) => pages.length >= 2)
    .map(([query, pages]) => ({
      query,
      totalImpressions: pages.reduce((s, p) => s + p.impressions, 0),
      pages: pages
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 4)
        .map((p) => ({ page: p.page, impressions: p.impressions, position: Math.round(p.position * 10) / 10, clicks: p.clicks })),
    }))
    .filter((g) => g.totalImpressions >= minImpr)
    .sort((a, b) => b.totalImpressions - a.totalImpressions)
    .slice(0, 25);
}

function buildTopicClusters(queries) {
  // Simple stem clustering: group queries sharing a significant word
  const stopwords = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'in', 'of', 'to', 'is', 'vs', 'best', 'top', 'how', 'what', 'why', 'do', 'does', 'are', 'can', 'without', 'free', 'natural']);

  const stems = new Map(); // stem → [queries]
  for (const q of queries) {
    const words = q.keyword.toLowerCase().split(/\s+/).filter((w) => w.length > 3 && !stopwords.has(w));
    for (const word of words) {
      if (!stems.has(word)) stems.set(word, []);
      stems.get(word).push(q);
    }
  }

  return [...stems.entries()]
    .filter(([, qs]) => qs.length >= 3) // at least 3 queries in cluster
    .map(([stem, qs]) => {
      const unique = [...new Map(qs.map((q) => [q.keyword, q])).values()];
      const totalImpressions = unique.reduce((s, q) => s + q.impressions, 0);
      const totalClicks = unique.reduce((s, q) => s + q.clicks, 0);
      const avgPosition = unique.reduce((s, q) => s + q.position, 0) / unique.length;
      return { stem, queries: unique.slice(0, 8), totalImpressions, totalClicks, avgPosition: Math.round(avgPosition * 10) / 10 };
    })
    .filter((c) => c.totalImpressions >= minImpr * 3)
    .sort((a, b) => b.totalImpressions - a.totalImpressions)
    .slice(0, 15);
}

// ── format helpers ────────────────────────────────────────────────────────────

function pct(ctr) { return `${(ctr * 100).toFixed(1)}%`; }
function pos(p) { return `#${Math.round(p * 10) / 10}`; }

function formatLeaks(leaks) {
  if (!leaks.length) return 'None found above threshold.';
  return ['| Query | Impressions | Avg Position |',
    '|---|---|---|',
    ...leaks.slice(0, 30).map((q) => `| ${q.keyword} | ${q.impressions} | ${pos(q.position)} |`)
  ].join('\n');
}

function formatNearMisses(nearMisses) {
  if (!nearMisses.length) return 'None found above threshold.';
  return ['| Query | Impressions | Position | Clicks | CTR |',
    '|---|---|---|---|---|',
    ...nearMisses.map((q) => `| ${q.keyword} | ${q.impressions} | ${pos(q.position)} | ${q.clicks} | ${pct(q.ctr)} |`)
  ].join('\n');
}

function formatCannibalization(groups) {
  if (!groups.length) return 'No cannibalization detected above threshold.';
  return groups.slice(0, 15).map((g) => [
    `**"${g.query}"** — ${g.totalImpressions} total impressions across ${g.pages.length} pages`,
    ...g.pages.map((p) => `  - \`${p.page.replace(config.url, '')}\` — pos ${p.position}, ${p.impressions} impr, ${p.clicks} clicks`),
  ].join('\n')).join('\n\n');
}

function formatClusters(clusters) {
  if (!clusters.length) return 'No significant clusters found.';
  return clusters.slice(0, 10).map((c) => [
    `**"${c.stem}" cluster** — ${c.totalImpressions} impressions, ${c.totalClicks} clicks, avg pos ${c.avgPosition}`,
    ...c.queries.map((q) => `  - "${q.keyword}" (${q.impressions} impr, pos ${pos(q.position)})`),
  ].join('\n')).join('\n\n');
}

// ── claude analysis ───────────────────────────────────────────────────────────

async function generateAnalysis(leaks, nearMisses, cannibalization, clusters, totalQueries) {
  const prompt = `You are the SEO lead for ${config.name} (${config.url}), a ${config.brand_description}.

Below is GSC data (last ${days} days) surfacing four categories of opportunity. Write a focused SEO action plan.

---

## 1. Impression Leaks (${leaks.length} queries — impressions ≥ ${minImpr}, 0 clicks)
These queries show our pages in Google but nobody clicks. Root causes: wrong title/meta, wrong search intent match, ranking too low to matter even with impressions.

${formatLeaks(leaks)}

## 2. Near-Misses (positions 4–10 with ≥ ${minImpr} impressions)
One or two positions higher could 2–3× clicks. Levers: title tag relevance, internal links, content freshness, featured snippet optimization.

${formatNearMisses(nearMisses)}

## 3. Cannibalization (${cannibalization.length} query groups with 2+ competing pages)
Split signals mean neither page ranks as well as it could. Fix: consolidate, redirect, or canonicalize the weaker page.

${formatCannibalization(cannibalization)}

## 4. Topic Clusters with Aggregate Impressions (${clusters.length} clusters)
These topics generate impressions across many long-tail queries but no single page dominates. Consider a pillar page or content consolidation.

${formatClusters(clusters)}

---

Total queries in GSC data: ${totalQueries}

---

Write a Markdown report with these sections:

### Executive Summary
3-5 bullets on the biggest patterns and highest-priority issues.

### Impression Leaks — Action Plan
For the top 15 leak queries: group by root cause (wrong intent, bad title, no dedicated page) and give ONE specific action per group. Be concrete — name the actual query and what to do.

### Near-Miss Opportunities
For the top 10 near-miss queries: what would push each one from position 6 to position 2? (specific: add internal links, expand section X, add FAQ, etc.)

### Cannibalization Fixes
For the top 5 worst cannibalization cases: which URL should be the canonical, and what should happen to the others?

### Cluster Strategy
For the top 3 topic clusters: is there a missing pillar page, or do existing pages just need consolidation?

### Priority Action List
A numbered list of the top 10 concrete actions, ordered by expected impact. Each should be actionable in under a day.

Be specific. Use the actual query text and URL paths from the data. Skip generic advice.`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });

  return msg.content[0].text;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nGSC Query Miner — ${config.name}`);
  console.log(`Window: ${days} days | Min impressions: ${minImpr}\n`);

  mkdirSync(REPORTS_DIR, { recursive: true });

  // Fetch GSC data in parallel
  process.stdout.write('  Fetching GSC query data... ');
  const [allQueries, queryPageRows] = await Promise.all([
    getTopKeywords(5000, days),
    getAllQueryPageRows(5000, days),
  ]);
  console.log(`${allQueries.length} queries, ${queryPageRows.length} query+page rows`);

  // Run analyses
  process.stdout.write('  Analysing... ');
  const leaks = findImpressionLeaks(allQueries);
  const nearMisses = findNearMisses(allQueries);
  const cannibalization = findCannibalization(queryPageRows);
  const clusters = buildTopicClusters(allQueries);
  console.log(`${leaks.length} leaks, ${nearMisses.length} near-misses, ${cannibalization.length} cannibalization groups, ${clusters.length} clusters`);

  // Claude analysis
  process.stdout.write('\n  Generating analysis with Claude... ');
  const analysis = await generateAnalysis(leaks, nearMisses, cannibalization, clusters, allQueries.length);
  console.log('done');

  // Build full report
  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const header = [
    `# GSC Query Mining Report — ${config.name}`,
    `**Run date:** ${now}  `,
    `**Window:** Last ${days} days  `,
    `**Impression threshold:** ${minImpr}+  `,
    `**Total queries in GSC:** ${allQueries.length}  `,
    '',
    '---',
    '',
  ].join('\n');

  const rawDataSection = [
    '',
    '---',
    '',
    '## Raw Data',
    '',
    `### Impression Leaks (${leaks.length})`,
    formatLeaks(leaks),
    '',
    `### Near-Misses (${nearMisses.length})`,
    formatNearMisses(nearMisses),
    '',
    `### Cannibalization Groups (${cannibalization.length})`,
    formatCannibalization(cannibalization),
    '',
    `### Topic Clusters (${clusters.length})`,
    formatClusters(clusters),
  ].join('\n');

  const reportPath = join(REPORTS_DIR, 'gsc-query-mining-report.md');
  writeFileSync(reportPath, header + analysis + rawDataSection);

  console.log(`\n  Report saved: ${reportPath}`);
  console.log('\n  Summary:');
  console.log(`    Impression leaks:        ${leaks.length} queries (${leaks.reduce((s, q) => s + q.impressions, 0).toLocaleString()} impressions wasted)`);
  console.log(`    Near-miss opportunities: ${nearMisses.length} queries`);
  console.log(`    Cannibalization groups:  ${cannibalization.length} queries`);
  console.log(`    Topic clusters:          ${clusters.length} groups`);
}

main()
  .then(() => notify({ subject: 'GSC Query Miner completed', body: 'GSC Query Miner ran successfully.', status: 'success' }))
  .catch((err) => {
    notify({ subject: 'GSC Query Miner failed', body: err.message || String(err), status: 'error' });
    console.error('Error:', err.message);
    process.exit(1);
  });
