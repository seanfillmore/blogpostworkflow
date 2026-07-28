/**
 * Strip collection links out of the store's navigation.
 *
 * The header (`product-menu`) already links its 7 top-level items to the right
 * PDPs — the work is deleting their 32 collection children, not retargeting
 * anything. `main-menu`'s `Shop` item already points at /collections, which is
 * the Collections link; only its children go.
 *
 * `sidebar-menu`'s 7 collection links get retargeted to the matching PDPs.
 * `multi-main`'s top-level `Shop` item points at `/collections/live-collection`,
 * a collection this run redirects — it gets retargeted to Shopify's native
 * "all collections" link, mirroring `main-menu`'s existing `Shop` item.
 * `product-menu` also gains a new top-level `Sets & Bundles` item, since the
 * new collection needs a way into the navigation.
 *
 * Dry-run by default. Pass --apply to mutate.
 *
 * Usage:
 *   node scripts/update-navigation.mjs
 *   node scripts/update-navigation.mjs --apply
 */

import { shopifyGraphQL, getCustomCollections, getSmartCollections, getProducts } from '../lib/shopify.js';
import { appendAction, assertPreStateCaptured } from '../lib/consolidation-log.js';

const MENUS_QUERY = `{ menus(first: 20) { nodes { id handle title
  items { id title type url resourceId items { id title type url resourceId } } } } }`;

const MENU_UPDATE = `mutation menuUpdate($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
  menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
    menu { id handle }
    userErrors { field message }
  }
}`;

const isCollectionLink = (item) =>
  item?.type === 'COLLECTION' || /^\/collections\/[a-z0-9-]+$/.test(item?.url || '');

/**
 * Drop every child that is a collection link, survivor or not.
 *
 * A dropdown containing a survivor link is still a dropdown — it keeps a
 * click between the visitor and the buy button, which header cleanup exists
 * to remove. Survivors stay reachable via /collections (main-menu's `Shop`
 * item), the single deliberate route into collections. Do not restore a
 * survivor exception here thinking it's a bug — it was removed on purpose.
 */
export function stripCollectionChildren(items) {
  return (items || []).map((it) => ({
    ...it,
    items: (it.items || []).filter((c) => !isCollectionLink(c)),
  }));
}

/**
 * Rewrite collection links to PDPs using an explicit url -> {to, resourceId}
 * map. `resourceId` must be the DESTINATION product's GID, not whatever the
 * item already carried — a plain `{...it, url: to, type: 'PRODUCT'}` spread
 * preserves the item's original Collection resourceId, which Shopify treats
 * as governing for resource-typed items. That sent `{type: PRODUCT, url:
 * /products/…, resourceId: gid://shopify/Collection/…}` for every sidebar
 * item, a mismatched pair Shopify either rejects or silently accepts while
 * still resolving the item to the (now-unpublished) collection. Build the
 * map with `buildRetargetMap` so the resourceId always names the product.
 */
export function retargetToPdp(items, map) {
  return (items || []).map((it) => {
    const target = map[it.url];
    if (!target) return it;
    return { ...it, url: target.to, type: 'PRODUCT', resourceId: target.resourceId };
  });
}

/**
 * Resolve each retarget destination's product GID via `fetchProducts` (the
 * real store's product list, or an injected fake in tests) so retargetToPdp
 * never has to fall back to a stale/wrong resourceId. Throws if a mapped
 * destination has no matching product — better to fail loudly before
 * mutating the menu than to silently omit resourceId for one item.
 */
export async function buildRetargetMap(urlMap, fetchProducts) {
  const products = await fetchProducts({ limit: 250 });
  const gidByUrl = new Map(products.map((p) => [`/products/${p.handle}`, `gid://shopify/Product/${p.id}`]));
  const out = {};
  for (const [from, to] of Object.entries(urlMap)) {
    const resourceId = gidByUrl.get(to);
    if (!resourceId) {
      throw new Error(`update-navigation: no product found for retarget destination ${to} (source ${from})`);
    }
    out[from] = { to, resourceId };
  }
  return out;
}

// sidebar-menu mirrors the header's category->PDP mapping.
const SIDEBAR_MAP = {
  '/collections/coconut-oil-lotion': '/products/coconut-lotion',
  '/collections/body-cream': '/products/coconut-moisturizer',
  '/collections/natural-deodorant': '/products/coconut-oil-deodorant',
  '/collections/natural-toothpaste': '/products/coconut-oil-toothpaste',
  '/collections/natural-bar-soap': '/products/coconut-soap',
  '/collections/natural-lip-balm': '/products/coconut-oil-lip-balm',
  // foaming-hand-soap is a survivor and stays a collection link.
};

/**
 * `multi-main`'s sole collection link is its top-level `Shop` item, pointing
 * at `/collections/live-collection` — a collection this run redirects (it
 * falls through classifyTarget to the all-products fallback). Its children
 * are already PRODUCT links and untouched. Rather than send a top-level
 * "Shop" item at a single category collection, mirror `main-menu`'s existing
 * `Shop` item: Shopify's native COLLECTIONS type, which points at
 * `/collections` and carries no resourceId.
 */
export function retargetShopToAllCollections(items) {
  return (items || []).map((it) => {
    if (it.type !== 'COLLECTION') return it;
    const { resourceId, ...rest } = it;
    return { ...rest, type: 'COLLECTIONS', url: '/collections' };
  });
}

