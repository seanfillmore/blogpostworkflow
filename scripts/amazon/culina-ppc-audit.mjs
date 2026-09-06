#!/usr/bin/env node
/**
 * Culina Amazon PPC audit — READ-ONLY. Never writes to Shopify, Amazon, or an ad
 * account; the only thing it writes is a finance cache under data/reports/culina-ppc/.
 *
 * WHY THIS EXISTS. An outside agency is paid >$1K/mo to manage the Culina Amazon
 * account. Culina is otherwise out of scope for this repo (CLAUDE.md); auditing that
 * spend is the one standing exception, opened by Sean on 2026-09-05.
 *
 * WHAT IT ANSWERS, in the order the answers matter:
 *
 *   1. BREAK-EVEN ACoS per ASIN. Contribution margin before ads, as a percent of
 *      revenue, IS the break-even ACoS. An ASIN advertising above it loses money on
 *      every ad-driven sale. This is the only question COGS can answer and nothing
 *      else can, which is why config/culina-cogs.json is committed beside it.
 *   2. WASTED SPEND, split by what you can actually do about it. Zero-order terms in
 *      auto/broad/phrase campaigns → NEGATE. The same terms inside manual-exact or
 *      product-target campaigns → BID DOWN, because in a one-to-one campaign you
 *      cannot lower the bid on one term within a multi-term target.
 *   3. SELF-COMPETITION. The same keyword at the same match type running in two or
 *      more campaigns. Amazon lets only one of your ads win a placement, so this is
 *      spend bidding against itself.
 *   4. STRUCTURE. Whether each ASIN has the auto-as-discovery / exact-as-vault pair.
 *
 * Tactics 2, 3 and the bid-down/negate split come from
 * .claude/skills/marketing-amazon-ppc-management (PRs #809, #812).
 *
 * INPUT — five Amazon Ads console exports in data/amazon-explore/ads-reports/
 * (gitignored; export them by hand until Ads API access is approved):
 *   Sponsored_Products_Advertised_product_report.xlsx   (required — carries SKU→ASIN)
 *   Sponsored_Products_Search_term_report.xlsx          (required for §2)
 *   Sponsored_Products_Targeting_report.xlsx            (required for §3)
 *   Sponsored_Brands_Campaign_report.xlsx               (optional, spend reconciliation)
 *   Sponsored_Display_Campaign_report.xlsx              (optional, same)
 *
 * ATTRIBUTION. Sponsored Products is 7-day; SB/SD are 14-day. Spend is comparable
 * across ad types, SALES ARE NOT — never sum sales across them. Everything below §0
 * is Sponsored Products only, so it is internally consistent.
 *
 * Usage:
 *   node scripts/amazon/culina-ppc-audit.mjs            # full audit
 *   node scripts/amazon/culina-ppc-audit.mjs --refresh  # re-pull finance (else cached)
 *   node scripts/amazon/culina-ppc-audit.mjs --json     # machine-readable
 */
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getClient, request } from '../../lib/amazon/sp-api-client.js';
import { isDirectRun } from '../../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ADS_DIR = join(ROOT, 'data', 'amazon-explore', 'ads-reports');
const OUT_DIR = join(ROOT, 'data', 'reports', 'culina-ppc');
const CACHE = join(OUT_DIR, 'finance-30d.json');
const COGS_PATH = join(ROOT, 'config', 'culina-cogs.json');

/** Terms with this many clicks and zero orders are actionable; below it, noise. */
export const NEGATION_CLICK_FLOOR = 8;
/** Auto-targeting GROUPS are not keywords — one per auto campaign is correct. */
const AUTO_TARGET_GROUPS = new Set(['close-match', 'loose-match', 'substitutes', 'complements']);

const r2 = (n) => Math.round(n * 100) / 100;
const usd = (n, w = 9) => `${n < 0 ? '-' : ''}$${Math.abs(r2(n)).toFixed(2)}`.padStart(w);
const pct = (n, w = 6) => `${r2(n * 100).toFixed(2)}%`.padStart(w);
const num = (r, k) => Number(r[k] ?? 0) || 0;

/** Amazon's headers carry trailing spaces; resolve by trimmed name. */
export function col(rows, name) {
  return Object.keys(rows[0] ?? {}).find((k) => k.trim() === name.trim());
}

