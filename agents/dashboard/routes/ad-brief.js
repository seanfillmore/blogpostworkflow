// agents/dashboard/routes/ad-brief.js
//
// The four HTTP entry points onto the ad-BRIEF stage: list what exists, generate more,
// and decide what happens to one. Sibling to routes/ad-studio-launch.js, which owns the
// equivalent surface for Ad Studio renders — this module follows its shape on purpose:
//
//   1. Every path segment is validated BEFORE it can reach the filesystem. `product` and
//      `briefId` both flow into lib/ad-brief.js's briefPath()/briefsDir(), which throw an
//      Error whose message contains the raw, possibly attacker-supplied segment (see that
//      module's checkSegment). isValidBriefId() is the same safe-segment test briefPath()
//      uses internally, so calling it here first means a bad segment is refused with a
//      fixed string and never reaches a function that would embed it in a thrown message.
//   2. Every error string returned to the client is fixed. Never an exception's
//      `.message`, never a filesystem path, never a client-supplied value echoed back —
//      see decideBrief's handler below for the specific case this guards against.
//   3. The whole handler body is wrapped in try/catch. lib/router.js's dispatch() calls
//      handlers without awaiting them and nothing in this process registers
//      `unhandledRejection`, so an unguarded throw here would take down the entire shared
//      `seo-dashboard` PM2 process, not just this tab. This is a "whole body" rule, not a
//      "the obvious part" rule — /decide's own listProductsWithBriefs(ROOT) call sits
//      after this handler's first await and was missed once already (code review,
//      2026-08-17); see that handler for the fix.
//   4. Generation is a long job that outlives the request, so it reuses the SAME job-file
//      mechanism as Ad Studio (lib/ad-studio-job.js) — same one-run-at-a-time guard via
//      findActiveJob (deliberately SHARED with Ad Studio's renders, not partitioned by
//      kind — see performGenerate()'s docstring for why), same detached spawn, same
//      ONE-WRITER contract: this route writes the job file once and only reads it after,
//      exactly like ad-studio-launch.js, because agents/ad-brief/index.js now claims its
//      own job file via --job-id the same way agents/ad-studio/index.js does.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  listBriefs, decideBrief, listProductsWithBriefs, isValidBriefId, BRIEF_STATES,
} from '../../../lib/ad-brief.js';
import { writeJob, updateJob, findActiveJob, isValidJobId } from '../../../lib/ad-studio-job.js';
import { respondJson, respondError, readJsonBody } from '../lib/responses.js';
import { ROOT, PRODUCT_MANIFEST_PATH } from '../lib/paths.js';

/**
 * The catalog products a brief can be generated for. Deliberately re-read here rather
 * than imported from routes/ad-studio-launch.js — that module doesn't export it, and this
 * is plain data (a filtered read of the product-images manifest), not a gate, so there is
 * nothing wrong with each route module holding its own copy the way ad-studio-launch.js
 * does. Culina is a separate brand on a separate site and never gets an RSC ad.
 */
function manifestProducts() {
  try {
    const raw = JSON.parse(readFileSync(PRODUCT_MANIFEST_PATH, 'utf8'));
    const list = Array.isArray(raw) ? raw : (raw.products || []);
    return list.filter(p => !/culina|cast iron/i.test(`${p.handle} ${p.title || ''}`));
  } catch {
    return [];
  }
}

/**
 * The only place a decide request is trusted. Returns normalised args or a reason.
 *
 * `product` and `briefId` are both checked with isValidBriefId — the same safe-segment
 * test lib/ad-brief.js's own briefPath()/briefsDir() apply internally — BEFORE either one
 * reaches decideBrief(), so a traversal attempt is refused here with a fixed string
 * instead of reaching a function that would embed it in a thrown Error message.
 *
 * `deps.products` is the set of handles a decision may target. The route passes
 * `listProductsWithBriefs(ROOT)` — a decision only ever makes sense for a product that
 * already has at least one brief on disk — so this function stays testable against a
 * synthetic list without touching the real briefs directory.
 */