/**
 * Append a top-level `Sets & Bundles` item to product-menu, pointing at the
 * new collection. `resourceId` is required — a null/undefined id means the
 * collection doesn't exist yet (setup-survivor-collections.mjs --apply must
 * run first) and the item is not appended, since a COLLECTION-typed item
 * with no resourceId is exactly the malformed shape Critical 4 fixes.
 *
 * Idempotent: re-running after a partial failure is the documented recovery
 * path (see assertPreStateCaptured), so a second call over the first call's
 * own output must not duplicate the item. `stripCollectionChildren` only
 * filters *children*, so a top-level item survives untouched across re-runs
 * — skip the append if one already targets the collection.
 */
export function withSetsAndBundlesItem(items, resourceId) {
  if (!resourceId) return items;
  const alreadyPresent = (items || []).some(
    (it) => it.url === '/collections/sets-and-bundles' || it.resourceId === resourceId
  );
  if (alreadyPresent) return items;
  return [...items, {
    title: 'Sets & Bundles',
    type: 'COLLECTION',
    url: '/collections/sets-and-bundles',
    resourceId,
    items: [],
  }];
}

async function findCollectionGid(handle, { fetchCustom, fetchSmart }) {
  const [custom, smart] = await Promise.all([
    fetchCustom({ limit: 250 }),
    fetchSmart({ limit: 250 }),
  ]);
  const found = [...custom, ...smart].find((c) => c.handle === handle);
  return found ? `gid://shopify/Collection/${found.id}` : null;
}

// menuUpdate replaces the whole item tree from what's sent, so every field
// that should survive the round trip must be sent back explicitly. `id`
// targets the existing MenuItem for an in-place update instead of a
// recreate, and must be OMITTED (not sent as undefined/null) for a brand-new
// item so Shopify creates it; `resourceId` is the item's association with a
// product/collection resource and must likewise be omitted for items that
// don't have one (HTTP, PAGE, BLOG, etc.) — an explicit null is not the same
// as absent.
const toItemInput = (it) => ({
  ...(it.id ? { id: it.id } : {}),
  title: it.title,
  type: it.type,
  url: it.url,
  ...(it.resourceId ? { resourceId: it.resourceId } : {}),
  items: (it.items || []).map(toItemInput),
});

export const toInput = (items) => items.map(toItemInput);

async function main() {
  const apply = process.argv.includes('--apply');
  const { menus } = await shopifyGraphQL(MENUS_QUERY);
  const byHandle = Object.fromEntries(menus.nodes.map((m) => [m.handle, m]));

  const changes = [];

  const setsAndBundlesGid = await findCollectionGid('sets-and-bundles', {
    fetchCustom: getCustomCollections, fetchSmart: getSmartCollections,
  });

  for (const handle of ['product-menu', 'main-menu']) {
    const m = byHandle[handle];
    if (!m) continue;
    const before = m.items.reduce((n, i) => n + (i.items || []).length, 0);
    let items = stripCollectionChildren(m.items);
    const after = items.reduce((n, i) => n + (i.items || []).length, 0);
    let note = `children ${before} -> ${after}`;

    if (handle === 'product-menu') {
      const withSab = withSetsAndBundlesItem(items, setsAndBundlesGid);
      if (withSab !== items) {
        note += '; added Sets & Bundles top-level item';
      } else {
        note += '; WARN sets-and-bundles collection not found — --apply will hard-fail; run setup-survivor-collections.mjs --apply first, then re-run this script';
      }
      items = withSab;
    }

    changes.push({ menu: m, items, note });
  }

  const sidebar = byHandle['sidebar-menu'];
  if (sidebar) {
    const retargetMap = await buildRetargetMap(SIDEBAR_MAP, getProducts);
    changes.push({
      menu: sidebar,
      items: retargetToPdp(sidebar.items, retargetMap),
      note: 'collection links retargeted to PDPs',
    });
  }

  const multiMain = byHandle['multi-main'];
  if (multiMain) {
    changes.push({
      menu: multiMain,
      items: retargetShopToAllCollections(stripCollectionChildren(multiMain.items)),
      note: 'top-level collection link (live-collection) retargeted to the native collections index',
    });
  }

  console.log(`\nNavigation update — ${apply ? 'APPLY' : 'DRY RUN'}`);
  for (const ch of changes) {
    console.log(`\n  ${ch.menu.handle}: ${ch.note}`);
    for (const it of ch.items) {
      console.log(`    ${it.title} [${it.type}] ${it.url}`);
      for (const c of it.items || []) console.log(`        - ${c.title} ${c.url}`);
    }
  }

  if (!apply) {
    console.log('\n  Dry run: nothing written. Re-run with --apply.');
    return;
  }

  // Hard failure, not a WARN-and-proceed: a nav missing the collection this
  // project exists to add is not an acceptable silent outcome. This must
  // block before any menu is written, not just product-menu's — a partial
  // apply that updates every other menu but skips the one that matters is
  // its own kind of silent failure.
  if (!setsAndBundlesGid) {
    throw new Error(
      'update-navigation: sets-and-bundles collection not found — refusing to apply. ' +
      'Run setup-survivor-collections.mjs --apply first, then re-run this script.'
    );
  }

  // Hard precondition: this script must never be the first to mutate the
  // store on a given day — see lib/consolidation-log.js.
  assertPreStateCaptured();

  for (const ch of changes) {
    const res = await shopifyGraphQL(MENU_UPDATE, {
      id: ch.menu.id,
      title: ch.menu.title,
      handle: ch.menu.handle,
      items: toInput(ch.items),
    });
    const errs = res.menuUpdate.userErrors;
    if (errs?.length) throw new Error(`${ch.menu.handle}: ${errs.map((e) => e.message).join('; ')}`);
    appendAction({ action: 'menu_update', handle: ch.menu.handle, note: ch.note });
    console.log(`  ✓ ${ch.menu.handle} updated`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
