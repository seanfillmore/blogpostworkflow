# Bundle roster build — design

Written 2026-07-26. Sub-project **A** of four; see [Scope boundary](#scope-boundary).

Build the three remaining bundles in the roster as componentized Shopify products, driven by a declarative spec file that later becomes the input to demand forecasting.

---

## 1. Why this, and why now

Five bundles are live and nothing links to them yet, so the build carries almost no risk — a broken bundle page today is seen by nobody. That window is the reason to build the rest now rather than incrementally alongside traffic.

The roster also has to exist before sales can be forecast. A forecast needs unit demand per component, which means every bundle's exact component mapping has to be written down somewhere machine-readable. Today it lives in three places that disagree: Shopify's variant relationships, the aggregate `items` counts hardcoded in `scripts/bundle-economics.mjs`, and prose in `docs/bundle-marketing-plan.md`. This design collapses them to one file.

**Inventory is not a gate.** Production scales, and current stock levels play no part in what gets built or how variants are structured.

---

## 2. What gets built

Three products. All componentized, all on the lean `product.bundle-landing` template, all published to **Online Store and Shop only** — every product-feed channel refuses componentized bundles (§6).

### 2.1 Hand Soap Set — `/products/hand-soap-set`

Collapses what the marketing plan lists as three separate bundles (#6, #8, #9) into one product with a price ladder. Three separate URLs would compete on the same query and split reviews three ways; the plan itself notes #8 cannibalizes #6. Componentized variants can each carry their own components *and* their own price, so one product expresses the whole ladder.

Two options: `Configuration` × `Scent`. **15 variants.**

| Configuration | MSRP | Price | Contribution |
|---|--:|--:|--:|
| 4 pumps | $52 | $44 | $17.55 |
| 3 pumps + body lotion | $69 | $59 | $31.46 |
| 4 pumps + body lotion | $82 | $72 | $39.82 |

Scents use the **real product scent names**. Every unit in this bundle is the same SKU, so there is no mixed-scent box to abstract over and no reason to invent a second vocabulary:

`Variety` · `Calming Lavender` · `Orange Zest` · `Coconut Breeze` · `Pure Unscented`

- `Variety` on a 4-pump configuration is one of each of the four scents.
- `Variety` on the 3-pump configuration is the three *scented* ones — Orange Zest, Coconut Breeze, Calming Lavender — because Pure Unscented is orderable on its own.

**Lotion pairing.** Body lotion ships only Pure Unscented and Coconut Breeze (marketing plan §1 rule 2 — a merchandising decision, not a stock one). Where the pump scent has no lotion counterpart, it pairs with Pure Unscented, which is honest because unscented goes with anything:

| Pump scent | Lotion |
|---|---|
| Coconut Breeze | Coconut Breeze |
| Pure Unscented | Pure Unscented |
| Calming Lavender | Pure Unscented |
| Orange Zest | Pure Unscented |
| Variety | Pure Unscented |

Note `coconut-lotion` *does* have a Calming Lavender variant. It is deliberately not used: the two-scent rule is a merchandising decision that outranks availability.

### 2.2 The Clean Swap — `/products/clean-swap` — $59

The entry version of the live 90-Day Clean Swap. One option, `Kit`: **Gentle / Calm / Fresh**, component-for-component identical to the $159 at 1× depth. Same SKUs, same scent logic, so it reads as the smaller size of a bundle already on sale rather than a different product.

MSRP $69 (lotion $30 + deodorant $15 + toothpaste $13 + bar soap $11). Contribution $34.06.

| Kit | `coconut-lotion` | `coconut-oil-deodorant` | `coconut-oil-toothpaste` | `coconut-soap` |
|---|---|---|---|---|
| Gentle | Pure Unscented | Calming Lavender | Fresh Mint | Pure Unscented |
| Calm | Pure Unscented | Calming Lavender | Fresh Mint | Calming Lavender |
| Fresh | Coconut Breeze | Geranium Flower | Fresh Mint | Nourishing Tea Tree |

**Why kit names here but not on the Hand Soap Set.** No real scent name is true of a mixed box. "Calm" could honestly be called Lavender, but **"Gentle" cannot be called Unscented** — there is no unscented deodorant, so it ships Calming Lavender. Labelling that box "Unscented" would be a false claim on the exact attribute a fragrance-free buyer filters for. The kit name is the only truthful label available.

### 2.3 Gift Box — `/products/gift-box` — $62

One option, `Kit`: **Gentle / Calm / Fresh**. Ships in the custom gift box already on hand.

MSRP $71 (lotion $30 + lip balm $15 + bar soap $11 + deodorant $15). Contribution $34.32 after packaging (below).

| Kit | `coconut-lotion` | `coconut-oil-lip-balm` | `coconut-soap` | `coconut-oil-deodorant` |
|---|---|---|---|---|
| Gentle | Pure Unscented | Pure Unscented | Pure Unscented | Calming Lavender |
| Calm | Pure Unscented | Vanilla Dream | Calming Lavender | Calming Lavender |
| Fresh | Coconut Breeze | Sweet Tangerine | Nourishing Tea Tree | Geranium Flower |

**Packaging cost.** The economics model currently treats the gift box as free, overstating contribution. Add a `packaging` field to the bundle record, defaulting to `0`, set to **$1.00** for the Gift Box. Contribution falls $35.32 → **$34.32**. Every other bundle is unaffected.

### 2.4 Collection placement is deliberately empty

All three ship with **no collection assignments** beyond whatever smart collections claim them automatically. There is no "Bundles" collection today, and most soap and lotion collections are smart with a `VARIANT_PRICE < 20` rule that correctly excludes bundles anyway.

Creating a bundles collection is a navigation and destination decision — it is where organic traffic would land — so it belongs in **B** with the rest of the funnel work. Making that call as a side effect of a build script is how half-decisions get made permanent.

---

## 3. Architecture — one declarative roster

### 3.1 `config/bundles.json` is the single source of truth

```jsonc
{
  "bundles": [
    {
      "handle": "clean-swap",
      "title": "The Clean Swap",
      "status": "live",              // live | draft | proposed | retired | rejected
      "templateSuffix": "bundle-landing",
      "packaging": 0,                 // per-order packaging cost in dollars
      "tags": ["bundle", "clean-swap", "value-set"],
      "collections": [],              // see §2.4 — placement is sub-project B
      "story": "Entry version of the 90-day…",
      "options": [{ "name": "Kit", "values": ["Gentle", "Calm", "Fresh"] }],
      "variants": [
        {
          "options": { "Kit": "Gentle" },
          "price": 59.00,
          "compareAtPrice": 69.00,
          "contents": "1 × Coconut Body Lotion (unscented)\n1 × …",
          "components": [
            { "product": "coconut-lotion",          "variant": "Pure Unscented",   "qty": 1 },
            { "product": "coconut-oil-deodorant",   "variant": "Calming Lavender", "qty": 1 },
            { "product": "coconut-oil-toothpaste",  "variant": "Fresh Mint",       "qty": 1 },
            { "product": "coconut-soap",            "variant": "Pure Unscented",   "qty": 1 }
          ]
        }
      ],
      "lander": { "heading": "…", "subheading": "…", "bullets": [], "faq": [], "tabs": [] }
    }
  ]
}
```

The five already-live bundles are backfilled into this file from their live Shopify state, so the roster describes the whole catalogue rather than only the new work. Backfill is read-then-write: generate the entry from Shopify, diff against the live product, and only then hand-edit.

### 3.2 Three consumers, one file

| Consumer | Reads | Purpose |
|---|---|---|
| `scripts/build-bundle.mjs` | roster | Build or reconcile a bundle in Shopify |
| `scripts/bundle-economics.mjs` | roster | Derive aggregate `items` counts instead of hardcoding them |
| Sub-project **D** (forecast) | roster | Component demand per bundle |

Deriving `bundle-economics.mjs`'s `items` from the roster is the point of the exercise: today the model asserts a bundle contains three lotions and Shopify independently ships whatever its component mapping says. They cannot disagree once one is computed from the other. `BUNDLES` keeps its `status`, `price` and `story` fields — those are editorial, not derivable — but `items` becomes a projection of the roster's component mappings.

### 3.3 `scripts/build-bundle.mjs`

```
node scripts/build-bundle.mjs <handle> [--apply]
node scripts/build-bundle.mjs --all [--apply]
```

Idempotent and re-runnable: every step reads current state first and skips when already correct, so a partial failure is repaired by running it again. Dry run by default; `--apply` writes.

**Sequence, and it is order-dependent:**

1. **Product** — create or update title, handle, `descriptionHtml`, SEO, `templateSuffix`, tags, status
2. **Options and variants** — with `price` and `compareAtPrice`
3. **Componentize** — `productVariantRelationshipBulkUpdate`
4. **Re-assert prices** — componentizing **overwrites the variant price with the component sum**. This has caused a production price error twice. It is a separate step *after* componentization, never before
5. **Metafields** — variant `bundle.contents`; product `bundle.components`, `bundle.component_qty`, `bundle.value_stack`
6. **Lander** — create the `bundle_lander` metaobject, link via product metafield `bundle.lander`
7. **Collections** — add to the configured collections
8. **Publish** — channel by channel, tolerating refusals (§6)

---

## 4. Verification

`scripts/verify-bundle-contents.mjs` keeps its existing checks (copy ↔ components both directions, component/qty index alignment, price splits) and gains:

- **Spec ↔ Shopify.** Every live variant's components match `config/bundles.json`. This is what makes the file authoritative rather than aspirational; without it the roster is just another thing that drifts.
- **Lander ↔ components.** Flag any product noun appearing in lander copy that is not among that bundle's components. This is the automated form of the project's most repeated bug — on a shared template, assume every string is wrong for the next product. It is currently a manual grep and should be a test.

Per bundle, before it is called done:

- Live URL returns **200**
- No unsubstituted `[[TOTAL]]` / `[[PRICE]]` / `[[SAVINGS]]` tokens in the rendered page
- Variant price ≠ component sum (catches the step-4 trap)
- `node --test` passes, including `tests/scripts/bundle-economics.test.js`

---

## 5. Testing

`scripts/build-bundle.mjs` is I/O against a live store, so the tests target the pure parts:

- **Roster validation** — every `product`/`variant` reference resolves to a real Shopify variant; option values cover the full variant grid; no duplicate handles; `packaging` non-negative
- **Economics derivation** — `items` computed from the roster matches the hand-written counts for the five live bundles. A mismatch means either the roster or the old model was wrong, and both cases must be inspected rather than auto-accepted
- **Variant grid generation** — the Hand Soap Set's 15 variants and their lotion pairings are produced from configuration × scent as specified in §2.1

Existing tests must keep passing unchanged.

---

## 6. Known traps this build must respect

Each of these has already cost a rework cycle:

- **Componentizing overwrites variant price** with the component sum. Set price after. Bit twice.
- **Every product-feed channel refuses componentized bundles** — Google, Meta, Pinterest, TikTok and Buy Button all reject them. Online Store and Shop are the only channels that accept one. Publish one channel at a time so a refusal does not abort the rest.
- **Shopify allows max 3 options per product.** The Hand Soap Set uses 2 and has no headroom for a third.
- **Never create a selling plan group through Shopify's Admin API.** Subscriptions are Recurpay's; a native group sells but never bills. If any bundle here needs a subscription, the plan is created in Recurpay and the product attached in its admin UI.
- **Bundle inventory takes ~10 s to compute** after component mapping. An immediate read shows 0 and is not a failure.
- **Only the app that assigned components can manage them.**
- **Metafield validation needs `metaobject_definition_id`** (a gid), not `..._type`.
- **Multi-arg filters break inside `{% render %}` argument lists** — assign first, then pass.
- **On a shared template, assume every string is wrong for the next product.** Grep for product nouns before calling a bundle done; §4 automates this.

---

## 7. Scope boundary

This spec covers **A** only.

| | Sub-project | Status |
|---|---|---|
| **A** | Build the three remaining bundles | **this spec** |
| **B** | Funnels — landers, collections, cross-sell, Klaviyo placements, ad copy | separate spec |
| **C** | Media and asset generation per bundle | separate spec |
| **D** | Demand forecast → component demand → purchase order | separate spec, reads `config/bundles.json` |

Not in scope here: linking anything to these bundles, generating imagery beyond what the build needs to not look broken, and any paid-ads work.

---

## 8. Open questions

None blocking. One deferred: whether the **Sensitive Skin Set** should migrate from its bespoke template to `bundle-landing`. It is the live hero and `verify-bundle-contents` flags it for missing `bundle.contents`. Migrating touches a converting page, so it belongs in **B** where the funnel work is deliberate, not here as a side effect of a build script.
