# Dashboard Refactor Phase 2 — Route & Supporting Code Extraction

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `agents/dashboard/index.js` from 2,629 lines to a thin (~150 line) bootstrap by extracting the 38 route handlers, data-loading helpers, auth/path constants, and SSE-streaming logic into focused modules under `agents/dashboard/lib/` and `agents/dashboard/routes/`.

**Architecture:** Every route handler in the `createServer` callback becomes an entry in an array exported from a `routes/*.js` module. Each entry is `{ method, match, handler }` where `match` is either a string (exact) or a function (`(url) => boolean`) for prefix/regex routes. The bootstrap in `index.js` composes all route arrays into one flat list and walks it per request. Data parsers and shared helpers move to `lib/`.

**Tech Stack:** Plain Node.js ESM. No new dependencies. No behavior changes.

---

## Target file layout

```
agents/dashboard/
├── index.js                    # bootstrap: imports, creates ctx, registers routes, starts server (~150 lines)
├── lib/
│   ├── static.js               # (already exists from Phase 1)
│   ├── auth.js                 # loadEnvAuth, checkAuth, AUTH_TOKEN setup
│   ├── paths.js                # all *_DIR constants + ROOT + PUBLIC_DIR
│   ├── env.js                  # process.env hydration from .env (was inline)
│   ├── fs-helpers.js           # ensureDir, kwToSlug, small shared utilities
│   ├── data-parsers.js         # parseCalendar, parseEditorReports, parseRankings, parseCROData, loadRejections, isRejectedKw, checkAhrefsData, getPendingAhrefsData, getPostMeta, getItemStatus
│   ├── data-loader.js          # aggregateData() (the big one) + a 2s TTL cache
│   ├── run-agent.js            # RUN_AGENT_ALLOWLIST + the /run-agent SSE streaming handler factory
│   ├── tab-chat-prompt.js      # buildTabChatSystemPrompt
│   ├── creatives-store.js      # saveSession, createSession, GEMINI_MODELS
│   └── responses.js            # respondJson, respondError, readJsonBody helpers
└── routes/
    ├── agents.js               # POST /run-agent, /apply/*, /brief/*, /dismiss-alert
    ├── uploads.js              # /upload/ahrefs, /upload/rank-snapshot, /upload/ahrefs-keyword-zip, /upload/content-gap-zip
    ├── ahrefs.js               # POST /api/ahrefs-overview, POST /api/reject-keyword
    ├── data.js                 # GET /api/data (just calls the data loader)
    ├── chat.js                 # POST /api/chat, /api/chat/action-item
    ├── ads.js                  # /apply-ads, /api/campaigns, /ads/:date/suggestion/:id, /ads/.../chat
    ├── creatives.js            # ~16 /api/creatives/* routes + /api/generate-creative + /api/creative-packages/download/*
    ├── google.js               # /api/google/auth, /callback, /status
    ├── meta-ads.js             # /api/meta-ads-insights
    └── misc.js                 # /screenshot, /images/*
```

---

## Context passed to each route

Handlers receive `(req, res, ctx)` where `ctx` is a single frozen object built once at startup:

```javascript
const ctx = {
  ROOT, PUBLIC_DIR,
  POSTS_DIR, BRIEFS_DIR, IMAGES_DIR, REPORTS_DIR, SNAPSHOTS_DIR,
  KEYWORD_TRACKER_DIR, ADS_OPTIMIZER_DIR, CALENDAR_PATH,
  COMP_SCREENSHOTS_DIR, META_ADS_INSIGHTS_DIR,
  CREATIVE_TEMPLATES_PREVIEWS_DIR, CREATIVE_SESSIONS_DIR, CREATIVES_DIR,
  CLARITY_SNAPSHOTS_DIR, SHOPIFY_SNAPSHOTS_DIR, GOOGLE_ADS_SNAPSHOTS_DIR,
  CONTENT_GAP_DIR, RANK_ALERTS_DIR,
  anthropic,                 // the Anthropic SDK client
  loadData,                  // cached aggregateData()
  runAgent,                  // /run-agent SSE handler (bound to allowlist)
  adsInFlight: new Set(),    // shared mutable state that was module-level
};
```

Shared mutable state (like `adsInFlight`) lives on `ctx` so it's one instance shared across all route modules.

---

## Migration rules

