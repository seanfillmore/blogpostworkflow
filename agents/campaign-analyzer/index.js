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
  const computed = totalOrders > 0 ? totalRevenue / totalOrders : 0;
  return computed > 1 ? computed : FALLBACK_AOV;
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

// ── Proposal reviewer ──────────────────────────────────────────────────────────

const MATH_TOLERANCE = 0.15; // 15% — accounts for rounding in Claude's output

export function mathCheck(p, aov) {
  const proj = p.projections || {};
  const issues = [];

  if (proj.dailyClicks && proj.cvr && proj.monthlyConversions) {
    const expected = proj.dailyClicks * proj.cvr * 30;
    const ratio = proj.monthlyConversions / expected;
    if (ratio < 1 - MATH_TOLERANCE || ratio > 1 + MATH_TOLERANCE) {
      issues.push(`monthlyConversions (${proj.monthlyConversions}) doesn't match dailyClicks × cvr × 30 = ${expected.toFixed(1)}`);
    }
  }

  if (proj.cpc && proj.dailyClicks && proj.monthlyCost) {
    const expected = proj.cpc * proj.dailyClicks * 30;
    const ratio = proj.monthlyCost / expected;
    if (ratio < 1 - MATH_TOLERANCE || ratio > 1 + MATH_TOLERANCE) {
      issues.push(`monthlyCost ($${proj.monthlyCost}) doesn't match cpc × dailyClicks × 30 = $${expected.toFixed(0)}`);
    }
  }

  if (proj.monthlyConversions && proj.monthlyRevenue && aov) {
    const expected = proj.monthlyConversions * aov;
    const ratio = proj.monthlyRevenue / expected;
    if (ratio < 1 - MATH_TOLERANCE || ratio > 1 + MATH_TOLERANCE) {
      issues.push(`monthlyRevenue ($${proj.monthlyRevenue}) doesn't match monthlyConversions × AOV ($${aov.toFixed(2)}) = $${expected.toFixed(2)}`);
    }
  }

  return issues;
}

export async function reviewProposal(p, aov, client) {
  const proj = p.projections || {};

  // Layer 1: math consistency (free)
  const mathIssues = mathCheck(p, aov);
  if (mathIssues.length > 0) return { approved: false, reasons: mathIssues };

  // Layer 2: Claude narrative vs numbers review
  const reviewPrompt = `Review this Google Ads campaign proposal for consistency between the rationale and the projection numbers.

Campaign: ${p.campaignName}
Rationale: ${p.rationale}

Projections:
- CTR: ${((proj.ctr || 0) * 100).toFixed(1)}%
- CPC: $${proj.cpc}
- CVR: ${((proj.cvr || 0) * 100).toFixed(1)}%
- Daily Clicks: ${proj.dailyClicks}
- Monthly Cost: $${proj.monthlyCost}
- Monthly Conversions: ${proj.monthlyConversions}
- Monthly Revenue: $${proj.monthlyRevenue}
- ROAS: ${proj.monthlyCost > 0 ? (proj.monthlyRevenue / proj.monthlyCost).toFixed(2) : 'n/a'}x

Check:
1. Does the CVR in projections match any CVR range cited in the rationale? Flag if they differ by more than 5 percentage points.
2. Does the CPC match any CPC estimate in the rationale?
3. Are CTR, CPC, and CVR realistic for this keyword type (branded / generic / long-tail)?
4. Any other contradictions between the narrative and the numbers?

Output ONLY valid JSON — no markdown:
{ "approved": true }
OR
{ "approved": false, "reasons": ["specific issue 1", "specific issue 2"] }`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: reviewPrompt }],
  });

  const raw = response.content?.[0]?.text || '';
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  return JSON.parse(cleaned);
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
- rationale (cite specific data points — see RATIONALE REQUIREMENTS below)
- dataPoints (key metrics that informed the proposal)
- projections: { ctr, cpc, cvr, dailyClicks, monthlyCost, monthlyConversions, monthlyRevenue }

ROAS REQUIREMENT: Only propose campaigns where projected ROAS (monthlyRevenue ÷ monthlyCost) ≥ 0.85.
The AOV will be provided in the data. Use it to compute monthlyRevenue = monthlyConversions × AOV.
Prioritize niche, high-intent, long-tail keywords with lower CPCs that can clear this threshold.
If no keyword opportunity meets the ROAS minimum, do not force a proposal — output clarificationNeeded instead.

RATIONALE REQUIREMENTS — the rationale field MUST explicitly address all four of these or the proposal will be rejected:

