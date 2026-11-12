import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, parseArgs, previousMonth, monthWindow, monthsBetween, itemLabel } from '../../agents/culina-report/index.js';

const SRC = readFileSync('agents/culina-report/index.js', 'utf8');

test('entry point is guarded with isDirectRun', () => {
  assert.match(SRC, /import \{ isDirectRun \} from '\.\.\/\.\.\/lib\/is-direct-run\.js'/);
  assert.match(SRC, /if \(isDirectRun\(import\.meta\.url\)\)/);
});

test('gitignore covers the state directory', () => {
  assert.match(readFileSync('.gitignore', 'utf8'), /^data\/reports\/culina-report\/$/m);
});

test('parseArgs, previousMonth, monthWindow, monthsBetween', () => {
  assert.deepEqual(parseArgs(['--monthly', '--month', '2026-10', '--apply', '--to', 'a@b.c']),
    { mode: 'monthly', month: '2026-10', apply: true, to: 'a@b.c' });
  assert.equal(parseArgs(['--alerts']).mode, 'alerts');
  assert.throws(() => parseArgs(['--monthly', '--alerts']));
  assert.throws(() => parseArgs([]));
  assert.throws(() => parseArgs(['--monthly', '--month', '2026-1']));
  assert.equal(previousMonth(new Date('2026-11-10T15:00:00Z')), '2026-10');
  assert.equal(previousMonth(new Date('2026-01-10T15:00:00Z')), '2025-12');
  assert.deepEqual(monthWindow('2026-10'), {
    startISO: '2026-10-01T00:00:00.000Z', endISO: '2026-11-01T00:00:00.000Z',
    startDate: '2026-10-01', endDate: '2026-10-31', days: 31,
  });
  assert.equal(monthWindow('2026-12').endISO, '2027-01-01T00:00:00.000Z');
  assert.equal(monthsBetween('2026-10', '2027-11'), 13);
});

// ---- injected run ---------------------------------------------------------

const A3 = 'B0CULINA03'; // 3-pack
const AS = 'B0CULINA01'; // soap single
const AR = 'B0RSCLOT01'; // RSC lotion

const config = {
  to: 'travis@traviswales.com', cc: ['sean@realskincare.com'], from: 'sean@realskincare.com',
  cover_target_days: [90, 120], alert_below_days: 60, lead_time_days: 14, sourced_lead_time_days: 45,
  sourced_components: ['chain mail scrubber'], goal_monthly: [75000, 100000], goal_by: '2027-11',
  launches: [{ name: 'Chainmail scrubber', start_monthly_units: 300 }, { name: 'Five piece' }, { name: 'First run', initial_units: 100 }],
  seasonal_keywords: ['cast iron soap'],
};
const cogs = {
  [A3]: { cogs: 7.3, name: 'Supreme Care Set', contents: ['conditioning oil', 'cleaning soap', 'salt scrub'] },
  [AS]: { cogs: 1.73, name: 'Cleaning Soap 8oz', contents: ['cleaning soap'] },
};

function daysBack(today, n) {
  const out = [];
  for (let i = n; i >= 1; i--) out.push(new Date(Date.parse(`${today}T00:00:00Z`) - i * 864e5).toISOString().slice(0, 10));
  return out;
}

