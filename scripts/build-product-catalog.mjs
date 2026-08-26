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
  'coconut-bar-soap-12-pack',
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
    // Store the display string, not just the number. Interpolating the raw value rendered
    // "$46.8" for the $46.80 set — cents are not optional in a price.
    const label = Number.isInteger(prices[0]) ? `$${prices[0]}` : `$${prices[0].toFixed(2)}`;

    // The SAVING, captured for the same reason the price is: agents/ad-studio's claim gate
    // (claims.js) searches a stringified catalog entry, so a bundle's "save $44" or "$132
    // value" was unsourceable and an ad could not state it at all — while the number sat one
    // field away on the same Shopify response. Taken from the variant that supplies `price`,
    // never the highest or an average: quoting a compare-at from a different variant than the
    // price is how a $132 anchor ends up beside an $88 that never had one.
    //
    // ABSENT rather than null when there is nothing to say. Most RSC products carry no
    // compare-at at all, and a `compareAtPrice: null` in the stringified entry would put the
    // word "compareAtPrice" into the searchable text of an entry that has no saving — which
    // is exactly the kind of near-miss substring the gate should not be handed.
    const priced = p.variants.find((v) => Number(v.price) === prices[0]);
    const compareAt = Number(priced?.compare_at_price ?? 0);
    const hasSaving = compareAt > prices[0];
    const fmt = (n) => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

    catalog[handle] = {
      title: p.title,
      // Emails quote a single figure. Where variants differ, the lowest is the honest one
      // to quote — but flag it so nobody writes "just $X" about a range.
      price: prices[0],
      priceLabel: label,
      priceVaries: prices.length > 1,
      ...(hasSaving
        ? {
            compareAtPrice: compareAt,
            compareAtLabel: fmt(compareAt),
            savings: Number((compareAt - prices[0]).toFixed(2)),
            savingsLabel: fmt(Number((compareAt - prices[0]).toFixed(2))),
          }
        : {}),
      defaultVariantId: String(p.variants[0].id),
      url: `https://www.realskincare.com/products/${handle}`,
    };
    console.log(`${handle.padEnd(28)} $${prices[0]}${hasSaving ? ` (was ${fmt(compareAt)}, save ${fmt(compareAt - prices[0])})` : ''}${prices.length > 1 ? ` (varies, ${prices.length} prices)` : ''}  variant ${p.variants[0].id}`);
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
