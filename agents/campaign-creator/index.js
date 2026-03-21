// agents/campaign-creator/index.js
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..', '..');

// ── Pure exports ───────────────────────────────────────────────────────────────

export function validateCampaignFile(campaign) {
  if (campaign.status !== 'approved') {
    throw new Error(`Campaign status must be 'approved', got '${campaign.status}'`);
  }
  if (!campaign.proposal?.approvedBudget) {
    throw new Error('Campaign proposal.approvedBudget is required');
  }
  for (const ag of (campaign.proposal?.adGroups || [])) {
    if (!ag.headlines || ag.headlines.length < 3) {
      throw new Error(`Ad group '${ag.name}' must have at least 3 headlines`);
    }
    if (!ag.descriptions || ag.descriptions.length < 2) {
      throw new Error(`Ad group '${ag.name}' must have at least 2 descriptions`);
    }
    if (!ag.keywords || ag.keywords.length < 1) {
      throw new Error(`Ad group '${ag.name}' must have at least 1 keyword`);
    }
  }
}

export function mobileAdjustmentValue(pct) {
  return Math.round((1 + pct / 100) * 1000) / 1000;
}

export function buildBudgetOperation(dailyBudgetUSD, customerResourceName, name) {
  return {
    campaignBudgetOperation: {
      create: {
        resourceName: `${customerResourceName}/campaignBudgets/-1`,
        name,
        amountMicros: Math.round(dailyBudgetUSD * 1_000_000),
        deliveryMethod: 'STANDARD',
      },
    },
  };
}

export function buildCampaignOperation(name, budgetResourceName, mobileAdjustment, customerResourceName) {
  return {
    campaignOperation: {
      create: {
        resourceName: `${customerResourceName}/campaigns/-2`,
        name,
        status: 'PAUSED',
        advertisingChannelType: 'SEARCH',
        campaignBudget: budgetResourceName,
        manualCpc: { enhancedCpcEnabled: false },
        networkSettings: {
          targetGoogleSearch: true,
          targetSearchNetwork: true,
          targetContentNetwork: false,
        },
        geoTargetTypeSetting: {
          positiveGeoTargetType: 'PRESENCE_OR_INTEREST',
        },
        biddingStrategyType: 'MANUAL_CPC',
        containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      },
    },
  };
}

export function buildAdGroupOperation(name, campaignResourceName, customerResourceName) {
  return {
    adGroupOperation: {
      create: {
        resourceName: `${customerResourceName}/adGroups/-3`,
        name,
        campaign: campaignResourceName,
        status: 'ENABLED',
        type: 'SEARCH_STANDARD',
      },
    },
  };
}

