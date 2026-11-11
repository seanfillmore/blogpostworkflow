// lib/culina-data.js
//
// Amazon data reads for the Culina monthly inventory report: Sales, FBA
// inventory, AWD, Finance, Ads and DataForSEO seasonality. Every function takes
// `deps` first so tests inject stubs; `defaultDeps()` builds the real clients
// lazily (sp-api-client and ads-api-client read credentials when used, so they
// are imported dynamically and never at module load).

import { isCulinaTitle } from './culina-catalog.js';

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_ATTEMPTS = 5;

export async function defaultDeps() {
  const sp = await import('./amazon/sp-api-client.js');
  let spClient;
  let adsClient;
  return {
    request: (method, path, params) => sp.request((spClient ||= sp.getClient()), method, path, params),
    marketplaceId: sp.getMarketplaceId(),
    sleep: sleepReal,
    now: () => new Date(),
    ads: {
      async run(config) {
        const ads = await import('./amazon/ads-api-client.js');
        if (!adsClient) {
          adsClient = ads.getClient();
          await ads.listProfiles(adsClient);
        }
        return ads.runReport(adsClient, config);
      },
    },
    async getSearchVolume(keywords) {
      return (await import('./dataforseo.js')).getSearchVolume(keywords);
    },
  };
}

const sleepOf = (deps) => deps.sleep || sleepReal;

/** Retry a SP-API call on 429, up to 5 attempts. */
async function withRetry(deps, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!/\(429\)|429|rate limit|QuotaExceeded|throttl/i.test(String(e?.message || e)) || attempt === MAX_ATTEMPTS) throw e;
      await sleepOf(deps)(2000 * attempt);
    }
  }
  throw lastErr;
}

const call = (deps, method, path, params) => withRetry(deps, () => deps.request(method, path, params));

/** Pacific UTC offset (e.g. "-07:00") for a given instant. */
function laOffset(date) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', timeZoneName: 'longOffset' })
    .formatToParts(date).find((p) => p.type === 'timeZoneName')?.value || 'GMT-08:00';
  const m = part.match(/GMT([+-]\d{2}:\d{2})/);
  return m ? m[1] : '-08:00';
}

/** "YYYY-MM-DD" of the Pacific calendar day containing `date`. */
function laDay(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(date);
}

/** Pacific midnight ISO (with offset) at the start of a YYYY-MM-DD day. */
function laMidnight(day) {
  const off = laOffset(new Date(`${day}T12:00:00Z`));
  return `${day}T00:00:00${off}`;
}

const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

function metricsArray(res) {
  const p = res?.payload ?? res;
  return Array.isArray(p) ? p : [];
}

/** Every FBA summary row, paginated, details on. */
async function fbaSummaries(deps) {
  const rows = [];
  let nextToken;
  do {
    const res = await call(deps, 'GET', '/fba/inventory/v1/summaries', {
      granularityType: 'Marketplace', granularityId: deps.marketplaceId, marketplaceIds: deps.marketplaceId,
      details: 'true', nextToken,
    });
    rows.push(...(res?.payload?.inventorySummaries || []));
    nextToken = res?.pagination?.nextToken || res?.payload?.pagination?.nextToken;
  } while (nextToken);
  return rows;
}

export async function fetchListings(deps) {
  const out = [];
  for (const r of await fbaSummaries(deps)) {
    if (!r.asin) continue;
    out.push({ asin: r.asin, sku: r.sellerSku, title: r.productName || '', culina: isCulinaTitle(r.productName) });
  }
  return out;
}

export async function fetchDailyUnits(deps, asins, days = 120) {
  const now = deps.now ? deps.now() : new Date();
  const today = laDay(now);
  const start = laMidnight(addDays(today, -days));
  const end = laMidnight(today); // complete days only
  const out = {};
  let first = true;
  for (const asin of asins) {
    if (!first) await sleepOf(deps)(2500);
    first = false;
    const res = await call(deps, 'GET', '/sales/v1/orderMetrics', {
      marketplaceIds: deps.marketplaceId, interval: `${start}--${end}`, granularity: 'Day',
      granularityTimeZone: 'America/Los_Angeles', asin,
    });
    out[asin] = metricsArray(res).map((m) => ({ date: String(m.interval).slice(0, 10), units: m.unitCount || 0 }));
  }
  return out;
}

