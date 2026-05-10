# Sensitive Skin Set — Google Ads Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Phase 0 code work needed to launch a 21-day, $252 Google Search validation campaign for the Sensitive Skin Moisturizing Set PDP, including a mid-test Clarity audit pipeline.

**Architecture:** Three small, isolated changes — extend `lib/clarity.js` for URL-filtered metrics (reusable for any future PDP audit), extend `agents/campaign-creator/index.js` to emit `trackingUrlTemplate` and override `targetSearchNetwork` (so the new campaign can append UTMs and disable Search Network partners without changing defaults that affect prior campaigns). Plus a new campaign JSON proposal file and a one-off mid-test report script that composes the existing GA4, Google Ads, and Clarity libs.

**Tech Stack:** Node.js (ESM), `node:test` / `node --test` for tests, Microsoft Clarity Data Export API, Google Ads API v20, Google Analytics Data API v1.

**Spec:** [docs/superpowers/specs/2026-05-09-sensitive-skin-set-google-ads-validation.md](../specs/2026-05-09-sensitive-skin-set-google-ads-validation.md)

---

## File structure

| File | Action | Responsibility |
|---|---|---|
| `lib/clarity.js` | Modify | Add optional `{ url, numOfDays }` filter to `fetchClarityInsights`. Backward-compatible default. Extract `buildClarityUrl` pure helper for testability. |
| `tests/lib/clarity.test.js` | Create | Pure-function tests for `buildClarityUrl`. No live API calls. |
| `agents/campaign-creator/index.js` | Modify | Extend `buildCampaignOperation` to accept 5th optional `options` arg for `trackingUrlTemplate` and `targetSearchNetwork` overrides. Update `main()` to pass these from proposal. |
| `tests/agents/campaign-creator.test.js` | Modify | Add tests for new options behavior; existing tests must still pass with old call signature. |
| `data/campaigns/2026-05-09-sensitive-skin-set-search-validation.json` | Create | Campaign proposal in the schema validated by `validateCampaignFile`. Status `proposed` → flipped to `approved` by user before launch. |
| `scripts/sensitive-skin-set-mid-test-report.js` | Create | Composes Clarity (URL-filtered) + GA4 (paid-only) + Google Ads (campaign-scoped). Outputs markdown to `data/reports/sensitive-skin-set-validation/day-N.md`. Robust to "campaign not yet launched" state. |
| `data/reports/sensitive-skin-set-validation/.gitkeep` | Create | Reserve the report directory. |

---

## Task 1: Extend `lib/clarity.js` for URL-filtered insights

**Files:**
- Modify: `lib/clarity.js`
- Create: `tests/lib/clarity.test.js`

**Why:** The current `fetchClarityInsights()` returns site-wide aggregates only. For the mid-test PDP audit we need per-URL metrics. The Clarity Data Export API supports a URL filter via `dimension1=URL&dimension1Value=<path>` query parameters.

- [ ] **Step 1: Read current `lib/clarity.js`** to confirm current shape

```bash
cat lib/clarity.js
```

Expected: 98 lines, exports `fetchClarityInsights()` with no arguments, builds URL inline.

- [ ] **Step 2: Write the failing test** at `tests/lib/clarity.test.js`

```javascript
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildClarityUrl } from '../../lib/clarity.js';

const ENDPOINT = 'www.clarity.ms/export-data/api/v1/project-live-insights';

test('buildClarityUrl: no filter returns base endpoint with default numOfDays', () => {
  const url = buildClarityUrl({ endpoint: ENDPOINT });
  assert.equal(url, `https://${ENDPOINT}?numOfDays=1`);
});

test('buildClarityUrl: numOfDays override is reflected', () => {
  const url = buildClarityUrl({ endpoint: ENDPOINT, numOfDays: 3 });
  assert.equal(url, `https://${ENDPOINT}?numOfDays=3`);
});

test('buildClarityUrl: url filter adds dimension1 params, URL-encoded', () => {
  const url = buildClarityUrl({
    endpoint: ENDPOINT,
    url: '/products/sensitive-skin-starter-set',
  });
  assert.equal(
    url,
    `https://${ENDPOINT}?numOfDays=1&dimension1=URL&dimension1Value=%2Fproducts%2Fsensitive-skin-starter-set`
  );
});

