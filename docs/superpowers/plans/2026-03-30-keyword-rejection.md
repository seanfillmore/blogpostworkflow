# Keyword Rejection System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reject button to Pending and Briefed kanban cards that opens a match-type modal, stores the rejection in `data/rejected-keywords.json`, and wires pipeline-scheduler and content-strategist to skip rejected keywords.

**Architecture:** Three layers — a JSON flat file as the source of truth, a dashboard endpoint + modal for creating rejections, and integration in two agents. Each agent defines its own `loadRejections`/`isRejected` helpers and exports them for testing. No shared library.

**Tech Stack:** Node.js ESM, vanilla JS dashboard (Node.js template literal serving browser JS), JSON flat-file storage

---

## File Structure

- **Modify:** `agents/pipeline-scheduler/index.js` — add `import.meta` guard, export `loadRejections` + `isRejected`, filter `due` array
- **Modify:** `agents/content-strategist/index.js` — add `import.meta` guard, export `loadRejections` + `isRejected` + `buildRejectionSection`, inject into prompt, filter brief queue
- **Modify:** `agents/dashboard/index.js` — add `POST /api/reject-keyword` endpoint, rejection modal HTML, `rejectKeyword()` + supporting browser JS functions, reject button on kanban cards
- **Create:** `tests/agents/rejected-keywords.test.js` — unit tests for both `isRejected` implementations and `buildRejectionSection`
- **Create:** `tests/agents/dashboard-reject-keyword.test.js` — source-level assertion test for the dashboard endpoint

---

### Task 1: Add `import.meta` guards and export rejection helpers

Both agents call `main()` at module level. Without a guard, importing them in tests triggers main execution and potentially crashes the test process. Add the guard first, then export helpers.

**Files:**
- Modify: `agents/pipeline-scheduler/index.js`
- Modify: `agents/content-strategist/index.js`
- Create: `tests/agents/rejected-keywords.test.js`

- [ ] **Step 1: Add `import.meta` guard to `agents/pipeline-scheduler/index.js`**

The last line of `agents/pipeline-scheduler/index.js` is currently:
```javascript
main().catch(e => { console.error(e.message); process.exit(1); });
```

Replace it with:
```javascript
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}
```

`fileURLToPath` is already imported at the top of the file.

- [ ] **Step 2: Add exported helpers to `agents/pipeline-scheduler/index.js`**

Add these two exported functions immediately after the `kwToSlug` function (after line 26):

```javascript
export function loadRejections() {
  const path = join(ROOT, 'data', 'rejected-keywords.json');
  if (!existsSync(path)) return [];
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
}

export function isRejected(keyword, rejections) {
  const kw = keyword.toLowerCase();
  return rejections.some(r => {
    const term = r.keyword.toLowerCase();
    if (r.matchType === 'exact') return kwToSlug(keyword) === kwToSlug(r.keyword);
    return kw.includes(term);
  });
}
```

- [ ] **Step 3: Add `import.meta` guard to `agents/content-strategist/index.js`**

The last lines of `agents/content-strategist/index.js` are currently:
```javascript
main().then(() => {
  console.log('\nStrategy complete.');
}).catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
```

Replace with:
```javascript
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(() => {
    console.log('\nStrategy complete.');
  }).catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
```

`fileURLToPath` is already imported at line 17.

- [ ] **Step 4: Add exported helpers to `agents/content-strategist/index.js`**

Add these three exported functions in the `// ── helpers ───` section (after the `loadLatestRankReport` function, around line 65):

```javascript
export function loadRejections() {
  const path = join(ROOT, 'data', 'rejected-keywords.json');
  if (!existsSync(path)) return [];
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
}

export function isRejected(keyword, rejections) {
  const kw = keyword.toLowerCase().trim();
  return rejections.some(r => {
    const term = r.keyword.toLowerCase().trim();
    if (r.matchType === 'exact') return kw === term;
    return kw.includes(term);
  });
}

export function buildRejectionSection(rejections) {
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

- [ ] **Step 5: Write failing tests**

Create `tests/agents/rejected-keywords.test.js`:

```javascript
import { strict as assert } from 'node:assert';
import { isRejected as schedulerIsRejected } from '../../agents/pipeline-scheduler/index.js';
import { isRejected, buildRejectionSection } from '../../agents/content-strategist/index.js';

