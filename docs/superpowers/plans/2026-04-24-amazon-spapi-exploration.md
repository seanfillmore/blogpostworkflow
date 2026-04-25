# Amazon SP-API Exploration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a hand-rolled SP-API client plus seven exploration scripts so the user can eyeball representative Amazon Seller Central data and decide which sources are useful for business decisions.

**Architecture:** One client library (`lib/amazon/sp-api-client.js`) with LWA token exchange, request helpers, and three report helpers. Seven standalone scripts under `scripts/amazon/` call the client directly. No agent harness, no scheduling, no persistent storage beyond JSON dumps in `data/amazon-explore/` (git-ignored). Environment switch (`AMAZON_SPAPI_ENV=sandbox|production`) defaults to production.

**Tech Stack:** Node.js (ESM — `"type": "module"` in package.json), built-in `fetch`, `node:zlib` for gzip, `dotenv`. No new npm dependencies.

**Spec reference:** [docs/superpowers/specs/2026-04-24-amazon-spapi-exploration-design.md](../specs/2026-04-24-amazon-spapi-exploration-design.md)

**Branch:** `feature/amazon-spapi-exploration` (already created)

---

## File Structure

Will create:
- `lib/amazon/sp-api-client.js` — SP-API client library (~230 lines)
- `scripts/amazon/README.md` — usage guide
- `scripts/amazon/explore-marketplaces.mjs` — smoke-test script
- `scripts/amazon/explore-orders.mjs`
- `scripts/amazon/explore-inventory.mjs`
- `scripts/amazon/explore-listings.mjs`
- `scripts/amazon/explore-finance.mjs`
- `scripts/amazon/explore-brand-analytics.mjs`
- `scripts/amazon/explore-sales-traffic.mjs`

Will modify:
- `.gitignore` — add `data/amazon-explore/`

**Testing approach:** Per the spec, no unit tests. Each script IS the test — running it against sandbox (to validate wiring) and/or production (to validate real data return). Verification commands are spelled out per task.

**Sandbox caveat:** The sandbox refresh token the user currently has in `.env` starts with `AAtzr|` (double-A), which looks like a typo during paste. If any sandbox-env run returns 401, skip sandbox validation and go straight to production for that task — note it in the commit message so we can fix the token later.

---

## Task 1: Git-ignore the data dump directory

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add entry to .gitignore**

Open `.gitignore`. Find the line `amazon_product_photos/`. Add a new line directly below it:

```
data/amazon-explore/
```

- [ ] **Step 2: Verify the pattern works**

Run:
```bash
mkdir -p data/amazon-explore && touch data/amazon-explore/test.json && git status data/amazon-explore/
```

Expected: `data/amazon-explore/` should NOT appear in git status (it's ignored). If it does appear, the gitignore line didn't take.

Clean up:
```bash
rm data/amazon-explore/test.json
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "chore: git-ignore data/amazon-explore/ dumps"
```

---

## Task 2: Create SP-API client library (auth + request)

**Files:**
- Create: `lib/amazon/sp-api-client.js`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p lib/amazon
```

- [ ] **Step 2: Write the client with env loader, LWA exchange, and request function**

Create `lib/amazon/sp-api-client.js` with this content:

```js
/**
 * Amazon SP-API client (hand-rolled, minimal).
 *
 * Usage:
 *   import { getClient, request } from '../../lib/amazon/sp-api-client.js';
 *   const client = getClient();
 *   const data = await request(client, 'GET', '/sellers/v1/marketplaceParticipations');
 *
 * Env switch: AMAZON_SPAPI_ENV=sandbox|production (default production).
 */

import 'dotenv/config';

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const MARKETPLACE_ID_US = 'ATVPDKIKX0DER';

const ENV_CONFIG = {
  production: {
    baseUrl: 'https://sellingpartnerapi-na.amazon.com',
    appIdVar: 'AMAZON_SPAPI_PRODUCTION_APP_ID',
    clientIdVar: 'AMAZON_SPAPI_PRODUCTION_LWA_CLIENT_ID',
    clientSecretVar: 'AMAZON_SPAPI_PRODUCTION_LWA_CLIENT_SECRET',
    refreshTokenVar: 'AMAZON_SPAPI_PRODUCTION_REFRESH_TOKEN',
  },
  sandbox: {
    baseUrl: 'https://sandbox.sellingpartnerapi-na.amazon.com',
    appIdVar: 'AMAZON_SPAPI_SANDBOX_APP_ID',
    clientIdVar: 'AMAZON_SPAPI_SANDBOX_LWA_CLIENT_ID',
    clientSecretVar: 'AMAZON_SPAPI_SANDBOX_LWA_CLIENT_SECRET',
    refreshTokenVar: 'AMAZON_SPAPI_SANDBOX_REFRESH_TOKEN',
  },
};

export function getMarketplaceId() {
  return MARKETPLACE_ID_US;
}

export function getClient() {
  const env = process.env.AMAZON_SPAPI_ENV || 'production';
  const config = ENV_CONFIG[env];
  if (!config) {
    throw new Error(`Invalid AMAZON_SPAPI_ENV: "${env}". Must be "production" or "sandbox".`);
  }

  const clientId = process.env[config.clientIdVar];
  const clientSecret = process.env[config.clientSecretVar];
  const refreshToken = process.env[config.refreshTokenVar];

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      `Missing SP-API credentials for env "${env}". ` +
      `Required: ${config.clientIdVar}, ${config.clientSecretVar}, ${config.refreshTokenVar}`
    );
  }

  return {
    env,
    baseUrl: config.baseUrl,
    clientId,
    clientSecret,
    refreshToken,
    accessToken: null,
    expiresAt: 0,
  };
}

