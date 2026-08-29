#!/usr/bin/env node
/**
 * Give the Sets & Bundles collection an inbound link. It had none.
 *
 *   node scripts/link-sets-and-bundles.mjs            # DRY (default)
 *   node scripts/link-sets-and-bundles.mjs --apply
 *
 * WHY
 * ───
 * `/collections/sets-and-bundles` is a published SMART collection (rule: TAG =
 * "bundle") holding all 11 live bundles, and its page renders every one of them.
 * Measured 2026-08-29, NOT ONE of the store's 13 navigation menus linked to it,
 * and the only bundles reachable from anywhere were the Sensitive Skin Set and
 * the Coconut Reset, both hardcoded into homepage sections. Nine bundles were
 * built, priced, componentized and published with no path to them at all.
 *
 * That is the gap `docs/bundle-marketing-plan.md` §4 calls the "Collections +
 * organic SEO" channel, and it is the cheapest revenue work available here: the
 * pages already exist and already convert-or-not on their own merits. Nothing
 * new is created — this only adds links.
 *
 * WHICH MENUS, AND WHY ONLY THESE TWO
 * ───────────────────────────────────
 * The store has 13 menus and most of them render NOWHERE. Verified against the
 * live rendered homepage rather than guessed:
 *
 *   - `main-menu`  → renders in the <header>. It carried exactly two items,
 *                    "About Us" and "Blogs", so the site's header had no route
 *                    to anything purchasable whatsoever.
 *   - `multi-main` → renders in the <footer>, as `scripts/footer-collections-link.mjs`
 *                    documents. Its "Collections" item has a submenu of the 7
 *                    single SKUs and no bundle.
 *
 * Every other menu (`footer`, `product-menu`, `sidebar-menu`, `ops-header`,
 * `main-menu-2`, `company`, …) is an orphan of a past theme. Adding items to one
 * is invisible — the exact trap `footer-collections-link.mjs` was written to
 * record. Do not "helpfully" extend this to them without re-checking the
 * rendered page first.
 *
 * The header link goes FIRST, ahead of About Us, because it is the only
 * commercial item in that menu. The footer link goes first inside the
 * "Collections" submenu, ahead of the single SKUs, because a set is the higher
 * average-order-value entry point.
 *
 * IDEMPOTENT — a second run finds the items already there and writes nothing.
 */
import { shopifyGraphQL } from '../lib/shopify.js';

const apply = process.argv.includes('--apply');

const COLLECTION_HANDLE = 'sets-and-bundles';
const LINK_TITLE = 'Sets & Bundles';

const Q_MENUS = `{
  menus(first: 20) {
    nodes {
      id handle title
      items { id title type url resourceId items { id title type url resourceId } }
    }
  }
}`;

const Q_COLLECTION = `query($handle: String!) {
  collectionByHandle(handle: $handle) { id handle title productsCount { count } }
}`;

const M_UPDATE = `mutation menuUpdate($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
  menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
    menu { id handle }
    userErrors { field message }
  }
}`;

/** Menu items round-trip as MenuItemUpdateInput; drop everything the input rejects. */
const toInput = (items) => items.map((it) => ({
  ...(it.id ? { id: it.id } : {}),
  title: it.title,
  type: it.type,
  url: it.url,
  ...(it.resourceId ? { resourceId: it.resourceId } : {}),
  items: (it.items || []).map((c) => ({
    ...(c.id ? { id: c.id } : {}),
    title: c.title,
    type: c.type,
    url: c.url,
    ...(c.resourceId ? { resourceId: c.resourceId } : {}),
    items: [],
  })),
}));

const linksToCollection = (it) =>
  it.url === `/collections/${COLLECTION_HANDLE}` ||
  (it.url || '').endsWith(`/collections/${COLLECTION_HANDLE}`);

