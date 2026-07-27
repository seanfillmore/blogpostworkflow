/**
 * Emit roster entries for bundles that already exist in Shopify.
 *
 *   node scripts/roster-from-shopify.mjs [handle …]
 *
 * Read-only. Prints JSON to stdout for pasting into config/bundles.json, so the
 * five live bundles are described by what they actually ship rather than by
 * what anyone remembers. Editorial fields (story, lander) come out empty and
 * are filled by hand.
 */

import { shopifyGraphQL } from '../lib/shopify.js';

const only = process.argv.slice(2);

const q = `{
  products(first: 10, query: "tag:bundle") {
    pageInfo { hasNextPage }
    nodes {
      handle title status templateSuffix tags
      variants(first: 20) {
        pageInfo { hasNextPage }
        nodes {
          title price compareAtPrice
          selectedOptions { name value }
          metafield(namespace: "bundle", key: "contents") { value }
          productVariantComponents(first: 10) {
            nodes { quantity productVariant { title product { handle } } }
          }
        }
      }
      options { name values }
    }
  }
}`;

const { products } = await shopifyGraphQL(q);

if (products.pageInfo.hasNextPage) {
  throw new Error(
    'roster-from-shopify: products(first: 10, query: "tag:bundle") has more pages — ' +
    'more than 10 bundle-tagged products now exist in Shopify. Raise `first` on the ' +
    'products connection (and re-check the query cost budget) before trusting this output.'
  );
}
for (const p of products.nodes) {
  if (p.variants.pageInfo.hasNextPage) {
    throw new Error(
      `roster-from-shopify: "${p.handle}" has more than 20 variants — ` +
      'variants(first: 20) truncated silently. Raise `first` on the variants connection ' +
      '(and re-check the query cost budget) before trusting this output.'
    );
  }
}

const bundles = products.nodes
  .filter(p => p.variants.nodes.some(v => v.productVariantComponents.nodes.length))
  .filter(p => !only.length || only.includes(p.handle))
  .map(p => ({
    handle: p.handle,
    title: p.title,
    status: p.status === 'ACTIVE' ? 'live' : 'draft',
    templateSuffix: p.templateSuffix || null,
    packaging: 0,
    tags: p.tags,
    collections: [],
    story: '',
    options: p.options.map(o => ({ name: o.name, values: o.values })),
    variants: p.variants.nodes.map(v => ({
      options: Object.fromEntries(v.selectedOptions.map(o => [o.name, o.value])),
      price: Number(v.price),
      compareAtPrice: v.compareAtPrice ? Number(v.compareAtPrice) : null,
      contents: v.metafield?.value ?? '',
      components: v.productVariantComponents.nodes.map(c => ({
        product: c.productVariant.product.handle,
        variant: c.productVariant.title,
        qty: c.quantity,
      })),
    })),
  }));

console.log(JSON.stringify({ bundles }, null, 2));