export function validateDecide(body = {}, { products = [] } = {}) {
  const bad = (error) => ({ ok: false, error });

  const product = String(body.product || '').trim();
  if (!product || !isValidBriefId(product)) return bad('a valid product handle is required');

  const briefId = String(body.briefId || '').trim();
  if (!briefId || !isValidBriefId(briefId)) return bad('a valid brief id is required');

  const state = String(body.state || '').trim();
  if (!BRIEF_STATES.includes(state)) return bad(`state must be one of: ${BRIEF_STATES.join(', ')}`);

  const entry = products.find(p => p.handle === product);
  if (!entry) return bad('unknown product');

  const note = body.note === undefined ? undefined : String(body.note);

  return { ok: true, args: { product, briefId, state, note } };
}

/**
 * The only place a generate request is trusted. Returns normalised args or a reason.
 *
 * `angles` is a whitelist-shaped check, not a sanitiser: each entry must pass the same
 * safe-segment test as a product or brief id, because it ends up embedded in a brief id
 * (buildBriefId() in agents/ad-brief/index.js joins `${product}-${angleId}-${now}`) which
 * is in turn a filename. A malformed angle id fails closed here rather than reaching
 * that join.
 */
export function validateGenerate(body = {}, { products = [] } = {}) {
  const bad = (error) => ({ ok: false, error });

  const product = String(body.product || '').trim();
  if (!product || !isValidBriefId(product)) return bad('a valid product handle is required');
  const entry = products.find(p => p.handle === product);
  if (!entry) return bad('unknown product');

  const variant = body.variant ? String(body.variant).trim() : null;
  if (variant && !isValidBriefId(variant)) return bad('invalid variant');

  let angles = [];
  if (body.angles !== undefined) {
    if (!Array.isArray(body.angles)) return bad('angles must be a list of angle ids');
    angles = body.angles.map(a => String(a).trim()).filter(Boolean);
    if (angles.some(a => !isValidBriefId(a))) return bad('invalid angle id');
  }

  const dryRun = Boolean(body.dryRun);

  return { ok: true, args: { product, variant, angles, dryRun } };
}

/**
 * Built from validated args only — nothing from the request body reaches argv directly.
 *
 * `jobId` is threaded through last, mirroring routes/ad-studio-launch.js's
 * buildAgentArgv(args, jobId): agents/ad-brief/index.js now accepts --job-id (added
 * alongside this route in the same review pass) and claims the job file itself at boot,
 * before any network call — see that file's parseArgs and main() for the claim.
 */
export function buildAgentArgv(args, jobId) {
  const argv = ['--product', args.product];
  if (args.variant) argv.push('--variant', args.variant);
  if (args.angles && args.angles.length) argv.push('--angles', args.angles.join(','));
  if (args.dryRun) argv.push('--dry-run');
  argv.push('--job-id', jobId);
  return argv;
}

