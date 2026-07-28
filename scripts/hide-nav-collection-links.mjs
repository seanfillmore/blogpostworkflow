/**
 * Hide every collection-typed link from `product-menu` and `main-menu`.
 *
 * Applied 2026-07-27 at Sean's request ("hide sets and collections from the main
 * menu for now"). Removed: `Sets & Bundles` from the header, and `Shop`
 * (-> /collections) plus `On Sale` from main-menu.
 *
 * Dry-run by default; --apply to write.
 *
 * TO REVERSE: the pre-change menu trees are in
 *   data/reports/collection-consolidation/nav-before-hide-2026-07-28.json
 * Feed those `items` arrays back through `menuUpdate` with the same id/title/handle.
 *
 * CAUTION: `scripts/update-navigation.mjs --apply` re-adds the `Sets & Bundles`
 * item. If that script is ever re-run, re-run this one afterwards, or the header
 * link comes back.
 */

import { shopifyGraphQL } from '../lib/shopify.js';
import { writeFileSync, mkdirSync } from 'node:fs';

const apply = process.argv.includes('--apply');
const Q = `{ menus(first: 20) { nodes { id handle title items { id title type url resourceId items { id title type url resourceId } } } } }`;
const M = `mutation menuUpdate($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
  menuUpdate(id: $id, title: $title, handle: $handle, items: $items) { menu { id } userErrors { field message } } }`;

const isCollectionish = (it) =>
  it.type === 'COLLECTION' || it.type === 'COLLECTIONS' || /^\/collections(\/|$)/.test(it.url || '');

const toInput = (items) => items.map((it) => ({
  id: it.id, title: it.title, type: it.type, url: it.url,
  ...(it.resourceId ? { resourceId: it.resourceId } : {}),
  items: (it.items || []).map((c) => ({
    id: c.id, title: c.title, type: c.type, url: c.url,
    ...(c.resourceId ? { resourceId: c.resourceId } : {}),
  })),
}));

const { menus } = await shopifyGraphQL(Q);
const targets = menus.nodes.filter((m) => ['product-menu', 'main-menu'].includes(m.handle));

mkdirSync('data/reports/collection-consolidation', { recursive: true });
const backupPath = 'data/reports/collection-consolidation/nav-before-hide-2026-07-28.json';
writeFileSync(backupPath, JSON.stringify(targets, null, 1));
console.log(`before-state saved -> ${backupPath}`);

for (const m of targets) {
  const kept = m.items.filter((it) => !isCollectionish(it));
  const dropped = m.items.filter(isCollectionish);
  console.log(`\n${m.handle}: ${m.items.length} -> ${kept.length} top-level`);
  dropped.forEach((d) => console.log(`   removing: ${d.title} [${d.type}] ${d.url}`));
  kept.forEach((k) => console.log(`   keeping:  ${k.title} [${k.type}] ${k.url}`));
  if (!apply) continue;
  const res = await shopifyGraphQL(M, { id: m.id, title: m.title, handle: m.handle, items: toInput(kept) });
  const errs = res.menuUpdate.userErrors;
  if (errs?.length) throw new Error(`${m.handle}: ${errs.map((e) => e.message).join('; ')}`);
  console.log(`   ✓ ${m.handle} updated`);
}
if (!apply) console.log('\nDry run: nothing written. Re-run with --apply.');
