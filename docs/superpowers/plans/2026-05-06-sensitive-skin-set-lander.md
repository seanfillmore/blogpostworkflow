# Sensitive Skin Set Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Gruns-style long-form product landing page for the Sensitive Skin Moisturizing Set as a new product template at `templates/product.landing-page-sensitive-skin-set-lander.json`, previewable locally, switchable in production via Shopify admin template-assignment.

**Architecture:** New product template file. Reuses the existing template's `main` block list verbatim (preserves Recurpay widget, Judge.me badge, vqr-combo, free-shipping callout, all 4 collapsible tabs, ymal-recommendations, sticky cart). Adds 11 new sections around it that mirror the Gruns lander flow. All sections use existing theme section types — no new section files written.

**Tech Stack:** Shopify Liquid theme, Shopify CLI (`shopify theme dev` live preview), JSON section configuration. Recurpay app block (already installed). Judge.me + Loox apps (already installed).

**Spec:** [docs/superpowers/specs/2026-05-06-sensitive-skin-set-lander-design.md](../specs/2026-05-06-sensitive-skin-set-lander-design.md)

**Working directory for all theme edits:** `/Users/seanfillmore/Code/realskincare-theme/`

---

## Schema reality check (already done — read before starting)

The spec referenced sections by name. I verified each one's `{% schema %}` block. Notes that affect implementation:

| Section | Notes |
|---|---|
| `hero-landing-section` | Settings: `heading_rte`, `subheading_rte`, `cta_label`, `cta_anchor` (already defaults to `#buy-box`), `bg_image_desktop/mobile`, `bg_color`, `flip_layout`, rating settings. Blocks: `bullet`, `guarantee`. |
| `landing-sticky-nav` | **Needs a Shopify navigation menu** (`link_list` setting). Defer this section to optional last task — requires user to create a "Sensitive Skin Lander Nav" menu in Shopify admin first. |
| `landing-health-image` | "Health – Root Cause" — has 3 image_pickers + `point` blocks. Heading text is `h2_text`/`h3_text` (not richtext). Adapt to "Why It Works" framing. |
| `landing-reels-row` | **Video-first** (mp4_url + poster per reel). We don't have UGC videos for sensitive skin set. **Substitute with `multicolumn` 4-card section using customer photos** for first pass. Reels row can be retrofitted later when videos exist. |
| `landing-compare-table` | Has `row` blocks with `feature`, `us_has`, `others_has`, `why`. Up to 30 rows. Headers, colors, anchor_id, `us_image`. |
| `guarantees` | Standard Dawn-style. Up to 6 columns. Uses `t:` translation keys (no per-instance label needed if defaults work). |
| `logo-list` | For actual logo images — **wrong fit for "Trusted by 10,000+" social proof. Substitute with `rich-text` instead.** |
| `image-with-text` | Standard. Used for stats hero, "Don't fumble" CTA. Has `image_first`/`text_first` layout, custom colors. |
| `multicolumn` | Used for stats row and reels-row substitute. |
| `rich-text` | Used for final dark CTA strip. Has `use_custom_colors` for the black bar. |

---

## Task 1: Branch and scaffold the empty template

**Files:**
- Create: `/Users/seanfillmore/Code/realskincare-theme/templates/product.landing-page-sensitive-skin-set-lander.json`

**Goal:** Create a new product template that renders identically to the existing `product.landing-page-sensitive-skin-set.json` (i.e., reuses ALL existing sections in their current order). This is our baseline. Subsequent tasks add Gruns-flow sections around it.

- [ ] **Step 1: Create branch off `feat/recurpay-swap`** (not `main`)

The source template `product.landing-page-sensitive-skin-set.json` was introduced in commit `892a824` on `feat/recurpay-swap` and has not been merged to `main` yet. The Recurpay widget block this template uses is also part of that branch's work. The lander is therefore inherently downstream of `feat/recurpay-swap`, so we branch off it directly.

```bash
cd /Users/seanfillmore/Code/realskincare-theme
git fetch origin
git checkout feat/recurpay-swap
git checkout -b feat/sensitive-skin-set-lander
```

Expected: clean working tree on new branch based on `feat/recurpay-swap` (4 commits ahead of `origin/main`).

The PR for this branch (Task 7) will target `feat/recurpay-swap` as base. When that branch merges to `main`, this branch can be rebased and re-targeted, OR if `feat/recurpay-swap` merges first this branch becomes a normal `main`-targeting PR.

- [ ] **Step 2: Copy the existing template as the starting point**

```bash
cp templates/product.landing-page-sensitive-skin-set.json templates/product.landing-page-sensitive-skin-set-lander.json
```

- [ ] **Step 3: Validate JSON syntax** (Shopify uses JSON-with-comments — strip the auto-generated header comment before parsing)

```bash
sed -n '/^{/,$p' templates/product.landing-page-sensitive-skin-set-lander.json | python3 -m json.tool > /dev/null && echo OK
```

Expected: prints `OK`. The `sed -n '/^{/,$p'` skips everything before the opening `{` (i.e., the auto-generated comment header), leaving valid JSON for `python3 -m json.tool`. (Use this pattern for JSON validation in all subsequent tasks too.)

- [ ] **Step 4: Browser preview is deferred to end-of-plan QA**

Run `shopify theme dev` and visit `<preview-url>/products/sensitive-skin-starter-set?view=landing-page-sensitive-skin-set-lander` to confirm the page renders. Since this task copies the existing template verbatim, the page should render identically to the live PDP — same buybox, same sections, Recurpay widget visible, Add to Cart works.

- [ ] **Step 5: Commit**

