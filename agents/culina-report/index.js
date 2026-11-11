#!/usr/bin/env node
/**
 * Culina monthly inventory report and daily stock alerts, emailed to Travis.
 *
 *   node agents/culina-report/index.js --monthly [--month YYYY-MM] [--apply] [--to <addr>]
 *   node agents/culina-report/index.js --alerts [--apply] [--to <addr>]
 *
 * Dry by default: writes data/reports/culina-report/preview-<mode>.html and prints
 * a summary, sends nothing. `--apply` sends from sean@realskincare.com through
 * Resend, To config.to, CC config.cc. `--to` sends only to that address, no CC.
 *
 * --monthly (cron on the 10th) covers the previous calendar month (UTC) unless
 * --month is given: stock projection and ship plan, forecast vs actual, monthly
 * sales chart, P&L against the month before, and goal progress.
 * --alerts (cron daily) mails when an Amazon item or a made-in-house component
 * falls below config.alert_below_days of cover (lib/culina-alerts.js rules).
 *
 * State, all gitignored under data/reports/culina-report/:
 *   inventory/YYYY-MM-DD.json  stock snapshot, written by every run (stockout days)
 *   forecasts/YYYY-MM.json     forecast for the calendar month the monthly run occurs in
 *   seasonal.json              cached search-volume history (paid call, refreshed after 35 days)
 *   ads/YYYY-MM.json           a complete month's ad rows (Ads API keeps ~60 days, so the
 *                              month before the report month is read from here)
 *   alerts-state.json          last alert per item; written only by --alerts --apply
 * Unreadable state throws rather than resetting.
 *
 * Culina only (CLAUDE.md exception, requested by Sean 2026-11-11). No RSC products.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { notify } from '../../lib/notify.js';
import { hushmailCredentials, sendMail } from '../../lib/hushmail.js';
import { loadReportConfig } from '../../lib/culina-catalog.js';
import {
  defaultDeps, fetchListings, fetchDailyUnits, fetchMonthlySales, fetchStock, fetchFinance, fetchAdSpend, fetchSeasonal,
} from '../../lib/culina-data.js';
import { dailyPace, seasonalIndex, forecastUnits, shipPlan, inferStockoutDates, componentPlan } from '../../lib/culina-forecast.js';
import { decideAlerts } from '../../lib/culina-alerts.js';
import { monthPnl, comparePnl } from '../../lib/culina-pnl.js';
import { renderMonthly, renderAlert } from '../../lib/culina-report-render.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STATE_DIR = join(ROOT, 'data', 'reports', 'culina-report');
const DAY = 864e5;
const SEASONAL_MAX_AGE_DAYS = 35;
const ACTIVE_WINDOW_DAYS = 60;
const PACE_WINDOW_DAYS = 120;
const SALES_FROM = '2026-03';

// ---- pure helpers ---------------------------------------------------------

export function parseArgs(argv) {
  const monthly = argv.includes('--monthly');
  const alerts = argv.includes('--alerts');
  if (monthly === alerts) throw new Error('usage: --monthly [--month YYYY-MM] | --alerts, plus [--apply] [--to <addr>]');
  const val = (flag) => {
    const i = argv.indexOf(flag);
    if (i === -1) return null;
    const v = argv[i + 1];
    if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  const month = val('--month');
  if (month !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`--month must be YYYY-MM, got ${month}`);
  return { mode: monthly ? 'monthly' : 'alerts', month, apply: argv.includes('--apply'), to: val('--to') };
}

const ymd = (d) => d.toISOString().slice(0, 10);
const addMonths = (month, n) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

export function previousMonth(now) {
  return addMonths(now.toISOString().slice(0, 7), -1);
}

/** UTC window of a calendar month: ISO instants for Finance, inclusive dates for Ads. */
export function monthWindow(month) {
  const start = Date.parse(`${month}-01T00:00:00Z`);
  const end = Date.parse(`${addMonths(month, 1)}-01T00:00:00Z`);
  return {
    startISO: new Date(start).toISOString(), endISO: new Date(end).toISOString(),
    startDate: ymd(new Date(start)), endDate: ymd(new Date(end - DAY)), days: Math.round((end - start) / DAY),
  };
}

