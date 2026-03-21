// agents/campaign-monitor/index.js
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..', '..');

// ── Pure exports ───────────────────────────────────────────────────────────────

export function buildPerformanceEntry(date, snap, projections) {
  const impressions = Number(snap.impressions || 0);
  const clicks = Number(snap.clicks || 0);
  const spend = Number(snap.spend || 0);
  const ctr = impressions > 0 ? clicks / impressions : 0;
  const avgCpc = clicks > 0 ? spend / clicks : 0;
  const conversions = Number(snap.conversions || 0);
  const cvr = clicks > 0 ? conversions / clicks : 0;
  const cpa = conversions > 0 ? spend / conversions : null;

  return {
    date,
    impressions,
    clicks,
    spend: Math.round(spend * 100) / 100,
    ctr: Math.round(ctr * 10000) / 10000,
    avgCpc: Math.round(avgCpc * 100) / 100,
    conversions,
    cvr: Math.round(cvr * 10000) / 10000,
    cpa: cpa !== null ? Math.round(cpa * 100) / 100 : null,
    vsProjection: {
      ctrDelta: Math.round((ctr - projections.ctr) * 10000) / 10000,
      cpcDelta: Math.round((avgCpc - projections.cpc) * 100) / 100,
      cvrDelta: Math.round((cvr - projections.cvr) * 10000) / 10000,
    },
  };
}

export function isDuplicateAlert(type, existingAlerts) {
  return existingAlerts.some(a => a.type === type && !a.resolved);
}

export function evaluateAlerts(performance, projections, approvedBudget, existingAlerts) {
  const newAlerts = [];
  const days = performance.length;
  if (days === 0) return newAlerts;

  const totalSpend = performance.reduce((s, e) => s + e.spend, 0);
  const totalClicks = performance.reduce((s, e) => s + e.clicks, 0);
  const totalConversions = performance.reduce((s, e) => s + e.conversions, 0);
  const avgCTR = performance.reduce((s, e) => s + e.ctr, 0) / days;
  const avgCPC = totalClicks > 0 ? totalSpend / totalClicks : 0;
  const avgCVR = totalClicks > 0 ? totalConversions / totalClicks : 0;

  const fire = (type, message) => {
    if (!isDuplicateAlert(type, existingAlerts)) {
      newAlerts.push({ type, firedAt: new Date().toISOString(), message, resolved: false });
    }
  };

  // low_ctr: after 7 days, avg CTR < 50% of projected
  if (days >= 7 && avgCTR < projections.ctr * 0.5) {
    fire('low_ctr', `CTR ${(avgCTR * 100).toFixed(2)}% is below 50% of projected ${(projections.ctr * 100).toFixed(2)}% after ${days} days — review ad copy`);
  }

  // high_cpc: after 7 days, avg CPC > 150% of projected
  if (days >= 7 && avgCPC > projections.cpc * 1.5) {
    fire('high_cpc', `Avg CPC $${avgCPC.toFixed(2)} is above 150% of projected $${projections.cpc.toFixed(2)} after ${days} days — consider bid adjustment`);
  }

  // low_cvr: after 14 days, avg CVR < 50% of projected
  if (days >= 14 && avgCVR < projections.cvr * 0.5) {
    fire('low_cvr', `CVR ${(avgCVR * 100).toFixed(2)}% is below 50% of projected ${(projections.cvr * 100).toFixed(2)}% after ${days} days — review landing page`);
  }

  // high_cpa: after 14 days, with conversions, projected CVR > 0
  if (days >= 14 && totalConversions > 0 && projections.cvr > 0) {
    const actualCPA = totalSpend / totalConversions;
    const projectedCPA = projections.cpc / projections.cvr;
    if (actualCPA > projectedCPA * 2.0) {
      fire('high_cpa', `CPA $${actualCPA.toFixed(2)} exceeds 200% of projected $${projectedCPA.toFixed(2)} — consider pausing`);
    }
  }

  // troas_ready: cumulative conversions >= 15
  if (totalConversions >= 15) {
    fire('troas_ready', `${totalConversions} cumulative conversions reached — recommend switching to Target ROAS bidding`);
  }

  // budget_maxed: last 7 days all have spend >= 95% of daily budget
  if (days >= 7) {
    const last7 = performance.slice(-7);
    if (last7.every(e => e.spend >= approvedBudget * 0.95)) {
      fire('budget_maxed', `Daily budget $${approvedBudget} has been at ≥95% utilization for 7 consecutive days — consider increasing budget`);
    }
  }

  return newAlerts;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const CAMPAIGNS_DIR   = join(ROOT, 'data', 'campaigns');
const ADS_SNAPS_DIR   = join(ROOT, 'data', 'snapshots', 'google-ads');

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

function loadActiveCampaigns() {
  if (!existsSync(CAMPAIGNS_DIR)) return [];
  return readdirSync(CAMPAIGNS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(readFileSync(join(CAMPAIGNS_DIR, f), 'utf8')); } catch { return null; } })
    .filter(c => c && c.status === 'active');
}

