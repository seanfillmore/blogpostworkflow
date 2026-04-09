# Automated Content Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three changes that together make the content pipeline fully automated: (1) a dashboard zip-upload button per keyword that triggers the researcher immediately, (2) Mon/Wed/Fri publish-date snapping in calendar-runner, and (3) a bi-weekly content-strategist cron job plus a Content Gap Data card in the dashboard.

**Architecture:** The existing daily cron (`scheduler.js` → `calendar-runner --run`) already handles the full briefed→published pipeline. These changes feed the front of that pipeline (keyword zip upload triggers content-researcher), control its rhythm (Mon/Wed/Fri cadence), and keep it filled with fresh topics (bi-weekly strategist refresh + content-gap upload UI). No new agents are created — only existing ones are wired up in new ways.

**Tech Stack:** Node.js ESM, Node built-in `node:test`, `extract-zip` (already in node_modules), system cron

---

## File Structure

| File | Change |
|------|--------|
| `agents/dashboard/index.js` | Add `CONTENT_GAP_DIR` constant (line ~307); add `contentGapFiles` to `aggregateData()` return; add Content Gap Data card HTML in SEO tab; add upload-zip button to each Data Needed row; add `run-log-agents-content-researcher-index-js` pre element; add `run-log-agents-content-strategist-index-js` pre element; add JS functions `uploadKeywordZip`, `runGapAnalysis`; add server endpoints `/upload/ahrefs-keyword-zip` and `/upload/content-gap-zip` |
| `agents/calendar-runner/index.js` | Replace `formatPublishAt()` (lines 403–410) with Mon/Wed/Fri snapping version; export `formatPublishAt` for testing |
| `scripts/setup-cron.sh` | Add bi-weekly `content-strategist` cron entry |
| `tests/agents/calendar-runner.test.js` | New — tests for `formatPublishAt` snapping logic |
| `tests/agents/dashboard-pipeline.test.js` | New — source-level assertions that new dashboard elements exist |

---

## Task 1: Mon/Wed/Fri cadence in calendar-runner

**Files:**
- Modify: `agents/calendar-runner/index.js:403-410`
- Create: `tests/agents/calendar-runner.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/agents/calendar-runner.test.js`:

```javascript
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { formatPublishAt } from '../../agents/calendar-runner/index.js';

test('snaps Tuesday to Wednesday', () => {
  // 2026-03-31 is a Tuesday
  const result = formatPublishAt(new Date('2026-03-31T12:00:00Z'));
  assert.match(result, /^2026-04-01T08:00:00-07:00$/);
});

test('snaps Saturday to Monday', () => {
  // 2026-04-04 is a Saturday
  const result = formatPublishAt(new Date('2026-04-04T12:00:00Z'));
  assert.match(result, /^2026-04-06T08:00:00-07:00$/);
});

test('keeps Monday as Monday', () => {
  // 2026-03-30 is a Monday — already a publish day
  const result = formatPublishAt(new Date('2026-03-30T12:00:00Z'));
  assert.match(result, /^2026-03-30T08:00:00-07:00$/);
});

test('keeps Wednesday as Wednesday', () => {
  // 2026-04-01 is a Wednesday
  const result = formatPublishAt(new Date('2026-04-01T12:00:00Z'));
  assert.match(result, /^2026-04-01T08:00:00-07:00$/);
});

test('keeps Friday as Friday', () => {
  // 2026-04-03 is a Friday
  const result = formatPublishAt(new Date('2026-04-03T12:00:00Z'));
  assert.match(result, /^2026-04-03T08:00:00-07:00$/);
});

test('snaps Sunday to Monday', () => {
  // 2026-04-05 is a Sunday
  const result = formatPublishAt(new Date('2026-04-05T12:00:00Z'));
  assert.match(result, /^2026-04-06T08:00:00-07:00$/);
});

test('past date advances to future Mon/Wed/Fri', () => {
  // 2020-01-01 is far in the past — result must be a future Mon/Wed/Fri
  const result = formatPublishAt(new Date('2020-01-01T12:00:00Z'));
  const d = new Date(result);
  const day = d.getDay();
  assert.ok([1, 3, 5].includes(day), `Expected Mon/Wed/Fri, got day ${day}`);
  assert.ok(d > new Date(), 'Result must be in the future');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test tests/agents/calendar-runner.test.js
```

