/**
 * Audit every Recurpay selling plan: cadence, discount, and whether the API can
 * write it.
 *
 *   node scripts/recurpay-audit.mjs
 *
 * Sean's rule is flat 15% at every frequency — a bigger discount for a longer
 * cycle is not the goal; removing the incentive to pick monthly is. Over-supply
 * ("more than I need") is the top cancellation driver against a ~65% lifetime
 * cancel rate, so any cadence discounted BELOW 15% is actively pushing customers
 * onto shorter cycles and into churn.
 *
 * Anything flagged "UI only" cannot be fixed from here — Recurpay's API writes
 * position 1 exclusively. See CONSTRAINTS in lib/recurpay.js.
 */

import { listSellingPlans } from '../lib/recurpay.js';

const TARGET = 15;
const sps = await listSellingPlans();

console.log('PLAN       POS  CADENCE      DISCOUNT  WRITABLE      NAME');
for (const s of sps.sort((a, b) => a.planId - b.planId || a.position - b.position)) {
  const off = s.discountPercent !== TARGET;
  console.log(
    String(s.planId).padEnd(10),
    String(s.position).padEnd(4),
    s.cadence.padEnd(12),
    `${s.discountPercent}%`.padEnd(9),
    (s.apiWritable ? 'api' : 'UI only').padEnd(13),
    s.name,
    off ? '  <<< not 15%' : ''
  );
}

const off = sps.filter(s => s.discountPercent !== TARGET);
if (!off.length) {
  console.log(`\nAll ${sps.length} selling plans are at ${TARGET}%.`);
  process.exit(0);
}

console.log(`\n${off.length} selling plan(s) not at ${TARGET}%:`);
for (const s of off) {
  console.log(`  plan ${s.planId} position ${s.position} — "${s.name}" (${s.cadence}) at ${s.discountPercent}%`);
}

const uiOnly = off.filter(s => !s.apiWritable);
if (uiOnly.length) {
  console.log(
    `\n${uiOnly.length} of these are at position 2+ and CANNOT be fixed via the API.\n` +
    `Fix in Shopify admin -> Apps -> Recurpay -> Plans. Change only the discount field;\n` +
    `do not touch the delivery interval (see lib/recurpay.js constraint 3).`
  );
}
process.exit(1);
