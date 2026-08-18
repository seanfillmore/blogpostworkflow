// lib/seo-impact.js
//
// Pure analysis core for the SEO impact / revenue-attribution layer. Joins four
// signals by landing-page path over a time window to answer "what's actually
// working?":
//   - Shopify per-order revenue/orders per landing page   (the OUTCOME — ground truth)
//   - GA4 organic SESSIONS per landing page               (the TRAFFIC; GA4 revenue is
//     carried alongside as `revenueGa4` for comparison only)
//   - GSC clicks/impressions per page (the VISIBILITY that drives the outcome)
//   - the SEO action log (what we published/refreshed, and when)
//
// Everything here is pure and unit-tested; the agent does the I/O (Shopify orders,
// GA4/GSC queries, reading the action log) and feeds these functions.

/** Normalize a URL or path to a single join key: lowercase path, no trailing slash. */
export function pathOf(url) {
  if (!url) return null;
  let p = String(url).trim();
  if (!p) return null;
  // strip origin if it's a full URL
  const m = p.match(/^https?:\/\/[^/]+(\/.*)?$/i);
  if (m) p = m[1] || '/';
  p = p.split(/[?#]/)[0].toLowerCase();
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}

/**
 * Aggregate GA4 landingPage×channel rows down to organic-only revenue per page.
 * @param {Array<{page,channel,sessions,conversions,revenue}>} rows
 * @returns {Map<string,{sessions,conversions,revenue}>} keyed by normalized path
 */
export function organicByPage(rows, { channel = 'Organic Search' } = {}) {
  const m = new Map();
  for (const r of rows || []) {
    if (r.channel !== channel) continue;
    const key = pathOf(r.page);
    if (!key) continue;
    const cur = m.get(key) || { sessions: 0, conversions: 0, revenue: 0 };
    cur.sessions += r.sessions || 0;
    cur.conversions += r.conversions || 0;
    cur.revenue += r.revenue || 0;
    m.set(key, cur);
  }
  // round revenue to cents to avoid float drift
  for (const v of m.values()) v.revenue = Math.round(v.revenue * 100) / 100;
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
 *   - `revenueGa4` / `conversionsGa4` are carried alongside, unused for decisions, so
 *     the report can quantify how far the GA4-modelled organic number actually drifts.
 *
 * A page present in only one source still appears, with zeros from the other.
 *
 * @param {Map<string,{sessions,conversions,revenue}>} ga4Map from organicByPage()
 * @param {Map<string,{sessions,conversions,revenue}>} shopifyMap from shopifyRevenueByPage()
 * @returns {Map<string,{sessions,conversions,revenue,revenueGa4,conversionsGa4}>}
 */
export function mergeRevenueSources(ga4Map, shopifyMap) {
  const g4 = ga4Map || new Map();
  const sh = shopifyMap || new Map();
  const out = new Map();
  for (const path of new Set([...g4.keys(), ...sh.keys()])) {
    const g = g4.get(path) || { sessions: 0, conversions: 0, revenue: 0 };
    const s = sh.get(path) || { sessions: 0, conversions: 0, revenue: 0 };
    out.set(path, {
      sessions: g.sessions || 0,            // GA4 owns traffic
      conversions: s.conversions || 0,      // Shopify owns orders
      revenue: round2(s.revenue),           // Shopify owns dollars — source of truth
      revenueGa4: round2(g.revenue),        // comparison only
      conversionsGa4: g.conversions || 0,   // GA4 key events, NOT purchases
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
      // GA4's modelled organic revenue, carried for comparison. Never a decision input.
      revenueGa4: round2(c.revenueGa4 || 0),
      revenueGa4Prev: round2(p.revenueGa4 || 0),
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
      || { cluster, revenue: 0, revenuePrev: 0, revenueGa4: 0, clicks: 0, pages: 0 };
    cur.revenue += i.revenue || 0;
    cur.revenuePrev += i.revenuePrev || 0;
    cur.revenueGa4 += i.revenueGa4 || 0;
    cur.clicks += i.clicks || 0;
    cur.pages += 1;
    m.set(cluster, cur);
  }
  const out = [...m.values()].map((c) => ({
    ...c,
    revenue: round2(c.revenue),
    revenuePrev: round2(c.revenuePrev),
    revenueGa4: round2(c.revenueGa4),
    revenueDelta: round2(c.revenue - c.revenuePrev),
  }));
  return out.sort((a, b) => b.revenue - a.revenue);
}

/** Sort a copy of rows descending by numeric key, optionally capped at limit. */
export function rankBy(rows, key, limit) {
  const sorted = [...(rows || [])].sort((a, b) => (b[key] || 0) - (a[key] || 0));
  return limit ? sorted.slice(0, limit) : sorted;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
