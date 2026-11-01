#!/usr/bin/env node
/**
 * Create one Standard Shopping campaign that advertises a named set of items.
 *
 *   node scripts/create-shopping-campaign.mjs --name Toothpaste --budget 5 --bid 0.30 \
 *     --items shopify_US_1_2,rsc_pack_3 [--enable] [--apply]
 *
 * Dry by default. Copies the settings the live lotion test settled on after its
 * audits rather than the original builder's: MANUAL_CPC (no eCPC), Google Search
 * + search partners only, US location with PRESENCE geo targeting (the
 * PRESENCE_OR_INTEREST default served people outside the US), the shared
 * "RSC | Shopping — Master Negatives" list attached, every listed item_id
 * biddable at --bid and everything else excluded. Created PAUSED unless --enable.
 *
 * Named "RSC | Shopping Test | <name>" so agents/shopping-test-monitor and
 * agents/shopping-calibrator cover it. Refuses if that name already exists, and
 * never removes or edits another campaign (scripts/create-shopping-test-campaign.mjs
 * deletes every "RSC | Shopping Test" campaign before rebuilding; do not use it
 * to add one).
 */
import { CUSTOMER_ID, gaqlQuery, mutate } from '../lib/google-ads.js';
import { isDirectRun } from '../lib/is-direct-run.js';

export const NAME_PREFIX = 'RSC | Shopping Test';
export const MERCHANT_ID = 729030085;
export const MASTER_NEGATIVES_SHARED_SET = 12166869811;
const US = 'geoTargetConstants/2840';

export function buildShoppingCampaignOperations({ customer, name, budget, bid, items, enable }) {
  if (!items.length) throw new Error('need at least one --items id');
  if (!(budget > 0) || !(bid > 0)) throw new Error('budget and bid must be positive');
  const C = `customers/${customer}`;
  const budgetRN = `${C}/campaignBudgets/-1`;
  const campaignRN = `${C}/campaigns/-2`;
  const adGroupRN = `${C}/adGroups/-3`;
  const rootRN = `${C}/adGroupCriteria/-3~-5`;
  const full = `${NAME_PREFIX} | ${name}`;
  const ops = [
    { campaignBudgetOperation: { create: {
      resourceName: budgetRN, name: `${full} | Budget ($${budget}/day)`,
      amountMicros: Math.round(budget * 1e6), deliveryMethod: 'STANDARD', explicitlyShared: false,
    } } },
    { campaignOperation: { create: {
      resourceName: campaignRN, name: full, status: enable ? 'ENABLED' : 'PAUSED',
      advertisingChannelType: 'SHOPPING', campaignBudget: budgetRN,
      containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      manualCpc: { enhancedCpcEnabled: false },
      shoppingSetting: { merchantId: MERCHANT_ID, feedLabel: 'US', campaignPriority: 0, enableLocal: false },
      networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false, targetPartnerSearchNetwork: false },
      geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE', negativeGeoTargetType: 'PRESENCE' },
    } } },
    { campaignCriterionOperation: { create: { campaign: campaignRN, location: { geoTargetConstant: US } } } },
    { campaignSharedSetOperation: { create: { campaign: campaignRN, sharedSet: `${C}/sharedSets/${MASTER_NEGATIVES_SHARED_SET}` } } },
    { adGroupOperation: { create: { resourceName: adGroupRN, name, campaign: campaignRN, status: 'ENABLED', type: 'SHOPPING_PRODUCT_ADS' } } },
    { adGroupAdOperation: { create: { adGroup: adGroupRN, status: 'ENABLED', ad: { shoppingProductAd: {} } } } },
    { adGroupCriterionOperation: { create: { resourceName: rootRN, adGroup: adGroupRN, status: 'ENABLED', listingGroup: { type: 'SUBDIVISION' } } } },
  ];
  items.forEach((id, i) => ops.push({ adGroupCriterionOperation: { create: {
    resourceName: `${C}/adGroupCriteria/-3~-${10 + i}`, adGroup: adGroupRN, status: 'ENABLED', cpcBidMicros: Math.round(bid * 1e6),
    listingGroup: { type: 'UNIT', parentAdGroupCriterion: rootRN, caseValue: { productItemId: { value: String(id).toLowerCase() } } },
  } } }));
  ops.push({ adGroupCriterionOperation: { create: {
    resourceName: `${C}/adGroupCriteria/-3~-9`, adGroup: adGroupRN, negative: true,
    listingGroup: { type: 'UNIT', parentAdGroupCriterion: rootRN, caseValue: { productItemId: {} } },
  } } });
  return ops;
}

function arg(flag) { const i = process.argv.indexOf(flag); return i === -1 ? undefined : process.argv[i + 1]; }

async function main() {
  const name = arg('--name');
  const budget = Number(arg('--budget'));
  const bid = Number(arg('--bid'));
  const items = String(arg('--items') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const enable = process.argv.includes('--enable');
  if (!name) throw new Error('usage: --name <label> --budget <usd/day> --bid <usd> --items a,b [--enable] [--apply]');
  const full = `${NAME_PREFIX} | ${name}`;

  const clash = await gaqlQuery(`SELECT campaign.id FROM campaign WHERE campaign.name = '${full.replace(/'/g, "\\'")}' AND campaign.status != 'REMOVED'`);
  if (clash.length) throw new Error(`"${full}" already exists (campaign ${clash[0].campaign.id}); refusing to create a second`);

  const known = new Set((await gaqlQuery('SELECT shopping_product.item_id FROM shopping_product')).map((r) => String(r.shoppingProduct.itemId).toLowerCase()));
  const missing = items.filter((id) => !known.has(id.toLowerCase()));

  const ops = buildShoppingCampaignOperations({ customer: CUSTOMER_ID, name, budget, bid, items, enable });
  console.log(`${full}: $${budget}/day, $${bid.toFixed(2)} manual CPC, ${items.length} items, ${enable ? 'ENABLED' : 'PAUSED'}`);
  for (const id of items) console.log(`  ${id}${missing.includes(id) ? '   (not yet visible to Google Ads)' : ''}`);
  if (!process.argv.includes('--apply')) { console.log(`dry run: ${ops.length} operations; add --apply`); return; }
  const res = await mutate(ops);
  const camp = (res.mutateOperationResponses || []).find((r) => r.campaignResult)?.campaignResult;
  console.log(`created ${camp?.resourceName}`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
