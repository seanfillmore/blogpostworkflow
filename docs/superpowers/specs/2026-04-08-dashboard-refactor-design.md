# Dashboard Refactor — Design Spec

**Date:** 2026-04-08
**Status:** Approved for Phase 1
**Goal:** Reorganize `agents/dashboard/index.js` (7,708 lines, single file) into smaller, focused modules so adding features is cleaner and the recurring template-literal escape-bug class disappears entirely. Zero user-visible behavior change.

## Context

`agents/dashboard/index.js` has grown into a single 7.7k-line file containing:
- Imports, auth, paths (~720 lines)
- One giant `const HTML` template literal containing all HTML, CSS, and browser JavaScript (~1,100 lines, lines 720–1820)
- ~50 server-side render/build helper functions (~3,900 lines, lines 1820–5800)
- ~50 inline route handlers chained through one `createServer` callback (~1,900 lines, lines 5840–7700)

The template literal is the worst pain point. Because Node processes escape sequences before the browser sees the string, every `\n` inside browser JS strings (or `\s` inside browser regex) must be written as `\\n` / `\\s`. CLAUDE.md has a dedicated review checklist for this and bugs still ship periodically. Editor support inside template literals is also poor — no syntax highlighting, no formatting, no linting.

## Non-goals

- Not introducing Express, Fastify, or any router library. Plain Node `http` continues.
- Not introducing TypeScript, a frontend bundler, or a build step.
- Not converting the dashboard to a SPA (React/Vue/etc.). The current architecture — server-rendered HTML composed from render helpers — stays.
- Not adding tests. The project has no test suite. Verification is "load the dashboard, exercise every tab."
- Not adding new user-facing features. Post-performance, quick-wins, cluster-weights cards come *after* this refactor lands.

## Target architecture

```
agents/dashboard/
├── index.js                    # ~150 lines: server bootstrap, wires routes + static
├── public/                     # served as static files (no template literal escaping)
│   ├── index.html              # the HTML shell
│   ├── dashboard.css           # all CSS
│   └── js/
│       ├── app.js              # main app + tab switching
│       ├── kanban.js           # kanban interactions
│       ├── creatives.js        # creatives tab JS (the largest module)
│       ├── ads.js              # ads tab JS
│       ├── chat.js             # tab chat panel JS
│       └── ...                 # additional per-tab files as the split makes sense
├── lib/
│   ├── auth.js                 # checkAuth, basic auth wiring
│   ├── paths.js                # all *_DIR constants in one place
│   ├── static.js               # serve files from public/ with correct MIME types
│   ├── router.js               # tiny route matcher (POST /api/foo, GET /images/:id)
│   ├── data-loader.js          # buildDashboardData() + a 2s in-memory cache
│   ├── run-agent.js            # /run-agent SSE streaming
│   └── responses.js            # respondJson, respondError, respondHtml helpers
├── render/                     # server-side HTML fragment builders, pure functions
│   ├── kpis.js
│   ├── kanban.js
│   ├── rankings.js
│   ├── posts.js
│   ├── briefs.js
│   ├── creatives.js
│   ├── ads.js
│   ├── seo-panels.js
│   ├── cro.js
│   └── content-gap.js
└── routes/                     # one file per concern
    ├── data.js                 # GET / (the dashboard page), GET /api/data
    ├── agents.js               # POST /run-agent, /apply/*, /brief/*
    ├── uploads.js              # all /upload/* + multer setup
    ├── ahrefs.js               # /api/ahrefs-overview, ahrefs uploads, /api/reject-keyword
    ├── chat.js                 # /api/chat, /api/chat/action-item, /ads/.../chat
    ├── ads.js                  # /apply-ads, /api/campaigns, /ads/.../suggestion/*
    ├── creatives.js            # the ~15 /api/creatives/* routes
    ├── google.js               # /api/google/auth, /callback, /status
    ├── meta.js                 # /api/meta-ads-insights
    └── misc.js                 # /screenshot, /images/*, /dismiss-alert
```

### Wiring

- `index.js` creates the HTTP server, walks an ordered list of route modules per request, and falls through to the static-file handler for `public/`.
- Each route module exports an array of `{ method, pattern, handler }`. Patterns support exact match and `:param`-style placeholders via `lib/router.js`.
- Handlers receive `(req, res, ctx)` where `ctx` is a single object carrying shared dependencies: `paths`, `anthropic` client, `dataLoader`, `runAgent`, etc. This avoids module-level globals and keeps each handler easy to reason about in isolation.
- All HTML, CSS, and browser JS are static files served from `public/`. Node never interpolates them, so the `\n` vs `\\n` rule from CLAUDE.md becomes obsolete and the dashboard section of that file can be deleted.

### Server-side render helpers

The existing `renderKanban`, `buildSeoKpis`, `renderRankings`, etc. move to `render/*.js` modules unchanged. The only edits are: add `export`, replace `const config = ...` and other top-level globals with parameters passed in by the route handler, and update import paths. No logic changes.

### Efficiency wins (taken during the refactor, not as a follow-up)

