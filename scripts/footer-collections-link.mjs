/**
 * Footer "Collections" link, applied 2026-07-27.
 *
 * IMPORTANT THEME FACT, learned the hard way: this theme's footer does NOT render
 * the menu whose handle is `footer`. `sections/footer-group.json` references
 * `multi-main` and `one-footer`. Adding items to the `footer` menu is invisible.
 *
 * So the footer's link to the collections index is `multi-main`'s top-level item
 * (retargeted to /collections during the consolidation, then relabelled here from
 * "Shop" to "Collections"). This script also strips the dead /collections item that
 * had been added to the unrendered `footer` menu.
 *
 * Verifying footer content from page source: do NOT slice on the last `<footer` tag,
 * it does not bound what you think. Search the whole document.
 *
 * Dry-run by default; --apply to write.
 */

import { shopifyGraphQL } from '../lib/shopify.js';
const apply = process.argv.includes('--apply');
const Q = `{ menus(first: 20) { nodes { id handle title items { id title type url resourceId items { id title type url resourceId } } } } }`;
const M = `mutation menuUpdate($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
  menuUpdate(id: $id, title: $title, handle: $handle, items: $items) { menu { id } userErrors { field message } } }`;
const toInput = (items) => items.map((it) => ({
  ...(it.id ? { id: it.id } : {}), title: it.title, type: it.type, url: it.url,
  ...(it.resourceId ? { resourceId: it.resourceId } : {}),
  items: (it.items || []).map((c) => ({
    ...(c.id ? { id: c.id } : {}), title: c.title, type: c.type, url: c.url,
    ...(c.resourceId ? { resourceId: c.resourceId } : {}),
  })),
}));
const { menus } = await shopifyGraphQL(Q);

// 1. multi-main renders in the footer: relabel its /collections item "Collections".
const mm = menus.nodes.find((m) => m.handle === 'multi-main');
const mmItems = mm.items.map((it) => (it.url === '/collections' && it.title !== 'Collections')
  ? { ...it, title: 'Collections' } : it);
const renamed = mmItems.some((it, i) => it.title !== mm.items[i].title);
console.log(`multi-main: ${renamed ? 'renaming Shop -> Collections' : 'already labelled Collections'}`);

// 2. The `footer` menu is NOT rendered by this theme; drop the Collections item I added there.
const fm = menus.nodes.find((m) => m.handle === 'footer');
const fmItems = fm.items.filter((it) => it.url !== '/collections');
const removed = fm.items.length - fmItems.length;
console.log(`footer menu (unrendered): removing ${removed} dead /collections item(s)`);

if (!apply) { console.log('\nDry run: nothing written.'); process.exit(0); }
for (const [m, items] of [[mm, mmItems], [fm, fmItems]]) {
  const r = await shopifyGraphQL(M, { id: m.id, title: m.title, handle: m.handle, items: toInput(items) });
  if (r.menuUpdate.userErrors?.length) throw new Error(`${m.handle}: ${r.menuUpdate.userErrors.map(e=>e.message).join('; ')}`);
  console.log(`✓ ${m.handle} updated`);
}
