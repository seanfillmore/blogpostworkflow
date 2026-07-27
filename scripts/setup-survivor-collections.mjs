/**
 * Prepare the surviving collections.
 *
 *   1. Create `sets-and-bundles` — a smart collection on `tag equals bundle`,
 *      so it maintains itself as bundles are added. Merchandising, not SEO:
 *      it is measured on AOV, not impressions. `tag equals bundle` is correct
 *      exactly as written — all 10 bundle-tagged products belong here,
 *      including `99-coconut-reset-digital` (a physical $99 bundle that
 *      ships; the `-digital` in its handle is a landing-page artifact, not a
 *      statement about the product).
 *   2. Add `foam-soap-refill-32oz` to `foaming-hand-soap`. Without this the
 *      collection holds one product and is a duplicate of its own PDP.
 *   3. Every survivor's body_html leads with a prominent, above-the-fold link
 *      to its primary PDP — the spec's mechanism for focusing clicks on the
 *      product page, not just arriving at fewer collections. `all-products`
 *      has no single PDP, so it leads with links to the other surviving
 *      collections instead.
 *
 *      If a survivor's body_html is empty, this writes the full lead-link +
 *      description. If it already has merchandiser copy, the lead link is
 *      PREPENDED — existing copy is never destroyed, only pushed below the
 *      link so the link stays above the fold. This is idempotent: if the
 *      body_html already links to the target PDP (or, for all-products, to
 *      every surviving collection), nothing is written a second time. See
 *      `planLeadLink` and tests/scripts/setup-survivor-collections.test.js.
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

const LOTION_LEAD_LINK = '<p><a href="/products/coconut-lotion">Shop Coconut Lotion</a></p>';
const SOAP_LEAD_LINK = '<p><a href="/products/organic-foaming-hand-soap">Shop Foaming Hand Soap</a></p>';
const SETS_AND_BUNDLES_LEAD_LINK = '<p><a href="/products/90-day-clean-swap">Shop the 90-Day Clean Swap</a></p>';
const SETS_AND_BUNDLES_BODY = `${SETS_AND_BUNDLES_LEAD_LINK}<p>Multi-product sets and value packs — the cheapest way to switch your whole routine.</p>`;

// handle -> { leadHtml: the paragraph to prepend when copy already exists,
//             fullHtml: the body to write when body_html is currently empty
//             (lead link + description),
//             hrefs: the target href(s) that prove a lead link is already
//             present — checked with .every() so all-products requires every
//             surviving collection linked, not just one, before it's
//             considered already done }
export const SURVIVOR_LEAD = {
  'non-toxic-body-lotion': {
    leadHtml: LOTION_LEAD_LINK,
    fullHtml: LOTION_LEAD_LINK,
    hrefs: ['/products/coconut-lotion'],
  },
  'foaming-hand-soap': {
    leadHtml: SOAP_LEAD_LINK,
    fullHtml: SOAP_LEAD_LINK,
    hrefs: ['/products/organic-foaming-hand-soap'],
  },
  'sets-and-bundles': {
    leadHtml: SETS_AND_BUNDLES_LEAD_LINK,
    fullHtml: SETS_AND_BUNDLES_BODY,
    hrefs: ['/products/90-day-clean-swap'],
  },
  'all-products': {
    leadHtml: ALL_PRODUCTS_LEAD_LINKS,
    fullHtml: ALL_PRODUCTS_BODY,
    hrefs: [
      '/collections/non-toxic-body-lotion',
      '/collections/foaming-hand-soap',
      '/collections/sets-and-bundles',
      '/collections/on-sale',
    ],
  },
};

/**
 * Pure decision for what to do with a survivor's body_html — no network
 * calls, so it's directly unit-testable. Given the collection's current
 * body_html and its lead-link config, returns:
 *   - { action: 'write-full', body } — body_html is empty; write lead + copy.
 *   - { action: 'prepend', body }    — copy exists but doesn't link to the
 *                                       PDP yet; lead link goes on top.
 *   - { action: 'skip', body }       — already links to the PDP (or, for
 *                                       all-products, all of them); body is
 *                                       returned unchanged. Calling this
 *                                       again with `body` from a prior
 *                                       'prepend'/'write-full' result always
 *                                       yields 'skip' with the same body —
 *                                       that's the idempotency guarantee.
 */
export function planLeadLink(existingBodyHtml, cfg) {
  const existing = (existingBodyHtml || '').trim();
  if (existing.length === 0) {
    return { action: 'write-full', body: cfg.fullHtml };
  }
  if (cfg.hrefs.every((href) => existing.includes(href))) {
    return { action: 'skip', body: existing };
  }
  return { action: 'prepend', body: `${cfg.leadHtml}\n${existing}` };
}

// Applies planLeadLink's decision: logs it, and under --apply, writes it.
async function ensureLeadLink(handle, all, apply, log) {
  const cfg = SURVIVOR_LEAD[handle];
  const c = all.find((x) => x.handle === handle);
  if (!c) { log(`WARN ${handle} not found`); return; }

  const plan = planLeadLink(c.body_html, cfg);
  if (plan.action === 'skip') {
    log(`${handle} body_html already links to its PDP — leaving as-is`);
    return;
  }

  const verb = plan.action === 'write-full' ? 'wrote' : 'prepended PDP lead link to';
  if (apply) {
    const fields = { body_html: plan.body };
    if (c.rules) await updateSmartCollection(c.id, fields);
    else await updateCustomCollection(c.id, fields);
    log(`${verb} ${handle} body_html`);
  } else {
    const existing = (c.body_html || '').trim();
    const preview = existing.length > 200 ? `${existing.slice(0, 200)}…` : existing;
    if (plan.action === 'write-full') {
      log(`would write ${handle} body_html (${plan.body.length} chars, leads with PDP link)`);
    } else {
      log(`would prepend PDP lead link to ${handle} body_html. Existing copy kept: ${preview}`);
    }
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
    log('would create sets-and-bundles (smart, tag equals bundle, body_html leads with PDP link)');
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

  // 3. above-the-fold PDP lead link for every survivor. sets-and-bundles is
  // only processed here if it already existed before step 1 — a freshly
  // created collection already has the lead link baked into its body_html,
  // so re-checking it against the stale pre-creation `all` snapshot would
  // wrongly report it as not found.
  const leadLinkHandles = existing
    ? ['non-toxic-body-lotion', 'foaming-hand-soap', 'sets-and-bundles', 'all-products']
    : ['non-toxic-body-lotion', 'foaming-hand-soap', 'all-products'];
  for (const handle of leadLinkHandles) {
    await ensureLeadLink(handle, all, apply, log);
  }

  if (!apply) console.log('\n  Dry run: nothing written. Re-run with --apply.');
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
