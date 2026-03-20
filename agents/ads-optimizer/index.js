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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

// ── Pure exports (tested) ──────────────────────────────────────────────────────

export function suggestionFilePath(date, rootDir) {
  return join(rootDir, 'data', 'ads-optimizer', `${date}.json`);
}

export function buildAlertEmailBody(snap, suggestions, dashboardUrl) {
  const lines = [
    `Yesterday: $${snap.spend.toFixed(2)} spend · ${snap.clicks} clicks · ${snap.conversions} conv · ${snap.roas.toFixed(2)}x ROAS`,
    '',
    'Suggestions:',
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
