# Ad Structures — model proven competitor ads instead of inventing concepts

**Date:** 2026-10-03 · **Status:** decided by Sean in conversation ("Build it based on your recommendations")
**Changes:** `agents/ad-concepts` (concept stage replaced; typesetter gains layouts), new `data/ad-structures/`, new research command.

## Why

On 2026-10-03 `agents/ad-concepts` produced three live runs of model-invented concepts (a coconut-shell bar, a lather storm cloud, a melting iceberg). Sean: *"Nothing about those ads makes me want to click on them… Go out and look for ad creatives that are working for other brands instead of inventing new concepts."* and *"Use lotion and creams."*

A Meta Ad Library pull the same day (36 advertisers, ~4,600 ads) found 37 static lotion/cream/balm ads running 90+ days — the only performance signal the library leaks. Three RSC ads modelled on survivors' STRUCTURES (a real-review comment card with an offer band, a finger-scoop texture shot, a "they think we sell / we actually sell" split) were rendered photoreal with AI, gated, and type-set in code. Sean: *"All three of those are great."* This spec turns that one-off into the pipeline.

Research material, source ads and the approved reference implementation: `docs/superpowers/specs/assets/2026-10-03-ad-structures-research/` (`ads.json`, `sources/*.jpg`, `approved/*.jpg`, `approved-reference-make.mjs`, `scripts/*.mjs`).

## Decisions (Sean)

| Question | Decision |
|---|---|
| Source of ideas | A library of long-running competitor STRUCTURES; the model fills slots, never invents a concept |
| Library growth | Seeded from today's research + an on-demand refresh command that proposes candidates; Sean approves what enters |
| Discounts in ads | Only an offer Sean names for the run (`--offer`), verified against the live store price; otherwise an always-true value line |
| Imagery | Photoreal AI, phone-shot look, gated by Ad Studio's `verifyImage` |
| Products | Lotion and cream first; landing page for the first ad is the Sensitive Skin Moisturizing Set |
| Approach | Library as data + one code layout per visual shape (not an LLM picking from research, not per-structure scripts) |

## Out of scope (v1)
Scheduled refresh; structures needing evidence RSC does not have (founder/family photo, customer counts, Day-1-vs-Day-N durations, press); video; Meta publishing (always manual).

## The structure library — `data/ad-structures/library.json` (tracked)

```json
{
  "version": 1,
  "structures": [{
    "id": "comment-card-offer",
    "name": "Customer comment card + offer band",
    "status": "approved",                       // approved | candidate | retired
    "sources": [{ "brand": "Ancestral Cosmetics", "days": 304, "adLibraryUrl": "...", "image": "sources/ancestral-cosmetics-2025-12-02-1.jpg" }],
    "layout": "comment-card",                   // a key in agents/ad-concepts/layouts/
    "ratio": "1:1",
    "fits": ["cream", "lotion"],               // product kinds the scene works for
    "requires": ["review"],                     // evidence that must exist or the structure is skipped
    "people": "none",                           // none | hands | face  (hands/face → needsHumanReview)
    "scene": { "primary": "…phone-shot scene with {productNoun}…", "fallback": "…bigger, simpler framing…" },
    "slots": {
      "headline": { "source": "model", "maxWords": 5, "style": "a 2-4 word category title in the reviewer's own framing" },
      "quote":    { "source": "review", "maxChars": 220 },
      "band":     { "source": "offerOrValue" }
    },
    "notes": "Why it works and what NOT to copy"
  }]
}
```

`sources/` images live beside the library (`data/ad-structures/sources/`, compressed JPEG). Every structure cites ≥1 source ad with its days running.

**Seeded structures (status `approved`), all transferable per the research's compliance review:**

