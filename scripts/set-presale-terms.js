#!/usr/bin/env node
/**
 * Presale terms — the ship-by date — on both bar-soap surfaces a buyer can land on.
 *
 *   node scripts/set-presale-terms.js            # dry run, prints what would change
 *   node scripts/set-presale-terms.js --apply    # writes to live Shopify
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────
 * The bar soap is OVERSOLD: "Continue selling when out of stock" is on, so bars are
 * buyable while the next 1,200 finish production. That makes those orders mail-order
 * sales of goods not yet in hand, and the FTC Mail Order Rule (16 CFR 435) requires a
 * stated shipping date — absent one, the default is 30 days.
 *
 * Ship-by is the operator's: OCTOBER 1, 2026 (Sean, 2026-08-30).
 *
 * ── TWO SURFACES, TWO ACTIONS, AND THE DIFFERENCE MATTERS ───────────────────────────
 * `coconut-soap` is the INDEXED SALES PAGE. Since the quantity ladder shipped
 * (2026-08-25) it carries the 1 / 4 / 12 tier selector, so it is where a buyer actually
 * chooses a pack size and adds to cart. It has 1,200 characters of real body copy, so
 * the notice is PREPENDED — replacing that body would destroy the page's whole pitch.
 *
 * `coconut-bar-soap-12-pack` is a `noindex` CART TARGET whose body was empty. It is
 * still written, because a direct lander (an ad link, a shared URL) has to see the
 * terms too, and because agents/ad-studio's claim gate builds its `pdp` source from a
 * live fetch of that handle — an empty body is why no ad could state a ship date
 * without inventing one, and the gate would have rejected it, correctly.
 *
 * ── WHY THE NOTICE IS PAGE-LEVEL RATHER THAN PER-TIER ───────────────────────────────
 * `theme/blocks/quantity-ladder.liquid` renders quantity, a savings/free-unit badge,
 * price and per-unit price. There is NO per-tier note field, so a per-tier disclosure
 * would be a theme change.
 *
 * The earlier objection to a page-level notice was that it would be WRONG for the 1-bar
 * and 4-pack tiers, which still ship from stock. The operator overruled it on two
 * grounds, and both are right (Sean, 2026-08-30): those tiers are nearly sold out and
 * will be on the same footing shortly, and — the substantive point — the Mail Order
 * Rule constrains shipping LATER than the stated date, never earlier. A date you beat
 * is over-delivery, not a violation. So the copy states a CEILING every tier can meet
 * today and will still meet once the others sell out, and says plainly that most orders
 * ship sooner.
 *
 * ── WHAT WAS CHECKED BEFORE WRITING TO AN INDEXED PAGE ──────────────────────────────
 * The rendered `/products/coconut-soap` really does print `body_html` (verified by
 * grepping three distinct phrases out of the live HTML), so the notice will be seen.
 * And its `<meta name="description">` comes from a hand-written `description_tag`
 * metafield, NOT from `body_html` — verified on the live page — so prepending cannot
 * rewrite the SERP snippet of an indexed page. That was the one real SEO risk here.
 */

import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { isDirectRun } from '../lib/is-direct-run.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The operator's date, in one place. Every rendering below derives from it. */
export const SHIP_BY = 'October 1, 2026';

/**
 * The sales-page notice. A CEILING, not a forecast — "by" and "most ship sooner" are
 * what make it true for a tier shipping from stock today AND for one waiting on the
 * batch. It names no tier and no stock level, because both change daily and a PDP
 * sentence cannot track them.
 */
export const SALES_PAGE_NOTICE =
  `<p><strong>Presale — every order ships by ${SHIP_BY}.</strong> We're restocking, and some pack sizes are on presale while the next batch finishes production. Your card is charged at checkout, most orders ship sooner than the date above, and we email tracking the day yours leaves.</p>`;

/**
 * The cart-target body. This handle had no body at all, so this is the whole thing.
 * Every figure is checkable against the live catalog entry — $88, $132, $7.33/bar,
 * 3.4 oz — and the free-unit framing is the one `lib/quantity-ladder.js` derives
 * ($88 / $11 = exactly 8 paid, 4 free).
 */
export const TWELVE_PACK_BODY = [
  `<p><strong>Presale — ships by ${SHIP_BY}.</strong> This 12-pack is available to order now and ships by ${SHIP_BY}. Your card is charged at checkout and we email tracking the day it leaves.</p>`,
  `<p>Twelve bars of Pure Unscented Moisturizing Coconut Soap. Buy 8, get 4 free — $88 instead of $132, which is $7.33 a bar.</p>`,
  `<p>No fragrance and no essential oils, so there is nothing added to irritate sensitive skin. Handmade in small batches, made in the USA.</p>`,
  `<p>3.4 oz (84g) per bar. Ingredients: saponified organic virgin coconut oil.</p>`,
].join('\n');

