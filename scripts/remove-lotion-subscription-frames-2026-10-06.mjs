#!/usr/bin/env node
/**
 * Take the subscription offer out of the coconut-lotion PDP gallery.
 *
 *   node scripts/remove-lotion-subscription-frames-2026-10-06.mjs            # dry run
 *   node scripts/remove-lotion-subscription-frames-2026-10-06.mjs --apply
 *
 * Lotion sells no new subscriptions since 2026-10-05 (multi-unit over
 * subscriptions); PR #1019 suppressed the Recurpay widget. Two gallery frames
 * still sold the subscription in their PIXELS and alt text:
 *
 *   - clean-offer.jpg: the whole frame is "SUBSCRIBE & SAVE 15%". Removed, not
 *     replaced (the ladder and the guarantee frame carry the offer now).
 *   - coconut-lotion-ingredients-pdp.jpg: a "Subscribe & save 15%" badge and the
 *     same line in its alt. Replaced in the SAME gallery position by the
 *     re-rendered frame (data/brand/frames/coconut-lotion, badge removed).
 *
 * DETACH, NEVER DELETE. Deleting a product image destroys the CDN file, and the
 * old ingredients frame is still referenced by URL from
 * assets/digital/image-map.json (field guide PDF). `fileUpdate` with
 * `referencesToRemove` drops the image from the product's gallery and leaves
 * the file in the Files library, so this is reversible with `referencesToAdd`.
 * Full-resolution copies are archived first anyway, and the run refuses to
 * detach anything whose archive copy is missing.
 *
 * Idempotent: an already-uploaded v2 frame is not uploaded again, and an
 * already-detached image is skipped.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getAccessToken, shopifyGraphQL } from '../lib/shopify.js';
import { API_VERSION } from '../lib/shopify-api-version.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = process.cwd();
const HANDLE = 'coconut-lotion';
const ARCHIVE = join(ROOT, 'data', 'archive', 'lotion-subscription-frames-2026-10-06');
const NEW_FRAME = join(ROOT, 'data', 'brand', 'pdp-frames', 'coconut-lotion', 'coconut-lotion-ingredients-pdp.jpg');
const NEW_PROVENANCE = NEW_FRAME.replace(/\.jpg$/, '.provenance.json');
const NEW_FILENAME = 'coconut-lotion-ingredients-pdp-v2.jpg';

export const DETACH = ['clean-offer.jpg', 'coconut-lotion-ingredients-pdp.jpg'];
const REPLACES = 'coconut-lotion-ingredients-pdp.jpg';

/** Shopify file name of a CDN URL, without the query string. */
export const fileName = (url) => url.split('/').pop().split('?')[0];

/** Subscription wording that must not appear on the replacement frame's alt. */
export const SUBSCRIPTION_COPY = /subscri|save 15%/i;