/** Whole months from `from` to `to` (YYYY-MM each). */
export function monthsBetween(from, to) {
  const n = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7));
  return n(to) - n(from);
}

const sumUnits = (rows, pred) => (rows || []).reduce((s, r) => (pred(r.date) ? s + (r.units || 0) : s), 0);
const round1 = (n) => Math.round(n * 10) / 10;

// ---- state files ----------------------------------------------------------

function readJson(path, what) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`culina-report: ${what} at ${path} is unreadable (${e.message}); fix or remove it by hand`);
  }
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmp, path);
}

/** { asin: { date: fba } } from every inventory snapshot. */
function loadSnapshots(dir) {
  const invDir = join(dir, 'inventory');
  const out = {};
  if (!existsSync(invDir)) return out;
  for (const f of readdirSync(invDir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x)).sort()) {
    const snap = readJson(join(invDir, f), 'inventory snapshot');
    for (const [asin, s] of Object.entries(snap?.byAsin || {})) (out[asin] ||= {})[snap.date] = s?.fba ?? 0;
  }
  return out;
}

async function loadSeasonal(deps, dir, now, sourceErrors) {
  const path = join(dir, 'seasonal.json');
  let cached = null;
  try { cached = readJson(path, 'seasonal cache'); } catch { cached = null; } // a cache: refetch on corruption
  const age = cached?.fetchedAt ? (now.getTime() - Date.parse(cached.fetchedAt)) / DAY : Infinity;
  if (cached && age <= SEASONAL_MAX_AGE_DAYS) return seasonalIndex(cached.monthlySearches);
  const { data, error } = await fetchSeasonal(deps.amazon, deps.config.seasonal_keywords || []);
  if (error || !data) {
    if (cached?.monthlySearches) {
      deps.log(`culina-report: seasonal refresh failed (${error}); using the cache from ${cached.fetchedAt}`);
      return seasonalIndex(cached.monthlySearches);
    }
    sourceErrors.push('seasonal');
    return seasonalIndex(null);
  }
  writeJson(path, { fetchedAt: now.toISOString(), monthlySearches: data });
  return seasonalIndex(data);
}

// ---- shared gathering -----------------------------------------------------

async function gather(deps, { extraDays = 0 } = {}) {
  const { amazon, config, cogs, dir } = deps;
  const now = deps.now();
  const today = ymd(now);
  const sourceErrors = [];

  const listings = await fetchListings(amazon);
  const culinaListings = listings.filter((l) => l.culina);
  const culinaAsins = [...new Set(culinaListings.map((l) => l.asin))];
  const titleOf = Object.fromEntries(culinaListings.map((l) => [l.asin, l.title]));

  const stock = await fetchStock(amazon);
  const onHandOf = (a) => {
    const s = stock.byAsin[a];
    return s ? (s.fba || 0) + (s.awd || 0) + (s.inbound || 0) : 0;
  };
  // Today's snapshot (Culina only), overwriting a same-day file.
  writeJson(join(dir, 'inventory', `${today}.json`), {
    date: today,
    byAsin: Object.fromEntries(culinaAsins.map((a) => [a, { fba: 0, awd: 0, inbound: 0, ...(stock.byAsin[a] || {}) }])),
  });

  const daily = await fetchDailyUnits(amazon, culinaAsins, Math.max(PACE_WINDOW_DAYS, extraDays));
  const snapshots = loadSnapshots(dir);
  const seasonal = await loadSeasonal(deps, dir, now, sourceErrors);

  const activeFrom = ymd(new Date(now.getTime() - ACTIVE_WINDOW_DAYS * DAY));
  const paceFrom = ymd(new Date(now.getTime() - PACE_WINDOW_DAYS * DAY));
  const items = [];
  for (const asin of culinaAsins) {
    const rows = daily[asin] || [];
    const onHand = onHandOf(asin);
    if (sumUnits(rows, (d) => d >= activeFrom) <= 0 && onHand <= 0) continue;
    const recent = rows.filter((r) => r.date >= paceFrom);
    const pace = dailyPace(recent, { stockoutDates: inferStockoutDates(recent, snapshots[asin] || {}) });
    const label = cogs?.[asin]?.name || titleOf[asin] || asin;
    items.push({ key: asin, asin, label, pace, onHand, ...shipPlan({ pace, onHand, today, seasonal, config }) });
  }
  const known = new Set(items.map((i) => i.asin));
  for (const l of config.launches || []) {
    if (l.asin && known.has(l.asin)) continue;
    const pace = Number(l.start_monthly_units) > 0 ? Number(l.start_monthly_units) / 30 : null;
    const onHand = l.asin ? onHandOf(l.asin) : 0;
    items.push({ key: `launch:${l.asin || l.name}`, asin: l.asin || null, label: l.name || l.asin, launch: true, pace, onHand,
      ...shipPlan({ pace, onHand, today, seasonal, config }) });
  }

  const comps = componentPlan(items.filter((i) => i.asin), cogs, config, today)
    .map((c) => ({ ...c, coverDays: c.coverDays === null ? null : Math.round(c.coverDays) }));

  return { now, today, listings, culinaAsins, stock, daily, seasonal, items, comps, sourceErrors };
}