Expected: FAIL — `formatPublishAt is not exported` or similar.

- [ ] **Step 3: Export `formatPublishAt` and replace its implementation**

In `agents/calendar-runner/index.js`, replace the existing `formatPublishAt` function (lines 403–410):

```javascript
export function formatPublishAt(date) {
  const PUBLISH_DAYS = new Set([1, 3, 5]); // Mon, Wed, Fri
  const d = new Date(date);
  // Snap forward to next publish day
  while (!PUBLISH_DAYS.has(d.getDay())) {
    d.setDate(d.getDate() + 1);
  }
  // If that date is in the past, advance by 1 week until it is future
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

Note: use `getFullYear()`, `getMonth()`, `getDate()` (local time, not UTC) so the local calendar date is used, since publish times are expressed in Pacific time. The previous implementation incorrectly used `getUTCFullYear()` etc., which could produce an off-by-one on the date portion.

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test tests/agents/calendar-runner.test.js
```

Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add agents/calendar-runner/index.js tests/agents/calendar-runner.test.js
git commit -m "feat: snap publish dates to Mon/Wed/Fri at 08:00 PT"
```

---

## Task 2: Keyword zip upload — server endpoint

**Files:**
- Modify: `agents/dashboard/index.js` (server section, after the `/upload/rank-snapshot` endpoint)

- [ ] **Step 1: Add `CONTENT_GAP_DIR` constant**

In `agents/dashboard/index.js`, find the constants block near line 307 where `AHREFS_DIR` is defined. Add directly after it:

```javascript
const CONTENT_GAP_DIR = join(ROOT, 'data', 'content_gap');
```

- [ ] **Step 2: Add `/upload/ahrefs-keyword-zip` server endpoint**

Find the `/upload/rank-snapshot` endpoint in the server request handler. Add the following block immediately after it (after its closing `return;`):

```javascript
  if (req.method === 'POST' && req.url === '/upload/ahrefs-keyword-zip') {
    if (!checkAuth(req, res)) return;
    const slug = (req.headers['x-slug'] || '').replace(/[^a-z0-9-]/g, '');
    if (!slug) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Missing or invalid X-Slug header' }));
      return;
    }
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', async () => {
      const destDir = join(AHREFS_DIR, slug);
      const tmpZip  = join(destDir, '.upload.zip');
      try {
        mkdirSync(destDir, { recursive: true });
        writeFileSync(tmpZip, Buffer.concat(chunks));
        const extract = (await import('extract-zip')).default;
        await extract(tmpZip, { dir: destDir });
        const { unlinkSync } = await import('node:fs');
        unlinkSync(tmpZip);
        const files = readdirSync(destDir).filter(f => !f.startsWith('.'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, slug, files }));
      } catch (err) {
        try { const { unlinkSync } = await import('node:fs'); unlinkSync(tmpZip); } catch {}
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }
```

- [ ] **Step 3: Add `/upload/content-gap-zip` server endpoint**

Add immediately after the `/upload/ahrefs-keyword-zip` block:

```javascript
  if (req.method === 'POST' && req.url === '/upload/content-gap-zip') {
    if (!checkAuth(req, res)) return;
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', async () => {
      const tmpZip = join(CONTENT_GAP_DIR, '.upload.zip');
      try {
        mkdirSync(CONTENT_GAP_DIR, { recursive: true });
        writeFileSync(tmpZip, Buffer.concat(chunks));
        const extract = (await import('extract-zip')).default;
        await extract(tmpZip, { dir: CONTENT_GAP_DIR });
        const { unlinkSync } = await import('node:fs');
        unlinkSync(tmpZip);
        const files = readdirSync(CONTENT_GAP_DIR).filter(f => f.endsWith('.csv'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, files }));
      } catch (err) {
        try { const { unlinkSync } = await import('node:fs'); unlinkSync(tmpZip); } catch {}
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }
```

- [ ] **Step 4: Verify server starts without errors**

```bash
node agents/dashboard/index.js &
sleep 2
curl -s http://localhost:4242/api/data | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{ try{JSON.parse(d); console.log('OK');}catch(e){console.log('FAIL',e.message);} });"
kill %1
```

Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add /upload/ahrefs-keyword-zip and /upload/content-gap-zip endpoints"
```

