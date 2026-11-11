import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gatherGrowthInputs, generateGrowthRecs, growthRecProblems } from '../../lib/growth-recs.js';

const inputs = { aov_trailing_90d: 50.39, quick_wins: { rows: [{ page: '/p', impressions: 4200, ctr: 0.5 }] }, missing: [] };
const good = (move, ev = 'The page has 4,200 impressions at 0.5% CTR.') =>
  ({ move, evidence: ev, dollars_low: 50, dollars_high: 150, status: 'needs-decision' });
const fake = (...replies) => {
  let i = 0; const calls = [];
  return { calls, messages: { create: async (p) => { calls.push(p); const r = replies[Math.min(i++, replies.length - 1)]; return { content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r) }], stop_reason: 'end_turn' }; } } };
};

test('invented number in evidence is dropped and named', async () => {
  const bad = good('Rewrite title', 'It gets 9,999 impressions.');
  const c = fake([bad, good('A'), good('B')], [bad, good('A'), good('B')]);
  const r = await generateGrowthRecs({ inputs, client: c });
  assert.equal(r.recs.length, 2);
  assert.match(r.dropped[0].reason, /9,999/);
  assert.match(c.calls[1].messages[0].content, /9,999/);
});

test('claim gate drops "heals eczema"', () => {
  const p = growthRecProblems(good('Say our lotion heals eczema'), JSON.stringify(inputs));
  assert.ok(p.some((x) => /claim gate/.test(x)));
});

test('em dash and bad dollars are problems', () => {
  const t = JSON.stringify(inputs);
  assert.ok(growthRecProblems(good('Do x — now'), t).some((x) => /em dash/.test(x)));
  assert.ok(growthRecProblems({ ...good('x'), dollars_low: 9, dollars_high: 1 }, t).length);
});

test('malformed reply retries once then returns empty with reason', async () => {
  const c = fake('not json');
  const r = await generateGrowthRecs({ inputs, client: c });
  assert.equal(c.calls.length, 2);
  assert.deepEqual(r.recs, []);
  assert.match(r.reason, /JSON/);
});

test('valid recs pass, fewer than 2 survivors returns empty', async () => {
  const ok = await generateGrowthRecs({ inputs, client: fake([good('A'), good('B'), good('C')]) });
  assert.equal(ok.recs.length, 3);
  const bad = good('Z', 'It gets 777 clicks.');
  const few = await generateGrowthRecs({ inputs, client: fake([bad, good('A')]) });
  assert.deepEqual(few.recs, []);
  assert.ok(few.reason);
});

test('gatherGrowthInputs lists stale and missing sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'growth-'));
  mkdirSync(join(root, 'data/reports/quick-wins'), { recursive: true });
  mkdirSync(join(root, 'data/reports/gsc-opportunity'), { recursive: true });
  writeFileSync(join(root, 'data/reports/quick-wins/latest.json'), JSON.stringify({ generated_at: '2020-01-01T00:00:00Z', rows: [] }));
  writeFileSync(join(root, 'data/reports/gsc-opportunity/latest.json'), JSON.stringify({ generated_at: new Date().toISOString(), rows: [1] }));
  const i = gatherGrowthInputs(root);
  assert.ok(i.gsc_opportunity);
  assert.equal(i.quick_wins, undefined);
  const m = Object.fromEntries(i.missing.map((x) => [x.source, x.reason]));
  assert.match(m.quick_wins, /stale/);
  assert.equal(m.seo_impact || m['seo-impact'], 'missing');
  assert.equal(m.ctr_program, 'missing');
  assert.match(m.commercial_cvr, /not computed/);
});

// ---- fix round 1 ----
import { SHOPIFY_MONTHLY_REVENUE } from '../../lib/business-baseline.js';

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const mkroot = () => mkdtempSync(join(tmpdir(), 'growth-'));
const put = (root, rel, obj) => { mkdirSync(join(root, rel, '..'), { recursive: true }); writeFileSync(join(root, rel), JSON.stringify(obj)); };

