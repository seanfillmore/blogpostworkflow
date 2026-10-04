# Ad Structures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. TDD in every task: write the failing test, see it fail, implement, see it pass, commit.

**Goal:** Replace `agents/ad-concepts`' invented-concept stage with a library of long-running competitor ad structures; the model only fills slots; layouts are code.

**Architecture:** `data/ad-structures/library.json` (data) + `agents/ad-concepts/structures.js` (load/validate/select) + `evidence.js` (reviews, offer, value lines, slot filling) + `layouts/*.js` (one HTML layout per visual shape) + the existing rendering/verify/typeset/flexible-copy machinery, orchestrated by a rewritten `index.js`. Plus `research.js` (on-demand Ad Library refresh producing candidates).

**Tech:** Node 22 ESM, `node --test`, `lib/anthropic.js`, `@google/genai` via Ad Studio's `renderVariationWithBackoff`, Puppeteer + sharp, `lib/brand-fonts.js`.

**Spec:** `docs/superpowers/specs/2026-10-03-ad-structures-design.md`. Research assets and the APPROVED reference implementation: `docs/superpowers/specs/assets/2026-10-03-ad-structures-research/` — `approved-reference-make.mjs` produced the three ads Sean approved (`approved/*.jpg`); the comment-card, headline-over-photo and split-two-panel layouts must reproduce those HTML layouts.

**Plan note (deviation from the full-code plan format):** tasks give exact interfaces, file paths, behaviours and test cases; implementers write the code. The approved reference script supplies the exact HTML/CSS for three layouts.

## Global Constraints
- Node 22 (`source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null`); report `fail` AND `cancelled`; full suite must stay 0/0.
- Never import `@anthropic-ai/sdk`; use `lib/anthropic.js`. Agent entry points guarded by `isDirectRun`.
- No em dash (U+2014) in any published string. RSC sells a deodorant, never an antiperspirant. No named competitor in published copy. No before/after of skin/body. Reviews quoted verbatim only, attributed "Customer review".
- Offers only from `--offer`, verified equal to the landing product's live `price` and `compare_at_price`; otherwise a value line from the allowlist.
- Ad Studio files and their existing test assertions must not change except where a task says so.
- Never run the agent live inside a task (stubbed deps only). Never weaken a gate to pass a fixture.
- `notify()` deferred only; `status:'error'` only when the agent broke.

## Review Focus
1. A library entry with an unknown layout, missing source image or bad status must fail at LOAD, before any paid call (Task 1).
2. An `--offer` whose numbers differ from the live store by a cent must abort before any paid call (Task 2).
3. A quote longer than `maxChars` is cut at a sentence boundary, never mid-sentence and never with edited words; if no sentence fits, that review is skipped (Task 3).
4. A long headline or quote never overflows its layout region (fit-to-box like typeset.js) (Task 4).
5. A product-free plate (split left panel) with readable stray text fails (Task 5).

---

### Task 1: Structure library — schema, loader, selection, seeded data
**Files:** create `data/ad-structures/library.json`, `data/ad-structures/sources/*.jpg` (copy the 14 JPEGs from the spec assets `sources/`), `agents/ad-concepts/structures.js`; test `tests/agents/ad-structures-library.test.js`.
**Produces:**
- `LAYOUTS = ['comment-card','headline-over-photo','split-two-panel','checklist-split','photo-only','labelled-bundle']`
- `EVIDENCE = ['review','offer','catalogFact','bundleLanding']`
- `loadLibrary(path = DEFAULT_LIBRARY_PATH) → { version, structures }` — throws naming the structure id on: unknown `layout`, `status` not in approved|candidate|retired, empty `sources`, a source `image` file that does not exist (resolved relative to the library dir), a `requires` value not in EVIDENCE, missing `scene.primary`, `ratio` not in ['1:1','4:5'], `fits` empty.
- `eligible(lib, { productKinds: string[], evidence: Set<string> }) → structure[]` — approved only; every `requires` in `evidence`; `fits` intersects `productKinds`.
- `selectStructures(list, { slots = 3, override = [] }) → structure[]` — override ids first (throw if an override id is not eligible, naming why); then by max source `days` desc; never two with the same `layout`.
Seed the six structures exactly as the spec table (ids, layouts, sources with brand/days/adLibraryUrl from `ads.json`/the research table, requires, people: texture-scoop `hands`, others `none`). Scene recipes: port the three from `approved-reference-make.mjs` with `{productNoun}`/`{productDescriptionShort}` placeholders; fallback = a standing-and-large framing. Slots per spec. Tests: valid library loads; each invalid case throws with the id; eligibility skips a structure whose evidence is missing and one whose fits doesn't match; offer-only `labelled-bundle-offer` absent without `offer`+`bundleLanding`; selection order and layout distinctness; override honoured and invalid override throws; the real `data/ad-structures/library.json` loads.

