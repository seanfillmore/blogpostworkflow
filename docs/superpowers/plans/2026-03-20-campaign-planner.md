# Campaign Planner System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build three agents (campaign-analyzer, campaign-creator, campaign-monitor) that discover, create, and track Google Ads campaigns using a shared campaign JSON file as the communication backbone, with a feedback loop through the dashboard.

**Architecture:** A weekly `campaign-analyzer` reads all available data and writes proposal files to `data/campaigns/`. The dashboard surfaces proposals for review and approval. `campaign-creator` (dashboard-triggered) creates approved campaigns via the Google Ads API. `campaign-monitor` (daily) reads active campaign files, scores performance against projections, and writes alerts back to the file.

**Tech Stack:** Node.js ESM, `@anthropic-ai/sdk` (claude-opus-4-6), `lib/google-ads.js` (existing mutate/gaqlQuery), `lib/notify.js` (email), Node built-in test runner (`node --test`).

**Branch:** All work on `feature/campaign-planner`. Never commit to main. Test locally before pushing.

---

## File Map

**New files:**
- `agents/campaign-analyzer/index.js` — weekly agent: loads all data, calls Claude, writes proposals
- `agents/campaign-creator/index.js` — dashboard-triggered: validates proposal, creates campaign via Ads API
- `agents/campaign-monitor/index.js` — daily agent: scores performance vs projections, writes alerts
- `tests/agents/campaign-analyzer.test.js` — unit tests for pure exports
- `tests/agents/campaign-creator.test.js` — unit tests for pure exports
- `tests/agents/campaign-monitor.test.js` — unit tests for pure exports
- `test/fixtures/campaigns/sample-proposed.json` — tracked test fixture (not gitignored)
- `data/campaigns/.gitkeep` — creates the directory in git

**Modified files:**
- `agents/dashboard/index.js` — new API routes, new UI cards, allowlist additions
- `scripts/setup-cron.sh` — add analyzer (weekly) and monitor (daily)
- `.gitignore` — add `data/campaigns/*.json`
- `package.json` — add npm scripts for new agents

---

## Task 1: Branch + Scaffold

**Files:**
- Create: `data/campaigns/.gitkeep`
- Create: `test/fixtures/campaigns/sample-proposed.json`
- Modify: `.gitignore`
- Modify: `package.json`

- [ ] **Step 1: Create the feature branch**

```bash
git checkout main && git pull && git checkout -b feature/campaign-planner
```

- [ ] **Step 2: Create the campaigns data directory**

```bash
mkdir -p data/campaigns && touch data/campaigns/.gitkeep
```

- [ ] **Step 3: Create the test fixtures directory**

```bash
mkdir -p test/fixtures/campaigns
```

- [ ] **Step 4: Write the sample proposed fixture**

Create `test/fixtures/campaigns/sample-proposed.json`:
```json
{
  "id": "2026-03-20-natural-toothpaste-search",
  "status": "proposed",
  "createdAt": "2026-03-20T08:00:00.000Z",
  "proposal": {
    "campaignName": "RSC | Toothpaste | Search",
    "objective": "Drive purchases of coconut oil toothpaste",
    "landingPage": "/products/coconut-oil-toothpaste",
    "network": "Search",
    "suggestedBudget": 5.00,
    "approvedBudget": null,
    "mobileAdjustmentPct": 30,
    "adGroups": [
      {
        "name": "Natural Toothpaste",
        "keywords": [
          { "text": "natural toothpaste", "matchType": "EXACT" },
          { "text": "coconut oil toothpaste", "matchType": "EXACT" }
        ],
        "headlines": [
          "Natural Coconut Oil Toothpaste",
          "Only Clean Ingredients",
          "Fluoride-Free Formula",
          "Skip Harsh Chemicals"
        ],
        "descriptions": [
          "Made with organic coconut oil and no harsh chemicals. Clean teeth, clean ingredients.",
          "Fluoride-free toothpaste for a cleaner routine. 6 real ingredients you can pronounce."
        ]
      }
    ],
    "negativeKeywords": ["diy", "recipe", "homemade", "wholesale"]
  },
  "rationale": "GSC shows 420 impressions/mo for 'natural toothpaste' with 0 paid coverage.",
  "dataPoints": {
    "gscImpressions": 420,
    "gscCTR": 0.031,
    "ga4CVR": 0.022,
    "shopifyRevenue": 612.00,
    "competitorsCovering": ["hello", "dr. bronner's"]
  },
  "projections": {
    "ctr": 0.035,
    "cpc": 0.65,
    "cvr": 0.022,
    "dailyClicks": 8,
    "monthlyCost": 150,
    "monthlyConversions": 5,
    "monthlyRevenue": 180
  },
  "clarificationNeeded": null,
  "clarificationResponse": null,
  "googleAds": {
    "campaignResourceName": null,
    "campaignId": null,
    "budgetResourceName": null,
    "adGroupResourceNames": [],
    "createdAt": null
  },
  "performance": [],
  "alerts": []
}
```