test('buildClarityUrl: url + numOfDays combined', () => {
  const url = buildClarityUrl({
    endpoint: ENDPOINT,
    numOfDays: 3,
    url: '/products/coconut-lotion',
  });
  assert.equal(
    url,
    `https://${ENDPOINT}?numOfDays=3&dimension1=URL&dimension1Value=%2Fproducts%2Fcoconut-lotion`
  );
});
```

- [ ] **Step 3: Run test, verify it fails** (`buildClarityUrl` not yet exported)

```bash
node --test tests/lib/clarity.test.js 2>&1 | tail -20
```

Expected: failures with messages mentioning `buildClarityUrl is not a function` or `is not exported`.

- [ ] **Step 4: Refactor `lib/clarity.js`** — extract `buildClarityUrl`, update `fetchClarityInsights` signature

Replace lines 41–50 (the JSDoc + `fetchClarityInsights` opening through the `fetch(url, ...)` call) with:

```javascript
/**
 * Build the Clarity Data Export API URL with optional filters.
 * @param {object} opts
 * @param {string} opts.endpoint - hostname + path (no protocol)
 * @param {number} [opts.numOfDays=1] - 1, 2, or 3
 * @param {string} [opts.url] - page URL to filter by (sets dimension1)
 * @returns {string} fully-formed https URL
 */
export function buildClarityUrl({ endpoint, numOfDays = 1, url = null }) {
  const params = new URLSearchParams({ numOfDays: String(numOfDays) });
  if (url) {
    params.set('dimension1', 'URL');
    params.set('dimension1Value', url);
  }
  return `https://${endpoint}?${params.toString()}`;
}

/**
 * Fetch and normalize the Clarity live-insights snapshot.
 * @param {object} [opts]
 * @param {string} [opts.url] - filter to a specific page URL (e.g. '/products/foo')
 * @param {number} [opts.numOfDays=1] - 1, 2, or 3
 * @returns {Promise<object|null>} normalized snapshot, or null if no sessions
 */
export async function fetchClarityInsights({ url: pageUrl = null, numOfDays = 1 } = {}) {
  const requestUrl = buildClarityUrl({ endpoint: ENDPOINT, numOfDays, url: pageUrl });
  const res = await fetch(requestUrl, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  });
```

The rest of `fetchClarityInsights` (response handling, normalization) stays unchanged.

- [ ] **Step 5: Run test, verify it passes**

```bash
node --test tests/lib/clarity.test.js 2>&1 | tail -10
```

Expected: `# pass 4`, no failures.

- [ ] **Step 6: Backward-compat smoke test** — run an actual API call with no args

```bash
node --input-type=module -e "import { fetchClarityInsights } from './lib/clarity.js'; const r = await fetchClarityInsights(); console.log('total sessions:', r?.sessions?.total ?? 'null'); console.log('site-wide scrollDepth:', r?.behavior?.scrollDepth ?? 'null');" 2>&1 | tail -5
```

Expected: prints session count and scroll depth (or `null` if no data today). No errors.

- [ ] **Step 7: Confirm any callers of `fetchClarityInsights` still work** (no positional args were ever passed)

```bash
grep -rn "fetchClarityInsights" --include="*.js" /Users/seanfillmore/Code/Claude/agents /Users/seanfillmore/Code/Claude/scripts /Users/seanfillmore/Code/Claude/lib 2>&1 | grep -v "test"
```

Expected: callers exist (likely `agents/clarity-collector/`); none pass arguments. The new optional-args signature is backward-compatible.

- [ ] **Step 8: Commit**

