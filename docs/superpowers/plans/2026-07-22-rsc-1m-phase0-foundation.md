# RSC $1M Plan — Phase 0 (Foundation & Measurement) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Live-production / Sean-owned tasks must NOT be executed autonomously by a subagent — they are gated on Sean's approval (marked `Owner: Sean` or `Gate: Sean approves`).**

**Goal:** Make RSC's funnel measurable and its offer paid-ready — so that when spend turns on in Phase 1, it's optimizing against *true* numbers, not GA4's 4× overcount, and pointing at an offer that converts.

**Architecture:** Five workstreams — (1) trustworthy tracking, (2) kill the 12% JS-error CVR leak, (3) build the offer architecture ($99 bundle + Set reframe), (4) Amazon lotion price test, (5) a KPI/gate scoreboard that reconciles GA4↔Shopify. Repo-codeable tasks (scoreboard, Amazon price script, bundle-creation script, JS-error diagnosis) are built and tested here; platform-config tasks (Meta CAPI, publishing copy, price change) are prepared here and executed by Sean.

**Tech Stack:** Node ESM scripts under `scripts/`; `lib/shopify.js`, `lib/ga4.js`, `lib/clarity.js`, `lib/amazon/sp-api-client.js`; Shopify Admin API `2025-01`; Amazon SP-API (production); Meta CAPI + Google Enhanced Conversions (platform config).

## Global Constraints

- Work on a branch; merge via PR. Never commit to `main`. (CLAUDE.md dev rules)
- Test a change on ONE entity before bulk-applying; verify live (curl 200 / read-back) after any Shopify- or Amazon-mutating action. (CLAUDE.md; `feedback_verify_live_after_mutating_agents`)
- New Shopify products/collections publish as **drafts** first (assign/verify before going live). (`project_content_pipeline_overhaul`)
- Measure in dollars, reconciled to Shopify orders — GA4 conversions are unreliable (4× overcount confirmed 2026-07-22). (`project_revenue_attribution_unreliable`)
- Amazon: RSC production creds via `AMAZON_SPAPI_ENV=production` + `AMAZON_SPAPI_PRODUCTION_*`. US marketplace `ATVPDKIKX0DER`.
- Offer copy: lead with value stack, NOT the "% off" markdown ($100M Offers). Never make the subscription the cold attraction offer ($100M Money Models).
- Verified baseline (2026-07-22): AOV ~$47.66; true CVR ~0.85%; ~2,125 sessions/mo; Clarity `scriptErrorPct` 12.4%; email list ~481; SMS 0; 7 live Klaviyo flows.

---

### Task 1: KPI & tracking-reconciliation scoreboard

**Why first:** it's the instrument every later gate reads, and it quantifies the tracking gap (GA4 vs Shopify) that Task 2 fixes. Fully repo-codeable and testable.

**Files:**
- Create: `scripts/growth-scoreboard.mjs`
- Create: `scripts/__tests__/growth-scoreboard.test.mjs`
- Consumes: `lib/ga4.js` `fetchLandingPagesByChannel(start,end)`, `lib/shopify.js` `getOrders(from,to)`
- Produces: `computeScoreboard({ga4Rows, orders})` → `{sessions, ga4Conversions, ga4Cvr, shopifyOrders, trueCvr, aov, ga4OvercountRatio, byChannel}` and a CLI that prints a 30-day scoreboard.

**Interfaces:**
- `computeScoreboard(input)` is pure (no network) so it's unit-testable; the CLI wrapper does the live pulls and calls it.

- [ ] **Step 1: Write the failing test** for the pure reducer.

```js
// scripts/__tests__/growth-scoreboard.test.mjs
import assert from 'node:assert';
import { test } from 'node:test';
import { computeScoreboard } from '../growth-scoreboard.mjs';

test('reconciles GA4 vs Shopify and flags overcount', () => {
  const ga4Rows = [
    { page: '/', channel: 'Direct', sessions: 100, conversions: 40, revenue: 100 },
    { page: '/blogs/news/x', channel: 'Organic Search', sessions: 900, conversions: 35, revenue: 20 },
  ];
  const orders = { count: 18, revenue: 858, aov: 47.66 };
  const s = computeScoreboard({ ga4Rows, orders });
  assert.equal(s.sessions, 1000);
  assert.equal(s.ga4Conversions, 75);
  assert.equal(s.shopifyOrders, 18);
  assert.equal(Number(s.trueCvr.toFixed(4)), 0.018);            // 18/1000
  assert.equal(Number(s.ga4Cvr.toFixed(4)), 0.075);             // 75/1000
  assert.equal(Number(s.ga4OvercountRatio.toFixed(2)), 4.17);   // 75/18
  assert.equal(s.aov, 47.66);
});
```

