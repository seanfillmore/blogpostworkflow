# Quantity ladders — one page per consumable, several quantities

Design, 2026-08-25. Approved in chat the same day (Approach A; buy-box replacement, bundle republish, and rollout to all three consumables all approved).

---

## The problem

Bar soap is sold as three Shopify products: `coconut-soap` (1 bar, $11), `coconut-bar-soap-4-pack` ($39) and `coconut-bar-soap-12-pack` ($88). They are three URLs with no path between them. A buyer who lands on the 12-pack and does not want twelve bars has no single-click way down to four or one — they have to leave and search again. That is the conversion leak this closes.

The obvious fix — make quantity an option on `coconut-soap` — is **blocked by Shopify**, not by preference:

> "A bundle can't have components and be part of another bundle simultaneously."
> — [Add a variant fixed bundle](https://shopify.dev/docs/apps/build/product-merchandising/bundles/add-variant-fixed-bundle)

`coconut-soap` is a component of seven bundles. Making it a bundle parent breaks all seven. The ladder therefore has to span products rather than live inside one.

## Goal

Each consumable's single-unit PDP becomes the one page for that product, carrying a tier selector. Picking a tier changes what add-to-cart puts in the cart. Each stays the only indexed URL for its product.

| Base product | Template | Tiers | Options per tier |
|---|---|---|--:|
| `coconut-soap` | `landing-page-bar-soap` | 1 / 4 / 12 | 4 + 5 + 5 = 14 |
| `coconut-oil-deodorant` | `landing-page-deodorant` | 1 / 4 | 4 + 5 = 9 |
| `coconut-oil-toothpaste` | `landing-page-toothpaste` | 1 / 3 | 3 + 4 = 7 |

Thirty tier×option combinations across three templates. All three base products already carry their own `landing-page-*` template, so no new template is created.

## Non-goals

- **Subscriptions on the ladder.** Decided out of scope. This matters architecturally: Shopify states *"Bundles can't be sold with selling plans, such as subscriptions, pre-orders, and try-before-you-buy."* Because the ladder's cart targets are componentized bundles, a subscribe toggle cannot be bolted on later without changing the mechanism to quantity-plus-discount. If subscriptions are ever wanted here, that is a redesign, not an increment. Recorded so nobody discovers it mid-sprint.
- **Lotion, cream, lip balm, hand soap.** No single-unit-plus-multipack ladder exists for them today. Out of scope until one does.
- **New products.** Every product involved already exists.

## Architecture

### Where it renders

One new `custom_liquid` block per base product, in that product's existing template, positioned between the option picker and the CTA:

- `templates/product.landing-page-bar-soap.json`
- `templates/product.landing-page-deodorant.json`
- `templates/product.landing-page-toothpaste.json`

`sections/main-product.liquid` is **not touched**. It is 157 KB, shared by every PDP, and declares no `@theme` block support — but it does expose a `custom_liquid` block type, which is already how `theme/blocks/set-value-stack.liquid` is injected. This follows that established pattern.

Every base product already carries its own `landing-page-*` template, so no new template is created and no other product is affected.

**Gallery-scoping check (required by CLAUDE.md, done 2026-08-25):** the alt-text `#` gang mechanism only runs where `hide_variants` is false, so a template change can silently unscope a gallery. Verified for all three:

| Base product | Images | `#` gang-scoped | Mechanism |
|---|--:|--:|---|
| `coconut-soap` | 9 | 0 | variant attachment |
| `coconut-oil-deodorant` | 9 | 0 | variant attachment |
| `coconut-oil-toothpaste` | 8 | 0 | variant attachment |

None use gang scoping, `hide_variants` is not being changed on any of them, and no gallery is at risk. Recorded so it is not re-derived — and note the contrast with `coconut-deodorant-4-pack`, a *tier target* whose 10 images are 100% gang-scoped and which must stay on `scoped-gallery` (see Prerequisite).

### Cart mechanism

The ladder renders **its own form**, posting the selected variant to `/cart/add.js` and then opening the cart drawer.

It deliberately does *not* rewrite the hidden `id` input on Dawn's product form. `product-info.js` rewrites that field on every variant change, so sharing it means fighting theme internals and re-breaking on every Dawn update.

Consequence, accepted: on this template the theme's `variant_picker`, `buy_buttons` and `sticky_cart` blocks are hidden, and the ladder owns the buy box. It has to own the scent selector too, because the scent options differ per tier — the multipacks have a "Variety" option the single bar does not.

### Data model

Three layers, with one rule: **prices are never stored, only read.**

**1. Tier configuration** — a new **top-level** `ladders` key in `config/bundles.json`:

```json
"ladders": [
  {
    "base": "coconut-soap",
    "tiers": ["coconut-soap", "coconut-bar-soap-4-pack", "coconut-bar-soap-12-pack"],
    "default": "coconut-bar-soap-12-pack"
  },
  {
    "base": "coconut-oil-deodorant",
    "tiers": ["coconut-oil-deodorant", "coconut-deodorant-4-pack"],
    "default": "coconut-deodorant-4-pack"
  },
  {
    "base": "coconut-oil-toothpaste",
    "tiers": ["coconut-oil-toothpaste", "coconut-toothpaste-3-pack"],
    "default": "coconut-toothpaste-3-pack"
  }
]
```

Top-level, not nested under a bundle entry, because the base product is `coconut-soap` — a *component*, which has no entry in `bundles[]` at all. A ladder spans a component and its bundles, so it cannot belong to either list.

Tier order is display order. `default` is the pre-selected tier.

**2. Derivation and validation** — `lib/quantity-ladder.js`, pure functions, no I/O:

- `resolveTiers(roster, ladder)` → ordered tier descriptors with unit counts, taken from each bundle's componentization (`sum(component.qty)`), never typed.
- `validateLadder(tiers, catalogue)` → human-readable errors. Fails on: a tier handle absent from the roster or catalogue; a tier product not published; a non-integer or non-monotonic unit count; a price-per-unit that does not decrease as quantity rises.

**3. Rendering** — the Liquid block reads prices live via `all_products['<handle>']` (well under the 20-product-per-page ceiling) and computes display values inline:

- per-unit price = `tier.price / units`
- savings = `tier.compare_at_price - tier.price`
- **free-unit label is derived, never written**: `paid = tier.price / base_unit_price`, `free = units - paid`, rendering "Buy 8, get 4 free". At $88 against an $11 bar that is exactly 8 paid and 4 free. If the bar is repriced, the label follows or the validator fails — it cannot silently lie.

  **The free-unit framing renders only when `paid` is a whole number** (within one cent of tolerance). This is not an edge case — across all six multipack tiers, **exactly one qualifies**:

  | Tier | Arithmetic | Framing |
  |---|---|---|
  | Bar soap 12-pack | `88 / 11 = 8` ✓ | **Buy 8, get 4 free** |
  | Bar soap 4-pack | `39 / 11 = 3.545` | Save $5 |
  | Deodorant 4-pack | `53 / 15 = 3.53` | Save $7 |
  | Toothpaste 3-pack | `34 / 13 = 2.615` | Save $5 |

  Rendering the others as free units would print "Buy 3.5, get 0.5 free". Tiers that fail the whole-number test fall back to a savings label. Each tier picks its own framing independently; they do not have to match, and a page may show one of each.

This follows `docs/bundle-landing-architecture.md`'s rule: *"Only `product.price` and `compareAtPrice` come from Shopify commerce data... Nothing is a literal, and no total is ever asserted — it is summed."*

Only display arithmetic exists in both Liquid and JS. The validator's job is to catch divergence: it recomputes the same values from live data and fails if any tier would render something incoherent.

### Scent / flavour handling

Tier and option together resolve to exactly one variant. The single-unit product offers only its own scents; every multipack additionally offers a Variety variant.

| Ladder | Single unit | Multipack tiers |
|---|---|---|
| Soap | 4 scents | Variety + 4 (both 4-pack and 12-pack) |
| Deodorant | 4 scents | Variety + 4 |
| Toothpaste | 3 flavours | Variety + 3 |

Note the option axis is named differently per product — soap and deodorant use **Scent**, toothpaste uses **Flavor**. The block reads the option name off the product rather than assuming "Scent", or the toothpaste ladder silently fails to match.

On tier change the chosen option is preserved if the new tier offers it; otherwise it falls back to Variety for a multipack, or the first option for the single unit. Default state is the ladder's `default` tier plus Variety.

### The tier-target URLs

Multipack products stay **published** — they must be, to be purchasable as cart targets — but are excluded from collections and served `noindex`, so each base product's URL remains the single indexed one for its product. This is deliberate under the collection-architecture rule: one page accumulating signal, not several competing for the same query.

## Error handling

- **Tier product unavailable** (unpublished, deleted): the tier is omitted from the rendered ladder rather than rendered broken, and the validator reports it. The page degrades to the tiers that work.
- **Variant out of stock**: the tier card renders sold-out and the CTA is disabled for that tier+scent pair. Other tiers stay buyable.
- **`/cart/add.js` failure**: the error surfaces inline next to the CTA. No silent failure, no spinner that never resolves.
- **No JavaScript**: the default tier's form submits natively to `/cart/add`, so the page is still buyable.

## Testing

**Unit** (`tests/lib/quantity-ladder.test.js`, no network): tier resolution from componentization; unit counts; per-unit price; free-unit derivation including the non-integer case; monotonicity; every `validateLadder` failure mode.

**Integration** (validator against live Shopify): every tier handle resolves, is published, and its componentized unit count matches the roster.

**Live** (the check that actually counts, per `feedback_verify_live_after_mutating_agents`): all three pages return 200; for each of the **30** tier×option combinations (14 soap + 9 deodorant + 7 toothpaste), add-to-cart lands the expected variant ID and quantity in a real cart; the theme's own buy box is not double-rendered on any of the three.

Ship one ladder first. Soap goes live and is verified end-to-end before the deodorant and toothpaste templates are touched — three templates changed at once is three ways to break a PDP with one deploy, and the per-product config makes staggering free.

## Rollout and rollback

`scripts/update-theme-asset.mjs put` writes the current live copy to `theme/backup/<key>` before every write, so the template has an exact way back. A full rollback theme (`Real Skin Care — Rollback (8.3.2)`) also exists.

**The theme is not deployed by `git pull`** (`reference_theme_not_auto_deployed`). The block source lives in the repo under `theme/blocks/` and is pushed explicitly by script; the rendered page must be fetched and checked afterward, not assumed.

## Risks

| Risk | Mitigation |
|---|---|
| Dawn `product-info.js` interactions | Ladder owns its own form; theme buy box hidden on this template only |
| Theme not fully version-controlled | Block source committed under `theme/blocks/`; deploys go through `update-theme-asset.mjs`, which backs up first |
| Tier products drift back to DRAFT | Real and recurring (8 were dark on 2026-08-25, unnoticed). The validator treats an unpublished tier as an error, so the ladder reports it instead of silently losing a tier. A standing fleet check that alerts on roster-`live`-but-Shopify-`DRAFT` is tracked separately — the ladder makes the drift *visible*, but only a scheduled check makes it *noticed* |
| Subscribe & Save wanted later | Not incrementally addable — documented in Non-goals as a redesign |

## Prerequisite — done

The 4-Pack tier adds a variant of `coconut-bar-soap-4-pack`, which returned 404. Eight roster-`live` bundles were DRAFT. Republished 2026-08-25 (PR #670); all 12 bundle URLs now return 200, and the deodorant 4-pack's gang-scoped gallery was preserved by correcting its `templateSuffix` first.