// ── pipeline-scheduler isRejected ───────────────────────────────────────────

const exactR  = [{ keyword: 'sls', matchType: 'exact' }];
const phraseR = [{ keyword: 'sls', matchType: 'phrase' }];
const broadR  = [{ keyword: 'sls', matchType: 'broad' }];

// exact: matches slug of identical keyword
assert.equal(schedulerIsRejected('sls', exactR), true, 'exact: matches identical');
// exact: slug comparison makes it case-insensitive
assert.equal(schedulerIsRejected('SLS', exactR), true, 'exact: case-insensitive via slug');
// exact: does NOT match a longer keyword that contains the term
assert.equal(schedulerIsRejected('best sls free toothpaste', exactR), false, 'exact: no substring match');

// phrase: matches any keyword containing the term
assert.equal(schedulerIsRejected('best sls free toothpaste', phraseR), true, 'phrase: matches containing keyword');
assert.equal(schedulerIsRejected('toothpaste without sodium lauryl sulfate', phraseR), false, 'phrase: no false positive');

// broad: same hard filter as phrase
assert.equal(schedulerIsRejected('sls toothpaste', broadR), true, 'broad: substring match');

// empty list: never blocks
assert.equal(schedulerIsRejected('anything', []), false, 'empty list: never blocks');

// ── content-strategist isRejected ───────────────────────────────────────────

assert.equal(isRejected('sls', exactR), true, 'strategist exact: matches');
assert.equal(isRejected('SLS', exactR), true, 'strategist exact: case-insensitive');
assert.equal(isRejected('best sls toothpaste', exactR), false, 'strategist exact: no substring match');
assert.equal(isRejected('best sls toothpaste', phraseR), true, 'strategist phrase: matches substring');
assert.equal(isRejected('unrelated keyword', phraseR), false, 'strategist phrase: no false positive');

// ── buildRejectionSection ────────────────────────────────────────────────────

assert.equal(buildRejectionSection([]), '', 'empty list returns empty string');

const section = buildRejectionSection([
  { keyword: 'sls', matchType: 'broad', reason: 'too broad' },
  { keyword: 'itchy armpits', matchType: 'exact', reason: null },
  { keyword: 'sweating', matchType: 'phrase', reason: 'off-brand' },
]);
assert.ok(section.includes('## Rejected Keywords'), 'includes heading');
assert.ok(section.includes('"sls" (broad match)'), 'broad entry present');
assert.ok(section.includes('avoid this topic'), 'broad has avoidance language');
assert.ok(section.includes('too broad'), 'reason included when present');
assert.ok(section.includes('"itchy armpits" (exact match)'), 'exact entry present');
assert.ok(!section.includes('null'), 'null reason not rendered');
assert.ok(section.includes('"sweating" (phrase match)'), 'phrase entry present');
assert.ok(section.includes('off-brand'), 'phrase reason included');

