#!/usr/bin/env node
/**
 * Cream PDP: swap the buy box for the 1 / 5 quantity ladder ("buy 4, get 1
 * free"). Cream AND lotion PDPs: remove the Recurpay subscription widget, so no
 * new subscriptions start. Sean, 2026-10-05: RSC moved from subscriptions to
 * multi-unit purchases; "current subscribers stay".
 *
 *   node scripts/convert-cream-lotion-off-subscriptions-2026-10-05.mjs           # dry
 *   node scripts/convert-cream-lotion-off-subscriptions-2026-10-05.mjs --apply   # writes live
 *
 * WHY EXISTING SUBSCRIBERS ARE UNAFFECTED. Only the PDP widget is removed. The
 * Recurpay selling plans stay attached to coconut-lotion and coconut-moisturizer
 * (requires_selling_plan is false, so the products still sell one-time), and
 * a subscription contract renews from the contract, not from the page.
 *
 * WHY THE LOTION GETS NO LADDER YET. Its 5-pack ships as a draft: 11 + 8
 * bottles of the two allowed scents on 2026-10-05 (see the roster story).
 * build-quantity-ladder.mjs refuses a draft tier, which is the guard working.
 *
 * Same mechanics and safety as convert-liquid-soap-to-ladder-2026-09-05.mjs,
 * whose pure convert() this reuses: round-trip proven before any edit, live
 * read fresh, backup + read-back by update-theme-asset.mjs put.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { serialize } from './build-product-templates.mjs';
import { convert } from './convert-liquid-soap-to-ladder-2026-09-05.mjs';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const PAGES = [
  { key: 'templates/product.landing-page-cream.json', ladder: join(ROOT, 'data', 'ladder-coconut-moisturizer.liquid') },
  { key: 'templates/product.landing-page-lotion.json', ladder: null },
];

/** Pure: drop every Recurpay app block from main. Returns the removed ids. */
export function dropSubscriptionWidget(parsed) {
  const main = parsed.sections?.main;
  if (!main) throw new Error('no main section');
  const ids = Object.entries(main.blocks).filter(([, b]) => /recurpay/i.test(b.type ?? '')).map(([id]) => id);
  for (const id of ids) {
    main.block_order = main.block_order.filter((b) => b !== id);
    delete main.blocks[id];
  }
  return ids;
}

/** Pure: the page must still be able to sell something. */
export function assertBuyable(parsed) {
  const order = parsed.sections.main.block_order;
  if (!order.includes('quantity-ladder') && !order.includes('buy_buttons')) {
    throw new Error('page would have neither a ladder nor a buy button');
  }
}

if (isDirectRun(import.meta.url)) {
  const APPLY = process.argv.includes('--apply');
  for (const { key, ladder } of PAGES) {
    const name = key.split('.').at(-2);
    const tmp = join(ROOT, 'data', `${name}-template.live.json`);
    const out = join(ROOT, 'data', `${name}-template.next.json`);
    execFileSync('node', [join(ROOT, 'scripts', 'update-theme-asset.mjs'), 'get', key, tmp], { stdio: 'inherit' });
    const live = readFileSync(tmp, 'utf8');
    if (serialize(JSON.parse(live)) !== live) { console.error(`${key}: ROUND-TRIP MISMATCH, refusing`); process.exit(1); }

    const parsed = JSON.parse(live);
    const notes = ladder ? convert(parsed, readFileSync(ladder, 'utf8')) : [];
    const dropped = dropSubscriptionWidget(parsed);
    assertBuyable(parsed);
    const next = serialize(parsed);
    writeFileSync(out, next);

    console.log(`\n== ${key}\n${[...notes, ...dropped.map((id) => `removed ${id}`)].join('\n') || 'already done'}`);
    console.log(`block_order: ${parsed.sections.main.block_order.join(', ')}`);
    execFileSync('node', [join(ROOT, 'scripts', 'update-theme-asset.mjs'), 'put', key, out, ...(APPLY ? ['--apply'] : [])], { stdio: 'inherit' });
    if (APPLY) writeFileSync(join(ROOT, 'theme', key), next);
  }
  console.log(APPLY ? '\nAPPLIED' : '\nDRY RUN — pass --apply to write');
}
