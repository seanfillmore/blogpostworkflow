# 90-Day Coconut Reset — offer reframe and bundle-lander enrichment

**Date:** 2026-08-04
**Status:** approved design (rev 2), pending implementation plan
**Related:**
- `docs/bundle-landing-architecture.md` — the data-not-literals rule this spec obeys
- `docs/superpowers/specs/2026-07-22-rsc-1m-growth-plan-design.md` — the $1M plan this offer serves

> **Revision note.** Rev 1 proposed re-pointing the Reset at its old 49KB
> single-product template. That was wrong: `docs/bundle-landing-architecture.md`
> identifies that template as the anti-pattern this system was built to replace,
> and re-pointing would have reintroduced the literal-price drift that produced
> "A complete $158 routine" beside a $118 strikethrough. Rev 2 keeps the
> data-driven architecture and enriches it instead.

## Problem

The Reset launched 2026-07-29 and has taken zero orders.

**The bundle lander is structurally thin.** `product.bundle-landing.json` renders
7 sections. The bespoke landers it replaced render 17. Missing: the opening
hook, ingredient cards, the stat row, the mechanism explainer, a review
carousel, customer photos, the us-vs-them comparison table, and the founder
block. This affects **all five bundles** on the template, not just the Reset.

The FAQ is **not** missing. Comparing section *types* suggested the bespoke
lander's 8-block `collapsible-content` had been reduced to a stub, but the
rendered page disproves it: the `custom-liquid` version reads the metaobject
`faq` and `tabs` fields and renders all of them. It is the better
implementation, and it stays as-is.

**The page has never been measured.** GA4 stopped collecting 2026-07-26 and
resumed 2026-08-03; the product's entire life sits inside that hole. Zero orders
is therefore uninterpretable — we do not know whether anyone reached the page.
It has no homepage placement (the Sensitive Skin Set has three) and no nav link,
and the live Shopping campaign lands on the lotion PDP.

## Architecture (existing, and why it stays)

`product.bundle-landing.json` is shared by five active bundles **by design**.
Per-product copy comes from a `bundle_lander` metaobject referenced by the
`bundle.lander` metafield; numbers come from `bundle.value_stack` and are
summed at render, never asserted. `[[TOTAL]]`, `[[PRICE]]` and `[[SAVINGS]]`
tokens in metaobject text are substituted at render.

The governing rule, quoted from the architecture doc:

> Only `product.price` and `compareAtPrice` come from Shopify commerce data.
> Everything else comes from metafields. **Nothing is a literal, and no total is
> ever asserted — it is summed.**

**Critical platform constraint.** Shopify evaluates Liquid *only* inside
`custom_liquid` settings. Native sections — `rich-text`, `multicolumn`,
`image-with-text`, `collapsible-content` — render their settings verbatim, so
`{{ ... }}` in them prints rather than computes. Every data-driven module
therefore must be either a `custom_liquid` section or a purpose-built theme
section that reads metafields directly. This is why `whats-in-it`,
`free-from-block` and `collapsible-content` in the current template are all
`custom-liquid`. New modules follow the same rule.

`scripts/build-bundle-landing.mjs` regenerates the three literal-price settings
that survive in bespoke templates, and **refuses to run against a shared
template** — a guard that must keep passing.

## Decisions

### Offer framing

**Price stays $121. Nothing in Shopify commerce data changes.**

**What renders today.** The buy box reads the **variant-level**
`bundle.value_stack` (the product-level metafield is a stale near-duplicate that
renders nothing). Both variants carry four rows:

```json
[
  { "label": "Body Lotion (8oz)", "qty": 3, "amount": 90, "img": "…" },
  { "label": "Body Cream (4oz)",  "qty": 3, "amount": 84, "img": "…" },
  { "label": "90-Day Routine & Tracker",   "amount": 19, "digital": true },
  { "label": "Coconut Skincare Field Guide","amount": 15, "digital": true }
]
```

Summed, that is $208, so the live page asserts **"Total value $208 / You save
$87 today"** beside a **$174** compare-at strikethrough. Two different totals on
one screen, one of them checkable against the PDPs. This is the drift the
architecture doc was written to prevent, reappearing through the digital rows.

**The fix is in the template, not the data.** Digital rows stay in
`value_stack` — `whats-in-it` renders them as box contents and they should keep
appearing — but the value stack **excludes `digital: true` rows from the sum**
and renders them in a separate "also included, free" group carrying no price.

→ total **$174**, price **$121**, savings **$53** — matching the compare-at
exactly, all computed, none written down.

Placing the rule in the template rather than in each bundle's data means it
holds for every future bundle automatically. The other four bundles carry no
`digital: true` rows, so their pages are unaffected.

Buy-box copy carries the add-on framing, which `marketing-offer-construction`
rates above an equivalent percent-off:

> 90 days of lotion — $90. Add all three body creams, worth $84, for $31.

