#!/usr/bin/env node
/**
 * Paid-vs-organic conversion-rate diagnosis, per ASIN — READ-ONLY.
 *
 * Never writes to Amazon, an ad account or Shopify. The only thing it writes is a
 * report (and a sales-and-traffic cache) under data/reports/amazon-cvr-diagnosis/.
 *
 * WHY THIS EXISTS. "Most Amazon PPC problems are not PPC problems" —
 * .claude/skills/marketing-amazon-ppc-management, the paid-vs-organic diagnosis
 * (PR #862). The listing, the price and the reviews are identical on both paths;
 * only how the shopper arrived differs. So comparing a listing's PAID conversion
 * rate against its OWN ORGANIC conversion rate isolates the cause:
 *
 *   paid  << organic  → the ad is the problem (targeting, or the ad's promise)
 *   paid  ≈  organic, both bad → the LISTING is the problem; bids cannot fix it
 *   paid  >> organic  → the ad works; organic discovery/relevance is the gap
 *
 * THE UNIT IS UNITS-PER-VISIT ON BOTH SIDES, and that is a deliberate choice.
 * Amazon's own "unit session percentage" is units ÷ sessions. The ads console's
 * "7 Day Conversion Rate" is ORDERS ÷ clicks, a different numerator. Comparing
 * those two directly is the different-denominator error that manufactures verdicts
 * out of a basis mismatch. So this uses UNITS on both sides throughout.
 *
 * PAID UNITS ARE "7 Day Advertised SKU Units", NOT "7 Day Total Units". Total Units
 * includes halo — other SKUs the shopper bought in the same session — which is real
 * ad value but is NOT this listing converting. Using it would flatter paid CVR by
 * crediting the ad with sales of a different listing.
 *
 * ORGANIC IS DERIVED BY SUBTRACTION, which is the only way available: Amazon
 * publishes no organic-only traffic report. organic = total − paid, on both
 * sessions and units. Read the CAVEATS block in the output before quoting a number.
 *
 * INPUT
 *   1. data/amazon-explore/ads-reports/Sponsored_Products_Advertised_product_report.{xlsx,csv}
 *      Hand-exported from the Ads console (gitignored) until Ads API access is
 *      approved. It carries the per-ASIN clicks and advertised-SKU units, and the
 *      window is READ OFF THIS FILE rather than hardcoded, so the SP-API pull
 *      always matches the ads data instead of drifting away from it.
 *      Optionally SB/SD campaign reports, used only to size an unattributable
 *      click residual — see CAVEATS.
 *   2. SP-API GET_SALES_AND_TRAFFIC_REPORT for that same window (sessions,
 *      unitsOrdered per ASIN). Cached; --refresh re-pulls.
 *   3. SP-API Catalog Items for the product TITLE of each advertised ASIN, so the
 *      brand split uses CLAUDE.md's documented rule (title contains "culina" or
 *      "cast iron" → Culina, else RSC) rather than inventing a second taxonomy off
 *      the SKU prefix.
 *
 * Usage:
 *   node scripts/amazon/paid-vs-organic-cvr.mjs             # full diagnosis
 *   node scripts/amazon/paid-vs-organic-cvr.mjs --refresh   # re-pull sales & traffic
 *   node scripts/amazon/paid-vs-organic-cvr.mjs --json      # machine-readable
 *   node scripts/amazon/paid-vs-organic-cvr.mjs --brand rsc # one brand only
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getClient, getMarketplaceId, request,
  requestReport, pollReport, downloadReport,
} from '../../lib/amazon/sp-api-client.js';
import { isDirectRun } from '../../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, 'data', 'reports', 'amazon-cvr-diagnosis');

/**
 * The ads exports are the OPERATOR'S hand-downloaded files and `data/amazon-explore/`
 * is gitignored, so they exist in the main checkout and in no worktree. Resolving
 * through git's common dir means a worktree reads the one real copy rather than
 * needing it duplicated or symlinked in — the same mechanism lib/archive-run-output.js
 * uses in the opposite direction. Falls back to the local path outside a repo.
 */
