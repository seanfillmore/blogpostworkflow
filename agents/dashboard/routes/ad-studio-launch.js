// agents/dashboard/routes/ad-studio-launch.js
//
// The endpoints that SPEND MONEY. Kept apart from routes/ad-studio.js, which reads and
// judges runs that already exist.
//
// Three things make this route different from every other one on this server, and all
// three are here rather than in the browser:
//
//   1. The dashboard is reachable over a public ngrok URL. Basic auth is in front of
//      it, but a launch endpoint deserves its own ceiling regardless.
//   2. The browser's format and product lists are a CONVENIENCE. Every field is
//      re-validated here against formats.js and the product manifest.
//   3. One run at a time. On a 1 vCPU box two concurrent runs only slow each other
//      down, and a double-clicked button would otherwise pay twice.
//
// The agent is spawned DETACHED and owns its job file from the moment it starts. This
// route writes the job file exactly once, before the spawn, and only ever reads it
// afterwards — including on cancel, which sends a signal rather than writing a verdict.

import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FORMATS } from '../../ad-studio/formats.js';
import { selectTargets } from '../../ad-studio/packaging.js';
import { estimateRenders, USD_PER_RENDER } from '../../../lib/ad-studio-cost.js';
import { writeJob, readJob, findActiveJob, rendersToday, isValidJobId } from '../../../lib/ad-studio-job.js';
import { respondJson, respondError, readJsonBody } from '../lib/responses.js';
import { ROOT, PRODUCT_IMAGES_DIR, PRODUCT_MANIFEST_PATH } from '../lib/paths.js';

/** ≈$15.60. Approved 2026-08-16. Enforced here whatever the form sends. */
export const MAX_RENDERS_CEILING = 120;

/** The agent's own MAX_VARIATIONS. Duplicated deliberately — this must reject before spawning. */
const MAX_VARIATIONS = 10;

/** The two target sets the UI offers. Anything else is a CLI-only power feature. */
const TARGET_SETS = ['meta', 'all'];

function manifestProducts() {
  try {
    const raw = JSON.parse(readFileSync(PRODUCT_MANIFEST_PATH, 'utf8'));
    const list = Array.isArray(raw) ? raw : (raw.products || []);
    // Culina is a separate brand on a separate site — never an RSC ad.
    return list.filter(p => !/culina|cast iron/i.test(`${p.handle} ${p.title || ''}`));
  } catch {
    return [];
  }
}

/** Variant subdirectories of a product's image directory — the ones holding photos. */
function variantsFor(product) {
  const dir = join(PRODUCT_IMAGES_DIR, product.imageDir || product.handle);
  try {
    return readdirSync(dir)
      .filter(name => !name.startsWith('.'))
      .filter(name => { try { return statSync(join(dir, name)).isDirectory(); } catch { return false; } })
      .sort();
  } catch {
    return [];
  }
}

/**
 * The only place a launch request is trusted. Returns normalised args or a reason.
 *
 * `formats` and `manifestProducts` are injected so this is testable without the real
 * manifest, and so the test suite pins the RULES rather than today's product list.
 */
export function validateLaunch(body = {}, { formats = FORMATS, manifestProducts: products = [] } = {}) {
  const bad = (error) => ({ ok: false, error });

  const product = String(body.product || '').trim();
  if (!product) return bad('product is required');
  if (!products.some(p => p.handle === product)) return bad(`unknown product "${product}"`);

  const variant = body.variant ? String(body.variant).trim() : null;

  const requested = Array.isArray(body.formats) ? body.formats.map(f => String(f).trim()).filter(Boolean) : [];
  if (!requested.length) return bad('pick at least one format');
  const unknown = requested.filter(k => !formats.some(f => f.key === k));
  if (unknown.length) return bad(`unknown format(s): ${unknown.join(', ')}`);

  const variations = body.variations === undefined ? 1 : Number(body.variations);
  if (!Number.isInteger(variations) || variations < 1 || variations > MAX_VARIATIONS) {
    return bad(`variations must be a whole number from 1 to ${MAX_VARIATIONS}`);
  }

  const targetSet = String(body.targets || 'meta');
  if (!TARGET_SETS.includes(targetSet)) return bad(`targets must be one of: ${TARGET_SETS.join(', ')}`);
  const targets = selectTargets(targetSet);

  const dryRun = Boolean(body.dryRun);

  let maxRenders = body.maxRenders === undefined ? MAX_RENDERS_CEILING : Number(body.maxRenders);
  if (!Number.isInteger(maxRenders) || maxRenders < 1) return bad('render ceiling must be a positive whole number');
  // Clamped, never trusted upward.
  maxRenders = Math.min(maxRenders, MAX_RENDERS_CEILING);

  const plan = estimateRenders({ formats: requested, variations, targets });

  // A run that cannot finish inside its own ceiling would budget-stop halfway, having
  // spent the money and produced a partial batch. Refuse it while it is still free.
  if (!dryRun && plan.expected > maxRenders) {
    return bad(
      `this run's expected renders (${plan.expected}, ~$${plan.expectedUsd.toFixed(2)}) exceed the ceiling of ` +
      `${maxRenders}. Reduce formats or variations, or raise the ceiling (max ${MAX_RENDERS_CEILING}).`
    );
  }

  return { ok: true, args: { product, variant, formats: requested, variations, targets: targetSet, maxRenders, dryRun, plan } };
}