async function main() {
  const APPLY = process.argv.includes('--apply');
  const env = Object.fromEntries(
    readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }),
  );
  const base = `https://${env.SHOPIFY_STORE}/admin/api/${API_VERSION}`;
  const headers = { 'X-Shopify-Access-Token': await getAccessToken(), 'Content-Type': 'application/json' };

  const alt = JSON.parse(readFileSync(NEW_PROVENANCE, 'utf8')).alt;
  if (SUBSCRIPTION_COPY.test(alt)) throw new Error(`replacement alt still sells a subscription: ${alt}`);

  const readGallery = async () => {
    const r = await shopifyGraphQL(`query LotionMedia($handle: String!) { productByIdentifier(identifier: {handle: $handle}) {
      id media(first: 50) { nodes { id alt mediaContentType ... on MediaImage { image { url } } } } } }`, { handle: HANDLE });
    const p = r.productByIdentifier;
    const rest = await (await fetch(`${base}/products/${p.id.split('/').pop()}/images.json`, { headers })).json();
    return { productGid: p.id, productId: p.id.split('/').pop(), media: p.media.nodes, images: rest.images };
  };

  let g = await readGallery();
  console.log(`${HANDLE} ${g.productId}: ${g.images.length} images\n`);

  // ── 1. Archive the full-resolution originals of everything we detach ──────
  mkdirSync(ARCHIVE, { recursive: true });
  const targets = [];
  for (const name of DETACH) {
    const m = g.media.find((n) => n.image && fileName(n.image.url) === name);
    if (!m) { console.log(`SKIP    ${name} — not on the product (already detached?)`); continue; }
    const dest = join(ARCHIVE, name);
    if (!existsSync(dest)) {
      const res = await fetch(m.image.url.split('?')[0]);
      if (!res.ok) throw new Error(`could not download ${name} (${res.status}) — refusing to detach without an archive copy`);
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    }
    console.log(`ARCHIVE ${name} → ${dest.replace(ROOT + '/', '')}`);
    targets.push({ name, id: m.id, alt: m.alt });
  }
  writeFileSync(join(ARCHIVE, 'detached.json'), `${JSON.stringify({
    product: HANDLE, productGid: g.productGid, at: new Date().toISOString(), detached: targets,
    restore: 'fileUpdate(files:[{id, referencesToAdd:[productGid]}]) for each, then reorder',
  }, null, 2)}\n`);

  // ── 2. Upload the replacement into the old frame's gallery position ───────
  const old = g.images.find((i) => fileName(i.src) === REPLACES);
  const already = g.images.find((i) => fileName(i.src).startsWith(NEW_FILENAME.replace(/\.jpg$/, '')));
  if (already) {
    console.log(`\nSKIP    ${NEW_FILENAME} — already on the product (position ${already.position})`);
  } else {
    if (!old) throw new Error(`neither ${REPLACES} nor ${NEW_FILENAME} is on the product — nothing to replace`);
    console.log(`\n${APPLY ? 'UPLOAD ' : 'DRY    '} ${NEW_FILENAME} → position ${old.position}\n        alt: ${alt}`);
    if (APPLY) {
      const res = await fetch(`${base}/products/${g.productId}/images.json`, {
        method: 'POST', headers,
        body: JSON.stringify({ image: { attachment: readFileSync(NEW_FRAME).toString('base64'), filename: NEW_FILENAME, alt, position: old.position } }),
      });
      const body = await res.json();
      if (!res.ok || !body.image) throw new Error(`upload failed ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
      console.log(`        ✓ image ${body.image.id} at position ${body.image.position}`);
    }
  }

  // ── 3. Detach (never delete) ─────────────────────────────────────────────
  for (const t of targets) {
    console.log(`${APPLY ? 'DETACH ' : 'DRY    '} ${t.name} (${t.id})`);
    if (!APPLY) continue;
    const r = await shopifyGraphQL(`mutation Detach($files: [FileUpdateInput!]!) { fileUpdate(files: $files) {
      files { id } userErrors { field message code } } }`, { files: [{ id: t.id, referencesToRemove: [g.productGid] }] });
    const errs = r.fileUpdate.userErrors;
    if (errs.length) throw new Error(`detach ${t.name}: ${JSON.stringify(errs)}`);
    console.log('        ✓ detached (file kept in the Files library)');
  }

  if (!APPLY) { console.log('\nDry run. Re-run with --apply to write.'); return; }

  await new Promise((r) => setTimeout(r, 2500));
  g = await readGallery();
  console.log(`\nLIVE GALLERY (${g.images.length} images):`);
  for (const im of g.images.sort((a, b) => a.position - b.position)) {
    const flag = SUBSCRIPTION_COPY.test(im.alt ?? '') ? '   ⚠ SUBSCRIPTION ALT' : '';
    console.log(`  ${String(im.position).padStart(2)}  ${fileName(im.src).slice(0, 52)}${flag}`);
  }
  const left = g.images.filter((i) => DETACH.includes(fileName(i.src)) || SUBSCRIPTION_COPY.test(i.alt ?? ''));
  if (left.length) throw new Error(`still on the gallery: ${left.map((i) => fileName(i.src)).join(', ')}`);
}

if (isDirectRun(import.meta.url)) await main();
