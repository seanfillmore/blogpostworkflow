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
import { isDirectRun } from '../lib/is-direct-run.js';

const APPLY = process.argv.includes('--apply');

const SHIPPING_LINE = '<p>✓ Free shipping on any subscription order</p>';
const TAIL = '<p>✓ Pause, skip, or cancel anytime</p><p>✓ 30-day money-back guarantee</p>';

/**
 * THE SAVE LINE IS DERIVED FROM THE PLAN, NEVER A CONSTANT.
 *
 * It was `Save 15% on every order`, hardcoded, which was true of all eight
 * plans on the day it was written. Recurpay plan 11152263 (the foam refill,
 * added 2026-09-05) runs at **5%** — deliberately, because refills are already
 * discounted and Sean chose not to stack another 15% on top. A constant would
 * have written a FALSE DISCOUNT CLAIM onto that plan the moment it became
 * writable, which is the same class of defect as every other claim gate in this
 * repo: copy asserting a number nobody re-checked against the thing it names.
 *
 * A plan with no percentage discount gets NO save line rather than an invented
 * one — omitting a benefit costs a little persuasion; inventing one is a lie.
 */
export function saveLine(sellingPlan) {
  const d = (sellingPlan?.pricing_polices ?? sellingPlan?.pricing_policies ?? [])[0]?.discount;
  if (!d || d.type !== 'percentage') return '';
  const pct = Number(d.value);
  if (!Number.isFinite(pct) || pct <= 0) return '';
  return `<p>✓ Save ${pct}% on every order</p>`;
}

/**
 * Target descriptions, in the house ✓ style already used by plan 11150631 and
 * the bar soap plan. Each keeps its own cadence line so the picker still tells a
 * customer how often the box arrives.
 */
const CADENCE_LINE = {
  11134099: '<p>✓ Delivered every 30 days</p>',
  11134100: '<p>✓ Delivered every month</p>',
  11151699: '<p>✓ Four bars, delivered every four months</p>',
};

/** The house ✓ block for one live selling plan, with ITS discount. */
export function describe(sellingPlan, cadenceLine) {
  return saveLine(sellingPlan) + SHIPPING_LINE + cadenceLine + TAIL;
}

const COPY = CADENCE_LINE;

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

// ── everything below is the RUN ────────────────────────────────────────────
//
// Guarded because IMPORTING THIS FILE USED TO EXECUTE IT — the pure helpers
// above (saveLine, describe) are what the tests need, and importing them fired
// listPlans() and a getPlan() per writable plan against LIVE Recurpay. Dry by
// default so nothing was written, but a test suite that makes production API
// calls is the exact failure `reference_agents_run_on_import` documents, and it
// was found by a test taking 1.9 seconds when it should take milliseconds.
if (isDirectRun(import.meta.url)) {
  // ── survey every plan so the gaps this script cannot fix are still reported ──

  const all = await listPlans();
  const unreachable = [];
  for (const p of all) {
    const plans = p.selling_plans ?? [];
    for (const sp of plans) {
      if (hasShipping(sp.description)) continue;
      if (plans.length === 1 && COPY[p.id]) continue; // handled below
      const every = `${sp.billing_policy?.frequency} ${sp.billing_policy?.interval}`;
      unreachable.push({
        label: `plan ${p.id} pos${sp.position} — ${every} ("${sp.name}")`,
        // Paste-ready, and built from THIS plan's own discount — so a 5% plan can
        // never be handed 15% copy.
        html: describe(sp, `<p>✓ Delivered every ${every}${Number(sp.billing_policy?.frequency) === 1 ? '' : 's'}</p>`),
      });
    }
  }

  log(`${Object.keys(COPY).length} single-selling-plan plans are API-writable.`);
  if (!APPLY) log('\nDRY RUN — re-run with --apply to write.\n');

  for (const [id, cadenceLine] of Object.entries(COPY)) {
    const before = await getPlan(id);
    const sp = before.selling_plans?.[0];
    const description = sp ? describe(sp, cadenceLine) : null;

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
    for (const u of unreachable) log(`  - ${u.label}`);
    log(`\n  Positions 2+ cannot be reached: Recurpay rejects any payload whose`);
    log(`  selling_plans array holds more than one item, so anything sent lands at`);
    log(`  position 1 and would overwrite a live cadence.`);
    log(`\n  Paste this into each position's Description in the Recurpay admin`);
    log(`  (each carries ITS OWN discount, read from the live plan):\n`);
    for (const u of unreachable) log(`  ${u.label}\n    ${u.html}\n`);
  }

}
