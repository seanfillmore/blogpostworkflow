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

## Migration order

1. Create the metafield definitions (`bundle` namespace, product owner type).
2. Populate them for the Reset from the values already in its template.
3. Fork `product.landing-page-99-coconut-reset` → `product.bundle-landing`, swapping literals for the metafield renders above. Compare rendered output against the current page — it should be pixel-identical.
4. Point the Reset at the new template. Verify, then delete the old one.
5. Write `product.description` and the SEO fields.
6. Build bundle #2 by populating metafields only.

Step 3 is the real work; steps 1–2 are mechanical; step 6 is the payoff.

## Gotchas

- `product.price` is in **cents** in Liquid. `divided_by: 90` on 9900 yields 110 → `$1.10`. Use `divided_by: 100.0` to get dollars for arithmetic against `amount` values.
- JSON-template sections render as `#shopify-section-template--<numericId>__<sectionKey>`. Scope CSS with `[id$="__<key>"]`, not `#shopify-section-<key>`.
- `compareAtPrice` must remain the genuine retail price of the **goods** ($118). The $158 value-stack total includes digital goods and shipping and is a marketing figure — it belongs in the itemized stack where it is verifiable, never as a second strikethrough.
