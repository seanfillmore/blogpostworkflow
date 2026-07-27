# Bundle economics — Real Skin Care

Generated 2026-07-27 by `scripts/bundle-economics.mjs`. Freight is **measured**, pulled live from Shopify's `shipping_labels` dataset.

> Regenerate with `node scripts/bundle-economics.mjs --write`. Do not hand-edit the tables.

## How to read this

CAC target is **$25**. Under the CFA rule, 30-day gross profit ≥ CAC breaks even; ≥ 2× CAC (**$50**) is the threshold for scaling paid spend. Contribution = price − COGS − freight − packaging − payment fees (2.9% + $0.30).

## Bundles

| Bundle | Status | MSRP | Price | Disc | COGS | lb | Units | Freight | **Contribution** | Verdict |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|---|
| The 90-Day Clean Swap | live | $207.00 | $159.00 | 23% | $45.30 | 3.84 | 12 | $7.94 | **$100.85** | ✅ scale (≥2× CAC) |
| The 90-Day Coconut Reset | live | $118.00 | $99.00 | 16% | $19.94 | 2.19 | 4 | $7.83 | **$68.06** | ✅ scale (≥2× CAC) |
| Head-to-Toe | live | $125.00 | $105.00 | 16% | $29.54 | 2.24 | 7 | $7.83 | **$64.29** | ✅ scale (≥2× CAC) |
| Hand Soap Set — 4 pumps + body lotion | live | $82.00 | $72.00 | 12% | $21.96 | 3.13 | 5 | $7.83 | **$39.82** | 🟡 breakeven (≥1× CAC) |
| Gift Box | live | $71.00 | $62.00 | 13% | $16.75 | 1.06 | 4 | $7.83 | **$34.32** | 🟡 breakeven (≥1× CAC) |
| The Clean Swap | live | $69.00 | $59.00 | 14% | $15.10 | 1.28 | 4 | $7.83 | **$34.06** | 🟡 breakeven (≥1× CAC) |
| Hand Soap Set — 3 pumps + body lotion | live | $69.00 | $59.00 | 14% | $17.70 | 2.50 | 4 | $7.83 | **$31.46** | 🟡 breakeven (≥1× CAC) |
| Sensitive Skin Moisturizing Set | live | $58.00 | $46.80 | 19% | $10.10 | 0.94 | 2 | $6.68 | **$28.36** | 🟡 breakeven (≥1× CAC) |
| Coconut Deodorant — 4-Pack | live | $60.00 | $53.00 | 12% | $15.36 | 0.63 | 4 | $7.83 | **$27.97** | 🟡 breakeven (≥1× CAC) |
| Two-Step Dry Skin Starter Set | retired | $58.00 | $39.99 | 31% | $10.10 | 0.94 | 2 | $6.68 | **$21.75** | 🟠 thin (<1× CAC) |
| Coconut Bar Soap — 4-Pack | live | $44.00 | $39.00 | 11% | $11.96 | 1.00 | 4 | $7.83 | **$17.78** | 🟠 thin (<1× CAC) |
| Hand Soap Set — 4 pumps | live | $52.00 | $44.00 | 15% | $17.04 | 2.50 | 4 | $7.83 | **$17.55** | 🟠 thin (<1× CAC) |
| Single lotion (reference) | live | $30.00 | $30.00 | 0% | $4.92 | 0.63 | 1 | $6.68 | **$17.23** | 🟠 thin (<1× CAC) |
| Coconut Oil Toothpaste — 3-Pack | live | $39.00 | $34.00 | 13% | $10.05 | 0.75 | 3 | $7.83 | **$14.83** | 🟠 thin (<1× CAC) |
| Pump + Refill | rejected | $39.00 | $34.00 | 13% | $13.05 | 3.43 | 2 | $21.31 | **$-1.65** | ❌ loses money |
| Foam Soap Bundle | retired | $52.00 | $20.02 | 62% | $17.31 | 4.05 | 3 | $21.31 | **$-19.48** | ❌ loses money |

## Why each one exists

