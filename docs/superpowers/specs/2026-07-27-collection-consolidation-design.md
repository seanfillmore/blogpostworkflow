# Collection Consolidation and the End of Keyword-Driven Collection Creation

**Date:** 2026-07-27
**Status:** Approved in principle; spec pending review
**Decision owner:** Sean

## Problem

The store has **62 live collections for 9 distinct products**. They were generated to chase
keyword rankings. They are not ranking, and they are splitting the signal of the products
they point at.

90 days of Search Console, live store:

| | URLs | Impressions | Clicks | CTR |
|---|---|---|---|---|
| All collections | 71 | 93,785 | 51 | 0.054% |
| All PDPs | — | 22,257 | 8 | 0.036% |

**57 of the 71 collection URLs earned zero clicks**, carrying 46,926 impressions between
them. The lotion category alone runs 29 collection URLs for 2 products: 59,616 impressions,
38 clicks.

The catalog is 19 products, of which 10 carry a `bundle` / `value-set` tag. That leaves
**9 distinct single products**:

`coconut-lotion`, `coconut-moisturizer`, `coconut-soap`, `organic-foaming-hand-soap`,
`foam-soap-refill-32oz`, `coconut-oil-deodorant`, `coconut-oil-toothpaste`,
`coconut-oil-lip-balm`, `cut-and-scrape`.

## The rule

**A collection exists only where a category holds 2 or more distinct products. Single-product
categories are PDP-only. A collection is never created to chase a keyword.**

Multipacks and value-sets are the same product in a different quantity, not a second product.
`coconut-deodorant-4-pack` does not make deodorant a two-SKU category. The `bundle` /
`value-set` product tag is the machine-readable test.

## Category map

| Category | Distinct SKUs | Verdict | Collections today | 90d impr | 90d clicks |
|---|---|---|---|---|---|
| Lotion | 2 | **Collection** | 29 | 59,616 | 38 |
| Hand soap | 2 (dispenser, refill) | **Collection** | 2 | ~2,500 | 0 |
| Toothpaste | 1 | PDP only | 12 | 9,645 | **0** |
| Lip balm | 1 | PDP only | 5 | 6,356 | 1 |
| Bar soap | 1 | PDP only | 4 identified | ~4,000 | 2 |
| Deodorant | 1 | PDP only | 7 | 2,620 | **0** |
| Cut & scrape | 1 | PDP only | 0 | — | — |

Soap totals 10 collection URLs / 7,773 impressions / 3 clicks; the split above between bar and
hand is derived from handle intent and is the one place the implementation plan must confirm
per-URL rather than inherit from this table.

**Survivors — four collections:**

1. **`non-toxic-body-lotion`** — absorbs all 28 other lotion URLs. Holds `coconut-lotion`
   and `coconut-moisturizer`.
2. **`foaming-hand-soap`** — absorbs the hand-soap URLs. Currently holds 1 product;
   `foam-soap-refill-32oz` must be added, which is what makes it a legitimate two-SKU
   category rather than a PDP duplicate.
3. **`all-products`** — the native catch-all, 19 products. Retained and optimized; its
   `body_html` is currently empty. Its 0.79% CTR is brand traffic, not browse-page quality —
   see Workstream D.
4. **`sets-and-bundles`** — new smart collection, added 2026-07-27 at Sean's direction. See
   "Workstream C" below for why this is consistent with the rule rather than an exception to it.

Everything else 301s to its category's survivor, or to the category's PDP where the category
is single-product.

### Why `non-toxic-body-lotion` and not the higher-traffic alternatives

`coconut-oil-lotion` has more impressions (8,045 vs 4,668) and `organic-body-lotion` has more
clicks (13 vs 9). `non-toxic-body-lotion` still wins:

- It matches the product's own title — "Non-Toxic Body Lotion Made With Only 6 Clean
  Ingredients" — so the page, the product, and the query agree.
- The surviving collection must now serve *all* lotion intent. `coconut-oil-lotion` is
  scoped to one ingredient and would be a poor destination for "non-toxic body lotion"
  or "fragrance free lotion" traffic.
- "Organic" is a substantiation risk we should not build the category page's identity on.

The 13 clicks on `organic-body-lotion` are not discarded — that URL 301s into the survivor.

## Workstream A — the consolidation mechanism

The pattern already proven in the 2026-07-20 toothpaste consolidation:

