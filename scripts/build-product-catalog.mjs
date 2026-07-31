#!/usr/bin/env node
/**
 * Generate data/brand/product-catalog.json from the live Shopify storefront.
 *
 *   node scripts/build-product-catalog.mjs
 *
 * Prices and variant IDs are facts, not things to type from memory. A lip balm price of
 * $8 was invented in a rebuild and reached a live email; the real price is $15. Variant
 * IDs are worse — a wrong one silently adds the wrong product to a customer's cart.
 *
 * Emails interpolate from this file, so a price change on the storefront is one
 * regeneration rather than a hunt through copy.
 */

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const HANDLES = [
  'coconut-oil-deodorant',
  'coconut-oil-toothpaste',
  'coconut-oil-lip-balm',
  'coconut-lotion',
  'coconut-soap',
  'coconut-moisturizer',
  'organic-foaming-hand-soap',
  'sensitive-skin-starter-set',
];

const catalog = {};
let failed = 0;

for (const handle of HANDLES) {
  try {
    const res = await fetch(`https://www.realskincare.com/products/${handle}.json`, {
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const p = (await res.json()).product;

    const prices = [...new Set(p.variants.map((v) => Number(v.price)))].sort((a, b) => a - b);
    catalog[handle] = {
      title: p.title,
      // Emails quote a single figure. Where variants differ, the lowest is the honest one
      // to quote — but flag it so nobody writes "just $X" about a range.
      price: prices[0],
      priceVaries: prices.length > 1,
      defaultVariantId: String(p.variants[0].id),
      url: `https://www.realskincare.com/products/${handle}`,
    };
    console.log(`${handle.padEnd(28)} $${prices[0]}${prices.length > 1 ? ` (varies, ${prices.length} prices)` : ''}  variant ${p.variants[0].id}`);
  } catch (e) {
    console.error(`${handle.padEnd(28)} ✗ ${e.message}`);
    failed++;
  }
}

if (failed) {
  console.error(`\n${failed} product(s) failed — catalog NOT written, to avoid writing a partial one`);
  process.exit(1);
}

writeFileSync(
  join(ROOT, 'data/brand/product-catalog.json'),
  `${JSON.stringify({ generated: 'run scripts/build-product-catalog.mjs to refresh', products: catalog }, null, 2)}\n`,
);
console.log(`\n${Object.keys(catalog).length} products written to data/brand/product-catalog.json`);
