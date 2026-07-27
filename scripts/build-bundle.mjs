/**
 * Reconcile a bundle in Shopify against config/bundles.json.
 *
 *   node scripts/build-bundle.mjs <handle> [--apply]
 *   node scripts/build-bundle.mjs --all [--apply]
 *
 * Idempotent: every step reads current state and skips when already correct, so
 * a partial failure is repaired by running it again.
 *
 * ORDER MATTERS. Componentizing OVERWRITES the variant price with the sum of
 * its components, so prices are re-asserted afterwards in their own step. That
 * has shipped a wrong price to production twice.
 *
 * Channels: only Online Store and Shop accept componentized bundles. Google,
 * Meta, Pinterest, TikTok and Buy Button all refuse them, so channels are
 * published one at a time and refusals are reported, not fatal.
 */

import { shopifyGraphQL } from '../lib/shopify.js';
import { loadRoster, validateRoster } from '../lib/bundle-roster.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ALL = args.includes('--all');
const handles = args.filter(a => !a.startsWith('--'));

const PUBLICATIONS = [
  ['gid://shopify/Publication/41249308707', 'Online Store'],
  ['gid://shopify/Publication/90546471082', 'Shop'],
];

const log = (...a) => console.log(...a);

async function gql(query, variables = {}) {
  const data = await shopifyGraphQL(query, variables);
  for (const v of Object.values(data ?? {})) {
    const errs = v?.userErrors ?? v?.mediaUserErrors;
    if (errs?.length) throw new Error(errs.map(e => `${(e.field ?? []).join('.')}: ${e.message}`).join('; '));
  }
  return data;
}

/** handle -> { id, variants: { [title]: id } } for every component product. */
async function loadCatalogue() {
  const d = await shopifyGraphQL(
    `{ products(first: 50) { nodes { id handle variants(first: 50) { nodes { id title } } } } }`
  );
  const byHandle = {};
  for (const p of d.products.nodes) {
    byHandle[p.handle] = {
      id: p.id,
      variants: Object.fromEntries(p.variants.nodes.map(v => [v.title, v.id])),
    };
  }
  return byHandle;
}

async function getProduct(handle) {
  const d = await shopifyGraphQL(`{
    productByHandle(handle: "${handle}") {
      id status templateSuffix
      options { id name values }
      variants(first: 50) {
        nodes { id title price selectedOptions { name value }
          productVariantComponents(first: 20) { nodes { quantity productVariant { id } } } }
      }
      resourcePublications(first: 20) { nodes { publication { id name } isPublished } }
    }
  }`);
  return d.productByHandle;
}

const optionKey = opts => Object.entries(opts).sort(([a], [b]) => a.localeCompare(b))
  .map(([k, v]) => `${k}=${v}`).join('|');