function makeDeps(dir, { now = '2026-11-11T15:00:00Z', stock = {}, financeFail = false, adsFail = false, adsRows = {}, seasonalFail = false, mail = [] } = {}) {
  const calls = { finance: [], ads: [], seasonal: 0, fba: 0 };
  const today = now.slice(0, 10);
  const dates = daysBack(today, 400);
  const amazon = {
    marketplaceId: 'ATVPDKIKX0DER',
    sleep: async () => {},
    now: () => new Date(now),
    async request(method, path, params) {
      if (path === '/fba/inventory/v1/summaries') {
        calls.fba++;
        const rows = [[A3, 'C-3PK', 'Culina Cast Iron Care Set 3 pack'], [AS, 'C-SOAP', 'Culina Cast Iron Soap'], [AR, 'R-LOT', 'Real Skin Care Lotion']]
          .map(([asin, sellerSku, productName]) => ({ asin, sellerSku, productName, inventoryDetails: { fulfillableQuantity: stock[asin] ?? 0 } }));
        return { payload: { inventorySummaries: rows } };
      }
      if (path === '/awd/2024-05-09/inventory') return { inventory: [] };
      if (path === '/sales/v1/orderMetrics') {
        const perDay = params.asin === A3 ? 10 : 2;
        if (params.granularity === 'Day') {
          return { payload: dates.map((d) => ({ interval: `${d}T00:00:00-07:00--x`, unitCount: perDay })) };
        }
        return { payload: [{ interval: '2026-09-01T00:00-07:00--x', unitCount: 1, totalSales: { amount: params.asin === A3 ? 20000 : 1000 } },
          { interval: '2026-10-01T00:00-07:00--x', unitCount: 1, totalSales: { amount: params.asin === A3 ? 25000 : 4882 } },
          { interval: '2026-11-01T00:00-07:00--x', unitCount: 1, totalSales: { amount: 999 } }] };
      }
      if (path === '/finances/v0/financialEvents') {
        calls.finance.push(params);
        if (financeFail) throw new Error('finance down');
        return { payload: { FinancialEvents: { ShipmentEventList: [{ ShipmentItemList: [{ SellerSKU: 'C-3PK', QuantityShipped: 2,
          ItemChargeList: [{ ChargeType: 'Principal', ChargeAmount: { CurrencyAmount: 50 } }], ItemFeeList: [] }] }] } } };
      }
      throw new Error(`unexpected ${path}`);
    },
    ads: { async run(cfg) { calls.ads.push(cfg); if (adsFail === true || adsFail === cfg.startDate) throw new Error('ads down'); return adsRows[cfg.name] || []; } },
    async getSearchVolume() { calls.seasonal++; if (seasonalFail) throw new Error('ip not whitelisted'); return [{ monthlySearches: [] }]; },
  };
  const notes = [];
  return {
    calls, notes, mail,
    deps: {
      amazon, config, cogs, dir, creds: { user: 'sean@realskincare.com', pass: 'x' }, resendKey: 'rk',
      now: () => new Date(now), log: () => {},
      sendMail: async (creds, msg, opts) => { mail.push({ creds, msg, opts }); return { messageId: 'm1' }; },
      notify: async (n) => { notes.push(n); },
    },
  };
}

const tmp = () => mkdtempSync(join(tmpdir(), 'culina-report-'));

test('monthly dry run writes the preview and sends nothing', async () => {
  const dir = tmp();
  const { deps, mail, notes } = makeDeps(dir, { stock: { [A3]: 100, [AS]: 5000 } });
  const r = await run(['--monthly', '--month', '2026-10'], deps);
  assert.equal(mail.length, 0);
  assert.ok(existsSync(join(dir, 'preview-monthly.html')));
  assert.equal(r.sales, 29882);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].category, 'amazon');
  assert.ok(['success', 'info'].includes(notes[0].status));
  // snapshot of today's stock
  const snap = JSON.parse(readFileSync(join(dir, 'inventory', '2026-11-11.json'), 'utf8'));
  assert.equal(snap.byAsin[A3].fba, 100);
  assert.equal(snap.byAsin[AR], undefined, 'RSC stock is not snapshotted');
  // forecast saved for the run month
  const fc = JSON.parse(readFileSync(join(dir, 'forecasts', '2026-11.json'), 'utf8'));
  assert.equal(fc.byAsin[A3].forecast, 300); // 10/day * 30 days (flat seasonal)
});

