#!/usr/bin/env node
/**
 * One-off batch 2: targets selected via blog-index token-overlap scoring,
 * each HEAD-verified live, plus repair of yesterday's orphan redirect whose
 * target has since 404'd.
 *
 * Usage:
 *   node scripts/apply-broken-redirects-2026-05-04-batch2.mjs           # dry-run
 *   node scripts/apply-broken-redirects-2026-05-04-batch2.mjs --apply   # delete orphan + create
 */

import { getRedirects, createRedirect, deleteRedirect } from '../lib/shopify.js';

const APPLY = process.argv.includes('--apply');

// Source URL → live target. All targets HEAD-verified 200 and confirmed
// to have no incoming redirect (no chain conflict).
const REDIRECTS = [
  // Bar-soap chain loops (3 sources → 1 gender-neutral live post)
  ['/blogs/news/best-natural-bar-soap-for-women-clean-picks-that-work',
   '/blogs/news/natural-soap-bar-the-clean-skin-guide-you-need'],
  ['/blogs/news/best-natural-bar-soap-for-women-clean-picks-that-work-1',
   '/blogs/news/natural-soap-bar-the-clean-skin-guide-you-need'],

  // Clean body-lotion chain loop
  ['/blogs/news/clean-body-lotion-what-to-look-for-best-picks-1',
   '/blogs/news/best-clean-body-lotion-2025'],

  // Wrong topic — toothpaste source matched to deodorant target by old matcher
  ['/blogs/news/can-you-use-coconut-oil-as-toothpaste-what-to-know',
   '/blogs/news/can-you-use-coconut-oil-as-toothpaste'],

  // Topic drift — unscented preserved by routing to fragrance-free post
  ['/blogs/news/best-unscented-lotion-clean-fragrance-free-picks',
   '/blogs/news/best-fragrance-free-body-lotion-2025'],

  // Topic drift — natural-without-chemicals → natural body lotion
  ['/blogs/news/natural-body-lotion-without-chemicals-what-to-look-for',
   '/blogs/news/best-natural-body-lotion-2025'],

  // Product fallbacks (sitemap-confirmed canonical product URLs)
  ['/products/coconut-body-lotion',     '/products/coconut-lotion'],
  ['/products/coconut-body-cream',      '/products/coconut-moisturizer'],
  ['/products/coconut-oil-lip-balm-tube', '/products/coconut-oil-lip-balm'],
  ['/products/natural-deodorant',       '/products/coconut-oil-deodorant'],

  // Repair yesterday's orphan: the redirect we created points to a URL that
  // has since 404'd. Re-point to the live coconut-oil-as-toothpaste post.
  ['/blogs/news/can-coconut-oil-replace-toothpaste-discover-the-benefits-of-this-natural-alternative',
   '/blogs/news/can-you-use-coconut-oil-as-toothpaste'],
];

async function main() {
  console.log(`\nBatch 2 broken-page redirects (${APPLY ? 'APPLY' : 'DRY-RUN'})\n`);

  const existing = await getRedirects();
  const byPath = new Map(existing.map((r) => [r.path, r]));

  let deleted = 0;
  let created = 0;
  let errors = 0;

  for (const [from, to] of REDIRECTS) {
    const existingForPath = byPath.get(from);
    if (existingForPath) {
      console.log(`  ${APPLY ? '[REPLACE]' : '[DRY-RUN REPLACE]'} ${from}`);
      console.log(`              old: ${existingForPath.target}`);
      console.log(`              new: ${to}`);
      if (APPLY) {
        try { await deleteRedirect(existingForPath.id); deleted++; }
        catch (e) { console.log(`    ERROR deleting: ${e.message}`); errors++; continue; }
      }
    } else {
      console.log(`  ${APPLY ? '[CREATE]' : '[DRY-RUN]'}   ${from} → ${to}`);
    }
    if (!APPLY) { created++; continue; }
    try { await createRedirect(from, to); created++; }
    catch (e) { console.log(`    ERROR creating: ${e.message}`); errors++; }
  }

  console.log(`\n  ${APPLY ? 'Created' : 'Would create'}: ${created}, ${APPLY ? 'replaced (deleted old)' : 'would replace'}: ${deleted}, errors: ${errors}`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