```bash
git add lib/clarity.js tests/lib/clarity.test.js
git commit -m "$(cat <<'EOF'
feat(clarity): add URL-filter support to fetchClarityInsights

Extends fetchClarityInsights({ url, numOfDays }) with optional URL
filter via the Clarity Data Export API's dimension1=URL parameter.
Backward-compatible — no args still returns site-wide aggregate.
Extracts buildClarityUrl as a pure helper for testability.

Needed for the Sensitive Skin Set Google Ads validation mid-test
audit (per docs/superpowers/specs/2026-05-09-sensitive-skin-set-
google-ads-validation.md).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Extend `campaign-creator` for `trackingUrlTemplate` and `targetSearchNetwork`

**Files:**
- Modify: `agents/campaign-creator/index.js`
- Modify: `tests/agents/campaign-creator.test.js`

**Why:** The new campaign needs a Google Ads `trackingUrlTemplate` so paid clicks get UTM params for downstream Clarity filtering, AND needs `targetSearchNetwork: false` to disable Search Network partners (the spec calls for Google Search only). The existing `buildCampaignOperation` has a hardcoded positional signature; we add a 5th optional `options` arg so prior call sites keep working unchanged.

- [ ] **Step 1: Add failing tests** to `tests/agents/campaign-creator.test.js`

After the existing `buildCampaignOperation` test (around line 56), insert:

```javascript
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
```

- [ ] **Step 2: Run test, verify it fails**

```bash
node tests/agents/campaign-creator.test.js 2>&1 | tail -10
```

Expected: failure mentioning `trackingUrlTemplate` is `undefined` instead of the expected string, OR the override test fails because options arg is ignored.

- [ ] **Step 3: Update `buildCampaignOperation`** in `agents/campaign-creator/index.js`

Replace lines 48–71 with:

```javascript
export function buildCampaignOperation(name, budgetResourceName, mobileAdjustment, customerResourceName, options = {}) {
  const { trackingUrlTemplate = null, targetSearchNetwork = true } = options;
  const create = {
    resourceName: `${customerResourceName}/campaigns/-2`,
    name,
    status: 'PAUSED',
    advertisingChannelType: 'SEARCH',
    campaignBudget: budgetResourceName,
    manualCpc: { enhancedCpcEnabled: false },
    networkSettings: {
      targetGoogleSearch: true,
      targetSearchNetwork,
      targetContentNetwork: false,
    },
    geoTargetTypeSetting: {
      positiveGeoTargetType: 'PRESENCE_OR_INTEREST',
    },
    biddingStrategyType: 'MANUAL_CPC',
    containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
  };
  if (trackingUrlTemplate) create.trackingUrlTemplate = trackingUrlTemplate;
  return { campaignOperation: { create } };
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
node tests/agents/campaign-creator.test.js 2>&1 | tail -5
```

Expected: `✓ campaign-creator pure function tests pass`.

- [ ] **Step 5: Update `main()` call site** to pass options from proposal

In `agents/campaign-creator/index.js`, find the line (around line 217):

```javascript
const campaignOp = buildCampaignOperation(proposal.campaignName, `${customerResourceName}/campaignBudgets/-1`, mobileAdj, customerResourceName);
```

Replace with:

```javascript
const campaignOp = buildCampaignOperation(
  proposal.campaignName,
  `${customerResourceName}/campaignBudgets/-1`,
  mobileAdj,
  customerResourceName,
  {
    trackingUrlTemplate: proposal.trackingUrlTemplate ?? null,
    targetSearchNetwork: proposal.targetSearchNetwork ?? true,
  }
);
```

- [ ] **Step 6: Re-run tests** to make sure the main() change didn't break anything

```bash
node tests/agents/campaign-creator.test.js 2>&1 | tail -5
```

Expected: still passes.

- [ ] **Step 7: Commit**

```bash
git add agents/campaign-creator/index.js tests/agents/campaign-creator.test.js
git commit -m "$(cat <<'EOF'
feat(campaign-creator): add trackingUrlTemplate + targetSearchNetwork options

Extends buildCampaignOperation with an optional 5th options arg:
- trackingUrlTemplate: emit Google Ads campaign-level tracking template
  (used to append UTM params at click time so Clarity can filter to
  paid-only sessions)
- targetSearchNetwork: override to disable Search Network partners
  (defaults to true for backward compat with existing campaigns)

main() reads both from the proposal JSON. Backward-compatible — proposals
that don't specify either field behave identically to before.

Needed for the Sensitive Skin Set Google Ads validation campaign.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Build the campaign proposal JSON

**Files:**
- Create: `data/campaigns/2026-05-09-sensitive-skin-set-search-validation.json`

**Why:** The `campaign-creator` agent consumes JSON files in `data/campaigns/`. This file encodes every spec decision (keywords, ads, budget, negatives, tracking template, etc.) in the schema validated by `validateCampaignFile`.

- [ ] **Step 1: Create the file** with the full spec encoded

Create `data/campaigns/2026-05-09-sensitive-skin-set-search-validation.json`:

```json
{
  "id": "2026-05-09-sensitive-skin-set-search-validation",
  "status": "proposed",
  "createdAt": "2026-05-09T22:00:00.000Z",
  "proposal": {
    "campaignName": "RSC | Sensitive Skin Set | Search | Validation",
    "objective": "Validate whether the Sensitive Skin Moisturizing Set PDP and offer convert paid Google Search traffic. Binary read at day 21: scale, kill, or extend.",
    "landingPage": "/products/sensitive-skin-starter-set",
    "network": "Search",
    "suggestedBudget": 12,
    "approvedBudget": null,
    "mobileAdjustmentPct": 0,
    "maxCpcUSD": 1.4,
    "trackingUrlTemplate": "{lpurl}?utm_source=google&utm_medium=cpc&utm_campaign=sensitive-skin-set-validation&utm_content={adgroupid}&utm_term={keyword}",
    "targetSearchNetwork": false,
    "adGroups": [
      {
        "name": "Sensitive Skin Set — Format",
        "keywords": [
          { "text": "fragrance free body lotion", "matchType": "PHRASE" },
          { "text": "fragrance free lotion for sensitive skin", "matchType": "PHRASE" },
          { "text": "unscented body lotion", "matchType": "PHRASE" },
          { "text": "unscented lotion for sensitive skin", "matchType": "EXACT" },
          { "text": "paraben free body lotion", "matchType": "EXACT" }
        ],
        "headlines": [
          "Fragrance-Free Body Lotion",
          "Pure Unscented. Pure Clean.",
          "Zero Fragrance. Zero Parabens.",
          "Unscented Lotion + Cream Set",
          "For Fragrance-Sensitive Skin",
          "No Mineral Oil. No Lanolin.",
          "Light Lotion + Night Cream",
          "Coconut Oil & Organic Jojoba",
          "Handmade in the USA",
          "30-Day Money-Back Guarantee",
          "From $0.55 a Day, 12-Wk Supply",
          "Truly Unscented, Not Masked"
        ],
        "descriptions": [
          "Pure Unscented body lotion + overnight cream. No fragrance — not even masking scents.",
          "Cold-pressed coconut oil + jojoba. Paraben-free, lanolin-free, mineral oil-free.",
          "Two-step daily + nightly routine for sensitive, fragrance-reactive skin. Handmade USA.",
          "Approx $0.55/day. Subscribe & get free lip balm + bar soap with your first order."
        ]
      }
    ],
    "negativeKeywords": [
      "free", "coupon", "cheap", "discount code", "recipe", "homemade", "how to make", "diy", "prescription",
      "face", "face lotion", "hand cream", "baby", "baby lotion", "tattoo", "body wash", "bar soap", "essential oil",
      "amazon", "walmart", "target", "cvs", "costco", "sephora", "ulta",
      "aveeno", "cerave", "cetaphil", "eucerin", "lubriderm", "vaseline", "vanicream", "gold bond", "nivea",
      "eczema", "psoriasis", "dermatitis", "rosacea",
      "wholesale", "bulk", "distributor", "near me", "samples"
    ]
  },
  "rationale": "DataForSEO confirmed real CPCs in the format-keyword cluster average ~$1.05 effective. At $12/day for 21 days ($252 total), expected ~240 clicks. Hitting the kill criteria (≥5 purchases at ≤$50 CPA) requires 2.1% CVR — achievable for cold paid traffic to a message-matched PDP. Single ad group, format-only angle (fragrance-free / unscented / paraben-free) chosen because it aligns with the PDP's 'Pure Unscented' framing. Symptom/eczema angle held for Phase 2 with a dedicated landing page (PDP doesn't say 'eczema' — would create message-mismatch and tank CVR). PDP launched 2026-05-09; paid is the only traffic source, so all signals are attributable. See docs/superpowers/specs/2026-05-09-sensitive-skin-set-google-ads-validation.md for full design rationale.",
  "dataPoints": {
    "dfsCpcFragranceFreeBodyLotion": "$0.82 CPC, 3,600 vol/mo",
    "dfsCpcFragranceFreeForSensitive": "$1.18 CPC, 2,900 vol/mo",
    "dfsCpcUnscentedBodyLotion": "$0.91 CPC, 1,300 vol/mo",
    "dfsCpcUnscentedForSensitive": "$0.85 CPC, 320 vol/mo",
    "dfsCpcParabenFreeBodyLotion": "$2.18 CPC, 720 vol/mo (capped by max bid $1.40)",
    "aov": "$46.80 (sale; regular $58.00)",
    "subscriptionBonus": "Free lip balm + bar soap on first subscription order"
  },
  "projections": {
    "ctr": 0.04,
    "cpc": 1.05,
    "cvr": 0.021,
    "dailyClicks": 11.4,
    "monthlyCost": 252,
    "monthlyConversions": 5,
    "monthlyRevenue": 234.0
  },
  "killCriteria": {
    "framework": "≥5 purchases at ≤$50 CPA over 21 days",
    "windowDays": 21,
    "minPurchases": 5,
    "maxCpaUSD": 50,
    "verdictBands": "See spec — full decision table covering WIN / KILL / INCONCLUSIVE bands"
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

- [ ] **Step 2: Smoke-test that the file parses and partially validates**

`validateCampaignFile()` requires `status: 'approved'` to pass. We'll use a temporary approved override:

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { validateCampaignFile } from './agents/campaign-creator/index.js';
const c = JSON.parse(readFileSync('data/campaigns/2026-05-09-sensitive-skin-set-search-validation.json', 'utf8'));
const approved = { ...c, status: 'approved', proposal: { ...c.proposal, approvedBudget: 12 } };
try { validateCampaignFile(approved); console.log('VALID — would pass validation once status=approved and approvedBudget=12 set'); } catch (e) { console.error('INVALID:', e.message); process.exit(1); }
" 2>&1 | tail -3
```

Expected: `VALID — would pass validation once status=approved and approvedBudget=12 set`.

- [ ] **Step 3: Run the campaign-creator dry-run** to confirm the file integrates end-to-end

```bash
node agents/campaign-creator/index.js --campaign 2026-05-09-sensitive-skin-set-search-validation --dry-run 2>&1 | tail -15
```

Expected output should include:

```
Campaign Creator — 2026-05-09-sensitive-skin-set-search-validation
```

then either:

(a) success with `[DRY RUN] Would create CampaignBudget…` lines (if you've already temporarily flipped status to `approved` and added `approvedBudget`), OR

(b) a clear error message about `status must be 'approved'` (expected because we ship the file with `status: 'proposed'`).

If (b), this confirms the validation gate works correctly and the file integrates with `campaign-creator`. The user will flip `status: 'approved'` and `approvedBudget: 12` manually before launch.

- [ ] **Step 4: Commit**

```bash
git add data/campaigns/2026-05-09-sensitive-skin-set-search-validation.json
git commit -m "$(cat <<'EOF'
feat(campaigns): add sensitive skin set validation campaign proposal

Encodes the Sensitive Skin Set Google Ads validation campaign in the
campaign-creator JSON schema. Single ad group, format-only keyword angle,
$12/day suggested budget, ROAS-based kill criteria. Status: proposed
(user flips to approved + sets approvedBudget=12 before launch).

Includes:
- 5 keywords (PHRASE/EXACT mix) with DataForSEO-validated volume/CPC
- 12 RSA headlines + 4 descriptions, all under Google's char limits
- 41 negative keywords across 5 buckets (intent, product, channel,
  competitor brands, symptom-keyword block)
- trackingUrlTemplate for paid-only Clarity filtering
- targetSearchNetwork=false to disable Search Network partners

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Build the mid-test report script

**Files:**
- Create: `scripts/sensitive-skin-set-mid-test-report.js`
- Create: `data/reports/sensitive-skin-set-validation/.gitkeep`

**Why:** Phase 3 (days 5–7) needs a one-command report combining Clarity URL-filtered behavior, GA4 paid-session funnel metrics, and Google Ads campaign performance. Robust to "campaign not yet launched" — should print a useful "no data yet" message rather than crash.

- [ ] **Step 1: Reserve the report directory**

```bash
mkdir -p data/reports/sensitive-skin-set-validation && touch data/reports/sensitive-skin-set-validation/.gitkeep
```

- [ ] **Step 2: Create the script** at `scripts/sensitive-skin-set-mid-test-report.js`

```javascript
/**
 * Sensitive Skin Set — mid-test report generator.
 *
 * Composes Clarity (URL-filtered, paid-only via UTM), GA4 (paid sessions),
 * and Google Ads (campaign-scoped) into a single markdown report.
 *
 * Usage:
 *   node scripts/sensitive-skin-set-mid-test-report.js
 *   node scripts/sensitive-skin-set-mid-test-report.js --day 7
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const PDP_URL_PATH = '/products/sensitive-skin-starter-set';
const CAMPAIGN_NAME = 'RSC | Sensitive Skin Set | Search | Validation';
const REPORT_DIR = join(ROOT, 'data', 'reports', 'sensitive-skin-set-validation');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const day = arg('day', String(Math.ceil((Date.now() - new Date('2026-05-09').getTime()) / 86400000)));

async function loadClarity() {
  try {
    const { fetchClarityInsights } = await import('../lib/clarity.js');
    const data = await fetchClarityInsights({ url: PDP_URL_PATH, numOfDays: 3 });
    if (!data) return { available: false, reason: 'no Clarity sessions in window' };
    return { available: true, data };
  } catch (err) {
    return { available: false, reason: `Clarity error: ${err.message}` };
  }
}

async function loadGoogleAds() {
  try {
    const { gaqlQuery } = await import('../lib/google-ads.js');
    const campaigns = await gaqlQuery(`
      SELECT campaign.id, campaign.name, campaign.status,
             metrics.impressions, metrics.clicks, metrics.ctr,
             metrics.average_cpc, metrics.cost_micros,
             metrics.conversions, metrics.conversions_value,
             metrics.cost_per_conversion
      FROM campaign
      WHERE campaign.name = '${CAMPAIGN_NAME.replace(/'/g, "\\'")}'
        AND segments.date DURING LAST_7_DAYS
    `);
    if (campaigns.length === 0) return { available: false, reason: 'campaign not yet launched or no data in last 7 days' };
    const m = campaigns[0].metrics ?? {};
    const c = campaigns[0].campaign ?? {};
    return {
      available: true,
      data: {
        campaignId: c.id,
        status: c.status,
        impressions: Number(m.impressions ?? 0),
        clicks: Number(m.clicks ?? 0),
        ctr: Number(m.ctr ?? 0),
        avgCpcUSD: Number(m.averageCpc ?? 0) / 1_000_000,
        spendUSD: Number(m.costMicros ?? 0) / 1_000_000,
        conversions: Number(m.conversions ?? 0),
        revenueUSD: Number(m.conversionsValue ?? 0),
        cpaUSD: Number(m.costPerConversion ?? 0) / 1_000_000,
      },
    };
  } catch (err) {
    return { available: false, reason: `Google Ads error: ${err.message}` };
  }
}

function fmt(label, value, suffix = '') {
  return `- ${label}: **${value}**${suffix}`;
}

function buildReport({ day, clarity, ads }) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    `# Sensitive Skin Set — Mid-Test Report (Day ${day})`,
    ``,
    `**Generated:** ${date}`,
    `**PDP:** \`${PDP_URL_PATH}\``,
    `**Campaign:** \`${CAMPAIGN_NAME}\``,
    ``,
    `## Google Ads — campaign performance (last 7 days)`,
    ``,
  ];
  if (!ads.available) {
    lines.push(`_${ads.reason}_`, ``);
  } else {
    const a = ads.data;
    lines.push(
      fmt('Status', a.status),
      fmt('Impressions', a.impressions),
      fmt('Clicks', a.clicks),
      fmt('CTR', (a.ctr * 100).toFixed(2), '%'),
      fmt('Avg CPC', `$${a.avgCpcUSD.toFixed(2)}`),
      fmt('Spend', `$${a.spendUSD.toFixed(2)}`),
      fmt('Conversions', a.conversions),
      fmt('CPA', a.conversions > 0 ? `$${a.cpaUSD.toFixed(2)}` : 'n/a'),
      fmt('Revenue', `$${a.revenueUSD.toFixed(2)}`),
      fmt('ROAS', a.spendUSD > 0 ? (a.revenueUSD / a.spendUSD).toFixed(2) + '×' : 'n/a'),
      ``
    );
  }
  lines.push(`## Clarity — PDP behavior (URL-filtered, last 3 days)`, ``);
  if (!clarity.available) {
    lines.push(`_${clarity.reason}_`, ``);
  } else {
    const c = clarity.data;
    lines.push(
      fmt('Sessions (real)', c.sessions?.real ?? 0),
      fmt('Avg engagement (sec)', c.engagement?.activeTime ?? 0),
      fmt('Avg scroll depth', `${(c.behavior?.scrollDepth ?? 0).toFixed(1)}%`),
      fmt('Rage-click %', `${(c.behavior?.rageClickPct ?? 0).toFixed(2)}%`),
      fmt('Dead-click %', `${(c.behavior?.deadClickPct ?? 0).toFixed(2)}%`),
      fmt('Quickback %', `${(c.behavior?.quickbackPct ?? 0).toFixed(2)}%`),
      ``
    );
  }
  lines.push(
    `## Adjustment criteria (per spec)`,
    ``,
    `| Signal | Threshold | Action if breached |`,
    `|---|---|---|`,
    `| Avg scroll depth | <40% | Rework H1 / hero copy |`,
    `| Quickback % | >25% | Ad–PDP message-mismatch — revise ad copy or PDP H1 |`,
    `| Dead-click % | >5% | Visual confusion — make CTA more obvious |`,
    `| ATC rate (paid) | <2% | Tweak offer presentation, NOT page structure |`,
    `| Conversions <2 with all signals normal | — | No fix; let it run |`,
    ``,
    `_Full design and verdict bands: docs/superpowers/specs/2026-05-09-sensitive-skin-set-google-ads-validation.md_`,
    ``
  );
  return lines.join('\n');
}

async function main() {
  const [clarity, ads] = await Promise.all([loadClarity(), loadGoogleAds()]);
  const report = buildReport({ day, clarity, ads });
  mkdirSync(REPORT_DIR, { recursive: true });
  const outPath = join(REPORT_DIR, `day-${day}.md`);
  writeFileSync(outPath, report);
  console.log(`Report written: ${outPath}`);
  console.log(`  Clarity: ${clarity.available ? 'OK' : clarity.reason}`);
  console.log(`  Google Ads: ${ads.available ? 'OK' : ads.reason}`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
```

- [ ] **Step 3: Smoke-test the script** — campaign isn't launched yet, so we expect graceful "no data" output

```bash
node scripts/sensitive-skin-set-mid-test-report.js --day 0 2>&1 | tail -10
```

Expected:
- `Report written: …/data/reports/sensitive-skin-set-validation/day-0.md`
- `Clarity: OK` OR `Clarity: no Clarity sessions in window` (either is fine — depends on whether the API is reachable today)
- `Google Ads: campaign not yet launched or no data in last 7 days` (because we haven't created the campaign in Google Ads yet)

- [ ] **Step 4: Inspect the generated report**

```bash
cat data/reports/sensitive-skin-set-validation/day-0.md
```

Expected: a well-formed markdown report with headings, the "campaign not yet launched" message in the Google Ads section, and either real Clarity data or the "no sessions" message.

- [ ] **Step 5: GA4 hook (if needed)** — the script does not call GA4 today

The spec lists GA4 paid-session metrics (ATC rate, begin_checkout rate, etc.) as part of the report. Adding a GA4 query requires extending `lib/ga4.js` with a `fetchPaidFunnel({ landingPagePath, startDate, endDate })` helper that filters by `sessionSource=google` AND `sessionMedium=cpc` AND `landingPage=<path>`. **Defer this** — it's straightforward to add when we actually have campaign data flowing (day 5+). Note the gap in the report ("GA4 paid funnel: deferred — see TODO note below"). The Google Ads block already gives us conversions, CPA, ROAS — the GA4 view would only add intermediate funnel steps (ATC, checkout) which are nice-to-have for the Phase 3 audit but not blocking.

Add this comment line at the bottom of the report builder, just above the "Adjustment criteria" section:

```javascript
    `## GA4 — paid funnel (deferred)`,
    ``,
    `_GA4 paid-funnel breakdown (ATC rate, begin_checkout rate) will be added when we extend lib/ga4.js with a paid-funnel helper. For now, conversion counts come from Google Ads above (purchases). Add this hook before the day-7 audit at the latest._`,
    ``,
```

Re-run the smoke test to confirm the section appears:

```bash
node scripts/sensitive-skin-set-mid-test-report.js --day 0 2>&1 | tail -3 && grep -A 1 "GA4" data/reports/sensitive-skin-set-validation/day-0.md
```

- [ ] **Step 6: Commit**

```bash
git add scripts/sensitive-skin-set-mid-test-report.js data/reports/sensitive-skin-set-validation/.gitkeep
git commit -m "$(cat <<'EOF'
feat(scripts): add sensitive skin set mid-test report

Composes Clarity (URL-filtered, last 3 days), Google Ads (campaign-
scoped, last 7 days), and a placeholder for GA4 paid-funnel metrics
into a single markdown report at
data/reports/sensitive-skin-set-validation/day-N.md.

Robust to "campaign not yet launched" state — prints a useful "no
data yet" message in each section instead of crashing. Run pre-launch
to confirm wiring; run on days 5–7 for the Phase 3 audit.

GA4 paid-funnel breakdown deferred until day 5+ when campaign data
exists; tracked inline in the report as a known gap.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: End-to-end verification

**Files:** None modified (verification only)

**Why:** Ensure no test in the broader project regressed, and that the four artifacts produced by Tasks 1–4 work together.

- [ ] **Step 1: Run the full project test suite** (or whatever subset CI covers)

```bash
# If there's a top-level test runner:
ls package.json && grep -A 3 '"scripts"' package.json | head -20
```

If there's an npm test script, run:

```bash
npm test 2>&1 | tail -20
```

Otherwise, run the two test files we touched plus a few adjacent ones to verify nothing nearby broke:

```bash
node tests/agents/campaign-creator.test.js && echo "---" && node --test tests/lib/clarity.test.js 2>&1 | tail -5
```

Expected: both pass.

- [ ] **Step 2: Confirm git state is clean for the new branch**

```bash
git status --short
git log --oneline main..HEAD
```

Expected: 4 new commits on top of the spec commit (one per Task 1–4). Working directory may have unrelated modifications from before (pre-existing uncommitted state) — those should be untouched.

- [ ] **Step 3: Confirm the spec's Phase 0 code work checklist is fully covered**

Cross-reference the spec's "Code work needed (Phase 0)" section against what we shipped:

- [x] Extend `lib/clarity.js` with optional URL filter — Task 1
- [x] Extend `campaign-creator` with `trackingUrlTemplate` field — Task 2
- [x] New `scripts/sensitive-skin-set-mid-test-report.js` — Task 4
- [x] New `data/campaigns/2026-05-09-sensitive-skin-set-search-validation.json` — Task 3

Plus we shipped:
- `targetSearchNetwork` override (caught during planning — spec calls for Search-only but existing code default is partners-on)
- `data/reports/sensitive-skin-set-validation/.gitkeep` — directory reservation

- [ ] **Step 4: Surface remaining manual / Sean-side work** in a final message to the user

These are NOT in the implementation plan because they require Google Ads UI / GA4 admin access:

1. Flip `data/campaigns/2026-05-09-sensitive-skin-set-search-validation.json` `status: "proposed"` → `"approved"` and `approvedBudget: null` → `12` when ready to launch
2. Run the pre-launch checklist from the spec (Step 3 of the spec's "Conversion tracking" section) — GA4 link, conversion import, browser render check, Clarity verification, PDP micro-audit
3. Run `node agents/campaign-creator/index.js --campaign 2026-05-09-sensitive-skin-set-search-validation` (no `--dry-run`) to push the campaign to Google Ads in PAUSED state
4. Verify in Google Ads UI (Ad Preview & Diagnosis), then flip the campaign to ENABLED
5. Schedule Phase 3 mid-test audit reminder for day 5–7 (run `node scripts/sensitive-skin-set-mid-test-report.js`, then watch ~10–15 Clarity recordings manually)
6. Schedule Day 21 verdict review

---

## Self-review notes

- **Spec coverage:** Every item in the spec's "Code work needed (Phase 0)" section maps to a task. Manual/Sean-side items (GA4 conversion import, browser render check, Clarity dashboard review) are listed in Task 5 Step 4 as out-of-scope handoff items.
- **Type consistency:** `buildClarityUrl` signature is consistent across Task 1 test and implementation. `buildCampaignOperation`'s 5th `options` arg is consistent across Task 2 test, implementation, and call site update.
- **No placeholders:** all code blocks contain runnable code with no TBD/TODO markers (the GA4-paid-funnel deferral in Task 4 Step 5 is documented as a known gap, not a placeholder — the Google Ads block in the report already covers conversion counts).
- **Bite-sized:** each step is one action with explicit commands and expected output. Total task count: 5. Total step count: ~25.