1. `updateCustomCollection` / `updateSmartCollection` with `{ published: false }`.
2. `createRedirect` from the old path to the canonical target.
3. **Guard: never redirect to an unpublished or missing target.** Verify the target returns
   200 before writing the redirect.
4. Cloudflare caches collection URLs for ~10s, so a post-mutation `curl` can still return the
   old 200. Confirm via the API's `published_at` and the redirect's existence, then re-curl.

Two conditions in the current data need handling beyond a plain redirect:

- **Live collections with zero products** (e.g. `best-coconut-body-lotion`, 279 impressions).
  Empty published collections are the landmine from the June cleanup. They redirect like any
  other source.
- **Draft collections still earning impressions** — `best-non-toxic-lotion` carries 1,851
  impressions and `coconut-scented-body-lotion` 864, both unpublished. Google is still
  serving pages that now 404. These need redirects *more* urgently than the live ones,
  because they are actively bleeding.

Each surviving collection then gets a prominent above-the-fold link to its primary PDP —
`sets-and-bundles` to the highest-AOV bundle. That is what makes this "focus clicks on the PDP"
rather than merely tidier collections.

## Workstream B — the operating change

The cleanup is worthless without this. Three changes, or the fleet regenerates the sprawl
within weeks:

1. **`scheduler.js`** — remove `collection-creator --from-opportunities --queue` and
   `collection-creator --publish-approved` from the Sunday block. The agent stays in the
   repo for deliberate manual use; it stops running on a timer.
2. **`lib/seo-opportunities.js`** — `COLLECTION_BOOST = 1.6` currently ranks "build another
   collection" above every other opportunity type, ahead of `PRODUCT_BOOST = 1.5`. Drop it
   below product so the analyzer stops steering here.
3. **`CLAUDE.md`** — the Prime Directive section instructs agents to "prioritize
   creating/optimizing collection and product pages" on the strength of "collections ≈80% of
   ecommerce SEO revenue." That statistic describes stores with hundreds of SKUs, where
   collections are genuine browse pages. With 9 products it does not transfer, and following
   it produced 62 collections. Replace it with the rule above.

## Workstream C — the bundles collection

**Create `sets-and-bundles` as a smart collection with the rule `tag equals bundle`.** Ten
products carry that tag, so this satisfies the 2+ distinct products rule on its own terms; it
is not an exception. Being tag-driven, it maintains itself as bundles are added or retired,
which is the property a hand-curated custom collection would lack.

**Justify it on merchandising, not search.** Genuine bundle/set query demand is roughly 130
impressions across 90 days — `day and night moisturizer set` (18), `skincare set for dry
sensitive skin` (9), `moisturizer set` (6), and a long tail of ones and twos. Building this
page to capture that traffic would be precisely the keyword-chasing this project exists to
stop. The case for it is that bundles run $39–159 against a $50.46 AOV, and browse and
cross-sell currently have no destination.

**Record the expectation now, so the page is judged correctly later:** this collection should
earn approximately no organic search traffic. If it is reviewed on rankings in three months it
will look like a failure while doing exactly its job. Its measure is AOV and bundle
attach-rate, not impressions.

Exclude `99-coconut-reset-digital` — it is a digital product and does not belong in a physical
sets page.

## Workstream D — `all-products`

`all-products` is a live smart collection of 19 products whose `body_html` is **empty**. It has
no description, no intro copy, nothing for a browse visitor or a crawler to read.

Its 0.79% CTR — 15× the site average — must not be misread as evidence that the page is well
built. Its top queries are `real skin care` (409 impressions), `real skincare` (242), and
`realskincare` (position 1.0). It performs because it catches the **brand name**, not because
it is a good category page. An earlier reading of this number in conversation drew the opposite
conclusion and was wrong.

Optimize it as a genuine browse page — a real description covering the catalog, and internal
links to the surviving category collections and the primary PDPs. Do **not** optimize it for
brand queries: it is one of the pages competing with the homepage for the brand term, which
Workstream E addresses.

## Workstream E — brand-query cannibalization

Brand queries (`real skin care`, `realskincare`, and variants) draw **9,723 impressions and 170
clicks over 90 days, a 1.75% CTR**. The homepage takes only 1,290 of those impressions, at
**average position 4.5**, while these internal pages rank above it:

| Page | Impressions | Clicks | Position |
|---|---|---|---|
| `/` | 1,290 | 145 | 4.5 |
| `/products/coconut-lotion` | 756 | 0 | 3.0 |
| `/collections/all-products` | 722 | 5 | 3.7 |
| `/collections/organic-body-lotion` | 674 | 13 | 3.1 |
| `/collections` | 554 | 1 | 5.3 |