---

## Task 3: Keyword zip upload — dashboard UI

**Files:**
- Modify: `agents/dashboard/index.js` (HTML and browser JS sections)
- Create: `tests/agents/dashboard-pipeline.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/agents/dashboard-pipeline.test.js`:

```javascript
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync('agents/dashboard/index.js', 'utf8');

assert.ok(src.includes('uploadKeywordZip'), 'must define uploadKeywordZip function');
assert.ok(src.includes('/upload/ahrefs-keyword-zip'), 'must have keyword zip upload endpoint');
assert.ok(src.includes('uploadContentGapZip'), 'must define uploadContentGapZip function');
assert.ok(src.includes('/upload/content-gap-zip'), 'must have content-gap zip upload endpoint');
assert.ok(src.includes('runGapAnalysis'), 'must define runGapAnalysis function');
assert.ok(src.includes('content-gap-card'), 'must have Content Gap Data card');
assert.ok(src.includes('run-log-agents-content-researcher-index-js'), 'must have content-researcher run-log element');
assert.ok(src.includes('run-log-agents-content-strategist-index-js'), 'must have content-strategist run-log element');
assert.ok(src.includes('CONTENT_GAP_DIR'), 'must define CONTENT_GAP_DIR constant');
assert.ok(src.includes('contentGapFiles'), 'must include contentGapFiles in data');

console.log('✓ dashboard pipeline tests pass');
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test tests/agents/dashboard-pipeline.test.js
```

Expected: FAIL — multiple assertions failing.

- [ ] **Step 3: Add `contentGapFiles` to `aggregateData()` return**

In `agents/dashboard/index.js`, find the `aggregateData()` function. Before the final `return {` (around line 612), add:

```javascript
  const contentGapFiles = existsSync(CONTENT_GAP_DIR)
    ? readdirSync(CONTENT_GAP_DIR)
        .filter(f => f.endsWith('.csv'))
        .map(f => ({ name: f, mtime: statSync(join(CONTENT_GAP_DIR, f)).mtimeMs }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];
```

Then add `contentGapFiles,` to the return object alongside the other fields.

- [ ] **Step 4: Add run-log elements for content-researcher and content-strategist**

In the SEO tab HTML, find the block of `<pre class="run-log">` elements near line 1089. Add two new ones:

```html
  <pre id="run-log-agents-content-researcher-index-js" class="run-log" style="display:none"></pre>
  <pre id="run-log-agents-content-strategist-index-js" class="run-log" style="display:none"></pre>
```

- [ ] **Step 5: Add upload button to each Data Needed row**

In `agents/dashboard/index.js`, find `renderDataNeeded`. The function builds HTML for each item. In the `return '<div class="data-item">' + ...` block, add the upload button to the `data-item-header` div, after the date span:

Replace:
```javascript
    return '<div class="data-item">' +
      '<div class="data-item-header">' +
        '<span class="data-item-keyword">' + esc(item.keyword) + '</span>' +
        '<span class="data-item-date">Scheduled ' + fmtDate(item.publishDate) + '</span>' +
      '</div>' +
```

