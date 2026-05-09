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

const day = arg('day', String(Math.floor((Date.now() - new Date('2026-05-09T00:00:00Z').getTime()) / 86400000)));

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
    // TODO(day-7): extend lib/ga4.js with a paid-funnel helper for ATC/checkout rates
    `## GA4 — paid funnel (deferred)`,
    ``,
    `_GA4 paid-funnel breakdown (ATC rate, begin_checkout rate) will be added when we extend lib/ga4.js with a paid-funnel helper. For now, conversion counts come from Google Ads above (purchases). Add this hook before the day-7 audit at the latest._`,
    ``,
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
