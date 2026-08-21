# Dashboard Route Hardening

**Date:** 2026-08-21
**Branch:** `fix/dashboard-route-hardening`
**Status:** approved design, pending implementation plan

## Problem

One malformed request to `seo-dashboard` can terminate the PM2 process, taking every
tab down with it. The dashboard runs on a public ngrok URL and two of its routes
(`/api/rum`, `/api/giveaway/*`) are deliberately unauthenticated, so the trigger does
not require credentials.

The mechanism, established in `agents/dashboard/lib/responses.js` and proved by
`tests/dashboard/json-body-hardening.test.js`: `lib/router.js`'s `dispatch()` calls
`route.handler(req, res, ctx)` **without awaiting it**, and nothing in the process
registers `unhandledRejection` or `uncaughtException`. Node's default since v15 is to
terminate on an unhandled rejection. So any throw a handler does not catch itself is
fatal.

`readJsonBody` fixed this centrally for the five modules that use it. Twelve modules
still read bodies by hand.

## The three crash classes

The choice was framed as "migrate everything onto `readJsonBody`" **or** "guard in
place". It is neither: there are three distinct classes and each fix covers a
different one. Any single-layer answer leaves a live crash.

### Class A — `null` body, property access outside the `try`

`JSON.parse('null')` returns `null`, not `undefined`. Handlers wrap the `JSON.parse`
in a `try`, then read fields **after** the `catch` block closes, so `payload.message`
throws a TypeError nothing is catching.

Confirmed live:

| Site | Access |
|---|---|
| `chat.js:20` | `const { tab, messages } = payload` |
| `chat.js:86` | `const { tab, title, description, type } = payload` |
| `ads.js:67` | `payload.message` |
| `ads.js:300` | `payload.status` |
| `dataforseo.js:62` | `const { keyword, matchType, reason } = payload` |
| `creatives.js:127` | `payload.referenceImage` |
| `creatives.js:179` | `data.id` |
| `creatives.js:590` | `const { sessionId, refinement, model } = payload` |
| `creatives.js:736` | destructure of `payload` |

`curl -X POST <dashboard>/api/creatives/refine -d 'null'` kills the process.

`readJsonBody` fixes exactly this class, and only this class.

### Class B — anything after the JSON step that throws

Unrelated to bodies, and more numerous. `JSON.parse(readFileSync(...))` against a
corrupt or truncated data file, outside any `try`:

| Site | Note |
|---|---|
| `ads.js:73`, `ads.js:297` | inside an async `end` callback |
| `agents.js` `/brief/` | inside an `end` callback |
| `campaigns.js` dismiss + alerts/resolve | **synchronous handler, no `try` at all** — an `uncaughtException`, not a rejection |

`readJsonBody` does nothing for any of these. A `dispatch()` guard catches the
`campaigns.js` pair; it cannot catch the ones inside `end` callbacks (see Class C).

### Class C — the structural one

A throw inside `req.on('end', cb)` runs on a later tick, on the emitter's stack,
**outside the handler's promise chain**. No guard at the `dispatch()` level can ever
catch it, however it is written.

This is the actual argument for migration, and it is not about `null` bodies at all:
`await readJsonBody(req)` pulls the body-dependent code out of the `end` callback and
back into the handler's promise, which is the only place a central guard can see it.

Migration is therefore not an alternative to guarding — it is what makes guarding
effective for these nine modules.

## Design — three layers

Ordered so that each lands on a floor that already cannot crash.

### Layer 1 — guard `dispatch()`

`agents/dashboard/lib/router.js`. Wrap the handler call in **both** a `try/catch`
(synchronous throws, e.g. the `campaigns.js` pair) and a `.catch()` on the returned
value coerced through `Promise.resolve` (async rejections):

- On either, answer a fixed `500` with a generic message. **Never echo the
  exception** — same rule as `readJsonBody`'s fixed 400; the dashboard is
  publicly reachable and exception text leaks paths.
- Guard against a double write: if `res.headersSent`, log and destroy rather than
  calling `writeHead` again.
- Log to stderr with method and URL so the digest has something to point at.

One file. Covers Class B outside `end` callbacks, and every route added later.

### Layer 2 — one body reader

`readJsonBody` grows a cap and becomes the single reader for all twelve modules.

```js
readJsonBody(req, { maxBytes = DEFAULT_MAX_BYTES } = {})
```

- On overflow, reject with `err.code = 'BODY_TOO_LARGE'` and call `req.destroy()`.
  Both are required to preserve existing behaviour: `giveaway.js:312` branches on
  that exact `code` to answer 413 rather than 400, and `rum.js` destroys the socket
  so an attacker cannot keep streaming into a request already refused.
- The existing `null`/scalar reject and the array pass-through are unchanged. Their
  reasoning is in the `responses.js` docstring and stays there.

**The cap is per-call, not one constant.** The three modules that already have caps
keep their current values exactly — this migration must not loosen a limit on an
unauthenticated route:

| Module | Cap | Why |
|---|---|---|
| `rum.js` | 8 KB | unauthenticated; a beacon is 400–900 bytes |
| `giveaway.js` entry routes | 4 KB | unauthenticated; enum-validated fields |
| `giveaway.js` upload | `MAX_UPLOAD_BASE64 + 2048` | base64 image payload |
| everything else | `DEFAULT_MAX_BYTES` | authenticated; set generously, see below |

