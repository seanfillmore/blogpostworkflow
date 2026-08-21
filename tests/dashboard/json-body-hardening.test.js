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
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch } from '../../agents/dashboard/lib/router.js';
import { readJsonBody } from '../../agents/dashboard/lib/responses.js';
import adBriefRoutes from '../../agents/dashboard/routes/ad-brief.js';
import adsRoutes from '../../agents/dashboard/routes/ads.js';
import adStudioLaunchRoutes from '../../agents/dashboard/routes/ad-studio-launch.js';
import adStudioRoutes from '../../agents/dashboard/routes/ad-studio.js';
import chatRoutes from '../../agents/dashboard/routes/chat.js';
import creativesRoutes from '../../agents/dashboard/routes/creatives.js';
import dataforseoRoutes from '../../agents/dashboard/routes/dataforseo.js';
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
  ...adsRoutes,
  ...adStudioLaunchRoutes,
  ...adStudioRoutes,
  ...chatRoutes,
  ...creativesRoutes,
  ...dataforseoRoutes,
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
  ['POST', '/ads/2026-08-21/suggestion/no-such-id-xyz/chat'],
  ['POST', '/ads/2026-08-21/suggestion/no-such-id-xyz'],
  ['POST', '/api/ad-studio/launch'],
  ['POST', '/api/ad-studio/run/no-such-run-xyz/decide'],
  ['POST', '/api/chat'],
  ['POST', '/api/chat/action-item'],
  ['POST', '/api/reject-keyword'],
  ['PATCH', '/api/ideas/no-such-slug-xyz'],
  ['POST', '/api/performance-queue/no-such-slug-xyz/feedback'],
  ['POST', '/api/rum'],
  ['POST', '/api/creatives/analyze-reference'],
  ['POST', '/api/creatives/templates'],
  ['POST', '/api/creatives/refine'],
  ['POST', '/api/creatives/package'],
  ['POST', '/api/generate-creative'],
  // PUT /api/creatives/templates/:id and PUT /api/creatives/sessions/:id are deliberately
  // NOT here — see the dedicated test below for why the blanket "must be 4xx" assertion
  // this loop applies does not fit those two routes, and why sessions/:id specifically
  // cannot be driven through every hostile body in an automated test at all.
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
    // ads.js's chat route reads ctx.adsInFlight before the body, and its update route
    // reads ctx.ADS_OPTIMIZER_DIR after — both need to exist for the sweep to reach the
    // JSON parse rather than throwing on ctx access first. creatives.js's handlers each
    // check existsSync(<dir>) and answer 404 before doing real work — pointing every one
    // of these at a directory that does not exist keeps the sweep on that harmless path.
    const ctx = {
      adsInFlight: new Set(),
      ADS_OPTIMIZER_DIR: '/tmp/no-such-dir-xyz',
      REFERENCE_IMAGES_DIR: '/tmp/route-hardening-no-such-dir',
      CREATIVE_TEMPLATES_DIR: '/tmp/route-hardening-no-such-dir',
      CREATIVE_SESSIONS_DIR: '/tmp/route-hardening-no-such-dir',
      CREATIVES_DIR: '/tmp/route-hardening-no-such-dir',
      PRODUCT_IMAGES_DIR_MA: '/tmp/route-hardening-no-such-dir',
      META_ADS_INSIGHTS_DIR: '/tmp/route-hardening-no-such-dir',
      // Truthy so /api/creatives/refine's pre-body 503 gate ("Gemini API key not
      // configured") does not fire before the body is ever read — a falsy stub here
      // would make refine answer 503 for every hostile body regardless of migration
      // status, which proves nothing about read-order and fails the blanket 4xx check
      // below for an unrelated reason.
      geminiClient: {},
    };

    for (const [method, url] of TARGETS) {
      const res = makeRes();
      // NOT awaited — exactly how lib/router.js's dispatch() calls a handler, and exactly
      // why an internal throw used to become an unhandled rejection rather than a 500.
      const matched = dispatch(ROUTES, makeReq(method, url, body), res, ctx);
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

// ── the two upsert PUT routes: no required-field validation, so an array or empty body
// legitimately SUCCEEDS instead of being refused ─────────────────────────────────────────
//
// PUT /api/creatives/templates/:id and PUT /api/creatives/sessions/:id are excluded from
// the blanket TARGETS sweep above on purpose. Both are create-or-replace endpoints with no
// required fields, so a body readJsonBody PASSES THROUGH untouched (an array, or an empty
// body — see readJsonBody's own docstring) reaches their real upsert logic and answers 200,
// not a refusal. That is not a regression this migration introduces — it is the same
// "no required fields" shape every other migrated route already treats as ordinary — but it
// does mean the blanket "must be a 4xx" assertion above does not hold for these two, so they
// get their own, narrower test: the three bodies readJsonBody actually REJECTS (null, 5,
// "str") are asserted to come back 4xx; '[]' is deliberately not exercised here (see below).
//
// THE EMPTY-BODY CASE IS A RULED-ON, ACCEPTED CONSEQUENCE — NOT A DESIRED OUTCOME, AND NOT
// A BUG. readJsonBody resolves `{}` for a zero-byte body (its documented contract, which
// predates this migration); the old `JSON.parse('')` threw and produced a 400. Neither of
// these two routes has a required field to catch that on, so an empty PUT now succeeds
// (200) where it used to be refused — on templates/:id this also CREATES a stub file that
// did not exist before, carrying only an updatedAt stamp. Task 5 review flagged this as
// invisible (no test exercised it); the ruling was to make it VISIBLE in CI rather than add
// "at least one field required" validation, which the effort's Global Constraints forbid as
// new validation out of this migration's scope, and which matches how the same shape
// (POST /ads/:date/suggestion/:id) was already ruled acceptable elsewhere in this effort.
// The assertions below are written to read as "this was decided on purpose", not as an
// endorsement — see the two comments directly on those assertions.
//
// Only templates/:id is driven through the empty body. sessions/:id is deliberately NOT —
// it cannot be driven through the '[]' or '' body shapes in an automated test at all:
// agents/dashboard/lib/creatives-store.js's saveSession/createSession import
// CREATIVE_SESSIONS_DIR and CREATIVES_DIR directly from lib/paths.js rather than reading
// them off ctx, so pointing ctx.CREATIVE_SESSIONS_DIR at a scratch directory does NOT stop
// a body that reaches the real upsert path from writing into THIS repo's actual
// data/creative-sessions and data/creatives directories. Confirmed by running exactly that
// scenario once, by hand, while building this test, and having to delete the stray
// no-such-id-xyz.json and session-*.json files it left behind. That ctx-bypass is a
// pre-existing fact about the library, not something this migration introduces or is in
// scope to fix, so sessions/:id's own empty-body 200 stays untested here — this paragraph
// is the record of that gap, so it stays documented rather than silent.
test(`PUT /api/creatives/templates/:id and /sessions/:id refuse null/5/"str" without crashing, and templates/:id's empty-body 200 is the accepted readJsonBody consequence (see comment above)`, async () => {
  rejections.length = 0;
  // Real, writable, throwaway directory — templates/:id's write DOES respect
  // ctx.CREATIVE_TEMPLATES_DIR. None of null/5/"str" ever reach that write (readJsonBody
  // rejects all three before the handler's own try touches the filesystem); the empty
  // body below is the one case that does reach it, which is the point of this test.
  const tmpDir = mkdtempSync(join(tmpdir(), 'route-hardening-creatives-put-'));
  const ctx = {
    CREATIVE_TEMPLATES_DIR: tmpDir,
    CREATIVE_SESSIONS_DIR: '/tmp/route-hardening-no-such-dir',
    CREATIVES_DIR: '/tmp/route-hardening-no-such-dir',
  };
  const seen = [];
  let emptyBodyRes;
  let stubFileExists;
  try {
    for (const body of ['null', '5', '"str"']) {
      for (const [method, url] of [
        ['PUT', '/api/creatives/templates/no-such-id-xyz'],
        ['PUT', '/api/creatives/sessions/no-such-id-xyz'],
      ]) {
        const res = makeRes();
        const matched = dispatch(creativesRoutes, makeReq(method, url, body), res, ctx);
        assert.equal(matched, true, `${method} ${url} must still match a route`);
        seen.push({ method, url, body, res });
      }
    }

    // templates/:id ONLY — see the comment block above for why sessions/:id is excluded.
    emptyBodyRes = makeRes();
    const emptyMatched = dispatch(
      creativesRoutes,
      makeReq('PUT', '/api/creatives/templates/no-such-id-xyz', ''),
      emptyBodyRes,
      ctx,
    );
    assert.equal(emptyMatched, true, 'PUT templates/:id must still match a route for an empty body');

    await drain();

    // Checked before the tmpDir cleanup in `finally` below runs.
    stubFileExists = existsSync(join(tmpDir, 'no-such-id-xyz.json'));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  assert.deepEqual(
    rejections.map((r) => (r && r.message) || String(r)), [],
    'no route may leave an unhandled rejection',
  );
  for (const { method, url, body, res } of seen) {
    assert.ok(typeof res.statusCode === 'number', `${method} ${url} must answer a body of ${body}`);
    assert.ok(res.statusCode >= 400 && res.statusCode < 500,
      `${method} ${url} must refuse a body of ${body} with a 4xx, got ${res.statusCode}`);
  }

  // ACCEPTED CONSEQUENCE, ruled on in Task 5 review — not desirable, not a regression this
  // migration introduces, and deliberately left unfixed rather than given new validation.
  // readJsonBody resolves {} for an absent body (its documented, pre-existing contract);
  // templates/:id has no required field to catch that on, so the merge-and-save proceeds
  // and answers 200 where the old hand-rolled JSON.parse('') used to throw into a 400.
  assert.equal(emptyBodyRes.statusCode, 200,
    'RULED ACCEPTABLE (Task 5 review): an empty body against templates/:id succeeds instead ' +
    'of being refused, because readJsonBody resolves {} and this route has no required field');
  // Same ruling: the write this 200 represents is real, and on this route it can CREATE a
  // template that did not exist — asserted here so that fact stays visible, not implied.
  assert.equal(stubFileExists, true,
    'RULED ACCEPTABLE (Task 5 review): the empty body creates a stub template file in ' +
    'CREATIVE_TEMPLATES_DIR carrying only an updatedAt stamp, where none existed before');
});

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
