# Ads Suggestion Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an inline per-suggestion chat panel to the Ads Optimization Queue so users can discuss, question, and act on suggestions through a conversation with Claude that can approve, reject, or modify suggestions via tool use, with chat history persisted across page refreshes.

**Architecture:** All changes live in `agents/dashboard/index.js` — a new `POST /ads/:date/suggestion/:id/chat` route (registered before the existing suggestion handler) calls the Anthropic API directly, streams SSE text back to the browser, executes tool calls server-side, and writes updated suggestion+chat data to the existing `data/ads-optimizer/YYYY-MM-DD.json` files. The browser side adds a `chatOpen` Set, a `Discuss` button per actionable suggestion card, an inline chat panel (rendered with the card, toggled visible/hidden), and an SSE consumer that streams Claude's response into a bubble then reloads the panel from server data on completion.

**Tech Stack:** Node.js HTTP server, Anthropic SDK (`@anthropic-ai/sdk`), Server-Sent Events, vanilla browser JS inside Node.js template literal (escape rule: `\\n` not `\n`).

---

## File Map

| File | Change |
|------|--------|
| `agents/dashboard/index.js` | Add Anthropic import + client; add `adsInFlight` Set; add chat endpoint (before line 2895); add `chatOpen` global, `loadAdsOptimization`, `toggleChat`, `renderChatMessages`, `renderToolActionCard`, `sendChatMessage` browser functions; update `renderSuggestionCard` with Discuss button + chat panel |
| `tests/agents/dashboard-ads-chat.test.js` | New test file — string-presence checks for all new server + browser functions |

---

## Task 1: Add Anthropic client to dashboard server

**Files:**
- Modify: `agents/dashboard/index.js:14-19` (imports block)
- Test: `tests/agents/dashboard-ads-chat.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/agents/dashboard-ads-chat.test.js`:

```javascript
import { strict as assert } from 'assert';
import { readFileSync } from 'fs';

const src = readFileSync('agents/dashboard/index.js', 'utf8');

// Task 1: Anthropic client
assert.ok(src.includes("import Anthropic from '@anthropic-ai/sdk'"), 'must import Anthropic SDK');
assert.ok(src.includes('new Anthropic()'), 'must instantiate Anthropic client');

console.log('✓ ads suggestion chat tests pass');
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
node --test tests/agents/dashboard-ads-chat.test.js
```
Expected: fail — `must import Anthropic SDK`

- [ ] **Step 3: Add Anthropic import and client to dashboard**

In `agents/dashboard/index.js`, add after the existing imports (after line 19):

```javascript
import Anthropic from '@anthropic-ai/sdk';
const anthropic = new Anthropic();
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
node --test tests/agents/dashboard-ads-chat.test.js
```
Expected: `✓ ads suggestion chat tests pass`

- [ ] **Step 5: Commit**

```bash
git add agents/dashboard/index.js tests/agents/dashboard-ads-chat.test.js
git commit -m "feat: add Anthropic client to dashboard for suggestion chat"
```

---

## Task 2: Chat endpoint — routing, concurrency guard, validation

The new route URL is `/ads/:date/suggestion/:id/chat`. It must be registered **before** the existing handler at line 2895, which matches any URL containing `/suggestion/` and would silently intercept `/chat` requests.

**Files:**
- Modify: `agents/dashboard/index.js` — near top constants block (adsInFlight Set), and before line 2895 (new route)
- Test: `tests/agents/dashboard-ads-chat.test.js`

- [ ] **Step 1: Add tests for routing and concurrency**

Add to `tests/agents/dashboard-ads-chat.test.js` (before the `console.log` line):

```javascript
// Task 2: Chat endpoint structure
assert.ok(src.includes('const adsInFlight = new Set()'), 'must have adsInFlight concurrency guard');
assert.ok(src.includes("req.url.endsWith('/chat')"), 'must check for /chat suffix to distinguish from existing handler');

// Route ordering: chat handler must appear before the generic suggestion handler
const chatHandlerIdx    = src.indexOf("req.url.endsWith('/chat')");
const genericHandlerIdx = src.indexOf("req.url.includes('/suggestion/')");
assert.ok(chatHandlerIdx < genericHandlerIdx, 'chat route must be registered before generic suggestion handler');

assert.ok(src.includes("'date/id' key"), 'must have 429 in-flight guard comment or equivalent');
assert.ok(src.includes('message.length > 2000'), 'must validate message length');
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
node --test tests/agents/dashboard-ads-chat.test.js
```
Expected: fail — `must have adsInFlight concurrency guard`

