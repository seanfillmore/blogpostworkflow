# Culina monthly report and stock alerts

**Date:** 2026-11-11 · **Requested by:** Sean · **Reader:** Travis (travis@traviswales.com)

## Why

Travis is the final decision maker on Culina and decides where to put time and money in the brand. He already reads SellerBoard every day, so he does not need another daily sales and profit view. What he lacks is a forward view of inventory. **Travis makes everything to order**: there is no finished stock held outside Amazon, so what he needs is how many units of each item to make and ship into Amazon, and when. Culina makes its own soap, oil, scrub and stick and sources chainmail scrubbers and brushes from China; Travis orders the raw materials, so he needs to see at least 90 days ahead.

The second goal is staying in stock. The target is **90 to 120 days of stock on hand in FBA plus AWD** for every item. In November 2026 the 6-piece set ran out and the 3-pack fell to about 1.5 weeks of cover, which is the problem this is meant to prevent. Growth partners (GigaBrands) screen out brands that cannot stay in stock.

Context: Culina is Amazon-only for now, was bought at the start of 2026, and targets $75K to $100K a month within 12 months (from ~$30K in Oct 2026), with a profitable exit in 12 to 18 months.

## What gets built

### 1. Monthly report, emailed automatically on the 10th

Covers the previous calendar month. Sent on the 10th so Amazon's settlements, refunds and ad charges for the month have closed. No human review step.

- **From:** sean@realskincare.com · **To:** travis@traviswales.com · **CC:** sean@realskincare.com

Contents, in this order:

1. **Inventory projection (the core).** Per finished item, forecast unit sales for the next 30, 60 and 90 days, then:
   - stock on hand: FBA sellable, AWD, inbound
   - days of cover at the forecast pace
   - **units to make and ship into Amazon, and the date they must ship by**, to stay inside the 90-120 day target through the 90-day window. Stock on Amazon (FBA + AWD + inbound) is the only stock there is.

   Two levels:
   - **Amazon items** (the 3-pack, the 6-piece and other kits, the singles), because those are what ship to FBA.
   - **Components**: kits broken into what's inside them, so Travis sees the total soap bottles, oil bottles, scrub jars, sticks, chainmails and brushes to produce or buy. Component contents come from `config/culina-cogs.json` (`contents`).

   China-sourced items (chainmail, brush) are flagged separately because their lead time is longer. Stops at finished items; **no raw materials** (Travis tracks those).
2. **Forecast vs actual.** Last month's 30-day forecast per item against what actually sold, so Travis can judge how far to trust the projection.
3. **Monthly sales chart.** Gross sales by calendar month since March 2026, as on the GigaBrands prep page.
4. **P&L: last month next to the month before.** Sales, Amazon fees (FBA, referral), promotions, refunds, product cost, contribution, ad spend (Sponsored Products, Brands, Display), freight into Amazon, storage and AWD, coupon/deal fees, reimbursements, net. Each line shows both months and the change. A one-line note states the method, because it will not match SellerBoard to the dollar.
5. **Progress toward the goal.** Last month's sales against the $75K-$100K target and the pace needed to reach it by Nov 2027.