- [ ] **Step 2: Run it, verify it fails.** `node --test scripts/__tests__/growth-scoreboard.test.mjs` → FAIL (`computeScoreboard` not exported).

- [ ] **Step 3: Implement the reducer + CLI.**

```js
// scripts/growth-scoreboard.mjs
export function computeScoreboard({ ga4Rows, orders }) {
  const sessions = ga4Rows.reduce((s, r) => s + r.sessions, 0);
  const ga4Conversions = ga4Rows.reduce((s, r) => s + r.conversions, 0);
  const byChannel = {};
  for (const r of ga4Rows) {
    (byChannel[r.channel] ??= { sessions: 0, conversions: 0, revenue: 0 });
    byChannel[r.channel].sessions += r.sessions;
    byChannel[r.channel].conversions += r.conversions;
    byChannel[r.channel].revenue += r.revenue;
  }
  const shopifyOrders = orders.count;
  return {
    sessions, ga4Conversions, shopifyOrders,
    ga4Cvr: sessions ? ga4Conversions / sessions : 0,
    trueCvr: sessions ? shopifyOrders / sessions : 0,
    ga4OvercountRatio: shopifyOrders ? ga4Conversions / shopifyOrders : null,
    aov: orders.aov,
    byChannel,
  };
}

async function main() {
  const { fetchLandingPagesByChannel } = await import('../lib/ga4.js');
  const { getOrders } = await import('../lib/shopify.js');
  const end = new Date().toISOString().slice(0, 10);
  const startD = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const [ga4Rows, orders] = await Promise.all([
    fetchLandingPagesByChannel(startD, end),
    getOrders(startD, end),
  ]);
  const s = computeScoreboard({ ga4Rows, orders });
  console.log(`30d ${startD}..${end}`);
  console.log(`  sessions ${s.sessions} | Shopify orders ${s.shopifyOrders} | AOV $${s.aov}`);
  console.log(`  TRUE CVR ${(s.trueCvr * 100).toFixed(2)}% | GA4 CVR ${(s.ga4Cvr * 100).toFixed(2)}% | GA4 overcount ${s.ga4OvercountRatio?.toFixed(2)}x`);
}
if (import.meta.url === `file://${process.argv[1]}`) main();
```

- [ ] **Step 4: Run test, verify PASS.** `node --test scripts/__tests__/growth-scoreboard.test.mjs` → PASS.

- [ ] **Step 5: Run the live CLI** `node scripts/growth-scoreboard.mjs` → prints a real 30-day scoreboard. **Acceptance:** overcount ratio prints ~3–5× (matches the manual finding), confirming the reducer works on live data.

- [ ] **Step 6: Commit.** `git add scripts/growth-scoreboard.mjs scripts/__tests__/growth-scoreboard.test.mjs && git commit -m "feat(growth): KPI scoreboard reconciling GA4 vs Shopify (true CVR + overcount)"`

---

### Task 2: Diagnose & fix the 12.4% JS-error CVR leak

**Owner:** Claude diagnoses; **Gate: Sean approves** the theme edit before it goes live (theme code is outward-facing).

**Files:**
- Create: `data/reports/cro/js-error-diagnosis-2026-07-22.md` (findings)
- Modify: Shopify theme (identified erroring script) — **only after Sean approves**

- [ ] **Step 1: Reproduce.** Load the homepage + a PDP + checkout in a headless browser (or Sean shares a Clarity session recording filtered to `ScriptError`). Capture the console errors and the failing script URL/line.

```bash
# if puppeteer/playwright available; else Sean pulls Clarity recordings tagged ScriptError
node scripts/capture-console-errors.mjs https://www.realskincare.com/ https://www.realskincare.com/products/sensitive-skin-starter-set
```

- [ ] **Step 2: Classify** each error: theme code vs a Shopify app (Zipify/Recurpay/Judge.me/Klaviyo/tracking pixel). Write findings + the exact offending file:line to the diagnosis report. **Acceptance:** the report names the specific script(s) causing ≥ the bulk of the 12.4%.

- [ ] **Step 3: Determine blast radius.** Confirm whether the error breaks add-to-cart, checkout, or a tracking pixel (the last would corrupt Task 3 data). Note it explicitly.

- [ ] **Step 4 (Gate: Sean approves):** apply the minimal theme/app fix. If it's an app conflict, the fix may be Sean toggling/reconfiguring the app rather than a code edit.

- [ ] **Step 5: Verify live.** Re-run Step 1 capture → target script no longer errors. Re-pull Clarity after 3 days: `node -e "import('./lib/clarity.js').then(m=>m.fetchClarityInsights({numOfDays:3}).then(c=>console.log(c.behavior)))"` → **Acceptance:** `scriptErrorPct` trending down from 12.4%.

- [ ] **Step 6: Commit** the diagnosis report (+ theme fix if code). `git add data/reports/cro/js-error-diagnosis-2026-07-22.md && git commit -m "fix(cro): diagnose + fix homepage/PDP JS errors (12.4% -> lower)"`

---

### Task 3: Server-side conversion tracking (Meta CAPI + Google Enhanced Conversions)

**Owner: Sean** (platform config in Shopify admin / Meta Events Manager / Google Ads). Claude provides the reconciliation check and the runbook.

**Files:**
- Create: `docs/runbooks/2026-07-22-conversion-tracking-setup.md` (step-by-step Sean runbook)
- Reuse: `scripts/growth-scoreboard.mjs` (Task 1) as the acceptance instrument

- [ ] **Step 1 (Claude): Write the runbook** covering: install/verify the Meta pixel + **Conversions API** via Shopify's native Facebook & Instagram channel (or Meta's Shopify app); enable **Google Enhanced Conversions** in Google Ads ↔ GA4 linkage; confirm the `purchase` event fires server-side with order value + order id; deduplication (event_id) so browser+server don't double-count.

- [ ] **Step 2 (Sean): Execute** the runbook. Fire 2–3 real test orders (or Shopify's test mode).

- [ ] **Step 3 (Claude): Reconcile.** Run `node scripts/growth-scoreboard.mjs` and compare Meta Events Manager "Purchases" + GA4 `purchase` count against Shopify orders for the same window. **Acceptance / PHASE-0 GATE:** platform purchase counts match Shopify orders within ~±10% (no more 4× overcount).

- [ ] **Step 4: Commit** the runbook. `git add docs/runbooks/2026-07-22-conversion-tracking-setup.md && git commit -m "docs(runbook): server-side conversion tracking setup + reconciliation gate"`

---

### Task 4: Build the $99 "90-Day Coconut Reset" bundle (draft) + reframe the Set copy

**Owner:** Claude creates the bundle product as a **draft** and drafts the Set PDP copy; **Gate: Sean approves/publishes.**

**Files:**
- Create: `scripts/create-coconut-reset-bundle.mjs` (idempotent; creates the product as draft if absent)
- Create: `data/offers/sensitive-set-reframe-copy.md` (value-stack PDP + guarantee copy for Sean/theme)
- Consumes: `lib/shopify.js` `getProducts()`, and add a `createProduct(fields)` helper if not present (`shopifyRequest('POST','/products.json', …)`)

**Interfaces:**
- Bundle: title "90-Day Coconut Reset", 3× Body Lotion + 1× Coconut Moisturizer, price **$99.00**, status **draft**, tagged `bundle`, SKU `RSC-BUN-90RESET`.

- [ ] **Step 1: Confirm `createProduct` exists** in `lib/shopify.js`; if not, add it (mirror `updateProduct` at `lib/shopify.js:299`). Show the code:

```js
export async function createProduct(fields) {
  const data = await shopifyRequest('POST', '/products.json', { product: fields });
  return data.product;
}
```

- [ ] **Step 2: Write the idempotent creation script.**

```js
// scripts/create-coconut-reset-bundle.mjs
import { getProducts, createProduct } from '../lib/shopify.js';
const TITLE = '90-Day Coconut Reset';
const existing = (await getProducts()).find(p => p.title === TITLE);
if (existing) { console.log('Bundle already exists (draft/live):', existing.id, existing.status); process.exit(0); }
const product = await createProduct({
  title: TITLE,
  body_html: '<p>90 days of calm, non-reactive skin. 3× our 6-ingredient Body Lotion + our overnight Coconut Moisturizer. Free Bar Soap + Lip Balm included.</p>',
  vendor: 'Real Skin Care',
  status: 'draft',
  tags: 'bundle,skin,acquisition-offer',
  variants: [{ price: '99.00', sku: 'RSC-BUN-90RESET', inventory_management: null }],
});
console.log('Created DRAFT bundle:', product.id, '— assign images + verify, then Sean publishes.');
```

- [ ] **Step 3: Run it.** `node scripts/create-coconut-reset-bundle.mjs` → prints created draft id. **Verify live (read-back):** `node -e "import('./lib/shopify.js').then(m=>m.getProducts().then(ps=>console.log(ps.filter(p=>p.title==='90-Day Coconut Reset').map(p=>({id:p.id,status:p.status,price:p.variants[0].price})))))"` → shows `status: 'draft'`, `price: '99.00'`.

- [ ] **Step 4: Draft the Set-reframe copy** to `data/offers/sensitive-set-reframe-copy.md`: value stack (Lotion $30 + Cream $28 + free Lip Balm $15 + free Bar Soap $11 + "$39" info bonuses + free ship = ~$115 value → your price $46.80); Buy-X-Get-Y headline ("free Bar Soap + Lip Balm today"); MAGIC name ("14-Day Sensitive-Skin Calm-Down System"); named guarantee ("The Calm-Skin Promise — 30 days, keep the products"). No leading "% off".

- [ ] **Step 5 (Gate: Sean):** Sean adds images to the bundle, reviews copy, and publishes the bundle + applies the Set copy. **Acceptance:** bundle live at a clean URL; Set PDP leads with value stack, not markdown.

- [ ] **Step 6: Commit.** `git add scripts/create-coconut-reset-bundle.mjs lib/shopify.js data/offers/sensitive-set-reframe-copy.md && git commit -m "feat(offer): $99 Coconut Reset bundle (draft) + Set value-stack reframe copy"`

---

### Task 5: Amazon lotion price test ($21.99 → $25.99)

**Owner:** Claude writes the script; **Gate: Sean approves** the actual price change (live marketplace, affects buy-box).

**Files:**
- Create: `scripts/amazon-set-price.mjs` (single-SKU, prints before/after; requires `--apply` to write)
- Consumes: `lib/amazon/sp-api-client.js` `getClient`, `request`, `getMarketplaceId`

- [ ] **Step 1: Write the script** using the SP-API Listings Items API `PATCH /listings/2021-08-01/items/{sellerId}/{sku}` (or Product Pricing to read current). Default is **dry-run** (read + print intended change); `--apply` performs the PATCH. Target the lotion SKU `RSC-LO-CB-08-FBA-stickerless` (ASIN B09QJFBPJ1) first.

- [ ] **Step 2: Dry-run.** `node scripts/amazon-set-price.mjs RSC-LO-CB-08-FBA-stickerless 25.99` → prints "current $21.99 → new $25.99 (dry-run, pass --apply to write)". **Acceptance:** reads current price live without error.

- [ ] **Step 3 (Gate: Sean approves):** `node scripts/amazon-set-price.mjs RSC-LO-CB-08-FBA-stickerless 25.99 --apply` → 200/accepted.

- [ ] **Step 4: Verify live.** Re-run dry-run after ~15 min → current price reads $25.99. Watch buy-box + units for 7–14 days via existing Amazon reporting. **Acceptance:** price updated, buy-box retained.

- [ ] **Step 5: Commit.** `git add scripts/amazon-set-price.mjs && git commit -m "feat(amazon): single-SKU price script + lotion $21.99->$25.99 test"`

---

## Phase 0 exit gate (all must hold before Phase 1 spend)

- [ ] Task 3 reconciliation: platform purchases match Shopify orders within ~±10% (tracking is trustworthy).
- [ ] Task 2: `scriptErrorPct` trending down from 12.4%.
- [ ] Task 4: $99 bundle live + Set reframed (offer paid-ready).
- [ ] Task 1: scoreboard runs and is the standing KPI instrument.
- [ ] Task 5: Amazon lotion price test applied (independent near-term margin win).

---

## Self-review notes

- **Spec coverage:** Phase 0 items from spec §13 map 1:1 — tracking (Task 3), JS errors (Task 2), $99 bundle + Set reframe (Task 4), Amazon price (Task 5), KPI scoreboard (Task 1), fresh-data instrument (Task 1). Free-quiz lead magnet is deferred to Phase 1 (it feeds traffic, not foundation).
- **Owners explicit:** every live-mutation/config task is gated on Sean; only pure repo code (Tasks 1, and the script-authoring in 4/5) runs autonomously.
- **Verification-based acceptance** used where TDD doesn't fit (config/live mutation); real unit test only where a pure function exists (Task 1).
