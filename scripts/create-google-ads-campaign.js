/**
 * Create Google Ads Campaign — RSC | Lotion | Search
 *
 * One-shot setup script. Creates the full campaign structure defined in:
 *   docs/superpowers/specs/2026-03-19-google-ads-campaign-design.md
 *
 * Usage:
 *   node scripts/create-google-ads-campaign.js --dry-run   (print operations, don't send)
 *   node scripts/create-google-ads-campaign.js             (create campaign in Google Ads)
 *
 * Resources are created in sequential mutate calls because each step depends
 * on the resource name returned by the previous step (budget → campaign →
 * ad groups → RSAs + keywords + negatives).
 */

import { mutate, CUSTOMER_ID } from '../lib/google-ads.js';

const DRY_RUN = process.argv.includes('--dry-run');

// ── Ad copy ───────────────────────────────────────────────────────────────────
const lotionHeadlines = [
  'Real Coconut Oil Body Lotion',
  'Only 6 Clean Ingredients',
  'Free of Toxins & Harsh Chemicals',
  'Deep Moisture That Lasts All Day',
  'Non-Toxic Lotion for Dry Skin',
  'Made With Organic Coconut Oil',
  'No Parabens, SLS, or Fragrance',
  'Shop Real Skin Care Lotion',
  'Lightweight & Fast Absorbing',
  'Clean Beauty. Real Ingredients.',
  'Feel the Difference in One Use',
  '100% Natural Body Lotion',
  'Try Our Coconut Breeze Formula',
  'Ships Fast — Order Today',
  'Clean Lotion Your Skin Will Love',
].map(text => ({ text }));

const lotionDescriptions = [
  { text: 'Moisturize without the mystery ingredients. Our coconut oil body lotion is made with only 6 real, clean ingredients you can actually pronounce. No fillers, no fragrance.' },
  { text: 'Ditch the toxins. Real Skin Care body lotion is non-toxic, fragrance-free, and made with organic coconut oil — gentle enough for sensitive skin, effective enough for extremely dry skin.' },
  { text: 'Real people. Real results. Our coconut lotion absorbs fast, locks in moisture, and skips the harmful chemicals found in most drugstore brands. Clean beauty that works.' },
  { text: 'Not sure what\'s in your lotion? Ours has 6 ingredients and nothing to hide. Organic coconut oil base, zero parabens, zero SLS. Try Real Skin Care today.' },
];

const naturalHeadlines = [
  'Natural Body Lotion That Works',
  'Only 6 Clean Ingredients Total',
  'Organic Coconut Oil Formula',
  'No Parabens. No SLS. No Toxins.',
  'Best Non-Toxic Body Lotion',
  'Clean Body Lotion for Dry Skin',
  'Skip the Harsh Chemicals',
  'Real Ingredients. Real Results.',
  'Fragrance-Free & Gentle Formula',
  'Natural Lotion for Sensitive Skin',
  'Lightweight & Deeply Moisturizing',
  'Shop Real Skin Care',
  'Made for Dry & Sensitive Skin',
  'Cruelty-Free. Vegan. Clean.',
  'Your Skin Knows the Difference',
].map(text => ({ text }));

const naturalDescriptions = [
  { text: 'Tired of body lotions packed with chemicals you can\'t pronounce? Real Skin Care is made with just 6 ingredients — organic coconut oil, shea butter, and nothing you wouldn\'t recognize.' },
  { text: 'Non-toxic, fragrance-free, and actually moisturizing. Our natural body lotion is formulated for dry and sensitive skin — no parabens, no SLS, no artificial fragrance. Clean skincare, simplified.' },
  { text: 'Most body lotions have 20+ ingredients. Ours has 6. Real Skin Care natural lotion is lightweight, fast-absorbing, and free of the toxins your skin doesn\'t need. Clean beauty made simple.' },
  { text: 'Your lotion should heal, not harm. Real Skin Care uses organic coconut oil as the base for a clean, effective body lotion — gentle on skin, tough on dry patches. Free of harsh chemicals.' },
];

const LOTION_URL = 'https://www.realskincare.com/products/coconut-lotion?utm_source=google&utm_medium=cpc&utm_campaign=rsc-lotion-search';

// ── Keywords ──────────────────────────────────────────────────────────────────
const lotionKeywords = [
  { text: 'coconut lotion',             matchType: 'EXACT' },
  { text: 'coconut body lotion',        matchType: 'EXACT' },
  { text: 'coconut lotion for dry skin', matchType: 'PHRASE' },
  { text: 'coconut oil lotion',         matchType: 'PHRASE' },
  { text: 'buy coconut lotion',         matchType: 'EXACT' },
  { text: 'coconut lotion natural',     matchType: 'EXACT' },
];