- [ ] **Step 3: Add `adsInFlight` Set near top of server constants**

In `agents/dashboard/index.js`, after the `ADS_OPTIMIZER_DIR` constant (around line 70), add:

```javascript
const adsInFlight = new Set(); // concurrency guard: 'date/id' key
```

- [ ] **Step 4: Add chat route handler before line 2895**

Insert immediately before the existing `if (req.method === 'POST' && req.url.startsWith('/ads/') && req.url.includes('/suggestion/'))` block:

```javascript
if (req.method === 'POST' && req.url.startsWith('/ads/') && req.url.includes('/suggestion/') && req.url.endsWith('/chat')) {
  const parts = req.url.split('/'); // ['', 'ads', date, 'suggestion', id, 'chat']
  const date = parts[2], id = parts[4];
  if (!date || !id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Missing date or id' })); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Invalid date' })); return; }

  const inFlightKey = `${date}/${id}`;
  if (adsInFlight.has(inFlightKey)) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Request already in progress' })); return; }
  adsInFlight.add(inFlightKey);

  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', async () => {
    const cleanup = () => adsInFlight.delete(inFlightKey);
    let payload;
    try { payload = JSON.parse(body); } catch { cleanup(); res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' })); return; }
    const message = (payload.message || '').trim();
    if (!message) { cleanup(); res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'message is required' })); return; }
    if (message.length > 2000) { cleanup(); res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'message exceeds 2000 characters' })); return; }

    const filePath = join(ADS_OPTIMIZER_DIR, `${date}.json`);
    if (!existsSync(filePath)) { cleanup(); res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Suggestion file not found' })); return; }
    const fileData = JSON.parse(readFileSync(filePath, 'utf8'));
    const suggestion = fileData.suggestions?.find(s => s.id === id);
    if (!suggestion) { cleanup(); res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Suggestion not found' })); return; }

    // === Chat logic continues in Task 3 ===
    cleanup();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    res.write('data: [DONE]\n\n');
    res.end();
  });
  return;
}
```

Note: the body ends with a stub `[DONE]` response — Task 3 replaces this with full Claude logic.

- [ ] **Step 5: Run test to confirm it passes**

```bash
node --test tests/agents/dashboard-ads-chat.test.js
```
Expected: `✓ ads suggestion chat tests pass`

- [ ] **Step 6: Commit**

```bash
git add agents/dashboard/index.js tests/agents/dashboard-ads-chat.test.js
git commit -m "feat: add chat endpoint shell with concurrency guard and validation"
```

---

## Task 3: Chat endpoint — Claude API call, tool execution, SSE streaming

This task replaces the stub `[DONE]` response with full logic: append user message, reconstruct history, call Claude, handle tool use, stream text response, persist to file.

**Files:**
- Modify: `agents/dashboard/index.js` — the `req.on('end', async () => { ... })` handler added in Task 2

- [ ] **Step 1: Add tests for Claude integration**

Add to `tests/agents/dashboard-ads-chat.test.js` (before `console.log`):

```javascript
// Task 3: Claude integration
assert.ok(src.includes('approve_suggestion'), 'must define approve_suggestion tool');
assert.ok(src.includes('reject_suggestion'), 'must define reject_suggestion tool');
assert.ok(src.includes('update_suggestion'), 'must define update_suggestion tool');
assert.ok(src.includes('proposedCpcMicros'), 'update_suggestion must include proposedCpcMicros param');
assert.ok(src.includes('ALLOWED_UPDATE_FIELDS'), 'must have type-validation table for update_suggestion');
assert.ok(src.includes("role: 'tool_result'"), 'must build tool_result messages for history reconstruction');
assert.ok(src.includes('data: [DONE]'), 'must send DONE sentinel to close stream');
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
node --test tests/agents/dashboard-ads-chat.test.js
```
Expected: fail — `must define approve_suggestion tool`

- [ ] **Step 3: Replace the stub handler with full Claude logic**

Replace the stub section (from `// === Chat logic continues in Task 3 ===` through the final `res.end()`) inside the `req.on('end', async () => { ... })` block:

```javascript
    // Append user message to chat history
    if (!suggestion.chat) suggestion.chat = [];
    const now = () => new Date().toISOString();
    suggestion.chat.push({ role: 'user', content: message, ts: now() });

    // Reconstruct Anthropic SDK message array from chat history
    const messages = [];
    for (let i = 0; i < suggestion.chat.length; i++) {
      const entry = suggestion.chat[i];
      if (entry.role === 'user') {
        messages.push({ role: 'user', content: entry.content });
      } else if (entry.role === 'assistant') {
        const content = [{ type: 'text', text: entry.content }];
        // Merge adjacent tool_call into this assistant message
        if (i + 1 < suggestion.chat.length && suggestion.chat[i + 1].role === 'tool_call') {
          const tc = suggestion.chat[i + 1];
          content.push({ type: 'tool_use', id: tc.tool_use_id, name: tc.tool, input: tc.input });
          i++; // skip the tool_call entry
        }
        messages.push({ role: 'assistant', content });
      } else if (entry.role === 'tool_result') {
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: entry.tool_use_id, content: entry.content }] });
      }
      // tool_call entries are consumed above alongside their assistant message
    }

    // Build system prompt
    const pc = suggestion.proposedChange || {};
    const systemPrompt = [
      `You are an expert Google Ads advisor helping a user decide on an optimization suggestion.`,
      ``,
      `SUGGESTION DETAILS:`,
      `Type: ${suggestion.type}`,
      `Ad Group: ${suggestion.adGroup || 'Campaign-level'}`,
      `Confidence: ${suggestion.confidence}`,
      `Rationale: ${suggestion.rationale}`,
      `Proposed Change: ${JSON.stringify(pc)}`,
      suggestion.ahrefsMetrics ? `Ahrefs Metrics: ${JSON.stringify(suggestion.ahrefsMetrics)}` : null,
      fileData.analysisNotes ? `\nAccount Analysis Notes:\n${fileData.analysisNotes}` : null,
      ``,
      `INSTRUCTIONS:`,
      `Answer the user's questions about this suggestion clearly and concisely.`,
      `Only call approve_suggestion, reject_suggestion, or update_suggestion when the user has explicitly signalled a decision — never speculatively.`,
      `For update_suggestion, only provide fields valid for this suggestion type (${suggestion.type}).`,
    ].filter(Boolean).join('\n');

    // Tool definitions
    const ALLOWED_UPDATE_FIELDS = {
      bid_adjust:    ['proposedCpcMicros'],
      keyword_add:   ['keyword', 'matchType'],
      negative_add:  ['keyword', 'matchType'],
      copy_rewrite:  ['suggestedCopy'],
      keyword_pause: [],
    };

    const tools = [
      {
        name: 'approve_suggestion',
        description: 'Approve the suggestion as-is, setting its status to approved.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'reject_suggestion',
        description: 'Reject the suggestion, setting its status to rejected.',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'update_suggestion',
        description: 'Modify specific fields of the proposed change and approve the suggestion. Only provide fields valid for this suggestion type.',
        input_schema: {
          type: 'object',
          properties: {
            proposedCpcMicros: { type: 'integer', description: 'New max CPC in micros (bid_adjust only)' },
            keyword:           { type: 'string',  description: 'Keyword text (keyword_add / negative_add only)' },
            matchType:         { type: 'string',  enum: ['EXACT', 'PHRASE', 'BROAD'], description: 'Match type (keyword_add / negative_add only)' },
            suggestedCopy:     { type: 'string',  description: 'Replacement copy text (copy_rewrite only)' },
          },
          required: [],
        },
      },
    ];

    // First Claude call (non-streaming) to detect tool use
    let firstResponse;
    try {
      firstResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        messages,
        tools,
      });
    } catch (err) {
      cleanup();
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      res.write(`data: Error contacting Claude: ${err.message}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Extract text and tool use from first response
    const textBlock   = firstResponse.content.find(b => b.type === 'text');
    const toolBlock   = firstResponse.content.find(b => b.type === 'tool_use');
    let finalText     = textBlock?.text || '';
    let toolCallEntry = null;
    let toolResultEntry = null;

    if (toolBlock) {
      // Validate and execute tool
      const allowedFields = ALLOWED_UPDATE_FIELDS[suggestion.type] || [];
      let toolSummary = '';

      if (toolBlock.name === 'approve_suggestion') {
        suggestion.status = 'approved';
        toolSummary = 'status: approved';
      } else if (toolBlock.name === 'reject_suggestion') {
        suggestion.status = 'rejected';
        toolSummary = 'status: rejected';
      } else if (toolBlock.name === 'update_suggestion') {
        const input = toolBlock.input || {};
        const changes = [];
        for (const field of allowedFields) {
          if (input[field] !== undefined) {
            const oldVal = suggestion.proposedChange[field];
            suggestion.proposedChange[field] = input[field];
            changes.push(`${field}: ${oldVal} → ${input[field]}`);
          }
        }
        suggestion.status = 'approved';
        toolSummary = [...changes, 'status: approved'].join(' · ');
      }

      toolCallEntry   = { role: 'tool_call',   tool: toolBlock.name, tool_use_id: toolBlock.id, input: toolBlock.input, ts: now() };
      toolResultEntry = { role: 'tool_result', tool_use_id: toolBlock.id, content: toolSummary, ts: now() };

      // Second Claude call (streaming) to get narration after tool execution
      const messagesWithTool = [
        ...messages,
        { role: 'assistant', content: firstResponse.content },
        { role: 'user',      content: [{ type: 'tool_result', tool_use_id: toolBlock.id, content: toolSummary }] },
      ];

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

      try {
        const stream = anthropic.messages.stream({
          model: 'claude-sonnet-4-6',
          max_tokens: 512,
          system: systemPrompt,
          messages: messagesWithTool,
          tools,
        });
        finalText = '';
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            const chunk = event.delta.text;
            finalText += chunk;
            res.write(`data: ${chunk}\n\n`);
          }
        }
      } catch (err) {
        res.write(`data: Error: ${err.message}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        cleanup();
        return;
      }
    } else {
      // No tool use — write first response text as a single SSE chunk
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      if (finalText) res.write(`data: ${finalText}\n\n`);
    }

    // Persist to chat history and write file
    suggestion.chat.push({ role: 'assistant', content: finalText, ts: now() });
    if (toolCallEntry)   suggestion.chat.push(toolCallEntry);
    if (toolResultEntry) suggestion.chat.push(toolResultEntry);

    try {
      writeFileSync(filePath, JSON.stringify(fileData, null, 2));
    } catch (err) {
      console.error('[chat] Failed to write suggestion file:', err.message);
    }

    res.write('data: [DONE]\n\n');
    res.end();
    cleanup();
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
node --test tests/agents/dashboard-ads-chat.test.js
```
Expected: `✓ ads suggestion chat tests pass`

- [ ] **Step 5: Smoke-test the endpoint manually**

Start the dashboard: `node agents/dashboard/index.js`

Find a pending suggestion id and date from `data/ads-optimizer/`. Send a chat request:

```bash
curl -X POST http://localhost:3000/ads/2026-03-26/suggestion/suggestion-001/chat \
  -H 'Content-Type: application/json' \
  -d '{"message": "Why are you suggesting this?"}' \
  --no-buffer
