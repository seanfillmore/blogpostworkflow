// agents/ad-brief/index.js
//
// Generates ad BRIEFS — one per persona angle — before any image is rendered.
//
//   node agents/ad-brief/index.js --product coconut-lotion [--variant coconut-breeze]
//                                [--angles p1a1,p5a3] [--dry-run] [--job-id <id>]
//
// --job-id turns on progress reporting into data/reports/ad-studio/jobs/<id>.json, via
// the SAME createJobReporter Ad Studio uses (imported, never reimplemented — see the
// gates rule below). The dashboard's /api/ad-brief/generate route sets it; a human
// never does. Every reporter method is a no-op without one, so every invocation in this
// file's own history — none of which passed --job-id — behaves exactly as before.
// This closes a gap a 2026-08-17 review found: the route used to write a job's pid and
// terminal status itself because this agent had no way to claim the file, which meant a
// `pm2 restart` mid-run (every deploy does one) left the route's in-memory 'exit'
// listener gone and the job stuck at 'running' forever even though the briefs had
// already landed correctly on disk. Claiming the file here, the way the agent that
// actually knows when it's done, removes that failure mode.
//
// WHY THIS EXISTS. Ad Studio used to write copy and immediately spend ~$0.78 rendering
// it. The copy is the part that decides whether a concept was ever worth rendering, so
// judging it first is roughly a tenth of the cost of finding out from pixels.
//
// WHAT A BRIEF IS. The FINISHED, gate-passed copy for one persona angle, plus the
// evidence behind it and a score. Approving one renders those exact strings with no
// second LLM call — nothing drifts between what was read and what gets baked in.
//
// GIVEAWAYS. While an Entry Period is open (config/giveaway.json), the published Official
// Rules become a fifth claim source, `giveaway`, alongside pdp/catalog/brandKit/reviews; the
// copy writer is told the goal is an ENTRY rather than a purchase; and a product-aware angle
// proposes the `giveaway-entry` format instead of `offer-focused`. All three switch off
// together the moment the Entry Period closes, and outside one this agent is byte-identical
// to what it was before. See lib/giveaway-claim-source.js — in particular why it REFUSES to
// build the source when the config and the published rules disagree about the dates.
//
// THE GATES ARE IMPORTED, NEVER REIMPLEMENTED. buildConcept (ad-studio) runs
// assertNoHealthClaims then assertClaimsSourced on every brief, the same modules in the
// same order Ad Studio uses. A second copy that drifts from the first would be the worst
// thing this agent could do.
//
// --dry-run makes ZERO Anthropic calls, unlike Ad Studio's --dry-run (which still burns
// real copy calls and only skips the paid Gemini render). A brief's entire purpose is to
// be the thing judged BEFORE spend, so its own preview mode has to cost nothing too — the
// same "cheapest action is the accidental one" reasoning behind --formats being required
// on Ad Studio. See the README's "Why --dry-run differs from Ad Studio's" section.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '../../lib/anthropic.js';
import { visibleFormats } from '../ad-studio/formats.js';
import { buildSourceIndex } from '../ad-studio/claims.js';
import { loadGiveaway } from '../../lib/giveaway-claim-source.js';
import { buildConcept, buildLabelStrings, fetchAdReviews, createJobReporter } from '../ad-studio/index.js';
import { scoreBrief } from '../../lib/ad-brief-score.js';
import { writeBrief } from '../../lib/ad-brief.js';
import { isValidJobId } from '../../lib/ad-studio-job.js';
// The selection brain lives in lib/ so the dashboard's /api/ad-brief routes can tell the
// operator which products are briefable and how many copy calls a click costs WITHOUT
// importing this module — which would pull Anthropic, @google/genai and sharp into the
// single 961 MB dashboard process. Re-exported below so this file's public surface, and
// every existing caller and test, is unchanged. See lib/ad-brief-plan.js's header.
import {
  AWARENESS_TO_FORMAT_AWARENESS, formatsForAngle, angleRelevance,
  allPersonaAngles, assertClusterCoverage, withheldNote,
} from '../../lib/ad-brief-plan.js';

