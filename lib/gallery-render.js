/**
 * The render loop shared by scripts/build-ladder-galleries.mjs and
 * scripts/build-bundle-galleries.mjs: prop-free references from the cutout
 * library, gpt-image-2 / Gemini renders, a vision READ, and a verdict the CALLER
 * decides in code. Extracted when the second script appeared — two copies of a
 * retry-and-judge loop drift, and a drifted copy is how a weaker gate ships.
 *
 * The caller passes `check(buffer, refs)` returning {ok, reasons}; this module
 * never decides whether an image is acceptable.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { GoogleGenAI } from '@google/genai';
import Anthropic from './anthropic.js';
import { LLM_MODELS } from '../config/llm-models.js';
import { renderOpenAI, renderGemini, ATTEMPTS } from '../agents/ad-batch/render.js';
import { parseCheck } from '../agents/ad-batch/check.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CUTOUTS = join(ROOT, 'data', 'brand', 'cutouts');
export const SIZE = '2048x2048';
const slugify = (s) => String(s).toLowerCase().replace(/[—–]/g, '-').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function loadEnv() {
  return Object.fromEntries(readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
}

export function planAttempts(engines) {
  return engines === 'gemini' ? ['gemini', 'gemini', 'gemini'] : engines === 'openai' ? ['openai', 'openai', 'openai'] : ATTEMPTS;
}

/** A cutout path; one artifact is pinned to a historical misspelling (data/brand/frames/deodorant-4-pack). */
export function cutoutPath(refKey, scent) {
  const name = `${refKey}-${slugify(scent)}`;
  let src = join(CUTOUTS, `component-${name}.png`);
  if (!existsSync(src)) src = join(CUTOUTS, `component-${name.replace('frankincense', 'frankincence')}.png`);
  if (!existsSync(src)) throw new Error(`no cutout for ${refKey} / ${scent} (looked for component-${name}.png)`);
  return src;
}

/** Any image flattened onto white and squared — what the models and the reader are given. */
export async function flatRef(src, out) {
  if (existsSync(out)) return out;
  mkdirSync(dirname(out), { recursive: true });
  const m = await sharp(src).metadata();
  const side = Math.round(Math.max(m.width, m.height) * 1.15);
  const buf = await sharp({ create: { width: side, height: side, channels: 3, background: '#ffffff' } })
    .composite([{ input: await sharp(src).flatten({ background: '#ffffff' }).toBuffer(), gravity: 'center' }]).png().toBuffer();
  await sharp(buf).resize(1024, 1024).png().toFile(out);
  return out;
}

export const cutoutRef = (refDir, refKey, scent) =>
  flatRef(cutoutPath(refKey, scent), join(refDir, `${refKey}-${slugify(scent)}.png`));

/** A label close-up cut from the same cutout, so it always matches the scent. */
export async function labelCrop(refDir, refKey, scent, [a, b]) {
  const out = join(refDir, `${refKey}-${slugify(scent)}-label.png`);
  if (existsSync(out)) return out;
  const src = cutoutPath(refKey, scent);
  const m = await sharp(src).metadata();
  const buf = await sharp(src).flatten({ background: '#ffffff' })
    .extract({ left: 0, top: Math.round(m.height * a), width: m.width, height: Math.round(m.height * (b - a)) }).png().toBuffer();
  await sharp(buf).resize({ height: 1024 }).png().toFile(out);
  return out;
}

const jpegB64 = async (buf, px) => (await sharp(buf).flatten({ background: '#ffffff' }).resize(px, px, { fit: 'inside' }).jpeg({ quality: 88 }).toBuffer()).toString('base64');

/**
 * @returns {{ renderJob(job): Promise<object>, budget: {used:number, costUsd:number} }}
 * job: { handle, name, prompt, refs:string[], checkText:string, judge(read):{ok,reasons} }
 */
export function createRenderer({ env, outDir, maxRenders = 240, engines = null, log = console.log }) {
  const anthropic = new Anthropic();
  const gemini = env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }) : null;
  const budget = { used: 0, costUsd: 0 };
  const attemptsPlan = planAttempts(engines);

  async function read(job, buf) {
    const content = [];
    for (const r of job.refs) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await jpegB64(readFileSync(r), 512) } });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await jpegB64(buf, 1400) } });
    content.push({ type: 'text', text: job.checkText });
    const res = await anthropic.messages.create({ model: LLM_MODELS.standard, max_tokens: 2500, messages: [{ role: 'user', content }] });
    return parseCheck((res.content || []).map((c) => c.text || '').join(''));
  }

  async function renderJob(job) {
    const attempts = [];
    let last = null;
    for (const engine of attemptsPlan) {
      if (budget.used >= maxRenders) { attempts.push({ engine, error: 'render budget exhausted' }); break; }
      if (engine === 'gemini' && !gemini) continue;
      budget.used++;
      let r;
      try {
        r = engine === 'openai'
          ? await renderOpenAI({ apiKey: env.OPENAI_API_KEY, prompt: job.prompt, refs: job.refs, size: SIZE })
          : await renderGemini({ gemini, prompt: job.prompt, refs: job.refs, aspectRatio: '1:1' });
      } catch (e) { attempts.push({ engine, error: e.message }); continue; }
      budget.costUsd += r.costUsd;
      let verdict;
      try { verdict = job.judge(await read(job, r.buffer)); }
      catch (e) { verdict = { ok: false, reasons: [`vision read failed: ${e.message}`] }; }
      attempts.push({ engine: r.model, ok: verdict.ok, reasons: verdict.reasons });
      last = { verdict, model: r.model };
      const dir = join(outDir, job.handle, verdict.ok ? '' : '_rejected');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${job.name}${verdict.ok ? '' : `-a${attempts.length}`}.png`), r.buffer);
      log(`  ${verdict.ok ? '✓' : '✗'} ${job.handle} ${job.name} [${r.model}] ${verdict.reasons.join(' | ')}`);
      if (verdict.ok) break;
    }
    return { handle: job.handle, name: job.name, ok: !!last?.verdict.ok, model: last?.model || null, attempts, prompt: job.prompt };
  }
  return { renderJob, budget };
}

/** Run jobs with bounded concurrency, results in input order. */
export async function runAll(jobs, n, fn) {
  const out = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await fn(jobs[i]); }
  }));
  return out;
}
