import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import routes, { validateLaunch, buildAgentArgv, performLaunch, MAX_RENDERS_CEILING } from '../../agents/dashboard/routes/ad-studio-launch.js';
import { writeJob, readJob, findActiveJob } from '../../lib/ad-studio-job.js';
import { createJobReporter } from '../../agents/ad-studio/index.js';

const FORMATS = [{ key: 'manifesto' }, { key: 'us-vs-them' }, { key: 'testimonial' }];
const PRODUCTS = [{ handle: 'coconut-lotion' }, { handle: 'coconut-oil-deodorant' }];
const VARIANTS = { 'coconut-lotion': ['coconut-breeze', 'unscented'], 'coconut-oil-deodorant': [] };
const ctx = {
  formats: FORMATS,
  manifestProducts: PRODUCTS,
  variantsFor: (p) => VARIANTS[p.handle] || [],
};

const good = { product: 'coconut-lotion', formats: ['manifesto'], variations: 1, targets: 'meta', maxRenders: 120 };

test('a well-formed request is accepted and normalised', () => {
  const r = validateLaunch(good, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.args.product, 'coconut-lotion');
  assert.deepEqual(r.args.formats, ['manifesto']);
  assert.equal(r.args.variant, null);
  assert.equal(r.args.dryRun, false);
});