With:
```javascript
    return '<div class="data-item">' +
      '<div class="data-item-header">' +
        '<span class="data-item-keyword">' + esc(item.keyword) + '</span>' +
        '<span class="data-item-date">Scheduled ' + fmtDate(item.publishDate) + '</span>' +
        '<button id="kw-zip-btn-' + esc(item.slug) + '" class="upload-btn" onclick="uploadKeywordZip(' + JSON.stringify(item.slug) + ',' + JSON.stringify(item.keyword) + ')" data-tip="Upload a zip of the 3 Ahrefs CSVs for this keyword">&#8593; Upload Zip</button>' +
      '</div>' +
```

- [ ] **Step 6: Add `uploadKeywordZip` and `runGapAnalysis` JS functions**

In the browser JS section (inside `<script>`), add these functions near the other upload functions (`uploadRankSnapshot`, etc.):

```javascript
function uploadKeywordZip(slug, keyword) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zip';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.onchange = async () => {
    document.body.removeChild(input);
    const file = input.files[0];
    if (!file) return;
    const btn = document.getElementById('kw-zip-btn-' + slug);
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="chat-dot"></span><span class="chat-dot"></span><span class="chat-dot"></span>'; }
    try {
      const res = await fetch('/upload/ahrefs-keyword-zip', {
        method: 'POST',
        headers: { 'X-Slug': slug, 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const json = await res.json();
      if (!json.ok) {
        if (btn) { btn.disabled = false; btn.innerHTML = '&#8593; Upload Zip'; }
        alert('Upload failed: ' + json.error);
        return;
      }
      if (btn) btn.innerHTML = '<span class="chat-dot"></span><span class="chat-dot"></span><span class="chat-dot"></span>';
      runAgent('agents/content-researcher/index.js', [keyword], function() {
        if (btn) { btn.disabled = false; btn.innerHTML = '&#10003; Brief created'; }
        loadData();
      });
    } catch (e) {
      if (btn) { btn.disabled = false; btn.innerHTML = '&#8593; Upload Zip'; }
    }
  };
  input.click();
}

function uploadContentGapZip() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zip';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.onchange = async () => {
    document.body.removeChild(input);
    const file = input.files[0];
    if (!file) return;
    const btn = document.getElementById('content-gap-upload-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="chat-dot"></span><span class="chat-dot"></span><span class="chat-dot"></span>'; }
    try {
      const res = await fetch('/upload/content-gap-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const json = await res.json();
      if (btn) { btn.disabled = false; btn.innerHTML = '&#10003; Uploaded'; }
      if (!json.ok) { alert('Upload failed: ' + json.error); return; }
      loadData();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.innerHTML = '&#8593; Upload Zip'; }
    }
  };
  input.click();
}

function runGapAnalysis() {
  const btn = document.getElementById('content-gap-run-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="chat-dot"></span><span class="chat-dot"></span><span class="chat-dot"></span>'; }
  runAgent('agents/content-gap/index.js', [], function() {
    runAgent('agents/content-strategist/index.js', [], function() {
      if (btn) { btn.disabled = false; btn.innerHTML = '&#10003; Done'; }
      loadData();
    });
  });
}
```

- [ ] **Step 7: Add `renderContentGapCard` JS function**

In the browser JS section, add after the `renderDataNeeded` function:

```javascript
function renderContentGapCard(d) {
  const files = d.contentGapFiles || [];
  const EXPECTED = ['top100.csv','realskincare_organic_keywords.csv','natural_deodorant.csv','natural_toothpaste.csv','natural_body_lotion.csv','natural_lip_balm.csv','natural_bar_soap.csv'];
  const present = new Set(files.map(f => f.name));
  const allRows = EXPECTED.map(name => {
    const f = files.find(x => x.name === name);
    const tag = f
      ? '<span class="file-tag file-tag-present">&#10003; ' + esc(name) + ' &mdash; ' + new Date(f.mtime).toLocaleDateString() + '</span>'
      : '<span class="file-tag file-tag-missing">&#10007; ' + esc(name) + '</span>';
    return tag;
  });
  // Also show any extra files not in EXPECTED
  files.filter(f => !EXPECTED.includes(f.name)).forEach(f => {
    allRows.push('<span class="file-tag file-tag-present">&#10003; ' + esc(f.name) + ' &mdash; ' + new Date(f.mtime).toLocaleDateString() + '</span>');
  });
  const el = document.getElementById('content-gap-files');
  if (el) el.innerHTML = allRows.join(' ');
}
```

