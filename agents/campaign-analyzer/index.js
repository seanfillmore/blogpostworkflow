/**
 * Campaign Analyzer — weekly Google Ads proposal generator.
 *
 *   node agents/campaign-analyzer/index.js              weekly run (cron: 0 6 * * 0 UTC)
 *   node agents/campaign-analyzer/index.js --dry-run    print proposals, write nothing
 *   node agents/campaign-analyzer/index.js --campaign <id>   re-analyze after a clarification answer
 *
 * Generates proposals with Claude, reviews them (math, MEASURED CVR range, landing
 * page, narrative), filters on ROAS, and when every proposal fails writes
 * data/campaigns/aov-barrier.json for the dashboard Ads tab.
 *
 * THREE DEFECTS FIXED 2026-09-16 — read these before changing the flow.
 *
 * 1. IT HAD NOT RUN SINCE APRIL. Every weekly run died on a 413: the prompt pasted
 *    60 days of raw snapshots and the request body had grown to 52.8 MB, over the
 *    API's 32 MB limit (GSC `queriesByPage` alone ~27 MB). The last proposal on disk
 *    is 2026-04-19, the last barrier 2026-04-25, and NOTHING said so — the crash
 *    path called process.exit(1) with no notify, so the 5 AM digest never saw it.
 *    The prompt is now built from aggregates (./lib/context.js); a crash now puts an
 *    error row in the digest.
 *
 * 2. ITS CVR RANGES WERE BENCHMARKS 4-9x ABOVE MEASURED REALITY, AND ENFORCED. The
 *    reviewer rejected realistic projections and passed fantasy ones; the 2026-03-20
 *    lotion proposal projected 3% CVR -> 0.89x ROAS, went ACTIVE, and delivered
 *    0.23% CVR / 0.19x. The ranges are now MEASURED at run time on clean US shoppable
 *    traffic (./lib/measured-cvr.js), and the run FAILS CLOSED when it cannot measure.
 *
 * 3. THE BARRIER AND THE DASHBOARD QUOTED BREAK-EVEN CPC AT 2%/3%/5% CVR. Break-even
 *    is now computed at the measured commercial CVR and its Wilson bounds, with the
 *    window and sample stated.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, unlinkSync } from 'node:fs';
import { isDirectRun } from '../../lib/is-direct-run.js';
import {
  measureCvr, renderMeasuredCvrSection, breakEvenCpcAtMeasured, CvrMeasurementError, PAGE_TYPE_LABELS, pct,
} from './lib/measured-cvr.js';
import { buildPromptContext } from './lib/context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..', '..');

/**
 * Model IDs. The 413 was masking whether the old pins still worked — they do
 * (claude-opus-4-6 / claude-sonnet-4-6 are still served) — but the fleet's newer
 * agents pin the current generation as a module constant (agents/voice-of-customer,
 * lib/marketing-learner.js, agents/ad-studio), and this agent follows that. Both
 * run adaptive thinking by default, which is why responses are read through
 * responseText(): the first content block can be a thinking block, and the old
 * `content[0].text` read would have returned '' and thrown a JSON parse error.
 */
export const ANALYZER_MODEL = 'claude-opus-5';
export const REVIEW_MODEL = 'claude-sonnet-5';

/** Output budget. Thinking counts against it, so 8192 is no longer enough headroom. */
const ANALYZER_MAX_TOKENS = 16000;
const REVIEW_MAX_TOKENS = 4096;

export const MIN_ROAS = 0.85;

// ── Pure exports ───────────────────────────────────────────────────────────────

export function campaignFilePath(date, slug, rootDir) {
  return join(rootDir, 'data', 'campaigns', `${date}-${slug}.json`);
}

/**
 * USD — trailing-90-day AOV, $56.08 as of 2026-09-15 (scripts/aov-analysis.mjs).
 * Was $29.61 from 2026-03-20. Used only when the Shopify snapshots carry no orders.
 * The store has a structural AOV break around 2025-09; never average across it.
 */
export const FALLBACK_AOV = 56.08;

export function computeAov(shopifySnaps) {
  const totalRevenue = shopifySnaps.reduce((s, d) => s + (d.orders?.revenue || 0), 0);
  const totalOrders  = shopifySnaps.reduce((s, d) => s + (d.orders?.count  || 0), 0);
  const computed = totalOrders > 0 ? totalRevenue / totalOrders : 0;
  return computed > 1 ? computed : FALLBACK_AOV;
}

