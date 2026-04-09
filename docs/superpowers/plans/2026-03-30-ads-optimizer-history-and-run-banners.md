# Ads Optimizer History + Run Banners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the ads optimizer aware of previous approval/rejection decisions when generating new suggestions, and replace dashboard run-log terminal readouts with dismissible success/failure banners that auto-refresh the active tab.

**Architecture:** Two independent changes — (1) the ads-optimizer agent loads 30 days of prior suggestion history and injects it into the Claude prompt so re-recommendations cite past decisions; (2) the dashboard's `runAgent()` function is updated to parse exit codes from the SSE stream, hide the `<pre>` log on completion, show a dismissible banner at the top of the active tab, and auto-call `loadData()` when no custom `onDone` is provided.

**Tech Stack:** Node.js ESM, browser-side vanilla JS inside a Node.js template literal (dashboard), SSE streaming, existing `data/ads-optimizer/YYYY-MM-DD.json` file format.

---

## CRITICAL: Dashboard template literal rules

`agents/dashboard/index.js` serves all browser JS inside a Node.js template literal. Node.js processes escape sequences before the browser sees the string:
- `\n` in browser string literals → Node converts to literal newline → browser SyntaxError. Use `\\n`.
- `\s`, `\t` in regex inside the script block → same problem. Use `[ ]` instead of `\s`.
- Single quotes in `onclick` attributes use `&apos;` HTML entity.
- Double quotes in `onclick` attributes use `&quot;` HTML entity or `JSON.stringify(...).replace(/"/g, '&quot;')`.
- Any new browser JS function must be added inside the `<script>` block of the HTML template literal.

---

## File Map

- **Modify:** `agents/ads-optimizer/index.js` — add `loadRecentHistory()` and `buildHistorySection()` exports; call them in `main()` to inject history into the Claude prompt; update system prompt with history instructions.
- **Modify:** `tests/agents/ads-optimizer.test.js` — add tests for the two new exported functions.
- **Modify:** `agents/dashboard/index.js` — two changes:
  1. Server: change the `/run-agent` close handler to emit `data: __exit__:{...}` instead of an SSE `event: done` line.
  2. Browser JS: update `runAgent()` to parse `__exit__`, hide log on done, call `showRunBanner()`, default `onDone` to `loadData()`; add `showRunBanner()` function; add `.run-banner` CSS.

---

## Task 1: `loadRecentHistory` and `buildHistorySection` pure exports

**Files:**
- Modify: `agents/ads-optimizer/index.js` (after the existing exports, before `loadEnv`)
- Modify: `tests/agents/ads-optimizer.test.js`

- [ ] **Step 1: Write the failing tests**

Add to the bottom of `tests/agents/ads-optimizer.test.js`:

