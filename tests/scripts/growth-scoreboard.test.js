// Salvaged from feature/growth-plan-1m before that branch was deleted (2026-08-21),
// and relocated from scripts/__tests__/growth-scoreboard.test.mjs to tests/scripts/
// so `npm test` (glob 'tests/**/*.test.js') actually picks it up — it never ran
// in its original location. package.json has "type": "module", so this .js file
// importing the sibling .mjs module is fine.
import assert from 'node:assert';
import { test } from 'node:test';
import { computeScoreboard } from '../../scripts/growth-scoreboard.mjs';

test('reconciles GA4 vs Shopify and flags overcount', () => {
  const ga4Rows = [
    { page: '/', channel: 'Direct', sessions: 100, conversions: 40, revenue: 100 },
    { page: '/blogs/news/x', channel: 'Organic Search', sessions: 900, conversions: 35, revenue: 20 },
  ];
  const orders = { count: 18, revenue: 858, aov: 47.66 };
  const s = computeScoreboard({ ga4Rows, orders });
  assert.equal(s.sessions, 1000);
  assert.equal(s.ga4Conversions, 75);
  assert.equal(s.shopifyOrders, 18);
  assert.equal(Number(s.trueCvr.toFixed(4)), 0.018);            // 18/1000
  assert.equal(Number(s.ga4Cvr.toFixed(4)), 0.075);             // 75/1000
  assert.equal(Number(s.ga4OvercountRatio.toFixed(2)), 4.17);   // 75/18
  assert.equal(s.aov, 47.66);
});

test('handles zero sessions without dividing by zero', () => {
  const s = computeScoreboard({ ga4Rows: [], orders: { count: 0, revenue: 0, aov: 0 } });
  assert.equal(s.sessions, 0);
  assert.equal(s.trueCvr, 0);
  assert.equal(s.ga4Cvr, 0);
  assert.equal(s.ga4OvercountRatio, null);
});

test('aggregates channels', () => {
  const ga4Rows = [
    { page: '/a', channel: 'Organic Search', sessions: 50, conversions: 1, revenue: 10 },
    { page: '/b', channel: 'Organic Search', sessions: 30, conversions: 2, revenue: 5 },
    { page: '/c', channel: 'Direct', sessions: 20, conversions: 4, revenue: 40 },
  ];
  const s = computeScoreboard({ ga4Rows, orders: { count: 5, revenue: 200, aov: 40 } });
  assert.equal(s.byChannel['Organic Search'].sessions, 80);
  assert.equal(s.byChannel['Organic Search'].conversions, 3);
  assert.equal(s.byChannel['Direct'].sessions, 20);
});
