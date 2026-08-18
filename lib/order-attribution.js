// lib/order-attribution.js
//
// Per-order attribution: turns a raw Shopify order into a small, PII-free record
// saying which page earned it and which channel sent it.
//
// This is GROUND TRUTH, and it is the point of the module. Shopify stamps every
// order with `landing_site` (the exact entry page) and `referring_site`. Until now
// the fleet threw both away in the daily snapshot and inferred organic revenue from
// GA4 instead — a modelled number this project has repeatedly found unreliable.
//
// Two traps are encoded here because both have already produced wrong answers:
//
//  1. `srsltid` WITHOUT `gclid` is a Google Merchant Center FREE listing — organic.
//     Paid Shopping clicks always carry a gclid alongside it.
//  2. Shopify labels paid Shopping traffic `utm_content=sag_organic`. The word
//     "organic" in that value is a lie; never classify on it.
//
// Everything here is pure. Callers do the I/O.

import { extractOrderClickId } from './ads-conversions.js';
import { pathOf } from './seo-impact.js';

// Search engines whose referral means an unpaid click. DuckDuckGo is served by Bing's
// index and Brave runs its own — neither appears in Search Console, so an order from
// them is the ONLY evidence we hold that those engines convert at all.
export const SEARCH_HOSTS = new Set([
  'google.com', 'bing.com', 'duckduckgo.com', 'search.brave.com', 'search.yahoo.com',
  'ecosia.org', 'startpage.com', 'search.marginalia.nu', 'kagi.com', 'yandex.com',
  'baidu.com', 'qwant.com', 'mojeek.com', 'perplexity.ai', 'chatgpt.com', 'claude.ai',
  'copilot.microsoft.com', 'gemini.google.com',
]);

// Webmail hosts and the Gmail Android app, which arrives as android-app://...
const EMAIL_HOSTS = new Set([
  'com.google.android.gm', 'mail.google.com', 'outlook.live.com', 'outlook.office.com',
  'outlook.office365.com', 'mail.yahoo.com', 'mail.proton.me', 'mail.aol.com',
]);

// Any click identifier at all — however truncated — proves the click was paid.
// Deliberately looser than extractOrderClickId's 20-char floor: that floor exists so a
// damaged gclid is never UPLOADED to Google, but a 4-character stump is still perfectly
// good evidence for CLASSIFYING the order as paid. Using the strict check here silently
// relabels paid orders as organic and inflates the SEO numbers.
const PAID_PARAMS = ['gclid', 'gbraid', 'wbraid'];
const PAID_MEDIUMS = new Set(['cpc', 'ppc', 'paid', 'paidsearch', 'paid_search', 'cpm', 'cpv']);

function queryOf(landingSite) {
  if (!landingSite || typeof landingSite !== 'string') return null;
  const i = landingSite.indexOf('?');
  if (i === -1) return null;
  return new URLSearchParams(landingSite.slice(i + 1));
}

/** True when anything about the order indicates a paid click. */
function isPaidClick(order) {
  const attrs = Array.isArray(order?.note_attributes) ? order.note_attributes : [];
  for (const a of attrs) {
    if (PAID_PARAMS.includes(String(a?.name || '').toLowerCase()) && a?.value) return true;
  }
  const q = queryOf(order?.landing_site);
  if (!q) return false;
  for (const p of PAID_PARAMS) if (q.get(p)) return true;
  // gad_source / gad_campaignid are stamped by Google Ads autotagging.
  if (q.get('gad_source') || q.get('gad_campaignid')) return true;
  const medium = String(q.get('utm_medium') || '').toLowerCase();
  return PAID_MEDIUMS.has(medium);
}