- [ ] **Step 8: Call `renderContentGapCard` in `loadData`**

In the `loadData` function, find the block of `render*` calls. Add:

```javascript
    renderContentGapCard(data);
```

alongside the other render calls (e.g., after `renderDataNeeded(data)`).

- [ ] **Step 9: Run tests to verify they pass**

```bash
node --test tests/agents/dashboard-pipeline.test.js
```

Expected: all assertions pass.

- [ ] **Step 10: Commit**

```bash
git add agents/dashboard/index.js tests/agents/dashboard-pipeline.test.js
git commit -m "feat: add keyword zip upload buttons and content-gap upload UI"
```

---

## Task 4: Content Gap Data card HTML

**Files:**
- Modify: `agents/dashboard/index.js` (HTML section, SEO tab)

- [ ] **Step 1: Add CSS for content-gap card file tags**

The `.file-tag`, `.file-tag-present`, and `.file-tag-missing` classes are already defined (used by the Data Needed card). No new CSS needed.

- [ ] **Step 2: Add Content Gap Data card HTML in SEO tab**

In the SEO tab HTML, find the block of `<pre class="run-log">` elements (around line 1089). Add the Content Gap Data card immediately before those run-log elements:

```html
  <!-- Content Gap Data -->
  <div class="card" id="content-gap-card">
    <div class="card-header">
      <h2>Content Gap Data</h2>
      <div class="card-header-right">
        <span class="section-note">Ahrefs CSV exports &middot; refresh every 1&ndash;2 months</span>
        <button id="content-gap-upload-btn" class="upload-btn" onclick="uploadContentGapZip()" data-tip="Upload a zip of your Ahrefs content gap CSV exports">&#8593; Upload Zip</button>
        <button id="content-gap-run-btn" class="upload-btn" onclick="runGapAnalysis()" data-tip="Run content gap analysis and rebuild the content calendar">Run Analysis</button>
      </div>
    </div>
    <div class="card-body">
      <div id="content-gap-files" style="display:flex;flex-wrap:wrap;gap:6px;padding:4px 0"></div>
    </div>
  </div>
```

- [ ] **Step 3: Verify dashboard renders without JS errors**

```bash
node agents/dashboard/index.js &
sleep 2
curl -s http://localhost:4242 | grep -c "content-gap-card"
kill %1
```

Expected: `1`

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add Content Gap Data card to SEO tab"
```

---

## Task 5: Bi-weekly content-strategist cron job

**Files:**
- Modify: `scripts/setup-cron.sh`

- [ ] **Step 1: Add the bi-weekly cron entry**

In `scripts/setup-cron.sh`, find the block where all cron variables are defined (the lines like `DAILY_SCHEDULER=...`). Add after `WEEKLY_CAMPAIGN_ANALYZER`:

```bash
BIWEEKLY_STRATEGIST="0 13 * * 0 [ \$(( \$(date +%W) % 2 )) -eq 0 ] && cd \"$PROJECT_DIR\" && $NODE agents/content-strategist/index.js >> data/reports/scheduler/content-strategist.log 2>&1"
```

(13:00 UTC = 05:00 PT, every other Sunday)

- [ ] **Step 2: Add it to the cron install block**

Find the `NEW_CRONTAB="$CLEANED` block and add `$BIWEEKLY_STRATEGIST` alongside the other entries.

- [ ] **Step 3: Add it to the echo summary**

Find the `echo "Installed:"` block at the bottom and add:

```bash
echo "  Bi-weekly Sun 05:00 PT — content-strategist calendar refresh"
```

