# Google Ads Optimizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a daily AI feedback loop that analyzes Google Ads + GSC + GA4 + Ahrefs + Shopify data and surfaces keyword/copy suggestions with a dashboard approval queue and email alerts.

**Architecture:** `ads-optimizer` agent loads all data sources, calls Claude for structured JSON suggestions, saves to `data/ads-optimizer/YYYY-MM-DD.json`, and sends an alert email if suggestions exist. The dashboard Ads tab shows an approval queue with editable copy fields. `apply-ads-changes` reads approved suggestions and mutates Google Ads via the existing `lib/google-ads.js` client.

**Tech Stack:** Node.js ESM, Google Ads API v18 (`lib/google-ads.js`), Anthropic SDK (`claude-opus-4-6`), Ahrefs REST API v3, Resend (`lib/notify.js`), existing dashboard SSE pattern.

---

## Branch setup

This plan builds on the `feature/google-ads-campaign` branch. Before starting:

```bash
git checkout feature/google-ads-campaign
git merge main   # bring in competitor-intelligence and dashboard changes
npm install
```

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `lib/google-ads.js` | Modify | Add resource names to `fetchDailySnapshot` |
| `agents/ads-optimizer/index.js` | Create | Daily analysis → suggestions JSON → alert email |
| `agents/apply-ads-changes/index.js` | Create | Execute approved mutations via Google Ads API |
| `scripts/ads-weekly-recap.js` | Create | Sunday digest email |
| `tests/lib/google-ads.test.js` | Modify | Add resource-name assertions |
| `tests/agents/ads-optimizer.test.js` | Create | Pure function tests |
| `tests/agents/apply-ads-changes.test.js` | Create | Pure function tests |
| `tests/scripts/ads-weekly-recap.test.js` | Create | Pure function tests |
| `agents/dashboard/index.js` | Modify | New routes, optimization card, actions bar, allowlist |
| `scripts/setup-cron.sh` | Modify | Add optimizer + recap cron entries |

---

## Task 1: Add resource names to `fetchDailySnapshot`

The optimizer needs resource names for all entities so the apply agent never has to do a lookup.

**Files:**
- Modify: `lib/google-ads.js`
- Modify: `tests/lib/google-ads.test.js`

- [ ] **Step 1: Add assertions to the existing test**

Add to `tests/lib/google-ads.test.js` after the existing assertions:

```js
// fetchDailySnapshot returns resource-name fields
// (tested structurally — we check the export exists and the query strings)
const src = (await import('fs')).readFileSync('lib/google-ads.js', 'utf8');
assert.ok(src.includes('campaign.resource_name'), 'campaign query must select resource_name');
assert.ok(src.includes('ad_group.resource_name'),  'must query ad group resource names');
assert.ok(src.includes('ad_group_ad.resource_name'), 'must query adGroupAd resource names');
assert.ok(src.includes('ad_group_criterion.resource_name'), 'must query criterion resource names');
assert.ok(src.includes('adGroupAds'), 'snapshot must include adGroupAds array');

console.log('✓ google-ads lib unit tests pass');
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
node tests/lib/google-ads.test.js
```

Expected: fails with "campaign query must select resource_name"

- [ ] **Step 3: Update `fetchDailySnapshot` in `lib/google-ads.js`**

Replace the existing `fetchDailySnapshot` function with:

```js
export async function fetchDailySnapshot(date) {
  const campaignQuery = `
    SELECT
      campaign.resource_name,
      campaign.id,
      campaign.name,
      campaign.status,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.average_cpc,
      metrics.cost_micros,
      metrics.conversions,
      metrics.conversions_value,
      metrics.cost_per_conversion
    FROM campaign
    WHERE segments.date = '${date}'
    ORDER BY metrics.cost_micros DESC
  `;

  const kwQuery = `
    SELECT
      ad_group_criterion.resource_name,
      ad_group_criterion.keyword.text,
      ad_group_criterion.keyword.match_type,
      ad_group_criterion.quality_info.quality_score,
      ad_group.resource_name,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.cost_micros,
      metrics.average_cpc
    FROM keyword_view
    WHERE segments.date = '${date}'
      AND metrics.impressions > 0
    ORDER BY metrics.conversions DESC
    LIMIT 10
  `;

  const adGroupQuery = `
    SELECT
      ad_group.resource_name,
      ad_group.name,
      campaign.resource_name
    FROM ad_group
    WHERE campaign.status = 'ENABLED'
      AND ad_group.status = 'ENABLED'
  `;

  const adGroupAdQuery = `
    SELECT
      ad_group_ad.resource_name,
      ad_group.resource_name,
      ad_group_ad.ad.id,
      ad_group_ad.ad.name
    FROM ad_group_ad
    WHERE ad_group_ad.status = 'ENABLED'
  `;

  const [campaignRows, kwRows, adGroupRows, adGroupAdRows] = await Promise.all([
    gaqlQuery(campaignQuery),
    gaqlQuery(kwQuery),
    gaqlQuery(adGroupQuery),
    gaqlQuery(adGroupAdQuery),
  ]);

  const campaigns = campaignRows.map(r => ({
    resourceName: r.campaign?.resource_name,
    id: r.campaign?.id,
    name: r.campaign?.name,
    status: r.campaign?.status,
    impressions: Number(r.metrics?.impressions || 0),
    clicks: Number(r.metrics?.clicks || 0),
    ctr: Number(r.metrics?.ctr || 0),
    avgCpc: Number(r.metrics?.average_cpc || 0) / 1_000_000,
    spend: Number(r.metrics?.cost_micros || 0) / 1_000_000,
    conversions: Number(r.metrics?.conversions || 0),
    revenue: Number(r.metrics?.conversions_value || 0),
    costPerConversion: Number(r.metrics?.cost_per_conversion || 0) / 1_000_000,
  }));

  const topKeywords = kwRows.map(r => ({
    criterionResourceName: r.ad_group_criterion?.resource_name,
    adGroupResourceName: r.ad_group?.resource_name,
    keyword: r.ad_group_criterion?.keyword?.text,
    matchType: r.ad_group_criterion?.keyword?.match_type,
    qualityScore: r.ad_group_criterion?.quality_info?.quality_score,
    impressions: Number(r.metrics?.impressions || 0),
    clicks: Number(r.metrics?.clicks || 0),
    conversions: Number(r.metrics?.conversions || 0),
    spend: Number(r.metrics?.cost_micros || 0) / 1_000_000,
    avgCpc: Number(r.metrics?.average_cpc || 0) / 1_000_000,
  }));

  const adGroups = adGroupRows.map(r => ({
    resourceName: r.ad_group?.resource_name,
    name: r.ad_group?.name,
    campaignResourceName: r.campaign?.resource_name,
  }));

  const adGroupAds = adGroupAdRows.map(r => ({
    resourceName: r.ad_group_ad?.resource_name,
    adGroupResourceName: r.ad_group?.resource_name,
    adId: r.ad_group_ad?.ad?.id,
  }));

  const totalSpend = campaigns.reduce((s, c) => s + c.spend, 0);
  const totalClicks = campaigns.reduce((s, c) => s + c.clicks, 0);
  const totalImpressions = campaigns.reduce((s, c) => s + c.impressions, 0);
  const totalConversions = campaigns.reduce((s, c) => s + c.conversions, 0);
  const totalRevenue = campaigns.reduce((s, c) => s + c.revenue, 0);

  return {
    date,
    spend: Math.round(totalSpend * 100) / 100,
    impressions: totalImpressions,
    clicks: totalClicks,
    ctr: totalImpressions > 0 ? Math.round(totalClicks / totalImpressions * 10000) / 10000 : 0,
    avgCpc: totalClicks > 0 ? Math.round((totalSpend / totalClicks) * 100) / 100 : 0,
    conversions: totalConversions,
    conversionRate: totalClicks > 0 ? Math.round(totalConversions / totalClicks * 10000) / 10000 : 0,
    costPerConversion: totalConversions > 0 ? Math.round((totalSpend / totalConversions) * 100) / 100 : 0,
    roas: totalSpend > 0 ? Math.round(totalRevenue / totalSpend * 100) / 100 : 0,
    revenue: Math.round(totalRevenue * 100) / 100,
    campaigns,
    topKeywords,
    adGroups,
    adGroupAds,
  };
}
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
node tests/lib/google-ads.test.js
```

