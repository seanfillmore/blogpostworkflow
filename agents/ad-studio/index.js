// agents/ad-studio/index.js
//
// Ad Studio — publish-ready static ad creatives for Meta and Google Demand Gen.
//
// Usage:
//   node agents/ad-studio/index.js --product coconut-lotion [--variant coconut-breeze]
//                                 [--formats us-vs-them,manifesto] [--variations 3]
//                                 [--max-renders 120] [--dry-run]
//
// A default run (6 formats × 3 variations × 6 platform targets) is 108 renders ≈ $14
// before retries; --max-renders is the hard ceiling. See the README's Cost section.
//
// Stages: angle → copy (+ claim gate) → single-pass render → verify → package.
// See docs/superpowers/specs/2026-08-14-ad-studio-design.md

import { GoogleGenAI } from '@google/genai';
import Anthropic from '../../lib/anthropic.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREATIVE_MODELS } from '../../config/creative-models.js';
import { renderVariation, buildRenderPrompt, selectReferencePhotos } from './render.js';
import { buildVerifyPrompt, parseVerifyResponse, verdictFor, selectVolumeStrings } from './verify.js';
import { buildCritiquePrompt, parseCritiqueResponse, critiqueVerdict } from './critique.js';
import { selectFormats } from './formats.js';
import { buildSourceIndex, assertClaimsSourced, validateClaims } from './claims.js';
import { buildCopyPrompt, parseCopyResponse, enforceZoneCapacity, expectedStrings } from './copy.js';
import { PLATFORM_TARGETS, variationDir, artifactName, buildDemandGenAssets, renderRatioFor, cropToRatio } from './packaging.js';
import { notify } from '../../lib/notify.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// (There is deliberately no slugify() here: the concept slug is the format key, which
// formats.js already guarantees is a slug. An exported-but-uncalled helper with a test
// of its own reads as covered code that nothing uses.)

// Gemini 3 Pro image, 2K. The single number every cost figure in the README and the
// design spec is derived from — keep them in step if it changes.
export const ESTIMATED_COST_PER_RENDER_USD = 0.13;

// A default run is 6 concepts × 3 variations × 6 platform targets = 108 renders before
// a single retry (~$14), and 324 (~$42) if every artifact needs all 3 attempts. Nothing
// in the pipeline bounded that. 120 leaves a dozen retries on a default run and stops
// the pathological case cold; override with --max-renders.
export const DEFAULT_MAX_RENDERS = 120;

// The number of --variations above which the flag is almost certainly a typo. 10
// variations of one concept is already 60 renders (~$8).
export const MAX_VARIATIONS = 10;

/**
 * Counts every render ATTEMPT, retries included — retries are what make the worst case
 * 3x the nominal cost, so a ceiling that only counted artifacts would not be a ceiling.
 * `take()` is called immediately before each paid call and returns false once the
 * budget is spent; callers stop and record the skip rather than truncating silently.
 */
export function createRenderBudget(max) {
  let used = 0;
  return {
    max,
    used: () => used,
    exhausted: () => used >= max,
    take() {
      if (used >= max) return false;
      used += 1;
      return true;
    },
  };
}

function textOf(msg) {
  return (msg?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

// Magic-byte signatures. Gemini's response carries no reliable content-type of its
// own (renderVariation only ever reads the base64 payload), and it returns JPEG on
// some calls and PNG on others — assuming PNG produced a live 400 from the
// Anthropic API ("the image was specified using the image/png media type, but the
// image appears to be a image/jpeg image"). Every verify call failed until this was
// fixed, which means every render was paid for and then thrown away. No silent
// default: an unrecognized signature throws rather than guessing.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

// R4. How many reference photographs the VERIFY call gets. The renderer gets up to 4
// (selectReferencePhotos' own cap); the verifier gets fewer because its call is made once
// per attempt and every photograph is input tokens on it. Two angles are enough to judge
// silhouette, cap and label element order — the attributes in FIDELITY_ATTRIBUTES.
const VERIFY_REFERENCE_MAX = 2;

export function sniffImageMediaType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) {
    throw new Error(`ad-studio: image buffer too short to identify a type (${buf?.length ?? 0} byte(s))`);
  }
  if (PNG_SIGNATURE.every((byte, i) => buf[i] === byte)) return 'image/png';
  if (JPEG_SIGNATURE.every((byte, i) => buf[i] === byte)) return 'image/jpeg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';

  const hex = [...buf.subarray(0, 8)].map(b => b.toString(16).padStart(2, '0')).join(' ');
  throw new Error(`ad-studio: unrecognized image type — first 8 bytes: ${hex}`);
}

/**
 * Stage 5b. One art-direction call over a frame that has already passed verify.
 *
 * SEPARATE from the verify call on purpose — buildVerifyPrompt's framing is a literal,
 * "do not interpret anything" pixel read, and holistic judgement is the opposite
 * instruction. See critique.js's header.
 *
 * The `ratio` here is the DELIVERY ratio, not the request ratio. It matters only for
 * 9:16, which RENDER_RATIO_MAP renders natively (`needsCrop: false`) — so the frame this
 * call judges is the frame that ships. The one ratio that IS cropped afterwards, 1.91:1,
 * is a plate, and critiqueVerdict returns not-applicable for plates.
 *
 * A failure here is a defect in the frame, not an error: on a malformed response the
 * frame is not silently accepted, because parseCritiqueResponse throws and renderTarget's
 * try/catch records the target as errored.
 */
export async function critiqueArtifact({ anthropic, buffer, mediaType, format, zones, mode, ratio }) {
  // A plate has no typeset copy to place or set, so there is nothing to ask. Skip the
  // call entirely rather than pay for a question with no answerable content.
  if (mode === 'plate') return critiqueVerdict({ mode, ratio });

  const msg = await anthropic.messages.create({
    model: CREATIVE_MODELS.adStudio.verify,
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: buffer.toString('base64') } },
        { type: 'text', text: buildCritiquePrompt({ ratio, format, zones }) },
      ],
    }],
  });

  if (msg.stop_reason === 'max_tokens') {
    throw new Error('ad-studio: the critique response was cut off at the token limit. Raise max_tokens in critiqueArtifact.');
  }

  return critiqueVerdict({ ...parseCritiqueResponse(textOf(msg)), mode, ratio });
}