1. CTR source: State the projected CTR and cite where it comes from — e.g. "GSC shows X% organic CTR on this query" or "industry benchmark for long-tail branded terms is X–Y%". If projecting higher than observed organic CTR, explain why paid would outperform organic.

2. CVR source: State the projected CVR and cite its basis — e.g. "branded search typically converts at X–Y%" or "prior campaign data shows X%". Do not invent a CVR without grounding it in a benchmark or observed signal.

3. AOV disclosure: Explicitly state the AOV being used for revenue projections and confirm it matches the value provided in the data section. Example: "Using AOV of $29.61 as provided. Monthly revenue = N conversions × $29.61 = $X."

4. Paused campaign explanation: If any prior campaign for this keyword space is listed as PAUSED or REMOVED, state why it was paused (if inferable from data) and what has changed that makes a new campaign viable now.

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

  const MIN_ROAS = 0.85;
  const allProposals = result.proposals || [];
  const rejected = allProposals.filter(p => {
    const proj = p.projections || {};
    return proj.monthlyCost > 0 && (proj.monthlyRevenue / proj.monthlyCost) < MIN_ROAS;
  });
  if (rejected.length > 0) {
    console.log(`  Filtered ${rejected.length} proposal(s) below ${MIN_ROAS}x ROAS: ${rejected.map(p => p.campaignName).join(', ')}`);
  }
  const proposals = allProposals.filter(p => {
    const proj = p.projections || {};
    if (!proj.monthlyCost) return true; // no cost data, let it through
    return (proj.monthlyRevenue / proj.monthlyCost) >= MIN_ROAS;
  });

  const aov = computeAov(context.shopifySnaps);
  const written = [];
  for (const p of proposals) {
    process.stdout.write(`  Reviewing: ${p.campaignName}... `);
    let review;
    try {
      review = await reviewProposal(p, aov, client);
    } catch (e) {
      console.log(`review error — skipping (${e.message})`);
      continue;
    }
    if (!review.approved) {
      console.log('rejected');
      (review.reasons || []).forEach(r => console.log(`    ✗ ${r}`));
      continue;
    }
    console.log('approved');

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

  const barrierFile = join(CAMPAIGNS_DIR, 'aov-barrier.json');
  if (written.length > 0) {
    // Clear any stale barrier file now that we have viable proposals
    if (existsSync(barrierFile)) { try { const { unlinkSync } = await import('node:fs'); unlinkSync(barrierFile); } catch {} }
    const { notify } = await import('../../lib/notify.js');
    await notify({
      subject: `Campaign Analyzer — ${written.length} new proposal${written.length > 1 ? 's' : ''}`,
      body: `New campaign proposals ready for review:\n${written.map(n => `• ${n}`).join('\n')}\n\nReview at dashboard → Ads tab`,
    }).catch(() => {});
  } else if (allProposals.length > 0) {
    // Proposals were generated but all rejected — write AOV barrier summary
    const breakEvenCpa = aov / MIN_ROAS;
    const barrier = {
      date: today,
      aov,
      minRoas: MIN_ROAS,
      breakEvenCpa: Math.round(breakEvenCpa * 100) / 100,
      breakEvenCpc: {
        at2pctCvr: Math.round(breakEvenCpa * 0.02 * 100) / 100,
        at3pctCvr: Math.round(breakEvenCpa * 0.03 * 100) / 100,
        at5pctCvr: Math.round(breakEvenCpa * 0.05 * 100) / 100,
      },
      proposalsAnalyzed: allProposals.length,
      proposalsSaved: 0,
      message: `All ${allProposals.length} proposals rejected. At $${aov.toFixed(2)} AOV and ${MIN_ROAS}x minimum ROAS, campaigns need CPC ≤ $${(breakEvenCpa * 0.02).toFixed(2)} at 2% CVR or ≤ $${(breakEvenCpa * 0.03).toFixed(2)} at 3% CVR. Most natural skincare keywords cost $0.80–$1.50 CPC. Consider increasing AOV via bundles or upsells.`,
    };
    writeFileSync(barrierFile, JSON.stringify(barrier, null, 2));
    console.log(`  No viable campaigns — AOV barrier written: ${barrierFile}`);
    const { notify } = await import('../../lib/notify.js');
    await notify({
      subject: 'Campaign Analyzer — no viable campaigns',
      body: barrier.message + '\n\nSee dashboard → Ads tab for details.',
    }).catch(() => {});
  }
}

// Only run when invoked directly (not when imported by tests)
const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main().catch(err => { console.error('Error:', err.message); process.exit(1); });
