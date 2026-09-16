/**
 * What the campaign analyzer's model actually needs from the snapshots — and
 * nothing it does not.
 *
 * WHY THIS EXISTS. The analyzer used to paste 60 days of raw GSC, GA4 and Google
 * Ads snapshots plus 90 of Shopify into the prompt with JSON.stringify(_, null, 2).
 * Every weekly run from late April to 2026-09-16 died on
 *
 *   Error: 413 {"type":"request_too_large","message":"Request exceeds the maximum size"}
 *
 * MEASURED on the production snapshots, 2026-09-16 — the request body was
 * **52.8 MB** against the Messages API's 32 MB limit:
 *
 *   gsc      60 days   45.12 MB   (queriesByPage ~27 MB, topQueries ~8 MB, topPages ~2.5 MB)
 *   ga4      60 days    2.00 MB   (landingPagesByDevice, topLandingPages, usLandingPages, country)
 *   ads      60 days    0.90 MB   (per-day campaign lists, adGroupAds resource names)
 *   shopify  90 days    0.07 MB
 *
 * GSC alone was the 413: it grew `queriesByPage` (~1,900 pages/day) and a
 * 1,000-row `topQueries` per day, and the analyzer re-listed every one of them for
 * every day. Even the non-GSC remainder (~3 MB, roughly a million tokens) would
 * have blown the context window. Nothing reported the failure — the cron log was
 * the only witness, for five months.
 *
 * THE FIX IS AGGREGATION, NOT TRUNCATION. Each feed is rolled up across the window
 * (queries summed by query with an impression-weighted position; campaigns summed
 * by id with their latest status; landing pages and sources summed), then capped
 * to the rows a keyword/landing-page decision can use. `queriesByPage` is dropped
 * entirely: it is the same query data sliced per page, and the page list plus the
 * query list carry what a campaign proposal needs.
 *
 * GA4 conversions/revenue are deliberately NOT offered as a conversion measure —
 * the conversion definition broke in August 2026, and the analyzer's CVR comes from
 * the measured Shopify-joined ladder in ./measured-cvr.js. GA4 contributes traffic
 * shape only.
 */

/** The prompt built from production-shaped snapshots must stay under this. See tests. */
export const CONTEXT_BYTE_CEILING = 150_000;

export const LIMITS = Object.freeze({
  queriesByImpressions: 120,
  queriesByClicks: 60,
  pages: 60,
  ga4Sources: 15,
  ga4LandingPages: 30,
  adsKeywords: 40,
  shopifyProducts: 15,
});

const r2 = (n) => Math.round(n * 100) / 100;
const r4 = (n) => Math.round(n * 10000) / 10000;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function windowOf(snaps) {
  const dates = snaps.map((s) => s?.date).filter(Boolean).sort();
  return dates.length ? { start: dates[0], end: dates[dates.length - 1], days: snaps.length } : { days: snaps.length };
}

function sumBy(rows, keyFn, fields) {
  const m = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    const acc = m.get(key) || Object.fromEntries(fields.map((f) => [f, 0]));
    for (const f of fields) acc[f] += num(row[f]);
    m.set(key, acc);
  }
  return m;
}

export function summarizeGsc(gscSnaps = []) {
  const totals = { clicks: 0, impressions: 0 };
  const queries = new Map();
  const pages = new Map();
  for (const snap of gscSnaps) {
    totals.clicks += num(snap?.summary?.clicks);
    totals.impressions += num(snap?.summary?.impressions);
    for (const [bucket, list, key] of [[queries, snap?.topQueries, 'query'], [pages, snap?.topPages, 'page']]) {
      for (const row of list || []) {
        const k = row?.[key];
        if (!k) continue;
        const acc = bucket.get(k) || { clicks: 0, impressions: 0, posWeight: 0 };
        const imp = num(row.impressions);
        acc.clicks += num(row.clicks);
        acc.impressions += imp;
        acc.posWeight += num(row.position) * imp;
        bucket.set(k, acc);
      }
    }
  }
  const finish = (key) => ([k, a]) => ({
    [key]: k,
    clicks: a.clicks,
    impressions: a.impressions,
    ctr: a.impressions ? r4(a.clicks / a.impressions) : 0,
    position: a.impressions ? Math.round((a.posWeight / a.impressions) * 10) / 10 : null,
  });
  const allQueries = [...queries.entries()].map(finish('query'));
  const byImp = [...allQueries].sort((a, b) => b.impressions - a.impressions).slice(0, LIMITS.queriesByImpressions);
  const byClicks = [...allQueries].filter((q) => q.clicks > 0).sort((a, b) => b.clicks - a.clicks).slice(0, LIMITS.queriesByClicks);
  const seen = new Set();
  const topQueries = [...byImp, ...byClicks].filter((q) => (seen.has(q.query) ? false : seen.add(q.query)));
  const topPages = [...pages.entries()].map(finish('page')).sort((a, b) => b.impressions - a.impressions).slice(0, LIMITS.pages);
  return {
    window: windowOf(gscSnaps),
    totals: { ...totals, ctr: totals.impressions ? r4(totals.clicks / totals.impressions) : 0 },
    distinctQueries: queries.size,
    topQueries,
    topPages,
  };
}