export {
  AWARENESS_TO_FORMAT_AWARENESS, formatsForAngle, angleRelevance, assertClusterCoverage,
};

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * copy.js's buildCopyPrompt wants { name, angles: [flat strings] } and renders them as
 * "WHAT THEY ALREADY TRIED". Ad Studio passes a persona's WHOLE angle list, which asks
 * the writer to address five things at once. A brief is one angle — this projection is
 * what makes the copy specific to it.
 */
export function personaProjection(persona, angle) {
  const parts = [angle?.label, angle?.objection_addressed, angle?.proof].filter(Boolean);
  return { name: persona?.name || '', angles: [parts.join(' — ')] };
}

export function buildBriefId(product, angleId, now = Date.now()) {
  return `${product}-${angleId}-${now}`;
}

/**
 * A VALUE THAT STARTS WITH A DASH IS A MISSING VALUE, not a value.
 *
 * `--product --dry-run` reads as product "--dry-run"; `--angles --job-id --job-id X` reads
 * as jobId "--job-id". The second one is not hypothetical: a request of
 * `{angles: ["--job-id"]}` passed every validator (a dash is an ordinary filename
 * character, so the safe-segment test allowed it), shifted argv by one, and made this agent
 * claim a job file literally named `--job-id.json` while the route's real job sat at
 * 'pending' — after which the 60-second pending grace let a second click launch a second
 * PAID batch. lib/ad-brief.js's checkSegment now refuses a leading dash at the route
 * boundary; this is the same refusal for argv that arrives from a shell. (Code review,
 * 2026-08-17.)
 */
function assertNotFlagShaped(name, value) {
  if (value !== undefined && value !== null && String(value).startsWith('-')) {
    throw new Error(
      `ad-brief: ${name} was given "${value}", which starts with "-" — that is a flag, not a ` +
      `value, so ${name} is missing its argument.`
    );
  }
}

export function parseArgs(argv) {
  const get = (name) => { const i = argv.indexOf(name); return i === -1 ? undefined : argv[i + 1]; };
  const product = get('--product');
  if (!product) throw new Error('ad-brief: --product is required, e.g. --product coconut-lotion');
  assertNotFlagShaped('--product', product);
  const variant = get('--variant') || null;
  assertNotFlagShaped('--variant', variant);
  const anglesRaw = get('--angles');
  assertNotFlagShaped('--angles', anglesRaw);
  const angles = anglesRaw ? anglesRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  for (const a of angles) assertNotFlagShaped('--angles', a);
  // Validated here too, not just in the route: this argv can also arrive from a shell,
  // and the same safe-segment rule the job file's path is built from (lib/ad-studio-job.js)
  // must hold no matter who supplied it.
  const jobId = get('--job-id') || null;
  assertNotFlagShaped('--job-id', jobId);
  if (jobId !== null && !isValidJobId(jobId)) {
    throw new Error(`ad-brief: invalid --job-id "${jobId}" — letters, digits, dot, dash and underscore only`);
  }
  return {
    product,
    variant,
    angles,
    dryRun: argv.includes('--dry-run'),
    jobId,
  };
}

// ── env / data loading — mirrors agents/ad-studio/index.js's loadEnv/loadJson exactly ──

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const env = {};
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx === -1) continue;
      env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
    }
    return env;
  } catch { return {}; }
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The live storefront's public product JSON — no Admin API token required.
 *
 * Not exported from agents/ad-studio/index.js, so it is re-implemented here rather than
 * imported. This is plain data fetching, not a gate — rule 1 (gates imported, never
 * reimplemented) is about assertNoHealthClaims/assertClaimsSourced, which ARE imported.
 * Kept byte-for-byte identical to Ad Studio's copy so the two never read the PDP body
 * differently.
 */
async function fetchPdpBody(siteUrl, handle) {
  const url = `${siteUrl}/products/${handle}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ad-brief: failed to fetch PDP body for "${handle}" (${url}): ${res.status}`);
  const data = await res.json();
  return stripHtml(data?.product?.body_html);
}