export function truncateField(text, max) {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

export function buildRsaOperation(headlines, descriptions, adGroupResourceName, finalUrl) {
  return {
    adGroupAdOperation: {
      create: {
        adGroup: adGroupResourceName,
        status: 'ENABLED',
        ad: {
          finalUrls: [finalUrl],
          responsiveSearchAd: {
            headlines: headlines.map(text => ({ text: truncateField(text, 30) })),
            descriptions: descriptions.map(text => ({ text: truncateField(text, 90) })),
          },
        },
      },
    },
  };
}

export function buildKeywordOperations(keywords, adGroupResourceName) {
  return keywords.map(kw => ({
    adGroupCriterionOperation: {
      create: {
        adGroup: adGroupResourceName,
        status: 'ENABLED',
        keyword: {
          text: kw.text,
          matchType: kw.matchType,
        },
      },
    },
  }));
}

export function buildNegativeKeywordOperations(negativeKeywords, campaignResourceName) {
  return negativeKeywords.map(text => ({
    campaignCriterionOperation: {
      create: {
        campaign: campaignResourceName,
        negative: true,
        keyword: {
          text,
          matchType: 'BROAD',
        },
      },
    },
  }));
}

// ── Main ──────────────────────────────────────────────────────────────────────

const CAMPAIGNS_DIR = join(ROOT, 'data', 'campaigns');

async function main() {
  const campaignArg = process.argv.includes('--campaign')
    ? process.argv[process.argv.indexOf('--campaign') + 1]
    : null;

  if (!campaignArg) {
    console.error('Usage: node agents/campaign-creator/index.js --campaign <id>');
    process.exit(1);
  }

  console.log(`Campaign Creator — ${campaignArg}\n`);

  // Load campaign file
  const file = join(CAMPAIGNS_DIR, `${campaignArg}.json`);
  if (!existsSync(file)) throw new Error(`Campaign file not found: ${file}`);
  const campaign = JSON.parse(readFileSync(file, 'utf8'));

  // Validate
  validateCampaignFile(campaign);

  const { mutate, gaqlQuery, CUSTOMER_ID } = await import('../../lib/google-ads.js');
  const customerResourceName = `customers/${CUSTOMER_ID}`;
  const { proposal } = campaign;
  const mobileAdj = mobileAdjustmentValue(proposal.mobileAdjustmentPct ?? 30);
  const budget = proposal.approvedBudget;

  // Build final URL from STORE_DOMAIN env var + proposal landing page
  const envVars = (() => {
    try { return Object.fromEntries(readFileSync(join(ROOT, '.env'), 'utf8').split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])); } catch { return {}; }
  })();
  const storeDomain = process.env.STORE_DOMAIN || envVars.STORE_DOMAIN;
  if (!storeDomain) throw new Error('Missing STORE_DOMAIN in .env');
  const landingPath = (proposal.landingPage || '/').replace(/^\//, '');
  const finalUrl = `https://${storeDomain}/${landingPath}`;

  console.log(`  Campaign: ${proposal.campaignName}`);
  console.log(`  Budget: $${budget}/day | Mobile adj: ${mobileAdj}x`);
  console.log(`  Ad groups: ${proposal.adGroups.length}`);

  const isDryRun = process.argv.includes('--dry-run');

  if (isDryRun) {
    console.log(`[DRY RUN] Would create CampaignBudget: $${budget}/day`);
    console.log(`[DRY RUN] Would create Campaign: ${proposal.campaignName}`);
    for (const ag of proposal.adGroups) {
      console.log(`[DRY RUN] Would create AdGroup: ${ag.name} with ${ag.keywords.length} keywords`);
    }
    if (proposal.negativeKeywords?.length > 0) {
      console.log(`[DRY RUN] Would add ${proposal.negativeKeywords.length} negative keywords`);
    }
    console.log('[DRY RUN] No API calls made.');
    return;
  }

  // Step 1: Create budget + campaign (or find existing campaign by name)
  let campaignRN, campaignId, budgetRN;

  process.stdout.write('  Checking for existing campaign... ');
  const existing = await gaqlQuery(
    `SELECT campaign.resource_name, campaign.id, campaign.campaign_budget
     FROM campaign
     WHERE campaign.name = '${proposal.campaignName.replace(/'/g, "\\'")}'
       AND campaign.status IN ('PAUSED', 'ENABLED')`
  );

  if (existing.length > 0) {
    const c = existing[0].campaign;
    campaignRN = c?.resourceName ?? c?.resource_name;
    campaignId = c?.id;
    budgetRN = c?.campaignBudget ?? c?.campaign_budget;
    if (!campaignRN) throw new Error(`Found existing campaign but could not read resource name. Raw: ${JSON.stringify(existing[0])}`);
    console.log(`found (${campaignRN})`);
  } else {
    console.log('none');
    const budgetName = `${proposal.campaignName} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    const budgetOp = buildBudgetOperation(budget, customerResourceName, budgetName);
    const campaignOp = buildCampaignOperation(proposal.campaignName, `${customerResourceName}/campaignBudgets/-1`, mobileAdj, customerResourceName);

    process.stdout.write('  Creating budget + campaign... ');
    const res1 = await mutate([budgetOp, campaignOp]);
    budgetRN = res1.mutateOperationResponses?.[0]?.campaignBudgetResult?.resourceName;
    campaignRN = res1.mutateOperationResponses?.[1]?.campaignResult?.resourceName;
    if (!budgetRN || !campaignRN) {
      throw new Error(`Budget/campaign creation returned no resource names. Response: ${JSON.stringify(res1)}`);
    }
    campaignId = campaignRN.split('/').pop();
    console.log(`done (${campaignRN})`);
  }

  // Step 2: Create ad groups + RSAs + keywords per ad group
  const adGroupResourceNames = [];
  for (const ag of proposal.adGroups) {
    const existingAg = await gaqlQuery(
      `SELECT ad_group.resource_name FROM ad_group
       WHERE ad_group.name = '${ag.name.replace(/'/g, "\\'")}'
         AND campaign.resource_name = '${campaignRN}'
         AND ad_group.status != 'REMOVED'`
    );
    let adGroupRN;
    if (existingAg.length > 0) {
      const ag0 = existingAg[0].adGroup ?? existingAg[0].ad_group;
      adGroupRN = ag0?.resourceName ?? ag0?.resource_name;
      console.log(`  Ad group: ${ag.name} (existing: ${adGroupRN})`);
    } else {
      const adGroupOp = buildAdGroupOperation(ag.name, campaignRN, customerResourceName);
      const adGroupRes = await mutate([adGroupOp]);
      adGroupRN = adGroupRes.mutateOperationResponses?.[0]?.adGroupResult?.resourceName;
      if (!adGroupRN) {
        throw new Error(`Ad group '${ag.name}' creation returned no resource name. Response: ${JSON.stringify(adGroupRes)}`);
      }
      console.log(`  Ad group: ${ag.name} (${adGroupRN})`);
    }
    adGroupResourceNames.push(adGroupRN);

    const rsaOp = buildRsaOperation(ag.headlines, ag.descriptions, adGroupRN, finalUrl);
    const kwOps = buildKeywordOperations(ag.keywords, adGroupRN);
    await mutate([rsaOp, ...kwOps]);
    console.log(`    RSA + ${ag.keywords.length} keywords created`);
  }

  // Step 3: Negative keywords (campaign-level)
  if (proposal.negativeKeywords?.length > 0) {
    const negOps = buildNegativeKeywordOperations(proposal.negativeKeywords, campaignRN);
    await mutate(negOps);
    console.log(`  Negative keywords: ${proposal.negativeKeywords.length}`);
  }

  // Update campaign file
  campaign.status = 'active';
  campaign.googleAds = {
    campaignResourceName: campaignRN,
    campaignId,
    budgetResourceName: budgetRN,
    adGroupResourceNames,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify(campaign, null, 2));
  console.log(`\n  Campaign file updated: ${file}`);
  console.log(`  Status: active | Campaign ID: ${campaignId}`);
  console.log(`DONE ${JSON.stringify({ campaignId, status: 'active' })}`);

  // Notify
  const { notify } = await import('../../lib/notify.js');
  await notify({
    subject: `Campaign Created — ${proposal.campaignName}`,
    body: `Campaign "${proposal.campaignName}" created in Google Ads.\nCampaign ID: ${campaignId}\nBudget: $${budget}/day\nStatus: PAUSED (enable in Google Ads dashboard)`,
  }).catch(() => {});
}

const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main().catch(err => { console.error('Error:', err.message); process.exit(1); });