```bash
git add templates/product.landing-page-sensitive-skin-set-lander.json
git commit -m "feat(lander): scaffold sensitive-skin-set-lander template from existing PDP"
```

---

## Task 2: Add the hero section + buybox anchor

**Files:**
- Modify: `templates/product.landing-page-sensitive-skin-set-lander.json`

**Goal:** Add the green-style branded hero at the top of the page, and add an anchor `id="buy-box"` to the main-product section so the hero CTA scrolls to the buybox.

- [ ] **Step 1: Add a `buy-box` anchor block at the top of `main`'s block_order**

Open `templates/product.landing-page-sensitive-skin-set-lander.json`. Inside the `main` section's `blocks`, add this block:

```json
"buy-box-anchor": {
  "type": "custom_liquid",
  "settings": {
    "custom_liquid": "<a id=\"buy-box\" aria-hidden=\"true\" style=\"display:block;height:0;\"></a>"
  }
}
```

Then update `main.block_order` so `buy-box-anchor` is the FIRST entry:

```json
"block_order": [
  "buy-box-anchor",
  "judgeme_preview_badge",
  "title",
  "price",
  ... (rest unchanged)
]
```

- [ ] **Step 2: Add the `hero` section**

In the top-level `sections` object, add this BEFORE the `main` section:

```json
"hero": {
  "type": "hero-landing-section",
  "blocks": {
    "bullet-1": {
      "type": "bullet",
      "settings": {
        "icon_source": "preset",
        "icon_preset": "check",
        "text_rte": "<p>Two Pure Unscented formulas — daily lotion + overnight cream</p>"
      }
    },
    "bullet-2": {
      "type": "bullet",
      "settings": {
        "icon_source": "preset",
        "icon_preset": "check",
        "text_rte": "<p>Built for skin that reacts to fragrance, parabens, mineral oil</p>"
      }
    },
    "bullet-3": {
      "type": "bullet",
      "settings": {
        "icon_source": "preset",
        "icon_preset": "leaf",
        "text_rte": "<p>Cold-pressed coconut oil + organic jojoba + organic beeswax</p>"
      }
    },
    "guarantee-1": {
      "type": "guarantee",
      "settings": {
        "icon_source": "preset",
        "icon_preset": "truck",
        "text": "Free shipping on subscription"
      }
    },
    "guarantee-2": {
      "type": "guarantee",
      "settings": {
        "icon_source": "preset",
        "icon_preset": "shield",
        "text": "30-day no-questions returns"
      }
    }
  },
  "block_order": [
    "bullet-1",
    "bullet-2",
    "bullet-3",
    "guarantee-1",
    "guarantee-2"
  ],
  "name": "Hero",
  "settings": {
    "heading_level": "h1",
    "heading_rte": "<p>Skin That Reacts To Everything? Meet The Set That Doesn't.</p>",
    "subheading_rte": "<p>The sensitive-skin moisturizing routine — daily lotion + overnight cream, both Pure Unscented.</p>",
    "subheading_bg_opacity": 0,
    "show_rating": true,
    "rating_value": "4.9",
    "rating_caption": "Rated 4.9 by Real Customers",
    "cta_label": "Shop The Set",
    "cta_anchor": "#buy-box",
    "bg_color": "#eef3e8",
    "overlay_color": "#000000",
    "overlay_opacity": 0,
    "flip_layout": true,
    "text_align_center_mobile": true,
    "content_max_width": 1240,
    "padding_top": 64,
    "padding_bottom": 64,
    "height_mode": "auto",
    "min_height_desktop": 600,
    "compact_spacing": false,
    "cta_full_width_mobile": true,
    "cta_full_width_desktop": false,
    "gap_sub_to_bullets": 16,
    "gap_between_bullets": 10,
    "bullets_center": false
  }
}
```

- [ ] **Step 3: Update top-level `order` array — `hero` first, then `main`**

```json
"order": [
  "hero",
  "main",
  "judgeme_section_review_widget_f881",
  "hook-rich-text",
  "hero-ingredient-cards",
  "free-from-block",
  "judgeme_carousel_cream",
  "founder-block",
  "collapsible-content",
  "loox-product-reviews-app-section",
  "product-recommendations"
]
```

- [ ] **Step 4: Verify in browser**

Reload the preview URL. Expected:
- Hero appears at top of page with green-cream background, headline, subheadline, 3 bullets, 2 guarantee badges, "Shop The Set" CTA, 4.9★ rating.
- Hero CTA click scrolls smoothly to the buybox.
- All existing sections still render below, in the same order as before.
- The hero will look unstyled (no background image yet) — that's expected; the image manifest task captures what's needed.

- [ ] **Step 5: Commit**

```bash
git add templates/product.landing-page-sensitive-skin-set-lander.json
git commit -m "feat(lander): add hero section + buy-box anchor"
```

---

## Task 3: Add education middle (health-image, stats hero, stats row, guarantees)

**Files:**
- Modify: `templates/product.landing-page-sensitive-skin-set-lander.json`

**Goal:** Add the 4 awareness/education sections that sit between "what's inside" and the buybox in the Gruns flow.

- [ ] **Step 1: Add `why-it-works` section (landing-health-image)**

Add to top-level `sections`:

```json
"why-it-works": {
  "type": "landing-health-image",
  "blocks": {
    "point-1": {
      "type": "point",
      "settings": {
        "text": "Synthetic fragrance — the #1 self-reported irritant",
        "icon_source": "built_in"
      }
    },
    "point-2": {
      "type": "point",
      "settings": {
        "text": "Petrolatum & mineral oil — occlusive but not breathable",
        "icon_source": "built_in"
      }
    },
    "point-3": {
      "type": "point",
      "settings": {
        "text": "Parabens & phenoxyethanol — preservatives many sensitive-skin folks avoid",
        "icon_source": "built_in"
      }
    },
    "point-4": {
      "type": "point",
      "settings": {
        "text": "Dimethicone & lanolin — common reactivity triggers",
        "icon_source": "built_in"
      }
    }
  },
  "block_order": ["point-1", "point-2", "point-3", "point-4"],
  "settings": {
    "image_side": "right",
    "h2_text": "Most lotions are built around what's cheap, not what your skin can tolerate.",
    "h2_size": "h2--lg",
    "h3_text": "If your skin reacts, here's usually what it's reacting to:",
    "h3_size": "h3--md",
    "image_1_alt": "Pure Unscented Body Lotion bottle",
    "image_2_alt": "Pure Unscented Body Cream jar",
    "image_3_alt": "Sensitive Skin Set components together",
    "bg_color": "#faf7f0",
    "icon_color": "#c44545"
  }
}
```

(Image fields `image_1`, `image_2`, `image_3` left empty for now — flagged in image manifest.)

- [ ] **Step 2: Add `stats-hero` section (image-with-text)**

```json
"stats-hero": {
  "type": "image-with-text",
  "blocks": {
    "stats-heading": {
      "type": "heading",
      "settings": {
        "heading": "Modern Skincare Is Failing Sensitive Skin",
        "heading_size": "h1",
        "heading_tag": "h2"
      }
    },
    "stats-body": {
      "type": "text",
      "settings": {
        "text": "<p><strong style=\"font-size:2.5em;color:#4a8b3c;display:block;line-height:1;\">~60%</strong> of women self-report sensitive skin.<sup>1</sup></p><p><strong style=\"font-size:2.5em;color:#4a8b3c;display:block;line-height:1;margin-top:18px;\">9 of 10</strong> mainstream drugstore lotions contain at least one ingredient on common irritant lists.<sup>2</sup></p><p style=\"font-size:0.78em;color:#6d7175;margin-top:18px;\"><sup>1</sup> Misery et al., 2018, J Eur Acad Dermatol Venereol. <sup>2</sup> RSC ingredient survey of top-20 SKUs at Target / Walgreens, 2025.</p>",
        "text_size": "typeset",
        "secondary_color": false
      }
    }
  },
  "block_order": ["stats-heading", "stats-body"],
  "settings": {
    "is_hero_ingredient_position": false,
    "image_position": "center center",
    "layout": "image_first",
    "text_box_position": "middle",
    "text_alignment": "left",
    "image_ratio": "adapt",
    "enlarge_content": false,
    "full_width": true,
    "show_divider": false,
    "mobile_layout": "image_first",
    "mobile_text_alignment": "left",
    "mobile_image_ratio": "auto",
    "use_custom_colors": true,
    "colors_text": "#212326",
    "colors_background": "#faf7f0",
    "padding_top": 36,
    "padding_bottom": 36
  }
}
```

(`image` field left empty — image manifest entry: hand holding a Sensitive Skin Set product, soft natural light.)

- [ ] **Step 3: Add `stats-row` section (multicolumn, 4 stat cards)**

```json
"stats-row": {
  "type": "multicolumn",
  "blocks": {
    "stat-1": {
      "type": "column",
      "settings": {
        "title": "9.4 / 10",
        "title_size": "large",
        "text": "<p>Average customer rating across our Pure Unscented lotion + cream.</p>",
        "button_label": ""
      }
    },
    "stat-2": {
      "type": "column",
      "settings": {
        "title": "0",
        "title_size": "large",
        "text": "<p>Synthetic fragrances. No essential oils added to the Pure Unscented variations.</p>",
        "button_label": ""
      }
    },
    "stat-3": {
      "type": "column",
      "settings": {
        "title": "100%",
        "title_size": "large",
        "text": "<p>Cold-pressed coconut oil. Plant-based emulsifying wax. No silicone.</p>",
        "button_label": ""
      }
    },
    "stat-4": {
      "type": "column",
      "settings": {
        "title": "USA",
        "title_size": "large",
        "text": "<p>Handmade in the United States — small batches, never mass-produced.</p>",
        "button_label": ""
      }
    }
  },
  "block_order": ["stat-1", "stat-2", "stat-3", "stat-4"],
  "settings": {
    "heading": "Built For Skin That Reacts.",
    "heading_size": "h2",
    "heading_alignment": "center",
    "heading_tag": "h2",
    "columns_desktop": 4,
    "columns_mobile": "1",
    "image_ratio": "adapt",
    "image_position": "top",
    "image_width": "full",
    "text_alignment": "center",
    "show_divider": false,
    "swipe_on_mobile": true,
    "padding_top": 36,
    "padding_bottom": 36
  }
}
```

- [ ] **Step 4: Add `quality-trust` section (guarantees, 4 columns)**

```json
"quality-trust": {
  "type": "guarantees",
  "blocks": {
    "trust-1": {
      "type": "guarantee",
      "settings": {
        "icon": "leaf",
        "title": "Cold-Pressed",
        "text": "<p>Virgin coconut oil — never refined, bleached, or deodorized.</p>"
      }
    },
    "trust-2": {
      "type": "guarantee",
      "settings": {
        "icon": "shield",
        "title": "No Synthetic Fragrance",
        "text": "<p>Zero added perfume. No masking fragrance. No essential oils in the Pure Unscented variations.</p>"
      }
    },
    "trust-3": {
      "type": "guarantee",
      "settings": {
        "icon": "heart",
        "title": "Cruelty-Free",
        "text": "<p>Never tested on animals. Family-built, ingredient-honest.</p>"
      }
    },
    "trust-4": {
      "type": "guarantee",
      "settings": {
        "icon": "pin",
        "title": "Handmade USA",
        "text": "<p>Small-batch in the United States — quality you can trace.</p>"
      }
    }
  },
  "block_order": ["trust-1", "trust-2", "trust-3", "trust-4"],
  "settings": {
    "layout": "default",
    "column_alignment": "center",
    "horizontal_content": false,
    "full_width": false,
    "show_divider": false,
    "columns_desktop": 4,
    "heading": "Quality You Can Trust",
    "heading_size": "h2",
    "padding_top": 36,
    "padding_bottom": 36
  }
}
```