/**
 * Render one variation, verifying after each attempt. Stops at maxAttempts, or earlier
 * if the run-wide render budget is exhausted (see createRenderBudget) — a budget stop
 * is reported, never silently swallowed.
 * @returns {Promise<{ok:boolean, buffer:Buffer|null, mediaType:string|null, attempts:number, budgetStopped:boolean, proof:object}>}
 */
export async function renderWithRetry({ gemini, anthropic, prompt, photoPaths, ratio, expected, format, zones = {}, deliveryRatio = '', mode = 'finished', volumeStrings = [], physicalDescription = '', maxAttempts = 3, budget = null }) {
  // R4. The reference photographs go to the VERIFIER as well as the renderer, so the gate
  // can compare the product it got against the product it asked for. Capped below what
  // the renderer gets: two angles are enough to judge silhouette, cap and label order,
  // and every extra photograph is input tokens on a call made once per attempt.
  const referencePhotos = (photoPaths || []).slice(0, VERIFY_REFERENCE_MAX).map(p => {
    const buf = readFileSync(p);
    return { mediaType: sniffImageMediaType(buf), data: buf.toString('base64') };
  });
  let attempts = 0;
  let lastProof = { ok: false, reasons: ['no attempt made'], missing: [], mismatchedPairs: [] };
  let lastBuffer = null;
  let lastMediaType = null;
  let budgetStopped = false;

  while (attempts < maxAttempts) {
    if (budget && !budget.take()) {
      budgetStopped = true;
      lastProof = {
        ok: false,
        reasons: [`render budget exhausted after ${budget.max} render(s) — stopped before attempt ${attempts + 1}`],
        missing: lastProof.missing || [],
        mismatchedPairs: lastProof.mismatchedPairs || [],
      };
      break;
    }
    attempts += 1;
    lastBuffer = await renderVariation(gemini, { prompt, photoPaths, ratio });
    // Sniff on every attempt — nothing guarantees Gemini returns the same format twice.
    lastMediaType = sniffImageMediaType(lastBuffer);

    const msg = await anthropic.messages.create({
      model: CREATIVE_MODELS.adStudio.verify,
      // A per-string check carries the expected string AND the rendered text back, so
      // the response scales with the copy volume — 2000 truncated the JSON on a
      // six-zone format and the truncation surfaced as an unparseable response.
      // R4 added a per-attribute fidelity block, five entries each carrying a prose
      // detail, on top of a per-string check that already scales with the copy volume.
      // 5000 truncated the JSON on the 1x1 frame of a six-zone format — the same failure
      // 2000 produced before it, surfacing as an unparseable response rather than as
      // "the output was cut off". Raised, and the cut is now reported as itself below.
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: [
          // Reference photographs FIRST, each labelled, then the render. buildVerifyPrompt
          // states this order too — a verifier that read the label off a reference photo
          // would report a flawless render of a product the ad never contained.
          ...referencePhotos.flatMap((ref, i) => [
            { type: 'text', text: `REFERENCE PHOTOGRAPH ${i + 1} of the real product:` },
            { type: 'image', source: { type: 'base64', media_type: ref.mediaType, data: ref.data } },
          ]),
          ...(referencePhotos.length ? [{ type: 'text', text: 'THE RENDER UNDER TEST:' }] : []),
          { type: 'image', source: { type: 'base64', media_type: lastMediaType, data: lastBuffer.toString('base64') } },
          { type: 'text', text: buildVerifyPrompt({
            expected, format, mode, volumeStrings,
            physicalDescription, referenceCount: referencePhotos.length,
          }) },
        ],
      }],
    });

    // A truncated response is not a malformed one, and saying so is the difference
    // between a one-line max_tokens bump and an afternoon debugging the parser. Same
    // reasoning as the blog-post-writer's stop_reason check in CLAUDE.md.
    if (msg.stop_reason === 'max_tokens') {
      throw new Error(
        `ad-studio: the verify response was cut off at the ${msg.usage?.output_tokens ?? '?'}-token ` +
        `limit, so this render could not be scored. Raise max_tokens in renderWithRetry.`
      );
    }

    const { checks, productVolume, defects, transcript, pairings, fidelity } = parseVerifyResponse(textOf(msg));
    lastProof = verdictFor({
      expected, checks, productVolume, defects, transcript, pairings, format, mode, volumeStrings,
      fidelity, hasReference: referencePhotos.length > 0,
    });
    lastProof.transcript = transcript;

    // Stage 5b — the layout critique, and ONLY on a frame that already passed verify.
    // Art-directing a frame that is about to be rejected for a corrupted headline buys
    // nothing and costs a vision call. A Part A defect (copy under the platform UI, copy
    // unreadable at thumb size) feeds THIS retry loop rather than inventing a second one;
    // the Part B quality score is recorded either way and never blocks. See critique.js.
    if (lastProof.ok) {
      const crit = await critiqueArtifact({ anthropic, buffer: lastBuffer, mediaType: lastMediaType, format, zones, mode, ratio: deliveryRatio });
      lastProof.critique = crit;
      if (!crit.ok) {
        lastProof.ok = false;
        lastProof.reasons = [...lastProof.reasons, ...crit.reasons];
      }
    }

    if (lastProof.ok) return { ok: true, buffer: lastBuffer, mediaType: lastMediaType, attempts, budgetStopped: false, proof: lastProof };
  }

  return { ok: false, buffer: lastBuffer, mediaType: lastMediaType, attempts, budgetStopped, proof: lastProof };
}

