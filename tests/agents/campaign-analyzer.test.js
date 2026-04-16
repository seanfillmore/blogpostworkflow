import { strict as assert } from 'node:assert';
import {
  campaignFilePath,
  buildAnalyzerPrompt,
  parseAnalyzerResponse,
  isClarification,
} from '../../agents/campaign-analyzer/index.js';

// campaignFilePath
assert.equal(
  campaignFilePath('2026-03-20', 'natural-toothpaste-search', '/root/project'),
  '/root/project/data/campaigns/2026-03-20-natural-toothpaste-search.json'
);

// buildAnalyzerPrompt — includes active campaigns and all data sections
const context = {
  activeSlugs: ['2026-03-19-lotion-search'],
  adsSnaps: [{ date: '2026-03-19', spend: 4.5, clicks: 10 }],
  gscSnaps: [{ date: '2026-03-19', clicks: 100 }],
  ga4Snaps: [],
  shopifySnaps: [],
  pastOutcomes: [],
};
const prompt = buildAnalyzerPrompt(context);
assert.ok(prompt.includes('2026-03-19-lotion-search'), 'must list active slugs');
assert.ok(prompt.includes('Google Ads'), 'must include ads section');
assert.ok(prompt.includes('Google Search Console'), 'must include GSC section');
assert.ok(prompt.includes('DataForSEO'), 'must reference DataForSEO as the keyword data source');

// parseAnalyzerResponse — valid JSON with proposals array
const rawProposal = JSON.stringify({
  proposals: [{
    slug: 'natural-toothpaste-search',
    campaignName: 'RSC | Toothpaste | Search',
    objective: 'Drive purchases',
    landingPage: '/products/toothpaste',
    network: 'Search',
    suggestedBudget: 5,
    mobileAdjustmentPct: 30,
    adGroups: [{
      name: 'Natural Toothpaste',
      keywords: [{ text: 'natural toothpaste', matchType: 'EXACT' }],
      headlines: ['Natural Toothpaste', 'Clean Ingredients', 'Fluoride Free', 'No Harsh Chemicals'],
      descriptions: ['Desc one here.', 'Desc two here.']
    }],
    negativeKeywords: ['diy'],
    rationale: 'GSC signal.',
    dataPoints: { gscImpressions: 420 },
    projections: { ctr: 0.035, cpc: 0.65, cvr: 0.022, dailyClicks: 8, monthlyCost: 150, monthlyConversions: 5, monthlyRevenue: 180 }
  }]
});
const parsed = parseAnalyzerResponse(rawProposal);
assert.equal(parsed.proposals.length, 1);
assert.equal(parsed.proposals[0].slug, 'natural-toothpaste-search');
assert.ok(!parsed.clarificationNeeded);

// parseAnalyzerResponse — clarification response
const rawClarify = JSON.stringify({
  clarificationNeeded: ['What is your primary product focus?', 'What is your monthly budget?']
});
const parsedClarify = parseAnalyzerResponse(rawClarify);
assert.ok(Array.isArray(parsedClarify.clarificationNeeded));
assert.equal(parsedClarify.clarificationNeeded.length, 2);

// parseAnalyzerResponse — strips markdown fences
const wrapped = '```json\n' + rawProposal + '\n```';
const parsed2 = parseAnalyzerResponse(wrapped);
assert.equal(parsed2.proposals.length, 1);

// isClarification
assert.ok(isClarification({ clarificationNeeded: ['q1'] }));
assert.ok(!isClarification({ proposals: [] }));
assert.ok(!isClarification({ clarificationNeeded: null }));

console.log('✓ campaign-analyzer pure function tests pass');
