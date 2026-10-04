// agents/ad-concepts/index.js
//
// Structure-first ad creation. One run → one Meta flexible ad built on proven competitor
// STRUCTURES (long-running ads from the Meta Ad Library, data/ad-structures/library.json):
// up to 3 finished images from 3 distinct layouts, 2 primary texts, 2 headlines. The model
// fills slots; it never invents a concept. Spec:
// docs/superpowers/specs/2026-10-03-ad-structures-design.md
//
//   node agents/ad-concepts/index.js --products a,b [--variant <name>] [--landing <handle>]
//     [--offer "<text naming price and was-price>"] [--structures id,id] [--max-renders 30] [--dry-run]
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
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
import { loadLibrary, eligible, selectStructures, whyIneligible } from './structures.js';
import { parseOffer, verifyOffer, valueLines } from './landing.js';
import { screenReviews, screenRows, buildQuotePickPrompt, parseQuotePick, quoteFromPick, quotableReviews, templateSlot, fillModelSlot } from './evidence.js';
import { getLayout } from './layouts/index.js';
import { LABEL_MAX_CHARS } from './layouts/labelled-bundle.js';
import { buildScenePrompt } from './plates.js';
import { runConceptTakes } from './shots.js';
import { gateCopy, writeFlexibleCopy } from './copy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_MAX_RENDERS = 30;
const SLOTS = 3;
const MIN_ELIGIBLE = 2;
const MIN_CHECKLIST_ROWS = 2;
const BUNDLE_LANDING_RE = /\b(?:set|bundle|kit)s?\b/i;
// A split panel is tall and narrow (538 x 1246): render each panel's plate at 9:16, as the
// approved reference did, so the cover crop loses as little of the scene as possible.
const PLATE_RATIO = Object.freeze({ 'split-two-panel': '9:16' });

const list = (s) => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