/**
 * Generate copy and pass it through the claim gate for ONE concept (format).
 *
 * Mirrors renderTarget: the fallible step — assertClaimsSourced — is tried here and
 * ONLY a claim-gate failure is turned into a structured result. assertClaimsSourced
 * itself is untouched (still throws, still no override flag); this function is "the
 * caller" the isolation belongs in. Matching on the exact message prefix that
 * function has always thrown (not a try/catch around the whole concept) is what
 * guarantees an unrelated failure — a network error on the copy call, a malformed
 * response from parseCopyResponse, enforceZoneCapacity throwing — still propagates
 * and aborts the run instead of being swallowed as if it were a sourcing problem.
 *
 * @returns {Promise<{ok:true, conceptSlug:string, format:object, zones:object, claims:object[]}
 *                  |{ok:false, conceptSlug:string, format:string, violations:object[], error:string}>}
 */
export async function buildConcept({ anthropic, format, product, pdpBody, persona, sourceIndex }) {
  console.log(`Copy: ${format.key} (${format.name})...`);
  const prompt = buildCopyPrompt({ format, product, pdpBody, persona });
  const msg = await anthropic.messages.create({
    model: CREATIVE_MODELS.adStudio.copy,
    max_tokens: 3000,
    messages: [{ role: 'user', content: prompt }],
  });
  const { zones: rawZones, claims: rawClaims } = parseCopyResponse(textOf(msg));

  // Hard cap — a backstop for when the model ignores buildCopyPrompt's capacity
  // hint (or the capacity hint doesn't apply, e.g. no zoneCapacity declared). Must
  // run BEFORE the claim gate: the gate has to see the copy that will actually
  // render, not the pre-truncation draft.
  const { zones, dropped } = enforceZoneCapacity(rawZones, format);

  // A claim whose text was just truncated away must not reach the gate either — it
  // will never render, so sourcing it (or failing to) proves nothing, and running
  // the gate against text that no longer exists is exactly the "validate a claim we
  // then dropped" bug this fix exists to close. Zone-aware — see filterDroppedClaims.
  const claims = filterDroppedClaims(rawClaims, dropped);

  try {
    // Hard stop, unchanged — no override flag. Runs on the TRUNCATED copy above.
    assertClaimsSourced(claims, sourceIndex);
  } catch (err) {
    if (!/^Claim gate failed/.test(err.message)) throw err;
    const { violations } = validateClaims(claims, sourceIndex);
    console.error(`  REJECTED — claim gate failed for "${format.key}": ${violations.length} unsourced claim(s).`);
    for (const v of violations) console.error(`    [${v.zone}] "${v.text}" — ${v.reason}`);
    return { ok: false, conceptSlug: format.key, format: format.key, violations, error: err.message };
  }

  return { ok: true, conceptSlug: format.key, format, zones, claims };
}

/**
 * Build every requested concept, isolating a claim-gate failure to the ONE concept
 * that produced it — mirrors renderVariationTargets: one bad target already couldn't
 * be allowed to discard money and work spent on the others, and a bad concept is no
 * different. The one thing this loop does NOT do is catch anything itself — that
 * belongs to buildConcept (see its docstring), so an unexpected error here still
 * propagates and aborts the whole run.
 *
 * @returns {Promise<{concepts:{format:object, zones:object, claims:object[]}[], rejectedConcepts:{conceptSlug:string, format:string, violations:object[], error:string}[]}>}
 */
export async function buildConcepts({ anthropic, formats, product, pdpBody, persona, sourceIndex }) {
  const concepts = [];
  const rejectedConcepts = [];
  for (const format of formats) {
    const result = await buildConcept({ anthropic, format, product, pdpBody, persona, sourceIndex });
    if (result.ok) concepts.push({ format: result.format, zones: result.zones, claims: result.claims });
    else rejectedConcepts.push({ conceptSlug: result.conceptSlug, format: result.format, violations: result.violations, error: result.error });
  }
  return { concepts, rejectedConcepts };
}

/**
 * @param {{runId:string, product:object, results:object[], renders?:number, budget?:{maxRenders:number, stopped:boolean, skipped:string[]}}} args
 *
 * `renders` and `cost` are here because a run that spends money and reports only
 * accept/reject counts hides its own cost — the design spec's output-layout section
 * always said run.json carries costs. `budget` records a budget stop and names every
 * artifact that was dropped because of it, so a short run can never be mistaken for a
 * complete one.
 *
 * `rejectedConcepts` (from buildConcepts) names every concept the claim gate rejected
 * before it ever reached render, with the violations that failed it — so it is never
 * ambiguous whether a requested concept succeeded, was skipped, or was never asked
 * for. `totals.requested` is results.length + rejectedConcepts.length: the count of
 * concepts asked for, independent of how many actually rendered.
 */
export function buildRunReport({ runId, product, results, renders = 0, budget = null, rejectedConcepts = [] }) {
  let accepted = 0;
  let rejected = 0;
  const conceptsWithNoAcceptedVariation = [];

  for (const c of results) {
    const okCount = c.variations.filter(v => v.ok).length;
    accepted += okCount;
    rejected += c.variations.length - okCount;
    if (okCount === 0) conceptsWithNoAcceptedVariation.push(c.conceptSlug);
  }

  return {
    runId,
    generatedAt: new Date().toISOString(),
    product: { handle: product.handle, title: product.title },
    models: CREATIVE_MODELS.adStudio,
    totals: { accepted, rejected, concepts: results.length, requested: results.length + rejectedConcepts.length },
    cost: {
      renders,
      perRenderUsd: ESTIMATED_COST_PER_RENDER_USD,
      estimatedUsd: Number((renders * ESTIMATED_COST_PER_RENDER_USD).toFixed(2)),
    },
    budget: budget
      ? {
          maxRenders: budget.maxRenders,
          stopped: Boolean(budget.stopped),
          skipped: budget.skipped || [],
          skippedCount: (budget.skipped || []).length,
        }
      : null,
    conceptsWithNoAcceptedVariation,
    rejectedConcepts,
    results,
  };
}

