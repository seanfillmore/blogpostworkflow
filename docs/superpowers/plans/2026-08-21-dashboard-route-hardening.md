# Dashboard Route Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it impossible for a single malformed HTTP request to terminate the `seo-dashboard` process.

**Architecture:** Three layers, built in this order. (1) `dispatch()` catches both synchronous throws and async rejections from any handler and answers a fixed 500. (2) One body reader, `readJsonBody`, gains a per-call byte cap and replaces twenty hand-rolled readers across twelve modules — which is what moves body-dependent code out of `req.on('end')` callbacks, where no dispatch-level guard could ever reach it, and into handler promises, where Layer 1 can. (3) Process-level `unhandledRejection` / `uncaughtException` handlers log, notify immediately, and keep serving.

**Tech Stack:** Node 22 LTS, plain ESM, `node:http`, `node --test`. No framework, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-21-dashboard-route-hardening-design.md` — read it first; it explains the three crash classes and why neither layer alone is sufficient.

## Global Constraints

- **Node 22 LTS.** Run `nvm use` in the repo before any test. Node 25 locally vs 22 on the server has already hidden a dead test for months.
- **When reading `node --test` output, check the `cancelled` count, not just `fail`.** A test that never settles prints `cancelled` alongside `# fail 0` and reads like a pass.
- **Work only in the worktree** `/Users/seanfillmore/Code/Claude/.claude/worktrees/route-hardening`, branch `fix/dashboard-route-hardening`. Never the main checkout. **Re-check `git branch --show-current` before every commit** — the shell's cwd has already reverted to the main checkout once during this work.
- **One PR at the end.** Commit per task; do not open a PR until Task 10.
- **Never echo an exception message to an HTTP client.** The dashboard is on a public ngrok URL. Fixed, generic strings only in new error paths.
- **Preserve existing status codes and response bodies exactly.** This change alters *failure containment*, never route behaviour. If a route answers `400 {"error":"Invalid JSON"}` today, it answers exactly that after migration — do not "improve" wording, do not upgrade a 400 to a 422, do not add validation that was not there.
- **Do not add a per-route `try/catch` that was not already there.** Post-body failures are Layer 1's job now. Adding local catches re-buries the crash class this plan exists to surface.
- **`data/` snapshots and reports are server-authoritative.** Nothing in this plan reads or writes them; if a test needs a data file, it creates it under a temp dir and removes it.

---

## File Structure

**Modified:**

- `agents/dashboard/lib/router.js` — gains the handler guard. Stays the only routing file; it is 20 lines and the size is not the problem.
- `agents/dashboard/lib/responses.js` — `readJsonBody` gains `{ maxBytes }` and becomes the single body reader for the whole dashboard. Exports `DEFAULT_MAX_BYTES`.
- `agents/dashboard/index.js` — registers the two process-level handlers.
- Twelve route modules under `agents/dashboard/routes/` — see task list.

**Test files:**

- `tests/dashboard/router-guard.test.js` — **new.** Unit tests for Layer 1 in isolation, with a synthetic route table. Must not import any real route module, so a route change can never mask a guard regression.
- `tests/dashboard/json-body-hardening.test.js` — **extended.** Already contains the technique and the reasoning; each migration task adds its module to the tables here.

**Not touched:**

- `POST /api/creatives/generate` — multipart via `multer` (`index.js:72`, 20 MB `fileSize` limit), reads `req.body` / `req.files`, has no `req.on('data')`. It is not part of this migration. Do not route it through `readJsonBody`.

---

### Task 1: Layer 1 — guard `dispatch()`

**Files:**
- Modify: `agents/dashboard/lib/router.js`
- Test: `tests/dashboard/router-guard.test.js` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `dispatch(routes, req, res, ctx) => boolean` — unchanged signature and return value. New behaviour: a handler that throws synchronously, or returns a promise that rejects, produces `500 {"ok":false,"error":"internal error"}` and no unhandled rejection.

- [ ] **Step 1: Write the failing test**

Create `tests/dashboard/router-guard.test.js`:

```js
// tests/dashboard/router-guard.test.js
//
// Layer 1 of the route hardening: dispatch() must contain a handler failure
// instead of letting it reach the process.
//
// Deliberately uses a SYNTHETIC route table and imports no real route module.
// If this file imported routes/, a future route fix could silently mask a
// regression in the guard itself — and the guard is the floor everything else
// stands on.

import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { dispatch } from '../../agents/dashboard/lib/router.js';

function makeRes() {
  const res = { statusCode: null, body: null, headersSent: false, writableEnded: false, destroyed: false };
  res.writeHead = (status) => { res.statusCode = status; res.headersSent = true; };
  res.end = (body) => { res.body = body === undefined ? null : body; res.writableEnded = true; };
  res.destroy = () => { res.destroyed = true; };
  return res;
}

const makeReq = (method, url) => ({ method, url, headers: {}, on() { return this; } });

const rejections = [];
const onUnhandled = (reason) => { rejections.push(reason); };
before(() => { process.on('unhandledRejection', onUnhandled); });
after(() => { process.off('unhandledRejection', onUnhandled); });

async function drain() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

test('a handler that throws synchronously produces a 500, not a crash', async () => {
  rejections.length = 0;
  const routes = [{ method: 'POST', match: '/boom', handler() { throw new Error('sync boom'); } }];
  const res = makeRes();

  const matched = dispatch(routes, makeReq('POST', '/boom'), res, {});
  await drain();

  assert.equal(matched, true, 'the route still counts as matched');
  assert.equal(res.statusCode, 500);
  assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'internal error' });
  assert.deepEqual(rejections, []);
});

test('a handler whose promise rejects produces a 500, not an unhandled rejection', async () => {
  rejections.length = 0;
  const routes = [{ method: 'POST', match: '/boom', async handler() { throw new Error('async boom'); } }];
  const res = makeRes();

  dispatch(routes, makeReq('POST', '/boom'), res, {});
  await drain();

  assert.equal(res.statusCode, 500);
  assert.deepEqual(rejections, [], 'nothing reached the process-level handler');
});

test('the 500 body never contains the exception message', async () => {
  rejections.length = 0;
  const secret = '/root/seo-claude/.env token sk-leak-me';
  const routes = [{ method: 'POST', match: '/boom', async handler() { throw new Error(secret); } }];
  const res = makeRes();

  dispatch(routes, makeReq('POST', '/boom'), res, {});
  await drain();

  assert.ok(!String(res.body).includes('sk-leak-me'), 'exception text must not reach the client');
  assert.ok(!String(res.body).includes('/root/'), 'paths must not reach the client');
});

test('a handler that already answered is not written to twice', async () => {
  rejections.length = 0;
  const routes = [{
    method: 'POST',
    match: '/late',
    async handler(req, res) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      throw new Error('threw after responding');
    },
  }];
  const res = makeRes();

  dispatch(routes, makeReq('POST', '/late'), res, {});
  await drain();

  assert.equal(res.statusCode, 200, 'the original response stands');
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(res.destroyed, true, 'the connection is torn down instead of double-written');
  assert.deepEqual(rejections, []);
});

test('a handler that succeeds is completely unaffected', async () => {
  rejections.length = 0;
  const routes = [{
    method: 'GET',
    match: '/fine',
    handler(req, res) { res.writeHead(200); res.end('ok'); },
  }];
  const res = makeRes();

  assert.equal(dispatch(routes, makeReq('GET', '/fine'), res, {}), true);
  await drain();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body, 'ok');
});

test('a non-matching request still returns false and touches nothing', async () => {
  const routes = [{ method: 'POST', match: '/boom', handler() { throw new Error('never called'); } }];
  const res = makeRes();

  assert.equal(dispatch(routes, makeReq('GET', '/other'), res, {}), false);
  assert.equal(res.statusCode, null);
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
cd /Users/seanfillmore/Code/Claude/.claude/worktrees/route-hardening
nvm use
node --test tests/dashboard/router-guard.test.js
```

