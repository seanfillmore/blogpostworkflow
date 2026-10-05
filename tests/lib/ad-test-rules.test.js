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

// ── Creative graduation readout (2026-10-04) ────────────────────────────────────
import { evaluateGraduation, readoutDue, adOrderTag, metaAddToCartCount, renderCreativeLines, shortCreativeName } from '../../lib/ad-test-rules.js';

const grad = { minSpend: 150, minLinkCtr: 0.015, maxCostPerLinkClick: 1.5, minAddToCarts: 5, minPurchases: 1 };
const c = (o) => ({ spend: 0, impressions: 0, linkClicks: 0, addToCarts: 0, purchases: 0, ...o });

test('graduation: collecting until the spend floor, whatever the ratios', () => {
  assert.equal(evaluateGraduation(c({ spend: 149.99, impressions: 1000, linkClicks: 100, addToCarts: 9 }), grad).status, 'collecting');
});

test('graduation: ready needs CTR, cost per click and add-to-carts together', () => {
  const ok = c({ spend: 150, impressions: 10000, linkClicks: 150, addToCarts: 5 }); // 1.5% CTR, $1.00/click
  assert.equal(evaluateGraduation(ok, grad).status, 'ready');
  assert.equal(evaluateGraduation({ ...ok, linkClicks: 149 }, grad).status, 'below');          // CTR 1.49%
  assert.equal(evaluateGraduation({ ...ok, impressions: 5000, linkClicks: 99 }, grad).status, 'below'); // $1.52/click
  assert.equal(evaluateGraduation({ ...ok, addToCarts: 4 }, grad).status, 'below');
  assert.equal(evaluateGraduation({ ...ok, addToCarts: 0, purchases: 1 }, grad).status, 'ready'); // a purchase stands in for carts
});

test('graduation: no clicks at all reads as below, not as an error', () => {
  const e = evaluateGraduation(c({ spend: 200, impressions: 5000 }), grad);
  assert.equal(e.status, 'below');
  assert.equal(e.cpc, null);
});

test('readout cadence counts calendar days in UTC', () => {
  const d = (s) => Date.parse(s);
  assert.equal(readoutDue(null, d('2026-10-05T12:10Z'), 3), true);
  assert.equal(readoutDue('2026-10-05T12:10:00Z', d('2026-10-07T12:10Z'), 3), false);
  assert.equal(readoutDue('2026-10-05T12:10:00Z', d('2026-10-08T12:09Z'), 3), true); // a minute earlier is still day 3
});

test('order tags: Trybe id from the ad name, utm_content from url_tags, else null', () => {
  assert.equal(adOrderTag({ name: 'X_20261003_trybe=cce706a9' }), 'trybe=cce706a9');
  assert.equal(adOrderTag({ name: 'RSC | split', urlTags: 'utm_source=facebook&utm_content=sensitive-skin-split' }), 'utm_content=sensitive-skin-split');
  assert.equal(adOrderTag({ name: 'RSC | DPA' }), null);
});

test('tagged orders accept several tags', () => {
  const o = taggedOrders([{ landing_site: '/?trybe=a' }, { landing_site: '/?utm_campaign=creative-test-2026-10' }, { landing_site: '/' }], ['trybe=', 'utm_campaign=creative-test-2026-10']);
  assert.equal(o.length, 2);
});

test('add to carts read the pixel action', () => {
  assert.equal(metaAddToCartCount([{ action_type: 'offsite_conversion.fb_pixel_add_to_cart', value: '3' }]), 3);
});

test('readout lists ready creatives first and names them briefly', () => {
  const rows = [
    { name: 'Trybe | TaylorCopp_Non-ToxicBodyLotionMadeWithOnly6CleanIngredients_20261002_trybe=9638b656', ...c({ spend: 10 }), eval: { status: 'collecting', ctr: null, cpc: null, misses: [] } },
    { name: 'EverittModer_MoisturizingCoconutSoap|3.4oz_20261004_trybe=75427b73', ...c({ spend: 160, impressions: 9000, linkClicks: 150, addToCarts: 6 }), eval: { status: 'ready', ctr: 0.0167, cpc: 1.07, misses: [] } },
  ];
  const lines = renderCreativeLines(rows, grad);
  assert.match(lines[0], /1 ready, 0 below the bar, 1 still collecting/);
  assert.match(lines[1], /READY TO GRADUATE: Everitt Moder · Bar Soap · 75427b73/);
  assert.equal(shortCreativeName('RSC | Sensitive Skin Set | split'), 'RSC | Sensitive Skin Set | split');
});
