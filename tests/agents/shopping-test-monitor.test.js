import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  computeMetrics,
  selectCampaigns,
  classifyCampaign,
  summarize,
  buildMarkdown,
  DEFAULTS,
} from '../../agents/shopping-test-monitor/index.js';

test('computeMetrics derives ROAS/CPC/CVR from raw row', () => {
  const m = computeMetrics({
    campaign: { id: '1', name: 'RSC | Shopping Test | Lotion - Pure Unscented', status: 'ENABLED' },
    metrics: { impressions: 500, clicks: 20, costMicros: 6_000_000, conversions: 2, conversionsValue: 60 },
  });
  assert.equal(m.spend, 6);
  assert.equal(m.avgCpc, 0.3);
  assert.equal(m.roas, 10);      // $60 / $6
  assert.equal(m.cvr, 0.1);      // 2/20
  assert.equal(m.conversions, 2);
});

test('classify: no spend = no_spend, not a flag', () => {
  const m = computeMetrics({ campaign: { name: 'x' }, metrics: {} });
  assert.equal(classifyCampaign(m).verdict, 'no_spend');
});

test('classify: 1x+ ROAS is ok (the revised gate)', () => {
  const m = computeMetrics({ campaign: { name: 'x' }, metrics: { clicks: 10, costMicros: 5_000_000, conversions: 1, conversionsValue: 5 } });
  assert.equal(classifyCampaign(m).verdict, 'ok'); // ROAS exactly 1.0
});

test('classify: ROAS between 0.5 and 1 with few conv is watch, not a flag', () => {
  const m = computeMetrics({ campaign: { name: 'x' }, metrics: { clicks: 10, costMicros: 10_000_000, conversions: 1, conversionsValue: 8 } });
  assert.equal(classifyCampaign(m).verdict, 'watch'); // 0.8x, only 1 conv
});

test('classify: many clicks, zero conversions = dead_spend flag', () => {
  const m = computeMetrics({ campaign: { name: 'x' }, metrics: { clicks: 160, costMicros: 12_000_000, conversions: 0, conversionsValue: 0 } });
  assert.equal(classifyCampaign(m).verdict, 'dead_spend');
});

test('classify: below dead-click threshold with no conv is learning, not a flag', () => {
  // 27 clicks / 0 conv was the real Jul-2026 state; at a ~0.82% CVR that expects
  // 0.22 conversions, so a zero there carries no information.
  const m = computeMetrics({ campaign: { name: 'x' }, metrics: { clicks: 27, costMicros: 43_510_000, conversions: 0, conversionsValue: 0 } });
  const { verdict, reason } = classifyCampaign(m);
  assert.equal(verdict, 'learning');
  assert.match(reason, /search-term quality and CTR/);
});

test('classify: 45 clicks with no conv is no longer flagged as dead spend', () => {
  const m = computeMetrics({ campaign: { name: 'x' }, metrics: { clicks: 45, costMicros: 12_000_000, conversions: 0, conversionsValue: 0 } });
  assert.equal(classifyCampaign(m).verdict, 'learning');
});

test('classify: deeply unprofitable only after a conversion base', () => {
  const deep = computeMetrics({ campaign: { name: 'x' }, metrics: { clicks: 300, costMicros: 100_000_000, conversions: 20, conversionsValue: 30 } });
  assert.equal(classifyCampaign(deep).verdict, 'unprofitable'); // 0.3x after 20 conv
  const early = computeMetrics({ campaign: { name: 'x' }, metrics: { clicks: 300, costMicros: 100_000_000, conversions: 3, conversionsValue: 30 } });
  assert.notEqual(classifyCampaign(early).verdict, 'unprofitable'); // too few conv to judge
});

