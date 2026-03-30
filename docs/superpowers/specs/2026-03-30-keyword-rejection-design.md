# Keyword Rejection System Design

## Goal

Allow users to reject keywords from the content pipeline kanban, specifying a match type (exact, phrase, broad) so agents can avoid re-suggesting rejected topics in future research cycles.

## Architecture

Three components: a persisted JSON file agents read, dashboard UI to create rejections, and integration points in two agents.

**Tech Stack:** Node.js (existing), vanilla JS dashboard, JSON flat-file storage

---

## Data Model

**File:** `data/rejected-keywords.json`

```json
[
  {
    "keyword": "sls",
    "matchType": "broad",
    "reason": "too broad, not product-specific",
    "rejectedAt": "2026-03-30T18:00:00.000Z"
  }
]
```

- `keyword`: the raw keyword string as it appears in the calendar
- `matchType`: `"exact"` | `"phrase"` | `"broad"`
- `reason`: optional free-text string
- `rejectedAt`: ISO 8601 timestamp

File is created on first rejection if it doesn't exist, appended on each subsequent one. No deduplication — later entries for the same keyword override nothing; all are checked.

---

## Match Type Semantics

| Type | Hard filter rule | Agent prompt guidance |
|------|-----------------|----------------------|
| `exact` | Skip if `slugify(keyword) === slugify(rejection.keyword)` | Only block this exact phrase |
| `phrase` | Skip if `keyword.toLowerCase().includes(rejection.keyword.toLowerCase())` | Block keywords containing this phrase |
| `broad` | Skip if `keyword.toLowerCase().includes(rejection.keyword.toLowerCase())` | Avoid this topic and related ideas broadly |

`exact` and `phrase` use different string comparison semantics. `phrase` and `broad` share the same hard filter logic; the distinction surfaces only in the content-strategist Claude prompt where broad rejections carry stronger avoidance guidance.

---

## Dashboard Changes (`agents/dashboard/index.js`)

### Reject button on kanban cards

Added to cards in `pending` and `briefed` columns only. Cards in `written`, `scheduled`, and `published` columns do not show the button — those stages are past the research phase.

Button markup (inside each pending/briefed card):
```html
<button class="kw-reject-btn" onclick="rejectKeyword('${esc(item.keyword)}')">✕ Reject</button>
```

CSS:
```css
.kw-reject-btn {
  font-size: 0.72rem;
  color: #ef4444;
  background: none;
  border: 1px solid #fca5a5;
  border-radius: 5px;
  padding: 2px 8px;
  cursor: pointer;
}
```

### Rejection modal

Single shared modal added to the HTML body (alongside the existing keyword detail modal). Fields:

- Keyword display (read-only)
- Match type radio group: Exact / Phrase / Broad (default: Exact)
- Reason text input (optional, placeholder: "e.g. too broad, off-brand topic…")
- Cancel and "Reject keyword" buttons

`rejectKeyword(keyword)` populates the modal's keyword field and shows it.

On confirm:
1. POST `/api/reject-keyword` with `{ keyword, matchType, reason }`
2. On `{ ok: true }`: remove the card from the DOM, close modal
3. On error: show inline error message in modal, keep modal open

### Server endpoint

`POST /api/reject-keyword`

- Reads `data/rejected-keywords.json` (defaults to `[]` if missing)
- Appends `{ keyword, matchType, reason: reason || null, rejectedAt: new Date().toISOString() }`
- Writes file back
- Returns `{ ok: true }`
- Returns `{ ok: false, error }` on failure with HTTP 500

---

## Pipeline Scheduler (`agents/pipeline-scheduler/index.js`)

Load rejections before filtering due keywords:

```javascript
function loadRejections() {
  const path = join(ROOT, 'data', 'rejected-keywords.json');
  if (!existsSync(path)) return [];
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
}

function isRejected(keyword, rejections) {
  const kw = keyword.toLowerCase();
  return rejections.some(r => {
    const term = r.keyword.toLowerCase();
    if (r.matchType === 'exact') return kwToSlug(keyword) === kwToSlug(r.keyword);
    return kw.includes(term); // phrase and broad
  });
}
```

Applied in the `due` filter:
```javascript
const rejections = loadRejections();
const due = rows.filter(r =>
  r.publishDate >= now &&
  r.publishDate <= horizon &&
  !existsSync(join(BRIEFS_DIR, `${r.slug}.json`)) &&
  !isRejected(r.keyword, rejections)
);
```

Logs `[SKIP] Rejected keyword: "${keyword}"` when a keyword is filtered out.

---

## Content Strategist (`agents/content-strategist/index.js`)

### Hard filter on brief queue

After Claude returns the brief queue JSON, filter out any rejected keywords before processing:

```javascript
const rejections = loadRejections(); // same function as pipeline-scheduler
const filteredQueue = briefQueue.filter(item => !isRejected(item.keyword, rejections));
```

### Prompt injection

The rejection list is injected into the calendar-generation prompt as a dedicated section. Broad rejections get stronger language:

```javascript
function buildRejectionSection(rejections) {
  if (!rejections.length) return '';
  const lines = rejections.map(r => {
    const note = r.reason ? ` — ${r.reason}` : '';
    if (r.matchType === 'broad') {
      return `- "${r.keyword}" (broad match) — avoid this topic and closely related ideas${note}`;
    }
    if (r.matchType === 'phrase') {
      return `- "${r.keyword}" (phrase match) — do not include keywords containing this phrase${note}`;
    }
    return `- "${r.keyword}" (exact match) — do not schedule this exact keyword${note}`;
  });
  return `\n## Rejected Keywords\nDo not schedule or suggest content related to these topics:\n${lines.join('\n')}\n`;
}
```

Injected into the existing prompt parts array before the calendar generation call.

---

## Error Handling

- If `rejected-keywords.json` is missing or malformed, agents default to empty rejections (never crash)
- If the POST endpoint fails, the modal shows an inline error and stays open — the card is not removed
- Corrupt entries in the JSON array are skipped silently

---

## Out of Scope

- Viewing or undoing rejections (no UI for managing the rejection list)
- Rejections in the keyword rankings table
- Syncing rejections with Google Ads negative keyword lists
