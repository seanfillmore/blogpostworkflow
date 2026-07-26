# Bundle landing pages — data, not literals

How to build bundle landers so the copy lives in product data and the numbers compute themselves. Written 2026-07-26, after the $99 Reset shipped as a one-off template.

---

## Why

The Reset's lander is `templates/product.landing-page-99-coconut-reset.json` — 48 KB of section settings serving exactly one product. It works, and the value stack in it is genuinely good. But:

- **`product.description` is empty.** Nothing syndicates. The Google Shopping feed, the app ecosystem, AI-search crawlers reading product data, and any collection or email pulling `product.description` all get nothing. The copy exists only inside one template rendering one URL.
- **Zero references to `product.description`, `product.title` or `product.metafields`.** Every price and claim is a literal string.
- **It already drifted.** The hero read *"A complete $158 routine"* while the buy box struck through `compareAtPrice` of `$118`, with no on-page reconciliation. $158 is legitimate ($118 goods + $19 + $15 guides + $6 shipping), but one number was data and the other was a string, so only one could stay current.
- **A live copy bug survived in it:** *"$59 in total value"* where $59 is the *savings* — contradicting *"$158 value"* two clauses earlier. Fixed 2026-07-26.

The plan calls for **seven more bundles**. On this pattern each needs its own 48 KB template with its own literals to drift.

## The rule

> Only `product.price` and `compareAtPrice` come from Shopify commerce data. Everything else comes from metafields. **Nothing is a literal, and no total is ever asserted — it is summed.**

## Schema — namespace `bundle`

| Key | Type | Purpose |
|---|---|---|
| `value_stack` | `json` | Line items. **The total is computed from this, never written down.** |
| `duration_days` | `number_integer` | Drives the per-day figure (90 for the Reset). |
| `hero_promise` | `single_line_text_field` | The one-line positioning. Duration/completeness, never savings-vs-single. |
| `guarantee` | `single_line_text_field` | e.g. "30-day no-questions-asked money-back guarantee". |
| `bonus_delivery` | `single_line_text_field` | How digital goods arrive, e.g. "Emailed within 5 minutes". |
| `comparison_rows` | `json` | Rows for the compare table. |

`value_stack` shape:

```json
[
  { "label": "3 Body Lotions + 1 Body Cream", "amount": 118, "digital": false },
  { "label": "90-Day Routine & Tracker",      "amount": 19,  "digital": true  },
  { "label": "Coconut Skincare Field Guide",  "amount": 15,  "digital": true  },
  { "label": "Free shipping",                 "amount": 6,   "digital": false }
]
```

## Rendering — the total computes itself

```liquid
{%- liquid
  assign stack = product.metafields.bundle.value_stack.value
  assign total = 0
  for row in stack
    assign total = total | plus: row.amount
  endfor
  assign price_dollars = product.price | divided_by: 100.0
  assign savings = total | minus: price_dollars
  assign days = product.metafields.bundle.duration_days.value | default: 90
-%}

<div class="crx-vs">
  <p class="crx-vs__title">Everything in your {{ days }}-Day Reset</p>
  {%- for row in stack -%}
    <div class="crx-vs__row">
      <span class="crx-vs__label">
        {{ row.label }}{% if row.digital %} <small>(digital)</small>{% endif %}
      </span>
      <span class="crx-vs__price">${{ row.amount }}</span>
    </div>
  {%- endfor -%}
  <div class="crx-vs__total">
    <span>Total value</span>
    <span><s>${{ total }}</s> {{ product.price | money }} today</span>
  </div>
  <div class="crx-vs__save">
    You save ${{ savings | round }} — about {{ product.price | divided_by: days | money }} a day
  </div>
</div>
```

Change the cream from $28 to $30 and every figure updates: line item, total, savings, per-day. **The drift that produced the $158/$118 mismatch becomes structurally impossible.**

## Where the prose goes