/**
 * Turn a rejected buildConcept() result into the brief's gates block.
 *
 * buildConcept runs assertNoHealthClaims BEFORE assertClaimsSourced (see its docstring),
 * so on a rejection exactly one of the two ever ran — the other simply never got a
 * chance to fail. The gate that actually rejected is marked false; the other stays
 * true, which is accurate (it did not fail) and is also what the "record what failed"
 * instruction asks for: name the one gate that did.
 *
 * The third branch is the important one under review. buildConcept only ever produces
 * an ok:false result by catching an error whose message starts with one of the two
 * known prefixes ("Health claim gate failed" / "Claim gate failed") — anything else it
 * re-throws uncaught. So in the REAL path this function should only ever see one of the
 * two known shapes. But the match is a plain string-prefix test against hand-authored
 * error text in two OTHER files (health-claims.js, claims.js), and nothing pins that
 * text — a future rename of either message would silently fall through here. Guessing
 * which gate "must have" failed in that case (or worse, assuming neither failed) would
 * launder an unverified brief into looking approvable. So an unrecognised shape marks
 * BOTH gates false rather than picking one to blame or trusting the other: a brief whose
 * gate outcome is unknown must not be approvable, and must not be mistaken for one that
 * passed either check.
 */
export function gatesFromRejection(result) {
  const error = result?.error || '';
  const healthFailed = /^Health claim gate failed/.test(error);
  const claimsFailed = /^Claim gate failed/.test(error);

  if (healthFailed) {
    return {
      health: { ok: false, violations: result.violations || [], error },
      claims: { ok: true, unsourced: [] },
    };
  }
  if (claimsFailed) {
    return {
      health: { ok: true },
      claims: { ok: false, unsourced: result?.violations || [], error },
    };
  }
  const unknownError = error || 'unrecognised rejection shape — buildConcept reported ok:false ' +
    'with an error message matching neither known gate prefix, so it is not possible to tell ' +
    'which gate (if either) actually failed.';
  return {
    health: { ok: false, unresolved: true, error: unknownError },
    claims: { ok: false, unresolved: true, unsourced: [], error: unknownError },
  };
}

/**
 * Resolve a format, score, generate + gate copy, and PERSIST — one angle at a time.
 *
 * Each brief is written via writeBrief() IMMEDIATELY after it is built, inside this
 * loop, rather than accumulated in memory and written in a batch after every angle has
 * been processed. That used to be a real hazard: if anything threw that was not a gate
 * rejection — a transient API error, a malformed copy response out of
 * parseCopyResponse, anything outside buildConcept's own try/catch — the exception
 * would reach main()'s top-level .catch() and discard every brief already generated,
 * including ones that had already passed both gates and cost real Anthropic spend. This
 * agent's entire premise is being the cheap step that is safe to interrupt, and
 * writeBrief is a single atomic file write built exactly for independent per-brief
 * persistence (see lib/ad-brief.js) — there is no reason not to use it per-angle.
 *
 * `buildConceptFn` defaults to the real, imported buildConcept and exists purely so a
 * test can inject a stub that fails partway through a multi-angle batch without making
 * a real Anthropic call — the real path never overrides it.
 *
 * --dry-run never calls buildConceptFn and never writes: it returns the same shape
 * (score, proposed format, state) so main() can print an identical summary, each entry
 * additionally carrying `pending: true`.
 *
 * `job` defaults to a no-op reporter (createJobReporter() with no jobId, per its own
 * contract) so every existing caller of this function — including every test in this
 * repo's history — behaves exactly as before. When the caller does pass a live reporter
 * (main(), below), each angle reports its own outcome via job.event() as it lands, the
 * same shape Ad Studio's own per-concept reporting uses, so a dashboard watching the job
 * file sees progress angle by angle rather than one lump update at the very end.
 *
 * `giveaway` defaults to null, which is the NO-GIVEAWAY path and is byte-identical to this
 * function's behaviour before giveaways existed: no giveaway source in the copy prompt, and
 * `giveaway-entry` filtered out of the awareness join so `offer-focused` still wins the
 * product-aware slot. A non-null one is the loaded Official Rules (lib/giveaway-claim-source.js)
 * and flips both.
 */