- [ ] **Step 5: Add data/campaigns/*.json to .gitignore**

Add to `.gitignore` (after existing entries):
```
data/campaigns/*.json
```

- [ ] **Step 6: Add npm scripts to package.json**

Add to the `"scripts"` block in `package.json`:
```json
"campaign-analyzer": "node agents/campaign-analyzer/index.js",
"campaign-creator": "node agents/campaign-creator/index.js",
"campaign-monitor": "node agents/campaign-monitor/index.js"
```

- [ ] **Step 7: Commit scaffold**

```bash
git add data/campaigns/.gitkeep test/fixtures/campaigns/sample-proposed.json .gitignore package.json
git commit -m "feat: scaffold campaign-planner — directory, fixture, gitignore, npm scripts"
```

---

## Task 2: campaign-analyzer Pure Functions + Tests

**Files:**
- Create: `agents/campaign-analyzer/index.js` (pure exports only — no main() yet)
- Create: `tests/agents/campaign-analyzer.test.js`

Pure functions to export: `campaignFilePath`, `buildAnalyzerPrompt`, `parseAnalyzerResponse`, `isClarification`.

- [ ] **Step 1: Write the failing tests**

Create `tests/agents/campaign-analyzer.test.js`:
```js
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
  ahrefsPresent: false,
  pastOutcomes: [],
};
const prompt = buildAnalyzerPrompt(context);
assert.ok(prompt.includes('2026-03-19-lotion-search'), 'must list active slugs');
assert.ok(prompt.includes('Google Ads'), 'must include ads section');
assert.ok(prompt.includes('Google Search Console'), 'must include GSC section');
assert.ok(prompt.includes('No Ahrefs'), 'must note missing Ahrefs');

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
```

- [ ] **Step 2: Run tests — expect failure**

```bash
node --test tests/agents/campaign-analyzer.test.js
```
Expected: `Error: Cannot find module '../../agents/campaign-analyzer/index.js'`

- [ ] **Step 3: Implement pure exports**

Create `agents/campaign-analyzer/index.js` with only pure exports (no main yet):
```js
// agents/campaign-analyzer/index.js
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..', '..');

// ── Pure exports ───────────────────────────────────────────────────────────────

export function campaignFilePath(date, slug, rootDir) {
  return join(rootDir, 'data', 'campaigns', `${date}-${slug}.json`);
}

export function buildAnalyzerPrompt(context) {
  const { activeSlugs, adsSnaps, gscSnaps, ga4Snaps, shopifySnaps, ahrefsPresent, pastOutcomes } = context;

  const sections = [
    `## Active/Proposed Campaigns (do not duplicate these)\n${activeSlugs.length ? activeSlugs.join('\n') : 'None yet.'}`,
    `## Google Ads (last ${adsSnaps.length} days)\n${adsSnaps.length ? JSON.stringify(adsSnaps, null, 2) : 'No Google Ads snapshots available.'}`,
    `## Google Search Console\n${gscSnaps.length ? JSON.stringify(gscSnaps, null, 2) : 'No GSC snapshots available.'}`,
    `## Google Analytics 4\n${ga4Snaps.length ? JSON.stringify(ga4Snaps, null, 2) : 'No GA4 snapshots available.'}`,
    `## Shopify\n${shopifySnaps.length ? JSON.stringify(shopifySnaps, null, 2) : 'No Shopify snapshots available.'}`,
    `## Ahrefs\n${ahrefsPresent ? 'See uploaded CSV data.' : 'No Ahrefs exports found.'}`,
    `## Past Campaign Outcomes\n${pastOutcomes.length ? JSON.stringify(pastOutcomes, null, 2) : 'No past campaign data.'}`,
  ];

  return sections.join('\n\n');
}

export function parseAnalyzerResponse(raw) {
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  const parsed = JSON.parse(cleaned);
  return parsed;
}

export function isClarification(parsed) {
  return Array.isArray(parsed.clarificationNeeded) && parsed.clarificationNeeded.length > 0;
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
node --test tests/agents/campaign-analyzer.test.js
```
Expected: `✓ campaign-analyzer pure function tests pass`

- [ ] **Step 5: Commit**

```bash
git add agents/campaign-analyzer/index.js tests/agents/campaign-analyzer.test.js
git commit -m "feat: campaign-analyzer pure functions + tests"
```

---

## Task 3: campaign-analyzer Main Agent

**Files:**
- Modify: `agents/campaign-analyzer/index.js` (add loadEnv, data loaders, main)

- [ ] **Step 1: Add loadEnv, data loaders, and main() to campaign-analyzer**

Append to `agents/campaign-analyzer/index.js` after the pure exports:
```js
// ── Data paths ────────────────────────────────────────────────────────────────

const CAMPAIGNS_DIR     = join(ROOT, 'data', 'campaigns');
const ADS_SNAPS_DIR     = join(ROOT, 'data', 'snapshots', 'google-ads');
const GSC_SNAPS_DIR     = join(ROOT, 'data', 'snapshots', 'gsc');
const GA4_SNAPS_DIR     = join(ROOT, 'data', 'snapshots', 'ga4');
const SHOPIFY_SNAPS_DIR = join(ROOT, 'data', 'snapshots', 'shopify');
const AHREFS_DIR        = join(ROOT, 'data', 'ahrefs');

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const env = {};
    for (const l of lines) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return env;
  } catch { return {}; }
}

function loadSnaps(dir, days = 60) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort().reverse().slice(0, days)
    .map(f => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

function loadCampaigns() {
  if (!existsSync(CAMPAIGNS_DIR)) return [];
  return readdirSync(CAMPAIGNS_DIR)
    .filter(f => f.endsWith('.json') && f !== '.gitkeep')
    .map(f => { try { return JSON.parse(readFileSync(join(CAMPAIGNS_DIR, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

const SYSTEM_PROMPT = `You are a Google Ads campaign strategist for Real Skin Care (realskincare.com), a natural skincare brand.

Analyze the data provided and identify 1–3 new Search campaign opportunities not already covered by active campaigns.

For each opportunity output a complete proposal with:
- slug (kebab-case, e.g. "natural-deodorant-search")
- campaignName (e.g. "RSC | Deodorant | Search")
- objective
- landingPage (relative URL)
- network: "Search"
- suggestedBudget (daily USD, number)
- mobileAdjustmentPct (integer, positive = bid up, negative = bid down)
- adGroups (array): each with name, keywords (text + matchType: EXACT|PHRASE|BROAD), headlines (3–15 strings), descriptions (2–4 strings)
- negativeKeywords (array of strings)
- rationale (cite specific data points)
- dataPoints (key metrics that informed the proposal)
- projections: { ctr, cpc, cvr, dailyClicks, monthlyCost, monthlyConversions, monthlyRevenue }

If you cannot form a confident proposal due to missing or insufficient data, output:
{ "clarificationNeeded": ["Question 1?", "Question 2?"] }

Output ONLY valid JSON — no markdown, no explanation outside the JSON.

Output format:
{ "proposals": [ ...proposal objects... ] }
OR
{ "clarificationNeeded": ["..."] }`;

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const campaignArg = process.argv.includes('--campaign')
    ? process.argv[process.argv.indexOf('--campaign') + 1]
    : null;

  console.log('Campaign Analyzer\n');
  const env = loadEnv();
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY in .env');

  const campaigns = loadCampaigns();
  const activeSlugs = campaigns
    .filter(c => ['proposed', 'approved', 'active'].includes(c.status) && !c.clarificationNeeded)
    .map(c => c.id);
  const pastOutcomes = campaigns
    .filter(c => ['paused', 'completed'].includes(c.status) && c.performance.length > 0)
    .map(c => ({ id: c.id, projections: c.projections, performance: c.performance.slice(-7) }));

  // Re-analysis mode
  if (campaignArg) {
    const file = join(CAMPAIGNS_DIR, `${campaignArg}.json`);
    if (!existsSync(file)) throw new Error(`Campaign file not found: ${file}`);
    const campaign = JSON.parse(readFileSync(file, 'utf8'));
    if (campaign.status !== 'proposed') throw new Error(`Cannot re-analyze campaign with status: ${campaign.status}`);
    if (!campaign.clarificationResponse) throw new Error('No clarificationResponse found on campaign file');

    console.log(`  Re-analyzing: ${campaignArg}`);
    const reanalysisPrompt = [
      `## Original Proposal\n${campaign.rationale}\n\nData points: ${JSON.stringify(campaign.dataPoints)}`,
      `## Questions Asked\n${(campaign.clarificationNeeded || []).map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
      `## User's Answers\n${campaign.clarificationResponse}`,
      `## Task\nUsing the user's answers, produce a complete updated campaign proposal. If answers are still insufficient, output clarificationNeeded with refined questions.`,
    ].join('\n\n');

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    process.stdout.write('  Running AI re-analysis... ');
    const response = await client.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: reanalysisPrompt }],
    });
    console.log('done');
    const result = parseAnalyzerResponse(response.content?.[0]?.text || '');

    if (isClarification(result)) {
      campaign.clarificationNeeded = result.clarificationNeeded;
      console.log(`  Still needs clarification: ${result.clarificationNeeded.length} questions`);
    } else {
      const p = result.proposals?.[0];
      if (p) {
        campaign.proposal = { ...campaign.proposal, ...p };
        campaign.rationale = p.rationale;
        campaign.projections = p.projections;
        campaign.dataPoints = p.dataPoints;
        campaign.clarificationNeeded = null;
        console.log(`  Proposal updated: ${p.campaignName}`);
      }
    }
    if (!isDryRun) writeFileSync(file, JSON.stringify(campaign, null, 2));
    else console.log('[DRY RUN] Would write:', JSON.stringify(campaign, null, 2).slice(0, 200));
    return;
  }

  // Normal weekly run
  const context = {
    activeSlugs,
    adsSnaps: loadSnaps(ADS_SNAPS_DIR),
    gscSnaps: loadSnaps(GSC_SNAPS_DIR),
    ga4Snaps: loadSnaps(GA4_SNAPS_DIR),
    shopifySnaps: loadSnaps(SHOPIFY_SNAPS_DIR),
    ahrefsPresent: existsSync(AHREFS_DIR) && readdirSync(AHREFS_DIR).some(f => f.endsWith('.csv')),
    pastOutcomes,
  };

  console.log(`  Data loaded: ads=${context.adsSnaps.length} gsc=${context.gscSnaps.length} ga4=${context.ga4Snaps.length} shopify=${context.shopifySnaps.length} ahrefs=${context.ahrefsPresent}`);

  const userPrompt = buildAnalyzerPrompt(context);
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  process.stdout.write('  Running AI analysis... ');
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });
  console.log('done');

  const result = parseAnalyzerResponse(response.content?.[0]?.text || '');

  if (isDryRun) {
    if (isClarification(result)) {
      console.log('[DRY RUN] Clarification needed:', result.clarificationNeeded);
    } else {
      (result.proposals || []).forEach((p, i) => console.log(`[DRY RUN] Proposal ${i + 1}:`, JSON.stringify(p, null, 2)));
    }
    return;
  }

  mkdirSync(CAMPAIGNS_DIR, { recursive: true });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

  if (isClarification(result)) {
    const clarifyFile = join(CAMPAIGNS_DIR, `${today}-clarification-needed.json`);
    const clarifyDoc = {
      id: `${today}-clarification-needed`,
      status: 'proposed',
      createdAt: new Date().toISOString(),
      clarificationNeeded: result.clarificationNeeded,
      clarificationResponse: null,
      proposal: null, rationale: null, dataPoints: null, projections: null,
      googleAds: { campaignResourceName: null, campaignId: null, budgetResourceName: null, adGroupResourceNames: [], createdAt: null },
      performance: [], alerts: [],
    };
    writeFileSync(clarifyFile, JSON.stringify(clarifyDoc, null, 2));
    console.log(`  Clarification needed — saved: ${clarifyFile}`);
    const { notify } = await import('../../lib/notify.js');
    await notify({ subject: 'Campaign Analyzer — clarification needed', body: result.clarificationNeeded.join('\n') }).catch(() => {});
    return;
  }

  const written = [];
  for (const p of (result.proposals || [])) {
    const slug = p.slug || p.campaignName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const filePath = campaignFilePath(today, slug, ROOT);
    const doc = {
      id: `${today}-${slug}`,
      status: 'proposed',
      createdAt: new Date().toISOString(),
      proposal: {
        campaignName: p.campaignName,
        objective: p.objective,
        landingPage: p.landingPage,
        network: p.network || 'Search',
        suggestedBudget: p.suggestedBudget,
        approvedBudget: null,
        mobileAdjustmentPct: p.mobileAdjustmentPct ?? 30,
        adGroups: p.adGroups,
        negativeKeywords: p.negativeKeywords || [],
      },
      rationale: p.rationale,
      dataPoints: p.dataPoints || {},
      projections: p.projections,
      clarificationNeeded: null,
      clarificationResponse: null,
      googleAds: { campaignResourceName: null, campaignId: null, budgetResourceName: null, adGroupResourceNames: [], createdAt: null },
      performance: [],
      alerts: [],
    };
    writeFileSync(filePath, JSON.stringify(doc, null, 2));
    written.push(p.campaignName);
    console.log(`  Saved: ${filePath}`);
  }

  if (written.length > 0) {
    const { notify } = await import('../../lib/notify.js');
    await notify({
      subject: `Campaign Analyzer — ${written.length} new proposal${written.length > 1 ? 's' : ''}`,
      body: `New campaign proposals ready for review:\n${written.map(n => `• ${n}`).join('\n')}\n\nReview at dashboard → Ads tab`,
    }).catch(() => {});
  }
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
```

- [ ] **Step 2: Run tests — confirm pure exports still pass**

```bash
node --test tests/agents/campaign-analyzer.test.js
```
Expected: `✓ campaign-analyzer pure function tests pass`

- [ ] **Step 3: Run dry-run locally**

```bash
node agents/campaign-analyzer/index.js --dry-run
```
Expected: Output shows data counts and either `[DRY RUN] Proposal 1:` JSON or `[DRY RUN] Clarification needed:`. No files written. No errors.

- [ ] **Step 4: Test re-analysis guard — non-proposed status rejected**

Write a one-off active fixture to `data/campaigns/test-active.json`:
```json
{ "id": "test-active", "status": "active", "proposal": {}, "performance": [], "alerts": [] }
```
Run:
```bash
node agents/campaign-analyzer/index.js --campaign test-active && echo "SHOULD NOT REACH HERE"
```
Expected: `Error: Cannot re-analyze campaign with status: active` and exit code 1 (not "SHOULD NOT REACH HERE").

Then delete the test fixture:
```bash
rm data/campaigns/test-active.json
```

- [ ] **Step 5: Commit**

```bash
git add agents/campaign-analyzer/index.js
git commit -m "feat: campaign-analyzer main agent with dry-run and re-analysis support"
```

---

## Task 4: campaign-creator Pure Functions + Tests

**Files:**
- Create: `agents/campaign-creator/index.js` (pure exports only)
- Create: `tests/agents/campaign-creator.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/agents/campaign-creator.test.js`:
```js
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

// buildAdGroupOperation — returns operation with ad group name
const adGroupOp = buildAdGroupOperation('Natural Toothpaste', 'customers/123/campaigns/789', 'customers/123');
assert.equal(adGroupOp.adGroupOperation.create.name, 'Natural Toothpaste');

// buildRsaOperation — headline and description counts
const rsaOp = buildRsaOperation(
  ['H1','H2','H3','H4'],
  ['D1','D2'],
  'customers/123/adGroups/999',
  '/products/toothpaste',
  'customers/123'
);
assert.ok(rsaOp.adGroupAdOperation.create.ad.responsiveSearchAd.headlines.length === 4);
assert.ok(rsaOp.adGroupAdOperation.create.ad.responsiveSearchAd.descriptions.length === 2);

// buildKeywordOperations
const kwOps = buildKeywordOperations(
  [{ text: 'natural toothpaste', matchType: 'EXACT' }],
  'customers/123/adGroups/999'
);
assert.equal(kwOps.length, 1);
assert.equal(kwOps[0].adGroupCriterionOperation.create.keyword.matchType, 'EXACT');

// buildNegativeKeywordOperations
const negOps = buildNegativeKeywordOperations(['diy', 'recipe'], 'customers/123/campaigns/789');
assert.equal(negOps.length, 2);
assert.ok(negOps[0].campaignCriterionOperation.create.negative === true);

console.log('✓ campaign-creator pure function tests pass');
```

- [ ] **Step 2: Run tests — expect failure**

```bash
node --test tests/agents/campaign-creator.test.js
```
Expected: `Cannot find module '../../agents/campaign-creator/index.js'`

- [ ] **Step 3: Implement pure exports**

Create `agents/campaign-creator/index.js`:
```js
// agents/campaign-creator/index.js
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..', '..');

// ── Pure exports ───────────────────────────────────────────────────────────────

export function validateCampaignFile(campaign) {
  if (campaign.status !== 'approved') throw new Error(`Campaign status must be 'approved', got: ${campaign.status}`);
  if (!campaign.proposal?.approvedBudget || campaign.proposal.approvedBudget <= 0) throw new Error('approvedBudget must be a positive number');
  for (const ag of (campaign.proposal?.adGroups || [])) {
    if (!ag.headlines || ag.headlines.length < 3) throw new Error(`Ad group "${ag.name}" needs at least 3 headlines`);
    if (!ag.descriptions || ag.descriptions.length < 2) throw new Error(`Ad group "${ag.name}" needs at least 2 descriptions`);
    if (!ag.keywords || ag.keywords.length < 1) throw new Error(`Ad group "${ag.name}" needs at least 1 keyword`);
  }
}

export function mobileAdjustmentValue(pct) {
  return 1 + (pct / 100);
}

export function buildBudgetOperation(dailyBudgetUsd, customerPath) {
  return {
    campaignBudgetOperation: {
      create: {
        amountMicros: Math.round(dailyBudgetUsd * 1_000_000),
        deliveryMethod: 'STANDARD',
        explicitlyShared: false,
      },
    },
  };
}

export function buildCampaignOperation(campaignName, budgetResourceName, mobileAdj, customerPath) {
  return {
    campaignOperation: {
      create: {
        name: campaignName,
        campaignBudget: budgetResourceName,
        advertisingChannelType: 'SEARCH',
        status: 'ENABLED',
        manualCpc: { enhancedCpcEnabled: false },
        networkSettings: {
          targetGoogleSearch: true,
          targetSearchNetwork: false,
          targetContentNetwork: false,
        },
        geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE_OR_INTEREST' },
        targetSpendBiddingScheme: undefined,
      },
    },
  };
}

export function buildAdGroupOperation(adGroupName, campaignResourceName, customerPath) {
  return {
    adGroupOperation: {
      create: {
        name: adGroupName,
        campaign: campaignResourceName,
        status: 'ENABLED',
        type: 'SEARCH_STANDARD',
      },
    },
  };
}

export function buildRsaOperation(headlines, descriptions, adGroupResourceName, landingPage, customerPath) {
  return {
    adGroupAdOperation: {
      create: {
        adGroup: adGroupResourceName,
        status: 'ENABLED',
        ad: {
          finalUrls: [`https://www.realskincare.com${landingPage}`],
          responsiveSearchAd: {
            headlines: headlines.map(text => ({ text })),
            descriptions: descriptions.map(text => ({ text })),
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
        keyword: { text: kw.text, matchType: kw.matchType },
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
        keyword: { text, matchType: 'BROAD' },
      },
    },
  }));
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
node --test tests/agents/campaign-creator.test.js
```
Expected: `✓ campaign-creator pure function tests pass`

- [ ] **Step 5: Commit**

```bash
git add agents/campaign-creator/index.js tests/agents/campaign-creator.test.js
git commit -m "feat: campaign-creator pure functions + tests"
```

---

## Task 5: campaign-creator Main Agent

**Files:**
- Modify: `agents/campaign-creator/index.js` (add main)

- [ ] **Step 1: Append main() to campaign-creator**

Append to `agents/campaign-creator/index.js`:
```js
// ── Data paths ────────────────────────────────────────────────────────────────

const CAMPAIGNS_DIR = join(ROOT, 'data', 'campaigns');

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const env = {};
    for (const l of lines) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return env;
  } catch { return {}; }
}

function log(msg) { process.stdout.write(msg + '\n'); }

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const campaignId = process.argv.includes('--campaign')
    ? process.argv[process.argv.indexOf('--campaign') + 1]
    : null;

  if (!campaignId) { console.error('Usage: node campaign-creator/index.js --campaign <id>'); process.exit(1); }

  log(`Campaign Creator\n`);
  log(`Validating campaign file...`);

  const filePath = join(CAMPAIGNS_DIR, `${campaignId}.json`);
  if (!existsSync(filePath)) { console.error(`ERROR Campaign file not found: ${filePath}`); process.exit(1); }
  const campaign = JSON.parse(readFileSync(filePath, 'utf8'));

  try { validateCampaignFile(campaign); } catch (err) { console.error(`ERROR ${err.message}`); process.exit(1); }

  const p = campaign.proposal;
  const budget = p.approvedBudget;
  const mobileAdj = mobileAdjustmentValue(p.mobileAdjustmentPct ?? 30);

  if (isDryRun) {
    log(`[DRY RUN] Would create CampaignBudget: $${budget}/day`);
    log(`[DRY RUN] Would create Campaign: ${p.campaignName}`);
    for (const ag of p.adGroups) {
      log(`[DRY RUN] Would create AdGroup: ${ag.name} (${ag.keywords.length} keywords, ${ag.headlines.length} headlines)`);
    }
    log(`[DRY RUN] Would add ${p.negativeKeywords.length} negative keywords`);
    log(`DONE {"dryRun":true}`);
    return;
  }

  const { mutate, CUSTOMER_ID } = await import('../../lib/google-ads.js');
  const customerPath = `customers/${CUSTOMER_ID}`;

  // 1. Create budget
  log(`Creating campaign budget ($${budget}/day)...`);
  const budgetResult = await mutate([buildBudgetOperation(budget, customerPath)]);
  const budgetResourceName = budgetResult.mutateOperationResponses?.[0]?.campaignBudgetResult?.resourceName;
  if (!budgetResourceName) throw new Error('Budget creation failed — no resourceName returned');

  // 2. Create campaign
  log(`Creating campaign: ${p.campaignName}`);
  const campaignResult = await mutate([buildCampaignOperation(p.campaignName, budgetResourceName, mobileAdj, customerPath)]);
  const campaignResourceName = campaignResult.mutateOperationResponses?.[0]?.campaignResult?.resourceName;
  if (!campaignResourceName) throw new Error('Campaign creation failed — no resourceName returned');
  const campaignIdCreated = campaignResourceName.split('/').pop();

  // 3. Create ad groups, RSAs, keywords
  const adGroupResourceNames = [];
  for (const ag of p.adGroups) {
    log(`Creating ad group: ${ag.name}`);
    const agResult = await mutate([buildAdGroupOperation(ag.name, campaignResourceName, customerPath)]);
    const agResourceName = agResult.mutateOperationResponses?.[0]?.adGroupResult?.resourceName;
    if (!agResourceName) { log(`  ⚠ Ad group "${ag.name}" creation may have failed`); continue; }
    adGroupResourceNames.push(agResourceName);

    log(`  Adding RSA...`);
    await mutate([buildRsaOperation(ag.headlines, ag.descriptions, agResourceName, p.landingPage, customerPath)]);

    log(`  Adding ${ag.keywords.length} keywords...`);
    await mutate(buildKeywordOperations(ag.keywords, agResourceName));
  }

  // 4. Negative keywords
  if (p.negativeKeywords.length > 0) {
    log(`Adding ${p.negativeKeywords.length} negative keywords...`);
    await mutate(buildNegativeKeywordOperations(p.negativeKeywords, campaignResourceName));
  }

  // 5. Write back to file
  campaign.status = 'active';
  campaign.googleAds = {
    campaignResourceName,
    campaignId: campaignIdCreated,
    budgetResourceName,
    adGroupResourceNames,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(filePath, JSON.stringify(campaign, null, 2));

  // 6. Notify
  const { notify } = await import('../../lib/notify.js');
  await notify({
    subject: `Campaign Created — ${p.campaignName}`,
    body: `Campaign "${p.campaignName}" is now live in Google Ads.\nCampaign ID: ${campaignIdCreated}\nDaily budget: $${budget}`,
  }).catch(() => {});

  log(`DONE {"campaignId":"${campaignIdCreated}","status":"active"}`);
}

main().catch(err => { console.error(`ERROR ${err.message}`); process.exit(1); });
```

- [ ] **Step 2: Confirm tests still pass**

```bash
node --test tests/agents/campaign-creator.test.js
```
Expected: `✓ campaign-creator pure function tests pass`

- [ ] **Step 3: Run dry-run locally**

First set a campaign file to `approved` and add `approvedBudget`:
```bash
# Copy fixture to data/campaigns/ and set status to approved for testing
cp test/fixtures/campaigns/sample-proposed.json data/campaigns/2026-03-20-natural-toothpaste-search.json
node -e "
const fs = require('fs');
const f = 'data/campaigns/2026-03-20-natural-toothpaste-search.json';
const d = JSON.parse(fs.readFileSync(f));
d.status = 'approved';
d.proposal.approvedBudget = 5.0;
fs.writeFileSync(f, JSON.stringify(d, null, 2));
console.log('done');
"
node agents/campaign-creator/index.js --campaign 2026-03-20-natural-toothpaste-search --dry-run
```
Expected output:
```
Campaign Creator

Validating campaign file...
[DRY RUN] Would create CampaignBudget: $5/day
[DRY RUN] Would create Campaign: RSC | Toothpaste | Search
[DRY RUN] Would create AdGroup: Natural Toothpaste (2 keywords, 4 headlines)
[DRY RUN] Would add 4 negative keywords
DONE {"dryRun":true}
```

- [ ] **Step 4: Commit**

```bash
git add agents/campaign-creator/index.js
git commit -m "feat: campaign-creator main agent with validation and dry-run"
```

---

## Task 6: campaign-monitor Pure Functions + Tests

**Files:**
- Create: `agents/campaign-monitor/index.js` (pure exports only)
- Create: `tests/agents/campaign-monitor.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/agents/campaign-monitor.test.js`:
```js
import { strict as assert } from 'node:assert';
import {
  buildPerformanceEntry,
  evaluateAlerts,
  isDuplicateAlert,
} from '../../agents/campaign-monitor/index.js';

// buildPerformanceEntry — zero conversions → cpa null
const snapCampaign = { spend: 4.82, impressions: 210, clicks: 7, ctr: 0.033, avgCpc: 0.69, conversions: 0 };
const projections = { ctr: 0.035, cpc: 0.65, cvr: 0.022 };
const entry = buildPerformanceEntry('2026-03-21', snapCampaign, projections);
assert.equal(entry.date, '2026-03-21');
assert.equal(entry.spend, 4.82);
assert.equal(entry.cpa, null);
assert.ok(Math.abs(entry.vsProjection.ctrDelta - (-0.002)) < 0.0001);
assert.ok(Math.abs(entry.vsProjection.cpcDelta - 0.04) < 0.0001);

// buildPerformanceEntry — with conversions → cpa computed
const snapWithConv = { ...snapCampaign, conversions: 1 };
const entryWithConv = buildPerformanceEntry('2026-03-21', snapWithConv, projections);
assert.ok(Math.abs(entryWithConv.cpa - 4.82) < 0.001);

// evaluateAlerts — low CTR after 7 days
const performance7 = Array.from({ length: 7 }, (_, i) => ({
  date: `2026-03-${15 + i}`,
  spend: 5, impressions: 200, clicks: 2, ctr: 0.01, avgCpc: 2.5, conversions: 0, cvr: 0, cpa: null,
  vsProjection: { ctrDelta: -0.025, cpcDelta: 1.85, cvrDelta: -0.022 },
}));
const alertsLowCTR = evaluateAlerts(performance7, { ctr: 0.035, cpc: 0.65, cvr: 0.022 }, 5.0, []);
assert.ok(alertsLowCTR.some(a => a.type === 'low_ctr'), 'should fire low_ctr');

// evaluateAlerts — no low_ctr before 7 days
const performance6 = performance7.slice(0, 6);
const alertsEarly = evaluateAlerts(performance6, projections, 5.0, []);
assert.ok(!alertsEarly.some(a => a.type === 'low_ctr'), 'should not fire before 7 days');

// evaluateAlerts — troas_ready when 15 conversions cumulative
const performanceWithConv = Array.from({ length: 20 }, (_, i) => ({
  date: `2026-03-${1 + i}`, spend: 5, impressions: 200, clicks: 10, ctr: 0.05, avgCpc: 0.5,
  conversions: 1, cvr: 0.1, cpa: 5, vsProjection: { ctrDelta: 0.015, cpcDelta: -0.15, cvrDelta: 0.078 },
}));
const alertsTROAS = evaluateAlerts(performanceWithConv, projections, 5.0, []);
assert.ok(alertsTROAS.some(a => a.type === 'troas_ready'), 'should fire troas_ready at 20 conversions');

// evaluateAlerts — high_cpc after 7 days (avg CPC $1.50 > 150% of projected $0.65)
const performance7HighCPC = Array.from({ length: 7 }, (_, i) => ({
  date: `2026-03-${15 + i}`,
  spend: 5, impressions: 200, clicks: 5, ctr: 0.025, avgCpc: 1.5, conversions: 0, cvr: 0, cpa: null,
  vsProjection: { ctrDelta: -0.01, cpcDelta: 0.85, cvrDelta: -0.022 },
}));
const alertsHighCPC = evaluateAlerts(performance7HighCPC, { ctr: 0.035, cpc: 0.65, cvr: 0.022 }, 5.0, []);
assert.ok(alertsHighCPC.some(a => a.type === 'high_cpc'), 'should fire high_cpc after 7 days');

// evaluateAlerts — low_cvr after 14 days (0 conversions < 50% of projected 0.022)
const performance14LowCVR = Array.from({ length: 14 }, (_, i) => ({
  date: `2026-03-${1 + i}`,
  spend: 5, impressions: 200, clicks: 10, ctr: 0.05, avgCpc: 0.5, conversions: 0, cvr: 0, cpa: null,
  vsProjection: { ctrDelta: 0.015, cpcDelta: -0.15, cvrDelta: -0.022 },
}));
const alertsLowCVR = evaluateAlerts(performance14LowCVR, { ctr: 0.035, cpc: 0.65, cvr: 0.022 }, 5.0, []);
assert.ok(alertsLowCVR.some(a => a.type === 'low_cvr'), 'should fire low_cvr after 14 days');

// evaluateAlerts — high_cpa after 14 days
// projectedCPA = 0.65/0.022 = 29.55; threshold = 59.09
// 14 days × spend=$5 = totalSpend=$70; 0.05 conv/day × 14 = 0.7 totalConv; actualCPA = 70/0.7 = $100 > $59.09
const performance14HighCPA = Array.from({ length: 14 }, (_, i) => ({
  date: `2026-03-${1 + i}`,
  spend: 5, impressions: 200, clicks: 10, ctr: 0.05, avgCpc: 0.5, conversions: 0.05, cvr: 0.005, cpa: 100,
  vsProjection: { ctrDelta: 0.015, cpcDelta: -0.15, cvrDelta: -0.017 },
}));
const alertsHighCPA = evaluateAlerts(performance14HighCPA, { ctr: 0.035, cpc: 0.65, cvr: 0.022 }, 5.0, []);
assert.ok(alertsHighCPA.some(a => a.type === 'high_cpa'), 'should fire high_cpa after 14 days');

// evaluateAlerts — budget_maxed (7 consecutive days spend >= 95% of $5 budget)
const performance7BudgetMaxed = Array.from({ length: 7 }, (_, i) => ({
  date: `2026-03-${15 + i}`,
  spend: 5.0, impressions: 500, clicks: 20, ctr: 0.04, avgCpc: 0.25, conversions: 1, cvr: 0.05, cpa: 5,
  vsProjection: { ctrDelta: 0.005, cpcDelta: -0.4, cvrDelta: 0.028 },
}));
const alertsBudgetMaxed = evaluateAlerts(performance7BudgetMaxed, { ctr: 0.035, cpc: 0.65, cvr: 0.022 }, 5.0, []);
assert.ok(alertsBudgetMaxed.some(a => a.type === 'budget_maxed'), 'should fire budget_maxed');

// isDuplicateAlert — returns true if unresolved alert of same type exists
const existingAlerts = [{ type: 'low_ctr', firedAt: '2026-03-20T07:30:00Z', message: 'test', resolved: false }];
assert.ok(isDuplicateAlert('low_ctr', existingAlerts));
assert.ok(!isDuplicateAlert('high_cpc', existingAlerts));
// resolved alerts don't block re-firing
const resolvedAlerts = [{ type: 'low_ctr', firedAt: '2026-03-20T07:30:00Z', message: 'test', resolved: true }];
assert.ok(!isDuplicateAlert('low_ctr', resolvedAlerts));

console.log('✓ campaign-monitor pure function tests pass');
```

- [ ] **Step 2: Run tests — expect failure**

```bash
node --test tests/agents/campaign-monitor.test.js
```
Expected: `Cannot find module '../../agents/campaign-monitor/index.js'`

- [ ] **Step 3: Implement pure exports**

Create `agents/campaign-monitor/index.js`:
```js
// agents/campaign-monitor/index.js
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..', '..');

// ── Pure exports ───────────────────────────────────────────────────────────────

export function buildPerformanceEntry(date, snapCampaign, projections) {
  const { spend, impressions, clicks, ctr, avgCpc, conversions } = snapCampaign;
  const cvr = clicks > 0 ? conversions / clicks : 0;
  const cpa = conversions > 0 ? spend / conversions : null;
  return {
    date,
    spend,
    impressions,
    clicks,
    ctr,
    avgCpc,
    conversions,
    cvr,
    cpa,
    vsProjection: {
      ctrDelta: ctr - projections.ctr,
      cpcDelta: avgCpc - projections.cpc,
      cvrDelta: cvr - projections.cvr,
    },
  };
}

export function isDuplicateAlert(type, existingAlerts) {
  return existingAlerts.some(a => a.type === type && !a.resolved);
}

export function evaluateAlerts(performance, projections, approvedBudget, existingAlerts) {
  const newAlerts = [];
  const days = performance.length;
  if (days === 0) return newAlerts;

  const totalSpend = performance.reduce((s, e) => s + e.spend, 0);
  const totalClicks = performance.reduce((s, e) => s + e.clicks, 0);
  const totalConversions = performance.reduce((s, e) => s + e.conversions, 0);
  const avgCTR = totalClicks > 0 ? performance.reduce((s, e) => s + e.ctr, 0) / days : 0;
  const avgCPC = totalClicks > 0 ? performance.reduce((s, e) => s + e.avgCpc, 0) / days : 0;
  const avgCVR = totalClicks > 0 ? totalConversions / totalClicks : 0;

  const fire = (type, message) => {
    if (!isDuplicateAlert(type, existingAlerts)) {
      newAlerts.push({ type, firedAt: new Date().toISOString(), message, resolved: false });
    }
  };

  // low_ctr: after 7 days, avg CTR < 50% of projected
  if (days >= 7 && avgCTR < projections.ctr * 0.5) {
    fire('low_ctr', `CTR ${(avgCTR * 100).toFixed(2)}% is below 50% of projected ${(projections.ctr * 100).toFixed(2)}% after ${days} days — review ad copy`);
  }

  // high_cpc: after 7 days, avg CPC > 150% of projected
  if (days >= 7 && avgCPC > projections.cpc * 1.5) {
    fire('high_cpc', `Avg CPC $${avgCPC.toFixed(2)} is above 150% of projected $${projections.cpc.toFixed(2)} after ${days} days — consider bid adjustment`);
  }

  // low_cvr: after 14 days, avg CVR < 50% of projected
  if (days >= 14 && avgCVR < projections.cvr * 0.5) {
    fire('low_cvr', `CVR ${(avgCVR * 100).toFixed(2)}% is below 50% of projected ${(projections.cvr * 100).toFixed(2)}% after ${days} days — review landing page`);
  }

  // high_cpa: after 14 days, with conversions, projected CVR > 0
  if (days >= 14 && totalConversions > 0 && projections.cvr > 0) {
    const actualCPA = totalSpend / totalConversions;
    const projectedCPA = projections.cpc / projections.cvr;
    if (actualCPA > projectedCPA * 2.0) {
      fire('high_cpa', `CPA $${actualCPA.toFixed(2)} exceeds 200% of projected $${projectedCPA.toFixed(2)} — consider pausing`);
    }
  }

  // troas_ready: cumulative conversions >= 15
  if (totalConversions >= 15) {
    fire('troas_ready', `${totalConversions} cumulative conversions reached — recommend switching to Target ROAS bidding`);
  }

  // budget_maxed: last 7 days all have spend >= 95% of daily budget
  if (days >= 7) {
    const last7 = performance.slice(-7);
    if (last7.every(e => e.spend >= approvedBudget * 0.95)) {
      fire('budget_maxed', `Daily budget $${approvedBudget} has been at ≥95% utilization for 7 consecutive days — consider increasing budget`);
    }
  }

  return newAlerts;
}
```

- [ ] **Step 4: Run tests — expect pass**

```bash
node --test tests/agents/campaign-monitor.test.js
```
Expected: `✓ campaign-monitor pure function tests pass`

- [ ] **Step 5: Commit**

```bash
git add agents/campaign-monitor/index.js tests/agents/campaign-monitor.test.js
git commit -m "feat: campaign-monitor pure functions + tests"
```

---

## Task 7: campaign-monitor Main Agent

**Files:**
- Modify: `agents/campaign-monitor/index.js` (add data loaders and main)

- [ ] **Step 1: Append data loaders and main() to campaign-monitor**

Append to `agents/campaign-monitor/index.js`:
```js
// ── Data paths ────────────────────────────────────────────────────────────────

const CAMPAIGNS_DIR  = join(ROOT, 'data', 'campaigns');
const ADS_SNAPS_DIR  = join(ROOT, 'data', 'snapshots', 'google-ads');

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const env = {};
    for (const l of lines) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return env;
  } catch { return {}; }
}

function loadCampaigns() {
  if (!existsSync(CAMPAIGNS_DIR)) return [];
  return readdirSync(CAMPAIGNS_DIR)
    .filter(f => f.endsWith('.json') && f !== '.gitkeep')
    .map(f => ({ file: join(CAMPAIGNS_DIR, f), data: (() => { try { return JSON.parse(readFileSync(join(CAMPAIGNS_DIR, f), 'utf8')); } catch { return null; } })() }))
    .filter(c => c.data !== null);
}

function loadLatestAdsSnapshot() {
  if (!existsSync(ADS_SNAPS_DIR)) return null;
  const files = readdirSync(ADS_SNAPS_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
  if (!files[0]) return null;
  try { return JSON.parse(readFileSync(join(ADS_SNAPS_DIR, files[0]), 'utf8')); } catch { return null; }
}

async function main() {
  console.log('Campaign Monitor\n');

  const campaigns = loadCampaigns().filter(c => c.data.status === 'active');
  if (campaigns.length === 0) { console.log('  No active campaigns to monitor.'); return; }

  const snap = loadLatestAdsSnapshot();
  if (!snap) { console.log('  No Google Ads snapshot found — run google-ads-collector first.'); return; }

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const allAlerts = [];

  for (const { file, data: campaign } of campaigns) {
    const campaignId = campaign.googleAds?.campaignId;
    if (!campaignId) { console.log(`  Skipping ${campaign.id} — no campaignId`); continue; }

    const snapCampaign = (snap.campaigns || []).find(c => String(c.id) === String(campaignId));
    if (!snapCampaign) { console.log(`  Skipping ${campaign.id} — not found in snapshot`); continue; }

    // Skip if already have today's entry
    if (campaign.performance.some(e => e.date === today)) {
      console.log(`  ${campaign.id}: already recorded for ${today}`);
      continue;
    }

    const entry = buildPerformanceEntry(today, snapCampaign, campaign.projections);
    campaign.performance.push(entry);

    const newAlerts = evaluateAlerts(campaign.performance, campaign.projections, campaign.proposal.approvedBudget, campaign.alerts);
    campaign.alerts.push(...newAlerts);

    if (newAlerts.length > 0) {
      allAlerts.push({ campaignName: campaign.proposal.campaignName, alerts: newAlerts });
      console.log(`  ${campaign.id}: ${newAlerts.length} new alert(s)`);
    } else {
      console.log(`  ${campaign.id}: spend=$${entry.spend} clicks=${entry.clicks} cvr=${(entry.cvr * 100).toFixed(2)}% — no new alerts`);
    }

    writeFileSync(file, JSON.stringify(campaign, null, 2));
  }

  if (allAlerts.length > 0) {
    const body = allAlerts.map(({ campaignName, alerts }) =>
      `Campaign: ${campaignName}\n${alerts.map(a => `• ${a.message}`).join('\n')}`
    ).join('\n\n');
    const { notify } = await import('../../lib/notify.js');
    await notify({ subject: `Campaign Monitor — ${allAlerts.flatMap(c => c.alerts).length} alert(s)`, body }).catch(() => {});
  }

  console.log(`\nDone. Monitored ${campaigns.length} active campaign(s).`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
```

- [ ] **Step 2: Confirm tests still pass**

```bash
node --test tests/agents/campaign-monitor.test.js
```
Expected: `✓ campaign-monitor pure function tests pass`

- [ ] **Step 3: Run locally against test data**

Copy the fixture and set it to active with a fake campaign ID to test the monitor:
```bash
node -e "
const fs = require('fs');
const f = 'data/campaigns/2026-03-20-natural-toothpaste-search.json';
const d = JSON.parse(fs.readFileSync(f));
d.status = 'active';
d.proposal.approvedBudget = 5.0;
d.googleAds.campaignId = '19977069552'; // use a real campaign ID from the snapshot
d.googleAds.createdAt = new Date().toISOString();
fs.writeFileSync(f, JSON.stringify(d, null, 2));
console.log('done');
"
node agents/campaign-monitor/index.js
```
Expected: `Campaign Monitor` header, monitoring output for the campaign, no crash. The campaign file should have a new performance entry.

- [ ] **Step 4: Commit**

```bash
git add agents/campaign-monitor/index.js
git commit -m "feat: campaign-monitor main agent"
```

---

## Task 8: Dashboard API Routes + Allowlist

**Files:**
- Modify: `agents/dashboard/index.js`

The dashboard needs 6 new API routes and 2 new allowlist entries.

- [ ] **Step 1: Add new agents to RUN_AGENT_ALLOWLIST**

Find `const RUN_AGENT_ALLOWLIST = new Set([` in `agents/dashboard/index.js` and add:
```js
  'agents/campaign-creator/index.js',
  'agents/campaign-analyzer/index.js',
```

- [ ] **Step 2: Add CAMPAIGNS_DIR constant**

Near the other directory constants (search for `ADS_OPTIMIZER_DIR`), add:
```js
const CAMPAIGN_PLANS_DIR = join(ROOT, 'data', 'campaigns');
```

- [ ] **Step 3: Add a readCampaigns helper function**

Add after the constant:
```js
function readCampaigns() {
  if (!existsSync(CAMPAIGN_PLANS_DIR)) return [];
  return readdirSync(CAMPAIGN_PLANS_DIR)
    .filter(f => f.endsWith('.json') && f !== '.gitkeep')
    .map(f => { try { return JSON.parse(readFileSync(join(CAMPAIGN_PLANS_DIR, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
```

- [ ] **Step 4: Add the 6 new API routes**

Find the existing route block (search for `if (req.url === '/api/data')`) and add these routes before it:

```js
  // GET /api/campaigns — list all campaign files
  if (req.method === 'GET' && req.url === '/api/campaigns') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readCampaigns()));
    return;
  }

  // GET /api/campaigns/:id
  if (req.method === 'GET' && req.url.startsWith('/api/campaigns/') && !req.url.includes('/alerts/')) {
    const id = req.url.replace('/api/campaigns/', '');
    if (!/^[\w-]+$/.test(id)) { res.writeHead(400); res.end('Invalid id'); return; }
    const file = join(CAMPAIGN_PLANS_DIR, `${id}.json`);
    if (!existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(readFileSync(file, 'utf8'));
    return;
  }

  // POST /api/campaigns/:id/approve
  if (req.method === 'POST' && /^\/api\/campaigns\/[\w-]+\/approve$/.test(req.url)) {
    const id = req.url.split('/')[3];
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { approvedBudget } = JSON.parse(body);
        if (typeof approvedBudget !== 'number' || approvedBudget <= 0) throw new Error('approvedBudget must be positive number');
        const file = join(CAMPAIGN_PLANS_DIR, `${id}.json`);
        if (!existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
        const campaign = JSON.parse(readFileSync(file, 'utf8'));
        campaign.status = 'approved';
        campaign.proposal.approvedBudget = approvedBudget;
        writeFileSync(file, JSON.stringify(campaign, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/campaigns/:id/dismiss
  if (req.method === 'POST' && /^\/api\/campaigns\/[\w-]+\/dismiss$/.test(req.url)) {
    const id = req.url.split('/')[3];
    const file = join(CAMPAIGN_PLANS_DIR, `${id}.json`);
    if (!existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
    const campaign = JSON.parse(readFileSync(file, 'utf8'));
    campaign.status = 'dismissed';
    writeFileSync(file, JSON.stringify(campaign, null, 2));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /api/campaigns/:id/clarify
  if (req.method === 'POST' && /^\/api\/campaigns\/[\w-]+\/clarify$/.test(req.url)) {
    const id = req.url.split('/')[3];
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { clarificationResponse } = JSON.parse(body);
        if (typeof clarificationResponse !== 'string' || !clarificationResponse.trim()) throw new Error('clarificationResponse must be a non-empty string');
        const file = join(CAMPAIGN_PLANS_DIR, `${id}.json`);
        if (!existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
        const campaign = JSON.parse(readFileSync(file, 'utf8'));
        campaign.clarificationResponse = clarificationResponse.trim();
        writeFileSync(file, JSON.stringify(campaign, null, 2));
        // Spawn re-analysis (non-blocking) — requires spawn imported at top of file (see Step 5)
        spawn('node', [join(ROOT, 'agents/campaign-analyzer/index.js'), '--campaign', id], { cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/campaigns/:id/alerts/:type/resolve
  if (req.method === 'POST' && /^\/api\/campaigns\/[\w-]+\/alerts\/[\w_]+\/resolve$/.test(req.url)) {
    const parts = req.url.split('/');
    const id = parts[3];
    const alertType = parts[5];
    const file = join(CAMPAIGN_PLANS_DIR, `${id}.json`);
    if (!existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
    const campaign = JSON.parse(readFileSync(file, 'utf8'));
    const alert = campaign.alerts.find(a => a.type === alertType && !a.resolved);
    if (alert) { alert.resolved = true; writeFileSync(file, JSON.stringify(campaign, null, 2)); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
```

- [ ] **Step 5: Add `spawn` to the top-level imports**

Find the existing imports at the top of `agents/dashboard/index.js` and add:
```js
import { spawn } from 'node:child_process';
```
The clarify route code above already uses `spawn(...)` directly — this import is what makes it work.

- [ ] **Step 6: Add `writeFileSync` to the existing fs import if not present**

Verify `writeFileSync` is already imported from `node:fs` (it is — used by existing routes). If not, add it.

- [ ] **Step 7: Test routes locally**

With the dashboard running (`node agents/dashboard/index.js`):
```bash
# List campaigns
curl -s -u sean:$(grep DASHBOARD_PASSWORD .env | cut -d= -f2) http://localhost:4242/api/campaigns | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log('count:', JSON.parse(d).length))"

# Approve a campaign
curl -s -u sean:$(grep DASHBOARD_PASSWORD .env | cut -d= -f2) -X POST http://localhost:4242/api/campaigns/2026-03-20-natural-toothpaste-search/approve \
  -H 'Content-Type: application/json' -d '{"approvedBudget": 5.0}'
# Expected: {"ok":true}

# Dismiss
curl -s -u sean:$(grep DASHBOARD_PASSWORD .env | cut -d= -f2) -X POST http://localhost:4242/api/campaigns/2026-03-20-natural-toothpaste-search/dismiss
# Expected: {"ok":true}
```

- [ ] **Step 8: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: dashboard — campaign API routes and allowlist"
```

---

## Task 9: Dashboard UI Cards

**Files:**
- Modify: `agents/dashboard/index.js` (HTML template + client JS)

Three new cards: Campaign Proposals, Clarifications Needed, Active Campaigns Performance.

- [ ] **Step 1: Add campaign cards HTML to the Ads tab**

Find `<div id="tab-ads" class="tab-panel">` in the HTML template. Add the three new card containers at the top of that div, before the existing `ads-opt-card`:

```html
<!-- Campaign Proposals card -->
<div class="card" id="campaign-proposals-card" style="display:none">
  <div class="card-header accent-indigo"><h2>Campaign Proposals</h2><span class="section-note" id="campaign-proposals-note"></span></div>
  <div class="card-body" id="campaign-proposals-body"></div>
</div>

<!-- Clarifications Needed card -->
<div class="card" id="campaign-clarify-card" style="display:none">
  <div class="card-header" style="background:#fef3c7"><h2>Clarifications Needed</h2></div>
  <div class="card-body" id="campaign-clarify-body"></div>
</div>

<!-- Active Campaigns Performance card -->
<div class="card" id="campaign-active-card" style="display:none">
  <div class="card-header"><h2>Active Campaigns</h2></div>
  <div class="card-body" id="campaign-active-body"></div>
</div>
```

- [ ] **Step 2: Add CSS for campaign cards**

Add to the `<style>` block:
```css
.camp-proposal { border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; margin-bottom: 12px; }
.camp-proposal-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.camp-proposal-name { font-weight: 600; font-size: 15px; }
.camp-proposal-meta { font-size: 12px; color: var(--muted); margin-top: 4px; }
.camp-proposal-rationale { font-size: 13px; color: var(--muted); margin: 8px 0; }
.camp-proposal-actions { display: flex; gap: 8px; margin-top: 10px; }
.camp-budget-input { width: 80px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 4px; font-size: 13px; }
.delta-up { color: var(--green); } .delta-down { color: var(--red); }
.alert-badge-inline { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; background: #fef2f2; color: #991b1b; margin-right: 4px; }
```

- [ ] **Step 3: Add renderCampaignCards client JS function**

In the `<script>` block, add a new function `renderCampaignCards(campaigns)` and call it from `loadData()` after data is loaded:

```js
async function loadCampaignCards() {
  try {
    const res = await fetch('/api/campaigns', { credentials: 'same-origin' });
    if (!res.ok) return;
    const campaigns = await res.json();
    renderCampaignCards(campaigns);
  } catch (e) { console.error('Campaign cards error:', e); }
}

function renderCampaignCards(campaigns) {
  // --- Proposals ---
  const proposals = campaigns.filter(c => c.status === 'proposed' && !c.clarificationNeeded);
  const propCard = document.getElementById('campaign-proposals-card');
  const propBody = document.getElementById('campaign-proposals-body');
  if (proposals.length > 0) {
    propCard.style.display = '';
    document.getElementById('campaign-proposals-note').textContent = proposals.length + ' pending';
    propBody.innerHTML = proposals.map(c => {
      const p = c.proposal;
      return '<div class="camp-proposal" id="prop-' + esc(c.id) + '">' +
        '<div class="camp-proposal-header">' +
        '<div><div class="camp-proposal-name">' + esc(p.campaignName) + '</div>' +
        '<div class="camp-proposal-meta">Budget: $<input class="camp-budget-input" id="budget-' + esc(c.id) + '" type="number" min="1" step="0.5" value="' + (p.suggestedBudget || 5) + '">/day &nbsp;|&nbsp; ' +
        'Proj: $' + (c.projections?.monthlyRevenue || '—') + '/mo · ' + (c.projections?.monthlyConversions || '—') + ' conv</div></div>' +
        '<span class="badge badge-gray">' + esc(c.status) + '</span></div>' +
        '<div class="camp-proposal-rationale">' + esc((c.rationale || '').slice(0, 160)) + (c.rationale?.length > 160 ? '…' : '') + '</div>' +
        '<div class="camp-proposal-actions">' +
        '<button onclick="approveCampaign(&apos;' + esc(c.id) + '&apos;)" id="approve-btn-' + esc(c.id) + '">Approve</button>' +
        '<button onclick="dismissCampaign(&apos;' + esc(c.id) + '&apos;)" class="btn-secondary">Dismiss</button>' +
        '</div>' +
        '<div id="launch-row-' + esc(c.id) + '" style="display:none;margin-top:8px">' +
        '<button onclick="launchCampaign(&apos;' + esc(c.id) + '&apos;)" style="background:#10b981">Confirm &amp; Launch</button>' +
        '</div></div>';
    }).join('');
  } else { propCard.style.display = 'none'; }

  // --- Clarifications ---
  const clarify = campaigns.filter(c => c.clarificationNeeded && c.clarificationNeeded.length > 0);
  const clarCard = document.getElementById('campaign-clarify-card');
  const clarBody = document.getElementById('campaign-clarify-body');
  if (clarify.length > 0) {
    clarCard.style.display = '';
    clarBody.innerHTML = clarify.map(c =>
      '<div class="camp-proposal"><strong>' + esc(c.id) + '</strong>' +
      '<ol>' + c.clarificationNeeded.map(q => '<li>' + esc(q) + '</li>').join('') + '</ol>' +
      '<textarea id="clarify-text-' + esc(c.id) + '" rows="3" style="width:100%;margin-top:8px" placeholder="Your answer..."></textarea>' +
      '<button style="margin-top:6px" onclick="submitClarification(&apos;' + esc(c.id) + '&apos;)">Submit</button>' +
      '</div>'
    ).join('');
  } else { clarCard.style.display = 'none'; }

  // --- Active campaigns ---
  const active = campaigns.filter(c => c.status === 'active');
  const actCard = document.getElementById('campaign-active-card');
  const actBody = document.getElementById('campaign-active-body');
  if (active.length > 0) {
    actCard.style.display = '';
    actBody.innerHTML = active.map(c => {
      const recent = c.performance.slice(-1)[0] || {};
      const proj = c.projections || {};
      const budget = c.proposal?.approvedBudget || 0;
      const spendPct = budget > 0 ? Math.round((recent.spend || 0) / budget * 100) : 0;
      const openAlerts = (c.alerts || []).filter(a => !a.resolved);
      const ctrDelta = recent.vsProjection?.ctrDelta ?? null;
      const cpcDelta = recent.vsProjection?.cpcDelta ?? null;
      const cvrDelta = recent.vsProjection?.cvrDelta ?? null;
      const days = c.googleAds?.createdAt ? Math.floor((Date.now() - new Date(c.googleAds.createdAt)) / 86400000) : '?';
      return '<div class="camp-proposal">' +
        '<div class="camp-proposal-name">' + esc(c.proposal?.campaignName || c.id) + ' <span class="section-note">Day ' + days + '</span></div>' +
        '<div style="margin:8px 0;background:#f1f5f9;border-radius:4px;height:6px"><div style="background:#818cf8;height:6px;border-radius:4px;width:' + Math.min(spendPct, 100) + '%"></div></div>' +
        '<div class="camp-proposal-meta">Spend: $' + (recent.spend ?? '—') + '/' + budget + ' (' + spendPct + '%) &nbsp;|&nbsp; ' +
        'CTR: <span class="' + (ctrDelta >= 0 ? 'delta-up' : 'delta-down') + '">' + (ctrDelta !== null ? (ctrDelta >= 0 ? '+' : '') + (ctrDelta * 100).toFixed(2) + 'pp' : '—') + '</span> &nbsp;|&nbsp; ' +
        'CPC: <span class="' + (cpcDelta <= 0 ? 'delta-up' : 'delta-down') + '">' + (cpcDelta !== null ? (cpcDelta >= 0 ? '+' : '') + '$' + cpcDelta.toFixed(2) : '—') + '</span> &nbsp;|&nbsp; ' +
        'CVR: <span class="' + (cvrDelta >= 0 ? 'delta-up' : 'delta-down') + '">' + (cvrDelta !== null ? (cvrDelta >= 0 ? '+' : '') + (cvrDelta * 100).toFixed(2) + 'pp' : '—') + '</span></div>' +
        (openAlerts.length > 0 ? '<div style="margin-top:8px">' + openAlerts.map(a =>
          '<span class="alert-badge-inline">' + esc(a.type.replace(/_/g, ' ')) + '</span>' +
          '<button style="font-size:11px;padding:2px 6px" onclick="resolveAlert(&apos;' + esc(c.id) + '&apos;,&apos;' + esc(a.type) + '&apos;)">Resolve</button> '
        ).join('') + '</div>' : '') +
        '</div>';
    }).join('');
  } else { actCard.style.display = 'none'; }
}

async function approveCampaign(id) {
  const budget = parseFloat(document.getElementById('budget-' + id)?.value);
  if (!budget || budget <= 0) { alert('Enter a valid budget before approving.'); return; }
  try {
    const res = await fetch('/api/campaigns/' + id + '/approve', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approvedBudget: budget }) });
    if (!res.ok) throw new Error(await res.text());
    document.getElementById('approve-btn-' + id).disabled = true;
    document.getElementById('launch-row-' + id).style.display = '';
  } catch (e) { alert('Approve failed: ' + e.message); }
}

async function dismissCampaign(id) {
  if (!confirm('Dismiss this campaign proposal?')) return;
  try {
    await fetch('/api/campaigns/' + id + '/dismiss', { method: 'POST', credentials: 'same-origin' });
    document.getElementById('prop-' + id)?.remove();
  } catch (e) { alert('Dismiss failed: ' + e.message); }
}

function launchCampaign(id) {
  if (!confirm('Create this campaign in Google Ads? This cannot be undone.')) return;
  fetch('/run-agent', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'agents/campaign-creator/index.js', args: ['--campaign', id] }),
  }).then(res => {
    const reader = res.body.getReader();
    const log = document.getElementById('run-log-apply-ads');
    if (log) { log.style.display = ''; log.textContent = ''; }
    const read = () => reader.read().then(({ done, value }) => {
      if (done) { loadCampaignCards(); return; }
      if (log) log.textContent += new TextDecoder().decode(value);
      read();
    });
    read();
  }).catch(e => alert('Launch failed: ' + e.message));
}

async function submitClarification(id) {
  const text = document.getElementById('clarify-text-' + id)?.value?.trim();
  if (!text) { alert('Please enter your answer before submitting.'); return; }
  try {
    await fetch('/api/campaigns/' + id + '/clarify', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clarificationResponse: text }) });
    alert('Response submitted. Re-analysis is running in the background.');
  } catch (e) { alert('Submit failed: ' + e.message); }
}

async function resolveAlert(id, type) {
  try {
    await fetch('/api/campaigns/' + id + '/alerts/' + type + '/resolve', { method: 'POST', credentials: 'same-origin' });
    loadCampaignCards();
  } catch (e) { alert('Resolve failed: ' + e.message); }
}
```

- [ ] **Step 4: Call loadCampaignCards() from loadData()**

Find `async function loadData()` and add a call to `loadCampaignCards()` after the main data renders:
```js
loadCampaignCards();
```

- [ ] **Step 5: Test UI locally**

Start dashboard (`node agents/dashboard/index.js`), open `http://localhost:4242`, click Ads tab.

Expected: Campaign Proposals card visible with "2026-03-20-natural-toothpaste-search" (if you have the test fixture in `data/campaigns/`). Budget input editable. Approve button works. Launch button appears after approve.

- [ ] **Step 6: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: dashboard — campaign proposal, clarification, and active campaign cards"
```

---

## Task 10: Cron Setup

**Files:**
- Modify: `scripts/setup-cron.sh`

- [ ] **Step 1: Add analyzer and monitor to cron script**

In `scripts/setup-cron.sh`, find the section where existing cron entries are added to `NEW_CRONTAB`. Add:
```bash
DAILY_CAMPAIGN_MONITOR="30 7 * * * TZ=America/Los_Angeles cd $PROJECT_DIR && node agents/campaign-monitor/index.js >> data/reports/campaign-monitor.log 2>&1"
WEEKLY_CAMPAIGN_ANALYZER="0 6 * * 0 TZ=America/Los_Angeles cd $PROJECT_DIR && node agents/campaign-analyzer/index.js >> data/reports/campaign-analyzer.log 2>&1"
```

And add both to the `NEW_CRONTAB` heredoc alongside the other entries.

Add `data/reports/campaign-monitor.log` and `data/reports/campaign-analyzer.log` to `.gitignore`.

- [ ] **Step 2: Add npm scripts**

In `package.json`, confirm these are present (added in Task 1):
```json
"campaign-analyzer": "node agents/campaign-analyzer/index.js",
"campaign-creator": "node agents/campaign-creator/index.js",
"campaign-monitor": "node agents/campaign-monitor/index.js"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/setup-cron.sh .gitignore package.json
git commit -m "feat: add campaign-analyzer and campaign-monitor cron entries"
```

---

## Task 11: Run Full Test Suite + Local Verification

- [ ] **Step 1: Run all tests**

```bash
npm test
```
Expected: All existing tests pass plus new campaign-analyzer, campaign-creator, campaign-monitor tests.

- [ ] **Step 2: Run analyzer dry-run end-to-end**

```bash
node agents/campaign-analyzer/index.js --dry-run
```
Expected: Proposal JSON printed to stdout, no files written, no crashes.

- [ ] **Step 3: Verify dashboard campaign cards**

Start dashboard, open Ads tab. Confirm:
- Campaign Proposals card shows pending proposals
- Approve flow works (budget input → Approve → Confirm & Launch appears)
- No JS errors in browser console

- [ ] **Step 4: Run full test suite one more time**

```bash
npm test
```
Expected: All pass.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: campaign planner system — analyzer, creator, monitor, dashboard integration"
```

---

## Task 12: Push to Server (After Local Verification)

Only after all local tests pass and the dashboard is verified locally.

- [ ] **Step 1: Push branch**

```bash
git push -u origin feature/campaign-planner
```

- [ ] **Step 2: Create PR and merge**

Use the finishing-a-development-branch skill.

- [ ] **Step 3: Deploy to server**

```bash
ssh root@137.184.119.230
cd /root/seo-claude && git pull
fuser -k 4242/tcp 2>/dev/null
pm2 restart seo-dashboard
# Run cron setup
bash scripts/setup-cron.sh
```

- [ ] **Step 4: Verify on server**

```bash
curl -s -u sean:$(grep DASHBOARD_PASSWORD .env | cut -d= -f2) http://localhost:4242/api/campaigns
```
Expected: JSON array (may be empty if no campaign files on server yet).

- [ ] **Step 5: Run analyzer on server**

```bash
node agents/campaign-analyzer/index.js --dry-run
```
Expected: Proposal output. If ready, remove `--dry-run` to write real proposals.
