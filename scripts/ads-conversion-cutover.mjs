#!/usr/bin/env node
/**
 * Google Ads conversion cutover — stop the GA4 purchase import from double-counting.
 *
 * Once agents/ads-conversion-uploader is live, the same Shopify sale can be counted
 * twice: once by the server-side upload ("RSC Shopify Purchase (server)") and once by
 * the GA4-imported "purchase" action. This demotes the GA4 import so it no longer
 * feeds the primary Conversions column.
 *
 * The GA4 action is NOT removed — it stays in the account as a secondary signal, still
 * visible under "All conversions", so the two sources can be compared. That comparison
 * is the ongoing check on how much GA4 was under-reporting.
 *
 * RUN THIS ONLY AFTER a real (non-dry-run) upload has succeeded. Running it earlier
 * leaves the account with no counted purchase conversion at all.
 *
 * Usage:
 *   node scripts/ads-conversion-cutover.mjs            # show what would change
 *   node scripts/ads-conversion-cutover.mjs --apply
 */

import { gaqlQuery, mutate } from '../lib/google-ads.js';

const APPLY = process.argv.includes('--apply');

const actions = await gaqlQuery(`
  SELECT conversion_action.resource_name, conversion_action.name, conversion_action.type,
         conversion_action.status, conversion_action.primary_for_goal,
         conversion_action.include_in_conversions_metric
  FROM conversion_action WHERE conversion_action.status = 'ENABLED'`);

console.log('Enabled conversion actions:');
for (const a of actions) {
  const c = a.conversionAction;
  console.log(`  ${c.name.padEnd(34)} ${String(c.type).padEnd(28)} primary=${!!c.primaryForGoal} counted=${!!c.includeInConversionsMetric}`);
}

const server = actions.find((a) => a.conversionAction.type === 'UPLOAD_CLICKS');
if (!server) {
  console.error('\nNo UPLOAD_CLICKS action found — refusing to demote GA4 and leave the account with no counted purchase conversion.');
  process.exit(1);
}

const ga4Purchase = actions.find(
  (a) => a.conversionAction.type === 'GOOGLE_ANALYTICS_4_PURCHASE' && a.conversionAction.primaryForGoal,
);
if (!ga4Purchase) {
  console.log('\nGA4 purchase import is already demoted — nothing to do.');
  process.exit(0);
}

console.log(`\nWill demote: ${ga4Purchase.conversionAction.name} (primary → secondary, out of the Conversions column)`);
console.log(`Keeping as primary: ${server.conversionAction.name}`);

if (!APPLY) {
  console.log('\nDry run. Re-run with --apply to make the change.');
  process.exit(0);
}

await mutate([{
  conversionActionOperation: {
    update: {
      resourceName: ga4Purchase.conversionAction.resourceName,
      primaryForGoal: false,
    },
    updateMask: 'primary_for_goal',
  },
}]);

console.log('Applied. Verifying...');
const after = await gaqlQuery(`
  SELECT conversion_action.name, conversion_action.primary_for_goal,
         conversion_action.include_in_conversions_metric
  FROM conversion_action WHERE conversion_action.status = 'ENABLED'`);
for (const a of after) {
  const c = a.conversionAction;
  console.log(`  ${c.name.padEnd(34)} primary=${!!c.primaryForGoal} counted=${!!c.includeInConversionsMetric}`);
}
