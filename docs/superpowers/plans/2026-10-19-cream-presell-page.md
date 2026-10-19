# Coconut Moisturizer Pre-sell Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A listicle pre-sell page for the Coconut Moisturizer that Meta ad traffic lands on, ending in a 1-jar $28 Coconut Breeze buy box, plus two fixes to the cream product page (scent from the link, 1 jar preselected).

**Architecture:** Theme code only. A new section `presell-listicle` rendered by a new page template `page.presell-cream.json`, with copy held in section/block settings so it can be edited in the theme editor. Buy box JS in its own asset. Media (creator stills + compressed video clips) lives in Shopify Files. Copy compliance is pinned by node tests that read the template JSON.

**Tech Stack:** Shopify Liquid / theme JSON (Be Yours 9.4.0, live theme `148782940330`), vanilla JS, Node 22 `node:test`, Shopify Admin REST/GraphQL via `lib/shopify.js`, ffmpeg.

**Spec:** `docs/superpowers/specs/2026-10-19-cream-presell-page-design.md`

## Global Constraints

- Ingredient wording: always "7-ingredient base"; scented versions add their scent on top (Sean). Coconut Breeze's addition is "organic coconut oil extract".
- Base ingredients, verbatim from `config/ingredients.json` `cream.base_ingredients`.
- Comparison label: Palmer's Coconut Oil Formula body lotion, ingredients copied word for word, source URL + date recorded in the PR; the brand name never appears on the page ("a popular drugstore coconut lotion").
- All page copy and video transcripts pass `checkSeoCopyFields` (`lib/seo-copy-health-gate.js`) on the default commercial surface.
- No em dashes (U+2014) in customer copy. No petroleum ingredient names (mineral oil, petrolatum, paraffin). Never "antiperspirant". No competitor brand names. No disease names beside the product.
- Reviews: verified Judge.me reviews, quoted word for word with first name + initial.
- Buy box: 1 jar, $28, Coconut Breeze (`variant 44179428475050`) preselected; other scents selectable; no ladder, no subscription widget. Button: `POST /cart/add.js` then `location = '/checkout'`.
- No video above the fold; videos muted/loop/autoplay/playsinline, lazy-loaded, captioned, with poster. Exclude Marvin Aboagye's video.
- Page is `noindex` (`seo.hidden` metafield = 1) and out of the sitemap.
- Theme JSON written with `\/` escaping preserved; theme changes go live only via preview theme + read-back + rendered-page check.

## Review Focus

1. **Visitor arrives with `?trybe=...&utm_*` and buys** → the tag must survive to the order's `landing_site` (it does, since the pre-sell is the landing page) and nothing on the page may redirect and drop it. Test: Task 3 JS test asserts the checkout URL is `/checkout` with no navigation before it, and the page template carries no redirect.
2. **`/cart/add.js` fails (out of stock scent, network)** → button shows an error and re-enables; never navigates to an empty checkout. Test in Task 3.
3. **Scent picker changed then buy** → the selected variant id is what's posted, not the default. Test in Task 3.
4. **Cart already holds other items** → add.js adds 1 jar; checkout shows both. Accept (no cart clearing). Manual check in Task 5.
5. **PDP link with a variant id of a scent the 4-pack lacks / unknown id** → ladder falls back to its default scent without error. Test in Task 4.

---

### Task 1: Content, compliance and media

**Files:**
- Create: `data/presell/coconut-cream/content.json` (all copy, review quotes, label lists, media choices with Trybe submission ids)
- Create: `scripts/presell/prepare-cream-media.mjs` (downloads chosen Trybe assets/ad stills, ffmpeg-compresses videos, uploads to Shopify Files, writes `data/presell/coconut-cream/media.json` with CDN URLs). Dry by default; `--apply` uploads.
- Test: `tests/theme/presell-cream-copy.test.js`

**Interfaces:**
- Produces: `content.json` shape: `{ headline, eyebrow, intro, reasons: [{ n, title, body, media: { kind: 'image'|'video', key } }], reviews: [{ quote, name }], ourLabel: string[], theirLabel: { ingredients: string[], sourceUrl, checkedOn }, guarantee, buyBox: { title, priceNote, shipping } }`; `media.json`: `{ [key]: { url, poster?, kind } }`.

