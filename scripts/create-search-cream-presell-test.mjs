#!/usr/bin/env node
/**
 * Google Search test: cream searches sent to the cream PRE-SELL page, not a product page.
 *
 *   node scripts/create-search-cream-presell-test.mjs            # dry run: print the plan
 *   node scripts/create-search-cream-presell-test.mjs --apply    # create it, PAUSED
 *
 * Why (Sean, 2026-11-07): every Google Search test so far sent traffic to a product,
 * collection or home page (2026 non-brand Search: ~$810 for ~750 clicks, 2 conversions).
 * Nothing has tested a page built for the search. This sends three tight exact-match
 * cream clusters to /pages/coconut-body-cream, each with its own headline via ?v=<key>
 * (data/presell/coconut-cream/content.json headlineVariants; the unscented variant also
 * preselects Pure Unscented, the only 7-ingredient-total scent).
 *
 * Economics: a click is worth about $0.40-0.58 to this store ($56 AOV x 0.7-1.0% clean
 * CVR), so bids are manual at $0.50 and every keyword was chosen with a DataForSEO
 * low top-of-page bid at or under ~$0.42 (2026-11-07). Judge at 150 clicks (~$75):
 * roughly 1 order per $56 spent is break-even. Orders are counted from Shopify (landing
 * URL carries utm_campaign=gsearch-cream-presell), never from Google's conversion column.
 * agents/shopping-test-monitor reports every ENABLED "RSC | " campaign daily, so this
 * one joins the digest the moment Sean enables it.
 *
 * Created PAUSED. Re-running removes any earlier copy of this campaign first.
 */
import { isDirectRun } from '../lib/is-direct-run.js';
import { checkSeoCopyFields } from '../lib/seo-copy-health-gate.js';
import { hasHealthClaim } from '../agents/ad-studio/health-claims.js';

export const NAME = 'RSC | Search Test | Cream Pre-sell';
export const BUDGET_PER_DAY = 8;
export const CPC_BID = 0.5;
export const PAGE = 'https://www.realskincare.com/pages/coconut-body-cream';
export const URL_SUFFIX = 'utm_source=google&utm_medium=cpc&utm_campaign=gsearch-cream-presell';

const SHARED_HEADLINES = [
  'Read the Whole Label', 'Goes On Like Butter', 'Buy 3 Jars, Get 1 Free', '30-Day Money-Back Guarantee',
  'Made in the USA', 'Handmade in Small Batches', 'Free Shipping Over $45', 'Why People Are Switching',
  '$28 a Jar', 'No Parabens',
];

export const AD_GROUPS = [
  {
    name: 'Coconut cream', variant: 'coconut', path: ['body-cream', 'coconut'],
    keywords: ['coconut body cream', 'coconut oil cream', 'coconut oil cream for skin', 'coconut oil skin cream', 'coconut moisturizer', 'coconut cream moisturizer'],
    headlines: ['Coconut Body Cream', 'Coconut Oil Body Cream', 'A 7-Ingredient Base', 'Thick, Rich Coconut Cream', 'Scented With Coconut Extract'],
    descriptions: [
      'A coconut body cream that starts from a 7-ingredient base you can read in one breath.',
      'Organic virgin coconut oil, beeswax and red palm oil. No parabens, no synthetic fragrance.',
      'Thick enough for heels, hands and elbows. Goes on like butter, with no slick film.',
      'Try it for 30 days. Not for you? Email us for a refund. No need to send the jar back.',
    ],
  },
  {
    name: 'Unscented cream', variant: 'unscented', path: ['body-cream', 'unscented'],
    keywords: ['fragrance free body cream', 'unscented body cream'],
    headlines: ['Unscented Body Cream', 'Fragrance Free Body Cream', 'Just 7 Ingredients', 'Nothing Added to the Base', 'No Fragrance, No Parabens'],
    descriptions: [
      'Pure Unscented body cream: 7 ingredients and nothing else. Read the whole label in one go.',
      'No synthetic fragrance and no essential oils. Organic virgin coconut oil and beeswax.',
      'Thick enough for heels, hands and elbows. Goes on like butter, with no slick film.',
      'Try it for 30 days. Not for you? Email us for a refund. No need to send the jar back.',
    ],
  },
  {
    name: 'Thick winter cream', variant: 'thick', path: ['body-cream', 'winter'],
    keywords: ['thick body cream', 'body cream for very dry skin', 'winter body cream', 'body cream for winter'],
    headlines: ['Thick Body Cream', 'Made for Dry Winter Skin', 'Thicker Than a Lotion', 'For Heels, Hands and Elbows', 'A Rich Cream for Winter'],
    descriptions: [
      'A thick coconut body cream for dry winter skin, from a 7-ingredient base you can read.',
      'Beeswax and coconut oil make it richer than a lotion. Goes on like butter, no slick film.',
      'A little goes a long way: one 4oz jar lasts about a month of nightly use. $28 a jar.',
      'Try it for 30 days. Not for you? Email us for a refund. No need to send the jar back.',
    ],
  },
];

