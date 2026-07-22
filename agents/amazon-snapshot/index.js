/**
 * Amazon Snapshot
 *
 * Recurring trend snapshot of the RSC Amazon channel — the piece that was missing
 * (unlike GSC/GA4/Shopify, Amazon had no scheduled snapshot, so revenue trend was
 * invisible; see project_amazon_spapi_phase1). Now that the Finance & Accounting
 * role is granted, this captures RSC NET (gross − referral − FBA fees), not just
 * gross, per run.
 *
 * Writes: data/snapshots/amazon/YYYY-MM-DD.json
 * Pulls:  Listings (SKU→ASIN→brand), Finances API (30-day financialEvents),
 *         FBA inventory (hero-lotion stockout guard).
 * Notifies: one-line RSC net + fee% + hero-lotion stock; error-status if stock low.
 *
 * Brand split: title contains "culina"/"cast iron" → Culina; else RSC (shared
 * seller account; see CLAUDE.md).
 *
 * Usage:  node agents/amazon-snapshot/index.js
 * Cron:   weekly (Amazon data moves slowly + the finance pull is heavy).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getClient, request, getMarketplaceId } from '../../lib/amazon/sp-api-client.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..', '..');
const SNAP_DIR = join(ROOT, 'data', 'snapshots', 'amazon');

// Below this many fulfillable units on a hero-lotion ASIN, flag a stockout risk.
export const LOW_STOCK_UNITS = 30;

// ── pure helpers (exported for tests) ─────────────────────────────────────────

export function classifyBrand(itemName) {
  return /culina|cast iron/i.test(itemName || '') ? 'Culina' : 'RSC';
}

/** listings[] → Map sku → { brand, asin, itemName } */
export function buildSkuBrandMap(listings) {
  const map = new Map();
  for (const l of listings || []) {
    const s = l.summaries?.[0] || {};
    map.set(l.sku, { brand: classifyBrand(s.itemName), asin: s.asin || null, itemName: s.itemName || '' });
  }
  return map;
}

const amt = (x) => Number(x?.CurrencyAmount || 0);
const r2 = (n) => Math.round(n * 100) / 100;

/**
 * Aggregate financialEvents into per-brand totals + per-ASIN net for RSC.
 * Fees arrive negative. Returns { RSC, Culina, Unknown } each with
 * { gross, referral, fba, otherFee, refund, units, net, feePct, netPct, byAsin }.
 */
export function aggregateFinance(events, skuBrandMap) {
  const mk = () => ({ gross: 0, referral: 0, fba: 0, otherFee: 0, refund: 0, units: 0, byAsin: {} });
  const out = { RSC: mk(), Culina: mk(), Unknown: mk() };

  for (const s of (events.ShipmentEventList || [])) {
    for (const it of (s.ShipmentItemList || [])) {
      const info = skuBrandMap.get(it.SellerSKU);
      const brand = info?.brand || 'Unknown';
      const b = out[brand];
      b.units += Number(it.QuantityShipped || 0);
      let itemPrincipal = 0, itemFees = 0;
      for (const c of (it.ItemChargeList || [])) if (c.ChargeType === 'Principal') itemPrincipal += amt(c.ChargeAmount);
      for (const f of (it.ItemFeeList || [])) {
        const v = amt(f.FeeAmount);
        if (f.FeeType === 'Commission') b.referral += v;
        else if (/^FBA/.test(f.FeeType)) b.fba += v;
        else b.otherFee += v;
        itemFees += v;
      }
      b.gross += itemPrincipal;
      const asin = info?.asin;
      if (asin) {
        const a = (b.byAsin[asin] = b.byAsin[asin] || { asin, itemName: info.itemName, gross: 0, net: 0, units: 0 });
        a.gross += itemPrincipal; a.net += itemPrincipal + itemFees; a.units += Number(it.QuantityShipped || 0);
      }
    }
  }
  for (const rf of (events.RefundEventList || [])) {
    for (const it of (rf.ShipmentItemAdjustmentList || rf.ShipmentItemList || [])) {
      const brand = skuBrandMap.get(it.SellerSKU)?.brand || 'Unknown';
      for (const c of (it.ItemChargeAdjustmentList || it.ItemChargeList || [])) if (c.ChargeType === 'Principal') out[brand].refund += amt(c.ChargeAmount);
    }
  }

  for (const b of Object.values(out)) {
    const fees = b.referral + b.fba + b.otherFee;
    b.net = r2(b.gross + fees + b.refund);
    b.gross = r2(b.gross); b.referral = r2(b.referral); b.fba = r2(b.fba); b.otherFee = r2(b.otherFee); b.refund = r2(b.refund);
    b.feePct = b.gross ? r2(-fees / b.gross * 100) : 0;
    b.netPct = b.gross ? r2(b.net / b.gross * 100) : 0;
    b.byAsin = Object.values(b.byAsin).map((a) => ({ ...a, gross: r2(a.gross), net: r2(a.net) })).sort((x, y) => y.net - x.net);
  }
  return out;
}