### Task 2: Landing product and offer verification
**Files:** create `agents/ad-concepts/landing.js`; test `tests/agents/ad-structures-landing.test.js`.
**Produces:**
- `fetchLanding(handle, { fetchImpl = fetch, siteUrl = 'https://www.realskincare.com' }) → { handle, title, url, variants:[{title, price:Number, compareAt:Number|null}] }` — reads `/products/<handle>.json`; throws on non-200 naming the URL.
- `parseOffer(text) → { price, wasPrice }` — extracts the first two `$N(.NN)` amounts (price first, was second); throws if fewer than two or was ≤ price.
- `verifyOffer(offer, landing) → { ok, reason, band }` — ok only when some variant has `price === offer.price && compareAt === offer.wasPrice` (exact to the cent); `band` = `${SHORT_TITLE} $${price} (WAS $${was})` uppercased where SHORT_TITLE is the landing title stripped of " | …" suffixes; no em dash.
- `valueLines({ brandKit, catalogEntry }) → string[]` — allowlist: `FREE SHIPPING ON ORDERS OVER $${brandKit.free_shipping_threshold}` when set; `MADE IN THE USA` when the brand kit says so (search its text); `ONLY ${n} CLEAN INGREDIENTS` when the catalog title contains "Only N Clean Ingredients" (case-insensitive).
Tests with a stubbed fetch: Sensitive Skin Set `46.80/58.00` verifies; `46.79` fails; one amount fails; was≤price fails; 404 throws; value lines from a fixture brand kit/catalog and from the real files.

### Task 3: Evidence — review screening, verbatim quote picking, template slots
**Files:** create `agents/ad-concepts/evidence.js`; test `tests/agents/ad-structures-evidence.test.js`.
**Produces:**
- `DISEASE_EXTRA` (frozen): diabetic, diabetes, cuts, wound(s), burn(s) (as a skin verb/noun — match `\bburns?\b`), rash, psoriasis, eczema, dermatitis.
- `screenReviews(reviews, { variant, siblingVariants, competitorNames }) → { kept: string[], dropped: [{text, reason}] }` — drops: `findHealthClaims` hits, DISEASE_EXTRA word-boundary hits, `variantConflicts`, `namedCompetitors`, em dash, length < 25 chars, product-title-only strings (e.g. "Coconut Moisturizer | 4oz"). The two real reviews "…helps my diabetic skin! …" and "…It also doesn't burn my cuts." MUST be dropped (tests).
- `truncateAtSentence(text, maxChars) → string|null` — returns the longest prefix made of whole sentences (split on `.!?` followed by space/end) within maxChars; null if the first sentence alone is too long; never alters characters.
- `buildQuotePickPrompt({ structure, reviews }) / parseQuotePick(text, n) → index` — the model returns `{"index": k}`; out of range or unparseable → throw.
- `quoteFromPick(reviews, index, maxChars) → string` — verbatim via truncateAtSentence; throws if null.
- `templateSlot(structure, slotName, { product }) → string` — deterministic strings: `they-think-we-sell` labels `${productNoun} they think we sell` / `${productNoun} we actually sell` (productNoun e.g. "Coconut lotion", "Body cream"); checklist rows: ours from catalog/PDP phrases that `checkClaimsSourced` accepts verbatim (e.g. "Only 6 clean ingredients", "Made in the USA"), theirs = generic category negatives fixed in the library entry (e.g. "Long ingredient list", "Synthetic fragrance") — theirs rows must not name a brand.
- `fillModelSlot({ anthropic, model, structure, slotName, evidence, sourceIndex, competitorNames, variant, siblingVariants }) → string` — one call, gated with `gateCopy` + `maxWords`, one regeneration naming the failure; max_tokens throws.
Tests for each, incl. verbatim guarantee (output is a substring of the input), sentence-boundary cases, the two real reviews dropped, and a model slot regenerated once on an em dash.