Expected: the sync-throw test fails with `sync boom` escaping `dispatch`; the async test records an entry in `rejections`. Confirm `# cancelled 0`.

- [ ] **Step 3: Implement the guard**

Replace the body of `agents/dashboard/lib/router.js` with:

```js
// agents/dashboard/lib/router.js
/**
 * Tiny router. Takes an array of { method, match, handler } entries.
 * - method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
 * - match: string (exact URL match) OR function (url) => boolean
 * - handler: (req, res, ctx) => Promise<void> | void
 *
 * dispatch(routes, req, res, ctx) walks the route list and calls the first matching
 * handler. Returns true if a route matched, false otherwise.
 *
 * WHY THE GUARD BELOW EXISTS. dispatch() calls handlers WITHOUT awaiting them, and
 * `seo-dashboard` is a single shared PM2 process on a public URL. Before this guard,
 * any throw a handler did not catch itself was fatal to the whole process: a sync
 * throw propagated into http.createServer's listener as an uncaughtException, and a
 * rejected handler promise became an unhandledRejection, which Node has terminated on
 * by default since v15. One malformed request took down every tab.
 *
 * BOTH arms are required and they catch different things. The try/catch cannot see a
 * rejection (the handler has already returned by then); the .then() rejection arm
 * cannot see a synchronous throw (there is no promise yet). `campaigns.js`'s bodyless
 * handlers are entirely synchronous and are caught only by the first; every migrated
 * async handler is caught only by the second.
 *
 * WHAT THIS GUARD STILL CANNOT REACH: a throw inside a `req.on('end', cb)` callback.
 * That runs on a later tick on the emitter's stack, outside the handler's promise
 * chain, so no amount of wrapping here will see it. That is why every route module
 * reads its body through readJsonBody and awaits it — the migration is what brings
 * that code inside the promise this guard is watching. Do not reintroduce a route that
 * does its work inside an 'end' callback; it would be silently unprotected.
 */
export function dispatch(routes, req, res, ctx) {
  for (const route of routes) {
    if (route.method !== req.method) continue;
    const matched = typeof route.match === 'string'
      ? req.url === route.match
      : route.match(req.url);
    if (!matched) continue;

    try {
      const result = route.handler(req, res, ctx);
      // Thenable check rather than Promise.resolve(): sync handlers stay fully
      // synchronous, which keeps the existing non-async routes on their current tick.
      if (result && typeof result.then === 'function') {
        result.then(undefined, (err) => failRoute(req, res, err));
      }
    } catch (err) {
      failRoute(req, res, err);
    }
    return true;
  }
  return false;
}

/**
 * Answer a fixed 500. NEVER echoes the exception — this process is reachable from the
 * public internet and exception text carries absolute paths and occasionally token
 * fragments. The detail goes to stderr, which PM2 captures.
 */
function failRoute(req, res, err) {
  console.error(`[router] unhandled error in ${req.method} ${req.url}:`, err?.stack || err);

  // The handler may have already answered and then failed partway through streaming
  // (several routes write SSE). Writing a second set of headers would throw from
  // inside the error path itself, so tear the socket down instead.
  if (res.headersSent || res.writableEnded) {
    try { res.destroy(); } catch { /* connection already gone */ }
    return;
  }

  try {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'internal error' }));
  } catch { /* client vanished mid-write; nothing left to do */ }
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
node --test tests/dashboard/router-guard.test.js
```

Expected: all six pass, `# fail 0`, `# cancelled 0`.

- [ ] **Step 5: Run the existing dashboard suite for regressions**

```bash
node --test tests/dashboard/
```

Expected: no new failures. Note the pre-existing pass/fail counts — you will compare against them in Task 10.

- [ ] **Step 6: Commit**

```bash
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/route-hardening add agents/dashboard/lib/router.js tests/dashboard/router-guard.test.js
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/route-hardening commit -m "fix(dashboard): dispatch() contains handler failures instead of killing the process

Both arms are load-bearing: try/catch cannot see a rejection, and the
rejection arm cannot see a sync throw. campaigns.js's bodyless handlers need
the first; every async handler needs the second."
```

---

### Task 2: Layer 2a — `readJsonBody` gains a per-call byte cap

**Files:**
- Modify: `agents/dashboard/lib/responses.js`
- Test: `tests/dashboard/json-body-hardening.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `readJsonBody(req, { maxBytes = DEFAULT_MAX_BYTES } = {}) => Promise<object|Array>` — resolves `{}` for an absent body, rejects for `null`/scalar JSON, rejects for unparseable JSON, and rejects with `err.code === 'BODY_TOO_LARGE'` once `maxBytes` is exceeded (also calling `req.destroy()`).
  - `DEFAULT_MAX_BYTES` — `1024 * 1024`.

- [ ] **Step 1: Write the failing test**

Append to `tests/dashboard/json-body-hardening.test.js`:

```js
// ---------------------------------------------------------------------------
// Byte cap. readJsonBody is becoming the single body reader for all twelve route
// modules, two of which (rum, giveaway) are UNAUTHENTICATED and already cap their
// bodies. Unification must not loosen a limit on a public route, so the cap is a
// per-call option and each caller passes its own existing value.
// ---------------------------------------------------------------------------

import { DEFAULT_MAX_BYTES } from '../../agents/dashboard/lib/responses.js';

/** A request that emits `body` in `chunkCount` roughly equal Buffer chunks. */
function makeChunkedReq(body, chunkCount = 1) {
  const buf = Buffer.from(body, 'utf8');
  const per = Math.ceil(buf.length / chunkCount) || 1;
  const chunks = [];
  for (let i = 0; i < buf.length; i += per) chunks.push(buf.subarray(i, i + per));
  return {
    method: 'POST',
    url: '/test',
    headers: {},
    destroyed: false,
    destroy() { this.destroyed = true; },
    on(event, cb) {
      if (event === 'data') for (const c of chunks) cb(c);
      if (event === 'end') cb();
      return this;
    },
  };
}

test('DEFAULT_MAX_BYTES is 1 MB', () => {
  assert.equal(DEFAULT_MAX_BYTES, 1024 * 1024);
});