export function parseArgs(argv) {
  const a = { products: [], variant: null, landing: null, offer: null, structures: [], maxRenders: DEFAULT_MAX_RENDERS, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { const x = argv[++i]; if (x === undefined) throw new Error(`${k} needs a value`); return x; };
    if (k === '--products') a.products = list(v());
    else if (k === '--variant') a.variant = v();
    else if (k === '--landing') a.landing = v();
    else if (k === '--offer') a.offer = v();
    else if (k === '--structures') a.structures = list(v());
    else if (k === '--max-renders') a.maxRenders = Number(v());
    else if (k === '--dry-run') a.dryRun = true;
    else throw new Error(`unknown argument ${k}`);
  }
  if (!a.products.length) throw new Error('--products is required (comma-separated handles of the products that may appear in the images)');
  if (!a.landing) {
    if (a.products.length !== 1) throw new Error('--landing is required when --products names more than one product');
    a.landing = a.products[0];
  }
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
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const money = (n) => (Number.isInteger(n) ? String(n) : Number(n).toFixed(2));
const maxDays = (s) => Math.max(...s.sources.map(x => x.days || 0));

/** Stated wherever needsHumanReview appears: the flag exists BECAUSE nothing checks this. */
export const NEEDS_HUMAN_REVIEW_NOTE =
  'verify.js checks nothing about anatomy. These images show a person (hands or a face), so a human must look at every hand and face before the ad ships.';

/**
 * The product's OTHER variants, for the deterministic variant gate: the directory names under
 * data/product-images/<imageDir>/, minus the current variant, the non-variant 'unwrapped' dir
 * and any plain file. No variant (or no directory) means no siblings, and the gate is a no-op.
 */
export function listSiblingVariants(imageRoot, variant) {
  if (!variant) return [];
  let entries;
  try { entries = readdirSync(imageRoot, { withFileTypes: true }); } catch { return []; }
  return entries.filter(e => e.isDirectory() && e.name !== variant && e.name !== 'unwrapped' && !e.name.startsWith('.'))
    .map(e => e.name).sort();
}

/** Product kind from the manifest's physical description: a squeeze bottle is lotion, a jar is cream. */
export function productKind(description) {
  const d = String(description || '');
  if (/squeeze bottle/i.test(d)) return 'lotion';
  if (/\bjar\b/i.test(d)) return 'cream';
  return null;
}

/** What the scenes and split-panel labels call the product ("coconut lotion", "body cream"). */
export function productNoun(handle, kind) {
  if (kind === 'lotion') return /coconut/i.test(handle || '') ? 'coconut lotion' : 'body lotion';
  if (kind === 'cream') return 'body cream';
  return null;
}

/** A short physical phrase for a scene sentence ("8 fl oz white squeeze bottle"); the full description is too long. */
export function productDescriptionShort(description, kind) {
  const d = String(description || '');
  const m = /(\d+(?:\.\d+)?)\s*(fl\.?\s*)?oz\b/i.exec(d);
  const volume = m ? `${m[1]} ${m[2] ? 'fl oz' : 'oz'}` : '';
  const colour = /\bwhite\b/i.test(d) ? 'white' : '';
  const container = kind === 'lotion' ? 'squeeze bottle' : kind === 'cream' ? 'jar' : 'container';
  return [volume, colour, container].filter(Boolean).join(' ');
}

/** The product block the run reads. priceLabel and url ride along for the flexible copy and manifest. */
export function buildEvidenceProduct({ handle, variant, manifestEntry, catalogEntry, studio }) {
  const physicalDescription = manifestEntry.productDescription || '';
  const kind = productKind(physicalDescription);
  return {
    handle, title: catalogEntry.title, variant, unitCount: manifestEntry.unitCount,
    priceLabel: catalogEntry.priceLabel || null, url: catalogEntry.url || null,
    labelStrings: studio.buildLabelStrings({ manifestEntry, variant }),
    badgeStrings: studio.resolveBadgeStrings({ manifestEntry, variant }),
    labelInk: manifestEntry.labelInk || null, physicalDescription,
    kind, productNoun: productNoun(handle, kind), productDescriptionShort: productDescriptionShort(physicalDescription, kind),
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

/**
 * Candidate "ours" checklist rows: short phrases lifted from the catalog titles and the PDP.
 * Candidates only. Every one still has to pass screenRows (copy gate + verbatim in the catalog
 * or PDP) before it can appear on an ad.
 */
export function factCandidates({ catalogEntries = [], pdpBodies = [] } = {}) {
  const out = new Set();
  const words = (s) => s.split(/\s+/).filter(Boolean).length;
  const add = (s) => { const t = String(s || '').trim().replace(/[.!?,:;]+$/, '').trim(); if (words(t) >= 2 && words(t) <= 8) out.add(t); };
  for (const e of catalogEntries) {
    const title = String(e?.title || '');
    for (const seg of title.split(/\s*\|\s*/)) add(seg);
    for (const m of title.matchAll(/only\s+\d+\s+clean\s+ingredients/gi)) add(m[0]);
  }
  for (const body of pdpBodies) for (const seg of String(body || '').split(/(?<=[.!?])\s+|\n|•|;/)) add(seg);
  return [...out];
}

/** The text a critique reads: every string slot, and list slots joined. */
function critiqueZones(slots) {
  const zones = {};
  for (const [k, v] of Object.entries(slots || {})) {
    if (typeof v === 'string' && v) zones[k] = v;
    else if (Array.isArray(v) && v.length) zones[k] = v.map(x => (typeof x === 'string' ? x : x?.text)).filter(Boolean).join(' / ');
  }
  return zones;
}

/** renderFlexibleManifest's markdown assumes three images at one ratio; make it say what this run is. */
function finishFlexibleMd(md, { n, target, ratios, landing, reviewFiles }) {
  let out = md;
  const word = n === 2 ? 'both' : n === 3 ? 'all three' : `all ${n}`;
  const shared = new Set(ratios).size === 1;
  out = out.replace('all three plates share this ratio', shared ? `${word} images share this ratio` : `the images differ in ratio (${ratios.join(', ')}); add each at its own ratio`);
  if (n !== 3) out = out.replace('add all three images', `add ${word} images`);
  const extra = [];
  if (landing?.url) {
    const price = landing.price != null ? ` ($${money(landing.price)}${landing.compareAt != null ? `, was $${money(landing.compareAt)}` : ''})` : '';
    extra.push(`**Landing page:** ${landing.url}${price}  `);
  }
  if (n < target) {
    extra.push('', `> **SHORT RUN: ${n} image${n === 1 ? '' : 's'}, not ${target}.** Only ${n} structure${n === 1 ? '' : 's'} finished, so build this ad with the ${n} image${n === 1 ? '' : 's'} listed below. Do not look for another.`);
  }
  if (extra.length) out = out.replace('\n\n## Build it as ONE ad', `\n${extra.join('\n')}\n\n## Build it as ONE ad`);
  if (reviewFiles.length) {
    out += `\n## Needs a human look before it ships\n\n${NEEDS_HUMAN_REVIEW_NOTE}\n\n${reviewFiles.map(f => `- \`${f}\``).join('\n')}\n`;
  }
  return out;
}

/** One product standing in for several (a labelled bundle shows every --products entry at once). */
function combineProducts(ps) {
  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  const first = ps[0];
  const interleave = (lists, max) => { const o = []; for (let i = 0; o.length < max && lists.some(l => i < l.length); i++) for (const l of lists) if (i < l.length && o.length < max) o.push(l[i]); return o; };
  return {
    handle: ps.map(p => p.handle).join('+'),
    product: {
      handle: ps.map(p => p.handle).join('+'), title: ps.map(p => p.product.title).join(' + '), variant: first.product.variant,
      unitCount: ps.reduce((n, p) => n + (Number(p.product.unitCount) || 1), 0),
      labelStrings: uniq(ps.flatMap(p => p.product.labelStrings || [])), badgeStrings: uniq(ps.flatMap(p => p.product.badgeStrings || [])),
      labelInk: first.product.labelInk, physicalDescription: ps.map(p => p.product.physicalDescription).join(' '),
      productNoun: ps.map(p => p.product.productNoun).join(' and '), productDescriptionShort: ps.map(p => p.product.productDescriptionShort).join(' and '),
    },
    catalogEntry: first.catalogEntry, pdpBody: ps.map(p => p.pdpBody).join('\n'),
    photoPaths: interleave(ps.map(p => p.photoPaths || []), 4),
    referencePhotos: interleave(ps.map(p => p.referencePhotos || []), 4),
  };
}

export async function runAds({ args, deps }) {
  const stamp = deps.now().toISOString().replace(/[:.]/g, '-');
  const runId = `structures-${args.landing}-${args.variant || 'default'}-${stamp}`;
  const runDir = join(deps.outRoot, runId);
  mkdirSync(runDir, { recursive: true });
  // main() archives this directory on SIGINT/SIGTERM; it needs to know it before anything is paid for.
  deps.onStart?.({ runDir, runId });

  const models = deps.models;
  const target = Math.max(SLOTS, args.structures.length);
  const budget = createRenderBudget(args.maxRenders);
  const products = [];
  let landing = null;
  let landingRec = null;
  let offerRec = null;
  let ineligible = [];
  const plan = [];
  const skipped = [];
  const rejected = [];
  const droppedReviews = [];
  const droppedRows = [];
  const finals = [];
  const budgetSkipped = [];
  let budgetStopped = false;
  let manifest = null;
  let manifestReason = null;
  let dry = false;

  const serialPlan = (e) => ({ id: e.id, name: e.name, layout: e.layout, ratio: e.ratio, people: e.people, sourceDays: e.sourceDays, sources: e.sources, product: e.product, slots: e.slots });
  const writePlan = () => writeJson(join(runDir, 'plan.json'), {
    runId, landing: landingRec, offer: offerRec, target,
    structures: plan.map(serialPlan), skipped, ineligible, droppedReviews, droppedRows,
  });

  const buildReport = (error = null) => {
    const renders = dry ? 0 : budget.used();
    const review = dry ? [] : finals.filter(f => f.entry.people !== 'none').map(f => f.entry.id);
    return {
      kind: 'ad-structures', runId, generatedAt: deps.now().toISOString(),
      product: { handle: landing?.handle || args.landing, title: landing?.title || null }, variant: args.variant,
      products: args.products, landing: landingRec, offer: offerRec,
      structures: plan.map(e => ({ id: e.id, layout: e.layout, sourceDays: e.sourceDays, sources: e.sources, product: e.product })),
      totals: { artifacts: dry ? 0 : finals.length },
      results: dry ? [] : finals.map(f => ({ conceptSlug: f.entry.id, file: f.file, score: f.score })),
      ineligible, skippedStructures: skipped, rejectedStructures: rejected, droppedReviews, droppedRows,
      cost: { renders, perRenderUsd: USD_PER_RENDER, estimatedUsd: Number((renders * USD_PER_RENDER).toFixed(2)) },
      budget: { maxRenders: args.maxRenders, stopped: dry ? false : budgetStopped, skipped: dry ? [] : budgetSkipped, skippedCount: dry ? 0 : budgetSkipped.length },
      manifest: manifest ? 'flexible-ad.json' : null,
      manifestReason: dry ? 'dry run' : manifestReason,
      needsHumanReview: review,
      needsHumanReviewNote: review.length ? NEEDS_HUMAN_REVIEW_NOTE : null,
      ...(error ? { error: String(error?.stack || error?.message || error) } : {}),
    };
  };

  // Shared evidence, set in body() before anything that is paid for.
  let shared = null;

  /** The --products entry a structure is shot on: the kind it lists first, then the least used. */
  function productFor(s) {
    if (s.layout === 'labelled-bundle') return combineProducts(products);
    const used = (h) => plan.filter(e => e.product === h).length;
    const fit = products.filter(p => s.fits.includes(p.product.kind));
    return [...fit].sort((a, b) => (s.fits.indexOf(a.product.kind) - s.fits.indexOf(b.product.kind)) || (used(a.handle) - used(b.handle)))[0];
  }

  /** Fill every slot of one structure. Throws (with a reason) when a slot cannot be filled. */
  async function fillSlots(s) {
    const prod = productFor(s);
    if (!prod) throw new Error(`no --products entry fits ${s.fits.join('/')}`);
    const { sourceIndex, competitorNames, variant, siblingVariants, reviews, brandKit } = shared;
    const gateCtx = { competitorNames, variant, siblingVariants };
    const slots = {};
    const defs = Object.entries(s.slots || {});
    const onDropped = (slot, dropped) => { for (const d of dropped) droppedRows.push({ structure: s.id, slot, text: d.text, reason: d.reason }); };
    const ctx = {
      productNoun: prod.product.productNoun, sourceIndex, ...gateCtx, onDropped,
      facts: factCandidates({ catalogEntries: [prod.catalogEntry], pdpBodies: [prod.pdpBody] }),
    };

    // 1. Quotes: the model picks a review BY INDEX, code inserts it verbatim. NoQuoteError propagates.
    for (const [name, slot] of defs.filter(([, d]) => d.source === 'review')) {
      const maxChars = slot.maxChars || 220;
      const prompt = buildQuotePickPrompt({ structure: s, reviews, maxChars });
      const idx = parseQuotePick(await ask(deps.anthropic, models.copy, prompt, 200), quotableReviews(reviews, maxChars).length);
      slots[name] = quoteFromPick(reviews, idx, maxChars);
    }
    // 2. Template slots: deterministic strings, every rejected row recorded.
    for (const [name, slot] of defs.filter(([, d]) => d.source === 'template' || d.source === 'catalogFact')) {
      if (name === 'labels') {
        const nouns = (s.layout === 'labelled-bundle' ? products : [prod]).map(p => cap(p.product.productNoun)).filter(Boolean);
        for (const n of nouns.filter(n => n.length > LABEL_MAX_CHARS)) droppedRows.push({ structure: s.id, slot: name, text: n, reason: `longer than ${LABEL_MAX_CHARS} chars` });
        const texts = templateSlot(s, 'labels', { ...ctx, labels: nouns.filter(n => n.length <= LABEL_MAX_CHARS) });
        const pos = s.labelPositions || [];
        if (texts.length < 2) throw new Error(`labelled bundle needs at least 2 labels, has ${texts.length}`);
        if (pos.length < 2) throw new Error('labelled bundle has no labelPositions in the library');
        slots.labels = texts.slice(0, Math.min(4, pos.length)).map((text, i) => ({ text, x: pos[i].x, y: pos[i].y, tx: pos[i].tx, ty: pos[i].ty }));
        continue;
      }
      slots[name] = templateSlot(s, name, ctx);
      if (name === 'oursRows' && slots[name].length < MIN_CHECKLIST_ROWS) {
        throw new Error(`only ${slots[name].length} sourced "ours" row(s); a checklist needs ${MIN_CHECKLIST_ROWS}`);
      }
    }
    if (s.rows?.theirs) {
      slots.theirs = templateSlot(s, 'theirsRows', ctx);
      slots.theirsLabel = s.rows.theirsLabel || 'Typical';
    }
    // 3. Model slots (headline-type), evidence = the chosen quote, else the screened reviews.
    for (const [name] of defs.filter(([, d]) => d.source === 'model')) {
      slots[name] = await fillModelSlot({
        anthropic: deps.anthropic, model: models.copy, structure: s, slotName: name,
        evidence: slots.quote ? [slots.quote] : reviews.slice(0, 12), sourceIndex, ...gateCtx,
      });
    }
    // 4. Band: the verified offer, or an always-true value line. Either way it passes the gate.
    for (const [name, slot] of defs.filter(([, d]) => d.source === 'offerOrValue' || d.source === 'offer')) {
      if (offerRec) { slots[name] = offerRec.band; continue; }
      if (slot.source === 'offer') throw new Error(`slot "${name}" needs a verified --offer`);
      const line = valueLines({ brandKit, catalogEntry: prod.catalogEntry }).find(l => gateCopy({ band: l }, [], { sourceIndex, ...gateCtx }).ok);
      if (line) slots[name] = line;
      else if (!slot.optional) throw new Error(`slot "${name}": no value line passes the copy gate`);
    }
    // Every visible string clears the copy gate, template strings included.
    const strings = Object.fromEntries(Object.entries(slots).filter(([, v]) => typeof v === 'string'));
    const g = gateCopy(strings, [], { sourceIndex, ...gateCtx });
    if (!g.ok) throw new Error(`copy gate: ${g.reasons.join('; ')}`);

    return {
      id: s.id, name: s.name, layout: s.layout, ratio: s.ratio, people: s.people || 'none',
      sourceDays: maxDays(s), sources: s.sources.map(x => ({ brand: x.brand, days: x.days, adLibraryUrl: x.adLibraryUrl })),
      product: prod.handle, slots, structure: s, prod,
    };
  }

  // Next eligible structure whose layout nobody active is using. Each structure is tried once.
  let pool = [];
  const nextFromPool = (activeLayouts) => {
    const i = pool.findIndex(s => !activeLayouts.has(s.layout));
    return i < 0 ? null : pool.splice(i, 1)[0];
  };

  /** Plan one structure; on a fill failure record it and keep pulling replacements. Returns the entry or null. */
  async function planOne(s, activeLayouts) {
    let cur = s;
    while (cur) {
      try {
        const entry = await fillSlots(cur);
        plan.push(entry);
        return entry;
      } catch (e) {
        if (/cut off/.test(e?.message || '')) throw e;
        skipped.push({ id: cur.id, reason: firstLine(e) });
        cur = nextFromPool(activeLayouts);
      }
    }
    return null;
  }

  // One structure: render plate(s) with primary then fallback scenes, lay out in code, critique,
  // occlusion. Takes are written to disk the moment they are checked. Returns { best } or { reason }.
  async function runOne(entry) {
    const s = entry.structure;
    const prod = entry.prod;
    const layout = getLayout(s.layout);
    const plateRatio = PLATE_RATIO[s.layout] || s.ratio;
    const pSlug = ratioSlug(plateRatio);
    const fSlug = ratioSlug(s.ratio);
    const dir = join(runDir, s.id, 'v1');
    mkdirSync(dir, { recursive: true });
    // The dashboard's judging screen reads the zones from here.
    writeJson(join(runDir, s.id, 'copy.json'), { zones: critiqueZones(entry.slots), claims: [] });
    const proofs = {};
    const writeProofs = () => writeJson(join(dir, 'proof.json'), proofs);
    try {
      const specs = s.plates?.length ? s.plates : [{ kind: 'product', productFree: false }];
      const productIdx = specs.findIndex(p => !p.productFree);
      const passedByPlate = [];
      for (let i = 0; i < specs.length; i++) {
        const spec = specs[i];
        const productFree = !!spec.productFree;
        const prefix = productFree ? 'meta-generic' : 'meta-plate';
        const plateArg = s.plates?.length ? spec : null;
        const promptFor = (which) => buildScenePrompt({ structure: s, which, product: prod.product, brandKit: shared.brandKit, plate: plateArg });
        const takes = await runConceptTakes({
          concept: { people: productFree ? 'none' : (s.people || 'none') },
          prompt: promptFor('primary'), fallbackPrompt: promptFor('fallback'), budget,
          render: (p) => deps.render(p, { ratio: plateRatio, budget, photoPaths: productFree ? [] : prod.photoPaths }),
          verify: async (buffer) => {
            const mediaType = sniffImageMediaType(buffer);
            const proof = productFree
              ? await deps.strayText({ buffer, mediaType })
              : await deps.verifyImage({
                buffer, mediaType, referencePhotos: prod.referencePhotos || [], expected: [], mode: 'plate',
                format: { key: s.id, plateSetting: 'scene', pairsImagesWithLabels: false },
                physicalDescription: prod.product.physicalDescription, unitCount: prod.product.unitCount, variant: prod.product.variant,
                expectedLabelInk: prod.product.labelInk, expectedBadge: prod.product.badgeStrings,
                volumeStrings: selectVolumeStrings(prod.product.labelStrings),
              });
            return { mediaType, proof };
          },
          onTake: (t) => {
            const name = `${prefix}-take${t.n}-${pSlug}.jpg`;
            writeFileSync(join(dir, name), t.buffer);
            proofs[name] = { ...t.proof, needsHumanReview: t.needsHumanReview, usedFallback: t.n > 2 };
            writeProofs();
          },
        });
        if (takes.budgetStopped) budgetStopped = true;
        if (!takes.passed.length) {
          const why = [...new Set(takes.takes.flatMap(t => t.proof.reasons || (t.proof.detail ? [t.proof.detail] : [])))].slice(0, 3).join('; ');
          const what = productFree ? `the stray-text check on the ${spec.kind || 'generic'} plate` : 'verification';
          return { reason: `no take passed ${what}${takes.budgetStopped ? ' (budget ran out)' : ''}${why ? `: ${why}` : ''}` };
        }
        passedByPlate[i] = takes.passed;
      }

      const size = layout.size(s.ratio);
      const regions = layout.regions(s.ratio, entry.slots);
      const zones = critiqueZones(entry.slots);
      const dataUrl = (t) => `data:${t.mediaType};base64,${t.buffer.toString('base64')}`;
      let best = null;
      const occluded = [];
      let otherFailure = false;
      for (const t of passedByPlate[productIdx]) {
        const plates = specs.map((_, i) => dataUrl(i === productIdx ? t : passedByPlate[i][0]));
        const html = layout.render({ plates, slots: entry.slots, ratio: s.ratio });
        const set = await deps.renderLayout({ html, width: size.width, height: size.height });
        const name = `meta-final-take${t.n}-${fSlug}.jpg`;
        writeFileSync(join(dir, name), set.buffer);
        const mediaType = sniffImageMediaType(set.buffer);
        const crit = await deps.critique({ buffer: set.buffer, mediaType, zones, ratio: s.ratio, structureId: s.id });
        const occ = crit.ok && !set.overflow
          ? await deps.occlusion({ buffer: set.buffer, mediaType, productDescription: prod.product.physicalDescription, regions, size, structureId: s.id })
          : null;
        const plateName = `meta-plate-take${t.n}-${pSlug}.jpg`;
        proofs[plateName] = {
          ...proofs[plateName], final: name, overflow: !!set.overflow, critique: crit,
          occlusion: occ ?? { ok: false, detail: set.overflow ? 'not checked: the type overflowed its box' : 'not checked: the type failed critique' },
        };
        writeProofs();
        if (crit.ok && !set.overflow && occ?.ok) {
          if (!best || (crit.score ?? 0) > (best.score ?? 0)) {
            best = { entry, take: t, file: join(s.id, 'v1', name), score: crit.score, headline: entry.slots.headline || entry.slots.left || entry.slots.title || null };
          }
        } else if (occ && !occ.ok) occluded.push(occ.detail);
        else otherFailure = true;
      }
      if (best) return { best };
      return {
        reason: occluded.length && !otherFailure
          ? `overlay occludes our product: ${[...new Set(occluded)].slice(0, 2).join('; ')}`
          : 'layout failed critique or overflowed on every passing take',
      };
    } finally {
      writeProofs();
    }
  }

  async function body() {
    // 1. Evidence per product, and the guards that must stop a run before anything is paid for.
    for (const handle of args.products) {
      const ev = await deps.loadEvidence({ handle, variant: args.variant });
      // Fidelity is a hard gate and the reference photographs are what a take is checked
      // against; with none, the check switches itself off while the run still bills.
      if (!ev.photoPaths || ev.photoPaths.length === 0) {
        const dir = ev.photoDir || `data/product-images/<imageDir>/${args.variant || ''}`;
        throw new Error(
          `ad-concepts: no reference photos under ${dir}. A take rendered without them cannot be checked ` +
          `for product fidelity, so this run would bill for unverifiable renders.\n` +
          `  In a worktree this usually means data/product-images/ was never linked (it is gitignored); ` +
          `scripts/new-worktree.sh links it.`
        );
      }
      // An empty label list is how the image model invents a volume that was never on the product.
      if (!ev.product?.labelStrings || ev.product.labelStrings.length === 0) {
        throw new Error(
          `ad-concepts: labelStrings is empty for "${handle}", refusing to render. An empty list ` +
          `is exactly how the image model invents a volume that was never on the label. Add quoted ` +
          `label text and a volume marking to this product's productDescription in ` +
          `data/product-images/manifest.json before running again.`
        );
      }
      products.push({ ...ev, handle });
    }
    const first = products[0];
    const competitorNames = first.competitorNames || [];
    const variant = args.variant || null;
    const siblingVariants = [...new Set(products.flatMap(p => p.siblingVariants || []))].sort();
    const brandKit = first.brandKit || {};

    // 2. Landing page and offer. A mismatched or ungateable offer aborts before any paid call.
    landing = await deps.fetchLanding(args.landing);
    let landingVariant = landing.variants?.[0] || null;
    if (args.offer) {
      const parsed = parseOffer(args.offer);
      const v = verifyOffer(parsed, landing);
      if (!v.ok) throw new Error(`ad-concepts: --offer ${v.reason}`);
      const g = gateCopy({ band: v.band }, [], { sourceIndex: {}, competitorNames, variant, siblingVariants });
      if (!g.ok) throw new Error(`ad-concepts: the offer band "${v.band}" fails the copy gate: ${g.reasons.join('; ')}`);
      landingVariant = landing.variants.find(x => x.compareAt !== null && Math.round(x.price * 100) === Math.round(parsed.price * 100)) || landingVariant;
      offerRec = { text: args.offer, price: parsed.price, wasPrice: parsed.wasPrice, band: v.band, verified: v.reason };
    }
    landingRec = { handle: landing.handle, title: landing.title, url: landing.url, price: landingVariant?.price ?? null, compareAt: landingVariant?.compareAt ?? null };

    // 3. Reviews: Ad Studio's health screen, then ad-concepts' own. Every drop is recorded.
    const raw = [...new Set(products.flatMap(p => (p.reviews || []).map(r => String(r ?? '').trim())).filter(Boolean))];
    const pdpAll = products.map(p => p.pdpBody || '').join('\n');
    const catalogAll = Object.fromEntries(products.map(p => [p.handle, p.catalogEntry]));
    const healthy = quotableEvidence({ pdpBody: pdpAll, brandKit, catalogEntry: catalogAll, reviews: raw }).reviews;
    for (const r of raw.filter(r => !healthy.includes(r))) droppedReviews.push({ text: r, reason: 'health claim (selectQuotableReviews)' });
    const screened = screenReviews(healthy, { variant, siblingVariants, competitorNames });
    droppedReviews.push(...screened.dropped);
    const reviews = screened.kept;
    const sourceIndex = buildSourceIndex({ pdpBody: pdpAll, brandKit, catalogEntry: catalogAll, reviews });
    shared = { sourceIndex, competitorNames, variant, siblingVariants, reviews, brandKit, persona: first.persona || null, pdpAll };

    // 4. Evidence present this run, then eligibility and selection (free, no model call yet).
    const facts = screenRows(factCandidates({ catalogEntries: products.map(p => p.catalogEntry), pdpBodies: products.map(p => p.pdpBody) }), { sourceIndex, competitorNames, variant, siblingVariants });
    const evidence = new Set();
    if (reviews.length) evidence.add('review');
    if (offerRec) evidence.add('offer');
    if (facts.kept.length) evidence.add('catalogFact');
    if (BUNDLE_LANDING_RE.test(landing.title || '')) evidence.add('bundleLanding');
    const ctx = { productKinds: [...new Set(products.map(p => p.product.kind).filter(Boolean))], evidence };
    const library = deps.library || loadLibrary();
    const ok = eligible(library, ctx);
    ineligible = library.structures.filter(s => !ok.includes(s)).map(s => ({ id: s.id, reason: whyIneligible(s, ctx) }));
    if (ok.length < MIN_ELIGIBLE) {
      throw new Error(`ad-concepts: fewer than 2 eligible structures (${ok.length}); ${ineligible.map(x => `${x.id}: ${x.reason}`).join('; ')}`);
    }
    const picked = selectStructures(ok, { slots: SLOTS, override: args.structures });
    pool = ok.filter(s => !picked.includes(s)).sort((a, b) => maxDays(b) - maxDays(a));

    // 5. Fill slots for each picked structure; a structure that cannot be filled is replaced.
    for (let i = 0; i < picked.length; i++) {
      const active = new Set([...plan.map(e => e.layout), ...picked.slice(i + 1).map(s => s.layout)]);
      await planOne(picked[i], active);
    }
    writePlan();
    if (args.dryRun) { dry = true; return; }

    // 6. Render, lay out, check. A structure that fails is replaced by the next eligible one.
    const queue = [...plan];
    while (queue.length && finals.length < target) {
      const entry = queue.shift();
      if (budgetStopped) { budgetSkipped.push(entry.id); continue; }
      let out = null;
      try { out = await runOne(entry); }
      catch (e) {
        // One structure's failure is that structure's failure: record it, replace it, carry on.
        out = { reason: `failed: ${firstLine(e)}` };
        if (budget.exhausted()) budgetStopped = true;
      }
      if (out.best) { finals.push(out.best); continue; }
      rejected.push({ id: entry.id, reason: out.reason });
      if (budgetStopped) continue;
      const active = new Set([...finals.map(f => f.entry.layout), ...queue.map(e => e.layout)]);
      const rep = nextFromPool(active);
      if (rep) {
        const planned = await planOne(rep, active);
        if (planned) queue.push(planned);
      }
    }
    for (const e of queue) budgetSkipped.push(e.id);
    writePlan();

    manifestReason = `fewer than 2 structures finished (${finals.length})`;
    if (finals.length < 2) return;
    // Every render is already paid for here. A truncation still escapes (a hard signal, as
    // everywhere else in the fleet); any other throw costs the manifest only.
    const landingProduct = {
      handle: landing.handle, title: landing.title, variant: args.variant,
      priceLabel: landingRec.price != null ? `$${money(landingRec.price)}` : null, url: landing.url,
    };
    let flex;
    try {
      flex = await (deps.writeFlexibleCopy || writeFlexibleCopy)({
        anthropic: deps.anthropic, model: models.copy, product: landingProduct,
        concepts: finals.map(f => ({ id: f.entry.id, title: f.entry.name, overlayHeadline: f.headline, awareness: 'solution' })),
        sourceIndex, pdpBody: pdpAll, persona: shared.persona, reviews, competitorNames, variant, siblingVariants,
      });
    } catch (e) {
      if (/cut off/.test(e?.message || '')) throw e;
      flex = { ok: false, failed: firstLine(e) };
    }
    if (flex.failed) { manifestReason = `flexible copy failed: ${flex.failed}`; return; }
    if (!flex.ok) { manifestReason = `flexible copy rejected: ${flex.reasons.join('; ')}`; return; }
    const ratios = finals.map(f => f.entry.ratio);
    const sharedRatio = new Set(ratios).size === 1 ? ratios[0] : 'mixed';
    const { json, md } = renderFlexibleManifest({
      runId, product: landingProduct, variant: args.variant, target: { platform: 'meta', ratio: sharedRatio },
      plates: finals.map(f => ({ format: f.entry.id, file: f.file, verified: true })),
      primaryTexts: flex.primaryTexts, headlines: flex.headlines, claims: flex.claims,
    });
    const review = finals.filter(f => f.entry.people !== 'none');
    manifest = {
      ...json, productUrl: landing.url, landing: landingRec, offer: offerRec,
      plates: json.plates.map((p, i) => ({ ...p, ratio: finals[i].entry.ratio, structure: finals[i].entry.name })),
      short: finals.length < target,
      needsHumanReview: review.map(f => f.entry.id),
      needsHumanReviewNote: review.length ? NEEDS_HUMAN_REVIEW_NOTE : null,
      goldenThread: flex.goldenThread || [],
    };
    writeJson(join(runDir, 'flexible-ad.json'), manifest);
    writeFileSync(join(runDir, 'flexible-ad.md'), finishFlexibleMd(md, { n: finals.length, target, ratios, landing: landingRec, reviewFiles: review.map(f => f.file) }));
    manifestReason = null;
  }

  try {
    await body();
  } catch (err) {
    // The renders already on disk are the expensive part: record what is known, archive, THEN
    // rethrow. Nothing here may mask err.
    try { if (plan.length) writePlan(); } catch { /* keep the real error */ }
    try { writeJson(join(runDir, 'run.json'), buildReport(err)); } catch { /* keep the real error */ }
    try { deps.archive({ sourceDir: runDir, runId }); } catch { /* keep the real error */ }
    throw err;
  }

  const report = buildReport();
  writeJson(join(runDir, 'run.json'), report);
  deps.archive({ sourceDir: runDir, runId });
  const title = landing?.title || args.landing;
  const n = dry ? 0 : finals.length;
  const subject = dry
    ? `Ad Structures dry run, ${title}: ${plan.length} structures planned`
    : `Ad Structures, ${title}: ${n} image${n === 1 ? '' : 's'}${manifest?.short ? ' (SHORT)' : ''}${report.needsHumanReview.length ? ' · NEEDS HUMAN REVIEW' : ''}`;
  const lines = [`Run ${runId}`, manifest ? 'flexible-ad.md is ready.' : `No flexible ad: ${dry ? 'dry run' : manifestReason}.`];
  lines.push(`Structures: ${plan.map(e => `${e.id} (${e.sourceDays}d)`).join(', ') || 'none'}`);
  if (skipped.length) lines.push(`Skipped (slots could not be filled): ${skipped.map(x => `${x.id}: ${x.reason}`).join('; ')}`);
  if (rejected.length) lines.push(`Replaced after rendering: ${rejected.map(x => `${x.id}: ${x.reason}`).join('; ')}`);
  if (report.needsHumanReview.length) lines.push(`Needs human review (${report.needsHumanReview.join(', ')}): ${NEEDS_HUMAN_REVIEW_NOTE}`);
  await deps.notify({ subject, body: lines.join('\n'), status: 'info', category: 'ads' });
  return report;
}

