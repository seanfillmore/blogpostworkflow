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
import { GoogleGenAI } from '@google/genai';
import Anthropic from '../lib/anthropic.js';
import { LLM_MODELS } from '../config/llm-models.js';
import { shopifyGraphQL } from '../lib/shopify.js';
import { archiveRunOutput } from '../lib/archive-run-output.js';
import { renderOpenAI, renderGemini, ATTEMPTS } from '../agents/ad-batch/render.js';
import { parseCheck } from '../agents/ad-batch/check.js';
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
const PLAN_ATTEMPTS = ENGINES === 'gemini' ? ['gemini', 'gemini', 'gemini'] : ENGINES === 'openai' ? ['openai', 'openai', 'openai'] : ATTEMPTS;
const SIZE = '2048x2048';

const env = Object.fromEntries(readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
  .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));

const { bundles } = JSON.parse(readFileSync(join(ROOT, 'config', 'bundles.json'), 'utf8'));
const CUTOUTS = join(ROOT, 'data', 'brand', 'cutouts');

// ── References: the prop-free cutouts, flattened onto white ─────────────────
const refDir = join(ROOT, 'data', 'creatives', 'ladder-galleries', '_refs');
mkdirSync(refDir, { recursive: true });
async function refFor(unit, scent) {
  const name = `${unit.refKey}-${slugify(scent)}`;
  let src = join(CUTOUTS, `component-${name}.png`);
  // One artifact is pinned to a historical misspelling; see data/brand/frames/deodorant-4-pack.
  if (!existsSync(src)) src = join(CUTOUTS, `component-${name.replace('frankincense', 'frankincence')}.png`);
  if (!existsSync(src)) throw new Error(`no cutout for ${unit.refKey} / ${scent} (looked for component-${name}.png)`);
  const out = join(refDir, `${name}.png`);
  if (!existsSync(out)) {
    const m = await sharp(src).metadata();
    const side = Math.round(Math.max(m.width, m.height) * 1.15);
    await sharp({ create: { width: side, height: side, channels: 3, background: '#ffffff' } })
      .composite([{ input: await sharp(src).flatten({ background: '#ffffff' }).toBuffer(), gravity: 'center' }])
      .png().toBuffer()
      .then((b) => sharp(b).resize(1024, 1024).png().toFile(out));
  }
  return out;
}

/** A label close-up cut from the same cutout, so it always matches the scent. */
async function detailFor(unit, scent) {
  const full = await refFor(unit, scent);
  const out = full.replace(/\.png$/, '-label.png');
  if (!existsSync(out)) {
    const src = join(CUTOUTS, `component-${unit.refKey}-${slugify(scent)}.png`);
    const m = await sharp(src).metadata();
    const [a, b] = unit.detailCrop;
    const buf = await sharp(src).flatten({ background: '#ffffff' })
      .extract({ left: 0, top: Math.round(m.height * a), width: m.width, height: Math.round(m.height * (b - a)) }).png().toBuffer();
    await sharp(buf).resize({ height: 1024 }).png().toFile(out);
  }
  return out;
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
const anthropic = new Anthropic();
const gemini = env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }) : null;
const budget = { used: 0, costUsd: 0 };

const jpegB64 = async (buf, px = 1024) => (await sharp(buf).resize(px, px, { fit: 'inside' }).jpeg({ quality: 88 }).toBuffer()).toString('base64');

async function read(job, refs, buf) {
  const content = [];
  for (const r of refs) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await jpegB64(readFileSync(r), 512) } });
  content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await jpegB64(buf, 1400) } });
  content.push({ type: 'text', text: checkPrompt({ unit: job.unit, units: job.units }) });
  const res = await anthropic.messages.create({ model: LLM_MODELS.standard, max_tokens: 2000, messages: [{ role: 'user', content }] });
  return parseCheck((res.content || []).map((c) => c.text || '').join(''));
}

async function renderJob(job) {
  const refs = [];
  for (const s of [...new Set(job.units)]) {
    refs.push(await refFor(job.unit, s));
    if (job.unit.detailCrop) refs.push(await detailFor(job.unit, s));
  }
  const attempts = [];
  let last = null;
  for (const engine of PLAN_ATTEMPTS) {
    if (budget.used >= MAX_RENDERS) { attempts.push({ engine, error: 'render budget exhausted' }); break; }
    if (engine === 'gemini' && !gemini) continue;
    budget.used++;
    let r;
    try {
      r = engine === 'openai'
        ? await renderOpenAI({ apiKey: env.OPENAI_API_KEY, prompt: job.prompt, refs, size: SIZE })
        : await renderGemini({ gemini, prompt: job.prompt, refs, aspectRatio: '1:1' });
    } catch (e) { attempts.push({ engine, error: e.message }); continue; }
    budget.costUsd += r.costUsd;
    let verdict;
    try { verdict = judge({ read: await read(job, refs, r.buffer), units: job.units, required: job.required }); }
    catch (e) { verdict = { ok: false, reasons: [`vision read failed: ${e.message}`] }; }
    attempts.push({ engine: r.model, ok: verdict.ok, reasons: verdict.reasons });
    last = { buf: r.buffer, verdict, model: r.model };
    const dir = join(OUT, job.handle, verdict.ok ? '' : '_rejected');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${job.name}${verdict.ok ? '' : `-a${attempts.length}`}.png`), r.buffer);
    console.log(`  ${verdict.ok ? '✓' : '✗'} ${job.handle} ${job.name} [${r.model}] ${verdict.reasons.join(' | ')}`);
    if (verdict.ok) break;
  }
  return { handle: job.handle, frame: job.frame, name: job.name, variantTitle: job.variantTitle || null,
    units: job.units, copy: job.copy || null, checks: job.checks || null,
    ok: !!last?.verdict.ok, model: last?.model || null, attempts, prompt: job.prompt };
}

const results = new Array(jobs.length);
let next = 0;
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (next < jobs.length) { const i = next++; results[i] = await renderJob(jobs[i]); }
}));

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
