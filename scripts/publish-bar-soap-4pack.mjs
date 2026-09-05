/**
 * SUPERSEDED — kept only as the historical record of how the 4-pack was first
 * published, not as a script to run again.
 *
 * The roster path now owns this product: `config/bundles.json` (handle
 * "coconut-bar-soap-4-pack") is the source of truth, and
 * `scripts/build-bundle.mjs coconut-bar-soap-4-pack [--apply]` is what
 * reconciles it. Do not run this script to republish or re-fix the 4-pack —
 * use build-bundle.mjs instead.
 *
 * Its channel list below (Buy Button, Pinterest, TikTok, in addition to
 * Online Store and Shop) predates the discovery that only Online Store and
 * Shop actually accept componentized bundles — every other channel either
 * refuses them outright or silently carries phantom sellable inventory.
 * build-bundle.mjs's PUBLICATIONS list deliberately only contains Online
 * Store and Shop; do not copy this script's longer list into it.
 *
 * Not deleted because it is still the record of how the 4-pack went live —
 * see WHY THIS EXISTS below.
 *
 * Finish and publish the Coconut Bar Soap — 4-Pack.
 *
 *   node scripts/publish-bar-soap-4pack.mjs [--apply]
 *
 * WHY THIS EXISTS
 *   The 4-pack was componentized (5 variants, correct components, correct price
 *   split) and then left as a bare draft: zero media, no SEO, a one-line
 *   description, no collection, zero publications. It is the replacement for the
 *   single-bar subscription, which loses money on every shipment — so it cannot
 *   be detached until this is buyable. See docs/bundle-marketing-plan.md §3.3.
 *
 * WHAT IT DOES (idempotent — safe to re-run)
 *   1. Composites a 2x2 variety grid from the four REAL coconut-soap variant
 *      photos and uploads it as the featured image. Nothing is generated or
 *      illustrated; a buyer sees the bars they actually receive.
 *   2. Attaches those four photos to the product and pins each to its
 *      "4x <scent>" variant.
 *   3. Writes the description, SEO title and SEO description.
 *   4. Adds the product to `natural-bar-soap` (the only MANUAL soap collection —
 *      the rest are smart collections gated on VARIANT_PRICE < 20, which
 *      correctly excludes a $39 pack).
 *   5. Flips DRAFT -> ACTIVE and publishes to Online Store, Shop, Pinterest and
 *      TikTok.
 *
 * CHANNELS
 *   Every product-feed channel refuses componentized bundles, not just Google
 *   and Meta — Pinterest returns "Channel Pinterest does not support bundle
 *   products" as well. So channels are published one at a time and refusals are
 *   reported rather than aborting the run. See docs/bundle-marketing-plan.md §4.
 *
 * COPY RULE (docs/bundle-marketing-plan.md §1)
 *   Lead with cadence, never with savings-vs-single. And note $39 does NOT clear
 *   the $45 free-shipping threshold, so the copy must not imply free shipping.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { shopifyGraphQL, uploadImageToShopifyCDN } from '../lib/shopify.js';

const APPLY = process.argv.includes('--apply');
const HANDLE = 'coconut-bar-soap-4-pack';
const SOAP_HANDLE = 'coconut-soap';
const BAR_SOAP_COLLECTION = 'gid://shopify/Collection/153343197219'; // natural-bar-soap (manual)

// Attempted in order. Feed-backed channels reject bundles outright; the run
// records which refused instead of failing, because Online Store is the only
// one that actually matters for a bundle.
const PUBLICATIONS = [
  ['gid://shopify/Publication/41249308707', 'Online Store'],
  ['gid://shopify/Publication/90546471082', 'Shop'],
  ['gid://shopify/Publication/69200183466', 'Buy Button'],
  ['gid://shopify/Publication/88277811370', 'Pinterest'],
  ['gid://shopify/Publication/87801102506', 'TikTok'],
];

const GRID_ORDER = ['Calming Lavender', 'Nourishing Tea Tree', 'Refreshing Lemongrass', 'Pure Unscented'];

const VARIANT_ALT = {
  'Calming Lavender': 'Four bars of Real Skin Care calming lavender coconut oil soap',
  'Nourishing Tea Tree': 'Four bars of Real Skin Care nourishing tea tree coconut oil soap',
  'Refreshing Lemongrass': 'Four bars of Real Skin Care refreshing lemongrass coconut oil soap',
  'Pure Unscented': 'Four bars of Real Skin Care pure unscented coconut oil soap',
};

const GRID_ALT =
  'Coconut oil bar soap 4-pack — calming lavender, nourishing tea tree, refreshing lemongrass and pure unscented bars';

const DESCRIPTION = `
<p><strong>Four bars, four months, one box.</strong> Bar soap is the one thing in the bathroom that runs out on a schedule — so it may as well arrive on one.</p>
<p>Take one of every scent, or four of the bar you already reach for. Every bar is the same cold-pressed coconut oil soap sold singly: coconut oil, olive oil and essential oils, and nothing that needs explaining.</p>
<h3>Choose your four</h3>
<ul>
  <li><strong>Variety</strong> — one Calming Lavender, one Nourishing Tea Tree, one Refreshing Lemongrass, one Pure Unscented</li>
  <li><strong>4 × Calming Lavender</strong> — lavender</li>
  <li><strong>4 × Nourishing Tea Tree</strong> — tea tree</li>
  <li><strong>4 × Refreshing Lemongrass</strong> — lemongrass &amp; tea tree</li>
  <li><strong>4 × Pure Unscented</strong> — no essential oils</li>
</ul>
<h3>Set it and forget it</h3>
<p>One 3.4&nbsp;oz bar is about a month of daily use, so four is roughly a quarter and a bit. Subscribe on the four-month refill and the next box lands about the time the last bar gets thin — 15% off, cancel any time.</p>
<h3>What's in every bar</h3>
<p>Saponified coconut and olive oils, water, and essential oil where a scent is named. No SLS, no synthetic fragrance, no palm oil, no detergents. Vegan and cruelty-free.</p>
`.trim();

const SEO_TITLE = 'Coconut Bar Soap 4-Pack — Four Months of Natural Soap';
const SEO_DESCRIPTION =
  'Four bars of cold-pressed coconut oil soap: one of each scent, or four of your favorite. About four months of daily use, with a 4-month refill subscription at 15% off.';

// --------------------------------------------------------------------------

function log(...a) { console.log(...a); }
function step(n, s) { console.log(`\n[${n}] ${s}`); }

async function gql(query, variables = {}) {
  const data = await shopifyGraphQL(query, variables);
  // Surface userErrors from whichever mutation ran.
  for (const v of Object.values(data ?? {})) {
    const errs = v?.userErrors ?? v?.mediaUserErrors;
    if (errs?.length) throw new Error(errs.map((e) => `${(e.field ?? []).join('.')}: ${e.message}`).join('; '));
  }
  return data;
}

async function loadState() {
  const q = `{
    p: productByHandle(handle: "${HANDLE}") {
      id status descriptionHtml seo { title description }
      media(first: 20) { nodes { ... on MediaImage { id alt } } }
      collections(first: 30) { nodes { id handle } }
      resourcePublications(first: 20) { nodes { publication { id name } isPublished } }
      variants(first: 20) { nodes { id title inventoryQuantity price
        media(first: 5) { nodes { ... on MediaImage { id } } } } }
    }
    soap: productByHandle(handle: "${SOAP_HANDLE}") {
      variants(first: 20) { nodes { title image { url } } }
    }
  }`;
  const d = await shopifyGraphQL(q);
  if (!d.p) throw new Error(`product ${HANDLE} not found`);
  return d;
}

/** Compose a 2x2 grid of the four real bar photos. */
async function buildGrid(urls) {
  const CELL = 1000;
  const tiles = await Promise.all(
    urls.map(async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
      return sharp(Buffer.from(await res.arrayBuffer()))
        .resize(CELL, CELL, { fit: 'cover' })
        .toBuffer();
    })
  );
  const buf = await sharp({
    create: { width: CELL * 2, height: CELL * 2, channels: 3, background: '#ffffff' },
  })
    .composite([
      { input: tiles[0], top: 0, left: 0 },
      { input: tiles[1], top: 0, left: CELL },
      { input: tiles[2], top: CELL, left: 0 },
      { input: tiles[3], top: CELL, left: CELL },
    ])
    .jpeg({ quality: 88 })
    .toBuffer();
  const path = join(mkdtempSync(join(tmpdir(), 'soap4pack-')), 'coconut-bar-soap-4-pack-variety.jpg');
  writeFileSync(path, buf);
  return path;
}