function resolveAdsDir() {
  const local = join(ROOT, 'data', 'amazon-explore', 'ads-reports');
  if (existsSync(local)) return local;
  try {
    const commonDir = execFileSync(
      'git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: ROOT, encoding: 'utf8' },
    ).trim();
    if (commonDir) {
      const shared = join(dirname(commonDir), 'data', 'amazon-explore', 'ads-reports');
      if (existsSync(shared)) return shared;
    }
  } catch { /* not a repo, or git unavailable — fall through to the local path */ }
  return local;
}
const ADS_DIR = resolveAdsDir();

/**
 * A listing needs this many visits on a side before that side's CVR is quoted as
 * evidence rather than as a reading. Derived, not picked: at the catalogue's own
 * ~5% unit-session rate, 30 visits is where the expected unit count reaches ~1.5 —
 * below that a zero is the single most likely outcome for a perfectly healthy
 * listing, so a "0% CVR" verdict there would be noise, not a finding.
 */
export const MIN_VISITS_FOR_VERDICT = 30;

/**
 * How far apart the two rates must sit before the gap is called a direction rather
 * than a wobble. A ratio, because the rates themselves span an order of magnitude
 * across the catalogue. 1.5x on a ~5% base is ~2.5pp, comfortably wider than the
 * session/click approximation below can manufacture on its own.
 */
export const MEANINGFUL_RATIO = 1.5;

/**
 * Above this share of a listing's sessions being paid clicks, the organic residual is
 * not reported — it is mostly measurement error.
 *
 * DERIVED FROM THE DATA, not picked, and the production pull is what forced it to
 * exist. A click does NOT reliably become a session: Amazon de-duplicates repeat
 * visits inside 24h and filters invalid traffic, so clicks OVERSTATE paid sessions.
 * Measured on the 2026-08-03 → 2026-09-01 window, two Culina ASINs record MORE ad
 * clicks than the listing had sessions in total (B071SGF6GT 1,109 clicks vs 901
 * sessions = 1.23x; B0771WC1Q1 1.03x), which is only possible if clicks overstate
 * sessions by at least ~23%.
 *
 * Take that worst observed overstatement b = 1.23. Subtracting raw clicks understates
 * organic sessions by clicks x (b-1)/b ≈ 0.19 x clicks. Requiring that error to stay
 * under a quarter of the organic residual gives organic > 0.75 x clicks, i.e. paid
 * share below ~0.57. Rounded to 0.60.
 *
 * The bias has a DIRECTION and it matters: over-subtracting sessions INFLATES organic
 * CVR, which is exactly the direction that manufactures a false "the ad is the
 * problem" verdict. So this guard suppresses the verdict that would otherwise be
 * over-reported, not the one that would be missed.
 */
export const MAX_PAID_SHARE_FOR_ORGANIC = 0.60;

const arg = (f) => process.argv.includes(f);
const argVal = (f) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : null; };

/** Amazon's exported headers carry trailing spaces; resolve by trimmed name. */
export function col(rows, name) {
  return Object.keys(rows[0] ?? {}).find((k) => k.trim() === name.trim());
}

/** Excel serial date → ISO yyyy-mm-dd. Epoch is 1899-12-30 (the 1900 leap-year bug). */
export function excelDate(serial) {
  if (typeof serial === 'string') return serial.slice(0, 10);
  return new Date(Date.UTC(1899, 11, 30) + serial * 86400000).toISOString().slice(0, 10);
}

/** Minimal RFC-4180 CSV: quoted fields, embedded commas, doubled quotes, CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0];
  return rows.slice(1).filter((r) => r.some((v) => v !== ''))
    .map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}

/**
 * The `xlsx` package is an OPTIONAL, lazy import and this repo deliberately does not
 * depend on it — npm's last published 0.18.5 carries two unpatched high-severity
 * advisories. Export CSV from the Ads console and nothing is needed. Same policy and
 * same reasoning as scripts/amazon/culina-ppc-audit.mjs.
 */