```

Expected: SSE chunks of text ending with `data: [DONE]`. Verify the suggestion file now has a `chat` array with user + assistant entries.

- [ ] **Step 6: Commit**

```bash
git add agents/dashboard/index.js tests/agents/dashboard-ads-chat.test.js
git commit -m "feat: implement Claude chat endpoint with tool use for suggestion decisions"
```

---

## Task 4: Browser — `chatOpen` global + `loadAdsOptimization`

All browser JS lives inside the `const HTML = \`` template literal in `agents/dashboard/index.js`. Rules:
- Use `\\n` not `\n` inside any string or regex in this section
- Use `var` (consistent with existing code)
- Use `&apos;` for single-quote delimiters inside HTML `onclick` attributes

**Files:**
- Modify: `agents/dashboard/index.js` — browser JS section
- Test: `tests/agents/dashboard-ads-chat.test.js`

- [ ] **Step 1: Add tests for browser globals**

Add to `tests/agents/dashboard-ads-chat.test.js` (before `console.log`):

```javascript
// Task 4: Browser globals
assert.ok(src.includes('var chatOpen = new Set()'), 'must have chatOpen Set');
assert.ok(src.includes('async function loadAdsOptimization()'), 'must have loadAdsOptimization function');
assert.ok(src.includes("fetch('/api/data'"), 'loadAdsOptimization must fetch /api/data');
assert.ok(src.includes('renderAdsOptimization(d)'), 'loadAdsOptimization must call renderAdsOptimization');
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
node --test tests/agents/dashboard-ads-chat.test.js
```
Expected: fail — `must have chatOpen Set`