function recipients(deps, to) {
  return to ? { to } : { to: deps.config.to, cc: deps.config.cc };
}

async function send(deps, rendered, to) {
  return deps.sendMail(deps.creds, { ...recipients(deps, to), subject: rendered.subject, text: rendered.text, html: rendered.html, agent: 'culina-report' },
    { via: 'resend', resendKey: deps.resendKey });
}

// ---- modes ----------------------------------------------------------------

async function runMonthly(args, deps) {
  const { config, cogs, dir, amazon } = deps;
  const month = args.month || previousMonth(deps.now());
  const win = monthWindow(month);
  const prev = monthWindow(addMonths(month, -1));
  const daysBack = Math.ceil((deps.now().getTime() - Date.parse(win.startISO)) / DAY) + 2;
  const g = await gather(deps, { extraDays: daysBack });
  const { today, listings, culinaAsins, daily, seasonal, items, comps, sourceErrors, stock } = g;

  // Forecast vs actual for the report month.
  const saved = readJson(join(dir, 'forecasts', `${month}.json`), 'forecast file');
  let forecastVsActual = null;
  if (saved) {
    const inMonth = (d) => d >= win.startDate && d <= win.endDate;
    forecastVsActual = Object.entries(saved.byAsin || {}).map(([asin, f]) => ({
      label: f.label || asin, forecast30: f.forecast ?? null, actual: daily[asin] ? sumUnits(daily[asin], inMonth) : null,
    }));
  }

  // Save this run month's forecast for next month's comparison.
  const runMonth = today.slice(0, 7);
  const runWin = monthWindow(runMonth);
  writeJson(join(dir, 'forecasts', `${runMonth}.json`), {
    month: runMonth, madeAt: deps.now().toISOString(),
    byAsin: Object.fromEntries(items.filter((i) => i.asin && i.pace !== null && i.pace !== undefined)
      .map((i) => [i.asin, { label: i.label, forecast: Math.round(forecastUnits(i.pace, runWin.startDate, runWin.days, seasonal)) }])),
  });

  const monthlySales = (await fetchMonthlySales(amazon, culinaAsins, SALES_FROM)).filter((m) => m.month <= month);
  const lastMonth = Math.round((monthlySales.find((m) => m.month === month)?.sales || 0) * 100) / 100;
  const nMonths = monthsBetween(month, config.goal_by || '2027-11');
  const low = (config.goal_monthly || [75000, 100000])[0];
  const neededMonthlyGrowthPct = lastMonth > 0 && nMonths > 0 ? round1((Math.pow(low / lastMonth, 1 / nMonths) - 1) * 100) : null;

  // P&L, report month and the month before.
  const culinaSkus = new Set(listings.filter((l) => l.culina && l.sku).map((l) => String(l.sku).trim()));
  const skuToAsin = new Map(listings.filter((l) => l.sku).map((l) => [String(l.sku).trim(), l.asin]));
  const culinaSet = new Set(culinaAsins);
  const rscAsins = new Set(listings.filter((l) => !l.culina).map((l) => l.asin));
  // Amazon Ads keeps report data for about 60 days, so the month before the report
  // month is already partly out of reach on the 10th. Each complete month's ad rows
  // are kept in ads/<YYYY-MM>.json and read back by the next month's report.
  const adsFor = async (w) => {
    const ym = w.startDate.slice(0, 7);
    const path = join(dir, 'ads', `${ym}.json`);
    const cached = readJson(path, 'ad spend cache');
    if (cached?.data) return { data: cached.data, error: null };
    const ads = await fetchAdSpend(amazon, w.startDate, w.endDate);
    if (!ads.error && ads.data && w.endDate < today) writeJson(path, { month: ym, fetchedAt: deps.now().toISOString(), data: ads.data });
    return ads;
  };
  const adsMissing = [];
  const pnlFor = async (w, isReportMonth) => {
    let financeEvents = null;
    try {
      financeEvents = await fetchFinance(amazon, w.startISO, w.endISO);
    } catch (e) {
      deps.log(`culina-report: finance ${w.startDate} failed: ${e.message}`);
      if (!sourceErrors.includes('finance')) sourceErrors.push('finance');
    }
    const ads = await adsFor(w);
    if (ads.error) {
      deps.log(`culina-report: ads ${w.startDate} failed: ${ads.error}`);
      adsMissing.push(w.startDate.slice(0, 7));
      // The renderer blanks ad spend and net for BOTH months on 'ads', so only the
      // report month's failure sets it; a missing month-before shows as n/a by itself.
      if (isReportMonth && !sourceErrors.includes('ads')) sourceErrors.push('ads');
    }
    if (!financeEvents) return null;
    return monthPnl({ financeEvents, culinaSkus, cogsTable: cogs, skuToAsin, culinaAsins: culinaSet, rscAsins, ads: ads.data });
  };
  const curr = await pnlFor(win, true);
  const before = await pnlFor(prev, false);
  const pnl = comparePnl(curr, before);

  const model = {
    month, reportDate: today,
    projection: items.map(({ label, onHand, coverDays, forecast30, forecast60, forecast90, shipBy, shipQty }) =>
      ({ label, onHand, coverDays, forecast30, forecast60, forecast90, shipBy, shipQty })),
    components: comps, forecastVsActual, monthlySales, pnl,
    goal: { lastMonth, target: config.goal_monthly, neededMonthlyGrowthPct },
    sourceErrors, unassignedCampaigns: curr?.unassignedCampaigns || [], missingCogs: curr?.missingCogs || [],
    unmappedStock: stock.unmapped || [],
  };
  const rendered = renderMonthly(model);
  writeJson(join(dir, 'preview-monthly.json'), model);
  writeFileSync(join(dir, 'preview-monthly.html'), rendered.html);

  const net = pnl.find((l) => l.line === 'net')?.curr;
  const shipping = items.filter((i) => i.shipBy).map((i) => `${i.label}: ${i.shipQty} by ${i.shipBy}`);
  const summary = [
    `Culina monthly report for ${month}`,
    `Sales ${month}: $${lastMonth.toLocaleString('en-US')} · P&L net: ${net == null ? 'n/a' : `$${net.toLocaleString('en-US')}`}`,
    `Items projected: ${items.length} · with a ship date: ${shipping.length}`,
    ...shipping.map((s) => `  - ${s}`),
    sourceErrors.length ? `Source errors: ${sourceErrors.join(', ')}` : 'Source errors: none',
    adsMissing.length ? `Ad spend unavailable for: ${adsMissing.join(', ')}` : null,
    model.missingCogs.length ? `Missing COGS: ${model.missingCogs.join(', ')}` : null,
    model.unmappedStock.length ? `Unmapped AWD stock: ${model.unmappedStock.map((u) => u.sku).join(', ')}` : null,
    model.unassignedCampaigns.length ? `Unassigned campaigns: ${model.unassignedCampaigns.join(', ')}` : null,
  ].filter(Boolean);
  deps.log(summary.join('\n'));
  deps.log(`Preview: ${join(dir, 'preview-monthly.html')}`);

  let sent = false;
  if (args.apply) {
    await send(deps, rendered, args.to);
    sent = true;
  }
  const rcpt = recipients(deps, args.to);
  await deps.notify({
    subject: sent ? `Culina monthly report for ${month} sent to ${rcpt.to}` : `Culina monthly report for ${month} (dry run, not sent)`,
    body: summary.join('\n'), status: sourceErrors.length ? 'info' : 'success', category: 'amazon',
  });
  return { mode: 'monthly', month, sent, sales: lastMonth, ...model };
}

