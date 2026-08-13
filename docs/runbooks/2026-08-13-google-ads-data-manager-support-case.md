# Google Ads support case — Data Manager offline conversions never process

**Status: ⏸️ HOLD — do not file yet.** A decisive test is in flight; see "The gclid test" below. If it succeeds there is nothing to escalate.
**Where (when needed):** Google Ads UI → Help (?) → Contact us → *Conversion tracking* → chat or email.

---

## ⚠️ The gclid test — read this before filing

**The root cause is Shopify truncation, not Google.** Shopify caps `order.landing_site` at 255 characters, which cut the gclid in half and forced every upload onto `gbraid` — and gbraid is what was not attaching. Order **#2332** (2026-08-13, $37.49, campaign 24050427048) is the proof:

| Source | gclid |
|---|---|
| Shopify `landing_site` | 46 chars — **truncated** |
| Cart-attribute capture (PR #450, live 2026-08-12) | **92 chars — complete** |

That order was uploaded with its **full gclid** at 2026-08-13 ~18:15 UTC as request `082b8231-dad7-49db-82b5-b654287ebf85`. **If that conversion lands, the pipeline is fixed and this ticket is unnecessary** — every future paid order carries a full gclid automatically.

Only file the ticket below if the full-gclid upload *also* fails to attach after ~24h. At that point the identifier has been ruled out as the cause and the problem genuinely is account-side.

Note for the ticket if it comes to that: the two older orders (#2322, #2329) predate the capture and carry `gbraid` only. Their gbraid values were verified **complete**, not truncated (they end at char 244 of 255, with `&gclid=` following) — so "gbraid was malformed" is not an available explanation for those.

**Evidence is now conclusive (2026-08-13 16:46 UTC).** Both independent watchers came back negative: no ingest request has ever reached a terminal status (12h+ of polling), and the destination action has recorded **0 conversions** ~19h after the first submission. The daily cron job runs correctly and reports the failure honestly — `data/reports/ads-conversions/2026-08-13.json` shows `submitted: 2, ingestStatus: "PROCESSING", confirmedByGoogle: false, reportedConversions: 0, fieldWarnings: []`. This is not a lag artifact and not a payload defect.

---

## Paste this into the support ticket

> **Account:** 5099369750 (Real Skin Care)
> **Issue:** Offline conversion events uploaded via the **Data Manager API** (`events:ingest`) are accepted with HTTP 200 and no errors or warnings, but the ingestion request never leaves `PROCESSING` status, and **zero conversions ever appear** on the destination conversion action.
>
> **Conversion action:** `RSC Shopify Purchase (server)`, ID **7718887636**
> — type `UPLOAD_CLICKS`, category `PURCHASE`, status `ENABLED`, primary for goal, `include_in_conversions_metric = true`, click-through lookback 90 days.
>
> **Request IDs — all still `PROCESSING`, none has ever reached a terminal status:**
> - `922f7ebf-e7d4-43b0-975c-3f741a473da8` (submitted 2026-08-12 ~21:59 UTC — still `PROCESSING` 19h later)
> - `7a31c35d-04f1-41c2-9f63-0f4f283a711b` (submitted with an explicit `loginAccount` — no difference)
> - `98b18b2e-a872-4c8c-b462-441b43661e3e` (automated daily run, 2026-08-13 15:05 UTC)
>
> As of **2026-08-13 16:46 UTC**, conversion action 7718887636 reports **0 conversions** — roughly **19 hours** after the first submission and ~22h after the first attempt overall. No request has returned a single `fieldWarning` at any point.
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
