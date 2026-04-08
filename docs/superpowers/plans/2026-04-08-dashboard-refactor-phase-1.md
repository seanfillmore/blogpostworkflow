# Dashboard Refactor Phase 1 — Extract `const HTML` to `public/`

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the entire `const HTML` template literal in `agents/dashboard/index.js` (lines 720–5805) into static files served from `agents/dashboard/public/`, eliminating the template-literal escape-sequence bug class permanently and dropping `index.js` from 7,708 → ~3,000 lines.

**Architecture:** The `const HTML` template literal is a 5,086-line static string (verified: zero `${...}` interpolations). It naturally splits into HTML head (8 lines), `<style>` block (680 lines), HTML body (335 lines), `<script>` block (3,860 lines), closing HTML (~200 lines). Phase 1 lifts each section into its own file under `agents/dashboard/public/`, adds a tiny static-file handler to the existing `createServer` callback, and replaces the const-HTML route with one that streams the file. No route handlers, render functions, or other code in `index.js` move in this phase.

**Tech Stack:** Node.js stdlib only — `node:fs`, `node:http`, `node:path`. No new dependencies.

---

## File Structure

**Created:**
- `agents/dashboard/public/index.html` — full HTML shell with `<link>` to CSS and `<script src>` for JS
- `agents/dashboard/public/dashboard.css` — verbatim contents of the current `<style>` block
- `agents/dashboard/public/js/dashboard.js` — verbatim contents of the current `<script>` block, with `\\n` / `\\s` escapes converted back to natural form (the whole point of the refactor)
- `agents/dashboard/lib/static.js` — `serveStatic(req, res, publicDir)` helper. Streams files. Handles MIME types and 404s.

**Modified:**
- `agents/dashboard/index.js`:
  - Delete `const HTML = ...` (lines 720–5805).
  - Add `import { serveStatic } from './lib/static.js'` near the top.
  - Replace the existing `GET /` route handler (whatever currently serves `HTML`) so it streams `public/index.html` via `serveStatic`.
  - Add a fall-through `serveStatic` call at the end of the request dispatch chain, before the final 404, so `/dashboard.css` and `/js/dashboard.js` get served.
- `CLAUDE.md`:
  - Delete the entire "Code Review Checklist — Dashboard" / "Template Literal Escape Sequences" section.
  - Replace with a one-line note: "Browser JS, CSS, and HTML for the dashboard live in `agents/dashboard/public/`. Edit those files directly — no escaping rules apply."

---

## Task 1: Set up the static file directory and helper

**Files:**
- Create: `agents/dashboard/public/.gitkeep`
- Create: `agents/dashboard/lib/static.js`

- [ ] **Step 1: Create the public directory placeholder**

```bash
mkdir -p agents/dashboard/public/js agents/dashboard/lib
touch agents/dashboard/public/.gitkeep
```

- [ ] **Step 2: Write `agents/dashboard/lib/static.js`**

```javascript
/**
 * Serve a file from the dashboard's public/ directory.
 *
 * Returns true if the request was handled (file streamed or 404 sent),
 * false if the URL is outside the public/ namespace and the caller
 * should continue dispatching.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.map':  'application/json; charset=utf-8',
};

/**
 * Resolve a URL path against publicDir, returning the absolute file path
 * only if it stays inside publicDir (prevents path traversal).
 */
function safeResolve(publicDir, urlPath) {
  // Strip query string and leading slash
  const clean = urlPath.split('?')[0].replace(/^\/+/, '');
  const abs = normalize(join(publicDir, clean));
  if (!abs.startsWith(publicDir)) return null;
  return abs;
}

export function serveStatic(req, res, publicDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  // Map "/" to /index.html
  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = safeResolve(publicDir, urlPath);
  if (!filePath) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return true;
  }
  if (!existsSync(filePath)) return false;
  const st = statSync(filePath);
  if (st.isDirectory()) return false;

  const mime = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': st.size,
    // Cache aggressively in production; cheap to bust by editing the file.
    'Cache-Control': 'public, max-age=60',
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  createReadStream(filePath).pipe(res);
  return true;
}
```

- [ ] **Step 3: Verify syntax**