- [ ] Step 1: Collect inputs. Palmer's Coconut Oil Formula body lotion ingredient list from the manufacturer site (WebFetch); Judge.me verified reviews for `coconut-moisturizer` (pick 3-4 about texture/thickness/winter, verbatim); transcripts of the chosen Trybe videos (Rebecca West "read the label", Kaitlynn Eliason "butter", Kristin Crane "just shaved") via `lib/trybe.js` `listSubmissions`. Confirm each video shows the jar, not a pump (view thumbnail).
- [ ] Step 2: Write the failing test. For every string in `content.json` plus every chosen video transcript: `checkSeoCopyFields({...}).ok === true`; no `—`; no `/palmer/i`; no `/mineral oil|petrolatum|paraffin|antiperspirant/i`; `ourLabel` deep-equals `config/ingredients.json` `cream.base_ingredients`; headline matches `/7-ingredient base/`; `theirLabel.ingredients.length >= 20` OR the page copy's count equals its real length; no media key references Marvin Aboagye's submission id.
- [ ] Step 3: Run `node --test tests/theme/presell-cream-copy.test.js`; expect FAIL (file missing).
- [ ] Step 4: Write `content.json` (listicle per spec: 5 reasons, headline "5 reasons people are switching to a body cream with a 7-ingredient base this winter").
- [ ] Step 5: Run the test; expect PASS (fix copy, never the test, on a gate hit).
- [ ] Step 6: Write and run `prepare-cream-media.mjs` dry, then `--apply`. Videos: H.264, ≤720px wide, ≤ ~1.5 MB each, ~15 s max, muted track stripped, poster jpg from first good frame. Uploads use `stagedUploadsCreate`/`fileCreate` (generalise `uploadImageToShopifyCDN` to accept a mime type for `video/mp4` if needed; Shopify Files video returns a `Video` with `sources[]` — record the mp4 source URL).
- [ ] Step 7: Commit `content.json`, `media.json`, script, test.

### Task 2: Section + template

