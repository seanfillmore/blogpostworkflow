# Automated Content Pipeline — Design Spec

**Date:** 2026-03-29
**Status:** Approved for implementation

## Goal

Turn the content pipeline into a fully automated machine. The only required human action is uploading Ahrefs keyword files for new topics. Everything else — brief generation, writing, editing, image creation, and publishing — runs without intervention.

## Architecture Overview

Three independent changes compose the full system:

1. **Keyword zip upload** — dashboard UI that accepts a zip of Ahrefs CSVs per keyword, extracts them, and immediately runs the content-researcher to generate the brief
2. **Mon/Wed/Fri cadence** — calendar-runner snaps every scheduled publish date to the nearest upcoming Monday, Wednesday, or Friday at 08:00 PT
3. **Bi-weekly pipeline refresh** — new cron job every two weeks that re-runs content-strategist (keeping the calendar current with new topic priorities) plus a dashboard upload section for content-gap CSV files so the user can trigger a full gap refresh when ready

The existing daily cron (`scheduler.js` at 08:00 PT) already handles the full `briefed → written → scheduled → published` pipeline. These changes feed the front of that pipeline and control its publishing rhythm.

---

## Part 1: Keyword Zip Upload

### Context

The Data Needed card already exists on the SEO tab. It lists every keyword from the content calendar that is missing its Ahrefs CSV files (`serp.csv`, `matching_terms.csv`, `keyword.csv`), along with which specific files are absent. Currently, the user must manually copy files into `data/ahrefs/{slug}/`.

### UI Changes — `agents/dashboard/index.js`

Each keyword row in the Data Needed card gains an **Upload Zip** button alongside the existing file-check tags.

**Button states:**
- Default: `↑ Upload Zip`
- Processing: animated dots (reuse `.chat-dot`)
- Success: `✓ Brief created` (permanent until page refresh)
- Error: `✗ Failed — retry` (button re-enables)

**File acceptance:** `.zip` only.

The button triggers a hidden `<input type="file" accept=".zip">` (appended to `document.body` before `.click()` to survive GC, removed in `onchange` — same pattern as `uploadRankSnapshot`).

On file selection, POST to `/upload/ahrefs-keyword-zip` with headers:
- `X-Slug: {slug}` — the keyword slug the files belong to
- `Content-Type: application/octet-stream`

After a successful upload response, the browser calls `runAgent('agents/content-researcher/index.js', [keyword], onDone)` to immediately generate the brief. The SSE log for the researcher run streams to the existing run-log element `run-log-agents-content-researcher-index-js` (create it if it doesn't exist). On `onDone`, call `loadData()` to refresh the card — the keyword will disappear from the Data Needed card once all files are present.

### Server Endpoint — `/upload/ahrefs-keyword-zip`

```
POST /upload/ahrefs-keyword-zip
Headers: X-Slug, Content-Type: application/octet-stream
Body: raw zip bytes
```

1. Read `X-Slug` header; validate it matches `/^[a-z0-9-]+$/` — reject with 400 if invalid
2. Write zip bytes to a temp file: `data/ahrefs/{slug}/.upload.zip`
3. Use `extract-zip` (already in `node_modules`) to extract into `data/ahrefs/{slug}/`
4. Delete the temp zip file
5. Return `{ ok: true, slug, files: [list of extracted filenames] }`
6. On any error return `{ ok: false, error: message }`

The server does NOT run content-researcher — that happens client-side via the existing `runAgent` SSE mechanism so the user sees streaming output.

### Run-Log Element

Add `<pre id="run-log-agents-content-researcher-index-js" class="run-log" style="display:none"></pre>` to the SEO tab alongside the other run-log elements. `runAgent` uses the script path to derive the element ID, so naming it correctly is all that's needed.

---

## Part 2: Mon/Wed/Fri Publishing Cadence

### Context

`calendar-runner` calls `formatPublishAt(date)` to compute the ISO timestamp used when scheduling a post in Shopify. Currently it formats the exact calendar date at 08:00 PT. Posts should instead land on the nearest upcoming Monday, Wednesday, or Friday.

### Change — `agents/calendar-runner/index.js`

Replace the `formatPublishAt` function with one that:

1. Takes a target date
2. Finds the next Monday (1), Wednesday (3), or Friday (5) on or after that date
3. If the computed date is in the past (already passed), advance to the next available Mon/Wed/Fri slot
4. Returns an ISO string at `08:00:00-07:00` (PT)

```javascript
function formatPublishAt(date) {
  const PUBLISH_DAYS = new Set([1, 3, 5]); // Mon, Wed, Fri
  const d = new Date(date);
  // Snap forward to next publish day
  while (!PUBLISH_DAYS.has(d.getDay())) {
    d.setDate(d.getDate() + 1);
  }
  // If that date is in the past, keep advancing by 1 week until it's future
  const now = new Date();
  while (d < now) {
    d.setDate(d.getDate() + 7);
  }
  const y  = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${dy}T08:00:00-07:00`;
}
```

No other changes to `calendar-runner` are needed. Existing items already scheduled in Shopify are unaffected — the function is only called at the moment of publishing.

---

## Part 3: Bi-Weekly Pipeline Refresh

### 3a. Bi-Weekly Content Strategist Cron Job

Add to `scripts/setup-cron.sh`:

```bash
# Every other Sunday at 05:00 PT — refresh content calendar priorities
BIWEEKLY_STRATEGIST="0 5 * * 0 [ $(( $(date +%W) % 2 )) -eq 0 ] && cd \"$PROJECT_DIR\" && $NODE agents/content-strategist/index.js >> data/reports/scheduler/content-strategist.log 2>&1"
```

This re-runs `content-strategist` (plan only, no `--generate-briefs`) every other Sunday at 05:00 PT. It reads the existing gap report and current rank data to reprioritize the calendar, add new items from the brief queue, and extend the schedule. The brief generation itself is left to the daily pipeline-scheduler so it runs one per day rather than all at once.

Also update the cron install block and the echo summary at the bottom of `setup-cron.sh` to include this new job.

### 3b. Content Gap Upload Section in Dashboard

The content-gap agent needs a separate set of broader Ahrefs CSV files in `data/content_gap/` (category-level keyword exports + competitor top pages). These change infrequently (every few months) and require a fresh Ahrefs session to produce.

Add a **Content Gap Data** card to the SEO tab, below the Data Needed card. The card shows:
- The files currently present in `data/content_gap/` with their last-modified dates
- An **Upload Files** button that accepts a `.zip` and extracts into `data/content_gap/`
- A **Run Gap Analysis** button that triggers `agents/content-gap/index.js` followed by `agents/content-strategist/index.js` via `runAgent`, streaming output to a run-log element

**Card structure (always visible, not hidden like Data Needed):**

```
┌─ Content Gap Data ────────────────────────────────── [Upload Zip] [Run Analysis] ─┐
│  top100.csv                   Updated Mar 29, 2026                                 │
│  realskincare_organic_keywords.csv   Updated Mar 29, 2026                          │
│  natural_deodorant.csv        Updated Mar 29, 2026                                 │
│  ... (one row per file)                                                             │
└────────────────────────────────────────────────────────────────────────────────────┘
```

Files missing from `data/content_gap/` are shown in muted/italic style.

**Upload endpoint — `/upload/content-gap-zip`:**

Same pattern as `/upload/ahrefs-keyword-zip` but extracts into `data/content_gap/` (flat, no subdirectory). No slug header needed.

**Run Analysis button:**

Chains two agents sequentially using SSE: after `content-gap` completes, kicks off `content-strategist`. Since `runAgent` calls `onDone` on completion, chain them:

```javascript
runAgent('agents/content-gap/index.js', [], function() {
  runAgent('agents/content-strategist/index.js', [], function() {
    loadData();
  });
});
```

Both agents write to the same run-log element (`run-log-agents-content-gap-index-js`). After completion, `loadData()` refreshes the dashboard — the new calendar items will appear in the kanban.

### 3c. Server Data for Content Gap Card

Add a `contentGapFiles` field to the `aggregateData()` return value:

```javascript
const contentGapFiles = existsSync(CONTENT_GAP_DIR)
  ? readdirSync(CONTENT_GAP_DIR)
      .filter(f => f.endsWith('.csv'))
      .map(f => ({ name: f, mtime: statSync(join(CONTENT_GAP_DIR, f)).mtimeMs }))
      .sort((a, b) => a.name.localeCompare(b.name))
  : [];
