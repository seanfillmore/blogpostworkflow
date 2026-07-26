/**
 * Which products lose money as a SOLO subscription?
 *
 *   node scripts/recurpay-solo-economics.mjs
 *
 * A subscription ships one product, alone, on a cadence. Freight is paid per
 * shipment regardless of order size, so a cheap item in its own box is a
 * structural loss — and cadence does not fix it. Changing a bar of soap from
 * monthly to 8-weekly makes you lose $0.87 less often; it never makes you gain.
 *
 * This is how the single-bar soap subscription went unnoticed: nothing in the
 * product or plan config says "this one loses money on every shipment." You have
 * to multiply it out. So this script multiplies it out, for every product on
 * every Recurpay plan.
 *
 * Price, COGS and weight come live from Shopify; freight from lib/shipping-costs.js
 * (measured labels, not a fitted curve). Discount comes from each plan's actual
 * selling plan, so a plan at 15% is evaluated at 15%.
 */

import { shopifyGraphQL } from '../lib/shopify.js';
import { listPlans, getPlanProducts } from '../lib/recurpay.js';
import { estimateShipping, contribution, FALLBACK_PACKAGE_COSTS, fetchPackageCosts } from '../lib/shipping-costs.js';

const OVERSIZE_OZ = 32; // a 32oz refill forces the 14x10x4 box at ~$21.31

let costs = FALLBACK_PACKAGE_COSTS;
try { costs = await fetchPackageCosts({ sinceDays: 365 }); } catch { /* measured labels unavailable; fall back */ }

const plans = await listPlans();

// Collect every product id referenced by any plan, then fetch each one once.
const ids = [...new Set((await Promise.all(plans.map(p => getPlanProducts(p.id)))).flat().map(e => e.id))];
const gids = ids.map(i => `"gid://shopify/Product/${i}"`).join(',');
const r = await shopifyGraphQL(`{ nodes(ids: [${gids}]) { ... on Product {
  id handle title
  variants(first: 1) { nodes {
    price
    inventoryItem { unitCost { amount } measurement { weight { value unit } } }
  } }
} } }`);

const info = new Map();
for (const n of r.nodes) {
  const v = n.variants.nodes[0] ?? {};
  const w = v.inventoryItem?.measurement?.weight;
  let oz = Number(w?.value ?? 0);
  const unit = (w?.unit || '').toUpperCase();
  if (unit === 'POUNDS') oz *= 16;
  else if (unit === 'GRAMS') oz /= 28.3495;
  else if (unit === 'KILOGRAMS') oz *= 35.274;
  info.set(Number(n.id.split('/').pop()), {
    handle: n.handle,
    price: Number(v.price ?? 0),
    cogs: Number(v.inventoryItem?.unitCost?.amount ?? 0),
    oz,
  });
}

const rows = [];
for (const p of plans) {
  const disc = p.selling_plans?.[0]?.pricing_polices?.[0]?.discount?.value ?? 0;
  for (const e of await getPlanProducts(p.id)) {
    const i = info.get(e.id);
    if (!i || !i.price) continue;
    const net = i.price * (1 - disc / 100);
    const shipping = estimateShipping(
      { units: 1, pounds: i.oz / 16, hasOversizeItem: i.oz >= OVERSIZE_OZ },
      costs
    );
    rows.push({
      plan: p.id, cadence: `${p.selling_plans[0].delivery_policy.frequency}${p.selling_plans[0].delivery_policy.interval}`,
      handle: i.handle, price: i.price, disc, net, cogs: i.cogs, oz: i.oz, shipping,
      contrib: contribution({ price: net, cogs: i.cogs, shipping }),
    });
  }
}

rows.sort((a, b) => a.contrib - b.contrib);
console.log('PLAN      CADENCE   PRODUCT                        NET    COGS   SHIP    CONTRIB');
for (const x of rows) {
  console.log(
    String(x.plan).padEnd(9), x.cadence.padEnd(9), x.handle.slice(0, 29).padEnd(30),
    ('$' + x.net.toFixed(2)).padStart(6), ('$' + x.cogs.toFixed(2)).padStart(6),
    ('$' + x.shipping.toFixed(2)).padStart(6),
    ('$' + x.contrib.toFixed(2)).padStart(8),
    x.contrib < 0 ? '  <<< LOSES MONEY' : (x.contrib < 2 ? '  (thin)' : ''),
    // Componentized bundles carry no unitCost on the bundle variant — Shopify holds
    // cost on the components. Contribution for those reads high; trust
    // docs/bundle-economics.md instead, which sums the components.
    x.cogs === 0 ? '  [COGS unset — bundle, figure overstated]' : ''
  );
}

const losers = rows.filter(x => x.contrib < 0);
if (!losers.length) {
  console.log('\nNo product loses money as a solo subscription.');
  process.exit(0);
}

console.log(`\n${losers.length} product/plan combination(s) lose money on every shipment:`);
const byHandle = new Map();
for (const l of losers) {
  if (!byHandle.has(l.handle)) byHandle.set(l.handle, { contrib: l.contrib, plans: [] });
  byHandle.get(l.handle).plans.push(`${l.plan} (${l.cadence})`);
}
for (const [h, v] of byHandle) {
  console.log(`  ${h}: $${v.contrib.toFixed(2)}/shipment — on plan ${v.plans.join(', ')}`);
}
console.log(
  '\nCadence does not fix these — a longer cycle just loses the money less often.\n' +
  'Remove the product from the plan (Recurpay admin UI; the API cannot, see lib/recurpay.js),\n' +
  'or replace it with a multi-unit bundle that carries the freight.'
);
process.exit(1);
