/**
 * Repair the Bar Soap 4-Pack's subscription: it was a native Shopify selling plan
 * group that nothing can bill.
 *
 *   node scripts/fix-bar-soap-subscription.mjs [--apply]
 *
 * THE BUG
 *   `BARSOAP_4MO` ("Every 4 months, 15% off") was created through the Shopify
 *   Admin API by our own custom app. Our app has no subscription billing engine —
 *   it never calls `subscriptionContractCreate` and never charges anyone. So a
 *   customer choosing that option on the live product page would have received
 *   **15% off one shipment and then nothing, forever**. No second order, no
 *   contract, no cancellation email — silent.
 *
 *   Real Skin Care's subscriptions are Recurpay's. Every working plan carries a
 *   `RP_PLAN_*` merchant code and is INVISIBLE to a shop-level
 *   `sellingPlanGroups` query, because that query only returns groups the calling
 *   app owns. That asymmetry is the tell, and it reads backwards:
 *
 *     visible at shop level      -> ours -> NOT billable
 *     invisible at shop level    -> Recurpay's -> billable
 *
 *   `BARSOAP_4MO` was the only group visible at shop level. That is what gave it
 *   away. Recurpay's own plan list (`node scripts/recurpay-audit.mjs`) confirms
 *   it: seven selling plans, cadences 30-day through 12-week, and no 4-month plan
 *   at all.
 *
 * WHY IT WAS SAFE TO CATCH LATE
 *   The product was a draft from creation until 2026-07-26, so nothing could be
 *   bought on it. `subscriptionContracts` returns zero contracts for our app.
 *
 * THE FIX
 *   1. Detach the product from `BARSOAP_4MO`, then delete the group. A group with
 *      no billing behind it must not survive to be re-attached by accident.
 *   2. Create the 4-month plan in RECURPAY instead, so the app that can actually
 *      bill owns it.
 *
 *   Step 3 — attaching the product to the new plan — CANNOT BE SCRIPTED. Recurpay
 *   accepts a `products` array on POST and silently ignores it, and returns HTTP
 *   500 on PUT. Verified on throwaway plans 11151694/11151695. It is an admin-UI
 *   operation, like selling plans at position 2+. See lib/recurpay.js CONSTRAINTS.
 *
 * THE RULE THIS LEAVES BEHIND
 *   Never create a selling plan group through the Shopify Admin API for this
 *   store. A selling plan without a subscription app behind it is not a
 *   subscription — it is a discount that lies about recurring.
 */

import { shopifyGraphQL } from '../lib/shopify.js';
import { createPlan, listSellingPlans } from '../lib/recurpay.js';

const APPLY = process.argv.includes('--apply');
const HANDLE = 'coconut-bar-soap-4-pack';

// House style, copied from the live Recurpay plans so the storefront widget reads
// consistently against the 6-week and 8-week options.
const DESCRIPTION =
  '<p>✓ Save 15% on every order</p>' +
  '<p>✓ Four bars, delivered every four months</p>' +
  '<p>✓ Pause, skip, or cancel anytime</p>' +
  '<p>✓ 30-day money-back guarantee</p>';

const RECURPAY_PLAN = {
  name: 'Bar Soap — 4 Month Refill',
  description: DESCRIPTION,
  selling_plans: [
    {
      name: 'Every 4 months, 15% off',
      description: DESCRIPTION,
      delivery_policy: { frequency: 4, interval: 'month', pre_anchor_behavior: 'ASAP', cutoff: 0 },
      billing_policy: { frequency: 4, interval: 'month' },
      pricing_polices: [{ discount: { type: 'percentage', value: 15, currency: 'USD' } }],
      position: 1,
      is_recommended: true,
    },
  ],
};

const log = (...a) => console.log(...a);

async function gql(query, variables = {}) {
  const data = await shopifyGraphQL(query, variables);
  for (const v of Object.values(data ?? {})) {
    if (v?.userErrors?.length) throw new Error(v.userErrors.map((e) => e.message).join('; '));
  }
  return data;
}

// ── inspect ────────────────────────────────────────────────────────────────

const state = await shopifyGraphQL(`{
  p: productByHandle(handle: "${HANDLE}") {
    id title
    sellingPlanGroups(first: 10) { nodes { id name merchantCode } }
  }
  shopLevel: sellingPlanGroups(first: 20) { nodes { id merchantCode productsCount { count } } }
  contracts: subscriptionContracts(first: 10) { nodes { id status } }
}`);

const product = state.p;
const ours = new Set(state.shopLevel.nodes.map((g) => g.id));
const attached = product.sellingPlanGroups.nodes;
const orphaned = attached.filter((g) => ours.has(g.id));

log(`${product.title}`);
log(`  groups attached: ${attached.map((g) => g.merchantCode).join(', ') || '(none)'}`);
log(`  owned by our app (NOT billable): ${orphaned.map((g) => g.merchantCode).join(', ') || '(none)'}`);
log(`  subscription contracts on our app: ${state.contracts.nodes.length}`);

const recurpayPlans = await listSellingPlans();
const fourMonth = recurpayPlans.filter((sp) => sp.interval === 'month' && sp.frequency === 4);
log(`  Recurpay 4-month plans: ${fourMonth.length ? fourMonth.map((p) => p.planId).join(', ') : 'NONE — this is the gap'}`);

if (!orphaned.length && fourMonth.length) {
  log('\nAlready repaired. Nothing to do.');
  process.exit(0);
}

if (state.contracts.nodes.length) {
  throw new Error(
    `Refusing to run: ${state.contracts.nodes.length} subscription contract(s) exist on our app. ` +
    `Deleting the group would strand them. Migrate them first.`
  );
}

if (!APPLY) {
  log('\nDry run. Re-run with --apply to repair.');
  process.exit(0);
}

// ── 1. detach and delete the un-billable group ─────────────────────────────

for (const g of orphaned) {
  log(`\n[1] removing ${g.merchantCode} from the product`);
  await gql(
    `mutation ($id: ID!, $productIds: [ID!]!) {
      sellingPlanGroupRemoveProducts(id: $id, productIds: $productIds) {
        removedProductIds userErrors { field message }
      }
    }`,
    { id: g.id, productIds: [product.id] }
  );
  log(`    deleting the group so it cannot be re-attached`);
  await gql(
    `mutation ($id: ID!) {
      sellingPlanGroupDelete(id: $id) { deletedSellingPlanGroupId userErrors { field message } }
    }`,
    { id: g.id }
  );
  log(`    ✓ ${g.merchantCode} gone`);
}

// ── 2. create the real plan in Recurpay ────────────────────────────────────

if (!fourMonth.length) {
  log(`\n[2] creating the 4-month plan in Recurpay`);
  const created = await createPlan(RECURPAY_PLAN);
  log(`    ✓ Recurpay plan ${created.id} — "${created.name}"`);
  log(`      selling plan group ${created.selling_plan_group_id}`);
}

log(`
[3] MANUAL — attach the product in the Recurpay admin UI.
    Recurpay's API cannot write product associations: POST silently ignores a
    \`products\` array, PUT returns HTTP 500. Open the plan and add
    "Coconut Bar Soap — 4-Pack".

    Until that is done the product is a one-time purchase only — which is the
    correct failure mode. It is not offering a subscription it cannot honour.

    Verify after: node scripts/fix-bar-soap-subscription.mjs
`);
