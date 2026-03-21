import { strict as assert } from 'node:assert';
import {
  buildPerformanceEntry,
  evaluateAlerts,
  isDuplicateAlert,
} from '../../agents/campaign-monitor/index.js';

const projections = { ctr: 0.035, cpc: 0.65, cvr: 0.022, dailyClicks: 8, monthlyCost: 150, monthlyConversions: 5, monthlyRevenue: 180 };

// buildPerformanceEntry — basic
const snapActual = { impressions: 1000, clicks: 30, spend: 20.00, ctr: 0.03, avgCpc: 0.67, conversions: 0 };
const entry = buildPerformanceEntry('2026-03-20', snapActual, projections);
assert.equal(entry.date, '2026-03-20');
assert.equal(entry.impressions, 1000);
assert.equal(entry.clicks, 30);
assert.ok(typeof entry.spend === 'number');
assert.ok(typeof entry.ctr === 'number');
assert.ok(entry.vsProjection !== undefined, 'must have vsProjection deltas');
assert.ok(typeof entry.vsProjection.ctrDelta === 'number');
assert.ok(typeof entry.vsProjection.cpcDelta === 'number');
assert.ok(typeof entry.vsProjection.cvrDelta === 'number');

// buildPerformanceEntry — with conversions, CPA calculated
const snapWithConv = { impressions: 1000, clicks: 30, spend: 20.00, ctr: 0.03, avgCpc: 0.67, conversions: 4.15 };
const entryWithConv = buildPerformanceEntry('2026-03-21', snapWithConv, projections);
assert.ok(Math.abs(entryWithConv.cpa - 4.82) < 0.001);

// evaluateAlerts — low CTR after 7 days
const performance7 = Array.from({ length: 7 }, (_, i) => ({
  date: `2026-03-${15 + i}`,
  spend: 5, impressions: 200, clicks: 2, ctr: 0.01, avgCpc: 2.5, conversions: 0, cvr: 0, cpa: null,
  vsProjection: { ctrDelta: -0.025, cpcDelta: 1.85, cvrDelta: -0.022 },
}));
const alertsLowCTR = evaluateAlerts(performance7, { ctr: 0.035, cpc: 0.65, cvr: 0.022 }, 5.0, []);
assert.ok(alertsLowCTR.some(a => a.type === 'low_ctr'), 'should fire low_ctr');

// evaluateAlerts — no low_ctr before 7 days
const performance6 = performance7.slice(0, 6);
const alertsEarly = evaluateAlerts(performance6, projections, 5.0, []);
assert.ok(!alertsEarly.some(a => a.type === 'low_ctr'), 'should not fire before 7 days');

// evaluateAlerts — troas_ready when 15 conversions cumulative
const performanceWithConv = Array.from({ length: 20 }, (_, i) => ({
  date: `2026-03-${1 + i}`, spend: 5, impressions: 200, clicks: 10, ctr: 0.05, avgCpc: 0.5,
  conversions: 1, cvr: 0.1, cpa: 5, vsProjection: { ctrDelta: 0.015, cpcDelta: -0.15, cvrDelta: 0.078 },
}));
const alertsTROAS = evaluateAlerts(performanceWithConv, projections, 5.0, []);
assert.ok(alertsTROAS.some(a => a.type === 'troas_ready'), 'should fire troas_ready at 20 conversions');

// evaluateAlerts — high_cpc after 7 days (avg CPC $1.50 > 150% of projected $0.65)
const performance7HighCPC = Array.from({ length: 7 }, (_, i) => ({
  date: `2026-03-${15 + i}`,
  spend: 5, impressions: 200, clicks: 5, ctr: 0.025, avgCpc: 1.5, conversions: 0, cvr: 0, cpa: null,
  vsProjection: { ctrDelta: -0.01, cpcDelta: 0.85, cvrDelta: -0.022 },
}));
const alertsHighCPC = evaluateAlerts(performance7HighCPC, { ctr: 0.035, cpc: 0.65, cvr: 0.022 }, 5.0, []);
assert.ok(alertsHighCPC.some(a => a.type === 'high_cpc'), 'should fire high_cpc after 7 days');

// evaluateAlerts — low_cvr after 14 days (0 conversions < 50% of projected 0.022)
const performance14LowCVR = Array.from({ length: 14 }, (_, i) => ({
  date: `2026-03-${1 + i}`,
  spend: 5, impressions: 200, clicks: 10, ctr: 0.05, avgCpc: 0.5, conversions: 0, cvr: 0, cpa: null,
  vsProjection: { ctrDelta: 0.015, cpcDelta: -0.15, cvrDelta: -0.022 },
}));
const alertsLowCVR = evaluateAlerts(performance14LowCVR, { ctr: 0.035, cpc: 0.65, cvr: 0.022 }, 5.0, []);
assert.ok(alertsLowCVR.some(a => a.type === 'low_cvr'), 'should fire low_cvr after 14 days');

// evaluateAlerts — high_cpa after 14 days
// projectedCPA = 0.65/0.022 = 29.55; threshold = 59.09
// 14 days × spend=$5 = totalSpend=$70; 0.05 conv/day × 14 = 0.7 totalConv; actualCPA = 70/0.7 = $100 > $59.09
const performance14HighCPA = Array.from({ length: 14 }, (_, i) => ({
  date: `2026-03-${1 + i}`,
  spend: 5, impressions: 200, clicks: 10, ctr: 0.05, avgCpc: 0.5, conversions: 0.05, cvr: 0.005, cpa: 100,
  vsProjection: { ctrDelta: 0.015, cpcDelta: -0.15, cvrDelta: -0.017 },
}));
const alertsHighCPA = evaluateAlerts(performance14HighCPA, { ctr: 0.035, cpc: 0.65, cvr: 0.022 }, 5.0, []);
assert.ok(alertsHighCPA.some(a => a.type === 'high_cpa'), 'should fire high_cpa after 14 days');

// evaluateAlerts — budget_maxed (7 consecutive days spend >= 95% of $5 budget)
const performance7BudgetMaxed = Array.from({ length: 7 }, (_, i) => ({
  date: `2026-03-${15 + i}`,
  spend: 5.0, impressions: 500, clicks: 20, ctr: 0.04, avgCpc: 0.25, conversions: 1, cvr: 0.05, cpa: 5,
  vsProjection: { ctrDelta: 0.005, cpcDelta: -0.4, cvrDelta: 0.028 },
}));
const alertsBudgetMaxed = evaluateAlerts(performance7BudgetMaxed, { ctr: 0.035, cpc: 0.65, cvr: 0.022 }, 5.0, []);
assert.ok(alertsBudgetMaxed.some(a => a.type === 'budget_maxed'), 'should fire budget_maxed');

// isDuplicateAlert — returns true if unresolved alert of same type exists
const existingAlerts = [{ type: 'low_ctr', firedAt: '2026-03-20T07:30:00Z', message: 'test', resolved: false }];
assert.ok(isDuplicateAlert('low_ctr', existingAlerts));
assert.ok(!isDuplicateAlert('high_cpc', existingAlerts));
// resolved alerts don't block re-firing
const resolvedAlerts = [{ type: 'low_ctr', firedAt: '2026-03-20T07:30:00Z', message: 'test', resolved: true }];
assert.ok(!isDuplicateAlert('low_ctr', resolvedAlerts));

console.log('✓ campaign-monitor pure function tests pass');
