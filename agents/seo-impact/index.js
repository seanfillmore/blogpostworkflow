#!/usr/bin/env node
/**
 * SEO Impact Agent — "what's actually working?"
 *
 * The analysis/feedback layer. Most agents in this repo *fire* (publish, refresh,
 * optimize); this one closes the loop by measuring outcomes. It joins, by landing
 * page over a trailing window:
 *
 *   - Shopify per-order revenue / orders per landing page            (the OUTCOME)
 *   - GA4 organic sessions per landing page                          (the TRAFFIC)
 *   - GSC clicks / impressions per page                              (the VISIBILITY)
 *   - posts published in the window                                  (the ACTION, best-effort)
 *
 * and reports: which pages/clusters earn organic revenue, which are growing vs the
 * prior window, which high-traffic pages aren't converting, and where to push harder.
 *
 * REVENUE SOURCE IS SHOPIFY, not GA4. Shopify stamps every order with `landing_site`
 * (the exact entry page) and `referring_site`, so revenue and order counts here are
 * measured, not modelled — see lib/order-attribution.js for the channel classifier and
 * the two traps it encodes (srsltid-without-gclid is a FREE listing; `sag_organic` is
 * paid). GA4 is still queried, for two reasons: it is the only source of SESSIONS, which
 * is what makes "high traffic, $0 revenue" detectable, and its modelled organic revenue
 * is carried alongside as `revenueGa4` so the report quantifies the gap between the two.
 * GA4's `conversions` are key events, not purchases; Shopify's are real orders.
 *
 * The window still ends 2 days back — GA4 monetization data needs that to finalize, and
 * both sources must cover the identical range or the comparison is meaningless.
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
import { getOrders } from '../../lib/shopify.js';
import { attributionRows, shopifyRevenueByPage, channelRollup } from '../../lib/order-attribution.js';
import { listAllSlugs, getPostMeta } from '../../lib/posts.js';
import {
  pathOf, organicByPage, mergeRevenueSources, buildPageImpacts, clusterRollup, actionWins, rankBy,
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

// ── Shopify orders → organic revenue per landing page (GROUND TRUTH) ───────────
// getOrders() interpolates its arguments straight into created_at_min/max. A bare
// YYYY-MM-DD as created_at_max means that day's MIDNIGHT, which silently drops the whole
// last day of the window — so pass an explicit end-of-day instant.
async function shopifyOrganic({ start, end }) {
  const { rawOrders } = await getOrders(`${start}T00:00:00Z`, `${end}T23:59:59Z`);
  const rows = attributionRows(rawOrders || []);
  const real = rows.filter((r) => r.countsAsRevenue);
  return {
    byPage: shopifyRevenueByPage(rows, { channels: ['organic-search'] }),
    channels: channelRollup(rows),
    fetched: (rawOrders || []).length,
    orders: real.length,
    revenueAll: round2(real.reduce((s, r) => s + r.total, 0)),
  };
}

async function main() {
  console.log('\nSEO Impact Agent\n');
  const w = windows(WINDOW);
  console.log(`  Window:  ${w.current.start} → ${w.current.end} (${WINDOW}d)`);
  console.log(`  Compare: ${w.prior.start} → ${w.prior.end}`);

  // GA4 — sessions per landing page (and its modelled revenue, for comparison only)
  let curRows, priorRows;
  try {
    curRows = await fetchLandingPagesByChannel(w.current.start, w.current.end);
    priorRows = await fetchLandingPagesByChannel(w.prior.start, w.prior.end);
  } catch (err) {
    console.error('  GA4 query failed:', err.message);
    process.exit(1);
  }
  const ga4Current = organicByPage(curRows);
  const ga4Prior = organicByPage(priorRows);
  console.log(`  GA4 organic landing pages: ${ga4Current.size} (current), ${ga4Prior.size} (prior)`);

  // Shopify — per-order revenue per landing page. This is the revenue source of truth,
  // so a failure here is fatal: without it the report has no dollars to report.
  let shopCur, shopPrior;
  try {
    shopCur = await shopifyOrganic(w.current);
    shopPrior = await shopifyOrganic(w.prior);
  } catch (err) {
    console.error('  Shopify orders query failed:', err.message);
    process.exit(1);
  }
  console.log(`  Shopify orders: ${shopCur.orders} in window ($${shopCur.revenueAll} all channels), ${shopPrior.orders} prior`);
  console.log(`  Organic-search orders: ${[...shopCur.byPage.values()].reduce((s, v) => s + v.conversions, 0)} across ${shopCur.byPage.size} landing pages`);

  // Shopify revenue + GA4 sessions, joined per page. NOT a swap — see mergeRevenueSources.
  const current = mergeRevenueSources(ga4Current, shopCur.byPage);
  const prior = mergeRevenueSources(ga4Prior, shopPrior.byPage);

  const gscCurrent = gscByPath(w.current);
  const gscPrior = gscByPath(w.prior);
  const actions = actionsByPath(w.current);

  const impacts = buildPageImpacts({ current, prior, gscCurrent, gscPrior, actionsByPath: actions });

  // Aggregates. organic_revenue / organic_conversions are SHOPIFY (orders, dollars);
  // the *_ga4 pair is GA4's modelled figure kept beside it so the gap is visible.
  const sum = (m, k) => round2([...m.values()].reduce((s, v) => s + (v[k] || 0), 0));
  const organicRevenue = sum(current, 'revenue');
  const organicRevenuePrev = sum(prior, 'revenue');
  const organicConversions = [...current.values()].reduce((s, v) => s + v.conversions, 0);
  const ga4Revenue = sum(current, 'revenueGa4');
  const ga4RevenuePrev = sum(prior, 'revenueGa4');
  const ga4Conversions = [...current.values()].reduce((s, v) => s + (v.conversionsGa4 || 0), 0);
  // Signed: positive means GA4 overstated organic revenue vs the orders Shopify recorded.
  const ga4Gap = round2(ga4Revenue - organicRevenue);
  const ga4GapPct = organicRevenue > 0 ? Math.round((ga4Gap / organicRevenue) * 1000) / 10 : null;

  const topRevenue = rankBy(impacts.filter(i => i.revenue > 0), 'revenue', 10);
  const topGrowth = rankBy(impacts.filter(i => i.revenueDelta > 0), 'revenueDelta', 10);
  const clusters = clusterRollup(impacts, clusterFor);
  const wins = rankBy(actionWins(impacts), 'revenueDelta', 10);
  // High organic traffic that isn't converting — content driving visits, not sales.
  const notConverting = rankBy(
    impacts.filter(i => i.sessions >= 30 && i.revenue === 0), 'sessions', 10,
  );
  // Pages GA4 credited with organic revenue where Shopify recorded no organic order at
  // all. This is the concrete, per-page evidence of how the modelled number goes wrong.
  const ga4Phantom = rankBy(
    impacts.filter(i => i.revenue === 0 && (i.revenueGa4 || 0) > 0), 'revenueGa4', 10,
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

  console.log(`\n  Organic revenue (Shopify): $${organicRevenue} (prior $${organicRevenuePrev}, ${organicRevenue >= organicRevenuePrev ? '+' : ''}$${round2(organicRevenue - organicRevenuePrev)}) from ${organicConversions} orders`);
  console.log(`  Organic revenue (GA4, modelled): $${ga4Revenue} — gap ${ga4Gap >= 0 ? '+' : ''}$${ga4Gap}${ga4GapPct === null ? '' : ` (${ga4Gap >= 0 ? '+' : ''}${ga4GapPct}%)`}`);
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
    revenue_source: 'shopify-orders',
    totals: {
      // Shopify — ground truth. Field names unchanged so existing consumers keep working.
      organic_revenue: organicRevenue,
      organic_revenue_prev: organicRevenuePrev,
      organic_revenue_delta: round2(organicRevenue - organicRevenuePrev),
      organic_conversions: organicConversions,      // real Shopify orders, not key events
      // GA4 — modelled, comparison only.
      organic_revenue_ga4: ga4Revenue,
      organic_revenue_ga4_prev: ga4RevenuePrev,
      organic_conversions_ga4: ga4Conversions,      // GA4 key events, NOT purchases
      ga4_gap: ga4Gap,
      ga4_gap_pct: ga4GapPct,
      // All-channel Shopify totals, so organic can be read as a share of the store.
      shopify_orders_all_channels: shopCur.orders,
      shopify_revenue_all_channels: shopCur.revenueAll,
    },
    channel_mix: shopCur.channels,
    top_revenue: topRevenue,
    top_growth: topGrowth,
    clusters,
    action_wins: wins,
    not_converting: notConverting,
    ga4_phantom_revenue: ga4Phantom,
    revenue_trend: revenueTrend,
  };
  writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify(payload, null, 2));
  writeFileSync(join(REPORTS_DIR, `${ymd(Date.now())}.md`), buildReport(payload));
  console.log(`\n  Report saved: data/reports/seo-impact/${ymd(Date.now())}.md`);

  await notify({
    subject: `SEO Impact: $${organicRevenue} organic revenue, ${organicConversions} orders (${organicRevenue >= organicRevenuePrev ? '+' : ''}$${round2(organicRevenue - organicRevenuePrev)} vs prior ${WINDOW}d)`,
    body: `Revenue is Shopify per-order (landing_site), not GA4. GA4 modelled the same window at $${ga4Revenue} — a gap of ${ga4Gap >= 0 ? '+' : ''}$${ga4Gap}.\n\nTop organic-revenue pages:\n${topRevenue.slice(0, 5).map(p => `  $${p.revenue} — ${p.path}`).join('\n')}\n\nTop clusters:\n${clusters.slice(0, 4).map(c => `  $${c.revenue} — ${c.cluster}`).join('\n')}`,
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
  L.push(`**Organic revenue:** ${money(p.totals.organic_revenue)} (${delta(p.totals.organic_revenue_delta)} vs prior) · ${p.totals.organic_conversions} Shopify orders`);
  L.push('');
  L.push('_Revenue and order counts are **Shopify per-order ground truth**: every order carries the exact entry page (`landing_site`) and referrer, and an order counts as organic only when the referrer is an unpaid search engine and no click id is present. Sessions come from GA4 (Shopify has no sessions); clicks from Search Console._');
  L.push('');
  L.push(...ga4ComparisonSection(p));
  L.push('## Top organic-revenue pages');
  L.push('');
  L.push('| Page | Revenue | Δ vs prior | Orders | GA4 said | Sessions | Clicks Δ | Action |');
  L.push('|------|--------:|-----------:|-------:|---------:|---------:|---------:|--------|');
  for (const r of p.top_revenue) {
    L.push(`| ${r.path} | ${money(r.revenue)} | ${delta(r.revenueDelta)} | ${r.conversions} | ${money(r.revenueGa4 || 0)} | ${r.sessions} | ${r.clicksDelta >= 0 ? '+' : ''}${r.clicksDelta} | ${r.action ? r.action.type + ' ' + r.action.date : '—'} |`);
  }
  if (!p.top_revenue.length) L.push('| _no organic-search orders in this window_ | — | — | — | — | — | — | — |');
  L.push('');
  L.push(...ga4OnlySection(p));
  L.push('## Fastest-growing (revenue Δ vs prior window)');
  L.push('');
  for (const r of p.top_growth) L.push(`- **${delta(r.revenueDelta)}** — ${r.path} (${money(r.revenue)} now)`);
  if (!p.top_growth.length) L.push('- _No pages grew vs the prior window._');
  L.push('');
  L.push('## Revenue by cluster — where to push harder');
  L.push('');
  L.push('| Cluster | Revenue | Δ vs prior | GA4 said | Pages |');
  L.push('|---------|--------:|-----------:|---------:|------:|');
  for (const c of p.clusters) L.push(`| ${c.cluster} | ${money(c.revenue)} | ${delta(c.revenueDelta)} | ${money(c.revenueGa4 || 0)} | ${c.pages} |`);
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

/**
 * Shopify vs GA4, side by side. The point of this release: this project has treated the
 * GA4 organic number as unreliable on instinct, and this section is where that stops
 * being instinct and becomes a measured figure.
 */
