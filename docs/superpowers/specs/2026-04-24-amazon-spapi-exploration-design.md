# Amazon SP-API exploration — Phase 1 design

**Date:** 2026-04-24
**Status:** Spec — pending implementation plan

## Goal

Pull representative data from Amazon Seller Central via SP-API so we can evaluate which Amazon data sources are useful for business decisions. **Exploration mode only** — no scheduled jobs, no dashboard integration, no persistent storage beyond raw JSON dumps for inspection.

Success looks like: run a script (e.g. `node scripts/amazon/explore-brand-analytics.mjs`) and get real data on stdout plus a JSON dump on disk.

## Non-goals (Phase 1)

- No agent harness (no `agents/amazon-data/index.js` orchestrator)
- No scheduled pulls (calendar-runner integration)
- No dashboard surface
- No DB or structured cross-channel storage
- No Amazon Ads API integration — that's Phase 1b (separate registration, separate auth model)

## Background

### Auth state (already done outside this spec)

The user has registered two SP-API apps in Solution Provider Portal:

- **Sandbox app** ("RSC Data Aggregator"), App ID `amzn1.sp.solution.1ef77b47-076b-4bf8-b9f3-c70b2f1d175f` — for safe wiring tests against mock data
- **Production app** ("RSC Data Aggregator Production"), App ID `amzn1.sp.solution.57176b29-f9a8-4e44-b977-6408baf1640c` — self-authorized to the Real Skin Care seller account

Both apps have 7 data access roles approved (RSC Data Aggregator, Product Listing, Amazon Business Analytics, + 4 others — exact list visible in SPP).

Credentials stored in `.env`:

```
# Sandbox
AMAZON_SPAPI_SANDBOX_APP_ID
AMAZON_SPAPI_SANDBOX_LWA_CLIENT_ID
AMAZON_SPAPI_SANDBOX_LWA_CLIENT_SECRET
AMAZON_SPAPI_SANDBOX_REFRESH_TOKEN

# Production
AMAZON_SPAPI_PRODUCTION_APP_ID
AMAZON_SPAPI_PRODUCTION_LWA_CLIENT_ID
AMAZON_SPAPI_PRODUCTION_LWA_CLIENT_SECRET
AMAZON_SPAPI_PRODUCTION_REFRESH_TOKEN
```

### Why hand-roll instead of using an SDK

