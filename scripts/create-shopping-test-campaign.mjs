/**
 * Create the paused Standard Shopping test campaigns (Google Ads flight plan).
 *
 * Budget is split 60/40 across the two hero Coconut Body Lotion scents Sean
 * chose. Standard Shopping sets budget at the campaign level and Maximize Clicks
 * ignores per-product bids for allocation, so the ONLY way to enforce a budget
 * split is one campaign per product with its own daily budget:
 *
 *   Pure Unscented   $6/day  (60%)  item_id shopify_US_7691181686954_45828179165354
 *   Coconut Breeze   $4/day  (40%)  item_id shopify_US_7691181686954_44414530781354
 *
 *   Type:    Standard Shopping, Maximize Clicks
 *   Feed:    Merchant Center 729030085, feed label "US"
 *   Scope:   each campaign advertises exactly one variant (item_id), all else excluded
 *   Status:  PAUSED (built for review; Sean enables them manually)
 *
 * The lotion is ~70% of store revenue ($2,813/111u Mar–Jul); these two scents are
 * the chosen focus. Total $10/day.
 *
 * Usage:
 *   node scripts/create-shopping-test-campaign.mjs            # dry-run: print ops
 *   node scripts/create-shopping-test-campaign.mjs --apply    # create in the account
 *
 * See docs/superpowers/plans/2026-07-20-coconut-oil-lotion-google-ads-flight-plan.NOTES.md
 */
import { mutate, gaqlQuery, CUSTOMER_ID } from '../lib/google-ads.js';

const APPLY = process.argv.includes('--apply');
const CID = CUSTOMER_ID;
const C = `customers/${CID}`;

const MERCHANT_ID = 729030085;
const FEED_LABEL = 'US';

// One campaign per product so the daily budget enforces the 60/40 split.
const PRODUCTS = [
  { label: 'Pure Unscented', budget: 6, itemId: 'shopify_US_7691181686954_45828179165354' },
  { label: 'Coconut Breeze', budget: 4, itemId: 'shopify_US_7691181686954_44414530781354' },
];

const NAME_PREFIX = 'RSC | Shopping Test | Lotion';

function buildOperations({ label, budget, itemId }) {
  const budgetRN = `${C}/campaignBudgets/-1`;
  const campaignRN = `${C}/campaigns/-2`;
  const adGroupRN = `${C}/adGroups/-3`;
  const adGroupAdRN = `${C}/adGroupAds/-3~-4`;
  const listingRootRN = `${C}/adGroupCriteria/-3~-5`;  // subdivision (root)
  const listingItemRN = `${C}/adGroupCriteria/-3~-6`;  // included: this item_id
  const listingOtherRN = `${C}/adGroupCriteria/-3~-7`; // excluded: everything else
  const name = `${NAME_PREFIX} - ${label}`;
  return [
    { campaignBudgetOperation: { create: {
      resourceName: budgetRN,
      name: `${name} | Budget ($${budget}/day)`,
      amountMicros: budget * 1_000_000,
      deliveryMethod: 'STANDARD',
      explicitlyShared: false,
    } } },
    { campaignOperation: { create: {
      resourceName: campaignRN,
      name,
      status: 'PAUSED',
      advertisingChannelType: 'SHOPPING',
      campaignBudget: budgetRN,
      containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      targetSpend: {}, // Maximize Clicks
      shoppingSetting: { merchantId: MERCHANT_ID, feedLabel: FEED_LABEL, campaignPriority: 0, enableLocal: false },
      networkSettings: { targetGoogleSearch: true, targetSearchNetwork: true, targetContentNetwork: false, targetPartnerSearchNetwork: false },
    } } },
    { adGroupOperation: { create: {
      resourceName: adGroupRN, name: label, campaign: campaignRN, status: 'ENABLED', type: 'SHOPPING_PRODUCT_ADS',
    } } },
    { adGroupAdOperation: { create: {
      resourceName: adGroupAdRN, adGroup: adGroupRN, status: 'ENABLED', ad: { shoppingProductAd: {} },
    } } },
    // Root: subdivide by item_id.
    { adGroupCriterionOperation: { create: {
      resourceName: listingRootRN, adGroup: adGroupRN, status: 'ENABLED', listingGroup: { type: 'SUBDIVISION' },
    } } },
    // Included: this one variant.
    { adGroupCriterionOperation: { create: {
      resourceName: listingItemRN, adGroup: adGroupRN, status: 'ENABLED', cpcBidMicros: 400000, // $0.40 ceiling
      listingGroup: { type: 'UNIT', parentAdGroupCriterion: listingRootRN, caseValue: { productItemId: { value: itemId } } },
    } } },
    // Excluded: everything else.
    { adGroupCriterionOperation: { create: {
      resourceName: listingOtherRN, adGroup: adGroupRN, negative: true,
      listingGroup: { type: 'UNIT', parentAdGroupCriterion: listingRootRN, caseValue: { productItemId: {} } },
    } } },
  ];
}

