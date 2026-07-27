/**
 * Strip collection links out of the store's navigation.
 *
 * The header (`product-menu`) already links its 7 top-level items to the right
 * PDPs — the work is deleting their 32 collection children, not retargeting
 * anything. `main-menu`'s `Shop` item already points at /collections, which is
 * the Collections link; only its children go.
 *
 * Dry-run by default. Pass --apply to mutate.
 *
 * Usage:
 *   node scripts/update-navigation.mjs
 *   node scripts/update-navigation.mjs --apply
 */

import { shopifyGraphQL } from '../lib/shopify.js';

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

/** Rewrite collection links to PDPs using an explicit url->url map. */
export function retargetToPdp(items, map) {
  return (items || []).map((it) => {
    const to = map[it.url];
    if (!to) return it;
    return { ...it, url: to, type: 'PRODUCT' };
  });
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

// menuUpdate replaces the whole item tree from what's sent, so every field
// that should survive the round trip must be sent back explicitly. `id`
// targets the existing MenuItem for an in-place update instead of a
// recreate; `resourceId` is the item's association with a product/collection
// resource and must be omitted (not sent as null) for items that don't have
// one (HTTP, PAGE, BLOG, etc.) — an explicit null is not the same as absent.
const toItemInput = (it) => ({
  id: it.id,
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

  for (const handle of ['product-menu', 'main-menu']) {
    const m = byHandle[handle];
    if (!m) continue;
    const before = m.items.reduce((n, i) => n + (i.items || []).length, 0);
    const items = stripCollectionChildren(m.items);
    const after = items.reduce((n, i) => n + (i.items || []).length, 0);
    changes.push({ menu: m, items, note: `children ${before} -> ${after}` });
  }

  const sidebar = byHandle['sidebar-menu'];
  if (sidebar) {
    changes.push({
      menu: sidebar,
      items: retargetToPdp(sidebar.items, SIDEBAR_MAP),
      note: 'collection links retargeted to PDPs',
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

  for (const ch of changes) {
    const res = await shopifyGraphQL(MENU_UPDATE, {
      id: ch.menu.id,
      title: ch.menu.title,
      handle: ch.menu.handle,
      items: toInput(ch.items),
    });
    const errs = res.menuUpdate.userErrors;
    if (errs?.length) throw new Error(`${ch.menu.handle}: ${errs.map((e) => e.message).join('; ')}`);
    console.log(`  ✓ ${ch.menu.handle} updated`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