export const CALLOUTS = ['30-Day Money-Back Promise', 'Made in the USA', 'Handmade in Small Batches', 'Free Shipping Over $45', 'Buy 3, Get 1 Free', 'No Synthetic Fragrance', 'No Parabens'];

// Exact-match keywords already keep the ads on these searches; these stop close variants
// drifting into recipe, DIY or face searches, and keep brand searches out of a test.
export const NEGATIVES = ['face', 'facial', 'recipe', 'diy', 'homemade', 'how to make', 'real skin care', 'realskincare'];

/** Every problem with the ad copy; an empty list means it may be sent. */
export function copyProblems(groups = AD_GROUPS, callouts = CALLOUTS) {
  const out = [];
  const check = (where, text, max) => {
    if (text.length > max) out.push(`${where}: ${text.length} chars > ${max}: "${text}"`);
    if (/[–—]/.test(text)) out.push(`${where}: dash in "${text}"`);
    if (/antiperspirant|mineral oil|petrolatum|paraffin/i.test(text)) out.push(`${where}: forbidden term in "${text}"`);
    if (!checkSeoCopyFields({ copy: text }).ok) out.push(`${where}: commercial claim gate: "${text}"`);
    if (hasHealthClaim(text)) out.push(`${where}: ad health-claim gate: "${text}"`);
  };
  for (const g of groups) {
    const heads = [...g.headlines, ...SHARED_HEADLINES];
    if (heads.length < 3 || heads.length > 15) out.push(`${g.name}: ${heads.length} headlines (3-15)`);
    if (new Set(heads.map((h) => h.toLowerCase())).size !== heads.length) out.push(`${g.name}: duplicate headline`);
    if (g.descriptions.length < 2 || g.descriptions.length > 4) out.push(`${g.name}: ${g.descriptions.length} descriptions (2-4)`);
    heads.forEach((h) => check(`${g.name} headline`, h, 30));
    g.descriptions.forEach((d) => check(`${g.name} description`, d, 90));
    g.path.forEach((p) => { if (p.length > 15) out.push(`${g.name}: path "${p}" > 15`); });
    // "7 ingredients" with no "base" is a total, true for Pure Unscented only (Coconut Breeze has 8)
    for (const t of [...heads, ...g.descriptions]) {
      if (/\b7 ingredients\b/i.test(t) && !/7-ingredient base/i.test(t) && g.variant !== 'unscented') out.push(`${g.name}: "${t}" claims 7 ingredients total on a scent that has 8`);
    }
  }
  callouts.forEach((c) => check('callout', c, 25));
  return out;
}

export const finalUrl = (variant) => `${PAGE}?v=${variant}`;