**`product.description`** carries the core selling copy — it syndicates to the Google feed, apps, and anything reading product data. Lead with duration or completeness per [`bundle-marketing-plan.md`](./bundle-marketing-plan.md) §1; never lead with savings-vs-single, which invites the per-unit comparison the bundle exists to escape.

**SEO title and description must be set.** Both are currently empty on the Reset, so Google composes its own snippet and the Shopping feed has no title to lean on.

## One template, not eight

Replace `product.landing-page-99-coconut-reset` with **`product.bundle-landing`**, rendering entirely from the metafields above. Assign it to every bundle.

Bundle #2 through #8 then need **data entry, not a new template**. That is the whole return on this work — and it needs doing before bundle #2, because that is when the copy-paste cost becomes real.

## Platform constraint: Liquid only runs in `custom_liquid`

Verified on this theme — the only settings containing Liquid are the three `custom_liquid` blocks. Rich-text, multicolumn and heading settings render their value **verbatim**, so `{{ ... }}` in them prints rather than computes.

That is precisely how the drift happened: `compareAtPrice` was data and updated itself; the hero's `$158` was a rich-text string and did not.

So the migration splits in two:

- **Computed** — `main.value-stack` and `main.bundle-savings` are `custom_liquid`, and now loop the metafield and **sum** the total. Nothing is asserted.
- **Generated** — three settings display a price and cannot evaluate Liquid: `hero.bullet-2`, `stats-row.stat-3`, `final-cta-strip.fc-text`. `scripts/build-bundle-landing.mjs` rewrites their price tokens from the same metafield.

The generator substitutes **price tokens only** — prose is human-authored and survives untouched. An earlier version rebuilt whole sentences and would have silently replaced the copy; that was caught in dry-run and fixed.

Treat those three settings as generated output, like `docs/bundle-economics.md`. **Don't hand-edit them in the theme editor** — run the script, or the next edit reintroduces the drift.

```bash
node scripts/build-bundle-landing.mjs 99-coconut-reset-digital          # dry run
node scripts/build-bundle-landing.mjs 99-coconut-reset-digital --apply  # push
```

## What building bundle #2 exposed

The claim was that a shared template plus per-product metafields makes bundle #2 data entry. **Half right, and the failing half only appeared on the second build.**

**Worked:** `bundle.value_stack` drives the computed blocks per product. The Clean Swap renders its own $213 / $159 / save $54 from the same `product.bundle-landing` template the Reset uses. No new template file.

**Failed:** the three *generated* settings live in the **template**, and the template is now shared. Running the generator for the Clean Swap would have rewritten the live Reset's prices to $213/$159. The copy is wrong across bundles too — *"lotions, cream & expert guides"* describes the Reset, not a lotion/deodorant/toothpaste/soap swap.

`scripts/build-bundle-landing.mjs` now **refuses to run when the template is shared** (exit 1, naming the other products). That prevents the corruption but does not solve the underlying problem.

### The fix, implemented 2026-07-26

Replacing those sections with `custom-liquid` would have discarded their theme styling (section padding, colour custom properties), so the settings now carry **tokens** instead: `[[TOTAL]]`, `[[PRICE]]`, `[[SAVINGS]]`.

Three section files compute the values and substitute the tokens on output:

| Section | Templates affected | Why safe |
|---|--:|---|
| `hero-landing-section.liquid` | 1 | bespoke to this lander |
| `multicolumn.liquid` | 13 | substitution is a **no-op when tokens are absent** |
| `rich-text.liquid` | 30 | same — every other page renders byte-identically |

Each begins with a prelude that sums `bundle.value_stack` and derives price and savings, guarded by `if product != blank`.

**⚠️ Liquid gotcha that cost a debugging cycle.** Multi-argument filters **cannot be used inline in `{% render %}` argument lists** — the comma in `replace: '[[TOTAL]]', bundle_total` is parsed as an *argument separator for the render tag*, so the filter chain breaks **silently** and the raw token renders. Both shared sections pipe text through `{% render 'highlight-text', hl_input: ... %}`, so they hit this while the hero (a direct `{{ }}` output) worked. Fix is assign-then-pass:

```liquid
{%- assign bt_text = block.settings.text
      | replace: '[[TOTAL]]', bundle_total
      | replace: '[[PRICE]]', bundle_price
      | replace: '[[SAVINGS]]', bundle_savings -%}
{%- render 'highlight-text', hl_input: bt_text, ... -%}
```

**Verified:** one template, two products, all figures computed —

| | Hero | CTA | Stack total |
|---|---|---|---|
| Reset | $158 → $99 | save $59 | $158 |
| Clean Swap | $213 → $159 | save $54 | $213 |

Zero leaked tokens on either; homepage, collection and a non-bundle PDP all still 200.

`scripts/build-bundle-landing.mjs` is now redundant — nothing is generated because everything computes. It is kept only as a drift **detector**; its shared-template guard still refuses to write.

| Block | Section type | Move to |
|---|---|---|
| `hero.bullet-2` | `hero-landing-section` | `custom-liquid` section, or drop the price and let the value stack own it |
| `stats-row.stat-3` | `multicolumn` / `column` | replace `stats-row` with a `custom-liquid` section rendering all four stats |
| `final-cta-strip.fc-text` | `rich-text` | `custom-liquid` section |

Once done, the generator script can be deleted — nothing is generated because everything computes.

**Simpler alternative worth considering:** delete the price claims from all three. The computed value stack already states total, price and savings authoritatively, and repeating them in a hero bullet, a stat card and a closing line is redundant. That removes three drift sources permanently and needs no new sections.

## Migration order

**Done for the Reset, 2026-07-26:**

1. ✅ Metafield definitions created (`bundle` namespace, product owner).
2. ✅ Populated for the Reset from its existing template values — sums to $158, savings $59, matching the page exactly.
3. ✅ Forked to `product.bundle-landing`, computed blocks loop and sum the metafield.
4. ✅ Reset points at the new template. Live output verified identical to the hand-built version.
5. ✅ `product.description`, SEO title/description, Google category, productType, tags and SKUs all populated.

**Verified the generator actually works** rather than trusting a no-op: temporarily set the stack to $160, confirmed all three literals were flagged with the prose intact, then restored to $158.

**Still to do:**

6. Build bundle #2 by populating metafields only — that is the payoff, and the first real test of whether the template generalises.
7. Delete `templates/product.landing-page-99-coconut-reset.json` once bundle #2 confirms the shared template holds. Kept for now as a rollback path.

## Gotchas

- `product.price` is in **cents** in Liquid. `divided_by: 90` on 9900 yields 110 → `$1.10`. Use `divided_by: 100.0` to get dollars for arithmetic against `amount` values.
- JSON-template sections render as `#shopify-section-template--<numericId>__<sectionKey>`. Scope CSS with `[id$="__<key>"]`, not `#shopify-section-<key>`.
- `compareAtPrice` must remain the genuine retail price of the **goods** ($118). The $158 value-stack total includes digital goods and shipping and is a marketing figure — it belongs in the itemized stack where it is verifiable, never as a second strikethrough.


---

# Round 2 — what building bundle #2 *properly* required

Tokens fixed the numbers. They cannot fix prose, and prose is most of a landing page. Building the Clean Swap on the shared template rendered it with the Reset's heading, subheading, CTA label and bullets — correct prices, wrong product.

## Component choice: curated kits

Shopify allows a **maximum of 3 options per product**. The Clean Swap has four components, so free choice across all four is impossible as native variants — not hard, impossible. (Variant *count* is not the limit; that is 2048.)

Sean's call: **curated kits**, with a free-text note for anyone wanting a swap.

| Kit | Composition | Available |
|---|---|--:|
| Gentle | Unscented lotion · Calming Lavender deo · All Natural paste · Unscented soap | 2 |
| Calm | Unscented lotion · Calming Lavender deo · Fresh Mint paste · Lavender soap | 10 |
| Fresh | Coconut Breeze lotion · Geranium deo · Fresh Mint paste · Tea Tree soap | 11 |

