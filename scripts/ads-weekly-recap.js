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

import { readFileSync, existsSync } from 'node:fs';
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
  // Load GSC snapshots for organic overlap check
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
