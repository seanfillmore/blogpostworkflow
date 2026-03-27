# Ads Suggestion Chat — Design Spec

**Date:** 2026-03-26
**Status:** Approved for implementation

## Overview

Add a per-suggestion chat panel to the Ads tab Optimization Queue. Users can open an inline conversation with Claude beneath any suggestion, ask questions about the rationale, propose alternatives, and let Claude approve, reject, or modify the suggestion directly through tool use. Multiple panels can be open simultaneously. Conversation history persists across page refreshes.

---

## Data Model

Conversation history is stored on each suggestion object inside the existing `data/ads-optimizer/YYYY-MM-DD.json` file. No new files or directories are introduced.

Each suggestion gains a `chat` array (absent or empty by default):

```json
{
  "id": "suggestion-001",
  "status": "pending",
  "proposedChange": { ... },
  "chat": [
    { "role": "user",        "content": "What if I reduce the bid instead?", "ts": "2026-03-26T14:00:00Z" },
    { "role": "assistant",   "content": "A bid reduction could work here...", "ts": "2026-03-26T14:00:02Z" },
    { "role": "tool_call",   "tool": "update_suggestion", "tool_use_id": "toolu_01XyzAbc", "input": { "proposedCpcMicros": 550000 }, "ts": "2026-03-26T14:00:03Z" },
    { "role": "tool_result", "tool_use_id": "toolu_01XyzAbc", "content": "Bid updated to $0.55 and approved.", "ts": "2026-03-26T14:00:03Z" }
  ]
}
```

Tool calls are stored verbatim so the full audit trail replays when the panel is reopened.

---

## Server API

### `POST /ads/:date/suggestion/:id/chat`

**Request body:** `{ "message": "user's text" }`

**Route ordering:** This route must be registered *before* the existing `POST /ads/:date/suggestion/:id` handler, which matches any URL containing `/suggestion/`. Without this ordering, the existing handler intercepts `/chat` requests silently.

**Concurrency guard:** A server-side `Set` of in-flight `"date/id"` keys. If a request arrives for an already in-flight key, respond 429. The key is removed when the stream closes (success or error).

**Processing steps:**

1. Return 429 if `"date/id"` is already in-flight; add to in-flight set
2. Return 400 if `message` exceeds 2000 characters
3. Load `data/ads-optimizer/:date.json`, find suggestion by id
4. Append `{ role: "user", content: message, ts: now }` to `suggestion.chat`
5. Build the Claude messages array from the full `chat` history using this mapping:
   - `user` entries → `{ role: "user", content: text }`
   - `assistant` entries → `{ role: "assistant", content: [{ type: "text", text }] }` — if the next entry is a `tool_call`, merge it into the same `content` array as `{ type: "tool_use", id: entry.tool_use_id, name: entry.tool, input: entry.input }`
   - `tool_result` entries → `{ role: "user", content: [{ type: "tool_result", tool_use_id: entry.tool_use_id, content: entry.content }] }`
6. Call `client.messages.create()` with:
   - `model: "claude-sonnet-4-6"`
   - `system`: suggestion context (type, rationale, proposedChange, adGroup, confidence, Ahrefs metrics, full account analysis notes)
   - `messages`: reconstructed conversation history
   - `tools`: the three tools defined below
7. If the response contains a tool use block, validate the tool input against the suggestion type (see tool definitions), execute the tool (write to file), then make a second `client.messages.create()` call with the tool result appended to get Claude's narration
8. Stream the final text response back to the browser as SSE (`data: <chunk>\n\n`)
9. Append to `suggestion.chat`:
   - `{ role: "assistant", content: text, ts: now }`
   - If tool was called: `{ role: "tool_call", tool: name, tool_use_id: id, input: {...}, ts: now }` and `{ role: "tool_result", tool_use_id: id, content: summary, ts: now }`
10. Write the updated suggestion file to disk
11. Send `data: [DONE]\n\n` to close the stream; remove from in-flight set

**Response:** `text/event-stream` — streamed text chunks, then `data: [DONE]\n\n`

---

## Claude Tools

Three tools are defined and passed to every chat request:

### `approve_suggestion`
Sets `suggestion.status = "approved"`. No parameters.

### `reject_suggestion`
Sets `suggestion.status = "rejected"`. No parameters.

### `update_suggestion`
Merges provided fields into `suggestion.proposedChange`, then sets `suggestion.status = "approved"`.

Parameters (all optional — only provided fields are updated):
- `proposedCpcMicros` (integer) — for `bid_adjust` suggestions
- `keyword` (string) — for `keyword_add` / `negative_add`
- `matchType` (string) — `EXACT`, `PHRASE`, or `BROAD`
- `suggestedCopy` (string) — for `copy_rewrite` suggestions

**Server-side type validation:** Before writing, the server checks that the provided fields are valid for the suggestion's `type`. Invalid fields for the type are ignored (not written). This prevents a misfire from producing a structurally broken `proposedChange` that `apply-ads-changes` would misprocess:

| Suggestion type | Allowed update fields |
|---|---|
| `bid_adjust` | `proposedCpcMicros` |
| `keyword_add` | `keyword`, `matchType` |
| `negative_add` | `keyword`, `matchType` |
| `copy_rewrite` | `suggestedCopy` |
| `keyword_pause` | *(no fields — approve/reject only)* |

Claude's system prompt instructs it to only call these tools when the user has signalled a decision, not speculatively.

---

## Dashboard UI

### Triggering the panel

Each suggestion card in `renderAdsOptimization` gains a **"💬 Discuss"** button alongside the existing Approve/Reject buttons. Clicking it toggles the chat panel open/closed. Multiple panels can be open at the same time.

The Discuss button is hidden once a suggestion reaches `applied` or `rejected` status (no point discussing a closed suggestion).

### Panel structure

The chat panel is rendered directly below its suggestion card, sharing a border and connected visually (top border removed from panel, bottom border-radius removed from card).

```
┌─────────────────────────────────────┐
│  [card] Bid Adjust — $0.47 → $0.65  │  ← suggestion card (border-bottom-radius: 0)
│  [✓ Approve] [✗ Reject] [💬 Discuss] │
├─────────────────────────────────────┤  ← indigo border
│  C  I'm suggesting this because...  │
│                  You: What about... │  ← user messages right-aligned
│  C  $0.55 is a reasonable move...   │
│  ⚙️  Suggestion updated & approved   │  ← green tool action card
│  [ Ask a follow-up...        ] Send  │
└─────────────────────────────────────┘
```

### Message rendering

- **Claude messages** — left-aligned, white bubble, indigo avatar "C"
- **User messages** — right-aligned, lavender bubble, purple avatar "Y"
- **Tool action cards** — full-width green card beneath the Claude message that triggered it. Shows the tool name and a summary of what changed (e.g., `proposedCpcMicros: 470,000 → 550,000 · status: approved`). Never shown inline with text.
- **Streaming** — Claude's response streams in word by word into the current bubble using SSE chunks, same as the existing run-agent log panels

### State management

- `chatOpen` — a `Set` of suggestion IDs with open panels (managed in browser JS, no persistence needed)
- `chatHistory` — not stored in browser JS; always loaded from the suggestion's `chat` array via `loadCampaignCards`-style re-fetch after each response
- After the stream ends, `loadAdsOptimization()` re-renders the suggestion cards. The re-render must check `chatOpen` and rebuild panels for any ID still in the set, so open panels survive the re-render. Panels not in `chatOpen` are rendered collapsed as normal.

### Existing buttons

The Approve/Reject buttons on the suggestion card continue to work independently. The chat panel is additive — users can decide without ever opening it.

---

## Error Handling

- If the Claude API call fails, stream an error message into the chat bubble and do not append to `chat` history (so the user can retry)
- If the suggestion file cannot be written after a tool call, stream an error and log server-side
- The `[DONE]` sentinel is always sent — if an error occurs mid-stream, send an error chunk first, then `[DONE]`

---

## Out of Scope

- Chat for applied/rejected suggestions (read-only history could be a future addition)
- Bulk chat across multiple suggestions at once
- Claude proactively opening chat on new suggestions