async function runAlerts(args, deps) {
  const { config, dir } = deps;
  const statePath = join(dir, 'alerts-state.json');
  const state = readJson(statePath, 'alerts-state.json') || {}; // read first: corrupt state stops the run before any work
  const g = await gather(deps);
  const amazonItems = g.items.filter((i) => !i.launch).map((i) => ({ key: i.key, label: i.label, coverDays: i.coverDays, onHand: i.onHand }));
  const compItems = g.comps.filter((c) => !c.sourced).map((c) => ({ key: `component:${c.name}`, label: `${c.name} (all products)`, coverDays: c.coverDays, onHand: c.onHand }));
  const decision = decideAlerts({ items: [...amazonItems, ...compItems], state, today: g.today, config });
  const rendered = renderAlert(decision.rows);
  writeFileSync(join(dir, 'preview-alerts.html'), rendered.html);

  const lines = decision.rows.map((r) => `- ${r.label}: ${r.onHand} on hand, cover ${r.coverDays ?? 'none'} days (${r.reason})`);
  deps.log(decision.send ? `${decision.rows.length} item(s) to alert:\n${lines.join('\n')}` : 'No stock alert due.');

  let sent = false;
  if (args.apply) {
    if (decision.send) {
      await send(deps, rendered, args.to);
      sent = true;
    }
    writeJson(statePath, decision.nextState);
  }
  const rcpt = recipients(deps, args.to);
  await deps.notify({
    subject: sent ? `Culina stock alert sent to ${rcpt.to}: ${decision.rows.length} item(s)`
      : decision.send ? `Culina stock alert: ${decision.rows.length} item(s) due (dry run, not sent)` : 'Culina stock check: nothing low',
    body: lines.length ? lines.join('\n') : 'Every Culina item has at least the alert threshold of cover.',
    status: decision.send ? 'info' : 'success', category: 'amazon',
  });
  return { mode: 'alerts', sent, rows: decision.rows, sourceErrors: g.sourceErrors };
}

export async function run(argv, deps) {
  const args = parseArgs(argv);
  mkdirSync(deps.dir, { recursive: true });
  if (args.apply && !deps.creds) throw new Error('cannot send: HUSHMAIL_USER/HUSHMAIL_PASSWORD not set');
  if (args.apply && !deps.resendKey) throw new Error('cannot send: RESEND_API_KEY not set');
  return args.mode === 'monthly' ? runMonthly(args, deps) : runAlerts(args, deps);
}

async function realDeps() {
  await import('dotenv/config');
  return {
    amazon: await defaultDeps(),
    config: loadReportConfig(),
    cogs: JSON.parse(readFileSync(join(ROOT, 'config', 'culina-cogs.json'), 'utf8')).cogs,
    dir: STATE_DIR,
    creds: hushmailCredentials(process.env),
    resendKey: process.env.RESEND_API_KEY,
    now: () => new Date(),
    log: console.log,
    sendMail,
    notify,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  try {
    await run(argv, await realDeps());
  } catch (e) {
    console.error(e);
    await notify({ subject: `Culina report failed: ${e.message}`, body: String(e?.stack || e), status: 'error', category: 'amazon' }).catch(() => {});
    process.exit(1);
  }
}

if (isDirectRun(import.meta.url)) main();
