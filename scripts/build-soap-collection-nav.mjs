#!/usr/bin/env node
/**
 * Collapse the two soap links in the header into one `Soap` category link.
 *
 *   node scripts/build-soap-collection-nav.mjs                  # DRY (default)
 *   node scripts/build-soap-collection-nav.mjs --apply
 *   node scripts/build-soap-collection-nav.mjs --only collection # or: menus
 *
 * WHY
 *   The header carried `Liquid Soap` and `Bar Soap` as two separate PDP links,
 *   and the third soap SKU — `Foam Soap Refill | 32oz` — had NO nav route at
 *   all. This replaces both with a single `Soap` link to a real category page
 *   holding all three. Soap is the store's second-biggest cluster
 *   ($324.85/90d), so this trades one click of friction for a category page
 *   and a route to the refill.
 *
 * THE HEADER USES TWO DIFFERENT MENUS. `sections/header-group.json` carries:
 *
 *     "menu":        "product-menu"   ← DESKTOP  (.header__inline-menu)
 *     "menu_mobile": "main-menu"      ← MOBILE   (.menu-drawer__navigation)
 *
 * so BOTH have to be swapped or the two breakpoints show different soap
 * navigation. See `scripts/build-header-nav.mjs` for the full history of that
 * trap — mobile carries the same seven products inside a `Shop` accordion.
 *
 * WHY A MANUAL COLLECTION, AND WHY A NEW ONE
 *   Every existing soap collection is unusable here, measured 2026-09-02:
 *     coconut-soap / vegan-soap / mens-natural-soap / natural-bar-soap
 *                       → all 301 to the bar soap PDP (deliberate cleanup)
 *     foaming-hand-soap → 200, but holds liquid + refill and NO bar
 *     /collections/soap → 404, handle is free
 *   Retitling the one live collection to "Soap" would cost its "foaming hand
 *   soap" rankings for no gain. And every smart soap rule in the store is
 *   `TITLE CONTAINS soap AND VARIANT_PRICE < 20`, which structurally excludes
 *   the $26 refill — so a smart collection cannot express this set.
 *
 *   Per the Prime Directive a collection is legitimate here only because the
 *   category holds 3 distinct products. This is a nav destination, not a
 *   keyword play: no 300-word SEO body, just a short gated description.
 *
 * VERIFY ON THE RENDERED PAGE, NEVER THE MENU API. This store has 13 menus and
 * most render nowhere. The verify commands are printed after an --apply run.
 *
 * IDEMPOTENT. Re-running finds the collection and both menu items already in
 * place and writes nothing.
 */
import {
  shopifyGraphQL,
  getCustomCollections,
  createCustomCollection,
  createCollect,
} from '../lib/shopify.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const apply = process.argv.includes('--apply');
const onlyIdx = process.argv.indexOf('--only');
const only = onlyIdx === -1 ? null : process.argv[onlyIdx + 1];

const DESKTOP_MENU = 'product-menu';
const MOBILE_MENU = 'main-menu';
const MOBILE_PARENT = 'Shop';

const COLLECTION_HANDLE = 'soap';
const COLLECTION_TITLE = 'Soap';
const COLLECTION_URL = `/collections/${COLLECTION_HANDLE}`;
const NAV_TITLE = 'Soap';

/** The three soap SKUs, in the order the collection should list them. */
const SOAP_PRODUCTS = [
  { handle: 'coconut-soap', label: 'Bar Soap' },
  { handle: 'organic-foaming-hand-soap', label: 'Liquid Soap' },
  { handle: 'foam-soap-refill-32oz', label: 'Foam Soap Refill' },
];

/** Menu items these replace. Matched on URL, so a retitled item still goes. */
const REPLACED_URLS = [
  '/products/organic-foaming-hand-soap',
  '/products/coconut-soap',
];

const DESCRIPTION = [
  '<p>Coconut oil soap for hands and body — the same short ingredient list in',
  'three formats. Pick the moisturizing bar, the 8oz foaming pump, or the 32oz',
  'refill that keeps the pump going.</p>',
].join(' ');

const Q_MENUS = `{ menus(first: 25) { nodes { id handle title
  items { id title type url resourceId items { id title type url resourceId } } } } }`;

const M_UPDATE = `mutation menuUpdate($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
  menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
    menu { id handle } userErrors { field message } } }`;

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