async function getAccessToken(client) {
  const now = Date.now();
  if (client.accessToken && client.expiresAt - now > 60_000) {
    return client.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: client.refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });

  const res = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LWA token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  client.accessToken = data.access_token;
  client.expiresAt = now + data.expires_in * 1000;
  return client.accessToken;
}

export async function request(client, method, path, params = null, attempt = 1) {
  const accessToken = await getAccessToken(client);

  let url = `${client.baseUrl}${path}`;
  let body = null;

  if ((method === 'GET' || method === 'DELETE') && params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      qs.append(k, Array.isArray(v) ? v.join(',') : String(v));
    }
    const queryStr = qs.toString();
    if (queryStr) url += `?${queryStr}`;
  } else if (params) {
    body = JSON.stringify(params);
  }

  const res = await fetch(url, {
    method,
    headers: {
      'x-amz-access-token': accessToken,
      'Content-Type': 'application/json',
    },
    body,
  });

  if (res.status === 429 && attempt <= 3) {
    const retryAfter = parseFloat(res.headers.get('Retry-After') || '1');
    const sleepMs = Math.max(retryAfter * 1000, 1000);
    console.warn(`Rate limited (attempt ${attempt}/3); sleeping ${sleepMs}ms`);
    await new Promise((r) => setTimeout(r, sleepMs));
    return request(client, method, path, params, attempt + 1);
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON (e.g., report document). Callers using request() expect JSON; downloadReport handles non-JSON.
  }

  if (!res.ok) {
    throw new Error(`SP-API ${method} ${path} failed (${res.status}): ${text}`);
  }

  return data;
}
```

- [ ] **Step 3: Syntax check the file**

Run:
```bash
node --check lib/amazon/sp-api-client.js
```

Expected: no output (success). If output, read the error and fix.

- [ ] **Step 4: Verify the client loads env correctly**

Run a one-liner to confirm `getClient()` doesn't throw:
```bash
node -e "import('./lib/amazon/sp-api-client.js').then(m => { const c = m.getClient(); console.log('env:', c.env, 'baseUrl:', c.baseUrl); })"
```

Expected output:
```
env: production baseUrl: https://sellingpartnerapi-na.amazon.com
```

- [ ] **Step 5: Commit**

```bash
git add lib/amazon/sp-api-client.js
git commit -m "feat(amazon): add minimal SP-API client with LWA auth + request helper"
```

---

## Task 3: Create smoke-test script — explore-marketplaces.mjs

This is the end-to-end wiring test. If this works, the client is good.

**Files:**
- Create: `scripts/amazon/explore-marketplaces.mjs`

- [ ] **Step 1: Create the directory**

```bash
mkdir -p scripts/amazon
```

- [ ] **Step 2: Write the script**

Create `scripts/amazon/explore-marketplaces.mjs`:

```js
/**
 * SP-API smoke test: list marketplace participations.
 *
 * Runs GET /sellers/v1/marketplaceParticipations and dumps the full response.
 * This is the wiring test - if this works, the client is good.
 *
 * Usage:
 *   node scripts/amazon/explore-marketplaces.mjs
 *   AMAZON_SPAPI_ENV=sandbox node scripts/amazon/explore-marketplaces.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { getClient, request } from '../../lib/amazon/sp-api-client.js';

const client = getClient();
console.log(`Hitting ${client.env} endpoint: ${client.baseUrl}`);
console.log('Calling GET /sellers/v1/marketplaceParticipations...');

const data = await request(client, 'GET', '/sellers/v1/marketplaceParticipations');
const rows = data?.payload || [];

console.log(`\nMarketplaces returned: ${rows.length}`);
for (const m of rows) {
  const name = m.marketplace?.name ?? '(unknown)';
  const id = m.marketplace?.id ?? '(unknown)';
  const participating = m.participation?.isParticipating ? 'active' : 'inactive';
  console.log(`  - ${name} (${id}) - ${participating}`);
}

const outDir = 'data/amazon-explore';
mkdirSync(outDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const outPath = `${outDir}/${today}-marketplaces-${client.env}.json`;
writeFileSync(outPath, JSON.stringify(data, null, 2));
console.log(`\nDump: ${outPath}`);
```

- [ ] **Step 3: Syntax check**

Run:
```bash
node --check scripts/amazon/explore-marketplaces.mjs
```

Expected: no output.

- [ ] **Step 4: Run against sandbox (validates wiring, not data)**

Run:
```bash
AMAZON_SPAPI_ENV=sandbox node scripts/amazon/explore-marketplaces.mjs
```

Expected: a 2xx response with either canned sandbox data or an empty array. Output should look like:
```
Hitting sandbox endpoint: https://sandbox.sellingpartnerapi-na.amazon.com
Calling GET /sellers/v1/marketplaceParticipations...

Marketplaces returned: <N>
  - ...

Dump: data/amazon-explore/2026-04-24-marketplaces-sandbox.json
```

**If sandbox returns 401** — the `AAtzr|` prefix on the sandbox refresh token was a typo. Skip sandbox for this task, note in commit message, and continue to Step 5.

- [ ] **Step 5: Run against production (validates real data)**

Run:
```bash
node scripts/amazon/explore-marketplaces.mjs
```

Expected output:
```
Hitting production endpoint: https://sellingpartnerapi-na.amazon.com
Calling GET /sellers/v1/marketplaceParticipations...

Marketplaces returned: 1
  - Amazon.com (ATVPDKIKX0DER) - active

Dump: data/amazon-explore/2026-04-24-marketplaces-production.json
```

If this returns 401 or 403, stop and surface the error — credentials or role scope is wrong.

- [ ] **Step 6: Inspect the JSON dump**

Run:
```bash
ls -la data/amazon-explore/
cat data/amazon-explore/*-marketplaces-production.json | head -40
```

Expected: JSON with a `payload` array. Each entry has `marketplace` + `participation` objects.

- [ ] **Step 7: Commit**

```bash
git add scripts/amazon/explore-marketplaces.mjs
git commit -m "feat(amazon): add marketplaces smoke-test script"
```

If sandbox was skipped due to the typo, append `(sandbox skipped - refresh token prefix issue, see .env)` to the commit body.

---

## Task 4: Add report helpers to the SP-API client

**Files:**
- Modify: `lib/amazon/sp-api-client.js`

- [ ] **Step 1: Append report helpers to the client**

Add to the end of `lib/amazon/sp-api-client.js`:

```js
/**
 * Report helpers (async SP-API Reports flow).
 *
 * Usage:
 *   const reportId = await requestReport(client, 'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT', [getMarketplaceId()], startIso, endIso);
 *   const reportDocumentId = await pollReport(client, reportId);
 *   const rows = await downloadReport(client, reportDocumentId);
 */