test('monthly --apply mails travis with sean cc via resend, finance window is the month', async () => {
  const dir = tmp();
  const { deps, mail, calls } = makeDeps(dir, { stock: { [A3]: 100, [AS]: 5000 } });
  const r = await run(['--monthly', '--month', '2026-10', '--apply'], deps);
  assert.equal(mail.length, 1);
  assert.equal(mail[0].msg.to, 'travis@traviswales.com');
  assert.deepEqual(mail[0].msg.cc, ['sean@realskincare.com']);
  assert.equal(mail[0].msg.agent, 'culina-report');
  assert.equal(mail[0].opts.via, 'resend');
  assert.equal(mail[0].opts.resendKey, 'rk');
  assert.match(mail[0].msg.subject, /October 2026/);
  assert.ok(mail[0].msg.html.includes('<html'));
  assert.equal(calls.finance[0].PostedAfter, '2026-10-01T00:00:00.000Z');
  // first month's window ends at the first of next month (or now, if earlier)
  assert.equal(calls.finance[0].PostedBefore, '2026-11-01T00:00:00.000Z');
  assert.equal(calls.finance[1].PostedAfter, '2026-09-01T00:00:00.000Z');
  assert.equal(calls.ads[0].startDate, '2026-10-01');
  assert.equal(calls.ads[0].endDate, '2026-10-31');
  assert.equal(r.pnl.find((l) => l.line === 'sales').curr, 50);
  assert.equal(r.goal.lastMonth, 29882);
  assert.ok(r.goal.neededMonthlyGrowthPct > 7 && r.goal.neededMonthlyGrowthPct < 8);
});

test('--to sends only to that address with no cc', async () => {
  const dir = tmp();
  const { deps, mail } = makeDeps(dir, { stock: { [A3]: 100 } });
  await run(['--monthly', '--month', '2026-10', '--apply', '--to', 'me@example.com'], deps);
  assert.equal(mail[0].msg.to, 'me@example.com');
  assert.equal(mail[0].msg.cc, undefined);
});

test('ads and finance failures become source errors, not crashes', async () => {
  const dir = tmp();
  const { deps } = makeDeps(dir, { stock: { [A3]: 100 }, financeFail: true, adsFail: true });
  const r = await run(['--monthly', '--month', '2026-10'], deps);
  assert.ok(r.sourceErrors.includes('ads'));
  assert.ok(r.sourceErrors.includes('finance'));
  assert.equal(r.pnl.find((l) => l.line === 'sales').curr, null);
});

test('month-before ads past retention: no ads source error; complete months are cached and reused', async () => {
  const dir = tmp();
  const { deps, calls } = makeDeps(dir, { stock: { [A3]: 100 }, adsFail: '2026-09-01' });
  const r = await run(['--monthly', '--month', '2026-10'], deps);
  assert.ok(!r.sourceErrors.includes('ads'));
  assert.equal(r.pnl.find((l) => l.line === 'adSpend').prev, null);
  assert.ok(existsSync(join(dir, 'ads', '2026-10.json')));
  assert.ok(!existsSync(join(dir, 'ads', '2026-09.json')));
  const before = calls.ads.length;
  const next = makeDeps(dir, { now: '2026-12-10T15:00:00Z', stock: { [A3]: 100 } });
  await run(['--monthly'], next.deps);
  assert.ok(next.calls.ads.every((c) => c.startDate !== '2026-10-01'), 'October ads come from the cache');
  assert.ok(before > 0);
});

test('forecast vs actual reads the file saved for the report month', async () => {
  const dir = tmp();
  mkdirSync(join(dir, 'forecasts'), { recursive: true });
  writeFileSync(join(dir, 'forecasts', '2026-10.json'), JSON.stringify({ month: '2026-10', byAsin: { [A3]: { label: 'Supreme Care Set', forecast: 280 } } }));
  const { deps } = makeDeps(dir, { stock: { [A3]: 100 } });
  const r = await run(['--monthly', '--month', '2026-10'], deps);
  assert.deepEqual(r.forecastVsActual, [{ label: '3-pack', forecast30: 280, actual: 310 }]);
});

test('projection includes launches and drops RSC', async () => {
  const dir = tmp();
  const { deps } = makeDeps(dir, { stock: { [A3]: 100, [AR]: 500 } });
  const r = await run(['--monthly', '--month', '2026-10'], deps);
  const labels = r.projection.map((p) => p.label);
  assert.ok(labels.includes('3-pack'));
  assert.ok(!labels.some((l) => /Lotion/.test(l)));
  const chain = r.projection.find((p) => p.label === 'Chainmail scrubber');
  assert.equal(chain.forecast30, 300);
  const five = r.projection.find((p) => p.label === 'Five piece');
  assert.equal(five.shipQty, null);
  // every product line carries its ASIN (null only for a launch configured without one)
  assert.ok(r.projection.filter((p) => !p.launch).every((p) => typeof p.asin === 'string' && p.asin.length > 0));
});

