/**
 * Phase 0 Task 3 — list Google Ads conversion actions + their primary/secondary
 * status, so we can confirm Ads is bidding on `purchase`, not cart/checkout.
 *   node scripts/ga-conversion-actions.mjs
 */
import { gaqlQuery } from '../lib/google-ads.js';

const actions = await gaqlQuery(`
  SELECT conversion_action.name, conversion_action.category,
         conversion_action.type, conversion_action.status,
         conversion_action.primary_for_goal,
         conversion_action.origin, conversion_action.counting_type
  FROM conversion_action
  WHERE conversion_action.status != 'REMOVED'
`);
console.log('=== Conversion actions ===');
for (const r of actions) {
  const c = r.conversionAction || r.conversion_action || {};
  console.log(`  primary=${c.primaryForGoal ?? c.primary_for_goal}  [${c.status}] ${c.category}  "${c.name}"  (${c.type}, origin ${c.origin})`);
}

// Account-level conversion goals (the modern primary/secondary control)
try {
  const goals = await gaqlQuery(`
    SELECT customer_conversion_goal.category, customer_conversion_goal.origin,
           customer_conversion_goal.biddable
    FROM customer_conversion_goal
  `);
  console.log('\n=== Customer conversion goals (biddable = counts toward bidding) ===');
  for (const r of goals) {
    const g = r.customerConversionGoal || r.customer_conversion_goal || {};
    console.log(`  biddable=${g.biddable}  ${g.category}  origin ${g.origin}`);
  }
} catch (e) { console.log('\n(customer_conversion_goal query failed:', e.message.slice(0,120), ')'); }