`DEFAULT_MAX_BYTES` is 1 MB. Every authenticated JSON body is small — `chat` caps its
message at 2000 chars, and `creatives` passes filenames and session IDs, never image
bytes. 1 MB is far above any real request and far below a memory problem.

The one route that does receive image bytes, `POST /api/creatives/generate`, does not
read a JSON body at all: it is **multipart**, handled by `multer` (configured in
`index.js:72` with its own 20 MB `fileSize` limit) and read as `req.body` / `req.files`.
It has no `req.on('data')` and is not part of this migration. Do not try to route it
through `readJsonBody` — the two body paths are separate by design, and the 1 MB
default never applies to it.

### Layer 3 — process-level net

`agents/dashboard/index.js`. Register `unhandledRejection` and `uncaughtException`:
log, `notify({ immediate: true, ... })`, and **keep serving**.

This is a last resort, not the fix — if layers 1 and 2 are right it never fires, and
its firing is a bug report. The tradeoff is deliberate: surviving leaves that one
request hanging until the client times out, which is the right trade for a shared
dashboard on a public URL. Exiting for a PM2 restart would turn one bad request into
the outage this whole change exists to remove.

`immediate: true` is correct here and is the documented exception to deferred
notification — a crash-class event must not wait for the 5 AM digest.

## Module inventory

Twelve modules call `req.on('data')`. They are not in the same state:

**Already promise-returning (3)** — `campaigns.js` (`readJson`, uncapped, no
non-object reject), `giveaway.js` (`readCappedBody`), `rum.js` (`readBody`).
Migration here is deduplication, not a bug fix. `campaigns.js`'s Class B defect is
in its *other*, bodyless handlers and is covered by Layer 1.

**Callback-style, must migrate (9)** — `agents.js`, `ads.js`, `cannibalization.js`,
`chat.js`, `creatives.js` (7 sites), `dataforseo.js`, `indexing.js`,
`posts-kill.js`, `rejected-images.js`.

Of these, `cannibalization.js`, `indexing.js`, `posts-kill.js` and
`rejected-images.js` access fields **inside** their `try` and so have no Class A
defect today. They still migrate, for Class C: their `end` callbacks are invisible to
the Layer 1 guard, and the next field added outside the `try` reintroduces the crash
silently.

Twenty body-read sites in total.

## Testing

Extend `tests/dashboard/json-body-hardening.test.js` rather than adding a file — it
already encodes the technique that found the bug: dispatch through the **real**
`dispatch()` over the **real** exported route tables, do not await, drain the
macrotask queue, and assert an `unhandledRejection` listener saw nothing. Awaiting the
handler would prove nothing, because the crash is precisely the promise nobody awaits.

Add:

1. **Class A, widened** — the four hostile bodies (`null`, `5`, `"str"`, `[]`)
   against every POST/PATCH surface in all twelve route tables, not just the six
   currently covered.
2. **Class B** — a handler whose data file is corrupt on disk answers 500 and does
   not reject. Covers the `campaigns.js` synchronous path specifically.
3. **Layer 1 directly** — a route table with a handler that throws synchronously, and
   one that rejects asynchronously. Both must produce a 500 and no unhandled
   rejection. This is the guard's own unit test and must not depend on any route
   module.
4. **Caps** — a body one byte over each module's cap rejects with `BODY_TOO_LARGE`,
   and `rum`/`giveaway` still answer the status codes they answer today.

Run with Node 22 (`nvm use`). **Check the cancelled count in `node --test` output,
not just the fail count** — a stubbed-fetch test that never settles reports
`cancelled` alongside `# fail 0` and reads like a pass.

## Rollout

**One PR, one deploy.** The problem being fixed is dashboard uptime, and three
separate deploys means three restarts of the process whose availability is the whole
point. The layers are still built and committed in order inside the branch, so the
history stays bisectable and each commit lands on a floor that already cannot crash:

1. Layer 1 + its own guard tests.
2. Layer 2 — `readJsonBody` gains the cap, then the nine callback-style modules
   migrate, then the three promise-style ones. Body-read behaviour per route is
   preserved, including status codes.
3. Layer 3 + a test that the handlers are registered.

The ordering is not bookkeeping. Layer 2 moves code out of `end` callbacks and into
handler promises — code that is only safe there **because** Layer 1 is already
catching that promise. Committing Layer 2 first would briefly convert uncatchable
throws into uncaught ones.

Post-deploy verification, against the live dashboard:

- `pm2 status` shows `seo-dashboard` `online`.
- `curl -X POST <dashboard>/api/rum -d 'null'` returns 400 and the process stays up.
- A body one byte over the `rum` cap returns the same status it returns today.
- Load one authenticated tab and confirm a normal request still round-trips.

## Non-goals

- No change to what any route *does* with a well-formed body.
- No change to authentication, rate limiting, or CORS.
- No rewrite of `creatives.js` (1112 lines) beyond its seven body-read sites. It is
  too large and that is worth fixing, but not here.
- No change to the multipart path or to `multer`'s limits.
- No migration to a framework. The router is twenty lines and is not the problem.