test('a launch with initial_units ships that many now, is marked a launch, and is not out of stock', async () => {
  const dir = tmp();
  const { deps } = makeDeps(dir, { stock: { [A3]: 100 } });
  const r = await run(['--monthly', '--month', '2026-10'], deps);
  const first = r.projection.find((p) => p.label === 'First run');
  assert.equal(first.launch, true);
  assert.equal(first.shipQty, 100);
  assert.equal(first.shipBy, '2026-11-11');
  assert.equal(first.forecast30, null);
});

test('seasonal is cached and refreshed only when older than 35 days', async () => {
  const dir = tmp();
  const { deps, calls } = makeDeps(dir, { stock: { [A3]: 100 } });
  await run(['--alerts'], deps);
  await run(['--alerts'], deps);
  assert.equal(calls.seasonal, 1);
  writeFileSync(join(dir, 'seasonal.json'), JSON.stringify({ fetchedAt: '2026-09-01T00:00:00Z', monthlySearches: [] }));
  await run(['--alerts'], deps);
  assert.equal(calls.seasonal, 2);
});

test('alerts dry run never writes alerts-state.json; --apply writes after sending', async () => {
  const dir = tmp();
  const { deps, mail } = makeDeps(dir, { stock: { [A3]: 100, [AS]: 5000 } });
  const r = await run(['--alerts'], deps);
  assert.equal(mail.length, 0);
  assert.ok(r.rows.some((x) => x.key === A3));
  assert.ok(!existsSync(join(dir, 'alerts-state.json')));
  assert.ok(existsSync(join(dir, 'preview-alerts.html')));
  await run(['--alerts', '--apply'], deps);
  assert.equal(mail.length, 1);
  assert.equal(mail[0].msg.to, 'travis@traviswales.com');
  assert.deepEqual(mail[0].msg.cc, ['sean@realskincare.com']);
  assert.equal(mail[0].opts.via, 'resend');
  const state = JSON.parse(readFileSync(join(dir, 'alerts-state.json'), 'utf8'));
  assert.equal(state[A3].lastAlertAt, '2026-11-11');
  // second apply the same day: already alerted, no mail
  await run(['--alerts', '--apply'], deps);
  assert.equal(mail.length, 1);
});

test('alerts list product ASINs only: no component rows, no launches', async () => {
  const dir = tmp();
  const { deps } = makeDeps(dir, { stock: { [A3]: 0, [AS]: 0 } });
  const r = await run(['--alerts'], deps);
  const keys = r.rows.map((x) => x.key);
  assert.ok(keys.includes(A3));
  assert.ok(!keys.some((k) => k.startsWith('component:')));
  assert.ok(!keys.some((k) => /launch|Chainmail|Five/i.test(k)));
});

test('a corrupt alerts-state.json throws', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'alerts-state.json'), '{not json');
  const { deps, mail } = makeDeps(dir, { stock: { [A3]: 100 } });
  await assert.rejects(run(['--alerts', '--apply'], deps), /alerts-state/);
  assert.equal(mail.length, 0);
});

// Every file a run writes lands under deps.dir; the real state directory is untouched.
function listTree(root) {
  const out = {};
  if (!existsSync(root)) return out;
  for (const e of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const p = join(e.parentPath ?? e.path, e.name);
    out[p] = statSync(p).mtimeMs;
  }
  return out;
}

test('writes only under deps.dir, never the real data directory', async () => {
  const real = join(process.cwd(), 'data', 'reports', 'culina-report');
  const before = listTree(real);
  const dir = tmp();
  const { deps } = makeDeps(dir, { stock: { [A3]: 100 } });
  await run(['--monthly', '--month', '2026-10', '--apply'], deps);
  await run(['--alerts', '--apply'], deps);
  assert.deepEqual(listTree(real), before);
  const written = Object.keys(listTree(dir)).map((p) => p.slice(dir.length + 1)).sort();
  assert.deepEqual(written, ['ads/2026-09.json', 'ads/2026-10.json', 'alerts-state.json', 'forecasts/2026-11.json', 'inventory/2026-11-11.json',
    'preview-alerts.html', 'preview-monthly.html', 'preview-monthly.json', 'seasonal.json']);
});

