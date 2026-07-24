# Theme Update + App-Scoping Perf Plan — Real Skin Care

**Owner:** Sean · **Created:** 2026-07-24 · **Status:** foundation set; execution pending theme update

This is the durable pick-up doc for two linked pieces of work:
1. **Update the Shopify theme** (several versions behind, with significant upstream improvements).
2. **App-scoping perf work** — deferred until the theme is current, because the update changes the perf picture.

---

## Status snapshot (2026-07-24)

| Item | State |
|---|---|
| Google tag audit + cleanup (GA4 double-fire, GTM, sprawl) | ✅ Done — see `tag-audit-2026-07-24.md` |
| `pagespeed-monitor` agent (daily mobile/desktop scores) | ✅ Live on server, runs 8 AM PT (cron `scheduler.js`) |
| Shadow GA4 `…FNX` removed | ⏳ Verify in GA4 Realtime (should go silent) |
| **Theme update** | ⬜ Foundation set (this doc); not started |
| **App-scoping perf work** | ⬜ Deferred — blocked on theme update |

---

## Current theme facts (pulled from Shopify API 2026-07-24)

- **Theme:** "Be Yours" **v8.3.2** by RoarTheme (a *premium* theme — not Dawn; updates come from RoarTheme, not Shopify).
- **Live/main theme:** id `145536778410`, named **"PDP-toothpaste-pilot-draft"** — ⚠️ the production theme is named like a draft/pilot. **Confirm this is truly the canonical production theme before investing in a migration.**
- **Other themes in store (both unpublished, STALE):**
  - `138250158250` "be-yours-updated-realskincare-8-3-2" (updated 2026-05-03)
  - `140829458602` "be-yours-updated-realskincare-8-3-2 with Instal…" (updated 2026-03-18)
  - These predate today's tag cleanup and other recent edits — **do not treat them as current backups.**
- **Asset counts:** 166 assets, 97 sections, 69 templates, 68 snippets, 6 layout, 2 config, 26 locales.

---

## Part 1 — Theme update foundation

### 1a. FIRST action before touching anything: back up the *current* live theme
Shopify admin → **Online Store → Themes → (live theme) → ⋯ → Duplicate.**
This snapshots the current state *including today's tag cleanup and all customizations*. The two existing unpublished copies are stale (pre-May) — they are NOT valid restore points.

### 1b. Get the new theme version
"Be Yours" updates ship from **RoarTheme** (via your RoarTheme account / the Shopify Theme Store "Be Yours" listing), not Shopify core.
- Add the **latest Be Yours** as a new *unpublished* theme (never edit the live one directly).
- Read RoarTheme's **changelog 8.3.2 → latest** for breaking changes / renamed sections.

### 1c. Customizations to migrate (do not lose these)
- **Custom sections** (migration-critical): `rsc-buybox-card`, `rsc-tiered-buybox` (the PDP builder buybox — see `project_pdp_builder_active` memory), `hero-landing-section`, `bundle-products`, `clean-lotion-comparison`, `coconut-oil-benefits-comparison`, `image-comparison`, `landing-ingredients`, `faq`, `custom-liquid`, `jdgm-featured-reviews-3up`.
- **`layout/theme.liquid` head edits to preserve:** Microsoft Clarity snippet (~line 152) + `preconnect` to cdn.shopify.com (line 17).
  - ⚠️ **Do NOT re-add the Google tag snippets** we removed today. GA4 (`G-PYV4WG2QL8`) + Google Ads (`AW-10923654107`) now fire via the **Google & YouTube channel pixel**, which is app-level and survives theme changes. Re-adding a hardcoded gtag/GTM would reintroduce the double-fire.
- **`settings_data.json`** — all theme-customizer content + settings. This is the bulk of "the look" and must be carried forward or re-applied.
- **`templates/*.json`** (69 files) — per-page section arrangements.

### 1d. Update procedure (safe migration, not in-place)
1. **Duplicate** the live theme (backup — 1a).
2. **Add** latest Be Yours as unpublished.
3. **Re-apply** customizations onto the new version: custom sections/snippets → `theme.liquid` head snippets → settings → template JSON.
4. **Preview + QA** the unpublished theme: PDP buybox, collection pages, cart/checkout, mobile layout, Clarity firing.
5. **Re-baseline perf on the preview** — `pagespeed-monitor` can target the preview URL (add it to `config/pagespeed.json` temporarily, or `--url <preview>`).
6. **Publish.** Then verify: live pages 200; GA4 + Clarity fire exactly once (Google Tag Assistant); no console errors.
7. **Re-run `pagespeed-monitor`** post-publish → new baseline.

### 1e. Risks / notes
- Premium-theme updates overwrite customizations if done in-place — hence migrate onto a fresh copy.
- A naive "reset section to theme default" would re-introduce the duplicate Google tags — keep our removals.
- Resolve the "…pilot-draft" naming: make sure the migration targets the real production theme.

---

## Part 2 — Deferred: app-scoping perf work (execute AFTER theme update)

**Why deferred:** the theme update changes how apps bundle/load; measuring or scoping before it would be wasted. Re-baseline first, then scope.

### Baseline (2026-07-24, mobile / desktop lab scores)
Homepage **32 / 62**, Collection **33 / 75**, PDP **62 / 82**. Mobile TBT ~8.5 s, ~1.7 MB unused JS. Mobile is the constraint across all commercial pages. (Fields: no CrUX data yet — low traffic.)

### The four levers (ranked by wasted JS)
1. **Zipify OCU (One Click Upsell)** — ~227 KB (`zipify-oneclickupsell-single` 164 KB + `zipify-cart-drawer` 63 KB). Scope to **cart/checkout only**, off the homepage. ⚠️ Earns +172% AOV — **scope, don't remove.**
2. **PayPal SDK** — ~170 KB (smart buttons 106 KB + sdk 63 KB). Express-checkout buttons; scope to **cart/product**, off the homepage.
3. **Judge.me** — ~33 KB inline. Reviews belong on **PDP**; lazy-load / remove off the homepage.
4. **Recurpay** — ~36 KB inline. Subscription widget; **PDP-only.**

### How to scope each (investigate at execution time)
- **App embeds:** Shopify → theme editor → **App embeds** — some apps can be toggled/scoped there.
- **Per-app settings:** several apps offer native "load on these pages" targeting — check each app first.
- **Fallback:** wrap the app's block in conditional Liquid so it only renders on relevant templates (e.g. `{% if template contains 'product' %}`).

### Sequence
Theme update → **re-baseline** (`pagespeed-monitor`) → scope apps (1→4) → re-measure. Track the score climb in `data/snapshots/pagespeed/`.

---

## Pick-up checklist (next session)

- [ ] Confirm the canonical production theme (resolve "…pilot-draft" naming).
- [ ] Duplicate live theme as a current backup.
- [ ] Obtain latest "Be Yours" from RoarTheme + read changelog.
- [ ] Migrate customizations (Part 1c) onto the new version.
- [ ] Preview QA + perf re-baseline on preview.
- [ ] Publish + verify (200s, tags fire once, Clarity ok).
- [ ] Re-baseline post-publish, then app-scoping (Part 2).

## References
- Tag audit + keep/kill: `data/reports/pagespeed/tag-audit-2026-07-24.md`
- Monitor: `agents/pagespeed-monitor/`, `config/pagespeed.json` (daily 8 AM PT via `scheduler.js:170`)
- Memory: `project_google_tag_sprawl_audit`, `project_pdp_builder_active`
