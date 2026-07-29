#!/usr/bin/env node
/**
 * Give every bundle the review rating its own components have earned.
 *
 *   node scripts/sync-bundle-ratings.mjs [--apply]
 *
 * A multipack or kit almost never carries reviews of its own — buyers review the
 * lotion, not the box the lotion came in. Aggregating the component SKUs' reviews
 * onto the bundle is legitimate and is already how the 90-Day Coconut Reset shows
 * 131 reviews. This script makes that the rule rather than a one-off, and writes
 * the numbers as product metafields so the storefront renders a real figure
 * instead of a constant typed into a theme setting.
 *
 * Writes two metafields per bundle, read by sections/hero-landing-section.liquid:
 *   bundle.rating_value (number_decimal)  — review-weighted mean of its components
 *   bundle.rating_count (number_integer)  — how many reviews stand behind it
 *
 * The hero renders stars ONLY when rating_count > 0, and captions them
 * "<value> from <count> reviews of the products inside" — the disclosure is what
 * keeps the aggregation honest, so it is composed in Liquid and cannot drift out
 * of sync with the numbers.
 *
 * Weighted, not a mean of means: a component with 97 reviews should move the
 * bundle's rating far more than one with 8.
 *
 * Re-run whenever reviews accumulate. Idempotent.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { fetchAllReviewStats } from '../lib/judgeme.js';
import { getProducts, upsertMetafield } from '../lib/shopify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');

// Judge.me keys reviews by the myshopify domain, not the storefront domain. Passing
// the storefront domain returns 401, and fetchAllReviewStats turns a non-ok response
// into an empty result — a silent "0 reviews" that looks like real data.
const SHOP_DOMAIN = process.env.JUDGEME_SHOP_DOMAIN || 'realskincare-com.myshopify.com';

async function main() {
  const token = process.env.JUDGEME_API_TOKEN;
  if (!token) throw new Error('JUDGEME_API_TOKEN is not set.');

  const stats = await fetchAllReviewStats(SHOP_DOMAIN, token);
  if (stats.total === 0) {
    throw new Error(
      `Judge.me returned 0 reviews for shop_domain "${SHOP_DOMAIN}". That is almost ` +
      `certainly an auth or domain error rather than an empty store — refusing to ` +
      `write zeroes over real ratings.`
    );
  }
  console.log(`Judge.me: ${stats.total} reviews across ${stats.byHandle.size} products (shop avg ${stats.avgRating.toFixed(2)}).\n`);

  const roster = JSON.parse(readFileSync(join(ROOT, 'config', 'bundles.json'), 'utf8'));
  const products = await getProducts({ limit: 250 });
  const idByHandle = new Map(products.map((p) => [p.handle, p.id]));

  let wrote = 0;
  for (const bundle of roster.bundles) {
    const componentHandles = new Set();
    for (const variant of bundle.variants) {
      for (const c of variant.components || []) componentHandles.add(c.product);
    }

    let count = 0;
    let ratingSum = 0;
    const unreviewed = [];
    for (const handle of componentHandles) {
      const s = stats.byHandle.get(handle);
      if (!s) { unreviewed.push(handle); continue; }
      count += s.count;
      ratingSum += s.ratingSum;
    }

    const productId = idByHandle.get(bundle.handle);
    const label = bundle.handle.padEnd(27);

    if (!productId) { console.log(`${label} SKIP — not live on Shopify`); continue; }
    if (count === 0) {
      console.log(`${label} SKIP — no reviews on any component (${[...componentHandles].join(', ')})`);
      continue;
    }

    const value = (ratingSum / count).toFixed(2);
    const note = unreviewed.length ? `  (no reviews yet: ${unreviewed.join(', ')})` : '';
    console.log(`${label} ${value} from ${String(count).padStart(3)} reviews${note}`);

    if (APPLY) {
      await upsertMetafield('products', productId, 'bundle', 'rating_value', value, 'number_decimal');
      await upsertMetafield('products', productId, 'bundle', 'rating_count', String(count), 'number_integer');
      wrote++;
    }
  }

  console.log(APPLY
    ? `\nApplied to ${wrote} bundle(s). Fetch a rendered page to confirm — the Admin API cannot tell you what the storefront shows.`
    : `\nDry run. Re-run with --apply to write.`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