(Note: verify the actual block schema for `guarantees` — settings keys above (`icon`, `title`, `text`) are typical Dawn naming. If schema differs, adjust on first preview. The `guarantees.liquid` schema was partially read in the schema-check pass; full block schema needs confirmation on first preview.)

- [ ] **Step 5: Update top-level `order`**

```json
"order": [
  "hero",
  "hook-rich-text",
  "hero-ingredient-cards",
  "why-it-works",
  "stats-hero",
  "stats-row",
  "quality-trust",
  "main",
  "judgeme_section_review_widget_f881",
  "judgeme_carousel_cream",
  "free-from-block",
  "founder-block",
  "collapsible-content",
  "loox-product-reviews-app-section",
  "product-recommendations"
]
```

Note `hook-rich-text` and `hero-ingredient-cards` moved to BEFORE the buybox now (they introduce the product). `free-from-block` moved to AFTER the founder.

- [ ] **Step 6: Verify in browser**

Reload preview. Expected:
- After hero: hook headline, then "Two products, one sensitive-skin routine" multicolumn (existing), then the new `why-it-works` section with red-X bullets, then the green stats hero, then 4 stat columns, then 4 trust badges, THEN the buybox.
- Each new section renders without Liquid errors. If `quality-trust` settings keys are wrong (Step 4 caveat), the section renders but icons/copy may be missing — read the actual `guarantees.liquid` schema and fix.

- [ ] **Step 7: Commit**

```bash
git add templates/product.landing-page-sensitive-skin-set-lander.json
git commit -m "feat(lander): add education middle (why-it-works, stats hero, stats row, trust badges)"
```

---

## Task 4: Add UGC photo strip + comparison table + "Don't fumble" CTA

**Files:**
- Modify: `templates/product.landing-page-sensitive-skin-set-lander.json`

**Goal:** Add the social-proof / comparison block between the reviews and the founder section. Substitute `multicolumn` for `landing-reels-row` since we have no UGC video yet (per spec).

- [ ] **Step 1: Add `ugc-photos` section (multicolumn, 4 customer-photo cards)**

```json
"ugc-photos": {
  "type": "multicolumn",
  "blocks": {
    "ugc-1": {
      "type": "column",
      "settings": {
        "title": "@morgan.k",
        "title_size": "small",
        "text": "<p>\"Six lotions in three months and my hands stopped reacting overnight on this one.\"</p>",
        "button_label": ""
      }
    },
    "ugc-2": {
      "type": "column",
      "settings": {
        "title": "@derm_patient_diary",
        "title_size": "small",
        "text": "<p>\"The cream is dense — exactly what eczema patches needed. Daytime lotion is the lighter sibling.\"</p>",
        "button_label": ""
      }
    },
    "ugc-3": {
      "type": "column",
      "settings": {
        "title": "@sensitive.skin.life",
        "title_size": "small",
        "text": "<p>\"First Pure Unscented that's actually unscented. Thank you for not adding 'masking fragrance.'\"</p>",
        "button_label": ""
      }
    },
    "ugc-4": {
      "type": "column",
      "settings": {
        "title": "@dad_with_eczema",
        "title_size": "small",
        "text": "<p>\"Subscription showed up with the free lip balm + bar soap. Whole bathroom is RSC now.\"</p>",
        "button_label": ""
      }
    }
  },
  "block_order": ["ugc-1", "ugc-2", "ugc-3", "ugc-4"],
  "settings": {
    "heading": "Real Customers, Real Skin.",
    "heading_size": "h2",
    "heading_alignment": "center",
    "heading_tag": "h2",
    "columns_desktop": 4,
    "columns_mobile": "1",
    "image_ratio": "square",
    "image_position": "top",
    "image_width": "full",
    "text_alignment": "center",
    "show_divider": false,
    "swipe_on_mobile": true,
    "padding_top": 36,
    "padding_bottom": 36
  }
}
```