function loadYesterdaySnap() {
  if (!existsSync(ADS_SNAPS_DIR)) return null;
  const files = readdirSync(ADS_SNAPS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort().reverse();
  if (!files.length) return null;
  try { return JSON.parse(readFileSync(join(ADS_SNAPS_DIR, files[0]), 'utf8')); } catch { return null; }
}

async function main() {
  console.log('Campaign Monitor\n');

  const campaigns = loadActiveCampaigns();
  if (!campaigns.length) {
    console.log('  No active campaigns found.');
    return;
  }
  console.log(`  Active campaigns: ${campaigns.length}`);

  const snap = loadYesterdaySnap();
  if (!snap) {
    console.log('  No Google Ads snapshot found. Skipping.');
    return;
  }
  console.log(`  Snapshot date: ${snap.date}`);

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const updated = [];
  const alertsFired = [];

  for (const campaign of campaigns) {
    const campaignId = campaign.googleAds?.campaignId;
    if (!campaignId) {
      console.log(`  Skipping ${campaign.id} — no campaignId`);
      continue;
    }

    // Find this campaign's data in yesterday's snapshot
    const snapCampaign = (snap.campaigns || []).find(c => String(c.id) === String(campaignId));
    if (!snapCampaign) {
      console.log(`  No snapshot data for ${campaign.id}`);
      continue;
    }

    const entry = buildPerformanceEntry(snap.date || today, snapCampaign, campaign.projections);
    campaign.performance.push(entry);

    const newAlerts = evaluateAlerts(campaign.performance, campaign.projections, campaign.proposal.approvedBudget, campaign.alerts);
    campaign.alerts.push(...newAlerts);

    if (newAlerts.length > 0) {
      alertsFired.push({ campaign: campaign.id, alerts: newAlerts });
      console.log(`  ${campaign.id}: ${newAlerts.length} new alert(s): ${newAlerts.map(a => a.type).join(', ')}`);
    } else {
      console.log(`  ${campaign.id}: no new alerts`);
    }

    const file = join(CAMPAIGNS_DIR, `${campaign.id}.json`);
    writeFileSync(file, JSON.stringify(campaign, null, 2));
    updated.push(campaign.id);
  }

  console.log(`\n  Updated: ${updated.length} campaign(s)`);

  // Notify if any alerts fired
  if (alertsFired.length > 0) {
    const { notify } = await import('../../lib/notify.js');
    const body = alertsFired.map(({ campaign: id, alerts }) =>
      `${id}:\n${alerts.map(a => `  • ${a.type}: ${a.message}`).join('\n')}`
    ).join('\n\n');
    await notify({
      subject: `Campaign Monitor — ${alertsFired.reduce((s, x) => s + x.alerts.length, 0)} alert(s) fired`,
      body,
    }).catch(() => {});
  }
}

const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main().catch(err => { console.error('Error:', err.message); process.exit(1); });
