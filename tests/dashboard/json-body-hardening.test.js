// tests/dashboard/json-body-hardening.test.js
//
// A JSON BODY OF LITERAL `null` USED TO KILL THE WHOLE DASHBOARD.
//
// `JSON.parse('null')` is `null`, not `undefined`, so every validator's `body = {}`
// parameter default — which fires only on `undefined` — did not fire, and `body.product`
// threw a TypeError. Those validator calls sit OUTSIDE the handlers' try/catch,
// lib/router.js's dispatch() calls handlers WITHOUT awaiting them, and nothing in the
// dashboard process registers an 'unhandledRejection' handler. Net effect:
// `curl -X POST https://<dashboard>/api/ad-brief/generate -d 'null'` terminated the single
// shared seo-dashboard PM2 process, taking every tab down with it.
//
// Fixed centrally in agents/dashboard/lib/responses.js's readJsonBody, which now REJECTS a
// non-object parse result (see its docstring for reject-vs-coerce and for why an array is
// deliberately still accepted). This file is the proof, and it is deliberately written the
// way the reviewer found the bug: through the REAL dispatch() from lib/router.js, over the
// REAL exported route tables, with an 'unhandledRejection' listener watching.
//
// The listener is the actual assertion. Calling a handler and awaiting it would prove
// nothing — the crash came precisely from the promise NOBODY awaited, so these tests
// dispatch without awaiting, drain the macrotask queue, and then assert that nothing
// reached the process-level handler.

import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import { dispatch } from '../../agents/dashboard/lib/router.js';
import { readJsonBody } from '../../agents/dashboard/lib/responses.js';
import adBriefRoutes from '../../agents/dashboard/routes/ad-brief.js';
import adStudioLaunchRoutes from '../../agents/dashboard/routes/ad-studio-launch.js';
import adStudioRoutes from '../../agents/dashboard/routes/ad-studio.js';
import ideasRoutes from '../../agents/dashboard/routes/ideas.js';
import performanceQueueRoutes from '../../agents/dashboard/routes/performance-queue.js';
import rumRoutes from '../../agents/dashboard/routes/rum.js';
import { validateEntryPayload, validateUpload } from '../../agents/dashboard/routes/giveaway.js';

// The same list order agents/dashboard/index.js dispatches in, restricted to the modules
// that parse a request body. giveaway is covered by direct validator calls further down —
// its handlers sit behind a rate limiter keyed on socket details that a stub request has no
// business faking.
const ROUTES = [
  ...adBriefRoutes,
  ...adStudioLaunchRoutes,
  ...adStudioRoutes,
  ...ideasRoutes,
  ...performanceQueueRoutes,
  ...rumRoutes,
];

/** Minimal http.ServerResponse stand-in: captures status + body, nothing else. */
function makeRes() {
  const res = { statusCode: null, body: null, headersSent: false };
  res.writeHead = (status) => { res.statusCode = status; res.headersSent = true; };
  res.end = (body) => { res.body = body === undefined ? null : body; };
  return res;
}

/** Minimal IncomingMessage stand-in. Emits the body the moment each listener is attached. */
function makeReq(method, url, bodyStr) {
  return {
    method,
    url,
    headers: { 'user-agent': 'node-test', origin: 'https://www.realskincare.com' },
    destroy() {},
    on(event, cb) {
      if (event === 'data' && bodyStr) cb(Buffer.from(bodyStr));
      if (event === 'end') cb();
      return this;
    },
  };
}

/** Every body-parsing POST/PATCH surface in the modules above, with a harmless target. */
const TARGETS = [
  ['POST', '/api/ad-brief/generate'],
  ['POST', '/api/ad-brief/decide'],
  ['POST', '/api/ad-brief/format'],
  ['POST', '/api/ad-brief/render'],
  ['POST', '/api/ad-studio/launch'],
  ['POST', '/api/ad-studio/run/no-such-run-xyz/decide'],
  ['PATCH', '/api/ideas/no-such-slug-xyz'],
  ['POST', '/api/performance-queue/no-such-slug-xyz/feedback'],
  ['POST', '/api/rum'],
];

/** The four non-object top-level JSON documents from the review. */
const HOSTILE_BODIES = ['null', '5', '"str"', '[]'];

const rejections = [];
const onUnhandled = (reason) => { rejections.push(reason); };

before(() => { process.on('unhandledRejection', onUnhandled); });
after(() => { process.off('unhandledRejection', onUnhandled); });

/** Let dispatch()'s un-awaited handler promise settle and any rejection surface. */
async function drain() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