/**
 * The concurrency check, the job-file write, and the spawn — the ONE-WRITER contract
 * lib/ad-studio-job.js's header describes, same as routes/ad-studio-launch.js's
 * performLaunch(): this route writes the job file exactly once, before the spawn, and
 * only ever reads it afterwards. agents/ad-brief/index.js claims it (pid, status
 * 'running') the moment it boots and writes its own terminal status — the same
 * createJobReporter Ad Studio's agent uses, imported there rather than reimplemented.
 *
 * This used to be different: before agents/ad-brief/index.js accepted --job-id, this
 * function wrote the child's pid and terminal status itself, from 'exit'/'error'
 * listeners bound to the in-memory ChildProcess. Code review on 2026-08-17 found the
 * failure mode that made that unsafe — the child is spawned `detached` and `unref()`'d
 * specifically so it outlives this process, but a `pm2 restart` (every deploy runs one)
 * kills this process's listeners along with it while the child keeps running. Nobody was
 * left to write the terminal status, so a job that actually finished correctly sat at
 * 'running' forever. Restoring the one-writer contract removes that failure mode instead
 * of working around it.
 *
 * The child's 'error' listener is the one write that stays here, and it does NOT violate
 * the contract above: it only fires when spawn() itself fails synchronously or
 * asynchronously (e.g. ENOENT: no `node` on PATH) — cases in which the child process
 * never ran at all, so it never had the chance to claim the job file. There is no writer
 * to conflict with, only a launch that needs to be reported as failed rather than left at
 * 'pending' forever.
 *
 * `findActiveJob` is shared with Ad Studio's renders on purpose (not partitioned by
 * `kind`): this box is 1 vCPU with ~430 MB free, and a brief-generation batch (many
 * sequential Anthropic calls) running at the same time as an Ad Studio render
 * (Anthropic + Gemini) would only slow each other down, not actually parallelise.
 */
export function performGenerate(args, deps = {}) {
  const {
    findActiveJob: findActiveJobFn = findActiveJob,
    writeJob: writeJobFn = writeJob,
    updateJob: updateJobFn = updateJob,
    spawn: spawnFn = spawn,
  } = deps;

  const active = findActiveJobFn(ROOT);
  if (active) {
    return { ok: false, status: 409, error: `a run is already in progress (${active.jobId}) — wait for it or cancel it first` };
  }

  const jobId = `ad-brief-${args.product}-${Date.now()}`;
  if (!isValidJobId(jobId)) return { ok: false, status: 400, error: 'could not build a safe job id' };

  // Written ONCE, here. The agent owns this file from the moment it boots.
  writeJobFn(ROOT, {
    jobId, status: 'pending', kind: 'ad-brief', createdAt: new Date().toISOString(),
    args, runId: null, pid: null, events: [], totals: null, error: null,
  });

  const child = spawnFn('node', [join(ROOT, 'agents/ad-brief/index.js'), ...buildAgentArgv(args, jobId)], {
    cwd: ROOT, detached: true, stdio: 'ignore',
  });

  // See this function's docstring: the ONE case this route still writes for itself,
  // because the child never claimed the file if it never started.
  child.on('error', () => {
    try { updateJobFn(ROOT, jobId, { status: 'error', error: 'failed to start the brief generation process' }); } catch { /* the job file itself may be what's broken */ }
  });

  child.unref();
  return { ok: true, jobId };
}