- **The 90-Day Clean Swap** (live, $100.85) — Replace the four things you put on your body every day, for a quarter.
- **The 90-Day Coconut Reset** (live, $68.06) — Live on the lean lander, two scents, digital bonuses delivered by Klaviyo.
- **Head-to-Toe** (live, $64.29) — One of everything. Discovery and gifting.
- **Hand Soap Set — 4 pumps + body lotion** (live, $39.82) — The pump ladder: a scent for every sink at full MSRP, or step up to a high-margin lotion so the box clears CAC — 3 pumps for a lighter box, 4 for the full set.
- **Gift Box** (live, $34.32) — Gifting escapes price comparison entirely. Q4. Ships in the custom box ($1/unit).
- **The Clean Swap** (live, $34.06) — Entry version of the 90-day. Turns three weak singles into margin.
- **Hand Soap Set — 3 pumps + body lotion** (live, $31.46) — The pump ladder: a scent for every sink at full MSRP, or step up to a high-margin lotion so the box clears CAC — 3 pumps for a lighter box, 4 for the full set.
- **Sensitive Skin Moisturizing Set** (live, $28.36) — Current hero. Clears the $45 free-shipping threshold on its own.
- **Coconut Deodorant — 4-Pack** (live, $27.97) — Subscription vehicle for deodorant, mirroring the bar soap 4-pack. Replaces the single-deodorant subscription.
- **Two-Step Dry Skin Starter Set** (retired, $21.75) — Deleted 2026-07-26. Same contents as the hero at a deeper discount.
- **Coconut Bar Soap — 4-Pack** (live, $17.78) — Subscription vehicle, every 4 months. Replaces the single-bar sub, which still loses money per shipment. Does not clear the $45 free-shipping threshold — never lead its copy with shipping.
- **Hand Soap Set — 4 pumps** (live, $17.55) — The pump ladder: a scent for every sink at full MSRP, or step up to a high-margin lotion so the box clears CAC — 3 pumps for a lighter box, 4 for the full set.
- **Single lotion (reference)** (live, $17.23) — Reference point, not an offer. Anchor for the $99 bundle.
- **Coconut Oil Toothpaste — 3-Pack** (live, $14.83) — Subscription vehicle for toothpaste. Three flavours means a three-pack: one of each, or three of one.
- **Pump + Refill** (rejected, $-1.65) — Loses money: the refill forces a $21.31 box.
- **Foam Soap Bundle** (retired, $-19.48) — Deleted 2026-07-26 without ever being published — lost ~$19/order.

## SKU table (measured)

| SKU | Price | COGS | Margin | Weight |
|---|--:|--:|--:|--:|
| Body Lotion 8oz | $30.00 | $4.92 | 84% | 10 oz |
| Coconut Moisturizer 4oz | $28.00 | $5.18 | 82% | 5 oz |
| Foam Soap Refill 32oz | $26.00 | $8.79 | 66% | 44.8 oz |
| Lip Balm 4-pack | $15.00 | $5.00 | 67% | 0.4 oz |
| Deodorant | $15.00 | $3.84 | 74% | 2.5 oz |
| Toothpaste | $13.00 | $3.35 | 74% | 4 oz |
| Foaming Soap Pump 8oz | $13.00 | $4.26 | 67% | 10 oz |
| Bar Soap 3.4oz | $11.00 | $2.99 | 73% | 4 oz |

## Freight model

Cost is driven by **package**, not weight — real labels are flat $6.50–8.50 from 0.4 lb to 3.1 lb. Weighted average across all labels: **$7.34**.

| Package | Measured avg |
|---|--:|
| 4x4x4 | $6.58 |
| Bubble Envelope | $6.68 |
| Sample box | $6.91 |
| 4x4x8 | $7.04 |
| Custom box | $7.08 |
| 6x6x4 | $7.18 |
| 8x8x8 | $7.36 |
| 10x5x5 | $7.83 |
| 8x8x4 | $7.94 |
| 9x9x9x | $9.84 |
| 14108 | $9.88 |
| 14x10x4 | $21.31 |

Selection rules live in `estimateShipping()` (`lib/shipping-costs.js`): oversize item → 14x10x4; ≤2 units and <1 lb → bubble envelope; ≤8 units and <3.5 lb → 10x5x5; otherwise a larger box.
