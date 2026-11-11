# Culina Monthly Report and Stock Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Email Travis a Culina inventory-and-P&L report on the 10th of each month, and email stock alerts during the month when an item falls below 60 days of cover.

**Architecture:** Pure logic in `lib/culina-*.js` (catalog, forecast, alerts, P&L, rendering), one I/O module for Amazon reads, and one agent `agents/culina-report/index.js` with `--monthly` and `--alerts` modes, dry by default, `--apply` to send. Mail goes through `lib/hushmail.js` over Resend, extended for HTML and CC.

**Tech Stack:** Node 22 ESM, `node:test`, existing `lib/amazon/sp-api-client.js`, `lib/amazon/ads-api-client.js`, `lib/hushmail.js`, `lib/dataforseo.js`, `lib/notify.js`.

**Spec:** `docs/superpowers/specs/2026-11-11-culina-monthly-report-design.md`

## Global Constraints

- From `sean@realskincare.com`, To `travis@traviswales.com`, CC `sean@realskincare.com`. Sent with `sendMail(creds, msg, { via: 'resend', resendKey })`.
- Monthly report covers the previous calendar month and runs on the 10th. Alerts run daily.
- Cover target 90-120 days (FBA sellable + AWD + inbound). Alert below 60 days. Lead time 14 days end to end for made-in-house items; 45 days for sourced parts (chainmail, brush, plastic scrapers, silicone handle cover).
- Ship-by date = date forecast cover falls below 90 days, minus 14 days. Quantity = units to bring cover back to 120 days.
- No agency fees anywhere. No raw materials. No RSC products.
- Culina ASIN = title contains `culina` or `cast iron` (case-insensitive).
- No `createReport` (Reports API) dependency: use Sales API `GET /sales/v1/orderMetrics`, Finance `GET /finances/v0/financialEvents`, FBA `GET /fba/inventory/v1/summaries`, AWD `GET /awd/2024-05-09/inventory`, and the Ads API.
- No em dashes in any email copy (Sean's rule for copy he sends).
- `status: 'error'` in `notify()` only when the job broke; never `immediate: true`.
- Cron in UTC; no `TZ=` prefix. Agent entry point guarded with `isDirectRun(import.meta.url)`.
- State lives in gitignored `data/reports/culina-report/`.

## Review Focus

1. An item that is out of stock today: its pace must come from in-stock days, not read as zero demand, and it must alert as OUT OF STOCK.
2. An item with no sales history (a planned launch): listed with its configured starting estimate, or listed as "no forecast" if none; never silently dropped or forecast at 0.
3. A month where ad data or finance data failed to load: P&L lines show "not available", never $0, and the email says which source failed.
4. An ad campaign whose name matches neither brand: listed under "unassigned" in the report, excluded from Culina spend, never guessed.
5. The first monthly run, with no saved forecast for the previous month: the forecast-vs-actual section says "first report, no prior forecast" instead of erroring.

---

### Task 1: HTML and CC in `lib/hushmail.js`

**Files:**
- Modify: `lib/hushmail.js` (`sendMail`, `sendViaSmtp`, `composeMessage`, `sendViaResend`)
- Test: `tests/lib/hushmail-html-cc.test.js`

**Interfaces:**
- Produces: `sendMail(creds, { to, cc?, subject, text, html?, agent }, opts)`. `cc` is a string or array; `html` optional. Requirement `to, subject, text` unchanged (text stays required as the plain-text alternative).

- [ ] **Step 1: Write the failing tests**

```js
test('resend payload carries html and cc', async () => {
  let body; const fetchImpl = async (_u, o) => { body = JSON.parse(o.body); return { ok: true, text: async () => '{"id":"r1"}' }; };
  await sendMail({ user: 'sean@realskincare.com', pass: 'x' },
    { to: 'travis@traviswales.com', cc: 'sean@realskincare.com', subject: 's', text: 't', html: '<p>h</p>', agent: 'culina-report' },
    { via: 'resend', resendKey: 'k', fetchImpl, appendSent: async () => {} });
  assert.deepEqual(body.cc, ['sean@realskincare.com']);
  assert.equal(body.html, '<p>h</p>');
  assert.deepEqual(body.to, ['travis@traviswales.com']);
});
test('composeMessage includes Cc header and an html part', async () => {
  const { raw } = await composeMessage({ user: 'sean@realskincare.com' }, { to: 'a@b.c', cc: ['d@e.f'], subject: 's', text: 't', html: '<b>h</b>' });
  const s = raw.toString();
  assert.match(s, /^Cc: d@e\.f/m);
  assert.match(s, /text\/html/);
});
test('no cc and no html keeps the old payload shape', async () => { /* body.cc === undefined, body.html === undefined */ });
```

- [ ] **Step 2: Run `node --test tests/lib/hushmail-html-cc.test.js`** — expected FAIL (cc/html absent).
- [ ] **Step 3: Thread `cc` and `html` through all four functions.** In Resend, send `cc` as an array only when present, `html` only when present. Existing hushmail tests must still pass.
- [ ] **Step 4: Run `node --test tests/lib/hushmail-*.test.js`** — expected PASS, 0 cancelled.
- [ ] **Step 5: Commit** `feat(hushmail): html body and cc on sendMail`

### Task 2: Catalog and config

**Files:**
- Create: `config/culina-report.json`, `lib/culina-catalog.js`
- Test: `tests/lib/culina-catalog.test.js`

**Interfaces:**
- Produces:
  - `loadReportConfig(path?) -> config` (throws on unparseable JSON)
  - `isCulinaTitle(title: string) -> boolean`
  - `components(asin, cogsTable) -> string[]` (normalized component names from `config/culina-cogs.json` `contents`)
  - `componentRollup(unitsByAsin: Record<asin, number>, cogsTable) -> Record<component, number>`
  - `isSourced(component, config) -> boolean`

`config/culina-report.json` holds, verbatim: `to: "travis@traviswales.com"`, `cc: ["sean@realskincare.com"]`, `from: "sean@realskincare.com"`, `cover_target_days: [90, 120]`, `alert_below_days: 60`, `lead_time_days: 14`, `sourced_lead_time_days: 45`, `sourced_components: ["chain mail scrubber", "brush", "plastic scrapers", "silicone pan handle cover"]`, `goal_monthly: [75000, 100000]`, `goal_by: "2027-11"`, `launches: []` (each `{ asin|name, start_monthly_units }`), `seasonal_keywords: ["cast iron cleaner", "cast iron soap", "cast iron seasoning", "cast iron scrubber", "cast iron oil"]`.

- [ ] **Step 1: Failing tests**: `isCulinaTitle('Culina Cast Iron Scrub')` true, `isCulinaTitle('Real Skin Care Body Lotion')` false; `componentRollup({ B08BTQK5Z9: 10, B071SGF6GT: 5 }, cogs)` → `{ 'conditioning oil': 10, 'cleaning soap': 15, 'salt scrub': 10 }`; the 6-piece contributes one `'chain mail scrubber'` and one `'brush'` per unit; `isSourced('brush')` true, `isSourced('cleaning soap')` false; malformed config file throws.
- [ ] **Step 2: Run** `node --test tests/lib/culina-catalog.test.js` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(culina-report): catalog, component rollup, config`

### Task 3: Forecast and ship plan

**Files:**
- Create: `lib/culina-forecast.js`
- Test: `tests/lib/culina-forecast.test.js`

**Interfaces:**
- Consumes: `config` (Task 2).
- Produces:
  - `inStockDays(daily: {date, units}[], stockoutDates: Set<string>) -> {date, units}[]`
  - `dailyPace(daily, { halfLifeDays = 14 }) -> number` (exponentially weighted units/day over in-stock days; 0 history → `null`)
  - `seasonalIndex(monthlySearches: {year, month, search_volume}[][]) -> Record<1..12, number>` (sum across keywords, divided by the 12-month mean; missing data → all 1)
  - `forecastUnits(pace, startDate, days, seasonal) -> number` (sum of pace × seasonal[month] per day)
  - `shipPlan({ pace, onHand, today, seasonal, config }) -> { coverDays, forecast30, forecast60, forecast90, shipBy: 'YYYY-MM-DD'|null, shipQty: number }`

`shipBy` is the day cover falls below 90 days minus 14; if that is before today, it is today. `shipQty` = 120 days of forecast demand minus the stock forecast to remain on the arrival day (`shipBy` + 14), floored at 0. `pace === null` → all forecast fields `null`, `shipBy` null.

- [ ] **Step 1: Failing tests** with exact values: pace 10/day flat seasonal, onHand 600, today 2026-12-10 → `coverDays` 60, `shipBy` `'2026-12-10'` (90-day floor already crossed; clamp to today), `shipQty` 740 (1200 − the 460 left on arrival 2026-12-24). Pace 10, onHand 1500 → `coverDays` 150, `shipBy` `'2027-01-25'` (cover hits 90 on 2027-02-08, minus 14), `shipQty` 300 (1200 − the 900 left on arrival 2027-02-08). Seasonal index where December volume is double the mean → `forecast30` from 2026-12-01 is 600 for pace 10. `dailyPace` ignores days in `stockoutDates`. Empty history → `null`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(culina-report): forecast and ship plan`

### Task 4: Alert decisions

**Files:**
- Create: `lib/culina-alerts.js`
- Test: `tests/lib/culina-alerts.test.js`

**Interfaces:**
- Consumes: `shipPlan` output (Task 3).
- Produces: `decideAlerts({ items: [{key, label, coverDays, onHand}], state: {[key]: {lastAlertAt, level}}, today, config }) -> { send: boolean, rows: [{key, label, coverDays, onHand, reason: 'out_of_stock'|'below_threshold'|'reminder'}], nextState }`. `items` includes both Amazon items and made-in-house components.

Rules: `onHand === 0` → `out_of_stock`, alerted on the day it first happens and weekly after. Cover < 60 days and not alerted at this level before → `below_threshold`. Still below and last alert ≥ 7 days ago → `reminder`. Cover back ≥ 60 → state cleared. All rows in one email: `send` true when rows non-empty.

- [ ] **Step 1: Failing tests** for each rule, including: alerted 3 days ago and still below → no row; alerted 7 days ago → `reminder`; drops from 40 days to 0 on-hand → `out_of_stock` even though alerted yesterday; recovers to 70 → key removed from `nextState`.
- [ ] **Step 2-4: Run FAIL, implement, run PASS.**
- [ ] **Step 5: Commit** `feat(culina-report): stock alert rules`

### Task 5: Monthly P&L

**Files:**
- Create: `lib/culina-pnl.js`
- Test: `tests/lib/culina-pnl.test.js`, fixtures in `tests/fixtures/culina/`

**Interfaces:**
- Produces:
  - `assignCampaignBrand(name, culinaAsins: Set, rscAsins: Set) -> 'culina'|'rsc'|null` (ASIN in name first, then product words: culina words `cast iron|scrub|soap|oil|seasoning|stick|3 pack|2 pack|conditioner`; rsc words `lotion|deodorant|toothpaste|lip balm|cream`)
  - `monthPnl({ financeEvents, culinaSkus: Set, cogsTable, skuToAsin, ads: { sp, sb, sd } | null }) -> { sales, fba, referral, promotions, refunds, cogs, contribution, adSpend: {sp, sb, sd, total} | null, freight, storage, couponFees, reimbursements, net | null, unassignedCampaigns: string[], unitShare }`
  - `comparePnl(curr, prev) -> rows [{ line, curr, prev, change }]`

Account-level service fees (inbound transport, placement, AWD transport/processing/storage, FBA storage, coupon/deal fees) and reimbursement adjustments are multiplied by `unitShare` = Culina units shipped ÷ all units shipped in the same events. Fee-type mapping: freight = `FBAInboundTransportationFee`, `FBAInboundConvenienceFee`, `AmazonUpstreamStorageTransportationFee`, `AWDMcdTransportationFee`; storage = `FBAStorageFee`, `FBALongTermStorageFee`, `STARStorageFee`, `AmazonUpstreamProcessingFee`; coupon = `CouponParticipationFee`, `CouponPerformanceFee`, `DealParticipationFee`, `DealPerformanceFee`; reimbursements = `AdjustmentEventList` types `WAREHOUSE_DAMAGE`, `WAREHOUSE_LOST`, `REVERSAL_REIMBURSEMENT`, `MISSING_FROM_INBOUND`, `MISSING_FROM_INBOUND_CLAWBACK`, `COMPENSATED_CLAWBACK`, `FREE_REPLACEMENT_REFUND_ITEMS`. `ads === null` → `adSpend` and `net` null.

- [ ] **Step 1: Failing tests** against a small fixture (2 Culina orders, 1 RSC order, one inbound fee of −100, Culina 2 of 3 units → freight −66.67); `assignCampaignBrand('SD - RM - VCPM - Body Lotions - B08GMCDMQ7 - EB', …)` → `'rsc'`; `'SB - PC - Search Terms3 - Broad - EB'` → `null` and appears in `unassignedCampaigns`; `ads: null` → `net === null`; no field named `agency` in output.
- [ ] **Step 2-4: Run FAIL, implement, run PASS.**
- [ ] **Step 5: Commit** `feat(culina-report): monthly P&L with allocated freight and storage`

### Task 6: Amazon data reads

**Files:**
- Create: `lib/culina-data.js`
- Test: `tests/lib/culina-data.test.js`

**Interfaces:**
- Consumes: SP-API `request`, Ads `runReport`, `getSearchVolume`.
- Produces (each takes `deps` for injection; all return plain data):
  - `fetchCulinaListings(deps) -> [{ asin, sku, title }]` from FBA summaries (`isCulinaTitle`)
  - `fetchDailyUnits(deps, asins, days = 120) -> Record<asin, {date, units}[]>` (orderMetrics, `granularity: 'Day'`, `America/Los_Angeles`, one ASIN per call, 2.5 s between calls, retry 429 up to 5×)
  - `fetchMonthlySales(deps, asins, fromMonth = '2026-03') -> [{ month, sales, units }]`
  - `fetchStock(deps) -> Record<asin, { fba, awd, inbound }>` (FBA summaries with details + AWD inventory, by SKU → ASIN)
  - `fetchFinance(deps, startISO, endISO) -> events` (paginate `NextToken`, 2.1 s between pages)
  - `fetchAdSpend(deps, startDate, endDate) -> { sp: rows, sb: rows, sd: rows } | null` (same report configs as `scripts/amazon/pull-ads-reports.mjs`; null on any failure, with the error returned beside it)
  - `fetchSeasonal(deps, keywords) -> monthlySearches[][]` (null on failure)

- [ ] **Step 1: Failing tests** with stubbed `request`: daily units parsed from an orderMetrics payload; a 429 then success retries; stock merges FBA and AWD for the same SKU; `fetchAdSpend` returns `null` plus error when `runReport` throws.
- [ ] **Step 2-4: Run FAIL, implement, run PASS.**
- [ ] **Step 5: Commit** `feat(culina-report): Amazon reads via Sales, Finance, inventory and Ads APIs`

### Task 7: Email rendering

**Files:**
- Create: `lib/culina-report-render.js`
- Test: `tests/lib/culina-report-render.test.js`

**Interfaces:**
- Produces: `renderMonthly(model) -> { subject, html, text }`, `renderAlert(rows) -> { subject, html, text }`.
- `model = { month, projection: [{label, onHand, coverDays, forecast30, forecast60, forecast90, shipBy, shipQty}], components: [{name, shipQty, sourced, orderBy}], forecastVsActual: [...]|null, monthlySales: [{month, sales}], pnl: comparePnl rows, unassignedCampaigns, sourceErrors: string[], goal: {lastMonth, target: [75000,100000], neededMonthlyGrowthPct} }`

Section order as in the spec: projection, forecast vs actual, monthly sales chart (HTML table bars, no SVG), P&L last month vs prior, goal progress. Inline CSS only (Gmail). Subject: `Culina monthly report: <Month YYYY>`; alert subject: `Culina stock alert: <n> item(s) low`.

- [ ] **Step 1: Failing tests**: html contains the five section headings in order; no `<svg`; no `—` (em dash) and no `agency` in html or text; `forecastVsActual: null` renders "First report, no prior forecast"; `sourceErrors: ['ads']` renders "Ad spend not available" and the P&L ad line shows "n/a", not `$0`; unassigned campaigns listed by name; values HTML-escaped.
- [ ] **Step 2-4: Run FAIL, implement, run PASS.**
- [ ] **Step 5: Commit** `feat(culina-report): monthly and alert email rendering`

### Task 8: The agent

**Files:**
- Create: `agents/culina-report/index.js`
- Modify: `.gitignore` (add `data/reports/culina-report/`)
- Test: `tests/agents/culina-report.test.js`

**Interfaces:**
- Consumes: Tasks 1-7.
- CLI: `node agents/culina-report/index.js --monthly [--month YYYY-MM] [--apply]` and `--alerts [--apply]`. Without `--apply`: writes `data/reports/culina-report/preview-<mode>.html`, prints a summary, sends nothing.
- State: `forecasts/YYYY-MM.json` (the 30-day forecast per ASIN made at the monthly run), `inventory/YYYY-MM-DD.json` (daily stock snapshot, written by `--alerts`, used for stockout days), `alerts-state.json`. Unreadable state throws rather than resetting.
- `--monthly` default month = previous calendar month (UTC). Finance window = that month; ads window = that month (two windows if > 31 days is impossible, so one).
- Ends with one deferred `notify({ category: 'amazon', status: 'success'|'info' })` row naming what was sent; `catch` → `status: 'error'`.

- [ ] **Step 1: Failing tests** (source scan plus injected run): entry uses `isDirectRun`; without `--apply` no `sendMail` call; with `--apply` the mail has `to: 'travis@traviswales.com'`, `cc: ['sean@realskincare.com']`, `via: 'resend'`; `--month 2026-10` sets finance window 2026-10-01..2026-10-31; a corrupt `alerts-state.json` throws.
- [ ] **Step 2-4: Run FAIL, implement, run PASS.**
- [ ] **Step 5: Dry run locally**: `node agents/culina-report/index.js --monthly --month 2026-10` and open the preview; sales should read ~$29,882 for October, P&L net near the prep-page figure. `--alerts` dry run should flag the 6-piece and 3-pack if not yet restocked.
- [ ] **Step 6: Commit** `feat(culina-report): monthly report and stock alert agent`

### Task 9: Schedule, backup and docs

**Files:**
- Modify: `scripts/setup-cron.sh`, `scripts/backup-snapshots-offsite.sh`, `CLAUDE.md`, `tests/scripts/` cron test if one pins the job list
- Memory: `project_culina_out_of_scope.md` (second exception)

- [ ] **Step 1:** Add `MONTHLY_CULINA_REPORT="30 14 10 * * cd \"$PROJECT_DIR\" && $NODE agents/culina-report/index.js --monthly --apply >> data/reports/scheduler/culina-report.log 2>&1"` and `DAILY_CULINA_STOCK_ALERTS="40 14 * * * … --alerts --apply …"`. Check `crontab -l` on the server for minute collisions first.
- [ ] **Step 2:** Add `data/reports/culina-report/` to the `server-state` backup set.
- [ ] **Step 3:** CLAUDE.md: a short paragraph under Architecture naming the agent, schedule, recipients, and that this is the second Culina exception (with PPC auditing). Update the out-of-scope memory to match.
- [ ] **Step 4:** Run `npm test` — expected all pass, check the cancelled count is 0.
- [ ] **Step 5:** Commit, push, `gh pr create`. After merge: deploy, run `scripts/setup-cron.sh` on the server, verify with the mirror diff in CLAUDE.md, then a dry `--monthly --month 2026-10` on the server before the first live run on 2026-12-10.
