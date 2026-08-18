import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyOrder, attributionRows, shopifyRevenueByPage, SEARCH_HOSTS,
} from '../../lib/order-attribution.js';

// Fixtures lifted verbatim from live orders on 2026-08-17 so the classifier is
// pinned to shapes Shopify actually emits, not shapes we imagined.
const ORGANIC_FREE_LISTING = {
  id: 1, name: '#2334', created_at: '2026-08-17T05:02:58-06:00', total_price: '62.40',
  source_name: 'web',
  landing_site: '/products/organic-foaming-hand-soap?srsltid=AfmBOoo3pft2LsJxYxeiSv45mZDlTOXjHDB5YG24PHlBoUkWWI3RvyCt',
  referring_site: 'https://www.google.com/',
  discount_codes: [], note_attributes: [{ name: '', value: '' }],
};

const PAID_SHOPPING = {
  id: 2, name: '#2332', created_at: '2026-08-13T13:38:16-06:00', total_price: '37.49',
  source_name: 'web',
  landing_site: '/products/coconut-lotion?utm_content=sag_organic&gad_source=1&gclid=CjwKCAjw1vXTBhB-EiwAEKr_k_YHOyxD7Jv0zc5hJ1JvLc',
  referring_site: 'https://www.google.com/',
  discount_codes: [{ code: 'WEL30-4P2XTMQ8' }],
  note_attributes: [{ name: 'gclid', value: 'CjwKCAjw1vXTBhB-EiwAEKr_k_YHOyxD7Jv0zc5hJ1JvLchFK-QMH167Tmqdqr-YKVR3CEY3qcPw' }],
};

const ADMIN_PREVIEW = {
  id: 3, name: '#2331', created_at: '2026-08-12T22:09:49-06:00', total_price: '38.17',
  source_name: 'web', landing_site: '/online_store_preview',
  referring_site: 'https://admin.shopify.com/', discount_codes: [], note_attributes: [],
};

const BLOG_BRAVE = {
  id: 4, name: '#2330', created_at: '2026-08-12T10:14:14-06:00', total_price: '35.99',
  source_name: 'web', landing_site: '/blogs/news/best-non-toxic-body-lotion-2025',
  referring_site: 'https://search.brave.com/', discount_codes: [], note_attributes: [],
};

const DIRECT = {
  id: 5, name: '#2333', created_at: '2026-08-16T12:40:27-06:00', total_price: '35.99',
  source_name: 'web', landing_site: '/products/coconut-lotion',
  referring_site: null, discount_codes: [], note_attributes: [],
};

const SUBSCRIPTION = {
  id: 6, name: '#2325', created_at: '2026-08-03T10:01:22-06:00', total_price: '25.50',
  source_name: 'subscription_contract_checkout_one', landing_site: null, referring_site: null,
  discount_codes: [{ code: 'Subscription Free Shipping' }],
  note_attributes: [{ name: '_renewal_order', value: 'This is 2nd order of subscription 742859' }],
};

const TEST_ORDER = {
  id: 7, name: '#2326', created_at: '2026-08-03T19:53:19-06:00', total_price: '0.00',
  source_name: 'web', landing_site: '/', referring_site: null,
  discount_codes: [{ code: 'TEST100' }, { code: 'TESTSHIPPING' }], note_attributes: [],
};

const GMAIL_APP = {
  id: 8, name: '#2320', created_at: '2026-08-01T09:00:00-06:00', total_price: '25.50',
  source_name: 'web', landing_site: '/collections/deodorant',
  referring_site: 'android-app://com.google.android.gm/', discount_codes: [], note_attributes: [],
};

test('srsltid without gclid is organic, not paid', () => {
  const c = classifyOrder(ORGANIC_FREE_LISTING);
  assert.equal(c.paid, false);
  assert.equal(c.clickId, null);
  assert.equal(c.channel, 'organic-search');
  assert.equal(c.referrerHost, 'google.com');
  assert.equal(c.landingPath, '/products/organic-foaming-hand-soap');
  assert.equal(c.pageType, 'product');
});

test('gclid in landing_site marks the order paid', () => {
  const c = classifyOrder(PAID_SHOPPING);
  assert.equal(c.paid, true);
  assert.equal(c.channel, 'paid-search');
  assert.equal(c.clickId.type, 'gclid');
});

test('sag_organic in utm_content does NOT make a paid order organic', () => {
  // Shopify labels paid Shopping traffic `sag_organic`; the name is a trap.
  assert.equal(classifyOrder(PAID_SHOPPING).channel, 'paid-search');
});

test('gclid recovered from note_attributes when landing_site is truncated', () => {
  const truncated = {
    ...PAID_SHOPPING,
    landing_site: '/products/coconut-lotion?utm_content=sag_organic&gad_source=1&gclid=Cjw',
  };
  const c = classifyOrder(truncated);
  assert.equal(c.paid, true);
  // note_attributes holds the untruncated value, so prefer it
  assert.ok(c.clickId.value.length > 20);
});

test('a gclid truncated to a stump still classifies as paid', () => {
  // Shopify caps landing_site at 255 chars and Google puts gclid last, so the value is
  // routinely sliced to "CjwK". That stump is useless to UPLOAD (ads-conversions applies
  // a 20-char floor) but is still proof the click was paid. Classifying on the strict
  // check would relabel paid orders as organic and inflate SEO revenue.
  const stump = {
    ...PAID_SHOPPING,
    landing_site: '/products/coconut-lotion?utm_content=sag_organic&gclid=CjwK',
    note_attributes: [],
  };
  const c = classifyOrder(stump);
  assert.equal(c.paid, true);
  assert.equal(c.channel, 'paid-search');
  assert.equal(c.clickId, null, 'stump must not be offered as uploadable');
});