/** The mutate operations, in dependency order, all in one request (temp ids). */
export function buildOperations(C) {
  const budget = `${C}/campaignBudgets/-1`;
  const campaign = `${C}/campaigns/-2`;
  const ops = [
    { campaignBudgetOperation: { create: { resourceName: budget, name: `${NAME} | Budget ($${BUDGET_PER_DAY}/day)`, amountMicros: BUDGET_PER_DAY * 1_000_000, deliveryMethod: 'STANDARD', explicitlyShared: false } } },
    { campaignOperation: { create: {
      resourceName: campaign, name: NAME, status: 'PAUSED', advertisingChannelType: 'SEARCH', campaignBudget: budget,
      containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      manualCpc: { enhancedCpcEnabled: false },
      networkSettings: { targetGoogleSearch: true, targetSearchNetwork: false, targetContentNetwork: false, targetPartnerSearchNetwork: false },
      geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE' },
      finalUrlSuffix: URL_SUFFIX,
    } } },
    { campaignCriterionOperation: { create: { campaign, location: { geoTargetConstant: 'geoTargetConstants/2840' } } } }, // United States
    { campaignCriterionOperation: { create: { campaign, language: { languageConstant: 'languageConstants/1000' } } } }, // English
    ...NEGATIVES.map((text) => ({ campaignCriterionOperation: { create: { campaign, negative: true, keyword: { text, matchType: 'PHRASE' } } } })),
  ];
  let id = -10;
  for (const g of AD_GROUPS) {
    const adGroup = `${C}/adGroups/${id--}`;
    ops.push({ adGroupOperation: { create: { resourceName: adGroup, name: g.name, campaign, status: 'ENABLED', type: 'SEARCH_STANDARD', cpcBidMicros: Math.round(CPC_BID * 1_000_000) } } });
    for (const text of g.keywords) ops.push({ adGroupCriterionOperation: { create: { adGroup, status: 'ENABLED', keyword: { text, matchType: 'EXACT' } } } });
    ops.push({ adGroupAdOperation: { create: { adGroup, status: 'ENABLED', ad: {
      finalUrls: [finalUrl(g.variant)],
      responsiveSearchAd: {
        headlines: [...g.headlines, ...SHARED_HEADLINES].map((text) => ({ text })),
        descriptions: g.descriptions.map((text) => ({ text })),
        path1: g.path[0], path2: g.path[1],
      },
    } } } });
  }
  CALLOUTS.forEach((text) => {
    const asset = `${C}/assets/${id--}`;
    ops.push({ assetOperation: { create: { resourceName: asset, calloutAsset: { calloutText: text } } } });
    ops.push({ campaignAssetOperation: { create: { campaign, asset, fieldType: 'CALLOUT' } } });
  });
  return ops;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const problems = copyProblems();
  if (problems.length) { console.error('Ad copy refused:\n  ' + problems.join('\n  ')); process.exit(1); }

  console.log(`${NAME}: $${BUDGET_PER_DAY}/day, manual CPC $${CPC_BID}, exact match, Google Search only, US, PAUSED`);
  for (const g of AD_GROUPS) console.log(`  ${g.name} -> ${finalUrl(g.variant)}&${URL_SUFFIX}\n    ${g.keywords.map((k) => `[${k}]`).join(' ')}`);
  console.log(`  negatives (phrase): ${NEGATIVES.join(', ')}\n  callouts: ${CALLOUTS.join(' · ')}`);
  if (!apply) { console.log('\nDry run. Copy passed every check. Re-run with --apply to create it PAUSED.'); return; }

  const { mutate, gaqlQuery, CUSTOMER_ID } = await import('../lib/google-ads.js');
  const C = `customers/${CUSTOMER_ID}`;
  const stale = await gaqlQuery(`SELECT campaign.resource_name, campaign.status FROM campaign WHERE campaign.name = '${NAME}' AND campaign.status != 'REMOVED'`);
  if (stale.some((x) => x.campaign.status === 'ENABLED')) throw new Error(`${NAME} exists and is ENABLED; refusing to replace a live campaign`);
  const staleBudgets = await gaqlQuery(`SELECT campaign_budget.resource_name FROM campaign_budget WHERE campaign_budget.name LIKE '${NAME} |%' AND campaign_budget.status = 'ENABLED'`);
  const cleanup = [...stale.map((x) => ({ campaignOperation: { remove: x.campaign.resourceName } })), ...staleBudgets.map((x) => ({ campaignBudgetOperation: { remove: x.campaignBudget.resourceName } }))];
  if (cleanup.length) { console.log(`Removing ${cleanup.length} earlier paused copy resource(s)...`); await mutate(cleanup); }

  await mutate(buildOperations(C));
  const rows = await gaqlQuery(`SELECT campaign.id, campaign.status, campaign.bidding_strategy_type, campaign_budget.amount_micros, campaign.final_url_suffix FROM campaign WHERE campaign.name = '${NAME}' AND campaign.status != 'REMOVED'`);
  const kw = await gaqlQuery(`SELECT ad_group.name, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type FROM keyword_view WHERE campaign.name = '${NAME}'`);
  const ads = await gaqlQuery(`SELECT ad_group.name, ad_group_ad.ad.final_urls, ad_group_ad.policy_summary.approval_status FROM ad_group_ad WHERE campaign.name = '${NAME}'`);
  console.log('\nRead back:');
  for (const r of rows) console.log(`  campaign ${r.campaign.id} ${r.campaign.status} ${r.campaign.biddingStrategyType} $${Number(r.campaignBudget.amountMicros) / 1e6}/day suffix=${r.campaign.finalUrlSuffix}`);
  console.log(`  ${kw.length} keywords, ${ads.length} ads`);
  for (const a of ads) console.log(`  ${a.adGroup.name}: ${a.adGroupAd.ad.finalUrls.join(' ')} (${a.adGroupAd.policySummary?.approvalStatus || 'pending review'})`);
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
