/**
 * Phase 0 Task 4 — create the "$99 90-Day Coconut Reset" bundle as a DRAFT.
 *
 * The bundle is the CFA scaling engine: ~$47 contribution → ~$50 30-day gross
 * profit → ~2x a $25 CAC (Hormozi's infinite-scaling threshold). Created as a
 * DRAFT per dev rules — Sean adds images, verifies, and publishes.
 *
 * Idempotent: does nothing if a product with this title already exists.
 * Default is a DRY-RUN (prints intent). Pass --apply to actually create.
 *
 *   node scripts/create-coconut-reset-bundle.mjs            # dry-run
 *   node scripts/create-coconut-reset-bundle.mjs --apply    # create draft
 */
import { getProducts, createProduct } from '../lib/shopify.js';

const TITLE = '90-Day Coconut Reset';
const APPLY = process.argv.includes('--apply');

const fields = {
  title: TITLE,
  body_html:
    '<p>90 days of calm, non-reactive skin. Three of our 6-ingredient Body Lotions ' +
    '+ our overnight Coconut Moisturizer. Free Bar Soap + Lip Balm included.</p>',
  vendor: 'Real Skin Care',
  status: 'draft',
  tags: 'bundle,skin,acquisition-offer',
  variants: [{ price: '99.00', sku: 'RSC-BUN-90RESET' }],
};

const existing = (await getProducts()).find((p) => p.title === TITLE);
if (existing) {
  console.log(`Bundle already exists (id ${existing.id}, status ${existing.status}) — no action.`);
  process.exit(0);
}

if (!APPLY) {
  console.log('DRY-RUN — would create DRAFT product:');
  console.log(JSON.stringify(fields, null, 2));
  console.log('\nPass --apply to create. It is created as a draft; Sean adds images + publishes.');
  process.exit(0);
}

const product = await createProduct(fields);
console.log(`Created DRAFT bundle: id ${product.id}, price $${product.variants[0].price}, status ${product.status}`);
console.log('Next: assign images, verify, then Sean publishes.');
