/**
 * Landing product + offer verification + value-line allowlist.
 * Pure apart from the injected fetch. Money is compared in integer cents.
 */

const cents = (n) => Math.round(Number(n) * 100);
const toNum = (s) => (s === null || s === undefined || s === '' ? null : Number(s));

export async function fetchLanding(handle, { fetchImpl = fetch, siteUrl = 'https://www.realskincare.com' } = {}) {
  const url = `${siteUrl}/products/${handle}`;
  const jsonUrl = `${url}.json`;
  const res = await fetchImpl(jsonUrl);
  if (!res || res.status !== 200) throw new Error(`landing fetch failed (${res && res.status}): ${jsonUrl}`);
  const { product } = await res.json();
  return {
    handle: product.handle || handle,
    title: product.title,
    url,
    variants: (product.variants || []).map((v) => ({
      title: v.title,
      price: toNum(v.price),
      compareAt: toNum(v.compare_at_price),
    })),
  };
}

export function parseOffer(text) {
  const m = [...String(text).matchAll(/\$(\d+(?:\.\d{1,2})?)/g)].map((x) => Number(x[1]));
  if (m.length < 2) throw new Error(`offer needs two amounts (price, was price): "${text}"`);
  const [price, wasPrice] = m;
  if (cents(wasPrice) <= cents(price)) throw new Error(`was price must exceed price: "${text}"`);
  return { price, wasPrice };
}

const money = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

export function verifyOffer(offer, landing) {
  const shortTitle = String(landing.title || '').split(/\s+\|\s+/)[0].trim();
  const band = `${shortTitle} $${money(offer.price)} (WAS $${money(offer.wasPrice)})`.toUpperCase();
  const hit = landing.variants.some(
    (v) => v.compareAt !== null && cents(v.price) === cents(offer.price) && cents(v.compareAt) === cents(offer.wasPrice),
  );
  if (hit) return { ok: true, reason: 'matches a live variant', band };
  const live = landing.variants.map((v) => `$${v.price}${v.compareAt !== null ? ` (was $${v.compareAt})` : ''}`).join(', ');
  return { ok: false, reason: `offer $${offer.price} (was $${offer.wasPrice}) matches no live variant of ${landing.handle}; live: ${live}`, band };
}

/**
 * Every always-true value line, with an id a structure's bandPreference can name. The
 * 'ingredients-origin' line joins two facts exactly as approved reference C did
 * ("Only 6 clean ingredients. Made in the USA.") and exists only when both facts do.
 */
export function valueLineOptions({ brandKit = {}, catalogEntry = {} } = {}) {
  const out = [];
  const usa = /made in the usa/i.test(brandKit?.manufacturing || '');
  const m = /only\s+(\d+)\s+clean\s+ingredients/i.exec(catalogEntry?.title || '');
  if (brandKit?.free_shipping_threshold) out.push({ id: 'free-shipping', text: `FREE SHIPPING ON ORDERS OVER $${brandKit.free_shipping_threshold}` });
  if (usa) out.push({ id: 'made-in-usa', text: 'MADE IN THE USA' });
  if (m) out.push({ id: 'ingredients', text: `ONLY ${m[1]} CLEAN INGREDIENTS` });
  if (m && usa) out.push({ id: 'ingredients-origin', text: `Only ${m[1]} clean ingredients. Made in the USA.` });
  return out;
}

/**
 * The components of a bundle, from ITS OWN manifest description, as short label texts in the
 * order the description names them. Only a fixed vocabulary of things RSC sells is read, so an
 * unknown description yields nothing (and the bundle structure is then ineligible).
 */
const COMPONENTS = [
  [/\bhand\s*(?:&|and)\s*body\s+soap\b/i, 'Hand & Body Soap'],
  [/\bfoaming\s+hand\s+soap\b/i, 'Foaming Hand Soap'],
  [/\bbody\s+lotion\b/i, 'Body Lotion'],
  [/\bbody\s+cream\b/i, 'Body Cream'],
  [/\bdeodorant\b/i, 'Deodorant'],
  [/\blip\s+balm\b/i, 'Lip Balm'],
  [/\btoothpaste\b/i, 'Toothpaste'],
];
export function bundleComponents(description) {
  const d = String(description || '');
  return COMPONENTS.map(([re, label]) => ({ label, at: d.search(re) }))
    .filter(x => x.at >= 0).sort((a, b) => a.at - b.at).map(x => x.label);
}

export function valueLines({ brandKit = {}, catalogEntry = {} } = {}) {
  const out = [];
  if (brandKit.free_shipping_threshold) out.push(`FREE SHIPPING ON ORDERS OVER $${brandKit.free_shipping_threshold}`);
  if (/made in the usa/i.test(brandKit.manufacturing || '')) out.push('MADE IN THE USA');
  const m = /only\s+(\d+)\s+clean\s+ingredients/i.exec(catalogEntry.title || '');
  if (m) out.push(`ONLY ${m[1]} CLEAN INGREDIENTS`);
  return out;
}
