import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  computeMetrics,
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
  const m = computeMetrics({ campaign: { name: 'x' }, metrics: { clicks: 45, costMicros: 12_000_000, conversions: 0, conversionsValue: 0 } });
  assert.equal(classifyCampaign(m).verdict, 'dead_spend');
});

test('classify: below dead-click threshold with no conv is only watch', () => {
  const m = computeMetrics({ campaign: { name: 'x' }, metrics: { clicks: 12, costMicros: 4_000_000, conversions: 0, conversionsValue: 0 } });
  assert.equal(classifyCampaign(m).verdict, 'watch');
});

test('classify: deeply unprofitable only after a conversion base', () => {
  const deep = computeMetrics({ campaign: { name: 'x' }, metrics: { clicks: 300, costMicros: 100_000_000, conversions: 20, conversionsValue: 30 } });
  assert.equal(classifyCampaign(deep).verdict, 'unprofitable'); // 0.3x after 20 conv
  const early = computeMetrics({ campaign: { name: 'x' }, metrics: { clicks: 300, costMicros: 100_000_000, conversions: 3, conversionsValue: 30 } });
  assert.notEqual(classifyCampaign(early).verdict, 'unprofitable'); // too few conv to judge
});

test('summarize aggregates totals and collects only real flags', () => {
  const recent = [
    computeMetrics({ campaign: { name: 'A', status: 'ENABLED' }, metrics: { clicks: 45, costMicros: 6_000_000, conversions: 0, conversionsValue: 0 } }),
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
  assert.ok(DEFAULTS.deadClicks >= 30);
});