const isReplaced = (it) => REPLACED_URLS.some((u) => (it.url || '') === u || (it.url || '').endsWith(u));
const linksToCollection = (it) => (it.url || '') === COLLECTION_URL || (it.url || '').endsWith(COLLECTION_URL);

const numericId = (gid) => String(gid).split('/').pop();

/**
 * Put a single `Soap` item where the FIRST replaced item sat, and drop the
 * rest. Position matters — the soap links live mid-list, between Deodorant and
 * Lip Balm, and appending would move soap to the end of the header.
 */
export function swapSoapItems(items, soapItem) {
  const out = [];
  let inserted = false;
  for (const it of items) {
    // A soap PDP link OR an existing Soap collection link is an insertion
    // point. Treating only the PDPs as one would drop an already-placed Soap
    // item and re-append it at the END of the menu on a second run — the
    // early-return in main() means that never fires today, but a function that
    // silently reorders the live header when called twice is a trap.
    if (isReplaced(it) || linksToCollection(it)) {
      if (!inserted) { out.push(soapItem); inserted = true; }
      continue;
    }
    out.push(it);
  }
  if (!inserted) out.push(soapItem);
  return out;
}

async function resolveProduct(handle) {
  const r = await shopifyGraphQL(
    'query($h:String!){ productByHandle(handle:$h){ id title handle status } }',
    { h: handle },
  );
  return r.productByHandle;
}

async function findExistingCollection() {
  const custom = await getCustomCollections({ handle: COLLECTION_HANDLE });
  if (custom.length) return { ...custom[0], kind: 'custom' };
  const r = await shopifyGraphQL(
    `query($h:String!){ collectionByHandle(handle:$h){ id handle title
      productsCount { count } ruleSet { rules { column } } } }`,
    { h: COLLECTION_HANDLE },
  );
  const c = r.collectionByHandle;
  return c ? { id: numericId(c.id), gid: c.id, handle: c.handle, title: c.title, kind: c.ruleSet ? 'smart' : 'custom' } : null;
}