/** Bare hostname of a referrer, `www.` stripped. null when there is no referrer. */
function referrerHostOf(referringSite) {
  if (!referringSite || typeof referringSite !== 'string') return null;
  const raw = referringSite.trim();
  if (!raw) return null;
  try {
    return new URL(raw).hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    // Not a parseable URL — take the leading host-looking chunk.
    const m = raw.match(/^(?:[a-z-]+:\/\/)?([^/?#]+)/i);
    return m ? m[1].replace(/^www\./, '').toLowerCase() : null;
  }
}

/** Coarse page class for the entry page, used for cluster rollups. */
function pageTypeOf(path) {
  if (!path) return null;
  if (path === '/') return 'home';
  if (path.startsWith('/blogs/')) return 'blog';
  if (path.startsWith('/products/')) return 'product';
  if (path.startsWith('/collections/')) return 'collection';
  if (path.startsWith('/pages/')) return 'page';
  return 'other';
}

function isAdminPreview(order) {
  const ls = String(order?.landing_site || '');
  if (ls.includes('/online_store_preview')) return true;
  return referrerHostOf(order?.referring_site) === 'admin.shopify.com';
}

function hasTestDiscount(order) {
  const codes = Array.isArray(order?.discount_codes) ? order.discount_codes : [];
  return codes.some((d) => /^TEST/i.test(String(d?.code || '')));
}

/**
 * Classify one raw Shopify order.
 *
 * Returns a flat, PII-free record — deliberately NO email, ip, customer or address,
 * because these records land in data/snapshots/ which is backed up offsite.
 *
 * @param {object} order raw Shopify order
 * @returns {object|null} null when there is no order
 */
export function classifyOrder(order) {
  if (!order || typeof order !== 'object') return null;

  const sourceName = order.source_name || null;
  const landingPath = pathOf(order.landing_site);
  const referrerHost = referrerHostOf(order.referring_site);
  const total = Number.parseFloat(order.total_price || 0) || 0;
  const cancelled = Boolean(order.cancelled_at);
  const preview = isAdminPreview(order);
  const isTest = preview || hasTestDiscount(order);
  const paid = isPaidClick(order);

  // The uploadable click id (strict length check) is reported separately from `paid`
  // so the ads uploader and the attribution report can disagree without either lying.
  const clickId = extractOrderClickId(order) || null;

  const channel = (() => {
    if (sourceName && sourceName !== 'web') {
      return /subscription|recurpay/i.test(sourceName) ? 'subscription' : 'other';
    }
    if (preview) return 'admin-preview';
    if (paid) return 'paid-search';
    if (referrerHost && SEARCH_HOSTS.has(referrerHost)) return 'organic-search';
    const medium = String(queryOf(order.landing_site)?.get('utm_medium') || '').toLowerCase();
    if (medium === 'email' || (referrerHost && EMAIL_HOSTS.has(referrerHost))) return 'email';
    if (!referrerHost) return 'direct';
    return 'referral';
  })();

  return {
    id: order.id ?? null,
    name: order.name ?? null,
    created_at: order.created_at ?? null,
    total: Math.round(total * 100) / 100,
    sourceName,
    landingPath,
    pageType: pageTypeOf(landingPath),
    referrerHost,
    channel,
    paid,
    clickId,
    isTest,
    cancelled,
    countsAsRevenue: !isTest && !cancelled && total > 0,
  };
}

/** Map a list of raw orders to attribution records, skipping junk entries. */
export function attributionRows(orders) {
  if (!Array.isArray(orders)) return [];
  const out = [];
  for (const o of orders) {
    const c = classifyOrder(o);
    if (c) out.push(c);
  }
  return out;
}

/**
 * Roll attribution records up into revenue-per-landing-page, shaped to drop straight
 * into seo-impact's buildPageImpacts() in place of the GA4 map.
 *
 * `sessions` is always 0: Shopify cannot know sessions, only orders. GA4 remains the
 * source for sessions and is still needed to spot traffic that does not convert.
 *
 * @param {Array<object>} rows from attributionRows()
 * @param {{channels?: string[]|null}} opts channels to include; null means all
 * @returns {Map<string,{sessions:number,conversions:number,revenue:number}>}
 */
export function shopifyRevenueByPage(rows, { channels = ['organic-search'] } = {}) {
  const allow = channels === null ? null : new Set(channels);
  const m = new Map();
  for (const r of rows || []) {
    if (!r?.countsAsRevenue) continue;
    if (!r.landingPath) continue;
    if (allow && !allow.has(r.channel)) continue;
    const cur = m.get(r.landingPath) || { sessions: 0, conversions: 0, revenue: 0 };
    cur.conversions += 1;
    cur.revenue += r.total;
    m.set(r.landingPath, cur);
  }
  for (const v of m.values()) v.revenue = Math.round(v.revenue * 100) / 100;
  return m;
}

/** Group records by channel → { orders, revenue }. Test/cancelled orders excluded. */
export function channelRollup(rows) {
  const m = new Map();
  for (const r of rows || []) {
    if (!r?.countsAsRevenue) continue;
    const cur = m.get(r.channel) || { channel: r.channel, orders: 0, revenue: 0 };
    cur.orders += 1;
    cur.revenue += r.total;
    m.set(r.channel, cur);
  }
  return [...m.values()]
    .map((v) => ({ ...v, revenue: Math.round(v.revenue * 100) / 100 }))
    .sort((a, b) => b.revenue - a.revenue);
}