- [ ] **Step 4: Verify the script is valid bash**

```bash
bash -n scripts/setup-cron.sh && echo "OK"
```

Expected: `OK` (no syntax errors)

- [ ] **Step 5: Commit**

```bash
git add scripts/setup-cron.sh
git commit -m "feat: add bi-weekly content-strategist cron job"
```

---

## Task 6: Full test suite and local verification

**Files:**
- No new files

- [ ] **Step 1: Run full test suite**

```bash
npm test
```

Expected: all tests pass with no failures.

- [ ] **Step 2: Start dashboard locally and verify UI**

```bash
node agents/dashboard/index.js &
sleep 2
```

Open `http://localhost:4242` and verify:
- SEO tab shows the Content Gap Data card with file tags
- Data Needed card shows "↑ Upload Zip" button next to each keyword row
- Clicking "↑ Upload Zip" opens a file picker that accepts only `.zip` files
- Run Analysis button is visible

- [ ] **Step 3: Test keyword zip upload end-to-end**

```bash
# Create a test zip with dummy CSV files
mkdir -p /tmp/test-kw-zip
echo "Date, Volume" > /tmp/test-kw-zip/keyword.csv
echo "Keyword,URL" > /tmp/test-kw-zip/serp.csv
echo "#,Keyword" > /tmp/test-kw-zip/matching_terms.csv
cd /tmp/test-kw-zip && zip test-keyword.zip keyword.csv serp.csv matching_terms.csv
curl -s -X POST http://localhost:4242/upload/ahrefs-keyword-zip \
  -H "X-Slug: test-keyword" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @/tmp/test-kw-zip/test-keyword.zip
```

Expected: `{"ok":true,"slug":"test-keyword","files":["keyword.csv","matching_terms.csv","serp.csv"]}`

Verify files were extracted:
```bash
ls data/ahrefs/test-keyword/
```

Expected: `keyword.csv  matching_terms.csv  serp.csv`

Clean up test data:
```bash
rm -rf data/ahrefs/test-keyword
```

- [ ] **Step 4: Test content-gap zip upload end-to-end**

```bash
# Create a test zip
mkdir -p /tmp/test-gap-zip
echo "col1,col2" > /tmp/test-gap-zip/top100.csv
cd /tmp/test-gap-zip && zip test-gap.zip top100.csv
curl -s -X POST http://localhost:4242/upload/content-gap-zip \
  -H "Content-Type: application/octet-stream" \
  --data-binary @/tmp/test-gap-zip/test-gap.zip
```

Expected: `{"ok":true,"files":[...]}` (list includes `top100.csv` plus existing files)

- [ ] **Step 5: Kill local server**

```bash
kill %1
```

- [ ] **Step 6: Final commit (if any last fixes)**

```bash
git status
# commit any remaining changes
```

---

## Self-Review Checklist

**Spec coverage:**
- ✅ Part 1 (keyword zip upload) → Tasks 2, 3, 4
- ✅ Part 2 (Mon/Wed/Fri cadence) → Task 1
- ✅ Part 3a (bi-weekly cron) → Task 5
- ✅ Part 3b (content-gap card + upload UI) → Tasks 2, 3, 4
- ✅ Part 3c (contentGapFiles server data) → Task 3

**Template literal safety (dashboard):**
- All new strings in browser JS use `&#10003;` (✓), `&#10007;` (✗), `&#8593;` (↑), `&middot;`, `&ndash;` — no raw unicode or escape sequences
- No `\n` in string literals
- `JSON.stringify` used to safely embed slug and keyword into onclick attributes

**Type consistency:**
- `item.slug` used in `renderDataNeeded` button id and `uploadKeywordZip` arg — consistent with existing `item.slug` field
- `data.contentGapFiles` referenced in `renderContentGapCard(d)` where `d` is the `data` object — consistent with how other render functions receive data
- `CONTENT_GAP_DIR` defined in constants section, used in both `aggregateData()` and server endpoints
