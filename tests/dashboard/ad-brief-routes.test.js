import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import routes, {
  validateDecide, validateGenerate, buildAgentArgv, performGenerate,
  validateRender, validateChooseFormat, performRender,
} from '../../agents/dashboard/routes/ad-brief.js';

const PRODUCTS = [{ handle: 'coconut-lotion' }, { handle: 'coconut-soap' }];

test('a well-formed decision is accepted', () => {
  const r = validateDecide({ product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1', state: 'approved' }, { products: PRODUCTS });
  assert.equal(r.ok, true);
});

test('an unknown state is refused', () => {
  assert.equal(validateDecide({ product: 'coconut-lotion', briefId: 'b1', state: 'shipped' }, { products: PRODUCTS }).ok, false);
});

test('a traversal product or brief id is refused', () => {
  assert.equal(validateDecide({ product: '../etc', briefId: 'b1', state: 'approved' }, { products: PRODUCTS }).ok, false);
  assert.equal(validateDecide({ product: 'coconut-lotion', briefId: '../../x', state: 'approved' }, { products: PRODUCTS }).ok, false);
});

test('an unknown product is refused', () => {
  assert.equal(validateDecide({ product: 'not-a-product', briefId: 'b1', state: 'approved' }, { products: PRODUCTS }).ok, false);
});

test('generate requires a known product', () => {
  assert.equal(validateGenerate({ product: 'coconut-lotion' }, { products: PRODUCTS }).ok, true);
  assert.equal(validateGenerate({ product: 'nope' }, { products: PRODUCTS }).ok, false);
  assert.equal(validateGenerate({}, { products: PRODUCTS }).ok, false);
});

test('generate normalises an angle list and refuses a malformed one', () => {
  assert.deepEqual(validateGenerate({ product: 'coconut-lotion', angles: ['p1a1', ' p5a3 '] }, { products: PRODUCTS }).args.angles, ['p1a1', 'p5a3']);
  assert.equal(validateGenerate({ product: 'coconut-lotion', angles: ['../x'] }, { products: PRODUCTS }).ok, false);
});

// ── validateRender / validateChooseFormat ───────────────────────────────────────────
//
// Coordinator fix (2026-08-17): Task 6's Briefs view always listed Render and a
// format-override dropdown as actions, but Task 5's route table never built the
// endpoints behind them. These two mirror validateDecide's shape exactly — same
// segment-before-filesystem discipline, same `deps.products` allowlist seam.

test('a well-formed render request is accepted', () => {
  const r = validateRender({ product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1' }, { products: PRODUCTS });
  assert.equal(r.ok, true);
  assert.deepEqual(r.args, { product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1' });
});

test('render refuses a traversal product or brief id', () => {
  assert.equal(validateRender({ product: '../etc', briefId: 'b1' }, { products: PRODUCTS }).ok, false);
  assert.equal(validateRender({ product: 'coconut-lotion', briefId: '../../x' }, { products: PRODUCTS }).ok, false);
});

test('render refuses an unknown product', () => {
  assert.equal(validateRender({ product: 'not-a-product', briefId: 'b1' }, { products: PRODUCTS }).ok, false);
});

test('render refuses a missing briefId', () => {
  assert.equal(validateRender({ product: 'coconut-lotion' }, { products: PRODUCTS }).ok, false);
});

test('a well-formed format-choice request is accepted', () => {
  const r = validateChooseFormat(
    { product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1', formatKey: 'testimonial' },
    { products: PRODUCTS },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.args, { product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1', formatKey: 'testimonial' });
});

test('format-choice refuses a traversal product, brief id, or formatKey', () => {
  assert.equal(validateChooseFormat({ product: '../etc', briefId: 'b1', formatKey: 'testimonial' }, { products: PRODUCTS }).ok, false);
  assert.equal(validateChooseFormat({ product: 'coconut-lotion', briefId: '../../x', formatKey: 'testimonial' }, { products: PRODUCTS }).ok, false);
  assert.equal(validateChooseFormat({ product: 'coconut-lotion', briefId: 'b1', formatKey: '../x' }, { products: PRODUCTS }).ok, false);
});

test('format-choice refuses a missing formatKey', () => {
  assert.equal(validateChooseFormat({ product: 'coconut-lotion', briefId: 'b1' }, { products: PRODUCTS }).ok, false);
});

test('format-choice refuses an unknown product', () => {
  assert.equal(validateChooseFormat({ product: 'nope', briefId: 'b1', formatKey: 'testimonial' }, { products: PRODUCTS }).ok, false);
});

// ── buildAgentArgv ───────────────────────────────────────────────────────────────────
//
// --job-id is threaded through now that agents/ad-brief/index.js accepts one and claims
// its own job file (code review, 2026-08-17) — mirrors ad-studio-launch.js's
// buildAgentArgv(args, jobId) exactly.

test('buildAgentArgv threads --job-id through, mirroring Ad Studio', () => {
  const args = { product: 'coconut-lotion', variant: null, angles: [], dryRun: false };
  assert.deepEqual(buildAgentArgv(args, 'job-1'), ['--product', 'coconut-lotion', '--job-id', 'job-1']);
});

test('buildAgentArgv carries variant, angles and dry-run ahead of --job-id', () => {
  const args = { product: 'coconut-lotion', variant: 'coconut-breeze', angles: ['p1a1', 'p5a3'], dryRun: true };
  assert.deepEqual(buildAgentArgv(args, 'job-2'), [
    '--product', 'coconut-lotion', '--variant', 'coconut-breeze', '--angles', 'p1a1,p5a3', '--dry-run', '--job-id', 'job-2',
  ]);
});

// ── performGenerate: the one-writer contract ────────────────────────────────────────
//
// Before this, performGenerate wrote the child's pid on spawn and its terminal status
// from 'exit'/'error' listeners bound to the in-memory ChildProcess, because
// agents/ad-brief/index.js had no way to claim the job file itself. Code review
// (2026-08-17) found that unsafe: the child is `detached` and `unref()`'d specifically
// so it outlives this process, but a `pm2 restart` (every deploy runs one) kills this
// process's listeners along with it while the child keeps running — nobody was left to
// write the terminal status, so a job that finished correctly sat at 'running' forever.
// Now that the agent accepts --job-id and claims the file itself (see
// tests/agents/ad-brief.test.js), this route writes the job file exactly ONCE, before
// the spawn, and never again — restoring the contract lib/ad-studio-job.js's header
// describes. These tests pin that: no write on a successful spawn, no write on 'exit'.

test('performGenerate writes the job file exactly once and does not write again on a successful spawn', () => {
  const calls = { write: 0, update: 0 };
  const fakeChild = new EventEmitter();
  fakeChild.pid = 4242;
  fakeChild.unref = () => {};
  const deps = {
    findActiveJob: () => null,
    writeJob: () => { calls.write += 1; },
    updateJob: () => { calls.update += 1; },
    spawn: () => fakeChild,
  };

  const result = performGenerate({ product: 'coconut-lotion', variant: null, angles: [], dryRun: false }, deps);
  assert.equal(result.ok, true);
  assert.equal(calls.write, 1, 'the job file must be written exactly once, before the spawn');
  assert.equal(calls.update, 0, 'no follow-up write on a successful spawn — the agent claims the file itself now');
});

test("performGenerate does not write on the child's 'exit' — that would be a second writer", () => {
  const calls = { update: 0 };
  const fakeChild = new EventEmitter();
  fakeChild.pid = 4242;
  fakeChild.unref = () => {};
  const deps = {
    findActiveJob: () => null,
    writeJob: () => {},
    updateJob: () => { calls.update += 1; },
    spawn: () => fakeChild,
  };

  performGenerate({ product: 'coconut-lotion', variant: null, angles: [], dryRun: false }, deps);
  // Simulate the detached child running to completion. Before the fix, this is exactly
  // where the route wrote a terminal status; now nothing here does.
  fakeChild.emit('exit', 0);
  assert.equal(calls.update, 0, "no write on 'exit' — the agent, not the route, owns the terminal status now");
});

test("a spawn failure is still recorded — the ONE write this route keeps, because the child never claimed the file if it never ran", () => {
  const calls = [];
  const fakeChild = new EventEmitter();
  fakeChild.unref = () => {};
  const deps = {
    findActiveJob: () => null,
    writeJob: () => {},
    spawn: () => fakeChild,
    updateJob: (root, jobId, patch) => calls.push({ jobId, patch }),
  };

  const result = performGenerate({ product: 'coconut-lotion', variant: null, angles: [], dryRun: false }, deps);
  fakeChild.emit('error', new Error('spawn node ENOENT'));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].jobId, result.jobId);
  assert.equal(calls[0].patch.status, 'error');
  // Fixed message, not the raw ENOENT text.
  assert.doesNotMatch(calls[0].patch.error, /ENOENT/);
});

// ── performRender: the SAME one-writer contract, pointed at agents/ad-studio/index.js's
// own `--brief` CLI mode instead of agents/ad-brief/index.js. Mirrors performGenerate's
// three tests above exactly — same shape, same reasoning, different spawn target.

test('performRender writes the job file exactly once and does not write again on a successful spawn', () => {
  const calls = { write: 0, update: 0 };
  const fakeChild = new EventEmitter();
  fakeChild.pid = 4242;
  fakeChild.unref = () => {};
  const deps = {
    findActiveJob: () => null,
    writeJob: () => { calls.write += 1; },
    updateJob: () => { calls.update += 1; },
    spawn: () => fakeChild,
  };

  const result = performRender({ product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1' }, deps);
  assert.equal(result.ok, true);
  assert.equal(calls.write, 1, 'the job file must be written exactly once, before the spawn');
  assert.equal(calls.update, 0, 'no follow-up write on a successful spawn — agents/ad-studio/index.js claims the file itself');
});

test("performRender does not write on the child's 'exit' — that would be a second writer", () => {
  const calls = { update: 0 };
  const fakeChild = new EventEmitter();
  fakeChild.pid = 4242;
  fakeChild.unref = () => {};
  const deps = {
    findActiveJob: () => null,
    writeJob: () => {},
    updateJob: () => { calls.update += 1; },
    spawn: () => fakeChild,
  };

  performRender({ product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1' }, deps);
  fakeChild.emit('exit', 0);
  assert.equal(calls.update, 0, "no write on 'exit' — the agent, not the route, owns the terminal status");
});

test('performRender spawns agents/ad-studio/index.js with --brief and --job-id, not agents/ad-brief/index.js', () => {
  let spawnedArgs = null;
  const fakeChild = new EventEmitter();
  fakeChild.pid = 4242;
  fakeChild.unref = () => {};
  const deps = {
    findActiveJob: () => null,
    writeJob: () => {},
    updateJob: () => {},
    spawn: (cmd, args) => { spawnedArgs = args; return fakeChild; },
  };

  performRender({ product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1' }, deps);
  assert.match(spawnedArgs[0], /agents\/ad-studio\/index\.js$/);
  assert.deepEqual(spawnedArgs.slice(1, 3), ['--brief', 'coconut-lotion-p1a1-1']);
  assert.equal(spawnedArgs[3], '--job-id');
});

test('performRender refuses a second launch while one is already active', () => {
  const deps = {
    findActiveJob: () => ({ jobId: 'ad-brief-render-other-1' }),
    writeJob: () => { throw new Error('must not be called'); },
    updateJob: () => {},
    spawn: () => { throw new Error('must not be called'); },
  };

  const result = performRender({ product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1' }, deps);
  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /already in progress/);
});

test("a render spawn failure is still recorded — the ONE write this route keeps", () => {
  const calls = [];
  const fakeChild = new EventEmitter();
  fakeChild.unref = () => {};
  const deps = {
    findActiveJob: () => null,
    writeJob: () => {},
    spawn: () => fakeChild,
    updateJob: (root, jobId, patch) => calls.push({ jobId, patch }),
  };

  const result = performRender({ product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1' }, deps);
  fakeChild.emit('error', new Error('spawn node ENOENT'));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].jobId, result.jobId);
  assert.equal(calls[0].patch.status, 'error');
  assert.doesNotMatch(calls[0].patch.error, /ENOENT/);
});

// ── POST /decide: the missed try/catch (Finding 1, code review 2026-08-17) ─────────
//
// listProductsWithBriefs(ROOT) used to run un-try/catch'd, after this handler's first
// await. lib/ad-brief.js guards each per-entry statSync individually but not the
// readdirSync itself, so an EACCES/EIO/TOCTOU throw there reached lib/router.js's
// dispatch(), which calls handlers without awaiting them — with no 'unhandledRejection'
// handler registered anywhere in the dashboard, that throw would have killed the whole
// shared seo-dashboard PM2 process, not just this one request.

/** Minimal http.ServerResponse stand-in: captures status + body, nothing else. */
function makeRes() {
  const res = { statusCode: null, body: null };
  res.writeHead = (status) => { res.statusCode = status; };
  res.end = (body) => { res.body = body; };
  return res;
}

/** Minimal IncomingMessage stand-in for readJsonBody(req), which registers 'data' then 'end'. */
function makeReq(bodyStr) {
  return {
    on(event, cb) {
      if (event === 'data') cb(Buffer.from(bodyStr));
      if (event === 'end') cb();
      return this;
    },
  };
}

test('the POST /decide handler answers 500 rather than rejecting when listProductsWithBriefs throws', async () => {
  const route = routes.find(r => r.method === 'POST' && r.match === '/api/ad-brief/decide');
  assert.ok(route, 'POST /api/ad-brief/decide route not found');

  const req = makeReq(JSON.stringify({ product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1', state: 'approved' }));
  const res = makeRes();
  const failingCtx = {
    adBriefDeps: {
      listProductsWithBriefs: () => { throw new Error('EACCES: permission denied, scandir \'/data/briefs/ad-studio\''); },
    },
  };

  // The point of the fix: this must resolve, never reject.
  await assert.doesNotReject(() => route.handler(req, res, failingCtx));
  assert.equal(res.statusCode, 500);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.ok, false);
  // No raw exception text, no path — a fixed message only.
  assert.doesNotMatch(parsed.error, /EACCES/);
  assert.doesNotMatch(parsed.error, /scandir/);
  assert.doesNotMatch(parsed.error, /\/data\/briefs/);
});

test('the POST /decide handler still runs normally when listProductsWithBriefs succeeds (ctx carries no override)', async () => {
  const route = routes.find(r => r.method === 'POST' && r.match === '/api/ad-brief/decide');
  // Against the real (empty, in this worktree) briefs directory, an unrecognised product
  // is refused by validateDecide with a clean 400 — proving the try/catch around
  // listProductsWithBriefs doesn't swallow the ordinary, non-throwing path.
  const req = makeReq(JSON.stringify({ product: 'not-a-real-product', briefId: 'x', state: 'approved' }));
  const res = makeRes();
  await route.handler(req, res, {});
  assert.equal(res.statusCode, 400);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.ok, false);
});

// ── POST /api/ad-brief/render — the security boundary, at the handler level ────────
//
// Coordinator fix (2026-08-17). state !== 'approved' is refused BY NAME inside the
// handler itself, not delegated to a caught exception the way /decide's gate failures
// are — because lib/ad-brief.js already guarantees an 'approved' record cannot exist
// without both gates having strictly passed at write time; this route's own job is only
// to check that stored fact and to refuse a null format, never to re-derive the gates.
//
// `readBrief` is stubbed via ctx.adBriefDeps the same way listProductsWithBriefs is
// stubbed for /decide above — these tests are entirely about the handler's OWN state
// and format checks, not about lib/ad-brief.js's storage layer, which tests/lib/ad-brief.test.js
// and agents/ad-studio/index.js's own resolveBriefFormatKey/assertBriefApproved tests
// already cover.

function fakeSpawnableChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.unref = () => {};
  return child;
}

function renderCtx(overrides = {}) {
  return {
    adBriefDeps: {
      listProductsWithBriefs: () => ['coconut-lotion'],
      readBrief: () => ({ state: 'approved', format: { proposed: 'testimonial' } }),
      findActiveJob: () => null,
      writeJob: () => {},
      updateJob: () => {},
      spawn: () => fakeSpawnableChild(),
      ...overrides,
    },
  };
}

test('POST /render launches for an approved brief with a resolvable format', async () => {
  const route = routes.find(r => r.method === 'POST' && r.match === '/api/ad-brief/render');
  assert.ok(route, 'POST /api/ad-brief/render route not found');

  const req = makeReq(JSON.stringify({ product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1' }));
  const res = makeRes();
  await route.handler(req, res, renderCtx());

  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.ok, true);
  assert.ok(parsed.jobId, 'a jobId must be returned so the browser can poll it');
});

test('POST /render refuses a "ready" brief, by name, and never spawns', async () => {
  const route = routes.find(r => r.method === 'POST' && r.match === '/api/ad-brief/render');
  let spawned = false;
  const req = makeReq(JSON.stringify({ product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1' }));
  const res = makeRes();
  await route.handler(req, res, renderCtx({
    readBrief: () => ({ state: 'ready', format: { proposed: 'testimonial' } }),
    spawn: () => { spawned = true; return fakeSpawnableChild(); },
  }));

  assert.equal(res.statusCode, 409);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error, /"ready"/);
  assert.match(parsed.error, /not "approved"/);
  assert.equal(spawned, false, 'a non-approved brief must never reach performRender at all');
});

test('POST /render refuses a "needs-evidence" brief', async () => {
  const route = routes.find(r => r.method === 'POST' && r.match === '/api/ad-brief/render');
  const req = makeReq(JSON.stringify({ product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1' }));
  const res = makeRes();
  await route.handler(req, res, renderCtx({
    readBrief: () => ({ state: 'needs-evidence', format: { proposed: null } }),
  }));

  assert.equal(res.statusCode, 409);
  assert.match(JSON.parse(res.body).error, /"needs-evidence"/);
});

test('POST /render refuses a "rejected" brief and a "rendered" one', async () => {
  const route = routes.find(r => r.method === 'POST' && r.match === '/api/ad-brief/render');
  for (const state of ['rejected', 'rendered']) {
    const req = makeReq(JSON.stringify({ product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1' }));
    const res = makeRes();
    await route.handler(req, res, renderCtx({ readBrief: () => ({ state, format: { proposed: 'testimonial' } }) }));
    assert.equal(res.statusCode, 409, `state "${state}" must be refused`);
  }
});

test('POST /render refuses an approved brief whose resolved format is null', async () => {
  const route = routes.find(r => r.method === 'POST' && r.match === '/api/ad-brief/render');
  const req = makeReq(JSON.stringify({ product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1' }));
  const res = makeRes();
  await route.handler(req, res, renderCtx({
    readBrief: () => ({ state: 'approved', format: { proposed: null, chosen: null } }),
  }));

  assert.equal(res.statusCode, 409);
  assert.match(JSON.parse(res.body).error, /no format to render/);
});

test('POST /render resolves format.chosen over format.proposed — an override with no proposed format still renders', async () => {
  const route = routes.find(r => r.method === 'POST' && r.match === '/api/ad-brief/render');
  const req = makeReq(JSON.stringify({ product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1' }));
  const res = makeRes();
  await route.handler(req, res, renderCtx({
    readBrief: () => ({ state: 'approved', format: { proposed: 'testimonial', chosen: 'manifesto' } }),
  }));

  assert.equal(res.statusCode, 200);
});

test('POST /render refuses a traversal product or brief id before the brief is ever read', async () => {
  const route = routes.find(r => r.method === 'POST' && r.match === '/api/ad-brief/render');
  let readCalled = false;
  const ctx = renderCtx({ readBrief: () => { readCalled = true; return { state: 'approved', format: { proposed: 'testimonial' } }; } });

  const res1 = makeRes();
  await route.handler(makeReq(JSON.stringify({ product: '../etc', briefId: 'b1' })), res1, ctx);
  assert.equal(res1.statusCode, 400);

  const res2 = makeRes();
  await route.handler(makeReq(JSON.stringify({ product: 'coconut-lotion', briefId: '../../x' })), res2, ctx);
  assert.equal(res2.statusCode, 400);

  assert.equal(readCalled, false, 'a traversal id must be refused before the brief is ever read off disk');
});

test('POST /render answers 404 for a brief that does not exist', async () => {
  const route = routes.find(r => r.method === 'POST' && r.match === '/api/ad-brief/render');
  const req = makeReq(JSON.stringify({ product: 'coconut-lotion', briefId: 'coconut-lotion-ghost-1' }));
  const res = makeRes();
  await route.handler(req, res, renderCtx({ readBrief: () => null }));
  assert.equal(res.statusCode, 404);
});

test('POST /render answers 409 when a render or generation job is already active', async () => {
  const route = routes.find(r => r.method === 'POST' && r.match === '/api/ad-brief/render');
  const req = makeReq(JSON.stringify({ product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1' }));
  const res = makeRes();
  await route.handler(req, res, renderCtx({ findActiveJob: () => ({ jobId: 'ad-brief-other-1' }) }));

  assert.equal(res.statusCode, 409);
  assert.match(JSON.parse(res.body).error, /already in progress/);
});

test('POST /render answers 500 rather than rejecting when readBrief throws', async () => {
  const route = routes.find(r => r.method === 'POST' && r.match === '/api/ad-brief/render');
  const req = makeReq(JSON.stringify({ product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1' }));
  const res = makeRes();
  await assert.doesNotReject(() => route.handler(req, res, renderCtx({
    readBrief: () => { throw new Error('EACCES: permission denied'); },
  })));
  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(JSON.parse(res.body).error, /EACCES/);
});

// ── POST /api/ad-brief/format — persists the operator's dropdown choice ────────────

function formatCtx(overrides = {}) {
  return {
    adBriefDeps: {
      listProductsWithBriefs: () => ['coconut-lotion'],
      chooseFormat: () => ({ briefId: 'coconut-lotion-p1a1-1', format: { proposed: 'testimonial', chosen: 'manifesto' } }),
      ...overrides,
    },
  };
}

test('POST /format accepts a well-formed choice', async () => {
  const route = routes.find(r => r.method === 'POST' && r.match === '/api/ad-brief/format');
  assert.ok(route, 'POST /api/ad-brief/format route not found');

  const req = makeReq(JSON.stringify({ product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1', formatKey: 'manifesto' }));
  const res = makeRes();
  await route.handler(req, res, formatCtx());

  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.brief.format.chosen, 'manifesto');
});

test('POST /format refuses a missing formatKey before calling chooseFormat', async () => {
  const route = routes.find(r => r.method === 'POST' && r.match === '/api/ad-brief/format');
  let called = false;
  const req = makeReq(JSON.stringify({ product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1' }));
  const res = makeRes();
  await route.handler(req, res, formatCtx({ chooseFormat: () => { called = true; } }));
  assert.equal(res.statusCode, 400);
  assert.equal(called, false);
});

test('POST /format refuses a traversal product or brief id', async () => {
  const route = routes.find(r => r.method === 'POST' && r.match === '/api/ad-brief/format');
  const res1 = makeRes();
  await route.handler(makeReq(JSON.stringify({ product: '../etc', briefId: 'b1', formatKey: 'manifesto' })), res1, formatCtx());
  assert.equal(res1.statusCode, 400);
  const res2 = makeRes();
  await route.handler(makeReq(JSON.stringify({ product: 'coconut-lotion', briefId: '../../x', formatKey: 'manifesto' })), res2, formatCtx());
  assert.equal(res2.statusCode, 400);
});

// lib/ad-brief.js's chooseFormat is the one that actually decides whether a key is
// valid for this brief (tests/lib/ad-brief.test.js covers that fully); this route's
// only job on a rejection is to translate the throw into a FIXED string, per rule 2 —
// never the exception's own message, which can name the rejected key.
test('POST /format translates a chooseFormat rejection into a fixed 400, never the raw message', async () => {
  const route = routes.find(r => r.method === 'POST' && r.match === '/api/ad-brief/format');
  const req = makeReq(JSON.stringify({ product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1', formatKey: 'ingredient-callout' }));
  const res = makeRes();
  await route.handler(req, res, formatCtx({
    chooseFormat: () => {
      throw new Error('ad-brief: "ingredient-callout" is not a format available to "coconut-lotion-p1a1-1" — must be one of: testimonial, manifesto');
    },
  }));

  assert.equal(res.statusCode, 400);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.ok, false);
  assert.doesNotMatch(parsed.error, /ingredient-callout/);
});

test('POST /format answers 500 rather than rejecting when listProductsWithBriefs throws', async () => {
  const route = routes.find(r => r.method === 'POST' && r.match === '/api/ad-brief/format');
  const req = makeReq(JSON.stringify({ product: 'coconut-lotion', briefId: 'coconut-lotion-p1a1-1', formatKey: 'manifesto' }));
  const res = makeRes();
  await assert.doesNotReject(() => route.handler(req, res, formatCtx({
    listProductsWithBriefs: () => { throw new Error('EACCES: permission denied'); },
  })));
  assert.equal(res.statusCode, 500);
  assert.doesNotMatch(JSON.parse(res.body).error, /EACCES/);
});