- [ ] **Step 3: Add `chatOpen` and `loadAdsOptimization` to browser JS**

In the browser JS section (inside the HTML template literal), locate where other global state variables are declared (search for `var data = null` or similar module-level vars). Add directly after them:

```javascript
    var chatOpen = new Set();

    async function loadAdsOptimization() {
      try {
        var res = await fetch('/api/data', { credentials: 'same-origin' });
        var d = await res.json();
        renderAdsOptimization(d);
      } catch(e) { console.error('loadAdsOptimization failed', e); }
    }
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
node --test tests/agents/dashboard-ads-chat.test.js
```
Expected: `✓ ads suggestion chat tests pass`

- [ ] **Step 5: Commit**

```bash
git add agents/dashboard/index.js tests/agents/dashboard-ads-chat.test.js
git commit -m "feat: add chatOpen Set and loadAdsOptimization browser function"
```

---

## Task 5: Browser — chat panel in `renderSuggestionCard`

This task modifies `renderSuggestionCard` (currently lines ~2170–2206) to:
1. Add a **Discuss** button in the action row
2. Render an inline chat panel (hidden by default, visible if `chatOpen.has(s.id)`) below the card div
3. Apply rounded-bottom=0 to the card when panel is open

The chat panel contains rendered chat history (from `s.chat`) and an input row.

Helper functions `renderChatMessages` and `renderToolActionCard` are added above `renderAdsOptimization`.

**Files:**
- Modify: `agents/dashboard/index.js`
- Test: `tests/agents/dashboard-ads-chat.test.js`

- [ ] **Step 1: Add tests**

Add to `tests/agents/dashboard-ads-chat.test.js` (before `console.log`):

```javascript
// Task 5: Chat panel rendering
assert.ok(src.includes('function renderChatMessages('), 'must have renderChatMessages helper');
assert.ok(src.includes('function renderToolActionCard('), 'must have renderToolActionCard helper');
assert.ok(src.includes('chat-panel-'), 'must use chat-panel- prefix for panel element ids');
assert.ok(src.includes('chat-messages-'), 'must use chat-messages- prefix for message container ids');
assert.ok(src.includes('chat-input-'), 'must use chat-input- prefix for input element ids');
assert.ok(src.includes('btn-ads-discuss'), 'must add Discuss button with btn-ads-discuss class');
assert.ok(src.includes('toggleChat('), 'Discuss button must call toggleChat');
assert.ok(src.includes('chatOpen.has(s.id)'), 'renderSuggestionCard must check chatOpen for initial panel visibility');
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
node --test tests/agents/dashboard-ads-chat.test.js
```
Expected: fail — `must have renderChatMessages helper`

- [ ] **Step 3: Add helper functions above `renderAdsOptimization`**

Insert immediately before `function renderAdsOptimization(d) {` (currently around line 2126):

```javascript
    function renderToolActionCard(tc, tr) {
      var label = tc.tool === 'approve_suggestion' ? 'Suggestion approved' :
                  tc.tool === 'reject_suggestion'  ? 'Suggestion rejected' :
                                                     'Suggestion updated & approved';
      var detail = tr ? esc(tr.content) : '';
      return '<div style="display:flex;gap:8px;margin-bottom:10px">' +
        '<div style="width:24px;flex-shrink:0"></div>' +
        '<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:8px 12px;font-size:11px;color:#166534;display:flex;align-items:center;gap:8px;max-width:480px">' +
          '<span style="font-size:14px">&#9881;&#65039;</span>' +
          '<div><div style="font-weight:700;margin-bottom:2px">' + label + '</div>' +
          '<div style="font-family:monospace;color:#166534">' + esc(detail) + '</div></div>' +
        '</div>' +
      '</div>';
    }

    function renderChatMessages(chatArr) {
      var html = '';
      var i = 0;
      while (i < chatArr.length) {
        var m = chatArr[i];
        if (m.role === 'user') {
          html += '<div style="display:flex;gap:8px;margin-bottom:10px;justify-content:flex-end">' +
            '<div style="background:#ede9fe;border:1px solid #c4b5fd;border-radius:8px 0 8px 8px;padding:8px 10px;font-size:12px;color:#374151;max-width:480px">' + esc(m.content) + '</div>' +
            '<div style="background:#6d28d9;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0">Y</div>' +
            '</div>';
          i++;
        } else if (m.role === 'assistant') {
          html += '<div style="display:flex;gap:8px;margin-bottom:10px">' +
            '<div style="background:#818cf8;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0">C</div>' +
            '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:0 8px 8px 8px;padding:8px 10px;font-size:12px;color:#374151;max-width:480px">' + esc(m.content) + '</div>' +
            '</div>';
          if (i + 1 < chatArr.length && chatArr[i + 1].role === 'tool_call') {
            var tc = chatArr[i + 1];
            var tr = (i + 2 < chatArr.length && chatArr[i + 2].role === 'tool_result') ? chatArr[i + 2] : null;
            html += renderToolActionCard(tc, tr);
            i += tr ? 3 : 2;
          } else {
            i++;
          }
        } else {
          i++; // tool_call / tool_result consumed above
        }
      }
      return html;
    }
```