test('alerts --apply --to sends the test mail but does not write alert state', async () => {
  const dir = tmp();
  const { deps, mail } = makeDeps(dir, { stock: { [A3]: 100 } });
  await run(['--alerts', '--apply', '--to', 'me@example.com'], deps);
  assert.equal(mail.length, 1);
  assert.equal(mail[0].msg.to, 'me@example.com');
  assert.ok(!existsSync(join(dir, 'alerts-state.json')));
});

test('forecast file: written when absent; kept by dry and --to runs; replaced by --apply', async () => {
  const dir = tmp();
  const path = join(dir, 'forecasts', '2026-11.json');
  const { deps } = makeDeps(dir, { stock: { [A3]: 100 } });
  await run(['--monthly', '--month', '2026-10'], deps);
  assert.ok(existsSync(path));
  writeFileSync(path, JSON.stringify({ month: '2026-11', byAsin: { X: { forecast: 1 } } }));
  await run(['--monthly', '--month', '2026-10'], deps);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).byAsin.X.forecast, 1, 'dry run keeps it');
  await run(['--monthly', '--month', '2026-10', '--apply', '--to', 'me@example.com'], deps);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).byAsin.X.forecast, 1, '--to run keeps it');
  await run(['--monthly', '--month', '2026-10', '--apply'], deps);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).byAsin.X, undefined, 'the real send replaces it');
});

test('campaign overrides from config reach the P&L', async () => {
  const dir = tmp();
  const { deps } = makeDeps(dir, { stock: { [A3]: 100 }, adsRows: { sbCampaigns: [{ campaignName: 'SB - PC - Search Terms3 - Broad - EB', cost: 40 }] } });
  const plain = await run(['--monthly', '--month', '2026-10'], deps);
  assert.deepEqual(plain.unassignedCampaigns, ['SB - PC - Search Terms3 - Broad - EB']);
  const dir2 = tmp();
  const o = makeDeps(dir2, { stock: { [A3]: 100 }, adsRows: { sbCampaigns: [{ campaignName: 'SB - PC - Search Terms3 - Broad - EB', cost: 40 }] } });
  o.deps.config = { ...o.deps.config, campaign_brand_overrides: { 'SB - PC - Search Terms3 - Broad - EB': 'culina' } };
  const r = await run(['--monthly', '--month', '2026-10'], o.deps);
  assert.deepEqual(r.unassignedCampaigns, []);
  assert.equal(r.pnl.find((l) => l.line === 'adSpend').curr, -40);
});

test('config ships the three campaign overrides', () => {
  const cfg = JSON.parse(readFileSync('config/culina-report.json', 'utf8'));
  assert.deepEqual(cfg.campaign_brand_overrides, {
    'SB - PC - Search Terms3 - Broad - EB': 'culina',
    'SBV - PT - Defensive - All products - EB': 'culina',
    'SBV - Defensive - Branded ST - All products - EB': 'culina',
  });
});

test('stale seasonal cache after a failed refresh is named in the notify body', async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'seasonal.json'), JSON.stringify({ fetchedAt: '2026-08-01T00:00:00Z', monthlySearches: [] }));
  const { deps, notes } = makeDeps(dir, { stock: { [A3]: 100 }, seasonalFail: true });
  const r = await run(['--alerts'], deps);
  assert.ok(!r.sourceErrors.includes('seasonal'));
  assert.match(notes[0].body, /seasonal index from cache dated 2026-08-01, refresh failed/);
});

test('a corrupt ads cache throws', async () => {
  const dir = tmp();
  mkdirSync(join(dir, 'ads'), { recursive: true });
  writeFileSync(join(dir, 'ads', '2026-10.json'), '{oops');
  const { deps, mail } = makeDeps(dir, { stock: { [A3]: 100 } });
  await assert.rejects(run(['--monthly', '--month', '2026-10', '--apply'], deps), /ad spend cache/);
  assert.equal(mail.length, 0);
});