A literal "buy 3, get 3 free" was considered and rejected: it would require
either pricing the bundle at $90 (giving up ~$31 contribution per order) or
listing lotion at $40.33 inside the bundle against $30 elsewhere on the site.

### Module enrichment

Missing modules are added to the **shared** template as data-driven sections, so
all five bundles gain them. Each renders only when its backing field is
populated, degrading to nothing rather than to an empty box.

| Module | Mechanism | Backing data |
|---|---|---|
| `hook-rich-text` | `custom_liquid` | new field `hook` |
| `hero-ingredient-cards` | `custom_liquid` | new field `ingredient_cards` (json) |
| `stats-row` | `custom_liquid` | new field `stats` (json) |
| `why-it-works` | `custom_liquid` | new field `mechanism` (json) |
| `compare-table` | existing `landing-compare-table` section | new metafield `bundle.comparison_rows` (json) — already named in the architecture doc's schema |
| `timeline` | `custom_liquid` | new field `timeline` (json) |
| `founder-block` | `custom_liquid` | new field `founder_note` |
| review carousel | `apps` section, Judge.me | none |

`ugc-photos` is **excluded**: it needs per-bundle photography that does not
exist, and an empty photo grid is worse than no section.

The Loox section carried by the bespoke landers is **excluded**. Judge.me is the
review system of record; a second review app is clutter.

### Hero angle — and the message-match contract

All copy derives from `data/context/voice-of-customer.md` (skin cluster, written
by `agents/voice-of-customer` 2026-07-26), not from invention.

Two entries in it decide the angle:

- **"Bottle size feels short for a premium natural lotion; people run out faster
  than they expect"** — 4 mentions. This is the bundle's reason to exist. A
  90-day supply answers the most common structural complaint in the file.
- **"Shoppers have a hard budget ceiling around $15 for body lotion and are
  skeptical of anything above it"** — 4 mentions. A $121 order is eight times
  that ceiling. This is the single largest objection to *this* offer and it must
  be answered above the fold, not buried in an FAQ.

Reinforced by the trigger **"sunk-cost fatigue after spending hundreds trying
organic lotions that all failed"** (3 mentions).

**The hero angle is therefore: you keep running out, and you have already spent
more than this on lotions that did not work.** Not "save $53" — savings is the
supporting line, not the lead. The price objection is answered in the same
breath, with per-day math the template already computes ($1.34/day at $121 over
90 days).

**Message-match contract.** Meta statics are built in a later spec, but the
angle is fixed here and the ads must enter on it. A cold click that arrives on a
different promise is a conversion lost after it was paid for. Any ad leading on
a discount, a scent, or a generic "clean ingredients" claim breaks this contract
and should not ship. Recorded here so the ad spec inherits it rather than
inventing its own angle.

### Copy angles

One tactic per module, each answering a named objection from the research file:

| Module | Objection it answers (mentions) | Tactic |
|---|---|---|
| hook | runs out too fast (4) + $15 ceiling (4) | Dose argument, per-day math |
| ingredient cards | "reading the actual ingredient list is what closes the sale" (5) | Specificity |
| stats | — | Hard numbers only: 6 ingredients, 90 days, 4.84★, 135 reviews |
| mechanism | "natural oils don't absorb — greasy baked good" (5); "skeptical a natural lotion moisturizes at all" (3) | Why lotion daily, cream overnight |
| timeline | runs out mid-way; uncertainty about when it works | Expectation map (see below) |
| compare table | "CeraVe, Vanicream, Cetaphil are the default recommendation" (6) | Us-vs-them |
| founder note | — | Authority, honest version only; no invented credentials |
| buy box | perceived risk | Guarantee, star rating, and one verbatim quote adjacent to add-to-cart |

**Coconut-oil comedogenicity** (6 mentions — the largest single objection in the
file) is answered by the existing body-map media asset, which already states
"Made for your body, not your face." No new module needed; it must simply not be
buried.

Verbatim proof is pulled from the file's golden-nugget phrases rather than
paraphrased — e.g. *"dude as soon as you put it on it just ABSORBS"* against the
absorption objection. Per `marketing-copy-credibility-and-proof`, reviewer-volunteered
context is kept and never invented.

### Timeline module — format constraint

There is **no photographic documentation of results**, so this is not a
before/after proof artifact and must not imply one. It is an illustrated
expectation map — CSS/SVG, typographic, no photography — covering what the buyer
uses and what to expect across months 1–3, and how the supply maps to them.

This keeps it inside what `marketing-problem-solution-inventory` warns about:
reversed problem statements drift into unsupportable claims in body care. The
module removes uncertainty about the *wait*, which is the mechanism
`marketing-conversion-friction-audit` credits (8/10), without asserting a
clinical result we cannot evidence.

### Page order and the skim rule

