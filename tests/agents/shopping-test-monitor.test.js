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

test('classify: deeply unprofitable after EITHER a conversion base or the click floor', () => {
  const deep = computeMetrics({ campaign: { name: 'x' }, metrics: { clicks: 300, costMicros: 100_000_000, conversions: 20, conversionsValue: 30 } });
  assert.equal(classifyCampaign(deep).verdict, 'unprofitable'); // 0.3x after 20 conv

  // DELIBERATE CHANGE, 2026-09-01. This case (300 clicks, 3 conv, 0.3x) previously
  // asserted "too few conv to judge". It now flags, and the reason is measured rather
  // than preferred: minConvForRoasJudgement is 15 while these campaigns produce roughly
  // ONE conversion per five months, so the conversion floor alone is not a safety
  // threshold — it is an off switch. A campaign with a single lucky conversion sat at
  // 0.17x for months reading 'watch'. Clicks are an independent sufficiency signal, and
  // 300 of them make a 0.3x reading real. The gate never auto-pauses, so a false
  // positive costs a line in a digest while the false negative cost $139.85 in 18 days.
  const early = computeMetrics({ campaign: { name: 'x' }, metrics: { clicks: 300, costMicros: 100_000_000, conversions: 3, conversionsValue: 30 } });
  assert.equal(classifyCampaign(early).verdict, 'unprofitable');

  // The guard that genuinely mattered survives: below the click floor, thin data still
  // cannot condemn a campaign on either axis.
  const thin = computeMetrics({ campaign: { name: 'x' }, metrics: { clicks: 30, costMicros: 100_000_000, conversions: 3, conversionsValue: 30 } });
  assert.notEqual(classifyCampaign(thin).verdict, 'unprofitable');
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

// ── 2026-09-01: two holes that let a slow-burning campaign bleed forever ──────────
//
// Found by auditing why nothing alerted while the account spent $139.85 over 18 days
// for $0. Both campaigns read 'learning' every single day. Two independent causes:
//
//   1. summarize() classified ONLY the trailing window. At ~$7.75/day these campaigns
//      accumulate 59-67 clicks per 14-day window, below the 150-click floor, so the
//      verdict was permanently 'learning' while LIFETIME sat at 275 and 360 clicks.
//   2. Even lifetime did not fire: dead_spend needs conversions === 0 and both
//      campaigns had exactly ONE lucky conversion; unprofitable needs 15 conversions,
//      which at ~1 conversion per 5 months is not a safety threshold but an off switch.
//
// Both fixes below only ever ADD flags. Neither can remove one that fires today.

const lifeMetrics = (name, clicks, costMicros, conversions, conversionsValue) =>
  computeMetrics({ campaign: { id: name, name, status: 'ENABLED' },
    metrics: { impressions: 50_000, clicks, costMicros, conversions, conversionsValue } });

test('classify: past the click floor, a deeply unprofitable ROAS flags without 15 conversions', () => {
  // Real lifetime state of RSC | Shopping Test | Lotion - Coconut Breeze on 2026-08-31.
  const m = lifeMetrics('coconut-breeze', 360, 215_110_000, 1, 37.49);
  assert.equal(m.roas, 0.17);
  assert.equal(classifyCampaign(m).verdict, 'unprofitable',
    '360 clicks at 0.17x is a real finding; one lucky conversion must not shield it');
});

test('classify: below the click floor, few conversions still cannot condemn on ROAS', () => {
  // The guard the 15-conversion floor was really protecting: too little traffic to judge.
  const m = lifeMetrics('early', 20, 20_000_000, 1, 4);
  assert.notEqual(classifyCampaign(m).verdict, 'unprofitable');
});

test('classify: healthy ROAS past the click floor is still ok, not flagged', () => {
  const m = lifeMetrics('good', 400, 100_000_000, 3, 150);
  assert.equal(classifyCampaign(m).verdict, 'ok');
});

test('summarize: lifetime dead spend flags even when the window is below the floor', () => {
  const recent = [lifeMetrics('brand', 59, 70_290_000, 0, 0)];       // 14d: reads 'learning'
  const lifetime = [lifeMetrics('brand', 275, 228_170_000, 1, 64)];  // lifetime: 0.28x
  const r = summarize(recent, lifetime);
  assert.equal(r.rows[0].verdict, 'learning', 'window verdict itself is unchanged');
  assert.equal(r.flags.length, 1, 'lifetime must escalate what the window cannot see');
  assert.equal(r.flags[0].scope, 'lifetime');
  assert.match(r.flags[0].reason, /lifetime/i, 'reason must say the finding is lifetime-scoped');
});

test('summarize: a campaign not spending in the window is not escalated', () => {
  // Already paused — there is no live bleeding to stop, and a flag here is pure noise.
  const recent = [lifeMetrics('paused', 0, 0, 0, 0)];
  const lifetime = [lifeMetrics('paused', 900, 500_000_000, 0, 0)];
  assert.equal(summarize(recent, lifetime).flags.length, 0);
});

test('summarize: a window flag is not duplicated by its lifetime twin', () => {
  const recent = [lifeMetrics('dead', 200, 100_000_000, 0, 0)];
  const lifetime = [lifeMetrics('dead', 900, 500_000_000, 0, 0)];
  const r = summarize(recent, lifetime);
  assert.equal(r.flags.length, 1);
  assert.equal(r.flags[0].scope, 'window', 'the window is the more urgent scope; report it once');
});

test('summarize: both real campaigns flag under the fixed gate', () => {
  const recent = [
    lifeMetrics('RSC | Brand | Search', 59, 70_290_000, 0, 0),
    lifeMetrics('RSC | Shopping Test | Lotion - Coconut Breeze', 67, 35_440_000, 0, 0),
  ];
  const lifetime = [
    lifeMetrics('RSC | Brand | Search', 275, 228_170_000, 1, 64),
    lifeMetrics('RSC | Shopping Test | Lotion - Coconut Breeze', 360, 215_110_000, 1, 37.49),
  ];
  assert.equal(summarize(recent, lifetime).flags.length, 2,
    'the exact production state on 2026-08-31 must not read as a clean run');
});
