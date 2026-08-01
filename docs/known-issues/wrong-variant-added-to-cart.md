# 🚨 Eight PDPs add the WRONG variant to cart

**Found:** 2026-08-01, while verifying an unrelated theme fix on the Reset.
**Status:** OPEN. Blocks sending paid or organic traffic to any single-product PDP.
**Severity:** a customer selects a scent, the buy button submits a different one.
Wrong goods ship, and the buyer's first experience of the brand is a mistake.

## What happens

Select any non-default option on an affected product. The visible picker updates,
but the add-to-cart form's `[name="id"]` does not, and neither does the URL.

Measured on `coconut-lotion` with a real (trusted) selection event:

| | |
|---|---|
| picked | **Rose Petal** — `45828179198122` |
| form `[name="id"]` after | **`45828179165354` = Pure Unscented** |
| URL | unchanged, no `?variant=` |
| console | `TypeError: Cannot read properties of undefined (reading 'dataset')` at `handleOptionValueChange` |

The buyer sees Rose Petal selected and is charged for, and shipped, Pure Unscented.

## Blast radius — 8 of 17 multi-variant products

Swept every active multi-variant product by selecting a non-default option in a
real browser and reading the resulting cart id.

| Product | Template | Result |
|---|---|---|
| `coconut-lotion` | landing-page-lotion | ❌ WRONG VARIANT |
| `coconut-moisturizer` | landing-page-cream | ❌ WRONG VARIANT |
| `coconut-oil-deodorant` | landing-page-deodorant | ❌ WRONG VARIANT |
| `coconut-oil-toothpaste` | landing-page-toothpaste | ❌ WRONG VARIANT |
| `organic-foaming-hand-soap` | landing-page-liquid-soap | ❌ WRONG VARIANT |
| `foam-soap-refill-32oz` | landing-page-liquid-soap | ❌ WRONG VARIANT |
| `coconut-soap` | landing-page-bar-soap | ❌ WRONG VARIANT |
| `coconut-oil-lip-balm` | landing-page-lip-balm | ❌ WRONG VARIANT |
| 5 × `bundle-landing` products | bundle-landing | ✅ OK |
| 3 × multipacks | default | ✅ OK |
| `hand-soap-set` | default | ⚠️ no visible picker — investigate separately |

**Every affected page is a `landing-page-*` template, and those are the core
single-product PDPs** — the pages organic search and any paid traffic would land
on. The bundle landers and the plain multipacks are unaffected.

## Root cause

Each of these templates carries a custom `vqr-combo` block that renders the
visible picker and forwards the selection to the theme's hidden `variant-selects`.
The affected copies do this:

```js
hidden.value = pickEl.value;                              // pickEl.value is a VARIANT ID
hidden.dispatchEvent(new Event('change', { bubbles: true }));
```

The hidden select's options are **option values** (`"Rose Petal"`), not variant
ids. Assigning an id matches nothing, so the select silently empties, the theme's
`handleOptionValueChange` receives no matching option, throws on `undefined`, and
the form is never updated.

**This exact bug was already found and fixed — but only on `bundle-landing`.** Its
copy of the block carries the correct implementation and even documents the trap:

```js
// Assign the OPTION VALUE, never the variant id — an id matches no option, so the
// select silently empties and the gallery never updates.
```

The fix never propagated to the other seven templates.

## The fix

Port the `vqr-combo` block from `templates/product.bundle-landing.json` to each
affected template. That version is proven — the five `bundle-landing` products all
pass the sweep — and it fixes two things at once:

1. Maps variant id → option values via a `VQR_OPTION_VALUES` table and assigns the
   **option value**, handling multi-option products, not just the first select.
2. Binds by **delegation on `document`** rather than to the elements. Dawn replaces
   the product-info container on every variant change, so element-bound listeners
   die after the first switch and inline scripts in replaced markup never re-run.

Do not hand-edit eight copies. Write it once and apply it to all of them, then
re-run the sweep and confirm every row reads OK.

## Subscription exposure

`coconut-lotion` and the other affected PDPs carry the Recurpay subscription
widget. A subscriber who picks a scent the form never applies would be enrolled on
a recurring plan for the **wrong variant** — the error repeats every billing cycle
rather than once. See `reference_recurpay_api` for why Recurpay billing is
touchy here.

A separate, unrelated `recurpay.calculatePrice` TypeError also fires on variant
change. Verified pre-existing (it reproduces on the pristine theme file), so it is
not part of this bug, but it is worth its own look.

## How to verify a fix

`scripts/` has no harness for this yet. The sweep used here: for each active
multi-variant product, load the PDP, `select()` a non-default option with a real
event, wait for the re-render, and compare
`document.querySelector('form[action*="/cart/add"] [name="id"]').value` against the
intended variant id. Worth committing as a script so this cannot regress silently
— it was invisible until someone read the cart id.