Expected: `✓ google-ads lib unit tests pass`

- [ ] **Step 5: Commit**

```bash
git add lib/google-ads.js tests/lib/google-ads.test.js
git commit -m "feat: add resource names to google-ads fetchDailySnapshot"
```

---

## Task 2: ads-optimizer pure functions + tests

**Files:**
- Create: `agents/ads-optimizer/index.js` (pure exports only — no `main()` yet)
- Create: `tests/agents/ads-optimizer.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/agents/ads-optimizer.test.js`:

```js
import { strict as assert } from 'node:assert';
import {
  suggestionFilePath,
  buildAlertEmailBody,
  parseSuggestionsResponse,
} from '../agents/ads-optimizer/index.js';

// suggestionFilePath
assert.equal(
  suggestionFilePath('2026-03-20', '/root/project'),
  '/root/project/data/ads-optimizer/2026-03-20.json'
);

// buildAlertEmailBody — includes spend, suggestion count, dashboard URL
const snap = { spend: 9.12, clicks: 16, conversions: 1, roas: 1.84 };
const suggestions = [
  { id: 's-001', type: 'keyword_pause', confidence: 'high', target: 'coconut oil lotion', rationale: 'Test reason.' },
  { id: 's-002', type: 'copy_rewrite', confidence: 'medium', target: 'Headline 4', adGroup: 'Natural Body Lotion', rationale: 'GSC signal.' },
];
const body = buildAlertEmailBody(snap, suggestions, 'http://localhost:4242');
assert.ok(body.includes('$9.12'), 'body must include spend');
assert.ok(body.includes('2 suggestions'), 'body must include count');
assert.ok(body.includes('localhost:4242'), 'body must include dashboard URL');
assert.ok(body.includes('[HIGH]'), 'body must include confidence badge');
assert.ok(body.includes('coconut oil lotion'), 'body must include target');

// parseSuggestionsResponse — valid JSON string
const raw = JSON.stringify({
  analysisNotes: 'Account healthy.',
  suggestions: [{ id: 's-001', type: 'keyword_pause', status: 'pending', confidence: 'high', adGroup: 'Coconut Lotion', target: 'foo', rationale: 'bar', proposedChange: { criterionResourceName: 'c/123' } }],
});
const parsed = parseSuggestionsResponse(raw);
assert.equal(parsed.analysisNotes, 'Account healthy.');
assert.equal(parsed.suggestions.length, 1);
assert.equal(parsed.suggestions[0].status, 'pending');

// parseSuggestionsResponse — Claude wraps in markdown code block
const wrapped = '```json\n' + raw + '\n```';
const parsed2 = parseSuggestionsResponse(wrapped);
assert.equal(parsed2.suggestions.length, 1);

// parseSuggestionsResponse — invalid JSON throws
assert.throws(() => parseSuggestionsResponse('not json'), /JSON/);

console.log('✓ ads-optimizer pure function tests pass');
```

- [ ] **Step 2: Run to confirm failure**

```bash
node tests/agents/ads-optimizer.test.js
```

Expected: fails with "Cannot find module"

- [ ] **Step 3: Create `agents/ads-optimizer/index.js` with pure exports**

```js
// agents/ads-optimizer/index.js
/**
 * Google Ads Optimizer Agent
 *
 * Loads Google Ads snapshot + GSC + GA4 + Shopify + Ahrefs data, runs
 * Claude analysis, saves suggestions to data/ads-optimizer/YYYY-MM-DD.json,
 * and sends an alert email if suggestions exist.
 *
 * Usage:
 *   node agents/ads-optimizer/index.js
 *   node agents/ads-optimizer/index.js --date 2026-03-19
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..', '..');

// ── Pure exports (tested) ──────────────────────────────────────────────────────

export function suggestionFilePath(date, rootDir) {
  return join(rootDir, 'data', 'ads-optimizer', `${date}.json`);
}

export function buildAlertEmailBody(snap, suggestions, dashboardUrl) {
  const lines = [
    `Yesterday: $${snap.spend.toFixed(2)} spend · ${snap.clicks} clicks · ${snap.conversions} conv · ${snap.roas.toFixed(2)}x ROAS`,
    '',
    `${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'}:`,
  ];
  for (const s of suggestions) {
    const badge = s.confidence === 'high' ? 'HIGH' : s.confidence === 'medium' ? 'MED' : 'LOW';
    const label = s.type === 'copy_rewrite'
      ? `Rewrite ${s.target}${s.adGroup ? ', ' + s.adGroup : ''}`
      : s.type === 'keyword_pause'
      ? `Pause "${s.target}"`
      : s.type === 'keyword_add'
      ? `Add keyword "${s.target}"`
      : `Add negative "${s.target}"`;
    lines.push(`• [${badge}] ${label} — ${s.rationale}`);
  }
  lines.push('');
  lines.push(`Review and approve: ${dashboardUrl} → Ads tab`);
  return lines.join('\n');
}

export function parseSuggestionsResponse(raw) {
  // Strip markdown code fence if Claude wraps output
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`JSON parse failed: ${e.message}`);
  }
  // Ensure all suggestions have status: 'pending'
  if (Array.isArray(parsed.suggestions)) {
    parsed.suggestions = parsed.suggestions.map(s => ({ ...s, status: s.status || 'pending' }));
  }
  return parsed;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
node tests/agents/ads-optimizer.test.js
```

Expected: `✓ ads-optimizer pure function tests pass`

- [ ] **Step 5: Commit**

```bash
git add agents/ads-optimizer/index.js tests/agents/ads-optimizer.test.js
git commit -m "feat: add ads-optimizer pure functions with tests"
```

---

## Task 3: ads-optimizer main agent

**Files:**
- Modify: `agents/ads-optimizer/index.js` (add `main()` and helpers)

- [ ] **Step 1: Add data-loading helpers and `main()` to `agents/ads-optimizer/index.js`**

Append to the file after the pure exports:

```js
// ── Data loading ───────────────────────────────────────────────────────────────

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

function loadRecentSnapshots(dir, days = 28) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort().reverse()
    .slice(0, days)
    .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

function loadLatestSnapshot(dir) {
  const snaps = loadRecentSnapshots(dir, 1);
  return snaps[0] || null;
}

