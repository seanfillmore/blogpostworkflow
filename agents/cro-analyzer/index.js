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

import Anthropic from '@anthropic-ai/sdk';
import { writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const CLARITY_DIR  = join(ROOT, 'data', 'snapshots', 'clarity');
const SHOPIFY_DIR  = join(ROOT, 'data', 'snapshots', 'shopify');
const GSC_DIR      = join(ROOT, 'data', 'snapshots', 'gsc');
const GA4_DIR      = join(ROOT, 'data', 'snapshots', 'ga4');
const REPORTS_DIR  = join(ROOT, 'data', 'reports', 'cro');

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

  console.log(`  Clarity snapshots:  ${claritySnaps.length}`);
  console.log(`  Shopify snapshots:  ${shopifySnaps.length}`);
  console.log(`  GSC snapshots:      ${gscSnaps.length}`);
  console.log(`  GA4 snapshots:      ${ga4Snaps.length}`);

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

### 1. [SHORT TITLE] — [HIGH/MED/LOW]
**Evidence:** [specific metric + value]
**Action:** [concrete thing to do]

[repeat for each item]

## Raw Data
[paste key metrics as a compact table]`;

  const parts = [
    `Here is the available CRO data (most recent first):`,
    claritySnaps.length ? `### Clarity Snapshots (${claritySnaps.length} days)\n${JSON.stringify(claritySnaps, null, 2)}` : '',
    shopifySnaps.length ? `### Shopify Snapshots (${shopifySnaps.length} days)\n${JSON.stringify(shopifySnaps, null, 2)}` : '',
    gscSnaps.length     ? `### GSC Snapshots (${gscSnaps.length} days)\n${JSON.stringify(gscSnaps, null, 2)}`     : '',
    ga4Snaps.length     ? `### GA4 Snapshots (${ga4Snaps.length} days)\n${JSON.stringify(ga4Snaps, null, 2)}`     : '',
    `Write the CRO brief now.`,
  ].filter(Boolean);
  const userMessage = parts.join('\n\n');

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

main()
  .then(async () => {
    await notify({ subject: 'CRO Analyzer completed', body: 'Weekly CRO brief generated.', status: 'success' }).catch(() => {});
  })
  .catch(async err => {
    await notify({ subject: 'CRO Analyzer failed', body: err.message || String(err), status: 'error' }).catch(() => {});
    console.error('Error:', err.message);
    process.exit(1);
  });