export async function generateBriefs({
  selected, product, pdpBody, sourceIndex, reviews, seoImpact, dryRun, anthropic, root,
  now = Date.now(), buildConceptFn = buildConcept, job = createJobReporter(), giveaway = null,
}) {
  const out = [];
  const formats = visibleFormats({ giveawayLive: Boolean(giveaway) });
  for (const { persona, angle } of selected) {
    const { proposed, alternatives } = formatsForAngle(angle, formats, { giveawayLive: Boolean(giveaway) });
    const score = scoreBrief({ persona, angle, reviews, productHandle: product.handle, seoImpact });
    const briefId = buildBriefId(product.handle, angle.id, now);
    const base = {
      briefId,
      product: product.handle,
      variant: product.variant ?? null,
      personaId: persona.id,
      personaName: persona.name,
      angleId: angle.id,
      angle,
      format: { proposed, alternatives },
      score,
    };

    // Rule 3: an angle with no matching format is still recorded and costs no copy
    // call — never substitute the nearest format, that would render a broad angle as a
    // narrow one and hide exactly the gap this is meant to surface.
    if (!proposed) {
      const brief = { ...base, zones: null, state: 'ready' };
      const saved = dryRun ? { ...brief, pending: true } : writeBrief(root, brief);
      job.event({ stage: 'brief', angleId: angle.id, personaId: persona.id, state: saved.state, format: null });
      out.push(saved);
      continue;
    }

    if (dryRun) {
      // No copy call, no write — --dry-run only previews the plan.
      const saved = { ...base, zones: null, state: 'ready', pending: true };
      job.event({ stage: 'brief', angleId: angle.id, personaId: persona.id, state: saved.state, format: proposed, pending: true });
      out.push(saved);
      continue;
    }

    const format = formats.find(f => f.key === proposed);
    const result = await buildConceptFn({
      anthropic, format, product, pdpBody,
      persona: personaProjection(persona, angle),
      sourceIndex, reviews, variant: product.variant, giveaway,
    });

    const brief = result.ok
      ? {
          ...base,
          zones: result.zones,
          claims: result.claims,
          state: 'ready',
          gates: { health: { ok: true }, claims: { ok: true, unsourced: [] } },
        }
      : {
          ...base,
          zones: null,
          claims: null,
          state: 'needs-evidence',
          gates: gatesFromRejection(result),
        };

    // Persisted before the loop moves to the next angle — see this function's docstring.
    const saved = writeBrief(root, brief);
    job.event({ stage: 'brief', angleId: angle.id, personaId: persona.id, state: saved.state, format: proposed });
    out.push(saved);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const handle = args.product;

  const job = createJobReporter({ root: ROOT, jobId: args.jobId });

  // CLAIM THE JOB FILE NOW — before .env, before personas, before a single network call.
  // Mirrors agents/ad-studio/index.js's own reasoning, learned the hard way there: the
  // dashboard route writes the file as 'pending' and only refuses a second /generate
  // request for DEFAULT_PENDING_GRACE_MS (60s) unless a live pid is on record. A
  // multi-angle Anthropic batch runs far longer than that, so claiming late would leave
  // a window in which a second click launches a second paid batch. A no-op without
  // --job-id, like every other reporter call.
  job.start({ pid: process.pid });

  const env = loadEnv();
  if (!env.ANTHROPIC_API_KEY) throw new Error('ad-brief: missing ANTHROPIC_API_KEY in .env');
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  // Step 1: personas + the cluster guard. Never fall back to another cluster's personas
  // and never invent one — fabricated audience reasoning underneath a claim-gated ad is
  // what this pipeline exists to prevent.
  const personasData = loadJson(join(ROOT, 'data', 'context', 'personas.json'));
  assertClusterCoverage(handle, personasData);

  // Step 2: product, exactly as Ad Studio loads it.
  const manifest = loadJson(join(ROOT, 'data', 'product-images', 'manifest.json'));
  const manifestEntry = manifest.find(p => p.handle === handle);
  if (!manifestEntry) {
    throw new Error(`ad-brief: no entry for handle "${handle}" in data/product-images/manifest.json`);
  }

  const catalog = loadJson(join(ROOT, 'data', 'brand', 'product-catalog.json'));
  const catalogEntry = catalog.products?.[handle];
  if (!catalogEntry) {
    throw new Error(`ad-brief: no entry for handle "${handle}" in data/brand/product-catalog.json`);
  }

  const brandKit = loadJson(join(ROOT, 'data', 'brand', 'brand-kit.json'));

  // labelStrings is built for parity with Ad Studio's product object, but a brief never
  // renders, so — unlike Ad Studio's main() — an empty result does not abort here: the
  // failure labelStrings guards against (an image model inventing a volume) can only
  // happen at render time, which this agent never reaches.
  const labelStrings = buildLabelStrings({ manifestEntry, variant: args.variant });

  const product = {
    handle,
    title: catalogEntry.title,
    priceLabel: catalogEntry.priceLabel,
    labelStrings,
    variant: args.variant,
  };

  const site = loadJson(join(ROOT, 'config', 'site.json'));
  const pdpBody = await fetchPdpBody(site.url, handle);

  // Step 3: reviews + the claim gate's source index.
  const reviews = await fetchAdReviews(handle, { env });
  if (reviews.length) console.log(`Reviews on file for ${handle}: ${reviews.length}`);
  else console.warn(`No Judge.me reviews for ${handle} — any angle that quotes a customer will be rejected by the claim gate.`);

  // A LIVE giveaway is a fifth claim source. Loaded only while its Entry Period is actually
  // open — outside it, loadGiveaway returns null, the `giveaway` key is absent from the
  // source index, no giveaway block reaches the copy prompt and no giveaway format is
  // offered, so this agent behaves exactly as it did before giveaways existed. It throws
  // rather than returning null if config/giveaway.json and the published Official Rules
  // disagree about the Entry Period dates: both files are authoritative, and picking one
  // would let ad copy cite a deadline the published rules contradict.
  const giveaway = loadGiveaway({ root: ROOT });
  if (giveaway) {
    console.log(
      `Giveaway live: ${giveaway.name} — entries close ${giveaway.closesOn}. ` +
      `Briefs will be written as ENTRY ads and may cite the "giveaway" source.`
    );
  }

  const sourceIndex = buildSourceIndex({ pdpBody, brandKit, catalogEntry, reviews, giveaway: giveaway?.text });

  // Step 4: seo-impact, best-effort. Missing (the common case in a local checkout — see
  // CLAUDE.md's snapshot note) scores neutral rather than blocking.
  let seoImpact = null;
  try {
    seoImpact = loadJson(join(ROOT, 'data', 'reports', 'seo-impact', 'latest.json'));
  } catch { /* neutral commercial score — see scoreCommercial */ }

  // Step 5: select angles — those named by --angles, else every angle passing
  // angleRelevance for this product.
  const all = allPersonaAngles(personasData);
  let selected;
  if (args.angles.length) {
    const byId = new Map(all.map(pa => [pa.angle.id, pa]));
    const missing = args.angles.filter(id => !byId.has(id));
    if (missing.length) {
      throw new Error(
        `ad-brief: unknown angle id(s): ${missing.join(', ')} — known ids: ${all.map(pa => pa.angle.id).join(', ')}` +
        withheldNote(missing, personasData)
      );
    }
    selected = args.angles.map(id => byId.get(id));
  } else {
    selected = all.filter(({ angle }) => angleRelevance(angle, product));
  }

  if (!selected.length) {
    console.log(`ad-brief: no angles selected for "${handle}" — nothing to do.`);
    job.finish({ totals: { briefs: 0 } });
    return { dryRun: args.dryRun, briefs: [] };
  }

  const now = Date.now();

  // Steps 6-8: resolve a format per angle, generate + gate copy where one exists, score,
  // and (outside --dry-run) persist ONE ANGLE AT A TIME — see generateBriefs' docstring.
  // Each angle is independent — one rejection or an unrelated error must not discard the
  // others' already-generated, already-paid-for briefs.
  const results = await generateBriefs({
    selected, product, pdpBody, sourceIndex, reviews, seoImpact,
    dryRun: args.dryRun, anthropic, root: ROOT, now, job, giveaway,
  });

  // Step 9: rank + print, computed from what generateBriefs actually returned (which — on
  // the real path — is exactly what is now on disk) rather than from a separate
  // in-main accumulator that a mid-run exception could leave short of the truth.
  // Highest score first, same ordering listBriefs uses on disk.
  const ranked = [...results].sort((a, b) => (b.score?.total ?? -1) - (a.score?.total ?? -1));

  if (args.dryRun) {
    const callCount = ranked.filter(b => b.format.proposed).length;
    console.log(`\nDRY RUN — ${ranked.length} angle(s) for ${product.title} (${handle}${args.variant ? '/' + args.variant : ''})`);
    console.log(`Would make ${callCount} Anthropic copy call(s). No Anthropic calls were made.`);
    console.log(
      giveaway
        ? `Giveaway: LIVE — "${giveaway.name}", entries close ${giveaway.closesOn}. Copy will be ENTRY-focused and may cite sourceId "giveaway".\n`
        : `Giveaway: none running — no "giveaway" source, no giveaway format.\n`
    );
    for (const b of ranked) {
      console.log(
        `── ${b.angleId} (${b.personaName}) — score ${b.score.total} ` +
        `[persona ${b.score.persona} proof ${b.score.proof} commercial ${b.score.commercial} headroom ${b.score.headroom}] ──`
      );
      console.log(`  angle: ${b.angle.label} (${b.angle.awareness})`);
      console.log(
        b.format.proposed
          ? `  format: ${b.format.proposed}${b.format.alternatives.length ? ` (alternatives: ${b.format.alternatives.join(', ')})` : ''}`
          : `  format: none — no format covers "${b.angle.awareness}" yet; brief will be recorded as ready with no render target`
      );
      console.log('');
    }
    job.finish({ totals: { briefs: ranked.length } });
    return { dryRun: true, briefs: ranked };
  }

  // Already written to disk inside generateBriefs, one at a time — this is a summary of
  // what happened, not the write itself.
  console.log(`\n${ranked.length} brief(s) written for ${product.title} (${handle}${args.variant ? '/' + args.variant : ''}):`);
  for (const b of ranked) {
    console.log(`  ${b.briefId} — score ${b.score.total} — ${b.state}${b.format.proposed ? ` (${b.format.proposed})` : ' (no format)'}`);
  }
  const needsEvidence = ranked.filter(b => b.state === 'needs-evidence');
  if (needsEvidence.length) {
    console.log(`\n${needsEvidence.length} brief(s) need evidence (gate-rejected):`);
    for (const b of needsEvidence) {
      const failed = b.gates.health.ok === false ? 'health' : 'claims';
      console.log(`  ${b.briefId} — ${failed} gate: ${b.gates[failed].error}`);
    }
  }

  job.finish({ totals: { briefs: ranked.length, needsEvidence: needsEvidence.length } });
  return { dryRun: false, briefs: ranked };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    // The job may have been claimed (job.start() above) before whatever failed. A fresh
    // reporter built from the same argv reaches the same file — createJobReporter's own
    // fail() swallows its own errors, so a broken job file can never mask the real one.
    try {
      const failedJobId = parseArgs(process.argv.slice(2)).jobId;
      if (failedJobId) createJobReporter({ root: ROOT, jobId: failedJobId }).fail(err);
    } catch { /* a parseArgs failure is itself the error being reported */ }
    console.error(err.message);
    process.exit(1);
  });
}
