#!/usr/bin/env node
/**
 * Fetch all reviews for the four lander-relevant products and dump the
 * full corpus to /tmp so we can hand-pick the best 4 testimonials.
 *
 * Products:
 *   coconut-lotion              (Body Lotion — Pure Unscented variant)
 *   coconut-moisturizer         (Body Cream — Pure Unscented variant)
 *   sensitive-skin-starter-set  (the bundle itself)
 *   skincare-starter-set        (legacy bundle — also relevant)
 */

import 'dotenv/config';
import { writeFileSync } from 'fs';
import { resolveExternalId, fetchProductReviews } from '../lib/judgeme.js';

const HANDLES = [
  'coconut-lotion',
  'coconut-moisturizer',
  'sensitive-skin-starter-set',
  'skincare-starter-set',
];

const SHOP   = process.env.SHOPIFY_STORE;
const TOKEN  = process.env.JUDGEME_API_TOKEN;
if (!SHOP || !TOKEN) {
  console.error('Missing SHOPIFY_STORE or JUDGEME_API_TOKEN');
  process.exit(1);
}

const all = [];
for (const handle of HANDLES) {
  const ext = await resolveExternalId(handle, SHOP, TOKEN);
  if (!ext) {
    console.log(`${handle}: no external_id (no reviews / not found)`);
    continue;
  }
  const reviews = await fetchProductReviews(ext, SHOP, TOKEN);
  console.log(`${handle}: ${reviews.length} reviews`);
  for (const r of reviews) {
    all.push({
      handle,
      rating: r.rating,
      title: r.title || '',
      body: (r.body || '').replace(/\s+/g, ' ').trim(),
      reviewer: r.reviewer?.name || 'Anonymous',
      verified: r.reviewer?.verified_buyer === true,
      created_at: r.created_at,
      pictures: (r.pictures || []).map(p => p.urls?.original || p.urls?.huge).filter(Boolean),
      product_variant: r.product_title || '',
    });
  }
}

writeFileSync('/tmp/lander-reviews.json', JSON.stringify(all, null, 2));
console.log(`\nTotal: ${all.length} reviews → /tmp/lander-reviews.json`);
console.log(`5-star: ${all.filter(r => r.rating >= 5).length}`);
console.log(`with photos: ${all.filter(r => r.pictures.length > 0).length}`);
