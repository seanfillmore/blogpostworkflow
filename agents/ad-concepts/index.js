// agents/ad-concepts/index.js
//
// Concept-first ad creation. One run → one Meta flexible ad: 3 finished images from 3
// distinct concepts, 2 primary texts, 2 headlines. Spec:
// docs/superpowers/specs/2026-10-03-ad-concepts-design.md
//
//   node agents/ad-concepts/index.js --product <handle> [--variant <name>]
//     [--concept "<idea>"]... [--ratio 4:5|1:1] [--max-renders 30] [--dry-run]
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { notify as realNotify } from '../../lib/notify.js';
import { archiveRunOutput } from '../../lib/archive-run-output.js';
import { USD_PER_RENDER } from '../../lib/ad-studio-cost.js';
import { renderFlexibleManifest } from '../ad-studio/flexible.js';
import { ratioSlug } from '../ad-studio/packaging.js';
import { createRenderBudget, sniffImageMediaType } from '../ad-studio/index.js';
import { selectVolumeStrings } from '../ad-studio/verify.js';
import { selectQuotableReviews } from '../ad-studio/health-claims.js';
import { buildSourceIndex } from '../ad-studio/claims.js';
import { buildConceptPrompt, parseConceptsResponse, preGate, buildJudgePrompt, parseJudgeResponse, pickConcepts, nextReplacement } from './concepts.js';
import { buildShotSpecPrompt, parseShotSpec, buildTakePrompt, runConceptTakes } from './shots.js';
import { writeOverlayCopy, writeFlexibleCopy } from './copy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_MAX_RENDERS = 30;
export const RATIOS = Object.freeze(['4:5', '1:1']);
const SLOTS = 3;

