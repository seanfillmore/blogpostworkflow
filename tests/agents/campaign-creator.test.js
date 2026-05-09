import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  validateCampaignFile,
  buildBudgetOperation,
  buildCampaignOperation,
  buildAdGroupOperation,
  buildRsaOperation,
  buildKeywordOperations,
  buildNegativeKeywordOperations,
  mobileAdjustmentValue,
} from '../../agents/campaign-creator/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(__dirname, '../../test/fixtures/campaigns/sample-proposed.json'), 'utf8'));

// validateCampaignFile — approved fixture with budget set
const approved = { ...fixture, status: 'approved', proposal: { ...fixture.proposal, approvedBudget: 5.0 } };
assert.doesNotThrow(() => validateCampaignFile(approved));

// validateCampaignFile — rejects wrong status
assert.throws(() => validateCampaignFile(fixture), /status/);

// validateCampaignFile — rejects missing budget
const noBudget = { ...approved, proposal: { ...approved.proposal, approvedBudget: null } };
assert.throws(() => validateCampaignFile(noBudget), /approvedBudget/);

// validateCampaignFile — rejects missing headlines
const noHeadlines = { ...approved, proposal: { ...approved.proposal, adGroups: [{ ...approved.proposal.adGroups[0], headlines: ['a', 'b'] }] } };
assert.throws(() => validateCampaignFile(noHeadlines), /headline/);

// validateCampaignFile — rejects missing descriptions
const noDesc = { ...approved, proposal: { ...approved.proposal, adGroups: [{ ...approved.proposal.adGroups[0], descriptions: ['only one'] }] } };
assert.throws(() => validateCampaignFile(noDesc), /description/);

// validateCampaignFile — rejects empty keywords
const noKeywords = { ...approved, proposal: { ...approved.proposal, adGroups: [{ ...approved.proposal.adGroups[0], keywords: [] }] } };
assert.throws(() => validateCampaignFile(noKeywords), /keyword/);

// mobileAdjustmentValue
assert.equal(mobileAdjustmentValue(30), 1.3);
assert.equal(mobileAdjustmentValue(-20), 0.8);
assert.equal(mobileAdjustmentValue(0), 1.0);

// buildBudgetOperation
const budgetOp = buildBudgetOperation(5.0, 'customers/123');
assert.equal(budgetOp.campaignBudgetOperation.create.amountMicros, 5000000);
assert.equal(budgetOp.campaignBudgetOperation.create.deliveryMethod, 'STANDARD');

// buildCampaignOperation
const campaignOp = buildCampaignOperation('RSC | Test | Search', 'customers/123/campaignBudgets/456', 1.3, 'customers/123');
assert.ok(campaignOp.campaignOperation.create.name === 'RSC | Test | Search');
assert.ok(campaignOp.campaignOperation.create.manualCpc !== undefined);

// buildCampaignOperation — emits trackingUrlTemplate when option is provided
const campaignOpWithTemplate = buildCampaignOperation(
  'RSC | Test | Search', 'customers/123/campaignBudgets/456', 1.3, 'customers/123',
  { trackingUrlTemplate: '{lpurl}?utm_source=google&utm_medium=cpc' }
);
assert.equal(
  campaignOpWithTemplate.campaignOperation.create.trackingUrlTemplate,
  '{lpurl}?utm_source=google&utm_medium=cpc'
);

// buildCampaignOperation — omits trackingUrlTemplate when not provided (backward compat)
assert.equal(campaignOp.campaignOperation.create.trackingUrlTemplate, undefined);

// buildCampaignOperation — defaults targetSearchNetwork to true (backward compat)
assert.equal(campaignOp.campaignOperation.create.networkSettings.targetSearchNetwork, true);

// buildCampaignOperation — targetSearchNetwork can be overridden to false
const campaignOpNoPartners = buildCampaignOperation(
  'RSC | Test | Search', 'customers/123/campaignBudgets/456', 1.3, 'customers/123',
  { targetSearchNetwork: false }
);
assert.equal(campaignOpNoPartners.campaignOperation.create.networkSettings.targetSearchNetwork, false);

// buildAdGroupOperation — returns operation with ad group name
const adGroupOp = buildAdGroupOperation('Natural Toothpaste', 'customers/123/campaigns/789', 'customers/123');
assert.equal(adGroupOp.adGroupOperation.create.name, 'Natural Toothpaste');

// buildRsaOperation — headline and description counts
const rsaOp = buildRsaOperation(
  ['H1','H2','H3','H4'],
  ['D1','D2'],
  'customers/123/adGroups/456',
  'customers/123'
);
assert.equal(rsaOp.adGroupAdOperation.create.ad.responsiveSearchAd.headlines.length, 4);
assert.equal(rsaOp.adGroupAdOperation.create.ad.responsiveSearchAd.descriptions.length, 2);

// buildKeywordOperations — one operation per keyword
const kwOps = buildKeywordOperations(
  [{ text: 'natural toothpaste', matchType: 'EXACT' }, { text: 'coconut toothpaste', matchType: 'PHRASE' }],
  'customers/123/adGroups/456',
  'customers/123'
);
assert.equal(kwOps.length, 2);
assert.equal(kwOps[0].adGroupCriterionOperation.create.keyword.matchType, 'EXACT');

// buildNegativeKeywordOperations — campaign-level negative keywords
const negOps = buildNegativeKeywordOperations(['diy', 'recipe'], 'customers/123/campaigns/789', 'customers/123');
assert.equal(negOps.length, 2);
assert.ok(negOps[0].campaignCriterionOperation.create.negative === true);

console.log('✓ campaign-creator pure function tests pass');