A native `line_item_property` block ("Prefer different scents? Tell us here") sits before the buy buttons, so requests ride on the order line.

**Product gap:** there is **no unscented deodorant SKU** — the range is Geranium, Calming Lavender, and two at zero stock. A genuinely fragrance-free kit is therefore not possible today, which is why the first kit is named "Gentle" and not "Fragrance-Free". Fragrance-free is one of the strongest converting angles in the catalogue; this looks like a real product gap.

## The `bundle_lander` metaobject

Per-product copy, so one template serves every bundle.

| Field | Type | Notes |
|---|---|---|
| `heading` | `single_line_text_field` | required |
| `subheading` | `multi_line_text_field` | |
| `cta_label` | `single_line_text_field` | |
| `rating_caption` | `single_line_text_field` | |
| `bullets` | `list.single_line_text_field` | supports `[[TOTAL]]` / `[[PRICE]]` / `[[SAVINGS]]` |

Referenced from a product metafield `bundle.lander` of type `metaobject_reference`, validated to `bundle_lander`.

`sections/hero-landing-section.liquid` then reads the metaobject and falls back to its own settings when absent — the section is bespoke to this lander, so this is safe. That is cleaner than tokens for prose: the section reads real values rather than substituting placeholders.

**⚠️ Blocked on scopes.** `read_metaobjects` and `write_metaobjects` are granted; `read_metaobject_definitions` and `write_metaobject_definitions` are not, so the definition cannot be created by API. Either grant both scopes and re-install the app, or create the definition by hand in Settings → Custom data → Metaobjects using the table above — entries can then be populated over the API.

## Still bundle-specific after the hero is fixed

The hero is the loudest offender but not the only one. These sections still hold Reset-specific prose and will need the same treatment before a third bundle:

- `collapsible-content` — 8 FAQ blocks
- `compare-table` — 7 rows
- `why-it-works` — 4 blocks

## Fixed in passing: the variant/quantity row

The scent and quantity controls could not align because the markup was broken, not because of styling. `<div class="vqr-row">` opened *inside* an `{% if %}` whose `{% endif %}` fired **before the closing `</div>`**, so the row was never closed and the quantity block nested inside it instead of beside it. Browsers auto-repaired the HTML, which is why it rendered at all. Rebuilt as one flex row containing both columns.


## Kit names are labels, not information

"Gentle" tells a customer nothing about what arrives in the box. Each variant now carries a **`bundle.contents`** variant metafield (`multi_line_text_field`, one item per line) rendered in a small panel directly under the picker, showing only the selected variant and swapping on change.

```
WHAT'S IN THE GENTLE BOX
 • 3 × Body Lotion — Pure Unscented (no fragrance at all)
 • 3 × Deodorant — Calming Lavender (our mildest)
 • 3 × Toothpaste — All Natural (unflavoured)
 • 3 × Bar Soap — Pure Unscented
 Want different scents? Add a note below and we'll swap them.
```

It is a **variant** metafield rather than derived from the bundle components for two reasons: Liquid does not expose `productVariantComponents` on the storefront, and the customer-facing wording should be better than raw component handles — "Calming Lavender (our mildest)" carries the reassurance that `coconut-oil-deodorant/Calming Lavender` does not.

The panel only renders when at least one variant has contents, so it is inert on any bundle that has not been given copy. The swap note only appears when there is more than one variant, and points at the `line_item_property` field.

Populated for all five variants across both bundles.


## The metaobject, built 2026-07-26

`bundle_lander` metaobject + `bundle.lander` product metafield (`metaobject_reference`). `sections/hero-landing-section.liquid` prefers the metaobject and falls back to its own section settings, so non-bundle uses of the section are untouched.

| Field | Type |
|---|---|
| `heading` | `single_line_text_field` |
| `subheading` | `multi_line_text_field` |
| `cta_label` | `single_line_text_field` |
| `rating_caption` | `single_line_text_field` |
| `bullets` | `list.single_line_text_field` — `[[TOTAL]]`/`[[PRICE]]`/`[[SAVINGS]]` still substitute |