**Files:**
- Create: `theme/sections/presell-listicle.liquid`, `theme/assets/presell.css`
- Create: `theme/templates/page.presell-cream.json`
- Create: `scripts/presell/build-cream-template.mjs` (renders `content.json` + `media.json` into the template JSON's section/block settings, serialising with `\/` escaping)
- Test: `tests/theme/presell-cream-template.test.js`

**Interfaces:**
- Consumes: Task 1 `content.json`, `media.json`.
- Produces: section type `presell-listicle` with block types `reason`, `reviews`, `label-compare`, `buy-box`; buy-box markup contract used by Task 3: `<form data-presell-buy>` containing `<select name="id">` (one `<option value="<variant_id>">` per scent of `coconut-moisturizer`, Coconut Breeze `selected`), `<button type="submit" data-presell-submit>`, `<p data-presell-error hidden>`; sticky bar `<a data-presell-sticky href="#presell-buy">`.

- [ ] Step 1: Failing test: template parses; section type is `presell-listicle`; every text setting value equals the corresponding `content.json` string (so the copy test covers what ships); the first block above the fold holds no `video`; every video block has `poster`, and the section source contains `muted`, `loop`, `playsinline`, `preload="none"`; the buy-box block's default variant is `44179428475050`; the section emits `<meta name="robots" content="noindex">` is NOT required (handled by metafield) but the source contains no `<script src` to third parties; re-serialising the JSON with the build script is byte-identical (idempotent, `\/` preserved).
- [ ] Step 2: Run; expect FAIL.
- [ ] Step 3: Write the section (mobile-first, theme fonts, cream/green palette per spec; reason cards with image or lazy video — IntersectionObserver swaps `data-src` to `src` and calls `play()`; label-compare two-column; reviews; guarantee; buy box with product image, $28 from `all_products['coconut-moisturizer']` live price, scent select from that product's variants, "Ships in 1-2 business days"; sticky phone CTA "Get Coconut Breeze, $28" shown after the hero scrolls out). No Recurpay block. Then run the build script to write the template.
- [ ] Step 4: Run tests; expect PASS. Run `node scripts/audit-theme-templates.mjs` if it accepts a single template, to catch claim regressions.
- [ ] Step 5: Commit.

### Task 3: Buy box JS

**Files:**
- Create: `theme/assets/presell-buy.js` (exports via `window.PresellBuy` and, for tests, a CommonJS-compatible factory `createBuy({ fetch, navigate })`)
- Test: `tests/theme/presell-buy.test.js`

**Interfaces:**
- Consumes: Task 2 markup contract.
- Produces: `createBuy({ fetch, navigate }).submit(variantId: string) -> Promise<{ ok: boolean, error?: string }>`.

- [ ] Step 1: Failing tests: `submit('44179428475050')` posts JSON `{ items: [{ id: 44179428475050, quantity: 1 }] }` to `/cart/add.js` then calls `navigate('/checkout')` exactly once; a non-2xx (e.g. 422 sold out) returns `{ ok:false }` with Shopify's `description` and never navigates; a rejected fetch returns `{ ok:false, error }` and never navigates; double-submit while pending posts once; submitting a changed select posts the selected id.
- [ ] Step 2: Run; expect FAIL.
- [ ] Step 3: Implement; wire in the section with `defer`; on error show `[data-presell-error]` text and re-enable the button.
- [ ] Step 4: Run; expect PASS. `node --check theme/assets/presell-buy.js`.
- [ ] Step 5: Commit.

### Task 4: Cream PDP fixes

**Files:**
- Modify: `theme/templates/product.landing-page-cream.json` (ladder block: `ladder_default` → `coconut-moisturizer`; ladder script reads `?variant=`)
- Test: `tests/theme/cream-pdp-ladder.test.js`

- [ ] Step 1: Pull the LIVE template first (`node scripts/update-theme-asset.mjs get templates/product.landing-page-cream.json` or `getThemeAsset`) and diff against the repo copy; if live differs, take live as the base.
- [ ] Step 2: Failing tests (source scan of the template JSON): `ladder_default = "coconut-moisturizer"`; the ladder script reads `URLSearchParams(location.search).get('variant')`, maps the id to a scent name via the 1-jar product's variants, and selects that scent in the ladder's scent select for every tier; an unknown id leaves the default. Extract the scent-mapping function from the block into a testable pure function string (or mirror it in `theme/assets/` if the block already loads an asset) and run it against: Coconut Breeze id → "Coconut Breeze"; unknown id → null.
- [ ] Step 3: Run; expect FAIL.
- [ ] Step 4: Implement with minimal edits; serialise with `\/` escaping so the diff against live is only these lines.
- [ ] Step 5: Run; expect PASS. Commit.

### Task 5: Ship and verify

**Files:**
- Create: `scripts/presell/publish-cream-presell.mjs` (dry by default): creates/updates the Shopify page (handle `coconut-body-cream`, title "Coconut Body Cream", `template_suffix: presell-cream`, published), sets `seo.hidden` = 1 (`number_integer`), writes theme assets to a preview copy or live with a guard.

- [ ] Step 1: Duplicate the live theme (GraphQL `themeDuplicate`) → preview id. Write `sections/presell-listicle.liquid`, `assets/presell.css`, `assets/presell-buy.js`, `templates/page.presell-cream.json`, `templates/product.landing-page-cream.json` to the preview with `updateThemeAsset`; read each back and compare to git (poll; read-backs lag).
- [ ] Step 2: Create the page (unpublished first) and render it through the preview with a cookie-following fetch (`?preview_theme_id=` then plain URL). Puppeteer at 390×844: screenshot the fold (headline + still, no video element above fold), full page, and the PDP with `?variant=44179428475050` (Coconut Breeze, 1 jar selected). Click buy → lands on `/checkout` with 1 Coconut Breeze jar; change scent → that scent; check videos load only on scroll and page weight before scroll.
- [ ] Step 3: Go live: write the five files to the live theme only if each live file still equals what was read at Step 1 (guard), read back, publish the page, set `seo.hidden`. Verify the live rendered page with curl (new markup present, `noindex` meta present) and Puppeteer again; confirm the page is absent from `/sitemap.xml`.
- [ ] Step 4: Verify Meta AddToCart fires on the buy click (Puppeteer: capture requests to `facebook.com/tr` or Shopify web pixel `monorail` events with `product_added_to_cart`). If it does not fire, report it; do not add a second pixel.
- [ ] Step 5: Commit, push branch, open PR (body: what shipped, Palmer's source URL + date, screenshots, the AddToCart result, the follow-up to repoint ads at `https://www.realskincare.com/pages/coconut-body-cream?…` keeping `trybe=` tags). Merge after review; theme is already live by Step 3.