| id | layout | source (days) | requires | notes |
|---|---|---|---|---|
| `comment-card-offer` | comment-card | Ancestral Cosmetics (304) | review | approved reference A |
| `texture-scoop` | headline-over-photo | Beauty From Bees (256) | review (headline sourced from review words) | approved reference B; hands |
| `they-think-we-sell` | split-two-panel | Ancestral Cosmetics (207) | catalogFact | approved reference C; left panel is a generic, unbranded, product-free plate |
| `ours-vs-theirs-checklist` | checklist-split | Ancestral (207), Wild Gold (204) | catalogFact | our facts only; "theirs" = generic category ("typical drugstore lotion"), never a brand; only items stated verbatim in catalog/PDP |
| `product-group-plain` | photo-only (+ optional band) | Carolina Tallow (386) | — | no overlay text except the band |
| `labelled-bundle-offer` | labelled-bundle | Ancestral Cosmetics (304) | offer, bundle landing | only runs when `--offer` is given and the landing product is a bundle |

Not seeded (requires evidence RSC lacks): founder/family collage, customer-count headline, Day-1-vs-Day-N, free-gift offer (until Sean names one).

## Run

```bash
node agents/ad-concepts/index.js --products coconut-moisturizer,coconut-lotion --variant pure-unscented \
  --landing sensitive-skin-starter-set [--offer "Sensitive Skin Set $46.80 (was $58)"] \
  [--structures id,id,id] [--ratio-override …] [--max-renders 30] [--dry-run]
```