/**
 * CSV is parsed with no dependency at all; .xlsx needs the `xlsx` package, which this
 * repo deliberately does NOT depend on. npm's last published version (0.18.5) carries
 * two unpatched high-severity advisories — GHSA-4r6h-8v6p-xvw6 (prototype pollution)
 * and GHSA-5pgg-2g8v-p4x9 (ReDoS) — because SheetJS ships fixes only from its own CDN
 * and never back to npm. Adding a permanently-vulnerable parser to the fleet's
 * dependency tree, for a hand-run audit tool, is not a trade worth making.
 *
 * So the import is OPTIONAL and lazy: export CSV from the Ads console and nothing is
 * needed; keep .xlsx and it works only if `xlsx` happens to be installed. Either way
 * the parser only ever sees the operator's own Amazon exports.
 */
let XLSX = null;
async function loadXlsxOrExplain() {
  if (XLSX) return XLSX;
  try { XLSX = (await import('xlsx')).default; return XLSX; } catch {
    throw new Error(
      'Found .xlsx reports but no .csv, and the optional `xlsx` package is not installed.\n' +
      '  Preferred fix: re-export the reports from the Amazon Ads console as CSV — no dependency needed.\n' +
      '  Alternative:   npm i -D xlsx@0.18.5  (carries two unpatched high-severity advisories; see this file\'s header)');
  }
}

/** Minimal RFC-4180 CSV: quoted fields, embedded commas, doubled quotes, CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows.shift();
  return rows.filter((r) => r.some((v) => v !== '')).map((r) => {
    const o = {};
    header.forEach((h, i) => {
      const raw = r[i] ?? '';
      // Amazon writes money as "$1,234.56" and percents as "12.34%".
      const cleaned = raw.replace(/^\$/, '').replace(/,(?=\d{3}\b)/g, '');
      o[h] = raw === '' ? null : (cleaned !== '' && !Number.isNaN(Number(cleaned)) ? Number(cleaned) : raw);
    });
    return o;
  });
}

async function loadSheet(fragment) {
  const files = readdirSync(ADS_DIR);
  const csv = files.find((x) => x.toLowerCase().endsWith('.csv') && x.toLowerCase().includes(fragment));
  if (csv) return parseCsv(readFileSync(join(ADS_DIR, csv), 'utf8'));
  const xls = files.find((x) => x.toLowerCase().endsWith('.xlsx') && x.toLowerCase().includes(fragment));
  if (!xls) throw new Error(`No ads report matching "${fragment}" in ${ADS_DIR}. Export it from the Ads console (CSV preferred).`);
  const X = await loadXlsxOrExplain();
  const wb = X.readFile(join(ADS_DIR, xls));
  return X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: null });
}

/**
 * Brand comes from the SKU prefix on the ONE report that carries both campaign and
 * SKU. A campaign whose SKUs disagree is MIXED and is excluded rather than guessed at.
 */
export function campaignBrands(advertisedProduct) {
  const isRscSku = (s) => typeof s === 'string' && /^RSC-/i.test(s.trim());
  const map = new Map();
  for (const row of advertisedProduct) {
    const c = row['Campaign Name'];
    const brand = isRscSku(row['Advertised SKU']) ? 'RSC' : 'Culina';
    const prev = map.get(c);
    map.set(c, prev && prev !== brand ? 'MIXED' : brand);
  }
  return map;
}

/**
 * A one-to-one campaign is manual exact or product targeting: you can address a
 * single target's bid directly, so unprofitable spend is a BID problem, not a
 * negation problem. Matched on the operator's own naming convention.
 */
export const isOneToOne = (campaign) => /\b(ex|exact)\b/i.test(campaign) || /\bPT\b/i.test(campaign);
export const isAuto = (campaign) => /auto/i.test(campaign);

/** Same keyword + same match type in 2+ campaigns = spend bidding against itself. */
export function duplicateTargets(targeting, isCulina) {
  const seen = new Map();
  for (const row of targeting) {
    if (!isCulina(row)) continue;
    const t = String(row['Targeting'] ?? '').trim().toLowerCase();
    if (!t || AUTO_TARGET_GROUPS.has(t)) continue;
    const key = `${t} [${String(row['Match Type'] ?? '').trim().toLowerCase()}]`;
    if (!seen.has(key)) seen.set(key, new Map());
    const m = seen.get(key);
    m.set(row['Campaign Name'], (m.get(row['Campaign Name']) || 0) + num(row, 'Spend'));
  }
  const dupes = [...seen]
    .filter(([, m]) => m.size > 1)
    .map(([target, m]) => ({ target, campaigns: m.size, spend: r2([...m.values()].reduce((a, b) => a + b, 0)) }))
    .sort((a, b) => b.spend - a.spend);
  return { dupes, totalTargets: seen.size };
}