Brand searchers already know the brand; they are the highest-intent traffic the site has.
Ranking fourth for your own name wastes it.

**Two fixes, both small:**

1. **Homepage title** is `Coconut Oil Based Skin Care Products | Real Skin Care` — the brand
   sits last. Lead with it: `Real Skin Care | Coconut Oil Skin Care for Sensitive Skin` or
   similar. The exact string is a copy decision; the requirement is brand-first.
2. **Homepage meta description is 352 characters** of general copy that never names the brand.
   Google truncates near 155. Rewrite it brand-first and specific.

**What the consolidation fixes for free:** `organic-body-lotion` (674 brand impressions,
position 3.1) is being redirected by Workstream A, removing one competitor outright. That is
the argument for doing these together rather than sequentially.

**Explicitly NOT a defect, having been checked:** the indexed Shopping-feed URLs
(`?utm_medium=product_sync&utm_source=google&utm_content=sag_organic`) that appear at position
1.0 with zero clicks are **not** a canonical bug. Their canonical tags correctly point at the
clean PDP — verified by fetching both. That tagging is Shopify's Google channel free-listing
pattern, so those rows describe a Shopping surface, not organic web results, and a product-grid
placement with no clicks is unremarkable there. An earlier reading in conversation called this a
parameter-handling bug; it is not, and no work should be spent on it.

## Workstream F — navigation

Added 2026-07-27 at Sean's direction. Without this, the site's own navigation points at 301s
on every page.

### Current state

> **Read this section's numbers from the Admin API, not from rendered HTML.** Two earlier
> drafts described this navigation by counting link occurrences in the homepage source and were
> wrong both times — first claiming the header held 6 collection links plus 8 PDP links, then
> claiming the footer enumerated 30 collections. The figures below come from the `menus`
> GraphQL query and supersede both.

**Authoritative state (Admin API, 2026-07-27).** The store has **12 menus**; 5 contain
collection links. **49 menu items point at a collection, across 35 distinct collection URLs.**

| Menu | Handle | Collection links |
|---|---|---|
| Product Menu (the visible header) | `product-menu` | 32 |
| Main menu | `main-menu` | 8 |
| Catalog sidebar | `sidebar-menu` | 7 |
| Footer menu | `footer` | 1 (`on-sale`) |
| Multi main | `multi-main` | 1 |

The footer menu holds **one** collection link. It does not enumerate collections.

**`product-menu` — the header — already links its 7 top-level items to the PDPs:**

| Top-level label | Dropdown children |
|---|---|
| Lotion | Coconut Oil, Lavender, Natural Body, Non Toxic body, Rose, Unscented (6) |
| Body Cream | Coconut, Moisturizing, Natural (3) |
| Toothpaste | Cinnamon, Mint, Fluoride Free, Natural, SLS Free, Vegan (6) |
| Deodorant | Aluminum Free, Natural, Non Toxic, Roll-on, Vegan (5) |
| Liquid Soap | Foaming Hand Soap, Foaming Soap Dispenser, Orange (3) |
| Bar Soap | Coconut, Men's Natural, Natural Bar, Organic Bar, Vegan (5) |
| Lip Balm | Coconut, Organic, Natural, Vegan (4) |

Every one of those 7 top-level items is already `type: PRODUCT` pointing at the correct PDP.
The dropdowns hang off links that are already right. **No retargeting is required — the work
is deleting the 32 children.**

**Footer** (rendered on every page): **30 collection links**, of which **28 are being
redirected** — only `all-products` and `non-toxic-body-lotion` survive. This is the single
largest internal-link signal on the site, and it currently points almost entirely at pages this
project removes. Cleaning it matters as much as the redirects themselves.

### Target

**Header — delete every dropdown; each top-level label links straight to its PDP.**

The existing 7 labels already map one-to-one onto the 7 primary products, so this is a
retarget rather than a redesign. Keep the labels, delete all 32 children:

| Top-level label | Links to |
|---|---|
| Lotion | `/products/coconut-lotion` |
| Body Cream | `/products/coconut-moisturizer` |
| Toothpaste | `/products/coconut-oil-toothpaste` |
| Deodorant | `/products/coconut-oil-deodorant` |
| Liquid Soap | `/products/organic-foaming-hand-soap` |
| Bar Soap | `/products/coconut-soap` |
| Lip Balm | `/products/coconut-oil-lip-balm` |