- **Stream static files** instead of `readFileSync` per request — `public/index.html`, `dashboard.css`, and the JS files are served on every page load.
- **Cache `buildDashboardData()`** behind a 2-second in-memory TTL so rapid dashboard refreshes don't re-walk the entire `data/` tree. Cache key is the request path; the TTL is short enough that nothing feels stale.
- **Centralize JSON responses** in `lib/responses.js` (`respondJson`, `respondError`, `respondHtml`). The current code has dozens of inline `res.writeHead(200, {...}); res.end(JSON.stringify(...))` calls — unify them and the bug surface shrinks.
- **Replace ad-hoc URL matching** (`req.url.startsWith('/foo/')`) with the small `matchRoute` helper in `lib/router.js`. Routes become declarative rather than imperative.

## Migration plan

Five phases. Each phase produces a working dashboard, is verified locally and on the server, and is deployed before the next phase begins. **Hard checkpoint after Phase 1** to decide whether the remaining phases are still worth doing.

### Phase 1 — Extract `const HTML` to `public/`

**The single biggest win and the highest-risk phase.** Carving up the template literal exposes any inline `${...}` server interpolations that need to move out.

Steps:

1. Catalog every `${...}` interpolation inside `const HTML`. Three categories will emerge:
   - **Static template values** (e.g., site name, dashboard title): inline at server-render time as a tiny one-pass string substitution against `index.html`.
   - **Per-request values** (e.g., initial dashboard data): move into the JSON returned by `/api/data` so the browser fetches them after page load.
   - **Inline event handlers** referencing globals: confirm the global is set up by `app.js` before the handler fires.
2. Split the `<style>` block into `public/dashboard.css`. Verify visually by loading the dashboard.
3. Split the inline `<script>` into per-tab files under `public/js/`. Convert any `\\n` / `\\s` escapes back to their natural `\n` / `\s` form — that's the whole point.
4. Add `lib/static.js` to serve files from `public/` with correct MIME types and cache headers. Stream files instead of reading them into memory.
5. Replace the `const HTML` block in `index.js` with a static-file route. Delete the const.
6. Local smoke test: load the dashboard, click every tab (Optimize, Kanban, Rankings, Posts, CRO, Ads, Creatives, Chat), trigger every button that doesn't make destructive changes.
7. Commit, deploy to server, verify.
8. Update CLAUDE.md to remove the now-obsolete template-literal escape rules. Replace with a one-line note that browser JS lives in `agents/dashboard/public/js/`.

**Checkpoint:** After Phase 1 lands and you've used the dashboard for a day or two, decide whether Phases 2–5 are still worth doing or whether the remaining file feels manageable.

### Phase 2 — Extract route handlers

For each `if (req.method === 'POST' && req.url === ...)` block in the `createServer` callback, move the handler body into a function in the appropriate `routes/*.js` file. Create `lib/router.js` with the matcher. Replace the `createServer` callback with a 10-line dispatch loop. Delete the inline blocks.

Verification: every route still responds identically.

### Phase 3 — Extract render functions

Move `renderKanban`, `buildSeoKpis`, etc. into `render/*.js` modules. Pure code-move. Update imports in `index.js` and route handlers. No logic change.

Verification: dashboard renders identically.

### Phase 4 — Extract supporting code

Move `checkAuth`, paths constants, `buildDashboardData`, `/run-agent` SSE logic, and JSON-response helpers into `lib/*.js`. Update imports.

Verification: nothing changes externally.

### Phase 5 — Final cleanup

`index.js` becomes a thin bootstrap. Final sweep for dead code, unused imports, and any straggling globals. Final smoke test, deploy, verify.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Inline `${...}` interpolations in `const HTML` reference server data the browser doesn't have | Catalog them up front in step 1; route through `/api/data` or inline-substitute in `lib/static.js`. Show the catalog to the user before committing Phase 1. |
| Some inline event handler depends on a global function defined later in the same `<script>` block | Splitting JS files by tab will surface this. Either keep both functions in the same file or load order in `index.html` reflects the dependency. |
| A route handler depends on a closed-over variable from `index.js` (e.g., the in-flight `adsInFlight` Set) | Move shared mutable state into the `ctx` object passed to handlers, so it's still a single instance shared across modules. |
| Static file MIME types break (e.g., serving JS as `text/plain`) | `lib/static.js` has a small extension → MIME map; verify in browser devtools after Phase 1. |
| Server cache hides a bug (data appears stale) | Cache TTL is 2s. Add a `?nocache=1` query param that bypasses it for debugging. |

## Success criteria

- Dashboard loads and behaves identically to the pre-refactor version on every tab.
- `agents/dashboard/index.js` shrinks from 7,708 lines to ~150 lines after all five phases (or to ~5,500 lines after Phase 1 alone).
- The CLAUDE.md "Template Literal Escape Sequences" section can be deleted.
- Adding a new card (the upcoming SEO engine UI work) requires touching at most 3 small files instead of editing the monolith.
- Each phase deploys cleanly to the server and the morning digest still arrives the next day with no errors.
