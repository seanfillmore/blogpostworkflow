# Tab Chat Feature — Design Spec

**Date:** 2026-03-27
**Status:** Approved for implementation

## Overview

Add a general-purpose AI chat panel to each dashboard tab. The chat understands the data currently displayed on that tab and can propose action items that feed into the existing per-tab approval queues.

## UI Layout

### Chat Toggle
- A "✦ Chat" button is added to the right side of each tab's header bar (the `tab-actions-bar`)
- One button per tab group (`tab-actions-seo`, `tab-actions-cro`, `tab-actions-ads`, `tab-actions-optimize`)
- Clicking toggles the right sidebar panel open/closed
- Button label changes to "✕ Chat" when open

### Right Sidebar Panel
- Width: ~300px, fixed
- Position: appended inside the tab's main content area as a flex sibling; opening the panel adds a class to the content wrapper that sets `padding-right: 300px` (or similar) so content compresses rather than overlaps
- Panel structure:
  - **Header:** "✦ [Tab Name] Chat" label + close (✕) button
  - **Message list:** scrollable, flex-column, newest at bottom
  - **Input area:** single-line text input + send button; submit on Enter or button click
- Panel state (open/closed) is per-tab and stored in a JS object — switching tabs preserves each tab's open/closed state and message history

### Message Rendering
- User messages: right-aligned, indigo background
- AI messages: left-aligned, light surface background
- Typing indicator: three animated dots (reuse existing `.chat-dot` CSS) while response streams in
- **Action item card:** rendered below AI messages that include a structured action proposal (see Action Items section)

### History
- Ephemeral — message arrays live in a JS object keyed by tab name, cleared on page refresh
- No persistence to disk

## Backend: `/api/chat` Endpoint

### Request
```json
POST /api/chat
{ "tab": "ads", "messages": [{ "role": "user", "content": "..." }, ...] }
```

### Tab Context (System Prompt)
Server reads existing data files for the active tab and builds a concise system prompt. Data loaded per tab:

| Tab | Data Sources |
|-----|-------------|
| `seo` | Latest rank snapshot, latest GSC snapshot, pipeline status summary, content calendar |
| `cro` | Latest CRO brief, latest clarity/GA4/shopify/GSC snapshots |
| `ads` | Latest Google Ads snapshot, active campaigns, current optimization queue |
| `optimize` | Latest optimization briefs and proposed changes |

The system prompt tells the AI:
1. What data is available (summarized, not raw dumps — truncate large arrays)
2. It can propose action items using the `ACTION_ITEM` marker format (see below)
3. It should be concise and focused on the SEO/ads/CRO domain

### Response Streaming
- Returns `text/event-stream` (SSE)
- Each `data:` event contains a text delta chunk
- Final event: `data: [DONE]`

### Action Item Marker Format
When the AI wants to propose a creatable action item, it includes a structured block in its response:

```
<ACTION_ITEM>
{"title": "Add sitelinks to Natural Deodorant ad group", "description": "Add 4 sitelinks: Shop All (/collections/all), Best Sellers (/collections/best-sellers), Sensitive Skin (/collections/sensitive-skin), Free Shipping (/). Sitelinks can increase CTR by 10-20%.", "type": "sitelinks", "tab": "ads"}
</ACTION_ITEM>
```

The frontend strips this marker from displayed text and renders a separate action card below the message.

## Action Item Cards

When an AI message contains an `ACTION_ITEM` block:
- Strip the block from the displayed message text
- Render a yellow card below the message bubble with:
  - "📋 Proposed Action" header
  - Title and description from the JSON
  - "+ Add to Queue" button
- Clicking "+ Add to Queue" calls `POST /api/chat/action-item` with the action item JSON plus the current tab

### Action Item Creation per Tab

| Tab | Destination | Implementation |
|-----|-------------|----------------|
| `ads` | Optimization Queue | Append a new suggestion object to `data/ads-optimizer/<today>.json` (create the file if it doesn't exist). Suggestion gets `status: 'pending'`, a generated `id`, and `source: 'chat'` |
| `cro` | CRO Brief items | Append a new item to the in-memory brief items list; re-render the CRO brief card |
| `seo` | Not yet defined — show a toast "Action item noted" for now |
| `optimize` | Not yet defined — show a toast "Action item noted" for now |

After creation, call `loadData()` to refresh the tab so the new item appears in the existing queue.

## `/api/chat/action-item` Endpoint

```json
POST /api/chat/action-item
{ "tab": "ads", "title": "...", "description": "...", "type": "sitelinks" }
```

- Writes the item to the appropriate data store for the tab
- Returns `{ "ok": true, "id": "<new-item-id>" }`

## Template Literal Safety

All browser-side JavaScript for this feature lives inside the existing Node.js template literal in `agents/dashboard/index.js`. Follow the established rules:
- No `\n` inside string literals — use `\\n`
- No `\s`, `\t`, `\r` inside regex patterns — use `[ ]` or equivalent
- No `\n` in `alert()`/`confirm()` messages

## Out of Scope

- Persisting chat history across page refreshes
- Cross-tab context (each chat only knows its own tab's data)
- Voice input
- File upload / screenshot sharing with the AI
