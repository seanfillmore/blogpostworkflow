#!/usr/bin/env node
// agents/ad-batch — one concept, 15-20 finished ad images.
//
// Sean writes the headlines; this tool only makes images. For each headline it picks
// ~12 scenes from data/ad-batch/scenes.json (spread across families, least-recently
// used first) plus a few generated fresh for that headline, renders each as a
// finished 4:5 ad with the headline designed into the image (OpenAI gpt-image-2,
// Gemini fallback), and checks every render letter by letter before keeping it.
//
// Usage:
//   node agents/ad-batch/index.js <batch.json> [--dry-run] [--out <dir>]
//                                 [--max-renders N] [--concurrency N]
//
// Batch file:
//   { "product": "coconut-moisturizer", "variant": "coconut-breeze",
//     "count": 16, "form": null,
//     "concepts": [ { "headline": "7 Simple Ingredients", "subhead": "vs 20+ in most lotions" } ],
//     "scenes": [] }
//
// A set (2-3 products, one of each in every image):
//   { "products": [ { "product": "coconut-lotion", "variant": "pure-unscented" },
//                   { "product": "coconut-moisturizer", "variant": "pure-unscented" } ],
//     "title": "Sensitive Skin Moisturizing Set", "concepts": [ ... ] }
//
// Output: ~/Desktop/Ad Batches/<date> <product>/<NN headline>/ — images, _rejected/,
// _contact sheet.jpg, scenes.md — plus run.json for the batch. Nothing is published.
// Design: docs/superpowers/specs/2026-10-06-ad-batch-design.md

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { GoogleGenAI } from '@google/genai';
import Anthropic from '../../lib/anthropic.js';
import { LLM_MODELS } from '../../config/llm-models.js';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { parseBatch, screenConcepts, resolveLineup } from './batch.js';
import { selectLibraryScenes, customScenes, generateFreshScenes, LIBRARY_SHARE } from './scenes.js';
import { buildPrompt } from './prompt.js';
import { renderOpenAI, renderGemini, ATTEMPTS } from './render.js';
import { checkPrompt, parseCheck, decide } from './check.js';
import {
  DEFAULT_OUT_ROOT, batchDirName, conceptDirName, imageName, loadUsage, saveUsage,
  ensureDir, writeContactSheet, scenesMarkdown,
} from './output.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_MAX_RENDERS = 120;
export const DEFAULT_CONCURRENCY = 4;

export function parseArgs(argv) {
  const args = { batchFile: null, dryRun: false, out: DEFAULT_OUT_ROOT, maxRenders: DEFAULT_MAX_RENDERS, concurrency: DEFAULT_CONCURRENCY };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--out') args.out = resolve(argv[++i]);
    else if (a === '--max-renders') args.maxRenders = Number(argv[++i]);
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (!a.startsWith('--') && !args.batchFile) args.batchFile = a;
    else throw new Error(`ad-batch: unknown argument ${a}`);
  }
  if (!args.batchFile) throw new Error('ad-batch: usage: node agents/ad-batch/index.js <batch.json> [--dry-run]');
  if (!(args.maxRenders > 0)) throw new Error('ad-batch: --max-renders must be a positive number');
  if (!(args.concurrency >= 1)) throw new Error('ad-batch: --concurrency must be at least 1');
  return args;
}

