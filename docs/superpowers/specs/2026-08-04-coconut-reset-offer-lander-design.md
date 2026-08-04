# 90-Day Coconut Reset — offer reframe and lander restoration

**Date:** 2026-08-04
**Status:** approved design, pending implementation plan
**Related:** `docs/superpowers/specs/2026-07-22-rsc-1m-growth-plan-design.md` (the $1M plan this offer serves)

## Problem

The 90-Day Coconut Reset launched 2026-07-29 and has taken zero orders. Two
causes, neither of which is the one the launch notes assume.

**The lander lost 10 of its 17 sections.** The product was re-pointed at the
shared `product.bundle-landing.json` template (7 sections), abandoning the
purpose-built 17-section lander that was written for it. The missing sections
are the entire selling apparatus: the opening hook, ingredient cards, the stat
row, the mechanism explainer, the review carousel, customer photos, the
us-vs-them comparison table, the founder block, and an 8-block FAQ replaced by a
stub. The buy box lost 8 blocks alongside them, including the value stack.

**The page has never been measured.** GA4 stopped collecting on 2026-07-26 and
resumed 2026-08-03; the product's entire life to date sits inside that hole. Its
zero orders are therefore uninterpretable — we do not know whether anyone
reached the page. It also has no homepage placement (the Sensitive Skin Set has
three) and no nav link, and the live Shopping campaign lands on the lotion PDP
rather than here.

The offer itself has already been revised away from what the $1M plan describes.
Live contents are **3 lotions + 3 creams at $121 against a $174 compare-at**, not
the 3+1 at $99 the plan specifies. The $174 anchor is exact and honest:
3 × $30 lotion + 3 × $28 cream.

## Decisions

**Price stays $121.** Presentation changes; nothing in Shopify does.

**Framing becomes gain-framed rather than percent-off**, per
`marketing-offer-construction`, which rates free-portion and add-on framings
above an equivalent discount:

```
90 days of lotion  ·  3 × 8 fl oz ........... $90
+ 3 Body Creams    ·  worth $84 ............. $31
────────────────────────────────────────────────
You pay ..................................... $121
                    $174 of product — save $53
```

A literal "buy 3, get 3 free" was considered and rejected. It would require
either pricing the bundle at $90 (giving up ~$31 of contribution per order) or
listing lotion at $40.33 inside the bundle against $30 everywhere else on the
site — a discrepancy any buyer can check in two clicks.

**The digital guides stay out of the headline value number.** The archived
lander stacked $19 + $15 + $6 shipping onto the product value to reach $158.
Carrying that forward would produce a $214 claim. Product-only value is
defensible against the live PDPs; the guides are listed as included at no
charge, without a dollar figure.

## Architecture

### Template ownership

`product.bundle-landing.json` is shared by **five active bundles** — 90-Day Clean
Swap, Head-to-Toe, Clean Swap, Gift Box, and the Reset. It must not be edited.

The purpose-built lander still exists in the theme as
`templates/product.landing-page-99-coconut-reset.json` (49KB, 17 sections);
it was orphaned rather than deleted. The work is therefore a **re-point plus a
copy pass**, not a rebuild:

1. Copy the orphaned template to `product.landing-page-coconut-reset.json`
   (dropping the dead `99-` price from the key).
2. Apply the copy changes below.
3. Re-point the product's `templateSuffix` to the new template.

The orphaned `...99-coconut-reset.json` key is left in place; removing it is not
required and risks nothing else.

The archived template was checked for hardcoded product references — product
IDs, `gid://` handles, or `/products/` links that would make it render another
product's content. **There are none**; the four matches are the phrase
"sensitive-skin" appearing in legitimate prose. The template is product-agnostic
and re-pointing is safe. It also predates the variant cull, but carries no
references to the three removed scents; the FAQ names only Pure Unscented.

### Copy changes

Eight strings in the archived template carry stale figures. One of them —
`hero-ingredient-cards.ingredient-card-1.title` ("Daytime: 3 Lotions") — is
**still correct** and must not be changed.