export function classifyPageType(url) {
  const path = url.replace(/^https?:\/\/[^/]+/, '');
  if (path === '/' || path === '') return 'homepage';
  if (path.includes('/products/')) return 'product';
  if (path.includes('/collections/')) return 'collection';
  if (path.includes('/blogs/') || path.includes('/blog/')) return 'blog';
  if (path.includes('/pages/')) return 'landing';
  return 'landing';
}

export function extractKnownPages(gscSnaps) {
  const pageMap = new Map();
  for (const snap of gscSnaps) {
    for (const p of (snap.topPages || [])) {
      const url = p.page;
      if (!pageMap.has(url)) pageMap.set(url, { clicks: 0, impressions: 0 });
      const entry = pageMap.get(url);
      entry.clicks += p.clicks || 0;
      entry.impressions += p.impressions || 0;
    }
  }
  return Array.from(pageMap.entries())
    .map(([url, stats]) => ({ url, ...stats, type: classifyPageType(url) }))
    .sort((a, b) => b.impressions - a.impressions);
}

/**
 * Known pages listed in the prompt. Every non-blog page is listed — those are the
 * landing pages a campaign should point at, and ranked purely by impressions they
 * fall below the blog posts (on 2026-09-16 the top 80 of 451 were almost all blog).
 * Blog posts are capped. The reviewer still checks against the FULL list.
 */
const PROMPT_BLOG_PAGES = 40;

export function promptKnownPages(knownPages) {
  const blogs = knownPages.filter((p) => p.type === 'blog').slice(0, PROMPT_BLOG_PAGES);
  const others = knownPages.filter((p) => p.type !== 'blog');
  return [...others, ...blogs];
}