async function loadFinance({ refresh }) {
  if (!refresh && existsSync(CACHE)) {
    console.log('(finance from cache — pass --refresh to re-pull)\n');
    return JSON.parse(readFileSync(CACHE, 'utf8'));
  }
  const client = getClient();
  const postedAfter = new Date(Date.now() - 31 * 864e5).toISOString();
  const events = { ShipmentEventList: [], RefundEventList: [] };
  let nextToken = null, pages = 0;
  do {
    const params = nextToken ? { NextToken: nextToken } : { PostedAfter: postedAfter };
    const data = await request(client, 'GET', '/finances/v0/financialEvents', params);
    const ev = data?.payload?.FinancialEvents ?? {};
    for (const k of ['ShipmentEventList', 'RefundEventList']) {
      if (Array.isArray(ev[k])) events[k].push(...ev[k]);
    }
    nextToken = data?.payload?.NextToken ?? null;
    pages++;
  } while (nextToken && pages < 60);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(CACHE, JSON.stringify(events));
  console.log(`(fetched ${pages} pages of finance events)\n`);
  return events;
}

/**
 * Roll finance line items up per ASIN. Finance carries SKU, so it needs the map.
 *
 * BRAND-FILTERED, and that is not cosmetic: the seller account ships both brands, so
 * an unfiltered rollup puts ten RSC ASINs into a Culina report. They then surface as
 * "no COGS" — which reads as a gap in config/culina-cogs.json when it is really
 * "correctly out of scope", and that is exactly the kind of false alarm that trains a
 * reader to ignore the list. Classification is the SKU prefix, the same rule
 * `campaignBrands` uses, so the two can never disagree.
 */
export function financeByAsin(events, skuToAsin, isCulinaSku = () => true) {
  const out = {};
  const mk = () => ({ gross: 0, referral: 0, fba: 0, otherFee: 0, promo: 0, units: 0 });
  const walk = (list, isRefund) => {
    for (const s of list || []) {
      for (const it of s.ShipmentItemList || s.ShipmentItemAdjustmentList || []) {
        const sku = String(it.SellerSKU ?? '').trim();
        if (!isCulinaSku(sku)) continue;
        const asin = skuToAsin.get(sku);
        if (!asin) continue;
        const b = (out[asin] ??= mk());
        for (const c of it.ItemChargeList || it.ItemChargeAdjustmentList || []) {
          if (c.ChargeType !== 'Principal') continue;
          b.gross += c?.ChargeAmount?.CurrencyAmount ?? 0;
          if (!isRefund) b.units += it.QuantityShipped ?? 0;
        }
        for (const pr of [...(it.PromotionList || []), ...(it.PromotionAdjustmentList || [])]) {
          b.promo += pr?.PromotionAmount?.CurrencyAmount ?? 0;
        }
        for (const f of [...(it.ItemFeeList || []), ...(it.ItemFeeAdjustmentList || [])]) {
          const v = f?.FeeAmount?.CurrencyAmount ?? 0;
          if (f.FeeType === 'Commission') b.referral += v;
          else if (/^FBA/.test(f.FeeType)) b.fba += v;
          else b.otherFee += v;
        }
      }
    }
  };
  walk(events.ShipmentEventList, false);
  walk(events.RefundEventList, true);
  return out;
}

/**
 * BREAK-EVEN ACoS = contribution margin before ads ÷ revenue. Above it, an ad-driven
 * sale loses money. Returns null-safe rows only for ASINs we hold a COGS figure for —
 * an ASIN with no COGS is REPORTED as unpriced rather than assumed to be free.
 */
