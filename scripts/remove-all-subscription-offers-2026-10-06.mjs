#!/usr/bin/env node
/**
 * Stop selling new subscriptions on every product page (Sean, 2026-10-06:
 * "Remove all of the subscriptions for now"). Existing contracts keep renewing:
 * the Recurpay selling plans stay attached, exactly as on lotion and cream.
 *
 *   node scripts/remove-all-subscription-offers-2026-10-06.mjs           # dry
 *   node scripts/remove-all-subscription-offers-2026-10-06.mjs --apply   # writes live
 *
 * Seven products still carried a plan on 2026-10-06 (storefront .js
 * selling_plan_groups): coconut-lotion, coconut-moisturizer (done in #1019),
 * coconut-bar-soap-4-pack, coconut-deodorant-4-pack, coconut-toothpaste-3-pack,
 * foam-soap-refill-32oz and sensitive-skin-starter-set.
 *
 * This script does the steps build-product-templates.mjs will not: it takes the
 * Recurpay app block out of block_order, and inserts the `no-subscription`
 * block (the builder only MAINTAINS a shared block that already exists). The
 * Recurpay app EMBED injects a widget with subscribe pre-selected on any
 * product with a plan, block or no block, so every template that can serve
 * such a product needs it, including product.json and product.scoped-gallery
 * .json, which serve the bare pack-tier pages that flow emails link to.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { serialize } from './build-product-templates.mjs';
import { dropSubscriptionWidget, assertBuyable } from './convert-cream-lotion-off-subscriptions-2026-10-05.mjs';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MANAGED = ['toothpaste', 'deodorant', 'bar-soap', 'liquid-soap', 'sensitive-skin-set-lander']
  .map((n) => `templates/product.landing-page-${n}.json`);
export const UNMANAGED = ['templates/product.json', 'templates/product.scoped-gallery.json'];
export const NO_SUB_ID = 'no-subscription';

/** Which block `no-subscription` sits under: the guarantee line on ladder pages, else the buy button. */
export function anchorFor(parsed) {
  const order = parsed.sections?.main?.block_order ?? [];
  return order.includes('quantity-ladder') && order.includes('trust-line') ? 'trust-line' : 'buy_buttons';
}

/** Pure: put the no-subscription block directly after its anchor. Idempotent. */
export function insertNoSubscription(parsed, liquid, anchor = anchorFor(parsed)) {
  const main = parsed.sections?.main;
  if (!main) throw new Error('no main section');
  if (main.block_order.includes(NO_SUB_ID)) return false;
  const at = main.block_order.indexOf(anchor);
  if (at < 0) throw new Error(`no ${anchor} to anchor on`);
  main.blocks[NO_SUB_ID] = { type: 'custom_liquid', settings: { custom_liquid: liquid } };
  main.block_order.splice(at + 1, 0, NO_SUB_ID);
  return true;
}

if (isDirectRun(import.meta.url)) {
  const APPLY = process.argv.includes('--apply');
  const liquid = readFileSync(join(ROOT, 'theme', 'blocks', 'no-subscription.liquid'), 'utf8');
  for (const key of [...MANAGED, ...UNMANAGED]) {
    const name = key.split('/').at(-1).replace(/\.json$/, '');
    const tmp = join(ROOT, 'data', `${name}.live.json`);
    const out = join(ROOT, 'data', `${name}.next.json`);
    execFileSync('node', [join(ROOT, 'scripts', 'update-theme-asset.mjs'), 'get', key, tmp], { stdio: 'ignore' });
    const live = readFileSync(tmp, 'utf8');
    if (serialize(JSON.parse(live)) !== live) { console.error(`${key}: ROUND-TRIP MISMATCH, refusing`); process.exit(1); }
    const parsed = JSON.parse(live);
    const dropped = dropSubscriptionWidget(parsed);
    const inserted = insertNoSubscription(parsed, liquid);
    assertBuyable(parsed);
    const next = serialize(parsed);
    console.log(`\n== ${key}: ${dropped.length ? `removed ${dropped.join(', ')}` : 'no Recurpay block'}${inserted ? `; inserted ${NO_SUB_ID}` : ''}`);
    if (next === live) continue;
    writeFileSync(out, next);
    execFileSync('node', [join(ROOT, 'scripts', 'update-theme-asset.mjs'), 'put', key, out, ...(APPLY ? ['--apply'] : [])], { stdio: 'inherit' });
    if (APPLY && MANAGED.includes(key)) writeFileSync(join(ROOT, 'theme', key), next);
  }
  console.log(APPLY ? '\nAPPLIED — now run build-product-templates.mjs --apply for the managed pages' : '\nDRY RUN — pass --apply to write');
}
