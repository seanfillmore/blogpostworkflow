# Creatives Tab — Two Pathways + UI/Model Refresh

- **Date:** 2026-07-23
- **Status:** Approved design, pending spec review
- **Author:** Sean Fillmore (with Claude)
- **Area:** `agents/dashboard` (Creatives tab, routes, store) + `agents/creative-packager`

## Problem

The Creatives tab today is two disconnected systems bolted onto one backend:

1. An interactive **Studio** (`#tab-creatives`): prompt → generate → refine → version filmstrip → upscale. Works well.
2. An adId-based **packager flow** driven from the Ad Intelligence tab's "Generate Creative" button. Coherent but clunky (a native `prompt()` asks the operator to type product-image filenames).

The Studio's "Package for All Placements" button reuses the adId packager and is **non-functional** — three stacked defects plus an architectural mismatch:

- Frontend checks `if (!data.ok)` but `/api/creatives/package` returns `{ jobId }` → always shows "Package failed", never polls (`dashboard.js:3373`).
- Poll waits for `status === 'done'` but the packager writes `'complete'` (`creative-packager/index.js:300`) → would never resolve success.
- The packager reads `job.adId` from `meta-ads-insights` and ignores the session image entirely; the session-based job has no `adId` → throws `Ad undefined not found`.

Additional debt found: custom aspect ratio is a no-op (route never reads `customWidth`/`customHeight`); refine drops aspect ratio and product context (`imageConfig: {}`); model IDs are hardcoded across 6 files and several are stale/overpowered; the packager's Gemini call uses an old model + old API shape (`generationConfig`) inconsistent with the Studio's (`config.imageConfig`).

## Goals

- Make the two pathways **explicit, separate operator flows** that share one image-canvas core (Approach A).
  - **Pathway 1 — Studio:** one-off creatives from a prompt + product/reference images. Output: download a single image.
  - **Pathway 2 — Ad Builder:** product + angle/offer → hero image (approve/regenerate) → fan out to placement-sized statics + copy → ZIP. Self-serve from our catalog.
- Fix the package pipeline end-to-end so a session image actually produces a ZIP (no `adId` dependency).
- Refresh the UI for cohesion (CSS variables, shared component classes, decluttered top bar) and add the mode toggle.
- Centralize and right-size model choices for cost/quality.
- Tie every Ad Builder output to a conversion path (destination PDP/collection URL) per the revenue Prime Directive.

## Non-goals

- No change to the Studio's core generate/refine/upscale mechanics.
- No new competitor-ad ingestion. The existing Ad Intelligence "Generate Creative" flow keeps working; it simply becomes a third caller of the same source-agnostic packager job shape (out of scope to redesign here, but must not break).
- No baked-in text on images (decided: clean image + separate copy file).

## Design

### Navigation — mode toggle (one tab)

A segmented toggle at the top-left of the Creatives tab switches between **Studio** and **Ad Builder**. One top-level tab, two views. State lives in `creativesState.mode` (`'studio' | 'adbuilder'`), persisted per session so reopening a session restores its mode.

```
Creatives
( ● Studio  ○ Ad Builder )            [ ⚙ Settings ] [ session ▾ ] [ + New ]
──────────────────────────────────────────────────────────────────────────
STUDIO                         │  AD BUILDER
prompt / negative / aspect /   │  1. Product ▾   Angle/Offer ▾   Dest URL
reference images               │     → Generate Hero
image · refine · history       │  2. hero preview + Approve / Regenerate
[Download]                     │  3. [ Generate Ad Set ] → placements+copy → ZIP
```

Both views mount the **same image-canvas** (`renderCreativesCanvas`) — the display area, spinner, error, refine row, and history filmstrip are one component. Studio and Ad Builder differ only in the left/step panel and the finishing action.

### Backend seam — source-agnostic packager

The packager stops resolving `adId` from insights. A packaging job is defined by a **hero image + a copy brief + placement targets**, regardless of who produced it.

New job shape (`data/creative-jobs/<jobId>.json`):

```json
{
  "jobId": "pkg-...",
  "source": "session",              // "session" | "ad" (ad = legacy Ad Intelligence path)
  "heroImagePath": "session-xxx/v3.png",  // relative to CREATIVES_DIR (session) ...
  "productImages": ["deodorant-stick.webp"],
  "copyBrief": {
    "product": "Sensitive Skin Set",
    "angle": "gentle for reactive skin",
    "destinationUrl": "https://www.realskincare.com/products/sensitive-skin-set"
  },
  "placements": ["instagram", "facebook"],
  "status": "pending",
  "createdAt": "..."
}
```

Packager `main()` branches on `source`:

- `session`: load `heroImagePath` from `CREATIVES_DIR`, resize to each placement size with `sharp` (existing `placementSizes()` / `PLACEMENT_MAP`), generate copy from `copyBrief` (no competitor ad).
- `ad` (legacy): keep current behavior for the Ad Intelligence caller — resolve the ad, build `copyBrief` from it, then run the identical resize/copy/zip path. This means the legacy path is refactored to construct a `copyBrief` up front and share the downstream code.

The ZIP gains a `manifest.json` (product, angle, `destinationUrl`, placement list, generated-at) so every asset set carries its conversion path.

### Route + frontend contract fixes

- `/api/creatives/package` accepts `{ sessionId, version, product, angle, destinationUrl, placements }`, resolves the session's version image to `heroImagePath`, writes the `source: "session"` job, spawns the packager, returns `{ jobId }`.
- Frontend `packageCreative()` → rename to `generateAdSet()`: check `data.jobId` (not `data.ok`); on poll, treat `status === 'complete'` as success (align with the working Ad Intelligence poller) and `'error'` as failure; download via the `downloadUrl` the job records.
- Packager keeps writing `status: 'complete'`; the status route already returns `job.status` verbatim, so aligning the frontend is the fix (do not introduce a new `'done'` string).

