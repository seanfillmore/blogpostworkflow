import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import routes, { validateDecide, validateGenerate, buildAgentArgv, performGenerate } from '../../agents/dashboard/routes/ad-brief.js';

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