export function parseArgs(argv) {
  const a = { product: null, variant: null, concepts: [], ratio: '4:5', maxRenders: DEFAULT_MAX_RENDERS, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${k} needs a value`); return x; };
    if (k === '--product') a.product = v();
    else if (k === '--variant') a.variant = v();
    else if (k === '--concept') a.concepts.push(v());
    else if (k === '--ratio') a.ratio = v();
    else if (k === '--max-renders') a.maxRenders = Number(v());
    else if (k === '--dry-run') a.dryRun = true;
    else throw new Error(`unknown argument ${k}`);
  }
  if (!a.product) throw new Error('--product is required');
  if (!RATIOS.includes(a.ratio)) throw new Error(`--ratio must be one of ${RATIOS.join(', ')}`);
  if (!Number.isInteger(a.maxRenders) || a.maxRenders < 1) throw new Error('--max-renders must be a positive integer');
  return a;
}

const textOf = (m) => (m?.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
async function ask(anthropic, model, content, maxTokens) {
  const msg = await anthropic.messages.create({ model, max_tokens: maxTokens, messages: [{ role: 'user', content }] });
  if (msg.stop_reason === 'max_tokens') throw new Error('ad-concepts: a model response was cut off at the token limit');
  return textOf(msg);
}
const writeJson = (p, o) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(o, null, 2)); };
const firstLine = (e) => String(e?.message || e).split('\n')[0];

/** Stated wherever needsHumanReview appears: the flag exists BECAUSE nothing checks this. */
export const NEEDS_HUMAN_REVIEW_NOTE =
  'verify.js checks nothing about anatomy. These images show a person (hands or a face), so a human must look at every hand and face before the ad ships.';

/** The product block the whole run reads. priceLabel and url ride along for the flexible copy and manifest. */
export function buildEvidenceProduct({ args, manifestEntry, catalogEntry, studio }) {
  return {
    handle: args.product, title: catalogEntry.title, variant: args.variant, unitCount: manifestEntry.unitCount,
    priceLabel: catalogEntry.priceLabel || null, url: catalogEntry.url || null,
    labelStrings: studio.buildLabelStrings({ manifestEntry, variant: args.variant }),
    badgeStrings: studio.resolveBadgeStrings({ manifestEntry, variant: args.variant }),
    labelInk: manifestEntry.labelInk || null, physicalDescription: manifestEntry.productDescription || '',
  };
}

/**
 * Reviews are screened ONCE, here, before they become anything: a review carrying health-claim
 * language (selectQuotableReviews) never reaches a prompt AND never becomes citable evidence,
 * because "it came from a review" is not a defence (see agents/ad-studio/health-claims.js).
 */
export function quotableEvidence({ pdpBody, brandKit, catalogEntry, reviews }) {
  const quotable = selectQuotableReviews(reviews || []);
  return { reviews: quotable, sourceIndex: buildSourceIndex({ pdpBody, brandKit, catalogEntry, reviews: quotable }) };
}

/** renderFlexibleManifest's markdown is written for three images; make a short run say what it is. */
function finishFlexibleMd(md, { n, productUrl, reviewFiles }) {
  let out = md;
  if (n !== SLOTS) {
    const word = n === 2 ? 'both' : `all ${n}`;
    out = out.replace('add all three images', `add ${word} images`).replace('all three plates share this ratio', `${word} images share this ratio`);
  }
  const extra = [];
  if (productUrl) extra.push(`**Product URL:** ${productUrl}  `);
  if (n < SLOTS) {
    extra.push('', `> **SHORT RUN: ${n} image${n === 1 ? '' : 's'}, not ${SLOTS}.** Only ${n} concept${n === 1 ? '' : 's'} finished, so build this ad with the ${n} image${n === 1 ? '' : 's'} listed below. Do not look for a third.`);
  }
  if (extra.length) out = out.replace('\n\n## Build it as ONE ad', `\n${extra.join('\n')}\n\n## Build it as ONE ad`);
  if (reviewFiles.length) {
    out += `\n## Needs a human look before it ships\n\n${NEEDS_HUMAN_REVIEW_NOTE}\n\n${reviewFiles.map(f => `- \`${f}\``).join('\n')}\n`;
  }
  return out;
}

export async function runConcepts({ args, deps }) {
  const stamp = deps.now().toISOString().replace(/[:.]/g, '-');
  const runId = `concepts-${args.product}-${args.variant || 'default'}-${stamp}`;
  const runDir = join(deps.outRoot, runId);
  mkdirSync(runDir, { recursive: true });
  // main() archives this directory on SIGINT/SIGTERM; it needs to know it before anything is paid for.
  deps.onStart?.({ runDir, runId });
  const ev = await deps.loadEvidence({ product: args.product, variant: args.variant });
  const { product, sourceIndex } = ev;

  // THROW before any paid call. Fidelity is a hard gate and the reference photographs are what
  // a take is checked against; with none, hasReference is false and the check switches itself
  // off while the run still bills for renders. Same reasoning as agents/ad-studio/index.js.
  if (!ev.photoPaths || ev.photoPaths.length === 0) {
    const dir = ev.photoDir || `data/product-images/<imageDir>/${args.variant || ''}`;
    throw new Error(
      `ad-concepts: no reference photos under ${dir}. A take rendered without them cannot be checked ` +
      `for product fidelity, so this run would bill for unverifiable renders.\n` +
      `  In a worktree this usually means data/product-images/ was never linked (it is gitignored); ` +
      `scripts/new-worktree.sh links it.`
    );
  }
  // Mirrors agents/ad-studio/index.js: an empty label list is how the image model invents a
  // volume that was never on the product. Not recoverable, no override flag.
  if (!product.labelStrings || product.labelStrings.length === 0) {
    throw new Error(
      `ad-concepts: labelStrings is empty for "${args.product}", refusing to render. An empty list ` +
      `is exactly how the image model invents a volume that was never on the label. Add quoted ` +
      `label text and a volume marking to this product's productDescription in ` +
      `data/product-images/manifest.json before running again.`
    );
  }

  const verdicts = {};
  let generated = [];
  let survivors = [];
  let scored = [];
  let picked = [];
  let runnersUp = [];
  const promoted = new Set();
  let requestedGated = [];
  let requestedMissing = null;
  const budget = createRenderBudget(args.maxRenders);
  const finals = [];
  const skipped = [];
  let budgetStopped = false;
  let manifest = null;
  let manifestReason = null;
  let dry = false;

  const writeConcepts = () => writeJson(join(runDir, 'concepts.json'), {
    runId, generated: generated.length,
    concepts: [...scored, ...generated.filter(g => !survivors.includes(g))].map(c => ({
      ...c,
      verdict: verdicts[c.id] || (picked.includes(c) ? 'picked' : promoted.has(c) ? 'picked (replacement)' : runnersUp.includes(c) ? 'runner-up' : 'outscored'),
    })),
  });

  const buildReport = (error = null) => {
    const renders = dry ? 0 : budget.used();
    const needsHumanReview = dry ? [] : finals.filter(f => f.take.needsHumanReview.length).map(f => f.concept.id);
    return {
      kind: 'concepts', runId, generatedAt: deps.now().toISOString(),
      product: { handle: product.handle, title: product.title }, variant: args.variant,
      totals: { artifacts: dry ? 0 : finals.length },
      results: dry ? [] : finals.map(f => ({ conceptSlug: f.concept.id, file: f.file, score: f.score })),
      rejectedConcepts: Object.entries(verdicts).map(([conceptSlug, err]) => ({ conceptSlug, error: err })),
      requestedGated: requestedGated.map(c => ({ conceptSlug: c.id, reason: verdicts[c.id] })),
      requestedMissing,
      cost: { renders, perRenderUsd: USD_PER_RENDER, estimatedUsd: Number((renders * USD_PER_RENDER).toFixed(2)) },
      budget: { maxRenders: args.maxRenders, stopped: dry ? false : budgetStopped, skipped: dry ? [] : skipped, skippedCount: dry ? 0 : skipped.length },
      manifest: manifest ? 'flexible-ad.json' : null,
      manifestReason: dry ? 'dry run' : manifestReason,
      needsHumanReview,
      needsHumanReviewNote: needsHumanReview.length ? NEEDS_HUMAN_REVIEW_NOTE : null,
      ...(error ? { error: String(error?.stack || error?.message || error) } : {}),
    };
  };

  // One concept: shot spec, takes (each written to disk the moment it is verified), copy,
  // typeset, critique. Returns the best final or null; may throw, and the caller turns a throw
  // into a per-concept failure instead of losing the run.
  async function runOne(c) {
    const rSlug = ratioSlug(args.ratio);
    const dir = join(runDir, c.id, 'v1');
    mkdirSync(dir, { recursive: true });
    const proofs = {};
    const writeProofs = () => writeJson(join(dir, 'proof.json'), proofs);
    try {
      const sceneSpec = parseShotSpec(await ask(deps.anthropic, deps.models.shot, buildShotSpecPrompt({ concept: c, product, ratio: args.ratio }), 1200));
      const prompt = buildTakePrompt({ sceneSpec, concept: c, product, brandKit: ev.brandKit });
      const takes = await runConceptTakes({
        concept: c, prompt, budget,
        render: (p) => deps.render(p, { ratio: args.ratio, budget }),
        verify: async (buffer) => {
          const mediaType = sniffImageMediaType(buffer);
          const proof = await deps.verifyImage({
            buffer, mediaType, referencePhotos: deps.referencePhotos ?? [], expected: [], mode: 'plate',
            format: { key: c.id, plateSetting: 'scene', pairsImagesWithLabels: false },
            physicalDescription: product.physicalDescription, unitCount: product.unitCount, variant: product.variant,
            expectedLabelInk: product.labelInk, expectedBadge: product.badgeStrings,
            volumeStrings: selectVolumeStrings(product.labelStrings), allowedSceneText: c.sceneText === 'illegible-print' ? 'illegible-print' : null,
          });
          return { mediaType, proof };
        },
        onTake: (t) => {
          const name = `meta-plate-take${t.n}-${rSlug}.jpg`;
          writeFileSync(join(dir, name), t.buffer);
          proofs[name] = { ...t.proof, needsHumanReview: t.needsHumanReview };
          writeProofs();
        },
      });
      if (takes.budgetStopped) budgetStopped = true;
      if (!takes.passed.length) {
        const why = [...new Set(takes.takes.flatMap(t => t.proof.reasons || []))].slice(0, 3).join('; ');
        verdicts[c.id] = `no take passed verification${takes.budgetStopped ? ' (budget ran out)' : ''}${why ? `: ${why}` : ''}`;
        return null;
      }
      let copy;
      try {
        copy = await writeOverlayCopy({ anthropic: deps.anthropic, model: deps.models.copy, concept: c, product, pdpBody: ev.pdpBody, sourceIndex, competitorNames: ev.competitorNames || [] });
      } catch (e) {
        if (/cut off/.test(e.message)) throw e;
        copy = { ok: false, reasons: [firstLine(e)] };
      }
      if (!copy.ok) { verdicts[c.id] = `copy rejected: ${copy.reasons.join('; ')}`; return null; }
      writeJson(join(runDir, c.id, 'copy.json'), { zones: { headline: copy.copy.headline, sub: copy.copy.sub }, claims: copy.copy.claims });
      let best = null;
      for (const t of takes.passed) {
        const plate = `meta-plate-take${t.n}-${rSlug}.jpg`;
        let set = await deps.typeset({ buffer: t.buffer, headline: copy.copy.headline, sub: copy.copy.sub, band: c.typeBand, treatment: 'band' });
        let crit = await deps.critique({ buffer: set.buffer, mediaType: set.mediaType, zones: { headline: copy.copy.headline, sub: copy.copy.sub } });
        if (!crit.ok || set.overflow) {
          set = await deps.typeset({ buffer: t.buffer, headline: copy.copy.headline, sub: copy.copy.sub, band: c.typeBand, treatment: 'caption' });
          crit = await deps.critique({ buffer: set.buffer, mediaType: set.mediaType, zones: { headline: copy.copy.headline, sub: copy.copy.sub } });
        }
        const name = `meta-final-take${t.n}-${rSlug}.jpg`;
        writeFileSync(join(dir, name), set.buffer);
        proofs[plate].critique = crit;
        proofs[plate].final = name;
        writeProofs();
        if (crit.ok && !set.overflow && (!best || (crit.score ?? 0) > (best.score ?? 0))) {
          best = { take: t, file: join(c.id, 'v1', name), score: crit.score, concept: c, headline: copy.copy.headline, sub: copy.copy.sub };
        }
      }
      if (!best) verdicts[c.id] = 'typeset/critique failed on both treatments';
      return best;
    } finally {
      writeProofs();
    }
  }

  async function body() {
    // 1. Concepts: generate (one retry on malformed JSON), pre-gate, judge, pick.
    const conceptPrompt = buildConceptPrompt({ ...ev, requested: args.concepts, count: 18, sourceIds: Object.keys(sourceIndex) });
    try { generated = parseConceptsResponse(await ask(deps.anthropic, deps.models.concept, conceptPrompt, 12000)); }
    catch (e) {
      if (/cut off/.test(e.message)) throw e;
      generated = parseConceptsResponse(await ask(deps.anthropic, deps.models.concept, `${conceptPrompt}\n\nYour previous reply was not valid JSON (${e.message}). Return ONLY the JSON.`, 12000));
    }
    // "requested" means the OPERATOR asked for it. Without --concept nothing is requested,
    // whatever the model echoed; with it, a shortfall is reported rather than silently absorbed.
    if (!args.concepts.length) for (const c of generated) c.requested = false;
    else {
      const got = generated.filter(c => c.requested).length;
      if (got < args.concepts.length) requestedMissing = args.concepts.length - got;
    }
    for (const c of generated) {
      const g = preGate(c, { sourceIndex, competitorNames: ev.competitorNames });
      if (g.ok) survivors.push(c); else verdicts[c.id] = `gated: ${g.reasons.join('; ')}`;
    }
    const judged = survivors.length ? parseJudgeResponse(await ask(deps.anthropic, deps.models.judge, buildJudgePrompt(survivors), 4000), survivors.length) : [];
    scored = survivors.map((c, i) => { const j = judged.find(x => x.i === i); return { ...c, scores: j?.scores || null, total: j?.total ?? 0 }; });
    ({ picked, runnersUp } = pickConcepts(scored, { slots: SLOTS }));
    writeConcepts();
    requestedGated = generated.filter(c => c.requested && verdicts[c.id]);
    if (args.dryRun) { dry = true; return; }

    // 2-3. Takes, gates, copy, typeset, critique, per concept, with replacement.
    const used = new Set(picked.map(c => c.family));
    const queue = [...picked];
    while (queue.length && finals.length < SLOTS) {
      const c = queue.shift();
      if (budgetStopped) { skipped.push(c.id); continue; }
      let best = null;
      try { best = await runOne(c); }
      catch (e) {
        // One concept's failure is that concept's failure: record it, replace it, carry on.
        verdicts[c.id] = `failed: ${firstLine(e)}`;
        if (budget.exhausted()) budgetStopped = true;
      }
      if (best) { finals.push(best); continue; }
      const rep = nextReplacement(runnersUp.filter(r => !queue.includes(r) && !finals.some(f => f.concept === r)), used);
      if (rep) { used.add(rep.family); queue.push(rep); runnersUp.splice(runnersUp.indexOf(rep), 1); promoted.add(rep); }
    }
    for (const c of queue) skipped.push(c.id);
    writeConcepts();

    manifestReason = `fewer than 2 concepts finished (${finals.length})`;
    if (finals.length >= 2) {
      const flex = await writeFlexibleCopy({
        anthropic: deps.anthropic, model: deps.models.copy, product,
        concepts: finals.map(f => ({ ...f.concept, overlayHeadline: f.headline, overlaySub: f.sub })),
        sourceIndex, pdpBody: ev.pdpBody, persona: ev.persona, reviews: ev.reviews, competitorNames: ev.competitorNames || [],
      });
      if (flex.ok) {
        const { json, md } = renderFlexibleManifest({
          runId, product, variant: args.variant, target: { platform: 'meta', ratio: args.ratio },
          plates: finals.map(f => ({ format: f.concept.id, file: f.file, verified: true })),
          primaryTexts: flex.primaryTexts, headlines: flex.headlines, claims: flex.claims,
        });
        const review = finals.filter(f => f.take.needsHumanReview.length);
        manifest = {
          ...json, productUrl: product.url || null, short: finals.length < SLOTS,
          needsHumanReview: review.map(f => f.concept.id),
          needsHumanReviewNote: review.length ? NEEDS_HUMAN_REVIEW_NOTE : null,
          goldenThread: flex.goldenThread || [],
        };
        writeJson(join(runDir, 'flexible-ad.json'), manifest);
        writeFileSync(join(runDir, 'flexible-ad.md'), finishFlexibleMd(md, { n: finals.length, productUrl: product.url, reviewFiles: review.map(f => f.file) }));
        manifestReason = null;
      } else {
        manifestReason = `flexible copy rejected: ${flex.reasons.join('; ')}`;
      }
    }
  }

  try {
    await body();
  } catch (err) {
    // Something escaped a concept (or happened outside one). The renders already on disk are
    // the expensive part: record what is known, archive, THEN rethrow. Nothing here may mask err.
    try { if (generated.length) writeConcepts(); } catch { /* keep the real error */ }
    try { writeJson(join(runDir, 'run.json'), buildReport(err)); } catch { /* keep the real error */ }
    try { deps.archive({ sourceDir: runDir, runId }); } catch { /* keep the real error */ }
    throw err;
  }

  const report = buildReport();
  writeJson(join(runDir, 'run.json'), report);
  deps.archive({ sourceDir: runDir, runId });
  const n = dry ? 0 : finals.length;
  const subject = dry
    ? `Ad Concepts dry run, ${product.title}: ${picked.length} concepts picked`
    : `Ad Concepts, ${product.title}: ${n} image${n === 1 ? '' : 's'}${manifest?.short ? ' (SHORT)' : ''}${report.needsHumanReview.length ? ' · NEEDS HUMAN REVIEW' : ''}`;
  const lines = [`Run ${runId}`, manifest ? 'flexible-ad.md is ready.' : `No flexible ad: ${dry ? 'dry run' : manifestReason}.`];
  if (requestedMissing) lines.push(`${requestedMissing} of ${args.concepts.length} requested concept(s) did not come back from the concept call.`);
  if (report.needsHumanReview.length) lines.push(`Needs human review (${report.needsHumanReview.join(', ')}): ${NEEDS_HUMAN_REVIEW_NOTE}`);
  await deps.notify({ subject, body: lines.join('\n'), status: 'info', category: 'ads' });
  return report;
}
// Set by main() once runConcepts names its run directory; cleared on the first archive so the
// success path, the error path and a signal cannot copy the same run twice. Module scope only
// holds the pointer: nothing is installed at import (agents must not run on import).
let ARCHIVE_ON_EXIT = null;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { default: Anthropic } = await import('../../lib/anthropic.js');
  const { GoogleGenAI } = await import('@google/genai');
  const studio = await import('../ad-studio/index.js');
  const { selectReferencePhotos } = await import('../ad-studio/render.js');
  const { overlayPersonas } = await import('../../lib/operator-angles.js');
  const { scanSkillInventory, renderContextMirror } = await import('../../lib/marketing-learner.js');
  const { typesetTake } = await import('./typeset.js');
  const { CREATIVE_MODELS } = await import('../../config/creative-models.js');
  const env = Object.fromEntries(readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
  const manifestEntry = loadJson('data/product-images/manifest.json').find(e => e.handle === args.product);
  if (!manifestEntry) throw new Error(`ad-concepts: "${args.product}" is not in data/product-images/manifest.json`);
  const photoDir = join(ROOT, 'data', 'product-images', manifestEntry.imageDir, args.variant || '');
  const photoPaths = selectReferencePhotos(photoDir, 4);
  const outRoot = join(ROOT, 'data', 'creatives', 'ad-studio');

  // Archive on EVERY exit path, as Ad Studio does: success, a thrown error, and SIGINT/SIGTERM.
  // A run's images are untracked inside a worktree, and `git worktree remove --force` deletes them.
  let pending = null;
  const flushArchive = () => {
    if (!pending) return;
    const p = pending;
    pending = null;
    ARCHIVE_ON_EXIT = null;
    const dest = archiveRunOutput({ sourceDir: p.sourceDir, runId: p.runId, relativeDir: 'data/creatives/ad-studio', root: ROOT, label: 'ad-concepts' });
    if (dest) console.log(`Archived to: ${dest}`);
  };
  // Registered inside main, `once`, so a second Ctrl-C is not swallowed.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      console.warn(`\nad-concepts: ${sig}, archiving run output before exit.`);
      try { flushArchive(); } catch (e) { console.warn(`archive failed: ${e.message}`); }
      process.exit(130);
    });
  }

  const report = await runConcepts({
    args,
    deps: {
      root: ROOT, outRoot, now: () => new Date(),
      models: { concept: CREATIVE_MODELS.adStudio.angle, judge: CREATIVE_MODELS.adStudio.verify, shot: CREATIVE_MODELS.adStudio.copy, copy: CREATIVE_MODELS.adStudio.copy },
      anthropic,
      referencePhotos: studio.loadReferencePhotos(photoPaths),
      onStart: ({ runDir, runId }) => { pending = { sourceDir: runDir, runId }; ARCHIVE_ON_EXIT = flushArchive; },
      loadEvidence: async () => {
        const catalogEntry = loadJson('data/brand/product-catalog.json').products?.[args.product];
        if (!catalogEntry) throw new Error(`ad-concepts: no catalog entry for "${args.product}"`);
        const brandKit = loadJson('data/brand/brand-kit.json');
        const pdpBody = await studio.fetchPdpBody(loadJson('config/site.json').url, args.product);
        const { reviews, sourceIndex } = quotableEvidence({ pdpBody, brandKit, catalogEntry, reviews: await studio.fetchAdReviews(args.product, { env }) });
        const persona = studio.projectPersonaForCopy(overlayPersonas(loadJson('data/context/personas.json'), { root: ROOT })).persona;
        const product = buildEvidenceProduct({ args, manifestEntry, catalogEntry, studio });
        return {
          product, catalogEntry, brandKit, pdpBody, persona, reviews, sourceIndex,
          photoPaths, photoDir, competitorNames: loadJson('config/competitors.json').map(c => c.name),
          tactics: renderContextMirror(scanSkillInventory(join(ROOT, '.claude', 'skills'))).trim(),
        };
      },
      render: (prompt, { ratio, budget }) => studio.renderVariationWithBackoff(gemini, { prompt, photoPaths, ratio }, { budget }),
      verifyImage: (o) => studio.verifyImage({ anthropic, ...o }),
      typeset: typesetTake,
      critique: ({ buffer, mediaType, zones }) => studio.critiqueArtifact({ anthropic, buffer, mediaType, format: { key: 'concept' }, zones, mode: 'finished', ratio: args.ratio }),
      notify: realNotify,
      archive: () => flushArchive(),
    },
  });
  console.log(`\n${report.runId}\n${report.manifest ? `Flexible ad: ${join(outRoot, report.runId, 'flexible-ad.md')}` : 'No flexible ad this run (see run.json).'}`);
  if (report.needsHumanReview.length) console.log(`NEEDS HUMAN REVIEW (people in frame): ${report.needsHumanReview.join(', ')}. ${NEEDS_HUMAN_REVIEW_NOTE}`);
}

if (isDirectRun(import.meta.url)) {
  main().catch(async (err) => {
    // runConcepts already archived on a thrown error; this covers anything that escaped before it.
    try { ARCHIVE_ON_EXIT?.(); } catch { /* archiving must never mask the real error */ }
    await realNotify({ subject: 'Ad Concepts failed', body: err.message || String(err), status: 'error', category: 'ads' }).catch(() => {});
    console.error(err);
    process.exit(1);
  });
}