/** Built from validated args only — nothing from the request body reaches argv directly. */
export function buildAgentArgv(args, jobId) {
  const argv = ['--product', args.product];
  if (args.variant) argv.push('--variant', args.variant);
  argv.push('--formats', args.formats.join(','));
  argv.push('--targets', args.targets);
  argv.push('--variations', String(args.variations));
  if (args.dryRun) argv.push('--dry-run');
  else argv.push('--max-renders', String(args.maxRenders));
  argv.push('--job-id', jobId);
  return argv;
}

export default [
  // GET /api/ad-studio/options — everything the setup form needs, so nothing about the
  // rotation is hardcoded in browser JS.
  {
    method: 'GET',
    match: '/api/ad-studio/options',
    handler(req, res) {
      try {
        const products = manifestProducts().map(p => ({
          handle: p.handle, title: p.title || p.handle, unitCount: p.unitCount ?? null, variants: variantsFor(p),
        }));
        respondJson(res, {
          products,
          formats: FORMATS.map(f => ({ key: f.key, name: f.name, plateSetting: f.plateSetting })),
          targetSets: TARGET_SETS.map(key => {
            const t = selectTargets(key);
            return { key, meta: t.filter(x => x.platform === 'meta').length, demandGen: t.filter(x => x.platform !== 'meta').length };
          }),
          perRenderUsd: USD_PER_RENDER,
          maxRendersCeiling: MAX_RENDERS_CEILING,
          maxVariations: MAX_VARIATIONS,
          rendersToday: rendersToday(ROOT),
          activeJobId: findActiveJob(ROOT)?.jobId || null,
        });
      } catch (err) {
        respondError(res, 500, err.message);
      }
    },
  },

  // POST /api/ad-studio/launch
  {
    method: 'POST',
    match: '/api/ad-studio/launch',
    async handler(req, res) {
      let body;
      try { body = await readJsonBody(req); } catch { return respondError(res, 400, 'bad JSON body'); }

      const verdict = validateLaunch(body, { formats: FORMATS, manifestProducts: manifestProducts() });
      if (!verdict.ok) return respondError(res, 400, verdict.error);

      const active = findActiveJob(ROOT);
      if (active) {
        return respondError(res, 409, `a run is already in progress (${active.jobId}) — wait for it or cancel it first`);
      }

      const { args } = verdict;
      const jobId = `${args.product}-${Date.now()}`;
      if (!isValidJobId(jobId)) return respondError(res, 400, 'could not build a safe job id');

      // Written ONCE, here. The agent owns this file from the moment it boots.
      writeJob(ROOT, {
        jobId, status: 'pending', createdAt: new Date().toISOString(),
        args: { ...args, plan: undefined }, plan: args.plan,
        runId: null, pid: null, events: [], totals: null, error: null,
      });

      const child = spawn('node', [join(ROOT, 'agents/ad-studio/index.js'), ...buildAgentArgv(args, jobId)], {
        cwd: ROOT, detached: true, stdio: 'ignore',
      });
      child.unref();

      respondJson(res, { ok: true, jobId, plan: args.plan });
    },
  },

  // GET /api/ad-studio/job/<id>
  {
    method: 'GET',
    match: (url) => /^\/api\/ad-studio\/job\/[^/]+$/.test(url.split('?')[0]),
    handler(req, res) {
      const jobId = decodeURIComponent(req.url.split('?')[0].split('/').pop());
      if (!isValidJobId(jobId)) return respondError(res, 400, 'bad job id');
      const job = readJob(ROOT, jobId);
      if (!job) return respondError(res, 404, 'no such job');
      respondJson(res, job);
    },
  },

  // POST /api/ad-studio/job/<id>/cancel — a SIGNAL, never a write. The agent's own
  // handler archives run output and records the outcome, so the file keeps one writer.
  {
    method: 'POST',
    match: (url) => /^\/api\/ad-studio\/job\/[^/]+\/cancel$/.test(url.split('?')[0]),
    handler(req, res) {
      const jobId = decodeURIComponent(req.url.split('?')[0].split('/')[4]);
      if (!isValidJobId(jobId)) return respondError(res, 400, 'bad job id');
      const job = readJob(ROOT, jobId);
      if (!job) return respondError(res, 404, 'no such job');
      if (!job.pid || job.status !== 'running') return respondError(res, 409, `job is ${job.status}, not running`);
      try {
        process.kill(job.pid, 'SIGTERM');
      } catch (err) {
        return respondError(res, 409, `could not signal the run: ${err.message}`);
      }
      respondJson(res, { ok: true, signalled: job.pid });
    },
  },
];
