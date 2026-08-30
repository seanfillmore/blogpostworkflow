#!/usr/bin/env node
/**
 * Give the store a real header navigation, on BOTH breakpoints.
 *
 *   node scripts/build-header-nav.mjs                  # DRY (default)
 *   node scripts/build-header-nav.mjs --apply
 *   node scripts/build-header-nav.mjs --only desktop   # or: mobile
 *
 * THE HEADER USES TWO DIFFERENT MENUS AND THIS IS THE WHOLE POINT.
 * `sections/header-group.json`'s header section carries:
 *
 *     "menu":        "product-menu"   ← DESKTOP  (renders as .header__inline-menu)
 *     "menu_mobile": "main-menu"      ← MOBILE   (renders as .menu-drawer__navigation)
 *     "enable_dropdown_menu": true
 *
 * So the two breakpoints had completely different navigation and nobody had
 * looked at both. Measured on the live homepage 2026-08-29:
 *
 *   desktop: Lotion · Body Cream · Toothpaste · Deodorant · Liquid Soap ·
 *            Bar Soap · Lip Balm            → 7 products, no bundles
 *   mobile:  About Us · Blogs               → NO route to anything purchasable
 *
 * (A `Sets & Bundles` item was added to `main-menu` on 2026-08-29 believing it
 * was the header menu. It is the MOBILE one. That is why the desktop header
 * still has no bundles link, and it is the correction this script carries: an
 * earlier note claiming "the site header had no route to anything purchasable"
 * was true of MOBILE ONLY.)
 *
 * WHAT THIS DOES
 *   desktop (`product-menu`) — append `Sets & Bundles`. Kept FLAT: seven flat
 *     items already render correctly, and a dropdown here would be an unforced
 *     change to the one navigation that currently works.
 *   mobile (`main-menu`)     — add a `Shop` parent carrying the same seven
 *     products, above the existing `Sets & Bundles`. `snippets/header-drawer.liquid`
 *     renders `link.links` inside a `<details>` accordion, so children are real
 *     here — unlike `multi-main` in the footer, which draws top-level items only.
 *
 * VERIFY ON THE RENDERED PAGE, NEVER THE MENU API. This store has 13 menus and
 * most render nowhere; `scripts/footer-collections-link.mjs` and
 * `scripts/link-sets-and-bundles.mjs` both exist because of that trap, and this
 * script exists because a third variant of it (two menus, one header) was missed.
 *
 * IDEMPOTENT. Re-running finds the items present and writes nothing.
 */
import { shopifyGraphQL } from '../lib/shopify.js';

const apply = process.argv.includes('--apply');
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx === -1 ? null : process.argv[onlyIdx + 1];

const DESKTOP_MENU = 'product-menu';
const MOBILE_MENU = 'main-menu';
const BUNDLES_URL = '/collections/sets-and-bundles';

/** The seven single-SKU PDPs, in the order desktop already uses. */
const SHOP_ITEMS = [
  { title: 'Lotion', handle: 'coconut-lotion' },
  { title: 'Body Cream', handle: 'coconut-moisturizer' },
  { title: 'Toothpaste', handle: 'coconut-oil-toothpaste' },
  { title: 'Deodorant', handle: 'coconut-oil-deodorant' },
  { title: 'Liquid Soap', handle: 'organic-foaming-hand-soap' },
  { title: 'Bar Soap', handle: 'coconut-soap' },
  { title: 'Lip Balm', handle: 'coconut-oil-lip-balm' },
];

const Q_MENUS = `{ menus(first: 20) { nodes { id handle title
  items { id title type url resourceId items { id title type url resourceId } } } } }`;

const Q_LOOKUP = `query($handles: [String!]!) {
  collection: collectionByHandle(handle: "sets-and-bundles") { id }
  products: nodes(ids: []) { id }
}`;

const M_UPDATE = `mutation menuUpdate($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
  menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
    menu { id handle } userErrors { field message } } }`;

const toInput = (items) => items.map((it) => ({
  ...(it.id ? { id: it.id } : {}),
  title: it.title, type: it.type, url: it.url,
  ...(it.resourceId ? { resourceId: it.resourceId } : {}),
  items: (it.items || []).map((c) => ({
    ...(c.id ? { id: c.id } : {}),
    title: c.title, type: c.type, url: c.url,
    ...(c.resourceId ? { resourceId: c.resourceId } : {}),
    items: [],
  })),
}));

const linksTo = (it, url) => (it.url || '') === url || (it.url || '').endsWith(url);

