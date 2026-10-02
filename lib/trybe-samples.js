// lib/trybe-samples.js
//
// The pure half of the creator-priming check in agents/trybe-review: which
// Trybe creators have their free sample in hand and still have not made
// content for it, so somebody nudges them while the product is fresh.
//
// ── Why the join runs through Shopify ───────────────────────────────────────────
//
// Trybe's Brand API exposes no sample requests at all (see lib/trybe.js). But
// every sample Trybe sends is a real Shopify order: $0, created by the
// "Trybe UGC" app, tagged `sample-request` + `trybe`, with the note
// "Trybe sample request for <creator name>". That note is the join key, NOT the
// shipping name: a creator who ships through a parcel forwarder arrives as
// "#ICC35294 Jose Guzmán" on the address while the note still names her.
// Submissions carry `creator.name`, so the two meet on a normalised name.
//
// ── What "needs priming" means ──────────────────────────────────────────────────
//
// A creator is due a nudge when a sample was DELIVERED at least
// PRIME_AFTER_DAYS ago and some product in it has no submission yet. Partial
// coverage counts: a creator who sent one toothpaste video after receiving
// toothpaste, moisturizer and foaming soap still owes two. Product matching is
// on the product title, which is what both Shopify line items and Trybe's
// `products[].name` carry.
//
// Shipping problems are reported too, because a sample stuck in a warehouse or
// with the carrier is the other way a creator ends up never posting:
// UNSHIPPED_AFTER_DAYS flags an order nobody has fulfilled, and a DELAYED or
// FAILURE carrier status is named.
//
// Reporting only. Trybe's API cannot message a creator, so this agent never
// contacts anyone; the digest names who to nudge and the operator does it.

export const PRIME_AFTER_DAYS = 5;
export const UNSHIPPED_AFTER_DAYS = 2;

const DAY_MS = 86_400_000;
const NOTE_PREFIX = /trybe sample request for\s+/i;
const PROBLEM_STATUSES = new Set(['DELAYED', 'FAILURE', 'ATTEMPTED_DELIVERY', 'CARRIER_PICKED_UP_FAILED']);