```javascript
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadRecentHistory,
  buildHistorySection,
} from '../../agents/ads-optimizer/index.js';

// ── loadRecentHistory ─────────────────────────────────────────────────────────

// Returns empty array when directory doesn't exist
assert.deepEqual(loadRecentHistory('/tmp/no-such-dir-ads-test'), []);

// Setup: write two fake history files
const tmpDir = join(tmpdir(), 'ads-history-test-' + Date.now());
mkdirSync(tmpDir, { recursive: true });

const today = new Date().toISOString().slice(0, 10);
const oldDate = '2020-01-01'; // outside 30-day window

writeFileSync(join(tmpDir, `${today}.json`), JSON.stringify({
  suggestions: [
    { id: 's1', type: 'keyword_pause', target: 'cheap shampoo', status: 'rejected', rationale: 'Reject reason.' },
    { id: 's2', type: 'negative_add', target: 'free samples', status: 'applied', rationale: 'Applied reason.' },
    { id: 's3', type: 'bid_adjust', target: 'natural deodorant', status: 'pending', rationale: 'Pending.' },
  ],
}));
writeFileSync(join(tmpDir, `${oldDate}.json`), JSON.stringify({
  suggestions: [{ id: 's4', type: 'keyword_pause', target: 'old keyword', status: 'rejected', rationale: 'Old.' }],
}));

const history = loadRecentHistory(tmpDir, 30);

// Only returns non-pending suggestions within the 30-day window
assert.equal(history.length, 2, 'must return only non-pending suggestions within 30 days');
assert.ok(history.every(h => h.status !== 'pending'), 'must not include pending suggestions');
assert.ok(history.every(h => h.date === today), 'must not include suggestions outside 30-day window');

// History items have required shape
const h = history[0];
assert.ok('date' in h, 'must have date');
assert.ok('type' in h, 'must have type');
assert.ok('target' in h, 'must have target');
assert.ok('status' in h, 'must have status');
assert.ok('rationale' in h, 'must have rationale');

// ── buildHistorySection ───────────────────────────────────────────────────────

// Empty history → empty string
assert.equal(buildHistorySection([]), '');

// Populated history → markdown section with header
const section = buildHistorySection([
  { date: '2026-03-28', type: 'keyword_pause', target: 'cheap shampoo', status: 'rejected', rationale: 'Low intent.' },
  { date: '2026-03-29', type: 'negative_add', target: 'free samples', status: 'applied', rationale: 'Freebie intent.' },
]);
assert.ok(section.startsWith('### Previous Recommendation History'), 'must start with header');
assert.ok(section.includes('REJECTED'), 'must include uppercased status');
assert.ok(section.includes('cheap shampoo'), 'must include target');
assert.ok(section.includes('2026-03-28'), 'must include date');

// Cleanup
rmSync(tmpDir, { recursive: true });

console.log('✓ loadRecentHistory and buildHistorySection tests pass');
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
node tests/agents/ads-optimizer.test.js
```

Expected: error about `loadRecentHistory` not being exported (or similar import error).

- [ ] **Step 3: Add the two exports to `agents/ads-optimizer/index.js`**

Add after the existing `parseSuggestionsResponse` export (around line 75, before the `// ── Data loading ──` comment):

```javascript
/**
 * loadRecentHistory(dir, days)
 * Reads the last `days` daily suggestion files and returns all non-pending
 * suggestions as a flat array of history records.
 */
export function loadRecentHistory(dir, days = 30) {
  if (!existsSync(dir)) return [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) >= cutoffStr)
    .sort()
    .flatMap(f => {
      try {
        const { suggestions = [] } = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        const date = f.slice(0, 10);
        return suggestions
          .filter(s => s.status !== 'pending')
          .map(s => ({ date, id: s.id, type: s.type, target: s.target, status: s.status, rationale: s.rationale }));
      } catch { return []; }
    });
}

/**
 * buildHistorySection(history)
 * Formats a history array into a markdown prompt section for Claude.
 * Returns empty string when history is empty.
 */
export function buildHistorySection(history) {
  if (!history.length) return '';
  const lines = ['### Previous Recommendation History (last 30 days)'];
  for (const h of history) {
    lines.push(`- ${h.date} [${h.status.toUpperCase()}] ${h.type}: "${h.target}" — ${h.rationale}`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
node tests/agents/ads-optimizer.test.js
```

Expected: `✓ ads-optimizer pure function tests pass` then `✓ loadRecentHistory and buildHistorySection tests pass`

- [ ] **Step 5: Commit**

```bash
git add agents/ads-optimizer/index.js tests/agents/ads-optimizer.test.js
git commit -m "feat: add loadRecentHistory and buildHistorySection exports to ads-optimizer"
```

---

## Task 2: Inject history into the ads-optimizer prompt

**Files:**
- Modify: `agents/ads-optimizer/index.js` (`main()` function, lines ~109–246)

The `main()` function currently builds the Claude prompt from `parts` array. We add history loading before building the prompt and inject a new section.

- [ ] **Step 1: Write a snapshot test for the history being present in parts**

This is tested indirectly — we verify `buildHistorySection` produces output in Task 1. The integration is confirmed manually after deploying. Skip a new test here to avoid mocking Claude.

- [ ] **Step 2: Update `main()` to load history and inject it**

In `main()`, find the block that builds `const parts = [...]` (around line 192). Add history loading before it, and add the history section to `parts`:

```javascript
  // Load previous recommendation history
  const history = loadRecentHistory(join(ROOT, 'data', 'ads-optimizer'));
  const historySection = buildHistorySection(history);
  if (history.length > 0) {
    console.log(`  History: ${history.length} prior decisions loaded`);
  }

  const parts = [
    `Analyze the following Google Ads account data and return optimization suggestions as JSON.`,
    campaignContext,
    historySection,
    `### Google Ads Snapshot (${adsSnap.date})\n${JSON.stringify(adsSnap, null, 2)}`,
    gscSnaps.length ? `### GSC Data (${gscSnaps.length} days, most recent first)\n${JSON.stringify(gscSnaps, null, 2)}` : '',
    ga4Snaps.length ? `### GA4 Data (${ga4Snaps.length} days, most recent first)\n${JSON.stringify(ga4Snaps, null, 2)}` : '',
    shopifySnaps.length ? `### Shopify Data (${shopifySnaps.length} days, most recent first)\n${JSON.stringify(shopifySnaps, null, 2)}` : '',
  ].filter(Boolean);
```

- [ ] **Step 3: Update the system prompt to instruct Claude how to use history**

In the `systemPrompt` string (around line 140), add this paragraph after "Return ONLY valid JSON..." and before the closing backtick:

```
When Previous Recommendation History is provided:
- Do NOT re-recommend items with status "applied" — they have already been executed.
- Do NOT re-recommend items with status "approved" that have no newer "applied" entry — they are awaiting action.
- DO re-recommend items with status "rejected" if the underlying data still supports the suggestion. In the rationale, cite the prior rejection: e.g. "Previously recommended ${date}, rejected — keyword continues to waste spend with X clicks and 0 conversions."
```

- [ ] **Step 4: Verify locally**

```bash
node agents/ads-optimizer/index.js
```

Expected output includes: `History: N prior decisions loaded` (if prior files exist) and completes without error.

- [ ] **Step 5: Commit**

```bash
git add agents/ads-optimizer/index.js
git commit -m "feat: inject 30-day suggestion history into ads-optimizer prompt"
```

---

## Task 3: Server — emit `__exit__` signal from `/run-agent` endpoint

**Files:**
- Modify: `agents/dashboard/index.js` (server section, around line 3758)

The current server code emits an SSE `event: done` line that the client ignores. Replace it with a `data: __exit__:` line the client can parse as a regular data line.

- [ ] **Step 1: Write the test**

Add to `tests/agents/dashboard-pipeline.test.js` (or create a new source-level assertion file at `tests/agents/dashboard-run-agent.test.js`):

```javascript
import { readFileSync } from 'node:fs';
const src = readFileSync('agents/dashboard/index.js', 'utf8');

// Server must emit __exit__ signal, not SSE event: done
assert.ok(
  src.includes('data: __exit__:'),
  'run-agent endpoint must emit data: __exit__: signal'
);
assert.ok(
  !src.includes("event: done\\ndata:"),
  'run-agent endpoint must not use SSE event: done format'
);

console.log('✓ run-agent server emits __exit__ signal');
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node tests/agents/dashboard-run-agent.test.js
```

Expected: assertion failure about `data: __exit__:` not found.

- [ ] **Step 3: Update the server close handler**

Find this line (around line 3758):

```javascript
child.on('close', code => { res.write(`event: done\ndata: ${JSON.stringify({ code })}\n\n`); res.end(); });
```

Replace with:

```javascript
child.on('close', code => { res.write(`data: __exit__:${JSON.stringify({ code })}\n\n`); res.end(); });
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node tests/agents/dashboard-run-agent.test.js
```

Expected: `✓ run-agent server emits __exit__ signal`

- [ ] **Step 5: Commit**

```bash
git add agents/dashboard/index.js tests/agents/dashboard-run-agent.test.js
git commit -m "feat: emit __exit__ signal from run-agent endpoint for exit code parsing"
```

---

## Task 4: Dashboard — banner CSS, `showRunBanner`, and updated `runAgent`

**Files:**
- Modify: `agents/dashboard/index.js` (browser JS and CSS sections)

**REMINDER:** All JS here lives inside a Node.js template literal. Use `\\n` not `\n` in strings. Use `[ ]` not `\s` in regex. Use `&apos;` for single quotes in onclick, `&quot;` for double quotes.

- [ ] **Step 1: Write source-level tests**

Add to `tests/agents/dashboard-run-agent.test.js`:

```javascript
// Banner CSS must be present
assert.ok(src.includes('.run-banner {'), 'must have .run-banner CSS');
assert.ok(src.includes('.run-banner-success {'), 'must have .run-banner-success CSS');
assert.ok(src.includes('.run-banner-error {'), 'must have .run-banner-error CSS');
assert.ok(src.includes('.run-banner-dismiss {'), 'must have .run-banner-dismiss CSS');

