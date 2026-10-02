import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateRules, metaPurchaseCount, taggedOrders, renderTestLines } from '../../lib/ad-test-rules.js';
import { checkTest } from '../../agents/ad-test-monitor/index.js';

const rules = { minImpressionsForCtr: 3000, minLinkCtr: 0.01, maxSpendWithoutPurchase: 150, maxCostPerPurchase: 60, costPerPurchaseAfter: 2 };
const m = (o) => ({ spend: 0, impressions: 0, linkClicks: 0, shopifyPurchases: 0, metaPurchases: 0, ...o });

test('too early: under every threshold', () => {
  assert.equal(evaluateRules(m({ spend: 20, impressions: 1500, linkClicks: 5 }), rules).status, 'early');
});

test('low CTR stops only after the impression floor', () => {
  assert.equal(evaluateRules(m({ spend: 40, impressions: 2999, linkClicks: 10 }), rules).status, 'early');
  const e = evaluateRules(m({ spend: 40, impressions: 3000, linkClicks: 29 }), rules);
  assert.equal(e.status, 'stop');
  assert.match(e.reasons[0], /0\.97% is under 1\.00%/);
});

test('no-purchase stop needs BOTH sources at zero', () => {
  assert.equal(evaluateRules(m({ spend: 150, impressions: 9000, linkClicks: 200 }), rules).status, 'stop');
  assert.equal(evaluateRules(m({ spend: 150, impressions: 9000, linkClicks: 200, metaPurchases: 1 }), rules).status, 'ok');
  assert.equal(evaluateRules(m({ spend: 150, impressions: 9000, linkClicks: 200, shopifyPurchases: 1 }), rules).status, 'ok');
});

test('cost per purchase uses the larger count, only from the second purchase', () => {
  assert.equal(evaluateRules(m({ spend: 100, impressions: 9000, linkClicks: 200, shopifyPurchases: 1 }), rules).status, 'ok');
  assert.equal(evaluateRules(m({ spend: 130, impressions: 9000, linkClicks: 200, shopifyPurchases: 2 }), rules).status, 'stop');
  assert.equal(evaluateRules(m({ spend: 130, impressions: 9000, linkClicks: 200, shopifyPurchases: 2, metaPurchases: 3 }), rules).status, 'ok');
});

test('meta purchases read the pixel action; tagged orders skip cancelled ones', () => {
  assert.equal(metaPurchaseCount([{ action_type: 'link_click', value: '9' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: '2' }]), 2);
  assert.equal(metaPurchaseCount([]), 0);
  const o = taggedOrders([{ landing_site: '/products/x?trybe=abc' }, { landing_site: '/', }, { landing_site: '/?trybe=z', cancelled_at: 'x' }], 'trybe=');
  assert.equal(o.length, 1);
});

test('checkTest credits each Shopify order to the campaign whose ad it came through', async () => {
  const pages = {
    c1: { effective_status: 'ACTIVE' }, 'c1/ads': { data: [{ name: 'Taylor_Lotion_trybe=aaa111' }] },
    'c1/insights': { data: [{ spend: '40.00', impressions: '4000', inline_link_clicks: '60', actions: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '1' }] }] },
    c2: { effective_status: 'ACTIVE' }, 'c2/ads': { data: [{ name: 'Taylor_Soap_trybe=bbb222' }] },
    'c2/insights': { data: [] },
  };
  const fetchImpl = async (url) => new Response(JSON.stringify(pages[new URL(url).pathname.replace('/v21.0/', '')] || { error: { message: 'nope' } }));
  const test = { name: 't', startDate: '2026-10-02', endDate: '2026-10-16', landingTag: 'trybe=', campaigns: [{ id: 'c1', label: 'Cold' }, { id: 'c2', label: 'Warm' }], rules };
  const r = await checkTest(test, {
    token: 'k', now: Date.parse('2026-10-05T12:00:00Z'), fetchImpl,
    loadOrders: async () => ({ orders: [{ name: '#1', landing_site: '/products/coconut-lotion?trybe=aaa111', total_price: '24.00' }, { name: '#2', landing_site: '/' }] }),
  });
  assert.equal(r.rows[0].shopifyPurchases, 1);
  assert.equal(r.rows[1].shopifyPurchases, 0);
  assert.equal(r.rows[1].spend, 0);
  const text = renderTestLines(test, r.rows, { ...r, tokenDaysLeft: 5, now: Date.parse('2026-10-05T12:00:00Z') }).join('\n');
  assert.match(text, /day 4 of 14/);
  assert.match(text, /purchases 1 on Shopify \/ 1 per Meta/);
  assert.match(text, /token expires in 5 day/);
});

test('the monitor never writes to Meta (source scan)', () => {
  const src = readFileSync(new URL('../../agents/ad-test-monitor/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /method:\s*['"]POST|status=PAUSED|'PAUSED'/);
});