/**
 * Build the run report, write run.json, and decide whether the run must fail.
 *
 * Extracted from main() for the same reason renderVariationTargets was: "every
 * concept rejected by the claim gate still writes a report and fails the run" is a
 * behavior nothing can prove while it only lives inline in main() — main() itself
 * does live file/network I/O that a unit test has no business triggering.
 *
 * run.json is written FIRST, unconditionally — a run where every concept failed the
 * gate must still leave a human-readable report on disk, not just a non-zero exit
 * code. The throw below (concepts.length === 0 && rejectedConcepts.length > 0) comes
 * after that write and only decides the exit code, via the same catch()/
 * process.exit(1) path any other main() failure already takes.
 *
 * A PARTIAL rejection (some concepts rendered, at least one didn't) is not fatal —
 * it's reported in run.json and the daily-summary notification, same as a budget
 * stop or an accepted-zero-variations concept already are.
 */
export function finalizeRunReport({ runDir, runId, product, results, renders, budget, rejectedConcepts, concepts }) {
  const report = buildRunReport({ runId, product, results, renders, budget, rejectedConcepts });
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(report, null, 2));

  if (concepts.length === 0 && rejectedConcepts.length > 0) {
    throw new Error(
      `ad-studio: every requested concept (${rejectedConcepts.length}) was rejected by the claim gate — ` +
      `nothing rendered. Rejected: ${rejectedConcepts.map(c => c.conceptSlug).join(', ')}. ` +
      `See ${join(runDir, 'run.json')} for violations.`
    );
  }

  return report;
}

// ── argv / env / data loading ──────────────────────────────────────────────

export function parseArgs(argv) {
  const getFlag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const product = getFlag('--product');
  if (!product) throw new Error('ad-studio: --product is required, e.g. --product coconut-lotion');
  const variant = getFlag('--variant') || null;
  const formatsRaw = getFlag('--formats');
  const formats = formatsRaw ? formatsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const variationsRaw = getFlag('--variations');
  const variations = variationsRaw === undefined ? 3 : parseInt(variationsRaw, 10);
  if (!Number.isInteger(variations) || variations < 1) {
    throw new Error(`ad-studio: --variations must be a positive integer, got "${variationsRaw}"`);
  }
  // Upper bound: --variations multiplies by 6 platform targets and 6 formats. An
  // unbounded flag is an unbounded bill.
  if (variations > MAX_VARIATIONS) {
    throw new Error(
      `ad-studio: --variations must be ${MAX_VARIATIONS} or fewer, got ${variations}. ` +
      `Each variation is ${PLATFORM_TARGETS.length} renders per concept ` +
      `(~$${(PLATFORM_TARGETS.length * ESTIMATED_COST_PER_RENDER_USD).toFixed(2)}); ` +
      `raise --max-renders deliberately if you really mean it.`
    );
  }
  const maxRendersRaw = getFlag('--max-renders');
  const maxRenders = maxRendersRaw === undefined ? DEFAULT_MAX_RENDERS : parseInt(maxRendersRaw, 10);
  if (!Number.isInteger(maxRenders) || maxRenders < 1) {
    throw new Error(`ad-studio: --max-renders must be a positive integer, got "${maxRendersRaw}"`);
  }
  const dryRun = argv.includes('--dry-run');
  return { product, variant, formats, variations, maxRenders, dryRun };
}

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

// artifactName() (packaging.js) always ends in ".png" — that suffix is pinned by
// Task 7's tests and is a placement-format label, not a promise about file bytes.
// Gemini can return JPEG, so the artifact actually written to disk must carry the
// real extension or we ship JPEG bytes inside a file named "*.png".
const EXTENSION_BY_MEDIA_TYPE = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };

function artifactFilename(baseName, mediaType) {
  const ext = EXTENSION_BY_MEDIA_TYPE[mediaType];
  if (!ext) throw new Error(`ad-studio: no known file extension for media type "${mediaType}"`);
  return baseName.replace(/\.png$/, ext);
}

/**
 * Render, crop and package ONE platform target.
 *
 * Everything that spends money — renderWithRetry and cropToRatio — is caught: a
 * render/verify failure on a single target (Anthropic error, a corrupt image,
 * anything) must not abort the rest of the run, because earlier targets, variations
 * and concepts already cost money. Callers write `buffer` to disk (null on failure)
 * and merge `proofEntry` into that variation's proof.json under `artifact`.
 *
 * renderRatioFor is the one exception and is deliberately called OUTSIDE the
 * try/catch: an unmapped delivery ratio is a code/config bug in RENDER_RATIO_MAP,
 * not a transient render failure. It's pure, free, and identical on every call for
 * a given ratio — every remaining target/variation/concept that shares that ratio
 * would fail the exact same way, so swallowing it as "one target failed, keep
 * going" would just mean paying for every other target while quietly producing no
 * plates at all. Fails the whole run immediately instead, before anything is spent.
 * @returns {Promise<{ok:boolean, artifact:string, buffer:Buffer|null, proofEntry:object}>}
 */
