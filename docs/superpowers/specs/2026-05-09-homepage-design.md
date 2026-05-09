# Homepage Redesign — Design Spec

**Date:** 2026-05-09
**Branch (theme):** `feat/homepage-redesign` in `realskincare-theme`
**Branch (this doc):** `docs/homepage-redesign` in `seo-claude`
**Author:** Sean Fillmore (initial copy + structure), Claude (implementation defaults)

## Goal

Replace the current 16-section Dawn-derived homepage with a tighter 8-section homepage that:

- Says the brand promise once, sharply, then proves it (instead of restating it 4–5 times in different generic phrasings)
- Matches the clinical / mechanism-focused voice of the recently-launched Sensitive Skin Set lander and the PDPs
- Drives toward two real conversion moments — the bundle PDP and the full-line collection — without intermediate clutter
- Replaces every numeric or quoted claim with peer-reviewed citations, real Judge.me data, or verifiable inventory (no aspirational marketing claims)

## Architecture

**File:** `templates/index.json`. Single replacement; existing backups (`index.gem-backup-default.json`, `index.gp-template-bk-default.json`, `index.gem-1716757211-template.json`) stay in place.

**Section count:** 10 entries in the JSON `order` array, 8 visually-distinct units. Two structural entries don't render as their own visual sections: `founder-anchor` is a zero-height `<span id="founder">` and `product-intro` is a tight rich-text heading + sub that visually reads as the header of the product-line multicolumn (separated only because `multicolumn` doesn't expose a subhead field — same pattern used on the Sensitive Skin Set lander).

**Primitive mapping (no new section types built):**

| # | Section (key) | Primitive | Notes |
|---|---|---|---|
| 1 | `hero` | `hero-landing-section` | Same primitive used on the lander |
| 2 | `thesis` | `rich-text` | Cream bg, narrow column, anchor link to founder |
| 3 | `exclusion-grid` | `custom-liquid` | Edge-to-edge sage-green band, 4×3 grid |
| 4a | `product-intro` | `rich-text` | Heading + sub for the product line — paired with multicolumn below |
| 4b | `product-line` | `multicolumn` | 7 cards, 4 cols desktop / 2 cols mobile, no own heading |
| 5 | `featured-testimonial` | `custom-liquid` | Pull-quote with `300+ verified · 290+ five-star` eyebrow |
| (anchor) | `founder-anchor` | `custom-liquid` | `<span id="founder">` only — invisible |
| 6 | `founder` | `image-with-text` | Image left, text right; placeholder image until walk-through |
| 7 | `closing-cta` | `custom-liquid` | Dark band, Liquid pulls live bundle price |
| 8 | `email-capture` | `apps` (Klaviyo) | Reuses existing Klaviyo form ID `WzAQZX` |

**Color conventions (inherited from the lander):**

| Token | Use |
|---|---|
| `#eef3e8` (sage-green) | Hero band, exclusion-grid full-width band |
| `#faf7f0` (cream/off-white) | Thesis, product line, testimonial, founder bands |
| `#1a1b18` (near-black) | Closing CTA dark band |
| `#AEDEAC` (light sage CTA) | Closing CTA button background |
| `#4a8b3c` (deep green) | ✗ marks in exclusion grid; accent links |

## Section-by-section spec

### 1. Hero (`hero-landing-section`)

