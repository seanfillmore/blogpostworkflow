#!/usr/bin/env node
/**
 * Re-run the CURRENT ad-batch check over images already in the library, without
 * rendering anything. Use it after the check gets stricter, to find ads that passed an
 * older, weaker check (2026-11-10: a Pure Unscented lotion without its leaf and soap bars
 * at half their real thickness had passed).
 *
 *   node scripts/ad-batch-recheck.mjs <batch.json> <theme dir> [--move]
 *
 * Reads <theme>/4x5 and <theme>/9x16 files whose names start with the batch's
 * "<date> <title>" prefix, maps each to its concept by the NN in the file name, and
 * prints pass/fail with the reasons. --move moves every failing file into
 * <theme>/_records/_failed-recheck/ so it can no longer be picked up by mistake.
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import Anthropic from '../lib/anthropic.js';
import { LLM_MODELS } from '../config/llm-models.js';
import { parseBatch, resolveLineup } from '../agents/ad-batch/batch.js';
import { checkPrompt, parseCheck, decide } from '../agents/ad-batch/check.js';
import { FEED_DIR, VERTICAL_DIR, RECORDS_DIR } from '../agents/ad-batch/output.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [batchFile, themeDir] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const move = process.argv.includes('--move');
if (!batchFile || !themeDir) { console.error('usage: ad-batch-recheck.mjs <batch.json> <theme dir> [--move]'); process.exit(64); }

const batch = parseBatch(JSON.parse(readFileSync(batchFile, 'utf8')));
const manifest = JSON.parse(readFileSync(join(ROOT, 'data/product-images/manifest.json'), 'utf8'));
const references = JSON.parse(readFileSync(join(ROOT, 'data/ad-batch/references.json'), 'utf8'));
const product = resolveLineup({ batch, manifest, references, imageRoot: join(ROOT, 'data/product-images') });
const title = product.title.split(/[|—–]/)[0].trim();
const anthropic = new Anthropic();
const b64 = async (p, max) => (await sharp(p).rotate().resize(max, max, { fit: 'inside' }).jpeg({ quality: 88 }).toBuffer()).toString('base64');
const refs = await Promise.all((product.items?.length > 1 ? product.refs.packaged : [product.refs.packaged[0]]).map(r => b64(r, 1024)));

let fails = 0;
for (const [dir, ratio] of [[FEED_DIR, '4:5'], [VERTICAL_DIR, '9:16']]) {
  const d = join(themeDir, dir);
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d).filter(n => n.includes(` ${title}`) && n.endsWith('.png')).sort()) {
    const nn = Number((f.match(/ - (\d\d) /) || [])[1]);
    const concept = batch.concepts[nn - 1];
    if (!concept) { console.log(`?  ${dir}/${f}: no concept ${nn}`); continue; }
    const res = await anthropic.messages.create({
      model: LLM_MODELS.standard, max_tokens: 1500,
      messages: [{ role: 'user', content: [
        ...refs.map(data => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })),
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await b64(join(d, f), 1200) } },
        { type: 'text', text: checkPrompt({ product, shown: 'packaged', style: batch.style, layout: !!concept.layout, ratio }) },
      ] }],
    });
    const read = parseCheck((res.content || []).map(c => c.text || '').join(''));
    const v = decide({ read, concept, product, shown: 'packaged', ratio });
    console.log(`${v.ok ? 'PASS' : 'FAIL'}  ${dir}/${f}${v.ok ? '' : `\n      ${v.reasons.join('\n      ')}`}`);
    if (!v.ok) {
      fails++;
      if (move) { const to = join(themeDir, RECORDS_DIR, '_failed-recheck', dir); mkdirSync(to, { recursive: true }); renameSync(join(d, f), join(to, f)); }
    }
  }
}
console.log(`\n${fails} failing${move && fails ? ', moved to _records/_failed-recheck/' : ''}.`);
