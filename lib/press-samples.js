// lib/press-samples.js
//
// Sample orders for agents/press-outreach. When a writer accepts samples and
// gives an address, RSC ships them a $0 "PR Package" order; once it ships, the
// writer gets the tracking link, and 21 days after delivery one check-in.
//
// THE ORDER IS $0 AND THAT IS ASSERTED, NOT ASSUMED. Every line carries a 100%
// discount and no shipping line, and createSampleOrder reads the draft's total
// back before completing it: a non-zero draft is left as a DRAFT (never
// completed, never charged) and the caller escalates to Sean. A $0 order is
// excluded from revenue by lib/order-attribution.js (`total > 0`), which the
// tests pin.
//
// Orders Sean places by hand count too: matchOrder finds a PR Package order for
// a contact by shipping name or email, so tracking and the check-in work the
// same whichever way the order was made.
//
// lib/shopify.js throws at import without OAuth credentials, so it is imported
// lazily (defaultGraphql) and every function takes an injected `graphql`.

export const SAMPLE_TAGS = Object.freeze(['PR Package', 'press-outreach']);
export const PR_PACKAGE_TAG = 'PR Package';
export const CHECKIN_AFTER_DAYS = 21;
const DAY = 86_400_000;

const SCOPES_QUERY = '{ currentAppInstallation { accessScopes { handle } } }';
const CREATE_MUTATION = 'mutation($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { id name totalPriceSet { shopMoney { amount } } } userErrors { field message } } }';
const COMPLETE_MUTATION = 'mutation($id: ID!) { draftOrderComplete(id: $id) { draftOrder { id order { id name } } userErrors { field message } } }';
const ORDERS_QUERY = 'query($q: String) { orders(first: 20, query: $q) { nodes { name email createdAt cancelledAt tags shippingAddress { name } fulfillments { displayStatus deliveredAt trackingInfo { company number url } } } } }';

export async function defaultGraphql(query, variables) {
  const { shopifyGraphQL } = await import('./shopify.js');
  return shopifyGraphQL(query, variables);
}

const pick = (res, key) => res?.[key] ?? res?.data?.[key];
const fold = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const isPrPackage = (o) => (o?.tags || []).some((t) => fold(t) === fold(PR_PACKAGE_TAG));

/** Does the installed app hold write_draft_orders? */
export async function hasDraftOrderScope({ graphql = defaultGraphql } = {}) {
  const res = await graphql(SCOPES_QUERY, {});
  const scopes = pick(res, 'currentAppInstallation')?.accessScopes || [];
  return scopes.some((s) => s?.handle === 'write_draft_orders');
}

/** PR Package orders created this UTC calendar month, not cancelled. */
export function countMonthKits(orders, nowMs) {
  const month = new Date(nowMs).toISOString().slice(0, 7);
  return (orders || []).filter((o) => isPrPackage(o) && !o.cancelledAt && String(o.createdAt || '').slice(0, 7) === month).length;
}

/** The variant gid for a product key, or null. Numeric ids become gids. */
export function variantGid(config, product) {
  const v = config?.sampleVariants?.[product];
  if (v == null || v === '') return null;
  const s = String(v);
  return s.startsWith('gid://') ? s : `gid://shopify/ProductVariant/${s}`;
}

/** What to ship, or why not. */
export function planSample({ pitch, address, config, monthKits }) {
  const cap = config?.monthlySampleKits ?? 10;
  if (monthKits >= cap) return { ok: false, lines: [], reason: `over monthly cap (${monthKits} of ${cap} PR Package orders this month)` };
  if (!address?.lines?.length) return { ok: false, lines: [], reason: 'no address to ship to' };
  const products = pitch?.products || [];
  if (!products.length) return { ok: false, lines: [], reason: 'the pitch names no products' };
  const lines = [];
  for (const p of products) {
    const variantId = variantGid(config, p);
    if (!variantId) return { ok: false, lines: [], reason: `no variant mapped for ${p}` };
    lines.push({ variantId, quantity: 1 });
  }
  return { ok: true, lines };
}