export async function renderTarget({ gemini, anthropic, target, format, zones, product, brandKit, photoPaths, expectedFinished, expectedPlate, volumeStrings = [], budget = null }) {
  const { requestRatio, needsCrop } = renderRatioFor(target.ratio);
  const artifactBase = artifactName(target.platform, target.ratio, target.mode);

  try {
    const prompt = buildRenderPrompt({ format, zones, product, brandKit, mode: target.mode });
    const expected = target.mode === 'finished' ? expectedFinished : expectedPlate;
    // mode is threaded all the way to verdictFor: a plate has no labels, so the
    // image/label pairing requirement must not be applied to it.
    const r = await renderWithRetry({
      gemini, anthropic, prompt, photoPaths, ratio: requestRatio, expected, format,
      zones, deliveryRatio: target.ratio,
      mode: target.mode, volumeStrings, physicalDescription: product.physicalDescription, budget,
    });

    // A budget stop before the first attempt produces no bytes at all.
    if (!r.buffer) {
      return {
        ok: false,
        artifact: artifactBase,
        buffer: null,
        proofEntry: {
          platform: target.platform,
          ratio: target.ratio,
          requestRatio,
          cropped: needsCrop,
          mode: target.mode,
          attempts: r.attempts,
          budgetStopped: Boolean(r.budgetStopped),
          ok: false,
          reasons: r.proof.reasons,
        },
      };
    }

    const buffer = needsCrop ? await cropToRatio(r.buffer, target.ratio) : r.buffer;
    const artifact = artifactFilename(artifactBase, r.mediaType);

    return {
      ok: r.ok,
      artifact,
      buffer,
      proofEntry: {
        platform: target.platform,
        ratio: target.ratio,
        requestRatio,
        cropped: needsCrop,
        mode: target.mode,
        mediaType: r.mediaType,
        attempts: r.attempts,
        budgetStopped: Boolean(r.budgetStopped),
        ok: r.proof.ok,
        reasons: r.proof.reasons,
        missing: r.proof.missing,
        // What the verifier said each region ACTUALLY reads — the thing a human
        // reviewing a rejected render needs, and the thing v1's proof.json could not
        // record because it only ever held an auto-corrected transcript.
        checkDetails: r.proof.checkDetails,
        volume: r.proof.volume,
        // R4. Every attribute's verdict, not just the failing ones — a human reading an
        // accepted frame's proof needs to see which attributes were actually judged and
        // which came back CANNOT_TELL, or "accepted" reads as "checked" when it wasn't.
        fidelity: r.proof.fidelity,
        // Stage 5b. Carries the 1-5 quality score even on an ACCEPTED frame — the score
        // exists to rank accepted frames for whoever chooses between them.
        critique: r.proof.critique,
        defects: r.proof.defects,
        mismatchedPairs: r.proof.mismatchedPairs,
        transcript: r.proof.transcript,
      },
    };
  } catch (err) {
    return {
      ok: false,
      artifact: artifactBase,
      buffer: null,
      proofEntry: {
        platform: target.platform,
        ratio: target.ratio,
        requestRatio,
        cropped: needsCrop,
        mode: target.mode,
        ok: false,
        error: err.message,
        attempts: null,
      },
    };
  }
}

/**
 * Render every platform target for ONE variation.
 *
 * Extracted from main() so the render budget's stop behaviour is testable end to end
 * with stubs — the ceiling that only exists inside main() is a ceiling nothing proves.
 * Writes nothing: returns the buffers for the caller to write, so tests need no disk.
 *
 * @returns {Promise<{proofByArtifact:object, artifacts:{name:string, buffer:Buffer}[], ok:boolean, skipped:string[]}>}
 */
export async function renderVariationTargets({
  gemini, anthropic, targets, format, zones, product, brandKit, photoPaths,
  expectedFinished, expectedPlate, volumeStrings = [], budget = null, onProgress = () => {},
}) {
  const proofByArtifact = {};
  const artifacts = [];
  const skipped = [];
  let allOk = true;

  for (const target of targets) {
    const base = artifactName(target.platform, target.ratio, target.mode);

    // Budget spent: stop cleanly and NAME what was dropped. Never silently truncate —
    // a short run that looks like a complete one is how $14 becomes an unexplained $42.
    if (budget && budget.exhausted()) {
      skipped.push(base);
      allOk = false;
      proofByArtifact[base] = {
        platform: target.platform,
        ratio: target.ratio,
        mode: target.mode,
        ok: false,
        skipped: true,
        budgetStopped: true,
        reasons: [`skipped — render budget of ${budget.max} exhausted`],
      };
      onProgress({ artifact: base, skipped: true });
      continue;
    }

    // renderTarget never throws for a render/verify failure — a failure on ONE target
    // (an Anthropic error, an unsupported-ratio 400, a corrupt image) must not discard
    // the rest of the run, because earlier targets/variations/concepts already cost
    // money. Reuses buildRunReport's existing rejected-variation path via ok=false.
    const result = await renderTarget({
      gemini, anthropic, target, format, zones, product, brandKit, photoPaths,
      expectedFinished, expectedPlate, volumeStrings, budget,
    });

    if (result.buffer) artifacts.push({ name: result.artifact, buffer: result.buffer });
    proofByArtifact[result.artifact] = result.proofEntry;
    if (!result.ok) allOk = false;
    if (result.proofEntry.budgetStopped) skipped.push(result.artifact);
    onProgress({ artifact: result.artifact, result });
  }

  return { proofByArtifact, artifacts, ok: allOk, skipped };
}

/**
 * A claim whose text was truncated out of its zone must not reach the claim gate — it
 * will never render, so sourcing it proves nothing.
 *
 * Matched on ZONE AND TEXT, never text alone. Keying on text alone silently filtered a
 * claim on a STRING zone (bottomBar) whose wording happened to match an item truncated
 * out of a different, ARRAY zone (listItems) — the bottomBar still renders, so an
 * unsourced claim would have reached a paid render with the gate none the wiser.
 */
export function filterDroppedClaims(claims, dropped) {
  if (!dropped || dropped.length === 0) return claims;
  return (claims || []).filter(c => !dropped.some(d => d.zone === c.zone && d.items.includes(c.text)));
}

/**
 * The verify gate's expected-text list for each mode, plus the volume markings the
 * gate compares the product's printed volume against.
 *
 * `productProminent` still decides whether labelStrings are demanded back as HARD
 * expected strings — on manifesto and problem-aware the product is deliberately tiny
 * ("small and understated at the bottom center", "present but not dominant") and
 * requiring a vision model to transcribe a 6pt brand mark off it fails every attempt
 * and burns the retries.
 *
 * `volumeStrings` is returned SEPARATELY and unconditionally, for every format,
 * prominent or not. That is the R2 fix: the flag used to strip labelStrings out
 * wholesale, so a wrong volume on a small product was not merely un-demanded, it was
 * un-checked — which is how "4 FL oz / 118ml" shipped on an 8 fl. oz. bottle. The
 * volume is now checked everywhere in a shape that tolerates illegibility but not
 * falsehood (verify.js's volumeVerdict).
 *
 * ── R2b: the volume is SUBTRACTED from the expected set (2026-08-14) ─────────────
 *
 * R2 shipped saying the double coverage on a prominent format was "the intended
 * ordering". It was not: the two mechanisms have different strictness and they
 * contradicted each other inside a single verdict. From a live run
 * (us-vs-them/v1/plate-1_91x1.jpg):
 *
 *   reasons: "8 fl. oz. (236ml)" — not present — that region reads "8 fl. oz - 236ml"
 *   volume:  { "status": "match" }
 *
 * volumeVerdict compares NUMBERS and tolerates separator/punctuation differences by
 * design, because the manifest prose writes the volume one way ("8 fl. oz. (236ml)")
 * and the physical label prints it another ("8 fl. oz - 236ml", "8 fl. oz • 236ml",
 * "8 fl. oz ~ 236ml"). The per-string check demands the character sequence literally
 * and fails every one of those. Three targets in one run were rejected for having a
 * correct, matching volume.
 *
 * So the volume markings are removed from the expected set in BOTH modes. The volume
 * is volumeVerdict's responsibility and only its — one fact, one mechanism. Coverage
 * is unchanged: volumeVerdict still runs on every format in every mode, and it is
 * strictly the more capable of the two (the per-string check could only ever ask about
 * the literal manifest spelling).
 *
 * Every NON-volume label string — brand mark, product type, variant name — is still
 * demanded back exactly as before on a productProminent format.
 */