test('a body at the cap is accepted', async () => {
  const filler = 'x'.repeat(100);
  const json = JSON.stringify({ filler });
  const parsed = await readJsonBody(makeChunkedReq(json), { maxBytes: Buffer.byteLength(json) });
  assert.equal(parsed.filler, filler);
});

test('a body one byte over the cap rejects with BODY_TOO_LARGE and destroys the socket', async () => {
  const json = JSON.stringify({ filler: 'x'.repeat(100) });
  const req = makeChunkedReq(json);
  await assert.rejects(
    () => readJsonBody(req, { maxBytes: Buffer.byteLength(json) - 1 }),
    (err) => err.code === 'BODY_TOO_LARGE',
  );
  assert.equal(req.destroyed, true, 'the socket is destroyed so the client cannot keep streaming');
});

test('overflow rejects exactly once even when many chunks follow', async () => {
  // The reject arrives on an early chunk; every later chunk must be ignored. A second
  // reject would be swallowed by the promise, but a second req.destroy() and the
  // continued buffering would not be — that is the leak this guards.
  const json = JSON.stringify({ filler: 'x'.repeat(5000) });
  const req = makeChunkedReq(json, 50);
  await assert.rejects(() => readJsonBody(req, { maxBytes: 100 }), (err) => err.code === 'BODY_TOO_LARGE');
  assert.equal(req.destroyed, true);
});

test('a multibyte character split across two chunks is not corrupted', async () => {
  // The old hand-rolled readers did `body += chunk`, which calls toString() per chunk
  // and mangles a UTF-8 sequence straddling a chunk boundary. Buffer.concat first is
  // the fix, and this is the test that would have caught it.
  const json = JSON.stringify({ note: 'café — naïve' });
  const parsed = await readJsonBody(makeChunkedReq(json, Buffer.byteLength(json)));
  assert.equal(parsed.note, 'café — naïve');
});

test('the existing contract is unchanged: empty resolves {}, null rejects, array passes', async () => {
  assert.deepEqual(await readJsonBody(makeChunkedReq('')), {});
  await assert.rejects(() => readJsonBody(makeChunkedReq('null')));
  await assert.rejects(() => readJsonBody(makeChunkedReq('5')));
  await assert.rejects(() => readJsonBody(makeChunkedReq('"str"')));
  assert.deepEqual(await readJsonBody(makeChunkedReq('[]')), []);
  await assert.rejects(() => readJsonBody(makeChunkedReq('{not json')));
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
node --test tests/dashboard/json-body-hardening.test.js
```

Expected: `DEFAULT_MAX_BYTES` is undefined, the cap tests fail, and the multibyte test fails. The last test (existing contract) already passes.

- [ ] **Step 3: Implement the cap**

In `agents/dashboard/lib/responses.js`, add the export above `readJsonBody` and replace the function. Leave the existing docstring in place and append the new paragraph — its reject-vs-coerce reasoning is still the reasoning:

```js
/** 1 MB. Generous for every authenticated JSON body (chat caps its message at 2000
 *  chars; creatives passes filenames and session ids, never image bytes) and far below
 *  a memory problem. The one route that receives image bytes, POST /api/creatives/generate,
 *  is multipart via multer and never reaches this function. */
export const DEFAULT_MAX_BYTES = 1024 * 1024;
```

Append to the existing `readJsonBody` docstring:

```
 * THE CAP. This is the single body reader for all twelve route modules, and two of them
 * — /api/rum and /api/giveaway/* — are deliberately UNAUTHENTICATED. They capped their
 * bodies before this unification, so the cap is a per-call option and those callers pass
 * their own existing values (8 KB, 4 KB, and MAX_UPLOAD_BASE64 + 2048 respectively).
 * A single shared constant would have silently raised the limit on the two routes that
 * most need one. `err.code = 'BODY_TOO_LARGE'` is load-bearing: giveaway.js branches on
 * that exact string to answer 413 rather than 400. So is `req.destroy()`: without it a
 * client can keep streaming into a request that has already been refused.
 *
 * Chunks are buffered and concatenated as Buffers, never accumulated with `body += chunk`.
 * The latter calls toString() per chunk and corrupts any UTF-8 sequence that straddles a
 * chunk boundary — which every hand-rolled reader this replaces was doing.
 */
export function readJsonBody(req, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflowed = false;
    const chunks = [];

    req.on('data', (chunk) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > maxBytes) {
        overflowed = true;
        const err = new Error('request body too large');
        err.code = 'BODY_TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (overflowed) return;
      const body = Buffer.concat(chunks).toString('utf8');
      if (!body) return resolve({});
      let parsed;
      try { parsed = JSON.parse(body); } catch (err) { return reject(err); }
      // `null` and every scalar. Fixed message — it is handed back as a fixed 400 by the
      // callers, and never carries any part of the request.
      if (parsed === null || typeof parsed !== 'object') {
        return reject(new Error('request body must be a JSON object'));
      }
      resolve(parsed);
    });

    req.on('error', reject);
  });
}
```

- [ ] **Step 4: Run the test and verify it passes**

```bash
node --test tests/dashboard/json-body-hardening.test.js
```

Expected: `# fail 0`, `# cancelled 0`. The five pre-existing hostile-body tests must still pass — the five modules already using `readJsonBody` are unchanged by the cap.

- [ ] **Step 5: Commit**

```bash
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/route-hardening add agents/dashboard/lib/responses.js tests/dashboard/json-body-hardening.test.js
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/route-hardening commit -m "feat(dashboard): readJsonBody takes a per-call byte cap

Per-call, not one constant: rum and giveaway are the unauthenticated routes
and already capped their bodies. A shared default would have raised the limit
on exactly the two routes that need one. Also switches to Buffer.concat, which
fixes multibyte corruption at chunk boundaries."
```

---

### Task 3: Migrate the simple Class-A modules — `chat.js`, `dataforseo.js`

**Files:**
- Modify: `agents/dashboard/routes/chat.js:10-71`, `agents/dashboard/routes/chat.js:76-155`, `agents/dashboard/routes/dataforseo.js:52-83`
- Test: `tests/dashboard/json-body-hardening.test.js`

**Interfaces:**
- Consumes: `readJsonBody` from Task 2; the `dispatch()` guard from Task 1.
- Produces: nothing new. Route paths, status codes and response bodies are unchanged.

**The migration recipe** (applies to every site in Tasks 3–7):

1. `handler(req, res, ctx)` becomes `async handler(req, res, ctx)`.
2. Everything inside `req.on('end', ...)` moves up into the handler body, one indent level out.
3. `let payload; try { payload = JSON.parse(body); } catch { ...400... return; }` becomes `let payload; try { payload = await readJsonBody(req); } catch { ...the identical 400... return; }`.
4. Delete the `let body = '';` and `req.on('data', ...)` lines.
5. Change nothing else. Same statuses, same messages, same order of checks.

- [ ] **Step 1: Add both modules to the hostile-body sweep**

In `tests/dashboard/json-body-hardening.test.js`, add the imports and extend the two tables:

```js
import chatRoutes from '../../agents/dashboard/routes/chat.js';
import dataforseoRoutes from '../../agents/dashboard/routes/dataforseo.js';
```