function ga4ComparisonSection(p) {
  const money = (n) => `$${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;
  const t = p.totals || {};
  const gap = t.ga4_gap || 0;
  const pct = t.ga4_gap_pct;
  const L = [];
  L.push('## Revenue source check — Shopify (truth) vs GA4 (modelled)');
  L.push('');
  L.push('| Source | Organic revenue | Prior window | Conversions |');
  L.push('|--------|----------------:|-------------:|------------:|');
  L.push(`| **Shopify orders** (source of truth) | ${money(t.organic_revenue)} | ${money(t.organic_revenue_prev)} | ${t.organic_conversions} orders |`);
  L.push(`| GA4 organic (modelled) | ${money(t.organic_revenue_ga4)} | ${money(t.organic_revenue_ga4_prev)} | ${t.organic_conversions_ga4} key events |`);
  L.push(`| **Gap** | ${gap >= 0 ? '+' : '−'}${money(Math.abs(gap))}${pct === null || pct === undefined ? '' : ` (${gap >= 0 ? '+' : ''}${pct}%)`} | | |`);
  L.push('');
  L.push(gap > 0
    ? `_GA4 **overstated** organic revenue by ${money(Math.abs(gap))} in this window._`
    : gap < 0
      ? `_GA4 **understated** organic revenue by ${money(Math.abs(gap))} in this window — likely organic orders it attributed elsewhere._`
      : '_The two sources agree in this window._');
  L.push('');
  L.push(`**Whole store this window (Shopify, all channels):** ${t.shopify_orders_all_channels} orders / ${money(t.shopify_revenue_all_channels)}. Organic search is ${t.shopify_revenue_all_channels > 0 ? Math.round((t.organic_revenue / t.shopify_revenue_all_channels) * 1000) / 10 : 0}% of it.`);
  L.push('');
  if ((p.channel_mix || []).length) {
    L.push('| Channel | Orders | Revenue |');
    L.push('|---------|-------:|--------:|');
    for (const c of p.channel_mix) L.push(`| ${c.channel} | ${c.orders} | ${money(c.revenue)} |`);
    L.push('');
  }
  return L;
}

/** Pages GA4 paid credit to that produced no organic order at all. */
function ga4OnlySection(p) {
  const rows = p.ga4_phantom_revenue || [];
  if (!rows.length) return [];
  const money = (n) => `$${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;
  const L = [];
  L.push('## GA4 credited these pages, Shopify recorded no organic order');
  L.push('');
  L.push('_Per-page evidence of where the modelled number diverges. Treat GA4 page-level organic revenue as directional at best._');
  L.push('');
  for (const r of rows) L.push(`- ${r.path} — GA4 ${money(r.revenueGa4)}, Shopify $0 (${r.sessions} sessions, ${r.clicks} clicks)`);
  L.push('');
  return L;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error('SEO impact agent failed:', err); process.exit(1); });
}