Plus `Sets & Bundles` → `/collections/sets-and-bundles`, and the existing About/Support items.

The category labels are worth keeping as anchor text: "Lotion" and "Toothpaste" describe what
the visitor wants better than the product titles do, and they pass category-relevant anchor
text to the PDPs that must now rank for those terms.

Two of the nine products stay off the top level. **`foam-soap-refill-32oz`** is an accessory
whose home is the hand-soap PDP and the hand-soap collection; **`cut-and-scrape`** sits outside
the skin-care line. Both remain reachable via `/collections`, search, and cross-links.

**Footer — a single `Collections` link** pointing at `/collections`, replacing all 30 current
collection links. Revised 2026-07-27 at Sean's direction: the footer does not enumerate
collections.

`/collections` is Shopify's native collection index. It already exists, returns 200, and lists
every published collection — so once Workstream A runs, it lists the four survivors
automatically with no maintenance. Nothing needs to be built.

Collections remain reachable from `/collections`, from PDP cross-links, and from the sitemap.

**Two defects on `/collections` to fix while we are pointing the whole site's footer at it:**

1. **Its meta description is the homepage's, verbatim** — the same 352-character block of
   general copy. Give it its own, describing what the page is.
2. **It is competing for brand queries** — 554 impressions at average position 5.3 for
   `real skin care` variants, one of the pages outranking the homepage in Workstream E. Its
   title (`Collections – Real Skin Care`) and duplicated brand-heavy meta are why. Distinct
   copy reduces that overlap, so this fix serves both workstreams.

Note the interaction: adding a sitewide footer link to `/collections` strengthens it
internally, which pulls against Workstream E unless its title and meta are made
category-specific rather than brand-specific. Doing (1) and (2) is therefore a requirement of
this change, not an optional polish.

`/collections` has no admin-editable SEO fields — it is theme-controlled, so this is a
`templates/list-collections` edit. The app holds `write_themes`, so unlike the menus themselves
this part *can* be automated.

### Menu edits are automatable

`write_online_store_navigation` was granted 2026-07-27, verified against
`oauth/access_scopes.json` (28 scopes, `read_` and `write_online_store_navigation` both
present). `shopifyGraphQL` is already exported from `lib/shopify.js`, and the `menus` query
returns the full structure with item IDs. Menu changes go through `menuUpdate`; no manual admin
work is required.

An earlier draft of this spec stated these edits could not be automated. That is no longer
true.

### Per-menu changes

| Menu | Change |
|---|---|
| `product-menu` | Delete all 32 children. Keep the 7 top-level PDP links unchanged. Add `Sets & Bundles` → `/collections/sets-and-bundles`. |
| `main-menu` | Delete the 7 collection children under `Shop`. Keep `Shop` itself, which already points at `/collections` — that is the Collections link. |
| `sidebar-menu` | Retarget its 7 collection links to the matching PDPs, mirroring `product-menu`. |
| `footer` | Leave the single `on-sale` link, subject to the decision below. |
| `multi-main` | Same. |

**Two utility collections need a decision, and neither is a category:**

- **`on-sale`** — merchandising, not keyword-chasing. Recommend keeping it, on the same
  footing as `sets-and-bundles`: it exists to sell, not to rank. It carries 50 impressions and
  0 clicks, so nothing is lost either way.
- **`live-collection`** — 108 impressions, 0 clicks, and appears to be leftover plumbing from a
  live-selling app rather than anything deliberate. Recommend redirecting it with the rest.

### Sequencing

Navigation should be updated in the same change window as the redirects. If the redirects land
first, every header and footer link becomes a 301 hop until the menus are fixed — functional,
but it wastes crawl budget across every page on the site and leaves the internal link graph
pointing at dead ends. If navigation cannot be updated first, run it immediately after and treat
the gap as a known temporary state rather than a finished result.

## What this does not promise

Consolidation alone will not convert 93,785 impressions into revenue. Site-wide CTR is 0.054%
because these pages rank at positions 25–62, and PDPs are no better at 0.036%. Nothing on page
3+ gets clicked regardless of page type.

The bet is that concentrating 29 lotion URLs into 1 lifts position enough to matter. That is
well-founded and cheap to test, but it is a hypothesis. If the survivor still lands at position
40, the outcome is a cleaner site earning the same $0. The structural case for doing it stands
either way: 62 near-duplicate pages for 9 products is indefensible on its own terms.