### Correctness fixes bundled in

- **Custom aspect ratio:** `/api/creatives/generate` reads `customWidth`/`customHeight` and passes them through (Gemini `imageConfig` when supported; otherwise post-resize with `sharp`). No more silent default.
- **Refine carries context:** `/api/creatives/refine` passes the version's `aspectRatio` into `imageConfig` and re-attaches product images, so a refine can't silently change the frame or drop the product.

### UI cohesion

- Replace hardcoded hexes (`#6c5ce7`, `#0f172a`, `#fff5f5`, fixed px) with the dashboard's existing CSS vars (`--border`, `--surface`, `--card`, `--fg`, `--muted`, `--bg`); add one `--accent` var (seeded from `#6c5ce7`) used by both pathways.
- Extract repeated inline styles into `dashboard.css` classes: `.creatives-select`, `.ar-btn`, `.creatives-primary-btn`, `.creatives-panel`. The two pathways share these so they stay visually identical by construction.
- Declutter the top bar: Model / Resolution / Template collapse into a **⚙ Settings** popover; Session controls stay right; the mode toggle takes the top-left. This makes room for the toggle without a third crowded row.
- Consistent type scale instead of the current `0.82`/`0.78`/`0.75rem` mix. Theme-aware (light/dark) via the existing dashboard variables.
- No behavior change from the cohesion work — purely visual/structural.

### Model configuration (centralized)

New `config/creative-models.js` (single source of truth; imported by routes, packager, store):

| Task | Model | Rationale |
|---|---|---|
| Ad copy (Ad Builder + legacy) | `claude-opus-4-8` | Flagship. Copy is where revenue is made — quality-first here. |
| Gemini style-brief (image prompt) | `claude-haiku-4-5` | Short mechanical instruction feeding image gen. |
| Template-from-image (vision) | `claude-haiku-4-5` | Vision-capable; light "describe as template" task. |
| Session naming | `claude-haiku-4-5` | Already optimal; keep. |
| Image generation (all paths) | `gemini-2.5-flash-image` via `config.imageConfig` | Unifies Studio + packager on one model + API shape; fast/cheap for placement fan-out. Studio's model selector still overrides for interactive use. |

The packager's old `gemini-2.0-flash-preview-image-generation` + `generationConfig` call is replaced with the `config.imageConfig` shape used by the Studio route.

## Components & interfaces

- `agents/dashboard/public/js/dashboard.js`
  - `creativesState.mode` + `switchCreativesMode(mode)`.
  - `renderCreativesCanvas()` — shared image-canvas render (extracted from current right-panel logic).
  - Studio: `generateCreativeImage()`, `refineCreativeImage()`, `downloadCreativeImage()` (unchanged behavior; Package button removed).
  - Ad Builder: `generateHero()`, `approveHero()`/`regenerateHero()` (reuse generate/refine), `generateAdSet()` (replaces `packageCreative()`), `pollAdSet()` (replaces `pollCreativePackage()`, checks `'complete'`).
- `agents/dashboard/routes/creatives.js` — `/api/creatives/package` rewritten to session job shape; generate/refine fixes; model IDs imported from config.
- `agents/creative-packager/index.js` — `source`-branched `main()`; shared resize/copy/zip; `manifest.json` in ZIP; models from config.
- `config/creative-models.js` — new.
- `agents/dashboard/public/dashboard.css` — new `.creatives-*` classes + `--accent`.

## Data flow

**Studio:** prompt/images → `/api/creatives/generate` → session version saved → canvas shows image → optional refine → Download.

**Ad Builder:** product+angle+destURL → `generateHero()` (seeds prompt, calls `/api/creatives/generate`) → operator approves or regenerates on the shared canvas → `generateAdSet()` → `/api/creatives/package` writes `source:"session"` job → packager resizes hero to placements + generates copy (Opus 4.8) + writes ZIP (+manifest) → poll `'complete'` → download.

## Error handling

- Missing session/version on package → 400 with message; button re-enables.
- Packager failure → job `status:'error'` + `error` (existing pattern); frontend surfaces it and re-enables.
- Gemini safety/no-image → existing 422 handling retained.
- Missing `destinationUrl` in Ad Builder → warn (non-blocking) but record empty in manifest; do not hard-block generation.

## Testing

- Unit: `placementSizes()`, `formatCopyFile()`, `formatSpecsFile()`, new `buildCopyBrief()` remain pure and tested. Add a test for the `source`-branch job parsing.
- End-to-end on ONE session before any batch behavior (project rule #4): create a Studio image → switch to Ad Builder → generate hero → Generate Ad Set → confirm ZIP downloads with correct placement images, `copy.txt`, and `manifest.json`.
- Verify legacy Ad Intelligence "Generate Creative" still produces a ZIP (regression).
- After deploy, curl the dashboard for `online` and exercise one package job (per verify-live-after-mutating feedback).

## Rollout

- Branch `feature/creatives-two-pathways`; PR to `main` (rules #1–#2).
- Test locally before pushing to the server (rule #3).
- Deploy via the standard `git pull && pm2 restart seo-dashboard`.

## Resolved decisions

1. Approach A (shared canvas core, two operator flows). ✔
2. Ad copy model = `claude-opus-4-8`; everything else Haiku 4.5. ✔
3. Mode toggle inside one tab (not two top-level tabs). ✔
4. Output = clean placement images + copy file (no baked-in text). ✔
5. Ad Builder always carries a destination URL for conversion attribution. ✔