const totalBudget = PRODUCTS.reduce((s, p) => s + p.budget, 0);
console.log(`Standard Shopping test campaigns — customer ${CID}`);
console.log(`  Total:   $${totalBudget}/day across ${PRODUCTS.length} single-product campaigns (Maximize Clicks)`);
for (const p of PRODUCTS) {
  console.log(`   • ${NAME_PREFIX} - ${p.label}: $${p.budget}/day → ${p.itemId}`);
}
console.log(`  Feed:    MC ${MERCHANT_ID} / label ${FEED_LABEL}`);
console.log(`  Status:  PAUSED (review then enable manually)\n`);

if (!APPLY) {
  console.log('DRY RUN — operations per campaign:\n');
  for (const p of PRODUCTS) {
    console.log(`### ${NAME_PREFIX} - ${p.label}`);
    console.log(JSON.stringify(buildOperations(p), null, 2));
  }
  console.log('\nRe-run with --apply to create.');
  process.exit(0);
}

// Idempotency: remove any leftover test campaigns/budgets from prior runs.
const stale = await gaqlQuery(`
  SELECT campaign.resource_name FROM campaign
  WHERE campaign.name LIKE 'RSC | Shopping Test%' AND campaign.status != 'REMOVED'
`);
const staleBudgets = await gaqlQuery(`
  SELECT campaign_budget.resource_name FROM campaign_budget
  WHERE campaign_budget.name LIKE 'RSC | Shopping Test%' AND campaign_budget.status = 'ENABLED'
`);
const cleanupOps = [
  ...stale.map(x => ({ campaignOperation: { remove: x.campaign.resourceName } })),
  ...staleBudgets.map(x => ({ campaignBudgetOperation: { remove: x.campaignBudget.resourceName } })),
];
if (cleanupOps.length) {
  console.log(`Cleaning up ${cleanupOps.length} stale test resource(s) from a prior run...`);
  await mutate(cleanupOps);
}

for (const p of PRODUCTS) {
  const res = await mutate(buildOperations(p));
  const camp = (res.mutateOperationResponses || []).find(r => r.campaignResult)?.campaignResult;
  console.log(`Created ${NAME_PREFIX} - ${p.label} → ${camp?.resourceName}`);
}

// Read-back
const check = await gaqlQuery(`
  SELECT campaign.id, campaign.name, campaign.status, campaign.bidding_strategy_type, campaign_budget.amount_micros
  FROM campaign WHERE campaign.name LIKE 'RSC | Shopping Test%' AND campaign.status != 'REMOVED'
  ORDER BY campaign.name
`);
console.log('\nRead-back:');
for (const x of check) {
  const c = x.campaign, b = Number(x.campaignBudget?.amountMicros || 0) / 1e6;
  console.log(`  [${c.status}] ${c.name} | ${c.biddingStrategyType} | $${b}/day`);
}
