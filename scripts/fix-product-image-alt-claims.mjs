#!/usr/bin/env node
/**
 * Strip health claims from product image ALT TEXT. Dry by default; --apply writes.
 *
 * Found while verifying the theme-copy rewrite, on a surface nothing in the fleet
 * screens. Every product image alt across the live catalogue was run through
 * lib/seo-copy-health-gate.js: **191 images with alt text, 5 blocking-tier, all
 * five on `coconut-moisturizer`**, each reading
 *
 *     "body cream all-natural organic coconut oil jojoba oil natural healing eczema <scent>"
 *
 * which trips BOTH `disease` ("eczema") and `therapeutic` ("healing") — a cosmetic
 * asserting it heals a named condition. Alt text is rendered into the page markup
 * dozens of times per view, is read by search engines and screen readers, and sits
 * on a page with an Add-to-Cart button, so it is marketing copy in every sense that
 * matters to the intended-use question. The other 186 alts in the catalogue are clean.
 *
 * The repair is a REMOVAL, not a rewrite: the claim phrase comes out and the
 * descriptive, genuinely useful remainder (product type, ingredients, scent) stays,
 * so nothing of SEO or accessibility value is lost. Each new value is re-gated
 * before it is written, and an alt that matches neither the expected BEFORE nor the
 * AFTER is skipped rather than overwritten.
 *
 * This only ever calls updateProductImage to change `alt`. It never deletes an
 * image — DELETE on a product image destroys the underlying CDN file, which has
 * already cost this project three unrecoverable photographs.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getProducts, updateProductImage } from '../lib/shopify.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';

const APPLY = process.argv.includes('--apply');
const CLAIM = /\s*natural healing eczema\s*/i;

async function main() {
  const products = await getProducts({ limit: 250 });
  const planned = [];

  for (const p of products) {
    for (const im of p.images || []) {
      const alt = (im.alt || '').trim();
      if (!alt) continue;
      const before = checkSeoCopyFields({ alt });
      if (before.ok) continue;

      const after = alt.replace(CLAIM, ' ').replace(/\s+/g, ' ').trim();
      if (after === alt) {
        console.error(`  ${p.handle} image ${im.id}: FLAGGED but no known claim phrase matched — left alone.`);
        console.error(`    "${alt}"`);
        planned.push({ handle: p.handle, image_id: im.id, outcome: 'unmatched', alt });
        continue;
      }
      const recheck = checkSeoCopyFields({ alt: after });
      if (!recheck.ok) {
        console.error(`  ${p.handle} image ${im.id}: replacement STILL trips the gate — left alone.`);
        for (const v of recheck.blocking) console.error(`    [${v.category}] "${v.match}"`);
        planned.push({ handle: p.handle, image_id: im.id, outcome: 'still-flagged', alt });
        continue;
      }
      planned.push({
        handle: p.handle,
        product_id: p.id,
        image_id: im.id,
        before: alt,
        after,
        tripped: (before.blocking || []).map((v) => `${v.category}:${v.match}`),
        outcome: 'planned',
      });
    }
  }

  const doable = planned.filter((r) => r.outcome === 'planned');
  console.log(`Product images with alt text scanned. ${planned.length} flagged, ${doable.length} repairable.\n`);
  for (const r of doable) {
    console.log(`  ${r.handle} · image ${r.image_id} · trips ${r.tripped.join(', ')}`);
    console.log(`    - ${r.before}`);
    console.log(`    + ${r.after}`);
  }
  if (!doable.length) {
    console.log('Nothing to do.');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join('data', 'reports', 'image-alt-claims', stamp);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'plan.json'), JSON.stringify({ at: new Date().toISOString(), applied: APPLY, planned }, null, 2));
  console.log(`\nPlan + backup of every prior value: ${dir}/plan.json`);

  if (!APPLY) {
    console.log('\nDRY RUN — pass --apply to write.');
    return;
  }
  for (const r of doable) {
    await updateProductImage(r.product_id, r.image_id, { alt: r.after });
    console.log(`  APPLIED ${r.handle} image ${r.image_id}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
