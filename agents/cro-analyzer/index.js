/**
 * CRO Analyzer Agent
 *
 * Reads the last 7 days of Clarity, Shopify, GSC, and GA4 snapshots, sends
 * them to Claude for CRO analysis, and saves a brief to:
 *   data/reports/cro/YYYY-MM-DD-cro-brief.md
 *
 * Usage:
 *   node agents/cro-analyzer/index.js
 */

import Anthropic from '../../lib/anthropic.js';
import { writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { notify } from '../../lib/notify.js';
import { compactJson, headArray, fitSections } from '../../lib/prompt-budget.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CLARITY_DIR  = join(ROOT, 'data', 'snapshots', 'clarity');
const SHOPIFY_DIR  = join(ROOT, 'data', 'snapshots', 'shopify');
const GSC_DIR      = join(ROOT, 'data', 'snapshots', 'gsc');
const GA4_DIR      = join(ROOT, 'data', 'snapshots', 'ga4');
const GOOGLE_ADS_DIR = join(ROOT, 'data', 'snapshots', 'google-ads');
const REPORTS_DIR  = join(ROOT, 'data', 'reports', 'cro');

// ~150k tokens of data. Well inside the 1M context window, and far more headroom
// than a conversion brief needs — the failure this guards against was 1,917,307
// tokens, so the useful ceiling is nowhere near the API's.
const PROMPT_CHAR_CAP = 600_000;

function loadRecentSnapshots(dir, days = 7) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort().reverse()
    .slice(0, days)
    .map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const env = {};
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx === -1) continue;
      env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
    }
    return env;
  } catch { return {}; }
}

