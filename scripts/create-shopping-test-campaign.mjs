/**
 * Create the paused Standard Shopping test campaign (Google Ads flight plan).
 *
 *   Type:    Standard Shopping (advertising_channel_type = SHOPPING)
 *   Budget:  $10/day
 *   Bidding: Maximize Clicks (target_spend) — no ROAS target until a conv base exists
 *   Feed:    Merchant Center 729030085, feed label "US"
 *   Scope:   all products (single root UNIT listing group) — refine to best-sellers
 *            after the first product/search-term report
 *   Status:  campaign PAUSED (built for review; Sean enables it manually)
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
const DAILY_BUDGET_USD = 10;
const CAMPAIGN_NAME = 'RSC | Shopping Test | All Products';

// Temp (negative) resource names, wired together within the single mutate.
const budgetRN = `${C}/campaignBudgets/-1`;
const campaignRN = `${C}/campaigns/-2`;
const adGroupRN = `${C}/adGroups/-3`;
const adGroupAdRN = `${C}/adGroupAds/-3~-4`; // ad group ad temp id
const listingRN = `${C}/adGroupCriteria/-3~-5`;

const operations = [
  {
    campaignBudgetOperation: {
      create: {
        resourceName: budgetRN,
        name: `RSC | Shopping Test | Budget ($${DAILY_BUDGET_USD}/day)`,
        amountMicros: DAILY_BUDGET_USD * 1_000_000,
        deliveryMethod: 'STANDARD',
        explicitlyShared: false,
      },
    },
  },
  {
    campaignOperation: {
      create: {
        resourceName: campaignRN,
        name: CAMPAIGN_NAME,
        status: 'PAUSED',
        advertisingChannelType: 'SHOPPING',
        campaignBudget: budgetRN,
        // Required since Google Ads API v19 — RSC ads are not political.
        containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
        // Maximize Clicks
        targetSpend: {},
        shoppingSetting: {
          merchantId: MERCHANT_ID,
          feedLabel: FEED_LABEL,
          campaignPriority: 0,
          enableLocal: false,
        },
        networkSettings: {
          targetGoogleSearch: true,
          targetSearchNetwork: true,
          targetContentNetwork: false,
          targetPartnerSearchNetwork: false,
        },
      },
    },
  },
  {
    adGroupOperation: {
      create: {
        resourceName: adGroupRN,
        name: 'All Products',
        campaign: campaignRN,
        status: 'ENABLED',
        type: 'SHOPPING_PRODUCT_ADS',
      },
    },
  },
  {
    adGroupAdOperation: {
      create: {
        resourceName: adGroupAdRN,
        adGroup: adGroupRN,
        status: 'ENABLED',
        ad: { shoppingProductAd: {} },
      },
    },
  },
  {
    // Root listing group = single UNIT node covering all products.
    adGroupCriterionOperation: {
      create: {
        resourceName: listingRN,
        adGroup: adGroupRN,
        status: 'ENABLED',
        listingGroup: { type: 'UNIT' },
        // Required on a biddable UNIT even under Maximize Clicks (acts as a ceiling).
        cpcBidMicros: 300000, // $0.30

      },
    },
  },
];

console.log(`Standard Shopping test campaign — customer ${CID}`);
console.log(`  Name:    ${CAMPAIGN_NAME}`);
console.log(`  Budget:  $${DAILY_BUDGET_USD}/day (Maximize Clicks)`);
console.log(`  Feed:    MC ${MERCHANT_ID} / label ${FEED_LABEL} / all products`);
console.log(`  Status:  PAUSED (review then enable manually)`);
console.log('');

if (!APPLY) {
  console.log('DRY RUN — operations that would be sent:\n');
  console.log(JSON.stringify(operations, null, 2));
  console.log('\nRe-run with --apply to create.');
  process.exit(0);
}

// Idempotency: remove any leftover test campaign/budget from a prior partial run
// (partial_failure commits successful ops, so a failed attempt can orphan a budget).
const stale = await gaqlQuery(`
  SELECT campaign.resource_name, campaign.name FROM campaign
  WHERE campaign.name = '${CAMPAIGN_NAME.replace(/'/g, "\\'")}'
`);
const staleBudgets = await gaqlQuery(`
  SELECT campaign_budget.resource_name FROM campaign_budget
  WHERE campaign_budget.name LIKE 'RSC | Shopping Test%'
    AND campaign_budget.status = 'ENABLED'
`);
const cleanupOps = [
  ...stale.map(x => ({ campaignOperation: { remove: x.campaign.resourceName } })),
  // Budgets can only be removed once no campaign references them, so remove after campaigns.
  ...staleBudgets.map(x => ({ campaignBudgetOperation: { remove: x.campaignBudget.resourceName } })),
];
if (cleanupOps.length) {
  console.log(`Cleaning up ${cleanupOps.length} stale test resource(s) from a prior run...`);
  await mutate(cleanupOps);
}

const res = await mutate(operations);
console.log('Created. Mutate results:');
for (const r of res.mutateOperationResponses || []) {
  const key = Object.keys(r)[0];
  console.log(`  ${key}: ${r[key]?.resourceName}`);
}

// Read back the campaign to confirm state.
const check = await gaqlQuery(`
  SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
         campaign.bidding_strategy_type, campaign.shopping_setting.merchant_id,
         campaign.shopping_setting.feed_label, campaign_budget.amount_micros
  FROM campaign WHERE campaign.name = '${CAMPAIGN_NAME.replace(/'/g, "\\'")}'
`);
console.log('\nRead-back:');
for (const x of check) {
  const c = x.campaign, b = Number(x.campaignBudget?.amountMicros || 0) / 1e6;
  console.log(`  [${c.status}] ${c.name} | ${c.advertisingChannelType} | ${c.biddingStrategyType} | $${b}/day | MC ${c.shoppingSetting?.merchantId}/${c.shoppingSetting?.feedLabel}`);
}