/**
 * Fulfillable units for RSC ASINs, aggregated per ASIN (Amazon returns one row per
 * SKU, and a single ASIN commonly has several SKUs — many of them zombie 0-unit
 * listings — so we MUST sum by ASIN or the same product appears many times and a
 * dead 0-unit SKU triggers a false stockout). Hero-lotion = itemName contains "lotion".
 */
export function rscInventory(inventory, skuBrandMap) {
  const asinBrand = new Map();
  for (const info of skuBrandMap.values()) if (info.asin) asinBrand.set(info.asin, info);
  const byAsin = new Map(); // asin -> { asin, itemName, fulfillable }
  for (const s of (inventory || [])) {
    const info = asinBrand.get(s.asin) || (classifyBrand(s.productName) === 'RSC' ? { brand: 'RSC', itemName: s.productName } : null);
    if (!info || info.brand !== 'RSC') continue;
    const units = s.inventoryDetails?.fulfillableQuantity ?? s.totalQuantity ?? 0;
    const name = info.itemName || s.productName || '';
    const cur = byAsin.get(s.asin) || { asin: s.asin, itemName: name, fulfillable: 0 };
    cur.fulfillable += units;
    if (!cur.itemName) cur.itemName = name;
    byAsin.set(s.asin, cur);
  }
  const all = [...byAsin.values()];
  const rscFulfillable = all.reduce((n, a) => n + a.fulfillable, 0);
  const heroLotion = all.filter((a) => /lotion/i.test(a.itemName)).sort((a, b) => a.fulfillable - b.fulfillable);
  return { rscFulfillable, heroLotion };
}

// ── SP-API pulls ──────────────────────────────────────────────────────────────

async function fetchListings(client, sellerId, marketplaceId) {
  let items = [], pageToken = null;
  do {
    const params = { marketplaceIds: marketplaceId, includedData: 'summaries', pageSize: 20 };
    if (pageToken) params.pageToken = pageToken;
    const data = await request(client, 'GET', `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}`, params);
    items = items.concat(data?.items ?? []);
    pageToken = data?.pagination?.nextToken ?? null;
  } while (pageToken);
  return items;
}

async function fetchFinance(client) {
  const postedAfter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const all = { ShipmentEventList: [], RefundEventList: [], ServiceFeeEventList: [] };
  let nextToken = null;
  do {
    const params = nextToken ? { NextToken: nextToken } : { PostedAfter: postedAfter };
    const data = await request(client, 'GET', '/finances/v0/financialEvents', params);
    const ev = data?.payload?.FinancialEvents ?? {};
    for (const k of Object.keys(ev)) if (Array.isArray(ev[k])) all[k] = (all[k] || []).concat(ev[k]);
    nextToken = data?.payload?.NextToken ?? null;
  } while (nextToken);
  return { postedAfter, events: all };
}