**Verified — one template, two bundles, everything per-product:**

| | Reset | Clean Swap |
|---|---|---|
| heading | The 90-Day Coconut Skin Reset | The 90-Day Clean Swap |
| CTA | Start My 90-Day Reset | Start My Clean Swap |
| bullet 2 | $158 … $99 | $213 … $159 |
| bullet 3 | coconut oil + jojoba | aluminium-free, fluoride-free |

Zero leaked tokens on either.

**Gotcha:** the metafield definition's validation takes `metaobject_definition_id` (a gid), not `metaobject_definition_type`. Passing the type string returns `INVALID_OPTION — Validations require that you select a metaobject`.

**Known limit:** bullets are capped by the number of `bullet` blocks in the template, because the loop reuses each block's icon settings by index. Three blocks exist; a bundle wanting a fourth bullet needs a fourth block added to the template. Acceptable for now — worth revisiting if a bundle needs a different bullet count.

### Still template-level

`collapsible-content` (8 FAQ blocks), `compare-table` (7 rows) and `why-it-works` (4 blocks) remain shared prose. They are below the fold and generic enough to survive two bundles, but a third with a materially different story will need them moved to the metaobject too.


---

# Round 3 — the template got simpler instead of smarter

An audit found **12 of 17 sections carried bundle-specific content**. Metaobject-ising all of them would have meant authoring twelve sections per new bundle — that is writing a landing page each time, which is exactly what a shared template was meant to avoid.

Sean's call: cut the page down. **17 sections → 7.**

| Kept | Why |
|---|---|
| `hero` | metaobject-driven, per-bundle |
| `main` | buy box: price, kit picker, contents panel, value stack, note field |
| `whats-in-it` | **new** — component-driven, see below |
| `free-from-block` | ingredient claims |
| Judge.me reviews | 131 reviews, 4.9 |
| `collapsible-content` | FAQ |
| `final-cta-strip` | closing CTA |

Dropped: `hook-rich-text`, `hero-ingredient-cards`, `founder-block`, `loox-product-reviews-app-section`, `why-it-works`, `stats-hero`, `stats-row`, `judgeme_carousel_cream`, `ugc-photos`, `compare-table-styles`, `compare-table`. Template went 51 KB → 32 KB. The full 17-section version is backed up at `~/Backups/shopify/bundle-landing-17section-2026-07-26.json`.

**`free-from-block` was kept against the "six sections" brief, deliberately.** It is *"What's NOT in any bottle or jar"* — mineral oil, petrolatum, parabens, synthetic fragrance, SLS. The Amazon SQP data in [`bundle-strategy-handoff.md`](./bundle-strategy-handoff.md) shows ingredient-led queries (`paraben chemical free body lotion`, `severe dry skin lotion free of petroleum chemicals`) converting at full price with no discount pressure. It is also brand-level, so it costs nothing per bundle.

## `whats-in-it` — driven by component references, not image slots

The old `why-it-works` had `image_1` / `image_2` / `image_3` as **section settings**: template-level, so shared across bundles, and hard-capped at three slots. The Clean Swap has four products. No amount of metaobject work fixes a hardcoded slot count.

Replaced with a `custom-liquid` section looping three product metafields:

| Metafield | Type | Role |
|---|---|---|
| `bundle.components` | `list.product_reference` | which products, in display order |
| `bundle.component_qty` | `list.number_integer` | index-aligned quantities |
| `bundle.short_name` | `single_line_text_field` (on each component product) | card label |

Each card pulls its **own featured image** from the component product, so:

- the card count is always the real component count — 2 for the Reset, 4 for the Clean Swap
- product photos can never go stale; change one and every bundle lander follows
- authoring is picking products, not managing image assets

`short_name` exists because the real titles are SEO-shaped — *"Non-Toxic Body Lotion Made With Only 6 Clean Ingredients"* is correct for search and unusable on a card. Set once per product, reused by every bundle.

**Verified:**

