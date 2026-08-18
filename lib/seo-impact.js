// lib/seo-impact.js
//
// Pure analysis core for the SEO impact / revenue-attribution layer. Joins four
// signals by landing-page path over a time window to answer "what's actually
// working?":
//   - Shopify per-order revenue/orders per landing page   (the OUTCOME — ground truth)
//   - GA4 organic SESSIONS per landing page               (the TRAFFIC — GA4's only job here)
//   - GSC clicks/impressions per page (the VISIBILITY that drives the outcome)
//   - the SEO action log (what we published/refreshed, and when)
//
// Everything here is pure and unit-tested; the agent does the I/O (Shopify orders,
// GA4/GSC queries, reading the action log) and feeds these functions.

// SEARCH_HOSTS is the ONE list of engines whose click is unpaid. It decides both
// whether an order counts as organic (order-attribution.js) and, here, whether a
// session does — two lists would drift and produce a page with organic dollars and
// zero organic sessions. This import closes a module cycle (order-attribution.js
// imports pathOf from this file), so SEARCH_HOSTS is only ever dereferenced INSIDE a
// function: touching it at module-evaluation time would hit the TDZ depending on which
// of the two modules the process happened to load first.
import { SEARCH_HOSTS } from './order-attribution.js';

/** Normalize a URL or path to a single join key: lowercase path, no trailing slash. */
export function pathOf(url) {
  if (!url) return null;
  let p = String(url).trim();
  if (!p) return null;
  // GA4 emits bucket labels where a page should be: `(not set)` when it could not
  // resolve a landing page, `(other)` when the report blew its cardinality limit.
  // Neither is a page, and `(not set)` was surfacing in the report's "high traffic,
  // $0 revenue" action list as though it were something to go and fix.
  if (/^\(.*\)$/.test(p)) return null;
  // strip origin if it's a full URL
  const m = p.match(/^https?:\/\/[^/]+(\/.*)?$/i);
  if (m) p = m[1] || '/';
  p = p.split(/[?#]/)[0].toLowerCase();
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}

// Tokens GA4 may report in `sessionSource` for a SEARCH_HOSTS engine: the bare host
// (`search.brave.com`) and the engine's own label (`brave`), since GA4 normalizes some
// sources to a name rather than a hostname. Built once, lazily — see the import note.
let searchSourceTokens = null;
function searchTokens() {
  if (searchSourceTokens) return searchSourceTokens;
  const t = new Set();
  for (const host of SEARCH_HOSTS) {
    t.add(host);
    const label = host.replace(/^(?:www|search)\./, '').split('.')[0];
    if (label) t.add(label);
  }
  searchSourceTokens = t;
  return t;
}

/** True when a GA4 `sessionSource` value names an unpaid search engine. */
export function isSearchEngineSource(source) {
  if (!source) return false;
  const s = String(source).trim().toLowerCase()
    .replace(/^[a-z]+:\/\//, '')   // in case GA4 hands back a full URL
    .replace(/[/?#].*$/, '')
    .replace(/^www\./, '');
  if (!s) return false;
  return searchTokens().has(s);
}

/**
 * True when a GA4 landingPage×channel×source row is an organic-search session.
 *
 * GA4's channel grouping only recognises the search engines Google keeps a list for.
 * Brave is not on it: `search.brave.com` arrives as channel `Referral`, so its sessions
 * were dropped here entirely while the matching Shopify order still counted as organic
 * revenue — a page with dollars and zero sessions, which breaks CVR and lets a page slip
 * past the "high traffic, $0 revenue" detector.
 *
 * Only `Referral` is rescued. A search host also appears as the source of PAID clicks
 * (`google` / Paid Search); widening this past Referral would relabel ad traffic organic.
 */
export function isOrganicSessionRow(row) {
  if (!row) return false;
  if (row.channel === 'Organic Search') return true;
  if (row.channel !== 'Referral') return false;
  return isSearchEngineSource(row.source);
}

/**
 * Aggregate GA4 landingPage×channel×source rows down to organic SESSIONS per page.
 *
 * Sessions are the whole of GA4's job in this pipeline. Revenue and conversions come
 * from Shopify orders (see mergeRevenueSources); GA4's modelled equivalents are not
 * read, not carried, and not reported.
 *
 * @param {Array<{page,channel,source,sessions}>} rows
 * @returns {Map<string,{sessions:number}>} keyed by normalized path
 */
export function organicSessionsByPage(rows) {
  const m = new Map();
  for (const r of rows || []) {
    if (!isOrganicSessionRow(r)) continue;
    const key = pathOf(r.page);
    if (!key) continue;
    const cur = m.get(key) || { sessions: 0 };
    cur.sessions += r.sessions || 0;
    m.set(key, cur);
  }
  return m;
}

/**
 * Merge the two revenue sources into ONE per-page map for buildPageImpacts().
 *
 * Division of labour, and why it is not a straight swap:
 *   - `revenue` / `conversions` come from SHOPIFY. Shopify stamps every order with the
 *     exact entry page (`landing_site`), so this is measured, not modelled.
 *   - `sessions` come from GA4. Shopify has no concept of a session, and sessions are
 *     what make "high traffic, $0 revenue" detectable — drop them and the agent loses
 *     its only view of a page that pulls visits without selling anything.
 *
 * GA4's own revenue and key-event counts are not carried. They were, for one release, so
 * the gap could be measured; it was measured (GA4 understated 28d organic revenue by 71%,
 * $71.50 vs $249.28) and the question is settled.
 *
 * A page present in only one source still appears, with zeros from the other.
 *
 * @param {Map<string,{sessions}>} ga4Map from organicSessionsByPage()
 * @param {Map<string,{sessions,conversions,revenue}>} shopifyMap from shopifyRevenueByPage()
 * @returns {Map<string,{sessions,conversions,revenue}>}
 */
export function mergeRevenueSources(ga4Map, shopifyMap) {
  const g4 = ga4Map || new Map();
  const sh = shopifyMap || new Map();
  const out = new Map();
  for (const path of new Set([...g4.keys(), ...sh.keys()])) {
    const g = g4.get(path) || { sessions: 0 };
    const s = sh.get(path) || { conversions: 0, revenue: 0 };
    out.set(path, {
      sessions: g.sessions || 0,            // GA4 owns traffic
      conversions: s.conversions || 0,      // Shopify owns orders
      revenue: round2(s.revenue),           // Shopify owns dollars — source of truth
    });
  }
  return out;
}

/**
 * Merge current + prior per-page maps, GSC clicks maps, and the action log into
 * one record per page with window deltas.
 */
export function buildPageImpacts({ current, prior, gscCurrent, gscPrior, actionsByPath } = {}) {
  const cur = current || new Map();
  const prev = prior || new Map();
  const gc = gscCurrent || new Map();
  const gp = gscPrior || new Map();
  const actions = actionsByPath || new Map();

  const paths = new Set([...cur.keys(), ...prev.keys()]);
  const impacts = [];
  for (const path of paths) {
    const c = cur.get(path) || { sessions: 0, conversions: 0, revenue: 0 };
    const p = prev.get(path) || { sessions: 0, conversions: 0, revenue: 0 };
    const gCur = gc.get(path) || { clicks: 0, impressions: 0 };
    const gPrev = gp.get(path) || { clicks: 0, impressions: 0 };
    impacts.push({
      path,
      revenue: round2(c.revenue),
      revenuePrev: round2(p.revenue),
      revenueDelta: round2(c.revenue - p.revenue),
      conversions: c.conversions,
      sessions: c.sessions,
      sessionsPrev: p.sessions,
      clicks: gCur.clicks,
      clicksPrev: gPrev.clicks,
      clicksDelta: gCur.clicks - gPrev.clicks,
      impressions: gCur.impressions,
      action: actions.get(path) || null,
    });
  }
  return impacts;
}

/** Pages where an SEO action was taken AND a lift followed (revenue or clicks). */
export function actionWins(impacts) {
  return (impacts || []).filter(
    (i) => i.action && ((i.revenueDelta || 0) > 0 || (i.clicksDelta || 0) > 0),
  );
}

/** Aggregate impacts into clusters via a clusterFor(path)=>name|null mapping. */
export function clusterRollup(impacts, clusterFor) {
  const m = new Map();
  for (const i of impacts || []) {
    const cluster = clusterFor(i.path);
    if (!cluster) continue;
    const cur = m.get(cluster)
      || { cluster, revenue: 0, revenuePrev: 0, clicks: 0, pages: 0 };
    cur.revenue += i.revenue || 0;
    cur.revenuePrev += i.revenuePrev || 0;
    cur.clicks += i.clicks || 0;
    cur.pages += 1;
    m.set(cluster, cur);
  }
  const out = [...m.values()].map((c) => ({
    ...c,
    revenue: round2(c.revenue),
    revenuePrev: round2(c.revenuePrev),
    revenueDelta: round2(c.revenue - c.revenuePrev),
  }));
  return out.sort((a, b) => b.revenue - a.revenue);
}

/**
 * Weekly revenue buckets from Shopify attribution records — the dashboard trend.
 *
 * This used to be GA4's modelled organic revenue, and it disagreed with the headline
 * it sat next to by a factor of four ($58.50 modelled vs $230.29 measured over the same
 * 28 days). Two revenue numbers contradicting each other on one screen is worse than
 * the bug that produced either, so the series is now built from the SAME records as the
 * headline: `attributionRows()` output, filtered by `countsAsRevenue`.
 *
 * BUCKET CONVENTION — weeks are ALIGNED TO THE WINDOW END, not to calendar Sundays.
 * Bucket k covers the 7 Pacific calendar days ending on `endDate - (weeks-1-k)*7`, so
 * the newest bucket ends exactly on `endDate` (the report window's last day). That
 * alignment is the whole point: it makes the last `WINDOW/7` buckets sum EXACTLY to the
 * headline figure for any window that is a multiple of 7 days. Calendar-Sunday weeks
 * would straddle both edges of the window and leave a residual nobody could explain,
 * which is the class of bug being fixed here.
 *
 * Days are Pacific calendar days, resolved by the injected `dayOf` — pass
 * `ptDayOf` from agents/shopify-collector, which is DST-correct and is what the daily
 * snapshots bucket by. It is injected rather than imported so this module stays pure and
 * free of an agent dependency; there is deliberately no UTC default, because a silent
 * fallback to UTC days is exactly how a timezone bug hides.
 *
 * Each bucket reports the selected channels AND all channels, so the chart can show
 * organic as the series with whole-store revenue as context.
 *
 * @param {Array<object>} rows attribution records from attributionRows()
 * @param {{endDate:string, weeks?:number, dayOf:function, channels?:string[]|null}} opts
 * @returns {Array<{week,week_end,revenue,orders,revenue_all_channels,orders_all_channels}>}
 */
export function weeklyRevenueTrend(rows, { endDate, weeks = 12, dayOf, channels = ['organic-search'] } = {}) {
  if (typeof dayOf !== 'function') {
    throw new TypeError('weeklyRevenueTrend: dayOf(instant) => "YYYY-MM-DD" is required (pass ptDayOf)');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(endDate || ''))) {
    throw new TypeError(`weeklyRevenueTrend: endDate must be YYYY-MM-DD, got: ${endDate}`);
  }
  const n = Math.max(1, Math.floor(weeks));
  const allow = channels === null ? null : new Set(channels);

  // Date arithmetic only — these strings never bucket an instant, dayOf() does that.
  const DAY_MS = 86400000;
  const asDay = (ms) => new Date(ms).toISOString().slice(0, 10);
  const endMs = Date.parse(`${endDate}T00:00:00Z`);

  const buckets = [];
  const dayToBucket = new Map();
  for (let k = 0; k < n; k++) {
    const bucketEndMs = endMs - (n - 1 - k) * 7 * DAY_MS;
    const bucketStartMs = bucketEndMs - 6 * DAY_MS;
    buckets.push({
      week: asDay(bucketStartMs),
      week_end: asDay(bucketEndMs),
      revenue: 0,
      orders: 0,
      revenue_all_channels: 0,
      orders_all_channels: 0,
    });
    for (let d = 0; d < 7; d++) dayToBucket.set(asDay(bucketStartMs + d * DAY_MS), k);
  }

  for (const r of rows || []) {
    if (!r?.countsAsRevenue) continue;
    const day = dayOf(r.created_at);
    const k = day == null ? undefined : dayToBucket.get(day);
    if (k === undefined) continue;               // order falls outside the trend range
    const b = buckets[k];
    b.revenue_all_channels += r.total || 0;
    b.orders_all_channels += 1;
    if (allow && !allow.has(r.channel)) continue;
    b.revenue += r.total || 0;
    b.orders += 1;
  }

  for (const b of buckets) {
    b.revenue = round2(b.revenue);
    b.revenue_all_channels = round2(b.revenue_all_channels);
  }
  return buckets;
}

/** Sort a copy of rows descending by numeric key, optionally capped at limit. */
export function rankBy(rows, key, limit) {
  const sorted = [...(rows || [])].sort((a, b) => (b[key] || 0) - (a[key] || 0));
  return limit ? sorted.slice(0, limit) : sorted;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