async function fetchInventory(client, marketplaceId) {
  let items = [], nextToken = null;
  do {
    const params = { granularityType: 'Marketplace', granularityId: marketplaceId, marketplaceIds: marketplaceId, details: 'true' };
    if (nextToken) params.nextToken = nextToken;
    const data = await request(client, 'GET', '/fba/inventory/v1/summaries', params);
    items = items.concat(data?.payload?.inventorySummaries ?? []);
    nextToken = data?.pagination?.nextToken ?? null;
  } while (nextToken);
  return items;
}

// ── main ────────────────────────────────────────────────────────────────────

export function buildSnapshot(date, finance, agg, inv) {
  const rsc = agg.RSC;
  const selling = new Set(rsc.byAsin.map((a) => a.asin));
  // Tag hero-lotion rows with whether they're actively selling — only sellers gate stock alarms.
  const heroLotion = inv.heroLotion.map((h) => ({ ...h, selling: selling.has(h.asin) }));
  const lowStock = heroLotion.some((h) => h.selling && h.fulfillable < LOW_STOCK_UNITS);
  return {
    date,
    window: { postedAfter: finance.postedAfter, days: 30 },
    rsc: {
      gross: rsc.gross, net: rsc.net, feePct: rsc.feePct, netPct: rsc.netPct, units: rsc.units,
      referral: rsc.referral, fba: rsc.fba, activeAsins: rsc.byAsin.length,
      topAsins: rsc.byAsin.slice(0, 5),
    },
    culina: { gross: agg.Culina.gross, net: agg.Culina.net, netPct: agg.Culina.netPct },
    inventory: { rscFulfillable: inv.rscFulfillable, heroLotion },
    lowStock,
  };
}

async function main() {
  const sellerId = process.env.AMAZON_SPAPI_SELLER_ID;
  if (!sellerId) throw new Error('AMAZON_SPAPI_SELLER_ID not set');
  const client = getClient();
  const marketplaceId = getMarketplaceId();
  console.log('Amazon Snapshot — pulling listings, finances, inventory...');

  const [listings, finance, inventory] = await Promise.all([
    fetchListings(client, sellerId, marketplaceId),
    fetchFinance(client),
    fetchInventory(client, marketplaceId),
  ]);
  const skuBrandMap = buildSkuBrandMap(listings);
  const agg = aggregateFinance(finance.events, skuBrandMap);
  const inv = rscInventory(inventory, skuBrandMap);

  const date = new Date().toISOString().slice(0, 10);
  const snap = buildSnapshot(date, finance, agg, inv);

  mkdirSync(SNAP_DIR, { recursive: true });
  writeFileSync(join(SNAP_DIR, `${date}.json`), JSON.stringify(snap, null, 2));

  const sellingHero = snap.inventory.heroLotion.filter((h) => h.selling);
  const heroStr = (sellingHero.length ? sellingHero : snap.inventory.heroLotion).map((h) => `${h.fulfillable}u`).join('/') || 'n/a';
  const subject = snap.lowStock
    ? `Amazon: LOW hero-lotion stock (${heroStr}) — RSC net $${snap.rsc.net}/30d`
    : `Amazon snapshot: RSC net $${snap.rsc.net}/30d (${snap.rsc.feePct}% fees, ${snap.rsc.units}u) · lotion ${heroStr}`;
  const body = [
    `RSC (30d): gross $${snap.rsc.gross}, net $${snap.rsc.net} (${snap.rsc.netPct}% net, ${snap.rsc.feePct}% fees), ${snap.rsc.units} units, ${snap.rsc.activeAsins} active ASINs.`,
    `Top ASINs by net: ${snap.rsc.topAsins.map((a) => `${a.itemName?.slice(0, 32)} $${a.net}`).join(' · ')}`,
    `Hero-lotion fulfillable: ${heroStr}${snap.lowStock ? ` — BELOW ${LOW_STOCK_UNITS}u, restock` : ''}.`,
    `Culina (context): gross $${snap.culina.gross}, net $${snap.culina.net}.`,
  ].join('\n');
  console.log(body);
  await notify({ subject, body, status: snap.lowStock ? 'error' : 'info', category: 'collector' });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => { console.error('Amazon snapshot failed:', err.message); process.exit(1); });
}
