import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..', '..');

// ── Pure exports ───────────────────────────────────────────────────────────────

export function campaignFilePath(date, slug, rootDir) {
  return join(rootDir, 'data', 'campaigns', `${date}-${slug}.json`);
}

const FALLBACK_AOV = 29.61; // USD — 90-day AOV from Shopify (orders > $1), as of 2026-03-20

export function computeAov(shopifySnaps) {
  const totalRevenue = shopifySnaps.reduce((s, d) => s + (d.orders?.revenue || 0), 0);
  const totalOrders  = shopifySnaps.reduce((s, d) => s + (d.orders?.count  || 0), 0);
  return totalOrders > 0 ? totalRevenue / totalOrders : FALLBACK_AOV;
}

export function buildAnalyzerPrompt(context) {
  const { activeSlugs, adsSnaps, gscSnaps, ga4Snaps, shopifySnaps, ahrefsPresent, pastOutcomes } = context;

  const aov = computeAov(shopifySnaps);
  const aovLabel = shopifySnaps.reduce((s, d) => s + (d.orders?.count || 0), 0) > 0
    ? `$${aov.toFixed(2)} (computed from ${shopifySnaps.length} days of Shopify data)`
    : `$${aov.toFixed(2)} (fallback — no real order data yet)`;

  const sections = [
    `## Active/Proposed Campaigns (do not duplicate these)\n${activeSlugs.length ? activeSlugs.join('\n') : 'None yet.'}`,
    `## Average Order Value (use this for revenue projections)\nAOV: ${aovLabel}\nIMPORTANT: Use this AOV when computing projections.monthlyRevenue = monthlyConversions × AOV. Do not invent a different revenue per conversion.`,
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

ROAS REQUIREMENT: Only propose campaigns where projected ROAS (monthlyRevenue ÷ monthlyCost) ≥ 0.85.
The AOV will be provided in the data. Use it to compute monthlyRevenue = monthlyConversions × AOV.
Prioritize niche, high-intent, long-tail keywords with lower CPCs that can clear this threshold.
If no keyword opportunity meets the ROAS minimum, do not force a proposal — output clarificationNeeded instead.

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
      max_tokens: 8192,
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
    if (!isDryRun) {
      writeFileSync(file, JSON.stringify(campaign, null, 2));
      const { notify } = await import('../../lib/notify.js');
      const body = isClarification(result)
        ? `Campaign re-analysis complete. Still needs clarification:\n${result.clarificationNeeded.join('\n')}`
        : `Campaign re-analysis complete. Proposal updated: ${result.proposals?.[0]?.campaignName || campaign.proposal?.campaignName || campaignArg}`;
      await notify({ subject: 'Campaign Analyzer — re-analysis complete', body }).catch(() => {});
    } else console.log('[DRY RUN] Would write:', JSON.stringify(campaign, null, 2).slice(0, 200));
    return;
  }

  // Normal weekly run
  const context = {
    activeSlugs,
    adsSnaps: loadSnaps(ADS_SNAPS_DIR),
    gscSnaps: loadSnaps(GSC_SNAPS_DIR),
    ga4Snaps: loadSnaps(GA4_SNAPS_DIR),
    shopifySnaps: loadSnaps(SHOPIFY_SNAPS_DIR, 90),
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
    max_tokens: 8192,
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

// Only run when invoked directly (not when imported by tests)
const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main().catch(err => { console.error('Error:', err.message); process.exit(1); });
