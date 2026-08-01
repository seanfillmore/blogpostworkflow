#!/usr/bin/env node
/**
 * Generate a product-gallery frame with Gemini, grounded in real product photography.
 *
 *   node scripts/generate-frame.mjs <spec.mjs> [--n 3] [--out DIR]
 *
 * Companion to scripts/render-frame.mjs. The split between them:
 *
 *   RENDER   — the frame is type over a colour field and its figures move
 *              (ratings, counts, prices). Exact, reproducible, re-renders when
 *              the data changes.
 *   GENERATE — the frame is a designed composition. A model that can light,
 *              arrange and lay out beats slicing a photograph into rectangles.
 *
 * Grounding is not optional. Per `.claude/skills/marketing-ai-product-imagery`,
 * the model has no ground truth for our packaging — without our own photographs
 * it averages the category and renders a competitor's bottle. Every spec must
 * supply real reference images of the actual product, and the audit step below
 * exists because these models invent plausible detail that survives a casual look.
 *
 * Uses gemini-3-pro-image: `docs/bundle-media-plan.md` §3 requires the pro model
 * at 2K for any frame carrying legible text, because Flash fails at text and
 * every frame in this plan carries a headline.
 *
 * A spec module exports:
 *   { name, product, prompt, references: [repo-relative paths], aspectRatio? }
 *
 * Output is written with a .prompt.json sidecar recording the model, the prompt
 * and the exact references used, because a generated asset with no provenance is
 * not auditable later.
 */

import { readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'gemini-3-pro-image';

const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const argv = process.argv.slice(2);
const specPath = argv.find((a) => !a.startsWith('--'));
const n = argv.includes('--n') ? Number(argv[argv.indexOf('--n') + 1]) : 1;
const outDir = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : join(ROOT, 'data', 'brand', 'candidates');
if (!specPath) { console.error('usage: generate-frame.mjs <spec.mjs> [--n 3]'); process.exit(2); }

const spec = (await import(pathToFileURL(resolve(specPath)).href)).default;
for (const k of ['name', 'prompt', 'references']) {
  if (!spec[k]) throw new Error(`${basename(specPath)}: spec must export "${k}"`);
}
if (!spec.references.length) {
  throw new Error(`${spec.name}: at least one real reference photograph is required — an ungrounded render invents our packaging`);
}

const { GoogleGenAI } = await import('@google/genai');
const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

const parts = [];
for (const ref of spec.references) {
  const abs = join(ROOT, ref);
  if (!existsSync(abs)) throw new Error(`${spec.name}: reference not found: ${ref}`);
  const ext = ref.split('.').pop().toLowerCase();
  const mimeType = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[ext];
  if (!mimeType) throw new Error(`${spec.name}: unsupported reference type .${ext}`);
  parts.push({ inlineData: { data: readFileSync(abs).toString('base64'), mimeType } });
  console.log(`  reference: ${ref}`);
}
parts.push({ text: spec.prompt });

mkdirSync(outDir, { recursive: true });
console.log(`\n${spec.name} — ${MODEL} @ 2K, ${n} candidate(s)\n`);

for (let i = 1; i <= n; i++) {
  process.stdout.write(`  [${i}/${n}] generating... `);
  const res = await gemini.models.generateContent({
    model: MODEL,
    contents: [{ role: 'user', parts }],
    config: {
      responseModalities: ['IMAGE'],
      imageConfig: { imageSize: '2K', aspectRatio: spec.aspectRatio ?? '1:1' },
    },
  });

  const image = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData)?.inlineData;
  if (!image) {
    const text = res.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text;
    console.log(`no image returned${text ? ` — model said: ${text.slice(0, 200)}` : ''}`);
    continue;
  }

  const file = join(outDir, n === 1 ? `${spec.name}.jpg` : `${spec.name}-${i}.jpg`);
  await sharp(Buffer.from(image.data, 'base64'))
    .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
    .toFile(file);
  const meta = await sharp(file).metadata();
  console.log(`${meta.width}×${meta.height}  ${Math.round(statSync(file).size / 1024)} KB  → ${file.replace(ROOT + '/', '')}`);
}

writeFileSync(join(outDir, `${spec.name}.prompt.json`), JSON.stringify({
  name: spec.name,
  model: MODEL,
  generative: true,
  imageSize: '2K',
  aspectRatio: spec.aspectRatio ?? '1:1',
  references: spec.references,
  prompt: spec.prompt,
}, null, 2) + '\n');

console.log(`\nCandidates are NOT approved assets. Audit before upload:`);
console.log(`  · every label word legible and correct ("real SKIN CARE", scent name, fl oz)`);
console.log(`  · no invented packaging, applicators, textures or badges`);
console.log(`  · the same product rendered at consistent proportions across the frame`);
console.log(`  · counts match config/bundles.json`);
