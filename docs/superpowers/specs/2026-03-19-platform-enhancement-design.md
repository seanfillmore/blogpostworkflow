# Platform Enhancement Design
**Date:** 2026-03-19
**Status:** Approved for implementation planning

## Context

This spec covers six coordinated improvements to the SEO Claude system. The current architecture is a single-brand validation tool (local Node.js server, flat-file data storage). The long-term vision is a multi-tenant SaaS product for DTC brands — so all work should be designed for portability. Specifically: CSS custom properties as design tokens, clean component-like HTML structure, and clear separation between data logic and presentation.

---

## 1. Dashboard Visual Redesign

### Goal
Replace the current utilitarian dashboard with a Bold & Data-Forward design system that can be ported to React/Next.js when the platform goes multi-tenant.

### Design System

**Color tokens (CSS custom properties):**
- `--indigo-900: #1e1b4b` — hero gradient start
- `--indigo-700: #312e81` — hero gradient mid
- `--indigo-600: #4338ca` — hero gradient end
- `--surface: #ffffff` — card backgrounds
- `--bg: #f8fafc` — page background
- `--border: #e2e8f0`
- `--text: #0f172a`
- `--muted: #94a3b8`
- Semantic: `--green: #10b981`, `--amber: #f59e0b`, `--red: #ef4444`, `--purple: #8b5cf6`, `--sky: #38bdf8`, `--orange: #fb923c`

**Typography:**
- Inter via Google Fonts (self-hostable for future production use)
- Label text: 9–11px, uppercase, letter-spacing 0.06em, `--muted`
- Body: 13–14px
- KPI numbers: 18–22px, font-weight 800

### Hero Header

Sticky. Full-width indigo gradient (`135deg`, `--indigo-900` → `--indigo-700` → `--indigo-600`). Two rows:

**Row 1:** Site logo mark (28px rounded square, frosted glass) + site name + pill-style tab switcher (SEO / CRO / Ads). Pill switcher uses `rgba(0,0,0,.2)` background with white active pill.

**Row 2:** 5 frosted-glass KPI cards in a grid. Cards use `rgba(255,255,255,.10)` background, `1px solid rgba(255,255,255,.08)` border, `backdrop-filter: blur(8px)`. Each card: large colored number (18–20px, weight 800) + small muted label.

KPI cards are **tab-contextual** — they update when the active tab changes:

| Tab | KPI 1 | KPI 2 | KPI 3 | KPI 4 | KPI 5 |
|-----|-------|-------|-------|-------|-------|
| SEO | Published (green) | Scheduled (indigo) | Pg 1 Keywords (amber) | Avg Rank Δ (purple) | GSC Clicks (sky) |
| CRO | Conversion Rate (green) | Avg Order Value (orange) | Bounce Rate (red) | Sessions (sky) | Cart Abandon (amber) |
| Ads | Daily Spend (orange) | Impressions (sky) | Clicks (indigo) | CTR (amber) | ROAS (green) |

### Content Area

White background, max-width 1400px, centered, 24px padding. Cards use `border-radius: 12px`, `box-shadow: 0 1px 3px rgba(0,0,0,.08), 0 4px 12px rgba(0,0,0,.04)`. Card headers use a **3px colored left border** as the primary visual accent (replaces old uppercase muted header text).

### Implementation

In-place overhaul of `agents/dashboard/index.js`. All data-loading and parsing functions remain untouched. Only the CSS block and HTML-generation functions are replaced. Inter font loaded via `<link>` in the HTML head.

---

## 2. SEO Tab Layout

Three panels stacked vertically:

### Panel 1: Content Pipeline (Kanban)
6 columns: Published (green), Scheduled (indigo), Draft (amber), Written (purple), Briefed (teal), Pending (gray). Larger column headers, bolder counts. Items get colored left-border accents matching their column color. Existing data logic unchanged.

### Panel 2: SEO Authority (new)
Reads Ahrefs CSV exports from `data/ahrefs/`. Expected files determined by parsing filenames for known Ahrefs export types (domain overview, backlinks summary, referring domains).

**If files present:** Displays a compact 4-metric row — Domain Rating, Total Backlinks, Referring Domains, Organic Traffic Value (divide by 100 for USD display per project convention). Uses the most recent file by modification date.

**If files missing:** Shows "Data Needed" banner with instructions: *"Download Ahrefs domain overview export and place in data/ahrefs/"*

No cron job, no API calls. Manual file drop only.

### Panel 3: Rankings + GSC
Existing keyword rankings table and GSC panel, restyled to match the new design system. Rankings table gets color-coded position badges: green (1–3), sky (4–10), amber (11–20), gray (21+). Delta arrows larger and more prominent.

---

## 3. CRO Tab Layout

Structural layout unchanged. Visual redesign only:

