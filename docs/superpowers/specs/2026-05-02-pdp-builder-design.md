# PDP Builder — Design Spec

**Date:** 2026-05-02
**Status:** Draft for review
**Replaces:** Default mode of `agents/product-optimizer/index.js`
**Pilot:** Toothpaste cluster (single SKU: `coconut-oil-toothpaste`)

---

## Problem

Real Skin Care has raised prices and is positioning as a premium brand. The current product-optimizer takes the top GSC query for a URL and asks Claude to rewrite the product copy around it. Even after a series of fixes today (smart selector, brand/competitor/generic filters, DataForSEO fallback), the output is keyword-anchored prose that reads as mass-market — not the kind of copy that closes a sale at premium prices.

Three structural failures with the current approach:

1. **Wrong primitive.** "One keyword, rewrite around it" is the wrong unit. Premium PDPs are built from a curated foundation (brand voice, ingredient stories, sensitive-skin authority) and *assemble* per-product copy from that foundation — they don't extract a keyword and pad it.
2. **Wrong layer.** The agent writes into `body_html` and `global.title_tag`, ignoring the theme's existing structure. Real Skin Care's Shopify theme has 7 cluster-specific landing-page templates with FAQ accordions, ingredient story blocks, badges, guarantees, and cross-sell — all unused. All 12 active products sit on the default template.
3. **Wrong workflow.** Default mode auto-publishes (`--apply`) directly to live SERP-impacting copy. No human review. Premium copy must be reviewed.

## Outcome we want

- Product titles that win the SERP click without keyword stuffing.
- Descriptions that close the sale at premium prices, structured as proper PDP sections (not a wall of body_html).
- A repeatable design pattern for both, grounded in industry research and our brand POV.
- Sensitive-skin authority threaded through every cluster.
- "We chose what's right, not what's cheap" as the ingredient-integrity narrative.
- Human review on every output. Nothing auto-publishes.

## Non-goals (explicitly out of scope for this spec)

- Cut and Scrape, Sensitive Skin Set, Two-Step Set, Foam Soap Bundle. These will get bespoke landing pages later.
- Changes to `--from-gsc`, `--optimize-titles`, `--pages-from-gsc`, `--expand-faq`, or `--publish-approved` modes of the existing optimizer. Default mode is what's being replaced.
- Photography commissioning. The user will source imagery once template structure is built.
- A/B testing infrastructure. Add later if we want it.

---

## Voice anchor

**Clinical-confident, accessible.** Mechanism-forward; we explain *why* ingredients work, not just that they do. Authority-driven without jargon. Reads like a trusted dermatologist explaining the science clearly. Reference points: Risewell's clinical clarity, but warmer; Primally Pure's premium polish, but with more substance. Never Tom's of Maine's feature-list cadence; never bro/playful; never aspirational fluff.

**Positioning hooks** (every PDP should ladder up to one):

1. *Made for reactive skin that other brands trigger.* Sensitive-skin authority is the primary positioning.
2. *Each ingredient was selected by what it does, not what it costs.* Ingredient-integrity narrative.
3. *Here's the science, plainly explained.* Trust through clarity, not credentialism.

---

## Architecture

Four layers, each independently buildable and refreshable.

### Layer 1 — Foundation (`data/brand/`)

Curated source-of-truth content. Version-controlled. Drives every agent draft.

| File | Purpose |
|---|---|
| `voice-and-pov.md` | Master voice doc. ~1500 words. Tone, "we say / we don't say," sensitive-skin framing, ingredient-integrity narrative. Used as system prompt for every draft. |
| `cluster-povs.md` | One paragraph per cluster (deodorant, toothpaste, body cream, body lotion, bar soap, foaming soap, lip balm). Worldview for that category. |
| `ingredient-stories.json` | Structured stories for 10-12 hero ingredients. Per ingredient: `{name, role, mechanism, sourcing, why_we_chose_it, what_cheap_alternatives_look_like, citations}`. The "right vs cheap" comparison is built into the schema. |
| `comparison-framework.md` | How we describe ourselves vs. mass-market without naming names. Covers SLS / aluminum / fluoride / synthetic-fragrance / preservative axes. |
| `founder-narrative.md` | "About RSC" content + a shorter "From Sean" snippet for cluster templates. |

**Foundation is the gate.** Nothing in Layers 2-4 ships without the relevant foundation content reviewed and approved.

The agent draftss foundation files from briefs you provide; you refine. The agent never publishes foundation drafts directly — they always go through human review.

### Layer 2 — Theme structure (Shopify CLI workflow in `~/Code/realskincare-theme/`)