```

Add `CONTENT_GAP_DIR = join(ROOT, 'data', 'content_gap')` to the server constants (alongside existing `AHREFS_DIR`).

---

## Template Literal Safety

All browser JS lives inside the Node.js template literal in `agents/dashboard/index.js`. Follow established rules:
- No `\n` in string literals — use `\\n`
- No `\s`, `\t` in regex patterns — use `[ ]` or `[\\t]`
- No `\n` in `alert()`/`confirm()` messages

---

## Data Flow Summary

```
User uploads keyword zip
  → /upload/ahrefs-keyword-zip
  → extract-zip → data/ahrefs/{slug}/
  → runAgent content-researcher → data/briefs/{slug}.json
  → daily scheduler (08:00 PT) picks up briefed item
    → blog-post-writer → data/posts/{slug}.html
    → image-generator → data/images/{slug}.webp
    → editor → data/reports/editor/{slug}-editor-report.md
    → link-repair (if needed)
    → featured-product-injector
    → schema-injector
    → publisher --publish-at next Mon/Wed/Fri 08:00 PT
      → post live in Shopify

Every 2 weeks (Sunday 05:00 PT):
  → content-strategist (plan only)
  → content-calendar.md refreshed with new priorities

When user uploads gap zip:
  → /upload/content-gap-zip
  → extract into data/content_gap/
  → Run Analysis button:
    → content-gap → content-gap-report.md
    → content-strategist → content-calendar.md updated with new topics
    → new keywords appear in Data Needed card
    → user uploads keyword zips → cycle continues
```

---

## Files to Create or Modify

| File | Change |
|------|--------|
| `agents/dashboard/index.js` | Add upload zip buttons to Data Needed card; add Content Gap Data card; add `/upload/ahrefs-keyword-zip` and `/upload/content-gap-zip` endpoints; add `contentGapFiles` to `aggregateData()`; add `CONTENT_GAP_DIR` constant |
| `agents/calendar-runner/index.js` | Replace `formatPublishAt()` with Mon/Wed/Fri snapping logic |
| `scripts/setup-cron.sh` | Add bi-weekly `content-strategist` cron entry |

---

## Out of Scope

- Automating the Ahrefs CSV export itself (requires a human Ahrefs session)
- Multiple posts per day
- Pausing the pipeline from the dashboard
- Editing brief content before writing