// Set by main() once runAds names its run directory; cleared on the first archive so the
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
  const { renderLayoutHtml } = await import('./typeset.js');
  const { checkOcclusion } = await import('./occlusion.js');
  const { checkStrayText } = await import('./plates.js');
  const { fetchLanding } = await import('./landing.js');
  const { CREATIVE_MODELS } = await import('../../config/creative-models.js');
  const env = Object.fromEntries(readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const loadJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
  const manifestAll = loadJson('data/product-images/manifest.json');
  const catalog = loadJson('data/brand/product-catalog.json').products || {};
  const brandKit = loadJson('data/brand/brand-kit.json');
  const siteUrl = loadJson('config/site.json').url;
  const competitorNames = loadJson('config/competitors.json').map(c => c.name);
  const persona = studio.projectPersonaForCopy(overlayPersonas(loadJson('data/context/personas.json'), { root: ROOT })).persona;
  const outRoot = join(ROOT, 'data', 'creatives', 'ad-studio');
  const verifyModel = CREATIVE_MODELS.adStudio.verify;

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

  const report = await runAds({
    args,
    deps: {
      outRoot, now: () => new Date(),
      models: { copy: CREATIVE_MODELS.adStudio.copy, verify: verifyModel },
      anthropic, library: loadLibrary(),
      onStart: ({ runDir, runId }) => { pending = { sourceDir: runDir, runId }; ARCHIVE_ON_EXIT = flushArchive; },
      loadEvidence: async ({ handle, variant }) => {
        const manifestEntry = manifestAll.find(e => e.handle === handle);
        if (!manifestEntry) throw new Error(`ad-concepts: "${handle}" is not in data/product-images/manifest.json`);
        const catalogEntry = catalog[handle];
        if (!catalogEntry) throw new Error(`ad-concepts: no catalog entry for "${handle}"`);
        const imageRoot = join(ROOT, 'data', 'product-images', manifestEntry.imageDir);
        const photoDir = join(imageRoot, variant || '');
        const photoPaths = selectReferencePhotos(photoDir, 4);
        return {
          product: buildEvidenceProduct({ handle, variant, manifestEntry, catalogEntry, studio }),
          catalogEntry, brandKit, competitorNames, persona, photoPaths, photoDir,
          referencePhotos: photoPaths.length ? studio.loadReferencePhotos(photoPaths) : [],
          pdpBody: await studio.fetchPdpBody(siteUrl, handle),
          reviews: await studio.fetchAdReviews(handle, { env }),
          siblingVariants: listSiblingVariants(imageRoot, variant),
        };
      },
      fetchLanding: (handle) => fetchLanding(handle, { siteUrl }),
      render: (prompt, { ratio, budget, photoPaths }) => studio.renderVariationWithBackoff(gemini, { prompt, photoPaths, ratio }, { budget }),
      verifyImage: (o) => studio.verifyImage({ anthropic, ...o }),
      strayText: ({ buffer, mediaType }) => checkStrayText({ anthropic, model: verifyModel, buffer, mediaType }),
      renderLayout: ({ html, width, height }) => renderLayoutHtml({ html, width, height }),
      critique: ({ buffer, mediaType, zones, ratio, structureId }) => studio.critiqueArtifact({ anthropic, buffer, mediaType, format: { key: structureId }, zones, mode: 'finished', ratio }),
      occlusion: ({ buffer, mediaType, productDescription, regions, size }) => checkOcclusion({ anthropic, model: verifyModel, buffer, mediaType, productDescription, regions, size }),
      notify: realNotify,
      archive: () => flushArchive(),
    },
  });
  console.log(`\n${report.runId}\n${report.manifest ? `Flexible ad: ${join(outRoot, report.runId, 'flexible-ad.md')}` : `No flexible ad this run: ${report.manifestReason} (see run.json).`}`);
  if (report.needsHumanReview.length) console.log(`NEEDS HUMAN REVIEW (people in frame): ${report.needsHumanReview.join(', ')}. ${NEEDS_HUMAN_REVIEW_NOTE}`);
}

if (isDirectRun(import.meta.url)) {
  main().catch(async (err) => {
    // runAds already archived on a thrown error; this covers anything that escaped before it.
    try { ARCHIVE_ON_EXIT?.(); } catch { /* archiving must never mask the real error */ }
    await realNotify({ subject: 'Ad Structures failed', body: err.message || String(err), status: 'error', category: 'ads' }).catch(() => {});
    console.error(err);
    process.exit(1);
  });
}
