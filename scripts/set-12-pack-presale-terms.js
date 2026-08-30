#!/usr/bin/env node
/**
 * Write the presale terms — including the ship-by date — onto the bar soap 12-pack PDP.
 *
 *   node scripts/set-12-pack-presale-terms.js            # dry run, prints the diff
 *   node scripts/set-12-pack-presale-terms.js --apply    # writes to live Shopify
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────
 * `12x Pure Unscented` is OVERSOLD: "Continue selling when out of stock" is on, so the
 * variant is buyable while the 1,200 bars are still in production. That makes every
 * order a mail-order sale of goods not yet in hand, and the FTC Mail Order Rule
 * (16 CFR 435) requires a stated shipping date — absent one, the default is 30 days.
 * The 12-pack's `body_html` was EMPTY, so the store stated nothing at all.
 *
 * Ship-by date is the operator's (Sean, 2026-08-30): OCTOBER 1, 2026.
 *
 * ── THE SECOND EFFECT, AND IT IS NOT INCIDENTAL ─────────────────────────────────────
 * `agents/ad-studio`'s claim gate builds its `pdp` source from a LIVE fetch of this
 * handle (`fetchPdpBody`). An empty body means `pdp` holds nothing, which is why no ad
 * for this product could state a ship date without inventing one — the gate would have
 * rejected it, correctly. Writing it here is what makes "Ships by October 1, 2026" a
 * citable claim rather than a fabrication.
 *
 * ── WHAT THIS DOES NOT FIX, AND YOU SHOULD READ THIS BEFORE TRUSTING IT ─────────────
 * THE BUYER PROBABLY NEVER SEES THIS PAGE. The quantity ladder shipped on 2026-08-25;
 * `/products/coconut-soap` is the indexed sales page and carries a 1 / 4 / 12 tier
 * selector, while `coconut-bar-soap-12-pack` is a `noindex` CART TARGET. A shopper who
 * picks the 12-Pack tier there adds to cart without ever loading this PDP.
 *
 * And `theme/blocks/quantity-ladder.liquid` has NO per-tier note field — it renders
 * quantity, a savings/free-unit badge, price and per-unit price, and nothing else. So
 * there is currently nowhere on the real purchase path to disclose a ship date.
 *
 * All three Pure Unscented tiers read `available: true`, and only the 12-pack is a
 * presale, so a blanket notice on `coconut-soap` would be WRONG for the 1-bar and
 * 4-pack tiers that ship from stock. The correct fix is a per-tier note in the ladder
 * block, which is a THEME change — and the theme is not deployed by `git pull`
 * (`scripts/update-theme-asset.mjs put`, then fetch the rendered page). That is a
 * separate change and is not attempted here.
 *
 * So: this script closes the ad-sourcing half and the direct-lander half. It does not
 * close the disclosure half. Do not read a green run as "the presale is compliant".
 */

import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { isDirectRun } from '../lib/is-direct-run.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HANDLE = 'coconut-bar-soap-12-pack';

/** The operator's date, in one place. Every rendering below derives from it. */
export const SHIP_BY = 'October 1, 2026';

/**
 * Prose, not a template. Every factual figure here is checkable against the live
 * catalog entry — $88, $132, $7.33/bar, 3.4 oz — and the free-unit framing is the same
 * one `lib/quantity-ladder.js` derives ($88 / $11 = exactly 8 paid, 4 free). If the bar
 * is ever repriced this copy goes stale silently, which is the cost of prose on a PDP;
 * the ladder computes its own figures live and will simply disagree, visibly.
 */
export const PRESALE_BODY = [
  `<p><strong>Presale — ships by ${SHIP_BY}.</strong> This 12-pack is available to order now and ships by ${SHIP_BY}. Your card is charged at checkout and we email tracking the day it leaves.</p>`,
  `<p>Twelve bars of Pure Unscented Moisturizing Coconut Soap. Buy 8, get 4 free — $88 instead of $132, which is $7.33 a bar.</p>`,
  `<p>No fragrance and no essential oils, so there is nothing added to irritate sensitive skin. Handmade in small batches, made in the USA.</p>`,
  `<p>3.4 oz (84g) per bar. Ingredients: saponified organic virgin coconut oil.</p>`,
].join('\n');

async function main() {
  const apply = process.argv.includes('--apply');
  // Imported lazily: lib/shopify.js reads .env and THROWS at import time without OAuth
  // credentials, so a static import would make even `--help` unusable on a box without them.
  const { getProducts, updateProduct } = await import('../lib/shopify.js');

  // GATE FIRST, BEFORE THE NETWORK. This is SEO copy on a live product surface, the same
  // surface `agents/product-optimizer` is gated on. A hit here is a bug in the prose
  // above, not something to override.
  const gate = checkSeoCopyFields({ 'product body': PRESALE_BODY });
  if (!gate.ok) {
    console.error('REFUSED — the presale copy trips the health-claim gate:');
    for (const c of gate.claims || []) console.error(`  [${c.field}] ${c.category}: "${c.match}"`);
    process.exit(1);
  }
  console.log('Health-claim gate: pass (no blocking, no advisory).\n');

  const products = await getProducts({ limit: 250 });
  const product = products.find(p => p.handle === HANDLE);
  if (!product) throw new Error(`no product with handle "${HANDLE}"`);

  const before = product.body_html || '';
  console.log(`Product ${product.id} — ${product.title}`);
  console.log(`  current body_html: ${before ? `${before.length} chars` : 'EMPTY'}`);
  console.log(`  new body_html:     ${PRESALE_BODY.length} chars`);

  if (before.trim() === PRESALE_BODY.trim()) {
    console.log('\nAlready applied. Nothing to do.');
    return;
  }

  // A non-empty body that is not ours means somebody or something else wrote copy here
  // since this script was authored. Overwriting it blind is exactly the class of move
  // that destroys work; refuse and let a human look.
  if (before.trim() && !before.includes('Presale')) {
    console.error(
      '\nREFUSED — this PDP already has a body that this script did not write.\n' +
      'Overwriting it would destroy copy nobody has read. Diff it by hand first.'
    );
    process.exit(2);
  }

  if (!apply) {
    console.log('\n--- DRY RUN. Re-run with --apply to write. New body: ---\n');
    console.log(PRESALE_BODY);
    return;
  }

  // Back up even an empty body: "it was empty" is itself the fact a rollback needs.
  const dir = join(ROOT, 'data/reports/presale-terms');
  mkdirSync(dir, { recursive: true });
  const backup = join(dir, `${HANDLE}-body-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(backup, JSON.stringify({ handle: HANDLE, product_id: product.id, before, ship_by: SHIP_BY }, null, 2));
  console.log(`\nBacked up prior body → ${backup}`);

  await updateProduct(product.id, { body_html: PRESALE_BODY });
  console.log('Written to live Shopify.');
  console.log(`\nVerify: curl -s https://www.realskincare.com/products/${HANDLE}.js | grep -o 'ships by [^<"]*'`);
}

if (isDirectRun(import.meta.url)) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}