test('fresh seo-impact report yields a cluster efficiency ranking and not_converting', () => {
  const root = mkroot();
  put(root, 'data/reports/seo-impact/latest.json', {
    generated_at: new Date().toISOString(),
    clusters: [
      { cluster: 'lotion', clicks: 106, pages: 39, entry_page_organic_revenue: 666.73 },
      { cluster: 'toothpaste', clicks: 640, pages: 24, entry_page_organic_revenue: 18.99 },
    ],
    clusters_product_wide: [
      { cluster: 'lotion', product_revenue_all_channels: 1757.1, entry_page_organic_revenue: 666.73 },
      { cluster: 'toothpaste', product_revenue_all_channels: 71.5, entry_page_organic_revenue: 18.99 },
    ],
    cluster_product_meta: { wide_window: { days: 90 }, wide_orders_all_channels: 50 },
    not_converting: [{ page: '/blogs/news/x', clicks: 40 }],
    totals: { organic_revenue: 363.55 },
  });
  const i = gatherGrowthInputs(root);
  assert.ok(i.cluster_efficiency, JSON.stringify(i.missing));
  const rows = i.cluster_efficiency.ranking;
  assert.equal(rows[0].cluster, 'lotion');
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[1].clicks, 640);
  assert.equal(rows[1].product_revenue, 71.5);
  assert.equal(i.seo_impact.not_converting.length, 1);
});

test('unavailable ranking is listed in missing with a reason', () => {
  const root = mkroot();
  put(root, 'data/reports/seo-impact/latest.json', { generated_at: new Date().toISOString(), clusters: [], totals: {} });
  const i = gatherGrowthInputs(root);
  assert.equal(i.cluster_efficiency, undefined);
  const m = i.missing.find((x) => x.source === 'cluster_efficiency');
  assert.ok(m && m.reason);
});

test('number check ignores timestamps, dates and ids; applies to move', () => {
  const inp = { seo_impact: { generated_at: '2026-11-10T05:06:07Z', id: 5099369750, resourceName: 'customers/5099369750/campaigns/24390990425' }, spend: 12.5, missing: [] };
  const t = JSON.stringify(inp);
  const p = (rec) => growthRecProblems({ ...good('x'), ...rec }, t, inp);
  assert.ok(p({ evidence: 'It has 5 pages.' }).some((x) => /\b5\b/.test(x)));
  assert.ok(p({ evidence: 'Seen in 2026.' }).some((x) => /2026/.test(x)));
  assert.ok(p({ evidence: 'Cost 24390990425.' }).length);
  assert.ok(p({ move: 'Fix the 7 worst pages', evidence: 'Spend was $12.50.' }).some((x) => /\b7\b/.test(x)));
  assert.deepEqual(p({ evidence: 'Spend was $12.50.' }), []);
});

test('google ads: sums the last 7 days by date field and labels the window', () => {
  const root = mkroot();
  const day = (d, spend) => ({ date: d, spend, clicks: 10, conversions: 1, revenue: 20, campaigns: [{ name: 'A', spend }, { name: 'B', spend: 0.1 }] });
  for (const [d, s] of [[today(), 3], [daysAgo(1), 2], [daysAgo(2), 1], [daysAgo(20), 99]]) put(root, `data/snapshots/google-ads/${d}.json`, day(d, s));
  const g = gatherGrowthInputs(root).google_ads;
  assert.equal(g.days, 3);
  assert.equal(g.spend, 6);
  assert.equal(g.clicks, 30);
  assert.match(g.window, /^3 days ending /);
  assert.equal(g.top_campaigns[0].name, 'A');
});

test('prompt states each input window', async () => {
  const c = fake([good('A'), good('B')]);
  await generateGrowthRecs({ inputs, client: c });
  assert.match(c.calls[0].system, /window/i);
});

test('dollar ranges are capped at 10x monthly revenue and may not be negative', () => {
  const t = JSON.stringify(inputs);
  const big = { ...good('x'), dollars_high: SHOPIFY_MONTHLY_REVENUE * 10 + 1 };
  assert.ok(growthRecProblems(big, t).length);
  assert.ok(growthRecProblems({ ...good('x'), dollars_low: -1 }, t).length);
  assert.deepEqual(growthRecProblems({ ...good('x'), dollars_high: SHOPIFY_MONTHLY_REVENUE * 10 }, t), []);
});

test('first-pass problems stay in dropped, flagged fixed_on_retry when the retry fixes them', async () => {
  const bad = good('Rewrite title', 'It gets 9,999 impressions.');
  const r = await generateGrowthRecs({ inputs, client: fake([bad, good('A'), good('B')], [good('Rewrite title'), good('A'), good('B')]) });
  assert.equal(r.recs.length, 3);
  assert.equal(r.dropped.length, 1);
  assert.equal(r.dropped[0].fixed_on_retry, true);
  assert.match(r.dropped[0].reason, /9,999/);
});

test('commercial cvr reason says why', () => {
  const i = gatherGrowthInputs(mkroot());
  assert.match(i.missing.find((x) => x.source === 'commercial_cvr').reason, /needs GA4 network read/);
});