async function buildBundle(bundle, catalogue) {
  log(`\n=== ${bundle.handle}`);
  let product = await getProduct(bundle.handle);

  // 1 — product shell
  const input = {
    title: bundle.title,
    handle: bundle.handle,
    descriptionHtml: bundle.descriptionHtml ?? '',
    templateSuffix: bundle.templateSuffix ?? null,
    tags: bundle.tags ?? [],
    status: 'ACTIVE',
    ...(bundle.seo ? { seo: bundle.seo } : {}),
  };

  if (!product) {
    log('  creating product');
    if (!APPLY) return log('  (dry run — stopping here; nothing else can be planned without an id)');
    const d = await gql(
      `mutation ($input: ProductInput!) { productCreate(input: $input) { product { id } userErrors { field message } } }`,
      { input: { ...input, productOptions: bundle.options.map(o => ({ name: o.name, values: o.values.map(v => ({ name: v })) })) } }
    );
    product = await getProduct(bundle.handle);
    log(`  created ${d.productCreate.product.id}`);
  } else if (APPLY) {
    await gql(
      `mutation ($input: ProductInput!) { productUpdate(input: $input) { product { id } userErrors { field message } } }`,
      { input: { ...input, id: product.id } }
    );
    log('  product updated');
  }

  // 2 — variants
  const existing = new Map(product.variants.nodes.map(v =>
    [optionKey(Object.fromEntries(v.selectedOptions.map(o => [o.name, o.value]))), v]));

  const missing = bundle.variants.filter(v => !existing.has(optionKey(v.options)));
  if (missing.length) {
    log(`  creating ${missing.length} variants`);
    if (APPLY) {
      await gql(
        `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkCreate(productId: $productId, variants: $variants) {
            productVariants { id } userErrors { field message } } }`,
        {
          productId: product.id,
          variants: missing.map(v => ({
            optionValues: Object.entries(v.options).map(([name, value]) => ({ optionName: name, name: value })),
            price: String(v.price),
            ...(v.compareAtPrice ? { compareAtPrice: String(v.compareAtPrice) } : {}),
          })),
        }
      );
      product = await getProduct(bundle.handle);
    }
  }

  if (!APPLY) return log('  (dry run — stopping before componentization)');

  const live = new Map(product.variants.nodes.map(v =>
    [optionKey(Object.fromEntries(v.selectedOptions.map(o => [o.name, o.value]))), v]));

  // 3 — components
  const relationships = bundle.variants.map(v => {
    const target = live.get(optionKey(v.options));
    return {
      parentProductVariantId: target.id,
      productVariantRelationshipsToUpdate: v.components.map(c => {
        const id = catalogue[c.product]?.variants[c.variant];
        if (!id) throw new Error(`no variant id for ${c.product} / ${c.variant}`);
        return { id, quantity: c.qty };
      }),
    };
  });

  await gql(
    `mutation ($input: [ProductVariantRelationshipUpdateInput!]!) {
      productVariantRelationshipBulkUpdate(input: $input) {
        parentProductVariants { id } userErrors { field message } } }`,
    { input: relationships }
  );
  log(`  componentized ${relationships.length} variants`);

  // 4 — RE-ASSERT PRICES. Componentizing just overwrote them with the component sum.
  await gql(
    `mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants { id price } userErrors { field message } } }`,
    {
      productId: product.id,
      variants: bundle.variants.map(v => ({
        id: live.get(optionKey(v.options)).id,
        price: String(v.price),
        ...(v.compareAtPrice ? { compareAtPrice: String(v.compareAtPrice) } : {}),
      })),
    }
  );
  log('  prices re-asserted after componentization');

  // 5 — metafields
  //
  // `bundle.components` / `bundle.component_qty` drive the "what's in the box"
  // cards, which are PRODUCT-level and so can only describe one basket. For a
  // single-basket bundle (every kit holds the same SKUs, differing only by
  // scent) that is exact. For the Hand Soap Set the cards describe the FIRST
  // declared configuration; the per-variant `bundle.contents` panel is what
  // tells a buyer what their selection actually contains. Order the Hand Soap
  // Set's variants so the intended default configuration is first.
  const componentHandles = [...new Set(bundle.variants.flatMap(v => v.components.map(c => c.product)))];
  const qtyByHandle = componentHandles.map(h =>
    bundle.variants[0].components.filter(c => c.product === h).reduce((s, c) => s + c.qty, 0));

  const metafields = [
    { ownerId: product.id, namespace: 'bundle', key: 'components', type: 'list.product_reference',
      value: JSON.stringify(componentHandles.map(h => catalogue[h].id)) },
    { ownerId: product.id, namespace: 'bundle', key: 'component_qty', type: 'list.number_integer',
      value: JSON.stringify(qtyByHandle) },
    ...bundle.variants
      .filter(v => v.contents)
      .map(v => ({ ownerId: live.get(optionKey(v.options)).id, namespace: 'bundle', key: 'contents',
        type: 'multi_line_text_field', value: v.contents })),
  ];

  await gql(
    `mutation ($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { metafields { id } userErrors { field message } } }`,
    { metafields }
  );
  log(`  wrote ${metafields.length} metafields`);

  // 6 — collections
  for (const gid of bundle.collections ?? []) {
    await gql(
      `mutation ($id: ID!, $productIds: [ID!]!) {
        collectionAddProducts(id: $id, productIds: $productIds) { collection { handle } userErrors { field message } } }`,
      { id: gid, productIds: [product.id] }
    );
  }

  // 7 — publish, channel by channel
  for (const [publicationId, name] of PUBLICATIONS) {
    try {
      await gql(
        `mutation ($id: ID!, $input: [PublicationInput!]!) {
          publishablePublish(id: $id, input: $input) { publishable { availablePublicationsCount { count } } userErrors { field message } } }`,
        { id: product.id, input: [{ publicationId }] }
      );
      log(`  ✓ ${name}`);
    } catch (err) {
      log(`  ✗ ${name} — ${err.message}`);
    }
  }

  log(`  done — https://www.realskincare.com/products/${bundle.handle}`);
}

// ── main ───────────────────────────────────────────────────────────────────

const roster = loadRoster();
const catalogue = await loadCatalogue();

const errors = validateRoster(roster,
  Object.fromEntries(Object.entries(catalogue).map(([h, p]) => [h, Object.keys(p.variants)])));
if (errors.length) {
  console.error('Roster is invalid — refusing to build:\n  ' + errors.join('\n  '));
  process.exit(1);
}

const targets = ALL ? roster.bundles : roster.bundles.filter(b => handles.includes(b.handle));
if (!targets.length) {
  console.error(`No bundle matched. Available: ${roster.bundles.map(b => b.handle).join(', ')}`);
  process.exit(1);
}

if (!APPLY) log('DRY RUN — re-run with --apply to write.\n');
for (const b of targets) await buildBundle(b, catalogue);