1. **Pure code-moves only.** If a handler is 40 lines in `index.js`, it becomes a 40-line function in the route module. No refactoring, no "while I'm here" cleanups, no inlining, no extraction of sub-helpers. We take the efficiency wins (cache, respondJson helper) in specific named tasks, not opportunistically.
2. **Each task commits independently** and leaves the dashboard in a working state. Local smoke test (authenticated curl of `/api/data` and a representative route from the extracted module) before each commit.
3. **Final server deploy** happens once at the end, not per task. Safe because every intermediate state is verified working locally.

---

## Task 1: Extract `lib/paths.js`, `lib/auth.js`, `lib/env.js`

**Files:**
- Create: `agents/dashboard/lib/paths.js`
- Create: `agents/dashboard/lib/auth.js`
- Create: `agents/dashboard/lib/env.js`
- Modify: `agents/dashboard/index.js` (remove the extracted code, import from new modules)

- [ ] **Step 1: Create `lib/env.js`**

Move the `loadEnvAuth` function and the line that hydrates `process.env` from it. Export both.

```javascript
// agents/dashboard/lib/env.js
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');

export function loadEnvAuth() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const e = {};
    for (const l of lines) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      e[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return e;
  } catch { return {}; }
}

export function hydrateProcessEnv(env) {
  for (const [k, v] of Object.entries(env)) {
    if (!process.env[k]) process.env[k] = v;
  }
}
```

- [ ] **Step 2: Create `lib/auth.js`**

```javascript
// agents/dashboard/lib/auth.js
export function createAuthCheck(envMap) {
  const AUTH_USER = envMap.DASHBOARD_USER || '';
  const AUTH_PASS = envMap.DASHBOARD_PASSWORD || '';
  const AUTH_REQUIRED = AUTH_USER && AUTH_PASS;
  const AUTH_TOKEN = AUTH_REQUIRED
    ? 'Basic ' + Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64')
    : null;

  return function checkAuth(req, res) {
    if (!AUTH_REQUIRED) return true;
    if (req.headers['authorization'] === AUTH_TOKEN) return true;
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="SEO Dashboard"', 'Content-Type': 'text/plain' });
    res.end('Unauthorized');
    return false;
  };
}
```

- [ ] **Step 3: Create `lib/paths.js`**

Copy verbatim the path constants from `index.js` (ROOT, POSTS_DIR, BRIEFS_DIR, IMAGES_DIR, REPORTS_DIR, SNAPSHOTS_DIR, KEYWORD_TRACKER_DIR, ADS_OPTIMIZER_DIR, CALENDAR_PATH, COMP_SCREENSHOTS_DIR, META_ADS_INSIGHTS_DIR, CREATIVE_TEMPLATES_PREVIEWS_DIR, CREATIVE_SESSIONS_DIR, CREATIVES_DIR, CLARITY_SNAPSHOTS_DIR, SHOPIFY_SNAPSHOTS_DIR, GOOGLE_ADS_SNAPSHOTS_DIR, CONTENT_GAP_DIR, RANK_ALERTS_DIR, PUBLIC_DIR). Export all of them as named exports.

The `ROOT` resolution changes: in `index.js` it is `join(__dirname, '..', '..')`, but in `lib/paths.js` we need `join(__dirname, '..', '..', '..')` because the file is one directory deeper.

- [ ] **Step 4: Update `index.js` to import from new modules**

At the top of `index.js`, replace the extracted blocks with:

```javascript
import { loadEnvAuth, hydrateProcessEnv } from './lib/env.js';
import { createAuthCheck } from './lib/auth.js';
import * as paths from './lib/paths.js';

const _authEnv = loadEnvAuth();
hydrateProcessEnv(_authEnv);
const checkAuth = createAuthCheck(_authEnv);
```

Then delete the old inline `loadEnvAuth`, the `_authEnv` / `process.env` loop, `AUTH_USER` / `AUTH_PASS` / `AUTH_REQUIRED` / `AUTH_TOKEN` / `checkAuth`, and all the `const *_DIR` path declarations. Throughout the rest of `index.js`, references like `POSTS_DIR` become `paths.POSTS_DIR`.

The mechanical find-and-replace: every identifier in the list from Step 3 gets `paths.` prefixed. The easiest approach is a single `sed`:

