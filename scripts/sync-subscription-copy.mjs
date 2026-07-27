/**
 * Make every Recurpay plan's customer-facing copy tell the truth about shipping.
 *
 *   node scripts/sync-subscription-copy.mjs [--apply]
 *
 * WHY
 *   Shopify runs an active automatic discount, `Subscription Free Shipping`
 *   (`appliesOnSubscription: true`, NO minimum order value, no cycle cap), so
 *   every subscription order ships free at any cart size — bypassing the $45
 *   threshold one-time buyers face.
 *
 *   Five of eight selling plans never said so. A customer comparing two options
 *   on one product saw one promising free shipping and the other silent, while
 *   both received it. We were giving away a benefit and not getting credit for
 *   it in the picker.
 *
 *   Shipping is a SHOPIFY concern — Recurpay creates subscription contracts, it
 *   does not decide rates. Recurpay only owns the promise text. This script
 *   syncs the promise to what Shopify actually does; it does not change the
 *   discount. If the discount is ever given a minimum, this copy must change
 *   with it or it becomes a lie.
 *
 * ⚠️ RECURPAY'S `PUT /plans/{id}` IS POSITIONAL AND DESTRUCTIVE
 *   The single selling plan you send BECOMES position 1, taking its delivery and
 *   billing policy with it. A 12-week payload sent to plan 11150632 once rewrote
 *   that plan's 4-week position-1 plan to deliver every 12 weeks. So this script
 *   never composes a payload by hand: it reads the live plan, changes only the
 *   description, echoes every other field back verbatim, and then re-reads to
 *   assert the cadence and discount did not move.
 *
 * SCOPE — only plans with a SINGLE selling plan are touched, because positions
 * 2+ are unreachable by this API (`selling_plans` must contain exactly one item,
 * so anything you send lands at position 1). The two remaining gaps are
 * position-2/position-1-of-a-multi plans and must be edited in the Recurpay
 * admin UI; this script prints them rather than risking a live cadence.
 */

import { getPlan, updatePlan, listPlans } from '../lib/recurpay.js';

const APPLY = process.argv.includes('--apply');

const SHIPPING_LINE = '<p>✓ Free shipping on any subscription order</p>';
const SAVE_LINE = '<p>✓ Save 15% on every order</p>';
const TAIL = '<p>✓ Pause, skip, or cancel anytime</p><p>✓ 30-day money-back guarantee</p>';

/**
 * Target descriptions, in the house ✓ style already used by plan 11150631 and
 * the bar soap plan. Each keeps its own cadence line so the picker still tells a
 * customer how often the box arrives.
 */
const COPY = {
  11134099: SAVE_LINE + SHIPPING_LINE + '<p>✓ Delivered every 30 days</p>' + TAIL,
  11134100: SAVE_LINE + SHIPPING_LINE + '<p>✓ Delivered every month</p>' + TAIL,
  11151699: SAVE_LINE + SHIPPING_LINE + '<p>✓ Four bars, delivered every four months</p>' + TAIL,
};

const hasShipping = (t) => /free ship/i.test(String(t ?? '').replace(/<[^>]+>/g, ' '));
const log = (...a) => console.log(...a);

/** Cadence + discount, the two things a destructive PUT could silently move. */
function fingerprint(sellingPlan) {
  return JSON.stringify({
    deliver: [sellingPlan.delivery_policy?.frequency, sellingPlan.delivery_policy?.interval],
    bill: [sellingPlan.billing_policy?.frequency, sellingPlan.billing_policy?.interval],
    discount: sellingPlan.pricing_polices?.[0]?.discount?.value,
    position: sellingPlan.position,
  });
}

// ── survey every plan so the gaps this script cannot fix are still reported ──

const all = await listPlans();
const unreachable = [];
for (const p of all) {
  const plans = p.selling_plans ?? [];
  for (const sp of plans) {
    if (hasShipping(sp.description)) continue;
    if (plans.length === 1 && COPY[p.id]) continue; // handled below
    unreachable.push(`plan ${p.id} pos${sp.position} — ${sp.billing_policy?.frequency} ${sp.billing_policy?.interval} ("${sp.name}")`);
  }
}

log(`${Object.keys(COPY).length} single-selling-plan plans are API-writable.`);
if (!APPLY) log('\nDRY RUN — re-run with --apply to write.\n');

for (const [id, description] of Object.entries(COPY)) {
  const before = await getPlan(id);
  const sp = before.selling_plans?.[0];

  if (!sp) { log(`✗ ${id}: no selling plan found — skipping`); continue; }
  if (before.selling_plans.length !== 1) {
    log(`✗ ${id}: has ${before.selling_plans.length} selling plans — refusing, this API can only write position 1`);
    continue;
  }
  if (hasShipping(sp.description)) { log(`· ${id}: already mentions free shipping — skipping`); continue; }

  const fpBefore = fingerprint(sp);
  log(`→ ${id} (${sp.billing_policy?.frequency} ${sp.billing_policy?.interval}, ${sp.pricing_polices?.[0]?.discount?.value}% off)`);

  if (!APPLY) continue;

  // Echo every field back verbatim; only `description` differs.
  await updatePlan(id, {
    name: before.name,
    description,
    selling_plans: [{
      name: sp.name,
      description,
      delivery_policy: sp.delivery_policy,
      billing_policy: sp.billing_policy,
      pricing_polices: sp.pricing_polices,
      position: sp.position,
      is_recommended: sp.is_recommended,
    }],
  });

  const after = await getPlan(id);
  const spAfter = after.selling_plans?.[0];
  const fpAfter = fingerprint(spAfter);

  if (fpAfter !== fpBefore) {
    throw new Error(
      `${id}: THE WRITE MOVED SOMETHING IT SHOULD NOT HAVE.\n  before ${fpBefore}\n  after  ${fpAfter}\n` +
      `  Fix this plan in the Recurpay admin UI before running anything else.`
    );
  }
  if (!hasShipping(spAfter.description)) throw new Error(`${id}: description did not take`);

  log(`  ✓ copy updated, cadence and discount unchanged`);
}

if (unreachable.length) {
  log(`\nStill missing the line, and NOT writable by this API (edit in the Recurpay admin UI):`);
  for (const u of unreachable) log(`  - ${u}`);
  log(`\n  Positions 2+ cannot be reached: Recurpay rejects any payload whose`);
  log(`  selling_plans array holds more than one item, so anything sent lands at`);
  log(`  position 1 and would overwrite a live cadence.`);
}