- [ ] **Step 4: Update `renderSuggestionCard` to include Discuss button and chat panel**

Find the existing `renderSuggestionCard` function body. The current `return` statement builds the card HTML ending with the `ads-suggestion-actions` div. Modify it:

Current action buttons block (around line 2199–2204):
```javascript
      '<div class="ads-suggestion-actions">' +
        '<button class="btn-ads-approve" onclick="adsUpdateSuggestion(&apos;' + esc(opt.date) + '&apos;,&apos;' + esc(s.id) + '&apos;,&apos;approved&apos;)">' +
          (isApproved ? '&#10003; Approved' : 'Approve') +
        '</button>' +
        '<button class="btn-ads-reject" onclick="adsUpdateSuggestion(&apos;' + esc(opt.date) + '&apos;,&apos;' + esc(s.id) + '&apos;,&apos;rejected&apos;)">Reject</button>' +
      '</div>' +
    '</div>';
```

Replace with:

```javascript
      '<div class="ads-suggestion-actions">' +
        '<button class="btn-ads-approve" onclick="adsUpdateSuggestion(&apos;' + esc(opt.date) + '&apos;,&apos;' + esc(s.id) + '&apos;,&apos;approved&apos;)">' +
          (isApproved ? '&#10003; Approved' : 'Approve') +
        '</button>' +
        '<button class="btn-ads-reject" onclick="adsUpdateSuggestion(&apos;' + esc(opt.date) + '&apos;,&apos;' + esc(s.id) + '&apos;,&apos;rejected&apos;)">Reject</button>' +
        '<button class="btn-ads-discuss" onclick="toggleChat(&apos;' + esc(s.id) + '&apos;)" style="background:#818cf8">&#128172; Discuss</button>' +
      '</div>' +
    '</div>' +
    '<div id="chat-panel-' + esc(s.id) + '" style="display:' + (chatOpen.has(s.id) ? 'block' : 'none') + ';border:1px solid #818cf8;border-top:none;border-radius:0 0 8px 8px;background:#f8fafc;padding:12px">' +
      '<div id="chat-messages-' + esc(s.id) + '" style="max-height:320px;overflow-y:auto">' + renderChatMessages(s.chat || []) + '</div>' +
      '<div style="display:flex;gap:6px;margin-top:8px">' +
        '<input id="chat-input-' + esc(s.id) + '" placeholder="Ask a follow-up question..." ' +
          'style="flex:1;padding:7px 10px;border:1px solid #c4b5fd;border-radius:6px;font-size:12px;outline:none;background:#fff" ' +
          'onkeydown="if(event.key===\'Enter\')sendChatMessage(&apos;' + esc(opt.date) + '&apos;,&apos;' + esc(s.id) + '&apos;)">' +
        '<button onclick="sendChatMessage(&apos;' + esc(opt.date) + '&apos;,&apos;' + esc(s.id) + '&apos;)" ' +
          'style="padding:7px 14px;background:#818cf8;color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer">Send</button>' +
      '</div>' +
    '</div>';
```

Also modify the opening `<div class="ads-suggestion"` line to apply flattened bottom radius when panel is open:

Replace:
```javascript
    return '<div class="ads-suggestion" id="suggestion-card-' + esc(s.id) + '">' +
```
With:
```javascript
    return '<div class="ads-suggestion" id="suggestion-card-' + esc(s.id) + '" style="' + (chatOpen.has(s.id) ? 'border-bottom-left-radius:0;border-bottom-right-radius:0' : '') + '">' +
```

- [ ] **Step 5: Run test to confirm it passes**

```bash
node --test tests/agents/dashboard-ads-chat.test.js
```
Expected: `✓ ads suggestion chat tests pass`

- [ ] **Step 6: Start dashboard and verify rendering**

```bash
node agents/dashboard/index.js
```

Open the Ads tab in browser. Each pending/approved suggestion should have a `💬 Discuss` button. Clicking it should do nothing yet (toggleChat not implemented) — verify no JS errors in console.

- [ ] **Step 7: Commit**

```bash
git add agents/dashboard/index.js tests/agents/dashboard-ads-chat.test.js
git commit -m "feat: add chat panel HTML to suggestion cards with history rendering"
```

---

## Task 6: Browser — `toggleChat` and `sendChatMessage`

**Files:**
- Modify: `agents/dashboard/index.js`
- Test: `tests/agents/dashboard-ads-chat.test.js`

- [ ] **Step 1: Add tests for interactive functions**

Add to `tests/agents/dashboard-ads-chat.test.js` (before `console.log`):

```javascript
// Task 6: Interactive functions
assert.ok(src.includes('function toggleChat('), 'must have toggleChat function');
assert.ok(src.includes('chatOpen.has(id)'), 'toggleChat must check chatOpen');
assert.ok(src.includes('chatOpen.delete(id)'), 'toggleChat must remove from chatOpen on close');
assert.ok(src.includes('chatOpen.add(id)'), 'toggleChat must add to chatOpen on open');
assert.ok(src.includes('async function sendChatMessage('), 'must have sendChatMessage function');
assert.ok(src.includes('/suggestion/'), 'sendChatMessage must POST to suggestion chat endpoint');
assert.ok(src.includes("endsWith('/chat')") || src.includes("+ '/chat'"), 'sendChatMessage must target /chat endpoint');
assert.ok(src.includes('data: [DONE]'), 'sendChatMessage must handle DONE sentinel');
assert.ok(src.includes('loadAdsOptimization()'), 'sendChatMessage must call loadAdsOptimization on completion');
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
node --test tests/agents/dashboard-ads-chat.test.js
```
Expected: fail — `must have toggleChat function`

- [ ] **Step 3: Add `toggleChat` function to browser JS**

Add after `loadAdsOptimization`:

```javascript
    function toggleChat(id) {
      var panel = document.getElementById('chat-panel-' + id);
      var card  = document.getElementById('suggestion-card-' + id);
      if (!panel) return;
      if (chatOpen.has(id)) {
        chatOpen.delete(id);
        panel.style.display = 'none';
        if (card) { card.style.borderBottomLeftRadius = ''; card.style.borderBottomRightRadius = ''; }
      } else {
        chatOpen.add(id);
        panel.style.display = 'block';
        if (card) { card.style.borderBottomLeftRadius = '0'; card.style.borderBottomRightRadius = '0'; }
      }
    }
```

- [ ] **Step 4: Add `sendChatMessage` function to browser JS**

Add after `toggleChat`:

```javascript
    async function sendChatMessage(date, id) {
      var inputEl = document.getElementById('chat-input-' + id);
      if (!inputEl) return;
      var msg = inputEl.value.trim();
      if (!msg) return;
      inputEl.value = '';
      inputEl.disabled = true;

      // Append user bubble immediately
      var msgsEl = document.getElementById('chat-messages-' + id);
      if (msgsEl) {
        msgsEl.innerHTML += '<div style="display:flex;gap:8px;margin-bottom:10px;justify-content:flex-end">' +
          '<div style="background:#ede9fe;border:1px solid #c4b5fd;border-radius:8px 0 8px 8px;padding:8px 10px;font-size:12px;color:#374151;max-width:480px">' + esc(msg) + '</div>' +
          '<div style="background:#6d28d9;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0">Y</div>' +
          '</div>';
      }

      // Append streaming Claude bubble
      var bubbleId = 'chat-bubble-' + id + '-' + Date.now();
      if (msgsEl) {
        msgsEl.innerHTML += '<div style="display:flex;gap:8px;margin-bottom:10px">' +
          '<div style="background:#818cf8;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0">C</div>' +
          '<div id="' + bubbleId + '" style="background:#fff;border:1px solid #e2e8f0;border-radius:0 8px 8px 8px;padding:8px 10px;font-size:12px;color:#374151;max-width:480px"></div>' +
          '</div>';
        msgsEl.scrollTop = msgsEl.scrollHeight;
      }

      var bubbleEl = document.getElementById(bubbleId);
      var done = false;

      function finish() {
        if (done) return;
        done = true;
        if (inputEl) inputEl.disabled = false;
        loadAdsOptimization();
      }

      try {
        var res = await fetch('/ads/' + date + '/suggestion/' + id + '/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: msg }),
        });
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        function read() {
          reader.read().then(function(result) {
            if (result.done) { finish(); return; }
            var lines = decoder.decode(result.value).split('\\n');
            for (var i = 0; i < lines.length; i++) {
              var line = lines[i];
              if (line === 'data: [DONE]') { finish(); return; }
              if (line.startsWith('data: ')) {
                var chunk = line.slice(6);
                if (bubbleEl) { bubbleEl.textContent += chunk; if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight; }
              }
            }
            read();
          }).catch(function() { finish(); });
        }
        read();
      } catch(e) {
        if (bubbleEl) bubbleEl.textContent = 'Error: ' + e.message;
        if (inputEl) inputEl.disabled = false;
      }
    }
```

- [ ] **Step 5: Run test to confirm it passes**

```bash
node --test tests/agents/dashboard-ads-chat.test.js
```
Expected: `✓ ads suggestion chat tests pass`

- [ ] **Step 6: Full npm test suite**

```bash
npm test
```
Expected: all existing tests still pass, new test passes.

- [ ] **Step 7: End-to-end browser test**

Start dashboard: `node agents/dashboard/index.js`

1. Open Ads tab — verify each pending suggestion shows `💬 Discuss` button
2. Click `💬 Discuss` on a suggestion — panel should expand below the card
3. Click again — panel should collapse
4. Open panel, type a question, click Send — verify streaming response appears word by word in the Claude bubble
5. After stream completes — verify panel reloads with the message in the persisted history, and the chat stays open
6. Send a follow-up asking Claude to approve the suggestion (e.g. "Go ahead and approve it") — verify green tool action card appears, suggestion status updates to `approved`
7. Verify the `data/ads-optimizer/YYYY-MM-DD.json` file has the `chat` array on the suggestion

- [ ] **Step 8: Commit**

```bash
git add agents/dashboard/index.js tests/agents/dashboard-ads-chat.test.js
git commit -m "feat: add toggleChat and sendChatMessage with SSE streaming consumer"
```

---

## Task 7: Branch, PR, deploy

- [ ] **Step 1: Create PR**

```bash
gh pr create --title "feat: ads suggestion chat panel with Claude tool use" --body "$(cat <<'EOF'
## Summary
- Inline chat panel per suggestion card in the Ads Optimization Queue
- Claude can answer questions about suggestions and approve/reject/update them via tool use
- Chat history persists in the suggestion JSON file across page refreshes
- Multiple panels can be open simultaneously; open state survives re-renders

## Test plan
- [ ] `npm test` — all tests pass
- [ ] Each pending suggestion has a 💬 Discuss button
- [ ] Panel toggles open/closed; multiple panels can be open at once
- [ ] Messages stream word-by-word; panel reloads from server data on completion
- [ ] Claude can approve, reject, and update suggestions via tool use (green action card appears)
- [ ] `data/ads-optimizer/YYYY-MM-DD.json` has persisted `chat` arrays after conversations
- [ ] Refreshing the page and reopening a panel shows prior chat history
- [ ] 429 response when same suggestion receives concurrent requests
- [ ] Suggest status update correctly respects type-validation (bid_adjust only gets proposedCpcMicros, etc.)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 2: Merge PR**

```bash
gh pr merge --squash
```

- [ ] **Step 3: Deploy to server**

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && git pull && pm2 restart seo-dashboard'
```

- [ ] **Step 4: Verify server is healthy**

```bash
ssh root@137.184.119.230 'pm2 status && pm2 logs seo-dashboard --lines 10 --nostream'
```

Expected: `seo-dashboard` status `online`, no crash errors in logs.