```bash
node -e "
import('node:fs').then(({ readFileSync, writeFileSync }) => {
  const NAMES = ['ROOT','POSTS_DIR','BRIEFS_DIR','IMAGES_DIR','REPORTS_DIR','SNAPSHOTS_DIR','KEYWORD_TRACKER_DIR','ADS_OPTIMIZER_DIR','CALENDAR_PATH','COMP_SCREENSHOTS_DIR','META_ADS_INSIGHTS_DIR','CREATIVE_TEMPLATES_PREVIEWS_DIR','CREATIVE_SESSIONS_DIR','CREATIVES_DIR','CLARITY_SNAPSHOTS_DIR','SHOPIFY_SNAPSHOTS_DIR','GOOGLE_ADS_SNAPSHOTS_DIR','CONTENT_GAP_DIR','RANK_ALERTS_DIR','PUBLIC_DIR'];
  let s = readFileSync('agents/dashboard/index.js', 'utf8');
  for (const n of NAMES) {
    // Replace bare uses of the name with paths.<name>, but not inside 'paths.<name>' already
    const re = new RegExp('(?<![.\\\\w])' + n + '(?!\\\\w)', 'g');
    s = s.replace(re, 'paths.' + n);
  }
  writeFileSync('agents/dashboard/index.js', s);
  console.log('done');
});
"
```

