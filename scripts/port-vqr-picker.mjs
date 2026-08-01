#!/usr/bin/env node
/**
 * Port the working variant-picker block from product.bundle-landing.json to every
 * other template that carries a broken copy.
 *
 *   node scripts/port-vqr-picker.mjs [--apply]
 *
 * Context: docs/known-issues/wrong-variant-added-to-cart.md. Eight PDPs were
 * adding the wrong variant to cart because their `vqr-combo` block assigns a
 * VARIANT ID to a select whose options are option VALUES. The id matches nothing,
 * the select empties, and the form is never updated — so the buyer is shipped the
 * default variant regardless of what they picked.
 *
 * bundle-landing already carries the corrected block, proven by all five
 * bundle-landing products passing the sweep. This copies that one block verbatim
 * rather than hand-editing seven near-identical copies, which is how the versions
 * diverged in the first place.
 *
 * The block is generic Liquid — it builds its variant→option-value table from
 * `product.variants` at render time and reads its label from `product.options[0]`
 * — so nothing needs adapting per template.
 *
 * Every template is backed up to theme/backup/templates/ before it is touched.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessToken } from '../lib/shopify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const SOURCE = 'templates/product.bundle-landing.json';
const BLOCK = 'vqr-combo';

const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const token = await getAccessToken();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rest(path, init) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`https://${env.SHOPIFY_STORE}/admin/api/2025-01/${path}`, {
      ...init,
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(60_000),
    });
    if (r.status === 429) { await sleep(1500); continue; }
    const j = await r.json();
    if (!r.ok) throw new Error(`HTTP ${r.status} on ${path}: ${JSON.stringify(j).slice(0, 240)}`);
    return j;
  }
  throw new Error(`rate limited repeatedly on ${path}`);
}

const { themes } = await rest('themes.json');
const theme = themes.find((t) => t.role === 'main');
console.log(`theme: ${theme.name} (${theme.id})\n`);

const readTemplate = async (key) => {
  const raw = (await rest(`themes/${theme.id}/assets.json?asset[key]=${encodeURIComponent(key)}`)).asset?.value;
  if (raw === undefined) return null;
  return raw;
};

/** Locate the main-product section's target block, whatever the section is keyed as. */
const findBlock = (parsed) => {
  for (const section of Object.values(parsed.sections ?? {})) {
    if (section.type !== 'main-product') continue;
    const block = (section.blocks ?? {})[BLOCK];
    if (block) return block;
  }
  return null;
};

const sourceRaw = await readTemplate(SOURCE);
if (!sourceRaw) throw new Error(`source template missing: ${SOURCE}`);
const sourceBlock = findBlock(JSON.parse(sourceRaw));
if (!sourceBlock?.settings?.custom_liquid) throw new Error(`no ${BLOCK} block in ${SOURCE}`);
const GOOD = sourceBlock.settings.custom_liquid;

// The whole point of the port. If the source ever loses this, porting it would
// spread the bug rather than fix it.
if (!/Assign the OPTION VALUE, never the variant id/.test(GOOD) || !/VQR_OPTION_VALUES/.test(GOOD)) {
  throw new Error(`${SOURCE}'s ${BLOCK} block does not look like the corrected version — refusing to port it`);
}
console.log(`source block: ${GOOD.length} bytes, verified corrected\n`);

const { assets } = await rest(`themes/${theme.id}/assets.json`);
const targets = assets.map((a) => a.key)
  .filter((k) => /^templates\/product\.landing-page-.*\.json$/.test(k))
  .sort();

let changed = 0;
for (const key of targets) {
  const raw = await readTemplate(key);
  await sleep(250);
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { console.log(`  ${key.padEnd(52)} SKIP — not parseable JSON`); continue; }

  const block = findBlock(parsed);
  if (!block) { console.log(`  ${key.padEnd(52)} skip — no ${BLOCK} block`); continue; }
  const currentLiquid = block.settings?.custom_liquid ?? '';
  if (currentLiquid === GOOD) { console.log(`  ${key.padEnd(52)} ✓ already correct`); continue; }

  const broken = /hidden\.value\s*=\s*pickEl\.value/.test(currentLiquid);
  console.log(`  ${key.padEnd(52)} → port  (${broken ? 'confirmed broken' : 'differs, not the known-broken shape'})`);
  changed++;

  if (!APPLY) continue;

  const backup = join(ROOT, 'theme', 'backup', key);
  mkdirSync(dirname(backup), { recursive: true });
  if (!existsSync(backup)) writeFileSync(backup, raw);

  block.settings.custom_liquid = GOOD;
  await rest(`themes/${theme.id}/assets.json`, {
    method: 'PUT',
    body: JSON.stringify({ asset: { key, value: JSON.stringify(parsed, null, 2) } }),
  });
  await sleep(600);

  // Read back and confirm the block really changed on the live theme.
  let ok = false;
  for (let i = 0; i < 6 && !ok; i++) {
    await sleep(1200);
    const after = findBlock(JSON.parse(await readTemplate(key)));
    ok = after?.settings?.custom_liquid === GOOD;
  }
  if (!ok) throw new Error(`${key}: write-back verification failed — restore from ${backup.replace(ROOT + '/', '')}`);
  console.log(`      written and verified`);
}

console.log(`\n${changed} template(s) ${APPLY ? 'ported' : 'would be ported'}.`);
if (!APPLY && changed) console.log('dry run — pass --apply');
if (APPLY && changed) console.log('Now run: npm run check-variant-picker');