export async function fetchMonthlySales(deps, asins, fromMonth = '2026-03') {
  const now = deps.now ? deps.now() : new Date();
  const today = laDay(now);
  const start = laMidnight(`${fromMonth}-01`);
  const end = laMidnight(today);
  const byMonth = new Map();
  let first = true;
  for (const asin of asins) {
    if (!first) await sleepOf(deps)(2500);
    first = false;
    const res = await call(deps, 'GET', '/sales/v1/orderMetrics', {
      marketplaceIds: deps.marketplaceId, interval: `${start}--${end}`, granularity: 'Month',
      granularityTimeZone: 'America/Los_Angeles', asin,
    });
    for (const m of metricsArray(res)) {
      const key = String(m.interval).slice(0, 7);
      const cur = byMonth.get(key) || { month: key, sales: 0, units: 0 };
      cur.sales += Number(m.totalSales?.amount) || 0;
      cur.units += m.unitCount || 0;
      byMonth.set(key, cur);
    }
  }
  return [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
}

async function awdInventory(deps) {
  const rows = [];
  let nextToken;
  let first = true;
  do {
    if (!first) await sleepOf(deps)(1200);
    first = false;
    const res = await call(deps, 'GET', '/awd/2024-05-09/inventory', { details: 'SHOW', nextToken });
    rows.push(...(res?.inventory || []));
    nextToken = res?.nextToken;
  } while (nextToken);
  return rows;
}

export async function fetchStock(deps) {
  const stock = {};
  const skuToAsin = {};
  for (const r of await fbaSummaries(deps)) {
    if (!r.asin) continue;
    const d = r.inventoryDetails || {};
    const s = (stock[r.asin] ||= { fba: 0, awd: 0, inbound: 0 });
    s.fba += d.fulfillableQuantity || 0;
    s.inbound += (d.inboundWorkingQuantity || 0) + (d.inboundShippedQuantity || 0) + (d.inboundReceivingQuantity || 0);
    if (r.sellerSku) skuToAsin[r.sellerSku] = r.asin;
  }
  for (const r of await awdInventory(deps)) {
    const asin = skuToAsin[r.sku];
    if (!asin) continue;
    const s = (stock[asin] ||= { fba: 0, awd: 0, inbound: 0 });
    s.awd += r.totalOnhandQuantity || 0;
    s.inbound += r.totalInboundQuantity || 0;
  }
  return stock;
}

export async function fetchFinance(deps, startISO, endISO) {
  const events = {};
  let token;
  let first = true;
  do {
    if (!first) await sleepOf(deps)(2100);
    const params = first ? { PostedAfter: startISO, PostedBefore: endISO, MaxResultsPerPage: 100 } : { NextToken: token };
    first = false;
    const res = await call(deps, 'GET', '/finances/v0/financialEvents', params);
    const fe = res?.payload?.FinancialEvents || {};
    for (const [k, v] of Object.entries(fe)) {
      if (Array.isArray(v)) (events[k] ||= []).push(...v);
    }
    token = res?.payload?.NextToken;
  } while (token);
  return events;
}

const SP_COLUMNS = ['campaignName', 'advertisedSku', 'advertisedAsin', 'cost', 'sales7d', 'purchases7d', 'clicks', 'impressions'];
const CAMPAIGN_COLUMNS = ['campaignName', 'cost', 'sales', 'purchases', 'clicks', 'impressions'];

/** `{ sp, sb, sd }`, or null on any failure (the report carries on without ad spend); the message goes to `deps.onError('ads', message)`. */
export async function fetchAdSpend(deps, startDate, endDate) {
  try {
    const run = (name, configuration) => deps.ads.run({ name, startDate, endDate, configuration });
    const sp = await run('ap', {
      adProduct: 'SPONSORED_PRODUCTS', timeUnit: 'SUMMARY', format: 'GZIP_JSON', groupBy: ['advertiser'],
      reportTypeId: 'spAdvertisedProduct', columns: SP_COLUMNS,
    });
    const campaign = (adProduct, reportTypeId) => run(reportTypeId, {
      adProduct, timeUnit: 'SUMMARY', format: 'GZIP_JSON', groupBy: ['campaign'], reportTypeId, columns: CAMPAIGN_COLUMNS,
    });
    const sb = await campaign('SPONSORED_BRANDS', 'sbCampaigns');
    const sd = await campaign('SPONSORED_DISPLAY', 'sdCampaigns');
    return { sp, sb, sd };
  } catch (e) {
    deps.onError?.('ads', e.message);
    return null;
  }
}

/** Array of `monthlySearches` arrays, or null on failure (message to `deps.onError('seasonal', message)`). */
export async function fetchSeasonal(deps, keywords) {
  try {
    const rows = await deps.getSearchVolume(keywords);
    return (rows || []).map((r) => r.monthlySearches || []);
  } catch (e) {
    deps.onError?.('seasonal', e.message);
    return null;
  }
}