/**
 * `prepend` keeps the existing body and puts the notice first; `replace` is only for a
 * surface that has no body of its own. Nothing here ever discards prose it did not
 * write — see `decide()`.
 */
export const PLAN = [
  { handle: 'coconut-soap', mode: 'prepend', copy: SALES_PAGE_NOTICE, why: 'indexed sales page — carries the ladder and 1,200 chars of real pitch' },
  { handle: 'coconut-bar-soap-12-pack', mode: 'replace', copy: TWELVE_PACK_BODY, why: 'noindex cart target; body was empty; feeds ad-studio\'s pdp claim source' },
];

/** A body already carrying the notice, so a second run is a no-op rather than a stack of them. */
const SENTINEL = 'Presale —';

/**
 * PURE. What should happen to this body, without touching the network.
 *
 * Returns `skip` when the notice is already there (idempotence), `refuse` when a
 * `replace` target has grown a body somebody else wrote, and otherwise the exact string
 * to write. A `prepend` never refuses — keeping the existing body is the whole point of
 * that mode, so there is nothing to destroy.
 */
export function decide({ mode, copy }, before = '') {
  const body = String(before || '');
  if (body.includes(SENTINEL)) return { action: 'skip', reason: 'notice already present' };
  if (mode === 'prepend') return { action: 'write', body: `${copy}\n${body}`.trim() };
  if (body.trim()) return { action: 'refuse', reason: 'replace target already has a body this script did not write' };
  return { action: 'write', body: copy };
}

async function main() {
  const apply = process.argv.includes('--apply');
  // Imported lazily: lib/shopify.js reads .env and THROWS at import time without OAuth
  // credentials, so a static import would make even a --help unusable without them.
  const { getProducts, updateProduct } = await import('../lib/shopify.js');

  // GATE FIRST, BEFORE THE NETWORK. This is SEO copy on live product surfaces, the same
  // surface agents/product-optimizer is gated on. A hit is a bug in the prose above.
  for (const entry of PLAN) {
    const gate = checkSeoCopyFields({ [`${entry.handle} body`]: entry.copy });
    if (!gate.ok) {
      console.error(`REFUSED — ${entry.handle} copy trips the health-claim gate:`);
      for (const c of gate.claims || []) console.error(`  ${c.category}: "${c.match}"`);
      process.exit(1);
    }
  }
  console.log('Health-claim gate: pass on every entry (no blocking, no advisory).\n');

  const products = await getProducts({ limit: 250 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let wrote = 0, refused = 0;

  for (const entry of PLAN) {
    const product = products.find(p => p.handle === entry.handle);
    if (!product) throw new Error(`no product with handle "${entry.handle}"`);
    const before = product.body_html || '';
    const verdict = decide(entry, before);

    console.log(`${entry.handle} (${entry.mode}) — ${entry.why}`);
    console.log(`  body now: ${before ? `${before.length} chars` : 'EMPTY'}`);

    if (verdict.action === 'skip')   { console.log(`  SKIP — ${verdict.reason}\n`); continue; }
    if (verdict.action === 'refuse') { console.error(`  REFUSED — ${verdict.reason}\n`); refused++; continue; }
    console.log(`  would write: ${verdict.body.length} chars`);

    if (!apply) { console.log(`  (dry run)\n`); continue; }

    // Back up even an empty body: "it was empty" is itself the fact a rollback needs.
    const dir = join(ROOT, 'data/reports/presale-terms');
    mkdirSync(dir, { recursive: true });
    const backup = join(dir, `${entry.handle}-body-${stamp}.json`);
    writeFileSync(backup, JSON.stringify({ handle: entry.handle, product_id: product.id, mode: entry.mode, before, ship_by: SHIP_BY }, null, 2));

    await updateProduct(product.id, { body_html: verdict.body });
    console.log(`  WRITTEN. Prior body backed up → ${backup}\n`);
    wrote++;
  }

  console.log(apply ? `${wrote} written, ${refused} refused.` : 'DRY RUN — re-run with --apply to write.');
  if (apply && wrote) {
    console.log('\nVerify (cache-bust, the storefront .js lags a write):');
    for (const e of PLAN) console.log(`  curl -s "https://www.realskincare.com/products/${e.handle}.js?cb=$(date +%s)" | grep -o "ships by [^<\\"]*"`);
  }
  if (refused) process.exit(2);
}

if (isDirectRun(import.meta.url)) {
  main().catch(err => { console.error(err.message); process.exit(1); });
}
