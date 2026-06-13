#!/usr/bin/env node
/**
 * SEO Impact Agent — "what's actually working?"
 *
 * The analysis/feedback layer. Most agents in this repo *fire* (publish, refresh,
 * optimize); this one closes the loop by measuring outcomes. It joins, by landing
 * page over a trailing window:
 *
 *   - GA4 organic revenue / conversions / sessions per landing page  (the OUTCOME)
 *   - GSC clicks / impressions per page                              (the VISIBILITY)
 *   - posts published in the window                                  (the ACTION, best-effort)
 *
 * and reports: which pages/clusters earn organic revenue, which are growing vs the
 * prior window, which high-traffic pages aren't converting, and where to push harder.
 *
 * Revenue source is GA4 organic (sessionDefaultChannelGroup = "Organic Search"),
 * range-queried over finalized days so the numbers match the GA4 Monetization UI.
 *
 * Outputs:
 *   data/reports/seo-impact/YYYY-MM-DD.md   — human-readable
 *   data/reports/seo-impact/latest.json     — machine-readable (digest + dashboard)
 *
 * Usage:
 *   node agents/seo-impact/index.js                 # default 28-day window
 *   node agents/seo-impact/index.js --window 30
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../../lib/notify.js';
import { fetchLandingPagesByChannel, fetchOrganicRevenueByDate } from '../../lib/ga4.js';
import { listAllSlugs, getPostMeta } from '../../lib/posts.js';
import {
  pathOf, organicByPage, buildPageImpacts, clusterRollup, actionWins, rankBy,
} from '../../lib/seo-impact.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const GSC_DIR = join(ROOT, 'data', 'snapshots', 'gsc');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'seo-impact');

const args = process.argv.slice(2);
const WINDOW = (() => { const i = args.indexOf('--window'); return i !== -1 ? parseInt(args[i + 1], 10) : 28; })();

// ── date helpers ──────────────────────────────────────────────────────────────
const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
// End the window 2 days back so GA4 monetization data is finalized.
function windows(windowDays) {
  const end = Date.parse(ymd(Date.now())) - 2 * DAY;
  const start = end - (windowDays - 1) * DAY;
  const priorEnd = start - DAY;
  const priorStart = priorEnd - (windowDays - 1) * DAY;
  return {
    current: { start: ymd(start), end: ymd(end) },
    prior: { start: ymd(priorStart), end: ymd(priorEnd) },
  };
}

// ── cluster mapping (path → product cluster) ───────────────────────────────────
const CLUSTERS = [
  'deodorant', 'toothpaste', 'lip balm', 'lip-balm', 'body lotion', 'body-lotion',
  'lotion', 'moisturizer', 'hand soap', 'hand-soap', 'bar soap', 'bar-soap',
  'foaming', 'soap', 'body cream', 'body-cream', 'cream', 'coconut oil', 'coconut-oil',
];
function clusterFor(path) {
  const t = (path || '').toLowerCase();
  for (const c of CLUSTERS) {
    if (t.includes(c) || t.includes(c.replace(/[- ]/g, '-')) || t.includes(c.replace(/[- ]/g, ''))) {
      return c.replace(/-/g, ' ');
    }
  }
  return null;
}

// ── GSC clicks/impressions per path over a date window (from stored snapshots) ──
function gscByPath({ start, end }) {
  const m = new Map();
  if (!existsSync(GSC_DIR)) return m;
  for (const f of readdirSync(GSC_DIR)) {
    const date = f.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f) || date < start || date > end) continue;
    let snap;
    try { snap = JSON.parse(readFileSync(join(GSC_DIR, f), 'utf8')); } catch { continue; }
    for (const p of (snap.topPages || [])) {
      const key = pathOf(p.page);
      if (!key) continue;
      const cur = m.get(key) || { clicks: 0, impressions: 0 };
      cur.clicks += p.clicks || 0;
      cur.impressions += p.impressions || 0;
      m.set(key, cur);
    }
  }
  return m;
}

// ── posts published within the window → action overlay (best-effort) ────────────
function actionsByPath({ start, end }) {
  const m = new Map();
  for (const slug of listAllSlugs()) {
    const meta = getPostMeta(slug);
    if (!meta) continue;
    const pub = (meta.shopify_publish_at || meta.published_at || meta.legacy_synced_at || '').slice(0, 10);
    if (!pub || pub < start || pub > end) continue;
    const blog = meta.shopify_blog_handle || 'news';
    const handle = meta.shopify_handle || slug;
    const path = pathOf(`/blogs/${blog}/${handle}`);
    if (path) m.set(path, { type: 'new-post', date: pub });
  }
  return m;
}

async function main() {
  console.log('\nSEO Impact Agent\n');
  const w = windows(WINDOW);
  console.log(`  Window:  ${w.current.start} → ${w.current.end} (${WINDOW}d)`);
  console.log(`  Compare: ${w.prior.start} → ${w.prior.end}`);

  // GA4 organic revenue/sessions per page, current + prior windows
  let curRows, priorRows;
  try {
    curRows = await fetchLandingPagesByChannel(w.current.start, w.current.end);
    priorRows = await fetchLandingPagesByChannel(w.prior.start, w.prior.end);
  } catch (err) {
    console.error('  GA4 query failed:', err.message);
    process.exit(1);
  }
  const current = organicByPage(curRows);
  const prior = organicByPage(priorRows);
  console.log(`  GA4 organic landing pages: ${current.size} (current), ${prior.size} (prior)`);

  const gscCurrent = gscByPath(w.current);
  const gscPrior = gscByPath(w.prior);
  const actions = actionsByPath(w.current);

  const impacts = buildPageImpacts({ current, prior, gscCurrent, gscPrior, actionsByPath: actions });

  // Aggregates
  const organicRevenue = round2([...current.values()].reduce((s, v) => s + v.revenue, 0));
  const organicRevenuePrev = round2([...prior.values()].reduce((s, v) => s + v.revenue, 0));
  const organicConversions = [...current.values()].reduce((s, v) => s + v.conversions, 0);

  const topRevenue = rankBy(impacts.filter(i => i.revenue > 0), 'revenue', 10);
  const topGrowth = rankBy(impacts.filter(i => i.revenueDelta > 0), 'revenueDelta', 10);
  const clusters = clusterRollup(impacts, clusterFor);
  const wins = rankBy(actionWins(impacts), 'revenueDelta', 10);
  // High organic traffic that isn't converting — content driving visits, not sales.
  const notConverting = rankBy(
    impacts.filter(i => i.sessions >= 30 && i.revenue === 0), 'sessions', 10,
  );

  // Weekly organic-revenue trend (last 12 weeks) for the dashboard chart.
  let revenueTrend = [];
  try {
    const trendStart = ymd(Date.parse(w.current.end) - (12 * 7 - 1) * DAY);
    const daily = await fetchOrganicRevenueByDate(trendStart, w.current.end);
    const buckets = new Map();
    for (const d of daily) {
      const wk = ymd(Date.parse(trendStart) + Math.floor((Date.parse(d.date) - Date.parse(trendStart)) / DAY / 7) * 7 * DAY);
      buckets.set(wk, round2((buckets.get(wk) || 0) + d.revenue));
    }
    revenueTrend = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([week, revenue]) => ({ week, revenue }));
  } catch (err) {
    console.error('  Trend fetch failed (non-fatal):', err.message);
  }

  console.log(`\n  Organic revenue: $${organicRevenue} (prior $${organicRevenuePrev}, ${organicRevenue >= organicRevenuePrev ? '+' : ''}$${round2(organicRevenue - organicRevenuePrev)})`);
  console.log('  Top organic-revenue pages:');
  for (const p of topRevenue.slice(0, 6)) {
    console.log(`    $${p.revenue.toString().padStart(7)}  ${p.path}  (${p.sessions}s, ${p.conversions}c${p.action ? ', ' + p.action.type : ''})`);
  }
  if (notConverting.length) {
    console.log('  High traffic, $0 revenue:');
    for (const p of notConverting.slice(0, 4)) console.log(`    ${p.sessions}s  ${p.path}`);
  }

  // ── outputs ───────────────────────────────────────────────────────────────
  mkdirSync(REPORTS_DIR, { recursive: true });
  const generated_at = new Date().toISOString();
  const payload = {
    generated_at,
    window: w.current,
    prior_window: w.prior,
    totals: {
      organic_revenue: organicRevenue,
      organic_revenue_prev: organicRevenuePrev,
      organic_revenue_delta: round2(organicRevenue - organicRevenuePrev),
      organic_conversions: organicConversions,
    },
    top_revenue: topRevenue,
    top_growth: topGrowth,
    clusters,
    action_wins: wins,
    not_converting: notConverting,
    revenue_trend: revenueTrend,
  };
  writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify(payload, null, 2));
  writeFileSync(join(REPORTS_DIR, `${ymd(Date.now())}.md`), buildReport(payload));
  console.log(`\n  Report saved: data/reports/seo-impact/${ymd(Date.now())}.md`);

  await notify({
    subject: `SEO Impact: $${organicRevenue} organic revenue (${organicRevenue >= organicRevenuePrev ? '+' : ''}$${round2(organicRevenue - organicRevenuePrev)} vs prior ${WINDOW}d)`,
    body: `Top organic-revenue pages:\n${topRevenue.slice(0, 5).map(p => `  $${p.revenue} — ${p.path}`).join('\n')}\n\nTop clusters:\n${clusters.slice(0, 4).map(c => `  $${c.revenue} — ${c.cluster}`).join('\n')}`,
    status: 'info',
    category: 'seo',
  }).catch(() => {});

  console.log('\nSEO impact analysis complete.');
}

function buildReport(p) {
  const L = [];
  const money = (n) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;
  const delta = (n) => `${n >= 0 ? '+' : '−'}${money(Math.abs(n))}`;
  L.push(`# SEO Impact — What's Working`);
  L.push('');
  L.push(`**Window:** ${p.window.start} → ${p.window.end} (vs ${p.prior_window.start} → ${p.prior_window.end})`);
  L.push(`**Organic revenue:** ${money(p.totals.organic_revenue)} (${delta(p.totals.organic_revenue_delta)} vs prior) · ${p.totals.organic_conversions} conversion events (GA4 key events, not purchases)`);
  L.push('');
  L.push('_Organic revenue is GA4 sessionDefaultChannelGroup = "Organic Search", attributed to the entry landing page._');
  L.push('');
  L.push('## Top organic-revenue pages');
  L.push('');
  L.push('| Page | Revenue | Δ vs prior | Conv | Sessions | Clicks Δ | Action |');
  L.push('|------|--------:|-----------:|-----:|---------:|---------:|--------|');
  for (const r of p.top_revenue) {
    L.push(`| ${r.path} | ${money(r.revenue)} | ${delta(r.revenueDelta)} | ${r.conversions} | ${r.sessions} | ${r.clicksDelta >= 0 ? '+' : ''}${r.clicksDelta} | ${r.action ? r.action.type + ' ' + r.action.date : '—'} |`);
  }
  L.push('');
  L.push('## Fastest-growing (revenue Δ vs prior window)');
  L.push('');
  for (const r of p.top_growth) L.push(`- **${delta(r.revenueDelta)}** — ${r.path} (${money(r.revenue)} now)`);
  if (!p.top_growth.length) L.push('- _No pages grew vs the prior window._');
  L.push('');
  L.push('## Revenue by cluster — where to push harder');
  L.push('');
  L.push('| Cluster | Revenue | Δ vs prior | Pages |');
  L.push('|---------|--------:|-----------:|------:|');
  for (const c of p.clusters) L.push(`| ${c.cluster} | ${money(c.revenue)} | ${delta(c.revenueDelta)} | ${c.pages} |`);
  L.push('');
  if (p.action_wins.length) {
    L.push('## Actions associated with a lift');
    L.push('');
    L.push('_Pages we published in-window that then saw a revenue or clicks lift (association, not proof)._');
    L.push('');
    for (const r of p.action_wins) L.push(`- ${r.path} — ${r.action.type} ${r.action.date}: ${delta(r.revenueDelta)} revenue, ${r.clicksDelta >= 0 ? '+' : ''}${r.clicksDelta} clicks`);
    L.push('');
  }
  if (p.not_converting.length) {
    L.push('## High organic traffic, $0 revenue — conversion opportunities');
    L.push('');
    L.push('_These pages pull organic visits but no sales — candidates for stronger product links / CTAs, or intent mismatch._');
    L.push('');
    for (const r of p.not_converting) L.push(`- ${r.path} — ${r.sessions} sessions, ${r.clicks} clicks, $0`);
    L.push('');
  }
  return L.join('\n');
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error('SEO impact agent failed:', err); process.exit(1); });
}