async function main() {
  console.log('CRO Analyzer\n');

  const claritySnaps  = loadRecentSnapshots(CLARITY_DIR);
  const shopifySnaps  = loadRecentSnapshots(SHOPIFY_DIR);
  const gscSnaps      = loadRecentSnapshots(GSC_DIR);
  const ga4Snaps      = loadRecentSnapshots(GA4_DIR);
  const adsSnaps      = loadRecentSnapshots(GOOGLE_ADS_DIR);

  console.log(`  Clarity snapshots:  ${claritySnaps.length}`);
  console.log(`  Shopify snapshots:  ${shopifySnaps.length}`);
  console.log(`  GSC snapshots:      ${gscSnaps.length}`);
  console.log(`  GA4 snapshots:      ${ga4Snaps.length}`);
  console.log(`  Google Ads snapshots: ${adsSnaps.length}`);

  if (!claritySnaps.length && !shopifySnaps.length && !gscSnaps.length && !ga4Snaps.length) {
    console.log('  No snapshot data found — run collectors first.');
    process.exit(0);
  }

  const env = loadEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY || env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY in .env');

  const client = new Anthropic({ apiKey });

  const systemPrompt = `You are a senior CRO (conversion rate optimization) analyst. You will be given daily snapshot data from up to four sources for a small ecommerce store selling natural skin care and oral care products:
- Microsoft Clarity: user behavior (sessions, scroll depth, rage clicks, dead clicks)
- Shopify: orders, revenue, cart abandonment, top products
- Google Search Console (GSC): organic search queries, impressions, CTR, ranking positions
- Google Analytics 4 (GA4): sessions, bounce rate, conversion rate, revenue, traffic sources, top landing pages
- Google Ads: campaign spend, clicks, CTR, average CPC, conversions, ROAS, top keywords by conversion

Not all sources may be present — analyze what is available.

Your task: analyze the data, identify the most impactful CRO opportunities, and write a concise brief with 3-7 prioritized action items.

For each action item:
- Assign priority: HIGH, MED, or LOW
- State the specific metric and its value that drives the recommendation
- Give a concrete, specific action the store owner can take

Output format (Markdown):
## Summary
[2-3 sentence overview of the week's performance]

## Action Items

### 1. [SHORT TITLE] <!-- category:[CATEGORY] page:[HANDLE] --> — [HIGH/MED/LOW]
**Evidence:** [specific metric + value]
**Action:** [concrete thing to do]

[repeat for each item]

CATEGORY/HANDLE tag rules:
- The HTML comment tag MUST appear BEFORE the priority suffix (before " — HIGH/MED/LOW"), never after.
- CATEGORY: pick exactly one of:
  - content-formatting — CTA placement, image gaps, heading cadence, readability, paragraph length
  - seo-discovery — meta title/description, keyword ranking, internal linking, content gaps
  - trust-conversion — social proof, CTA copy, above-the-fold value prop, product framing
  Omit the tag entirely if the item is not page-specific (e.g. checkout improvements, site-wide issues).
- HANDLE: extract the article handle from a blog URL in the GSC snapshot data.
  Example: https://www.realskincare.com/blogs/news/can-you-use-coconut-oil-as-toothpaste → handle is can-you-use-coconut-oil-as-toothpaste
  If the item is not tied to a specific blog post, omit the tag.
- If both CATEGORY and HANDLE are omitted (site-wide or non-page-specific item), write the heading without any HTML comment: ### 1. [SHORT TITLE] — [HIGH/MED/LOW]

## Raw Data
[paste key metrics as a compact table]`;

  const aovBarrierFile = join(ROOT, 'data', 'campaigns', 'aov-barrier.json');
  const aovBarrier = existsSync(aovBarrierFile) ? (() => { try { return JSON.parse(readFileSync(aovBarrierFile, 'utf8')); } catch { return null; } })() : null;

  // GSC snapshots are ~700 KB/day — 1,000 topQueries + 188 topPages + 1,997
  // queriesByPage rows each. Seven days pretty-printed came to ~2.5M tokens on
  // their own and took the whole request past the 1M context limit, failing every
  // run. A CRO brief needs the head of each list, not the full query x page cross
  // product, so trim at the source rather than blind-truncating a JSON blob into
  // something the model cannot parse.
  const slimGsc = gscSnaps.map((s) => ({
    date: s.date,
    summary: s.summary,
    topQueries: headArray(s.topQueries, 50),
    topPages: headArray(s.topPages, 50),
    // Dropped entirely: it is the cross product of the two lists above and adds
    // no signal a conversion brief acts on.
    queriesByPage: Array.isArray(s.queriesByPage)
      ? [{ _omitted: `${s.queriesByPage.length} query-by-page rows omitted — see topQueries and topPages` }]
      : undefined,
  }));

  const { text: dataBlock, trimmed } = fitSections([
    { label: `Clarity Snapshots (${claritySnaps.length} days)`, body: claritySnaps.length ? compactJson(claritySnaps) : '' },
    { label: `Shopify Snapshots (${shopifySnaps.length} days)`, body: shopifySnaps.length ? compactJson(shopifySnaps) : '' },
    { label: `GSC Snapshots (${gscSnaps.length} days)`,         body: gscSnaps.length ? compactJson(slimGsc) : '' },
    { label: `GA4 Snapshots (${ga4Snaps.length} days)`,         body: ga4Snaps.length ? compactJson(ga4Snaps) : '' },
    { label: `Google Ads Performance (${adsSnaps.length} days)`, body: adsSnaps.length ? compactJson(adsSnaps) : '' },
    { label: 'Paid Search Readiness', body: aovBarrier
      ? `The campaign analyzer was unable to find viable Google Ads campaigns because the store's AOV is too low to support profitable search spend at typical keyword CPCs.\n${compactJson(aovBarrier)}\nInclude a "Paid Search Readiness" section in the brief recommending specific actions to increase AOV (e.g. product bundles, upsells, cross-sells) that would unlock search advertising. State the target AOV needed and which campaign types become viable at that level.`
      : '' },
  ], { totalCap: PROMPT_CHAR_CAP });

  if (trimmed.length) console.log(`\n  Trimmed to fit the prompt budget: ${trimmed.join(', ')}`);
  console.log(`  Prompt data block: ~${Math.round(dataBlock.length / 4).toLocaleString()} tokens`);

  const userMessage = [
    'Here is the available CRO data (most recent first):',
    dataBlock,
    'Write the CRO brief now.',
  ].join('\n\n');

  process.stdout.write('  Running AI analysis... ');
  const response = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  if (!response.content?.[0]?.text) throw new Error('Claude returned an empty response');
  const brief = response.content[0].text;
  console.log('done');

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const header = `# CRO Brief — ${today}\n**Generated:** ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}\n\n---\n\n`;

  mkdirSync(REPORTS_DIR, { recursive: true });
  const outPath = join(REPORTS_DIR, `${today}-cro-brief.md`);
  writeFileSync(outPath, header + brief);
  console.log(`  Brief saved: ${outPath}`);
}

// Only run when invoked directly. Without this guard, any import of this module
// (tests import helpers from it) executes the whole agent — hitting live APIs and
// taking the host process down with it on any error.
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main()
    .then(async () => {
      await notify({ subject: 'CRO Analyzer completed', body: 'Weekly CRO brief generated.', status: 'success' }).catch(() => {});
    })
    .catch(async err => {
      await notify({ subject: 'CRO Analyzer failed', body: err.message || String(err), status: 'error' }).catch(() => {});
      console.error('Error:', err.message);
      process.exit(1);
    });
}