**Not in the report:** agency fees (Sean's instruction), raw materials, RSC products, day-to-day sales commentary SellerBoard already covers.

### 2. Stock alerts, during the month

A daily check emails the same recipients when an Amazon item **drops below 60 days of cover** at the forecast pace. 60 days leaves room for the 14-day lead time with a margin. Each alert names the item, days left, units on hand and inbound, and the quantity needed to get back to 120 days.

Out-of-stock is always alerted. To avoid noise: at most one alert email per day, combining every item that is low. An item already alerted is repeated weekly while it stays below 60 days, and immediately if it runs out.

## Forecast method

The forecast is of **actual expected sales**, not of the growth goal. The goal appears only as the separate progress check.

- Base: each item's recent unit pace, weighted toward the last few weeks so price changes and stockouts show up quickly. Days an item was out of stock are excluded from its pace, so a stockout doesn't read as low demand.
- Seasonality: there is no prior-year Culina history on this account (sales start March 2026, and the previous owner's history is not available). Use a seasonal index for cast-iron-care demand from search-volume history, and label the adjustment as an estimate in the report.
- Each month's forecast is saved so the next report can compare it with actual sales.

## Constraints and known facts

- **Lead time:** new inventory can be selling on Amazon within 14 days of deciding to make it (Sean). China-sourced parts take **30-45 days** to arrive (Sean's estimate); plan on 45, so their order-by date is 45 days ahead of the ship date of any kit that uses them.
- **Capacity:** 20,000+ units a month; not a constraint on the projection.
- **Data, all already readable on the production server** (credentials verified 2026-11-11):
  - Sales by item, month or week: Sales API `GET /sales/v1/orderMetrics` per ASIN. It has its own quota; the Reports API `createReport` quota is regularly used up by the server's cron jobs, so avoid depending on it.
  - Fees, promotions, refunds, freight, storage, AWD, coupon fees, reimbursements: Finance API `listFinancialEvents`. Freight and storage are charged to the whole seller account, so allocate to Culina by its share of units shipped (93% in Aug-Nov 2026).
  - Ad spend: Ads API (`lib/amazon/ads-api-client.js`, as `scripts/amazon/pull-ads-reports.mjs` uses).
  - Stock: FBA inventory summaries and the AWD inventory API (see `reference_awd_api_inventory_and_facility`).
  - Product cost: `config/culina-cogs.json`. B08ZH7L5M3 has no cost and does not sell.
- **Which ASINs are Culina:** title contains "culina" or "cast iron" (CLAUDE.md rule). Only items currently sold are projected; idle review-holder ASINs are excluded.
- **Sending:** through `lib/hushmail.js` `sendMail` with `via: 'resend'` (the server cannot use SMTP). It currently sends plain text to one address, so it needs **HTML and CC support** added; keep the Sent-folder copy behaviour.
- **Email rendering:** the bar chart must work in Gmail and Apple Mail, which don't render SVG reliably. Use HTML table bars or an embedded PNG.
- Runs on the production server from cron, scheduled in UTC (a `TZ=` prefix does nothing on this host). Add the jobs to `scripts/setup-cron.sh` and install them live in the same change.
- Report the run through the normal deferred `notify()` digest row. `status: 'error'` only when the job itself broke.
- **Scope:** CLAUDE.md and memory say Culina is out of scope for this repo except Amazon PPC auditing. Sean's request opens a second exception for this report and alerts; update both in the same change.

## Calls made in the design (Claude's, not Sean's; check these)

- **14 days is end to end**: from deciding to make an item to it being sellable on Amazon. The 60-day alert therefore leaves about 46 days of slack.
- **Need-by date and quantity:** the need-by date is when forecast cover (FBA sellable + AWD + inbound) would fall below 90 days, minus the lead time. The quantity brings cover back to 120 days. AWD stock counts as cover, because Sean's target is "90-120 days in FBA or AWD".
- **Which items are projected:** every Culina ASIN with sales or a buyable offer in the last 60 days, plus a short config list of planned launches (for example a standalone chainmail scrubber or the 5-piece B08K85JN7M), each with a stated starting forecast. A launch without one is listed but not forecast.
- **Bought-in parts:** chainmail, brush, plastic scrapers and silicone handle cover are all treated as sourced (long lead time). Soap, oil, scrub and stick are made in-house.
- **Stockout days** are inferred from runs of zero-sales days while the item had no FBA sellable stock (taken from daily snapshots this job starts keeping) or, before those exist, from runs of zero-sales days on an item that normally sells daily. No dependency on the inventory-ledger report.
- **Ad spend split:** Sponsored Products by advertised ASIN, as the PPC audit does. Brands and Display campaigns are assigned by the Culina ASIN or product word in the campaign name. On 2026-11-11 two Display campaigns were Real Skin Care's (body lotion, deodorant), both at $0. A campaign that cannot be assigned is listed in the report, not guessed.
- **Alerts include components:** besides Amazon items, an alert fires when a made-in-house component's combined cover (singles plus kits) drops below 60 days, since a soap shortage hits every kit at once.

## Left to the builder

- Agent name and file layout, following existing agents (`agents/<name>/index.js` with pure logic in `lib/`, `isDirectRun` guard, dry by default on the CLI, `--apply` on cron).
- Exact forecast weighting and the source for the seasonal index, as long as the method is stated in the report.
- Visual design of the email, which should feel like the GigaBrands prep page.
- Where forecasts and alert state are stored (gitignored, server-owned; add to the offsite backup if losing it would break forecast-vs-actual).
