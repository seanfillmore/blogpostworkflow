# Technical SEO Dashboard Tab

**Date:** 2026-04-11
**Goal:** Add a dedicated Technical SEO tab to the dashboard for uploading Ahrefs site audit data, viewing/fixing issues by category, and displaying Lighthouse theme audit results.

---

## Tab Structure

New tab "Tech SEO" added to the tab pills bar, positioned after "Optimize". Uses stacked cards layout matching existing dashboard patterns.

### Sections (top to bottom)

**1. Upload & Summary Card**
- Left: drag-and-drop upload zone for Ahrefs site audit ZIP (same pattern as keyword ZIP upload)
- Right: issue summary grid — 4 counts: Errors (red), Warnings (yellow), Fixed (green), Manual (blue)
- Bottom: action buttons — Run Audit, Fix All (dry run), Fix All (apply), Compare New ZIP
- Shows "Last audit: {date}" from the latest report

**2. Issue Cards (paired in rows)**

Row 1:
- **404 Pages** (red) — URLs returning 404, with inbound link counts. Button: "Create Redirects"
- **Broken Links** (red) — internal links pointing to 404s, with source post. Button: "Fix Links"

Row 2:
- **Missing Meta** (yellow) — pages without meta descriptions. Button: "Fix Meta"
- **Missing Alt Text** (yellow) — posts with images lacking alt text, with counts. Button: "Fix Alt Text"

Row 3:
- **Redirect Chains** (yellow) — multi-hop redirects. Button: "Fix Redirects"
- **Orphan Pages** (red) — pages with zero inbound internal links

Each card shows top 5 items with a "+ N more" overflow. Each fix button triggers the corresponding technical-seo agent command via `runAgent()`.

**3. Theme SEO Audit Card** (blue)
- Lighthouse scores as circle badges: Performance, SEO, Accessibility
- Core Web Vitals: LCP (seconds), CLS (score)
- Per-template table: Homepage, Product, Collection, Blog Post, Page — with columns: H1, Canonical, OG Tags, Alt %, Issues
- Button: "Run Theme Audit"
- Shows "Last run: {date}" from the latest theme audit report

---

## Data Sources

| Data | Source | Loaded by |
|---|---|---|
| Site audit issues | `data/technical_seo/*.csv` parsed by `agents/technical-seo/index.js audit` | New: data-loader reads latest audit report |
| Audit report | `data/reports/technical-seo/technical-seo-audit.md` | New: data-loader parses issue counts |
| Theme audit | `data/reports/theme-seo-audit/latest.json` | New: data-loader reads JSON directly |

### Data-loader additions

Load two new data sources in `agents/dashboard/lib/data-loader.js`:

```javascript
// Technical SEO audit — parse the markdown report for issue counts
const techSeoReport = readFileIfExists(join(REPORTS_DIR, 'technical-seo', 'technical-seo-audit.md'));

// Theme SEO audit — structured JSON
const themeSeoAudit = readJsonIfExists(join(REPORTS_DIR, 'theme-seo-audit', 'latest.json'));
```

The tech SEO report is markdown — parse it in the data-loader to extract structured issue data (counts by category, top items per category). The theme audit is already JSON.

### Audit report parsing

Parse the markdown audit report into a structured object:

```json
{
  "generated_at": "April 9, 2026",
  "summary": { "errors": 12, "warnings": 23, "fixable": 30 },
  "categories": {
    "404_pages": { "count": 5, "severity": "error", "items": [...] },
    "broken_links": { "count": 4, "severity": "error", "items": [...] },
    "missing_meta": { "count": 8, "severity": "warning", "items": [...] },
    "missing_alt": { "count": 15, "severity": "warning", "items": [...] },
    "redirect_chains": { "count": 3, "severity": "warning", "items": [...] },
    "orphan_pages": { "count": 2, "severity": "error", "items": [...] }
  }
}
```

---

## Upload Route

New route: `POST /upload/tech-seo-zip`

Same pattern as the keyword ZIP upload:
1. Receives binary ZIP via request stream
2. Extracts to `data/technical_seo/` (replacing existing CSVs)
3. Flattens nested subdirectory if present
4. Returns `{ ok: true, files: [...] }`
5. Invalidates data cache
6. Client auto-triggers `runAgent('agents/technical-seo/index.js', ['audit'])` after upload

---

## Agent Run Buttons

Each fix button triggers the technical-seo agent with the appropriate command:

| Button | Agent command | Args |
|---|---|---|
| Run Audit | `agents/technical-seo/index.js` | `['audit']` |
| Fix All (dry run) | `agents/technical-seo/index.js` | `['fix-all', '--dry-run']` |
| Fix All (apply) | `agents/technical-seo/index.js` | `['fix-all']` |
| Compare New ZIP | `agents/technical-seo/index.js` | `['compare']` |
| Create Redirects | `agents/technical-seo/index.js` | `['create-redirects']` |
| Fix Links | `agents/technical-seo/index.js` | `['fix-links']` |
| Fix Meta | `agents/technical-seo/index.js` | `['fix-meta']` |
| Fix Alt Text | `agents/technical-seo/index.js` | `['fix-alt-text']` |
| Fix Redirects | `agents/technical-seo/index.js` | `['fix-redirects']` |
| Run Theme Audit | `agents/theme-seo-auditor/index.js` | `[]` |

The `agents/technical-seo/index.js` must be added to the `RUN_AGENT_ALLOWLIST` in `agents/dashboard/lib/run-agent.js`. Same for `agents/theme-seo-auditor/index.js`.

---

## Files

| Action | File | Responsibility |
|---|---|---|
| Modify | `agents/dashboard/public/index.html` | Add tab pill + tab panel |
| Modify | `agents/dashboard/public/js/dashboard.js` | Add `renderTechnicalSeoTab()`, upload handler, fix button handlers |
| Modify | `agents/dashboard/lib/data-loader.js` | Load tech SEO audit report + theme audit JSON |
| Create | `agents/dashboard/lib/tech-seo-parser.js` | Parse tech SEO markdown report into structured data |
| Modify | `agents/dashboard/routes/uploads.js` | Add `POST /upload/tech-seo-zip` route |
| Modify | `agents/dashboard/lib/run-agent.js` | Add technical-seo + theme-seo-auditor to allowlist |
| Modify | `agents/dashboard/lib/tab-chat-prompt.js` | Add tech-seo tab context for chat |

---

## What's NOT in scope

- Live Ahrefs API integration (manual CSV upload only)
- Per-issue approve/dismiss workflow (fixes run immediately via agent commands)
- Historical tracking of audit scores over time
- Automated fix scheduling (fixes are triggered manually from the dashboard)