```bash
node -c agents/dashboard/lib/static.js && echo OK
```

Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/lib/static.js agents/dashboard/public/.gitkeep
git commit -m "feat(dashboard): add static file serving helper"
```

---

## Task 2: Extract the `<style>` block into `public/dashboard.css`

**Files:**
- Read: `agents/dashboard/index.js` (lines 728–1407 — the `<style>...</style>` content; verify boundaries before extracting)
- Create: `agents/dashboard/public/dashboard.css`

- [ ] **Step 1: Verify the exact line range of the style block**

```bash
awk 'NR==720,NR==5805' agents/dashboard/index.js | grep -n '<style>\|</style>'
```

Expected output:
```
9:<style>
688:</style>
```

That confirms the style block runs from `index.js` line `720 + 9 - 1 = 728` to line `720 + 688 - 1 = 1407`. The opening `<style>` tag is on line 728, the inner CSS starts on 729, the closing `</style>` is on 1407.

- [ ] **Step 2: Extract the CSS into `public/dashboard.css`**

```bash
sed -n '729,1406p' agents/dashboard/index.js > agents/dashboard/public/dashboard.css
```

- [ ] **Step 3: Verify the CSS file is non-empty and looks like CSS**

```bash
wc -l agents/dashboard/public/dashboard.css
head -3 agents/dashboard/public/dashboard.css
tail -3 agents/dashboard/public/dashboard.css
```

Expected: ~678 lines. First lines should be the `*, *::before` reset rule. Last lines should be the final CSS rule before `</style>` (no `</style>` tag in the file).

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/public/dashboard.css
git commit -m "feat(dashboard): extract CSS to public/dashboard.css"
```

---

## Task 3: Extract the `<script>` block into `public/js/dashboard.js`

**Files:**
- Read: `agents/dashboard/index.js` (lines 1744–5607 — the `<script>...</script>` content)
- Create: `agents/dashboard/public/js/dashboard.js`

- [ ] **Step 1: Verify the exact line range of the script block**

```bash
awk 'NR==720,NR==5805{print NR-719": "$0}' agents/dashboard/index.js | grep '<script>\|</script>'
```

Expected:
```
1025:<script>
4888:</script>
```

That confirms the script block runs from `index.js` line `720 + 1025 - 1 = 1744` to `720 + 4888 - 1 = 5607`. Inner JS starts on 1745, closing `</script>` is on 5607.

- [ ] **Step 2: Extract the JS into `public/js/dashboard.js`**

```bash
sed -n '1745,5606p' agents/dashboard/index.js > agents/dashboard/public/js/dashboard.js
```

- [ ] **Step 3: Convert escape-doubled sequences back to natural form**

The current code has `\\n` / `\\t` / `\\s` everywhere because Node was processing the template literal before the browser saw the string. In a real `.js` file these need to be `\n` / `\t` / `\s`.

```bash
# Use sed with a temp file to be explicit about what we're doing.
# This converts \\n -> \n, \\t -> \t, \\r -> \r, \\s -> \s ONLY where they
# appear escaped in the source. We don't touch \\\\ (legitimate backslash).
node -e "
const fs = require('fs');
const path = 'agents/dashboard/public/js/dashboard.js';
let s = fs.readFileSync(path, 'utf8');
// Replace doubled escapes inside strings/regex with single. The doubling was
// only ever needed because Node interpolated the template literal.
s = s.replace(/\\\\\\\\([nrtsdwbDWS])/g, '\\\\\$1');
fs.writeFileSync(path, s);
console.log('done');
"
```

- [ ] **Step 4: Verify the JS file parses as valid JavaScript**

```bash
node --check agents/dashboard/public/js/dashboard.js && echo OK
```

Expected: `OK`. If this fails, the escape conversion in step 3 was too aggressive — inspect the error line, restore from `index.js`, and convert the offending sequences manually.

- [ ] **Step 5: Quick sanity grep — no remaining `\\n` inside string literals**

```bash
grep -n "'.*\\\\\\\\n.*'" agents/dashboard/public/js/dashboard.js | head -5
grep -n '".*\\\\\\\\n.*"' agents/dashboard/public/js/dashboard.js | head -5
```

Expected: no output (no double-escaped `\\n` left inside string literals).

- [ ] **Step 6: Commit**

```bash
git add agents/dashboard/public/js/dashboard.js
git commit -m "feat(dashboard): extract browser JS to public/js/dashboard.js"
```

---

## Task 4: Build `public/index.html`

