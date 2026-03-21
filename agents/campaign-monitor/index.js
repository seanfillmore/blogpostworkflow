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
