// lib/collection-health.js
//
// Detects collection-level SEO liabilities the DataForSEO page crawl misses:
//   - EMPTY collections: published but 0 products (thin content; nothing to buy).
//   - ORPHAN collections: published but 0 inbound internal links (no equity, undiscoverable).
//
// Both were invisible to the site-crawler's orphan check (which only covers
// pages in its internal-link graph), which is why 14 empty published collections
// sat live + in the sitemap undetected until an external crawl found them. See
// [[project_*]] — the 2026-06-27 orphan-collection sweep.
//
// Pure function: the caller supplies product counts and inbound-link presence
// (gathered from Shopify + the crawl link graph); this just classifies.

/**
 * @param {Array<{handle:string, published:boolean, productCount:number, hasInlinks:boolean}>} collections
 * @param {{baseUrl:string}} opts
 * @returns {{empty:Array, orphan:Array}}
 *   empty  — published, productCount === 0 (reported here even if also orphaned: emptiness is the worse issue)
 *   orphan — published, productCount > 0, hasInlinks === false
 */
export function classifyCollectionHealth(collections, { baseUrl } = {}) {
  const base = (baseUrl || '').replace(/\/$/, '');
  const empty = [];
  const orphan = [];
  for (const c of collections || []) {
    if (!c || !c.published) continue;
    const url = `${base}/collections/${c.handle}`;
    if ((c.productCount || 0) === 0) {
      empty.push({ url, title: c.handle, status_code: 200, 'no._of_all_inlinks': c.hasInlinks ? 1 : 0, product_count: 0 });
    } else if (!c.hasInlinks) {
      orphan.push({ url, title: c.handle, status_code: 200, 'no._of_all_inlinks': 0, product_count: c.productCount });
    }
  }
  return { empty, orphan };
}
