/**
 * Google Merchant Center listings for Shopify PACKS — pure builder, no I/O.
 *
 * WHY THIS EXISTS. Every ladder tier and bundle is a componentized Shopify
 * product, and Shopify's Google & YouTube channel refuses those outright
 * ("Channel Google & YouTube does not support variant-fixed bundles", verified
 * 2026-10-23). So until this, no pack ever reached Google: the feed held only
 * the 35 single units. Competitor research the same week showed multipacks are
 * the Shopping listings that survive longest (Wellnesse's 4-pack ran a year
 * while its single tubes were cut), and a $90 pack makes a click worth ~3x a
 * $30 single, which is the constraint our Shopping campaign actually has.
 *
 * WHAT A PACK INHERITS, AND FROM WHERE. Shopify owns price, stock, link and
 * image. The SINGLE unit's live Merchant Center record (written by Shopify's
 * channel) owns category, product type, brand and shipping, so a pack is
 * described exactly as its single is and cannot drift from it.
 *
 * TITLES CARRY NO PROMOTIONAL TEXT. Google's title spec forbids it ("free",
 * "% off", "buy 3 get 1"). The saving shows as a sale price struck through
 * against the compare-at price instead, which is three or four singles at list.
 *
 * IDENTIFIERS. One component at quantity N is a MULTIPACK: the single's GTIN
 * plus `multipack: N`, which Google allows (the same GTIN with a different
 * multipack value is a different product). Several distinct components is a
 * BUNDLE with no main item, so no GTIN and `identifierExists: false`.
 */

export const OFFER_PREFIX = 'rsc_pack_';
export const BRAND_SUFFIX = 'Real Skin Care';

export const offerIdFor = (variantGid) => `${OFFER_PREFIX}${String(variantGid).split('/').pop()}`;

/** The offerId Shopify's channel uses for a single variant. */
export const singleOfferId = (productGid, variantGid) =>
  `shopify_US_${String(productGid).split('/').pop()}_${String(variantGid).split('/').pop()}`;

const micros = (amount) => String(Math.round(Number(amount) * 1_000_000));
const money = (amount) => ({ amountMicros: micros(amount), currencyCode: 'USD' });

/** "Coconut Oil Toothpaste — 3-Pack" → "Coconut Oil Toothpaste 3-Pack". */
export function baseTitle(productTitle) {
  return String(productTitle).replace(/\s*[—–-]\s*(?=\d+-Pack\b)/i, ' ').replace(/\s+/g, ' ').trim();
}

/** "3x Fresh Mint" → "Fresh Mint"; "Variety — one of each" → "Variety, One of Each". */
export function optionLabel(variantTitle) {
  const t = String(variantTitle).replace(/^\d+\s*x\s+/i, '').trim();
  return t.replace(/\s*[—–]\s*/g, ', ').replace(/\b(one|each)\b/g, (w) => w[0].toUpperCase() + w.slice(1));
}

/**
 * @param {{product: object, variant: object, template: object|null}} input
 *   product: Shopify product {title, handle, description, featuredImage}
 *   variant: Shopify variant {id, title, price, compareAtPrice, availableForSale, image, components:[{quantity, barcode}]}
 *   template: productAttributes of the first component's live Merchant Center item
 * @returns {object} a Merchant API ProductInput
 */
export function buildPackProductInput({ product, variant, template }) {
  if (!template) throw new Error(`${product.handle} / ${variant.title}: no live Merchant Center record for its single unit to inherit from`);
  const components = (variant.components || []).filter((c) => c && c.quantity > 0);
  if (!components.length) throw new Error(`${product.handle} / ${variant.title}: variant has no bundle components`);
  const units = components.reduce((n, c) => n + c.quantity, 0);
  const multipack = components.length === 1;

  const price = Number(variant.price);
  const compareAt = Number(variant.compareAtPrice);
  const onSale = Number.isFinite(compareAt) && compareAt > price;

  const shopDesc = String(product.description || '').trim();
  const description = shopDesc.length >= 50
    ? shopDesc
    : `Pack of ${units}. ${String(template.description || '').trim()}`.trim();

  const attrs = {
    title: `${baseTitle(product.title)} – ${BRAND_SUFFIX} ${optionLabel(variant.title)}`,
    description: description.slice(0, 5000),
    link: `https://www.realskincare.com/products/${product.handle}?variant=${String(variant.id).split('/').pop()}`,
    imageLink: variant.image?.url || product.featuredImage?.url,
    availability: variant.availableForSale ? 'IN_STOCK' : 'OUT_OF_STOCK',
    condition: 'NEW',
    brand: template.brand || BRAND_SUFFIX,
    price: money(onSale ? compareAt : price),
    ...(onSale ? { salePrice: money(price) } : {}),
    googleProductCategory: template.googleProductCategory,
    productTypes: template.productTypes,
    itemGroupId: `${OFFER_PREFIX}${String(product.id).split('/').pop()}`,
    ...(template.shipping ? { shipping: template.shipping } : {}),
    ...(multipack
      ? { multipack: String(components[0].quantity), ...(components[0].barcode ? { gtins: [components[0].barcode] } : { identifierExists: false }) }
      : { isBundle: true, identifierExists: false }),
  };
  if (!attrs.imageLink) throw new Error(`${product.handle} / ${variant.title}: no image`);
  for (const k of Object.keys(attrs)) if (attrs[k] === undefined) delete attrs[k];

  return {
    offerId: offerIdFor(variant.id),
    contentLanguage: 'en',
    feedLabel: 'US',
    productAttributes: attrs,
  };
}

/** Our items that no longer correspond to a desired variant, so the sync deletes them. */
export function staleOfferIds(existingOfferIds, desiredOfferIds) {
  const want = new Set(desiredOfferIds);
  return existingOfferIds.filter((id) => id.startsWith(OFFER_PREFIX) && !want.has(id));
}