function loadEnv() {
  try {
    return Object.fromEntries(readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
      .filter(l => l.includes('=') && !l.trim().startsWith('#'))
      .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
  } catch { return {}; }
}

/** Scenes for one concept: Sean's list if given, else library + fresh. */
export async function planScenes({ batch, concept, product, library, usage, taken, anthropic }) {
  if (batch.scenes.length) return { scenes: customScenes(batch.scenes), degraded: null };
  const nLib = Math.min(LIBRARY_SHARE, batch.count);
  const lib = selectLibraryScenes({ library, category: product.category, n: nLib, usage, seed: concept.headline, exclude: taken });
  const want = batch.count - lib.length;
  const fresh = await generateFreshScenes({ anthropic, model: LLM_MODELS.standard, product, concept, chosen: lib, k: want, library });
  let scenes = [...lib, ...fresh.scenes];
  if (scenes.length < batch.count) {
    // Planner short: top up from the library rather than ship a thin batch.
    const more = selectLibraryScenes({ library, category: product.category, n: batch.count, usage, seed: concept.headline + '#topup', exclude: taken })
      .filter(s => !scenes.some(x => x.id === s.id));
    scenes = [...scenes, ...more.slice(0, batch.count - scenes.length)];
  }
  return { scenes, degraded: fresh.degraded };
}

async function refForCheck(path) {
  return (await sharp(path).rotate().resize(1024, 1024, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer()).toString('base64');
}

async function visionCheck({ anthropic, refsB64, imageBuf, product, shown }) {
  const img = (await sharp(imageBuf).resize(1200, 1200, { fit: 'inside' }).jpeg({ quality: 88 }).toBuffer()).toString('base64');
  const res = await anthropic.messages.create({
    model: LLM_MODELS.standard,
    max_tokens: 1500,
    messages: [{ role: 'user', content: [
      ...refsB64.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img } },
      { type: 'text', text: checkPrompt({ product, shown }) },
    ] }],
  });
  return parseCheck((res.content || []).map(c => c.text || '').join(''));
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/** Render one scene: up to two OpenAI tries, then Gemini; keep the first that passes. */
export async function renderScene({ job, clients, budget, refCache, log }) {
  const { product, concept, scene, form } = job;
  const { prompt, refs, shown } = buildPrompt({ product, concept, scene, form });
  const attempts = [];
  let last = null;
  for (const engine of ATTEMPTS) {
    if (budget.used >= budget.max) { attempts.push({ engine, error: 'render budget exhausted' }); break; }
    if (engine === 'gemini' && !clients.gemini) continue;
    budget.used++;
    let r;
    try {
      r = engine === 'openai'
        ? await renderOpenAI({ apiKey: clients.openaiKey, prompt, refs })
        : await renderGemini({ gemini: clients.gemini, prompt, refs });
    } catch (err) {
      attempts.push({ engine, error: err.message });
      continue;
    }
    budget.costUsd += r.costUsd;
    // A set is checked against one reference per product, in product order; a single
    // product against its first reference.
    const checkRefs = product.items?.length > 1 ? refs : [refs[0]];
    for (const ref of checkRefs) if (!refCache.has(ref)) refCache.set(ref, await refForCheck(ref));
    let read = null;
    try { read = await visionCheck({ anthropic: clients.anthropic, refsB64: checkRefs.map(ref => refCache.get(ref)), imageBuf: r.buffer, product, shown }); }
    catch (err) { log(`    check failed to run: ${err.message}`); }
    const verdict = decide({ read, concept, product, shown });
    attempts.push({ engine: r.model, ok: verdict.ok, reasons: verdict.reasons });
    last = { ...r, verdict };
    if (verdict.ok) return { ok: true, model: r.model, buffer: r.buffer, reasons: [], notes: verdict.notes, attempts, shown, prompt };
  }
  return {
    ok: false, model: last?.model || null, buffer: last?.buffer || null,
    reasons: last ? last.verdict.reasons : attempts.map(a => a.error).filter(Boolean),
    notes: last?.verdict.notes || [], attempts, shown, prompt,
  };
}

export async function main(argv = process.argv.slice(2), { log = console.log } = {}) {
  const args = parseArgs(argv);
  const env = { ...loadEnv(), ...process.env };
  const batch = parseBatch(JSON.parse(readFileSync(resolve(args.batchFile), 'utf8')));
  const manifest = JSON.parse(readFileSync(join(ROOT, 'data/product-images/manifest.json'), 'utf8'));
  const references = JSON.parse(readFileSync(join(ROOT, 'data/ad-batch/references.json'), 'utf8'));
  const library = JSON.parse(readFileSync(join(ROOT, 'data/ad-batch/scenes.json'), 'utf8'));
  const product = resolveLineup({ batch, manifest, references, imageRoot: join(ROOT, 'data/product-images') });

  const { ok: concepts, skipped } = screenConcepts(batch.concepts);
  for (const s of skipped) log(`⚠ skipped "${s.headline}": ${s.reasons.join('; ')}`);
  if (!concepts.length) throw new Error('ad-batch: every concept failed the copy check; nothing to render');

  if (!args.dryRun && !env.OPENAI_API_KEY) throw new Error('ad-batch: missing OPENAI_API_KEY in .env');
  const anthropic = new Anthropic();
  const gemini = env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }) : null;
  const usage = loadUsage(args.out);
  const taken = new Set();

  log(`ad-batch: ${product.title}${product.variant ? ' / ' + product.variant : ''} · ${concepts.length} headline(s) × ${batch.count} scenes`);
  const plans = [];
  for (const concept of concepts) {
    const { scenes, degraded } = await planScenes({ batch, concept, product, library, usage, taken, anthropic });
    scenes.forEach(s => taken.add(s.id));
    if (degraded) log(`  ⚠ "${concept.headline}": ${degraded}; topped up from the library`);
    plans.push({ concept, scenes, degraded });
  }

  const totalRenders = plans.reduce((n, p) => n + p.scenes.length, 0);
  if (args.dryRun) {
    for (const p of plans) {
      log(`\n"${p.concept.headline}"${p.concept.subhead ? ' / ' + p.concept.subhead : ''}`);
      p.scenes.forEach((s, i) => log(`  ${String(i + 1).padStart(2)}. [${s.source}/${s.family}] ${s.id}: ${s.scene.slice(0, 90)}`));
    }
    log(`\nDry run: ${totalRenders} images planned (≥${totalRenders} renders, ≤${Math.min(totalRenders * ATTEMPTS.length, args.maxRenders)} with retries).`);
    log('\nFirst prompt:\n' + buildPrompt({ product, concept: plans[0].concept, scene: plans[0].scenes[0], form: batch.form }).prompt);
    return { dryRun: true, plans };
  }

  const date = new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD: the folder is for Sean, not a log
  const batchDir = ensureDir(join(args.out, batchDirName({ date, product })));
  const budget = { used: 0, max: args.maxRenders, costUsd: 0 };
  const clients = { openaiKey: env.OPENAI_API_KEY, gemini, anthropic };
  const refCache = new Map();
  const record = {
    generatedAt: new Date().toISOString(),
    product: { handle: product.handle, variant: product.variant, title: product.title, items: product.items?.map(i => ({ handle: i.handle, variant: i.variant })) },
    skipped, concepts: [],
  };

  for (const [ci, plan] of plans.entries()) {
    const dir = ensureDir(join(batchDir, conceptDirName(ci, plan.concept)));
    log(`\n▶ "${plan.concept.headline}" → ${dir}`);
    const results = await pool(plan.scenes, args.concurrency, async (scene, i) => {
      const r = await renderScene({ job: { product, concept: plan.concept, scene, form: batch.form }, clients, budget, refCache, log });
      const name = imageName(i, scene);
      if (r.buffer) {
        const path = join(r.ok ? dir : ensureDir(join(dir, '_rejected')), name);
        writeFileSync(path, r.buffer);
        r.path = path;
      }
      log(`  ${r.ok ? '✅' : '❌'} ${name}${r.ok ? ` (${r.model})` : ` — ${r.reasons.join('; ')}`}`);
      if (r.ok && scene.source === 'library') usage[scene.id] = new Date().toISOString();
      return { ...r, scene, buffer: undefined };
    });
    const kept = results.filter(r => r.ok);
    await writeContactSheet(dir, kept.map(r => ({ path: r.path, caption: `${r.scene.id}${r.notes.includes('hands in frame') ? ' ✋' : ''}` })));
    writeFileSync(join(dir, 'scenes.md'), scenesMarkdown({ concept: plan.concept, results }));
    record.concepts.push({
      ...plan.concept, dir, degraded: plan.degraded, kept: kept.length, rejected: results.length - kept.length,
      images: results.map(r => ({ scene: r.scene, ok: r.ok, model: r.model, file: r.path || null, reasons: r.reasons, notes: r.notes, attempts: r.attempts, shown: r.shown })),
    });
    log(`  ${kept.length}/${results.length} kept`);
  }

  saveUsage(args.out, usage);
  record.renders = budget.used;
  record.estimatedCostUsd = Math.round(budget.costUsd * 100) / 100;
  writeFileSync(join(batchDir, 'run.json'), JSON.stringify(record, null, 2));
  const kept = record.concepts.reduce((n, c) => n + c.kept, 0);
  log(`\nDone: ${kept} images kept from ${budget.used} renders, est. $${record.estimatedCostUsd}. ${batchDir}`);
  return record;
}

if (isDirectRun(import.meta.url)) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}