async function getAhrefsMetrics(keyword, apiKey) {
  const qs = new URLSearchParams({ keywords: keyword, country: 'us', select: 'volume,kd' }).toString();
  const res = await fetch(`https://api.ahrefs.com/v3/keywords-explorer/overview?${qs}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const kw = data.keywords?.[0];
  return kw ? { volume: kw.volume ?? 0, kd: kw.kd ?? 0 } : null;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const env = loadEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
  const ahrefsKey = process.env.AHREFS_API_KEY || env.AHREFS_API_KEY;
  const dashboardUrl = process.env.DASHBOARD_URL || env.DASHBOARD_URL || 'http://localhost:4242';
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY');

  const dateArg = process.argv.find(a => a.startsWith('--date='))?.split('=')[1]
    ?? (process.argv.includes('--date') ? process.argv[process.argv.indexOf('--date') + 1] : null);

  // Default: today's date (analyze yesterday's snapshot)
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const date = dateArg || today;

  console.log('Google Ads Optimizer\n');

  // Load Google Ads snapshot (yesterday's)
  const adsSnap = loadLatestSnapshot(join(ROOT, 'data', 'snapshots', 'google-ads'));
  if (!adsSnap) {
    console.log('No Google Ads snapshot found — run google-ads-collector first.');
    process.exit(0);
  }
  console.log(`  Ads snapshot: ${adsSnap.date} ($${adsSnap.spend} spend, ${adsSnap.clicks} clicks)`);

  // Load other data sources (28 days each)
  const gscSnaps     = loadRecentSnapshots(join(ROOT, 'data', 'snapshots', 'gsc'));
  const ga4Snaps     = loadRecentSnapshots(join(ROOT, 'data', 'snapshots', 'ga4'));
  const shopifySnaps = loadRecentSnapshots(join(ROOT, 'data', 'snapshots', 'shopify'));
  console.log(`  GSC: ${gscSnaps.length} days, GA4: ${ga4Snaps.length} days, Shopify: ${shopifySnaps.length} days`);

  // Build prompt
  const systemPrompt = `You are a Google Ads optimization specialist analyzing data for a small Shopify ecommerce store selling natural skincare products (realskincare.com). You have access to performance data that Google's own suggestion engine cannot see: organic rankings (GSC), real session quality (GA4), and revenue trends (Shopify).

Your job: identify the highest-impact keyword and ad copy changes for this account. Be conservative — only suggest changes with strong evidence. Never suggest changes that increase spend without a clear ROAS improvement case.

Suggestion types allowed:
- keyword_pause: pause a keyword (requires ≥100 impressions OR ≥10 clicks with 0 conversions, OR CPA > $25 after 3+ conversions)
- keyword_add: add a keyword (must have GSC evidence of organic impressions and not already rank top-3 organically)
- negative_add: add a campaign-level negative keyword (must have clear non-buyer intent evidence)
- copy_rewrite: rewrite a specific headline or description (must cite a specific GSC query or GA4 metric)

Return ONLY valid JSON (no markdown, no explanation) matching this schema exactly:
{
  "analysisNotes": "2-3 sentence account health summary with specific numbers",
  "suggestions": [
    {
      "id": "suggestion-001",
      "type": "keyword_pause|keyword_add|negative_add|copy_rewrite",
      "status": "pending",
      "confidence": "high|medium|low",
      "adGroup": "Ad group name or null for campaign-level",
      "target": "keyword text, headline name, or term",
      "rationale": "One sentence citing specific data. Reference the source (GSC, GA4, Ads).",
      "proposedChange": {
        // For keyword_pause: { "criterionResourceName": "..." }
        // For keyword_add: { "keyword": "...", "matchType": "EXACT|PHRASE|BROAD", "adGroupResourceName": "..." }
        // For negative_add: { "keyword": "...", "matchType": "BROAD", "campaignResourceName": "..." }
        // For copy_rewrite: { "field": "headline_N or description_N", "current": "...", "suggested": "...", "adGroupAdResourceName": "..." }
      },
      "editedValue": null
    }
  ]
}

If you have no suggestions with strong evidence, return { "analysisNotes": "...", "suggestions": [] }.`;

  const parts = [
    `Analyze the following Google Ads account data and return optimization suggestions as JSON.`,
    `### Google Ads Snapshot (${adsSnap.date})\n${JSON.stringify(adsSnap, null, 2)}`,
    gscSnaps.length ? `### GSC Data (${gscSnaps.length} days, most recent first)\n${JSON.stringify(gscSnaps, null, 2)}` : '',
    ga4Snaps.length ? `### GA4 Data (${ga4Snaps.length} days, most recent first)\n${JSON.stringify(ga4Snaps, null, 2)}` : '',
    shopifySnaps.length ? `### Shopify Data (${shopifySnaps.length} days, most recent first)\n${JSON.stringify(shopifySnaps, null, 2)}` : '',
  ].filter(Boolean).join('\n\n');

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  process.stdout.write('  Running AI analysis... ');
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: parts }],
  });
  console.log('done');

  const rawText = response.content?.[0]?.text;
  if (!rawText) throw new Error('Claude returned empty response');

  const result = parseSuggestionsResponse(rawText);

  // Enrich keyword_add suggestions with Ahrefs metrics if available
  if (ahrefsKey && result.suggestions.length > 0) {
    for (const s of result.suggestions.filter(s => s.type === 'keyword_add')) {
      const metrics = await getAhrefsMetrics(s.target, ahrefsKey).catch(() => null);
      if (metrics) s.ahrefsMetrics = metrics;
    }
  }

  // Save suggestion file
  const outDir = join(ROOT, 'data', 'ads-optimizer');
  mkdirSync(outDir, { recursive: true });
  const outPath = suggestionFilePath(date, ROOT);
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`  Saved: ${outPath} (${result.suggestions.length} suggestions)`);

  // Send alert email if suggestions exist
  if (result.suggestions.length > 0) {
    const { notify } = await import('../../lib/notify.js');
    const body = buildAlertEmailBody(adsSnap, result.suggestions, dashboardUrl);
    await notify({
      subject: `Google Ads — ${result.suggestions.length} suggestion${result.suggestions.length === 1 ? '' : 's'} ready for review`,
      body,
      status: 'info',
    });
    console.log('  Alert email sent.');
  } else {
    console.log('  No suggestions — no email sent.');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('Error:', e.message); process.exit(1); });
}
```

- [ ] **Step 2: Verify tests still pass**

```bash
node tests/agents/ads-optimizer.test.js
```

Expected: `✓ ads-optimizer pure function tests pass`

- [ ] **Step 3: Commit**

```bash
git add agents/ads-optimizer/index.js
git commit -m "feat: add ads-optimizer main agent"
```

---

## Task 4: apply-ads-changes pure functions + tests

**Files:**
- Create: `agents/apply-ads-changes/index.js` (pure exports only)
- Create: `tests/agents/apply-ads-changes.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/agents/apply-ads-changes.test.js`:

```js
import { strict as assert } from 'node:assert';
import {
  filterApprovedSuggestions,
  resolveEditValue,
  buildMutateOperation,
  parseDoneLine,
} from '../agents/apply-ads-changes/index.js';

// filterApprovedSuggestions
const data = {
  suggestions: [
    { id: 's-001', status: 'approved', type: 'keyword_pause', proposedChange: { criterionResourceName: 'c/1' } },
    { id: 's-002', status: 'pending', type: 'keyword_add', proposedChange: {} },
    { id: 's-003', status: 'rejected', type: 'negative_add', proposedChange: {} },
    { id: 's-004', status: 'approved', type: 'negative_add', proposedChange: { keyword: 'recipe', matchType: 'BROAD', campaignResourceName: 'c/2' } },
  ],
};
const approved = filterApprovedSuggestions(data);
assert.equal(approved.length, 2);
assert.equal(approved[0].id, 's-001');

// filterApprovedSuggestions — handles missing suggestions array
assert.deepEqual(filterApprovedSuggestions({}), []);

// resolveEditValue — returns editedValue if non-empty string
assert.equal(resolveEditValue({ editedValue: 'My Edit', proposedChange: { suggested: 'Original' } }), 'My Edit');
// returns suggested if editedValue is null
assert.equal(resolveEditValue({ editedValue: null, proposedChange: { suggested: 'Original' } }), 'Original');
// returns suggested if editedValue is empty string
assert.equal(resolveEditValue({ editedValue: '', proposedChange: { suggested: 'Original' } }), 'Original');

// buildMutateOperation — keyword_pause
const pauseOp = buildMutateOperation({
  type: 'keyword_pause',
  proposedChange: { criterionResourceName: 'customers/123/adGroupCriteria/1~2' },
});
assert.deepEqual(pauseOp, {
  adGroupCriterionOperation: {
    update: { resourceName: 'customers/123/adGroupCriteria/1~2', status: 'PAUSED' },
    updateMask: 'status',
  },
});

// buildMutateOperation — keyword_add
const addOp = buildMutateOperation({
  type: 'keyword_add',
  proposedChange: {
    keyword: 'natural lotion',
    matchType: 'EXACT',
    adGroupResourceName: 'customers/123/adGroups/456',
  },
});
assert.deepEqual(addOp, {
  adGroupCriterionOperation: {
    create: {
      adGroup: 'customers/123/adGroups/456',
      keyword: { text: 'natural lotion', matchType: 'EXACT' },
      status: 'ENABLED',
    },
  },
});

// buildMutateOperation — negative_add
const negOp = buildMutateOperation({
  type: 'negative_add',
  proposedChange: {
    keyword: 'recipe',
    matchType: 'BROAD',
    campaignResourceName: 'customers/123/campaigns/789',
  },
});
assert.deepEqual(negOp, {
  campaignCriterionOperation: {
    create: {
      campaign: 'customers/123/campaigns/789',
      keyword: { text: 'recipe', matchType: 'BROAD' },
      negative: true,
    },
  },
});

// buildMutateOperation — unknown type throws
assert.throws(() => buildMutateOperation({ type: 'unknown', proposedChange: {} }), /Unknown/);

// parseDoneLine
assert.deepEqual(parseDoneLine('DONE {"applied":3,"failed":1}'), { applied: 3, failed: 1 });
assert.equal(parseDoneLine('Some other line'), null);
assert.equal(parseDoneLine('DONE invalid-json'), null);