export async function requestReport(client, reportType, marketplaceIds, dataStartTime, dataEndTime, reportOptions = null) {
  const body = {
    reportType,
    marketplaceIds: Array.isArray(marketplaceIds) ? marketplaceIds : [marketplaceIds],
  };
  if (dataStartTime) body.dataStartTime = dataStartTime;
  if (dataEndTime) body.dataEndTime = dataEndTime;
  if (reportOptions) body.reportOptions = reportOptions;

  const data = await request(client, 'POST', '/reports/2021-06-30/reports', body);
  return data.reportId;
}

export async function pollReport(client, reportId, { intervalMs = 30000, maxWaitMs = 600000 } = {}) {
  const startedAt = Date.now();
  while (true) {
    const data = await request(client, 'GET', `/reports/2021-06-30/reports/${reportId}`);
    const status = data.processingStatus;
    console.log(`Report ${reportId} status: ${status}`);

    if (status === 'DONE') return data.reportDocumentId;
    if (status === 'CANCELLED' || status === 'FATAL') {
      throw new Error(`Report ${reportId} ended with status ${status}: ${JSON.stringify(data)}`);
    }
    if (Date.now() - startedAt > maxWaitMs) {
      throw new Error(`Report ${reportId} did not complete within ${maxWaitMs}ms (last status: ${status})`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function downloadReport(client, reportDocumentId) {
  const meta = await request(client, 'GET', `/reports/2021-06-30/documents/${reportDocumentId}`);

  const res = await fetch(meta.url);
  if (!res.ok) {
    throw new Error(`Report document download failed (${res.status}) for ${reportDocumentId}`);
  }

  let bytes = Buffer.from(await res.arrayBuffer());
  if (meta.compressionAlgorithm === 'GZIP') {
    const { gunzipSync } = await import('node:zlib');
    bytes = gunzipSync(bytes);
  }

  const text = bytes.toString('utf-8');
  const trimmed = text.trimStart();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(text);
  }

  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const headers = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const fields = line.split('\t');
    const row = {};
    headers.forEach((h, i) => {
      row[h] = fields[i];
    });
    return row;
  });
}
```

- [ ] **Step 2: Syntax check**

Run:
```bash
node --check lib/amazon/sp-api-client.js
```

Expected: no output.

- [ ] **Step 3: Verify exports are picked up**

Run:
```bash
node -e "import('./lib/amazon/sp-api-client.js').then(m => console.log(Object.keys(m).sort().join(', ')))"
```

Expected output:
```
downloadReport, getClient, getMarketplaceId, pollReport, request, requestReport
```

- [ ] **Step 4: Commit**

```bash
git add lib/amazon/sp-api-client.js
git commit -m "feat(amazon): add Reports API helpers (request/poll/download)"
```

---

## Task 5: Create explore-orders.mjs

**Files:**
- Create: `scripts/amazon/explore-orders.mjs`

- [ ] **Step 1: Write the script**

Create `scripts/amazon/explore-orders.mjs`:

```js
/**
 * Fetch last 30 days of orders. Summarize count + revenue + top SKUs.
 *
 * Usage:
 *   node scripts/amazon/explore-orders.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { getClient, request, getMarketplaceId } from '../../lib/amazon/sp-api-client.js';

const client = getClient();
console.log(`Hitting ${client.env} endpoint: ${client.baseUrl}`);

const createdAfter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
const marketplaceId = getMarketplaceId();

console.log(`Calling GET /orders/v0/orders (CreatedAfter=${createdAfter})...`);

let allOrders = [];
let nextToken = null;
do {
  const params = nextToken
    ? { NextToken: nextToken, MarketplaceIds: marketplaceId }
    : { CreatedAfter: createdAfter, MarketplaceIds: marketplaceId };
  const data = await request(client, 'GET', '/orders/v0/orders', params);
  const orders = data?.payload?.Orders ?? [];
  allOrders = allOrders.concat(orders);
  nextToken = data?.payload?.NextToken ?? null;
  console.log(`  fetched ${orders.length} (total: ${allOrders.length})`);
} while (nextToken);

let totalRevenue = 0;
for (const order of allOrders) {
  const amount = parseFloat(order.OrderTotal?.Amount ?? '0');
  if (!Number.isNaN(amount)) totalRevenue += amount;
}

console.log(`\nOrders: ${allOrders.length}`);
console.log(`Revenue (orders total): ${totalRevenue.toFixed(2)} USD`);
console.log('(SKU-level top-N would require a second call to /orders/v0/orders/{orderId}/orderItems - deferred)');

const outDir = 'data/amazon-explore';
mkdirSync(outDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const outPath = `${outDir}/${today}-orders-${client.env}.json`;
writeFileSync(outPath, JSON.stringify({ createdAfter, marketplaceId, orders: allOrders }, null, 2));
console.log(`\nDump: ${outPath}`);
```

- [ ] **Step 2: Syntax check**

Run:
```bash
node --check scripts/amazon/explore-orders.mjs
```

Expected: no output.

- [ ] **Step 3: Run against production**

Run:
```bash
node scripts/amazon/explore-orders.mjs
```

Expected: counts and revenue for the last 30 days. If 0 orders, note it and move on — still a valid result. On 403, surface the error (Orders role may not be active).

- [ ] **Step 4: Commit**

```bash
git add scripts/amazon/explore-orders.mjs
git commit -m "feat(amazon): add orders exploration script (last 30 days)"
```

---

## Task 6: Create explore-inventory.mjs

**Files:**
- Create: `scripts/amazon/explore-inventory.mjs`

- [ ] **Step 1: Write the script**

Create `scripts/amazon/explore-inventory.mjs`:

```js
/**
 * Fetch FBA inventory summary. Lists SKUs and fulfillable quantities.
 *
 * Usage:
 *   node scripts/amazon/explore-inventory.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { getClient, request, getMarketplaceId } from '../../lib/amazon/sp-api-client.js';

const client = getClient();
console.log(`Hitting ${client.env} endpoint: ${client.baseUrl}`);

const marketplaceId = getMarketplaceId();
console.log('Calling GET /fba/inventory/v1/summaries...');

let allItems = [];
let nextToken = null;
do {
  const params = {
    granularityType: 'Marketplace',
    granularityId: marketplaceId,
    marketplaceIds: marketplaceId,
    details: 'true',
  };
  if (nextToken) params.nextToken = nextToken;

  const data = await request(client, 'GET', '/fba/inventory/v1/summaries', params);
  const items = data?.payload?.inventorySummaries ?? [];
  allItems = allItems.concat(items);
  nextToken = data?.pagination?.nextToken ?? null;
  console.log(`  fetched ${items.length} (total: ${allItems.length})`);
} while (nextToken);

let totalFulfillable = 0;
for (const it of allItems) {
  totalFulfillable += it.inventoryDetails?.fulfillableQuantity ?? 0;
}

console.log(`\nSKUs in FBA: ${allItems.length}`);
console.log(`Total fulfillable units: ${totalFulfillable}`);

const outDir = 'data/amazon-explore';
mkdirSync(outDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const outPath = `${outDir}/${today}-inventory-${client.env}.json`;
writeFileSync(outPath, JSON.stringify({ marketplaceId, items: allItems }, null, 2));
console.log(`\nDump: ${outPath}`);
```

- [ ] **Step 2: Syntax check and run**

```bash
node --check scripts/amazon/explore-inventory.mjs
node scripts/amazon/explore-inventory.mjs
```

Expected: a list of SKU counts + total units. If role not approved → 403; surface and note.

- [ ] **Step 3: Commit**

```bash
git add scripts/amazon/explore-inventory.mjs
git commit -m "feat(amazon): add FBA inventory exploration script"
```

---

## Task 7: Create explore-listings.mjs

**Files:**
- Create: `scripts/amazon/explore-listings.mjs`
- Modify: `.env` (add `AMAZON_SPAPI_SELLER_ID`)

The Listings API path is `GET /listings/2021-08-01/items/{sellerId}` where `{sellerId}` is your **Merchant Token** — a string like `A1XXXXXXX`. This isn't derivable from the other endpoints; you grab it from Seller Central once and store it in `.env`.

- [ ] **Step 1: Have the user fetch the Merchant Token**

Ask the user to:
1. Go to Seller Central → **Settings** → **Account Info** → **Your Merchant Token** (URL: `https://sellercentral.amazon.com/sw/AccountInfo/MerchantToken/`)
2. Copy the token (starts with `A`, ~14 characters)
3. Add to `.env`:

```
AMAZON_SPAPI_SELLER_ID=<the Merchant Token>
```

Wait for user confirmation before moving on. Verify it's set:

```bash
grep -c '^AMAZON_SPAPI_SELLER_ID=' .env
```

Expected: `1`. If `0`, stop and re-request from user.

- [ ] **Step 2: Write the script**

Create `scripts/amazon/explore-listings.mjs`:

```js
/**
 * Fetch active catalog listings for the seller.
 *
 * Usage:
 *   node scripts/amazon/explore-listings.mjs
 */

import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { getClient, request, getMarketplaceId } from '../../lib/amazon/sp-api-client.js';

const sellerId = process.env.AMAZON_SPAPI_SELLER_ID;
if (!sellerId) {
  throw new Error(
    'AMAZON_SPAPI_SELLER_ID not set. Get your Merchant Token from Seller Central → Settings → Account Info → Your Merchant Token.',
  );
}

const client = getClient();
console.log(`Hitting ${client.env} endpoint: ${client.baseUrl}`);
console.log(`Seller ID: ${sellerId}`);

const marketplaceId = getMarketplaceId();
console.log(`Calling GET /listings/2021-08-01/items/${sellerId}...`);

let allItems = [];
let pageToken = null;
do {
  const params = {
    marketplaceIds: marketplaceId,
    includedData: 'summaries,attributes',
    pageSize: 20,
  };
  if (pageToken) params.pageToken = pageToken;

  const data = await request(
    client,
    'GET',
    `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}`,
    params,
  );
  const items = data?.items ?? [];
  allItems = allItems.concat(items);
  pageToken = data?.pagination?.nextToken ?? null;
  console.log(`  fetched ${items.length} (total: ${allItems.length})`);
} while (pageToken);

console.log(`\nListings: ${allItems.length}`);

const outDir = 'data/amazon-explore';
mkdirSync(outDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const outPath = `${outDir}/${today}-listings-${client.env}.json`;
writeFileSync(outPath, JSON.stringify({ sellerId, marketplaceId, items: allItems }, null, 2));
console.log(`\nDump: ${outPath}`);
```

- [ ] **Step 3: Syntax check and run**

```bash
node --check scripts/amazon/explore-listings.mjs
node scripts/amazon/explore-listings.mjs
```

Expected: list of listings with ASINs. On 403, note in commit — listings role may not be active.

- [ ] **Step 4: Commit**

```bash
git add scripts/amazon/explore-listings.mjs
git commit -m "feat(amazon): add listings catalog exploration script"
```

---

## Task 8: Create explore-finance.mjs

**Files:**
- Create: `scripts/amazon/explore-finance.mjs`

- [ ] **Step 1: Write the script**

Create `scripts/amazon/explore-finance.mjs`:

```js
/**
 * Fetch recent financial events (settlements, refunds, fees) - last 30 days.
 *
 * Usage:
 *   node scripts/amazon/explore-finance.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { getClient, request } from '../../lib/amazon/sp-api-client.js';

const client = getClient();
console.log(`Hitting ${client.env} endpoint: ${client.baseUrl}`);

const postedAfter = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

console.log(`Calling GET /finances/v0/financialEvents (PostedAfter=${postedAfter})...`);

let allEvents = { ShipmentEventList: [], RefundEventList: [], ServiceFeeEventList: [] };
let nextToken = null;

do {
  const params = nextToken ? { NextToken: nextToken } : { PostedAfter: postedAfter };
  const data = await request(client, 'GET', '/finances/v0/financialEvents', params);
  const events = data?.payload?.FinancialEvents ?? {};
  for (const key of Object.keys(events)) {
    if (Array.isArray(events[key])) {
      allEvents[key] = (allEvents[key] ?? []).concat(events[key]);
    } else {
      allEvents[key] = events[key];
    }
  }
  nextToken = data?.payload?.NextToken ?? null;
  console.log(`  page fetched; NextToken=${nextToken ? 'yes' : 'no'}`);
} while (nextToken);

console.log(`\nShipment events: ${allEvents.ShipmentEventList?.length ?? 0}`);
console.log(`Refund events: ${allEvents.RefundEventList?.length ?? 0}`);
console.log(`Service fee events: ${allEvents.ServiceFeeEventList?.length ?? 0}`);

const outDir = 'data/amazon-explore';
mkdirSync(outDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const outPath = `${outDir}/${today}-finance-${client.env}.json`;
writeFileSync(outPath, JSON.stringify({ postedAfter, events: allEvents }, null, 2));
console.log(`\nDump: ${outPath}`);
```

- [ ] **Step 2: Syntax check and run**

```bash
node --check scripts/amazon/explore-finance.mjs
node scripts/amazon/explore-finance.mjs
```

Expected: counts of shipment/refund/fee events. Could be slow — financial events endpoint is heavily paginated.

- [ ] **Step 3: Commit**

```bash
git add scripts/amazon/explore-finance.mjs
git commit -m "feat(amazon): add finance events exploration script"
```

---

## Task 9: Create explore-brand-analytics.mjs (uses Reports API)

**Files:**
- Create: `scripts/amazon/explore-brand-analytics.mjs`

Brand Analytics search terms reports cover one week at a time (Sunday-Saturday). The script requests last complete week.

- [ ] **Step 1: Write the script**

Create `scripts/amazon/explore-brand-analytics.mjs`:

```js
/**
 * Fetch Brand Analytics search terms report (weekly).
 * Requires Brand Registry + Amazon Business Analytics role.
 *
 * Usage:
 *   node scripts/amazon/explore-brand-analytics.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import {
  getClient,
  getMarketplaceId,
  requestReport,
  pollReport,
  downloadReport,
} from '../../lib/amazon/sp-api-client.js';

const client = getClient();
console.log(`Hitting ${client.env} endpoint: ${client.baseUrl}`);

// Last complete Sunday-Saturday week.
const now = new Date();
const day = now.getUTCDay(); // 0 = Sunday
const lastSaturday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day - 1));
const lastSunday = new Date(lastSaturday);
lastSunday.setUTCDate(lastSaturday.getUTCDate() - 6);

const dataStartTime = lastSunday.toISOString();
const dataEndTime = new Date(lastSaturday.getTime() + 24 * 60 * 60 * 1000 - 1).toISOString();

console.log(`Requesting GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT`);
console.log(`  start: ${dataStartTime}`);
console.log(`  end:   ${dataEndTime}`);

const reportId = await requestReport(
  client,
  'GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT',
  [getMarketplaceId()],
  dataStartTime,
  dataEndTime,
  { reportPeriod: 'WEEK' },
);
console.log(`Report ID: ${reportId}`);

const reportDocumentId = await pollReport(client, reportId);
console.log(`Report document ID: ${reportDocumentId}`);

const rows = await downloadReport(client, reportDocumentId);

const rowArray = Array.isArray(rows) ? rows : rows?.dataByDepartmentAndSearchTerm ?? [];
console.log(`\nRows: ${rowArray.length}`);
if (rowArray.length > 0) {
  console.log('First 5 rows:');
  console.log(JSON.stringify(rowArray.slice(0, 5), null, 2));
}

const outDir = 'data/amazon-explore';
mkdirSync(outDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const outPath = `${outDir}/${today}-brand-analytics-${client.env}.json`;
writeFileSync(
  outPath,
  JSON.stringify({ dataStartTime, dataEndTime, reportId, rows }, null, 2),
);
console.log(`\nDump: ${outPath}`);
```

- [ ] **Step 2: Syntax check**

```bash
node --check scripts/amazon/explore-brand-analytics.mjs
```

Expected: no output.

- [ ] **Step 3: Run against production**

Run:
```bash
node scripts/amazon/explore-brand-analytics.mjs
```

Expected: report status log lines (IN_PROGRESS → DONE), then row count. Can take 1-5 minutes.

**Possible failures and what to do:**
- `403` on report request: Brand Analytics role isn't active. Record in commit message, move on.
- Report ends `FATAL`: Amazon couldn't generate it — usually a date range issue or missing Brand Registry. Record the failure and move on.
- `CANCELLED`: same as FATAL.

- [ ] **Step 4: Commit**

```bash
git add scripts/amazon/explore-brand-analytics.mjs
git commit -m "feat(amazon): add Brand Analytics search terms exploration script"
```

---

## Task 10: Create explore-sales-traffic.mjs

**Files:**
- Create: `scripts/amazon/explore-sales-traffic.mjs`

- [ ] **Step 1: Write the script**

Create `scripts/amazon/explore-sales-traffic.mjs`:

```js
/**
 * Fetch Sales and Traffic report by ASIN (last 30 days).
 *
 * Usage:
 *   node scripts/amazon/explore-sales-traffic.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import {
  getClient,
  getMarketplaceId,
  requestReport,
  pollReport,
  downloadReport,
} from '../../lib/amazon/sp-api-client.js';

const client = getClient();
console.log(`Hitting ${client.env} endpoint: ${client.baseUrl}`);

const dataEndTime = new Date().toISOString();
const dataStartTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

console.log(`Requesting GET_SALES_AND_TRAFFIC_REPORT`);
console.log(`  start: ${dataStartTime}`);
console.log(`  end:   ${dataEndTime}`);

const reportId = await requestReport(
  client,
  'GET_SALES_AND_TRAFFIC_REPORT',
  [getMarketplaceId()],
  dataStartTime,
  dataEndTime,
  { asinGranularity: 'CHILD', dateGranularity: 'DAY' },
);
console.log(`Report ID: ${reportId}`);

const reportDocumentId = await pollReport(client, reportId);
console.log(`Report document ID: ${reportDocumentId}`);

const rows = await downloadReport(client, reportDocumentId);

const asinRows = Array.isArray(rows) ? rows : rows?.salesAndTrafficByAsin ?? [];
console.log(`\nASIN rows: ${asinRows.length}`);
if (asinRows.length > 0) {
  console.log('First 3 rows:');
  console.log(JSON.stringify(asinRows.slice(0, 3), null, 2));
}

const outDir = 'data/amazon-explore';
mkdirSync(outDir, { recursive: true });
const today = new Date().toISOString().slice(0, 10);
const outPath = `${outDir}/${today}-sales-traffic-${client.env}.json`;
writeFileSync(
  outPath,
  JSON.stringify({ dataStartTime, dataEndTime, reportId, rows }, null, 2),
);
console.log(`\nDump: ${outPath}`);
```

- [ ] **Step 2: Syntax check and run**

```bash
node --check scripts/amazon/explore-sales-traffic.mjs
node scripts/amazon/explore-sales-traffic.mjs
```

Expected: report status updates then ASIN rows. Can take 1-5 min. On failure, same troubleshooting as Task 9.

- [ ] **Step 3: Commit**

```bash
git add scripts/amazon/explore-sales-traffic.mjs
git commit -m "feat(amazon): add Sales & Traffic by ASIN exploration script"
```

---

## Task 11: Write the README

**Files:**
- Create: `scripts/amazon/README.md`

- [ ] **Step 1: Write the README**

Create `scripts/amazon/README.md`:

```markdown
# Amazon SP-API exploration scripts

One-off probes for evaluating which Amazon Seller Central data is useful for business decisions. Not agents — each script runs standalone, prints a summary to stdout, and dumps the full JSON response to `data/amazon-explore/` (git-ignored).

## Prerequisites

`.env` must contain the production credentials registered in Solution Provider Portal:

- `AMAZON_SPAPI_PRODUCTION_APP_ID`
- `AMAZON_SPAPI_PRODUCTION_LWA_CLIENT_ID`
- `AMAZON_SPAPI_PRODUCTION_LWA_CLIENT_SECRET`
- `AMAZON_SPAPI_PRODUCTION_REFRESH_TOKEN`
- `AMAZON_SPAPI_SELLER_ID` — your Merchant Token (for `explore-listings.mjs` only). Get it from Seller Central → Settings → Account Info → Your Merchant Token.

Sandbox variants (`AMAZON_SPAPI_SANDBOX_*`) enable mock-data testing.

## Switching environments

Default is production:

    node scripts/amazon/explore-marketplaces.mjs

Sandbox (mock data):

    AMAZON_SPAPI_ENV=sandbox node scripts/amazon/explore-marketplaces.mjs

## Scripts

| Script | What it returns |
|---|---|
| `explore-marketplaces.mjs` | Marketplace participations (smoke test — run this first). |
| `explore-orders.mjs` | Orders from the last 30 days. |
| `explore-inventory.mjs` | FBA inventory summaries. |
| `explore-listings.mjs` | Your catalog listings (ASINs, status, prices). |
| `explore-finance.mjs` | Financial events (shipments, refunds, fees) last 30 days. |
| `explore-brand-analytics.mjs` | Brand Analytics search terms report (last complete week). |
| `explore-sales-traffic.mjs` | Sales & Traffic by ASIN (last 30 days). |

## Output

Each run writes JSON to `data/amazon-explore/YYYY-MM-DD-<script>-<env>.json`. The directory is git-ignored because dumps may include order PII and financial details.

## Known limitations

- Brand Analytics requires Brand Registry + Amazon Business Analytics role. If `explore-brand-analytics.mjs` returns 403 or FATAL, that's why.
- Orders data is returned unredacted only when the Orders (PII) role is active.
- Reports (Brand Analytics, Sales & Traffic) are async — scripts poll up to 10 minutes before timing out.
- Ads API data (sponsored products/brands performance) is a separate API, not covered here — see Phase 1b spec when planned.
```

- [ ] **Step 2: Commit**

```bash
git add scripts/amazon/README.md
git commit -m "docs(amazon): add exploration scripts README"
```

---

## Task 12: Push branch and open PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feature/amazon-spapi-exploration
```

- [ ] **Step 2: Open the PR**

Run:
```bash
gh pr create --title "feat(amazon): Phase 1 - SP-API exploration scripts" --body "$(cat <<'EOF'
## Summary
- Hand-rolled SP-API client at `lib/amazon/sp-api-client.js` with LWA auth, request helper, and Reports API helpers (request/poll/download).
- Seven exploration scripts under `scripts/amazon/` for marketplaces, orders, inventory, listings, finance, Brand Analytics, and Sales & Traffic.
- Env switch via `AMAZON_SPAPI_ENV=sandbox|production` (defaults to production).
- `data/amazon-explore/` git-ignored for raw JSON dumps.
- Spec: `docs/superpowers/specs/2026-04-24-amazon-spapi-exploration-design.md`.
- Plan: `docs/superpowers/plans/2026-04-24-amazon-spapi-exploration.md`.

## Test plan
- [ ] `node scripts/amazon/explore-marketplaces.mjs` returns active Amazon.com marketplace
- [ ] `node scripts/amazon/explore-orders.mjs` returns order count for last 30 days
- [ ] `node scripts/amazon/explore-inventory.mjs` returns FBA SKU list
- [ ] `node scripts/amazon/explore-listings.mjs` returns catalog items
- [ ] `node scripts/amazon/explore-finance.mjs` returns financial events
- [ ] `node scripts/amazon/explore-brand-analytics.mjs` either returns search terms or a documented role failure
- [ ] `node scripts/amazon/explore-sales-traffic.mjs` either returns ASIN rows or a documented role failure

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Record the PR URL**

Paste the returned PR URL into the session so we have a reference for the user to review.

---

## Self-Review Checklist (completed)

- **Spec coverage:**
  - Architecture (lib + 7 scripts + data dir) → Tasks 2, 3, 5-10
  - Client API (getClient/request/report helpers) → Tasks 2, 4
  - Env switching → Task 2, tested in Task 3
  - 7 exploration scripts → Tasks 3, 5-10
  - `data/amazon-explore/` git-ignored → Task 1
  - README → Task 11
  - Non-goals (no agent harness, no tests, no dashboard) → respected throughout
  - Risks (Brand Analytics 403, PII redaction) → surfaced in Task 9 step 3 + README
- **Placeholders:** None — all code blocks are complete.
- **Type consistency:** `getClient`, `request`, `requestReport`, `pollReport`, `downloadReport`, `getMarketplaceId` are defined once (Tasks 2 & 4) and used consistently with matching signatures in Tasks 3, 5-10.
