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

export async function runConcepts({ args, deps }) {
  const stamp = deps.now().toISOString().replace(/[:.]/g, '-');
  const runId = `concepts-${args.product}-${args.variant || 'default'}-${stamp}`;
  const runDir = join(deps.outRoot, runId);
  mkdirSync(runDir, { recursive: true });
  const ev = await deps.loadEvidence({ product: args.product, variant: args.variant });
  const { product, sourceIndex } = ev;

  // 1. Concepts: generate (one retry on malformed JSON), pre-gate, judge, pick.
  const conceptPrompt = buildConceptPrompt({ ...ev, requested: args.concepts, count: 18, sourceIds: Object.keys(sourceIndex) });
  let generated;
  try { generated = parseConceptsResponse(await ask(deps.anthropic, deps.models.concept, conceptPrompt, 12000)); }
  catch (e) {
    if (/cut off/.test(e.message)) throw e;
    generated = parseConceptsResponse(await ask(deps.anthropic, deps.models.concept, `${conceptPrompt}\n\nYour previous reply was not valid JSON (${e.message}). Return ONLY the JSON.`, 12000));
  }
  const verdicts = {};
  const survivors = [];
  for (const c of generated) {
    const g = preGate(c, { sourceIndex, competitorNames: ev.competitorNames });
    if (g.ok) survivors.push(c); else verdicts[c.id] = `gated: ${g.reasons.join('; ')}`;
  }
  const judged = survivors.length ? parseJudgeResponse(await ask(deps.anthropic, deps.models.judge, buildJudgePrompt(survivors), 4000), survivors.length) : [];
  const scored = survivors.map((c, i) => { const j = judged.find(x => x.i === i); return { ...c, scores: j?.scores || null, total: j?.total ?? 0 }; });
  const { picked, runnersUp } = pickConcepts(scored, { slots: SLOTS });
  const writeConcepts = () => writeJson(join(runDir, 'concepts.json'), {
    runId, generated: generated.length,
    concepts: [...scored, ...generated.filter(g => !survivors.includes(g))].map(c => ({ ...c, verdict: verdicts[c.id] || (picked.includes(c) ? 'picked' : runnersUp.includes(c) ? 'runner-up' : 'outscored') })),
  });
  writeConcepts();
  const requestedGated = generated.filter(c => c.requested && verdicts[c.id]);
  const budget = createRenderBudget(args.maxRenders);
  const finals = [];
  const skipped = [];
  let budgetStopped = false;
  let manifest = null;
  if (args.dryRun) return finish({ dry: true });

  // 2-3. Takes, gates, copy, typeset, critique, per concept, with replacement.
  const referencePhotos = deps.referencePhotos ?? [];
  const used = new Set(picked.map(c => c.family));
  const queue = [...picked];
  const rSlug = ratioSlug(args.ratio);

  while (queue.length && finals.length < SLOTS) {
    const c = queue.shift();
    if (budgetStopped) { skipped.push(c.id); continue; }
    const sceneSpec = parseShotSpec(await ask(deps.anthropic, deps.models.shot, buildShotSpecPrompt({ concept: c, product, ratio: args.ratio }), 1200));
    const prompt = buildTakePrompt({ sceneSpec, concept: c, product, brandKit: ev.brandKit });
    const takes = await runConceptTakes({
      concept: c, prompt, budget,
      render: (p) => deps.render(p, { ratio: args.ratio, budget }),
      verify: async (buffer) => {
        const mediaType = buffer.length >= 12 ? sniffImageMediaType(buffer) : (buffer[0] === 0x89 ? 'image/png' : 'image/jpeg');
        const proof = await deps.verifyImage({
          buffer, mediaType, referencePhotos, expected: [], mode: 'plate',
          format: { key: c.id, plateSetting: 'scene', pairsImagesWithLabels: false },
          physicalDescription: product.physicalDescription, unitCount: product.unitCount, variant: product.variant,
          expectedLabelInk: product.labelInk, expectedBadge: product.badgeStrings,
          volumeStrings: product.labelStrings, allowedSceneText: c.sceneText === 'illegible-print' ? 'illegible-print' : null,
        });
        return { mediaType, proof };
      },
    });
    if (takes.budgetStopped) budgetStopped = true;
    const dir = join(runDir, c.id, 'v1');
    mkdirSync(dir, { recursive: true });
    const proofs = {};
    for (const t of takes.takes) {
      writeFileSync(join(dir, `meta-plate-take${t.n}-${rSlug}.jpg`), t.buffer);
      proofs[`meta-plate-take${t.n}-${rSlug}.jpg`] = { ...t.proof, needsHumanReview: t.needsHumanReview };
    }
    let best = null;
    if (takes.passed.length) {
      let copy;
      try {
        copy = await writeOverlayCopy({ anthropic: deps.anthropic, model: deps.models.copy, concept: c, product, pdpBody: ev.pdpBody, sourceIndex });
      } catch (e) {
        if (/cut off/.test(e.message)) throw e;
        copy = { ok: false, reasons: [String(e.message).split('\n')[0]] };
      }
      if (copy.ok) {
        writeJson(join(runDir, c.id, 'copy.json'), { zones: { headline: copy.copy.headline, sub: copy.copy.sub }, claims: copy.copy.claims });
        for (const t of takes.passed) {
          let set = await deps.typeset({ buffer: t.buffer, headline: copy.copy.headline, sub: copy.copy.sub, band: c.typeBand, treatment: 'band' });
          let crit = await deps.critique({ buffer: set.buffer, mediaType: set.mediaType, zones: { headline: copy.copy.headline, sub: copy.copy.sub } });
          if (!crit.ok || set.overflow) {
            set = await deps.typeset({ buffer: t.buffer, headline: copy.copy.headline, sub: copy.copy.sub, band: c.typeBand, treatment: 'caption' });
            crit = await deps.critique({ buffer: set.buffer, mediaType: set.mediaType, zones: { headline: copy.copy.headline, sub: copy.copy.sub } });
          }
          const name = `meta-final-take${t.n}-${rSlug}.jpg`;
          writeFileSync(join(dir, name), set.buffer);
          proofs[`meta-plate-take${t.n}-${rSlug}.jpg`].critique = crit;
          proofs[`meta-plate-take${t.n}-${rSlug}.jpg`].final = name;
          if (crit.ok && !set.overflow && (!best || (crit.score ?? 0) > (best.score ?? 0))) best = { take: t, file: join(c.id, 'v1', name), score: crit.score, concept: c };
        }
      } else {
        verdicts[c.id] = `copy rejected: ${copy.reasons.join('; ')}`;
      }
    }
    writeJson(join(dir, 'proof.json'), proofs);
    if (best) finals.push(best);
    else {
      const rep = nextReplacement(runnersUp.filter(r => !queue.includes(r) && !finals.some(f => f.concept === r)), used);
      if (rep) { used.add(rep.family); queue.push(rep); runnersUp.splice(runnersUp.indexOf(rep), 1); }
    }
  }
  for (const c of queue) skipped.push(c.id);
  writeConcepts();

  if (finals.length >= 2) {
    const flex = await writeFlexibleCopy({ anthropic: deps.anthropic, model: deps.models.copy, product, concepts: finals.map(f => f.concept), sourceIndex, pdpBody: ev.pdpBody, persona: ev.persona, reviews: ev.reviews });
    if (flex.ok) {
      const { json, md } = renderFlexibleManifest({
        runId, product, variant: args.variant, target: { platform: 'meta', ratio: args.ratio },
        plates: finals.map(f => ({ format: f.concept.id, file: f.file, verified: true })),
        primaryTexts: flex.primaryTexts, headlines: flex.headlines, claims: flex.claims,
      });
      manifest = { ...json, short: finals.length < SLOTS, needsHumanReview: finals.filter(f => f.take.needsHumanReview.length).map(f => f.concept.id) };
      writeJson(join(runDir, 'flexible-ad.json'), manifest);
      writeFileSync(join(runDir, 'flexible-ad.md'), md);
    }
  }
  return finish({ dry: false });

  async function finish({ dry }) {
    const renders = dry ? 0 : budget.used();
    const needsHumanReview = dry ? [] : finals.filter(f => f.take.needsHumanReview.length).map(f => f.concept.id);
    const report = {
      kind: 'concepts', runId, generatedAt: deps.now().toISOString(),
      product: { handle: product.handle, title: product.title }, variant: args.variant,
      totals: { artifacts: dry ? 0 : finals.length },
      results: dry ? [] : finals.map(f => ({ conceptSlug: f.concept.id, file: f.file, score: f.score })),
      rejectedConcepts: Object.entries(verdicts).map(([conceptSlug, error]) => ({ conceptSlug, error })),
      requestedGated: requestedGated.map(c => ({ conceptSlug: c.id, reason: verdicts[c.id] })),
      cost: { renders, perRenderUsd: USD_PER_RENDER, estimatedUsd: Number((renders * USD_PER_RENDER).toFixed(2)) },
      budget: { maxRenders: args.maxRenders, stopped: dry ? false : budgetStopped, skipped: dry ? [] : skipped, skippedCount: dry ? 0 : skipped.length },
      manifest: manifest ? 'flexible-ad.json' : null,
      needsHumanReview,
    };
    writeJson(join(runDir, 'run.json'), report);
    deps.archive({ sourceDir: runDir, runId });
    const n = dry ? 0 : finals.length;
    const subject = dry
      ? `Ad Concepts dry run, ${product.title}: ${picked.length} concepts picked`
      : `Ad Concepts, ${product.title}: ${n} image${n === 1 ? '' : 's'}${manifest?.short ? ' (SHORT)' : ''}${needsHumanReview.length ? ' · NEEDS HUMAN REVIEW' : ''}`;
    await deps.notify({ subject, body: `Run ${runId}\n${manifest ? 'flexible-ad.md is ready.' : 'No flexible ad: fewer than 2 concepts finished.'}`, status: 'info', category: 'ads' });
    return report;
  }
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { default: Anthropic } = await import('../../lib/anthropic.js');
  const { GoogleGenAI } = await import('@google/genai');
  const studio = await import('../ad-studio/index.js');
  const { selectReferencePhotos } = await import('../ad-studio/render.js');
  const { buildSourceIndex } = await import('../ad-studio/claims.js');
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
  const report = await runConcepts({
    args,
    deps: {
      root: ROOT, outRoot, now: () => new Date(),
      models: { concept: CREATIVE_MODELS.adStudio.angle, judge: CREATIVE_MODELS.adStudio.verify, shot: CREATIVE_MODELS.adStudio.copy, copy: CREATIVE_MODELS.adStudio.copy },
      anthropic,
      referencePhotos: studio.loadReferencePhotos(photoPaths),
      loadEvidence: async () => {
        const catalogEntry = loadJson('data/brand/product-catalog.json').products?.[args.product];
        if (!catalogEntry) throw new Error(`ad-concepts: no catalog entry for "${args.product}"`);
        const brandKit = loadJson('data/brand/brand-kit.json');
        const pdpBody = await studio.fetchPdpBody(loadJson('config/site.json').url, args.product);
        const reviews = await studio.fetchAdReviews(args.product, { env });
        const persona = studio.projectPersonaForCopy(overlayPersonas(loadJson('data/context/personas.json'), { root: ROOT })).persona;
        const product = {
          handle: args.product, title: catalogEntry.title, variant: args.variant, unitCount: manifestEntry.unitCount,
          labelStrings: studio.buildLabelStrings({ manifestEntry, variant: args.variant }),
          badgeStrings: studio.resolveBadgeStrings({ manifestEntry, variant: args.variant }),
          labelInk: manifestEntry.labelInk || null, physicalDescription: manifestEntry.productDescription || '',
        };
        return {
          product, catalogEntry, brandKit, pdpBody, persona, reviews,
          sourceIndex: buildSourceIndex({ pdpBody, brandKit, catalogEntry, reviews }),
          photoPaths, competitorNames: loadJson('config/competitors.json').map(c => c.name),
          tactics: renderContextMirror(scanSkillInventory(join(ROOT, '.claude', 'skills'))).trim(),
        };
      },
      render: (prompt, { ratio, budget }) => studio.renderVariationWithBackoff(gemini, { prompt, photoPaths, ratio }, { budget }),
      verifyImage: (o) => studio.verifyImage({ anthropic, ...o }),
      typeset: typesetTake,
      critique: ({ buffer, mediaType, zones }) => studio.critiqueArtifact({ anthropic, buffer, mediaType, format: { key: 'concept' }, zones, mode: 'finished', ratio: args.ratio }),
      notify: realNotify,
      archive: ({ sourceDir, runId }) => archiveRunOutput({ sourceDir, runId, relativeDir: 'data/creatives/ad-studio', root: ROOT, label: 'ad-concepts' }),
    },
  });
  console.log(`\n${report.runId}\n${report.manifest ? `Flexible ad: ${join(outRoot, report.runId, 'flexible-ad.md')}` : 'No flexible ad this run (see run.json).'}`);
  if (report.needsHumanReview.length) console.log(`NEEDS HUMAN REVIEW (people in frame): ${report.needsHumanReview.join(', ')}`);
}

if (isDirectRun(import.meta.url)) {
  main().catch(async (err) => {
    await realNotify({ subject: 'Ad Concepts failed', body: err.message || String(err), status: 'error', category: 'ads' }).catch(() => {});
    console.error(err);
    process.exit(1);
  });
}