async function main() {
  const { collectionByHandle: collection } = await shopifyGraphQL(Q_COLLECTION, { handle: COLLECTION_HANDLE });
  if (!collection) throw new Error(`Collection "${COLLECTION_HANDLE}" not found — refusing to link nothing.`);
  if (collection.productsCount.count === 0) {
    throw new Error(`Collection "${COLLECTION_HANDLE}" holds 0 products — refusing to link an empty page.`);
  }

  console.log(`Link ${LINK_TITLE} — ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`  target: /collections/${COLLECTION_HANDLE} (${collection.productsCount.count} products)\n`);

  const newItem = {
    title: LINK_TITLE,
    type: 'COLLECTION',
    url: `/collections/${COLLECTION_HANDLE}`,
    resourceId: collection.id,
    items: [],
  };

  const { menus } = await shopifyGraphQL(Q_MENUS);
  const byHandle = Object.fromEntries(menus.nodes.map((m) => [m.handle, m]));

  const plan = [];

  // 1. Header (`main-menu`) — prepend, it is the only commercial item there.
  const header = byHandle['main-menu'];
  if (!header) {
    console.log('  ! menu "main-menu" not found — header link skipped');
  } else if (header.items.some(linksToCollection)) {
    console.log('  = main-menu (header): already links to the collection');
  } else {
    plan.push({
      menu: header,
      items: [newItem, ...toInput(header.items)],
      what: `main-menu (header): prepend "${LINK_TITLE}" before ${header.items.map((i) => `"${i.title}"`).join(', ')}`,
    });
  }

  // 2. Footer (`multi-main`) — TOP LEVEL, directly after "Collections".
  //
  // It must be top level. Verified against the rendered page: the footer draws
  // only multi-main's TOP-LEVEL items — "Collections", About, Blog, Contact,
  // FAQS, Wholesale, Veterans all appear, and the seven single-SKU children of
  // "Collections" appear nowhere. A child added here is written successfully,
  // reads correctly back from the API, and is invisible to every shopper. That
  // is the same trap `scripts/footer-collections-link.mjs` exists to record,
  // and this script walked into it on its first run before the rendered page
  // was checked. Any child previously added by that run is removed here.
  const footer = byHandle['multi-main'];
  const collectionsItem = footer?.items.find((it) => it.url === '/collections' || it.type === 'COLLECTIONS');
  if (!footer) {
    console.log('  ! menu "multi-main" not found — footer link skipped');
  } else if (footer.items.some(linksToCollection)) {
    console.log('  = multi-main (footer): already links to the collection at top level');
  } else {
    // Strip any invisible nested copy, then insert at top level.
    const stripped = toInput(footer.items).map((it) => ({
      ...it,
      items: (it.items || []).filter((c) => !linksToCollection(c)),
    }));
    const at = collectionsItem
      ? stripped.findIndex((it) => it.id === collectionsItem.id) + 1
      : stripped.length;
    const items = [...stripped.slice(0, at), newItem, ...stripped.slice(at)];
    const hadNested = (collectionsItem?.items || []).some(linksToCollection);
    plan.push({
      menu: footer,
      items,
      what: `multi-main (footer): add "${LINK_TITLE}" at TOP LEVEL, position ${at + 1}`
        + (hadNested ? ' (and remove the invisible nested copy)' : ''),
    });
  }

  if (plan.length === 0) {
    console.log('\nNothing to do — every target menu already links to the collection.');
    return;
  }

  console.log('\nPLANNED:');
  for (const p of plan) console.log(`  - ${p.what}`);

  if (!apply) {
    console.log('\nNothing was written. Re-run with --apply.');
    return;
  }

  console.log('');
  for (const p of plan) {
    const res = await shopifyGraphQL(M_UPDATE, {
      id: p.menu.id,
      title: p.menu.title,
      handle: p.menu.handle,
      items: p.items,
    });
    const errs = res.menuUpdate?.userErrors || [];
    if (errs.length) {
      throw new Error(`menuUpdate(${p.menu.handle}) failed: ${errs.map((e) => `${e.field}: ${e.message}`).join('; ')}`);
    }
    console.log(`  ✓ ${p.menu.handle} updated`);
  }

  console.log('\nDone. Verify on the RENDERED page, not the menu API — most of this');
  console.log('store\'s menus render nowhere:');
  console.log('  curl -s https://www.realskincare.com/ | grep -c "collections/sets-and-bundles"');
}

main().catch((e) => {
  console.error(`\n${e.message}`);
  process.exit(1);
});
