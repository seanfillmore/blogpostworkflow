// agents/pdp-builder/lib/fetch-bundle.js
//
// READ-ONLY. A bundle's composition only exists on the GraphQL side of the
// Shopify Admin API (`productVariantComponents`), which is why bundle mode does
// not reuse the REST getProducts() call the product mode uses.
//
// There is deliberately no write path in this module. pdp-builder queues copy for
// human review; it never mutates a product, never touches `status`, and must not
// grow a mutation helper here by convenience.

import { shopifyGraphQL } from '../../../lib/shopify.js';

export const BUNDLE_QUERY = `query BundleProduct($handle: String!) {
  productByHandle(handle: $handle) {
    id
    handle
    title
    status
    productType
    tags
    descriptionHtml
    seo { title description }
    variants(first: 50) {
      nodes {
        id
        title
        price
        productVariantComponents(first: 25) {
          nodes {
            quantity
            productVariant {
              id
              title
              price
              product { id title handle }
            }
          }
        }
      }
    }
  }
}`;

/**
 * Fetches one bundle product with its variant components.
 *
 * @param {string} handle
 * @param {Object} [deps]
 * @param {Function} [deps.graphql] injection point for tests — defaults to the
 *        real read-only shopifyGraphQL call.
 * @returns {Promise<Object>} productByHandle payload
 * @throws if the handle does not resolve
 */
export async function fetchBundleProduct(handle, { graphql = shopifyGraphQL } = {}) {
  const data = await graphql(BUNDLE_QUERY, { handle });
  const product = data?.productByHandle;
  if (!product) throw new Error(`fetchBundleProduct: no product with handle "${handle}"`);
  return product;
}