/** {lines: [street, "City, ST 12345"], zip} -> Shopify address fields. */
export function parseAddress(address) {
  const [street = '', cityLine = ''] = address?.lines || [];
  const parts = street.split(/,\s*(?=(?:apt|apartment|unit|suite|ste|#)\b|#)/i);
  const address1 = parts[0].trim();
  const address2 = parts.slice(1).join(', ').trim() || null;
  const m = cityLine.match(/^\s*(.+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/);
  return {
    address1, address2,
    city: m ? m[1].trim() : null,
    provinceCode: m ? m[2] : null,
    zip: m ? m[3] : (address?.zip || null),
  };
}

export function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
}

export function buildDraftOrderInput({ contact, pitch, address, lines }) {
  const a = parseAddress(address);
  const { firstName, lastName } = splitName(contact?.name);
  return {
    lineItems: lines.map((l) => ({
      variantId: l.variantId, quantity: l.quantity || 1,
      appliedDiscount: { valueType: 'PERCENTAGE', value: 100, title: 'PR sample' },
    })),
    shippingAddress: {
      firstName, lastName, address1: a.address1, ...(a.address2 ? { address2: a.address2 } : {}),
      city: a.city, provinceCode: a.provinceCode, zip: a.zip, countryCode: 'US',
    },
    tags: [...SAMPLE_TAGS],
    note: `press-outreach: ${contact?.id} / ${pitch?.concept || ''}`,
  };
}

export class NonZeroDraftError extends Error {
  constructor(draft) {
    super(`draft ${draft?.name || draft?.id} totals ${draft?.totalPriceSet?.shopMoney?.amount}, not 0; left as a draft and NOT completed`);
    this.name = 'NonZeroDraftError';
    this.draft = draft;
  }
}

const errs = (u) => (u || []).map((e) => `${(e.field || []).join('.')}: ${e.message}`).join('; ');

/** draftOrderCreate, assert $0, then draftOrderComplete. Returns { name }. */
export async function createSampleOrder(input, { graphql = defaultGraphql } = {}) {
  const created = pick(await graphql(CREATE_MUTATION, { input }), 'draftOrderCreate');
  if (created?.userErrors?.length) throw new Error(`draftOrderCreate: ${errs(created.userErrors)}`);
  const draft = created?.draftOrder;
  if (!draft?.id) throw new Error('draftOrderCreate returned no draft');
  const amount = Number(draft.totalPriceSet?.shopMoney?.amount);
  if (!(amount === 0)) throw new NonZeroDraftError(draft);
  const done = pick(await graphql(COMPLETE_MUTATION, { id: draft.id }), 'draftOrderComplete');
  if (done?.userErrors?.length) throw new Error(`draftOrderComplete: ${errs(done.userErrors)}`);
  const name = done?.draftOrder?.order?.name;
  if (!name) throw new Error(`draftOrderComplete returned no order for ${draft.name}`);
  return { name };
}

/** PR Package orders created in the last `sinceDays` days (newest 20 the API returns). */
export async function fetchPrPackageOrders({ sinceDays = 60, now = Date.now(), graphql = defaultGraphql } = {}) {
  const since = new Date(now - sinceDays * DAY).toISOString().slice(0, 10);
  const res = await graphql(ORDERS_QUERY, { q: `tag:"${PR_PACKAGE_TAG}" created_at:>=${since}` });
  return (pick(res, 'orders')?.nodes || []).filter(isPrPackage);
}

/** One order by name (#2373), or null. Not filtered by tag: Sean may have tagged it differently. */
export async function fetchOrderByName(name, { graphql = defaultGraphql } = {}) {
  const n = String(name || '').replace(/^#?/, '#');
  const res = await graphql(ORDERS_QUERY, { q: `name:${n}` });
  return (pick(res, 'orders')?.nodes || []).find((o) => o.name === n) || null;
}

/**
 * The PR Package order that is this contact's sample: not cancelled, created on
 * or after `sinceDate` (YYYY-MM-DD), and either the shipping name equals the
 * contact's full name (case-insensitive) or the order email equals theirs. The
 * agent's own orders ship to the contact's name, so they match the same way as
 * one Sean placed by hand. The earliest such order wins.
 */
export function matchOrder(orders, { contact, email = null, sinceDate }) {
  const name = fold(contact?.name);
  const mail = fold(email);
  const hits = (orders || []).filter((o) => {
    if (!isPrPackage(o) || o.cancelledAt) return false;
    if (sinceDate && String(o.createdAt || '').slice(0, 10) < sinceDate) return false;
    if (name && fold(o.shippingAddress?.name) === name) return true;
    if (mail && fold(o.email) === mail) return true;
    return false;
  });
  hits.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return hits[0] || null;
}

/** The first fulfillment with a tracking URL: { url, company, number, deliveredAt } or null. */
export function trackingOf(order) {
  for (const f of order?.fulfillments || []) {
    const t = (f.trackingInfo || []).find((x) => x?.url);
    if (t) return { url: t.url, company: t.company || null, number: t.number || null, deliveredAt: f.deliveredAt || null };
  }
  return null;
}

/** When the sample was delivered (any fulfillment), or null. */
export function deliveredAtOf(order) {
  const d = (order?.fulfillments || []).map((f) => f.deliveredAt).filter(Boolean).sort();
  return d[0] || null;
}

export function checkinDue({ deliveredAt, nowMs }) {
  const t = Date.parse(deliveredAt || '');
  return Number.isFinite(t) && nowMs >= t + CHECKIN_AFTER_DAYS * DAY;
}

export function thanksText({ firstName: n }) {
  return `Hi ${n},\n\nThank you! They're on the way; I'll send tracking as soon as it ships.\n\nSean`;
}

export function trackingText({ firstName: n, url }) {
  return `Hi ${n},\n\nYour samples have shipped. You can track them here:\n${url}\n\nEnjoy, and let me know if anything arrives damaged.\n\nSean`;
}

export function checkinText({ firstName: n }) {
  return `Hi ${n},\n\nHope you've had a chance to try them. If photos or details would help with anything you're writing, just reply.\n\nSean`;
}

/** The escalation Sean gets when the agent cannot place the order itself. */
export function orderRequestEmail({ contact, pitch, address, config, reason = null }) {
  const products = (pitch?.products || []).map((p) => `  - ${p}: ${variantGid(config, p) || 'NO VARIANT MAPPED'}`);
  return {
    subject: `Press outreach: create a PR Package order for ${contact.name}`,
    body: [
      `${contact.name} accepted samples and sent this address:`,
      '', ...(address?.lines || []).map((l) => `  ${l}`), '',
      'Pitched products (default variants):',
      ...(products.length ? products : ['  (the pitch names no products)']),
      '',
      ...(reason ? [`Why the agent did not create it: ${reason}`, ''] : []),
      `Create a $0 order tagged "${PR_PACKAGE_TAG}" shipped to ${contact.name}. The agent finds it by name and will email ${contact.name.split(/\s+/)[0]} tracking automatically once it ships.`,
    ].join('\n'),
  };
}