// showRunBanner function must exist
assert.ok(src.includes('function showRunBanner('), 'must have showRunBanner function');

// runAgent must parse __exit__ and hide log on done
assert.ok(src.includes('__exit__:'), 'runAgent must parse __exit__ signal');
assert.ok(src.includes("logEl.style.display = 'none'"), 'runAgent must hide log on completion');

// runAgent must default to loadData when onDone is null
assert.ok(src.includes('if (onDone) onDone(); else loadData();'), 'runAgent must call loadData when no onDone');

console.log('✓ dashboard run banner source assertions pass');
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node tests/agents/dashboard-run-agent.test.js
```

Expected: multiple assertion failures.

- [ ] **Step 3: Add `.run-banner` CSS**

Find the `.run-log` CSS line (around line 888):

```css
  .run-log { margin: 0.5rem 24px 0.5rem; padding: 0.75rem; background: #0d0d0d; color: #7ee787; font-size: 0.78rem; border-radius: 6px; max-height: 200px; overflow-y: auto; white-space: pre-wrap; }
```

Add these lines immediately after it:

```css
  .run-banner { display: flex; align-items: center; gap: 0.5rem; padding: 0.6rem 1rem; border-radius: 6px; font-size: 0.85rem; margin: 0 0 0.5rem; }
  .run-banner-success { background: #d1fae5; color: #065f46; border: 1px solid #6ee7b7; }
  .run-banner-error { background: #fee2e2; color: #7f1d1d; border: 1px solid #fca5a5; }
  .run-banner-dismiss { margin-left: auto; background: none; border: none; cursor: pointer; font-size: 1rem; color: inherit; padding: 0 0.25rem; line-height: 1; }
```

- [ ] **Step 4: Add `showRunBanner` function**

Find the `function runAgent(` line (around line 3209) and add the new function **immediately before** it:

```javascript
function showRunBanner(script, tabName, success, logId) {
  var tabEl = document.getElementById('tab-' + tabName);
  if (!tabEl) return;
  var bannerId = 'run-banner-' + tabName;
  var existing = document.getElementById(bannerId);
  if (existing) existing.remove();
  var name = script.split('/').pop().replace('.js', '');
  var banner = document.createElement('div');
  banner.id = bannerId;
  banner.className = 'run-banner ' + (success ? 'run-banner-success' : 'run-banner-error');
  var showLog = !success ? ' &mdash; <a href="#" onclick="document.getElementById(&quot;' + logId + '&quot;).style.display=&quot;block&quot;;return false">show log</a>' : '';
  banner.innerHTML = (success ? '&#10003; ' : '&#10007; ') + esc(name) + (success ? ' completed' : ' failed') + showLog +
    '<button class="run-banner-dismiss" onclick="this.parentNode.remove()">&#10005;</button>';
  tabEl.insertBefore(banner, tabEl.firstChild);
}
```

- [ ] **Step 5: Update `runAgent` to parse `__exit__`, hide log, show banner, default to `loadData`**

Replace the existing `runAgent` function (lines 3209–3234):

**Current:**
```javascript
function runAgent(script, args = [], onDone = null) {
  const logId = 'run-log-' + script.replace(/[^a-z0-9]/gi, '-');
  const logEl = document.getElementById(logId);
  if (!logEl) return;
  logEl.textContent = 'Running...\\n';
  logEl.style.display = 'block';
  fetch('/run-agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script, args }),
  }).then(res => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    function read() {
      reader.read().then(({ done, value }) => {
        if (done) { if (onDone) onDone(); return; }
        for (const line of decoder.decode(value).split('\\n')) {
          if (line.startsWith('data: ')) logEl.textContent += line.slice(6) + '\\n';
        }
        logEl.scrollTop = logEl.scrollHeight;
        read();
      });
    }
    read();
  });
}
```

**Replace with:**
```javascript
function runAgent(script, args, onDone) {
  if (args === undefined) args = [];
  if (onDone === undefined) onDone = null;
  var logId = 'run-log-' + script.replace(/[^a-z0-9]/gi, '-');
  var logEl = document.getElementById(logId);
  if (!logEl) return;
  logEl.textContent = 'Running...\\n';
  logEl.style.display = 'block';
  var capturedTab = activeTab;
  var exitCode = null;
  fetch('/run-agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script: script, args: args }),
  }).then(function(res) {
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    function read() {
      reader.read().then(function(chunk) {
        if (chunk.done) {
          logEl.style.display = 'none';
          showRunBanner(script, capturedTab, exitCode === 0, logId);
          if (onDone) onDone(); else loadData();
          return;
        }
        var lines = decoder.decode(chunk.value).split('\\n');
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.startsWith('data: __exit__:')) {
            try { exitCode = JSON.parse(line.slice(15)).code; } catch(e) {}
          } else if (line.startsWith('data: ')) {
            logEl.textContent += line.slice(6) + '\\n';
          }
        }
        logEl.scrollTop = logEl.scrollHeight;
        read();
      });
    }
    read();
  });
}
```

Note: `'data: __exit__:'.length === 15` — that's the slice offset.

- [ ] **Step 6: Run the tests to verify they pass**

```bash
node tests/agents/dashboard-run-agent.test.js
```

Expected: all assertions pass.

- [ ] **Step 7: Smoke test locally**

```bash
node agents/dashboard/index.js
```

Open `http://localhost:4242`, go to the Ads tab, click "Run Ads Optimizer". Verify:
- The green `<pre>` log appears while running
- When it completes, the log disappears and a green banner appears at the top of the Ads tab with "✓ ads-optimizer completed"
- The X button dismisses the banner
- The tab data refreshes (ads suggestions reload)