let XLSX = null;
async function loadXlsxOrExplain() {
  if (XLSX) return XLSX;
  try { XLSX = (await import('xlsx')).default; return XLSX; } catch {
    throw new Error(
      'Found .xlsx reports but no .csv, and the optional `xlsx` package is not installed.\n' +
      '  Preferred fix: re-export the report from the Amazon Ads console as CSV — no dependency needed.\n' +
      '  Alternative:   npm i -D xlsx@0.18.5 (two unpatched high-severity advisories; see this file\'s header)');
  }
}

async function readAdsReport(fragment, { required = true } = {}) {
  if (!existsSync(ADS_DIR)) {
    if (!required) return [];
    throw new Error(`No ads exports at ${ADS_DIR}. Export them from the Ads console first.`);
  }
  const files = readdirSync(ADS_DIR);
  const csv = files.find((f) => f.toLowerCase().endsWith('.csv') && f.toLowerCase().includes(fragment));
  if (csv) return parseCsv(readFileSync(join(ADS_DIR, csv), 'utf8'));
  const xls = files.find((f) => f.toLowerCase().endsWith('.xlsx') && f.toLowerCase().includes(fragment));
  if (!xls) {
    if (!required) return [];
    throw new Error(`No report matching "${fragment}" in ${ADS_DIR}`);
  }
  const X = await loadXlsxOrExplain();
  const wb = X.readFile(join(ADS_DIR, xls));
  return X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
}

const num = (r, k) => Number(r[k] ?? 0) || 0;

/**
 * Sponsored Brands and Display reports carry NO ASIN column, so their clicks cannot be
 * joined to a listing and fall into the organic residual. But the campaign NAMES embed
 * the ASINs they promote, so the clicks can at least be attributed to a BRAND — which
 * is the difference between "the residual is contaminated somewhere" and a number per
 * brand.
 *
 * Resolution goes campaign name → ASIN → title → CLAUDE.md's rule, never straight from
 * the campaign name, so there is still only one brand taxonomy in play. A campaign
 * naming no ASIN stays unattributed and is reported as such rather than assigned.
 */
export function attributeCampaignClicks(rows, asinBrand) {
  const out = { rsc: 0, culina: 0, unattributed: 0 };
  if (!rows.length) return out;
  const cName = col(rows, 'Campaign Name'), cClicks = col(rows, 'Clicks');
  for (const r of rows) {
    const clicks = num(r, cClicks);
    if (!clicks) continue;
    const named = String(r[cName] ?? '').match(/B0[0-9A-Z]{8}/g) ?? [];
    const brands = new Set(named.map((a) => asinBrand.get(a)).filter(Boolean));
    if (brands.size === 1) out[[...brands][0]] = (out[[...brands][0]] ?? 0) + clicks;
    else out.unattributed += clicks;
  }
  return out;
}

/**
 * Roll the advertised-product report up to one row per ASIN, and read the window off
 * the rows. Rows are time-sliced per campaign, so a campaign live for only part of
 * the export still sums correctly into the window total; what the min/max give is the
 * span the SP-API pull has to match.
 */
export function aggregateAds(rows) {
  if (!rows.length) throw new Error('Advertised-product report is empty.');
  const c = {
    asin: col(rows, 'Advertised ASIN'), sku: col(rows, 'Advertised SKU'),
    clicks: col(rows, 'Clicks'), spend: col(rows, 'Spend'),
    start: col(rows, 'Start Date'), end: col(rows, 'End Date'),
    orders: col(rows, '7 Day Total Orders (#)'),
    advUnits: col(rows, '7 Day Advertised SKU Units (#)'),
    advSales: col(rows, '7 Day Advertised SKU Sales'),
    totalSales: col(rows, '7 Day Total Sales'),
    portfolio: col(rows, 'Portfolio name'),
  };
  for (const [k, v] of Object.entries(c)) {
    if (!v) throw new Error(`Advertised-product report is missing the "${k}" column.`);
  }
  const byAsin = new Map();
  let minStart = Infinity, maxEnd = -Infinity;
  for (const r of rows) {
    const asin = String(r[c.asin] ?? '').trim();
    if (!asin) continue;
    const s = r[c.start], e = r[c.end];
    if (typeof s === 'number') minStart = Math.min(minStart, s);
    if (typeof e === 'number') maxEnd = Math.max(maxEnd, e);
    const cur = byAsin.get(asin) ?? {
      asin, sku: String(r[c.sku] ?? ''), portfolio: String(r[c.portfolio] ?? ''),
      clicks: 0, spend: 0, adOrders: 0, adUnits: 0, adUnitSales: 0, adTotalSales: 0,
    };
    cur.clicks += num(r, c.clicks);
    cur.spend += num(r, c.spend);
    cur.adOrders += num(r, c.orders);
    cur.adUnits += num(r, c.advUnits);
    cur.adUnitSales += num(r, c.advSales);
    cur.adTotalSales += num(r, c.totalSales);
    byAsin.set(asin, cur);
  }
  return {
    asins: [...byAsin.values()],
    window: { start: excelDate(minStart), end: excelDate(maxEnd) },
  };
}