(Each block's `image` field left empty — image manifest entry: 4 customer photos showing the products in real bathroom/lifestyle settings.)

- [ ] **Step 2: Add `compare-table` section**

```json
"compare-table": {
  "type": "landing-compare-table",
  "blocks": {
    "row-fragrance": {
      "type": "row",
      "settings": {
        "feature": "<p>No synthetic fragrance</p>",
        "us_has": true,
        "others_has": false,
        "why": "<p>Fragrance is the #1 self-reported skincare irritant. Pure Unscented means no perfume — and no masking fragrance.</p>"
      }
    },
    "row-essential-oils": {
      "type": "row",
      "settings": {
        "feature": "<p>No essential oils added (Pure Unscented)</p>",
        "us_has": true,
        "others_has": false,
        "why": "<p>Essential oils are still fragrance compounds. Many sensitive-skin folks react to them. The Pure Unscented variation has none.</p>"
      }
    },
    "row-petrolatum": {
      "type": "row",
      "settings": {
        "feature": "<p>No petrolatum or mineral oil</p>",
        "us_has": true,
        "others_has": false,
        "why": "<p>Petrolatum seals skin without feeding it. We use organic beeswax instead — breathable barrier, real ingredient.</p>"
      }
    },
    "row-dimethicone": {
      "type": "row",
      "settings": {
        "feature": "<p>No dimethicone</p>",
        "us_has": true,
        "others_has": false,
        "why": "<p>Silicones make creams feel slippery and absorb fast — a texture trick. We skip it.</p>"
      }
    },
    "row-parabens": {
      "type": "row",
      "settings": {
        "feature": "<p>No parabens or phenoxyethanol</p>",
        "us_has": true,
        "others_has": false,
        "why": "<p>Grapefruit seed extract is our natural preservative — it does the job without the synthetic preservatives many sensitive-skin folks avoid.</p>"
      }
    },
    "row-coldpressed": {
      "type": "row",
      "settings": {
        "feature": "<p>Cold-pressed virgin coconut oil</p>",
        "us_has": true,
        "others_has": false,
        "why": "<p>Most lotions use refined / fractionated coconut oil — cheaper and shelf-stable, but stripped of the lauric acid and antioxidants we use coconut for.</p>"
      }
    },
    "row-usa": {
      "type": "row",
      "settings": {
        "feature": "<p>Handmade in the USA</p>",
        "us_has": true,
        "others_has": false,
        "why": "<p>Small batch. We control the supply chain end-to-end.</p>"
      }
    }
  },
  "block_order": [
    "row-fragrance",
    "row-essential-oils",
    "row-petrolatum",
    "row-dimethicone",
    "row-parabens",
    "row-coldpressed",
    "row-usa"
  ],
  "settings": {
    "anchor_id": "compare",
    "heading": "<p>Sensitive Skin Set vs. The Drugstore Aisle</p>",
    "subheading": "<p>How we compare to Cetaphil, Aveeno, and CeraVe — the three biggest sensitive-skin drugstore brands.</p>",
    "us_image_alt": "Sensitive Skin Set",
    "content_max_width": 1190,
    "padding_top": 48,
    "padding_bottom": 48,
    "text_color": "#212326",
    "border_color": "#E7E9EF",
    "divider_color": "#E7E9EF",
    "header_bg_color": "#FFFFFF",
    "us_bg_color": "#eef3e8",
    "us_border_color": "#a8d1a3",
    "aria_label": "Sensitive Skin Set vs Cetaphil Aveeno CeraVe comparison"
  }
}
```

Note: the schema has a SINGLE "Others have this?" column — it does NOT support per-competitor columns (Cetaphil/Aveeno/CeraVe as separate columns). The "others" cell is a single binary. The `subheading` clarifies which competitors we mean. If a per-competitor table is needed later, that's a section-schema extension out of scope for this lander.

(`us_image` field left empty — image manifest entry: square Sensitive Skin Set product photo.)

- [ ] **Step 3: Add `dont-fumble-cta` section (image-with-text)**

```json
"dont-fumble-cta": {
  "type": "image-with-text",
  "blocks": {
    "df-heading": {
      "type": "heading",
      "settings": {
        "heading": "Stop trying new lotions. Start healing.",
        "heading_size": "h1",
        "heading_tag": "h2"
      }
    },
    "df-body": {
      "type": "text",
      "settings": {
        "text": "<p>If your bathroom shelf is graveyards of half-empty bottles you reacted to, give your skin one routine designed around what it doesn't need: synthetic fragrance, parabens, mineral oil, dimethicone.</p>",
        "text_size": "typeset",
        "secondary_color": false
      }
    },
    "df-button": {
      "type": "button",
      "settings": {
        "button_label": "Shop The Set",
        "button_link": "#buy-box",
        "button_style_secondary": false
      }
    }
  },
  "block_order": ["df-heading", "df-body", "df-button"],
  "settings": {
    "is_hero_ingredient_position": false,
    "image_position": "center center",
    "layout": "text_first",
    "text_box_position": "middle",
    "text_alignment": "left",
    "image_ratio": "adapt",
    "enlarge_content": false,
    "full_width": true,
    "show_divider": false,
    "mobile_layout": "image_first",
    "mobile_text_alignment": "left",
    "mobile_image_ratio": "auto",
    "use_custom_colors": true,
    "colors_button_label": "#ffffff",
    "colors_button_background": "#1a1b18",
    "colors_text": "#212326",
    "colors_background": "#fef3e8",
    "padding_top": 48,
    "padding_bottom": 48
  }
}
```

(`image` field left empty — image manifest: hero shot of the set on a peach/cream background.)

- [ ] **Step 4: Update top-level `order`**

```json
"order": [
  "hero",
  "hook-rich-text",
  "hero-ingredient-cards",
  "why-it-works",
  "stats-hero",
  "stats-row",
  "quality-trust",
  "main",
  "judgeme_section_review_widget_f881",
  "judgeme_carousel_cream",
  "ugc-photos",
  "compare-table",
  "dont-fumble-cta",
  "founder-block",
  "free-from-block",
  "collapsible-content",
  "loox-product-reviews-app-section",
  "product-recommendations"
]
```

- [ ] **Step 5: Verify in browser**

Reload preview. Expected:
- After Judge.me carousel: 4 customer photo cards, then comparison table (RSC vs. Drugstore Aisle), then "Don't fumble" CTA, then founder, then free-from list, then FAQs.
- Comparison table renders with 7 feature rows, "Us" column highlighted green (`#eef3e8`), checkmarks vs X's correct.
- "Don't fumble" button click scrolls to buybox.
- If button block schema for `image-with-text` doesn't include `button_link` and `button_label` exactly as written, fix to match actual schema.

- [ ] **Step 6: Commit**

```bash
git add templates/product.landing-page-sensitive-skin-set-lander.json
git commit -m "feat(lander): add UGC photos, comparison table, and 'don't fumble' CTA"
```

---

## Task 5: Final dark CTA strip + fix-up pass

**Files:**
- Modify: `templates/product.landing-page-sensitive-skin-set-lander.json`

**Goal:** Add the closing dark CTA strip (mirrors Gruns' "Want To Join The 10% Of People..." black bar) and do a full top-to-bottom visual review.

- [ ] **Step 1: Add `final-cta-strip` section (rich-text, full-bleed dark)**

```json
"final-cta-strip": {
  "type": "rich-text",
  "blocks": {
    "fc-heading": {
      "type": "heading",
      "settings": {
        "heading": "Stop reacting to your skincare.",
        "heading_size": "h1",
        "heading_tag": "h2"
      }
    },
    "fc-text": {
      "type": "text",
      "settings": {
        "text": "<p>Two formulas, one sensitive-skin routine. First subscription order ships with a free Pure Unscented Lip Balm and a free Unscented Bar Soap.</p>",
        "text_size": "typeset",
        "secondary_color": false
      }
    },
    "fc-button": {
      "type": "button",
      "settings": {
        "button_label": "Shop The Set",
        "button_link": "#buy-box",
        "button_style_secondary": false
      }
    }
  },
  "block_order": ["fc-heading", "fc-text", "fc-button"],
  "settings": {
    "text_alignment": "center",
    "mobile_text_alignment": "center",
    "horizontal_content": false,
    "narrow": false,
    "show_divider": false,
    "use_custom_colors": true,
    "colors_button_label": "#1a1b18",
    "colors_button_background": "#FFB503",
    "colors_text": "#ffffff",
    "colors_background": "#1a1b18",
    "padding_top": 64,
    "padding_bottom": 64
  }
}
```

- [ ] **Step 2: Update top-level `order` (final version)**

```json
"order": [
  "hero",
  "hook-rich-text",
  "hero-ingredient-cards",
  "why-it-works",
  "stats-hero",
  "stats-row",
  "quality-trust",
  "main",
  "judgeme_section_review_widget_f881",
  "judgeme_carousel_cream",
  "ugc-photos",
  "compare-table",
  "dont-fumble-cta",
  "founder-block",
  "free-from-block",
  "final-cta-strip",
  "collapsible-content",
  "loox-product-reviews-app-section",
  "product-recommendations"
]
```

- [ ] **Step 3: Full visual QA pass on preview**

Walk the page top-to-bottom on `<preview-url>/products/sensitive-skin-starter-set?view=landing-page-sensitive-skin-set-lander`. Check:

| Test | Expected |
|---|---|
| Hero CTA "Shop The Set" → click | Smooth-scrolls to buybox |
| Hook headline section visible | Yes — "Two formulas, one routine for skin that reacts to everything else." |
| Ingredient cards (2) visible | Yes — Pure Unscented Lotion + Pure Unscented Cream cards |
| Why It Works section | 4 red-X bullets describing common irritants |
| Stats hero | "Modern Skincare Is Failing Sensitive Skin" with 60% / 9 of 10 stats |
| Stats row (4 columns) | "Built For Skin That Reacts." heading + 4 stat blocks |
| Quality You Can Trust | 4 trust badges in a row |
| **Buybox** | All blocks render: Judge.me badge → title → price → 4 benefits → variant picker → vqr-combo → discount callout (green dashed box) → **Recurpay widget** → buy buttons → 4 collapsible tabs → ymal-recommendations → sticky cart |
| Add to Cart works | Yes |
| Recurpay subscription tier selection works | Yes |
| Judge.me reviews carousel | Renders below buybox |
| UGC photos (4) | "Real Customers, Real Skin." heading + 4 customer testimonial cards |
| Compare table | "Sensitive Skin Set vs. The Drugstore Aisle" — 7 feature rows, green-highlighted Us column |
| "Don't fumble" CTA | Renders with Shop The Set button → scrolls to buybox |
| Founder block | Sean's existing quote |
| Free-from block | "What's NOT in either jar or bottle" with 8 bullets |
| Final CTA strip | Black background, white text, yellow button, "Shop The Set" → scrolls to buybox |
| FAQ accordion | 8 existing FAQs, click expands |
| Loox reviews | Render |
| No Liquid errors in browser console | Clean |
| Mobile (Chrome DevTools 375px) | All sections stack, hero CTA full-width, comparison table responsive (verify `landing-compare-table` renders mobile layout — schema doesn't expose mobile layout, theme handles internally) |

If any check fails, fix in place. Common issues likely to surface:
- Block setting key mismatch (e.g., `button_link` vs `button_url` in `rich-text`/`image-with-text` block schemas) — open the section's `.liquid` file and confirm the actual schema.
- Empty image fields rendering broken-image icons — that's expected; manifest captures these.

- [ ] **Step 4: Commit**

```bash
git add templates/product.landing-page-sensitive-skin-set-lander.json
git commit -m "feat(lander): add final dark CTA strip + complete section ordering"
```

---

## Task 6: Generate the image manifest

**Files:**
- Create: `/Users/seanfillmore/Code/Claude/data/landers/sensitive-skin-set-image-manifest.md`

**Goal:** Produce the explicit image deliverable Sean asked for. One document listing every image the lander needs, by section, with dimensions, alt text, and AI-generation prompts/notes.

- [ ] **Step 1: Walk the JSON template, find every empty image field**

```bash
cd /Users/seanfillmore/Code/realskincare-theme
grep -n '"image[^"]*": ""' templates/product.landing-page-sensitive-skin-set-lander.json
grep -n '"bg_image[^"]*"' templates/product.landing-page-sensitive-skin-set-lander.json
grep -n '"image_picker"' templates/product.landing-page-sensitive-skin-set-lander.json
```

Expected: a list of every empty image setting across the template.

- [ ] **Step 2: Create the manifest**

Create `/Users/seanfillmore/Code/Claude/data/landers/sensitive-skin-set-image-manifest.md` with this structure:

```markdown
# Sensitive Skin Set Lander — Image Manifest

Every image needed by `templates/product.landing-page-sensitive-skin-set-lander.json`. Drop the file in Shopify Files (Settings → Files → Upload), then update the corresponding setting in the template (or in Theme Editor on the live theme once the template goes live).

## Section: Hero (`hero-landing-section`)

### Hero background — desktop
- **Setting:** `bg_image_desktop`
- **Dimensions:** 2400 × 1200 (2x retina; min 1200×600 displayed)
- **Format:** WebP preferred; JPG acceptable
- **Alt:** "Sensitive Skin Moisturizing Set on a soft cream background"
- **Notes / generation prompt:** Clean editorial product photography. Sensitive Skin Set (lotion bottle + cream jar, both Pure Unscented) arranged at right third of frame. Background: soft cream-to-sage-green gradient (#eef3e8 → #faf7f0). Diffused natural daylight from upper left. Empty negative space at left half for headline text overlay. NO additional props, NO hands, NO models. Photo realistic. Studio quality.

### Hero background — mobile
- **Setting:** `bg_image_mobile`
- **Dimensions:** 750 × 1000 (vertical orientation)
- **Notes:** Same composition as desktop but vertical. Product centered vertically, top 40% reserved for headline overlay.

## Section: Why It Works (`landing-health-image`)

### Image 1
- **Setting:** `image_1`
- **Dimensions:** 800 × 800
- **Alt:** Already set: "Pure Unscented Body Lotion bottle"
- **Notes:** Studio shot of the lotion bottle on white seamless. No props.

### Image 2
- **Setting:** `image_2`
- **Dimensions:** 800 × 800
- **Alt:** Already set: "Pure Unscented Body Cream jar"
- **Notes:** Studio shot of the cream jar on white seamless. Open lid optional, showing cream texture.

### Image 3
- **Setting:** `image_3`
- **Dimensions:** 800 × 800
- **Alt:** Already set: "Sensitive Skin Set components together"
- **Notes:** Both products together, shot from above on a neutral linen surface. Soft daylight.

## Section: Stats Hero (`image-with-text`)

### Stats hero image
- **Setting:** `image`
- **Dimensions:** 1600 × 1600 (1:1; the section is wide-format)
- **Alt:** "Hand applying Pure Unscented Body Lotion"
- **Notes / generation prompt:** Photographic close-up of a hand (no model face, just hand and forearm) holding the Pure Unscented Body Lotion bottle. Soft natural daylight. Skin tone visible (any tone). Cream background. Aspirational/calm feeling — NOT clinical. NO text overlay; the section adds the stats as text.

## Section: Stats Row (`multicolumn`)
No images needed — stat cards are text-only.

## Section: Quality You Can Trust (`guarantees`)
Icons are preset SVGs — no images needed unless overriding with custom icons. (Default leaf/shield/heart/pin presets work.)

## Section: UGC Photos (`multicolumn` 4 customer cards)

### Customer photo 1 (@morgan.k)
- **Setting:** `image` on `ugc-1` block
- **Dimensions:** 800 × 800 square
- **Alt:** "Customer holding Pure Unscented Body Lotion in their bathroom"
- **Notes / generation prompt:** Phone-style UGC photo. Person from chest down (no face) holding lotion bottle in a bright bathroom. Casual, real, slightly imperfect lighting. NOT a studio shot — looks like an actual customer photo.

### Customer photo 2 (@derm_patient_diary)
- **Setting:** `image` on `ugc-2` block
- **Dimensions:** 800 × 800
- **Alt:** "Customer applying Pure Unscented Body Cream to their hand"
- **Notes:** UGC-style. Hand-and-forearm shot, scooping cream from open jar. Daylight from window. Shows the cream's actual color (faint red-orange from unrefined palm oil).

### Customer photo 3 (@sensitive.skin.life)
- **Setting:** `image` on `ugc-3` block
- **Dimensions:** 800 × 800
- **Alt:** "Both Sensitive Skin Set products on a bathroom counter"
- **Notes:** Casual bathroom counter photo. Both products visible. Personal touches — toothbrush, hand towel — make it feel real.

### Customer photo 4 (@dad_with_eczema)
- **Setting:** `image` on `ugc-4` block
- **Dimensions:** 800 × 800
- **Alt:** "Sensitive Skin Set with the free subscription bonuses"
- **Notes:** UGC photo showing the lotion + cream PLUS a Pure Unscented Lip Balm and Unscented Bar Soap (the subscription bonuses). On a kitchen / bathroom counter, casual.

## Section: Compare Table (`landing-compare-table`)

### "Us" column header image
- **Setting:** `us_image`
- **Dimensions:** 256 × 256 square (displayed at 64×64)
- **Alt:** Already set: "Sensitive Skin Set"
- **Notes:** Tight square crop of the Sensitive Skin Set hero shot. White or transparent background. The product itself fills 80% of the frame.

## Section: Don't Fumble CTA (`image-with-text`)

### "Don't fumble" image
- **Setting:** `image`
- **Dimensions:** 1600 × 1600 (1:1)
- **Alt:** "Sensitive Skin Moisturizing Set"
- **Notes / generation prompt:** Editorial flat-lay style product shot. Sensitive Skin Set on a peach / cream textured background (#fef3e8 paper or linen). Diagonal composition. Soft daylight. Aspirational. NOT clinical.

## Section: Founder Block (`founder-block`)
Already set: `shopify://shop_images/Coconut-About_a5199414-98ea-4656-b46e-3e10e2a6f27f.jpg`. No new image needed.

## Section: Free From Block (`free-from-block`)
Already set: `shopify://shop_images/coconut_oil.webp`. No new image needed.

## Summary

| Required new images | Count |
|---|---|
| Hero (desktop + mobile) | 2 |
| Why It Works (3 product shots) | 3 |
| Stats hero (1 lifestyle) | 1 |
| UGC photos (4 customer-style) | 4 |
| Compare table us-column thumbnail | 1 |
| Don't fumble CTA | 1 |
| **Total** | **12** |

All other images reuse assets already in `shopify://shop_images/`.

## Production order

1. Hero desktop + mobile (highest visual impact, top of fold)
2. Stats hero lifestyle photo (mid-page anchor)
3. Don't fumble CTA (high-converting CTA region)
4. Why It Works 3 product shots (can be sourced from existing product photography in the theme `assets/` folder if available — check first before generating)
5. UGC photos 4 (lowest priority — placeholder customer-text-only cards work for soft launch)
6. Compare table thumbnail (smallest, easy)
```

- [ ] **Step 3: Commit the manifest to the SEO Claude repo (NOT the theme repo)**

```bash
cd /Users/seanfillmore/Code/Claude
git add data/landers/sensitive-skin-set-image-manifest.md
git commit -m "docs(landers): add Sensitive Skin Set lander image manifest"
```

The manifest lives in the `Code/Claude` repo (it's project planning), not in `realskincare-theme` (which is just the theme code).

---

## Task 7: Push branch + open PR

**Files:** None — Git operations only.

- [ ] **Step 1: Push the theme branch**

```bash
cd /Users/seanfillmore/Code/realskincare-theme
git push -u origin feat/sensitive-skin-set-lander
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base feat/recurpay-swap --title "feat(lander): Sensitive Skin Set Gruns-style landing page" --body "$(cat <<'EOF'
## Summary

- New product template `templates/product.landing-page-sensitive-skin-set-lander.json` modeled after the Gruns landing page, adapted for the Sensitive Skin Moisturizing Set.
- Reuses existing `main` block list verbatim — Recurpay widget, Judge.me badge, vqr-combo, free-shipping callout, all 4 collapsible tabs, ymal-recommendations, sticky cart all intact.
- Adds 11 new sections around it: hero, why-it-works, stats hero, stats row, trust badges, UGC photos, comparison table, Don't fumble CTA, final dark CTA strip.
- All sections use existing theme section types — no new section files written.
- Image manifest delivered separately at [Code/Claude:data/landers/sensitive-skin-set-image-manifest.md](https://github.com/seanfillmore/seo-claude/blob/main/data/landers/sensitive-skin-set-image-manifest.md).

## Cutover

When ready to go live: in Shopify admin → Products → Sensitive Skin Moisturizing Set → Theme template → switch from `landing-page-sensitive-skin-set` to `landing-page-sensitive-skin-set-lander`.

Existing template stays in the codebase as fallback. One-click rollback by switching the assignment back.

## Test plan

- [ ] Preview at `/products/sensitive-skin-starter-set?view=landing-page-sensitive-skin-set-lander` renders without Liquid errors.
- [ ] All hero/Don't-fumble/final CTAs scroll to `#buy-box`.
- [ ] Recurpay subscription widget renders and updates price by frequency selection.
- [ ] Add to Cart works for both subscription and one-time purchase.
- [ ] Free-shipping discount callout renders ("FIRST SUBSCRIPTION ORDER: FREE LIP BALM + UNSCENTED BAR SOAP").
- [ ] All 4 collapsible tabs (Ingredients, Details, How to Use, Shipping & Returns) open.
- [ ] Mobile (Chrome DevTools 375px): all sections stack, no horizontal scroll, comparison table renders mobile-friendly.
- [ ] Image manifest reviewed; image generation/sourcing started in parallel.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Return PR URL**

Print the PR URL so Sean can review.

---

## Self-review notes

**Spec coverage:** Walked through each of the 19 sections in the spec.
- Sections 2, 4-19 → covered by Tasks 1-5.
- Image manifest deliverable → Task 6.
- Section 1 (sticky nav) → intentionally deferred. Schema requires a Shopify navigation menu that doesn't exist yet, so it's optional Phase 2 work captured in the spec's "Risks & open issues" section.
- Section 3 (social proof / "Trusted by 10,000+" strip) → intentionally dropped. The rating shown in the hero ("Rated 4.9 by Real Customers") plus the trust badges row (Section 8) cover the same conversion role. Adding a separate strip would be redundant and add visual clutter without lifting conversion. Documented here as a deliberate omission, not a gap.

**Schema risks acknowledged inline in tasks:**
- `guarantees` block setting names (`icon`, `title`, `text`) are typical Dawn — Task 3 Step 4 has a caveat to verify on first preview.
- `rich-text` and `image-with-text` button block setting names (`button_link` vs `button_url`) — Task 5 Step 3 has a fix-on-discovery caveat.
- `landing-compare-table` does NOT support per-competitor columns (it's a binary Us/Others) — called out explicitly in Task 4 Step 2.

**Out-of-scope reminder:** This plan does NOT generate or source images, run the live cutover, or wire analytics. Those are explicit out-of-scope items in the spec.