If the agent fails (e.g. no snapshot), the banner should be red with "✗ ads-optimizer failed — show log".

- [ ] **Step 8: Commit**

```bash
git add agents/dashboard/index.js tests/agents/dashboard-run-agent.test.js
git commit -m "feat: replace run-log readouts with dismissible banners; auto-refresh tab on agent completion"
```

---

## Final: Run all tests and push

- [ ] **Step 1: Run full test suite**

```bash
node tests/agents/ads-optimizer.test.js && node tests/agents/dashboard-run-agent.test.js && node tests/agents/dashboard-pipeline.test.js
```

Expected: all pass.

- [ ] **Step 2: Push branch and create PR**

```bash
git push -u origin feature/ads-optimizer-history-run-banners
gh pr create --title "Ads optimizer history injection + run banners" --body "$(cat <<'EOF'
## Summary
- Ads optimizer loads 30 days of prior suggestion history and injects it into the Claude prompt so rejected suggestions are re-recommended with escalating rationale ("rejected March 28, continues to waste spend")
- Applied and awaiting-approval suggestions are skipped to avoid duplicate recommendations
- `/run-agent` server endpoint now emits `data: __exit__:{code}` for exit code signaling
- `runAgent()` in the dashboard: parses exit code, hides the `<pre>` log on completion, shows a green/red dismissible banner at the top of the active tab
- Banner failure state includes "show log" link to reveal the raw output
- All `runAgent` calls with no `onDone` now auto-call `loadData()` to refresh tab data

## Test Plan
- [ ] Run ads optimizer — verify banner appears and tab refreshes
- [ ] Simulate failure (remove Google Ads snapshot) — verify red banner with show log link
- [ ] Verify prior rejected suggestion appears with amended rationale in next run
EOF
)"
```
