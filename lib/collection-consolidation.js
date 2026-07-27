/**
 * Decide each collection's fate in the 2026-07-27 consolidation.
 *
 * The rule (see the spec): a collection exists only where a category holds 2+
 * distinct products. Single-product categories are PDP-only, so their
 * collections redirect to the product page rather than to another collection.
 *
 * Pure and network-free so the mapping is testable without touching Shopify.
 */

export const SURVIVORS = new Set([
  'non-toxic-body-lotion', // lotion: 2 SKUs
  'foaming-hand-soap',     // hand soap: 2 SKUs (dispenser + refill)
  'all-products',          // native catch-all
  'on-sale',               // merchandising, not a category
]);

const PDP = {
  toothpaste: '/products/coconut-oil-toothpaste',
  deodorant: '/products/coconut-oil-deodorant',
  lipBalm: '/products/coconut-oil-lip-balm',
  barSoap: '/products/coconut-soap',
};

const LOTION = '/collections/non-toxic-body-lotion';
const HAND_SOAP = '/collections/foaming-hand-soap';
const FALLBACK = '/collections/all-products';

/**
 * Returns the redirect target for a collection handle, or null if the handle
 * is a survivor and must not be touched.
 *
 * Order matters: the specific category markers are tested before the generic
 * 'soap' and 'lotion' families, so 'mint-toothpaste' does not fall into a
 * broader bucket first.
 */
export function classifyTarget(handle) {
  if (!handle) return FALLBACK;
  if (SURVIVORS.has(handle)) return null;
  if (/toothpaste|fluoride|sls|cinnamon|mint/.test(handle)) return PDP.toothpaste;
  if (/deodorant/.test(handle)) return PDP.deodorant;
  if (/lip-?balm|lip-moistur/.test(handle)) return PDP.lipBalm;
  if (/hand-soap|foaming|soap-dispenser|liquid-soap/.test(handle)) return HAND_SOAP;
  if (/soap|tattoo/.test(handle)) return PDP.barSoap;
  if (/lotion|moistur|cream|butter/.test(handle)) return LOTION;
  return FALLBACK;
}

/**
 * Expand a list of collections into the redirect plan. Survivors are dropped,
 * as is any row whose target would equal its own path — a self-redirect is a
 * loop, and Shopify will happily create one.
 */
export function buildRedirectPlan(collections) {
  const out = [];
  for (const c of collections || []) {
    const target = classifyTarget(c.handle);
    if (!target) continue;
    if (target === `/collections/${c.handle}`) continue;
    out.push({ ...c, target });
  }
  return out;
}
