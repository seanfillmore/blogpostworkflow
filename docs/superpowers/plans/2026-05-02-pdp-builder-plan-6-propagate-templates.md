# PDP Builder — Plan 6: Propagate Template to Remaining Clusters

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build PDP templates for all 6 remaining clusters (deodorant, lotion, cream, bar_soap, liquid_soap, lip_balm) using the toothpaste pilot as the canonical pattern, then perform ONE coordinated cutover that flips all 8 SKUs to the new templates simultaneously.

**Architecture:** Two repos involved. Foundation content lives in `seo-claude` (`data/brand/*`, `config/ingredients.json`). Theme templates live in `~/Code/realskincare-theme/` (separate git repo). The pdp-builder agent reads foundation content and writes per-cluster + per-SKU JSON queue items to `data/performance-queue/`. The agent does NOT publish; humans paste agent output into the theme templates and Shopify product fields. The toothpaste template at `~/Code/realskincare-theme/templates/product.landing-page-toothpaste.json` is the canonical pattern and is preserved unchanged. Each cluster gets its own `product.landing-page-<cluster>.json` cloned from it. Cutover is one moment when all 8 products' `template_suffix` are set AND the draft theme is promoted to live.

**Tech Stack:** Node.js (pdp-builder agent), Anthropic SDK (claude-opus-4-7), Shopify CLI (theme push), Shopify Admin API (template_suffix). Theme is Shopify Liquid + JSON section configs.