console.log('✓ apply-ads-changes pure function tests pass');
```

- [ ] **Step 2: Run to confirm failure**

```bash
node tests/agents/apply-ads-changes.test.js
```

Expected: fails with "Cannot find module"

- [ ] **Step 3: Create `agents/apply-ads-changes/index.js` with pure exports**

```js
// agents/apply-ads-changes/index.js
/**
 * Apply Ads Changes Agent
 *
 * Reads today's suggestion file, applies approved changes to Google Ads
 * via the Mutate API, and updates suggestion statuses.
 *
 * stdout protocol: streams progress lines, final line is:
 *   DONE {"applied":N,"failed":N}
 *
 * Usage: node agents/apply-ads-changes/index.js [--date YYYY-MM-DD]
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// ── Pure exports (tested) ──────────────────────────────────────────────────────

export function filterApprovedSuggestions(data) {
  return (data.suggestions || []).filter(s => s.status === 'approved');
}

export function resolveEditValue(suggestion) {
  const edited = suggestion.editedValue;
  if (edited !== null && edited !== undefined && edited !== '') return edited;
  return suggestion.proposedChange?.suggested ?? '';
}

export function buildMutateOperation(suggestion) {
  const { type, proposedChange: pc } = suggestion;
  switch (type) {
    case 'keyword_pause':
      return {
        adGroupCriterionOperation: {
          update: { resourceName: pc.criterionResourceName, status: 'PAUSED' },
          updateMask: 'status',
        },
      };
    case 'keyword_add':
      return {
        adGroupCriterionOperation: {
          create: {
            adGroup: pc.adGroupResourceName,
            keyword: { text: pc.keyword, matchType: pc.matchType },
            status: 'ENABLED',
          },
        },
      };
    case 'negative_add':
      return {
        campaignCriterionOperation: {
          create: {
            campaign: pc.campaignResourceName,
            keyword: { text: pc.keyword, matchType: pc.matchType },
            negative: true,
          },
        },
      };
    case 'copy_rewrite':
      // copy_rewrite requires a GAQL fetch of current headlines before mutating.
      // This is handled in applyCopyRewrite() below — not a pure buildMutateOperation call.
      throw new Error('copy_rewrite must be applied via applyCopyRewrite(), not buildMutateOperation()');
    default:
      throw new Error(`Unknown suggestion type: ${type}`);
  }
}

export function parseDoneLine(line) {
  if (!line.startsWith('DONE ')) return null;
  try { return JSON.parse(line.slice(5)); } catch { return null; }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
node tests/agents/apply-ads-changes.test.js
```

Expected: `✓ apply-ads-changes pure function tests pass`

- [ ] **Step 5: Commit**

```bash
git add agents/apply-ads-changes/index.js tests/agents/apply-ads-changes.test.js
git commit -m "feat: add apply-ads-changes pure functions with tests"
```

---

## Task 5: apply-ads-changes main agent

**Files:**
- Modify: `agents/apply-ads-changes/index.js` (add `applyCopyRewrite()` and `main()`)

- [ ] **Step 1: Append to `agents/apply-ads-changes/index.js`**

```js
// ── Copy rewrite helper (requires API call) ────────────────────────────────────

async function applyCopyRewrite(suggestion, mutate, gaqlQuery) {
  const pc = suggestion.proposedChange;
  const newText = resolveEditValue(suggestion);

  // Fetch current RSA headlines
  const adId = pc.adGroupAdResourceName.split('/').pop().split('~')[1];
  const query = `
    SELECT
      ad_group_ad.ad.responsive_search_ad.headlines,
      ad_group_ad.ad.responsive_search_ad.descriptions
    FROM ad_group_ad
    WHERE ad_group_ad.resource_name = '${pc.adGroupAdResourceName}'
  `;
  const rows = await gaqlQuery(query);
  if (!rows.length) throw new Error(`Ad not found: ${pc.adGroupAdResourceName}`);

  const currentAd = rows[0].ad_group_ad?.ad?.responsive_search_ad;
  const headlines = [...(currentAd?.headlines || [])];
  const descriptions = [...(currentAd?.descriptions || [])];

  // Determine field type and index (headline_4 → index 3, description_2 → index 1)
  const field = pc.field; // e.g. "headline_4"
  const match = field.match(/^(headline|description)_(\d+)$/);
  if (!match) throw new Error(`Unknown field format: ${field}`);
  const fieldType = match[1];
  const idx = parseInt(match[2], 10) - 1;

  if (fieldType === 'headline') {
    if (!headlines[idx]) throw new Error(`No headline at index ${idx}`);
    headlines[idx] = { ...headlines[idx], text: newText };
    return mutate([{
      adGroupAdOperation: {
        update: {
          resourceName: pc.adGroupAdResourceName,
          ad: { responsiveSearchAd: { headlines } },
        },
        updateMask: 'ad.responsive_search_ad.headlines',
      },
    }]);
  } else {
    if (!descriptions[idx]) throw new Error(`No description at index ${idx}`);
    descriptions[idx] = { ...descriptions[idx], text: newText };
    return mutate([{
      adGroupAdOperation: {
        update: {
          resourceName: pc.adGroupAdResourceName,
          ad: { responsiveSearchAd: { descriptions } },
        },
        updateMask: 'ad.responsive_search_ad.descriptions',
      },
    }]);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const { mutate, gaqlQuery } = await import('../../lib/google-ads.js');

  const dateArg = process.argv.find(a => a.startsWith('--date='))?.split('=')[1]
    ?? (process.argv.includes('--date') ? process.argv[process.argv.indexOf('--date') + 1] : null);
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const date = dateArg || today;

  const filePath = join(ROOT, 'data', 'ads-optimizer', `${date}.json`);

  if (!existsSync(filePath)) {
    console.log('No suggestion file for today');
    console.log('DONE {"applied":0,"failed":0}'); // always emit DONE — dashboard SSE needs it to fire event:done
    return;
  }

  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  const approved = filterApprovedSuggestions(data);

  if (!approved.length) {
    console.log('No approved suggestions to apply');
    console.log('DONE {"applied":0,"failed":0}'); // always emit DONE — dashboard SSE needs it to fire event:done
    return;
  }

  console.log(`Applying ${approved.length} approved suggestion(s) for ${date}...`);
  let applied = 0, failed = 0;

  for (const s of approved) {
    console.log(`  ${s.id} (${s.type}: ${s.target})...`);
    try {
      if (s.type === 'copy_rewrite') {
        const result = await applyCopyRewrite(s, mutate, gaqlQuery);
        if (result?.partialFailureError) throw new Error(JSON.stringify(result.partialFailureError));
      } else {
        const op = buildMutateOperation(s);
        const result = await mutate([op]);
        if (result?.partialFailureError) throw new Error(JSON.stringify(result.partialFailureError));
      }
      s.status = 'applied';
      applied++;
      console.log(`  ✓ ${s.id} applied`);
    } catch (err) {
      console.log(`  ✗ ${s.id} failed: ${err.message}`);
      // Leave status as 'approved' for retry
      failed++;
    }
  }

  writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`\nDone: ${applied} applied, ${failed} failed`);
  console.log(`DONE {"applied":${applied},"failed":${failed}}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('Error:', e.message); process.exit(1); });
}
```

- [ ] **Step 2: Verify pure function tests still pass**

```bash
node tests/agents/apply-ads-changes.test.js
```

Expected: `✓ apply-ads-changes pure function tests pass`

- [ ] **Step 3: Commit**

```bash
git add agents/apply-ads-changes/index.js
git commit -m "feat: add apply-ads-changes main agent with copy_rewrite support"
```

---

## Task 6: ads-weekly-recap pure functions + main

**Files:**
- Create: `scripts/ads-weekly-recap.js`
- Create: `tests/scripts/ads-weekly-recap.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/scripts/ads-weekly-recap.test.js`:

```js
import { strict as assert } from 'node:assert';
import {
  getWeekWindow,
  aggregateAdSnapshots,
  aggregateAppliedChanges,
  computeDelta,
} from '../scripts/ads-weekly-recap.js';

// getWeekWindow — returns 7 dates ending on the given endDate (Sun–Sat of prior week)
const window = getWeekWindow('2026-03-22'); // Sunday Mar 22 → window is Mar 15–Mar 21
assert.equal(window.length, 7);
assert.equal(window[0], '2026-03-15');
assert.equal(window[6], '2026-03-21');

// aggregateAdSnapshots
const snaps = [
  { spend: 9.10, clicks: 14, conversions: 1, revenue: 22, impressions: 300 },
  { spend: 8.50, clicks: 12, conversions: 0, revenue: 0, impressions: 250 },
];
const totals = aggregateAdSnapshots(snaps);
assert.equal(totals.spend, 17.60);
assert.equal(totals.clicks, 26);
assert.equal(totals.conversions, 1);
assert.equal(totals.revenue, 22);

// aggregateAdSnapshots — empty array
const empty = aggregateAdSnapshots([]);
assert.equal(empty.spend, 0);

// aggregateAppliedChanges — counts applied suggestions across multiple files
const suggestionFiles = [
  { suggestions: [
    { status: 'applied', type: 'keyword_pause' },
    { status: 'applied', type: 'negative_add' },
    { status: 'pending', type: 'copy_rewrite' },
  ]},
  { suggestions: [
    { status: 'applied', type: 'copy_rewrite' },
  ]},
];
const counts = aggregateAppliedChanges(suggestionFiles);
assert.equal(counts.total, 3);
assert.equal(counts.keyword_pause, 1);
assert.equal(counts.negative_add, 1);
assert.equal(counts.copy_rewrite, 1);

// computeDelta — positive and negative
const delta = computeDelta({ spend: 67, conversions: 4, cpa: 16.75 }, { spend: 63, conversions: 3, cpa: 21 });
assert.ok(delta.spend.startsWith('+'), 'spend increased');
assert.equal(delta.conversions, '+1');
assert.ok(delta.cpa.startsWith('-'), 'cpa improved');

// countOrganicOverlap — paid keywords that rank top-3 organically
const { countOrganicOverlap } = await import('../scripts/ads-weekly-recap.js');
const keywords = [{ keyword: 'natural lotion' }, { keyword: 'coconut oil lotion' }, { keyword: 'body butter' }];
const gscQueries = [
  { query: 'natural lotion', position: 2.1 },
  { query: 'coconut oil lotion', position: 8.4 },
  { query: 'body butter', position: 1.0 },
];
assert.equal(countOrganicOverlap(keywords, gscQueries), 2, 'two keywords rank top-3 organically');
assert.equal(countOrganicOverlap(keywords, []), 0, 'no overlap when no GSC data');

console.log('✓ ads-weekly-recap pure function tests pass');
```

- [ ] **Step 2: Run to confirm failure**

```bash
node tests/scripts/ads-weekly-recap.test.js
```

Expected: fails with "Cannot find module"

- [ ] **Step 3: Create `scripts/ads-weekly-recap.js`**

```js
// scripts/ads-weekly-recap.js
/**
 * Google Ads Weekly Recap
 *
 * Aggregates the past 7 days (Sun–Sat ending yesterday) of Google Ads snapshots
 * and ads-optimizer suggestion files, generates a Claude outlook paragraph, and
 * sends a weekly digest email.
 *
 * Usage: node scripts/ads-weekly-recap.js
 * Cron:  7:00 AM PT every Sunday
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Pure exports (tested) ──────────────────────────────────────────────────────

export function getWeekWindow(sundayDate) {
  // Returns 7 dates: Sun through Sat of the prior complete week
  // If today is Sunday 2026-03-22, returns 2026-03-15 through 2026-03-21
  const end = new Date(sundayDate);
  end.setDate(end.getDate() - 1); // Saturday (yesterday)
  const dates = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

export function aggregateAdSnapshots(snaps) {
  const totals = { spend: 0, clicks: 0, conversions: 0, revenue: 0, impressions: 0 };
  for (const s of snaps) {
    totals.spend       += s.spend       || 0;
    totals.clicks      += s.clicks      || 0;
    totals.conversions += s.conversions || 0;
    totals.revenue     += s.revenue     || 0;
    totals.impressions += s.impressions || 0;
  }
  totals.spend = Math.round(totals.spend * 100) / 100;
  totals.cpa = totals.conversions > 0
    ? Math.round(totals.spend / totals.conversions * 100) / 100
    : null;
  totals.roas = totals.spend > 0
    ? Math.round(totals.revenue / totals.spend * 100) / 100
    : null;
  return totals;
}

export function aggregateAppliedChanges(suggestionFiles) {
  const counts = { total: 0, keyword_pause: 0, keyword_add: 0, negative_add: 0, copy_rewrite: 0 };
  for (const file of suggestionFiles) {
    for (const s of (file.suggestions || [])) {
      if (s.status === 'applied') {
        counts.total++;
        if (counts[s.type] !== undefined) counts[s.type]++;
      }
    }
  }
  return counts;
}

export function computeDelta(current, prior) {
  const fmt = (n, decimals = 0) => {
    const rounded = Math.round(n * Math.pow(10, decimals)) / Math.pow(10, decimals);
    return (rounded >= 0 ? '+' : '') + rounded.toFixed(decimals);
  };
  return {
    spend:       fmt(current.spend - prior.spend, 2),
    clicks:      fmt((current.clicks || 0) - (prior.clicks || 0)),
    conversions: fmt((current.conversions || 0) - (prior.conversions || 0)),
    cpa: current.cpa && prior.cpa ? fmt(current.cpa - prior.cpa, 2) : 'n/a',
  };
}

export function countOrganicOverlap(keywords, gscQueries) {
  // Count paid keywords that also appear in GSC with average position ≤ 3
  const topOrganic = new Set(
    gscQueries.filter(q => q.position <= 3).map(q => q.query.toLowerCase())
  );
  return keywords.filter(kw => topOrganic.has((kw.keyword || '').toLowerCase())).length;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

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

function loadFilesForWindow(dir, dates) {
  return dates
    .map(d => join(dir, `${d}.json`))
    .filter(existsSync)
    .map(p => JSON.parse(readFileSync(p, 'utf8')));
}

function topKeyword(snaps) {
  const kwMap = {};
  for (const s of snaps) {
    for (const kw of (s.topKeywords || [])) {
      const key = kw.keyword || 'unknown';
      if (!kwMap[key]) kwMap[key] = { conversions: 0, spend: 0 };
      kwMap[key].conversions += kw.conversions || 0;
      kwMap[key].spend += kw.spend || 0;
    }
  }
  const sorted = Object.entries(kwMap).sort((a, b) => b[1].conversions - a[1].conversions);
  if (!sorted.length) return null;
  const [kw, m] = sorted[0];
  return { keyword: kw, conversions: m.conversions, cpa: m.conversions > 0 ? Math.round(m.spend / m.conversions * 100) / 100 : null };
}

function weakestKeyword(snaps) {
  const kwMap = {};
  for (const s of snaps) {
    for (const kw of (s.topKeywords || [])) {
      const key = kw.keyword || 'unknown';
      if (!kwMap[key]) kwMap[key] = { clicks: 0, conversions: 0 };
      kwMap[key].clicks += kw.clicks || 0;
      kwMap[key].conversions += kw.conversions || 0;
    }
  }
  const candidates = Object.entries(kwMap).filter(([, m]) => m.clicks >= 5);
  if (!candidates.length) return null;
  const sorted = candidates.sort((a, b) => (a[1].conversions / a[1].clicks) - (b[1].conversions / b[1].clicks));
  const [kw, m] = sorted[0];
  return { keyword: kw, clicks: m.clicks, conversions: m.conversions };
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const env = loadEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
  const dashboardUrl = process.env.DASHBOARD_URL || env.DASHBOARD_URL || 'http://localhost:4242';

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const window = getWeekWindow(today);
  const priorWindow = getWeekWindow(window[0]); // week before

  console.log('Google Ads Weekly Recap\n');
  console.log(`  Window: ${window[0]} – ${window[6]}`);

  const adsDir = join(ROOT, 'data', 'snapshots', 'google-ads');
  const gscDir = join(ROOT, 'data', 'snapshots', 'gsc');
  const optDir = join(ROOT, 'data', 'ads-optimizer');

  const currentSnaps = loadFilesForWindow(adsDir, window);
  const priorSnaps   = loadFilesForWindow(adsDir, priorWindow);
  const optFiles     = loadFilesForWindow(optDir, window);
  // Load latest GSC snapshot for organic overlap check
  const gscFiles = loadFilesForWindow(gscDir, window);
  const gscQueries = gscFiles.flatMap(f => f.queries || []);

  if (!currentSnaps.length) {
    console.log('No Google Ads snapshots found for this week — skipping.');
    process.exit(0);
  }

  const current = aggregateAdSnapshots(currentSnaps);
  const prior   = aggregateAdSnapshots(priorSnaps);
  const delta   = computeDelta(current, prior);
  const applied = aggregateAppliedChanges(optFiles);
  const top     = topKeyword(currentSnaps);
  const weak    = weakestKeyword(currentSnaps);
  const allPaidKeywords = currentSnaps.flatMap(s => s.topKeywords || []);
  const organicOverlap = countOrganicOverlap(allPaidKeywords, gscQueries);

  // Get Claude outlook paragraph
  let outlook = '';
  if (apiKey) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey });
    const prompt = `In 2-3 sentences, give a forward-looking assessment for next week based on this Google Ads weekly data.

Current week: $${current.spend} spend, ${current.clicks} clicks, ${current.conversions} conv, ${current.roas ?? 'n/a'}x ROAS, $${current.cpa ?? 'n/a'} CPA
vs prior week: spend ${delta.spend}, conv ${delta.conversions}, CPA ${delta.cpa}
Changes applied: ${applied.total} (${applied.keyword_pause} paused, ${applied.keyword_add} added, ${applied.negative_add} negatives, ${applied.copy_rewrite} copy)

Be concise and specific. Focus on the single most important thing to watch or act on next week.`;
    const r = await client.messages.create({
      model: 'claude-opus-4-6', max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    }).catch(() => null);
    outlook = r?.content?.[0]?.text || '';
  }

  // Build Monday date for subject line
  const mondayDate = new Date(window[1]).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const changesLine = applied.total > 0
    ? `${applied.total} change${applied.total > 1 ? 's' : ''} applied: ${[
        applied.keyword_pause ? `${applied.keyword_pause} paused` : '',
        applied.keyword_add   ? `${applied.keyword_add} added` : '',
        applied.negative_add  ? `${applied.negative_add} negatives` : '',
        applied.copy_rewrite  ? `${applied.copy_rewrite} copy` : '',
      ].filter(Boolean).join(', ')}`
    : 'No changes applied this week';

  const lines = [
    `This week: $${current.spend.toFixed(2)} spend · ${current.clicks} clicks · ${current.conversions} conv · ${current.cpa ? '$' + current.cpa.toFixed(2) + ' CPA' : '—'} · ${current.roas ? current.roas.toFixed(2) + 'x ROAS' : '—'}`,
    `vs last week: spend ${delta.spend} · conv ${delta.conversions} · CPA ${delta.cpa}`,
    '',
    top ? `Top keyword: [${top.keyword}] — ${top.conversions} conv${top.cpa ? ', $' + top.cpa.toFixed(2) + ' CPA' : ''}` : '',
    weak ? `Weakest: [${weak.keyword}] — ${weak.clicks} clicks, ${weak.conversions} conv` : '',
    '',
    changesLine,
    `Organic overlap: ${organicOverlap} paid keyword${organicOverlap !== 1 ? 's' : ''} already ranking top-3 organically`,
    '',
    outlook ? `Next week outlook: ${outlook}` : '',
    '',
    `Full dashboard: ${dashboardUrl} → Paid Search tab`,
  ].filter(l => l !== undefined).join('\n');

  await notify({
    subject: `Google Ads Weekly — w/c ${mondayDate}`,
    body: lines,
    status: 'info',
  });

  console.log('  Weekly recap sent.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error('Error:', e.message); process.exit(1); });
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
node tests/scripts/ads-weekly-recap.test.js
```

Expected: `✓ ads-weekly-recap pure function tests pass`

- [ ] **Step 5: Commit**

```bash
git add scripts/ads-weekly-recap.js tests/scripts/ads-weekly-recap.test.js
git commit -m "feat: add ads-weekly-recap script with pure function tests"
```

---

## Task 7: Dashboard — new routes + constants + allowlist

**Files:**
- Modify: `agents/dashboard/index.js`

Find the `RUN_AGENT_ALLOWLIST` block (around line 75) and the route handlers section (around line 1948+).

- [ ] **Step 1: Add `ADS_OPTIMIZER_DIR` constant**

Find the block of directory constants (near `COMP_BRIEFS_DIR`, `AHREFS_DIR`, etc.) and add:

```js
const ADS_OPTIMIZER_DIR = join(ROOT, 'data', 'ads-optimizer');
```

- [ ] **Step 2: Add two scripts to `RUN_AGENT_ALLOWLIST`**

```js
const RUN_AGENT_ALLOWLIST = new Set([
  // ... existing entries ...
  'agents/ads-optimizer/index.js',
  'scripts/ads-weekly-recap.js',
]);
```

- [ ] **Step 3: Add `POST /ads/:date/suggestion/:id` route**

Add before the `POST /apply/` handler:

```js
if (req.method === 'POST' && req.url.startsWith('/ads/') && req.url.includes('/suggestion/')) {
  // /ads/:date/suggestion/:id
  const parts = req.url.split('/'); // ['', 'ads', date, 'suggestion', id]
  const date = parts[2], id = parts[4];
  if (!date || !id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Missing date or id' })); return; }
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' })); return; }
    const filePath = join(ADS_OPTIMIZER_DIR, `${date}.json`);
    if (!existsSync(filePath)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Suggestion file not found' })); return; }
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    const suggestion = data.suggestions?.find(s => s.id === id);
    if (!suggestion) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Suggestion not found' })); return; }
    if (payload.status !== undefined) {
      if (!['approved', 'rejected'].includes(payload.status)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'status must be approved or rejected' })); return; }
      suggestion.status = payload.status;
    }
    if (payload.editedValue !== undefined) suggestion.editedValue = payload.editedValue;
    writeFileSync(filePath, JSON.stringify(data, null, 2));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, suggestion }));
  });
  return;
}
```

- [ ] **Step 4: Add `POST /apply-ads` route**

Add after the `/ads/suggestion` route:

```js
if (req.method === 'POST' && req.url === '/apply-ads') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const child = spawn('node', [join(ROOT, 'agents', 'apply-ads-changes', 'index.js')], { cwd: ROOT });
  child.stdout.on('data', d => {
    for (const line of String(d).split('\\n').filter(Boolean)) {
      if (line.startsWith('DONE ')) {
        try { res.write(`event: done\\ndata: ${JSON.stringify(JSON.parse(line.slice(5)))}\\n\\n`); }
        catch { res.write(`event: done\\ndata: {}\\n\\n`); }
      } else {
        res.write(`data: ${line}\\n\\n`);
      }
    }
  });
  child.stderr.on('data', d => String(d).split('\\n').filter(Boolean).forEach(l => res.write(`data: [err] ${l}\\n\\n`)));
  child.on('close', () => res.end());
  return;
}
```

**Important:** The `\\n` sequences above are correct — this code is inside the `const HTML` template literal so we need `\\n` to produce literal `\n` in the rendered JavaScript.

- [ ] **Step 5: Verify dashboard starts without errors**

```bash
node agents/dashboard/index.js &
sleep 2 && curl -s http://localhost:4242/api/data | node -e "process.stdin.resume(); process.stdin.on('data', d => { const j = JSON.parse(d); console.log('Dashboard OK, tabs:', Object.keys(j)); })"
pkill -f "node agents/dashboard"
```

Expected: Dashboard starts, API returns data.

- [ ] **Step 6: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add /ads suggestion route, /apply-ads SSE route, ads-optimizer to allowlist"
```

---

## Task 8: Dashboard — Ads tab optimization card

Add the `renderAdsOptimization(d)` function and update `renderAdsTab` to show the optimization queue above campaign metrics.

**Files:**
- Modify: `agents/dashboard/index.js`

- [ ] **Step 1: Add CSS for the optimization card**

Find the existing Ads tab CSS (or add near the end of the `<style>` block) and append:

```css
.ads-opt-card { margin-bottom: 1rem; }
.ads-opt-analysis { color: var(--muted); font-size: 0.85rem; margin-bottom: 1rem; padding: 0.75rem 1rem; background: var(--surface); border-radius: 6px; border: 1px solid var(--border); }
.ads-suggestion { border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem; background: var(--bg); }
.ads-suggestion-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; }
.ads-suggestion-rationale { font-size: 0.85rem; color: var(--fg); margin-bottom: 0.75rem; line-height: 1.5; }
.ads-suggestion-change { font-size: 0.8rem; color: var(--muted); margin-bottom: 0.75rem; }
.ads-suggestion-actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.ads-suggestion-actions button { padding: 0.3rem 0.75rem; border-radius: 5px; border: 1px solid var(--border); cursor: pointer; font-size: 0.82rem; background: var(--surface); }
.btn-ads-approve { background: #d1fae5 !important; border-color: #6ee7b7 !important; color: #065f46 !important; }
.btn-ads-approve:hover { background: #6ee7b7 !important; }
.btn-ads-reject { background: #fee2e2 !important; border-color: #fca5a5 !important; color: #7f1d1d !important; }
.btn-ads-reject:hover { background: #fca5a5 !important; }
.ads-copy-edit { padding: 0.3rem 0.5rem; border: 1px solid var(--indigo); border-radius: 4px; font-size: 0.82rem; width: 260px; }
.ads-char-count { font-size: 0.75rem; color: var(--muted); }
.ads-char-count.over { color: #ef4444; }
.ads-applied-section summary { font-size: 0.8rem; color: var(--muted); cursor: pointer; }
```

- [ ] **Step 2: Add `renderAdsOptimization(d)` function to the client-side script block**

Add after the existing `renderAdsTab` function:

```js
function renderAdsOptimization(d) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const optEl = document.getElementById('ads-opt-body'); // targets card body, keeps card header visible
  if (!optEl) return;

  // Try to load today's suggestion file via the /api/data response
  const opt = (d.adsOptimization) || null;
  if (!opt) {
    optEl.innerHTML = '<div class="ads-opt-analysis">No optimization analysis yet. Run Ads Optimizer to generate suggestions.</div>';
    return;
  }

  const pending  = (opt.suggestions || []).filter(s => s.status === 'pending');
  const approved = (opt.suggestions || []).filter(s => s.status === 'approved');
  const applied  = (opt.suggestions || []).filter(s => s.status === 'applied');
  const rejected = (opt.suggestions || []).filter(s => s.status === 'rejected');

  // Group by type: keywords first, then copy — per spec
  const allPending  = [...pending, ...approved];
  const actionable  = [
    ...allPending.filter(s => s.type !== 'copy_rewrite'),
    ...allPending.filter(s => s.type === 'copy_rewrite'),
  ];

  function confidenceBadge(c) {
    const label = c === 'high' ? 'HIGH' : c === 'medium' ? 'MED' : 'LOW';
    const color = c === 'high' ? '#065f46' : c === 'medium' ? '#92400e' : '#374151';
    const bg    = c === 'high' ? '#d1fae5' : c === 'medium' ? '#fef3c7' : '#f3f4f6';
    return '<span class="badge" style="background:' + bg + ';color:' + color + ';font-size:0.7rem">' + label + '</span>';
  }

  function typeLabel(s) {
    if (s.type === 'keyword_pause') return 'Pause keyword';
    if (s.type === 'keyword_add')   return 'Add keyword';
    if (s.type === 'negative_add')  return 'Add negative';
    if (s.type === 'copy_rewrite')  return 'Rewrite copy';
    return s.type;
  }

  function changeDesc(s) {
    const pc = s.proposedChange || {};
    if (s.type === 'copy_rewrite') return esc(pc.field) + ': &ldquo;' + esc(pc.current) + '&rdquo; &rarr; &ldquo;' + esc(pc.suggested) + '&rdquo;';
    if (s.type === 'keyword_add')  return esc(pc.keyword) + ' [' + esc((pc.matchType || '').toLowerCase()) + ']';
    if (s.type === 'negative_add') return '&minus;' + esc(pc.keyword);
    return esc(s.target);
  }

  function renderSuggestionCard(s) {
    const isApproved = s.status === 'approved';
    const isCopyRewrite = s.type === 'copy_rewrite';
    const maxLen = (s.proposedChange?.field || '').startsWith('headline') ? 30 : 90;
    const currentVal = s.editedValue || s.proposedChange?.suggested || '';

    let copyEditHtml = '';
    if (isCopyRewrite) {
      const count = currentVal.length;
      const over = count > maxLen;
      copyEditHtml =
        '<div style="margin-bottom:0.5rem">' +
        '<input class="ads-copy-edit" id="copy-edit-' + esc(s.id) + '" maxlength="' + maxLen + '" value="' + esc(currentVal) + '" ' +
        'oninput="updateCopyCount(&apos;' + esc(s.id) + '&apos;,' + maxLen + ')" ' +
        'onblur="saveCopyEdit(&apos;' + esc(s.id) + '&apos;,&apos;' + esc(opt.date) + '&apos;)"> ' +
        '<span class="ads-char-count' + (over ? ' over' : '') + '" id="count-' + esc(s.id) + '">' + count + '/' + maxLen + '</span>' +
        '</div>';
    }

    return '<div class="ads-suggestion" id="suggestion-card-' + esc(s.id) + '">' +
      '<div class="ads-suggestion-header">' +
        confidenceBadge(s.confidence) +
        '<strong>' + typeLabel(s) + '</strong>' +
        (s.adGroup ? '<span class="badge-type">' + esc(s.adGroup) + '</span>' : '') +
        (isApproved ? '<span class="badge" style="background:#dbeafe;color:#1e40af;font-size:0.7rem">APPROVED</span>' : '') +
      '</div>' +
      '<div class="ads-suggestion-rationale">' + esc(s.rationale) + '</div>' +
      '<div class="ads-suggestion-change">' + changeDesc(s) + '</div>' +
      copyEditHtml +
      '<div class="ads-suggestion-actions">' +
        '<button class="btn-ads-approve" onclick="adsUpdateSuggestion(&apos;' + esc(opt.date) + '&apos;,&apos;' + esc(s.id) + '&apos;,&apos;approved&apos;)">' +
          (isApproved ? '✓ Approved' : 'Approve') +
        '</button>' +
        '<button class="btn-ads-reject" onclick="adsUpdateSuggestion(&apos;' + esc(opt.date) + '&apos;,&apos;' + esc(s.id) + '&apos;,&apos;rejected&apos;)">Reject</button>' +
      '</div>' +
    '</div>';
  }

  let html = '';
  if (opt.analysisNotes) html += '<div class="ads-opt-analysis">' + esc(opt.analysisNotes) + '</div>';

  if (actionable.length === 0) {
    html += '<p class="empty-state">No pending suggestions. Run Ads Optimizer to generate new analysis.</p>';
  } else {
    html += actionable.map(renderSuggestionCard).join('');
  }

  if (applied.length > 0 || rejected.length > 0) {
    html += '<details class="ads-applied-section"><summary>' + (applied.length + rejected.length) + ' resolved suggestion(s)</summary>' +
      '<div style="margin-top:0.5rem;opacity:0.6">' +
        [...applied, ...rejected].map(s =>
          '<div style="font-size:0.8rem;padding:0.25rem 0">' +
          '<span class="badge" style="background:' + (s.status === 'applied' ? '#d1fae5' : '#fee2e2') + ';font-size:0.7rem">' + s.status.toUpperCase() + '</span> ' +
          esc(s.target) + ' — ' + esc(s.rationale) +
          '</div>'
        ).join('') +
      '</div></details>';
  }

  optEl.innerHTML = html;
}

async function adsUpdateSuggestion(date, id, status) {
  await fetch('/ads/' + date + '/suggestion/' + id, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  loadData();
}

function updateCopyCount(id, maxLen) {
  const input = document.getElementById('copy-edit-' + id);
  const counter = document.getElementById('count-' + id);
  if (!input || !counter) return;
  const count = input.value.length;
  counter.textContent = count + '/' + maxLen;
  counter.className = 'ads-char-count' + (count > maxLen ? ' over' : '');
}

async function saveCopyEdit(id, date) {
  const input = document.getElementById('copy-edit-' + id);
  if (!input) return;
  const maxLen = parseInt(input.getAttribute('maxlength') || '90', 10);
  if (input.value.length > maxLen) return; // hard cap — should not happen with maxlength attr
  await fetch('/ads/' + date + '/suggestion/' + id, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ editedValue: input.value }),
  });
}
```

- [ ] **Step 3: Update `renderAdsTab` to include the optimization section and load `adsOptimization` from data**

In `renderAdsTab`, add at the top before the KPI strip:

```js
renderAdsOptimization(data);
```

And update the Ads tab HTML structure (in the static HTML, inside `<div id="tab-ads">`):

```html
<div id="tab-ads" class="tab-panel">
  <div id="ads-opt-section" class="card ads-opt-card">
    <div class="card-header accent-indigo"><h2>Optimization Queue</h2></div>
    <div class="card-body" id="ads-opt-body"><p class="empty-state">Loading...</p></div>
  </div>
  <div id="ads-kpi-strip"></div>
  <div id="ads-overview-card"></div>
  <div id="ads-keywords-card"></div>
  <pre id="run-log-apply-ads" class="run-log" style="display:none"></pre>
</div><!-- /tab-ads -->
```

The `renderAdsOptimization` function reads `d.adsOptimization`. This data must be added to the server-side `aggregateData()` function so it is included in `GET /api/data`.

**Step 3a: Add `adsOptimization` to `aggregateData()`**

Find the `aggregateData()` function in `agents/dashboard/index.js`. It reads from several directories and returns a single data object. Inside this function, locate the section that builds the return value and add the following before the `return` statement:

```js
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
const adsOptPath = join(ADS_OPTIMIZER_DIR, `${today}.json`);
const adsOptimization = existsSync(adsOptPath)
  ? JSON.parse(readFileSync(adsOptPath, 'utf8'))
  : null;
```

Then add `adsOptimization` to the return object:

```js
return {
  // ... existing fields ...
  adsOptimization,
};
```

- [ ] **Step 4: Verify dashboard compiles and serves**

```bash
node agents/dashboard/index.js &
sleep 2 && curl -s -o /dev/null -w "%{http_code}" http://localhost:4242
pkill -f "node agents/dashboard"
```

Expected: `200`

- [ ] **Step 5: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add ads optimization queue card to dashboard Ads tab"
```

---

## Task 9: Dashboard — tab-actions-ads + Apply Approved button

**Files:**
- Modify: `agents/dashboard/index.js`

- [ ] **Step 1: Add `tab-actions-ads` group to the actions bar HTML**

Find the `<div class="tab-actions-bar">` block and add after `tab-actions-optimize`:

```html
<div class="tab-actions-group" id="tab-actions-ads" style="display:none">
  <button onclick="runAgent('agents/ads-optimizer/index.js')" data-tip="Analyze Ads + GSC + GA4 + Ahrefs and generate optimization suggestions">Run Ads Optimizer</button>
  <button onclick="applyAdsChanges()" data-tip="Execute all approved suggestions via the Google Ads Mutate API">Apply Approved</button>
  <button onclick="runAgent('scripts/ads-weekly-recap.js')" data-tip="Send the weekly recap email now (normally runs automatically Sunday morning)">Send Weekly Recap</button>
</div>
```

- [ ] **Step 2: Add `applyAdsChanges()` client-side function**

Add to the script block near the other apply functions:

```js
async function applyAdsChanges() {
  const logEl = document.getElementById('run-log-apply-ads');
  if (logEl) { logEl.style.display = 'block'; logEl.textContent = ''; }
  const res = await fetch('/apply-ads', { method: 'POST' });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  function read() {
    reader.read().then(({ done, value }) => {
      if (done) { loadData(); return; }
      for (const line of decoder.decode(value).split('\\n')) {
        if (line.startsWith('data: ') && logEl) logEl.textContent += line.slice(6) + '\\n';
      }
      logEl.scrollTop = logEl.scrollHeight;
      read();
    });
  }
  read();
}
```

- [ ] **Step 3: Add 'ads' to the `switchTab` action groups loop**

Find the `switchTab` forEach call:

```js
['seo','cro','optimize'].forEach(function(t) {
```

Change to:

```js
['seo','cro','optimize','ads'].forEach(function(t) {
```

- [ ] **Step 4: Verify all tests pass and dashboard starts**

```bash
npm test 2>/dev/null || node --test tests/**/*.test.js 2>/dev/null || (node tests/lib/google-ads.test.js && node tests/agents/ads-optimizer.test.js && node tests/agents/apply-ads-changes.test.js && node tests/scripts/ads-weekly-recap.test.js && echo 'All tests pass')
```

Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add agents/dashboard/index.js
git commit -m "feat: add tab-actions-ads with Run Optimizer and Apply Approved buttons"
```

