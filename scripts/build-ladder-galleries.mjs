#!/usr/bin/env node
/**
 * Render the generated gallery frames for every quantity-ladder tier.
 *
 *   node scripts/build-ladder-galleries.mjs [--only <handle>] [--frames hero,offer,scene]
 *        [--name hero-...,offer] [--missing] [--engines openai|gemini]
 *        [--max-renders N] [--concurrency N] [--dry-run]
 *
 * What gets rendered, and why, is in lib/ladder-gallery.js. This file is the I/O:
 * live price checks, references, rendering, vision reads, output.
 *
 * Every frame gets up to three renders (gpt-image-2 twice, then Gemini 3 Pro Image),
 * each read back by a vision model and judged in code. A frame that never passes is
 * written to _rejected/ with its reasons and is NOT published — scripts/
 * publish-ladder-galleries.mjs only ever reads the passing files.
 *
 * Output: data/creatives/ladder-galleries/<run>/<handle>/, plus run.json and a
 * contact sheet per product, archived to the main checkout so removing the worktree
 * cannot destroy a paid run.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { shopifyGraphQL } from '../lib/shopify.js';
import { archiveRunOutput } from '../lib/archive-run-output.js';
import { loadEnv, createRenderer, runAll, cutoutRef, labelCrop } from '../lib/gallery-render.js';
import {
  TIERS, UNIT, unitsFor, offerCopy, representativeVariant, sceneUnits, choiceLine,
  heroPrompt, offerPrompt, scenePrompt, checkPrompt, judge, slugify,
} from '../lib/ladder-gallery.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const ONLY = arg('--only', null);
const FRAMES = arg('--frames', 'hero,offer,scene').split(',');
const MAX_RENDERS = Number(arg('--max-renders', 240));
const CONCURRENCY = Number(arg('--concurrency', 3));
const DRY = argv.includes('--dry-run');
const NAMES = arg('--name', null)?.split(',') ?? null;
const MISSING = argv.includes('--missing');
// --engines gemini: finish a run without OpenAI (2026-10-07 the account ran out of credits mid-run).
const ENGINES = arg('--engines', null);

const env = loadEnv();

const { bundles } = JSON.parse(readFileSync(join(ROOT, 'config', 'bundles.json'), 'utf8'));

// ── References: the prop-free cutouts, flattened onto white (lib/gallery-render.js) ──
const refDir = join(ROOT, 'data', 'creatives', 'ladder-galleries', '_refs');
async function refsFor(job) {
  const refs = [];
  for (const s of [...new Set(job.units)]) {
    refs.push(await cutoutRef(refDir, job.unit.refKey, s));
    if (job.unit.detailCrop) refs.push(await labelCrop(refDir, job.unit.refKey, s, job.unit.detailCrop));
  }
  return refs;
}

// ── Live price check: a frame states a price, so the price must be the live one ──
async function liveProduct(handle) {
  const r = await shopifyGraphQL(`query($h:String!){ productByIdentifier(identifier:{handle:$h}){
    id title status variants(first:30){ nodes{ id title price compareAtPrice } } } }`, { h: handle });
  const p = r.productByIdentifier ?? r.data?.productByIdentifier;
  if (!p) throw new Error(`${handle} not found in Shopify`);
  return p;
}

// ── Plan ─────────────────────────────────────────────────────────────────────
const jobs = [];
for (const [handle, tier] of Object.entries(TIERS)) {
  if (ONLY && ONLY !== handle) continue;
  const bundle = bundles.find((b) => b.handle === handle);
  if (!bundle) throw new Error(`config/bundles.json has no ${handle}`);
  const unit = UNIT[tier.base];
  const live = await liveProduct(handle);
  const base = await liveProduct(tier.base);
  const basePrice = Number(base.variants.nodes[0].price);
  if (base.variants.nodes.some((v) => Number(v.price) !== basePrice)) throw new Error(`${tier.base} singles are not one price`);

  for (const v of bundle.variants) {
    const title = v.options[tier.option];
    const lv = live.variants.nodes.find((x) => x.title === title);
    if (!lv) throw new Error(`${handle}: no live variant "${title}"`);
    if (Number(lv.price) !== v.price) throw new Error(`${handle} / ${title}: roster $${v.price}, Shopify $${lv.price}`);
  }

  const ctx = { handle, tier, unit, bundle, title: live.title };
  if (FRAMES.includes('hero')) {
    for (const v of bundle.variants) {
      const units = unitsFor(tier, v);
      jobs.push({ ...ctx, frame: 'hero', variantTitle: v.options[tier.option], name: `hero-${slugify(v.options[tier.option])}`,
        units, required: [], prompt: heroPrompt({ tier, unit, units }) });
    }
  }
  const rep = representativeVariant(bundle);
  if (FRAMES.includes('offer')) {
    const units = unitsFor(tier, rep);
    const copy = offerCopy({ tier, unit, variant: rep, basePrice });
    const checks = [choiceLine(tier, bundle, unit), 'Made in the USA'];
    jobs.push({ ...ctx, frame: 'offer', name: 'offer', units, copy, checks,
      required: [copy.headline, copy.price, copy.sub, ...checks], prompt: offerPrompt({ tier, unit, units, copy, checks }) });
  }
  if (FRAMES.includes('scene')) {
    const units = sceneUnits(tier, bundle);
    jobs.push({ ...ctx, frame: 'scene', name: 'scene', units, required: [], prompt: scenePrompt({ tier, unit, units }) });
  }
}

if (NAMES) jobs.splice(0, jobs.length, ...jobs.filter((j) => NAMES.includes(j.name)));
if (MISSING) {
  // A frame already has a passing render in some earlier run: skip it. Only top-level
  // files count — _rejected/ holds failures.
  // Read the MAIN checkout's archive — the same place the publisher reads, and where
  // a human moves a rejected frame. A worktree's own copy goes stale the moment that happens.
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const runsRoot = join(dirname(common), 'data', 'creatives', 'ladder-galleries');
  const runs = existsSync(runsRoot) ? readdirSync(runsRoot).filter((d) => /^\d{4}-/.test(d)) : [];
  const done = (j) => runs.some((r) => existsSync(join(runsRoot, r, j.handle, `${j.name}.png`)));
  jobs.splice(0, jobs.length, ...jobs.filter((j) => !done(j)));
}
if (!jobs.length) { console.log('Nothing to render.'); process.exit(0); }
console.log(`${jobs.length} frames planned across ${new Set(jobs.map((j) => j.handle)).size} products.`);
if (DRY) {
  for (const j of jobs) console.log(`  ${j.handle.padEnd(28)} ${j.name.padEnd(30)} ${j.units.length} units${j.copy ? `  "${j.copy.headline}" ${j.copy.price} ${j.copy.sub}` : ''}`);
  console.log(`\n--- first prompt ---\n${jobs[0]?.prompt}`);
  const offer = jobs.find((j) => j.frame === 'offer');
  if (offer) console.log(`\n--- first offer prompt ---\n${offer.prompt}`);
  process.exit(0);
}

// ── Render ───────────────────────────────────────────────────────────────────
// pid suffix: two runs started in the same second once shared a directory and run.json.
const RUN = `${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${process.pid}`;
const OUT = join(ROOT, 'data', 'creatives', 'ladder-galleries', RUN);
const { renderJob, budget } = createRenderer({ env, outDir: OUT, maxRenders: MAX_RENDERS, engines: ENGINES });
const results = await runAll(jobs, CONCURRENCY, async (job) => {
  const r = await renderJob({ ...job, refs: await refsFor(job),
    checkText: checkPrompt({ unit: job.unit, units: job.units }),
    judge: (read) => judge({ read, units: job.units, required: job.required }) });
  return { ...r, frame: job.frame, variantTitle: job.variantTitle || null, units: job.units, copy: job.copy || null, checks: job.checks || null };
});

// ── Contact sheets ───────────────────────────────────────────────────────────
for (const handle of new Set(jobs.map((j) => j.handle))) {
  const done = results.filter((r) => r.handle === handle && r.ok);
  if (!done.length) continue;
  const tiles = await Promise.all(done.map(async (r) => ({ input: await sharp(join(OUT, handle, `${r.name}.png`)).resize(480, 480).toBuffer() })));
  const cols = Math.min(4, tiles.length);
  await sharp({ create: { width: cols * 490, height: Math.ceil(tiles.length / cols) * 490, channels: 3, background: '#bbb' } })
    .composite(tiles.map((t, i) => ({ ...t, left: (i % cols) * 490 + 5, top: Math.floor(i / cols) * 490 + 5 })))
    .jpeg({ quality: 85 }).toFile(join(OUT, handle, '_contact sheet.jpg'));
}

writeFileSync(join(OUT, 'run.json'), JSON.stringify({ run: RUN, renders: budget.used, estCostUsd: Number(budget.costUsd.toFixed(2)), results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} frames passed · ${budget.used} renders · ~$${budget.costUsd.toFixed(2)}`);
for (const f of failed) console.log(`  FAILED ${f.handle} ${f.name}: ${f.attempts.map((a) => a.error || a.reasons?.join('; ')).join(' || ')}`);
console.log(`Output: ${OUT}`);
const archived = archiveRunOutput({ sourceDir: OUT, runId: RUN, relativeDir: 'data/creatives/ladder-galleries', root: ROOT, label: 'build-ladder-galleries' });
if (archived) console.log(`Archived to ${archived}`);