const naturalKeywords = [
  { text: 'natural body lotion',          matchType: 'EXACT' },
  { text: 'clean body lotion',            matchType: 'EXACT' },
  { text: 'non toxic body lotion',        matchType: 'EXACT' },
  { text: 'natural lotion for dry skin',  matchType: 'PHRASE' },
  { text: 'fragrance free body lotion',   matchType: 'PHRASE' },
  { text: 'organic body lotion',          matchType: 'EXACT' },
];

const negativeTerms = ['DIY', 'recipe', 'homemade', 'wholesale', 'bulk', 'free sample', 'cheap', 'dollar', 'sunscreen', 'face', 'baby', 'dog', 'cat', 'amazon', 'walmart', 'target'];

// ── Extensions ────────────────────────────────────────────────────────────────
const BASE_UTM = 'utm_source=google&utm_medium=cpc&utm_campaign=rsc-lotion-search';
const DOMAIN = 'https://www.realskincare.com';
const sitelinks = [
  { text: 'Shop Coconut Lotion',    url: `${DOMAIN}/products/coconut-lotion?${BASE_UTM}&utm_content=sitelink-coconut-lotion` },
  { text: 'Natural Deodorant',      url: `${DOMAIN}/products/coconut-oil-deodorant?${BASE_UTM}&utm_content=sitelink-deodorant` },
  { text: 'Coconut Oil Toothpaste', url: `${DOMAIN}/products/coconut-oil-toothpaste?${BASE_UTM}&utm_content=sitelink-toothpaste` },
  { text: 'All Products',           url: `${DOMAIN}/collections/all?${BASE_UTM}&utm_content=sitelink-all` },
];
const calloutTexts = ['6-Ingredient Formula', 'Fragrance Free', 'Vegan & Cruelty-Free', 'Ships Fast'];
const snippetValues = ['Organic Coconut Oil', 'Shea Butter', 'Vitamin E'];

