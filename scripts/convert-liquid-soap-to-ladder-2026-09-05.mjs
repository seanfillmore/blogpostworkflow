#!/usr/bin/env node
/**
 * Swap the liquid soap PDP's buy box for the quantity ladder — the same
 * conversion the bar soap, deodorant and toothpaste templates already had.
 *
 *   node scripts/convert-liquid-soap-to-ladder-2026-09-05.mjs           # dry
 *   node scripts/convert-liquid-soap-to-ladder-2026-09-05.mjs --apply   # writes live
 *
 * WHY THIS IS A SCRIPT AND NOT A MANIFEST ENTRY. `build-product-templates.mjs`
 * deliberately REFUSES to drop a block that is still in `block_order` ("refusing
 * to drop X — it IS in block_order"), because a block in block_order is live
 * markup and only an orphan is dead weight. So the one-way step — taking the
 * stock buy box out of block_order and putting the ladder in — cannot be
 * expressed there, and was done by hand for the other three ladder pages. This
 * writes it down instead.
 *
 * Once this has run, MANIFEST's liquid-soap entry is the ladder shape and
 * `build-product-templates.mjs` maintains the page from then on: its `drop` list
 * clears the four now-orphaned definitions, and `insertAfter` keeps trust-line
 * below the ladder.
 *
 * ORDERING. The ladder goes directly after `discount-callout`, which is where
 * all three sibling ladder pages carry it.
 *
 * SAFETY. Live is the source of truth and is read fresh; the serializer is
 * proven to round-trip THIS file byte-for-byte before any edit (Shopify's editor
 * escapes `/` inside strings, and a serializer that does not would rewrite all
 * ~600 lines and make the pre-apply diff useless — see
 * reference_theme_json_template_escaping). `update-theme-asset.mjs put` writes
 * the live copy to theme/backup/ before overwriting, and the write is read back
 * and compared.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { serialize } from './build-product-templates.mjs';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'templates/product.landing-page-liquid-soap.json';
const LADDER_SRC = join(ROOT, 'data', 'ladder-organic-foaming-hand-soap.liquid');

/** The stock buy box the ladder replaces. Same four as the sibling pages. */
export const REPLACED = ['variant_picker', 'vqr-combo', 'buy_buttons', 'sticky_cart'];
export const LADDER_ID = 'quantity-ladder';
export const ANCHOR = 'discount-callout';
/** The 30-day guarantee line. Must sit directly under the buy CTA. */
export const GUARANTEE_ID = 'trust-line';

/**
 * Pure: apply the conversion to a parsed template. Returns notes; throws rather
 * than producing a page with neither a buy box nor a ladder.
 */
export function convert(parsed, ladderLiquid) {
  const main = parsed.sections?.main;
  if (!main) throw new Error('no main section');
  const notes = [];

  const at = main.block_order.indexOf(ANCHOR);
  if (at < 0) throw new Error(`anchor "${ANCHOR}" is not in block_order — refusing to guess a position`);

  // Insert BEFORE removing, so a throw above can never leave the page with no
  // way to buy anything.
  if (!main.block_order.includes(LADDER_ID)) {
    main.blocks[LADDER_ID] = { type: 'custom_liquid', settings: { custom_liquid: ladderLiquid } };
    main.block_order.splice(at + 1, 0, LADDER_ID);
    notes.push(`inserted ${LADDER_ID} after ${ANCHOR}`);
  }

  for (const id of REPLACED) {
    if (!main.block_order.includes(id)) continue;
    main.block_order = main.block_order.filter((b) => b !== id);
    delete main.blocks[id];
    notes.push(`removed ${id}`);
  }

  // The guarantee goes DIRECTLY under the buy CTA, which on a ladder page is the
  // ladder — the invariant tests/scripts/build-product-templates.test.js
  // enforces across every page that has a trust-line, and which the three
  // sibling ladder pages already satisfy. Leaving `recurpay-widget` in between
  // (where it sat under the old buy box) puts a widget that renders NOTHING on
  // this page — nothing here is subscribable — between the CTA and the promise
  // that de-risks it. Moved rather than left alone: "minimal diff" is not a
  // reason to ship a page whose guarantee floats away from its button.
  if (main.block_order.includes(GUARANTEE_ID)) {
    const want = main.block_order.indexOf(LADDER_ID) + 1;
    const have = main.block_order.indexOf(GUARANTEE_ID);
    if (have !== want) {
      main.block_order.splice(have, 1);
      main.block_order.splice(main.block_order.indexOf(LADDER_ID) + 1, 0, GUARANTEE_ID);
      notes.push(`moved ${GUARANTEE_ID} directly under ${LADDER_ID}`);
    }
  }

  if (!main.block_order.includes(LADDER_ID)) throw new Error('ladder is not in block_order after conversion');
  return notes.length ? notes : ['already converted'];
}

if (isDirectRun(import.meta.url)) {
  const APPLY = process.argv.includes('--apply');
  const tmp = join(ROOT, 'data', 'liquid-soap-template.live.json');
  const out = join(ROOT, 'data', 'liquid-soap-template.next.json');

  execFileSync('node', [join(ROOT, 'scripts', 'update-theme-asset.mjs'), 'get', KEY, tmp], { stdio: 'inherit' });
  const live = readFileSync(tmp, 'utf8');

  if (serialize(JSON.parse(live)) !== live) {
    console.error('ROUND-TRIP MISMATCH — refusing to rewrite this file');
    process.exit(1);
  }

  const parsed = JSON.parse(live);
  const notes = convert(parsed, readFileSync(LADDER_SRC, 'utf8'));
  const next = serialize(parsed);
  writeFileSync(out, next);

  console.log(`\n${notes.join('\n')}`);
  console.log(`block_order: ${parsed.sections.main.block_order.join(', ')}`);
  console.log(`${live.split('\n').length} -> ${next.split('\n').length} lines\n`);

  execFileSync('node', [join(ROOT, 'scripts', 'update-theme-asset.mjs'), 'put', KEY, out, ...(APPLY ? ['--apply'] : [])],
    { stdio: 'inherit' });

  if (APPLY) writeFileSync(join(ROOT, 'theme', KEY), next);
  console.log(APPLY ? '\nAPPLIED' : '\nDRY RUN — pass --apply to write');
}
