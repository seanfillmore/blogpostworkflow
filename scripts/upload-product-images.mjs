#!/usr/bin/env node
/**
 * Upload product images to Shopify, optionally attaching each to a specific variant.
 *
 *   node scripts/upload-product-images.mjs <manifest.json> [--apply]
 *
 * Manifest:
 *   {
 *     "product": "99-coconut-reset-digital",
 *     "images": [
 *       { "file": "/abs/path.jpg", "alt": "…", "variant": "Coconut Breeze" }
 *     ]
 *   }
 *
 * `variant` is optional. When present the image is attached to that variant, so a buyer
 * who picks Pure Unscented sees the unscented kit — the media plan's rule that a frame
 * must never depict a kit nobody receives.
 *
 * `alt` is REQUIRED and the script refuses to upload without it. Bundle galleries in this
 * store already have images with no alt text; every one is invisible to a screen reader
 * and worth nothing for search.
 *
 * Optimise before running. ImageMagick at quality 85 took these 2048² heroes from ~2 MB to
 * ~300 KB with no visible loss:
 *   magick in.jpg -colorspace sRGB -strip -quality 85 -interlace Plane -sampling-factor 4:2:0 out.jpg
 * Upload the full-resolution original — Shopify generates its own responsive sizes and
 * WebP/AVIF variants from it, so downscaling first only throws away zoom detail.
 */

import { readFileSync, statSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessToken } from '../lib/shopify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const [manifestPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const APPLY = process.argv.includes('--apply');
if (!manifestPath) { console.error('usage: upload-product-images.mjs <manifest.json> [--apply]'); process.exit(2); }

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const token = await getAccessToken();

const gql = async (query, variables) => {
  const r = await fetch(`https://${env.SHOPIFY_STORE}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 400));
  return j.data;
};

const product = (await gql(
  `query($h:String!){ productByHandle(handle:$h){ id title media(first:50){edges{node{id}}}
     variants(first:100){edges{node{ id title }}} } }`,
  { h: manifest.product },
)).productByHandle;
if (!product) throw new Error(`no product with handle ${manifest.product}`);

const variantIdByTitle = new Map(product.variants.edges.map((e) => [e.node.title, e.node.id]));

console.log(`${product.title}  (${manifest.product})`);
console.log(`  existing media: ${product.media.edges.length}`);

for (const img of manifest.images) {
  if (!img.alt?.trim()) throw new Error(`${img.file}: alt text is required`);
  const size = statSync(img.file).size;
  const v = img.variant
    ? product.variants.edges.map((e) => e.node).find((n) => n.title === img.variant)
    : null;
  if (img.variant && !v) throw new Error(`${img.file}: no variant titled "${img.variant}"`);
  console.log(`  ${basename(img.file).padEnd(34)} ${String(Math.round(size / 1024)).padStart(4)} KB  → ${img.variant ?? '(product-level)'}`);
  console.log(`     alt: ${img.alt}`);
}

// Preflight: a Shopify variant holds EXACTLY ONE media. ProductVariantAppendMediaInput
// takes a `mediaIds` list and the reference docs describe "appending", both of which
// suggest otherwise, but the API rejects a second one two different ways: appending to
// an occupied variant gives "The given variant already has attached media", and passing
// two ids at once gives "Only one mediaId is allowed per media input". Detaching first
// is NOT the workaround — a detach that succeeds followed by an append that fails leaves
// the variant with no image at all, which is a live regression on a product page.
//
// So this is checked here, before a single byte is uploaded. Once a bundle's hero owns
// the variant slot, every later frame belongs at product level.
const occupied = [];
for (const img of manifest.images) {
  if (!img.variant) continue;
  const v = (await gql(
    `query($id:ID!){ node(id:$id){ ... on ProductVariant { media(first:5){edges{node{id}}} } } }`,
    { id: variantIdByTitle.get(img.variant) },
  )).node;
  if (v.media.edges.length) occupied.push({ file: basename(img.file), variant: img.variant });
}
if (occupied.length) {
  console.error('\nRefusing to upload — a variant can hold only one media, and these are taken:');
  for (const o of occupied) console.error(`  ${o.file}  →  "${o.variant}" already has an image`);
  console.error('\nDrop the "variant" key from these entries to attach them at product level instead.');
  process.exit(1);
}

if (!APPLY) { console.log('\ndry run — pass --apply to upload'); process.exit(0); }

for (const img of manifest.images) {
  const filename = basename(img.file);
  const bytes = readFileSync(img.file);

  // 1. staged target
  const staged = (await gql(
    `mutation($input:[StagedUploadInput!]!){ stagedUploadsCreate(input:$input){
       stagedTargets{ url resourceUrl parameters{name value} } userErrors{field message} } }`,
    { input: [{ filename, mimeType: 'image/jpeg', resource: 'IMAGE', httpMethod: 'POST' }] },
  )).stagedUploadsCreate;
  if (staged.userErrors.length) throw new Error(JSON.stringify(staged.userErrors));
  const target = staged.stagedTargets[0];

  // 2. upload the bytes
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([bytes], { type: 'image/jpeg' }), filename);
  const up = await fetch(target.url, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
  if (!up.ok) throw new Error(`${filename}: staged upload failed HTTP ${up.status}`);

  // 3. attach to the product
  const created = (await gql(
    `mutation($productId:ID!,$media:[CreateMediaInput!]!){ productCreateMedia(productId:$productId, media:$media){
       media{ ... on MediaImage { id status } } mediaUserErrors{field message} } }`,
    { productId: product.id, media: [{ originalSource: target.resourceUrl, alt: img.alt, mediaContentType: 'IMAGE' }] },
  )).productCreateMedia;
  if (created.mediaUserErrors.length) throw new Error(JSON.stringify(created.mediaUserErrors));
  const mediaId = created.media[0].id;

  // 4. Shopify processes asynchronously; a variant cannot be given media still UPLOADED.
  let status = created.media[0].status;
  for (let i = 0; i < 30 && status !== 'READY'; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    status = (await gql(`query($id:ID!){ node(id:$id){ ... on MediaImage { status } } }`, { id: mediaId }))?.node?.status;
    if (status === 'FAILED') throw new Error(`${filename}: Shopify failed to process the image`);
  }
  if (status !== 'READY') throw new Error(`${filename}: still ${status} after 60s`);

  // 5. attach to the variant, if one was named. Preflight has already established
  // the variant is empty, so this is a plain append.
  if (img.variant) {
    const app = (await gql(
      `mutation($productId:ID!,$variantMedia:[ProductVariantAppendMediaInput!]!){
         productVariantAppendMedia(productId:$productId, variantMedia:$variantMedia){
           userErrors{field message} } }`,
      { productId: product.id, variantMedia: [{ variantId: variantIdByTitle.get(img.variant), mediaIds: [mediaId] }] },
    )).productVariantAppendMedia;
    if (app.userErrors.length) throw new Error(`append: ${JSON.stringify(app.userErrors)}`);
  }

  console.log(`✓ ${filename} → ${img.variant ?? 'product'}  (${mediaId.split('/').pop()})`);
}

const after = (await gql(`query($h:String!){ productByHandle(handle:$h){ media(first:50){edges{node{id}}} } }`, { h: manifest.product }))
  .productByHandle.media.edges.length;
console.log(`\nmedia count: ${product.media.edges.length} → ${after}`);
