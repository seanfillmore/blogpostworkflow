// agents/dashboard/routes/ad-brief.js
//
// The HTTP entry points onto the ad-BRIEF stage: list the products and whether each one is
// briefable at all, plan what a generation would cost, list what exists, generate more,
// decide what happens to one, choose which of its alternative formats it renders with, and
// render an approved one. Sibling to routes/ad-studio-launch.js, which owns the equivalent
// surface for Ad Studio's own product-mode renders — this module follows its shape on
// purpose:
//
// /render and /format were added after Task 6 shipped the Briefs view: the view's own
// action list (Render, plus a format-override dropdown) always included both, but
// Task 5's route table never built the endpoints behind them — a plan inconsistency,
// not a scope cut, caught in review rather than shipped as a half flow. /render reuses
// agents/ad-studio/index.js's existing `--brief` CLI mode (added in Task 4, for exactly
// this) rather than adding a second render path; /format writes through lib/ad-brief.js
// so the approval invariant it protects is not something this route has to re-derive.
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
  readBrief, chooseFormat, selectableFormats,
} from '../../../lib/ad-brief.js';
// The SAME cluster and relevance logic agents/ad-brief/index.js acts on, not a second copy
// of it — see lib/ad-brief-plan.js's header for why it is a lib rather than an import of
// the agent (which would pull Anthropic, @google/genai and sharp into this one PM2 process).
import { clusterCoverage, planBriefs } from '../../../lib/ad-brief-plan.js';
// Pure fs + string work, no Anthropic/@google/genai/sharp — safe in this single PM2 process.
import { loadGiveaway } from '../../../lib/giveaway-claim-source.js';
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
 * The persona file the cluster guard is judged against. Missing or corrupt returns null,
 * which clusterCoverage() reads as "no cluster" and refuses every product for — the right
 * failure: no personas means no evidence means nothing is briefable, which is exactly what
 * the operator needs to be told.
 */
function personasData() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'data', 'context', 'personas.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The longest note a decision may carry. A note is free text typed by an operator and
 * written verbatim into a brief JSON file that the Briefs tab re-reads on every load, so an
 * uncapped one is an unbounded write behind a single authenticated POST. 2,000 characters is
 * far more than the "why I rejected this angle" this field exists for and still bounded.
 */
export const MAX_NOTE_LENGTH = 2000;

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

  // Capped, not truncated: silently storing half an operator's sentence is worse than
  // telling them it was too long. See MAX_NOTE_LENGTH.
  let note;
  if (body.note !== undefined) {
    note = String(body.note);
    if (note.length > MAX_NOTE_LENGTH) return bad(`note must be ${MAX_NOTE_LENGTH} characters or fewer`);
  }

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
  const argv = ['--product', argvValue(args.product)];
  if (args.variant) argv.push('--variant', argvValue(args.variant));
  if (args.angles && args.angles.length) argv.push('--angles', argvValue(args.angles.join(',')));
  if (args.dryRun) argv.push('--dry-run');
  argv.push('--job-id', argvValue(jobId));
  return argv;
}

/**
 * A value that would be read as a flag never reaches argv.
 *
 * The validators above already refuse a leading dash (lib/ad-brief.js's checkSegment), so
 * this cannot fire on the real path — it is here because argv position is the thing that
 * broke and this is the function that builds argv. `{angles: ["--job-id"]}` used to pass
 * every check, shift the argument list by one, and make the agent claim a job file named
 * `--job-id.json` while the route's real job stayed 'pending' — after the 60s pending grace
 * a second click then launched a second PAID batch. Throws rather than filters: a request
 * that reaches here with a flag-shaped value is a validator that has regressed, and
 * quietly dropping the value would hide it. (Code review, 2026-08-17.)
 */