Per [Amazon's 2024 SP-API changes](https://developer-docs.amazon.com/sp-api/changelog), AWS Sigv4 signing is no longer required — auth is now: refresh token → LWA access token → set `x-amz-access-token` header on each call. That makes a hand-rolled client genuinely small (~150 lines) and keeps us aligned with the existing project pattern (Shopify, GSC, Ahrefs are all hand-rolled). Third-party SDKs (`@scaleleap/selling-partner-api-sdk`, `amazon-sp-api`) add MB of generated code we won't use, plus their conventions conflict with how this project structures clients.

## Architecture

```
lib/
  amazon/
    sp-api-client.js        ← thin client (~150 lines + ~80 lines of report helpers)
scripts/
  amazon/
    README.md               ← how to run the scripts, env switching
    explore-marketplaces.mjs
    explore-orders.mjs
    explore-inventory.mjs
    explore-listings.mjs
    explore-finance.mjs
    explore-brand-analytics.mjs
    explore-sales-traffic.mjs
data/
  amazon-explore/
    YYYY-MM-DD-<endpoint>.json   ← raw JSON dumps for inspection
```

Notes:

- Scripts live under `scripts/amazon/`, not `agents/`, because they're one-off probes, not orchestrated agents. The README explaining how to run them lives alongside.
- `data/amazon-explore/` will be added to `.gitignore` as part of Phase 1 — raw API dumps may include order PII, customer addresses, or financial details. Existing `.gitignore` already excludes `amazon_product_photos/` so a similar entry fits naturally.

## Component design

### `lib/amazon/sp-api-client.js`

Public API:

```js
import {
  getClient,
  request,
  requestReport,
  pollReport,
  downloadReport,
  getMarketplaceId,
} from '../../lib/amazon/sp-api-client.js';

const client = getClient();
const data = await request(client, 'GET', '/orders/v0/orders', { CreatedAfter: '...' });
```

Behaviour:

1. **Env switching.** `getClient()` reads `process.env.AMAZON_SPAPI_ENV` (default `production`):
   - `production` — uses `AMAZON_SPAPI_PRODUCTION_*` vars and base URL `https://sellingpartnerapi-na.amazon.com`
   - `sandbox` — uses `AMAZON_SPAPI_SANDBOX_*` vars and base URL `https://sandbox.sellingpartnerapi-na.amazon.com`
   - Throws on missing required env vars at startup (loud failure beats silent 401s).

2. **LWA token exchange.** `POST https://api.amazon.com/auth/o2/token` with `grant_type=refresh_token`. Access tokens last 1 hour; **cached in memory** on the client object (`accessToken` + `expiresAt`). Refreshed lazily when expired or with <60s left.

3. **`request(client, method, path, params)`:**
   - Builds full URL, attaches `x-amz-access-token` header
   - Parses JSON response
   - On `429`: respects `x-amzn-RateLimit-Limit` / `Retry-After`, sleeps, retries up to 3 times
   - On `401`/`403`: throws with response body (auth/role errors are common; surface them clearly)
   - On other 4xx/5xx: throws with status + body
   - Returns parsed JSON `payload` (SP-API responses have shape `{ payload: {...} }` or `{ errors: [...] }`)

4. **Report helpers** (for async report endpoints):
   - `requestReport(client, reportType, marketplaceIds, dataStartTime, dataEndTime)` — `POST /reports/2021-06-30/reports`, returns `reportId`
   - `pollReport(client, reportId, { intervalMs = 30000, maxWaitMs = 600000 })` — polls `GET /reports/2021-06-30/reports/{reportId}` until `processingStatus === 'DONE'` or timeout. Returns `reportDocumentId`.
   - `downloadReport(client, reportDocumentId)` — `GET /reports/2021-06-30/documents/{id}` to get the document URL, then fetches it. Handles gzip decompression and TSV/JSON parsing based on the `compressionAlgorithm` and content-type fields. Returns parsed rows.

### `getMarketplaceId()`

Returns `'ATVPDKIKX0DER'` (Amazon US). Hard-coded in Phase 1; if multi-marketplace is needed later, move to env.

### Deliberate non-features

- No retry on non-429 errors — would mask bugs during exploration
- No request signing (not needed post-2024)
- No SDK-style typed wrapper per endpoint — scripts pass raw paths/params so we can hit any endpoint without code changes
- No persistent token cache — exploration scripts run rarely, in-memory is fine

## Exploration scripts

All scripts: standalone `node` invocation, print summary to stdout, dump full JSON to `data/amazon-explore/YYYY-MM-DD-<name>.json`.

### Direct query scripts

| Script | Endpoint | Output summary |
|---|---|---|
| `explore-marketplaces.mjs` | `GET /sellers/v1/marketplaceParticipations` | List of marketplace participations. Sanity check that auth works end to end. |
| `explore-orders.mjs` | `GET /orders/v0/orders?CreatedAfter=<30d ago>` | Order count, total revenue, top SKUs from last 30 days |
| `explore-inventory.mjs` | `GET /fba/inventory/v1/summaries` | FBA SKUs, fulfillable quantities, stranded/excess flags |
| `explore-listings.mjs` | `GET /listings/2021-08-01/items/{sellerId}` | Catalog: ASINs, status, prices |
| `explore-finance.mjs` | `GET /finances/v0/financialEvents` | Recent settlements, fees, refunds |

`explore-listings.mjs` needs the seller ID — fetched via `/sellers/v1/marketplaceParticipations` on first call within the same script.

### Report scripts (async)

| Script | Report type | Output summary |
|---|---|---|
| `explore-brand-analytics.mjs` | `GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT` | Top search queries customers used to find your products. **Most SEO-relevant.** |
| `explore-sales-traffic.mjs` | `GET_SALES_AND_TRAFFIC_REPORT` | Page views, sessions, conversion rate by ASIN |

These use the `requestReport` → `pollReport` → `downloadReport` helpers from the client lib.

## Sandbox vs production switching

The default is `production` because the user wants real data. To test wiring with mocks:

```bash
AMAZON_SPAPI_ENV=sandbox node scripts/amazon/explore-marketplaces.mjs
```

Sandbox calls hit Amazon's documented mock endpoints, return canned responses — useful for verifying request structure without burning real-data quota.

## Error handling and observability

- Client throws on any non-2xx (with status + response body in the message)
- Scripts catch top-level errors, print a one-line summary, exit code 1
- Each script logs:
  - First line: which env it's hitting (`Hitting production endpoint...` or `Hitting sandbox endpoint...`)
  - Per-call: `Calling <method> <path>...`
  - On success: human-readable summary
  - Path to the JSON dump

## Testing

No unit tests for Phase 1. The exploration scripts ARE the tests — running them against sandbox first, then production, validates the client.

If we promote any of this into a real agent in Phase 2, we'll add tests then (per the project's existing pattern of testing agents end-to-end via fixture data).

## Risks and unknowns to surface during exploration

- **Brand Analytics access** may not be on your approved roles even though it shows in SPP. If `requestReport` for `GET_BRAND_ANALYTICS_SEARCH_TERMS_REPORT` returns 403, we'll need a separate role grant + Brand Registry verification.
- **Order PII** may be partially redacted depending on PII role status. We'll see what comes back.
- **Brand Analytics data range** — Amazon limits search query reports to specific date ranges; we may need to iterate on `dataStartTime` / `dataEndTime` to get useful data.
- **Rate limits** vary widely by endpoint (some 1 req/sec, some 0.0167 req/sec). Phase 1 scripts each make a handful of calls so this should not bite, but worth knowing.

## Out of scope (deferred)

- Phase 1b — Amazon Ads API exploration (separate registration in `advertising.amazon.com`, separate OAuth flow)
- Phase 2 — promoting exploration scripts into real agents that pull on schedule and store data
- Phase 3 — dashboard integration / cross-channel comparisons (Amazon vs Shopify)

## References

- [SP-API self-authorization](https://developer-docs.amazon.com/sp-api/docs/self-authorization)
- [Application Authorization Limits](https://developer-docs.amazon.com/sp-api/docs/application-authorization-limits)
- [Reports API v2021-06-30](https://developer-docs.amazon.com/sp-api/docs/reports-api-v2021-06-30-reference)
- [SP-API Sandbox](https://developer-docs.amazon.com/sp-api/docs/sp-api-sandbox)