```
Reset       2 products, 90 days.   3 × Body Lotion · 1 × Body Cream
Clean Swap  4 products, 90 days.   3 × Body Lotion · 3 × Deodorant · 3 × Toothpaste · 3 × Bar Soap
```

**Known fragility:** `component_qty` is index-aligned with `components` — reorder one without the other and quantities silently attach to the wrong product. Worth folding into `verify-bundle-contents.mjs`.


---

# Round 4 — bundle #3 was, finally, data entry

**Head-to-Toe ($105)** — one of each of all seven products. Component math matched [`bundle-economics.md`](./bundle-economics.md) to the cent before a single write: MSRP $125, COGS $29.54, 2.24 lb.

**No template work. No section edits. No theme changes.** Just: create the product, componentize two curated kits, then populate metafields —

```
bundle.value_stack     7 line items summing to $125
bundle.components      7 product references
bundle.component_qty   [1,1,1,1,1,1,1]
bundle.contents        per-variant, per-kit
bundle.lander          -> new bundle_lander entry
templateSuffix         bundle-landing
```

Rendered correctly first time: heading "Head-to-Toe", bullets showing `$125` → `$105`, seven component cards each with its own image, value stack summing to $125, save $20, kit contents panel, note field. Zero leaked tokens.

That is the claim finally holding — after two bundles where it didn't.

## What the verifier now covers

`verify-bundle-contents.mjs` checks, for every componentized bundle:

- every component ships **and** is named in the customer-facing copy
- copy never promises a component that does not ship
- `bundle.components` / `bundle.component_qty` stay index-aligned against the real components

Proven by injecting drift rather than trusting a clean pass — swapping the Reset's quantities to `[1,3]` produced:

```
COMPONENT CARDS MISMATCH
    coconut-lotion: card says 1x, components ship 3x
    coconut-moisturizer: card says 3x, components ship 1x
```

## Open

- **`Sensitive Skin Moisturizing Set` has no `bundle.contents` copy.** It is live and selling, and the verifier flags it. It is not on the lean template, so nothing renders wrong today — but it will the moment it is migrated.
- **The `whats-in-it` subtitle is hardcoded** as "N products, D days." That works for the two 90-day bundles and reads oddly on Head-to-Toe, a discovery/gift bundle where duration is not the pitch. It should come from the metaobject.


---

# Round 5 — the buy box was still the Reset

Three bugs on one screenshot of the Clean Swap, all fixed:

**Price displayed $207 instead of $159.** Re-componentizing the Gentle kit (swapping All Natural for Fresh Mint) **overwrote its price with the component sum again** — the documented gotcha, biting a second time because I changed components *after* setting the price. Nothing errored; the page simply offered the bundle at its undiscounted total.

The verifier now checks that **every variant of a bundle shares one price**, which catches exactly this: a lone variant reverting to its component sum shows up as a price split.

**"$213 of product & expert guides"** — the Clean Swap has no guides. Made generic: "of value".

**Four hardcoded benefit lines** in the buy box, all describing the Reset ("Two formulas, one routine — daily lotion + overnight cream") on every bundle. Replaced the four `text` blocks with one `custom_liquid` block rendering a new `buybox_bullets` metaobject list, with token substitution.

**And the `whats-in-it` subtitle**, flagged last round, is now a `whats_in_it_note` metaobject field — duration framing for the supply bundles, "One of everything we make - full size, not samples" for the discovery bundle.

| | Reset | Clean Swap | Head-to-Toe |
|---|---|---|---|
| price | $99.00 | $159.00 | $105.00 |
| value line | $158 of value | $213 of value | $125 of value |
| benefit lines | own 4 | own 4 | own 4 |
| subtitle | own | own | own |

## The pattern worth remembering

Every round of this has been the same bug in a new costume: **content that should be per-product living in a template**. Hero, then prices, then component images, then buy-box benefits, then a subtitle. Each looked like the last one.

The general rule, learned expensively: **on a shared template, assume every string is wrong for the next product until proven otherwise.** Grep the template for product nouns — lotion, cream, guides, days — before declaring a bundle done.
