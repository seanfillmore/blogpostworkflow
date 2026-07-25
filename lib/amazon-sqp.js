/**
 * Amazon Search Query Performance (SQP) — purchase-calibrated query data.
 *
 * SQP is the only dataset in this project that ties a *search query* to an
 * actual *purchase*, per ASIN, alongside the price the market paid. That makes
 * it the right calibration source for paid search: Google search-term reports
 * tell you what you spent on, SQP tells you what converts and at what price.
 *
 * Weekly dumps land in data/amazon-explore/YYYY-MM-DD-search-query-performance-
 * production.json (see scripts/amazon/explore-search-query-performance-rsc.mjs).
 *
 * The headline finding this exists to encode (2026-07-25): the generic coconut/
 * body-lotion market clears at $10-16 while RSC sells at $21.99 (Amazon) and $30
 * (Shopify). Paid clicks on those generics cannot convert at our price — no bid
 * or negative-keyword tuning fixes a 3x price gap. Meanwhile 57% of lotion sales
 * come from brand queries, and the non-brand winners are ingredient-led
 * ("paraben chemical free", "free of petroleum chemicals"), which convert at
 * full price.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');
const EXPLORE_DIR = join(ROOT, 'data', 'amazon-explore');

const SQP_RE = /search-query-performance-production\.json$/;
const LISTINGS_RE = /listings-production\.json$/;

// ── pure helpers ──────────────────────────────────────────────────────────────

export const norm = (s) => String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');

/**
 * Brand queries are the ones where the shopper already wants us — they carry no
 * price competition, so they must never be judged by the price-gap rule.
 */
export function isBrandQuery(query, brandTerms = ['real skin care', 'realskincare', 'real lotion', 'real coconut', 'real cocanut', 'rsc']) {
  const q = norm(query);
  return brandTerms.some((b) => q.includes(norm(b)));
}

/**
 * Fold one SQP row into an accumulator keyed by search query.
 * Exported for testing without touching disk.
 */
export function foldRow(acc, row) {
  const q = row?.searchQueryData?.searchQuery;
  if (!q) return acc;
  const e = acc.get(q) || {
    query: q, volume: 0, ourImpressions: 0, ourClicks: 0,
    ourCartAdds: 0, ourPurchases: 0, marketPurchases: 0, marketClicks: 0,
    _prices: [],
  };
  e.volume += row.searchQueryData?.searchQueryVolume || 0;
  e.ourImpressions += row.impressionData?.asinImpressionCount || 0;
  e.ourClicks += row.clickData?.asinClickCount || 0;
  e.ourCartAdds += row.cartAddData?.asinCartAddCount || 0;
  e.ourPurchases += row.purchaseData?.asinPurchaseCount || 0;
  e.marketPurchases += row.purchaseData?.totalPurchaseCount || 0;
  e.marketClicks += row.clickData?.totalClickCount || 0;
  const p = row.purchaseData?.totalMedianPurchasePrice?.amount;
  if (p) e._prices.push(p);
  acc.set(q, e);
  return acc;
}

/** Average the collected weekly medians into one representative clearing price. */
export function finalize(acc) {
  return [...acc.values()].map((e) => {
    const { _prices, ...rest } = e;
    return {
      ...rest,
      marketPrice: _prices.length ? _prices.reduce((s, x) => s + x, 0) / _prices.length : null,
    };
  });
}

/**
 * Queries we must never add as negatives — they produced real sales.
 * This is the safety rail on any automated negative-keyword generation.
 */
export function protectedQueries(rows) {
  return new Set(rows.filter((r) => r.ourPurchases > 0).map((r) => norm(r.query)));
}

/**
 * Queries where the market clears so far below our price that a paid click
 * cannot convert. Deliberately conservative:
 *   - must have a real market (minMarketPurchases) so the price is meaningful
 *   - must have produced zero sales for us
 *   - must not be a brand query (no price competition on those)
 *   - market price must be below `maxPriceRatio` x our price
 */
export function priceMismatchedQueries(rows, {
  ourPrice,
  maxPriceRatio = 0.6,
  minMarketPurchases = 50,
  minVolume = 1000,
} = {}) {
  if (!ourPrice) throw new Error('ourPrice is required');
  const protectedSet = protectedQueries(rows);
  return rows
    .filter((r) => r.marketPrice !== null)
    .filter((r) => !protectedSet.has(norm(r.query)))
    .filter((r) => !isBrandQuery(r.query))
    .filter((r) => r.ourPurchases === 0)
    .filter((r) => r.marketPurchases >= minMarketPurchases)
    .filter((r) => r.volume >= minVolume)
    .filter((r) => r.marketPrice < ourPrice * maxPriceRatio)
    .map((r) => ({ ...r, priceRatio: r.marketPrice / ourPrice }))
    .sort((a, b) => b.volume - a.volume);
}

/** Queries that produced sales for us, ranked — the demand worth buying. */
export function convertingQueries(rows, { includeBrand = true } = {}) {
  return rows
    .filter((r) => r.ourPurchases > 0)
    .filter((r) => includeBrand || !isBrandQuery(r.query))
    .sort((a, b) => b.ourPurchases - a.ourPurchases);
}

// ── disk I/O ──────────────────────────────────────────────────────────────────

/** ASIN → item title, from the newest listings dump. */
export function loadAsinTitles(dir = EXPLORE_DIR) {
  if (!existsSync(dir)) return {};
  const file = readdirSync(dir).filter((f) => LISTINGS_RE.test(f)).sort().pop();
  if (!file) return {};
  const data = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const out = {};
  for (const item of data.items || []) {
    const s = item.summaries?.[0];
    if (s?.asin) out[s.asin] = s.itemName || '';
  }
  return out;
}

/**
 * Aggregate every weekly SQP dump for the ASINs whose title matches `include`
 * and does not match `exclude` (Culina shares the seller account — see CLAUDE.md).
 *
 * @returns {{ rows: object[], weeks: number, asins: string[] }}
 */
export function loadSqp({
  dir = EXPLORE_DIR,
  include = /lotion/i,
  exclude = /culina|cast iron/i,
} = {}) {
  const titles = loadAsinTitles(dir);
  const asins = Object.keys(titles).filter(
    (a) => include.test(titles[a]) && !exclude.test(titles[a])
  );
  const wanted = new Set(asins);

  const acc = new Map();
  let weeks = 0;
  if (!existsSync(dir)) return { rows: [], weeks: 0, asins };
  for (const f of readdirSync(dir).filter((f) => SQP_RE.test(f)).sort()) {
    let data;
    try { data = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { continue; }
    if (!data.rows?.length) continue;
    weeks++;
    for (const row of data.rows) {
      if (!wanted.has(row.asin)) continue;
      foldRow(acc, row);
    }
  }
  return { rows: finalize(acc), weeks, asins };
}
