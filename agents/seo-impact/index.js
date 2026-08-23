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
 * both sources must cover the identical range or the comparison is meaningless. Order
 * windows are PACIFIC calendar days (agents/shopify-collector's DST-correct helpers), the
 * same days the daily snapshots bucket by.
 *
 * The dashboard's 12-week `revenue_trend` is built from the same Shopify records, in
 * 7-Pacific-day buckets aligned to the window end, so its newest WINDOW/7 buckets sum
 * exactly to `organic_revenue`. It was GA4's modelled revenue until 2026-08-17 and
 * disagreed with the headline beside it four-fold ($58.50 vs $230.29 over 28 days).
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
import { fetchLandingPagesByChannel } from '../../lib/ga4.js';
import { getAllOrders } from '../../lib/shopify.js';
import { attributionRows, shopifyRevenueByPage, channelRollup } from '../../lib/order-attribution.js';
import { listAllSlugs, getPostMeta } from '../../lib/posts.js';
// ptDayOf/ptDayBounds are DST-correct Pacific day helpers owned by the shopify-collector
// (PR #510 fixed a real DST bug in them). Importing that agent is safe — its main() is
// behind a direct-invocation guard — and reusing them is what keeps this agent's windows
// on the same calendar days as the daily Shopify snapshots.
import { ptDayOf, ptDayBounds } from '../shopify-collector/index.js';
import {
  pathOf, organicSessionsByPage, isSearchEngineSource, mergeRevenueSources, buildPageImpacts,
  clusterRollup, residualRollup, actionWins, rankBy, weeklyRevenueTrend,
} from '../../lib/seo-impact.js';
import { clusterForText } from '../../lib/cluster-revenue.js';
import { isDirectRun } from '../../lib/is-direct-run.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const GSC_DIR = join(ROOT, 'data', 'snapshots', 'gsc');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'seo-impact');

const args = process.argv.slice(2);
const WINDOW = (() => { const i = args.indexOf('--window'); return i !== -1 ? parseInt(args[i + 1], 10) : 28; })();

// Weeks in the dashboard trend. 12 × 7 = an 84-day orders pull.
const TREND_WEEKS = 12;
// Orders come through getAllOrders(), which cursor-paginates and reports its own
// `truncated` flag. A silent truncation would understate revenue with no symptom at
// all, so that flag is propagated into revenue_trend_meta rather than swallowed.

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
// The cluster taxonomy lives in lib/cluster-revenue.js so that everything acting
// on these revenue numbers buckets pages the same way this report did.
const clusterFor = clusterForText;

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

// ── Shopify orders → attribution records over a PT date range ──────────────────
// getAllOrders() interpolates its arguments straight into created_at_min/max. A bare
// YYYY-MM-DD as created_at_max means that day's MIDNIGHT, which silently drops the whole
// last day of the window — so pass explicit day bounds. They are PACIFIC bounds, from
// the shopify-collector's DST-correct helpers, so a window here covers exactly the same
// calendar days the daily snapshots do, and so the headline and the weekly trend below
// can be reconciled order-for-order instead of approximately.
let ordersTruncated = false;
async function fetchOrderRows({ start, end }) {
  const res = await getAllOrders(ptDayBounds(start).dayStart, ptDayBounds(end).dayEnd);
  const rawOrders = res.orders || [];
  const fetched = rawOrders.length;
  if (res.truncated) {
    ordersTruncated = true;
    console.error(`  WARNING: getAllOrders() hit its page ceiling for ${start} → ${end} after ${fetched} orders. Revenue for this range is TRUNCATED.`);
  }
  return { rows: attributionRows(rawOrders), fetched };
}

async function shopifyOrganic({ start, end }) {
  const { rows, fetched } = await fetchOrderRows({ start, end });
  const real = rows.filter((r) => r.countsAsRevenue);
  return {
    byPage: shopifyRevenueByPage(rows, { channels: ['organic-search'] }),
    channels: channelRollup(rows),
    fetched,
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
  // What the cluster table drops on the floor. Reported explicitly so the table
  // can be read as what it is — a partial view of organic entry-page revenue —
  // rather than as a category P&L that mysteriously fails to add up.
  const clusterResidual = residualRollup(impacts, clusterFor);
  const wins = rankBy(actionWins(impacts), 'revenueDelta', 10);
  // High organic traffic that isn't converting — content driving visits, not sales.
  const notConverting = rankBy(
    impacts.filter(i => i.sessions >= 30 && i.revenue === 0), 'sessions', 10,
  );

  // Weekly revenue trend (last 12 weeks) for the dashboard chart — SHOPIFY ORDERS,
  // the same records as the headline above. It used to be GA4's modelled organic
  // revenue, which reported $58.50 for a 28-day window Shopify measured at $230.29;
  // two contradictory revenue numbers on one screen is worse than either bug alone.
  //
  // The series is ORGANIC SEARCH, matching `organic_revenue`, with all-channel revenue
  // carried alongside as context (this store's organic share swings a lot week to week,
  // and an organic-only chart read as "the store" is the same misreading in a new place).
  // Buckets are 7 Pacific days ending on the window end, so the last WINDOW/7 of them
  // sum exactly to the headline — see weeklyRevenueTrend() for why not calendar weeks.
  let revenueTrend = [];
  let trendWindow = null;
  try {
    const trendEnd = w.current.end;
    const trendStart = ymd(Date.parse(trendEnd) - (TREND_WEEKS * 7 - 1) * DAY);
    const { rows: trendRows, fetched } = await fetchOrderRows({ start: trendStart, end: trendEnd });
    revenueTrend = weeklyRevenueTrend(trendRows, {
      endDate: trendEnd, weeks: TREND_WEEKS, dayOf: ptDayOf, channels: ['organic-search'],
    });
    trendWindow = { start: trendStart, end: trendEnd };
    console.log(`  Trend: ${TREND_WEEKS} weeks from ${fetched} Shopify orders (${trendStart} → ${trendEnd} PT)`);
  } catch (err) {
    console.error('  Trend build failed (non-fatal):', err.message);
  }

  // Reconciliation: the trend's newest WINDOW/7 buckets ARE the headline window, so they
  // must sum to organic_revenue to the cent. Checked out loud every run — an assertion
  // nobody reads is how the GA4 series drifted four-fold without anyone noticing.
  let trendTiesOut = null;
  if (revenueTrend.length && WINDOW % 7 === 0 && WINDOW / 7 <= TREND_WEEKS) {
    const tail = revenueTrend.slice(-(WINDOW / 7));
    const tailRevenue = round2(tail.reduce((s, b) => s + b.revenue, 0));
    const tailOrders = tail.reduce((s, b) => s + b.orders, 0);
    trendTiesOut = tailRevenue === organicRevenue;
    console.log(`  Trend reconciliation: last ${WINDOW / 7} weeks = $${tailRevenue} / ${tailOrders} orders vs headline $${organicRevenue} / ${organicConversions} orders — ${trendTiesOut ? 'TIES OUT' : 'MISMATCH'}`);
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
    cluster_residual: clusterResidual,
    action_wins: wins,
    not_converting: notConverting,
    revenue_trend: revenueTrend,
    // Everything a reader needs to know what the chart's bars actually mean. The bug
    // this replaced was an UNLABELLED number that meant something other than assumed.
    revenue_trend_meta: {
      source: 'shopify-orders',
      channel: 'organic-search',
      weeks: TREND_WEEKS,
      window: trendWindow,
      timezone: 'America/Los_Angeles',
      bucket: 'weeks of 7 Pacific days, each ending on week_end; the newest ends on the report window end',
      ties_out: trendTiesOut,          // null when the window is not a whole number of weeks
      truncated: ordersTruncated,      // getAllOrders() hit its page ceiling — figures understated
    },
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

// Exported so the cluster table — including the residual row that makes it
// legible — is testable without a live GA4/Shopify/GSC run.
export function buildReport(p) {
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
  L.push(...revenueTrendSection(p));
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
  L.push('## Entry-page organic revenue by cluster');
  L.push('');
  L.push('_Organic-search-only revenue over this window, credited to the page the session LANDED on and bucketed'
    + ' by a word in that URL. **This is not product revenue and it is not a category\'s sales.** It reconciles to'
    + ' `totals.organic_revenue` and to nothing else — the residual row below is the rest of it._');
  L.push('');
  L.push('| Cluster | Entry-page organic $ | Δ vs prior | Clicks | Pages |');
  L.push('|---------|--------:|-----------:|-------:|------:|');
  for (const c of p.clusters) L.push(`| ${c.cluster} | ${money(c.entry_page_organic_revenue ?? c.revenue)} | ${delta(c.revenueDelta)} | ${c.clicks || 0} | ${c.pages} |`);
  if (p.cluster_residual) {
    const r = p.cluster_residual;
    L.push(`| _${r.label}_ | ${money(r.entry_page_organic_revenue)} | ${delta(r.revenueDelta)} | ${r.clicks || 0} | ${r.pages} |`);
  }
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

/** The weekly trend, spelled out so the chart's bars can never be read as something else. */
function revenueTrendSection(p) {
  const trend = p.revenue_trend || [];
  const meta = p.revenue_trend_meta || {};
  if (!trend.length) return [];
  const money = (n) => `$${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;
  const days = Math.round((Date.parse(p.window.end) - Date.parse(p.window.start)) / 86400000) + 1;
  const tieOut = days % 7 === 0 && days / 7 <= trend.length
    ? `the newest week ends on the window end, so the last ${days / 7} weeks sum to the headline exactly`
    : `the newest week ends on the window end (the ${days}-day window is not a whole number of weeks, so no run of weeks reproduces the headline exactly)`;
  const L = [];
  L.push(`## Weekly organic-search revenue — last ${trend.length} weeks`);
  L.push('');
  L.push(`_Shopify orders, **organic search only** (the same figure as the headline above), with all-channel revenue as context. Each week is 7 Pacific calendar days ending on the date shown; ${tieOut}._`);
  L.push('');
  L.push('| Week ending | Organic revenue | Organic orders | All channels |');
  L.push('|-------------|----------------:|---------------:|-------------:|');
  for (const b of trend) {
    L.push(`| ${b.week_end} | ${money(b.revenue)} | ${b.orders} | ${money(b.revenue_all_channels)} |`);
  }
  L.push('');
  if (meta.ties_out === false) {
    L.push('> **The trend does not reconcile with the headline.** The newest weeks should sum to organic revenue exactly; they do not. Treat both numbers as suspect until this is explained.');
    L.push('');
  }
  if (meta.truncated) {
    L.push('> **Truncated:** a Shopify orders page hit the un-paginated 250-order cap. Revenue here is understated.');
    L.push('');
  }
  return L;
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

// The one tested predicate (CLAUDE.md: four hand-rolled spellings had accumulated
// and two audit passes miscounted which agents were guarded as a result).
if (isDirectRun(import.meta.url)) {
  main().catch((err) => { console.error('SEO impact agent failed:', err); process.exit(1); });
}
