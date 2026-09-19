# Meta paid launch — $50/day cold start

**Status:** proposed, not started. Nothing has been written to Meta, Google, Shopify, Klaviyo or the theme.
**Date:** 2026-09-19
**Operator:** Sean, solo. No designer, no media buyer.

---

## The decision this document records

Run a cold-start Meta program at **$50/day**, optimized for **AddToCart**, against **broad US targeting**, judged at pre-registered weekly checkpoints rather than on final ROAS.

The purpose is **not** a profitable month. It is to buy three assets this business does not have: a measured CAC, a validated creative angle, and a retargeting pool of several thousand people. Book the spend as tuition.

### Why not the obvious alternatives

**Why not Purchase optimization?** Meta wants ~50 optimization events per week to exit the learning phase. At any budget this business will run, 50 purchases/week is unreachable — the store takes ~50 orders per *quarter*. This is arithmetic, not caution. AddToCart is the deepest event $50/day can plausibly generate 50 of.

**Why not retargeting/DPA first?** Measured 2026-09-19: the US product-viewer pool is **1,541 people over 180 days**, which is 460–770 matchable on Meta. At the account's measured $65.82 CPM, $50/day would hit that pool **7–12 times per person per week** — straight into exhaustion. The pools that *are* large enough (the 5,663-record customer list) are ~83% giveaway signups, a population that returned 0.31% CTR and **0 conversions** on the draw-day email. See `project_meta_dpa_never_used`. **Retargeting is premature, not wrong — this campaign is what builds the pool that makes it viable.**

**Why not Google Shopping instead?** It is currently bid-capped at $0.40 (a deliberate 2026-09-01 change) below its $0.42–0.60 clearing price, because the offer cannot profitably pay more. That is a real constraint and the quantity ladder is what lifts it. Shopping and this are not alternatives; the ladder unblocks both.

---

## The single most important setting

**Broad targeting. No interest stacks.**

The prior cold campaign ran **seven interest ad sets at $10/day** and paid a **$65.82 CPM** — narrow audiences have thin auction liquidity. Broad typically runs $15–25 in this vertical.

| | at $65 CPM (measured) | at $20 CPM (target) |
|---|--:|--:|
| impressions/day | 760 | **2,500** |
| clicks/day @ 1.5% link CTR | 9 | **37** |
| clicks/week | 63 | **262** |

Same $50. Roughly 4× the traffic. **This one setting is worth more than any creative decision in this document.**

---

## Build

### Campaign

| setting | value | why |
|---|---|---|
| Objective | Sales | Never Traffic or Engagement — Meta delivers literally what you ask for |
| Budget | **CBO, $50/day**, campaign level | One budget, one pool. Ad-set budgets fragment learning |
| Bid strategy | Lowest cost, no cap | A cap starves delivery before the account knows what good costs |
| Attribution | 7-day click / 1-day view | Meta's default — every external benchmark assumes it |
| Ad sets | **exactly one** | Splitting $50 guarantees nothing ever learns |

### Ad set

| setting | value |
|---|---|
| Optimization event | **AddToCart** |
| Location | **United States only** |
| Age | 25–65 |
| Detailed targeting | **NONE** — no interests, no behaviours |
| Advantage+ audience | ON |
| Exclusions | Purchasers (suppression audience, see below) |
| Placements | Advantage+ (all) |

### Ad

**One 3-2-2 flexible ad**: 3 statics (same format, same aspect ratio) × 2 meaningfully different primary texts × 2 headlines = 12 combinations sharing a single learning pool.

- **Judge it as one unit.** Per-permutation reporting does not exist, and at this volume it would be noise.
- Statics come from the ~128 accepted text-free plates in `data/creatives/ad-studio/` plus the 12 lotion/cream concepts from 2026-09-19. The bottleneck is Photoshop typesetting, not generation.
- The three creatives should differ by **pain angle**, not demographic — one physical-symptom, one appearance, one ingredient/trust. Angles are in `data/context/personas.json` as filtered by `data/context/operator-angles.json`.
- **Product-aware angles first** (us-vs-them, "if you've tried X"). These harvest in-market buyers and seed the pixel with real conversion data.
- UTM-tag it. No ad in this account's history ever has.

### Landing page

**Preferred:** the lotion PDP once the quantity ladder ships. Best first-purchase cohort evidence in the catalogue (n=310, 15.9% Wilson lower bound) and the highest-traffic commercial page (202 landing sessions in 24 days).

**Available today:** `/products/sensitive-skin-starter-set` — **the only page on the site that argues before asking for the sale** (319 words and 6 headings above the buy box, `#buy-box` anchor CTA). Every other PDP puts a buy box within ~35 words. **It must be published to Facebook & Instagram first; it currently is not.**

---

## Prerequisites

All cheap, all needed regardless of whether this campaign runs.