### Task 4: Layouts — registry, six layouts, shared band, layout renderer
**Files:** create `agents/ad-concepts/layouts/index.js` + one file per layout + `band.js`; modify `agents/ad-concepts/typeset.js` to export `renderLayoutHtml({ html, width, height, browser }) → { buffer, overflow }` (shared Puppeteer path with brand fonts; page closed in finally; reports overflow via a `data-fit` contract: every element with `data-fit` is shrunk until it fits its box, `window.__fit.overflow` true if any still overflows). Test `tests/agents/ad-structures-layouts.test.js`.
**Each layout:** `export default { key, size(ratio)→{width,height}, plates: 1|2, regions(ratio)→[{name,x,y,w,h}], render({ plates:[dataUrl], slots, ratio }) → html }`.
- `comment-card` (1:1, 1080²): port reference A exactly — headline top-centre with the red underline on the emphasised word (`slots.emphasis`), grey avatar circle, bubble with "Customer review" label + quote, Like · Reply line (#3a3b3c bold), black band 104px.
- `headline-over-photo` (1:1): reference B — headline top-left, two lines max.
- `split-two-panel` (4:5, 1080×1350): reference C — two panels 538px with a 4px gap, labels top-centre with text-shadow, sand (#EDE5D8) band 104px.
- `checklist-split` (4:5): two columns "Ours" / "Typical {category}" with ✓/✗ rows over a light plate, band.
- `photo-only` (1:1 or 4:5): plate + optional band.
- `labelled-bundle` (1:1): plate + 2-4 callout labels with thin leader lines (positions in slots) + band.
Tests: each renders the exact slot strings (HTML-escaped) and pixel size; long quote/headline → overflow false (shrinks); `regions()` boxes lie within the frame; band text appears.

### Task 5: Plate checks — product-free stray-text check; scene prompt with fallback
**Files:** create `agents/ad-concepts/plates.js`; modify `agents/ad-concepts/shots.js` (`runConceptTakes` gains `fallbackPrompt` + `primaryTakes=2`, `fallbackTakes=2`, keeping old defaults working); test `tests/agents/ad-structures-plates.test.js`.
**Produces:**
- `buildStrayTextPrompt()` / `parseStrayText(text) → { ok, detail }` fail-closed / `checkStrayText({ anthropic, model, buffer, mediaType })` (max_tokens throws).
- `buildScenePrompt({ structure, which: 'primary'|'fallback', product, brandKit }) → string` — fills `{productNoun}` etc., appends the phone-shot preamble, "no text except our label", unit block, label-ink line, and `buildProductFidelityBlock(product, { allowPeople: structure.people !== 'none' })`; for a product-free plate (split left) only the preamble + scene + "no logo, no printing, no text anywhere".
- `runConceptTakes` with `fallbackPrompt`: up to `primaryTakes` on the primary prompt; if none passes and budget remains, up to `fallbackTakes` on the fallback prompt (then the existing repair round is NOT used when a fallback is given). Existing callers/tests unchanged.
Tests: prompt contents; product-free prompt has no fidelity block; fallback used after 2 primary fails; stray-text parser fail-closed.

### Task 6: Orchestrator rewrite + retire invented concepts + docs
**Files:** rewrite `agents/ad-concepts/index.js`; delete invented-concept code from `concepts.js` (`FAMILIES`, `SCENE_TEXT`, `TYPE_BANDS`, `AWARENESS` if unused, `JUDGE_CRITERIA`, `CONCEPT_TACTIC_SKILLS`, `buildConceptTactics`, `normalizeFamily`, `normalizeConcept`, `parseConceptsResponse`, `buildConceptPrompt`, `buildJudgePrompt`, `parseJudgeResponse`, `pickConcepts`, `nextReplacement`, `preGate` if unused) and from `copy.js` what only served it (`buildOverlayCopyPrompt`, `writeOverlayCopy` if unused); delete their tests; keep and test `checkClaimsSourced`, `mentionsCompetitor`, `namedCompetitors`, `variantConflicts`, `gateCopy`, `writeFlexibleCopy`. Update `agents/ad-concepts/README.md` and the CLAUDE.md ad-concepts paragraph. Tests: rewrite `tests/agents/ad-concepts-orchestrator.test.js` for the new flow.
**Args:** `--products a,b` (required), `--variant`, `--landing` (default: the single product), `--offer "<text>"`, `--structures id,id`, `--max-renders` (30), `--dry-run` (stops after selection + slot filling, writes `plan.json`, no image call).
**Flow (`runAds({ args, deps })`):** load library → load evidence per product (existing `buildEvidenceProduct`/photo guard/label guard per product; product kind from manifest description: "squeeze bottle"→lotion, "jar"→cream) → fetchLanding → offer verify (abort before paid calls on mismatch) → evidence set (`review` if ≥1 screened review, `offer`, `catalogFact`, `bundleLanding` if landing title matches /set|bundle|kit/i) → eligible/select (≥2 or abort) → per structure: fill slots (quote by index, model headline, template slots, band) → render plate(s) with primary/fallback (product plate via verifyImage; product-free plate via checkStrayText) → layout render → critique (existing `critiqueArtifact`, mode finished) + occlusion (existing `checkOcclusion` with the layout's product region) → final. Per-structure failure → replaced by the next eligible structure with an unused layout. Then `writeFlexibleCopy` (concepts = structures, product = landing) → manifest (landing URL + price; `short`, `needsHumanReview`) → `run.json` (`structures` with source days, `landing`, `offer`) → archive → deferred notify. Crash safety and SIGINT/SIGTERM as today.
Tests (all stubbed): full run writes 3 finals + manifest with the landing URL; offer mismatch aborts with zero render/model calls; dry run writes plan.json with no render; a structure whose plate fails all takes is replaced; needsHumanReview for texture-scoop (hands).

### Task 7: Research refresh command
**Files:** create `agents/ad-concepts/research.js` (isDirectRun), `data/ad-structures/brands.json` (the 36 advertisers + keyword list from the research), `data/ad-structures/candidates/.gitkeep`; test `tests/agents/ad-structures-research.test.js` (pure parts only).
Productize `scripts/collect.mjs`, `filter.mjs`, `select.mjs` from the spec assets: pure `parseLibraryResponse(text) → ads[]` (the graphql/script JSON walker), `daysRunning(startEpoch, now)`, `isBodyCareAd(ad)` (lotion/cream/butter/balm keyword filter excluding face serum/fragrance/deodorant/soap), `rankCandidates(ads, { minDays: 90 })`; an I/O `collect({ brands, keywords, browserFactory })` using headful Chrome (`headless:false`, system Chrome path), paced 3s+, stopping on a login wall; a vision tagging call (format + `nonTransferable` reasons) with fail-closed parsing; writes `candidates/<date>.json`, compressed screenshots, a markdown report; `--approve <id>` appends a `candidate`-status library entry (never `approved`). Deferred notify. Tests: parser on a recorded fixture blob (save one small sample from the research run if available, else synthesize from the documented shape), days/filter/rank, approve writes candidate status only.

### Task 8: Full suite, dry run, live acceptance, PR
- [ ] `npm test` → 0 fail / 0 cancelled.
- [ ] `node agents/ad-concepts/index.js --products coconut-moisturizer,coconut-lotion --variant pure-unscented --landing sensitive-skin-starter-set --offer "Sensitive Skin Set \$46.80 (was \$58)" --dry-run` → plan.json picks comment-card-offer, texture-scoop, they-think-we-sell (or explain), quotes verbatim, band = verified offer.
- [ ] Same without `--dry-run` → 3 finals + flexible-ad.md; compare by eye to `approved/*.jpg`.
- [ ] PR, merge, deploy (per repo rules).