Add `...chatRoutes, ...dataforseoRoutes,` to the `ROUTES` array, and these entries to `TARGETS`:

```js
  ['POST', '/api/chat'],
  ['POST', '/api/chat/action-item'],
  ['POST', '/api/reject-keyword'],
```

- [ ] **Step 2: Run and verify it fails**

```bash
node --test tests/dashboard/json-body-hardening.test.js
```

Expected: FAIL. `-d 'null'` against `/api/chat` reaches `const { tab, messages } = payload` (`chat.js:20`) and destructuring `null` throws a TypeError inside the `end` callback. The `rejections` array is non-empty.

- [ ] **Step 3: Migrate `chat.js`**

Add the import at the top:

```js
import { readJsonBody } from '../lib/responses.js';
```

`POST /api/chat` — replace lines 10–19 (the handler signature through the `JSON.parse` catch) with:

```js
    async handler(req, res, ctx) {
      let payload;
      try { payload = await readJsonBody(req); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
```

Then un-indent the remainder of the old `end` callback (old lines 20–69) by two spaces, and delete the trailing `});` that closed it (old line 70).

`POST /api/chat/action-item` — the same transformation on lines 76–85, keeping its different error shape verbatim:

```js
    async handler(req, res, ctx) {
      let payload;
      try { payload = await readJsonBody(req); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        return;
      }
```

Un-indent old lines 86–153 and drop the closing `});`.

- [ ] **Step 4: Migrate `dataforseo.js`**

Add the import:

```js
import { readJsonBody } from '../lib/responses.js';
```

`POST /api/reject-keyword` — replace lines 52–61 with:

```js
    async handler(req, res, ctx) {
      let payload;
      try { payload = await readJsonBody(req); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        return;
      }
```

Un-indent old lines 62–81, drop the closing `});`. Leave the inner `try/catch` around the file write (old lines 68–81) exactly as it is — it produces a 500 with `err.message`, which is pre-existing behaviour on an authenticated route and is out of scope here.

- [ ] **Step 5: Run and verify it passes**

```bash
node --test tests/dashboard/json-body-hardening.test.js
```

Expected: `# fail 0`, `# cancelled 0`.

- [ ] **Step 6: Commit**

```bash
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/route-hardening add agents/dashboard/routes/chat.js agents/dashboard/routes/dataforseo.js tests/dashboard/json-body-hardening.test.js
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/route-hardening commit -m "fix(dashboard): chat and dataforseo read bodies through readJsonBody

Both destructured the parsed payload outside the JSON try, so -d 'null' threw
a TypeError inside an end callback and killed the process."
```

---

### Task 4: Migrate `ads.js` — and keep the in-flight set from leaking

**Files:**
- Modify: `agents/dashboard/routes/ads.js:51-...` (suggestion chat), `agents/dashboard/routes/ads.js:285-312` (suggestion update)
- Test: `tests/dashboard/json-body-hardening.test.js`

**Interfaces:**
- Consumes: `readJsonBody`, the `dispatch()` guard.
- Produces: nothing new.

**THE TRAP IN THIS TASK.** `POST /ads/:date/suggestion/:id/chat` adds `inFlightKey` to `ctx.adsInFlight` at line 59, **before** reading the body, and every early return calls `cleanup()` to remove it. Once the body read can reject, a rejection that escapes to the Layer 1 guard answers 500 and **never removes the key** — that suggestion then answers `429 Request already in progress` forever, until the process restarts. The 429 has no expiry. Wrap the body read so `cleanup()` runs on the failure path too.

- [ ] **Step 1: Add `ads.js` to the sweep, plus a dedicated in-flight leak test**

Add the import and `...adsRoutes` to `ROUTES`:

```js
import adsRoutes from '../../agents/dashboard/routes/ads.js';
```

Add to `TARGETS`:

```js
  ['POST', '/ads/2026-08-21/suggestion/no-such-id-xyz/chat'],
  ['POST', '/ads/2026-08-21/suggestion/no-such-id-xyz'],
```

The stub `ctx` those dispatches receive needs an `adsInFlight`. Extend the ctx object the sweep passes to `dispatch` so it carries `adsInFlight: new Set()`, and add this test:

```js
test('a rejected body read does not strand the ads in-flight key', async () => {
  // ctx.adsInFlight is added to BEFORE the body is read and removed on every early
  // return. If a body-read rejection escapes instead, the key is never removed and that
  // suggestion answers 429 until the process restarts — a permanent, silent lockout.
  const adsInFlight = new Set();
  const ctx = { adsInFlight, ADS_OPTIMIZER_DIR: '/tmp/no-such-dir-xyz' };
  const res = makeRes();

  dispatch(adsRoutes, makeReq('POST', '/ads/2026-08-21/suggestion/lock-test/chat', 'null'), res, ctx);
  await drain();

  assert.equal(adsInFlight.has('2026-08-21/lock-test'), false, 'the in-flight key was released');
});
```

- [ ] **Step 2: Run and verify it fails**

```bash
node --test tests/dashboard/json-body-hardening.test.js
```

Expected: FAIL on both the hostile-body sweep (`ads.js:67` reads `payload.message` off `null`) and the in-flight leak test.

- [ ] **Step 3: Migrate the suggestion-chat route**

Add the import:

```js
import { readJsonBody } from '../lib/responses.js';
```

Make the handler `async`, delete `let body = '';` and the `req.on('data', ...)` line (old 61–62), and replace the opening of the `end` callback (old 63–66) with:

```js
      const cleanup = () => ctx.adsInFlight.delete(inFlightKey);
      let payload;
      try {
        payload = await readJsonBody(req);
      } catch {
        // cleanup() MUST run here. The in-flight key was added before the body was
        // read, and a rejection escaping to the router guard would leave it set — the
        // suggestion would answer 429 forever, with no expiry to recover it.
        cleanup();
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        return;
      }
```

Un-indent the rest of the old callback body by two spaces and drop its closing `});`.

Then, so that a *post-body* failure cannot strand the key either, put the remainder in a `try/finally`. The handler ends up in this shape — the body read stays **outside** the `try/finally` because its own `catch` already calls `cleanup()`:

```js
    async handler(req, res, ctx) {
      const parts = req.url.split('/'); // ['', 'ads', date, 'suggestion', id, 'chat']
      const date = parts[2], id = parts[4];
      // ... the existing date/id validation and the 429 in-flight check, unchanged ...
      ctx.adsInFlight.add(inFlightKey);

      const cleanup = () => ctx.adsInFlight.delete(inFlightKey);

      let payload;
      try {
        payload = await readJsonBody(req);
      } catch {
        cleanup();
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        return;
      }

      try {
        // ... the entire remaining body of the old end callback, un-indented ...
        // Every `return` inside here now releases the key via the finally, so the
        // explicit cleanup() calls on those early returns are removed.
      } finally {
        cleanup();
      }
    },
```

Delete the now-redundant `cleanup();` from each early return inside the `try` — leaving them is harmless (`Set.delete` is idempotent) but obscures which mechanism is doing the work. After editing, read the whole handler top to bottom and confirm two things: `cleanup()` appears exactly twice (the body-read `catch` and the `finally`), and no `return` path exits between `adsInFlight.add` and the `try`.