// ── Main — sequential mutate calls ───────────────────────────────────────────
// Each step depends on resource names returned by the previous step.
async function main() {
  console.log('Create Google Ads Campaign — RSC | Lotion | Search\n');
  console.log(`Customer ID: ${CUSTOMER_ID}`);

  if (DRY_RUN) {
    console.log('\nDRY RUN — no API calls will be made');
    console.log('Sequential mutate calls that will be sent:');
    console.log('  Step 1: campaignBudgetOperation — RSC Lotion Budget ($10/day, explicitlyShared=false)');
    console.log('  Step 2: campaignOperation — RSC | Lotion | Search (PAUSED, manualCpc)');
    console.log('  Step 3: adGroupOperation x2 — Coconut Lotion, Natural Body Lotion');
    console.log('  Step 4: adGroupAdOperation x2 — RSA per ad group');
    console.log('  Step 5: adGroupCriterionOperation x12 — keywords');
    console.log('  Step 6: campaignCriterionOperation x16 — negative keywords');
    console.log('  Step 7: campaignCriterionOperation x2 — US geo target + mobile +30% bid adj');
    console.log('  Step 8: assetOperation x9 — 4 sitelinks + 4 callouts + 1 structured snippet');
    console.log('  Step 8b: campaignAssetOperation x9 — link assets to campaign');
    console.log('\nDry run complete. Run without --dry-run to create.');
    return;
  }

  // Step 1: Create budget
  process.stdout.write('\nStep 1: Creating campaign budget... ');
  const budgetResult = await mutate([{
    campaignBudgetOperation: {
      create: { name: 'RSC Lotion Budget', amountMicros: '10000000', deliveryMethod: 'STANDARD', explicitlyShared: false },
    },
  }]);
  const budgetName = budgetResult.mutateOperationResponses?.[0]?.campaignBudgetResult?.resourceName;
  if (!budgetName) throw new Error('No budget resource name returned: ' + JSON.stringify(budgetResult));
  console.log(`✓  ${budgetName}`);

  // Step 2: Create campaign using real budget resource name
  process.stdout.write('Step 2: Creating campaign... ');
  const campaignResult = await mutate([{
    campaignOperation: {
      create: {
        name: 'RSC | Lotion | Search',
        advertisingChannelType: 'SEARCH',
        status: 'PAUSED',
        campaignBudget: budgetName,
        networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false },
        geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE_OR_INTEREST' },
        manualCpc: { enhancedCpcEnabled: false },
      },
    },
  }]);
  const campaignName = campaignResult.mutateOperationResponses?.[0]?.campaignResult?.resourceName;
  if (!campaignName) throw new Error('No campaign resource name returned: ' + JSON.stringify(campaignResult));
  console.log(`✓  ${campaignName}`);

  // Step 3: Create ad groups using real campaign resource name
  process.stdout.write('Step 3: Creating ad groups... ');
  const agResult = await mutate([
    { adGroupOperation: { create: { name: 'Coconut Lotion', campaign: campaignName, status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidMicros: '800000' } } },
    { adGroupOperation: { create: { name: 'Natural Body Lotion', campaign: campaignName, status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidMicros: '800000' } } },
  ]);
  const agResponses = agResult.mutateOperationResponses || [];
  const lotionAgName = agResponses[0]?.adGroupResult?.resourceName;
  const naturalAgName = agResponses[1]?.adGroupResult?.resourceName;
  if (!lotionAgName || !naturalAgName) throw new Error('No ad group resource names returned: ' + JSON.stringify(agResult));
  console.log(`✓  ${lotionAgName}, ${naturalAgName}`);

  // Step 4: Create RSAs using real ad group resource names
  process.stdout.write('Step 4: Creating responsive search ads... ');
  await mutate([
    { adGroupAdOperation: { create: { adGroup: lotionAgName, status: 'ENABLED', ad: { responsiveSearchAd: { headlines: lotionHeadlines, descriptions: lotionDescriptions }, finalUrls: [LOTION_URL] } } } },
    { adGroupAdOperation: { create: { adGroup: naturalAgName, status: 'ENABLED', ad: { responsiveSearchAd: { headlines: naturalHeadlines, descriptions: naturalDescriptions }, finalUrls: [LOTION_URL] } } } },
  ]);
  console.log('✓');

  // Step 5: Create keywords using real ad group resource names
  process.stdout.write('Step 5: Creating keywords... ');
  await mutate([
    ...lotionKeywords.map(kw => ({ adGroupCriterionOperation: { create: { adGroup: lotionAgName, status: 'ENABLED', keyword: { text: kw.text, matchType: kw.matchType }, cpcBidMicros: '800000' } } })),
    ...naturalKeywords.map(kw => ({ adGroupCriterionOperation: { create: { adGroup: naturalAgName, status: 'ENABLED', keyword: { text: kw.text, matchType: kw.matchType }, cpcBidMicros: '800000' } } })),
  ]);
  console.log('✓');

  // Step 6: Create negative keywords using real campaign resource name
  process.stdout.write('Step 6: Creating negative keywords... ');
  await mutate(negativeTerms.map(text => ({
    campaignCriterionOperation: { create: { campaign: campaignName, negative: true, keyword: { text, matchType: 'BROAD' } } },
  })));
  console.log('✓');

  // Step 7: US-only geo targeting + mobile +30% bid adjustment
  process.stdout.write('Step 7: Setting geo targeting and device bid adjustment... ');
  await mutate([
    { campaignCriterionOperation: { create: { campaign: campaignName, location: { geoTargetConstant: 'geoTargetConstants/2840' } } } }, // United States
    { campaignCriterionOperation: { create: { campaign: campaignName, device: { type: 'MOBILE' }, bidModifier: 1.3 } } }, // +30%
  ]);
  console.log('✓');

  // Step 8: Ad extensions — sitelinks, callouts, structured snippet
  // Google Ads API v18 uses Assets: create asset first, then link to campaign.
  process.stdout.write('Step 8: Creating ad extension assets... ');
  const assetOps = [
    ...sitelinks.map(sl => ({ assetOperation: { create: { sitelinkAsset: { linkText: sl.text, finalUrls: [sl.url] } } } })),
    ...calloutTexts.map(text => ({ assetOperation: { create: { calloutAsset: { calloutText: text } } } })),
    { assetOperation: { create: { structuredSnippetAsset: { header: 'Ingredients', values: snippetValues } } } },
  ];
  const assetResult = await mutate(assetOps);
  const assetNames = (assetResult.mutateOperationResponses || []).map(r => r.assetResult?.resourceName).filter(Boolean);
  console.log(`✓ (${assetNames.length} assets)`);

  process.stdout.write('Step 8b: Linking assets to campaign... ');
  const fieldTypes = [
    ...sitelinks.map(() => 'SITELINK'),
    ...calloutTexts.map(() => 'CALLOUT'),
    'STRUCTURED_SNIPPET',
  ];
  await mutate(assetNames.map((name, i) => ({
    campaignAssetOperation: { create: { campaign: campaignName, asset: name, fieldType: fieldTypes[i] } },
  })));
  console.log('✓');

  console.log('\n✓ Campaign created. Campaign is PAUSED — review in Google Ads UI before enabling.');
  console.log(`  Campaign: ${campaignName}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