async function resolveProduct(handle) {
  const r = await shopifyGraphQL(
    'query($h:String!){ productByHandle(handle:$h){ id title status } }', { h: handle });
  return r.productByHandle;
}

async function main() {
  console.log(`Header navigation — ${apply ? 'APPLY' : 'DRY RUN'}${only ? ` (only: ${only})` : ''}\n`);

  const col = await shopifyGraphQL(
    'query{ collectionByHandle(handle:"sets-and-bundles"){ id productsCount { count } } }');
  if (!col.collectionByHandle) throw new Error('sets-and-bundles collection not found — refusing.');
  if (col.collectionByHandle.productsCount.count === 0) {
    throw new Error('sets-and-bundles holds 0 products — refusing to link an empty page.');
  }
  const bundlesItem = {
    title: 'Sets & Bundles', type: 'COLLECTION', url: BUNDLES_URL,
    resourceId: col.collectionByHandle.id, items: [],
  };

  const { menus } = await shopifyGraphQL(Q_MENUS);
  const byHandle = Object.fromEntries(menus.nodes.map((m) => [m.handle, m]));
  const plan = [];

  // ── DESKTOP: append Sets & Bundles to the flat product menu ────────────────
  if (!only || only === 'desktop') {
    const m = byHandle[DESKTOP_MENU];
    if (!m) console.log(`  ! menu "${DESKTOP_MENU}" not found — desktop skipped`);
    else if (m.items.some((it) => linksTo(it, BUNDLES_URL))) {
      console.log(`  = ${DESKTOP_MENU} (desktop): already links to the collection`);
    } else {
      plan.push({
        menu: m,
        items: [...toInput(m.items), bundlesItem],
        what: `${DESKTOP_MENU} (desktop): append "Sets & Bundles" after ${m.items.length} product link(s)`,
      });
    }
  }

  // ── MOBILE: a Shop parent carrying the same seven products ────────────────
  if (!only || only === 'mobile') {
    const m = byHandle[MOBILE_MENU];
    if (!m) console.log(`  ! menu "${MOBILE_MENU}" not found — mobile skipped`);
    else if (m.items.some((it) => it.title === 'Shop')) {
      console.log(`  = ${MOBILE_MENU} (mobile): already has a Shop submenu`);
    } else {
      const children = [];
      for (const s of SHOP_ITEMS) {
        const p = await resolveProduct(s.handle);
        if (!p) { console.log(`  ! product ${s.handle} not found — omitted from Shop`); continue; }
        if (p.status !== 'ACTIVE') { console.log(`  ! ${s.handle} is ${p.status} — omitted from Shop`); continue; }
        children.push({ title: s.title, type: 'PRODUCT', url: `/products/${s.handle}`, resourceId: p.id });
      }
      if (!children.length) throw new Error('no ACTIVE products resolved — refusing to add an empty Shop menu.');
      const shop = { title: 'Shop', type: 'HTTP', url: '/collections/all-products', items: children };
      plan.push({
        menu: m,
        items: [shop, ...toInput(m.items)],
        what: `${MOBILE_MENU} (mobile): add "Shop" with ${children.length} products, above ${m.items.map((i) => `"${i.title}"`).join(', ')}`,
      });
    }
  }

  if (!plan.length) { console.log('\nNothing to do.'); return; }
  console.log('\nPLANNED:');
  for (const p of plan) console.log(`  - ${p.what}`);

  if (!apply) {
    console.log('\nNothing was written. Re-run with --apply.');
    return;
  }

  console.log('');
  for (const p of plan) {
    const res = await shopifyGraphQL(M_UPDATE, {
      id: p.menu.id, title: p.menu.title, handle: p.menu.handle, items: p.items,
    });
    const errs = res.menuUpdate?.userErrors || [];
    if (errs.length) throw new Error(`menuUpdate(${p.menu.handle}) failed: ${errs.map((e) => `${e.field}: ${e.message}`).join('; ')}`);
    console.log(`  ✓ ${p.menu.handle}`);
  }

  console.log('\nVerify on the RENDERED page — desktop and mobile draw DIFFERENT menus:');
  console.log("  curl -s https://www.realskincare.com/ | grep -c 'header__inline-menu'      # desktop");
  console.log("  curl -s https://www.realskincare.com/ | grep -c 'menu-drawer__navigation'  # mobile");
}

main().catch((e) => { console.error(`\n${e.message}`); process.exit(1); });
