# Amazon SP-API exploration scripts

One-off probes for evaluating which Amazon Seller Central data is useful for business decisions. Not agents — each script runs standalone, prints a summary to stdout, and dumps the full JSON response to `data/amazon-explore/` (git-ignored).

## Prerequisites

`.env` must contain the production credentials registered in Solution Provider Portal:

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
| `explore-search-query-performance-rsc.mjs` | Search Query Performance for RSC + sub-brand ASINs (per-ASIN impressions / clicks / cart adds / purchases by query). |
| `explore-search-query-performance-culina.mjs` | Same, scoped to Culina ASINs. Returns 0 rows until Brand Registry is approved for Culina. |

## Output

Each run writes JSON to `data/amazon-explore/YYYY-MM-DD-<script>-<env>.json`. The directory is git-ignored because dumps may include order PII and financial details.

## Known limitations

- Brand Analytics requires Brand Registry + Amazon Business Analytics role. If `explore-brand-analytics.mjs` returns 403 or FATAL, that's why.
- Brand Analytics search-terms reports are several GB unzipped. The script streams the file to disk (using `streamReportToFile` from the client lib) and prints `jq` commands to sample the data — it does NOT print rows inline like the other scripts. Use the printed `jq` examples to inspect the JSON without loading it into memory.
- The `Finance and Accounting` role may not be approved by default. If `explore-finance.mjs` returns 403, request the role in Solution Provider Portal and re-run.
- Orders data is returned unredacted only when the Orders (PII) role is active.
- Reports (Brand Analytics, Sales & Traffic) are async — scripts poll up to 10 minutes before timing out.
- Ads API data (sponsored products/brands performance) is a separate API, not covered here — see Phase 1b spec when planned.
- Search Query Performance (`explore-search-query-performance-*.mjs`) requires Brand Registry. Without it, the report returns 0 rows. The Culina variant is currently in this state pending Brand Registry approval.