test('gad_source alone marks paid even with no click id', () => {
  const c = classifyOrder({
    ...ORGANIC_FREE_LISTING,
    landing_site: '/products/coconut-lotion?gad_source=1&gad_campaignid=24050427048',
    note_attributes: [],
  });
  assert.equal(c.paid, true);
});

test('admin preview orders are flagged as test, not revenue', () => {
  const c = classifyOrder(ADMIN_PREVIEW);
  assert.equal(c.isTest, true);
  assert.equal(c.channel, 'admin-preview');
});

test('TEST-prefixed discount codes flag a test order', () => {
  assert.equal(classifyOrder(TEST_ORDER).isTest, true);
});

test('brave and duckduckgo count as organic search', () => {
  assert.equal(classifyOrder(BLOG_BRAVE).channel, 'organic-search');
  assert.equal(classifyOrder(BLOG_BRAVE).pageType, 'blog');
  const ddg = classifyOrder({ ...BLOG_BRAVE, referring_site: 'https://duckduckgo.com/' });
  assert.equal(ddg.channel, 'organic-search');
  assert.equal(ddg.referrerHost, 'duckduckgo.com');
  assert.ok(SEARCH_HOSTS.has('duckduckgo.com'));
});

test('null referrer is direct, not organic', () => {
  const c = classifyOrder(DIRECT);
  assert.equal(c.channel, 'direct');
  assert.equal(c.referrerHost, null);
});

test('the Gmail android app referrer is email, not referral', () => {
  const c = classifyOrder(GMAIL_APP);
  assert.equal(c.channel, 'email');
  assert.equal(c.pageType, 'collection');
});

test('non-web source_name is a subscription renewal', () => {
  const c = classifyOrder(SUBSCRIPTION);
  assert.equal(c.channel, 'subscription');
  assert.equal(c.landingPath, null);
});

test('classified rows carry no PII', () => {
  const withPii = {
    ...DIRECT,
    email: 'buyer@example.com',
    browser_ip: '203.0.113.9',
    customer: { id: 99, email: 'buyer@example.com' },
    billing_address: { address1: '1 Main St' },
  };
  const c = classifyOrder(withPii);
  const serialized = JSON.stringify(c);
  assert.ok(!serialized.includes('buyer@example.com'), 'email leaked');
  assert.ok(!serialized.includes('203.0.113.9'), 'ip leaked');
  assert.ok(!serialized.includes('1 Main St'), 'address leaked');
});

test('cancelled orders are excluded from revenue but still recorded', () => {
  const c = classifyOrder({ ...DIRECT, cancelled_at: '2026-08-17T00:00:00Z' });
  assert.equal(c.cancelled, true);
  assert.equal(c.countsAsRevenue, false);
});

test('countsAsRevenue is false for test, zero-value and cancelled orders', () => {
  assert.equal(classifyOrder(DIRECT).countsAsRevenue, true);
  assert.equal(classifyOrder(TEST_ORDER).countsAsRevenue, false);
  assert.equal(classifyOrder(ADMIN_PREVIEW).countsAsRevenue, false);
  assert.equal(classifyOrder({ ...DIRECT, total_price: '0.00' }).countsAsRevenue, false);
});

test('attributionRows maps a list and tolerates junk', () => {
  const rows = attributionRows([ORGANIC_FREE_LISTING, null, SUBSCRIPTION, undefined]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, '#2334');
});

test('attributionRows on empty/missing input returns []', () => {
  assert.deepEqual(attributionRows([]), []);
  assert.deepEqual(attributionRows(null), []);
});

// ── the seo-impact join ───────────────────────────────────────────────────────

test('shopifyRevenueByPage keys organic revenue by normalized path', () => {
  const m = shopifyRevenueByPage(attributionRows([
    ORGANIC_FREE_LISTING, BLOG_BRAVE, PAID_SHOPPING, TEST_ORDER, SUBSCRIPTION, DIRECT,
  ]));
  // organic only: the free listing + the brave blog order
  assert.equal(m.get('/products/organic-foaming-hand-soap').revenue, 62.40);
  assert.equal(m.get('/blogs/news/best-non-toxic-body-lotion-2025').revenue, 35.99);
  assert.equal(m.get('/blogs/news/best-non-toxic-body-lotion-2025').conversions, 1);
  // paid, test, subscription and direct must not appear
  assert.equal(m.has('/products/coconut-lotion'), false);
  assert.equal(m.has('/'), false);
});

test('shopifyRevenueByPage sums multiple orders on one page and rounds cents', () => {
  const a = { ...ORGANIC_FREE_LISTING, id: 20, total_price: '10.01' };
  const b = { ...ORGANIC_FREE_LISTING, id: 21, total_price: '20.02' };
  const m = shopifyRevenueByPage(attributionRows([a, b]));
  const e = m.get('/products/organic-foaming-hand-soap');
  assert.equal(e.revenue, 30.03);
  assert.equal(e.conversions, 2);
  assert.equal(e.sessions, 0, 'Shopify cannot know sessions; GA4 supplies them');
});

test('shopifyRevenueByPage can include every channel when asked', () => {
  const m = shopifyRevenueByPage(attributionRows([DIRECT, ORGANIC_FREE_LISTING]), { channels: null });
  assert.equal(m.has('/products/coconut-lotion'), true);
  assert.equal(m.has('/products/organic-foaming-hand-soap'), true);
});