async function main() {
  console.log(`Soap collection + header nav — ${apply ? 'APPLY' : 'DRY RUN'}${only ? ` (only: ${only})` : ''}\n`);

  // ── GATE: the description is commercial copy on a published surface ───────
  const gate = checkSeoCopyFields({ 'collection title': COLLECTION_TITLE, body: DESCRIPTION });
  if (!gate.ok) {
    throw new Error(
      `collection copy failed the health-claim gate: ${gate.blocking
        .map((v) => `${v.field}: ${v.category} "${v.match}"`)
        .join('; ')}`,
    );
  }
  console.log('  ✓ collection copy passes the SEO-copy health gate');
  for (const a of gate.advisory) console.log(`    · advisory (${a.category}): "${a.match}" — not blocking`);

  // ── Resolve the three products. All three or nothing. ─────────────────────
  const products = [];
  for (const s of SOAP_PRODUCTS) {
    const p = await resolveProduct(s.handle);
    if (!p) throw new Error(`product ${s.handle} not found — refusing to build a partial soap collection.`);
    if (p.status !== 'ACTIVE') throw new Error(`product ${s.handle} is ${p.status} — refusing to link a non-purchasable product.`);
    products.push({ ...s, gid: p.id, id: numericId(p.id), title: p.title });
  }
  console.log(`  ✓ ${products.length} ACTIVE soap products resolved`);
  for (const p of products) console.log(`      · ${p.title} (${p.handle})`);

  // ── COLLECTION ────────────────────────────────────────────────────────────
  let collection = await findExistingCollection();
  const collectionPlanned = !collection && (!only || only === 'collection');

  if (collection) {
    console.log(`\n  = /collections/${COLLECTION_HANDLE} already exists (${collection.kind}, id ${collection.id})`);
  } else if (only === 'menus') {
    throw new Error(`/collections/${COLLECTION_HANDLE} does not exist — refusing to point the menu at a 404. Run without --only menus.`);
  } else {
    console.log(`\n  PLANNED: create manual collection "${COLLECTION_TITLE}" at ${COLLECTION_URL}, published, with ${products.length} products`);
  }

  if (apply && collectionPlanned) {
    collection = await createCustomCollection({
      title: COLLECTION_TITLE,
      handle: COLLECTION_HANDLE,
      body_html: DESCRIPTION,
      published: true,
      sort_order: 'manual',
    });
    console.log(`  ✓ created collection ${collection.id}`);
    for (const p of products) {
      await createCollect(collection.id, Number(p.id));
      console.log(`      + ${p.handle}`);
    }
  }

  // The menu item needs the collection's GID, which only exists once created.
  const collectionGid = collection
    ? (collection.gid || `gid://shopify/Collection/${collection.id}`)
    : null;

  // ── MENUS ─────────────────────────────────────────────────────────────────
  const plan = [];
  if (!only || only === 'menus') {
    const soapItem = {
      title: NAV_TITLE,
      type: 'COLLECTION',
      url: COLLECTION_URL,
      ...(collectionGid ? { resourceId: collectionGid } : {}),
      items: [],
    };

    const { menus } = await shopifyGraphQL(Q_MENUS);
    const byHandle = Object.fromEntries(menus.nodes.map((m) => [m.handle, m]));

    // DESKTOP — a flat list; the two soap PDPs sit at positions 5 and 6.
    const desktop = byHandle[DESKTOP_MENU];
    if (!desktop) console.log(`  ! menu "${DESKTOP_MENU}" not found — desktop skipped`);
    else if (!desktop.items.some(isReplaced) && desktop.items.some(linksToCollection)) {
      console.log(`  = ${DESKTOP_MENU} (desktop): already collapsed to a single Soap link`);
    } else {
      const items = swapSoapItems(toInput(desktop.items), soapItem);
      plan.push({
        menu: desktop,
        items,
        what: `${DESKTOP_MENU} (desktop): ${desktop.items.filter(isReplaced).length} soap link(s) → one "${NAV_TITLE}" → ${items.map((i) => i.title).join(' · ')}`,
      });
    }

    // MOBILE — the same swap, but inside the `Shop` accordion's children.
    const mobile = byHandle[MOBILE_MENU];
    const shop = mobile?.items.find((it) => it.title === MOBILE_PARENT);
    if (!mobile) console.log(`  ! menu "${MOBILE_MENU}" not found — mobile skipped`);
    else if (!shop) console.log(`  ! "${MOBILE_PARENT}" not found in ${MOBILE_MENU} — mobile skipped`);
    else if (!(shop.items || []).some(isReplaced) && (shop.items || []).some(linksToCollection)) {
      console.log(`  = ${MOBILE_MENU} (mobile): already collapsed to a single Soap link`);
    } else {
      const children = swapSoapItems(toInput(shop.items || []), soapItem);
      const items = toInput(mobile.items).map((it) => (it.title === MOBILE_PARENT ? { ...it, items: children } : it));
      plan.push({
        menu: mobile,
        items,
        what: `${MOBILE_MENU} (mobile): ${(shop.items || []).filter(isReplaced).length} soap link(s) under "${MOBILE_PARENT}" → one "${NAV_TITLE}" → ${children.map((i) => i.title).join(' · ')}`,
      });
    }
  }

  if (plan.length) {
    console.log('\nPLANNED:');
    for (const p of plan) console.log(`  - ${p.what}`);
  }

  if (!plan.length && !collectionPlanned) {
    console.log('\nNothing to do.');
    return;
  }

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
    if (errs.length) {
      throw new Error(`menuUpdate(${p.menu.handle}) failed: ${errs.map((e) => `${e.field}: ${e.message}`).join('; ')}`);
    }
    console.log(`  ✓ ${p.menu.handle}`);
  }

  console.log('\nVerify on the RENDERED page — desktop and mobile draw DIFFERENT menus:');
  console.log(`  curl -s -o /dev/null -w '%{http_code}\\n' https://www.realskincare.com${COLLECTION_URL}`);
  console.log("  curl -s https://www.realskincare.com/ | grep -c 'header__inline-menu'      # desktop");
  console.log("  curl -s https://www.realskincare.com/ | grep -c 'menu-drawer__navigation'  # mobile");
}

// Guarded so a test can import `swapSoapItems` without running the whole script
// against live Shopify. See the "Importing an agent must not run it" rule.
if (isDirectRun(import.meta.url)) {
  main().catch((e) => { console.error(`\n${e.message}`); process.exit(1); });
}
