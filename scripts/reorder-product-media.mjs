#!/usr/bin/env node
/**
 * Move one product image to a gallery position. Dry by default; --apply writes.
 *
 *   node scripts/reorder-product-media.mjs <handle> <filename-substring> <position> [--apply]
 *
 * `position` is 1-based, as the gallery reads. Reordering is the REVERSIBLE gallery
 * edit — deleting an image destroys its CDN file (CLAUDE.md, 2026-08-12) — and it
 * never touches variant attachments.
 *
 * POSITION 1 IS REFUSED. Media position 1 is the product's featured image: it is
 * what collection cards, the cart thumbnail and the Google Shopping feed use, and a
 * text-overlay frame there gets a Shopping item flagged. On the landing-page-*
 * templates (hide_variants: true) the selected scent's own attached bottle shot
 * renders first anyway, so the first MARKETING slot is the first product-level
 * position after the variant images — position 6 on the lotion.
 */

import { shopifyGraphQL } from '../lib/shopify.js';
import { isDirectRun } from '../lib/is-direct-run.js';

/**
 * Pure. `nodes` is the product's media in current order ([{ id, url }]).
 * Returns { id, from, to } with 1-based positions, or throws.
 */
export function planMove(nodes, match, position) {
  if (!Number.isInteger(position) || position < 2) {
    throw new Error(`position must be an integer ≥ 2 (got ${position}); position 1 is the featured image`);
  }
  if (position > nodes.length) throw new Error(`position ${position} is past the last of ${nodes.length} images`);
  const hits = nodes.map((n, i) => ({ ...n, i })).filter((n) => (n.url || '').includes(match));
  if (hits.length !== 1) throw new Error(`"${match}" matched ${hits.length} images; it must match exactly one`);
  return { id: hits[0].id, from: hits[0].i + 1, to: position };
}

async function mediaOrder(handle) {
  const r = await shopifyGraphQL(
    `query($h:String!){ productByIdentifier(identifier:{handle:$h}){ id media(first:100){nodes{ id ... on MediaImage { image { url } } }} } }`,
    { h: handle },
  );
  const p = r.productByIdentifier;
  if (!p) throw new Error(`no product with handle ${handle}`);
  return { productId: p.id, nodes: p.media.nodes.map((m) => ({ id: m.id, url: m.image?.url?.split('?')[0] || '' })) };
}

async function main() {
  const [handle, match, pos] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const APPLY = process.argv.includes('--apply');
  if (!handle || !match || !pos) {
    console.error('usage: reorder-product-media.mjs <handle> <filename-substring> <position> [--apply]');
    process.exit(2);
  }
  const { productId, nodes } = await mediaOrder(handle);
  const move = planMove(nodes, match, Number(pos));
  console.log(`${handle}: ${match} is at ${move.from} → ${move.to} (of ${nodes.length})`);
  if (move.from === move.to) { console.log('already in place'); return; }
  if (!APPLY) { console.log('dry run — pass --apply to move'); return; }

  const res = await shopifyGraphQL(
    `mutation($id:ID!,$moves:[MoveInput!]!){ productReorderMedia(id:$id, moves:$moves){ job{ id done } mediaUserErrors{ field message } } }`,
    { id: productId, moves: [{ id: move.id, newPosition: String(move.to - 1) }] },
  );
  const errs = res.productReorderMedia.mediaUserErrors;
  if (errs.length) throw new Error(JSON.stringify(errs));

  // The reorder runs as a background job; read the order back rather than trusting it.
  for (let i = 0; i < 15; i++) {
    const after = await mediaOrder(handle);
    const at = after.nodes.findIndex((n) => n.id === move.id) + 1;
    if (at === move.to) { console.log(`verified: now at position ${at}`); return; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('reorder job did not land within 30s — re-read the gallery before retrying');
}

if (isDirectRun(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
