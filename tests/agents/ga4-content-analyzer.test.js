// tests/agents/ga4-content-analyzer.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';

function classifyPage(sessions, conversions) {
  if (sessions >= 100 && conversions === 0) return 'high-traffic-low-conversion';
  if (sessions < 50 && conversions >= 1) return 'low-traffic-high-conversion';
  return 'balanced';
}

function aggregateSnapshots(snapshots) {
  const byPage = new Map();
  for (const snap of snapshots) {
    for (const lp of (snap.topLandingPages || [])) {
      const existing = byPage.get(lp.page) || { sessions: 0, conversions: 0, revenue: 0 };
      existing.sessions += lp.sessions || 0;
      existing.conversions += lp.conversions || 0;
      existing.revenue += lp.revenue || 0;
      byPage.set(lp.page, existing);
    }
  }
  return byPage;
}

function classifyCluster(pages) {
  const croCandidates = pages.filter((p) => p.classification === 'high-traffic-low-conversion');
  const expansionCandidates = pages.filter((p) => p.classification === 'low-traffic-high-conversion');
  return {
    cro_signal: croCandidates.length > expansionCandidates.length,
    expansion_signal: expansionCandidates.length > 0 && expansionCandidates.length >= croCandidates.length,
  };
}

test('classifyPage: high traffic, no conversions = CRO candidate', () => {
  assert.equal(classifyPage(500, 0), 'high-traffic-low-conversion');
});

test('classifyPage: low traffic, has conversions = expansion candidate', () => {
  assert.equal(classifyPage(30, 2), 'low-traffic-high-conversion');
});

test('classifyPage: moderate traffic with conversions = balanced', () => {
  assert.equal(classifyPage(200, 5), 'balanced');
});

test('classifyPage: low traffic, no conversions = balanced', () => {
  assert.equal(classifyPage(10, 0), 'balanced');
});

test('aggregateSnapshots sums sessions and conversions per page', () => {
  const snapshots = [
    { topLandingPages: [{ page: '/a', sessions: 50, conversions: 1, revenue: 10 }] },
    { topLandingPages: [{ page: '/a', sessions: 30, conversions: 0, revenue: 0 }, { page: '/b', sessions: 20, conversions: 1, revenue: 5 }] },
  ];
  const result = aggregateSnapshots(snapshots);
  assert.equal(result.get('/a').sessions, 80);
  assert.equal(result.get('/a').conversions, 1);
  assert.equal(result.get('/b').sessions, 20);
});

test('classifyCluster identifies CRO signal when more high-traffic pages', () => {
  const pages = [
    { classification: 'high-traffic-low-conversion' },
    { classification: 'high-traffic-low-conversion' },
    { classification: 'balanced' },
  ];
  const result = classifyCluster(pages);
  assert.equal(result.cro_signal, true);
  assert.equal(result.expansion_signal, false);
});

test('classifyCluster identifies expansion signal', () => {
  const pages = [
    { classification: 'low-traffic-high-conversion' },
    { classification: 'balanced' },
  ];
  const result = classifyCluster(pages);
  assert.equal(result.cro_signal, false);
  assert.equal(result.expansion_signal, true);
});
