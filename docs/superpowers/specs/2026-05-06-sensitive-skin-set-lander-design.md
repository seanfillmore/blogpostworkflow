# Sensitive Skin Set Landing Page (Gruns-style)

**Date:** 2026-05-06
**Product:** Sensitive Skin Moisturizing Set (Pure Unscented Lotion + Pure Unscented Body Cream)
**Goal:** Build a long-form, high-converting product page modeled after the Gruns landing page (`grunsdaily.com`), adapted for Real Skin Care.

## Goal & success criteria

- Match the **flow and conversion structure** of the Gruns lander, not its visual identity.
- Buybox uses Recurpay subscription widget (already installed as a theme app block).
- Build entirely in the local theme project at `/Users/seanfillmore/Code/realskincare-theme/`. Nothing pushed to live until reviewed.
- Output an explicit **image manifest** at the end of implementation: every photo/illustration the page needs, with dimensions, intended use, and copy/notes for AI generation.
- Reuse on-brand copy already drafted in `templates/product.landing-page-sensitive-skin-set.json` (founder voice, FAQs, free-from list, ingredient explanations).

## Architectural decision: new template, not in-place edit

Build at `templates/product.sensitive-skin-set-lander.json` as a **separate template**. Reasons:

1. **Live PDP stays intact.** The existing `product.landing-page-sensitive-skin-set.json` is currently rendering `/products/sensitive-skin-starter-set`. We don't break it while iterating.
2. **Preview without switch.** Shopify lets us preview any product with `?view=sensitive-skin-set-lander`. Local dev + theme preview work the same way.
3. **Cutover is one click.** When ready, change the product's template assignment in Shopify admin from `landing-page-sensitive-skin-set` → `sensitive-skin-set-lander`. No code redeploy needed; instant rollback if needed.
4. **All blocks/copy reused.** The new template will copy the `main` section block-for-block from the existing one (preserves Recurpay block, vqr-combo, free-shipping callout, all 4 benefit blocks, all 4 collapsible tabs, ymal-recommendations).

## Page architecture

The page renders sections in this order. Sections marked **[NEW]** are added; **[REUSE]** are copied verbatim from the existing template; **[REUSE+EDIT]** are copied with content tweaks.

| # | Section type | Purpose | Status |
|---|---|---|---|
| 1 | `landing-sticky-nav` | Anchor nav appears on scroll: Why It Works · Reviews · Compare · FAQ · Buy | **[NEW]** |
| 2 | `hero-landing-section` | Green/cream full-width hero with set product, headline, bullets, rating, CTA → `#buy-box` | **[NEW]** |
| 3 | `logo-list` | "Trusted by 10,000+" social proof strip OR press logos if available | **[NEW]** |
| 4 | `hero-ingredient-cards` (multicolumn 2-card) | "What's Inside The Set" — Pure Unscented Lotion + Pure Unscented Body Cream | **[REUSE]** |
| 5 | `landing-health-image` | Big set-product image with 4 benefit callouts orbiting: Non-Reactive · Plant-Based Barrier · Cold-Pressed · Made in USA | **[NEW]** |
| 6 | `image-with-text` | Stats hero — "Modern Skincare Is Failing Sensitive Skin" — 60%/X% stats with hand-holding-product photo | **[NEW]** |
| 7 | `multicolumn` (4-stat row) | Customer-data stats: % saw less reactivity, % repurchase, % irritation-free, % return rate | **[NEW]** |
| 8 | `guarantees` | Trust badges: Cold-pressed · No synthetic fragrance · Cruelty-free · Handmade USA | **[NEW]** |
| 9 | `main` (id=`buy-box`) | The buybox itself — full block list copied from existing template (title, price, 4 benefits, variant_picker, vqr-combo, discount-callout, **recurpay-widget**, buy_buttons, 4 collapsible tabs, ymal-recommendations, sticky_cart, judgeme_preview_badge) | **[REUSE]** — anchor id added |
| 10 | `hook-rich-text` | "Two formulas, one routine for skin that reacts to everything else." | **[REUSE]** |
| 11 | `judgeme_carousel_cream` (apps) | Customer review carousel | **[REUSE]** |
| 12 | `landing-reels-row` | 4-customer photo strip (UGC-style — hands holding the products in real settings) | **[NEW]** |
| 13 | `landing-compare-table` | Us vs. Them — RSC Set vs. Cetaphil · Aveeno · CeraVe (fragrance, parabens, mineral oil, plant-based, etc.) | **[NEW]** |
| 14 | `image-with-text` | "Don't fumble the bag" CTA — diagonal split, set product + "Stop trying new lotions. Start healing." → `#buy-box` | **[NEW]** |
| 15 | `founder-block` (image-with-text) | Sean's existing founder quote with chef/lifestyle photo | **[REUSE]** |
| 16 | `free-from-block` (image-with-text) | "What's NOT in either jar or bottle" | **[REUSE]** |
| 17 | `rich-text` (full-bleed dark) | Final CTA strip — "Want to Join the 10,000+ Who Stopped Reacting to Their Skincare?" + button | **[NEW]** |
| 18 | `collapsible-content` | "Any last questions?" — 8 existing FAQs | **[REUSE]** |
| 19 | `loox-product-reviews-app-section` (apps) | Loox reviews | **[REUSE]** — keep as legacy fallback, may disable if Judge.me carousel covers it |

