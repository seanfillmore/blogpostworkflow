// lib/seo-impact.js
//
// Pure analysis core for the SEO impact / revenue-attribution layer. Joins three
// signals by landing-page path over a time window to answer "what's actually
// working?":
//   - GA4 organic revenue/conversions/sessions per landing page (the OUTCOME)
//   - GSC clicks/impressions per page (the VISIBILITY that drives the outcome)
//   - the SEO action log (what we published/refreshed, and when)
//
// Everything here is pure and unit-tested; the agent does the I/O (GA4/GSC
// queries, reading the action log) and feeds these functions.

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
 * Merge current + prior organic maps, GSC clicks maps, and the action log into
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
    const cur = m.get(cluster) || { cluster, revenue: 0, revenuePrev: 0, clicks: 0, pages: 0 };
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

/** Sort a copy of rows descending by numeric key, optionally capped at limit. */
export function rankBy(rows, key, limit) {
  const sorted = [...(rows || [])].sort((a, b) => (b[key] || 0) - (a[key] || 0));
  return limit ? sorted.slice(0, limit) : sorted;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
