# Google Ads support case — Data Manager offline conversions never process

**Status:** ready to file. Sean must file it — it needs the Google Ads account login.
**Where:** Google Ads UI → Help (?) → Contact us → *Conversion tracking* → chat or email.

---

## Paste this into the support ticket

> **Account:** 5099369750 (Real Skin Care)
> **Issue:** Offline conversion events uploaded via the **Data Manager API** (`events:ingest`) are accepted with HTTP 200 and no errors or warnings, but the ingestion request never leaves `PROCESSING` status, and **zero conversions ever appear** on the destination conversion action.
>
> **Conversion action:** `RSC Shopify Purchase (server)`, ID **7718887636**
> — type `UPLOAD_CLICKS`, category `PURCHASE`, status `ENABLED`, primary for goal, `include_in_conversions_metric = true`, click-through lookback 90 days.
>
> **Example request IDs, all still `PROCESSING` 12+ hours after submission:**
> - `922f7ebf-e7d4-43b0-975c-3f741a473da8`
> - `7a31c35d-04f1-41c2-9f63-0f4f283a711b`
>
> `GET /v1/requestStatus:retrieve?requestId=<id>` returns:
> ```json
> {"requestStatusPerDestination":[{"destination":{
>   "loginAccount":{"accountId":"5099369750","accountType":"GOOGLE_ADS"},
>   "operatingAccount":{"accountId":"5099369750","accountType":"GOOGLE_ADS"},
>   "productDestinationId":"7718887636"},
>   "requestStatus":"PROCESSING"}]}
> ```
> No `fieldWarnings` are returned on ingest, and `validateOnly: true` passes cleanly.
>
> **Events being sent** (2 events, real purchases from paid clicks):
> ```json
> {"eventTimestamp":"2026-07-31T18:47:07-06:00","transactionId":"2322",
>  "conversionValue":37.19,"currency":"USD","eventSource":"WEB",
>  "adIdentifiers":{"gbraid":"0AAAAAosZu9t1m6C2lo-Rjf93JtQMUwnB-"},
>  "userData":{"userIdentifiers":[{"emailAddress":"<sha256 hex>"}]}}
> ```
> with top-level `"encoding":"HEX"`.
>
> **What I have already verified on my side:**
> - Data Manager API is enabled on Cloud project 729233344313.
> - OAuth token carries the `https://www.googleapis.com/auth/datamanager` scope.
> - `customer.conversion_tracking_setting.accepted_customer_data_terms = true`.
> - `enhanced_conversions_for_leads_enabled = true`.
> - Auto-tagging is ON; no tracking templates on any campaign.
> - The `gbraid` values come from real ad clicks on campaign 24050427048 and appear in the order's landing URL alongside `gad_campaignid=24050427048`.
> - Both conversions are well inside the 90-day lookback window.
> - Sending `loginAccount` explicitly (equal to the operating account) changes nothing.
>
> **Questions:**
> 1. Is this account enabled/allowlisted for Data Manager API ingestion? A request that stays `PROCESSING` indefinitely with no warnings suggests it is queued but never processed.
> 2. Are `gbraid`-only offline conversions supported for **Shopping** campaign clicks, or is a `gclid` required? (Our storefront truncates the gclid — see note below — so gbraid was all we had at upload time.)
> 3. If `PROCESSING` is expected to persist this long, what is the actual SLA before conversions surface in reporting?

---

## Background — why we are on this path at all

Google Ads reported **0 conversions from 2026-04 through 2026-08** while the store took real orders from paid clicks. Root cause: the account's only *counted* purchase conversion was a **GA4 import**, and GA4 was missing most of the data (264 ad clicks → 85 GA4 sessions, 68% lost; 7 storefront orders → 4 GA4 transactions). Every native `WEBPAGE` conversion action in the account is `REMOVED`, so nothing backstopped it.

Order **#2322** (2026-07-31, $37.19) carried `gad_campaignid=24050427048` and a `gbraid` in Shopify and **never appeared in GA4 at all** — that single order is the whole failure in miniature.

The loss is client-side (consent banners, ad blockers, the sandboxed Shopify channel pixel). It is **not** a page-speed problem — real p75 LCP is ~1.5s. So conversions are uploaded server-side from the Shopify order book, which is immune to all of those failure modes. `ConversionUploadService` is closed to new integrations, so Data Manager is the only available path.

## The gclid truncation detail (relevant to question 2)

Shopify caps `order.landing_site` at **255 characters** and Google Shopping puts `gclid` **last** in the query string, so server-side the gclid arrives as a 4-character stump (`CjwK`) while `gbraid` survives intact. We reject the stump deliberately — uploading it would be accepted by Google and attributed to no click.

As of 2026-08-12 the storefront captures the **full** gclid into a cart attribute (`theme/assets/rsc-click-id.js`, PR #450), which lands on the order as a `note_attribute` with no length cap. **This only helps orders placed after that date** — the two pending conversions predate it and have gbraid only. If support confirms gbraid-only is unsupported for Shopping clicks, that is the explanation, and new orders should work without further changes.

## If support resolves it

1. Re-run the backfill: `npm run ads-conversions-backfill` (idempotent — Google dedupes on the Shopify order number, so re-running cannot double-count).
2. Confirm non-zero conversions on action 7718887636 in Ads reporting.
3. The `dead-spend` rule in `agents/shopping-calibrator` is gated behind a "0 conversions across every search term" guard and stays inert until real conversions exist — it will start working automatically.

## If support confirms it will never work

Fall back to a **native browser conversion tag** via the Shopify Google & YouTube channel, accepting the ~68% client-side loss, and treat the uploaded figure as a floor rather than a count. Do **not** run both into the same conversion action — that double-counts.

## Related

- `~/.claude/.../memory/project_ads_conversion_tracking_rebuilt.md` — full diagnosis and API gotchas
- PRs #439 (pipeline), #447 (honest status reporting), #449 (hashed email), #450 (gclid capture)
