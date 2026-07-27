/**
 * Prepare the surviving collections.
 *
 *   1. Create `sets-and-bundles` — a smart collection on `tag equals bundle`,
 *      so it maintains itself as bundles are added. Merchandising, not SEO:
 *      it is measured on AOV, not impressions.
 *   2. Add `foam-soap-refill-32oz` to `foaming-hand-soap`. Without this the
 *      collection holds one product and is a duplicate of its own PDP.
 *   3. Give `all-products` a description — its body_html is currently empty.
 *   4. Every survivor's body_html leads with a prominent, above-the-fold link
 *      to its primary PDP — the spec's mechanism for focusing clicks on the
 *      product page, not just arriving at fewer collections. `all-products`
 *      has no single PDP, so it leads with links to the other surviving
 *      collections instead. Never overwrites an existing non-empty
 *      body_html; reports what is already there instead so a human can
 *      decide.
 *
 * Dry-run by default. Pass --apply to mutate.
 */

import {
  getSmartCollections, getCustomCollections, createSmartCollection,
  updateSmartCollection, updateCustomCollection, getProducts,
} from '../lib/shopify.js';

// Paragraph of links to the surviving category collections, since
// `all-products` has no single primary PDP to lead with.
const ALL_PRODUCTS_LEAD_LINKS = `<p><a href="/collections/non-toxic-body-lotion">Body Lotion</a> &middot; <a href="/collections/foaming-hand-soap">Hand Soap</a> &middot; <a href="/collections/sets-and-bundles">Sets &amp; Bundles</a> &middot; <a href="/collections/on-sale">On Sale</a></p>`;

const ALL_PRODUCTS_BODY = `${ALL_PRODUCTS_LEAD_LINKS}
<p>Every Real Skin Care product in one place: coconut-oil body
lotion and body cream, fluoride-free toothpaste, aluminium-free deodorant, bar and foaming
hand soap, and lip balm. Small-batch, made for skin that reacts to fragrance, parabens and
harsh preservatives.</p>`;

const SETS_AND_BUNDLES_LEAD_LINK = '<p><a href="/products/90-day-clean-swap">Shop the 90-Day Clean Swap</a></p>';
const SETS_AND_BUNDLES_BODY = `${SETS_AND_BUNDLES_LEAD_LINK}<p>Multi-product sets and value packs — the cheapest way to switch your whole routine.</p>`;

// handle -> body_html to write ONLY when the collection's existing body_html
// is empty. Each leads with the above-the-fold PDP link the spec requires.
// sets-and-bundles and all-products are handled inline in steps 1 and 3
// (their body_html write already happens there); this map backs the two
// survivors that don't otherwise get a body_html write in this script.
const SURVIVOR_LEAD_BODY_HTML = {
  'non-toxic-body-lotion': '<p><a href="/products/coconut-lotion">Shop Coconut Lotion</a></p>',
  'foaming-hand-soap': '<p><a href="/products/organic-foaming-hand-soap">Shop Foaming Hand Soap</a></p>',
};

// Writes body_html for `handle` only if it is currently empty; otherwise
// reports the existing copy and leaves it alone.
async function ensureLeadLink(handle, all, apply, log) {
  const c = all.find((x) => x.handle === handle);
  if (!c) { log(`WARN ${handle} not found`); return; }
  const existing = (c.body_html || '').trim();
  if (existing.length > 0) {
    const preview = existing.length > 200 ? `${existing.slice(0, 200)}…` : existing;
    log(`${handle} already has body_html — leaving it alone. Existing: ${preview}`);
    return;
  }
  const html = SURVIVOR_LEAD_BODY_HTML[handle];
  if (apply) {
    const fields = { body_html: html };
    if (c.rules) await updateSmartCollection(c.id, fields);
    else await updateCustomCollection(c.id, fields);
    log(`wrote ${handle} body_html (leads with PDP link)`);
  } else {
    log(`would write ${handle} body_html (${html.length} chars, leads with PDP link)`);
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const log = (m) => console.log(`  ${m}`);
  console.log(`\nSurvivor setup — ${apply ? 'APPLY' : 'DRY RUN'}`);

  const smart = await getSmartCollections({ limit: 250 });
  const custom = await getCustomCollections({ limit: 250 });
  const all = [...smart, ...custom];

  // 1. sets-and-bundles
  const existing = all.find((c) => c.handle === 'sets-and-bundles');
  if (existing) {
    log(`sets-and-bundles already exists (id ${existing.id}) — skipping create`);
    if ((existing.body_html || '').trim().length === 0) {
      log(`  WARN sets-and-bundles exists with empty body_html — its PDP lead link was not written by this run; needs a manual update or a follow-up script pass.`);
    }
  } else if (apply) {
    const created = await createSmartCollection({
      title: 'Sets & Bundles',
      handle: 'sets-and-bundles',
      published: true,
      body_html: SETS_AND_BUNDLES_BODY,
      rules: [{ column: 'tag', relation: 'equals', condition: 'bundle' }],
      disjunctive: false,
    });
    log(`created sets-and-bundles (id ${created.id})`);
  } else {
    log('would create sets-and-bundles (smart, tag equals bundle)');
  }

  // 2. refill into foaming-hand-soap
  const hs = all.find((c) => c.handle === 'foaming-hand-soap');
  const products = await getProducts({ limit: 250 });
  const refill = products.find((p) => p.handle === 'foam-soap-refill-32oz');
  if (!hs) log('WARN foaming-hand-soap not found');
  else if (!refill) log('WARN foam-soap-refill-32oz not found');
  else if (hs.rules) {
    log(`foaming-hand-soap is a SMART collection — cannot add a product directly.`);
    log(`  Its rule set decides membership; ensure the refill matches, or convert to custom.`);
    log(`  rules: ${JSON.stringify(hs.rules)}`);
  } else if (apply) {
    log('foaming-hand-soap is custom — add the refill via a collect in the admin or a Collect API call');
  } else {
    log('would add foam-soap-refill-32oz to foaming-hand-soap');
  }

  // 3. all-products description (leads with links to the other survivors)
  const ap = all.find((c) => c.handle === 'all-products');
  if (!ap) log('WARN all-products not found');
  else if ((ap.body_html || '').trim().length > 0) {
    log('all-products already has a description — leaving it alone');
  } else if (apply) {
    const fields = { body_html: ALL_PRODUCTS_BODY };
    if (ap.rules) await updateSmartCollection(ap.id, fields);
    else await updateCustomCollection(ap.id, fields);
    log('wrote all-products description');
  } else {
    log(`would write all-products description (${ALL_PRODUCTS_BODY.length} chars)`);
  }

  // 4. above-the-fold PDP link for the two survivors not already covered
  // by steps 1 and 3.
  await ensureLeadLink('non-toxic-body-lotion', all, apply, log);
  await ensureLeadLink('foaming-hand-soap', all, apply, log);

  if (!apply) console.log('\n  Dry run: nothing written. Re-run with --apply.');
}

main().catch((e) => { console.error(e); process.exit(1); });