**Sean-side prerequisites confirmed:**
- 5 metafield definitions exist in admin (PR #197 merged): `hero_ingredients_override`, `faq_additional`, `free_from`, `sensitive_skin_notes`, `scent_notes`.
- Founder narrative published with Sean's flip-the-box origin story (PR #196 merged).
- Draft theme `145536778410` exists; toothpaste template lives there at `~/Code/realskincare-theme/feat/toothpaste-cluster-template`.

---

## Cluster execution order

Ordered by revenue/strategic priority:
1. **deodorant** — 4 SKU variations on `coconut-oil-deodorant`. Highest blog-cluster traffic; most aligned with current SEO investment.
2. **lotion** — 5 variations on `coconut-lotion`.
3. **cream** — 5 variations on `coconut-moisturizer`.
4. **bar_soap** — 4 variations on `coconut-soap`.
5. **liquid_soap** — 4 variations on `organic-foaming-hand-soap` + 1 SKU `foam-soap-refill-32oz`.
6. **lip_balm** — 4 variations on `coconut-oil-lip-balm`.

Total: 6 clusters, 7 base SKUs (`foam-soap-refill-32oz` shares the `liquid_soap` cluster but is a separate Shopify product). The handoff says 8 SKUs — `foam-soap-refill-32oz` is the 8th counting refill separately.

---

## File Structure

**seo-claude (this repo):**
- Modify: `data/brand/cluster-povs.md` — fill 6 `> TBD — Plan 6` stubs
- Modify: `data/brand/ingredient-stories.json` — add stories for cluster-specific ingredients (jojoba, beeswax, palm stearic, palm oil, emulsifying wax, grapefruit seed extract, essential oils that recur, etc.)
- Generated (gitignored or untracked): `data/performance-queue/cluster-<name>.json` (× 6) and `data/performance-queue/<product-handle>.json` (× 7)

**realskincare-theme (sibling repo):**
- Create: `templates/product.landing-page-deodorant.json`
- Create: `templates/product.landing-page-lotion.json`
- Create: `templates/product.landing-page-cream.json`
- Create: `templates/product.landing-page-bar-soap.json`
- Create: `templates/product.landing-page-liquid-soap.json`
- Create: `templates/product.landing-page-lip-balm.json`

**Shopify admin (manual, not in repo):**
- Set `template_suffix` on each of the 7 products at cutover time only.

---

# PHASE A — Foundation expansion

This phase has no theme work. It writes the brand content the agent reads from. Both files are exemplars-by-toothpaste — the toothpaste section is the canonical voice. Match its structure, length, and tone.

---

### Task A.1: Write the 6 cluster POVs

**Files:**
- Modify: `data/brand/cluster-povs.md` (currently 42 lines; replaces lines 19-42)

**Pattern (from toothpaste section, lines 7-15):** four paragraphs.
1. **Who this is for** — name the customer (sensitive-skin sufferer, person who reads ingredient labels, person who's been burned by "natural" labeling). Lead with their experience, not the product.
2. **The mechanism story** — short. Each base ingredient gets one sentence: what it does + why we picked the unrefined/wildcrafted version vs. the cheap industrial one.
3. **What's NOT in the bottle/jar/bar/tube** — itemize the cheap industrial alternatives we left out, with the function they would have served.
4. **The trade-off, honest** — the texture, the scent intensity, the batch-to-batch variation. Each trade-off as a downstream effect of leaving something out or refusing to strip natural variation.

**Rules (per `data/brand/voice-and-pov.md` and Sean's PDP review):**
- "Natural" is not in our vocabulary. Use it only inside quotation marks when describing what mass-market brands say.
- Mechanism-forward, no hype words ("revolutionary", "best-in-class", "unparalleled").
- "We" voice (family-driven), not "I" voice. The founder block in the template uses Sean's solo voice — the cluster POV is family voice.
- Brand confidence is allowed; fabrication is not. Citations stay empty for now.
- ~280-360 words per cluster (toothpaste is ~330).

- [ ] **Step 1: Read toothpaste section as the exemplar**

Read `data/brand/cluster-povs.md` lines 7-15. This is the canonical structure. Every cluster section must follow it.

- [ ] **Step 2: Draft `## deodorant` POV**

Replace `> TBD — Plan 6 (after toothpaste pilot succeeds...)` at line 21 with a four-paragraph POV.

Cluster-specific content to weave in:
- **Who:** the customer who has tried 5+ natural deodorants that didn't work, who reacts to baking soda concentrations or aluminum chlorohydrate, who notices odor returning by 2pm with most natural alternatives.
- **Base ingredients (from `config/ingredients.json` deodorant.base_ingredients):** purified spring water, organic virgin coconut oil, organic jojoba, plant-based emulsifying wax, grapefruit seed extract, sodium bicarbonate (baking soda).
- **Mechanism:** lauric acid in coconut oil disrupts odor-causing bacteria's membranes (same antimicrobial role as the toothpaste version); jojoba is structurally similar to skin's own sebum so it absorbs without leaving a film; baking soda neutralizes the acidic environment odor bacteria need.
- **What's NOT in:** aluminum (chlorohydrate or zirconium); propylene glycol; parabens; synthetic fragrance; talc.
- **Trade-off:** roll-on is wetter than a stick. Doesn't antiperspire — sweat is body function. Coconut oil firms below 76°F so the application feel changes with temperature. Some customers reactive to baking soda at conventional concentrations should patch-test the formula.

- [ ] **Step 3: Draft `## lotion` POV**

Replace `> TBD — Plan 6.` at line 25 with the four-paragraph POV.

Cluster-specific content:
- **Who:** the customer with sensitive skin who reads lotion labels and finds petroleum derivatives, mineral oil, fragrance, parabens. Or who has eczema and gets reactive to "calming" lotions. Or whose hands stay dry no matter what they apply.
- **Base ingredients (lotion.base_ingredients):** purified spring water, organic virgin coconut oil, organic jojoba, plant-based emulsifying wax, organic grapefruit seed extract, organic red palm oil.
- **Mechanism:** coconut oil delivers medium-chain fatty acids that absorb readily; jojoba mirrors skin's own sebum chemistry so absorption is rapid without a greasy film; red palm oil contributes naturally occurring vitamin E and beta-carotene; grapefruit seed extract is the natural preservative.
- **What's NOT in:** mineral oil, petrolatum, propylene glycol, synthetic fragrance, parabens, phenoxyethanol, dimethicone.
- **Trade-off:** texture varies because cold-pressed coconut oil firms below 76°F. The unscented variation has a faint coconut/jojoba scent — that's the actual ingredients, not added fragrance. Bottles need a shake before pump if stored cool.

- [ ] **Step 4: Draft `## cream` POV**

Replace `> TBD — Plan 6.` at line 29.

Cluster-specific content:
- **Who:** the customer whose skin needs more occlusion than a lotion provides — extreme dryness, eczema-prone, post-shower routine, hands-and-feet routine. Often the same customer who's tried thick body butters that left a film and didn't actually lock moisture in.
- **Base ingredients (cream.base_ingredients):** purified spring water, organic virgin coconut oil, plant-based emulsifying wax, palm stearic, grapefruit seed extract, organic beeswax, organic red palm oil.
- **Mechanism:** beeswax is a true skin barrier — locks moisture in without sealing pores like petrolatum does; palm stearic gives the cream its rich body without synthetic thickeners; coconut oil + jojoba absorb while beeswax holds them in.
- **What's NOT in:** petrolatum, mineral oil, dimethicone, lanolin, synthetic fragrance, parabens, phenoxyethanol.
- **Trade-off:** thicker than the lotion — closer to a balm. Texture firms in cold weather because beeswax does. Not for fast absorption; for overnight moisturizing or post-bath routines.

- [ ] **Step 5: Draft `## bar_soap` POV**

Replace `> TBD — Plan 6.` at line 33.

Cluster-specific content:
- **Who:** the customer who's read bar-soap labels and found sodium tallowate (rendered animal fat), synthetic detergents, EDTA, fragrance. Or whose skin reacts to most commercial bars but is fine with castile-style coconut soap. Or who wants a long-lasting bar without parabens or sulfates.
- **Base ingredients (bar_soap.base_ingredients):** saponified organic virgin coconut oil. (One ingredient. Plus essential oils per variation.)
- **Mechanism:** saponification turns coconut oil into a true soap — fatty acids react with lye, producing soap molecules and glycerin. The single-ingredient base means lather, cleansing, and moisturizing all come from one source. Coconut soap is naturally rich in lather without added foam boosters.
- **What's NOT in:** sodium tallowate (animal fat), sulfates (SLS/SLES), EDTA, synthetic fragrance, parabens, triclosan, dyes.
- **Trade-off:** a single-ingredient bar is harder than tallow-based commercial bars and lasts longer in a wet shower if drained. The lather is generous but different from sulfate-foam — fluffier, less squeaky-clean afterward. The unscented bar has the natural light scent of saponified coconut oil.

- [ ] **Step 6: Draft `## liquid_soap` POV**

Replace `> TBD — Plan 6.` at line 37.

Cluster-specific content:
- **Who:** the customer who's tried foaming hand soaps and found surfactant cocktails, parabens, and dye. The parent who wants kids using soap they can read the label on. The customer with reactive hands from frequent washing.
- **Base ingredients (liquid_soap.base_ingredients):** saponified organic virgin coconut oil. (One ingredient. Plus essential oils per variation.)
- **Mechanism:** same coconut-oil saponification as the bar — but diluted to foaming-pump consistency, designed for the foaming dispenser. The pump aerates a small amount into a generous lather. Less product per wash than conventional pump soap.
- **What's NOT in:** SLS, SLES, cocamidopropyl betaine, propylene glycol, parabens, triclosan, synthetic fragrance, EDTA, dyes.
- **Trade-off:** thinner than commercial pump soap — must use a foaming dispenser, not a regular pump. The 32oz refill is concentrated; check fill instructions to dilute correctly. The unscented variation has a light coconut scent.

- [ ] **Step 7: Draft `## lip_balm` POV**

Replace `> TBD — Plan 6.` at line 41.

Cluster-specific content:
- **Who:** the customer whose lips stay dry no matter what balm they use. Or whose previous balms had petrolatum, parabens, synthetic flavoring, or microcrystalline wax. Or who's finally tracked a chronic chapping issue to a lanolin or fragrance reaction.
- **Base ingredients (lip_balm.base_ingredients):** organic virgin coconut oil, organic beeswax, organic red palm oil.
- **Mechanism:** beeswax forms the protective barrier that locks in moisture; coconut oil delivers medium-chain fatty acids that nourish; red palm oil adds vitamin E and tocotrienols. Three ingredients, three jobs. No occlusive that traps without nourishing (petrolatum), no irritant flavoring.
- **What's NOT in:** petrolatum, paraffin, mineral oil, lanolin, synthetic flavoring, parabens, phenol, menthol.
- **Trade-off:** firmer than petrolatum-based balm — beeswax sets harder. Apply with light pressure, not a smear. The unscented balm has the natural scent of beeswax and coconut, not "no scent." Color tints come from red palm oil and essential oils, not pigments.

- [ ] **Step 8: Verify the file structure**

Run: `cat data/brand/cluster-povs.md | grep -E "^## " -A 1 | head -30`
Expected: each `## <cluster>` heading is followed by a paragraph (not `> TBD`).

- [ ] **Step 9: Self-review against toothpaste exemplar**

For each new cluster section:
- Word count between 280-360.
- Four paragraphs.
- No "natural" outside quotation marks.
- No "I" voice (family "we" voice).
- No fabricated ingredients (every named ingredient is in `config/ingredients.json` for that cluster, OR is a documented mechanism like "lauric acid" / "vitamin E").
- Trade-off paragraph is honest, not glossy.

- [ ] **Step 10: Commit**

```bash
cd /Users/seanfillmore/Code/Claude
git checkout -b feat/pdp-cluster-povs-all
git add data/brand/cluster-povs.md
git commit -m "$(cat <<'EOF'
feat(brand): cluster POVs for all 6 remaining clusters

Replaces "> TBD — Plan 6" stubs with four-paragraph cluster POVs
(deodorant, lotion, cream, bar_soap, liquid_soap, lip_balm).
Each follows the toothpaste pattern: who-it's-for, mechanism story,
what's NOT in the bottle, honest trade-off. Family voice ("we"),
mechanism-forward, no fabricated ingredients.

Foundation for Plan 6 — propagate PDP template to remaining clusters.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A.2: Expand ingredient-stories.json

**Files:**
- Modify: `data/brand/ingredient-stories.json` (currently 5 toothpaste-relevant ingredients)

**Pattern (from existing entries):** every entry has `name`, `role`, `mechanism`, `sourcing`, `why_we_chose_it`, `what_cheap_alternatives_look_like`, `citations` (empty array). Match the depth and length of the toothpaste entries — each `mechanism` is 2-4 sentences with specific compound names.

**Required new ingredient entries** (used across the new cluster POVs and templates):

| Key | Used by | Role |
|---|---|---|
| `organic_jojoba` | deodorant, lotion | "skin-mirroring oil" |
| `plant_emulsifying_wax` | deodorant, lotion, cream | "emulsifier (water+oil binder)" |
| `grapefruit_seed_extract` | deodorant, lotion, cream | "natural preservative" |
| `organic_beeswax` | cream, lip_balm | "moisture-lock barrier" |
| `palm_stearic` | cream | "natural thickener" |
| `organic_red_palm_oil` | lotion, cream, lip_balm | "vitamin E + beta-carotene" |
| `saponified_coconut_oil` | bar_soap, liquid_soap | "single-ingredient soap base" |

For each, include the same six fields as the existing 5 entries.

- [ ] **Step 1: Read existing structure**

Read `data/brand/ingredient-stories.json`. Note that each ingredient has the same field shape. Use the toothpaste entries as exemplars for depth.

- [ ] **Step 2: Add `organic_jojoba` entry**

Insert before the closing `}` of the JSON. Required fields:

```json
"organic_jojoba": {
  "name": "Organic Jojoba",
  "role": "skin-mirroring carrier oil",
  "mechanism": "Jojoba is technically a wax ester, not an oil — its molecular structure mirrors human sebum closely enough that skin recognizes and absorbs it without forming an occlusive film. This makes it a fast-absorbing carrier that doesn't sit on top of skin the way mineral oil and petrolatum do. The same property keeps deodorant glide-on and lotion non-greasy.",
  "sourcing": "Cold-pressed from organic jojoba seeds (Simmondsia chinensis), grown primarily in the American Southwest and Mexico. Unrefined to retain the full wax-ester profile.",
  "why_we_chose_it": "Mineral oil and petrolatum are dramatically cheaper and form a more uniform film. They also block skin's own moisture exchange and can clog pores. Jojoba is the closest plant analog to sebum we know of, and the absorption behavior is the whole point of using it.",
  "what_cheap_alternatives_look_like": "Mineral oil, petrolatum, dimethicone, or fractionated coconut oil. All cheaper, all form an occlusive film, all good at making a product feel like it's doing something while doing less than they appear to.",
  "citations": []
}
```

- [ ] **Step 3: Add `plant_emulsifying_wax` entry**

```json
"plant_emulsifying_wax": {
  "name": "Plant-Based Emulsifying Wax",
  "role": "emulsifier (water + oil binder)",
  "mechanism": "Emulsifying wax holds water and oil phases together in a stable lotion or cream — without it, water and oil separate within hours. We use plant-derived emulsifying wax (typically from cetyl alcohol and vegetable-derived stearate). The wax forms micelles that suspend oil droplets in water and prevent phase separation through the product's shelf life.",
  "sourcing": "Plant-derived (vs. petroleum-derived). Vegetable cetearyl alcohol + vegetable-derived polysorbate, blended for the emulsifier function. Non-GMO.",
  "why_we_chose_it": "PEG-based emulsifiers (polyethylene glycol esters) are the industrial standard — cheaper, more shelf-stable, and easier to formulate with. They're also synthetic and have known purity concerns (1,4-dioxane contamination). We pay more for a plant-derived emulsifier because it does the same job without the contamination question.",
  "what_cheap_alternatives_look_like": "PEG-100 stearate, PEG-40 hydrogenated castor oil, ceteareth-20. All petroleum-derived, all do the emulsifier job, all carry the 1,4-dioxane contamination concern that requires the manufacturer to test for trace levels — something the consumer can't verify.",
  "citations": []
}
```

- [ ] **Step 4: Add `grapefruit_seed_extract` entry**

```json
"grapefruit_seed_extract": {
  "name": "Organic Grapefruit Seed Extract",
  "role": "natural preservative",
  "mechanism": "Plant-derived antimicrobial extract that inhibits bacterial and fungal growth in water-containing formulas. Acts as a broad-spectrum natural preservative, extending shelf life of lotion, cream, and deodorant without parabens or phenoxyethanol. The active polyphenol fraction (naringenin and related flavonoids) does the antimicrobial work.",
  "sourcing": "Cold-pressed and concentrated from organic grapefruit seeds. Standardized for active polyphenol content.",
  "why_we_chose_it": "Parabens and phenoxyethanol are the cheap, shelf-stable preservatives that show up in nearly every commercial cosmetic. They work — and they're also the most-asked-about ingredients by customers reading labels. Grapefruit seed extract works as well in our formulas at the concentrations we use, and it's something a customer can pronounce.",
  "what_cheap_alternatives_look_like": "Methylparaben, propylparaben, butylparaben, phenoxyethanol, methylisothiazolinone. All effective preservatives. Several of them are also documented endocrine disruptors or skin sensitizers, which is why label-reading customers avoid them.",
  "citations": []
}
```

- [ ] **Step 5: Add `organic_beeswax` entry**

```json
"organic_beeswax": {
  "name": "Organic Beeswax",
  "role": "moisture-lock barrier",
  "mechanism": "Beeswax forms a breathable barrier on skin that locks moisture in without occluding pores the way petrolatum does. Its long-chain fatty acids and esters create a flexible film that holds skin's own water content while still allowing gas exchange. In lip balm it's the structural ingredient that lets the balm hold a stick shape and stay on the lips through wear.",
  "sourcing": "Organic beeswax from hives certified for organic apiculture practices — bees not exposed to synthetic pesticides or fed sugar syrup. Filtered but not bleached or deodorized.",
  "why_we_chose_it": "Petrolatum and microcrystalline wax are dirt-cheap and shelf-stable forever. They also fully occlude — they trap moisture but block skin's exchange, and microcrystalline wax is a petroleum byproduct. Beeswax does the moisture-lock job while remaining breathable, and customers can verify what it is.",
  "what_cheap_alternatives_look_like": "Petrolatum (Vaseline), paraffin, microcrystalline wax, ozokerite. All petroleum-derived, all cheap, all create a more occlusive film than beeswax. The trade-off is the kind that's not visible until you spend years using them.",
  "citations": []
}
```

- [ ] **Step 6: Add `palm_stearic` entry**

```json
"palm_stearic": {
  "name": "Palm Stearic",
  "role": "natural cream thickener",
  "mechanism": "Palm stearic acid is a saturated fatty acid that gives the body cream its rich, semi-solid texture without synthetic thickeners. It melts at body temperature and emulsifies with water-phase ingredients, allowing the cream to feel firm in the jar but spread and absorb on skin.",
  "sourcing": "Sustainably sourced palm stearic from RSPO-certified or equivalent supply chains. Plant-derived (vs. tallow-derived).",
  "why_we_chose_it": "Stearyl alcohol or PEG-derived thickeners are cheaper to source consistently. We use palm stearic because it's recognizable as a plant fatty acid and works at the texture level we want for the cream — closer to a balm than a lotion.",
  "what_cheap_alternatives_look_like": "Stearyl alcohol (often petroleum-derived unless specified), PEG-100 stearate, polyacrylate-13, or carbomers. Cheaper, more shelf-stable, deliver the same thickness but with synthetic chemistry.",
  "citations": []
}
```

- [ ] **Step 7: Add `organic_red_palm_oil` entry**

```json
"organic_red_palm_oil": {
  "name": "Organic Red Palm Oil",
  "role": "vitamin E and beta-carotene source",
  "mechanism": "Unrefined red palm oil retains its naturally high tocotrienol (a form of vitamin E) and beta-carotene content, both of which contribute antioxidant activity to the formula. Beta-carotene gives the oil its red-orange color — refined palm oil is bleached white and the carotenes are stripped out.",
  "sourcing": "Sustainably sourced organic red palm oil — RSPO-certified or equivalent. Cold-pressed and unrefined to retain the carotenoid and tocotrienol content. Color in the finished product reflects the unrefined oil, not added pigment.",
  "why_we_chose_it": "Refined palm oil is dramatically cheaper, color-neutral, and shelf-stable. Refining strips out the carotenoids and tocotrienols. We use unrefined red palm oil because the antioxidants are why we're using palm oil at all.",
  "what_cheap_alternatives_look_like": "Refined, bleached, deodorized (RBD) palm oil. Identical fatty acid profile, none of the antioxidant content. Often appears simply as 'palm oil' on the back panel — different molecule, different work.",
  "citations": []
}
```

- [ ] **Step 8: Add `saponified_coconut_oil` entry**

```json
"saponified_coconut_oil": {
  "name": "Saponified Organic Virgin Coconut Oil",
  "role": "single-ingredient soap base",
  "mechanism": "Saponification is the chemical reaction between an oil and a strong alkali (sodium hydroxide for bar soap, potassium hydroxide for liquid soap) that produces soap molecules and glycerin as byproducts. With coconut oil as the only fat, the resulting soap is high in lauric and capric acid soap chains — naturally lathering, naturally antimicrobial, recognizable as a true single-ingredient soap.",
  "sourcing": "Organic virgin coconut oil (cold-pressed, unrefined) saponified in small batches with food-grade lye. The lye is fully reacted in the saponification process — no free alkali remains in the finished bar.",
  "why_we_chose_it": "Tallow (rendered beef fat) is the cheapest soap base by a wide margin and is the dominant fat in mass-market bar soap. We use coconut oil for the lather quality, the absence of animal fat, the lauric-acid antimicrobial property, and the single-ingredient simplicity. The customer who reads our label sees one fat name; the same customer reads commercial soap and sees a list.",
  "what_cheap_alternatives_look_like": "Sodium tallowate (animal fat), sodium palmate (palm oil — often unsustainably sourced), or synthetic detergent bars (sodium lauryl sulfoacetate, sodium isethionate). All cheaper, all create a different kind of bar — animal-fat bars feel different on skin and the synthetic bars are technically not soap at all (they're solidified detergent).",
  "citations": []
}
```

- [ ] **Step 9: Validate JSON**

Run: `node -e "console.log(Object.keys(JSON.parse(require('fs').readFileSync('data/brand/ingredient-stories.json'))).length)"`
Expected: `12` (5 original + 7 new).

- [ ] **Step 10: Commit**

```bash
cd /Users/seanfillmore/Code/Claude
git add data/brand/ingredient-stories.json
git commit -m "$(cat <<'EOF'
feat(brand): ingredient stories for Plan 6 cluster ingredients

Adds jojoba, plant emulsifying wax, grapefruit seed extract, beeswax,
palm stearic, red palm oil, and saponified coconut oil — the
cluster-specific ingredients referenced by the new cluster POVs and
required for Plan 6 template generation.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 11: Open PR for foundation work**

Push the branch + open a PR so Sean can review the cluster POVs before the agent runs against them. The cluster POVs are the brand-defining content; agent output will inherit their voice.

```bash
git push -u origin feat/pdp-cluster-povs-all
gh pr create --title "Plan 6 foundation: cluster POVs + ingredient stories" --body "$(cat <<'EOF'
## Summary
- Cluster POVs for deodorant, lotion, cream, bar_soap, liquid_soap, lip_balm (replacing "> TBD — Plan 6" stubs)
- 7 new ingredient stories for cluster-specific ingredients

These are the foundation content the pdp-builder agent reads in cluster mode. Voice + mechanism quality here propagates into every PDP the agent generates downstream — worth a careful read before running the agent.

## Test plan
- [ ] Read each new cluster POV section. Voice matches toothpaste exemplar (family "we", mechanism-forward, no "natural", honest trade-off paragraph).
- [ ] Each ingredient story has all six fields and reads like the toothpaste entries.
- [ ] No fabricated ingredients (every named ingredient is in config/ingredients.json or is a documented mechanism term).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**STOP here. Wait for Sean's review and merge before Phase B.** Cluster POV voice quality is upstream of every later artifact.

---

# PHASE B — Cluster-mode agent runs

After A.1 + A.2 are merged to `main`, run the pdp-builder in cluster mode for each cluster. Each run produces `data/performance-queue/cluster-<name>.json` containing `hookLine`, `mechanismBlock`, `founderBlock`, `ingredientCards`, `faq`. These are inputs to Phase C theme template work.

**Stale artifact note:** `data/performance-queue/coconut-moisturizer.json`, `coconut-soap.json`, `organic-foaming-hand-soap.json` exist from April runs — those predate cluster POVs and should be regenerated.

---

### Task B.0: Archive stale queue items

**Files:**
- Modify: `data/performance-queue/` — move `coconut-moisturizer.json`, `coconut-soap.json`, `organic-foaming-hand-soap.json` to `data/performance-queue/_archived-2026-05-02/` so they don't get confused with fresh output.

- [ ] **Step 1: Make archive subdirectory**

```bash
cd /Users/seanfillmore/Code/Claude
mkdir -p data/performance-queue/_archived-2026-05-02
```

- [ ] **Step 2: Move stale items**

```bash
mv data/performance-queue/coconut-moisturizer.json data/performance-queue/_archived-2026-05-02/
mv data/performance-queue/coconut-soap.json data/performance-queue/_archived-2026-05-02/
mv data/performance-queue/organic-foaming-hand-soap.json data/performance-queue/_archived-2026-05-02/
ls data/performance-queue/
```

Expected: only `cluster-toothpaste.json`, `coconut-oil-toothpaste.json`, and `_archived-2026-05-02/` remain.

(No commit — performance-queue is untracked working data.)

---

### Task B.1: Run cluster mode for `deodorant`

**Files:**
- Generated: `data/performance-queue/cluster-deodorant.json`

- [ ] **Step 1: Run the agent**

```bash
cd /Users/seanfillmore/Code/Claude
node agents/pdp-builder/index.js cluster deodorant
```

Expected output: `Queue item written: data/performance-queue/cluster-deodorant.json` and `Status: pending`.

- [ ] **Step 2: Check validation status**

```bash
node -e "const item=JSON.parse(require('fs').readFileSync('data/performance-queue/cluster-deodorant.json')); console.log('status:',item.status); console.log('errors:',item.validation.errors);"
```

Expected: `status: pending`, `errors: []`. If `status: needs_rework`, read the errors and either fix the foundation content (back to Phase A) OR regenerate (most likely — Claude variance).

- [ ] **Step 3: Spot-check voice and mechanism**

Read `data/performance-queue/cluster-deodorant.json`. Look at:
- `proposed.hookLine` — short, one sentence. Mechanism-forward, not slogan.
- `proposed.ingredientCards` — three cards, each with `name`, `role`, `story`. Stories follow the toothpaste pattern (mechanism, why-not-the-cheap-version, what's omitted).
- `proposed.faq` — 6-8 questions, real ones a deodorant skeptic asks (will it stop sweat? does baking soda irritate?).
- No fabricated ingredients (validators caught those, but spot-check anyway).

If the output reads weakly, regenerate (rerun Step 1). Claude variance is real.

- [ ] **Step 4: Note any rework needs in the plan checklist**

If three regeneration attempts produce weak output, the cluster POV at `data/brand/cluster-povs.md` may need sharpening — circle back to Phase A.

---

### Task B.2-B.6: Repeat B.1 for the remaining 5 clusters

Each task is structurally identical to B.1. Repeat with these commands:

- [ ] **Task B.2 — `lotion`:**
```bash
node agents/pdp-builder/index.js cluster lotion
```
Verify `data/performance-queue/cluster-lotion.json` has `status: pending` and ingredient cards reference jojoba, coconut oil, palm oil (or similar from `lotion.base_ingredients`). FAQs target lotion skeptics (will it grease? sensitive skin? scent strength?).

- [ ] **Task B.3 — `cream`:**
```bash
node agents/pdp-builder/index.js cluster cream
```
Verify `data/performance-queue/cluster-cream.json`. Cards likely reference beeswax, palm stearic, coconut oil (the cream-distinguishing ingredients vs. lotion). FAQs target the heavy-moisturizer customer (eczema-friendly? overnight use?).

- [ ] **Task B.4 — `bar_soap`:**
```bash
node agents/pdp-builder/index.js cluster bar_soap
```
Verify `data/performance-queue/cluster-bar_soap.json`. Single-ingredient base — cards may focus more on the saponification mechanism + variation essential oils rather than 3 separate ingredient stories. FAQs target bar-soap skeptics (will it last? lather like commercial?).

- [ ] **Task B.5 — `liquid_soap`:**
```bash
node agents/pdp-builder/index.js cluster liquid_soap
```
Verify `data/performance-queue/cluster-liquid_soap.json`. Same single-ingredient base; FAQs about foaming dispenser requirement, refill dilution, kid-safety.

- [ ] **Task B.6 — `lip_balm`:**
```bash
node agents/pdp-builder/index.js cluster lip_balm
```
Verify `data/performance-queue/cluster-lip_balm.json`. Cards reference beeswax, coconut oil, red palm oil (lip_balm.base_ingredients). FAQs about chapping, taste, kid-safety.

---

# PHASE C — Theme template per cluster

Each cluster gets its own template file derived from the toothpaste pilot. This is the heaviest work — 6 templates, each with ~600 lines of JSON, each requiring content customization in 11 sections. Work happens in the theme repo on the existing `feat/toothpaste-cluster-template` branch (Sean's strategy: one branch, one push, one cutover).

**Working directory for Phase C:** `~/Code/realskincare-theme/`

**Source template (the canonical pattern):** `templates/product.landing-page-toothpaste.json`. The structure (sections, block_order, custom_liquid CSS) is fixed. Cluster-specific edits are in: hero hook heading, hero ingredient cards, free-from list, founder block body, FAQ entries, buybox benefit lines, per-day price anchor.

**Image assets:** the toothpaste template uses placeholder shop_images. For each cluster, use the existing in-shop images that match the cluster's products. Do NOT block on real photography — use the closest available image per ingredient card (e.g. `shopify://shop_images/Coconut_Oil_Extract.webp` is fine for any coconut card across clusters).

---

### Task C.1: Create `product.landing-page-deodorant.json`

**Files:**
- Create: `~/Code/realskincare-theme/templates/product.landing-page-deodorant.json`

**Inputs:** `data/performance-queue/cluster-deodorant.json` (from Task B.1) + the toothpaste template as the structural pattern.

- [ ] **Step 1: Verify branch state in theme repo**

```bash
cd ~/Code/realskincare-theme
git status
git branch --show-current
```

Expected: branch `feat/toothpaste-cluster-template`, clean working tree.

- [ ] **Step 2: Duplicate the toothpaste template**

```bash
cp templates/product.landing-page-toothpaste.json templates/product.landing-page-deodorant.json
```

- [ ] **Step 3: Replace buybox content for deodorant**

Open `templates/product.landing-page-deodorant.json`. Edit the `main` section's blocks:

- `89424e9e-ae8c-402a-9483-1f35da6dd02e` (star anchor): keep as-is (`2,000+ happy customers`).
- `per-day-anchor` `custom_liquid`: edit to deodorant pricing math. Example draft (Sean to confirm): `<p style="font-size:16px;color:#4a8b3c;font-weight:600;margin:6px 0 14px 0;">Each bottle lasts about 6 weeks of daily use — roughly $0.31 per day.</p>` Use actual deodorant unit economics — ask Sean if pricing math is unclear.
- `benefit-1` text: e.g. `Cold-pressed virgin coconut oil — full lauric acid content` (still applies to deodorant) — confirm against Task B.1 cluster output `hookLine` / `ingredientCards`.
- `benefit-2` text: e.g. `Aluminum-free baking soda — pH balance for odor control`
- `benefit-3` text: e.g. `Organic jojoba — absorbs without a film`
- `benefit-4` text: e.g. `No aluminum, no propylene glycol, no synthetic fragrance`
- `subscribe-benefits` `custom_liquid`: re-use the toothpaste version, but if subscriptions on deodorant differ (Sean: confirm Shopify subscription plan exists for `coconut-oil-deodorant`), update the savings %.
- `subscriptions_anchor` `custom_liquid`: keep `<div class='subscriptions_app_embed_block'></div>`.
- `discount-callout` `custom_liquid`: re-use the toothpaste BUY 2 SAVE 10% / BUY 3 SAVE 20% green dashed box.

- [ ] **Step 4: Replace hook section**

Edit `hook-rich-text` `hook-heading` and `hook-text`:
- `heading`: from cluster-deodorant.json's `hookLine` if present — likely something like `"Stops odor at the source — without aluminum or propylene glycol."`
- `text`: a short hook paragraph from the cluster's `mechanismBlock` (one sentence, brand-confidence). Match toothpaste style (~25-35 words).

- [ ] **Step 5: Replace hero ingredient cards**

Edit `hero-ingredient-cards.blocks`:
- `ingredient-card-1`: pull from cluster-deodorant.json's `ingredientCards[0]` — `title` = card name, `text` = `<p><em>{role}.</em> {story}</p>`. Use `shopify://shop_images/Coconut_Oil_Extract.webp` for the coconut card.
- `ingredient-card-2`: pull from `ingredientCards[1]`. Image = closest match (e.g. `Spring_Water.webp` for baking soda or jojoba, or look in `~/Code/realskincare-theme/assets/` for jojoba imagery).
- `ingredient-card-3`: pull from `ingredientCards[2]`. Image = best match.
- `heading` setting: `"Three ingredients, three jobs"` (matches toothpaste — keep consistent across clusters).

- [ ] **Step 6: Replace free-from block**

Edit `free-from-block.blocks`:
- `free-from-heading.heading`: `"What's NOT in this bottle"` (match deodorant format word).
- `free-from-body.text`: `<p>No aluminum &bull; No propylene glycol &bull; No parabens &bull; No synthetic fragrance &bull; No talc &bull; No phthalates</p>` — derive exact list from the cluster-deodorant.json `mechanismBlock` "what's NOT" mention or the cluster POV in `data/brand/cluster-povs.md`.

- [ ] **Step 7: Replace testimonials**

Edit `testimonial-quotes.blocks`. The toothpaste version has 3 named (Judge.me) + 3 Verified Buyer (Amazon). For deodorant:
- Pull 6 deodorant reviews from Judge.me admin (Real Skin Care store → Judge.me dashboard → coconut-oil-deodorant). Use first names + last initial as Judge.me allows.
- If fewer than 3 Judge.me reviews exist, fall back to "Verified Buyer" generic attribution for the rest. Do NOT label any testimonial "Amazon" — Sean's rule.
- Each card: `title` = name, `text` = `<p><strong>★★★★★</strong></p><p>"{review excerpt}"</p>`. Trim review to ~30-60 words.
- Heading setting: `"What customers say"` — keep consistent.

If pulling reviews proves harder than expected, leave 6 placeholder cards with realistic deodorant pain-point copy and Sean reviews/replaces during sign-off.

- [ ] **Step 8: Replace founder block**

Edit `founder-block.blocks.founder-body.text`:
- Pull from `cluster-deodorant.json` `proposed.founderBlock` (the agent's output for the cluster's per-cluster founder voice). Toothpaste has a flip-the-box origin specific to toothpaste; deodorant version will be a different origin specific to deodorant.
- If the agent's `founderBlock` reads weakly, hand-write a deodorant-specific version (~80-120 words, lead with a specific origin moment, signed `— Sean Fillmore`).
- `heading` stays `"From The Founder"`.

Image setting can stay `shopify://shop_images/Coconut-About_a5199414-98ea-4656-b46e-3e10e2a6f27f.jpg` until real founder photography lands.

- [ ] **Step 9: Replace FAQ**

Edit `collapsible-content.blocks` to use the agent's deodorant FAQ output:
- The toothpaste has 8 FAQs (`faq-0` through `faq-6` plus `faq-2a`). For deodorant, populate 6-8 entries from `cluster-deodorant.json` `proposed.faq`.
- Block keys: keep `faq-0`, `faq-1`, etc. for sort consistency. Update `block_order` array if you change the count.
- Each entry: `heading` = question, `row_content` = `<p>{answer}</p>` (or with `<ul>` if the answer's bullet-formatted like the toothpaste "How is this different" answer).
- Heading: `"FAQs"` — keep.

- [ ] **Step 10: Sanity-check JSON**

```bash
cd ~/Code/realskincare-theme
python3 -m json.tool templates/product.landing-page-deodorant.json > /dev/null
echo "Exit: $?"
```

Expected: `Exit: 0`. If non-zero, JSON is malformed — find the comma/bracket issue.

- [ ] **Step 11: Commit**

```bash
cd ~/Code/realskincare-theme
git add templates/product.landing-page-deodorant.json
git commit -m "feat(theme): deodorant cluster template (Plan 6)

Cloned from product.landing-page-toothpaste.json. Cluster-specific
content from data/performance-queue/cluster-deodorant.json:
- Hero hook
- 3 ingredient cards (coconut, baking soda, jojoba)
- Free-from list (no aluminum, propylene glycol, etc.)
- 6 testimonials (Judge.me + Verified Buyer)
- Founder block (deodorant origin moment)
- FAQ (6-8 deodorant-specific questions)

Buybox structure preserved from toothpaste pilot."
```

---

### Tasks C.2 — C.6: Repeat C.1 for the remaining clusters

Each task follows the same 11-step pattern as C.1 with the cluster-specific inputs from `data/performance-queue/cluster-<name>.json`. Cluster-specific notes:

- [ ] **Task C.2 — `lotion`:**
  - File: `templates/product.landing-page-lotion.json`
  - Free-from heading: `"What's NOT in this bottle"`
  - Free-from list: `No mineral oil &bull; No petrolatum &bull; No propylene glycol &bull; No parabens &bull; No synthetic fragrance &bull; No dimethicone`
  - Per-day anchor: lotion math (estimate $0.40/day; confirm with Sean).
  - Image alternation: `text_first` for founder, `image_first` for free-from (matches toothpaste rhythm).

- [ ] **Task C.3 — `cream`:**
  - File: `templates/product.landing-page-cream.json`
  - Free-from heading: `"What's NOT in this jar"`
  - Free-from list: `No petrolatum &bull; No mineral oil &bull; No dimethicone &bull; No lanolin &bull; No parabens &bull; No phenoxyethanol`
  - Hero ingredient cards favor beeswax, palm stearic, coconut oil (the cream-distinguishing ingredients vs. lotion).

- [ ] **Task C.4 — `bar_soap`:**
  - File: `templates/product.landing-page-bar-soap.json`
  - Free-from heading: `"What's NOT in this bar"`
  - Free-from list: `No tallow &bull; No SLS or SLES &bull; No EDTA &bull; No synthetic fragrance &bull; No parabens &bull; No triclosan`
  - Hero ingredient cards: single-ingredient base means cards focus on (1) saponified coconut oil (the base), (2) the variation's essential oils, (3) "what we leave out" or the lather mechanism. Adjust the agent output as needed.

- [ ] **Task C.5 — `liquid_soap`:**
  - File: `templates/product.landing-page-liquid-soap.json`
  - Free-from heading: `"What's NOT in this bottle"`
  - Free-from list: `No SLS or SLES &bull; No cocamidopropyl betaine &bull; No propylene glycol &bull; No parabens &bull; No triclosan &bull; No synthetic fragrance &bull; No EDTA`
  - Hero ingredient cards similar to bar_soap (single-ingredient base).

- [ ] **Task C.6 — `lip_balm`:**
  - File: `templates/product.landing-page-lip-balm.json`
  - Free-from heading: `"What's NOT in this tube"` (lip balm is a tube)
  - Free-from list: `No petrolatum &bull; No paraffin &bull; No mineral oil &bull; No lanolin &bull; No synthetic flavor &bull; No parabens &bull; No phenol`
  - Hero ingredient cards: beeswax, coconut oil, red palm oil (the three lip-balm ingredients).
  - Per-day anchor: lip balm math (likely "lasts ~3 months daily — about $0.10/day"; confirm with Sean).

---

# PHASE D — Per-SKU product mode

For each Shopify product, run the agent in product mode to generate the SEO title, meta description, and `body_html` (which becomes the product description in Shopify). These outputs apply to the Shopify product, not the theme template — they go through the Shopify Admin API or get pasted manually.

**Important:** the toothpaste pilot used the agent output as a starting point but iterated based on Sean's PDP review. Plan 6 should expect the same — the agent output is a proposal, not final content. Final content gets pasted into Shopify admin only at cutover time.

**Order of products** (matches Phase B/C cluster order):

| Cluster | Product handle | Shopify product title (verify in admin) |
|---|---|---|
| deodorant | `coconut-oil-deodorant` | Real Skin Care Coconut Deodorant (TBD — verify) |
| lotion | `coconut-lotion` | Real Skin Care Coconut Lotion |
| cream | `coconut-moisturizer` | Real Skin Care Coconut Body Cream |
| bar_soap | `coconut-soap` | Real Skin Care Coconut Bar Soap |
| liquid_soap | `organic-foaming-hand-soap` | Real Skin Care Foaming Hand Soap |
| liquid_soap | `foam-soap-refill-32oz` | Real Skin Care Foam Soap Refill 32oz |
| lip_balm | `coconut-oil-lip-balm` | Real Skin Care Coconut Lip Balm |

---

### Task D.1: Run product mode for `coconut-oil-deodorant`

**Files:**
- Generated: `data/performance-queue/coconut-oil-deodorant.json`

- [ ] **Step 1: Run the agent**

```bash
cd /Users/seanfillmore/Code/Claude
node agents/pdp-builder/index.js product coconut-oil-deodorant
```

Expected: `Queue item written: data/performance-queue/coconut-oil-deodorant.json`, `Status: pending`.

- [ ] **Step 2: Inspect the proposal**

```bash
node -e "const i=JSON.parse(require('fs').readFileSync('data/performance-queue/coconut-oil-deodorant.json')); console.log('seoTitle:',i.proposed.seoTitle); console.log('metaDescription:',i.proposed.metaDescription); console.log('bodyHtml chars:',i.proposed.bodyHtml.length);"
```

Validate:
- `seoTitle` ≤ 60 chars (Google snippet limit).
- `metaDescription` ≤ 160 chars.
- `bodyHtml` reads in the cluster voice; no fabricated ingredients; no `aluminum`/`fluoride`/`SLS` etc. inside the bodyHtml as ingredients (validators should have caught — verify).

- [ ] **Step 3: Spot-check voice**

Read `data/performance-queue/coconut-oil-deodorant.json` `proposed.bodyHtml`. Compare against `data/performance-queue/coconut-oil-toothpaste.json` for voice consistency. Both should:
- Lead with the customer's situation, not "introducing".
- Include the mechanism in plain language.
- Mention specific trade-offs (texture, scent, etc.).
- End with the brand's standing-rule honesty.

If voice drifts, regenerate. Persistent drift = sharpen the cluster POV.

---

### Tasks D.2 — D.7: Repeat D.1 for the remaining 6 SKUs

- [ ] **Task D.2 — `coconut-lotion`:**
```bash
node agents/pdp-builder/index.js product coconut-lotion
```

- [ ] **Task D.3 — `coconut-moisturizer`:**
```bash
node agents/pdp-builder/index.js product coconut-moisturizer
```

- [ ] **Task D.4 — `coconut-soap`:**
```bash
node agents/pdp-builder/index.js product coconut-soap
```

- [ ] **Task D.5 — `organic-foaming-hand-soap`:**
```bash
node agents/pdp-builder/index.js product organic-foaming-hand-soap
```

- [ ] **Task D.6 — `foam-soap-refill-32oz`:**
```bash
node agents/pdp-builder/index.js product foam-soap-refill-32oz
```

The refill is a different SKU but shares the `liquid_soap` cluster. Output should emphasize "refill for the foaming dispenser" — confirm in spot-check.

- [ ] **Task D.7 — `coconut-oil-lip-balm`:**
```bash
node agents/pdp-builder/index.js product coconut-oil-lip-balm
```

---

# PHASE E — Push and coordinated cutover

All 6 templates exist locally. All 7 product-mode queue items exist locally. Time for the simultaneous flip.

---

### Task E.1: Push all templates to draft theme

**Files (from Phase C):**
- Push: `~/Code/realskincare-theme/templates/product.landing-page-{deodorant,lotion,cream,bar-soap,liquid-soap,lip-balm}.json`

- [ ] **Step 1: Verify shopify CLI is authenticated**

```bash
cd ~/Code/realskincare-theme
shopify version
shopify auth:logout 2>/dev/null; shopify theme list --store=realskincare-com
```

Expected: list of themes including `145536778410` "PDP-toothpaste-pilot-draft".

- [ ] **Step 2: Push to draft theme**

```bash
cd ~/Code/realskincare-theme
shopify theme push --theme=145536778410 --only=templates/product.landing-page-deodorant.json,templates/product.landing-page-lotion.json,templates/product.landing-page-cream.json,templates/product.landing-page-bar-soap.json,templates/product.landing-page-liquid-soap.json,templates/product.landing-page-lip-balm.json
```

Expected: 6 templates pushed; CLI prints success URLs.

- [ ] **Step 3: Generate preview URLs for Sean's sign-off**

For each cluster, the preview URL is:
```
https://realskincare-com.myshopify.com/products/<handle>?preview_theme_id=145536778410&view=landing-page-<cluster>
```

Print the full list:
```bash
echo "deodorant: https://realskincare-com.myshopify.com/products/coconut-oil-deodorant?preview_theme_id=145536778410&view=landing-page-deodorant"
echo "lotion: https://realskincare-com.myshopify.com/products/coconut-lotion?preview_theme_id=145536778410&view=landing-page-lotion"
echo "cream: https://realskincare-com.myshopify.com/products/coconut-moisturizer?preview_theme_id=145536778410&view=landing-page-cream"
echo "bar_soap: https://realskincare-com.myshopify.com/products/coconut-soap?preview_theme_id=145536778410&view=landing-page-bar-soap"
echo "liquid_soap: https://realskincare-com.myshopify.com/products/organic-foaming-hand-soap?preview_theme_id=145536778410&view=landing-page-liquid-soap"
echo "liquid_soap (refill): https://realskincare-com.myshopify.com/products/foam-soap-refill-32oz?preview_theme_id=145536778410&view=landing-page-liquid-soap"
echo "lip_balm: https://realskincare-com.myshopify.com/products/coconut-oil-lip-balm?preview_theme_id=145536778410&view=landing-page-lip-balm"
```

Note: the preview URLs render even if `template_suffix` is unset on the product, because `?view=` overrides the default.

---

### Task E.2: Sean visual sign-off (manual gate)

**Not a code task. Sean reviews each preview URL, lists issues, agent iterates until Sean approves.**

- [ ] **Step 1: Send preview URLs + cluster POV summaries to Sean**

Compose a message (Slack/text/email) listing all 7 preview URLs + a one-line summary per cluster (e.g. "Deodorant: leads with mechanism — coconut oil + jojoba + baking soda. No aluminum, no propylene glycol.").

- [ ] **Step 2: Iterate per Sean's feedback**

Each round of feedback edits the relevant `product.landing-page-<cluster>.json` and re-pushes via `shopify theme push --theme=145536778410 --only=templates/<file>`. Expect 1-3 rounds per cluster, similar to the toothpaste pilot's iteration.

- [ ] **Step 3: Sean explicit go-ahead**

Do not proceed to E.3 without Sean's explicit "promote to live" instruction. Cutover is irreversible without manual rollback.

---

### Task E.3: Coordinated cutover

**The moment all 7 SKUs flip to the new templates.**

- [ ] **Step 1: Apply Phase D agent outputs to Shopify product fields**

For each of the 7 products, paste:
- Agent's `proposed.seoTitle` → product `seo_title` (Shopify admin → product → SEO).
- Agent's `proposed.metaDescription` → product `meta_description`.
- Agent's `proposed.bodyHtml` → product `body_html` (description editor).
- Any per-SKU metafield overrides (e.g. `custom.scent_notes` per variation) using the helper `createMetafield()` if added programmatically, or by hand.

This step can be done via Shopify Admin API (lib/shopify.js helpers exist) or via the admin UI. Either works. Either way, save each product with the updates BEFORE step 2 — the description swap should be invisible to live traffic until step 3 promotes the theme.

- [ ] **Step 2: Set `template_suffix` on each product**

Set `template_suffix` for each of the 7 products to the corresponding suffix:

| Handle | template_suffix |
|---|---|
| coconut-oil-deodorant | `landing-page-deodorant` |
| coconut-lotion | `landing-page-lotion` |
| coconut-moisturizer | `landing-page-cream` |
| coconut-soap | `landing-page-bar-soap` |
| organic-foaming-hand-soap | `landing-page-liquid-soap` |
| foam-soap-refill-32oz | `landing-page-liquid-soap` |
| coconut-oil-lip-balm | `landing-page-lip-balm` |

(Toothpaste also needs its `template_suffix` set to `landing-page-toothpaste` if it isn't already — confirm via Shopify admin.)

This can be batched via the Admin API:
```javascript
// Pseudocode — one-shot script in scripts/apply-template-suffixes.mjs
import { getProducts, updateProduct } from '../lib/shopify.js';
const map = {
  'coconut-oil-toothpaste': 'landing-page-toothpaste',
  'coconut-oil-deodorant': 'landing-page-deodorant',
  // ... etc
};
const products = await getProducts();
for (const [handle, suffix] of Object.entries(map)) {
  const p = products.find(p => p.handle === handle);
  if (!p) { console.error(`MISSING: ${handle}`); continue; }
  await updateProduct(p.id, { template_suffix: suffix });
  console.log(`set ${handle} -> ${suffix}`);
}
```

**Critical:** until step 3 promotes the draft theme, setting `template_suffix` on a product means the LIVE theme will try to render `product.landing-page-<cluster>.json` from itself. The live theme has the old toothpaste body-lotion-clone at `product.landing-page-toothpaste.json` and likely none of the others. Setting suffixes BEFORE promoting the theme will break the affected product pages until step 3 completes. Run steps 2 and 3 within seconds of each other, ideally back-to-back.

- [ ] **Step 3: Promote draft theme to live**

Either via Shopify CLI:
```bash
cd ~/Code/realskincare-theme
shopify theme publish --theme=145536778410
```

Or via Shopify admin → Online Store → Themes → "PDP-toothpaste-pilot-draft" → Publish.

CLI confirms with the new live theme ID.

- [ ] **Step 4: Verify each live URL renders correctly**

```bash
for handle in coconut-oil-toothpaste coconut-oil-deodorant coconut-lotion coconut-moisturizer coconut-soap organic-foaming-hand-soap foam-soap-refill-32oz coconut-oil-lip-balm; do
  curl -sI "https://realskincare.com/products/$handle" | head -1
done
```

Expected: every URL returns `HTTP/2 200`.

Then visit each URL in a browser:
- Hero buybox renders correctly (star anchor, title, price, per-day anchor, 4 benefits, variant picker, subscribe block).
- Hero ingredient cards (3-up multicolumn) renders.
- Free-from block renders.
- Testimonials (6 cards in 3-column grid, 2 rows) renders.
- Founder block renders with image.
- FAQ collapsible-content renders.
- Loox app block + product-recommendations render.

If anything breaks, the rollback is: Shopify admin → Themes → publish the previous live theme (the body-lotion-clone-on-everything theme). The product `template_suffix` settings stay — they only matter once the new theme is live again.

- [ ] **Step 5: Commit theme state**

If GitHub remote is set up (Sean TODO #5 from handoff), push the branch:

```bash
cd ~/Code/realskincare-theme
git push -u origin feat/toothpaste-cluster-template
```

If no remote yet, this branch lives only on local + Shopify CDN. That's the current state of the toothpaste pilot too — fine for now.

- [ ] **Step 6: Mark project active memory complete**

Update `~/.claude/projects/-Users-seanfillmore-Code-Claude/memory/project_pdp_builder_active.md` to reflect Plan 6 is shipped. Move to a "complete" status note. Delete the now-obsolete `project_pdp_builder_session_handoff_2026_05_02.md`.

---

# Out of scope (intentional)

These are NOT in Plan 6. Document so they don't sneak in:

- **Plan 4 — `/pdp-review` dashboard tab.** Not blocking Plan 6. Manual review via the queue files works for 7 SKUs.
- **Plan 5 — pilot end-to-end.** Subsumed by Plan 6's cutover.
- **GitHub remote for `realskincare-theme`.** Listed as Sean TODO; not a Plan 6 prerequisite.
- **Real founder photography.** Placeholder coconut images stay until real photography lands.
- **Real ingredient photography.** Same.
- **"Best Value" trio bundle product.** Sean TODO; not blocking the per-SKU PDPs.
- **Free shipping threshold.** Sean TODO; lives in Shopify settings.
- **Real third-party badges.** None added; logo-list section was cut per Sean's review.
- **Variation-level metafield overrides for scent notes.** Optional polish; not blocking. Add if the agent's product-mode output includes `metafields` and time permits during cutover.

---

# Risks and rollback

- **Cutover window.** Steps E.3 #2 and #3 must happen in quick succession or live storefront breaks for affected SKUs. Run them in a single shell session, no breaks.
- **Template JSON malformation.** If the JSON breaks, Shopify CLI will reject the push. Catch in C.x step 10 ("python3 -m json.tool"). Don't push broken JSON to Shopify.
- **Cluster POV voice drift.** The cluster POV is upstream of every PDP for that cluster. If the POV reads weakly, every downstream PDP inherits the weakness. Sean's PR review at end of Phase A is the correction point.
- **Agent variance.** Cluster-mode and product-mode outputs can vary run-to-run. The validators catch fabrication. Voice quality is human-judged. Regenerate if a run reads poorly.
- **Forgetting to set template_suffix on the toothpaste product.** Verify in admin during E.3 #2.
- **Stale queue items.** Phase B archives them in `_archived-2026-05-02/` to avoid confusion.

---

# Self-review (writing-plans skill checklist)

- ✅ **Spec coverage:** every cluster from `config/ingredients.json` (deodorant, lotion, cream, bar_soap, liquid_soap, lip_balm) has a Phase A POV task, a Phase B agent run task, a Phase C template task, and at least one Phase D product task. Toothpaste cluster is intentionally NOT in this plan — it's already done. Cutover (Phase E) covers the toothpaste product's `template_suffix` to align with the rest.
- ✅ **No "TBD" placeholders.** Every step has actual content (cluster POV outlines, ingredient JSON entries, free-from lists per cluster, exact CLI commands).
- ✅ **Type consistency:** `template_suffix` values match the file names (e.g. `landing-page-bar-soap` matches `product.landing-page-bar-soap.json`); cluster names match `config/ingredients.json` keys throughout (`bar_soap` not `bar-soap` for the agent, but `bar-soap` for the template-suffix slug).
- ✅ **Honest gaps:** Sean-side dependencies (preview sign-off, real photography, GitHub remote) are called out as manual gates, not silently assumed.

# Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-02-pdp-builder-plan-6-propagate-templates.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task. Phase A could be one subagent (foundation content). Phase B could be 6 subagents in parallel (cluster mode is fast and independent). Phase C is 6 sequential template tasks (each customizes ~600 lines of JSON, takes 15-30 min focused work). Phase D is 7 quick agent runs. Phase E is one coordinated session — best in foreground with Sean.

2. **Inline Execution** — Walk through each phase in this session. Honest expectation: this is a multi-day effort (foundation alone could take a session; templates probably 2 sessions; cutover is its own session).

**Which approach?**