- `--products`: the products that may APPEAR in images (each needs reference photos + label strings, as today). Kind derived from the catalog/manifest (`lotion` for a squeeze bottle body lotion, `cream` for the jar). 
- `--landing`: the product page the ad sends people to (URL + live price read from `https://www.realskincare.com/products/<handle>.json`). Defaults to the single `--products` entry.
- `--offer`: optional, free text naming a price and a was-price; the run aborts before any paid call unless both numbers equal the landing product's live `price` and `compare_at_price` (any variant). The band then reads e.g. `SENSITIVE SKIN SET $46.80 (WAS $58)`.
- No `--offer` → the band uses an always-true value line from an allowlist built from the brand kit and catalog (`FREE SHIPPING ON ORDERS OVER $45` from `brand_kit.free_shipping_threshold`, `MADE IN THE USA`, the catalog's "Only N Clean Ingredients" when present).

## Pipeline

```
library ─▶ select 3 (approved, evidence present, fits a --product, distinct layouts, ranked by source days; --structures overrides)
        ─▶ per structure: fill slots (code picks evidence; model writes only headline-type slots; gates)
                        ─▶ render plate(s) from scene recipe (primary ×2, then fallback ×2) ─▶ verifyImage
                        ─▶ layout in code (brand fonts) ─▶ critique (legibility) + occlusion
        ─▶ flexible copy (2 primary texts, 2 headlines; existing writeFlexibleCopy + gates) ─▶ manifest ─▶ run.json ─▶ archive ─▶ notify
```

### Selection — `agents/ad-concepts/structures.js` (pure)
`loadLibrary(path)` validates the schema (unknown layout, missing source, bad status → throw at load). `eligible(library, { products, landing, offer, evidence })` filters approved structures whose `requires` are all present and whose `fits` matches some `--products` kind; `selectStructures(eligible, { slots: 3, override })` takes the override first, then highest max source-days, never two with the same layout. Fewer than 2 eligible → abort before any paid call with the reason.

### Evidence and slot filling — `agents/ad-concepts/evidence.js`
- **Reviews:** `fetchAdReviews` for every `--products` handle → `selectQuotableReviews` → an ad-concepts screen that additionally drops reviews matching `findHealthClaims`, the variant gate, a competitor name, an em dash, and a local DISEASE_EXTRA list (`diabetic`, `diabetes`, `cuts`, `wound`, `burn`, `rash`, `psoriasis`, `eczema`, `dermatitis`) — the 2026-10-03 run surfaced "helps my diabetic skin" and "doesn't burn my cuts" through `selectQuotableReviews`. A quote slot is filled with a review chosen by the model **by index**; code inserts the exact text (truncating at a sentence boundary to `maxChars`, never mid-sentence, never editing words). Reviews are attributed "Customer review" (no names, no "verified" unless the source says so).
- **Model slots** (headline-type): one call per structure with the structure's `style`, the evidence, the variant block, and `maxWords`; output gated by `gateCopy` (health, misnomer, competitor, em dash, variant, sourcing) with one regeneration.
- **Template slots** (split-panel labels, checklist rows): deterministic strings from the structure plus product facts; checklist rows only from catalog/PDP phrases that `checkClaimsSourced` accepts verbatim.
- **Band:** offer (verified) or a value line from the allowlist.

### Rendering — reuse `shots.js`
Scene recipe text + code-owned blocks (product fidelity with `allowPeople` per structure, unit count, label ink, scene-text "no text except our label"). Up to 2 takes on `scene.primary`, then up to 2 on `scene.fallback` (the 2026-10-03 lesson: a hand-held small bottle failed 4/4; standing and large passed first time). Product-free plates (split left panel) skip `verifyImage` but still pass a stray-text-only check (`verifyImage` with `unitCount: 0` is not supported — use a dedicated short vision check "is there any readable text?" fail-closed).

### Layouts — `agents/ad-concepts/layouts/*.js`
Each layout exports `render({ plates, slots, ratio, fontCss }) → html` and `regions(ratio)` (where type sits, for the occlusion prompt). Pixel-exact ports of the approved reference implementation for `comment-card`, `headline-over-photo`, `split-two-panel`; new `checklist-split`, `photo-only`, `labelled-bundle`. Shared `band` component. Typesetting engine (Puppeteer + `lib/brand-fonts.js`) is the existing one, generalized to accept layout HTML.

### Refresh — `agents/ad-concepts/research.js` (`node agents/ad-concepts/research.js --refresh [--brands …]`)
Productizes `scripts/collect.mjs`/`filter.mjs`/`select.mjs`: headful Chrome (headless is blocked), no login, paced; pulls active image ads for a configured brand list (`data/ad-structures/brands.json`) and keyword searches; keeps body lotion/cream/butter/balm ads running ≥90 days; a vision call tags each with a format and flags non-transferable claims (before/after of skin, collagen, Botox, condition, "chemicals are killing you"). Writes `data/ad-structures/candidates/<date>.json` + compressed screenshots and a markdown report, and `notify()`s (deferred). It NEVER edits `library.json`; Sean approves by asking, and `--approve <candidate-id>` adds a `candidate`-status entry he then promotes. On-demand only.

### Output, robustness, notify
Unchanged from the current agent (run dir under `data/creatives/ad-studio/`, per-take proofs, `flexible-ad.json`/`.md` with landing URL and price, `needsHumanReview` for hands/faces, crash-safe archive). `run.json` adds `structures` (ids + source days) and `landing`.

### Retired
The invented-concept stage (`buildConceptPrompt`, judge, `pickConcepts`, `buildConceptTactics`) is removed from the runtime path and deleted with its tests; reusable gates in `concepts.js` (`checkClaimsSourced`, `mentionsCompetitor`, `variantConflicts`, `preGate` pieces used by evidence screening) stay. `README.md` and the CLAUDE.md paragraph are updated.

## Testing
Pure-unit: library validation, eligibility/selection (evidence missing → skipped; offer-only structures need `--offer`; distinct layouts; override), offer verification against a stubbed live price, review screening (the two real 2026-10-03 reviews are dropped), quote insertion is verbatim and sentence-bounded, each layout renders exact strings at the right pixel size (Puppeteer, like typeset tests), fallback scene used after 2 primary failures. Orchestrator end-to-end with all models stubbed. Acceptance (live, by eye): one run for the Sensitive Skin Set in pure-unscented with the three approved structures → compared to the approved references.