test('FBA summaries are pulled once per run', async () => {
  const dir = tmp();
  const { deps, calls } = makeDeps(dir, { stock: { [A3]: 100 } });
  await run(['--alerts'], deps);
  assert.equal(calls.fba, 1);
});

test('final-fix: mail goes out as Sean at Culina', async () => {
  const dir = tmp();
  const { deps, mail } = makeDeps(dir, { stock: { [A3]: 100 } });
  await run(['--monthly', '--month', '2026-10', '--apply'], deps);
  await run(['--alerts', '--apply'], deps);
  assert.equal(mail.length, 2);
  for (const m of mail) assert.equal(m.msg.fromName, 'Sean at Culina');
});

test('final-fix: alert rows carry the stock split, ship quantity and date', async () => {
  const dir = tmp();
  const { deps } = makeDeps(dir, { stock: { [A3]: 100, [AS]: 0 } });
  const r = await run(['--alerts'], deps);
  const row = r.rows.find((x) => x.key === A3);
  assert.equal(row.fba, 100); assert.equal(row.awd, 0); assert.equal(row.inbound, 0);
  assert.ok(row.shipQty > 0);
  assert.equal(row.shipBy, '2026-11-11');
});

test('final-fix: missing month-before ads reach the model as a data note', async () => {
  const dir = tmp();
  const { deps } = makeDeps(dir, { stock: { [A3]: 100 }, adsFail: '2026-09-01' });
  const r = await run(['--monthly', '--month', '2026-10'], deps);
  assert.deepEqual(r.adsMissingMonths, ['2026-09']);
  assert.match(readFileSync(join(dir, 'preview-monthly.html'), 'utf8'), /Ad spend for September 2026 is not available/);
});

test('final-fix: goal and alert threshold come from config', async () => {
  const dir = tmp();
  const { deps } = makeDeps(dir, { stock: { [A3]: 100 } });
  deps.config = { ...deps.config, alert_below_days: 45, goal_by: '2028-03' };
  const r = await run(['--monthly', '--month', '2026-10'], deps);
  assert.equal(r.goal.by, '2028-03');
  await run(['--alerts'], deps);
  const html = readFileSync(join(dir, 'preview-alerts.html'), 'utf8');
  assert.match(html, /below 45 days/);
});

test('itemLabel names sets by item count and leaves single items and the COGS table alone', () => {
  const cogs = JSON.parse(readFileSync(new URL('../../config/culina-cogs.json', import.meta.url), 'utf8')).cogs;
  const before = JSON.stringify(cogs);
  assert.equal(itemLabel('B077LYR5SF', cogs), '2-pack');
  assert.equal(itemLabel('B08BTQK5Z9', cogs), '3-pack');
  assert.equal(itemLabel('B08K892JQG', cogs), '4-pack');
  assert.equal(itemLabel('B08K85JN7M', cogs), '5-pack');
  assert.equal(itemLabel('B08KHGYYKQ', cogs), '6-pack');
  assert.equal(itemLabel('B0984W3SG3', cogs), '8-pack');
  assert.equal(itemLabel('B071SGF6GT', cogs), 'Cleaning Soap 8oz');
  const config = JSON.parse(readFileSync(new URL('../../config/culina-report.json', import.meta.url), 'utf8'));
  assert.equal(itemLabel('B071SGF6GT', cogs, null, config), 'Soap');
  assert.equal(itemLabel('B0771WC1Q1', cogs, null, config), 'Oil');
  assert.equal(itemLabel('B08BTVXLXN', cogs, null, config), 'Salt');
  assert.equal(itemLabel('B08CQMQQ1K', cogs, null, config), 'Stick');
  assert.equal(itemLabel('B08K85JN7M', cogs, null, config), '5-pack');
  assert.equal(itemLabel('B0UNKNOWN', cogs, 'Listing title'), 'Listing title');
  assert.equal(itemLabel('B0UNKNOWN', cogs), 'B0UNKNOWN');
  assert.equal(JSON.stringify(cogs), before);
});
