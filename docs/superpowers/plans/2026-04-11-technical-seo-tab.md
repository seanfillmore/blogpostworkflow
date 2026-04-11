# Technical SEO Dashboard Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Technical SEO tab to the dashboard with site audit ZIP upload, issue cards grouped by category with fix buttons, and Lighthouse theme audit results.

**Architecture:** New tab follows existing dashboard patterns: HTML panel in `index.html`, render function in `dashboard.js`, data loaded in `data-loader.js`. A new parser module extracts structured issue data from the technical-seo markdown report. Upload route follows the existing ZIP upload pattern. Agent commands triggered via `runAgent()`.

**Tech Stack:** Browser HTML/CSS/JS (no framework), Node.js server routes, existing `agents/technical-seo/index.js` and `agents/theme-seo-auditor/index.js` commands.

---

## File Structure

| Action | File | Responsibility |
|---|---|---|
| Create | `agents/dashboard/lib/tech-seo-parser.js` | Parse tech SEO markdown report into structured JSON |
| Create | `tests/dashboard/tech-seo-parser.test.js` | Tests for report parsing |
| Modify | `agents/dashboard/public/index.html` | Add tab pill + tab panel + action buttons |
| Modify | `agents/dashboard/public/js/dashboard.js` | Add `renderTechnicalSeoTab()`, upload handler |
| Modify | `agents/dashboard/lib/data-loader.js` | Load tech SEO + theme audit data |
| Modify | `agents/dashboard/routes/uploads.js` | Add `POST /upload/tech-seo-zip` |
| Modify | `agents/dashboard/lib/run-agent.js` | Add agents to allowlist |
| Modify | `agents/dashboard/lib/tab-chat-prompt.js` | Add tech-seo context |

---

## Task 1: Tech SEO report parser — tests + implementation

**Files:**
- Create: `tests/dashboard/tech-seo-parser.test.js`
- Create: `agents/dashboard/lib/tech-seo-parser.js`

- [ ] **Step 1: Write the test file**

```javascript
// tests/dashboard/tech-seo-parser.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

function parseTechSeoReport(markdown) {
  if (!markdown) return null;

  const dateMatch = markdown.match(/\*\*(?:Generated|Run date|Date):\*\*\s*(.+)/i);
  const generated_at = dateMatch ? dateMatch[1].trim() : null;

  const categories = {};
  let totalErrors = 0;
  let totalWarnings = 0;

  // Parse error/warning sections by looking for emoji + category headers
  // Format: "### 🔴 404 Pages (5)" or "| url | status | links |"
  const sectionRegex = /###\s*(?:🔴|🟡|⚠️?)\s*(.+?)\s*\((\d+)\)/g;
  let match;
  while ((match = sectionRegex.exec(markdown)) !== null) {
    const name = match[1].trim();
    const count = parseInt(match[2], 10);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const isError = markdown.slice(Math.max(0, match.index - 5), match.index + 5).includes('🔴');
    const severity = isError ? 'error' : 'warning';

    // Extract table rows after this header (up to next ### or end)
    const afterHeader = markdown.slice(match.index + match[0].length);
    const nextSection = afterHeader.search(/\n###\s/);
    const sectionText = nextSection > 0 ? afterHeader.slice(0, nextSection) : afterHeader.slice(0, 2000);

    // Parse markdown table rows: | col1 | col2 | ... |
    const rows = [...sectionText.matchAll(/^\|(.+)\|$/gm)]
      .map(m => m[1].split('|').map(c => c.trim()))
      .filter(cols => cols.length >= 1 && !cols[0].includes('---'));
    // Skip header row
    const items = rows.slice(1).map(cols => ({ url: cols[0] || '', detail: cols.slice(1).join(' | ') })).slice(0, 10);

    categories[slug] = { name, count, severity, items };
    if (severity === 'error') totalErrors += count;
    else totalWarnings += count;
  }

  return { generated_at, summary: { errors: totalErrors, warnings: totalWarnings }, categories };
}

test('parseTechSeoReport extracts date', () => {
  const md = '# Audit\n**Generated:** April 9, 2026\n### 🔴 404 Pages (3)\n| URL |\n|---|\n| /old |';
  const result = parseTechSeoReport(md);
  assert.equal(result.generated_at, 'April 9, 2026');
});

test('parseTechSeoReport counts errors and warnings', () => {
  const md = '### 🔴 404 Pages (5)\n| URL |\n|---|\n| /a |\n### 🟡 Missing Meta (8)\n| URL |\n|---|\n| /b |';
  const result = parseTechSeoReport(md);
  assert.equal(result.summary.errors, 5);
  assert.equal(result.summary.warnings, 8);
});

test('parseTechSeoReport extracts categories with items', () => {
  const md = '### 🔴 Broken Links (2)\n| Source | Target | Status |\n|---|---|---|\n| /post-a | /dead | 404 |\n| /post-b | /gone | 404 |';
  const result = parseTechSeoReport(md);
  assert.equal(result.categories.broken_links.count, 2);
  assert.equal(result.categories.broken_links.severity, 'error');
  assert.equal(result.categories.broken_links.items.length, 2);
  assert.equal(result.categories.broken_links.items[0].url, '/post-a');
});

test('parseTechSeoReport returns null for empty input', () => {
  assert.equal(parseTechSeoReport(null), null);
  assert.equal(parseTechSeoReport(''), null);
});
```