## Risk

The exposure is almost entirely in lotion. The three PDP-only categories with the loudest
keyword histories — toothpaste, lip balm, deodorant — together carry **18,621 impressions and
1 click across 24 URLs**. Redirecting them costs nothing measurable.

This corrects an earlier assessment in the conversation that called deodorant the riskiest move
because it is the strongest organic cluster. Deodorant's *collections* earn zero; whatever
strength that cluster has lives in its blog posts and PDP.

## Measurement

Already wired, no new instrumentation:

- `rank-tracker` (DataForSEO) tracks the target queries daily; `rank-alerter` notifies on
  movement.
- `logChangeEvent({ url, slug, category: 'seo', targetQuery })` per survivor gives
  `change-verdict` a 28-day window.
- Caveat carried from the toothpaste work: `change-log captureBaseline` reads GSC daily
  snapshots, which store only top pages, so low-ranking collections get an `impr=0` baseline.
  **The trustworthy signal is rank-tracker on the query, not the change-log window.**

## Out of scope

- Collection-scoped product URLs (`/collections/rose-lotion/products/coconut-moisturizer?variant=…`)
  are duplicating PDPs, but that is a canonical-tag question, not a consolidation one.
- ~~The bundle products have no collection; creating one deserves its own decision.~~
  **Resolved 2026-07-27: in scope — see Workstream C.**
- Non-lotion, non-soap collections with zero impressions and zero products are swept by the
  same redirect pass but are not individually analysed here.

## Success criteria

1. Live collection count drops from 62 to 4 (the three survivors plus `sets-and-bundles`).
2. Every redirected source returns 301 to a target returning 200. No redirect points at an
   unpublished or missing target.
3. No live collection has zero products.
4. No unpublished collection is left 404ing on non-zero impressions.
5. `scheduler.js` no longer invokes `collection-creator` on a timer, and
   `COLLECTION_BOOST < PRODUCT_BOOST`.
6. `all-products` has a non-empty description and links to the surviving collections and
   primary PDPs.
7. `sets-and-bundles` exists as a smart collection on `tag equals bundle`, holding the 9
   physical bundle products, and is linked from the store's navigation.
8. The homepage title and meta description lead with the brand, and the meta description is
   under 160 characters.
9. No menu item points at a redirected collection. Across all 12 menus, the 49 collection-
   pointing items reduce to the survivors plus any retained utility collection: `product-menu`
   has no dropdowns, `main-menu`'s `Shop` still points at `/collections`, and `sidebar-menu`
   points at PDPs.
10. `/collections` has its own meta description rather than the homepage's, and a title that
   does not compete with the homepage for brand queries.
11. At 28 days: the lotion survivor's average position on its target queries has improved
   against the rank-tracker baseline, and the homepage's average position on brand queries has
   improved from 4.5. These are the two hypotheses under test — a null result on either is an
   acceptable outcome to learn, not a failure to hide.

## Amendment log

- **2026-07-27, after initial approval:** added Workstream C (bundles collection) and
  Workstream D (`all-products`) at Sean's direction, and Workstream E (brand-query
  cannibalization) which was discovered while investigating D and folded in at his direction
  rather than deferred.
- **2026-07-27, later:** added Workstream F (navigation) after Sean flagged that collections are
  linked from the main menu. Investigation found the footer links 30 collections on every page,
  28 of which this project redirects, and that menu edits cannot be automated with the current
  app scopes.
- **2026-07-27, revised twice more:** footer reduced from a four-item category block to one
  `Collections` link to Shopify's native `/collections` index (Sean); header top level changed
  from a `Shop` dropdown to direct PDP links (Sean).
- **2026-07-27, corrected against a screenshot:** the header is 7 category labels opening
  dropdowns of collection links, not the flat list an earlier draft inferred from raw HTML.
- **2026-07-27, corrected again against the Admin API** — the authoritative source, after two
  wrong readings taken from rendered HTML. 12 menus exist; 5 carry collection links; 49 items
  point at 35 distinct collections. The footer menu holds ONE collection link, not 30. And
  `product-menu`'s 7 top-level items already point at the correct PDPs, so the header work is
  purely deleting 32 children, not retargeting anything. **Lesson for the plan: read navigation
  from the `menus` GraphQL query, never from page source.**
- **2026-07-27:** `write_online_store_navigation` granted by Sean and verified; menu edits are
  automatable via `menuUpdate`, superseding the earlier "manual admin work required" constraint.