- **Headline (h1):** "Skincare for skin that reacts to everything else."
- **Subheading:** "We make small-batch lotion, body cream, toothpaste, deodorant, and soap for people whose skin doesn't tolerate fragrance, parabens, dimethicones, or mineral oil. No exceptions, no fine print."
- **CTA:** "Shop the Sensitive Skin Set" → `/products/sensitive-skin-starter-set`
- **bg_color:** `#eef3e8`; no bg_image (placeholder strategy — final shot dropped in during walk-through)
- **Layout:** flip_layout=false, text_align_center_mobile=false; padding_top 80, padding_bottom 64
- **show_rating:** false (drop the lander's rating element on homepage)
- **No bullets, no guarantee blocks.** Keeps hero clean; trust signals belong in the announcement bar (top of page) and closing CTA.

**Deviation from initial copy:** Sean's plan included a secondary "Browse the full line →" text link in the hero. The hero primitive only renders one CTA; the secondary link is omitted from this section and carried by the Closing CTA's secondary link instead. Cleaner visual hierarchy in the hero.

### 2. Thesis paragraph (`rich-text`)

- **Heading (h2 styled h1-size):** "Most "natural" skincare still isn't built for sensitive skin."
- **Body:** Two paragraphs from initial spec (verbatim).
- **Anchor link:** "Read our founder's story →" with `href="#founder"`
- **bg:** `#faf7f0`; text_alignment=center; narrow=true (typographic line length); padding 64/56

### 3. Exclusion grid (`custom-liquid`)

- **Edge-to-edge sage-green band** via `calc(-50vw + 50%)` margin trick (same pattern as the lander free-from band).
- **Heading:** "What's not in any of our products."
- **Subhead:** "Across the entire line. Every product, every batch, every variant."
- **Grid:** 4×3 desktop, 2-col under 900px, 1-col under 480px.
- **Items (12 total, row-major order):**
  1. Synthetic fragrance
  2. Phthalates
  3. Petrolatum
  4. Mineral oil
  5. Dimethicone
  6. Lanolin
  7. Synthetic dyes
  8. SLS
  9. Fluoride
  10. Titanium dioxide
  11. Aluminum
  12. Parabens, phenoxyethanol & other synthetic preservatives
- **Footer line:** "If you can't pronounce it and we can't justify it, it's not in the bottle."
- **✗ mark style:** 1.6em, weight 800, `#4a8b3c` (matches lander)

**Note on "Phthalates" and "Synthetic dyes":** These two replaced "Parabens" and "Phenoxyethanol" as standalone items after the user merged Parabens + Phenoxyethanol + "synthetic preservatives" into a single combined slot. Both new items are defensibly absent across the line: phthalates accompany synthetic fragrance (RSC has none), and the line's color comes from unrefined red palm oil's natural carotenoids, not FD&C dyes.

### 4. Product line (split into two sections that render as one unit)

**4a. `product-intro` (`rich-text`):**
- Heading (h2 styled h1-size): "Built for the bathroom shelf of someone who reacts."
- Sub: "Seven products. One philosophy. Pick what your skin needs." (muted gray)
- bg: `#faf7f0`; text_alignment=center; narrow=true; padding_top 64, padding_bottom 12 (tight bottom so it joins visually with the multicolumn below)

**4b. `product-line` (`multicolumn`):**
- No own heading (handled by 4a above)
- Layout: 4 cols desktop / 2 cols mobile, image_ratio=square, image_position=top, image_width=full, text_alignment=center, swipe_on_mobile=false
- bg: `#faf7f0`; padding_top 12 (tight top to join with intro), padding_bottom 56

**Why split:** The `multicolumn` primitive doesn't expose a separate subhead field. Splitting into rich-text intro + multicolumn cards is the same pattern used on the Sensitive Skin Set lander's "How the routine works" section.

**Card content:**

| # | Card title | Body | Link |
|---|---|---|---|
| 1 | Body Lotion | For skin that reacts to everyday lotions. | `/products/coconut-lotion` |
| 2 | Body Cream | For dry patches, eczema, and overnight repair. | `/products/coconut-moisturizer` |
| 3 | Toothpaste | For gums irritated by SLS and synthetic foaming agents. | `/products/coconut-oil-toothpaste` |
| 4 | Deodorant | Aluminum-free, baking-soda-free, fragrance-free. | `/products/coconut-oil-deodorant` |
| 5 | Liquid Soap | Hand wash that doesn't strip the skin barrier. | `/products/organic-foaming-hand-soap` |
| 6 | Bar Soap | No synthetic detergents, no synthetic fragrance. | `/products/coconut-soap` |
| 7 | Lip Balm | No petrolatum, no synthetic fragrance, no flavoring agents. | `/products/coconut-oil-lip-balm` |

**Order:** Sean's original order preserved (lotion → cream → toothpaste → deodorant → liquid → bar → lip balm).

**Placeholder image strategy:** Cards ship with no image set initially. The `multicolumn` section renders cards without images cleanly (title + text + link). At the photography walk-through, Sean provides 7 consistent-style product shots that get processed and uploaded.

**No prices on cards.** Pricing belongs on the PDP. The `Shop →` link is enough.

### 5. Featured testimonial (`custom-liquid`)

- **Edge-to-edge cream band** via `calc(-50vw + 50%)` margin.
- **Eyebrow line (uppercase, letter-spaced):** "300+ verified reviews · 290+ five-star"
- **Pull-quote (clamp 1.5–2.25rem, weight 600):** "I have horrible eczema and cracked feet. I've tried prescription lotions, steroids, everything OTC. Nothing worked — until Real Skin Care. Apply morning and night and my skin stays hydrated all day."
- **Attribution:** "— Jessica V., verified customer"
- **Link:** "Read more reviews →" → `https://judge.me/reviews/stores/realskincare-com`
- **Padding:** 80/80 desktop, 56/56 mobile

**Provenance:** Quote pulled from the actual Judge.me corpus (387 reviews store-wide; this one was the strongest in the sensitive-skin lander's testimonial swap pass). Replaces the placeholder "Morgan K." quote in the initial spec, which was a fictional name I'd generated earlier.

### 6. Founder anchor (`custom-liquid`, invisible)

A single `<span id="founder" style="display:block;height:0;"></span>` so the thesis section's anchor link can target the founder section. Zero padding, zero visible footprint.

### 7. Founder story (`image-with-text`)

- **Heading:** "Why we started Real Skin Care."
- **Body:** Two paragraphs from initial spec, with attribution `— Sean Fillmore, Founder` styled bold.
- **Image:** `shopify://shop_images/founder-landscape.webp` (existing asset, used on lander). Will be replaced during photography walk-through with the property photo.
- **Layout:** image_first (image left), full_width=true, text_alignment=left, mobile_layout=image_first
- **bg:** `#faf7f0`; padding 64/64

### 8. Closing CTA (`custom-liquid`)

- **Edge-to-edge dark band** (`#1a1b18`).
- **Heading (white, clamp 2–3.25rem):** "Stop reacting to your skincare."
- **Body (gray-white):** "If you've been slowly building a graveyard of "natural" products that still made your skin react, start with the Sensitive Skin Set. Two formulas, one routine, both Pure Unscented. 30-day money-back guarantee."
- **Primary button:** `Shop the Sensitive Skin Set — $XX.XX` (price pulled live via `{{ all_products['sensitive-skin-starter-set'].price | money }}`; if price is $0, the dash and price segment is omitted gracefully). bg `#AEDEAC`, dark text, 1px dark border.
- **Secondary text link (below button):** "Browse all products →" → `/collections/all`
- **Padding:** 80/80 desktop, 56/56 mobile

**Why custom-liquid instead of rich-text:** Rich-text button blocks accept plain string labels only. The closing CTA needs Liquid interpolation for the live price, which requires custom-liquid.

### 9. Email capture (`apps` section, Klaviyo block)

- **Block type:** `shopify://apps/klaviyo-email-marketing-sms/blocks/form-embed-block/2632fe16-c075-4321-a88b-50b567f42507`
- **formId:** `WzAQZX` (same form ID used in `templates/index.gem-1716757211-template.json` and elsewhere in the theme — Sean's existing Klaviyo form)
- **Padding:** 56/56

The Klaviyo form has its own copy and design configured in the Klaviyo dashboard. Sean's plan headline ("Get 15% off your first order") and subhead are assumed to live there. If they don't, Sean updates the form in Klaviyo, not in the theme.

## Photography walk-through plan

After the structural homepage is live on the dev theme, Sean walks through each section that has a placeholder image:

| Section | Placeholder | Final |
|---|---|---|
| 1 (Hero) | None — text on sage band | Flat-lay of full product line OR property + lotion/cream pair |
| 4 (Product cards) | None — text-only cards | 7 consistent-style product shots |
| 7 (Founder) | Existing `founder-landscape.webp` | Property photo |

**Process per shot:**
1. Sean drops the source image on Desktop
2. Run a sharp/sharp-style resize + WebP conversion (existing scripts: `scripts/swap-lander-hero.mjs` is the reference pattern)
3. Upload to Shopify Files via `lib/shopify.js`'s `uploadImageToShopifyCDN`
4. Patch the section's `image` field (or `bg_image_desktop` for the hero)
5. Push to dev theme; QA before pushing to live

## Build / deploy approach

**Approach 1 (chosen):** Single feature branch (`feat/homepage-redesign`), wholesale `index.json` replacement, dev-theme preview, push live last.

1. Build new `index.json` on `feat/homepage-redesign`
2. Push branch to origin
3. Push theme to dev theme (`shopify theme push --theme 145534910634`)
4. Sean reviews dev preview
5. Photography walk-through iterates on the same branch (commits as photos land)
6. When approved: PR → main, merge, then `shopify theme push --theme 145536778410 --allow-live` to publish

**Rollback:** Existing `index.gem-backup-default.json` etc. remain in place. If we ever need to revert the homepage, copy one of those back to `index.json`. Git history also preserves the prior state.

## Admin-side tasks for Sean (not theme code)

- Update the announcement bar copy in Shopify admin (theme customizer → header section). Should read: "Free shipping on orders over $50 · 30-day money-back guarantee"
- Confirm Klaviyo form `WzAQZX` is configured with the headline/subhead/15%-off automation he wants. If the form on the homepage looks wrong, edit it in Klaviyo dashboard, not in the theme.
- Optional: rename the bundle product variant from `Default Title` → `Pure Unscented` for clean cart/order display (this is the same admin task already noted from the lander launch).

## What got cut from the current homepage

For the record:

- "Be Confident in Your Skin with Pure Organic Skincare Solutions You Can Trust" hero (generic, not the thesis)
- "Seen On" press logos (financial wire services, not credible)
- Five-bottle Best Sellers row (visually undersells the line breadth)
- "Luxury Skincare For Sensitive Skin" middle band with Rochelle B. quote (generic)
- "Fast Shipping / Easy Returns / US Product" three-icon trust bar (generic; covered by announcement bar + closing CTA MBG)
- "Love from our customers" three-testimonial row (replaced by single stronger pull-quote)
- "Non-Toxic Body Lotion" mid-page product feature with buy button (jarring; buying happens on PDPs)
- "For All Skin Types / No Harmful Additives / Handmade By Us" badge row (generic)
- "Pure Organic Skincare" body section (repeats brand promise without new info)
- "Our Guarantee" section (MBG now lives in closing CTA)
- "Join the revolution on Instagram" full-width image block (deferred to footer if kept at all)