export function expectedForFormat({ zones, format, product }) {
  const volumeStrings = selectVolumeStrings(product.labelStrings);
  const isVolume = new Set(volumeStrings);
  const labelStrings = format.productProminent
    ? (product.labelStrings || []).filter(s => !isVolume.has(s))
    : [];
  return {
    finished: [...expectedStrings(zones), ...labelStrings],
    plate: labelStrings,
    volumeStrings,
  };
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

/** The live storefront's public product JSON — no Admin API token required. */
async function fetchPdpBody(siteUrl, handle) {
  const url = `${siteUrl}/products/${handle}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ad-studio: failed to fetch PDP body for "${handle}" (${url}): ${res.status}`);
  const data = await res.json();
  return stripHtml(data?.product?.body_html);
}

// Quoted label text the manifest prose attributes to a BADGE (a seal/emblem/roundel) is
// excluded. Badge inscriptions are decorative micro-copy set on a curved arc at roughly
// 8px — they carry no product spec, so nothing about them is falsifiable, and the verify
// gate's vision model cannot transcribe them reliably at plate resolution (it read the
// coconut-lotion badge as ["ORGANIC","COCONUT","ESSENTIAL OIL"], dropping a word and
// singularising another, on a plate that was in fact correct). Requiring text that cannot
// be read back is a gate that burns three paid renders per target and buys nothing.
//
// Scoped to the badge CUE in the prose, not to the string's content or length: a rule
// keyed on either of those could swallow the volume marking or the variant name, which
// are the whole reason labelStrings exists.
// The manifest names the element on one side of the quote or the other, consistently:
//   coconut-lotion            ...a small circular badge noting "Organic Coconut Oil + ..."
//   foam-soap-*, coconut-soap ...a small circular "Organic Coconut Oil & ..." badge, a...
// so both sides are checked. No spec-bearing string in any manifest entry sits next to
// one of these nouns — verified across all 21 entries.
// BOTH patterns are anchored hard against the quote. An earlier, looser version matched
// the noun anywhere in the preceding segment and silently ate "hand soap" and
// "toothpaste" — product-type strings, which ARE spec-bearing — because a segment starts
// immediately after the *previous* quote, so a badge named there reached forward into the
// next string. Keep these anchored; widening them is how this guard gets gutted.
const BADGE_NOUNS = 'badge|seal|emblem|roundel|medallion';
// noun directly precedes the quote: ...a small circular badge noting "..."
const BADGE_BEFORE_RE = new RegExp(`\\b(?:${BADGE_NOUNS})\\b(?:\\s+(?:noting|reading|stating|saying|that reads))?[\\s,]*$`, 'i');
// noun directly follows the quote: ..."..." badge, a botanical illustration...
const BADGE_AFTER_RE = new RegExp(`^[\\s,]*\\b(?:${BADGE_NOUNS})\\b`, 'i');

function extractQuotedLabelText(text) {
  const prose = String(text || '');
  const out = [];
  for (const m of prose.matchAll(/"([^"]+)"/g)) {
    // Only the prose since the previous quote closed / until the next one opens, so a
    // badge mentioned elsewhere in the sentence cannot suppress an unrelated string.
    const lead = prose.slice(0, m.index).split('"').pop();
    const trail = prose.slice(m.index + m[0].length).split('"')[0];
    if (BADGE_BEFORE_RE.test(lead) || BADGE_AFTER_RE.test(trail)) continue;
    const s = m[1].replace(/,\s*$/, '').trim();
    if (s) out.push(s);
  }
  return out;
}

// "2 fl oz (60ml)" / "8 fl. oz. (236ml)" / "4 fl. oz • 118ml" — the manifest's prose
// states these with inconsistent punctuation, and not always inside quotes even when
// the quoted label text nearby makes clear it IS printed on the product.
const VOLUME_RE = /\d+(?:\.\d+)?\s*fl\.?\s*oz\.?(?:\s*[•(]\s*\d+(?:\.\d+)?\s*m?l\)?)?/gi;

function extractVolumeMarkings(text) {
  return [...String(text || '').matchAll(VOLUME_RE)].map(m => m[0].trim());
}

/**
 * Every SPEC-BEARING string physically printed on the product's label, pulled from two
 * sources:
 *   - quoted label text inside the manifest's productDescription, EXCEPT badge
 *     inscriptions — see BADGE_CUE_RE above for why decorative arc micro-copy is
 *     excluded (Task 9 fix round 5, controller ruling)
 *   - the volume marking in that same prose, in or out of quotes
 *   - the --variant name, humanized — productDescription is written generically across
 *     a product's scents/variants and does not name the specific one being rendered,
 *     so without this the scent name would never appear here at all
 *
 * Deliberately does NOT include the catalog title (data/brand/product-catalog.json).
 * That title is marketing/SEO copy, not label text — for coconut-lotion it's
 * "Non-Toxic Body Lotion Made With Only 6 Clean Ingredients", never printed on the
 * bottle. Including it broke in two directions at once: render.js's fidelity block
 * tells the image model "the label carries exactly these strings and no others", so
 * it would try to print that sentence on the bottle; and main() folds labelStrings
 * into the verify gate's expected text for finished frames, so the gate would then
 * REQUIRE that sentence to appear, rejecting a correctly-rendered bottle and burning
 * every retry attempt. (Task 9 fix round 1 — controller review caught this from the
 * dry-run output before any paid render ran.)
 *
 * Load-bearing, not defensive boilerplate: main() aborts if this comes back empty,
 * because an empty list is exactly how the image model invents a volume that was
 * never on the bottle (design probe: "6 fl. oz." rendered on a 2 fl oz bottle).
 */
