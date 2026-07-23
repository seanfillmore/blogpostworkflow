# JS Error Diagnosis — realskincare.com (Phase 0 Task 2)

**Date:** 2026-07-22
**Method:** headless Chromium (Puppeteer, iPhone-13 emulation — ~69% of traffic is mobile), `scripts/capture-console-errors.mjs`, over homepage + hero PDP + a top blog landing page. Confirmed against rendered HTML via `curl`.
**Trigger:** Clarity `scriptErrorPct` 12.4% (up from 10.4% in April) — a top suspect for the ~0.85% true CVR.

## Findings (ranked by impact)

### 1. `twq is not defined` — orphaned Twitter/X pixel (PRIMARY — fires on EVERY page) 🔴
- **Error:** uncaught `ReferenceError: twq is not defined` at homepage `:462` and PDP `:495`, **plus** a second copy inside the Shopify custom web pixel (`/web-pixels@.../custom/...`).
- **Root cause:** the theme includes a **Twitter conversion tracking event** snippet (homepage HTML lines ~460–466):
  ```html
  <!-- Twitter conversion tracking event code -->
    twq('event', 'tw-odnr8-pz09i', { ... });
  <!-- End Twitter conversion tracking event code -->
  ```
  but the Twitter base pixel library (`https://static.ads-twitter.com/uwt.js`, which defines `twq`) is **never loaded** (zero references in the page; only `twitter:card` meta tags exist). So `twq()` throws on every page.
- **Fix (minimal):** remove the orphaned Twitter event snippet from the theme (likely `theme.liquid` or a tracking snippet include) **and** delete/disable the matching Twitter code in the Shopify **custom web pixel** (Settings → Customer events). RSC is not running Twitter/X ads, so removal is correct; do NOT "fix" it by loading `uwt.js`.
- **Blast radius:** an uncaught error early in page execution can halt *subsequent* inline scripts in the same block. This is the highest-value fix and almost certainly the largest share of the 12.4%.

### 2. `Identifier 'MulticolumnVideoItem' has already been declared` — theme double-include (PDP) 🟠
- **Error:** uncaught `SyntaxError` on the hero PDP — a `MulticolumnVideoItem` class/const is declared **twice**, so the whole script block fails to parse.
- **Root cause:** the multicolumn-video section's JS is included more than once on the PDP (section rendered twice, or the script asset loaded without a one-time guard).
- **Fix:** load the script once, or guard it: `if (!customElements.get('multicolumn-video-item')) { class MulticolumnVideoItem … }` (or wrap the `<script>` include so it can't render twice per page).

### 3. `SecurityError: Blocked a frame with origin "null" … cross-origin` (homepage) 🟡
- Cross-origin iframe access error — typically a third-party embed (video/widget) whose script pokes at the parent frame. Usually benign to conversion but adds to the error count. Identify the embed; low priority.

### 4. Analytics/ads beacons aborting — FLAG FOR TASK 3 (tracking), not confirmed broken ⚠️
- Many `net::ERR_ABORTED` on `analytics.google.com/g/collect`, `google.com/ccm/collect`, `google.com/rmkt/collect/10923654107`, `google.com/pagead/1p-conversion/10923654107`, `monorail-edge.shopifysvc.com`, TikTok, DoubleClick; plus `HTTP 401` on `/sf_private_access_tokens`.
- **Caveat:** in a headless, no-consent session, Shopify Consent Mode / Customer Privacy blocks marketing pixels, which *legitimately* aborts these — so this is **not proof they fail for real consented users.** BUT the aborting **Google Ads conversion beacons (account `10923654107`)** are exactly the kind of breakage behind "past Google Ads lost money on broken tracking." **Action (Task 3):** verify with Google Tag Assistant / a real consented session whether the conversion + `g/collect` beacons actually fire; this is the server-side-tracking work, not a theme fix.

## Recommended fix order
1. Remove the orphaned Twitter pixel (theme snippet + custom web pixel) — biggest, safest win.
2. Dedupe the `MulticolumnVideoItem` declaration on the PDP.
3. Re-pull Clarity after 3 days: `node -e "import('./lib/clarity.js').then(m=>m.fetchClarityInsights({numOfDays:3}).then(c=>console.log(c.behavior)))"` → expect `scriptErrorPct` well below 12.4%.
4. Address #4 inside Task 3 (tracking), with a consented Tag-Assistant check.

## Reproduce
`node scripts/capture-console-errors.mjs` (defaults to homepage + hero PDP + top blog page; pass URLs to target others).

---

## RESOLUTION (2026-07-22, applied to live theme 145536778410)

Two of the three JS errors fixed directly in the theme via Admin API; verified live with Puppeteer (homepage + PDP, cache-busted, two consecutive clean reads).

1. **✅ `twq` orphaned Twitter pixel — FIXED.** Removed the `//X Ads` / `<!-- Twitter conversion tracking event code -->` block (the `twq('event','tw-odnr8-pz09i',…)` call) from `layout/theme.liquid`, leaving the surrounding Ahrefs loader intact. This also removed the invalid `<!-- -->` HTML comments inside the `<script>`. Confirmed gone from homepage and PDP after CDN propagation. Original backed up at `docs/reports/theme-backups/2026-07-22/theme.liquid.orig`.
2. **✅ `MulticolumnVideoItem` double-declaration — FIXED.** Wrapped `assets/section-multicolumn.js` in `if (!customElements.get('multicolumn-video-item')) { … }` so a second evaluation (2+ multicolumn sections on a page) is a no-op instead of a re-declaration `SyntaxError`. The top-level `class` was previously unguarded (only the `define()` was). Confirmed gone from PDP. Backup at `docs/reports/theme-backups/2026-07-22/section-multicolumn.js.orig`.

### Still open
- **⛔ Sean (admin, ~2 min): `twq` in the custom web pixel.** A third copy lives in **Settings → Customer events → [custom pixel]** (rendered as `web-pixels@…/custom/…`). Not editable via the theme API. Open that pixel and delete the `twq(...)` call (or the whole pixel if it only holds the orphaned Twitter code). This is the last on-page `twq` error.
- **🟡 Cross-origin `SecurityError`** on the homepage — a third-party iframe embed; benign to conversion, low priority.
- **⚠️ Google Ads / GA beacon aborts** — carried into Phase 0 Task 3 (server-side tracking) for a consented Tag-Assistant check.

### Verify the drop
Re-pull Clarity in ~3 days: `node -e "import('./lib/clarity.js').then(m=>m.fetchClarityInsights({numOfDays:3}).then(c=>console.log(c.behavior)))"` → expect `scriptErrorPct` well below 12.4% (won't hit 0 until the web-pixel copy is removed).