export default [
  // GET /api/ad-brief/products — products that already have briefs, unioned with the
  // catalog products a brief can be generated for, so the dashboard never has to make a
  // second round trip to know which handle to offer next.
  {
    method: 'GET',
    match: '/api/ad-brief/products',
    handler(req, res) {
      try {
        const manifest = manifestProducts();
        const withBriefs = new Set(listProductsWithBriefs(ROOT));
        const products = manifest.map(p => ({
          handle: p.handle,
          title: p.title || p.handle,
          hasBriefs: withBriefs.has(p.handle),
        }));
        // A product that has briefs on disk but has since dropped out of the manifest
        // (discontinued, renamed) still needs to be visible — a catalog change shouldn't
        // hide a decision that was already made about it.
        const manifestHandles = new Set(manifest.map(p => p.handle));
        for (const handle of withBriefs) {
          if (!manifestHandles.has(handle)) products.push({ handle, title: handle, hasBriefs: true });
        }
        respondJson(res, { ok: true, products });
      } catch {
        respondError(res, 500, 'failed to load ad-brief products');
      }
    },
  },

  // GET /api/ad-brief/list?product=<handle> — ranked briefs for one product.
  {
    method: 'GET',
    match: (url) => url.split('?')[0] === '/api/ad-brief/list',
    handler(req, res) {
      try {
        const urlObj = new URL(req.url, 'http://localhost');
        const product = (urlObj.searchParams.get('product') || '').trim();
        if (!product || !isValidBriefId(product)) return respondError(res, 400, 'a valid product handle is required');
        const briefs = listBriefs(ROOT, product);
        respondJson(res, { ok: true, product, briefs });
      } catch {
        respondError(res, 500, 'failed to load briefs');
      }
    },
  },

  // POST /api/ad-brief/generate — spawn agents/ad-brief/index.js detached, same
  // one-run-at-a-time guard and job-file mechanism as Ad Studio's launch route.
  {
    method: 'POST',
    match: '/api/ad-brief/generate',
    async handler(req, res, ctx) {
      let body;
      try { body = await readJsonBody(req); } catch { return respondError(res, 400, 'bad JSON body'); }

      const verdict = validateGenerate(body, { products: manifestProducts() });
      if (!verdict.ok) return respondError(res, 400, verdict.error);

      // findActiveJob/writeJob/spawn are all synchronous fs or process calls that can
      // throw — most realistically writeJob hitting ENOSPC (see CLAUDE.md's disk-budget
      // history). dispatch() in lib/router.js calls this async handler without awaiting
      // or .catch()-ing it and nothing here registers an `unhandledRejection` handler, so
      // an uncaught throw would take down the whole shared seo-dashboard PM2 process, not
      // just this tab. Answer a fixed 500 instead; never echo the exception.
      let result;
      try {
        result = performGenerate(verdict.args, ctx?.adBriefDeps);
      } catch {
        return respondError(res, 500, 'failed to launch brief generation — check server disk space and logs');
      }

      if (!result.ok) return respondError(res, result.status, result.error);
      respondJson(res, { ok: true, jobId: result.jobId });
    },
  },

  // POST /api/ad-brief/decide — { product, briefId, state, note } -> decideBrief.
  {
    method: 'POST',
    match: '/api/ad-brief/decide',
    async handler(req, res, ctx) {
      let body;
      try { body = await readJsonBody(req); } catch { return respondError(res, 400, 'bad JSON body'); }

      // listProductsWithBriefs() reads a directory (readdirSync); lib/ad-brief.js guards
      // each per-entry statSync individually but not the readdirSync itself, so an
      // EACCES, an EIO, or a TOCTOU race between its own existsSync and the read that
      // follows reaches here as a throw. This sits after the handler's first await —
      // exactly the shape lib/router.js's dispatch() cannot catch (it calls handlers
      // without awaiting them, and nothing here registers 'unhandledRejection'), so an
      // unguarded throw would kill the whole shared seo-dashboard process rather than
      // fail this one request. Code review, 2026-08-17.
      const listProductsWithBriefsFn = ctx?.adBriefDeps?.listProductsWithBriefs || listProductsWithBriefs;
      let knownProducts;
      try {
        knownProducts = listProductsWithBriefsFn(ROOT).map(handle => ({ handle }));
      } catch {
        return respondError(res, 500, 'failed to load known products');
      }

      const verdict = validateDecide(body, { products: knownProducts });
      if (!verdict.ok) return respondError(res, 400, verdict.error);

      // decideBrief() enforces the approval invariant itself (both gates strictly
      // passing) and this route must not attempt to re-implement or relax that — it only
      // translates a throw into a response. The thrown message can name which gate
      // failed or which brief id was rejected (see lib/ad-brief.js's decideBrief
      // docstring) — useful on a terminal, not safe to hand back over HTTP verbatim per
      // this task's security note, so it never reaches respondError.
      try {
        const brief = decideBrief(ROOT, verdict.args.product, verdict.args.briefId, {
          state: verdict.args.state, note: verdict.args.note,
        });
        respondJson(res, { ok: true, brief });
      } catch {
        respondError(res, 409, 'that brief could not be moved to the requested state — check its gates and current state');
      }
    },
  },
];
