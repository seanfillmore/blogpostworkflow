# PDP Theme Refactor (Toothpaste Cluster) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. **This plan operates in two git repos** — most steps run in the sibling repo `~/Code/realskincare-theme/` (Shopify theme, separate origin). Each task explicitly states its working directory. The plan document itself lives in this repo (seo-claude) for cross-reference with Plan 1, Plan 2, and the spec.

**Goal:** Restructure the toothpaste cluster template (`templates/product.landing-page-toothpaste.json`) per spec Layer 2, update the 3 section .liquid files to read product metafields as optional overrides, define 5 metafields in Shopify admin, push to a draft theme and visually verify. **Template ships with publish-quality content** lifted from a fresh cluster-mode agent run (per Sean's call: pre-seed rather than stubs). Plan 5's scope shrinks to per-SKU product-mode content + live verification.

**Architecture:** Cluster template defaults rendered from the .json template's block settings; per-SKU overrides via `product.metafields.custom.*`. Section liquid files check the metafield and fall back to template defaults when absent. Standard Shopify Liquid + JSON template pattern.

**Tech Stack:** Shopify Liquid, JSON templates, Shopify CLI 3.94.3, Shopify admin (Settings → Custom data → Products) for metafield schema definition.

**Spec:** [`docs/superpowers/specs/2026-05-02-pdp-builder-design.md`](../specs/2026-05-02-pdp-builder-design.md) (Layer 2 + Phase 2)

**Foundation reference:** [`data/brand/voice-and-pov.md`](../../../data/brand/voice-and-pov.md), [`data/brand/cluster-povs.md`](../../../data/brand/cluster-povs.md). Block content is lifted from a fresh `node agents/pdp-builder/index.js cluster toothpaste` run (Task 4 Step 0).

**Out of scope (separate plans):**
- Other 6 cluster templates — Plan 6
- Dashboard `/pdp-review` UI — Plan 4 (parallel)
- Live publish pipeline (`--publish-approved`) — Plan 5
- Per-SKU product-mode content + metafield publish — Plan 5
- Live theme promotion (draft → published) — Plan 5

---

## Confirmed parameters

1. **Repository.** Theme work in `~/Code/realskincare-theme/` (already initialized, branch `main`, single commit `9842f51` — initial pull from live theme). Plan branch will be `feat/toothpaste-cluster-template`.
2. **Pilot SKU.** `coconut-oil-toothpaste` (3 variants: Fresh Mint, Cinnamon Spice, All Natural).
3. **Content source.** Fresh cluster-mode agent run against post-merge main foundation (~$0.30 in Claude API). Embedded in template block settings as the cluster default. Plan 5 regenerates only if foundation changes warrant it.
4. **Draft theme strategy.** Push all changes to a brand-new draft theme (not the live theme) via `shopify theme push --unpublished --json`. Visual verification on the draft theme's preview URL before any merge to live.

---

## File Structure

```
~/Code/realskincare-theme/                                    (separate sibling repo)
├── sections/
│   ├── main-product.liquid                                   MODIFY: add free_from metafield read
│   ├── collapsible-content.liquid                            MODIFY: append faq_additional metafield items
│   └── image-with-text.liquid                                MODIFY: optional hero_ingredients_override read
└── templates/
    └── product.landing-page-toothpaste.json                  REWRITE: block sequence per spec Layer 2

(In Shopify admin, NOT files)
Settings → Custom data → Products → Definitions:
  custom.hero_ingredients_override   (json, list, optional)
  custom.faq_additional              (json, list, optional)
  custom.free_from                   (single_line_text, list, optional)
  custom.sensitive_skin_notes        (multi_line_text, optional)
  custom.scent_notes                 (json, optional)
```

No files in seo-claude are modified by this plan. The plan document itself was committed at the start of this branch in seo-claude — that's the only seo-claude touch.

---

## Spec Layer 2 — block sequence to implement

For reference. Task 4 implements this exact sequence in `templates/product.landing-page-toothpaste.json`.

```
1.  main-product           (existing, unchanged — buybox + benefit bullets)
2.  rich-text              hook line (1-2 sentences)
3.  image-with-text        ingredient card 1 (image + heading + ~50-word "right vs cheap" story)
4.  image-with-text        ingredient card 2
5.  image-with-text        ingredient card 3
6.  image-with-text        mechanism explainer ("How this actually protects sensitive teeth", 80-100 words)
7.  image-with-text        founder block ("From Sean", 60-80 words family-voice)
8.  image-with-text        what's NOT in it (free-from grid: No fluoride, No SLS, No glycerin, No titanium dioxide, etc.)
9.  quotes                 1 customer testimonial (sensitive-skin-specific where possible)
10. logo-list              certification badges (Sensitive-skin-tested, Aluminum-free, Cold-pressed virgin, Wildcrafted myrrh)
11. collapsible-content    7-block FAQ accordion (cluster default; SKU appends via metafield)
12. guarantees             4 guarantees (already in template, content needs update)
13. product-recommendations  cross-sell (already in template)
```

Total ~700-850 words of marketing prose excluding FAQ + reviews + nav. Matches spec target.

---

## Task 0: Pre-flight

**Working directory:** `~/Code/realskincare-theme/`

- [ ] **Step 1: Confirm theme repo state**

```bash
cd ~/Code/realskincare-theme
git status                # should be clean
git log --oneline -5      # should show the initial pull commit
```

- [ ] **Step 2: Confirm Shopify CLI auth**

```bash
shopify version                                      # 3.94.3+
shopify theme list --store realskincare.myshopify.com  # should list themes; will prompt login if not authenticated
```

If the list command fails with auth, run `shopify auth logout` then re-run — CLI will open browser to authenticate.

- [ ] **Step 3: Create the feature branch**

```bash
git checkout -b feat/toothpaste-cluster-template
```

- [ ] **Step 4: Capture the current template for diffing later**

```bash
cp templates/product.landing-page-toothpaste.json /tmp/toothpaste-template-original.json
```

(Reference only — keeps the body-lotion-clone state visible for comparison during the rewrite.)

---

## Task 1: Update `sections/main-product.liquid` — read `product.metafields.custom.free_from`

**Working directory:** `~/Code/realskincare-theme/`

**Files:**
- Modify: `sections/main-product.liquid` (already 800+ lines; we only add to the existing benefit-bullets / "what's NOT in it" rendering)

**Approach.** The current main-product section renders product highlights from block settings only. Add an optional metafield read so per-SKU `custom.free_from` (a `list.single_line_text` metafield) renders alongside or replaces the template's free-from list. Spec says "Override the cluster template's 'what's NOT in it' list when this SKU has different exclusions" — so per-SKU metafield REPLACES the template default for that SKU, doesn't merge.

- [ ] **Step 1: Find the existing free-from / highlights rendering location**

```bash
grep -n "highlight\|features\|benefit" sections/main-product.liquid | head -20
```

The current template renders `block.settings` for "text" type blocks — the body-lotion clone's "100% Organic / 100% Cold Pressed" etc. comes from these. Adding a metafield read here means: when `product.metafields.custom.free_from` exists, render its items instead of the block-driven default.

Search for the block-rendering loop (typically a `{%- case block.type -%}` block).

- [ ] **Step 2: Add the metafield-aware rendering**

Inside the `{% case block.type %}` switch, locate the `when 'text'` branch (or whichever block type renders the highlights/free-from list). Above the existing rendering, add a check:

```liquid
{%- comment -%}
  PDP Builder cluster template support: if product has custom.free_from metafield,
  render it as the free-from list. Falls back to template-default block content otherwise.
  (Per docs/superpowers/specs/2026-05-02-pdp-builder-design.md Layer 2.)
{%- endcomment -%}
{%- if product.metafields.custom.free_from.value != blank and block.settings.is_free_from_list -%}
  <ul class="rsc-free-from">
    {%- for item in product.metafields.custom.free_from.value -%}
      <li>{{ item }}</li>
    {%- endfor -%}
  </ul>
{%- else -%}
  {%- comment -%} Existing block.settings.text rendering goes here {%- endcomment -%}
  {{ block.settings.text }}
{%- endif -%}
```

The `block.settings.is_free_from_list` flag is a new boolean we'll add to the `text` block schema in the same file's schema section, so cluster-template authors can mark which `text` block IS the free-from list. Add to the schema:

```json
{
  "type": "checkbox",
  "id": "is_free_from_list",
  "label": "This text block is the free-from list (renders product.metafields.custom.free_from when present)",
  "default": false
}
```

- [ ] **Step 3: Local syntax check**

```bash
shopify theme check sections/main-product.liquid 2>&1 | head -20
```

Expected: no new errors introduced. Existing errors in the file (if any) are out of scope.

- [ ] **Step 4: Commit**

```bash
git add sections/main-product.liquid
git commit -m "feat(pdp-template): main-product reads custom.free_from metafield

Per spec Layer 2: when a product has product.metafields.custom.free_from
(list of single_line_text strings), render those instead of the block's
default text. Backward-compatible — existing blocks without the new
'is_free_from_list' setting render unchanged."
```

---

## Task 2: Update `sections/collapsible-content.liquid` — append `product.metafields.custom.faq_additional`

**Working directory:** `~/Code/realskincare-theme/`

**Files:**
- Modify: `sections/collapsible-content.liquid`

**Approach.** Per spec: "render template's default FAQ blocks PLUS `product.metafields.custom.faq_additional` items." This is APPEND, not replace — the cluster's 7-question default FAQ stays, and per-SKU adds extras.

- [ ] **Step 1: Find the block-rendering loop**

```bash
grep -n "for block\|block.type\|collapsible" sections/collapsible-content.liquid | head -10
```

- [ ] **Step 2: After the existing block loop, add the metafield-driven items**

Insert AFTER the closing `{%- endfor -%}` of the existing `{%- for block in section.blocks -%}` loop. The metafield is a JSON list of `{question, answer}` objects.

```liquid
{%- comment -%}
  PDP Builder cluster template support: append per-SKU FAQ items from
  product.metafields.custom.faq_additional (JSON list of {question, answer}).
  (Per docs/superpowers/specs/2026-05-02-pdp-builder-design.md Layer 2.)
{%- endcomment -%}
{%- if product.metafields.custom.faq_additional.value != blank -%}
  {%- for item in product.metafields.custom.faq_additional.value -%}
    <details class="collapsible-row collapsible-row--from-metafield">
      <summary>{{ item.question }}</summary>
      <div class="collapsible-row__content">{{ item.answer }}</div>
    </details>
  {%- endfor -%}
{%- endif -%}
```

(Match the actual existing collapsible-row markup in the file — the example above is illustrative; use whatever wrapper element + class the existing blocks use, just rendered from the metafield instead of `block.settings`.)

- [ ] **Step 3: Local syntax check**

```bash
shopify theme check sections/collapsible-content.liquid 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add sections/collapsible-content.liquid
git commit -m "feat(pdp-template): collapsible-content appends faq_additional metafield items

Per spec Layer 2: cluster template's default FAQ blocks render unchanged;
SKU-specific extras appended via product.metafields.custom.faq_additional
(JSON list of {question, answer})."
```

---

## Task 3: Update `sections/image-with-text.liquid` — optional `hero_ingredients_override` read

**Working directory:** `~/Code/realskincare-theme/`

**Files:**
- Modify: `sections/image-with-text.liquid`

**Approach.** Spec: "When in a cluster template's 'ingredient card' position, prefer `product.metafields.custom.hero_ingredients_override` items if present, otherwise template defaults." This is REPLACE for the per-SKU case — the template renders 3 cluster-default ingredient cards by default, but if a SKU has its own `hero_ingredients_override`, those replace the cards.

The complication: `image-with-text` is a generic section used for many things (mechanism block, founder block, ingredient cards, free-from). The metafield should only override when this specific section instance is the "ingredient cards" set. We mark that via a new section setting `is_hero_ingredient_position` (boolean).

- [ ] **Step 1: Add the section setting to the schema**

In the `{% schema %}` block at the bottom of `sections/image-with-text.liquid`, add to the `settings` array:

```json
{
  "type": "checkbox",
  "id": "is_hero_ingredient_position",
  "label": "This section renders the cluster's hero ingredient cards (override-able via product.metafields.custom.hero_ingredients_override)",
  "default": false
}
```

- [ ] **Step 2: Add the metafield-aware rendering**

At the top of the section's main render area (above the existing block-rendering loop), add:

```liquid
{%- comment -%}
  PDP Builder cluster template support: if section.settings.is_hero_ingredient_position
  is true AND product has custom.hero_ingredients_override metafield,
  render those items in place of the section's default ingredient-card blocks.
  (Per docs/superpowers/specs/2026-05-02-pdp-builder-design.md Layer 2.)
  Each item shape: {name, role, mechanism, sourcing, why_we_chose_it, image_url}.
{%- endcomment -%}
{%- liquid
  assign render_metafield_overrides = false
  if section.settings.is_hero_ingredient_position and product.metafields.custom.hero_ingredients_override.value != blank
    assign render_metafield_overrides = true
  endif
-%}

{%- if render_metafield_overrides -%}
  <div class="image-with-text image-with-text--hero-ingredients-override">
    {%- for ingredient in product.metafields.custom.hero_ingredients_override.value -%}
      <div class="image-with-text__media-item">
        {%- if ingredient.image_url != blank -%}
          <img src="{{ ingredient.image_url }}" alt="{{ ingredient.name }}" loading="lazy">
        {%- endif -%}
        <h3 class="image-with-text__heading">{{ ingredient.name }}</h3>
        <p class="image-with-text__subheading">{{ ingredient.role }}</p>
        <p class="image-with-text__text">{{ ingredient.mechanism }}</p>
      </div>
    {%- endfor -%}
  </div>
{%- else -%}
  {%- comment -%} Existing section block-rendering goes here unchanged {%- endcomment -%}
  ...
{%- endif -%}
```

(Wrap the EXISTING render path in the `{%- else -%}` branch — don't duplicate or replace it.)

- [ ] **Step 3: Local syntax check**

```bash
shopify theme check sections/image-with-text.liquid 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add sections/image-with-text.liquid
git commit -m "feat(pdp-template): image-with-text optionally renders hero_ingredients_override

Per spec Layer 2: when section.settings.is_hero_ingredient_position is
true AND product has custom.hero_ingredients_override metafield, the
section renders that ingredient list in place of its block defaults.
Backward-compatible — sections without the new setting render unchanged."
```

---

## Task 4: Restructure `templates/product.landing-page-toothpaste.json` (with real content)

**Working directories:**
- `/Users/seanfillmore/Code/Claude` for Step 0 (run agent against post-merge foundation)
- `~/Code/realskincare-theme/` for Steps 1-3 (template work)

**Files:**
- Rewrite: `~/Code/realskincare-theme/templates/product.landing-page-toothpaste.json`
- Generated (read-only input): `/Users/seanfillmore/Code/Claude/data/performance-queue/cluster-toothpaste.json`

**Approach.** Replace the body-lotion-clone block sequence with the spec Layer 2 sequence, populating each block's settings with content lifted from a fresh cluster-mode agent run. The agent run is reproducible (foundation is committed in main), so anyone executing this plan generates the same shape of content; the prose itself will vary because the model is non-deterministic. That's fine — visually verify the run produces on-voice content before lifting it; re-run if a particular run is weak.

Per Sean's call: pre-seed rather than stubs. The template ships with publish-quality cluster-default content from day one.

- [ ] **Step 0: Run cluster-mode agent against post-merge foundation**

```bash
cd /Users/seanfillmore/Code/Claude
node agents/pdp-builder/index.js cluster toothpaste
```

Expected: `Status: pending` (the foundation in main passes all validators based on PR #193's smoke test).

If the run produces `needs_rework`, address the validation failures before proceeding. Common causes: model produced an off-spec ingredient name; a brand-term false positive; word-count drift. Re-run the agent (it's non-deterministic; a second attempt often passes). If the issue is structural (a real validator gap surfaced by new content), open a separate fix PR before continuing Plan 3.

If the run is `pending` but the prose feels weak (e.g., a flat hookLine, generic FAQs), re-run for a better generation. Read the queue item `data/performance-queue/cluster-toothpaste.json` end-to-end before lifting.

- [ ] **Step 1: Build the new template JSON**

Read `data/performance-queue/cluster-toothpaste.json` and lift these fields into the corresponding template blocks:

| Template block (in spec Layer 2 order) | Source from queue item `proposed.*` | Notes |
|---|---|---|
| 2 rich-text hook | `hookLine` | 1-2 sentences |
| 3 ingredient card 1 | `ingredientCards[0]` | name → block heading, role → subheading, story → body |
| 4 ingredient card 2 | `ingredientCards[1]` | same shape |
| 5 ingredient card 3 | `ingredientCards[2]` | same shape |
| 6 mechanism block | `mechanismBlock` | ~80-100 words; heading "How this actually protects sensitive teeth and gums" |
| 7 founder block | `founderBlock` | 60-80 words family-voice; signed "— Sean"; heading "From Sean" |
| 8 free-from grid | `freeFrom[]` | 4-6 short callouts; heading "What's NOT in this tube" |
| 9 testimonial | (hand-pick from `data/brand/_research/judgeme-coconut-oil-toothpaste.md`) | Agent doesn't generate testimonials; pick a 5-star Judge.me quote that hits the sensitive-skin or no-foam beats. |
| 10 badges (logo-list) | `badges[]` | 4 strings, render as text labels (since we don't have logo images for "Sensitive-skin-tested" etc. yet) |
| 11 FAQ (7 items) | `faq[]` | each `{question, answer}` → one collapsible_row block |
| 12 guarantees | `guarantees[]` | 4 strings, one per existing guarantee block |

Block structure rules:
- The section that renders ingredient cards 1-3 has `is_hero_ingredient_position: true` in its section settings (Task 3's new setting). Ingredient cards 1-3 should be CHILDREN of a single image-with-text section, not three separate sections.
- The block in main-product that holds the free-from list gets `is_free_from_list: true` (Task 1's new block setting).
- Block IDs (UUIDs): generate fresh ones for new blocks; preserve any UUIDs on blocks that already exist and are kept (main-product, judgeme_section_review_widget, product-recommendations).
- Remove the body-lotion-clone blocks entirely (don't keep them dormant).

- [ ] **Step 2: Validate the JSON parses**

Shopify .json templates allow `/* */` comments at the top. Strip them before parsing for validation:

```bash
cd ~/Code/realskincare-theme
python3 -c "
import json, re
with open('templates/product.landing-page-toothpaste.json') as f:
    raw = f.read()
cleaned = re.sub(r'/\*.*?\*/', '', raw, flags=re.DOTALL)
d = json.loads(cleaned)
print('OK:', len(d.get('sections', {})), 'sections')
"
```

Expected: `OK: 13 sections` (or close, depending on the existing meta-sections like `judgeme_section_review_widget_f881` you choose to keep).

- [ ] **Step 3: Commit (in theme repo)**

```bash
cd ~/Code/realskincare-theme
git add templates/product.landing-page-toothpaste.json
git commit -m "feat(pdp-template): restructure toothpaste template per spec Layer 2

Replaces body-lotion-clone block sequence with the spec's 13-section
sequence: hook → 3 ingredient cards → mechanism → founder → free-from
→ testimonial → badges → FAQ (7) → guarantees → recommendations.

Block content lifted from a fresh agents/pdp-builder cluster-mode
run against the post-PR-#193 foundation. Template ships with
publish-quality cluster-default content (per the choice to pre-seed
rather than stub).

Section/block settings (is_hero_ingredient_position, is_free_from_list)
support per-SKU metafield overrides per the metafield schema in admin
(Task 5)."
```

---

## Task 5: Define metafield schema in Shopify admin

**Working directory:** N/A (Shopify admin UI — no local files)

**This is a manual step in the Shopify admin.** The Shopify CLI doesn't manage metafield schema; it must be defined in Settings → Custom data → Products before any product can have these metafields populated.

- [ ] **Step 1: Open Settings → Custom data → Products**

In Shopify admin: Settings → Custom data → Products → Add definition.

- [ ] **Step 2: Define each of the 5 metafields**

| Namespace.key | Type | Notes |
|---|---|---|
| `custom.hero_ingredients_override` | JSON (single) | Per-SKU ingredient cards: list of `{name, role, mechanism, sourcing, why_we_chose_it, image_url}`. |
| `custom.faq_additional` | JSON (single) | Per-SKU FAQ items appended to cluster default: list of `{question, answer}`. |
| `custom.free_from` | Text → List of single-line text | Per-SKU free-from override (cluster default replaced). |
| `custom.sensitive_skin_notes` | Text → Multi-line | Per-SKU notes for reactive-skin customers. |
| `custom.scent_notes` | JSON (single) | Per-variant scent profile copy (when applicable). |

For each: set namespace to `custom`, key as listed, leave validation rules unset (the agent's validators handle content correctness), set the description to mirror the spec's "Purpose" column.

- [ ] **Step 3: Verify the metafields appear on the toothpaste product page in admin**

Go to Products → "Real Skin Care Coconut Toothpaste" → scroll to Metafields section. All 5 should be visible (empty values — they'll be filled in Plan 5 by the agent's `--publish-approved` step).

- [ ] **Step 4: Document the definitions for the team**

(No commit — this step has no file changes. Note in the PR description that metafields were defined manually in admin. Capture screenshots if helpful.)

---

## Task 6: Push to draft theme + visual verification

**Working directory:** `~/Code/realskincare-theme/`

- [ ] **Step 1: Push the branch to a brand-new unpublished (draft) theme**

```bash
shopify theme push --unpublished --json \
  --store realskincare.myshopify.com 2>&1 | tee /tmp/theme-push.log
tail -20 /tmp/theme-push.log
```

Look for the line containing the new theme's preview URL — it'll be something like `https://realskincare.myshopify.com/?preview_theme_id=NNNNNNNNN`.

- [ ] **Step 2: Set the toothpaste product's `template_suffix` so it uses our restructured template on the draft theme**

(This is needed because the draft theme contains both the old body-lotion-default and the new toothpaste template. The product needs `template_suffix=landing-page-toothpaste` to render the new one.)

The toothpaste product probably already has this suffix set from previous theme usage (the body-lotion-clone template was already named `product.landing-page-toothpaste.json` and the product was likely already pointing at it). Verify in admin: Products → Real Skin Care Coconut Toothpaste → Theme template → should be `landing-page-toothpaste`. If not, set it and save.

- [ ] **Step 3: Visit the preview URL on desktop AND mobile**

Read the page like a customer. Check:
- All 13 sections render (no missing blocks, no Liquid errors)
- Stub text appears in the right places (hook → 3 cards → mechanism → founder → free-from → testimonial → badges → FAQ → guarantees)
- The `is_hero_ingredient_position` and `is_free_from_list` settings render correctly (the metafield-aware sections fall back to template defaults since metafields are unpopulated)
- Mobile layout is intact — no overflow, no broken images

- [ ] **Step 4: Capture issues**

Anything wrong (sections not rendering, stub text in wrong place, mobile breakage) → return to the relevant Task (1-4) and fix. Re-push the draft theme and re-verify.

- [ ] **Step 5: When clean, document the preview URL in the PR description.**

(No commit — this step is the test gate.)

---

## Task 7: Push branch + open PR

**Working directory:** `~/Code/realskincare-theme/`

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/toothpaste-cluster-template
```

- [ ] **Step 2: Open the PR (against `main` of the theme repo)**

```bash
gh pr create --base main --head feat/toothpaste-cluster-template \
  --title "feat(pdp-template): toothpaste cluster template restructure (Plan 3)" \
  --body "$(cat <<'EOF'
## Summary

Plan 3 of 6 from the PDP redesign initiative. Restructures the toothpaste cluster template per spec Layer 2 (in seo-claude: \`docs/superpowers/specs/2026-05-02-pdp-builder-design.md\`). Updates 3 section .liquid files to read product metafields as optional per-SKU overrides. **Template ships with publish-quality cluster-default content** lifted from a fresh \`pdp-builder\` cluster-mode run (per the pre-seed-not-stubs decision).

## What's in
- \`templates/product.landing-page-toothpaste.json\` — restructured from body-lotion-clone to the spec's 13-section sequence (hook → 3 ingredient cards → mechanism → founder → free-from → testimonial → badges → FAQ → guarantees → cross-sell)
- \`sections/main-product.liquid\` — reads \`product.metafields.custom.free_from\` when block has \`is_free_from_list\` setting
- \`sections/collapsible-content.liquid\` — appends items from \`product.metafields.custom.faq_additional\`
- \`sections/image-with-text.liquid\` — renders \`product.metafields.custom.hero_ingredients_override\` when section has \`is_hero_ingredient_position\` setting

## What's also done (manual in admin, not in this PR)
- 5 metafields defined in Settings → Custom data → Products: \`custom.hero_ingredients_override\`, \`custom.faq_additional\`, \`custom.free_from\`, \`custom.sensitive_skin_notes\`, \`custom.scent_notes\`

## What's not in (separate plans)
- Per-SKU product-mode content + metafield publish — Plan 5
- Live theme promotion (draft → published) — Plan 5
- Other 6 cluster templates — Plan 6
- Dashboard \`/pdp-review\` review surface — Plan 4 (parallel)

## Test plan
- [x] \`shopify theme check\` reports no new errors
- [x] Pushed to unpublished draft theme; preview URL: <PASTE FROM TASK 6 STEP 1>
- [x] Visual verification on desktop + mobile — all 13 sections render correctly with stubs
- [ ] After merge, do NOT promote the new theme to live yet. Plan 5 will run \`--publish-approved\` to fill the blocks with real content first; only then promote.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Note the PR URL** — record in this plan's bottom section so future plans can reference it.

---

## Verification before merge

- [ ] All 4 code commits + 1 plan commit on the branch (5 commits total)
- [ ] `shopify theme check` reports no new errors introduced
- [ ] Draft theme renders correctly on desktop AND mobile
- [ ] All 5 metafields defined in Shopify admin (manual step, screenshot evidence in PR)
- [ ] Toothpaste product's `template_suffix` is `landing-page-toothpaste` (already true from prior body-lotion-clone usage)
- [ ] PR opened against the theme repo's `main`, not the live branch — merge does NOT auto-promote to live theme

---

## Self-review checklist

- [x] Spec Layer 2 deliverables — all 4 file changes covered (3 sections + 1 template)
- [x] Spec Layer 2 metafield schema — 5 metafields documented for admin
- [x] Spec Phase 2 testing — draft theme push + visual verification covered
- [x] Block content lifted from fresh agent run against post-merge foundation (publish-quality, not stubs)
- [x] All sections render correctly when metafields are absent (backward-compatibility for non-toothpaste products on these sections)
- [x] Plan does not promote draft theme to live — that's Plan 5's job after content is published

---

## PR reference (fill in after Task 7)

PR #__ → write the number into this section after PR is opened.