/**
 * CLAUDE.md's documented rule, applied to the product TITLE and nothing else:
 * a title containing "culina" or "cast iron" is Culina; everything else, including
 * the REAL sub-brand, is RSC. Deliberately NOT the SKU prefix — that would be a
 * second taxonomy that drifts from the one the rest of the fleet uses.
 */
export function classifyBrand(title) {
  const t = String(title ?? '').toLowerCase();
  if (!t) return 'unknown';
  // SEPARATORS ARE NORMALISED FIRST, and that is load-bearing rather than tidy: live
  // Culina titles write "Cast-Iron" with a hyphen ("Cast-Iron Cleaning Kit, A Cleanser
  // and Cleaner 8 oz Bundled with Cast-Iron Conditioner Oil"), so a bare
  // includes('cast iron') misses them and files Culina ad spend under RSC. Same class
  // of bug as the \bsoap\b-never-matched-"soaps" gap in lib/keyword-index/cluster.js.
  // Covers ASCII hyphen, underscore and the U+2010–U+2015 dash range.
  const norm = t.replace(/[-_‐-―]+/g, ' ').replace(/\s+/g, ' ');
  return (norm.includes('culina') || norm.includes('cast iron')) ? 'culina' : 'rsc';
}

/**
 * A failed title lookup is REPORTED, never swallowed. The brand split is computed
 * from the title, so a silent empty string does not mean "unknown brand" — it means
 * the classification never ran, and the two must not look the same in the output.
 */
async function fetchTitles(client, asins) {
  const titles = new Map();
  const failures = [];
  for (const asin of asins) {
    try {
      const res = await request(client, 'GET', `/catalog/2022-04-01/items/${asin}`, {
        marketplaceIds: getMarketplaceId(), includedData: 'summaries',
      });
      titles.set(asin, res?.summaries?.[0]?.itemName ?? '');
      if (!res?.summaries?.[0]?.itemName) failures.push({ asin, reason: 'no summary returned' });
    } catch (err) {
      titles.set(asin, '');
      failures.push({ asin, reason: err.message.slice(0, 120) });
    }
  }
  return { titles, failures };
}

async function fetchSalesTraffic(client, window, { refresh }) {
  mkdirSync(OUT_DIR, { recursive: true });
  const cache = join(OUT_DIR, `sales-traffic-${window.start}_${window.end}.json`);
  if (!refresh && existsSync(cache)) {
    return { data: JSON.parse(readFileSync(cache, 'utf8')), cached: true, cachePath: cache };
  }
  const reportId = await requestReport(
    client, 'GET_SALES_AND_TRAFFIC_REPORT', [getMarketplaceId()],
    `${window.start}T00:00:00Z`, `${window.end}T23:59:59Z`,
    { asinGranularity: 'CHILD' },
  );
  const docId = await pollReport(client, reportId);
  const data = await downloadReport(client, docId);
  writeFileSync(cache, JSON.stringify(data, null, 2));
  return { data, cached: false, cachePath: cache };
}