- [ ] **Step 4: Migrate the suggestion-update route**

Make the handler `async`, delete old lines 290–291, and replace old lines 292–294 with:

```js
      let payload;
      try { payload = await readJsonBody(req); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        return;
      }
```

Un-indent old lines 295–310, drop the closing `});`. This route does not touch `adsInFlight`, so it needs no `finally`.

- [ ] **Step 5: Run and verify it passes**

```bash
node --test tests/dashboard/json-body-hardening.test.js
```

Expected: `# fail 0`, `# cancelled 0`, including the in-flight leak test.

- [ ] **Step 6: Commit**

```bash
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/route-hardening add agents/dashboard/routes/ads.js tests/dashboard/json-body-hardening.test.js
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/route-hardening commit -m "fix(dashboard): ads routes read bodies through readJsonBody

The in-flight key is claimed before the body is read, so the rejection path
has to release it in a finally — otherwise a bad body locks that suggestion
behind a 429 with no expiry until the process restarts."
```

---

### Task 5: Migrate `creatives.js` — seven sites

**Files:**
- Modify: `agents/dashboard/routes/creatives.js` at lines 117, 168, 574, 725, 793, 836, 914 (route entries; body reads at 120, 171, 577, 728, 796, 840, 918)
- Test: `tests/dashboard/json-body-hardening.test.js`

**Interfaces:**
- Consumes: `readJsonBody`, the `dispatch()` guard.
- Produces: nothing new.

Four of the seven are live Class A crashes — `analyze-reference` (`payload.referenceImage` at 127), `POST templates` (`data.id` at 179), `refine` (destructure at 590), `package` (destructure at 736). The remaining three (`/api/generate-creative` at 796, `PATCH templates/:id` at 840, `PATCH sessions/:id` at 918) access inside their `try` and are Class C only — they migrate for the same reason, since their `end` callbacks are invisible to the Layer 1 guard.

**Do not touch `POST /api/creatives/generate` (line 336).** It is multipart via `multer`, reads `req.body`/`req.files`, and has no `req.on('data')`.

- [ ] **Step 1: Add `creatives.js` to the sweep**

```js
import creativesRoutes from '../../agents/dashboard/routes/creatives.js';
```

Add `...creativesRoutes` to `ROUTES` and these to `TARGETS`:

```js
  ['POST', '/api/creatives/analyze-reference'],
  ['POST', '/api/creatives/templates'],
  ['POST', '/api/creatives/refine'],
  ['POST', '/api/creatives/package'],
  ['POST', '/api/generate-creative'],
  ['PATCH', '/api/creatives/templates/no-such-id-xyz'],
  ['PATCH', '/api/creatives/sessions/no-such-id-xyz'],
```

The stub `ctx` needs the directory constants these handlers read: `REFERENCE_IMAGES_DIR`, `CREATIVE_TEMPLATES_DIR`, `CREATIVE_SESSIONS_DIR`, `CREATIVES_DIR`, `PRODUCT_IMAGES_DIR_MA`, `META_ADS_INSIGHTS_DIR`. Point them all at a non-existent temp path (`/tmp/route-hardening-no-such-dir`) — every handler checks `existsSync` and answers 404 before doing real work, which is exactly the harmless path this sweep wants.

- [ ] **Step 2: Run and verify it fails**

```bash
node --test tests/dashboard/json-body-hardening.test.js
```

Expected: FAIL on `analyze-reference`, `templates`, `refine`, `package`.

- [ ] **Step 3: Migrate all seven**

Add the import once at the top of the file:

```js
import { readJsonBody } from '../lib/responses.js';
```

Apply the recipe from Task 3 to each site. Six of the seven answer `{ error: 'Invalid JSON' }` on a bad body — 117, 168, 574, 725, 836, 914 — and become:

```js
    async handler(req, res, ctx) {
      let payload;
      try { payload = await readJsonBody(req); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
```

Keep each site's existing variable name so the rest of the handler is untouched — `payload` at 117/574/725, `data` at 168, `updates` at 836/914. Rename the destination only, never the uses.

**ORDER IS LOAD-BEARING AT SITE 574 (`/api/creatives/refine`).** Its `end` callback checks `ctx.geminiClient` and answers `503 {"error":"Gemini API key not configured"}` **before** it parses the body. Migrating the body read to the top of the handler would silently turn that into a 400 for any client sending a bad body while Gemini is unconfigured. Keep the 503 check first:

```js
    async handler(req, res, ctx) {
      if (!ctx.geminiClient) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Gemini API key not configured' }));
        return;
      }
      let payload;
      try { payload = await readJsonBody(req); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
```

The general rule the recipe implies but does not say: **preserve the original order of every response path.** Read each `end` callback top to bottom before moving it and keep the checks in the sequence they already run.

The `package` route (725) and `/api/generate-creative` (793) keep their own shapes; 793 currently destructures inside its `try` (`const { adId, productImages = [] } = JSON.parse(body)`), so replace only the parse:

```js
    async handler(req, res, ctx) {
      let payload;
      try { payload = await readJsonBody(req); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      const { adId, productImages = [] } = payload;
```

then un-indent the remainder, keeping its existing outer `try/catch` intact.

For 836 and 914, note `{ ...existing, ...updates }` and `updates.deleteVersion` are already `null`-safe (`{...null}` is `{}`), so their behaviour is unchanged — the migration is purely to bring them inside the guard.

- [ ] **Step 4: Run and verify it passes**

```bash
node --test tests/dashboard/json-body-hardening.test.js
```

Expected: `# fail 0`, `# cancelled 0`.

- [ ] **Step 5: Verify no `end`-callback body reads remain in the file**

```bash
grep -n "req.on('data'" agents/dashboard/routes/creatives.js
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/route-hardening add agents/dashboard/routes/creatives.js tests/dashboard/json-body-hardening.test.js
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/route-hardening commit -m "fix(dashboard): creatives reads all seven bodies through readJsonBody

Four were live crashes on -d 'null'; the other three migrate because an end
callback is invisible to the router guard. The multipart /generate route is
deliberately untouched."
```

---

### Task 6: Migrate the Class-C-only modules — `agents.js`, `cannibalization.js`, `indexing.js`, `posts-kill.js`, `rejected-images.js`

**Files:**
- Modify: `agents/dashboard/routes/agents.js:33-52`, `agents/dashboard/routes/cannibalization.js:41-73`, `agents/dashboard/routes/indexing.js:71-86`, `agents/dashboard/routes/posts-kill.js:17-31`, `agents/dashboard/routes/rejected-images.js:38-75`
- Test: `tests/dashboard/json-body-hardening.test.js`

**Interfaces:**
- Consumes: `readJsonBody`, the `dispatch()` guard.
- Produces: nothing new.

None of these five has a live Class A crash — each accesses its fields **inside** the `try`, so `-d 'null'` already produces a caught error today. They migrate for Class C: their work happens inside `req.on('end')` where the Layer 1 guard cannot reach, and `agents.js` in particular does `JSON.parse(readFileSync(briefPath))` there with no `try` at all, so a corrupt brief file is a live process kill.

