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
  }
}

export function mobileAdjustmentValue(pct) {
  return Math.round((1 + pct / 100) * 1000) / 1000;
}

export function buildBudgetOperation(dailyBudgetUSD, customerResourceName) {
  return {
    campaignBudgetOperation: {
      create: {
        resourceName: `${customerResourceName}/campaignBudgets/-1`,
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

export function buildRsaOperation(headlines, descriptions, adGroupResourceName, customerResourceName) {
  return {
    adGroupAdOperation: {
      create: {
        resourceName: `${customerResourceName}/adGroupAds/-4`,
        adGroup: adGroupResourceName,
        status: 'ENABLED',
        ad: {
          responsiveSearchAd: {
            headlines: headlines.map(text => ({ text })),
            descriptions: descriptions.map(text => ({ text })),
          },
        },
      },
    },
  };
}

export function buildKeywordOperations(keywords, adGroupResourceName, customerResourceName) {
  return keywords.map((kw, i) => ({
    adGroupCriterionOperation: {
      create: {
        resourceName: `${customerResourceName}/adGroupCriteria/-${10 + i}`,
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

export function buildNegativeKeywordOperations(negativeKeywords, campaignResourceName, customerResourceName) {
  return negativeKeywords.map((text, i) => ({
    campaignCriterionOperation: {
      create: {
        resourceName: `${customerResourceName}/campaignCriteria/-${20 + i}`,
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