function argvValue(value) {
  const s = String(value);
  if (s.startsWith('-')) {
    throw new Error('ad-brief route: refusing to pass a value that starts with "-" as a CLI argument');
  }
  return s;
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

/**
 * The only place a render request is trusted. Returns normalised args or a reason.
 *
 * Shape mirrors validateDecide exactly (both take `{product, briefId}` and check them
 * against the same `deps.products` allowlist) — render has no extra fields, because the
 * decision of WHAT to render already lives on the brief record itself (state, and
 * format.chosen/proposed), not in this request body.
 */
export function validateRender(body = {}, { products = [] } = {}) {
  const bad = (error) => ({ ok: false, error });

  const product = String(body.product || '').trim();
  if (!product || !isValidBriefId(product)) return bad('a valid product handle is required');

  const briefId = String(body.briefId || '').trim();
  if (!briefId || !isValidBriefId(briefId)) return bad('a valid brief id is required');

  const entry = products.find(p => p.handle === product);
  if (!entry) return bad('unknown product');

  return { ok: true, args: { product, briefId } };
}

/**
 * The only place a format-choice request is trusted. Returns normalised args or a
 * reason. `formatKey` is checked for shape only (a safe segment, non-empty) — whether
 * it is actually one of THIS brief's own proposed/alternative formats is lib/ad-brief.js's
 * chooseFormat()'s job, not this route's; that check needs the brief record, which this
 * function deliberately never reads (same reason validateDecide doesn't reach into the
 * brief record — it wants to stay testable against a synthetic product list, and the
 * value check belongs where the source of truth for "valid formats for this brief"
 * lives).
 */
export function validateChooseFormat(body = {}, { products = [] } = {}) {
  const bad = (error) => ({ ok: false, error });

  const product = String(body.product || '').trim();
  if (!product || !isValidBriefId(product)) return bad('a valid product handle is required');

  const briefId = String(body.briefId || '').trim();
  if (!briefId || !isValidBriefId(briefId)) return bad('a valid brief id is required');

  const formatKey = String(body.formatKey || '').trim();
  if (!formatKey || !isValidBriefId(formatKey)) return bad('a valid formatKey is required');

  const entry = products.find(p => p.handle === product);
  if (!entry) return bad('unknown product');

  return { ok: true, args: { product, briefId, formatKey } };
}

/**
 * The concurrency check, the job-file write, and the spawn for a BRIEF RENDER — same
 * one-writer contract as performGenerate above, just pointed at
 * agents/ad-studio/index.js's own `--brief` CLI mode (Task 4) instead of
 * agents/ad-brief/index.js. `findActiveJob` is the SAME shared guard performGenerate
 * uses (not partitioned by kind) for the identical reason: this box has one CPU and
 * ~430 MB free, and a render (Anthropic + Gemini) running alongside a brief-generation
 * batch (many sequential Anthropic calls) would only slow each other down.
 *
 * Deliberately does NOT re-check approval or format here — the route handler already
 * did, against a just-read brief record, immediately before calling this. Duplicating
 * that check here would just be a second read of a record that could have changed in
 * the gap between the two reads either way; the real, unbypassable enforcement is
 * agents/ad-studio/index.js's own assertBriefApproved()/resolveBriefFormatKey(), which
 * run inside the spawned process before anything renders regardless of what this route
 * believed.
 */
export function performRender(args, deps = {}) {
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

  const jobId = `ad-brief-render-${args.briefId}-${Date.now()}`;
  if (!isValidJobId(jobId)) return { ok: false, status: 400, error: 'could not build a safe job id' };

  // Written ONCE, here. agents/ad-studio/index.js claims this file (pid, status
  // 'running') the moment it boots, the same job.start({pid}) call it already makes
  // for a product-mode launch — --brief mode is not a special case there.
  writeJobFn(ROOT, {
    jobId, status: 'pending', kind: 'ad-brief-render', createdAt: new Date().toISOString(),
    args, runId: null, pid: null, events: [], totals: null, error: null,
  });

  const child = spawnFn('node', [join(ROOT, 'agents/ad-studio/index.js'), '--brief', args.briefId, '--job-id', jobId], {
    cwd: ROOT, detached: true, stdio: 'ignore',
  });

  // Same one write this route family keeps for itself: a spawn that never started
  // never claimed the job file, so nothing else will ever report it as failed.
  child.on('error', () => {
    try { updateJobFn(ROOT, jobId, { status: 'error', error: 'failed to start the render process' }); } catch { /* the job file itself may be what's broken */ }
  });

  child.unref();
  return { ok: true, jobId };
}

export default [
  // GET /api/ad-brief/products — products that already have briefs, unioned with the
  // catalog products a brief can be generated for, so the dashboard never has to make a
  // second round trip to know which handle to offer next.
  //
  // EVERY ENTRY CARRIES ITS CLUSTER COVERAGE. The manifest holds 11 non-Culina products;
  // only the 4 in the skin cluster have voice-of-customer personas behind them, and
  // agents/ad-brief/index.js aborts on the rest. The browser used to default to
  // `products[0]` — `coconut-oil-deodorant` — so the very first click on the new tab was
  // always a failed job. Uncovered products are still LISTED, marked unavailable with the
  // reason and the remedy: filtering them out would hide that the product exists and that
  // running agents/voice-of-customer for its cluster is what unlocks it. `covered` is
  // computed by lib/ad-brief-plan.js's clusterCoverage — the same function the agent's own
  // abort is now a thin throw around, so the label and the refusal cannot disagree.
  {
    method: 'GET',
    match: '/api/ad-brief/products',
    handler(req, res) {
      try {
        const manifest = manifestProducts();
        const personas = personasData();
        const withBriefs = new Set(listProductsWithBriefs(ROOT));
        const mark = (handle, title, hasBriefs) => {
          const coverage = clusterCoverage(handle, personas);
          return { handle, title, hasBriefs, covered: coverage.covered, coverageReason: coverage.reason };
        };
        const products = manifest.map(p => mark(p.handle, p.title || p.handle, withBriefs.has(p.handle)));
        // A product that has briefs on disk but has since dropped out of the manifest
        // (discontinued, renamed) still needs to be visible — a catalog change shouldn't
        // hide a decision that was already made about it.
        const manifestHandles = new Set(manifest.map(p => p.handle));
        for (const handle of withBriefs) {
          if (!manifestHandles.has(handle)) products.push(mark(handle, handle, true));
        }
        respondJson(res, { ok: true, products });
      } catch {
        respondError(res, 500, 'failed to load ad-brief products');
      }
    },
  },

  // GET /api/ad-brief/plan?product=<handle> — WHAT A GENERATE CLICK WOULD COST, before it
  // is clicked. One Opus copy call per angle that resolves to a format; an angle whose
  // awareness level no format covers is recorded and costs nothing. The sibling New-run
  // panel has shown a live render estimate since it shipped and this one showed nothing,
  // which contradicts this project's own rule that the cheapest action must be the one you
  // get by accident. Computed server-side from lib/ad-brief-plan.js — the same relevance and
  // cluster logic the agent applies — rather than reimplemented in the browser, because a
  // number the browser derives itself is a number that can be wrong.
  //
  // Free to call: no network, no LLM, no Anthropic key needed.
  {
    method: 'GET',
    match: (url) => url.split('?')[0] === '/api/ad-brief/plan',
    handler(req, res) {
      try {
        const urlObj = new URL(req.url, 'http://localhost');
        const handle = (urlObj.searchParams.get('product') || '').trim();
        if (!handle || !isValidBriefId(handle)) return respondError(res, 400, 'a valid product handle is required');
        const entry = manifestProducts().find(p => p.handle === handle);
        if (!entry) return respondError(res, 400, 'unknown product');

        // The SAME giveaway verdict agents/ad-brief/index.js computes, from the same
        // module. Without it this panel would promise `offer-focused` for a product-aware
        // angle while the agent spent the call on `giveaway-entry` — the drift
        // lib/ad-brief-plan.js exists to prevent, arriving from the one input the plan
        // does not take as an argument.
        const giveaway = loadGiveaway({ root: ROOT });
        const plan = planBriefs({
          personasData: personasData(),
          product: { handle, title: entry.title || handle },
          giveawayLive: Boolean(giveaway),
        });
        respondJson(res, {
          ok: true,
          product: handle,
          covered: plan.covered,
          reason: plan.reason,
          angleCount: plan.angleCount,
          copyCalls: plan.copyCalls,
          angles: plan.angles,
          giveaway: giveaway ? { name: giveaway.name, closesOn: giveaway.closesOn } : null,
        });
      } catch {
        respondError(res, 500, 'failed to plan brief generation');
      }
    },
  },

  // GET /api/ad-brief/list?product=<handle> — ranked briefs for one product.
  //
  // Each brief is annotated with `selectableFormats`: which of its offered formats can
  // actually carry the copy it already holds (identical zone key set — see
  // lib/ad-brief.js's selectableFormats). Annotated rather than persisted, because it is
  // derived from the format table and would go stale the moment a format's zones changed.
  // The dropdown offers exactly this list, so it can no longer present an option the server
  // is going to refuse.
  {
    method: 'GET',
    match: (url) => url.split('?')[0] === '/api/ad-brief/list',
    handler(req, res) {
      try {
        const urlObj = new URL(req.url, 'http://localhost');
        const product = (urlObj.searchParams.get('product') || '').trim();
        if (!product || !isValidBriefId(product)) return respondError(res, 400, 'a valid product handle is required');
        const briefs = listBriefs(ROOT, product).map(b => ({ ...b, selectableFormats: selectableFormats(b) }));
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

  // POST /api/ad-brief/format — { product, briefId, formatKey } -> chooseFormat.
  // Writes `format.chosen`, the field agents/ad-studio/index.js's resolveBriefFormatKey
  // already reads at render time; before this route existed nothing ever wrote it.
  {
    method: 'POST',
    match: '/api/ad-brief/format',
    async handler(req, res, ctx) {
      let body;
      try { body = await readJsonBody(req); } catch { return respondError(res, 400, 'bad JSON body'); }

      // Same unguarded-readdirSync hazard as /decide (code review, 2026-08-17) — this
      // sits after the handler's first await, so an fs fault here would otherwise reach
      // lib/router.js's dispatch(), which calls handlers without awaiting them.
      const listProductsWithBriefsFn = ctx?.adBriefDeps?.listProductsWithBriefs || listProductsWithBriefs;
      let knownProducts;
      try {
        knownProducts = listProductsWithBriefsFn(ROOT).map(handle => ({ handle }));
      } catch {
        return respondError(res, 500, 'failed to load known products');
      }

      const verdict = validateChooseFormat(body, { products: knownProducts });
      if (!verdict.ok) return respondError(res, 400, verdict.error);

      // chooseFormat() enforces the real check (this brief's OWN proposed+alternatives,
      // not the global format table) and this route must not attempt to re-implement or
      // relax that — it only translates a throw into a fixed response, same discipline
      // as /decide just above.
      const chooseFormatFn = ctx?.adBriefDeps?.chooseFormat || chooseFormat;
      try {
        const brief = chooseFormatFn(ROOT, verdict.args.product, verdict.args.briefId, verdict.args.formatKey);
        respondJson(res, { ok: true, brief });
      } catch {
        respondError(res, 400, 'that format is not available for this brief — check its proposed format and alternatives');
      }
    },
  },

  // POST /api/ad-brief/render — { product, briefId } -> spawn agents/ad-studio/index.js
  // --brief <briefId>, the same job mechanism /generate uses. THE security boundary:
  // only a brief whose stored `state` is 'approved' may render, checked HERE by name
  // (not delegated to a caught exception) because lib/ad-brief.js already guarantees
  // that state was unreachable without both gates strictly passing.
  {
    method: 'POST',
    match: '/api/ad-brief/render',
    async handler(req, res, ctx) {
      let body;
      try { body = await readJsonBody(req); } catch { return respondError(res, 400, 'bad JSON body'); }

      const listProductsWithBriefsFn = ctx?.adBriefDeps?.listProductsWithBriefs || listProductsWithBriefs;
      let knownProducts;
      try {
        knownProducts = listProductsWithBriefsFn(ROOT).map(handle => ({ handle }));
      } catch {
        return respondError(res, 500, 'failed to load known products');
      }

      const verdict = validateRender(body, { products: knownProducts });
      if (!verdict.ok) return respondError(res, 400, verdict.error);

      const readBriefFn = ctx?.adBriefDeps?.readBrief || readBrief;
      let brief;
      try {
        brief = readBriefFn(ROOT, verdict.args.product, verdict.args.briefId);
      } catch {
        return respondError(res, 500, 'failed to load the brief');
      }
      if (!brief) return respondError(res, 404, 'no such brief');

      // `brief.state` is not client-supplied — it comes from the record this route just
      // read off disk, and writeBrief() restricts it to the closed BRIEF_STATES
      // vocabulary, so naming it in the response is not the "echo a value back" rule 2
      // warns against; it is exactly the "by name" refusal this endpoint exists to give.
      if (brief.state !== 'approved') {
        return respondError(res, 409,
          `brief is "${brief.state}", not "approved" — only an approved brief can render`);
      }

      // A null-format brief has no `gates` block at all (agents/ad-brief/index.js never
      // writes one for an angle with no matching format — see generateBriefs) and so
      // could never have reached 'approved' in the first place; checked explicitly
      // anyway so the refusal names the real reason rather than relying on that chain.
      const formatKey = brief.format?.chosen ?? brief.format?.proposed ?? null;
      if (!formatKey) {
        return respondError(res, 409, 'this brief has no format to render — no format covers its awareness level');
      }

      // Same reasoning as /generate's handler: findActiveJob/writeJob/spawn are
      // synchronous fs/process calls that can throw (ENOSPC, most realistically — see
      // CLAUDE.md's disk-budget history) and nothing here registers
      // 'unhandledRejection'. Fixed 500; never echo the exception.
      let result;
      try {
        result = performRender(verdict.args, ctx?.adBriefDeps);
      } catch {
        return respondError(res, 500, 'failed to launch the render — check server disk space and logs');
      }

      if (!result.ok) return respondError(res, result.status, result.error);
      respondJson(res, { ok: true, jobId: result.jobId });
    },
  },
];