- [ ] **Step 1: Add all five to the sweep**

```js
import agentsRoutes from '../../agents/dashboard/routes/agents.js';
import cannibalizationRoutes from '../../agents/dashboard/routes/cannibalization.js';
import indexingRoutes from '../../agents/dashboard/routes/indexing.js';
import postsKillRoutes from '../../agents/dashboard/routes/posts-kill.js';
import rejectedImagesRoutes from '../../agents/dashboard/routes/rejected-images.js';
```

Add each to `ROUTES` and these to `TARGETS`:

```js
  ['POST', '/brief/no-such-slug-xyz/change/no-such-id-xyz'],
  ['POST', '/api/cannibalization/resolve'],
  ['POST', '/api/posts/no-such-slug-xyz/kill'],
  ['POST', '/api/rejected-images/no-such-slug-xyz/accept'],
  ['POST', '/api/indexing/resubmit'],
```

The stub `ctx` needs `COMP_BRIEFS_DIR`, `REJECTED_IMAGES_DIR`, `ROOT`, and an `invalidateDataCache() {}` no-op. Point the directories at `/tmp/route-hardening-no-such-dir`.

`/api/indexing/resubmit` dynamically imports `lib/gsc-indexing.js` and would attempt a real Google API call on a well-formed body. The hostile bodies never reach that line — each is rejected at the body read — but if the import itself is slow or throws in a test environment, assert only that no unhandled rejection occurred for this target rather than on its status code.

**Extend the existing `makeRes()` in this file** so the guard's double-write branch is exercisable — it currently lacks the two properties `failRoute` checks:

```js
function makeRes() {
  const res = { statusCode: null, body: null, headersSent: false, writableEnded: false, destroyed: false };
  res.writeHead = (status) => { res.statusCode = status; res.headersSent = true; };
  res.end = (body) => { res.body = body === undefined ? null : body; res.writableEnded = true; };
  res.destroy = () => { res.destroyed = true; };
  return res;
}
```

Add the Class B test this task is really about:

```js
test('a corrupt brief file produces a 500, not a process kill', async () => {
  // agents.js does JSON.parse(readFileSync(briefPath)) inside an end callback with no
  // try. Before the migration that throw was unreachable by the router guard; after it,
  // the guard answers 500. This is the Class B regression test.
  const dir = mkdtempSync(join(tmpdir(), 'route-hardening-'));
  writeFileSync(join(dir, 'corrupt.json'), '{ this is not json');
  const res = makeRes();

  dispatch(
    agentsRoutes,
    makeReq('POST', '/brief/corrupt/change/some-id', JSON.stringify({ status: 'approved' })),
    res,
    { COMP_BRIEFS_DIR: dir },
  );
  await drain();

  assert.equal(res.statusCode, 500);
  assert.deepEqual(rejections, [], 'nothing reached the process-level handler');
  rmSync(dir, { recursive: true, force: true });
});
```

Add the imports it needs at the top of the test file:

```js
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

- [ ] **Step 2: Run and verify it fails**

```bash
node --test tests/dashboard/json-body-hardening.test.js
```

Expected: the hostile-body sweep passes for these five (they were already safe), but the corrupt-brief test FAILS — the throw lands in the `end` callback where the guard cannot see it, and `rejections` is non-empty.

- [ ] **Step 3: Migrate all five**

Add `import { readJsonBody } from '../lib/responses.js';` to each file (`posts-kill.js` and `rejected-images.js` and `cannibalization.js` define their own local `respondJson`; leave those alone, this plan does not consolidate them).

Apply the recipe. Two shapes need care:

`agents.js` `/brief/` — the parse and the status check share one `try`. Split them, keeping both messages verbatim:

```js
    async handler(req, res, ctx) {
      const parts = req.url.split('/'); // ['', 'brief', slug, 'change', id]
      const slug = parts[2], id = parts[4];
      if (!slug || !id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Missing slug or id' })); return; }
      let status;
      try { ({ status } = await readJsonBody(req)); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' })); return; }
```

then un-indent the rest of the old `end` callback. The `JSON.parse(readFileSync(briefPath))` on the following lines stays exactly as it is, with no new `try` — it is now the guard's job, which is what the new test asserts.

`posts-kill.js` and `rejected-images.js` and `cannibalization.js` and `indexing.js` — each wraps everything in one `try/catch` that answers a 500/502 with `err.message`. Keep that catch and its status code exactly; just replace the read:

```js
    async handler(req, res, ctx) {
      const slug = decodeURIComponent(req.url.split('/')[3]);
      try {
        const body = await readJsonBody(req);
        const reason = body.reason || 'killed via dashboard';
        ...
      } catch (err) {
        respondJson(res, { ok: false, error: err.message }, 500);
      }
    },
```

- [ ] **Step 4: Run and verify it passes**

```bash
node --test tests/dashboard/json-body-hardening.test.js
```

Expected: `# fail 0`, `# cancelled 0`, including the corrupt-brief test.

- [ ] **Step 5: Commit**

```bash
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/route-hardening add agents/dashboard/routes/agents.js agents/dashboard/routes/cannibalization.js agents/dashboard/routes/indexing.js agents/dashboard/routes/posts-kill.js agents/dashboard/routes/rejected-images.js tests/dashboard/json-body-hardening.test.js
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/route-hardening commit -m "fix(dashboard): five Class-C modules read bodies through readJsonBody

None had a live null-body crash — they access inside the try. They migrate
because an end callback is unreachable from the router guard, which is how
agents.js's untried JSON.parse of a brief file was a live process kill."
```

---

### Task 7: Deduplicate the three promise-style readers — `campaigns.js`, `giveaway.js`, `rum.js`

**Files:**
- Modify: `agents/dashboard/routes/campaigns.js:16-25`, `agents/dashboard/routes/giveaway.js:269-302` and its three call sites (338, 387, 425), `agents/dashboard/routes/rum.js:59-76` and its call site
- Test: `tests/dashboard/json-body-hardening.test.js`

**Interfaces:**
- Consumes: `readJsonBody({ maxBytes })`, `DEFAULT_MAX_BYTES`.
- Produces: nothing new. `giveaway.js` keeps exporting `validateEntryPayload` and `validateUpload` unchanged.

These three already return promises and are already awaited, so there is no crash to fix — this is deduplication, and it must be **behaviour-preserving**. `giveaway.js` and `rum.js` are the only unauthenticated routes in the process; their caps are the thing most likely to be broken by carelessness here.

- [ ] **Step 1: Write the cap-preservation tests**

Add to `tests/dashboard/json-body-hardening.test.js`:

```js
test('rum still refuses a body over 8 KB', async () => {
  const res = makeRes();
  const oversized = JSON.stringify({ pad: 'x'.repeat(9 * 1024) });
  dispatch(rumRoutes, makeReq('POST', '/api/rum', oversized), res, {});
  await drain();
  assert.ok(res.statusCode >= 400, `expected a 4xx, got ${res.statusCode}`);
  assert.deepEqual(rejections, []);
});

test('giveaway entry routes still refuse a body over 4 KB', async () => {
  // Direct reader call, not a dispatch: the giveaway handlers sit behind a rate limiter
  // keyed on socket details a stub request has no business faking — the same reason the
  // existing tests in this file validate giveaway through its exported validators.
  const oversized = JSON.stringify({ pad: 'x'.repeat(5 * 1024) });
  await assert.rejects(
    () => readJsonBody(makeChunkedReq(oversized), { maxBytes: 4 * 1024 }),
    (err) => err.code === 'BODY_TOO_LARGE',
  );
});
```

Import `rumRoutes` if it is not already imported (it is — it is in the original `ROUTES` list).

- [ ] **Step 2: Run and verify the rum test's current behaviour**

```bash
node --test tests/dashboard/json-body-hardening.test.js
```

Expected: PASS already — `rum.js` caps today. This test is a **characterization test**: it pins the behaviour you are about to refactor so that breaking it during Step 3 is loud. Record that it passes before touching anything.

- [ ] **Step 3: Migrate `rum.js`**

Delete `readCappedBody` (lines 59–76). Replace its call site with:

```js
const parsed = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES });
```

Read the call site first — the old helper resolved a **string** that the caller then `JSON.parse`d. `readJsonBody` resolves the parsed object, so remove the now-duplicate parse and keep the surrounding `catch` and its status code exactly. Keep the `MAX_BODY_BYTES = 8 * 1024` constant and its comment.

- [ ] **Step 4: Migrate `giveaway.js`**

Delete `readCappedBody` (lines 269–302). Replace the three call sites:

```js
// line 338 — entry submission
      try { parsed = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES }); }

// line 387 — entry submission
      try { parsed = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES }); }

// line 425 — upload, which carries a base64 image and needs its own larger cap
      try { parsed = await readJsonBody(req, { maxBytes: MAX_UPLOAD_BASE64 + 2048 }); }
```

Pass `maxBytes` explicitly at all three — do not rely on the default, which is 1 MB and 256× too permissive for these public routes. Remove the now-duplicate `JSON.parse(...)` wrapper at each site, since `readJsonBody` returns the parsed value. **Leave every `catch` untouched**, including the `err?.code !== 'BODY_TOO_LARGE'` branch at line 312 — Task 2 preserved that code specifically so this keeps working.

- [ ] **Step 5: Migrate `campaigns.js`**

Delete the local `readJson` helper (lines 16–25) and import the shared one. Its three call sites use `await readJson(req)` and destructure the result; change them to `await readJsonBody(req)`. This is a real behaviour improvement — the local helper resolved `null` for `-d 'null'`, which then threw on destructuring into the handler's own `catch` and produced a 400. The shared reader rejects, producing the same 400 from the same `catch`. Verify that is what happens rather than assuming it.

Note `campaigns.js`'s two **bodyless** handlers (`dismiss`, `alerts/:type/resolve`) are synchronous and do `JSON.parse(readFileSync(file))` with no `try`. Leave them exactly as they are — Task 1's synchronous arm is what protects them, and Task 8 adds a test proving it.

This was decided explicitly (2026-08-21), not overlooked: a corrupt campaign file becomes a generic 500 rather than a specific 404 or 400. It is a genuine internal error, and a 404 would misreport the cause to the client while the real reason sat only in stderr. Do not "improve" this into a friendlier status.

- [ ] **Step 6: Run and verify everything passes**

```bash
node --test tests/dashboard/json-body-hardening.test.js
node --test tests/dashboard/
```

Expected: `# fail 0`, `# cancelled 0`. The `giveaway-routes.test.js` suite must still pass unchanged — if it does not, a status code moved and the migration was not behaviour-preserving.

- [ ] **Step 7: Verify no hand-rolled readers remain anywhere**

```bash
grep -rn "req.on('data'" agents/dashboard/
```

Expected: no output. Every body in the dashboard now flows through `readJsonBody`.

- [ ] **Step 8: Commit**

```bash
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/route-hardening add agents/dashboard/routes/campaigns.js agents/dashboard/routes/giveaway.js agents/dashboard/routes/rum.js tests/dashboard/json-body-hardening.test.js
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/route-hardening commit -m "refactor(dashboard): one body reader for all twelve route modules

The three promise-style readers had no crash to fix; this is deduplication.
Every cap is passed explicitly — the 1 MB default is 256x too permissive for
the two unauthenticated routes, and relying on it here would be the exact
regression the per-call option exists to prevent."
```

---

### Task 8: Layer 3 — process-level net

**Files:**
- Modify: `agents/dashboard/index.js`
- Test: `tests/dashboard/router-guard.test.js`

**Interfaces:**
- Consumes: `notify` from `lib/notify.js`.
- Produces: two process-level listeners. No exported symbols.

This is a last resort, not the fix. If Layers 1 and 2 are right it never fires, and its firing is a bug report.

- [ ] **Step 1: Write the failing test**

Add to `tests/dashboard/router-guard.test.js` — a synchronous bodyless handler is the case Layer 1's sync arm exists for, and `campaigns.js` is the real-world instance:

```js
test('a synchronous handler that throws on a corrupt file produces a 500', async () => {
  // The shape of campaigns.js's dismiss / alerts-resolve handlers: fully synchronous,
  // JSON.parse(readFileSync(...)) with no try. Only dispatch()'s synchronous arm stands
  // between a corrupt data file and an uncaughtException.
  rejections.length = 0;
  const routes = [{
    method: 'POST',
    match: '/sync-file',
    handler() { JSON.parse('{ not json'); },
  }];
  const res = makeRes();

  dispatch(routes, makeReq('POST', '/sync-file'), res, {});
  await drain();

  assert.equal(res.statusCode, 500);
  assert.deepEqual(rejections, []);
});
```

- [ ] **Step 2: Run and verify it passes**

```bash
node --test tests/dashboard/router-guard.test.js
```

Expected: PASS — Task 1 already implemented this arm. This test documents *why* the arm exists, tied to a named real handler. If it fails, Task 1 was implemented with only the promise arm and must be fixed before continuing.

- [ ] **Step 3: Register the process-level handlers**

In `agents/dashboard/index.js`, immediately before `const server = http.createServer(...)`, add:

```js
/**
 * LAST RESORT, NOT THE FIX. lib/router.js's dispatch() guard and readJsonBody between
 * them are supposed to make these unreachable — anything arriving here is a bug report,
 * not a routine event, which is why it notifies immediately rather than deferring to the
 * 5 AM digest.
 *
 * KEEP SERVING, deliberately. Node terminates on an unhandled rejection by default since
 * v15, and that default is what took the whole dashboard down for every tab whenever one
 * request went wrong. The cost of surviving is that the one in-flight request hangs until
 * its client times out; the cost of exiting is an outage, which is the thing this whole
 * change exists to remove.
 */
function reportFatal(kind, err) {
  console.error(`[dashboard] ${kind}:`, err?.stack || err);
  try {
    notify({
      agent: 'dashboard',
      status: 'error',
      immediate: true,
      subject: `Dashboard ${kind}`,
      body: `${kind} in seo-dashboard — the router guard did not contain it, which means a route is doing work outside a guarded promise.\n\n${err?.stack || err}`,
    });
  } catch (notifyErr) {
    // A failing notify must never itself become the thing that kills the process.
    console.error('[dashboard] notify failed while reporting a fatal:', notifyErr?.message || notifyErr);
  }
}

process.on('unhandledRejection', (reason) => reportFatal('unhandledRejection', reason));
process.on('uncaughtException', (err) => reportFatal('uncaughtException', err));
```

Add the import if `notify` is not already imported. Check first:

```bash
grep -n "notify" agents/dashboard/index.js
```

If absent, add `import { notify } from '../../lib/notify.js';` alongside the other imports and verify the relative path resolves from `agents/dashboard/`.

- [ ] **Step 4: Verify the handlers are registered and the server still boots**

```bash
node --input-type=module -e "
import('./agents/dashboard/index.js').catch(e => { console.error('IMPORT FAILED', e); process.exit(1); });
setTimeout(() => {
  console.log('unhandledRejection listeners:', process.listenerCount('unhandledRejection'));
  console.log('uncaughtException listeners:', process.listenerCount('uncaughtException'));
  process.exit(0);
}, 2000);
"
```

Expected: both counts ≥ 1, no import failure. If the port is in use, stop the local dashboard first or accept the listen error — the listener counts are what matter.

- [ ] **Step 5: Commit**

```bash
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/route-hardening add agents/dashboard/index.js tests/dashboard/router-guard.test.js
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/route-hardening commit -m "feat(dashboard): process-level net logs, notifies immediately, keeps serving

Last resort — if layers 1 and 2 are right this never fires, and its firing is
a bug report. Surviving costs one hung request; exiting costs an outage, which
is the thing being removed."
```

---

### Task 9: Documentation

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** none.

A change that makes a doc wrong fixes the doc in the same PR.

- [ ] **Step 1: Add the dashboard route contract to `CLAUDE.md`**

Under the `**Dashboard.**` paragraph in the Architecture section, add:

```markdown
**Dashboard route contract — three rules, because a bad request used to kill every tab.** `lib/router.js`'s `dispatch()` calls handlers without awaiting them, so before hardening any uncaught throw was fatal to the shared PM2 process on a public URL. Now: (1) `dispatch()` catches **both** synchronous throws and async rejections and answers a fixed 500, never echoing the exception; (2) **every** body is read with `await readJsonBody(req, { maxBytes })` from `lib/responses.js` — a per-call cap because `/api/rum` (8 KB) and `/api/giveaway/*` (4 KB, upload `MAX_UPLOAD_BASE64 + 2048`) are the unauthenticated routes and the 1 MB default is 256× too permissive for them; (3) `index.js` registers `unhandledRejection`/`uncaughtException` that log, `notify({ immediate: true })`, and **keep serving** — a last resort whose firing is a bug report. **Never do work inside a `req.on('end')` callback.** That runs on the emitter's stack, outside the handler's promise, where the `dispatch()` guard cannot reach it — that unreachability, not `null` bodies, is why all twelve modules were migrated. `POST /api/creatives/generate` is the one exception: multipart via `multer`, with its own 20 MB limit.
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/route-hardening add CLAUDE.md
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/route-hardening commit -m "docs: dashboard route contract — guard, one reader, never work in an end callback"
```

---

### Task 10: Full verification and PR

**Files:** none modified.

- [ ] **Step 1: Run the entire test suite on Node 22**

```bash
cd /Users/seanfillmore/Code/Claude/.claude/worktrees/route-hardening
nvm use
node --version   # must print v22.x
node --test tests/
```

Expected: `# fail 0` **and** `# cancelled 0`. Compare pass counts against the baseline recorded in Task 1 Step 5. A drop in total tests run means something stopped being collected.

- [ ] **Step 2: Boot the dashboard locally and exercise the crash cases**

```bash
PORT=4243 node agents/dashboard/index.js &
sleep 3
for p in /api/rum /api/chat /api/creatives/refine /api/reject-keyword; do
  printf '%s -> ' "$p"
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "http://localhost:4243$p" -d 'null'
done
printf 'still alive -> '
curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:4243/robots.txt"
kill %1
```

Expected: each POST returns 400 or 401 (authenticated routes answer 401 before dispatch — that is correct and still proves no crash), and `/robots.txt` returns 200, proving the process survived all four.

- [ ] **Step 3: Confirm the branch and push**

```bash
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/route-hardening branch --show-current   # must print fix/dashboard-route-hardening
git -C /Users/seanfillmore/Code/Claude/.claude/worktrees/route-hardening push -u origin fix/dashboard-route-hardening
```

- [ ] **Step 4: Open the PR**

```bash
gh pr create --repo seanfillmore/seo-claude --base main --head fix/dashboard-route-hardening \
  --title "fix(dashboard): route hardening — one bad request can no longer kill the process" \
  --body "$(cat <<'BODY'
`curl -X POST <dashboard>/api/creatives/refine -d 'null'` terminated the shared
`seo-dashboard` PM2 process — every tab, on a public URL, no credentials needed.

Three crash classes, three layers. Neither layer alone is sufficient:

- **Layer 1 — `dispatch()` guard.** Catches synchronous throws *and* async
  rejections, answers a fixed 500, never echoes the exception. Covers corrupt
  data files and every route added later.
- **Layer 2 — one body reader.** All twenty body reads across twelve modules
  now `await readJsonBody(req, { maxBytes })`. This is not mainly about `null`
  bodies: a throw inside `req.on('end', cb)` runs on the emitter's stack,
  outside the handler's promise, where **no** dispatch-level guard can reach
  it. Migration is what brings that code inside the guard.
- **Layer 3 — process-level net.** Logs, notifies immediately, keeps serving.
  A last resort whose firing is a bug report.

The cap is per-call, not one constant: `/api/rum` (8 KB) and `/api/giveaway/*`
(4 KB) are the unauthenticated routes and keep their existing limits exactly.
`readJsonBody` also switches to `Buffer.concat`, fixing multibyte corruption at
chunk boundaries that every hand-rolled `body += chunk` reader had.

`POST /api/creatives/generate` is untouched — multipart via multer.

**Verification:** full suite green on Node 22 (`# fail 0`, `# cancelled 0`);
locally booted and confirmed all four previously-fatal requests answer 400 with
the process still serving.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 5: Report back**

Do not merge or deploy. Report the PR URL, the final test counts including `cancelled`, and the four status codes from Step 2. Post-merge deploy and live verification are a separate decision for Sean.

---

## Post-merge verification (for whoever deploys)

```bash
ssh root@137.184.119.230 'cd ~/seo-claude && git pull && pm2 restart seo-dashboard && pm2 status'
```

Then, against the live dashboard:

1. `pm2 status` shows `seo-dashboard` **online**.
2. `curl -X POST <dashboard>/api/rum -d 'null'` returns 400 and the process stays up.
3. A body over 8 KB to `/api/rum` returns the same status it returned before this change.
4. Load one authenticated tab and confirm a normal request still round-trips.
