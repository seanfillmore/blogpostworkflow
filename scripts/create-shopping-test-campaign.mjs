/**
 * Create the paused Standard Shopping test campaign (Google Ads flight plan).
 *
 *   Type:    Standard Shopping (advertising_channel_type = SHOPPING)
 *   Budget:  $10/day
 *   Bidding: Maximize Clicks (target_spend) — no ROAS target until a conv base exists
 *   Feed:    Merchant Center 729030085, feed label "US"
 *   Scope:   ONLY the hero Coconut Body Lotion (feed product_type "lotion" = all
 *            5 scent variants + any future scent), everything else excluded. The
 *            lotion is ~70% of store revenue ($2,813/111u Mar–Jul); concentrating
 *            $10/day there beats spreading it across 36 SKUs where Maximize Clicks
 *            would just buy the cheapest low-intent clicks.
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
const CAMPAIGN_NAME = 'RSC | Shopping Test | Coconut Body Lotion';
const PRODUCT_TYPE = 'lotion'; // feed product_type_level1 that isolates the hero lotion

// Temp (negative) resource names, wired together within the single mutate.
const budgetRN = `${C}/campaignBudgets/-1`;
const campaignRN = `${C}/campaigns/-2`;
const adGroupRN = `${C}/adGroups/-3`;
const adGroupAdRN = `${C}/adGroupAds/-3~-4`; // ad group ad temp id
const listingRootRN = `${C}/adGroupCriteria/-3~-5`;   // subdivision (root)
const listingLotionRN = `${C}/adGroupCriteria/-3~-6`; // included: product_type = lotion
const listingOtherRN = `${C}/adGroupCriteria/-3~-7`;  // excluded: everything else

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
        name: 'Coconut Body Lotion',
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
    // Root: subdivide by product_type (level 1).
    adGroupCriterionOperation: {
      create: {
        resourceName: listingRootRN,
        adGroup: adGroupRN,
        status: 'ENABLED',
        listingGroup: { type: 'SUBDIVISION' },
      },
    },
  },
  {
    // Included: product_type = "lotion" (the 5 hero-lotion variants).
    adGroupCriterionOperation: {
      create: {
        resourceName: listingLotionRN,
        adGroup: adGroupRN,
        status: 'ENABLED',
        cpcBidMicros: 400000, // $0.40 ceiling (Maximize Clicks)
        listingGroup: {
          type: 'UNIT',
          parentAdGroupCriterion: listingRootRN,
          caseValue: { productType: { level: 'LEVEL1', value: PRODUCT_TYPE } },
        },
      },
    },
  },
  {
    // Excluded: everything else (the "Other" bucket under the same dimension).
    adGroupCriterionOperation: {
      create: {
        resourceName: listingOtherRN,
        adGroup: adGroupRN,
        negative: true,
        listingGroup: {
          type: 'UNIT',
          parentAdGroupCriterion: listingRootRN,
          caseValue: { productType: { level: 'LEVEL1' } },
        },
      },
    },
  },
];

console.log(`Standard Shopping test campaign — customer ${CID}`);
console.log(`  Name:    ${CAMPAIGN_NAME}`);
console.log(`  Budget:  $${DAILY_BUDGET_USD}/day (Maximize Clicks)`);
console.log(`  Feed:    MC ${MERCHANT_ID} / label ${FEED_LABEL} / product_type "${PRODUCT_TYPE}" only`);
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
  WHERE campaign.name LIKE 'RSC | Shopping Test%' AND campaign.status != 'REMOVED'
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
