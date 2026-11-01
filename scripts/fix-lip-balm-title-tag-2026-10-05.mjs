#!/usr/bin/env node
/**
 * Put "beeswax" in the lip balm PDP's SERP title (2026-10-05).
 *
 * "beeswax lip balm" is 9,900 searches/mo; Moon Valley Organics ranks #5 and
 * RSC does not rank at all, although organic beeswax is one of the lip balm's
 * three ingredients (config/ingredients.json) and the meta description already
 * names it. The five lip balm collections were retired to this PDP on
 * 2026-07-27, so the PDP is the one page to target.
 *
 * Writes ONLY global.title_tag. The product title is untouched, because Klaviyo
 * flows key on it. The new title omits the brand, so the theme appends
 * " – Real Skin Care" (58 rendered characters).
 *
 * Dry by default; --apply backs up the live value and writes. The live value
 * must equal BEFORE (or already AFTER), else the run refuses.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../lib/is-direct-run.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { checkCopyLength } from '../lib/seo-copy-length.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PRODUCT_ID = 7644975071402;
export const HANDLE = 'coconut-oil-lip-balm';
export const TITLE_TAG = {
  before: 'Coconut Oil Lip Balm – Real Skin Care',
  after: 'Natural Beeswax Lip Balm with Coconut Oil',
};

export function gateAfter() {
  const gate = checkSeoCopyFields({ title: TITLE_TAG.after });
  if (!gate.ok) throw new Error(`claim gate: ${JSON.stringify(gate.blocking)}`);
  const len = checkCopyLength({ title: TITLE_TAG.after });
  if (len.overlong?.length) throw new Error(`title too long: ${JSON.stringify(len.overlong)}`);
}

export function decide(live) {
  if (live === TITLE_TAG.after) return 'already-applied';
  if (live === TITLE_TAG.before) return 'apply';
  return 'refuse';
}

async function main() {
  const apply = process.argv.includes('--apply');
  gateAfter();
  const { getProduct, getMetafields, upsertMetafield } = await import('../lib/shopify.js');
  const p = await getProduct(PRODUCT_ID);
  if (p.handle !== HANDLE) throw new Error(`product ${PRODUCT_ID} handle is ${p.handle}`);
  const live = (await getMetafields('products', PRODUCT_ID)).find((m) => m.namespace === 'global' && m.key === 'title_tag')?.value ?? null;
  const state = decide(live);
  console.log(`title_tag: ${state}\n  live:  ${live}\n  after: ${TITLE_TAG.after}`);
  if (state === 'refuse') throw new Error('live value matches neither BEFORE nor AFTER; not overwriting');
  if (!apply || state !== 'apply') { if (!apply) console.log('\nDry run. Re-run with --apply to write.'); return; }
  const dir = join(ROOT, 'data/reports/product-title-fixes', new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${HANDLE}.before.json`), JSON.stringify({ product_id: PRODUCT_ID, title_tag: live }, null, 2));
  await upsertMetafield('products', PRODUCT_ID, 'global', 'title_tag', TITLE_TAG.after);
  console.log(`\nWritten. Backup: ${dir}`);
}

if (isDirectRun(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