| Path | Current | Becomes |
|---|---|---|
| `hero.blocks.bullet-2.settings.text_rte` | "A complete $158 routine … yours for $99" | $174 of lotion & cream, 90 days of both, $121 |
| `main.blocks.value-stack.settings.custom_liquid` | $118 / $19 / $15 / $6 → $158 → $99, "save $59" | the four-row stack above |
| `main.blocks.bundle-savings.settings.custom_liquid` | "$158 … for $99 … $59 in savings" | $174 / $121 / save $53 |
| `hero-ingredient-cards.…card-2.settings.title` | "Overnight: 1 Cream" | "Overnight: 3 Creams" |
| `founder-block.blocks.founder-body.settings.text` | "three lotions and a cream" | "three lotions and three creams" |
| `stats-row.blocks.stat-3.settings.title` | "$158" | "$174" |
| `final-cta-strip.blocks.fc-text.settings.text` | "Three lotions, one cream … $158 value, $99 today" | three creams; $174 value, $121 today |

The `.crx-vs` value-stack CSS and markup structure already exist in the archived
template and are reused; only the rows change.

`bundle-savings` computes a per-day figure via
`{{ product.price | divided_by: 90 }}`. It is dynamic and stays — at $121 it
reads $1.34/day.

### Copy angles

One tactic per module rather than scattering them across the page:

| Module | Tactic | Source skill |
|---|---|---|
| `hero`, `hook-rich-text` | Dose argument — one bottle does not reset anything; the product is named 90-Day, so this is native | `marketing-offer-construction` |
| `stats-row` | Specificity — 6 ingredients, 90 days, review count and rating | `marketing-conversion-copy-angles` |
| `why-it-works` | Mechanism — lotion daily, cream overnight | — |
| `compare-table` | Us-vs-them | `marketing-product-image-stack` |
| `founder-block` | Authority, honest version only — real formulation story, no invented credentials | `marketing-conversion-copy-angles` |
| `collapsible-content` | Problem articulation as proof substitute; 8 blocks restored over the stub | `marketing-conversion-copy-angles` |
| Buy box | Guarantee moves adjacent to add-to-cart, out of the footer | `marketing-offer-construction` |

The Loox review section carried by the Sensitive Set lander is **dropped**.
Judge.me is the review system of record and a second review app is clutter.

### Homepage banner

A new `custom-liquid` section between `hero` and `thesis` in
`templates/index.json`, matching the pattern the homepage already uses in five
places. Leads with the add-on framing and links to the lander.

## Verification

This theme has two known failure modes on bundle landers, both of which report
success from the API while rendering the wrong thing. Both get an explicit
check against the **rendered page**, not the API response:

1. Fetch `/products/99-coconut-reset-digital` and assert the new figures
   ($121, $174, $53, "3 Body Creams") are present and the old ones
   ($99, $118, $158, $59, "1 Cream") are absent.
2. Assert all 17 sections render, by section key.
3. Fetch the other four `bundle-landing` products and assert they are
   byte-identical to a pre-change capture — the shared template must be
   untouched.
4. Assert the homepage links to the lander.

The review count and star rating used in `stats-row` must be read from the live
Judge.me group at implementation time, not copied from notes — the product's
image alt text says 135 reviews while earlier project notes say 131. Whichever
is live is the one that ships.

## Out of scope

**Meta static ads.** `FACEBOOK_ACCESS_TOKEN` expired 2026-06-21, so
`meta-ads-collector`, `meta-ads-analyzer` and `campaign-ad-fixer` are dead and
the ad account is unreachable until re-auth. The image work is governed by
`marketing-product-image-stack` and needs its own spec. Noted here so it is not
lost: the Meta pixel itself **is** live (id `1948396628850834`, via the Shopify
web pixel), but its `metaapp_system_user_token` is `"-"`, suggesting the
Conversions API is not configured — client-side only.

**Distribution beyond the homepage banner.** Whether to re-point the Shopping
campaign at this lander is a separate call.

## Mechanics

Two repos, worktree off `origin/main` in each, PR in each:

- `Claude` — this spec. Worktree `.claude/worktrees/coconut-reset-offer`,
  branch `feature/coconut-reset-offer`.
- `realskincare-theme` — templates. Must branch from `origin/main`, **not** from
  `feat/coconut-reset-lander`, where the checkout is currently sitting.

Theme edits go live via the Admin API against the live theme; the repo commit is
the record. Verification runs against the live storefront after push.