- [ ] **Step 2: Run tests**

Run: `node --test tests/dashboard/tech-seo-parser.test.js`
Expected: All 4 tests pass.

- [ ] **Step 3: Create the parser module**

```javascript
// agents/dashboard/lib/tech-seo-parser.js
/**
 * Parse the technical SEO markdown audit report into structured data
 * for the dashboard Technical SEO tab.
 */

export function parseTechSeoReport(markdown) {
  if (!markdown) return null;

  const dateMatch = markdown.match(/\*\*(?:Generated|Run date|Date):\*\*\s*(.+)/i);
  const generated_at = dateMatch ? dateMatch[1].trim() : null;

  const categories = {};
  let totalErrors = 0;
  let totalWarnings = 0;

  const sectionRegex = /###\s*(?:🔴|🟡|⚠️?)\s*(.+?)\s*\((\d+)\)/g;
  let match;
  while ((match = sectionRegex.exec(markdown)) !== null) {
    const name = match[1].trim();
    const count = parseInt(match[2], 10);
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const isError = markdown.slice(Math.max(0, match.index - 5), match.index + 5).includes('🔴');
    const severity = isError ? 'error' : 'warning';

    const afterHeader = markdown.slice(match.index + match[0].length);
    const nextSection = afterHeader.search(/\n###\s/);
    const sectionText = nextSection > 0 ? afterHeader.slice(0, nextSection) : afterHeader.slice(0, 2000);

    const rows = [...sectionText.matchAll(/^\|(.+)\|$/gm)]
      .map(m => m[1].split('|').map(c => c.trim()))
      .filter(cols => cols.length >= 1 && !cols[0].includes('---'));
    const items = rows.slice(1).map(cols => ({ url: cols[0] || '', detail: cols.slice(1).join(' | ') })).slice(0, 10);

    categories[slug] = { name, count, severity, items };
    if (severity === 'error') totalErrors += count;
    else totalWarnings += count;
  }

  return { generated_at, summary: { errors: totalErrors, warnings: totalWarnings }, categories };
}
```

- [ ] **Step 4: Commit**

```bash
git add tests/dashboard/tech-seo-parser.test.js agents/dashboard/lib/tech-seo-parser.js
git commit -m "feat: add tech SEO report parser for dashboard tab"
```

---

## Task 2: Data loader — load tech SEO + theme audit data

**Files:**
- Modify: `agents/dashboard/lib/data-loader.js`

- [ ] **Step 1: Add imports and data loading**

Add import at the top:
```javascript
import { parseTechSeoReport } from './tech-seo-parser.js';
```

After the existing `cannibalization` line (around line 217), add:

```javascript
  // Technical SEO audit report (markdown → parsed)
  const techSeoReportRaw = (() => {
    const p = join(REPORTS_DIR, 'technical-seo', 'technical-seo-audit.md');
    if (!existsSync(p)) return null;
    try { return readFileSync(p, 'utf8'); } catch { return null; }
  })();
  const techSeoAudit = parseTechSeoReport(techSeoReportRaw);

  // Theme SEO audit (JSON)
  const themeSeoAudit = readJsonIfExists(join(REPORTS_DIR, 'theme-seo-audit', 'latest.json'));
```

Add `techSeoAudit` and `themeSeoAudit` to the return object:

```javascript
    techSeoAudit,
    themeSeoAudit,
```

- [ ] **Step 2: Commit**

```bash
git add agents/dashboard/lib/data-loader.js
git commit -m "feat(data-loader): load technical SEO audit + theme audit data"
```

---

## Task 3: Upload route for site audit ZIP

**Files:**
- Modify: `agents/dashboard/routes/uploads.js`

- [ ] **Step 1: Add the tech-seo-zip route**

Add a new route to the exports array (after the existing `content-gap-zip` route):