export function breakEvenRows({ finance, adSpend, cogsTable }) {
  const rows = [];
  const unpriced = [];
  for (const [asin, f] of Object.entries(finance)) {
    const c = cogsTable[asin];
    if (!c) { unpriced.push({ asin, gross: r2(f.gross), spend: r2(adSpend[asin]?.spend ?? 0) }); continue; }
    const amazonFees = f.referral + f.fba + f.otherFee + f.promo;
    const cogsTotal = c.cogs * f.units;
    const contribBeforeAds = f.gross + amazonFees - cogsTotal;
    const ad = adSpend[asin]?.spend ?? 0;
    const adSales = adSpend[asin]?.adSales ?? 0;
    rows.push({
      asin, name: c.name, units: f.units,
      gross: r2(f.gross), amazonFees: r2(amazonFees), cogsTotal: r2(cogsTotal),
      contribBeforeAds: r2(contribBeforeAds), adSpend: r2(ad),
      net: r2(contribBeforeAds - ad),
      breakEvenAcos: f.gross ? contribBeforeAds / f.gross : 0,
      actualAcos: adSales ? ad / adSales : (ad ? Infinity : 0),
    });
  }
  rows.sort((a, b) => b.gross - a.gross);
  return { rows, unpriced };
}

async function main() {
  const args = process.argv.slice(2);
  const refresh = args.includes('--refresh');
  const asJson = args.includes('--json');

  const ap = await loadSheet('advertised_product');
  const st = await loadSheet('search_term');
  const tg = await loadSheet('targeting');
  const brands = campaignBrands(ap);
  const isCulina = (row) => brands.get(row['Campaign Name']) === 'Culina';

  const skuToAsin = new Map(ap.map((r) => [String(r['Advertised SKU']).trim(), r['Advertised ASIN']]));
  const events = await loadFinance({ refresh });
  // SKU prefix is the brand rule (CLAUDE.md); RSC SKUs start RSC-.
  const isCulinaSku = (sku) => !/^RSC-/i.test(sku);
  const finance = financeByAsin(events, skuToAsin, isCulinaSku);

  const salesCol = col(ap, '7 Day Total Sales');
  const adSpend = {};
  for (const r of ap) {
    const o = (adSpend[r['Advertised ASIN']] ??= { spend: 0, adSales: 0 });
    o.spend += num(r, 'Spend');
    o.adSales += num(r, salesCol);
  }

  const cogsTable = JSON.parse(readFileSync(COGS_PATH, 'utf8')).cogs;
  const { rows, unpriced } = breakEvenRows({ finance, adSpend, cogsTable });

  // §2 wasted spend, split by what you can do about it
  const stOrders = col(st, '7 Day Total Orders (#)');
  const zero = st.filter(isCulina).filter((r) => num(r, stOrders) === 0 && num(r, 'Clicks') >= NEGATION_CLICK_FLOOR);
  const bidDown = zero.filter((r) => isOneToOne(String(r['Campaign Name'])));
  const negate = zero.filter((r) => !isOneToOne(String(r['Campaign Name'])));
  const sum = (a) => r2(a.reduce((x, r) => x + num(r, 'Spend'), 0));

  // §3 self-competition
  const { dupes, totalTargets } = duplicateTargets(tg, isCulina);

  const report = {
    generated_at: new Date().toISOString(),
    window: { start: ap[0]?.['Start Date'] ?? null, end: ap[0]?.['End Date'] ?? null },
    totals: {
      gross: r2(rows.reduce((a, r) => a + r.gross, 0)),
      adSpend: r2(rows.reduce((a, r) => a + r.adSpend, 0)),
      net: r2(rows.reduce((a, r) => a + r.net, 0)),
    },
    breakEven: rows,
    unpricedAsins: unpriced,
    wastedSpend: {
      clickFloor: NEGATION_CLICK_FLOOR,
      negate: { terms: negate.length, spend: sum(negate) },
      bidDown: { terms: bidDown.length, spend: sum(bidDown) },
    },
    selfCompetition: { duplicated: dupes.length, ofTargets: totalTargets, spend: r2(dupes.reduce((a, d) => a + d.spend, 0)), top: dupes.slice(0, 20) },
  };

  if (asJson) { console.log(JSON.stringify(report, null, 2)); return; }

  console.log('='.repeat(96));
  console.log(`CULINA AMAZON PPC AUDIT — Sponsored Products — read-only`);
  console.log('='.repeat(96));

  console.log('\n--- 1. BREAK-EVEN ACoS (the question only COGS can answer) ---');
  console.log('ASIN         units     gross  AmznFees      COGS   contrib   adSpend       NET  breakeven   actual');
  for (const r of rows) {
    console.log(`${r.asin}  ${String(r.units).padStart(5)} ${usd(r.gross)} ${usd(r.amazonFees)} ${usd(-r.cogsTotal)} ${usd(r.contribBeforeAds)} ${usd(-r.adSpend)} ${usd(r.net)}   ${pct(r.breakEvenAcos)}  ${pct(r.actualAcos)}`);
  }
  console.log(`${''.padEnd(13)}${String(rows.reduce((a, r) => a + r.units, 0)).padStart(5)} ${usd(report.totals.gross)} ${''.padStart(29)} ${usd(-report.totals.adSpend)} ${usd(report.totals.net)}`);
  if (unpriced.length) {
    console.log(`\n  ! ${unpriced.length} CULINA ASIN(s) sold but carry NO COGS in config/culina-cogs.json:`);
    for (const u of unpriced) console.log(`      ${u.asin}  gross ${usd(u.gross)}  spend ${usd(u.spend)}`);
    console.log('    They are EXCLUDED from the totals above rather than assumed free.');
  }

  console.log('\n  Losing money on every ad-driven sale (actual ACoS above break-even):');
  for (const r of [...rows].filter((x) => x.actualAcos > x.breakEvenAcos).sort((a, b) => (b.actualAcos - b.breakEvenAcos) - (a.actualAcos - a.breakEvenAcos))) {
    const over = (r.actualAcos - r.breakEvenAcos) * 100;
    console.log(`    ${r.asin}  ${pct(r.actualAcos)} vs ${pct(r.breakEvenAcos)}  (${r2(over).toFixed(1)}pp over)  spend ${usd(r.adSpend)}  ${r.name}`);
  }

  console.log(`\n--- 2. WASTED SPEND (>=${NEGATION_CLICK_FLOOR} clicks, 0 orders) — split by the fix ---`);
  console.log(`  NEGATE  (auto / broad / phrase):        ${String(report.wastedSpend.negate.terms).padStart(3)} terms  ${usd(report.wastedSpend.negate.spend)}`);
  console.log(`  BID DOWN (manual exact / product target): ${String(report.wastedSpend.bidDown.terms).padStart(3)} terms  ${usd(report.wastedSpend.bidDown.spend)}`);
  console.log('  In a one-to-one campaign you cannot lower the bid on one term inside a');
  console.log('  multi-term target, so negating there throws away a target you chose.');

  console.log('\n--- 3. SELF-COMPETITION (same keyword + match type in 2+ campaigns) ---');
  console.log(`  ${report.selfCompetition.duplicated} of ${totalTargets} real targets, ${usd(report.selfCompetition.spend)} of spend`);
  console.log('  (auto-targeting groups excluded — one per auto campaign is correct, not a duplicate)');
  for (const d of dupes.slice(0, 10)) {
    console.log(`    ${usd(d.spend)}  ${String(d.campaigns).padStart(2)} campaigns  ${d.target}`);
  }

  console.log('\n--- 4. STRUCTURE (auto = discovery, exact = vault) ---');
  const byAsin = new Map();
  for (const r of ap) {
    if (!isCulina(r)) continue;
    const e = byAsin.get(r['Advertised ASIN']) ?? { auto: 0, exact: 0, other: 0, spend: 0 };
    const s = num(r, 'Spend');
    e.spend += s;
    if (isAuto(r['Campaign Name'])) e.auto += s;
    else if (isOneToOne(r['Campaign Name'])) e.exact += s;
    else e.other += s;
    byAsin.set(r['Advertised ASIN'], e);
  }
  for (const [asin, e] of [...byAsin].sort((a, b) => b[1].spend - a[1].spend)) {
    const v = e.auto > 0 && e.exact > 0 ? 'both'
      : e.auto > 0 ? 'AUTO ONLY — nothing harvested into'
        : e.exact > 0 ? 'EXACT ONLY — no discovery' : 'neither';
    console.log(`  ${asin}  ${usd(e.spend)}  auto ${pct(e.auto / e.spend)}  exact ${pct(e.exact / e.spend)}   ${v}`);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'latest.json'), JSON.stringify(report, null, 2));
  console.log(`\nWrote ${join(OUT_DIR, 'latest.json')}`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