test('summarize aggregates totals and collects only real flags', () => {
  const recent = [
    computeMetrics({ campaign: { name: 'A', status: 'ENABLED' }, metrics: { clicks: 160, costMicros: 6_000_000, conversions: 0, conversionsValue: 0 } }),
    computeMetrics({ campaign: { name: 'B', status: 'ENABLED' }, metrics: { clicks: 10, costMicros: 4_000_000, conversions: 1, conversionsValue: 46 } }),
  ];
  const out = summarize(recent, recent);
  assert.equal(out.totals.spend, 10);
  assert.equal(out.totals.revenue, 46);
  assert.equal(out.flags.length, 1);          // only campaign A
  assert.equal(out.flags[0].verdict, 'dead_spend');
  // markdown renders without throwing
  const md = buildMarkdown(out, { start: '2026-07-08', end: '2026-07-21', days: 14 });
  assert.match(md, /Needs attention/);
});

test('DEFAULTS are permissive per the 1x directive', () => {
  assert.equal(DEFAULTS.watchRoas, 1.0);
  assert.ok(DEFAULTS.deadClicks >= 150, 'zero-conversion results need a real statistical floor');
});

// --- Campaign scope -----------------------------------------------------------------
// Added 2026-08-12. The monitor watched only 'RSC | Shopping Test%', so when
// 'RSC | Brand | Search' was unpaused it was invisible to the daily spend report —
// the one campaign we had just been asked to watch closely. Widening the net to all
// RSC campaigns would drag in a dozen long-dead paused campaigns, so selection is:
// currently ENABLED, or spent money in the window.

test('selectCampaigns includes every enabled RSC campaign, not just Shopping Test', () => {
  const rows = [
    { name: 'RSC | Shopping Test | Lotion - Coconut Breeze', status: 'ENABLED', spend: 2.5 },
    { name: 'RSC | Brand | Search', status: 'ENABLED', spend: 0 },
  ];
  assert.deepEqual(selectCampaigns(rows).map((r) => r.name),
    ['RSC | Shopping Test | Lotion - Coconut Breeze', 'RSC | Brand | Search']);
});

test('selectCampaigns keeps a paused campaign that still spent in the window', () => {
  // Spend after a pause is real money and must stay visible until it stops.
  const rows = [{ name: 'RSC | Brand | Search', status: 'PAUSED', spend: 12.4 }];
  assert.deepEqual(selectCampaigns(rows).map((r) => r.name), ['RSC | Brand | Search']);
});

test('selectCampaigns drops long-dead paused campaigns with no spend', () => {
  const rows = [
    { name: 'RSC | Sensitive Skin Set | Search | Validation', status: 'PAUSED', spend: 0 },
    { name: 'RSC | Coconut Oil Lotion Dry Skin | Search', status: 'PAUSED', spend: 0 },
  ];
  assert.deepEqual(selectCampaigns(rows), []);
});

// A campaign name containing "|" (every RSC campaign does) must not blow apart the
// markdown table. Before escaping, "RSC | Brand | Search" rendered as three extra
// columns and the digest table collapsed.
test('buildMarkdown escapes pipes in campaign names', () => {
  const rows = [{
    name: 'RSC | Brand | Search', status: 'ENABLED', spend: 51.16, clicks: 46,
    avgCpc: 1.11, conversions: 0, revenue: 0, roas: 0, ctr: 0.05, impressions: 900,
    verdict: 'learning', reason: 'early',
  }];
  const totals = { spend: 51.16, revenue: 0, roas: 0, clicks: 46, ctr: 0.05, avgCpc: 1.11, conversions: 0, impressions: 900 };
  const md = buildMarkdown({ rows, totals, lifetime: totals, flags: [] },
    { start: '2026-07-22', end: '2026-08-11', days: 21 });
  const row = md.split('\n').find((l) => l.includes('Brand'));
  assert.ok(row.includes('RSC \\| Brand \\| Search'), `pipes not escaped: ${row}`);
  // 9 data columns => 10 pipe-delimited segments; unescaped pipes would inflate this.
  assert.equal(row.split(/(?<!\\)\|/).length - 2, 9, `wrong column count: ${row}`);
});