**Files:**
- Read: `agents/dashboard/index.js` (lines 720–727 head, 1408–1743 body, 5608–5805 closing)
- Create: `agents/dashboard/public/index.html`

- [ ] **Step 1: Extract the HTML head, body, and closing into a single file**

```bash
{
  # Lines 1-8 of the template (head incl. <head>, fonts, title, opening <style>)
  sed -n '720,727p' agents/dashboard/index.js
  # Replace inline <style> with external stylesheet link
  echo '<link rel="stylesheet" href="/dashboard.css">'
  # Lines 689-1024 of the template = index.js 1408-1743 (the </style>...<script> body)
  # We skip the </style> on line 1407 (already implicit) and the <script> on 1744.
  sed -n '1408,1743p' agents/dashboard/index.js
  # Replace inline <script> with external script reference
  echo '<script src="/js/dashboard.js"></script>'
  # Lines 4889-5086 of the template = index.js 5608-5805 (everything after </script>)
  sed -n '5608,5805p' agents/dashboard/index.js
} > agents/dashboard/public/index.html
```

- [ ] **Step 2: Verify the file has the expected shape**

```bash
head -10 agents/dashboard/public/index.html
echo ---
grep -c '<link rel="stylesheet" href="/dashboard.css">' agents/dashboard/public/index.html
grep -c '<script src="/js/dashboard.js"></script>' agents/dashboard/public/index.html
tail -5 agents/dashboard/public/index.html
```

Expected: starts with `<!DOCTYPE html>`, has exactly one `<link>` to dashboard.css, one `<script src>` to dashboard.js, ends with `</html>`.

- [ ] **Step 3: Verify the file does NOT contain any leftover `<style>` or inline `<script>` content**

```bash
grep -n '<style>\|</style>' agents/dashboard/public/index.html
grep -c '<script>' agents/dashboard/public/index.html
```

Expected: no `<style>` tags. Zero inline `<script>` opens (the only `<script>` line should be the `<script src="...">` self-contained tag).

- [ ] **Step 4: Commit**

```bash
git add agents/dashboard/public/index.html
git commit -m "feat(dashboard): extract HTML shell to public/index.html"
```

---

## Task 5: Wire static serving into `index.js` and delete `const HTML`

**Files:**
- Modify: `agents/dashboard/index.js`

- [ ] **Step 1: Find the existing route that serves `HTML`**

```bash
grep -n "end(HTML)\|HTML);" agents/dashboard/index.js
```

This gives the line(s) where the current code returns the const. Note them — they need to be replaced with a call into the static handler.

- [ ] **Step 2: Add the import near the top of `index.js`**

Find the existing import block (the lines starting with `import http from 'http';`) and add:

```javascript
import { serveStatic } from './lib/static.js';
```

Also add a constant near the other path constants:

```javascript
const PUBLIC_DIR = join(__dirname, 'public');
```

- [ ] **Step 3: Replace the `GET /` route**

The current code looks roughly like:

```javascript
if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(HTML);
  return;
}
```

Replace it with:

```javascript
if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
  if (serveStatic(req, res, PUBLIC_DIR)) return;
}
```

- [ ] **Step 4: Add the static fall-through near the end of the dispatch chain**

Just before the final 404 handler (the catch-all `res.writeHead(404, ...)`), add:

```javascript
// Static assets from agents/dashboard/public/
if (serveStatic(req, res, PUBLIC_DIR)) return;
```

- [ ] **Step 5: Delete the `const HTML = ...` block (lines 720–5805)**

```bash
# Verify the line range first
sed -n '720p;5805p' agents/dashboard/index.js
# Expected: line 720 starts with "const HTML = `", line 5805 ends with "`;"

# Delete inclusively
sed -i.bak '720,5805d' agents/dashboard/index.js
rm agents/dashboard/index.js.bak
```

- [ ] **Step 6: Verify `index.js` parses**

```bash
node --check agents/dashboard/index.js && echo OK
wc -l agents/dashboard/index.js
```

Expected: `OK`. Line count drops from 7,708 to ~2,620.

- [ ] **Step 7: Smoke test the server locally**

```bash
node agents/dashboard/index.js --port 4243 &
SERVER_PID=$!
sleep 2
curl -sI http://localhost:4243/ | head -3
curl -sI http://localhost:4243/dashboard.css | head -3
curl -sI http://localhost:4243/js/dashboard.js | head -3
curl -s http://localhost:4243/api/data | head -c 200
kill $SERVER_PID
```