---

## Task 10: Cron entries

**Files:**
- Modify: `scripts/setup-cron.sh`

- [ ] **Step 1: Add cron entries**

Find the section where `DAILY_GOOGLE_ADS` is defined in `scripts/setup-cron.sh` and add after it:

```bash
DAILY_ADS_OPTIMIZER='45 6 * * * TZ=America/Los_Angeles cd '"$PROJECT_DIR"' && node agents/ads-optimizer/index.js >> '"$LOG_DIR"'/ads-optimizer.log 2>&1'
WEEKLY_ADS_RECAP='0 7 * * 0 TZ=America/Los_Angeles cd '"$PROJECT_DIR"' && node scripts/ads-weekly-recap.js >> '"$LOG_DIR"'/ads-weekly-recap.log 2>&1'
```

**Note:** `TZ=America/Los_Angeles` in each entry ensures these run at 6:45 AM and 7:00 AM Pacific time year-round, regardless of DST transitions. Alternatively, if `setup-cron.sh` already sets `TZ=America/Los_Angeles` at the top of the crontab (check with `crontab -l | head -5`), you can omit the inline `TZ=` prefix.

Add both variables to the `NEW_CRONTAB` heredoc and add to the printed summary:

```bash
echo "  Daily   06:45 PT — ads-optimizer (alert email if suggestions)"
echo "  Weekly  Sun 07:00 PT — ads-weekly-recap"
```