Buyers skim and decide. **Collapsing content behind accordions to fight page
length is rejected** — a skimmer does not open accordions, so collapsing
decision-relevant material simply hides it. This departs from the
"collapse the rest" reconciliation in `marketing-conversion-friction-audit` and
`marketing-problem-solution-inventory`, deliberately.

The rule instead: **order by decision-relevance and make every section legible
at a skim** — one idea per section, a headline that carries the point on its
own, and scannable supporting detail. Only reference material stays collapsed:
the full ingredient list, shipping and returns terms — which the existing FAQ
and tabs already handle.

Resulting order:

1. `hero` — the angle, per-day math, add-to-cart in view
2. `hook` — runs-out / already-spent-more
3. `main` (buy box) — value stack, guarantee, star rating, verbatim quote
4. `whats-in-it` — what physically arrives
5. `timeline` — months 1–3 expectation map
6. `mechanism` — why two formulas
7. `ingredient cards` — the ingredient list that closes the sale
8. `stats` — hard numbers
9. `compare-table` — versus CeraVe / Vanicream / Cetaphil
10. review carousel, `founder-note`, `free-from`, FAQ + tabs, `final-cta-strip`

### Content authoring

New fields are authored for **the Reset** in this work. The other four bundles
get the sections but leave the new fields empty, so their pages are unchanged
until someone writes their copy. This keeps the blast radius at one page while
the capability lands for all five.

Every new section self-suppresses on empty data, and the digital-row change
affects only bundles carrying `digital: true` rows — the Reset alone. So the
other four bundle pages must render **byte-identical** to their pre-capture.

### Data corrections

- `rating_caption` on the Reset reads "Rated 4.9 by Real Customers" against a
  live `rating_value` of 4.84 and 135 reviews. Corrected to match.
- `product.description` is empty, so nothing syndicates to the Shopping feed,
  the app ecosystem, or AI-search crawlers. Populated from the metaobject copy.
- A `bundle_lander` metaobject `reset-90-day` exists alongside the one actually
  referenced (`99-coconut-reset-digital`). Identified as an orphan; flagged, not
  deleted, since nothing reads it.

### Homepage banner

New `custom-liquid` section between `hero` and `thesis` in
`templates/index.json`, matching the pattern the homepage already uses in five
places. Leads with the add-on framing and links to the lander.

## Verification

This theme has known failure modes on bundle landers that report success from
the API while rendering something else. Every check runs against the **rendered
page**, not the API response.

1. Capture all five bundle product pages **before** any change.
2. After: fetch the Reset and assert the page renders "Total value $174" and
   "You save $53", and that **$208 and $87 appear zero times** — the two
   figures the live page asserts today.
3. Assert each new section renders on the Reset, by section key.
4. Assert the other four bundle pages render byte-identical to their
   pre-capture. Any diff is a regression and blocks the change.
5. Run `node scripts/build-bundle-landing.mjs 99-coconut-reset-digital` and
   assert it still refuses (shared-template guard intact).
6. Assert the homepage links to the lander.
7. Assert `product.description` is non-empty.

## Out of scope

**Meta static ads** — the assets, not the angle. The hero angle and the
message-match contract above are fixed by this spec and binding on that work.
`FACEBOOK_ACCESS_TOKEN` expired 2026-06-21, so
`meta-ads-collector`, `meta-ads-analyzer` and `campaign-ad-fixer` are dead and
the ad account is unreachable until re-auth. Image work is governed by
`marketing-product-image-stack` and needs its own spec. Recorded here so it is
not lost: the Meta pixel **is** live (id `1948396628850834`, via the Shopify web
pixel), but its `metaapp_system_user_token` is `"-"`, suggesting the Conversions
API is not configured — client-side only.

**Copy for the other four bundles' new fields.** The sections ship; the words do
not.

**The same empty-description gap on Clean Swap and Gift Box.** Both carry a
zero-length `product.description`, as the Reset does. Confirmed not deliberate —
the five bundles are inconsistent (90-Day Clean Swap 934 chars, Head-to-Toe 273,
the other three zero) while all nine non-bundle products carry one, and no
lander template renders `product.description` at all, so it is a pure
syndication field with no on-page effect. Deferred to its own pass to keep this
change scoped to one product.

**Re-pointing the Shopping campaign** at this lander is a separate call.

## Mechanics

Two repos, worktree off `origin/main` in each, PR in each:

- `Claude` — this spec, any script changes. Worktree
  `.claude/worktrees/coconut-reset-offer`, branch `feature/coconut-reset-offer`.
- `realskincare-theme` — template and section files. Must branch from
  `origin/main`, **not** from `feat/coconut-reset-lander`, where the checkout is
  currently sitting.

The **live theme is the source of truth** for template JSON: `origin/main` in
the theme repo does not contain `product.bundle-landing.json` at all. Pull each
asset from the live theme via the Admin API, modify, push back, and commit the
same content to the repo as the record. Never push a repo copy over a live asset
without pulling first.