/**
 * The comparison itself — pure, so every verdict below is a case a test can build
 * rather than a claim in a comment.
 *
 * A NEGATIVE organic residual is reported as such and never clamped to zero. It
 * means paid clicks exceeded sessions (or paid units exceeded units ordered) for
 * that ASIN, which is a real signal that the click→session approximation has broken
 * down there — usually a low-volume listing, or SB/SD clicks landing on it. Clamping
 * would hide exactly the case where the method does not apply.
 */
export function diagnose(ad, traffic) {
  const sessions = traffic?.sessions ?? 0;
  const units = traffic?.unitsOrdered ?? 0;
  const orgSessions = sessions - ad.clicks;
  const orgUnits = units - ad.adUnits;

  const rate = (n, d) => (d > 0 ? n / d : null);
  const paidCvr = rate(ad.adUnits, ad.clicks);
  const orgCvr = orgSessions > 0 ? rate(orgUnits, orgSessions) : null;
  const totalCvr = rate(units, sessions);

  const paidShare = sessions > 0 ? ad.clicks / sessions : null;
  const paidReadable = ad.clicks >= MIN_VISITS_FOR_VERDICT;
  // Two independent ways organic can be unreadable: too few visits to carry a rate,
  // or so dominated by paid that the residual is mostly click≈session error.
  const paidDominant = paidShare != null && paidShare > MAX_PAID_SHARE_FOR_ORGANIC;
  const orgReadable = orgSessions >= MIN_VISITS_FOR_VERDICT && !paidDominant;

  const ratio = (paidCvr != null && orgReadable && orgCvr > 0) ? paidCvr / orgCvr : null;

  let verdict, action;
  if (orgSessions < 0 || orgUnits < 0) {
    verdict = 'not-measurable';
    action = 'Ad clicks EXCEED total sessions — clicks overstate sessions here, so no organic residual exists to read.';
  } else if (paidDominant) {
    verdict = 'paid-dominant';
    action = `${Math.round(paidShare * 100)}% of sessions are ad clicks. The organic residual is mostly measurement error; judge this listing on paid alone.`;
  } else if (!paidReadable && !orgReadable) {
    verdict = 'no-data';
    action = `Under ${MIN_VISITS_FOR_VERDICT} visits on both sides. Nothing to read.`;
  } else if (!paidReadable) {
    verdict = 'organic-only';
    action = `Organic is readable, paid is not (${ad.clicks} clicks). Judge the listing on organic; do not read the ad.`;
  } else if (!orgReadable) {
    verdict = 'paid-only';
    action = 'Paid is readable, organic is not. This listing is almost entirely ad-fed.';
  } else if (ratio != null && ratio < 1 / MEANINGFUL_RATIO) {
    verdict = 'ad-problem';
    action = 'Paid converts materially worse than organic on the same listing → targeting or ad promise. Read the search terms.';
  } else if (ratio != null && ratio > MEANINGFUL_RATIO) {
    verdict = 'organic-gap';
    action = 'Paid converts materially better than organic → the listing sells when found. Organic relevance/rank is the gap, not the page.';
  } else {
    verdict = 'listing-bound';
    action = 'Both paths convert alike → the listing governs. Bids cannot fix it; fix the page.';
  }

  return {
    ...ad,
    sessions, units, orgSessions, orgUnits, paidShare,
    paidCvr,
    // Never hand back an organic rate the guards just declared unreadable — a printed
    // 1200% reads as a finding, and suppressing it at the display layer alone would
    // still leave it in the JSON for the next consumer to quote.
    orgCvr: orgReadable ? orgCvr : null,
    orgCvrRaw: orgCvr,
    totalCvr, ratio,
    paidReadable, orgReadable, paidDominant, verdict, action,
    acos: ad.adTotalSales > 0 ? ad.spend / ad.adTotalSales : null,
  };
}

const pct = (v) => (v == null ? '   —  ' : (v * 100).toFixed(2).padStart(5) + '%');
const money = (v) => (v == null ? '—' : '$' + v.toFixed(2));