export function summarizeGa4(ga4Snaps = []) {
  const totals = { sessions: 0, users: 0 };
  const us = { sessions: 0 };
  const sources = [];
  const landing = [];
  for (const snap of ga4Snaps) {
    totals.sessions += num(snap?.sessions);
    totals.users += num(snap?.users);
    us.sessions += num(snap?.us?.sessions);
    sources.push(...(snap?.topSources || []));
    landing.push(...(snap?.topLandingPages || []));
  }
  const top = (m, key, limit) => [...m.entries()]
    .map(([k, a]) => ({ [key]: k, sessions: a.sessions }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, limit);
  return {
    window: windowOf(ga4Snaps),
    note: 'Traffic shape only. GA4 conversions are NOT the conversion measure — use the MEASURED CVR section.',
    totals,
    usSessions: us.sessions,
    topSources: top(sumBy(sources, (r) => r?.source && `${r.source} / ${r.medium || '(none)'}`, ['sessions']), 'source', LIMITS.ga4Sources),
    topLandingPages: top(sumBy(landing, (r) => r?.page, ['sessions']), 'page', LIMITS.ga4LandingPages),
  };
}

export function summarizeAds(adsSnaps = []) {
  const totals = { spend: 0, impressions: 0, clicks: 0, conversions: 0, revenue: 0 };
  const campaigns = new Map();
  const keywords = new Map();
  // Newest first, as loadSnaps returns them — but sort to be sure the status kept is the latest.
  const ordered = [...adsSnaps].sort((a, b) => String(b?.date).localeCompare(String(a?.date)));
  for (const snap of ordered) {
    for (const f of Object.keys(totals)) totals[f] += num(snap?.[f]);
    for (const c of snap?.campaigns || []) {
      const id = c?.id || c?.name;
      if (!id) continue;
      const acc = campaigns.get(id) || { name: c.name, status: c.status, impressions: 0, clicks: 0, spend: 0, conversions: 0, revenue: 0 };
      for (const f of ['impressions', 'clicks', 'spend', 'conversions', 'revenue']) acc[f] += num(c[f]);
      campaigns.set(id, acc);
    }
    for (const k of snap?.topKeywords || []) {
      const key = k?.keyword && `${k.keyword}|${k.matchType || ''}`;
      if (!key) continue;
      const acc = keywords.get(key) || { keyword: k.keyword, matchType: k.matchType, impressions: 0, clicks: 0, spend: 0, conversions: 0 };
      for (const f of ['impressions', 'clicks', 'spend', 'conversions']) acc[f] += num(k[f]);
      keywords.set(key, acc);
    }
  }
  const money = (o) => ({ ...o, spend: r2(o.spend), ...(o.revenue !== undefined ? { revenue: r2(o.revenue) } : {}) });
  return {
    window: windowOf(adsSnaps),
    totals: money({ ...totals, avgCpc: totals.clicks ? r2(totals.spend / totals.clicks) : null }),
    campaigns: [...campaigns.values()].map(money).sort((a, b) => b.spend - a.spend || b.impressions - a.impressions),
    keywords: [...keywords.values()].map(money)
      .map((k) => ({ ...k, avgCpc: k.clicks ? r2(k.spend / k.clicks) : null }))
      .sort((a, b) => b.spend - a.spend || b.impressions - a.impressions)
      .slice(0, LIMITS.adsKeywords),
  };
}

export function summarizeShopify(shopifySnaps = []) {
  let orders = 0;
  let revenue = 0;
  const products = [];
  for (const snap of shopifySnaps) {
    orders += num(snap?.orders?.count);
    revenue += num(snap?.orders?.revenue);
    products.push(...(snap?.topProducts || []));
  }
  return {
    window: windowOf(shopifySnaps),
    orders,
    revenue: r2(revenue),
    // Display feed: topProducts is capped at 5 products per day by the collector,
    // so these totals understate the long tail (see CLAUDE.md, cluster-hold).
    topProducts: [...sumBy(products, (p) => p?.title, ['revenue', 'orders']).entries()]
      .map(([title, a]) => ({ title, revenue: r2(a.revenue), orders: a.orders }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, LIMITS.shopifyProducts),
  };
}

/** All four summaries, in one object. */
export function buildPromptContext({ adsSnaps = [], gscSnaps = [], ga4Snaps = [], shopifySnaps = [] } = {}) {
  return {
    ads: summarizeAds(adsSnaps),
    gsc: summarizeGsc(gscSnaps),
    ga4: summarizeGa4(ga4Snaps),
    shopify: summarizeShopify(shopifySnaps),
  };
}