```javascript
  {
    method: 'POST',
    match: '/upload/tech-seo-zip',
    handler(req, res, ctx) {
      const CSV_DIR = join(ctx.ROOT, 'data', 'technical_seo');
      const chunks = [];
      req.on('data', d => chunks.push(d));
      req.on('end', async () => {
        const tmpZip = join(CSV_DIR, '.upload.zip');
        try {
          mkdirSync(CSV_DIR, { recursive: true });
          writeFileSync(tmpZip, Buffer.concat(chunks));
          const extract = (await import('extract-zip')).default;
          await extract(tmpZip, { dir: CSV_DIR });
          const { unlinkSync, renameSync, rmdirSync } = await import('node:fs');
          unlinkSync(tmpZip);
          // Flatten single nested subdirectory
          const top = readdirSync(CSV_DIR).filter(f => !f.startsWith('.'));
          if (top.length === 1) {
            const sub = join(CSV_DIR, top[0]);
            if (statSync(sub).isDirectory()) {
              for (const f of readdirSync(sub)) renameSync(join(sub, f), join(CSV_DIR, f));
              rmdirSync(sub);
            }
          }
          const files = readdirSync(CSV_DIR).filter(f => f.endsWith('.csv'));
          ctx.invalidateDataCache();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, files }));
        } catch (err) {
          try { const { unlinkSync } = await import('node:fs'); unlinkSync(tmpZip); } catch {}
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
    },
  },
```

Note: `ctx.ROOT` is available from the paths spread. Add the `join` import if not already present — check the existing imports at the top of uploads.js.

- [ ] **Step 2: Commit**

```bash
git add agents/dashboard/routes/uploads.js
git commit -m "feat(uploads): add POST /upload/tech-seo-zip route"
```

---

## Task 4: Agent allowlist

**Files:**
- Modify: `agents/dashboard/lib/run-agent.js`

- [ ] **Step 1: Add technical-seo and theme-seo-auditor to allowlist**

After `'agents/legacy-triage/index.js',` add:

```javascript
  'agents/technical-seo/index.js',
  'agents/theme-seo-auditor/index.js',
  'agents/image-generator/index.js',
```

- [ ] **Step 2: Commit**

```bash
git add agents/dashboard/lib/run-agent.js
git commit -m "feat(run-agent): add technical-seo, theme-seo-auditor, image-generator to allowlist"
```

---

## Task 5: HTML — add tab pill + panel + action buttons

**Files:**
- Modify: `agents/dashboard/public/index.html`

- [ ] **Step 1: Add tab pill**

After the Optimize pill (line 25), add:

```html
      <button class="tab-pill" onclick="switchTab('tech-seo',this)" id="pill-tech-seo">Tech SEO</button>
```

- [ ] **Step 2: Add action buttons group**

After the `tab-actions-optimize` div (after line 67), add:

```html
  <div class="tab-actions-group" id="tab-actions-tech-seo" style="display:none">
    <button onclick="runAgent('agents/technical-seo/index.js', ['audit'])" data-tip="Parse CSV data and generate audit report">Run Audit</button>
    <button onclick="runAgent('agents/technical-seo/index.js', ['fix-all', '--dry-run'])" data-tip="Preview all fixes without applying">Fix All (dry run)</button>
    <button onclick="if(confirm('Apply all fixes to Shopify?')) runAgent('agents/technical-seo/index.js', ['fix-all'])" data-tip="Apply all automated fixes to Shopify">Fix All (apply)</button>
    <button onclick="runAgent('agents/theme-seo-auditor/index.js')" data-tip="Run Puppeteer + Lighthouse audit on all template types">Run Theme Audit</button>
    <button id="btn-chat-tech-seo" class="btn-open-chat" onclick="toggleTabChat('tech-seo')" data-tip="Ask Claude about Technical SEO data">&#x2736; Chat</button>
  </div>
```

- [ ] **Step 3: Add tab panel**

Before `<div id="tab-chat-sidebar"` (line 332), add:

```html
<div id="tab-tech-seo" class="tab-panel">
  <div class="empty-state">Loading technical SEO data...</div>
  <pre id="run-log-agents-technical-seo-index-js" class="run-log" style="display:none"></pre>
  <pre id="run-log-agents-theme-seo-auditor-index-js" class="run-log" style="display:none"></pre>
</div>
```

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/public/index.html
git commit -m "feat(html): add Tech SEO tab pill, panel, and action buttons"
```

---

## Task 6: Dashboard JS — renderTechnicalSeoTab + upload handler

**Files:**
- Modify: `agents/dashboard/public/js/dashboard.js`

- [ ] **Step 1: Add tab to switchTab logic**

In the `switchTab` function, update the action group list (line 17):

```javascript
  ['seo','cro','optimize','ads','creatives','tech-seo'].forEach(function(t) {
```

After line 25 (`if (name === 'creatives') renderCreativesTab();`), add:

```javascript
  if (name === 'tech-seo' && data) renderTechnicalSeoTab(data);
```

- [ ] **Step 2: Add TAB_CHAT_NAMES entry**

Find `var TAB_CHAT_NAMES = {` and add:

```javascript
  'tech-seo': 'Tech SEO',
```

- [ ] **Step 3: Add renderTechnicalSeoTab function**

Add the main render function. It builds:
- Upload zone + summary card
- Issue category cards (paired in rows)
- Theme audit card with Lighthouse scores + template table

The function reads `d.techSeoAudit` and `d.themeSeoAudit` from the data object.

For the upload zone, add a `uploadTechSeoZip()` function:

```javascript
function uploadTechSeoZip() {
  var input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zip';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.onchange = function() {
    document.body.removeChild(input);
    var file = input.files[0];
    if (!file) return;
    fetch('/upload/tech-seo-zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    }).then(function(r) { return r.json(); }).then(function(json) {
      if (!json.ok) { alert('Upload failed: ' + json.error); return; }
      // Auto-run audit after upload
      runAgent('agents/technical-seo/index.js', ['audit'], function() { loadData(); });
    }).catch(function() { alert('Upload failed'); });
  };
  input.click();
}
```

The `renderTechnicalSeoTab(d)` function builds HTML for each section. For issue cards, iterate `d.techSeoAudit.categories` and create paired cards with fix buttons. For theme audit, render the Lighthouse scores and template table from `d.themeSeoAudit`.

Key implementation details:
- Each fix button uses `onclick="runAgent('agents/technical-seo/index.js', ['fix-links'])"` etc.
- Category cards show top 5 items with "+ N more"
- Lighthouse scores use circular badge styling (border-radius: 50%, colored border)
- If `techSeoAudit` is null, show the upload zone only with "No audit data yet"
- If `themeSeoAudit` is null, show "No theme audit yet — Run Theme Audit"

The fix command mapping:

```javascript
var fixCommands = {
  '404_pages': ['create-redirects'],
  'broken_links': ['fix-links'],
  'missing_meta': ['fix-meta'],
  'missing_alt_text': ['fix-alt-text'],
  'redirect_chains': ['fix-redirects'],
};
```

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/public/js/dashboard.js
git commit -m "feat(dashboard): add renderTechnicalSeoTab with upload, issue cards, and theme audit"
```

---

## Task 7: Tab chat context

**Files:**
- Modify: `agents/dashboard/lib/tab-chat-prompt.js`

- [ ] **Step 1: Add tech-seo context**

In the `buildTabChatSystemPrompt(tab)` function, add a case for `tech-seo`:

```javascript
  if (tab === 'tech-seo') {
    const reportPath = join(ROOT, 'data', 'reports', 'technical-seo', 'technical-seo-audit.md');
    if (existsSync(reportPath)) {
      const report = readFileSync(reportPath, 'utf8').slice(0, 3000);
      lines.push('Current technical SEO audit report (first 3000 chars):');
      lines.push(report);
    }
    const themeAuditPath = join(ROOT, 'data', 'reports', 'theme-seo-audit', 'latest.json');
    if (existsSync(themeAuditPath)) {
      try {
        const theme = JSON.parse(readFileSync(themeAuditPath, 'utf8'));
        lines.push('Theme SEO audit results:');
        lines.push(JSON.stringify(theme, null, 2).slice(0, 2000));
      } catch { /* skip */ }
    }
  }
```

- [ ] **Step 2: Commit**

```bash
git add agents/dashboard/lib/tab-chat-prompt.js
git commit -m "feat(tab-chat): add tech-seo context for chat"
```

---

## Task 8: Integration smoke test

- [ ] **Step 1: Run parser tests**

Run: `node --test tests/dashboard/tech-seo-parser.test.js`
Expected: All 4 tests pass.

- [ ] **Step 2: Syntax check all modified files**

Run: `node --check agents/dashboard/lib/tech-seo-parser.js && node --check agents/dashboard/lib/data-loader.js && node --check agents/dashboard/routes/uploads.js && node --check agents/dashboard/lib/run-agent.js && node --check agents/dashboard/lib/tab-chat-prompt.js && echo "All OK"`
Expected: "All OK"

- [ ] **Step 3: Verify dashboard loads**

The HTML and JS changes can't be syntax-checked without a browser, but verify the server starts:

Run: `node --check agents/dashboard/index.js`
Expected: No errors.

- [ ] **Step 4: Commit if any fixes**

```bash
git add -A && git commit -m "fix: smoke test fixes for Technical SEO tab"
```
