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
 * paid). GA4 is queried for ONE thing: SESSIONS, which is what makes "high traffic,
 * $0 revenue" detectable. Its modelled revenue and key-event counts are not read — the
 * gap was measured for one release (GA4 understated 28d organic revenue by 71%) and the
 * question is closed.
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
  pathOf, organicSessionsByPage, isSearchEngineSource, mergeRevenueSources, buildPageImpacts,
  clusterRollup, actionWins, rankBy,
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

  // GA4 — organic sessions per landing page. Sessions only; dollars come from Shopify.
  let curRows, priorRows;
  try {
    curRows = await fetchLandingPagesByChannel(w.current.start, w.current.end);
    priorRows = await fetchLandingPagesByChannel(w.prior.start, w.prior.end);
  } catch (err) {
    console.error('  GA4 query failed:', err.message);
    process.exit(1);
  }
  const ga4Current = organicSessionsByPage(curRows);
  const ga4Prior = organicSessionsByPage(priorRows);
  console.log(`  GA4 organic landing pages: ${ga4Current.size} (current), ${ga4Prior.size} (prior)`);
  // Sessions GA4 filed as Referral that are actually unpaid search (Brave, and anything
  // else off Google's list). Logged because it is the whole point of the source dimension.
  const rescued = (curRows || [])
    .filter((r) => r.channel === 'Referral' && isSearchEngineSource(r.source))
    .reduce((acc, r) => { acc.sessions += r.sessions || 0; acc.sources.add(r.source); return acc; },
      { sessions: 0, sources: new Set() });
  if (rescued.sessions) {
    console.log(`  Rescued from GA4 "Referral": ${rescued.sessions} organic sessions from ${[...rescued.sources].join(', ')}`);
  }

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

  // Aggregates. Every dollar and every order here is SHOPIFY; only sessions are GA4.
  const sum = (m, k) => round2([...m.values()].reduce((s, v) => s + (v[k] || 0), 0));
  const organicRevenue = sum(current, 'revenue');
  const organicRevenuePrev = sum(prior, 'revenue');
  const organicConversions = [...current.values()].reduce((s, v) => s + v.conversions, 0);
  const organicSessions = [...current.values()].reduce((s, v) => s + (v.sessions || 0), 0);

  const topRevenue = rankBy(impacts.filter(i => i.revenue > 0), 'revenue', 10);
  const topGrowth = rankBy(impacts.filter(i => i.revenueDelta > 0), 'revenueDelta', 10);
  const clusters = clusterRollup(impacts, clusterFor);
  const wins = rankBy(actionWins(impacts), 'revenueDelta', 10);
  // High organic traffic that isn't converting — content driving visits, not sales.
  const notConverting = rankBy(
    impacts.filter(i => i.sessions >= 30 && i.revenue === 0), 'sessions', 10,
  );

  // Weekly organic-revenue trend (last 12 weeks) for the dashboard chart.
  //
  // NOTE: this series is still GA4's MODELLED revenue — the only figure in this agent
  // that is. It is a shape, not a total, and it will not tie out to organic_revenue
  // above (measured here at $230.29 against GA4's $58.50 for the same 28 days). Rebuilding
  // it from Shopify orders needs an 84-day getOrders() pull and is the obvious next step.
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
  console.log(`  Organic sessions (GA4): ${organicSessions}`);
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
      // GA4 — sessions only, the one thing Shopify cannot supply.
      organic_sessions: organicSessions,
      organic_sessions_rescued: rescued.sessions,   // filed Referral by GA4, really search
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
    revenue_trend: revenueTrend,
  };
  writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify(payload, null, 2));
  writeFileSync(join(REPORTS_DIR, `${ymd(Date.now())}.md`), buildReport(payload));
  console.log(`\n  Report saved: data/reports/seo-impact/${ymd(Date.now())}.md`);

  await notify({
    subject: `SEO Impact: $${organicRevenue} organic revenue, ${organicConversions} orders (${organicRevenue >= organicRevenuePrev ? '+' : ''}$${round2(organicRevenue - organicRevenuePrev)} vs prior ${WINDOW}d)`,
    body: `Revenue is Shopify per-order (landing_site), not GA4; GA4 supplies sessions only (${organicSessions} organic sessions this window).\n\nTop organic-revenue pages:\n${topRevenue.slice(0, 5).map(p => `  $${p.revenue} — ${p.path}`).join('\n')}\n\nTop clusters:\n${clusters.slice(0, 4).map(c => `  $${c.revenue} — ${c.cluster}`).join('\n')}`,
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
  L.push(...storeContextSection(p));
  L.push('## Top organic-revenue pages');
  L.push('');
  L.push('| Page | Revenue | Δ vs prior | Orders | Sessions | Clicks Δ | Action |');
  L.push('|------|--------:|-----------:|-------:|---------:|---------:|--------|');
  for (const r of p.top_revenue) {
    L.push(`| ${r.path} | ${money(r.revenue)} | ${delta(r.revenueDelta)} | ${r.conversions} | ${r.sessions} | ${r.clicksDelta >= 0 ? '+' : ''}${r.clicksDelta} | ${r.action ? r.action.type + ' ' + r.action.date : '—'} |`);
  }
  if (!p.top_revenue.length) L.push('| _no organic-search orders in this window_ | — | — | — | — | — | — |');
  L.push('');
  L.push('## Fastest-growing (revenue Δ vs prior window)');
  L.push('');
  for (const r of p.top_growth) L.push(`- **${delta(r.revenueDelta)}** — ${r.path} (${money(r.revenue)} now)`);
  if (!p.top_growth.length) L.push('- _No pages grew vs the prior window._');
  L.push('');
  L.push('## Revenue by cluster — where to push harder');
  L.push('');
  L.push('| Cluster | Revenue | Δ vs prior | Clicks | Pages |');
  L.push('|---------|--------:|-----------:|-------:|------:|');
  for (const c of p.clusters) L.push(`| ${c.cluster} | ${money(c.revenue)} | ${delta(c.revenueDelta)} | ${c.clicks || 0} | ${c.pages} |`);
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

/** Organic search read as a share of the whole store, plus the full channel mix. */
function storeContextSection(p) {
  const money = (n) => `$${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;
  const t = p.totals || {};
  const L = [];
  L.push('## Organic search in context');
  L.push('');
  L.push(`**Whole store this window (Shopify, all channels):** ${t.shopify_orders_all_channels} orders / ${money(t.shopify_revenue_all_channels)}. Organic search is ${t.shopify_revenue_all_channels > 0 ? Math.round((t.organic_revenue / t.shopify_revenue_all_channels) * 1000) / 10 : 0}% of it, on ${t.organic_sessions || 0} organic sessions.`);
  if (t.organic_sessions_rescued) {
    L.push('');
    L.push(`_${t.organic_sessions_rescued} of those sessions came from search engines GA4 files as "Referral" (Brave and friends are not on Google's channel list). They are counted here off the same host list that decides an order was organic._`);
  }
  L.push('');
  if ((p.channel_mix || []).length) {
    L.push('| Channel | Orders | Revenue |');
    L.push('|---------|-------:|--------:|');
    for (const c of p.channel_mix) L.push(`| ${c.channel} | ${c.orders} | ${money(c.revenue)} |`);
    L.push('');
  }
  return L;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error('SEO impact agent failed:', err); process.exit(1); });
}