test('an unknown product is refused', () => {
  const r = validateLaunch({ ...good, product: 'not-a-product' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /product/i);
});

// The browser's format list is a convenience. The authority is here — a client that
// posts a format that does not exist must not reach a spawn.
test('an unknown format is refused and named', () => {
  const r = validateLaunch({ ...good, formats: ['manifesto', 'invented-format'] }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /invented-format/);
});

// The single most expensive default in the CLI, deliberately inverted in the UI: the
// cheapest action is the one you get by accident.
test('no formats is refused rather than meaning all of them', () => {
  assert.equal(validateLaunch({ ...good, formats: [] }, ctx).ok, false);
});

// ── variant: the one client field that reaches the filesystem ───────────────────────
//
// It lands in `data/product-images/<imageDir>/<variant>` (readdirSync'd, and the photos
// found there are sent to the image model as product references) and in the run id, which
// is mkdir'd under data/creatives/ad-studio/ as root. It was taken straight from the
// request body while the module's own docstring claimed every field was re-validated.

test('a variant the product actually has is accepted', () => {
  const r = validateLaunch({ ...good, variant: 'coconut-breeze' }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.args.variant, 'coconut-breeze');
});

test('a variant the product does not have is refused', () => {
  const r = validateLaunch({ ...good, variant: 'pumpkin-spice' }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /variant/i);
});

test('a traversal in the variant is refused, and never echoed back', () => {
  for (const attempt of ['../../../../etc/ssl/certs', '../../../../tmp/x', '..']) {
    const r = validateLaunch({ ...good, variant: attempt }, ctx);
    assert.equal(r.ok, false, `"${attempt}" must not validate`);
    assert.doesNotMatch(r.error, /\.\./, 'the refusal must not reflect the submitted path back into the page');
  }
});

test('a product with no variant subdirectories refuses any variant at all', () => {
  const r = validateLaunch(
    { ...good, product: 'coconut-oil-deodorant', variant: 'anything' }, ctx,
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /no variants/i);
});

test('no variant stays legal — most products have none', () => {
  assert.equal(validateLaunch(good, ctx).args.variant, null);
  assert.equal(validateLaunch({ ...good, variant: '' }, ctx).args.variant, null);
});

test('variations must be a whole number in 1..10', () => {
  assert.equal(validateLaunch({ ...good, variations: 0 }, ctx).ok, false);
  assert.equal(validateLaunch({ ...good, variations: 11 }, ctx).ok, false);
  assert.equal(validateLaunch({ ...good, variations: 2.5 }, ctx).ok, false);
  assert.equal(validateLaunch({ ...good, variations: 10 }, ctx).ok, true);
});

test('targets must be one of the two offered sets', () => {
  assert.equal(validateLaunch({ ...good, targets: 'all' }, ctx).ok, true);
  assert.equal(validateLaunch({ ...good, targets: 'demand-gen=1:1' }, ctx).ok, false);
});

// The ceiling is enforced here regardless of what the form sends. A launch button on
// a publicly reachable URL is categorically different from every other route on it.
test('maxRenders is clamped to the ceiling, never trusted upward', () => {
  assert.equal(validateLaunch({ ...good, maxRenders: 5000 }, ctx).args.maxRenders, MAX_RENDERS_CEILING);
  assert.equal(validateLaunch({ ...good, maxRenders: 6 }, ctx).args.maxRenders, 6);
  assert.equal(validateLaunch({ ...good, maxRenders: 0 }, ctx).ok, false);
});

test('a run whose expected renders exceed its own ceiling is refused before it starts', () => {
  // 3 formats x 10 variations x meta = 30 concepts x 6 = 180 expected, over a ceiling of 20.
  const r = validateLaunch(
    { ...good, formats: ['manifesto', 'us-vs-them', 'testimonial'], variations: 10, maxRenders: 20 },
    ctx,
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /expected/i);
});

test('the plan carries the cost estimate the operator was shown', () => {
  const r = validateLaunch(good, ctx);
  assert.equal(r.args.plan.expected, 6);
  assert.equal(r.args.plan.expectedUsd, 0.78);
  assert.equal(r.args.plan.worstCase, 12);
});

test('a dry run is allowed with no ceiling argument at all', () => {
  const r = validateLaunch({ ...good, dryRun: true, maxRenders: undefined }, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.args.dryRun, true);
});

// ── buildAgentArgv ───────────────────────────────────────────────────────────────────

test('argv is built from validated args only', () => {
  const { args } = validateLaunch({ ...good, variant: 'coconut-breeze' }, ctx);
  assert.deepEqual(buildAgentArgv(args, 'job-1'), [
    '--product', 'coconut-lotion',
    '--variant', 'coconut-breeze',
    '--formats', 'manifesto',
    '--targets', 'meta',
    '--variations', '1',
    '--max-renders', '120',
    '--job-id', 'job-1',
  ]);
});

test('a dry run passes --dry-run and no render ceiling', () => {
  const { args } = validateLaunch({ ...good, dryRun: true }, ctx);
  const argv = buildAgentArgv(args, 'job-2');
  assert.ok(argv.includes('--dry-run'));
  assert.equal(argv.includes('--max-renders'), false);
});

test('a variant is omitted entirely when there is none', () => {
  const { args } = validateLaunch(good, ctx);
  assert.equal(buildAgentArgv(args, 'job-3').includes('--variant'), false);
});

// ── performLaunch / POST handler failure paths ──────────────────────────────────────
//
// Code review finding (2026-08-17): the POST /launch handler had no try/catch around
// findActiveJob/writeJob/spawn. lib/router.js's dispatch() calls this async handler
// without awaiting or .catch()-ing it, and the dashboard registers no
// 'unhandledRejection' handler, so a throw here — most realistically writeJob hitting
// ENOSPC, which has already cost this project four days of cron once — would kill the
// single shared seo-dashboard PM2 process for every tab, not just Ad Studio.
//
// Fixed by splitting the findActiveJob/writeJob/spawn sequence into performLaunch(),
// which the handler now calls inside a try/catch, and by threading `ctx.adStudioDeps`
// (the router already passes a ctx argument to every handler) through as an injectable
// override so these two failure paths are reachable without a real full disk or a
// missing `node` binary.

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

// This exercises the REAL route handler against the REAL product manifest and REAL
// FORMATS (unlike the tests above, which inject a fake ctx into validateLaunch) — so
// `good` has to be a request that is actually valid today: 'coconut-lotion' is a real
// RSC product handle and 'manifesto' a real format key.

// C1, the expensive one. A run is in its COPY stage: the agent has claimed the job file
// at boot (status running, its own pid) but has no runId yet, because buildConcepts is a
// sequential Anthropic call per format and takes minutes. This test builds that state
// through the real reporter and the real job lib, then asks the real findActiveJob about
// it — nothing is stubbed except the clock's worth of elapsed time (the job is written
// ten minutes old, well past the 60s pending grace) and the spawn.
//
// Before the fix the agent did not claim until after buildConcepts, so this same moment
// returned no active job and a second Render click spawned a second paid agent: ~$15.60
// twice over.
test('a second launch is refused while a run is in its copy stage', () => {
  const root = mkdtempSync(join(tmpdir(), 'ad-studio-launch-'));
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  // What the route writes, once, at launch.
  writeJob(root, { jobId: 'coconut-lotion-1', status: 'pending', createdAt: tenMinutesAgo, pid: null, plan: { expected: 6 } });
  // What the agent does immediately after parseArgs, before any network call.
  createJobReporter({ root, jobId: 'coconut-lotion-1' }).start({ pid: process.pid });

  const claimed = readJob(root, 'coconut-lotion-1');
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.runId, undefined, 'sanity: the copy stage has produced no run id yet');
  assert.deepEqual(claimed.plan, { expected: 6 }, 'the cost plan survives the claim');

  const { args } = validateLaunch(good, ctx);
  let spawned = 0;
  const result = performLaunch(args, {
    findActiveJob: () => findActiveJob(root),
    writeJob: () => { throw new Error('a refused launch must not write a second job file'); },
    spawn: () => { spawned += 1; throw new Error('a refused launch must not spawn a second paid agent'); },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.match(result.error, /already in progress/);
  assert.equal(spawned, 0);
});

test('performLaunch propagates a writeJob failure rather than swallowing it', () => {
  const { args } = validateLaunch(good, ctx);
  const deps = {
    findActiveJob: () => null,
    writeJob: () => { throw new Error('ENOSPC: no space left on device, write'); },
  };
  assert.throws(() => performLaunch(args, deps), /ENOSPC/);
});

test('the POST /launch handler answers 500 rather than rejecting when the launch step throws', async () => {
  const route = routes.find(r => r.method === 'POST' && r.match === '/api/ad-studio/launch');
  assert.ok(route, 'POST /api/ad-studio/launch route not found');

  const req = makeReq(JSON.stringify(good));
  const res = makeRes();
  const failingCtx = {
    adStudioDeps: {
      findActiveJob: () => null,
      writeJob: () => { throw new Error('ENOSPC: no space left on device, write'); },
    },
  };

  // The point of the fix: this must resolve, never reject.
  await assert.doesNotReject(() => route.handler(req, res, failingCtx));
  assert.equal(res.statusCode, 500);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.ok, false);
  // No raw exception text, no ENOSPC, no path, no stack — a fixed message only.
  assert.doesNotMatch(parsed.error, /ENOSPC/);
  assert.doesNotMatch(parsed.error, /no space left/i);
});

test('a run still launches normally when performLaunch succeeds (ctx carries no override)', async () => {
  const route = routes.find(r => r.method === 'POST' && r.match === '/api/ad-studio/launch');
  const req = makeReq(JSON.stringify(good));
  const res = makeRes();
  const calls = [];
  const okCtx = {
    adStudioDeps: {
      findActiveJob: () => null,
      writeJob: (root, job) => { calls.push(job); },
      spawn: () => { const child = new EventEmitter(); child.unref = () => {}; return child; },
    },
  };
  await route.handler(req, res, okCtx);
  assert.equal(res.statusCode, 200);
  const parsed = JSON.parse(res.body);
  assert.equal(parsed.ok, true);
  assert.equal(calls.length, 1, 'writeJob should be called exactly once');
});

// ── spawn's 'error' event ────────────────────────────────────────────────────────────
//
// Node treats an unhandled 'error' event on a ChildProcess as a throw — the same
// process-killing failure as above, just async (e.g. ENOENT: no `node` on PATH). The
// fix attaches a listener that records the failure on the job file via updateJob
// instead of leaving the job stuck 'pending' forever, and wraps that write so the
// listener itself cannot throw if the job file is *also* broken.

test('a spawn failure is recorded on the job file rather than left silently pending', () => {
  const { args } = validateLaunch(good, ctx);
  const calls = [];
  const fakeChild = new EventEmitter();
  fakeChild.unref = () => {};
  const deps = {
    findActiveJob: () => null,
    writeJob: () => {},
    spawn: () => fakeChild,
    updateJob: (root, jobId, patch) => { calls.push({ jobId, patch }); },
  };

  const result = performLaunch(args, deps);
  assert.equal(result.ok, true);

  fakeChild.emit('error', new Error('spawn node ENOENT'));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].jobId, result.jobId);
  assert.equal(calls[0].patch.status, 'error');
  // Fixed message, not the raw ENOENT text.
  assert.doesNotMatch(calls[0].patch.error, /ENOENT/);
});

test("the child 'error' listener cannot itself throw even if updateJob is also broken", () => {
  const { args } = validateLaunch(good, ctx);
  const fakeChild = new EventEmitter();
  fakeChild.unref = () => {};
  const deps = {
    findActiveJob: () => null,
    writeJob: () => {},
    spawn: () => fakeChild,
    updateJob: () => { throw new Error('job file is also broken'); },
  };

  performLaunch(args, deps);

  // EventEmitter re-throws synchronously out of emit() if a listener throws and is not
  // itself caught — this proves the internal try/catch, not just that a listener exists.
  assert.doesNotThrow(() => fakeChild.emit('error', new Error('spawn node ENOENT')));
});