The Liquid templates and metafield schema. Lives in a separate sibling repo, not in seo-claude.

**Restructure each cluster template's content blocks intentionally.** Today every cluster template is a body-lotion clone with 6 generic `image-with-text` blocks. Replace with a defined section sequence:

1. `main-product` (existing — buybox + benefit bullets)
2. `rich-text` — hook line (1-2 sentences setting the page's worldview)
3. `image-with-text × 3` — three hero ingredient cards. Each card: image + heading + ~50-word "right vs cheap" story.
4. `image-with-text × 1` — mechanism explainer ("How [product] actually protects sensitive skin"). 80-100 words.
5. `image-with-text × 1` — founder block. Sean's voice on why this product exists. 60-80 words.
6. `image-with-text × 1` — "What's NOT in it" block. Grid of 4-6 callouts (no aluminum / no SLS / no synthetic fragrance / etc.).
7. `quotes × 1` — 1-2 customer testimonials (specific to sensitive-skin reactions where possible).
8. `logo-list` — certification badges (Vegan / Cruelty-Free / Made in USA / etc.).
9. `collapsible-content` — 7-block FAQ accordion. Cluster-default questions; SKU can override via metafield.
10. `guarantees` — 30-day MBG / shipping / clean ingredients / handcrafted.
11. `product-recommendations` — "Complete your routine" cross-sell.

Total: ~700-850 words of marketing prose excluding FAQ + reviews + nav. Matches the Risewell / Each & Every / Davids sweet spot from competitor research.

**Define metafield schema for product-level overrides.** Cluster templates render evergreen content; per-product metafields override or extend where SKU-specific data matters:

| Namespace.key | Type | Purpose |
|---|---|---|
| `custom.hero_ingredients_override` | json | If present, replaces the cluster template's default 3 ingredient cards with this product-specific set. Each: `{name, role, mechanism, sourcing, why_we_chose_it, image_url}`. |
| `custom.faq_additional` | json | List of extra FAQ Q&A pairs appended to the cluster default FAQ. For SKU-specific questions (variant scent, sensitive-skin notes, etc.). |
| `custom.free_from` | list.single_line_text | Override the cluster template's "what's NOT in it" list when this SKU has different exclusions. |
| `custom.sensitive_skin_notes` | multi_line_text | Specific notes for reactive-skin customers (ingredients to consider, comparable prior reactions). |
| `custom.scent_notes` | json | For variant SKUs: per-variant copy describing scent profile. |

All optional. Empty falls back to cluster template defaults.

**Update the relevant section files to read product metafields:**

- `sections/collapsible-content.liquid` — render template's default FAQ blocks PLUS `product.metafields.custom.faq_additional` items.
- `sections/image-with-text.liquid` — when in a cluster template's "ingredient card" position, prefer `product.metafields.custom.hero_ingredients_override` items if present, otherwise template defaults.
- `sections/main-product.liquid` — render `product.metafields.custom.free_from` (overriding template's free-from list when set).

These Liquid changes live in `~/Code/realskincare-theme/`, push via `shopify theme push`. Branch-based deploy through Shopify's GitHub integration recommended.

### Layer 3 — Agent (`agents/pdp-builder/`)

A new agent that replaces the default mode of `agents/product-optimizer/index.js`. Two operating modes.

**Cluster mode** (`node agents/pdp-builder/index.js cluster <cluster-name>`)

Generates the JSON content for a cluster template's content blocks: 7 FAQ Q&As, 3 hero ingredient cards, 1 mechanism explainer, 1 founder block, "what's NOT in it" callouts, badge labels, guarantee text, hook line, testimonial selection.

Inputs: the Foundation object + the cluster name. Outputs: a queue item with the proposed template JSON diff. Runs once per cluster on initial template build, then on annual refresh or when foundation changes.

**Product mode** (`node agents/pdp-builder/index.js product <slug>`)

Generates SEO title (`global.title_tag`), meta description (`global.description_tag`), `body_html` (~150 words: hook + benefit bullets), and per-product metafield overrides where SKU-specific data warrants them.

Inputs: the Foundation + the cluster context (cluster POV, default ingredient cards, default FAQs) + the product's actual data (`config/ingredients.json` entry, current Shopify product fields, GSC long-tail queries for SEO title/meta only). Outputs: a queue item with the proposed product changes.

**Workflow flag**: `--queue-only` is the default. `--apply` is removed from the new agent. Items reach Shopify only via `--publish-approved` after dashboard review.

**Component breakdown:**

```
agents/pdp-builder/
├── index.js                       CLI entry, mode dispatcher
└── lib/
    ├── load-foundation.js         Pure function. Reads data/brand/* +
                                    config/ingredients.json. Returns Foundation
                                    object: {voice, clusterPOVs, ingredientStories,
                                    comparisonFramework, founderNarrative,
                                    ingredientsByCluster}.
                                    Fail loud if any required file missing.
    ├── prompt-builder.js           Builds the system prompt from Foundation +
                                    target. Voice doc is the spine; cluster POV
                                    is the angle; ingredient stories form the
                                    body; comparison framework is the
                                    differentiation tool.
    ├── assemble-cluster.js         Cluster mode. Calls Claude with system
                                    prompt + cluster brief. Returns structured
                                    JSON (FAQs, ingredient cards, mechanism,
                                    founder, free-from, badges, hook line,
                                    guarantee text). Validators run before
                                    queueing.
    ├── assemble-product.js         Product mode. Calls Claude with system
                                    prompt + product brief (cluster context +
                                    SKU data + GSC long tail for SEO targeting).
                                    Returns SEO title, meta description,
                                    body_html, metafield overrides. Validators
                                    run before queueing.
    └── validators.js               Pre-queue checks:
                                    - Every ingredient claim is in
                                      config/ingredients.json for that cluster
                                      (no fabrication).
                                    - Voice consistency (LLM-judge against
                                      voice-and-pov.md; threshold rejection).
                                    - Word counts within scaffold bounds (title
                                      55-70 chars, meta 145-160, body_html
                                      120-180, ingredient stories 40-60 each,
                                      mechanism block 80-100, founder 60-80,
                                      FAQ answers 30-80).
                                    - No branded/competitor/generic terms
                                      surfaced in title (reuses existing
                                      brand_terms / COMPETITOR_TERMS /
                                      GENERIC_BLOCKLIST).
                                    Failed validation = queue item flagged
                                    `status: needs_rework` with reasons.
```

### Layer 4 — Workflow (`agents/dashboard/` extensions)

The queue + review surface. Reuses existing `data/performance-queue/` infrastructure.

**Queue items** land at `data/performance-queue/<slug>.json` (product mode) or `data/performance-queue/cluster-<name>.json` (cluster mode), with shape:

```json
{
  "type": "pdp-product" | "pdp-cluster",
  "slug": "<product-handle>" | "<cluster-name>",
  "status": "pending" | "needs_rework" | "approved" | "dismissed" | "published",
  "generated_at": "<iso>",
  "current": { /* current Shopify state — title, meta, body_html, metafields */ },
  "proposed": { /* agent-generated state */ },
  "validation": { "passed": bool, "warnings": [], "errors": [] },
  "foundation_version": "<git sha of data/brand/ at generation time>"
}
```

**Dashboard surface** — new tab or route at `/pdp-review`:

- List queue items (filterable by status, cluster, type).
- Per-item side-by-side diff view: current Shopify content on the left, proposed on the right. For body_html, render both as HTML previews. For metafields, structured key-value diff.
- Action buttons: Approve / Edit Inline / Dismiss / Re-generate. Edit Inline lets you tweak the proposed content directly; saves over `proposed`.
- Bulk approve for confidence — but default is per-item review at this tier.

**Publishing**: `node agents/pdp-builder/index.js --publish-approved` reads queue items with `status: approved` and pushes to Shopify via the existing `lib/shopify.js` functions (`updateProduct`, `upsertMetafield`, `updateThemeAsset` for cluster items). On success, sets `status: published` and records `published_at`.

---

## Data flow (one product, end-to-end)

```
config/ingredients.json + data/brand/*
        │
        ▼
  load-foundation.js  ──▶  Foundation object
                              │
                              ▼
                       prompt-builder.js  ──▶  system prompt
                                                │
                                                ▼
                                  assemble-product.js
                                  (Claude API call)
                                                │
                                                ▼
                                  validators.js
                                  (ingredients, voice, length, exclusion lists)
                                                │
                                                ▼
                       data/performance-queue/<slug>.json
                       { status: pending, current, proposed, validation }
                                                │
                                                ▼
                       Dashboard /pdp-review
                       (side-by-side diff, approve/edit/dismiss)
                                                │
                                                ▼ (human approves)
                                  status: approved
                                                │
                                                ▼
                       --publish-approved
                                                │
                                                ▼
                       lib/shopify.js  ──▶  Shopify
                       (title_tag, description_tag, body_html, metafields)
                                                │
                                                ▼
                                  status: published, published_at
```

For cluster mode, the final step pushes via `lib/shopify.js#updateThemeAsset` (the cluster JSON template) instead of product fields — but the same queue/review/publish chain applies. Theme structural Liquid changes (Layer 2 sections) are NOT pushed via the agent — those go through the Shopify CLI workflow in `~/Code/realskincare-theme/` with branch-based deploy.

---

## Phased rollout

Six phases. Each phase has a clear deliverable; nothing publishes to live until the relevant phase is complete and reviewed.

**Phase 1 — Foundation**
Write the 5 docs/datasets in `data/brand/`. Toothpaste-relevant content prioritized: voice doc, toothpaste cluster POV, ingredient stories for the toothpaste hero ingredients (organic virgin coconut oil, baking soda, wildcrafted myrrh, xanthan gum, stevia), comparison framework lines for fluoride/SLS/synthetic-flavor/synthetic-sweetener axes, founder narrative.

Other clusters' content can come in Phase 6 — for the pilot, only toothpaste foundation needs to be complete.

Output: `data/brand/voice-and-pov.md`, `data/brand/cluster-povs.md` (toothpaste section complete), `data/brand/ingredient-stories.json` (5 toothpaste-relevant ingredients), `data/brand/comparison-framework.md` (toothpaste axes complete), `data/brand/founder-narrative.md`. Reviewed and committed.

**Phase 2 — Theme refactor for toothpaste cluster (CLI workflow)**

In `~/Code/realskincare-theme/`:

1. Restructure `templates/product.landing-page-toothpaste.json` blocks per the Layer 2 sequence above. Currently 6 image-with-text blocks of body-lotion placeholder; redefine to 3 ingredient cards + 1 mechanism + 1 founder + 1 free-from. Write the cluster-default content via the agent in Phase 4 — for now, set up the block structure with stub text.
2. Update `sections/collapsible-content.liquid` to read `product.metafields.custom.faq_additional`.
3. Update `sections/image-with-text.liquid` to optionally read `product.metafields.custom.hero_ingredients_override`.
4. Update `sections/main-product.liquid` (or wherever free-from currently displays) to read `product.metafields.custom.free_from`.
5. Define metafield schema in Shopify admin (Settings → Custom data → Products) for the 5 metafields above.
6. Test on a draft theme via `shopify theme push --theme=<draft-id>`.

Output: a draft theme with the toothpaste cluster template restructured + metafield-aware sections. Promoted to live only after Phase 4 testing.

**Phase 3 — Agent build (`agents/pdp-builder/`)**

Build the agent per Layer 3 spec. Cluster mode + product mode. Validators. Test against Phase 1 foundation content.

Output: working agent that, given foundation files, produces queue items for `coconut-oil-toothpaste` (product mode) and `toothpaste` (cluster mode).

**Phase 3a — Dashboard review surface**

Build `/pdp-review` route + UI per Layer 4 spec. Reuses existing performance-queue.

Output: reviewable queue with side-by-side diff and approve/edit/dismiss actions.

**Phase 4 — Pilot end-to-end**

1. Run cluster mode on toothpaste. Review the queue item (FAQs, ingredient cards, mechanism, founder, free-from). Approve. Publish via `--publish-approved` (this updates `templates/product.landing-page-toothpaste.json` content blocks via `updateThemeAsset`).
2. Run product mode on `coconut-oil-toothpaste`. Review queue item (title, meta, body_html, any metafield overrides). Approve. Publish.
3. Set `template_suffix=landing-page-toothpaste` on the toothpaste product (via `updateProduct` API call).
4. Visit the live page on Shopify. Stress-test on mobile + desktop. Read it like a customer.

Capture issues — copy that drifted, sections that don't render, voice that wandered, photography gaps, FAQ depth issues, anything that doesn't read premium.

**Phase 5 — Iterate**

Fix what Phase 4 surfaced. Voice tweaks, schema changes, additional metafields, prompt refinements, additional ingredient stories. Update Phase 1-3 deliverables as needed. Re-run pilot.

**Phase 6 — Propagate to remaining 6 clusters and 7 products**

Active SKUs after excluding the 4 bundles/first-aid (`cut-and-scrape`, `foam-soap-bundle`, `sensitive-skin-starter-set`, `skincare-starter-set`):
- Deodorant: `coconut-oil-deodorant`
- Toothpaste: `coconut-oil-toothpaste` (the Phase 4 pilot SKU)
- Body lotion: `coconut-lotion`
- Body cream: `coconut-moisturizer`
- Bar soap: `coconut-soap`
- Foaming soap: `organic-foaming-hand-soap`, `foam-soap-refill-32oz`
- Lip balm: `coconut-oil-lip-balm`

Total: 8 SKUs (1 pilot + 7 propagation).

For each cluster:
1. Write the cluster-specific foundation content (cluster POV paragraph + ingredient stories for that cluster's hero ingredients).
2. Restructure the cluster template in `~/Code/realskincare-theme/` to match the toothpaste pattern.
3. Run cluster mode → review → publish template content.
4. Run product mode for each SKU in that cluster → review → publish + set `template_suffix`.

Phases 1, 2, 6 mostly content/theme writing time; Phase 3 is engineering time; Phase 4-5 is the integration loop. Photography is a parallel workstream the user owns.

---

## Error handling and edge cases

- **Foundation file missing or malformed.** `load-foundation.js` fails loud. Don't fall back to defaults; we never publish without the curated foundation in hand.
- **Ingredient validation fails** (agent fabricated an ingredient not in `config/ingredients.json`). Queue item flagged `status: needs_rework`. Reviewer can edit inline or re-run.
- **Voice consistency fails** (LLM-judge against `voice-and-pov.md` scores below threshold). Flagged `needs_rework` with specific feedback.
- **Claude API fails or rate-limits.** Retry with exponential backoff (existing `lib/retry.js` pattern). Second failure logs and skips.
- **Theme Liquid changes break rendering.** Use `shopify theme push --theme=<draft-id>` for all Phase 2 work. Promote to live only after visual verification.
- **Metafield not yet defined in Shopify admin.** Agent's `upsertMetafield` call would silently succeed but the theme won't render it. Phase 2 includes defining metafields in admin first; document the metafield schema in the spec so it's not skipped.
- **Product missing `template_suffix` after Phase 4.** Product still works on default template; just doesn't get the new structure. Visible mismatch = reminder to set the suffix.
- **Foundation version drift.** Each queue item records `foundation_version` (git SHA of `data/brand/` at generation). If foundation changes between generation and review, the diff view shows the outdated foundation version. Reviewer can re-generate.

## Testing

- **Unit tests** (vitest or whatever the project uses): `load-foundation.js` (loads correctly when files missing/malformed), `validators.js` (catches fabricated ingredients, catches voice violations, catches length violations).
- **Snapshot tests**: `prompt-builder.js` system prompts for toothpaste cluster + `coconut-oil-toothpaste` product match expected structure.
- **Integration test**: full product-mode run on `coconut-oil-toothpaste` produces a queue item that passes validation. Mock the Claude API call for determinism.
- **Manual end-to-end**: pilot itself is the main test (Phase 4).

## Decision log

- **Hybrid (cluster + per-product metafield overrides), not cluster-only.** Premium brands have a brand POV at category level AND SKU-level depth — the same lavender deodorant doesn't have the same hero ingredient story as bergamot.
- **Restructure template blocks intentionally, not cut for simplicity.** Each of the 6 image-with-text slots gets a defined job (3 ingredients + mechanism + founder + free-from), not 6 generic blocks.
- **Clinical-confident voice with sensitive-skin authority anchor.** Locked in as the brand voice direction. Generic LLM voice is rejected at validator stage.
- **Shopify CLI workflow for theme work, API for products/metafields.** Theme files live in `~/Code/realskincare-theme/`; agent writes products via `lib/shopify.js`. Clean responsibility split.
- **Toothpaste as pilot.** Single SKU = lowest stakes for pilot. Sensitive-teeth positioning maps perfectly to the brand POV. Strong competitor research baseline.
- **No autonomous publishing.** `--apply` is removed from the new agent. Default is queue-only. Human review on every output.
- **Cut and Scrape, Sensitive Skin Set, Two-Step Set, Foam Soap Bundle excluded from this spec.** Bespoke landing pages will come later.

## Open questions / deferred decisions

- **Photography sourcing strategy.** User owns this. Stock vs. AI-generated vs. commissioned shoot — decide before Phase 4 visual review.
- **Shopify GitHub integration for theme.** Recommended (branch-based deploy) but optional for the pilot. Set up between Phase 2 and Phase 6.
- **A/B testing of new vs. old PDP copy.** Not in scope. Could add later if we want to measure conversion lift quantitatively rather than qualitatively.
- **Founder narrative voicing.** User to draft "From Sean" snippet in their own voice during Phase 1; agent uses as exemplar.
- **Comparison framework specifics.** User to confirm the specific axes we want to differentiate on. Initial draft: SLS, aluminum, fluoride, synthetic fragrance, parabens, glycerin/sorbitol coating, refined-vs-virgin oils.