for (const body of HOSTILE_BODIES) {
  test(`a request body of ${body} never reaches a handler as something that throws on property access`, async () => {
    rejections.length = 0;
    const answers = [];

    for (const [method, url] of TARGETS) {
      const res = makeRes();
      // NOT awaited — exactly how lib/router.js's dispatch() calls a handler, and exactly
      // why an internal throw used to become an unhandled rejection rather than a 500.
      const matched = dispatch(ROUTES, makeReq(method, url, body), res, {});
      assert.equal(matched, true, `${method} ${url} must still match a route`);
      answers.push({ url, res });
    }

    await drain();

    assert.deepEqual(
      rejections.map((r) => (r && r.message) || String(r)), [],
      'no route may leave an unhandled rejection — in production that terminates the whole ' +
      'shared seo-dashboard PM2 process, not just the request',
    );

    for (const { url, res } of answers) {
      assert.ok(
        typeof res.statusCode === 'number',
        `${url} must ANSWER a body of ${body}, not hang or die (got ${res.statusCode})`,
      );
      assert.ok(res.statusCode >= 400 && res.statusCode < 500,
        `${url} must refuse a body of ${body} with a 4xx, got ${res.statusCode}`);
    }
  });
}

// ── readJsonBody's own contract ─────────────────────────────────────────────────────────

/** Drives readJsonBody directly against the stub request. */
const parse = (bodyStr) => readJsonBody(makeReq('POST', '/x', bodyStr));

test('readJsonBody rejects every non-object top-level JSON value', async () => {
  for (const body of ['null', '5', '"str"', 'true', 'false']) {
    await assert.rejects(() => parse(body), /must be a JSON object/, `${body} must be refused`);
  }
});

test('readJsonBody rejects malformed JSON, as it always did', async () => {
  await assert.rejects(() => parse('{'));
  await assert.rejects(() => parse('not json at all'));
});

test('readJsonBody still resolves {} for an absent body — a fieldless POST is an ordinary request', async () => {
  assert.deepEqual(await parse(''), {});
  assert.deepEqual(await parse(undefined), {});
});

// The one arguable shape, decided deliberately: an array is PASSED THROUGH. `[].product` is
// `undefined`, not a throw, so an array cannot cause the crash this fix exists to close, and
// every validator already reads it correctly as "no fields supplied". Refusing it would be a
// behaviour change for a shape that is already handled — the rule stays exactly as narrow as
// the defect.
test('readJsonBody passes an array through untouched, and objects unchanged', async () => {
  assert.deepEqual(await parse('[]'), []);
  assert.deepEqual(await parse('[1,2]'), [1, 2]);
  assert.deepEqual(await parse('{"product":"coconut-lotion"}'), { product: 'coconut-lotion' });
});

// ── the unauthenticated surface: dispatched BEFORE checkAuth ─────────────────────────────
//
// agents/dashboard/index.js dispatches /api/rum and /api/giveaway/* ahead of checkAuth, so a
// crash reachable through either is reachable with no credentials at all. Neither uses
// readJsonBody — both do their own capped read and JSON.parse — so the central fix does NOT
// cover them and they are pinned separately. Both turn out to be safe already, one by design
// and one by luck, and this records which is which so a later edit cannot quietly remove the
// protection.

test('POST /api/rum refuses every non-object body by explicit type check, not by luck', async () => {
  rejections.length = 0;
  const seen = [];
  for (const body of ['null', '5', '"str"', '[]']) {
    const res = makeRes();
    dispatch(ROUTES, makeReq('POST', '/api/rum', body), res, {});
    seen.push({ body, res });
  }
  await drain();
  assert.deepEqual(rejections, [], '/api/rum is unauthenticated — a throw here is a public DoS');
  for (const { body, res } of seen) {
    assert.ok(res.statusCode >= 400 && res.statusCode < 500, `body ${body} got ${res.statusCode}`);
  }
});

test("giveaway's payload validators survive a null body — inside a try/catch, which is what saves them", () => {
  // These are the two unauthenticated bodies. `validateEntryPayload(body = {})` does NOT get
  // its default on null and DOES read `body.email` — the read simply happens to sit inside
  // the function's own try/catch, so the TypeError becomes a clean refusal. That is luck
  // rather than design, so it is pinned here: if that try/catch is ever narrowed to
  // normalizeEmail's own failure mode, this test fails instead of the process.
  for (const bad of [null, 5, 'str', []]) {
    const e = validateEntryPayload(bad);
    assert.equal(e.ok, false, `validateEntryPayload(${JSON.stringify(bad)}) must refuse, not throw`);
    const u = validateUpload(bad);
    assert.equal(u.ok, false, `validateUpload(${JSON.stringify(bad)}) must refuse, not throw`);
  }
});

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
