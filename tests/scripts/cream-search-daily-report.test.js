import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { buildReport, taggedOrders, shouldReport, ptDate, TARGET_CLICKS } from '../../scripts/cream-search-daily-report.mjs';

const order = (name, created_at, landing_site, total_price = '56.00') => ({ name, created_at, landing_site, total_price });

test('taggedOrders keeps only the campaign tag, bounded by PT date', () => {
  const orders = [
    order('#1', '2026-11-10T18:00:00Z', '/pages/coconut-body-cream?v=coconut&utm_campaign=gsearch-cream-presell'),
    order('#2', '2026-11-10T18:00:00Z', '/products/coconut-lotion?utm_campaign=other'),
    // 2026-11-11 05:00 UTC is still 2026-11-10 in PT
    order('#3', '2026-11-11T05:00:00Z', '/pages/coconut-body-cream?utm_campaign=gsearch-cream-presell'),
    order('#4', '2026-11-11T18:00:00Z', '/x?utm_campaign=gsearch-cream-presell'),
  ];
  assert.deepEqual(taggedOrders(orders, { fromDate: '2026-11-10', toDate: '2026-11-10' }).map((o) => o.name), ['#1', '#3']);
  assert.deepEqual(taggedOrders(orders, { fromDate: '2026-11-08' }).map((o) => o.name), ['#1', '#3', '#4']);
});

test('shouldReport goes quiet only when paused AND idle yesterday', () => {
  assert.equal(shouldReport({ status: 'ENABLED', yesterdayCostMicros: 0 }), true);
  assert.equal(shouldReport({ status: 'PAUSED', yesterdayCostMicros: '1000000' }), true);
  assert.equal(shouldReport({ status: 'PAUSED', yesterdayCostMicros: 0 }), false);
});

test('ptDate uses the Pacific calendar', () => {
  assert.equal(ptDate(new Date('2026-11-12T06:00:00Z')), '2026-11-11');
  assert.equal(ptDate(new Date('2026-11-12T14:15:00Z'), -1), '2026-11-11');
});

test('buildReport states progress, pace and orders', () => {
  const r = buildReport({
    today: '2026-11-15', yesterdayDate: '2026-11-14', status: 'ENABLED', budgetMicros: '30000000',
    total: { impressions: '1000', clicks: '40', costMicros: '48000000', averageCpc: '1200000' },
    yesterday: { impressions: '300', clicks: '10', costMicros: '12000000', averageCpc: '1200000', searchImpressionShare: 0.35 },
    keywords: [
      { adGroupCriterion: { keyword: { text: 'thick body cream' }, effectiveCpcBidMicros: '1250000', qualityInfo: { qualityScore: 5 }, positionEstimates: { topOfPageCpcMicros: '1220000' } }, metrics: { impressions: '50', clicks: '2', costMicros: '2400000' } },
      { adGroupCriterion: { keyword: { text: 'coconut oil cream' }, effectiveCpcBidMicros: '1150000' }, metrics: { impressions: '400', clicks: '20', costMicros: '24000000' } },
    ],
    terms: [],
    ordersAll: [order('#9', '2026-11-14T18:00:00Z', '/pages/coconut-body-cream?utm_campaign=gsearch-cream-presell', '60.00')],
    ordersYesterday: [order('#9', '2026-11-14T18:00:00Z', '/x', '60.00')],
  });
  assert.match(r.subject, /^Cream Search 2026-11-14: 10 click\(s\), \$12\.00, 1 order\(s\) · test 40\/150 clicks, \$48\.00, 1 order\(s\)$/);
  assert.match(r.body, new RegExp(`40/${TARGET_CLICKS} \\(110 to go; ~11 more day\\(s\\)`));
  assert.match(r.body, /ROAS 1\.25x/);
  assert.match(r.body, /Impression share 35%/);
  // keywords sorted by clicks, missing estimate shown as '?'
  assert.ok(r.body.indexOf('coconut oil cream: bid $1.15 (top ?), QS -') < r.body.indexOf('thick body cream: bid $1.25 (top $1.22), QS 5'));
  assert.match(r.body, /#9 2026-11-14 \$60\.00/);
});

test('buildReport says the read is due at 150 clicks', () => {
  const r = buildReport({ today: 'x', yesterdayDate: 'y', status: 'ENABLED', total: { clicks: '150' }, yesterday: {}, keywords: [], terms: [], ordersAll: [], ordersYesterday: [] });
  assert.match(r.body, /READ IS DUE/);
});

test('the script never writes to Google Ads', () => {
  const src = readFileSync(new URL('../../scripts/cream-search-daily-report.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\bmutate\b/);
});

import { buildHtml, verdict, niceDate } from '../../scripts/cream-search-daily-report.mjs';

const base = { today: '2026-11-15', yesterdayDate: '2026-11-14', status: 'ENABLED', budgetMicros: '30000000', terms: [], ordersAll: [], ordersYesterday: [] };

test('verdict names what limited the campaign', () => {
  assert.match(verdict({ total: { clicks: 150 }, yesterday: {} }), /read is due/);
  assert.match(verdict({ total: {}, yesterday: { impressions: 0 } }), /No impressions/);
  assert.match(verdict({ total: {}, yesterday: { impressions: 50, searchRankLostImpressionShare: 0.9, searchBudgetLostImpressionShare: 0 } }), /^Bid-limited: lost 90%/);
  assert.match(verdict({ total: {}, yesterday: { impressions: 50, searchRankLostImpressionShare: 0.1, searchBudgetLostImpressionShare: 0.4 } }), /^Budget-limited: missed 40%/);
});

test('niceDate formats PT calendar dates without shifting them', () => {
  assert.equal(niceDate('2026-11-14'), 'Sat, Nov 14');
  assert.equal(niceDate('2026-11-08', false), 'Nov 8');
});

test('buildHtml: escapes search text, flags bids under top-of-page, lists unshown keywords', () => {
  const html = buildHtml({
    ...base,
    total: { impressions: '100', clicks: '30', costMicros: '36000000' },
    yesterday: { impressions: '40', clicks: '5', costMicros: '6000000' },
    keywords: [
      { adGroupCriterion: { keyword: { text: 'coconut moisturizer' }, effectiveCpcBidMicros: '1200000', positionEstimates: { topOfPageCpcMicros: '1660000' } }, metrics: { impressions: '5', clicks: '1' } },
      { adGroupCriterion: { keyword: { text: 'winter body cream' }, effectiveCpcBidMicros: '950000' }, metrics: { impressions: '0', clicks: '0' } },
    ],
    terms: [{ searchTermView: { searchTerm: '<b>cream</b>' }, metrics: { impressions: '3', clicks: '1' } }],
  });
  assert.match(html, /&lt;b&gt;cream&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>cream<\/b>/);
  assert.match(html, /color:#9a6700;">top \$1\.66/);
  assert.match(html, /Not shown yet:<\/b> winter body cream/);
  assert.match(html, /width:20%/); // 30 of 150 clicks
  assert.match(html, /Cream Search · Sat, Nov 14/);
});