export function buildAnalyzerPrompt(context) {
  const { activeSlugs, adsSnaps, gscSnaps, ga4Snaps, shopifySnaps, pastOutcomes, measuredCvr } = context;
  // Fail closed at the prompt too: a prompt without measured ranges would leave
  // the model to reach for industry benchmarks, which is the defect being fixed.
  if (!measuredCvr?.ranges?.commercial) {
    throw new CvrMeasurementError('buildAnalyzerPrompt: no measured CVR — refusing to build a prompt that would fall back to benchmarks');
  }

  const aov = computeAov(shopifySnaps);
  const aovLabel = shopifySnaps.reduce((s, d) => s + (d.orders?.count || 0), 0) > 0
    ? `$${aov.toFixed(2)} (computed from ${shopifySnaps.length} days of Shopify data)`
    : `$${aov.toFixed(2)} (fallback — no order data in the snapshots)`;

  const knownPages = extractKnownPages(gscSnaps);
  const listedPages = promptKnownPages(knownPages);
  const knownPagesText = listedPages.length
    ? listedPages.map(p => `- ${p.url} [${p.type}] (${p.impressions} impressions, ${p.clicks} clicks)`).join('\n')
    : 'No page data available.';

  const summary = buildPromptContext({ adsSnaps, gscSnaps, ga4Snaps, shopifySnaps });
  const json = (o) => JSON.stringify(o);

  const sections = [
    `## Active/Proposed Campaigns (do not duplicate these)\n${activeSlugs.length ? activeSlugs.join('\n') : 'None yet.'}`,
    `## Average Order Value (use this for revenue projections)\nAOV: ${aovLabel}\nIMPORTANT: Use this AOV when computing projections.monthlyRevenue = monthlyConversions × AOV. Do not invent a different revenue per conversion.`,
    renderMeasuredCvrSection(measuredCvr),
    `## Known Site Pages (choose landingPage from this list only)\nPick the most specific page that matches the campaign intent. Prefer product > collection > homepage > blog. Do NOT invent URLs.\n${listedPages.length} of ${knownPages.length} pages with search impressions: every non-blog page, then the top ${PROMPT_BLOG_PAGES} blog posts.\n${knownPagesText}`,
    `## Google Ads (aggregated over ${summary.ads.window.days} days)\n${adsSnaps.length ? json(summary.ads) : 'No Google Ads snapshots available.'}`,
    `## Google Search Console (aggregated over ${summary.gsc.window.days} days; queries summed, position impression-weighted)\n${gscSnaps.length ? json(summary.gsc) : 'No GSC snapshots available.'}`,
    `## Google Analytics 4 (aggregated over ${summary.ga4.window.days} days)\n${ga4Snaps.length ? json(summary.ga4) : 'No GA4 snapshots available.'}`,
    `## Shopify (aggregated over ${summary.shopify.window.days} days)\n${shopifySnaps.length ? json(summary.shopify) : 'No Shopify snapshots available.'}`,
    `## Keyword Data\nKeyword metrics available via DataForSEO API.`,
    `## Past Campaign Outcomes\n${pastOutcomes.length ? json(pastOutcomes) : 'No past campaign data.'}`,
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

/**
 * The text of a Messages API response. Current models think by default, so the
 * text block is not necessarily content[0]. Truncated or refused output throws:
 * half a JSON proposal is not a proposal.
 */
export function responseText(response) {
  if (response?.stop_reason === 'max_tokens') {
    throw new Error('model output truncated (stop_reason: max_tokens) — refusing to parse a partial response');
  }
  if (response?.stop_reason === 'refusal') {
    throw new Error('model refused the request (stop_reason: refusal)');
  }
  const text = (response?.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('');
  if (!text.trim()) throw new Error('model response carried no text block');
  return text;
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

  // Ad copy character limits
  for (const ag of (p.proposal?.adGroups || [])) {
    for (const h of (ag.headlines || [])) {
      if (h.length > 30) issues.push(`Headline too long (${h.length} chars, max 30): "${h}"`);
    }
    for (const d of (ag.descriptions || [])) {
      if (d.length > 90) issues.push(`Description too long (${d.length} chars, max 90): "${d.slice(0, 40)}…"`);
    }
  }

  return issues;
}

/**
 * BRAND SEARCH IS EXEMPT FROM THE MEASURED RANGE, AND ITS 8-15% IS UNMEASURED.
 * It is an INDUSTRY BENCHMARK, not data from this store. Branded clicks land on the
 * homepage and PDPs, so the landing-page ladder cannot isolate them from every other
 * visitor to those pages — there is no measurement to hold them to. Do not quote
 * 8% as evidence of anything, and do not extend the exemption to another campaign
 * type on the strength of it.
 */
export function isBrandSearch(p) {
  return /brand/i.test(p?.campaignName || p?.slug || '');
}

/**
 * One reason this proposal's projected CVR is not supported by measurement, or
 * null. Fails CLOSED: no ranges, no range for the page type, or no projected CVR
 * is a rejection, never a pass.
 */
export function cvrRangeIssue(p, cvrRanges) {
  if (isBrandSearch(p)) return null;
  const landingPage = p?.landingPage || '';
  const pageType = classifyPageType(landingPage);
  const label = PAGE_TYPE_LABELS[pageType] || pageType;
  const range = cvrRanges?.byPageType?.[pageType];
  if (!range) {
    return `No measured CVR range for a ${label} — cannot check the projection, so it is rejected. Landing page: ${landingPage}`;
  }
  const cvr = p?.projections?.cvr;
  if (cvr == null || !Number.isFinite(Number(cvr))) {
    return `Proposal has no projections.cvr to check against the measured ${label} range. Landing page: ${landingPage}`;
  }
  if (cvr < range.min || cvr > range.max) {
    return `CVR of ${pct(cvr)} is outside the MEASURED range for a ${label} (${pct(range.min)}–${pct(range.max)}, ` +
      `${range.orders} orders / ${range.sessions} sessions${range.source === 'segment' ? '' : ', pooled'}). Landing page: ${landingPage}`;
  }
  return null;
}

export async function reviewProposal(p, aov, client, knownPages = [], cvrRanges = null) {
  const proj = p.projections || {};

  // Layer 1: math consistency (free)
  const mathIssues = mathCheck(p, aov);
  if (mathIssues.length > 0) return { approved: false, reasons: mathIssues };

  // Layer 1b: landing page + MEASURED CVR range (free)
  const landingPage = p.landingPage || '';
  const landingIssues = [];
  const pageType = classifyPageType(landingPage);
  const rangeIssue = cvrRangeIssue(p, cvrRanges);
  if (rangeIssue) landingIssues.push(rangeIssue);
  if (knownPages.length > 0) {
    const knownUrls = new Set(knownPages.map(p => p.url));
    // Normalize: strip trailing slash for comparison
    const normalize = u => u.replace(/\/$/, '');
    const fullUrl = landingPage.startsWith('http') ? landingPage : `https://www.realskincare.com${landingPage}`;
    if (!knownUrls.has(normalize(fullUrl)) && !knownUrls.has(normalize(fullUrl) + '/') && landingPage !== '/') {
      landingIssues.push(`Landing page "${landingPage}" was not found in GSC data — may not exist or have no search presence`);
    }
  }
  if (landingIssues.length > 0) return { approved: false, reasons: landingIssues };

  // Layer 2: Claude narrative vs numbers review
  const knownPagesContext = knownPages.length
    ? `\nKnown site pages (from GSC): ${knownPages.slice(0, 20).map(p => p.url).join(', ')}`
    : '';
  const range = cvrRanges?.byPageType?.[pageType];
  const measuredContext = isBrandSearch(p)
    ? ''
    : `\nMEASURED CVR for a ${PAGE_TYPE_LABELS[pageType]} on this store: ${pct(range.point)} (${range.orders} orders / ${range.sessions} sessions), 95% range ${pct(range.min)}–${pct(range.max)}. This is the store's own clean-traffic measurement. Judge the projected CVR against THIS range, not against industry benchmarks — a CVR inside it is realistic.`;

  const reviewPrompt = `Review this Google Ads campaign proposal for consistency between the rationale and the projection numbers.

Campaign: ${p.campaignName}
Landing Page: ${landingPage} [${pageType}]
Rationale: ${p.rationale}

Projections:
- CTR: ${((proj.ctr || 0) * 100).toFixed(1)}%
- CPC: $${proj.cpc}
- CVR: ${((proj.cvr || 0) * 100).toFixed(2)}%
- Daily Clicks: ${proj.dailyClicks}
- Monthly Cost: $${proj.monthlyCost}
- Monthly Conversions: ${proj.monthlyConversions}
- Monthly Revenue: $${proj.monthlyRevenue}
- ROAS: ${proj.monthlyCost > 0 ? (proj.monthlyRevenue / proj.monthlyCost).toFixed(2) : 'n/a'}x
${knownPagesContext}${measuredContext}

Check:
1. Does the CVR in projections match any CVR range cited in the rationale? Flag if they differ by more than 5 percentage points.
2. Does the CPC match any CPC estimate in the rationale?
3. Are CTR and CPC realistic for this keyword type (branded / generic / long-tail)? Is the CVR inside the measured range above?
4. Is the landing page appropriate for the campaign intent — does it match the ad messaging?
5. Any other contradictions between the narrative and the numbers?

IMPORTANT — Brand search exception: If this is a branded search campaign (targeting the store/brand name), the following ranges are accepted industry benchmarks (UNMEASURED on this store) and do NOT require site-specific data to justify: CTR 15–30%, CVR 8–15%, CPC $0.30–$0.60. Only flag brand search projections if they fall OUTSIDE these ranges, not merely because they weren't derived from observed data.

Output ONLY valid JSON — no markdown:
{ "approved": true }
OR
{ "approved": false, "reasons": ["specific issue 1", "specific issue 2"] }`;

  const response = await client.messages.create({
    model: REVIEW_MODEL,
    max_tokens: REVIEW_MAX_TOKENS,
    messages: [{ role: 'user', content: reviewPrompt }],
  });

  const raw = responseText(response);
  const cleaned = raw.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  return JSON.parse(cleaned);
}

/**
 * The barrier written when every proposal was rejected. Break-even CPC is quoted
 * at the MEASURED clean commercial CVR — never at an assumed 2%/3%/5%, which is
 * what this file used to carry and what the dashboard used to render.
 */
export function buildAovBarrier({ today, aov, minRoas, proposalsAnalyzed, measurement }) {
  const c = measurement.ranges.commercial;
  const { start, end } = measurement.window;
  const breakEvenCpa = aov / minRoas;
  const cpc = breakEvenCpcAtMeasured(aov, minRoas, c);
  return {
    date: today,
    aov,
    minRoas,
    breakEvenCpa: Math.round(breakEvenCpa * 100) / 100,
    measuredCvr: {
      basis: 'clean US shoppable commercial traffic (product + collection landing pages), Shopify orders by landing_site over GA4 sessions',
      window: { start, end },
      orders: c.orders,
      sessions: c.sessions,
      point: c.point,
      lower: c.lower,
      upper: c.upper,
      interval: '95% Wilson',
    },
    breakEvenCpcMeasured: cpc,
    proposalsAnalyzed,
    proposalsSaved: 0,
    message:
      `All ${proposalsAnalyzed} proposals rejected. At $${aov.toFixed(2)} AOV and ${minRoas}x minimum ROAS the break-even cost per acquisition is $${breakEvenCpa.toFixed(2)}. ` +
      `At the measured clean commercial CVR of ${pct(c.point)} (${c.orders} orders / ${c.sessions} sessions, ${start} → ${end}; 95% range ${pct(c.lower)}–${pct(c.upper)}) ` +
      `that allows a max CPC of $${cpc.atPoint.toFixed(2)} (range $${cpc.atLower.toFixed(2)}–$${cpc.atUpper.toFixed(2)}). ` +
      `Levers: raise AOV (bundles, upsells) or raise commercial-page conversion.`,
  };
}

// ── The weekly run ────────────────────────────────────────────────────────────

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
- adGroups (array): each with name, keywords (text + matchType: EXACT|PHRASE|BROAD), headlines (3–15 strings, each ≤30 characters), descriptions (2–4 strings, each ≤90 characters)
- negativeKeywords (array of strings)
- rationale (cite specific data points — see RATIONALE REQUIREMENTS below)
- dataPoints (key metrics that informed the proposal)
- projections: { ctr, cpc, cvr, dailyClicks, monthlyCost, monthlyConversions, monthlyRevenue }

BRAND SEARCH: Always include one brand search campaign (targeting the store name and close variants) if no active brand campaign exists. Use these fixed conservative benchmarks — do not deviate:
- CPC: $0.50
- CTR: 15%
- CVR: 8%
- suggestedBudget: $5/day

Compute projections from these inputs in order, then write the rationale from the computed numbers:
  dailyClicks = suggestedBudget / CPC = $5 / $0.50 = 10
  monthlyCost = dailyClicks × CPC × 30 = 10 × $0.50 × 30 = $150
  monthlyConversions = dailyClicks × CVR × 30 = 10 × 0.08 × 30 = 24
  monthlyRevenue = monthlyConversions × AOV = 24 × [AOV from data]
  ROAS = monthlyRevenue / monthlyCost
The rationale must cite these same computed numbers — do not recalculate independently.

NON-BRAND CVR: use the MEASURED conversion rate section in the data. It is this store's own clean-traffic measurement and it is far below industry benchmarks. Your projections.cvr MUST fall inside the measured range for the landing page type you choose; project near the measured rate. Do not cite an industry benchmark CVR for a non-brand campaign.

ROAS REQUIREMENT: Only propose campaigns where projected ROAS (monthlyRevenue ÷ monthlyCost) ≥ 0.85.
The AOV will be provided in the data. Use it to compute monthlyRevenue = monthlyConversions × AOV.
At the measured CVR, a non-brand campaign clears this only at a low CPC — derive the maximum CPC from AOV × CVR ÷ 0.85 before choosing keywords.
Prioritize niche, high-intent, long-tail keywords with lower CPCs that can clear this threshold.
If no keyword opportunity meets the ROAS minimum, do not force a proposal — output clarificationNeeded instead.

RATIONALE REQUIREMENTS — the rationale field MUST explicitly address all four of these or the proposal will be rejected:

1. CTR source: State the projected CTR and cite where it comes from — e.g. "GSC shows X% organic CTR on this query" or "industry benchmark for long-tail branded terms is X–Y%". If projecting higher than observed organic CTR, explain why paid would outperform organic.

2. CVR source: State the projected CVR and cite the measured rate and sample it came from (orders / sessions and window). Brand search cites its fixed benchmark and says it is unmeasured.

3. AOV disclosure: Explicitly state the AOV being used for revenue projections and confirm it matches the value provided in the data section. Example: "Using AOV of $X as provided. Monthly revenue = N conversions × $X = $Y."

4. Paused campaign explanation: If any prior campaign for this keyword space is listed as PAUSED or REMOVED, state why it was paused (if inferable from data) and what has changed that makes a new campaign viable now.

If you cannot form a confident proposal due to missing or insufficient data, output:
{ "clarificationNeeded": ["Question 1?", "Question 2?"] }

Output ONLY valid JSON — no markdown, no explanation outside the JSON.

Output format:
{ "proposals": [ ...proposal objects... ] }
OR
{ "clarificationNeeded": ["..."] }`;

function emptyGoogleAds() {
  return { campaignResourceName: null, campaignId: null, budgetResourceName: null, adGroupResourceNames: [], createdAt: null };
}

/**
 * The weekly run, with every side effect injected so fail-closed is testable.
 *
 * ORDER IS LOAD-BEARING: the CVR measurement happens FIRST, before any model call.
 * A run that cannot measure writes no proposal and no barrier and spends nothing,
 * and says so in the digest with status 'error' — the agent could not do its job.
 *
 * @param {object} deps
 * @param {object} deps.context  {activeSlugs, adsSnaps, gscSnaps, ga4Snaps, shopifySnaps, pastOutcomes}
 * @param {() => Promise<object>} deps.measure  resolves to measureCvr()'s result; throws to fail closed
 * @param {object} deps.client  Anthropic client
 * @param {string} deps.today   YYYY-MM-DD
 * @param {string} deps.campaignsDir
 * @param {(path:string, doc:object) => void} deps.write
 * @param {(path:string) => void} deps.remove
 * @param {(path:string) => boolean} deps.exists
 * @param {(n:object) => Promise<void>} deps.notify
 * @param {(msg:string) => void} [deps.log]
 * @param {boolean} [deps.isDryRun]
 */
export async function runWeeklyAnalysis(deps) {
  const { context, measure, client, today, campaignsDir, write, remove, exists, notify, isDryRun = false } = deps;
  const log = deps.log || (() => {});

  let measurement;
  try {
    measurement = await measure();
  } catch (e) {
    const why = e?.message || String(e);
    log(`  CVR measurement failed — no proposals written: ${why}`);
    // Deferred, never immediate: the digest is the channel. 'error' because the
    // agent could not do its job this week, which is exactly what that block is for.
    await notify({
      subject: 'Campaign Analyzer — CVR measurement failed, no proposals written',
      body: `The weekly run could not measure clean commercial CVR, so it wrote no proposals and no AOV barrier (it fails closed rather than projecting from benchmarks).\n\nReason: ${why}`,
      status: 'error',
    }).catch(() => {});
    return { status: 'measurement-failed', reason: why, written: [] };
  }
  const c = measurement.ranges.commercial;
  log(`  Measured commercial CVR ${pct(c.point)} (${c.orders}/${c.sessions}, ${measurement.window.start} → ${measurement.window.end}; 95% ${pct(c.lower)}–${pct(c.upper)})`);

  const userPrompt = buildAnalyzerPrompt({ ...context, measuredCvr: measurement });
  log(`  Prompt: ${Buffer.byteLength(userPrompt)} bytes`);
  const response = await client.messages.create({
    model: ANALYZER_MODEL,
    max_tokens: ANALYZER_MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
  });
  const result = parseAnalyzerResponse(responseText(response));

  if (isDryRun) {
    if (isClarification(result)) log(`[DRY RUN] Clarification needed: ${JSON.stringify(result.clarificationNeeded)}`);
    else (result.proposals || []).forEach((p, i) => log(`[DRY RUN] Proposal ${i + 1}: ${JSON.stringify(p, null, 2)}`));
    return { status: 'dry-run', written: [], result };
  }

  if (isClarification(result)) {
    const clarifyFile = join(campaignsDir, `${today}-clarification-needed.json`);
    write(clarifyFile, {
      id: `${today}-clarification-needed`,
      status: 'proposed',
      createdAt: new Date().toISOString(),
      clarificationNeeded: result.clarificationNeeded,
      clarificationResponse: null,
      proposal: null, rationale: null, dataPoints: null, projections: null,
      googleAds: emptyGoogleAds(),
      performance: [], alerts: [],
    });
    log(`  Clarification needed — saved: ${clarifyFile}`);
    await notify({ subject: 'Campaign Analyzer — clarification needed', body: result.clarificationNeeded.join('\n') }).catch(() => {});
    return { status: 'clarification', written: [] };
  }

  const allProposals = result.proposals || [];
  const roasOf = (p) => (p.projections?.monthlyCost > 0 ? p.projections.monthlyRevenue / p.projections.monthlyCost : null);
  const belowRoas = allProposals.filter(p => roasOf(p) !== null && roasOf(p) < MIN_ROAS);
  if (belowRoas.length > 0) {
    log(`  Filtered ${belowRoas.length} proposal(s) below ${MIN_ROAS}x ROAS: ${belowRoas.map(p => p.campaignName).join(', ')}`);
  }
  const proposals = allProposals.filter(p => roasOf(p) === null || roasOf(p) >= MIN_ROAS);

  const aov = computeAov(context.shopifySnaps);
  const knownPages = extractKnownPages(context.gscSnaps);
  const written = [];
  for (const p of proposals) {
    let review;
    try {
      review = await reviewProposal(p, aov, client, knownPages, measurement.ranges);
    } catch (e) {
      log(`  Reviewing: ${p.campaignName}... review error — skipping (${e.message})`);
      continue;
    }
    if (!review.approved) {
      log(`  Reviewing: ${p.campaignName}... rejected`);
      (review.reasons || []).forEach(r => log(`    ✗ ${r}`));
      continue;
    }
    log(`  Reviewing: ${p.campaignName}... approved`);

    const slug = p.slug || p.campaignName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const filePath = join(campaignsDir, `${today}-${slug}.json`);
    write(filePath, {
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
      measuredCvr: measurement.ranges.byPageType[classifyPageType(p.landingPage || '')] || null,
      clarificationNeeded: null,
      clarificationResponse: null,
      googleAds: emptyGoogleAds(),
      performance: [],
      alerts: [],
    });
    written.push(p.campaignName);
    log(`  Saved: ${filePath}`);
  }

  const barrierFile = join(campaignsDir, 'aov-barrier.json');
  if (written.length > 0) {
    // Clear any stale barrier file now that we have viable proposals
    if (exists(barrierFile)) { try { remove(barrierFile); } catch {} }
    await notify({
      subject: `Campaign Analyzer — ${written.length} new proposal${written.length > 1 ? 's' : ''}`,
      body: `New campaign proposals ready for review:\n${written.map(n => `• ${n}`).join('\n')}\n\nReview at dashboard → Ads tab`,
    }).catch(() => {});
  } else if (allProposals.length > 0) {
    const barrier = buildAovBarrier({ today, aov, minRoas: MIN_ROAS, proposalsAnalyzed: allProposals.length, measurement });
    write(barrierFile, barrier);
    log(`  No viable campaigns — AOV barrier written: ${barrierFile}`);
    await notify({
      subject: 'Campaign Analyzer — no viable campaigns',
      body: barrier.message + '\n\nSee dashboard → Ads tab for details.',
    }).catch(() => {});
  }
  return { status: written.length ? 'proposals' : 'no-viable', written };
}

// ── Data paths / I/O ─────────────────────────────────────────────────────────

const CAMPAIGNS_DIR     = join(ROOT, 'data', 'campaigns');
const ADS_SNAPS_DIR     = join(ROOT, 'data', 'snapshots', 'google-ads');
const GSC_SNAPS_DIR     = join(ROOT, 'data', 'snapshots', 'gsc');
const GA4_SNAPS_DIR     = join(ROOT, 'data', 'snapshots', 'ga4');
const SHOPIFY_SNAPS_DIR = join(ROOT, 'data', 'snapshots', 'shopify');

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
    .filter(f => f.endsWith('.json') && f !== '.gitkeep' && f !== 'aov-barrier.json')
    .map(f => { try { return JSON.parse(readFileSync(join(CAMPAIGNS_DIR, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

/**
 * The live measurement. lib/shopify.js throws at IMPORT without OAuth credentials,
 * so every import that reaches it sits inside measure() — an import failure is a measurement
 * failure and fails closed like any other.
 */
async function liveMeasure() {
  try {
    const [{ fetchLandingPageSegments }, { getAllOrders }, { ptDayOf, ptDayBounds }] = await Promise.all([
      import('../../lib/ga4.js'),
      import('../../lib/shopify.js'),
      // DST-correct Pacific day helpers, owned by shopify-collector and shared with
      // agents/seo-impact. It imports lib/shopify.js too, hence inside this boundary.
      import('../shopify-collector/index.js'),
    ]);
    return await measureCvr({
      fetchSegments: fetchLandingPageSegments,
      fetchOrders: getAllOrders,
      dayOf: ptDayOf,
      dayBounds: ptDayBounds,
    });
  } catch (e) {
    if (e instanceof CvrMeasurementError) throw e;
    throw new CvrMeasurementError(e?.message || String(e));
  }
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const campaignArg = process.argv.includes('--campaign')
    ? process.argv[process.argv.indexOf('--campaign') + 1]
    : null;

  console.log('Campaign Analyzer\n');
  const env = loadEnv();
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY in .env');

  const { notify } = await import('../../lib/notify.js');
  const campaigns = loadCampaigns();
  const activeSlugs = campaigns
    .filter(c => ['proposed', 'approved', 'active'].includes(c.status) && !c.clarificationNeeded)
    .map(c => c.id);
  const pastOutcomes = campaigns
    .filter(c => ['paused', 'completed'].includes(c.status) && c.performance?.length > 0)
    .map(c => ({ id: c.id, projections: c.projections, performance: c.performance.slice(-7) }));

  const { default: Anthropic } = await import('../../lib/anthropic.js');
  const client = new Anthropic({ apiKey });

  // Re-analysis mode
  if (campaignArg) {
    const file = join(CAMPAIGNS_DIR, `${campaignArg}.json`);
    if (!existsSync(file)) throw new Error(`Campaign file not found: ${file}`);
    const campaign = JSON.parse(readFileSync(file, 'utf8'));
    if (campaign.status !== 'proposed') throw new Error(`Cannot re-analyze campaign with status: ${campaign.status}`);
    if (!campaign.clarificationResponse) throw new Error('No clarificationResponse found on campaign file');

    // A re-analysis also produces a proposal that spends money, so it measures
    // first and fails closed exactly like the weekly run.
    let measurement;
    try {
      measurement = await liveMeasure();
    } catch (e) {
      await notify({
        subject: 'Campaign Analyzer — CVR measurement failed, re-analysis not run',
        body: `Could not measure clean commercial CVR for re-analysis of ${campaignArg}; the campaign file is unchanged.\n\nReason: ${e.message}`,
        status: 'error',
      }).catch(() => {});
      console.log(`  CVR measurement failed — re-analysis not run: ${e.message}`);
      return;
    }

    console.log(`  Re-analyzing: ${campaignArg}`);
    const reanalysisPrompt = [
      `## Original Proposal\n${campaign.rationale}\n\nData points: ${JSON.stringify(campaign.dataPoints)}`,
      `## Questions Asked\n${(campaign.clarificationNeeded || []).map((q, i) => `${i + 1}. ${q}`).join('\n')}`,
      `## User's Answers\n${campaign.clarificationResponse}`,
      renderMeasuredCvrSection(measurement),
      `## Task\nUsing the user's answers, produce a complete updated campaign proposal. If answers are still insufficient, output clarificationNeeded with refined questions.`,
    ].join('\n\n');

    process.stdout.write('  Running AI re-analysis... ');
    const response = await client.messages.create({
      model: ANALYZER_MODEL,
      max_tokens: ANALYZER_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: reanalysisPrompt }],
    });
    console.log('done');
    const result = parseAnalyzerResponse(responseText(response));

    let rejected = null;
    if (isClarification(result)) {
      campaign.clarificationNeeded = result.clarificationNeeded;
      console.log(`  Still needs clarification: ${result.clarificationNeeded.length} questions`);
    } else {
      const p = result.proposals?.[0];
      if (p) {
        // The free checks the weekly reviewer runs first. The re-analysis never had
        // any review; at minimum it may not write a CVR the measurement contradicts.
        const issues = [...mathCheck(p, computeAov(loadSnaps(SHOPIFY_SNAPS_DIR, 90))), cvrRangeIssue(p, measurement.ranges)].filter(Boolean);
        if (issues.length) {
          rejected = issues;
          console.log('  Re-analysis proposal rejected:');
          issues.forEach(r => console.log(`    ✗ ${r}`));
        } else {
          campaign.proposal = { ...campaign.proposal, ...p };
          campaign.rationale = p.rationale;
          campaign.projections = p.projections;
          campaign.dataPoints = p.dataPoints;
          campaign.measuredCvr = measurement.ranges.byPageType[classifyPageType(p.landingPage || '')] || null;
          campaign.clarificationNeeded = null;
          console.log(`  Proposal updated: ${p.campaignName}`);
        }
      }
    }
    if (!isDryRun) {
      if (!rejected) writeFileSync(file, JSON.stringify(campaign, null, 2));
      const body = rejected
        ? `Campaign re-analysis for ${campaignArg} produced a proposal that failed review; the campaign file is unchanged.\n${rejected.map(r => `• ${r}`).join('\n')}`
        : isClarification(result)
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
    pastOutcomes,
  };
  console.log(`  Data loaded: ads=${context.adsSnaps.length} gsc=${context.gscSnaps.length} ga4=${context.ga4Snaps.length} shopify=${context.shopifySnaps.length}`);

  if (!isDryRun) mkdirSync(CAMPAIGNS_DIR, { recursive: true });
  await runWeeklyAnalysis({
    context,
    measure: liveMeasure,
    client,
    today: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }),
    campaignsDir: CAMPAIGNS_DIR,
    write: (path, doc) => writeFileSync(path, JSON.stringify(doc, null, 2)),
    remove: (path) => unlinkSync(path),
    exists: (path) => existsSync(path),
    notify,
    log: (msg) => console.log(msg),
    isDryRun,
  });
}

// Only run when invoked directly (not when imported by tests).
//
// A crash MUST reach the 5 AM digest. Until 2026-09-16 this handler logged and
// exited, so five months of weekly 413s were visible only in the cron log. It is
// the agent BREAKING, so status 'error'; deferred like every notification.
if (isDirectRun(import.meta.url)) {
  main().catch(async (err) => {
    console.error('Error:', err?.message || err);
    try {
      const { notify } = await import('../../lib/notify.js');
      await notify({
        subject: 'Campaign Analyzer failed',
        body: `The weekly campaign analyzer crashed and wrote nothing.\n\n${err?.stack || err?.message || String(err)}`,
        status: 'error',
      });
    } catch { /* the digest is best-effort; the exit code still reports the failure */ }
    process.exit(1);
  });
}