After running this, the `const paths.POSTS_DIR = ...` declarations need to be manually deleted (they'll also have been renamed by the sed, which is wrong). Open the file, find the old path constant block, and delete it entirely — the imports replace it.

**Simpler alternative:** instead of renaming with `paths.` prefix throughout the file, import the paths individually:

```javascript
import {
  ROOT, POSTS_DIR, BRIEFS_DIR, IMAGES_DIR, REPORTS_DIR, SNAPSHOTS_DIR,
  KEYWORD_TRACKER_DIR, ADS_OPTIMIZER_DIR, CALENDAR_PATH,
  COMP_SCREENSHOTS_DIR, META_ADS_INSIGHTS_DIR,
  CREATIVE_TEMPLATES_PREVIEWS_DIR, CREATIVE_SESSIONS_DIR, CREATIVES_DIR,
  CLARITY_SNAPSHOTS_DIR, SHOPIFY_SNAPSHOTS_DIR, GOOGLE_ADS_SNAPSHOTS_DIR,
  CONTENT_GAP_DIR, RANK_ALERTS_DIR, PUBLIC_DIR,
} from './lib/paths.js';
```

Then the only edit to the body of `index.js` is deleting the old `const X = ...` declarations. All in-body references continue to work unchanged.

**Use the simpler alternative.** It's less risk and less code churn.

- [ ] **Step 5: Verify**

```bash
node --check agents/dashboard/index.js && echo OK
node --check agents/dashboard/lib/env.js agents/dashboard/lib/auth.js agents/dashboard/lib/paths.js && echo OK
```

Start the server on port 4248, authed curl `/`, `/api/data`, `/dashboard.css`, `/js/dashboard.js`. All 200s.

- [ ] **Step 6: Commit**

```bash
git add agents/dashboard/lib/{env,auth,paths}.js agents/dashboard/index.js
git commit -m "refactor(dashboard): extract env, auth, and paths to lib/"
```

---

## Task 2: Extract `lib/data-parsers.js` and `lib/data-loader.js`

**Files:**
- Create: `agents/dashboard/lib/fs-helpers.js`
- Create: `agents/dashboard/lib/data-parsers.js`
- Create: `agents/dashboard/lib/data-loader.js`
- Modify: `agents/dashboard/index.js`

- [ ] **Step 1: Create `lib/fs-helpers.js`**

```javascript
// agents/dashboard/lib/fs-helpers.js
import { existsSync, mkdirSync } from 'node:fs';

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function kwToSlug(kw) {
  return (kw || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
```

- [ ] **Step 2: Create `lib/data-parsers.js`**

Copy all the parser helper functions verbatim: `parseCalendar`, `getPostMeta`, `getItemStatus`, `parseEditorReports`, `parseRankings`, `parseCROData`, `loadRejections`, `isRejectedKw`, `checkAhrefsData`, `getPendingAhrefsData`. These all reference path constants — import them from `./paths.js`.

Each function gets `export` added. No logic changes.

- [ ] **Step 3: Create `lib/data-loader.js`**

Move `aggregateData` verbatim. Import its dependencies from `./data-parsers.js` and `./paths.js`. Export as `aggregateData`.

Add a 2-second TTL cache:

```javascript
// agents/dashboard/lib/data-loader.js
import * as parsers from './data-parsers.js';
// ... other imports ...

export function aggregateData() {
  // existing body
}

let _cache = null;
let _cacheExpiry = 0;
const CACHE_TTL_MS = 2000;

export function loadData() {
  const now = Date.now();
  if (_cache && now < _cacheExpiry) return _cache;
  _cache = aggregateData();
  _cacheExpiry = now + CACHE_TTL_MS;
  return _cache;
}

export function invalidateDataCache() { _cache = null; _cacheExpiry = 0; }
```

- [ ] **Step 4: Update `index.js`**

Delete the inline `parseCalendar`, `getPostMeta`, etc. Delete `aggregateData`. Add imports:

```javascript
import { loadData, invalidateDataCache } from './lib/data-loader.js';
```

Find every call to `aggregateData()` in `index.js` (there's likely one in `/api/data` route and possibly in the initial console.log block) and replace with `loadData()`.

- [ ] **Step 5: Verify & commit**

```bash
node --check agents/dashboard/index.js && echo OK
# start server, curl /api/data, confirm identical JSON vs before
```

```bash
git add agents/dashboard/lib/{fs-helpers,data-parsers,data-loader}.js agents/dashboard/index.js
git commit -m "refactor(dashboard): extract data parsers and loader to lib/"
```

---

## Task 3: Extract `lib/run-agent.js`, `lib/responses.js`, `lib/tab-chat-prompt.js`, `lib/creatives-store.js`

**Files:**
- Create: `agents/dashboard/lib/responses.js`
- Create: `agents/dashboard/lib/run-agent.js`
- Create: `agents/dashboard/lib/tab-chat-prompt.js`
- Create: `agents/dashboard/lib/creatives-store.js`
- Modify: `agents/dashboard/index.js`

- [ ] **Step 1: Create `lib/responses.js`**

```javascript
// agents/dashboard/lib/responses.js
export function respondJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

export function respondError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: message }));
}

export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}
```

- [ ] **Step 2: Create `lib/run-agent.js`**

Move `RUN_AGENT_ALLOWLIST` and the `/run-agent` route handler body into a factory:

```javascript
// agents/dashboard/lib/run-agent.js
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const RUN_AGENT_ALLOWLIST = new Set([
  // copy the existing allowlist contents verbatim
]);

export function createRunAgentHandler(ROOT) {
  return function runAgentHandler(req, res) {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let script, args = [];
      try { ({ script, args = [] } = JSON.parse(body)); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        return;
      }
      if (!RUN_AGENT_ALLOWLIST.has(script)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Script not in allowlist' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      const child = spawn('node', [join(ROOT, script), ...args], { cwd: ROOT });
      const send = (line) => res.write(`data: ${line}\n\n`);
      child.stdout.on('data', (d) => String(d).split('\n').filter(Boolean).forEach(send));
      child.stderr.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => send(`[stderr] ${l}`)));
      child.on('close', (code) => { res.write(`data: __exit__:${JSON.stringify({ code })}\n\n`); res.end(); });
    });
  };
}
```

- [ ] **Step 3: Create `lib/tab-chat-prompt.js`**

Move `buildTabChatSystemPrompt` verbatim. Export it.

- [ ] **Step 4: Create `lib/creatives-store.js`**

Move `GEMINI_MODELS`, `saveSession`, `createSession`. The functions use `CREATIVE_SESSIONS_DIR` / `CREATIVES_DIR` / `ensureDir` — import them from `./paths.js` and `./fs-helpers.js`. Export all three.

- [ ] **Step 5: Update `index.js`**

Remove the inline definitions. Add imports. Replace the inline `/run-agent` handler with `const runAgent = createRunAgentHandler(ROOT);` and a route entry that calls `runAgent(req, res)`.

- [ ] **Step 6: Verify & commit**

```bash
node --check agents/dashboard/index.js && echo OK
# smoke test
git add agents/dashboard/lib/{responses,run-agent,tab-chat-prompt,creatives-store}.js agents/dashboard/index.js
git commit -m "refactor(dashboard): extract run-agent, responses, chat prompt, and creatives store to lib/"
```

---

## Task 4: Create the route dispatcher

**Files:**
- Create: `agents/dashboard/lib/router.js`
- Modify: `agents/dashboard/index.js`

- [ ] **Step 1: Create `lib/router.js`**

```javascript
// agents/dashboard/lib/router.js
/**
 * Tiny router. Takes an array of { method, match, handler } entries.
 * - method: 'GET' | 'POST' | 'PUT' | 'DELETE'
 * - match: string (exact URL match) OR function (url) => boolean
 * - handler: (req, res, ctx) => Promise<void> | void
 *
 * dispatch(req, res, ctx) walks the route list and calls the first matching
 * handler. Returns true if a route matched, false otherwise.
 */
export function dispatch(routes, req, res, ctx) {
  for (const route of routes) {
    if (route.method !== req.method) continue;
    const matched = typeof route.match === 'string'
      ? req.url === route.match
      : route.match(req.url);
    if (!matched) continue;
    route.handler(req, res, ctx);
    return true;
  }
  return false;
}
```

- [ ] **Step 2: Verify & commit**

```bash
node --check agents/dashboard/lib/router.js && echo OK
git add agents/dashboard/lib/router.js
git commit -m "refactor(dashboard): add tiny route dispatcher"
```

---

## Task 5: Extract `routes/data.js`, `routes/agents.js`, `routes/misc.js`

These are the smallest and most isolated routes — do them first to establish the pattern.

**Files:**
- Create: `agents/dashboard/routes/data.js`
- Create: `agents/dashboard/routes/agents.js`
- Create: `agents/dashboard/routes/misc.js`
- Modify: `agents/dashboard/index.js`

- [ ] **Step 1: `routes/data.js`**

```javascript
// agents/dashboard/routes/data.js
import { respondJson } from '../lib/responses.js';

export default [
  {
    method: 'GET',
    match: '/api/data',
    handler(req, res, ctx) {
      respondJson(res, ctx.loadData());
    },
  },
];
```

- [ ] **Step 2: `routes/agents.js`**

Move these routes from `index.js`:
- `POST /run-agent` → calls `ctx.runAgent(req, res)`
- `POST /brief/*` — the brief acceptance route
- `POST /apply/*` — the apply/optimization route
- `POST /dismiss-alert`

Each becomes an entry in the exported array. For prefix routes use `match: (url) => url.startsWith('/brief/')`. Copy the handler body verbatim, wrapped as a function that takes `(req, res, ctx)`. Replace any direct references to `POSTS_DIR` / `BRIEFS_DIR` / etc. with `ctx.POSTS_DIR` etc.

- [ ] **Step 3: `routes/misc.js`**

Move:
- `GET /screenshot?...`
- `GET /images/*`

- [ ] **Step 4: Wire into `index.js`**

```javascript
import dataRoutes from './routes/data.js';
import agentsRoutes from './routes/agents.js';
import miscRoutes from './routes/misc.js';
import { dispatch } from './lib/router.js';

const ROUTES = [
  ...dataRoutes,
  ...agentsRoutes,
  ...miscRoutes,
  // more to come
];
```

Inside the `createServer` callback, AT THE TOP after `checkAuth`, add:

```javascript
if (dispatch(ROUTES, req, res, ctx)) return;
```

Then delete the inline handler blocks that were moved. The inline blocks still in `index.js` are the ones not yet extracted — they stay for now.

Build the `ctx` object once at startup, just before `const server = http.createServer`:

```javascript
const ctx = {
  ...paths,   // all the path constants
  anthropic,
  loadData,
  runAgent,
  adsInFlight,  // the Set at module scope
};
```

Wait — `paths` is the namespace import from Task 1. Spreading it works: `...paths`.

- [ ] **Step 5: Verify & commit**

Start server, authed curl `/api/data`, `/run-agent` POST with a tiny allowlisted script, `/dismiss-alert` POST, `/images/some-file.png`. All should behave identically.

```bash
git add agents/dashboard/routes/{data,agents,misc}.js agents/dashboard/index.js
git commit -m "refactor(dashboard): extract data, agents, misc routes"
```

---

## Task 6: Extract `routes/uploads.js` and `routes/ahrefs.js`

Move:
- `POST /upload/ahrefs`
- `POST /upload/rank-snapshot`
- `POST /upload/ahrefs-keyword-zip`
- `POST /upload/content-gap-zip`
- `POST /api/ahrefs-overview`
- `POST /api/reject-keyword`

The upload routes use `multer` via `const upload = multer({...})` at module scope in `index.js`. Move that definition and any required import into `routes/uploads.js`.

The `/api/reject-keyword` route mutates `data/rejected-keywords.json` and should call `ctx.invalidateDataCache()` after writing so subsequent `/api/data` calls see the change.

- [ ] **Step 1: Create the files and move routes**
- [ ] **Step 2: Import and register in `index.js`**
- [ ] **Step 3: Verify & commit**

```bash
git add agents/dashboard/routes/{uploads,ahrefs}.js agents/dashboard/index.js
git commit -m "refactor(dashboard): extract upload and ahrefs routes"
```

---

## Task 7: Extract `routes/chat.js`

Move:
- `POST /api/chat`
- `POST /api/chat/action-item`

Both use the Anthropic client — reference via `ctx.anthropic`. The chat route also uses `buildTabChatSystemPrompt` — import from `../lib/tab-chat-prompt.js`.

- [ ] Move, wire, verify, commit.

```bash
git add agents/dashboard/routes/chat.js agents/dashboard/index.js
git commit -m "refactor(dashboard): extract chat routes"
```

---

## Task 8: Extract `routes/ads.js`

Move:
- `POST /apply-ads`
- `GET /api/campaigns`
- `POST /ads/:date/suggestion/:id`
- `POST /ads/:date/suggestion/:id/chat`

The `adsInFlight` Set is shared mutable state — reference via `ctx.adsInFlight`.

The `/ads/...` routes have nested URL parsing. Keep the same parsing logic inside the handler body; use `match: (url) => url.startsWith('/ads/') && url.includes('/suggestion/') && !url.endsWith('/chat')` etc. Make sure the chat variant (which ends with `/chat`) is ordered BEFORE the non-chat variant in the array, because the non-chat match would otherwise swallow it.

- [ ] Move, wire, verify, commit.

```bash
git add agents/dashboard/routes/ads.js agents/dashboard/index.js
git commit -m "refactor(dashboard): extract ads routes"
```

---

## Task 9: Extract `routes/creatives.js`

This is the biggest route module — ~16 routes spanning ~1,000 lines in current `index.js`. Move all `/api/creatives/*` routes plus `/api/generate-creative` and `/api/creative-packages/download/*`.

Imports needed: `ctx.anthropic`, `createSession`/`saveSession`/`GEMINI_MODELS` from `../lib/creatives-store.js`, Google Gemini SDK (`import { GoogleGenAI } from '@google/genai'`), filesystem helpers.

- [ ] Move, wire, verify, commit.

```bash
git add agents/dashboard/routes/creatives.js agents/dashboard/index.js
git commit -m "refactor(dashboard): extract creatives routes"
```

---

## Task 10: Extract `routes/google.js` and `routes/meta-ads.js`

**Google OAuth routes:**
- `GET /api/google/auth` — redirect to Google
- `GET /api/google/callback` — handle OAuth callback
- `GET /api/google/status` — check token state

**Meta Ads:**
- `GET /api/meta-ads-insights`

- [ ] Move, wire, verify, commit.

```bash
git add agents/dashboard/routes/{google,meta-ads}.js agents/dashboard/index.js
git commit -m "refactor(dashboard): extract google and meta-ads routes"
```

---

## Task 11: Final bootstrap cleanup

After Task 10, `index.js` should be mostly imports + ctx construction + the `createServer` callback which now reads:

```javascript
const server = http.createServer((req, res) => {
  if (!checkAuth(req, res)) return;
  if (dispatch(ROUTES, req, res, ctx)) return;
  if (serveStatic(req, res, PUBLIC_DIR)) return;
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});
```

- [ ] **Step 1:** Delete any remaining inline handler blocks. There should be none, but sweep the file.
- [ ] **Step 2:** Sort and clean up imports at the top of `index.js`.
- [ ] **Step 3:** Verify line count is roughly 150–200.
- [ ] **Step 4:** Run the smoke test one more time.
- [ ] **Step 5:** Commit.

```bash
git add agents/dashboard/index.js
git commit -m "refactor(dashboard): final bootstrap cleanup"
```

---

## Task 12: Deploy and verify

- [ ] **Step 1:** Push the branch and open a PR.
- [ ] **Step 2:** Merge to main and deploy to server.
- [ ] **Step 3:** Authenticated curl smoke test against production:
  - `GET /`
  - `GET /dashboard.css`
  - `GET /js/dashboard.js`
  - `GET /api/data`
  - `GET /api/campaigns`
  - `GET /api/creatives/models`
  - `GET /api/google/status`
- [ ] **Step 4:** Open the dashboard in a browser, click every tab, verify no console errors.

## Success criteria

- `agents/dashboard/index.js` ≤ 200 lines.
- Every handler lives in a small focused file under `routes/*.js`.
- Shared helpers live under `lib/*.js`.
- Dashboard behavior is identical to the pre-refactor version on every tab.
- The morning digest still arrives the next day.
