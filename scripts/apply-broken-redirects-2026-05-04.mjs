#!/usr/bin/env node
/**
 * One-off: apply the curated set of redirects from the 2026-05-04 audit.
 *
 * Safe set only — chain-loop / topic-mismatch cases are intentionally
 * excluded and surfaced separately for explicit decision.
 *
 * Usage:
 *   node scripts/apply-broken-redirects-2026-05-04.mjs           # dry-run
 *   node scripts/apply-broken-redirects-2026-05-04.mjs --apply   # create redirects
 */

import { getRedirects, createRedirect } from '../lib/shopify.js';

const APPLY = process.argv.includes('--apply');

const REDIRECTS = [
  // User-confirmed product/collection overrides
  ['/products/cinnamon-toothpaste',           '/products/coconut-oil-toothpaste'],
  ['/products/natural-coconut-oil-deodorant', '/products/coconut-oil-deodorant'],
  ['/collections/body-lotion',                '/collections/coconut-oil-lotion'],

  // Clean blog-slug matches from dry-run (same topic, suffix or rename variants)
  ['/blogs/news/charcoal-toothpaste-does-it-work-is-it-safe',
   '/blogs/news/charcoal-toothpaste-does-it-work-is-it-safe-2'],
  ['/blogs/news/what-is-castile-soap-uses-benefits-ingredients-1',
   '/blogs/news/what-is-castile-soap-uses-benefits-ingredients-2'],
  ['/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing-1',
   '/blogs/news/best-soap-for-tattoos-what-to-use-for-safe-healing-2'],
  ['/blogs/news/organic-body-lotion-what-it-is-how-to-choose',
   '/blogs/news/organic-body-lotion-what-it-is-how-to-choose-1'],
  ['/blogs/news/can-coconut-oil-replace-toothpaste-discover-the-benefits-of-this-natural-alternative',
   '/blogs/news/can-coconut-oil-replace-toothpaste-the-honest-answer'],
  ['/blogs/news/benefits-of-coconut-oil-on-skin-everyday-full-guide',
   '/blogs/news/benefits-of-coconut-oil-on-skin-everyday-full-guide-1'],
  ['/blogs/news/dry-brushing-real-benefits-technique-what-to-expect',
   '/blogs/news/dry-brushing-skin-benefits-technique-what-to-expect-1'],
  ['/blogs/news/organic-coconut-oil-types-uses-benefits-for-skin',
   '/blogs/news/organic-coconut-oil-types-uses-benefits-for-skin-2'],
  ['/blogs/news/sulfate-free-toothpaste-why-it-matters-best-options',
   '/blogs/news/sls-free-toothpaste-list-best-natural-options-2026'],
  ['/blogs/news/why-adding-organic-lip-balms-to-your-skincare-routine-makes-a-difference',
   '/blogs/news/why-add-organic-lip-balms-to-your-skin-care-routine'],
  ['/blogs/news/getting-silky-smooth-lips-with-coconut-oil-lip-balm',
   '/blogs/news/get-silky-smooth-lips-with-coconut-oil-lip-balm'],
  ['/blogs/news/sls-free-toothpaste-list-best-options-for-2026',
   '/blogs/news/sls-free-toothpaste-list-best-natural-options-2026'],
  ['/blogs/news/how-to-make-a-natural-moisturizer-at-home-easy-recipes',
   '/blogs/news/how-to-make-a-natural-moisturizer-at-home-easy-recipes-1'],
];

async function main() {
  console.log(`\nApply broken-page redirects (${APPLY ? 'APPLY' : 'DRY-RUN'})\n`);

  const existing = await getRedirects();
  const existingPaths = new Set(existing.map((r) => r.path));

  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const [from, to] of REDIRECTS) {
    if (existingPaths.has(from)) {
      console.log(`  [SKIP exists]  ${from}`);
      skipped++;
      continue;
    }
    console.log(`  ${APPLY ? '[CREATE]' : '[DRY-RUN]'}     ${from} → ${to}`);
    if (!APPLY) { created++; continue; }
    try {
      await createRedirect(from, to);
      created++;
    } catch (e) {
      console.log(`    ERROR: ${e.message}`);
      errors++;
    }
  }

  console.log(`\n  ${APPLY ? 'Created' : 'Would create'}: ${created}, skipped (already exist): ${skipped}, errors: ${errors}`);
}

main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