export function normName(name) {
  return String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** True for the $0 sample orders the Trybe UGC app creates. */
export function isTrybeSampleOrder(order) {
  const tags = (order?.tags || []).map((t) => String(t).toLowerCase());
  return tags.includes('sample-request') && tags.includes('trybe');
}

/** The creator's Trybe name, from the order note, falling back to the ship-to name. */
export function creatorNameFromOrder(order) {
  const note = String(order?.note || '');
  if (NOTE_PREFIX.test(note)) return note.replace(NOTE_PREFIX, '').split('\n')[0].trim();
  return order?.shippingAddress?.name || order?.customer?.displayName || null;
}

/**
 * One order's shipping state.
 * @returns {{state: 'cancelled'|'unshipped'|'in_transit'|'problem'|'delivered',
 *            deliveredAt: string|null, carrierStatus: string|null, eta: string|null}}
 */
export function shipmentState(order) {
  if (order?.cancelledAt) return { state: 'cancelled', deliveredAt: null, carrierStatus: null, eta: null };
  const fulfillments = (order?.fulfillments || []).filter((f) => f && f.status !== 'CANCELLED');
  if (!fulfillments.length) return { state: 'unshipped', deliveredAt: null, carrierStatus: null, eta: null };
  // A multi-parcel order is delivered when its last parcel is.
  const delivered = fulfillments.every((f) => f.displayStatus === 'DELIVERED' || f.deliveredAt);
  const deliveredAt = delivered
    ? fulfillments.map((f) => f.deliveredAt).filter(Boolean).sort().pop() || null
    : null;
  const pending = fulfillments.find((f) => !(f.displayStatus === 'DELIVERED' || f.deliveredAt));
  const carrierStatus = (pending || fulfillments[0]).displayStatus || null;
  const eta = pending?.estimatedDeliveryAt || null;
  if (delivered) return { state: 'delivered', deliveredAt, carrierStatus: 'DELIVERED', eta: null };
  return { state: PROBLEM_STATUSES.has(carrierStatus) ? 'problem' : 'in_transit', deliveredAt: null, carrierStatus, eta };
}

const daysBetween = (fromIso, now) => Math.floor((now - Date.parse(fromIso)) / DAY_MS);

/**
 * @param {{orders: object[], submissions: object[], creators?: object[], now?: Date|number,
 *          primeAfterDays?: number, unshippedAfterDays?: number}} input
 */
export function planSamplePriming({
  orders = [],
  submissions = [],
  creators = [],
  now = Date.now(),
  primeAfterDays = PRIME_AFTER_DAYS,
  unshippedAfterDays = UNSHIPPED_AFTER_DAYS,
}) {
  const nowMs = typeof now === 'number' ? now : now.getTime();

  // Products each creator has already made content for. Rejected work still
  // counts as "engaged": that creator needs coaching, not a reminder.
  const covered = new Map();
  for (const s of submissions || []) {
    const key = normName(s?.creator?.name);
    if (!key) continue;
    if (!covered.has(key)) covered.set(key, new Set());
    for (const p of s.products || []) covered.get(key).add(normName(p.name));
  }

  const byCreator = new Map();
  for (const order of (orders || []).filter(isTrybeSampleOrder)) {
    const name = creatorNameFromOrder(order);
    const key = normName(name);
    if (!key) continue;
    const ship = shipmentState(order);
    if (ship.state === 'cancelled') continue;
    if (!byCreator.has(key)) byCreator.set(key, { name, orders: [] });
    byCreator.get(key).orders.push({
      name: order.name,
      createdAt: order.createdAt,
      products: (order.lineItems?.nodes || order.lineItems || []).map((l) => l.title).filter(Boolean),
      ...ship,
    });
  }

  const plan = { prime: [], waiting: [], inTransit: [], problems: [], unshipped: [], noSample: [] };
  for (const [key, c] of byCreator) {
    const done = covered.get(key) || new Set();
    const submitted = done.size > 0;
    for (const o of c.orders) {
      const row = { creator: c.name, order: o.name, products: o.products, submitted };
      if (o.state === 'unshipped') {
        const age = daysBetween(o.createdAt, nowMs);
        if (age >= unshippedAfterDays) plan.unshipped.push({ ...row, daysWaiting: age });
        else plan.inTransit.push({ ...row, carrierStatus: 'awaiting fulfillment', eta: null });
      } else if (o.state === 'problem') {
        plan.problems.push({ ...row, carrierStatus: o.carrierStatus, eta: o.eta });
      } else if (o.state === 'in_transit') {
        plan.inTransit.push({ ...row, carrierStatus: o.carrierStatus, eta: o.eta });
      } else {
        const missing = o.products.filter((p) => !done.has(normName(p)));
        if (!missing.length) continue;
        const days = o.deliveredAt ? daysBetween(o.deliveredAt, nowMs) : null;
        // An unknown delivery date is treated as due: Shopify said DELIVERED.
        const due = days === null || days >= primeAfterDays;
        (due ? plan.prime : plan.waiting).push({ ...row, missing, deliveredAt: o.deliveredAt, daysSinceDelivery: days });
      }
    }
  }

  for (const cr of creators || []) {
    const key = normName(cr?.name);
    if (key && !byCreator.has(key) && !covered.has(key)) plan.noSample.push(cr.name);
  }

  const longestFirst = (a, b) => (b.daysSinceDelivery ?? Infinity) - (a.daysSinceDelivery ?? Infinity);
  plan.prime.sort(longestFirst);
  plan.waiting.sort(longestFirst);
  plan.unshipped.sort((a, b) => b.daysWaiting - a.daysWaiting);
  return plan;
}

/** Digest lines for the priming plan. Empty sections are omitted. */
export function renderPrimingLines(plan) {
  if (!plan) return ['', 'Sample tracking could not be read this run.'];
  const lines = ['', 'Creator samples (Shopify sample orders joined to Trybe submissions):'];
  const list = (arr) => arr.join(', ');
  if (plan.prime.length) {
    lines.push(`Nudge these creators in Trybe, sample delivered ${PRIME_AFTER_DAYS}+ days and no content yet:`);
    for (const r of plan.prime) {
      const when = r.daysSinceDelivery === null ? 'delivered, date unknown' : `delivered ${r.daysSinceDelivery}d ago`;
      const part = r.submitted ? ' (has posted for other products)' : '';
      lines.push(`  - ${r.creator} · ${r.order} · ${when} · no content for: ${list(r.missing)}${part}`);
    }
  }
  if (plan.unshipped.length) {
    lines.push(`Sample orders not shipped yet:`);
    for (const r of plan.unshipped) lines.push(`  - ${r.creator} · ${r.order} · waiting ${r.daysWaiting}d · ${list(r.products)}`);
  }
  if (plan.problems.length) {
    lines.push(`Shipping problems:`);
    for (const r of plan.problems) lines.push(`  - ${r.creator} · ${r.order} · ${r.carrierStatus}${r.eta ? ` · was due ${r.eta.slice(0, 10)}` : ''}`);
  }
  const counts = [
    plan.waiting.length && `${plan.waiting.length} delivered recently`,
    plan.inTransit.length && `${plan.inTransit.length} in transit`,
    plan.noSample.length && `${plan.noSample.length} creator(s) with no sample order`,
  ].filter(Boolean);
  if (counts.length) lines.push(`Also: ${counts.join(' · ')}.`);
  if (lines.length === 2) lines.push('No creator samples to report.');
  return lines;
}