## Content sourcing

- **Headlines & body copy:** Will be drafted as part of implementation. Tone matches existing template (factual, ingredient-honest, no marketing puffery — the founder voice already established).
- **Stats (sections 6 and 7):**
  - Section 6 (external stats) — sourced from published research on sensitive skin prevalence (e.g., Misery et al. studies, ~60% of women self-report sensitive skin). Cite source inline.
  - Section 7 (internal stats) — RSC customer survey data if available; otherwise placeholder values flagged for fill-in by Sean.
- **Comparison table competitors:** Cetaphil, Aveeno, CeraVe — chosen as the dominant sensitive-skin drugstore brands. Comparison rows: Synthetic fragrance · Parabens · Mineral oil · Petrolatum · Dimethicone · Lanolin · Plant-based · Made in USA.
- **All product copy already exists** in the source template — no rewriting needed for ingredient explanations, benefits, FAQs, founder quote.

## Implementation phases

1. **Phase 1 — Scaffold the template.** Create `templates/product.sensitive-skin-set-lander.json` with the full section order, section settings copied from the existing template where applicable, and placeholder text/images everywhere new content is needed.
2. **Phase 2 — Verify each section renders.** Push to dev theme, view product with `?view=sensitive-skin-set-lander`, check every section renders without Liquid errors and the buybox/Recurpay/cart-add flow works identically to the live PDP.
3. **Phase 3 — Draft new copy.** Write headlines, subheadings, stat copy, CTA copy for the [NEW] sections. Match the existing template's voice.
4. **Phase 4 — Image manifest.** Produce the deliverable Sean asked for: a single document listing every image the page needs — section by section, intended dimensions, alt text, generation prompts/notes.
5. **Phase 5 — Generate/source images.** Out of scope for this design; spec will hand off the manifest.
6. **Phase 6 — QA & cutover.** Final review on dev theme. Switch product template assignment in Shopify admin when approved.

## Risks & open issues

- **Recurpay block portability.** The existing template references the Recurpay block by Shopify app block UUID. Copying that block ID into the new template should work because it's the same shop, but verify on first preview that the widget renders.
- **`landing-*` sections schema verification.** I have not yet read the schemas for `landing-sticky-nav`, `landing-health-image`, `landing-reels-row`, `landing-compare-table`, `hero-landing-section`. The implementation plan must start by reading each section's schema to know what blocks/settings are available before scaffolding. If any required visual element isn't expressible in the existing schema, the section needs minor extension (additive only — no breaking changes to existing usages elsewhere).
- **Section 19 duplicate review widgets.** The existing template has both Judge.me (carousel) and Loox (full reviews) showing reviews. The new template inherits both. Decision deferred to QA — if both show similar content, disable Loox.
- **Image volume.** The page will need ~12-15 net-new images (hero, stats hero, 4 reels-row UGC, comparison table competitor logos or product shots, "don't fumble" image, etc.). Manifest will quantify.

## Out of scope

- Pixel-matching Gruns visual treatment (typography, illustrations, gummy bear character).
- Building any new section types from scratch — all 19 sections must be expressible with existing theme sections (with at most additive schema tweaks). If a section can't be expressed that way, it gets cut from the design or replaced with the closest substitute.
- Image generation/sourcing itself — manifest only.
- A/B test infrastructure or analytics events on the new page.

## Deliverable handoff

End state of this work:

1. Working product template at `templates/product.sensitive-skin-set-lander.json` previewable on dev theme.
2. Image manifest document listing every required image.
3. List of any schema tweaks made to existing sections (with diff notes for review).