async function attachMedia(productId, sources) {
  const d = await gql(
    `mutation ($id: ID!, $media: [CreateMediaInput!]!) {
      productCreateMedia(productId: $id, media: $media) {
        media { ... on MediaImage { id alt } }
        mediaUserErrors { field message }
      }
    }`,
    {
      id: productId,
      media: sources.map(([originalSource, alt]) => ({ originalSource, alt, mediaContentType: 'IMAGE' })),
    }
  );
  return d.productCreateMedia.media;
}

/** Media is processed async; ids exist immediately but READY lags. */
async function waitForMedia(productId, expected) {
  for (let i = 0; i < 20; i++) {
    const d = await shopifyGraphQL(
      `{ node(id: "${productId}") { ... on Product {
          media(first: 20) { nodes { ... on MediaImage { id alt status } } } } } }`
    );
    const nodes = d.node.media.nodes;
    const failed = nodes.filter((n) => n.status === 'FAILED');
    if (failed.length) throw new Error(`media FAILED: ${failed.map((f) => f.alt).join(', ')}`);
    if (nodes.filter((n) => n.status === 'READY').length >= expected) return nodes;
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error('media not READY in time');
}

// --------------------------------------------------------------------------

const state = await loadState();
const p = state.p;
const soapImage = Object.fromEntries(state.soap.variants.nodes.map((v) => [v.title, v.image?.url]));

log(`${HANDLE}: status=${p.status} media=${p.media.nodes.length} collections=${p.collections.nodes.length}`);
log(`published to: ${p.resourcePublications.nodes.filter((n) => n.isPublished).map((n) => n.publication.name).join(', ') || '(nothing)'}`);

const oos = p.variants.nodes.filter((v) => v.inventoryQuantity <= 0);
if (oos.length) log(`⚠️  out of stock: ${oos.map((v) => `${v.title} (${v.inventoryQuantity})`).join(', ')}`);

if (!APPLY) {
  log('\nDry run. Re-run with --apply to write.');
  process.exit(0);
}

// 1 + 2 — media
if (p.media.nodes.length === 0) {
  step(1, 'building 2x2 variety grid from the real bar photos');
  const missing = GRID_ORDER.filter((s) => !soapImage[s]);
  if (missing.length) throw new Error(`coconut-soap has no image for: ${missing.join(', ')}`);
  const gridPath = await buildGrid(GRID_ORDER.map((s) => soapImage[s]));
  log(`   composed ${gridPath}`);
  const gridUrl = await uploadImageToShopifyCDN(gridPath, GRID_ALT);
  log(`   uploaded ${gridUrl.split('/').pop()}`);

  step(2, 'attaching grid + four scent photos');
  await attachMedia(p.id, [
    [gridUrl, GRID_ALT],
    ...GRID_ORDER.map((s) => [soapImage[s], VARIANT_ALT[s]]),
  ]);
  const media = await waitForMedia(p.id, 5);
  log(`   ${media.length} media READY`);

  // Pin each single-scent variant to its own photo. The variety variant keeps
  // the grid, which is the product's featured image.
  const byAlt = Object.fromEntries(media.map((m) => [m.alt, m.id]));
  const updates = p.variants.nodes
    .map((v) => {
      const scent = GRID_ORDER.find((s) => v.title === `4x ${s}`);
      return scent && byAlt[VARIANT_ALT[scent]] ? { id: v.id, mediaId: byAlt[VARIANT_ALT[scent]] } : null;
    })
    .filter(Boolean);
  await gql(
    `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id title }
        userErrors { field message }
      }
    }`,
    { productId: p.id, variants: updates }
  );
  log(`   pinned ${updates.length} variant images`);
} else {
  step(1, `skipped — product already has ${p.media.nodes.length} media`);
}

// 3 — copy + SEO
step(3, 'writing description and SEO');
await gql(
  `mutation ($input: ProductInput!) {
    productUpdate(input: $input) { product { id } userErrors { field message } }
  }`,
  {
    input: {
      id: p.id,
      descriptionHtml: DESCRIPTION,
      seo: { title: SEO_TITLE, description: SEO_DESCRIPTION },
    },
  }
);
log(`   seo.title "${SEO_TITLE}" (${SEO_TITLE.length} chars)`);

// 4 — collection
if (!p.collections.nodes.some((c) => c.id === BAR_SOAP_COLLECTION)) {
  step(4, 'adding to natural-bar-soap');
  await gql(
    `mutation ($id: ID!, $productIds: [ID!]!) {
      collectionAddProducts(id: $id, productIds: $productIds) {
        collection { handle } userErrors { field message }
      }
    }`,
    { id: BAR_SOAP_COLLECTION, productIds: [p.id] }
  );
} else {
  step(4, 'skipped — already in natural-bar-soap');
}

// 5 — activate + publish
step(5, 'activating and publishing');
await gql(
  `mutation ($input: ProductInput!) {
    productUpdate(input: $input) { product { status } userErrors { field message } }
  }`,
  { input: { id: p.id, status: 'ACTIVE' } }
);
for (const [publicationId, name] of PUBLICATIONS) {
  try {
    await gql(
      `mutation ($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) {
          publishable { availablePublicationsCount { count } }
          userErrors { field message }
        }
      }`,
      { id: p.id, input: [{ publicationId }] }
    );
    log(`   ✓ ${name}`);
  } catch (err) {
    log(`   ✗ ${name} — ${err.message}`);
  }
}

const after = await loadState();
log(`\nstatus=${after.p.status}  media=${after.p.media.nodes.length}`);
log(`published: ${after.p.resourcePublications.nodes.filter((n) => n.isPublished).map((n) => n.publication.name).join(', ')}`);
log(`\nNext: verify the live page and run \`npm run verify-bundle-contents ${HANDLE}\`.`);