- **Date filter:** Pill toggle group (Today / Yesterday / 7 Days / 30 Days), right-aligned, visible only when CRO tab is active
- **KPI strip removed:** The 7-card strip below the header is eliminated — those metrics now live in the hero header KPI row, avoiding duplication
- **2×2 card grid:** Clarity (purple left-border), Shopify (green), GA4 (orange), GSC (sky). Card content unchanged
- **CRO Brief:** Full-width card below the grid, content unchanged, restyled

---

## 4. Ads Tab

Activates when `data/snapshots/google-ads/` contains at least one snapshot file. Until then, shows a "Pending API Approval" placeholder. Once active, displays Google Ads campaign performance with the same design language. Built on the `feature/google-ads-campaign` branch — merge after Business Access is approved, apply new design system at that time.

---

## 5. Rank Change Alerter

**File:** `agents/rank-alerter/index.js`

**Trigger:** Daily cron at 07:30 PT (after GSC collector at 06:00 PT)

**Logic:**
1. Load yesterday's GSC snapshot from `data/snapshots/gsc/YYYY-MM-DD.json`
2. Load the snapshot from 7 days prior
3. Compare per-page clicks and per-query position
4. Flag:
   - **Rank drop:** keyword fell 5+ positions
   - **Traffic drop:** page lost 20%+ clicks week-over-week
   - **New Page 1:** keyword moved into top 10 (positive)
   - **Indexing loss:** page present 7 days ago, absent today

**Output:**
- Report written to `data/reports/rank-alerts/YYYY-MM-DD.md`
- Notify alert fired via `lib/notify` with summary counts (N drops, N gains)
- Dashboard SEO tab shows a dismissible alert banner at the top of the content area when an unread report exists: red for net-negative day, green for net-positive. Clicking opens the report.

**"Unread" state:** Tracked by comparing the report file's modification time to a `data/reports/rank-alerts/.last-viewed` timestamp written when the user dismisses the banner.

---

## 6. Content Pipeline Automation

### 6a. Auto-Brief Scheduler

**File:** `agents/pipeline-scheduler/index.js`

**Trigger:** Daily cron at 08:00 PT

**Logic:**
1. Parse `data/reports/content-strategist/content-calendar.md` for keywords with a publish date within the next 14 days
2. For each, check if `data/briefs/<slug>.json` already exists
3. If no brief exists, run `agents/content-researcher/index.js` for that keyword
4. Limit to 1 brief per run to avoid API overuse

**Output:** Brief written to `data/briefs/<slug>.json` as normal. Notify alert on completion.

### 6b. Post-Publish Verification

The publisher agent (`agents/publisher/index.js`) gains a `--verify` flag (default: on). After a successful publish, it spawns the blog-post-verifier on the newly published slug. Verifier report written to `data/reports/verifier/<slug>-<date>.md`. If the verifier flags issues, a notify alert fires with a count of problems found.

---

## 7. Title & Meta A/B Testing

### Components

**Test creation:** `scripts/create-meta-test.js <slug>`
1. Load the post's keyword and brief from `data/posts/<slug>.json` and `data/briefs/<slug>.json`
2. Generate Variant B title using keyword context (LLM call)
3. Write test file to `data/meta-tests/YYYY-MM-DD-<slug>.json`:
   ```json
   {
     "slug": "example-slug",
     "startDate": "2026-03-19",
     "concludeDate": "2026-04-16",
     "variantA": "Original title tag",
     "variantB": "Generated variant title tag",
     "baselineCTR": 0.034,
     "status": "active"
   }
   ```
4. Apply Variant B to the live Shopify post via API (`title` field update)

**Weekly tracking:** `agents/meta-ab-tracker/index.js`
- Runs Mondays at 08:00 PT
- For each active test in `data/meta-tests/`, loads daily GSC snapshots covering the test period, computes CTR mean for Variant B vs baseline
- Updates test file with `currentDelta` and `daysRemaining`

**Conclusion (28 days):**
- Tracker marks test `concluded`, declares winner
- If Variant B lost: reverts Shopify title to Variant A via API
- Notify alert with recommendation
- Results logged to `data/reports/meta-tests/<slug>-result.md`

**Dashboard:** CRO tab gets a compact "Active Tests" row above the CRO Brief card. Shows each active test as a pill: `<slug> · Day N/28 · CTR Δ +0.4%`. Click opens the test file.

---

## Implementation Order

1. Dashboard visual redesign (foundation — establishes design system)
2. SEO tab layout + Ahrefs manual-file panel
3. CRO tab visual update + Active Tests row
4. Rank Change Alerter agent + cron
5. Pipeline Scheduler + publisher verify flag
6. Meta A/B test script + tracker agent
7. Google Ads tab redesign (after Business Access approval + branch merge)

---

## Portability Notes

When the platform goes multi-tenant:
- CSS custom properties map directly to a Tailwind/CSS-in-JS token system
- HTML generation functions map to React components (1:1 naming)
- Data loading functions map to API route handlers
- Flat-file data model maps to a per-brand database schema
- Agent runners become per-brand scheduled jobs

No design or data-model decisions made here need to be undone for multi-tenancy — they only need to be wrapped in a brand-scoping layer.