console.log('All rejected-keywords tests passed.');
```

- [ ] **Step 6: Run tests to verify they pass**

```bash
node tests/agents/rejected-keywords.test.js
```

Expected output:
```
All rejected-keywords tests passed.
```

- [ ] **Step 7: Commit**

```bash
git add agents/pipeline-scheduler/index.js agents/content-strategist/index.js tests/agents/rejected-keywords.test.js
git commit -m "feat: export rejection helpers from pipeline agents, add import.meta guards"
```

---

### Task 2: Pipeline-scheduler — filter rejected keywords

**Files:**
- Modify: `agents/pipeline-scheduler/index.js`

- [ ] **Step 1: Replace the `due` filter in `main()`**

Find these lines in `agents/pipeline-scheduler/index.js` (around line 61):
```javascript
// Find keywords due within 14 days with no brief
const due = rows.filter(r =>
  r.publishDate >= now &&
  r.publishDate <= horizon &&
  !existsSync(join(BRIEFS_DIR, `${r.slug}.json`))
);
```

Replace with:
```javascript
// Find keywords due within 14 days with no brief and not rejected
const rejections = loadRejections();
const due = rows.filter(r => {
  if (r.publishDate < now || r.publishDate > horizon) return false;
  if (existsSync(join(BRIEFS_DIR, `${r.slug}.json`))) return false;
  if (isRejected(r.keyword, rejections)) {
    console.log(`  [SKIP] Rejected keyword: "${r.keyword}"`);
    return false;
  }
  return true;
});
```

- [ ] **Step 2: Verify with dry-run**

```bash
node agents/pipeline-scheduler/index.js --dry-run
```

Expected: No errors. Output is either `No briefs needed in the next 14 days.` or `Brief needed: "..." (due ...)`. If a `data/rejected-keywords.json` doesn't exist, `loadRejections()` returns `[]` and nothing changes.

- [ ] **Step 3: Commit**

```bash
git add agents/pipeline-scheduler/index.js
git commit -m "feat: pipeline-scheduler skips rejected keywords"
```

---

### Task 3: Content-strategist — prompt injection and brief queue filter

**Files:**
- Modify: `agents/content-strategist/index.js`

- [ ] **Step 1: Load rejections before the calendar prompt**

In `agents/content-strategist/index.js`, in the `main()` function, find the line that starts building `calendarPrompt` (around line 139). Just before it, add:

```javascript
const rejections = loadRejections();
```

- [ ] **Step 2: Inject rejection section into the calendar prompt**

Inside the `calendarPrompt` template literal, find the `CONTENT GAP REPORT:` section near the end (around line 158):

```javascript
CONTENT GAP REPORT:
${gapReport}
```

Change it to:
```javascript
CONTENT GAP REPORT:
${gapReport}
${buildRejectionSection(rejections)}
```

- [ ] **Step 3: Filter the brief queue after extraction**

Find the lines after `briefQueue` is parsed (around line 226):
```javascript
    if (limit) briefQueue = briefQueue.slice(0, limit);
  } catch (e) {
    console.log('(parse error — queue will be empty)');
```

Add the rejection filter immediately after the `if (limit)` line and before the `} catch`:
```javascript
    if (limit) briefQueue = briefQueue.slice(0, limit);
    briefQueue = briefQueue.filter(item => {
      if (isRejected(item.keyword, rejections)) {
        console.log(`  [SKIP] Rejected keyword: "${item.keyword}"`);
        return false;
      }
      return true;
    });
  } catch (e) {
    console.log('(parse error — queue will be empty)');
```

- [ ] **Step 4: Verify no crash on startup**

```bash
node --input-type=module <<'EOF'
import { loadRejections, isRejected, buildRejectionSection } from './agents/content-strategist/index.js';
console.log('imports ok');
console.log('loadRejections:', loadRejections());
console.log('isRejected test:', isRejected('sls', [{ keyword: 'sls', matchType: 'exact' }]));
console.log('buildRejectionSection empty:', buildRejectionSection([]));
EOF
```

Expected:
```
imports ok
loadRejections: []
isRejected test: true
buildRejectionSection empty:
```

- [ ] **Step 5: Commit**

```bash
git add agents/content-strategist/index.js
git commit -m "feat: content-strategist injects rejected keywords into prompt and filters brief queue"
```

---

### Task 4: Dashboard — `/api/reject-keyword` endpoint

**Files:**
- Modify: `agents/dashboard/index.js`
- Create: `tests/agents/dashboard-reject-keyword.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/agents/dashboard-reject-keyword.test.js`:

```javascript
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync('agents/dashboard/index.js', 'utf8');

assert.ok(src.includes("req.url === '/api/reject-keyword'"), 'endpoint route exists');
assert.ok(src.includes('rejected-keywords.json'), 'references rejected-keywords.json');
assert.ok(src.includes('rejectedAt'), 'writes rejectedAt timestamp');
assert.ok(src.includes("{ ok: true }"), 'returns ok: true on success');
assert.ok(src.includes("keyword and matchType are required"), 'validates required fields');

console.log('All dashboard-reject-keyword tests passed.');
```

- [ ] **Step 2: Run to verify it fails**

```bash
node tests/agents/dashboard-reject-keyword.test.js
```

Expected: Fails on `endpoint route exists`.

- [ ] **Step 3: Add the endpoint to `agents/dashboard/index.js`**

In the HTTP server handler, find the last `if (req.method === 'POST' ...)` block before the 404 fallback and add the new endpoint after it:

```javascript
  if (req.method === 'POST' && req.url === '/api/reject-keyword') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        return;
      }
      const { keyword, matchType, reason } = payload;
      if (!keyword || !matchType) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'keyword and matchType are required' }));
        return;
      }
      try {
        const filePath = join(ROOT, 'data', 'rejected-keywords.json');
        const existing = existsSync(filePath)
          ? JSON.parse(readFileSync(filePath, 'utf8'))
          : [];
        existing.push({ keyword, matchType, reason: reason || null, rejectedAt: new Date().toISOString() });
        writeFileSync(filePath, JSON.stringify(existing, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node tests/agents/dashboard-reject-keyword.test.js
```

Expected: `All dashboard-reject-keyword tests passed.`

- [ ] **Step 5: Commit**

```bash
git add agents/dashboard/index.js tests/agents/dashboard-reject-keyword.test.js
git commit -m "feat: add POST /api/reject-keyword endpoint to dashboard"
```

---

### Task 5: Dashboard — rejection modal and kanban UI

**CRITICAL — Template literal escape rules:**
All browser JS in `agents/dashboard/index.js` lives inside a Node.js template literal. Node.js processes escape sequences before the browser sees the string:
- Use `\\n` (two chars) for newlines in browser JS string literals — never single `\n`
- Never use `\s`, `\t`, `\r` in regex inside the script block
- For HTML attribute values in browser JS strings, use `&quot;` for double quotes and `&apos;` for single quotes

**Files:**
- Modify: `agents/dashboard/index.js`

- [ ] **Step 1: Add `.kw-reject-btn` CSS**

Find the `.kanban-item` CSS rule in the `<style>` block and add immediately after it:

```css
  .kw-reject-btn { margin-top:6px; font-size:0.7rem; color:#ef4444; background:none; border:1px solid #fca5a5; border-radius:5px; padding:2px 8px; cursor:pointer; width:100%; }
  .kw-reject-btn:hover { background:#fef2f2; }
```

- [ ] **Step 2: Add the rejection modal HTML**

Find the keyword detail modal in the HTML section (around line 3826):
```html
<!-- keyword detail modal -->
<div id="kw-modal" ...>
  <div id="kw-modal-body" ...></div>
</div>
```

Add the rejection modal immediately after it, before `</body>`:

```html
<!-- keyword rejection modal -->
<div id="reject-modal-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:1000;align-items:center;justify-content:center" onclick="if(event.target===this)closeRejectModal()">
  <div style="background:#fff;border-radius:12px;width:380px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.25)">
    <div style="font-size:0.95rem;font-weight:700;color:#111;margin-bottom:4px">Reject keyword</div>
    <div style="font-size:0.82rem;color:#64748b;margin-bottom:16px">How broadly should this rejection apply to future research?</div>
    <div style="font-size:0.75rem;font-weight:600;color:#374151;margin-bottom:6px">KEYWORD</div>
    <div id="reject-modal-keyword" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px 12px;font-size:0.85rem;font-weight:600;color:#111;margin-bottom:16px"></div>
    <div style="font-size:0.75rem;font-weight:600;color:#374151;margin-bottom:8px">MATCH TYPE</div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">
      <label id="reject-opt-exact" style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;padding:10px 12px;border:1.5px solid #6366f1;border-radius:8px;background:#f5f3ff" onclick="selectRejectMatch(&apos;exact&apos;)">
        <input type="radio" name="reject-match" value="exact" checked style="margin-top:2px;pointer-events:none">
        <div><div style="font-size:0.83rem;font-weight:600;color:#111">Exact match</div><div style="font-size:0.75rem;color:#64748b">Only block this exact keyword</div></div>
      </label>
      <label id="reject-opt-phrase" style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:8px" onclick="selectRejectMatch(&apos;phrase&apos;)">
        <input type="radio" name="reject-match" value="phrase" style="margin-top:2px;pointer-events:none">
        <div><div style="font-size:0.83rem;font-weight:600;color:#111">Phrase match</div><div style="font-size:0.75rem;color:#64748b">Block any keyword containing this phrase</div></div>
      </label>
      <label id="reject-opt-broad" style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;padding:10px 12px;border:1.5px solid #e2e8f0;border-radius:8px" onclick="selectRejectMatch(&apos;broad&apos;)">
        <input type="radio" name="reject-match" value="broad" style="margin-top:2px;pointer-events:none">
        <div><div style="font-size:0.83rem;font-weight:600;color:#111">Broad match</div><div style="font-size:0.75rem;color:#64748b">Tell agents to avoid this topic and related ideas broadly</div></div>
      </label>
    </div>
    <div style="font-size:0.75rem;font-weight:600;color:#374151;margin-bottom:6px">REASON <span style="font-weight:400;color:#94a3b8">(optional)</span></div>
    <input id="reject-modal-reason" type="text" placeholder="e.g. too broad, off-brand topic" style="width:100%;padding:8px 10px;border:1px solid #e2e8f0;border-radius:6px;font-size:0.83rem;box-sizing:border-box;margin-bottom:16px">
    <div id="reject-modal-error" style="display:none;color:#ef4444;font-size:0.8rem;margin-bottom:10px"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button onclick="closeRejectModal()" style="padding:7px 16px;border:1px solid #e2e8f0;border-radius:6px;background:#fff;font-size:0.83rem;cursor:pointer">Cancel</button>
      <button onclick="confirmRejectKeyword()" style="padding:7px 16px;border:none;border-radius:6px;background:#ef4444;color:#fff;font-size:0.83rem;font-weight:600;cursor:pointer">Reject keyword</button>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Add browser JS functions**

In the browser `<script>` block, add these four functions after `closeKeywordCard()` (around line 3216). **Verify no single-backslash escape sequences appear in string literals.**

```javascript
var _rejectKeyword = null;
var _rejectCardEl  = null;

function rejectKeyword(keyword, cardEl) {
  _rejectKeyword = keyword;
  _rejectCardEl  = cardEl || null;
  document.getElementById('reject-modal-keyword').textContent = keyword;
  document.getElementById('reject-modal-reason').value = '';
  document.getElementById('reject-modal-error').style.display = 'none';
  selectRejectMatch('exact');
  document.getElementById('reject-modal-overlay').style.display = 'flex';
}

function selectRejectMatch(type) {
  ['exact', 'phrase', 'broad'].forEach(function(t) {
    var el    = document.getElementById('reject-opt-' + t);
    var radio = el.querySelector('input[type=radio]');
    if (t === type) {
      el.style.border     = '1.5px solid #6366f1';
      el.style.background = '#f5f3ff';
      radio.checked = true;
    } else {
      el.style.border     = '1.5px solid #e2e8f0';
      el.style.background = '';
      radio.checked = false;
    }
  });
}

function closeRejectModal() {
  document.getElementById('reject-modal-overlay').style.display = 'none';
  _rejectKeyword = null;
  _rejectCardEl  = null;
}

function confirmRejectKeyword() {
  var matchType = document.querySelector('input[name=reject-match]:checked').value;
  var reason    = document.getElementById('reject-modal-reason').value.trim();
  var errEl     = document.getElementById('reject-modal-error');
  errEl.style.display = 'none';
  fetch('/api/reject-keyword', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword: _rejectKeyword, matchType: matchType, reason: reason || null }),
  }).then(function(r) { return r.json(); }).then(function(json) {
    if (!json.ok) {
      errEl.textContent = json.error || 'Failed to save rejection.';
      errEl.style.display = 'block';
      return;
    }
    if (_rejectCardEl) _rejectCardEl.remove();
    closeRejectModal();
  }).catch(function() {
    errEl.textContent = 'Network error - rejection not saved.';
    errEl.style.display = 'block';
  });
}
```

- [ ] **Step 4: Update `renderKanban` to add reject button on pending/briefed cards**

In `renderKanban`, the current card HTML (around line 1510) is:
```javascript
return '<div class="kanban-item"><div class="kw">' + esc(i.keyword) + '</div>' +
  dateLine +
  (i.volume ? '<div class="vol">' + fmtNum(i.volume) + '/mo</div>' : '') + '</div>';
```

Replace with:
```javascript
const rejectBtn = (col.key === 'pending' || col.key === 'briefed')
  ? '<button class="kw-reject-btn" onclick="event.stopPropagation();rejectKeyword(this.closest(&quot;.kanban-item&quot;).dataset.keyword,this.closest(&quot;.kanban-item&quot;))">&#10005; Reject</button>'
  : '';
return '<div class="kanban-item" data-keyword="' + esc(i.keyword) + '"><div class="kw">' + esc(i.keyword) + '</div>' +
  dateLine +
  (i.volume ? '<div class="vol">' + fmtNum(i.volume) + '/mo</div>' : '') +
  rejectBtn + '</div>';
```

Note: the keyword is stored in `data-keyword` on the card element and read via `dataset.keyword` — this avoids inline JS string escaping issues entirely.

- [ ] **Step 5: Run the dashboard locally to verify UI**

```bash
node agents/dashboard/index.js
```

Open http://localhost:4242. Navigate to the SEO tab. Confirm:
1. Pending and Briefed kanban cards show the `✕ Reject` button; Published/Scheduled/Written cards do not
2. Clicking `✕ Reject` opens the modal with the keyword pre-filled
3. Match type options are selectable — selected option gets indigo border, others reset
4. Cancel closes the modal without changes
5. Submitting creates/appends `data/rejected-keywords.json` and removes the card from the kanban
6. The modal shows an error message if the network call fails (test by temporarily breaking the endpoint)

- [ ] **Step 6: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add keyword rejection modal and reject button to kanban cards"
```

---

### Task 6: Branch, push, and deploy

- [ ] **Step 1: Verify all tests pass**

```bash
node tests/agents/rejected-keywords.test.js && node tests/agents/dashboard-reject-keyword.test.js
```

Expected:
```
All rejected-keywords tests passed.
All dashboard-reject-keyword tests passed.
```

- [ ] **Step 2: Push and create PR**

```bash
git push -u origin feature/keyword-rejection
gh pr create --title "feat: keyword rejection system" --body "$(cat <<'EOF'
## Summary
- Reject button on Pending/Briefed kanban cards opens a match-type modal (exact/phrase/broad)
- Rejections saved to data/rejected-keywords.json with keyword, matchType, reason, timestamp
- POST /api/reject-keyword dashboard endpoint handles persistence
- pipeline-scheduler skips rejected keywords when selecting the next brief to run
- content-strategist filters rejected keywords from the brief queue and injects rejection guidance into the Claude calendar-generation prompt

## Test Plan
- [ ] Reject a keyword from the kanban — confirm modal opens with correct keyword
- [ ] Select each match type — confirm visual selection state updates
- [ ] Submit rejection — confirm card removed, data/rejected-keywords.json created/appended
- [ ] Run node agents/pipeline-scheduler/index.js --dry-run with a rejection in place — confirm [SKIP] log
- [ ] Run node tests/agents/rejected-keywords.test.js — all pass
- [ ] Run node tests/agents/dashboard-reject-keyword.test.js — all pass
EOF
)"
```

- [ ] **Step 3: Merge and deploy**

```bash
# After PR is approved/merged:
git checkout main && git pull
ssh root@137.184.119.230 'cd ~/seo-claude && git pull && pm2 restart seo-dashboard'
```