export function buildLabelStrings({ manifestEntry, variant }) {
  const set = new Set();
  for (const s of extractQuotedLabelText(manifestEntry?.productDescription)) set.add(s);
  for (const s of extractVolumeMarkings(manifestEntry?.productDescription)) set.add(s);
  if (variant) set.add(variant.replace(/-/g, ' '));
  return [...set];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const env = loadEnv();
  if (!env.ANTHROPIC_API_KEY) throw new Error('ad-studio: missing ANTHROPIC_API_KEY in .env');
  if (!args.dryRun && !env.GEMINI_API_KEY) throw new Error('ad-studio: missing GEMINI_API_KEY in .env');

  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const gemini = env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }) : null;

  const handle = args.product;

  const manifest = loadJson(join(ROOT, 'data', 'product-images', 'manifest.json'));
  const manifestEntry = manifest.find(p => p.handle === handle);
  if (!manifestEntry) {
    throw new Error(`ad-studio: no entry for handle "${handle}" in data/product-images/manifest.json`);
  }

  const catalog = loadJson(join(ROOT, 'data', 'brand', 'product-catalog.json'));
  const catalogEntry = catalog.products?.[handle];
  if (!catalogEntry) {
    throw new Error(`ad-studio: no entry for handle "${handle}" in data/brand/product-catalog.json`);
  }

  const brandKit = loadJson(join(ROOT, 'data', 'brand', 'brand-kit.json'));

  const personasData = loadJson(join(ROOT, 'data', 'context', 'personas.json'));
  const rawPersona = personasData.personas?.[0] || null;
  // copy.js's buildCopyPrompt expects persona.angles as flat strings ("WHAT THEY
  // ALREADY TRIED"); personas.json's angles are objects, so project the field that
  // best matches that label.
  const persona = rawPersona
    ? {
        name: rawPersona.name,
        angles: (rawPersona.angles || []).map(a => a.objection_addressed || a.label).filter(Boolean),
      }
    : null;

  const site = loadJson(join(ROOT, 'config', 'site.json'));
  const pdpBody = await fetchPdpBody(site.url, handle);

  const labelStrings = buildLabelStrings({ manifestEntry, variant: args.variant });
  // ABORT — see buildLabelStrings' docstring. Not recoverable, no override flag.
  if (labelStrings.length === 0) {
    throw new Error(
      `ad-studio: labelStrings is empty for "${handle}" — refusing to render. An empty list ` +
      `is exactly how the image model invents a volume that was never on the bottle. Add ` +
      `quoted label text and a volume marking to this product's productDescription in ` +
      `data/product-images/manifest.json before running again.`
    );
  }

  const product = {
    handle,
    title: catalogEntry.title,
    priceLabel: catalogEntry.priceLabel,
    labelStrings,
    // R4. The manifest's prose description of the PHYSICAL product — "tall, slim lotion
    // bottle shape", "a black horizontal accent bar behind the variant name text". It was
    // being mined for label strings and volume markings and then dropped on the floor, so
    // the renderer knew what the label said and nothing about what the bottle was, and
    // the gate had nothing to compare a shape against. Both now read it.
    physicalDescription: manifestEntry.productDescription || '',
  };

  const sourceIndex = buildSourceIndex({ pdpBody, brandKit, catalogEntry });

  const formats = selectFormats(args.formats.length ? args.formats : undefined);

  // Stage 2: copy + the claim gate, per concept. Runs regardless of --dry-run — the
  // dry run's whole purpose is proving the gate fires against real generated copy
  // before anything costs money on the render side.
  //
  // A claim-gate failure on ONE concept must not cost the others — see buildConcepts/
  // buildConcept, which mirror renderVariationTargets/renderTarget's per-target
  // resilience. assertClaimsSourced itself is unchanged: still throws, still no
  // override flag; buildConcept is the caller the isolation belongs in.
  const { concepts, rejectedConcepts } = await buildConcepts({ anthropic, formats, product, pdpBody, persona, sourceIndex });

  if (rejectedConcepts.length) {
    console.log(
      `\nClaim gate rejected ${rejectedConcepts.length} of ${formats.length} concept(s): ` +
      `${rejectedConcepts.map(c => c.conceptSlug).join(', ')} — see run.json for violations.`
    );
  }

  if (args.dryRun) {
    console.log(`\nDRY RUN — ${concepts.length} concept(s) for ${product.title} (${handle}${args.variant ? '/' + args.variant : ''})`);
    console.log(`labelStrings: ${JSON.stringify(labelStrings)}\n`);
    for (const c of concepts) {
      console.log(`── ${c.format.key} — ${c.format.name} ──`);
      console.log('zones:');
      for (const [zone, value] of Object.entries(c.zones)) {
        console.log(`  ${zone}: ${JSON.stringify(value)}`);
      }
      console.log('claims:');
      if (!c.claims.length) console.log('  (none)');
      for (const claim of c.claims) {
        console.log(
          claim.factual
            ? `  [${claim.zone}] "${claim.text}" — sourced: ${claim.sourceId} ("${claim.evidence}")`
            : `  [${claim.zone}] "${claim.text}" — persuasion (not factual)`
        );
      }
      console.log('');
    }
    for (const c of rejectedConcepts) {
      console.log(`── ${c.conceptSlug} — REJECTED by the claim gate ──`);
      for (const v of c.violations) console.log(`  [${v.zone}] "${v.text}" — ${v.reason}`);
      console.log('');
    }
    console.log(
      concepts.length === formats.length
        ? 'Dry run complete — the claim gate passed for every concept above. No Gemini calls were made.'
        : `Dry run complete — ${concepts.length} concept(s) passed the claim gate, ${rejectedConcepts.length} rejected (see above). No Gemini calls were made.`
    );
    return { dryRun: true, concepts, rejectedConcepts };
  }

  // Stage 3-5: single-pass render → verify → package, one variation directory per N.
  const runId = `${handle}${args.variant ? '-' + args.variant : ''}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runDir = join(ROOT, 'data', 'creatives', 'ad-studio', runId);
  mkdirSync(runDir, { recursive: true });

  const photoDir = args.variant
    ? join(ROOT, 'data', 'product-images', manifestEntry.imageDir, args.variant)
    : join(ROOT, 'data', 'product-images', manifestEntry.imageDir);
  const photoPaths = selectReferencePhotos(photoDir);
  if (photoPaths.length === 0) {
    console.warn(`ad-studio: no reference photos found under ${photoDir} — rendering with zero product photos.`);
  }

  const budget = createRenderBudget(args.maxRenders);
  const skippedArtifacts = [];

  const results = [];
  for (const concept of concepts) {
    const { format, zones, claims } = concept;
    const conceptSlug = format.key;
    const conceptDir = join(runDir, conceptSlug);
    mkdirSync(conceptDir, { recursive: true });
    writeFileSync(join(conceptDir, 'copy.json'), JSON.stringify({ zones, claims }, null, 2));
    writeFileSync(join(conceptDir, 'demand-gen-assets.json'), JSON.stringify(buildDemandGenAssets(zones), null, 2));

    // Finished (Meta) frames must reproduce the ad copy AND — where the layout renders
    // the product large enough to read — the product's real label: an invented volume
    // shows up as a "missing expected string" the same way a misspelled headline would.
    // Plates (Demand Gen) carry no ad copy at all, only the product's own label.
    const { finished: expectedFinished, plate: expectedPlate, volumeStrings } = expectedForFormat({ zones, format, product });

    const variationsOut = [];
    for (let n = 1; n <= args.variations; n++) {
      const dir = variationDir(ROOT, runId, conceptSlug, n);
      mkdirSync(dir, { recursive: true });

      const { proofByArtifact, artifacts, ok: allOk, skipped } = await renderVariationTargets({
        gemini, anthropic, targets: PLATFORM_TARGETS, format, zones, product, brandKit, photoPaths,
        expectedFinished, expectedPlate, volumeStrings, budget,
        onProgress: ({ artifact, result, skipped: wasSkipped }) => {
          if (wasSkipped) {
            console.log(`  ${conceptSlug} v${n} ${artifact}: SKIPPED — render budget of ${budget.max} exhausted`);
            return;
          }
          console.log(
            result.buffer
              ? `  ${conceptSlug} v${n} ${artifact}: ${result.ok ? 'OK' : 'FAILED'} (${result.proofEntry.attempts} attempt(s))`
              : `  ${conceptSlug} v${n} ${artifact}: ERROR — ${result.proofEntry.error || result.proofEntry.reasons?.join('; ')}`
          );
        },
      });

      for (const a of artifacts) writeFileSync(join(dir, a.name), a.buffer);
      writeFileSync(join(dir, 'proof.json'), JSON.stringify(proofByArtifact, null, 2));
      for (const s of skipped) skippedArtifacts.push(`${conceptSlug}/v${n}/${s}`);
      variationsOut.push({ n, ok: allOk });
    }

    results.push({ conceptSlug, format: format.key, variations: variationsOut });
  }

  const report = finalizeRunReport({
    runDir, runId, product, results, renders: budget.used(),
    budget: { maxRenders: budget.max, stopped: skippedArtifacts.length > 0, skipped: skippedArtifacts },
    rejectedConcepts, concepts,
  });
  console.log(`\nRun complete: ${report.totals.accepted} accepted / ${report.totals.rejected} rejected. ${report.cost.renders} render(s), ≈$${report.cost.estimatedUsd}. Output: data/creatives/ad-studio/${runId}/`);
  if (report.budget?.stopped) {
    console.log(
      `BUDGET STOP — the --max-renders ceiling of ${report.budget.maxRenders} was reached. ` +
      `${report.budget.skippedCount} artifact(s) were not rendered:\n  ${report.budget.skipped.join('\n  ')}`
    );
  }

  return { report };
}

// Guard: importing this module must not run the agent.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then(async (result) => {
      if (result?.dryRun) return; // a proving run, not a production run — no digest noise
      const { report } = result || {};
      const budgetStopped = Boolean(report?.budget?.stopped);
      const rejectedByGate = report?.rejectedConcepts?.length || 0;
      const hasGaps = (report?.conceptsWithNoAcceptedVariation?.length || 0) > 0 || budgetStopped || rejectedByGate > 0;
      const body = report
        ? `${report.totals.accepted} accepted / ${report.totals.rejected} rejected across ${report.totals.concepts} concept(s).` +
          `\n${report.cost.renders} render(s), ≈$${report.cost.estimatedUsd}.` +
          (budgetStopped
            ? `\nBUDGET STOP at --max-renders ${report.budget.maxRenders} — ${report.budget.skippedCount} artifact(s) skipped.`
            : '') +
          (rejectedByGate
            ? `\nClaim gate rejected ${rejectedByGate} concept(s): ${report.rejectedConcepts.map(c => c.conceptSlug).join(', ')}.`
            : '') +
          (report.conceptsWithNoAcceptedVariation.length ? `\nNo accepted variation: ${report.conceptsWithNoAcceptedVariation.join(', ')}` : '') +
          `\nOutput: data/creatives/ad-studio/${report.runId}/`
        : 'Ad Studio run complete.';
      await notify({
        subject: `Ad Studio run complete — ${report?.product?.title || ''}`,
        body,
        status: hasGaps ? 'error' : 'success',
        category: 'ads',
      }).catch(() => {});
    })
    .catch(async (err) => {
      await notify({ subject: 'Ad Studio failed', body: err.message || String(err), status: 'error', category: 'ads' }).catch(() => {});
      console.error(err);
      process.exit(1);
    });
}