export async function main() {
  const refresh = arg('--refresh');
  const brandFilter = (argVal('--brand') ?? '').toLowerCase() || null;

  const adRows = await readAdsReport('advertised_product');
  const { asins: ads, window } = aggregateAds(adRows);

  // SB/SD carry no ASIN, so their clicks cannot be attributed and land in the
  // "organic" residual. Size them so the caveat is a number, not a hedge.
  const sb = await readAdsReport('brands_campaign', { required: false });
  const sd = await readAdsReport('display_campaign', { required: false });
  const sumClicks = (rows) => (rows.length ? rows.reduce((a, r) => a + num(r, col(rows, 'Clicks')), 0) : 0);
  const unattributableClicks = sumClicks(sb) + sumClicks(sd);

  const client = getClient();
  const { titles, failures: titleFailures } = await fetchTitles(client, ads.map((a) => a.asin));
  const { data, cached, cachePath } = await fetchSalesTraffic(client, window, { refresh });

  const byAsin = new Map();
  for (const row of data?.salesAndTrafficByAsin ?? []) {
    const asin = row.parentAsin && row.childAsin ? row.childAsin : (row.childAsin ?? row.parentAsin);
    if (!asin) continue;
    const cur = byAsin.get(asin) ?? { sessions: 0, unitsOrdered: 0, sales: 0 };
    cur.sessions += row.trafficByAsin?.sessions ?? 0;
    cur.unitsOrdered += row.salesByAsin?.unitsOrdered ?? 0;
    cur.sales += row.salesByAsin?.orderedProductSales?.amount ?? 0;
    byAsin.set(asin, cur);
  }

  let results = ads.map((a) => {
    const d = diagnose(a, byAsin.get(a.asin));
    const title = titles.get(a.asin) ?? '';
    return { ...d, title, brand: classifyBrand(title) };
  });
  const asinBrand = new Map(results.map((r) => [r.asin, r.brand]));
  const sbSplit = attributeCampaignClicks(sb, asinBrand);
  const sdSplit = attributeCampaignClicks(sd, asinBrand);
  const campaignClicks = {
    rsc: sbSplit.rsc + sdSplit.rsc,
    culina: sbSplit.culina + sdSplit.culina,
    unattributed: sbSplit.unattributed + sdSplit.unattributed,
  };

  if (brandFilter) results = results.filter((r) => r.brand === brandFilter);
  results.sort((a, b) => b.spend - a.spend);

  const report = {
    generated_at: new Date().toISOString(),
    window,
    sales_traffic_cached: cached,
    unattributable_clicks: unattributableClicks,
    campaign_clicks_by_brand: campaignClicks,
    title_lookup_failures: titleFailures,
    asins: results,
  };

  if (arg('--json')) { console.log(JSON.stringify(report, null, 2)); return report; }

  console.log(`\nPAID vs ORGANIC conversion rate — ${window.start} → ${window.end}`);
  console.log(`Sales & traffic: ${cached ? 'cached' : 'freshly pulled'} (${cachePath})`);
  console.log('Units per visit on both sides. Organic = total − paid.\n');

  for (const brand of ['rsc', 'culina', 'unknown']) {
    const rows = results.filter((r) => r.brand === brand);
    if (!rows.length) continue;
    console.log(`── ${brand.toUpperCase()} ${'─'.repeat(96)}`);
    console.log('ASIN          spend  clicks  paid%  paidCVR   orgSess   orgCVR    ratio  verdict');
    for (const r of rows) {
      console.log(
        r.asin.padEnd(12),
        money(r.spend).padStart(8),
        String(r.clicks).padStart(7),
        (r.paidShare == null ? '  —' : Math.round(r.paidShare * 100) + '%').padStart(6),
        pct(r.paidCvr).padStart(8),
        String(r.orgSessions).padStart(8),
        pct(r.orgCvr).padStart(8),
        (r.ratio == null ? '  —  ' : r.ratio.toFixed(2) + 'x').padStart(7),
        ' ' + r.verdict,
      );
      console.log(' '.repeat(13) + (r.title || '(title unavailable)').slice(0, 92));
    }
    const t = rows.reduce((a, r) => ({
      spend: a.spend + r.spend, clicks: a.clicks + r.clicks, adUnits: a.adUnits + r.adUnits,
      sessions: a.sessions + r.sessions, units: a.units + r.units,
    }), { spend: 0, clicks: 0, adUnits: 0, sessions: 0, units: 0 });
    const os = t.sessions - t.clicks, ou = t.units - t.adUnits;
    // The same guard applies to the roll-up. A brand whose traffic is overwhelmingly
    // paid has no readable organic figure either, and printing one at brand level is
    // how an artifact gets quoted as a headline.
    const brandPaidShare = t.sessions > 0 ? t.clicks / t.sessions : null;
    const brandOrgReadable = os >= MIN_VISITS_FOR_VERDICT
      && brandPaidShare != null && brandPaidShare <= MAX_PAID_SHARE_FOR_ORGANIC;
    const orgText = brandOrgReadable
      ? `organic ${os} sessions → ${ou} units (${pct(ou / os).trim()})`
      : `organic NOT READABLE — ${Math.round((brandPaidShare ?? 0) * 100)}% of sessions are ad clicks`;
    console.log(
      `\n  ${brand.toUpperCase()} TOTAL  spend ${money(t.spend)} · paid ${t.clicks} clicks → ${t.adUnits} units` +
      ` (${pct(t.clicks ? t.adUnits / t.clicks : null).trim()}) · ${orgText}\n`,
    );
  }

  if (titleFailures.length) {
    console.log('TITLE LOOKUP FAILED (brand not classified, NOT "brand unknown"):');
    for (const f of titleFailures) console.log(`  ${f.asin} — ${f.reason}`);
    console.log('');
  }

  console.log('CAVEATS — read before quoting any number above:');
  console.log('  1. A click is treated as one session, and MEASURABLY IT IS NOT. Amazon publishes no');
  console.log('     organic-only traffic report, so organic can only be derived by subtraction — but');
  console.log('     Amazon de-duplicates repeat visits within 24h and filters invalid traffic, so');
  console.log('     clicks OVERSTATE paid sessions. Two ASINs in this window record more ad clicks');
  console.log('     than the listing had sessions at all. The bias INFLATES organic CVR, which is the');
  console.log(`     direction that fakes an "ad-problem" verdict, so any listing over`);
  console.log(`     ${Math.round(MAX_PAID_SHARE_FOR_ORGANIC * 100)}% paid share is reported as paid-dominant instead of scored.`);
  console.log(`  2. Sponsored Brands + Display contributed ${unattributableClicks} clicks with NO ASIN column, so they`);
  console.log('     sit inside "organic" above and overstate it. Attributed by campaign name:');
  console.log(`     RSC ${campaignClicks.rsc} · Culina ${campaignClicks.culina} · unattributed ${campaignClicks.unattributed}.`);
  if (campaignClicks.rsc === 0) {
    console.log('     RSC took ZERO of them, so the RSC organic figures above are clean of this.');
  }
  console.log('  3. Ad units are 7-day attributed; sessions are calendar-window. They disagree at the');
  console.log('     window edges.');
  console.log('  4. Paid units are ADVERTISED-SKU units, excluding halo sales of other SKUs, so paid');
  console.log('     CVR here measures this listing converting — not the ad\'s total value.');
  console.log(`  5. A side with under ${MIN_VISITS_FOR_VERDICT} visits is marked unreadable rather than scored.`);
  console.log('  6. The category benchmark that would make this a four-quadrant read has to come from');
  console.log('     Brand Analytics → Search Query Performance, which needs Brand Registry. RSC has it;');
  console.log('     Culina\'s is pending, so no category benchmark exists for Culina yet.');

  // A --brand run is a VIEW, not a dataset. Letting it write latest.json replaces the
  // whole-account report with a filtered subset that looks complete to the next
  // reader — which is how "8 ASINs, all RSC" ends up quoted as the whole account.
  if (brandFilter) {
    console.log(`\nFiltered view (--brand ${brandFilter}) — latest.json NOT overwritten.`);
    return report;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const out = join(OUT_DIR, 'latest.json');
  writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${out}`);
  return report;
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