Also add the log files to `.gitignore`:

```
data/reports/ads-optimizer.log
data/reports/ads-weekly-recap.log
```

- [ ] **Step 2: Commit**

```bash
git add scripts/setup-cron.sh .gitignore
git commit -m "feat: add ads-optimizer and ads-weekly-recap cron entries"
```

---

## Task 11: Run all tests + final verification

- [ ] **Step 1: Run all pure function tests**

```bash
node tests/lib/google-ads.test.js && \
node tests/agents/ads-optimizer.test.js && \
node tests/agents/apply-ads-changes.test.js && \
node tests/scripts/ads-weekly-recap.test.js && \
echo 'All tests pass'
```

Expected: All pass.

- [ ] **Step 2: Dry-run apply-ads-changes — file-not-found edge case**

```bash
node agents/apply-ads-changes/index.js --date 1900-01-01
```

Expected output:
```
No suggestion file for today
DONE {"applied":0,"failed":0}
```

- [ ] **Step 3: Dry-run apply-ads-changes — zero approved edge case**

Create a minimal suggestion file with no approved suggestions and run:

```bash
mkdir -p data/ads-optimizer
echo '{"date":"1900-01-02","suggestions":[{"id":"s-001","type":"keyword_pause","status":"pending","target":"test"}]}' > data/ads-optimizer/1900-01-02.json
node agents/apply-ads-changes/index.js --date 1900-01-02
rm data/ads-optimizer/1900-01-02.json
```

Expected output:
```
No approved suggestions to apply
DONE {"applied":0,"failed":0}
```

- [ ] **Step 4: Dry-run ads-optimizer — no snapshot edge case**

```bash
node agents/ads-optimizer/index.js --date 1900-01-01 2>&1 | head -5
```

Expected: Script starts and either loads no snapshot (logs "No Google Ads snapshot found") or exits with a clear message — it should not crash with an unhandled exception.

- [ ] **Step 5: Start dashboard and verify Ads tab renders**

```bash
node agents/dashboard/index.js --public &
sleep 2
curl -s http://localhost:4242 | grep -c "ads-opt-section"
pkill -f "node agents/dashboard"
```

Expected: `1` (element present in HTML)

- [ ] **Step 6: Final commit**

```bash
git add -A
git status  # verify nothing unexpected
git commit -m "chore: final integration — ads optimizer complete"
```