| # | task | why | write? |
|--:|---|---|:--:|
| 1 | **Re-grant the Meta token** | `FACEBOOK_ACCESS_TOKEN` expires **2026-10-19** — day 30 of a 30-day campaign. Note `META_USER_ACCESS_TOKEN` is a system-user token that never expires and carries `catalog_management`; prefer it for catalog work | yes |
| 2 | **Confirm and fix Purchase deduplication** | 29 pixel Purchases vs 17 Shopify orders, ~2× on 11 of 12 days. Browser pixel and server CAPI landing without a shared `event_id`. Every ROAS figure is unreliable until fixed | yes |
| 3 | **Publish the 13 bundles + `sensitive-skin-starter-set` to Facebook & Instagram** | 15 of 23 products are missing from the channel — also ~20% of ViewContent that builds zero retargeting signal. Fixes the catalog gap and the pre-sell-page gap in one setting | yes |
| 4 | **Build the retargeting audience now, leave it unused** | US-only, PageView + ViewContent, 180-day retention. Costs nothing and accrues from day one. The existing one (`23855316387760172`) is a **stale 2023 prefill** reading 20 people, never recomputed because never used | yes |
| 5 | **Build a purchaser suppression audience** | 801 all-time purchasers. Stops paying to re-acquire existing customers | yes |
| 6 | **Pick one Facebook Page** | Two exist; `100780896269817` has no Instagram linked, which degrades IG placements. Use `113847674946808` | yes |
| 7 | **Fire `content_ids` on InitiateCheckout** | Currently 0 matched *and* 0 unmatched — the parameter is absent entirely | yes |
| 8 | **Fix 8 of 34 catalog items reading `PRODUCT_OUT_OF_STOCK`** | MUST_FIX; excluded from dynamic ads | yes |

**Never upload the raw Shopify customer list.** 2,948 of 8,611 records are the disqualified giveaway bots, every one flagged `subscribed`. Only 953 of 8,669 have ever ordered.

---

## Checkpoints

At this volume the final ROAS will be noise. These will not be. **Each failure points at one thing, which is the entire reason to run a two-element funnel.**

| week | question | pass | fail means |
|---|---|---|---|
| **1–2** | Is broad targeting fixing delivery? | CPM < $25 **and** link CTR > 1% | Creative or targeting. Cheapest thing to fix |
| **3–4** | Is the offer earning carts? | cost per ATC < $5 | The offer or the landing page |
| **5–8** | Is the cart converting? | ATC → checkout > 50% | The cart leak — see `project_add_to_cart_checkout_leak` |
| **9–12** | What does a customer cost? | CAC readable; retargeting pool > 3,000 | Re-decide the whole program on real data |

### Rules

- **No account edits for the first 10–14 days.** Every edit restarts learning. Analysis and creative prep continue; account changes do not.
- **Do not launch new ads alongside a running one.** A new ad is handed the warmest pool and makes the running ads look dead. New angles go into the *next rebuild* of the flexible ad.
- **Scale in ≤5% steps**, and only after 7 days beating target. Expect cost per result to look worse right after a bump — that is a denominator effect, not degradation.
- **Kill an individual ad** at ~$100 spend with zero results, ~$50 if it produced literally nothing. Inside the first learning window, **the freeze wins**.
- **Do not force budget toward the ad with the best apparent cost per result.** That efficiency is an artifact of small delivery.

### Pre-registered stop

**If week 1–2 fails on both CPM and CTR after one creative rebuild, stop.** That is the cheapest possible failure and it means the creative cannot earn attention at a price this offer can pay. Do not spend the remaining budget discovering it slowly.

---

## What this costs and what it buys

| | |
|---|--:|
| 30 days | $1,500 — ~1,100 clicks; a first read on CPM and CTR. **Not enough to know CAC** |
| 90 days | **$4,500** — a measured CAC, a validated angle, a retargeting pool of several thousand |

Against ~$2,700/mo revenue this is real money. The honest expectation is a **loss across the window**, and the deliverable is the three assets above rather than a positive ROAS. Name the acceptable loss before launching; do not rediscover it in month two.

---

## Dependencies outside this document

1. **The quantity ladder** (`project_paid_lotion_readiness`) — lifts contribution from ~$41 to $59–78 and the affordable CPC from $0.42 to $0.52–0.74. Blocked on publishing the DRAFT 4-pack and on removing Recurpay from the lotion PDP (a Shopify platform constraint: bundles cannot carry selling plans). **Subscriber contracts are unaffected by a theme-only removal** — a contract is a snapshot, not a pointer.
2. **The add-to-cart → checkout leak** (`project_add_to_cart_checkout_leak`) — 70.8% of clean-traffic carts never start checkout. **Optimizing for ATC while 70% of carts die is buying a broken step.** These two run together, not in sequence.

---

## Things measured on 2026-09-19 that this plan rests on

| figure | value | note |
|---|--:|---|
| Clean US commercial CVR | **0.87%** | n=5 orders. Quote 0.7–1.0%, never the decimal |
| 90-day AOV | **$54.73** mean / $38.32 median | n=49. The 28-day figure is unusable |
| Contribution, lotion order (2.02 bottles) | **~$41** | |
| Contribution, 90-Day Coconut Reset | **$80.29** | 66% margin |
| Repeat rate, current regime | **14.6%** | n=103. The 20.6% on record is refuted |
| Later revenue per acquired customer | **$11.31** | |
| Measured CPM, sales objective | **$65.82** | the number broad targeting must fix |
| Measured link CTR, cold purchase ad | **1.22%** | |
| Benchmark cold skincare CPA | **$55–110** | retargeting $28–55 |

**Published "median Meta CPC $0.57" is Clicks (All), not link clicks.** Like-for-like median link CPC is $0.85–$1.70; realistic cold US skincare is **$1.50–$3.50**. Do not compare a measured cost-per-link-click against an all-clicks benchmark.