Expected: each `curl -sI` returns `HTTP/1.1 200 OK`. The `/api/data` request returns valid JSON (starts with `{`).

- [ ] **Step 8: Open the dashboard in a browser and click every tab**

Start the server normally:

```bash
node agents/dashboard/index.js
```

In a browser, go to http://localhost:4242 and click through every tab: Optimize, Kanban, Rankings, Posts, CRO, Ads, Creatives, Chat. Open the browser devtools console — verify there are no JavaScript errors. If the previous CLAUDE.md escape rules were ever violated in the source, they will now manifest as syntax errors in the console.

If there are errors: note the file and line number, fix in `public/js/dashboard.js`, reload. The whole point is that you're now editing a real `.js` file.

- [ ] **Step 9: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "refactor(dashboard): replace const HTML with static file serving

Lifts the 5,086-line const HTML template literal into agents/dashboard/public/
(index.html, dashboard.css, js/dashboard.js). The static handler streams the
files directly. index.js drops from 7,708 to ~2,620 lines and the recurring
template-literal escape-sequence bug class is gone permanently."
```

---

## Task 6: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Find the dashboard checklist section**

```bash
grep -n "Code Review Checklist — Dashboard\|Template Literal Escape Sequences" CLAUDE.md
```

This gives the start of the section that needs to go.

- [ ] **Step 2: Delete the entire "Code Review Checklist — Dashboard" section**

The section spans from `## Code Review Checklist — Dashboard (\`agents/dashboard/index.js\`)` through the end of its content (the next `##`-level section). Use the Edit tool to delete it.

- [ ] **Step 3: Add a replacement note**

Insert the following one-line note in its place:

```markdown
## Dashboard Code Layout

Browser HTML, CSS, and JavaScript for the dashboard live in `agents/dashboard/public/`. Edit those files directly — they are served as static assets, so no template literal escaping rules apply.
```

- [ ] **Step 4: Verify the section was removed and the new note added**

```bash
grep -c "Template Literal Escape Sequences" CLAUDE.md
grep -c "Dashboard Code Layout" CLAUDE.md
```

Expected: `0` and `1`.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: remove dashboard template literal escape rules

The const HTML template literal no longer exists; browser code lives
in agents/dashboard/public/ as real files. The escape rules are obsolete."
```

---

## Task 7: Deploy and verify on the server

- [ ] **Step 1: Push and merge the branch**

```bash
git push -u origin feature/dashboard-refactor-phase-1
gh pr create --title "refactor(dashboard): phase 1 — extract const HTML to public/" --base main --body "Implements Phase 1 of the dashboard refactor spec. Lifts the 5,086-line const HTML template literal into agents/dashboard/public/ (index.html, dashboard.css, js/dashboard.js). Adds a tiny static file handler. Drops index.js from 7,708 to ~2,620 lines. Eliminates the template literal escape bug class permanently.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
gh pr merge --merge --delete-branch
```

- [ ] **Step 2: Pull main locally**

```bash
git checkout main
git pull
```

- [ ] **Step 3: Deploy to the server**

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && git pull && pm2 restart seo-dashboard'
```

- [ ] **Step 4: Verify the server is online and serving the new files**

```bash
ssh root@137.184.119.230 'pm2 status seo-dashboard'
curl -sI http://137.184.119.230:4242/dashboard.css | head -3
curl -sI http://137.184.119.230:4242/js/dashboard.js | head -3
```

Expected: PM2 shows `online`. Both curl requests return `HTTP/1.1 200 OK` with the right MIME types (`text/css` and `application/javascript`).

- [ ] **Step 5: Open the production dashboard in a browser**

Visit http://137.184.119.230:4242 and click through every tab. Verify no JS errors in the browser console.

- [ ] **Step 6: Pause for the checkpoint**

This is the hard checkpoint defined in the spec. Use the dashboard for a day or two. Decide:

- If editing files in `agents/dashboard/public/` feels good and `index.js` at ~2,620 lines feels manageable, **stop here**. Phase 1 has captured the bulk of the value. Move on to adding the new SEO engine cards (post-performance, quick-wins, cluster weights, etc.) on top of the now-cleaner base.
- If the route soup in `index.js` is still painful, return to the spec and write a Phase 2 plan (route extraction).
