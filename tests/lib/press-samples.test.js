import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  SAMPLE_TAGS, countMonthKits, planSample, buildDraftOrderInput, createSampleOrder, fetchPrPackageOrders,
  trackingText, thanksText, checkinText, matchOrder, trackingOf, checkinDue, hasDraftOrderScope, parseAddress,
  variantGid, orderRequestEmail, NonZeroDraftError,
} from '../../lib/press-samples.js';
import { classifyOrder } from '../../lib/order-attribution.js';
import { checkOutgoingCopy } from '../../lib/press-outreach.js';

const NOW = Date.parse('2026-10-15T18:00:00Z');
const CONFIG = { monthlySampleKits: 2, sampleVariants: { lotion: 45828179165354, soap: 'gid://shopify/ProductVariant/7' } };
const ADDRESS = { lines: ['12 Example Road, Apt 3B', 'Springfield, IL 62704'], zip: '62704' };
const contact = { id: 'jane-example', name: 'Jane Example' };
const pitch = { date: '2026-10-01', concept: 'intro', products: ['lotion', 'soap'] };
const order = (over = {}) => ({ name: '#2001', email: null, createdAt: '2026-10-05T10:00:00Z', cancelledAt: null, tags: ['PR Package'], shippingAddress: { name: 'Jane Example' }, fulfillments: [], ...over });

test('cap counting ignores last month, cancelled, and untagged orders', () => {
  const orders = [
    order(), order({ createdAt: '2026-10-01T00:00:01Z', tags: ['pr package', 'press-outreach'] }),
    order({ createdAt: '2026-09-30T23:59:59Z' }), order({ cancelledAt: '2026-10-06T00:00:00Z' }), order({ tags: ['sample-request'] }),
  ];
  assert.equal(countMonthKits(orders, NOW), 2);
});

test('planSample refuses over the cap and for an unmapped product', () => {
  assert.match(planSample({ pitch, address: ADDRESS, config: CONFIG, monthKits: 2 }).reason, /over monthly cap/);
  const r = planSample({ pitch: { ...pitch, products: ['lotion', 'toothpaste'] }, address: ADDRESS, config: CONFIG, monthKits: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no variant mapped for toothpaste');
  const ok = planSample({ pitch, address: ADDRESS, config: CONFIG, monthKits: 1 });
  assert.deepEqual(ok, { ok: true, lines: [{ variantId: 'gid://shopify/ProductVariant/45828179165354', quantity: 1 }, { variantId: 'gid://shopify/ProductVariant/7', quantity: 1 }] });
});

test('the draft-order input has the tags, a 100% discount and the parsed address', () => {
  const lines = planSample({ pitch, address: ADDRESS, config: CONFIG, monthKits: 0 }).lines;
  const input = buildDraftOrderInput({ contact, pitch, address: ADDRESS, lines });
  assert.deepEqual(input.tags, ['PR Package', 'press-outreach']);
  assert.deepEqual(SAMPLE_TAGS, ['PR Package', 'press-outreach']);
  for (const l of input.lineItems) assert.deepEqual(l.appliedDiscount, { valueType: 'PERCENTAGE', value: 100, title: 'PR sample' });
  assert.deepEqual(input.shippingAddress, { firstName: 'Jane', lastName: 'Example', address1: '12 Example Road', address2: 'Apt 3B', city: 'Springfield', provinceCode: 'IL', zip: '62704', countryCode: 'US' });
  assert.equal(input.note, 'press-outreach: jane-example / intro');
  assert.equal(input.email, undefined, 'no email: the writer gets no Shopify order notification');
  assert.equal(input.shippingLine, undefined, 'no shipping line: the total stays 0');
});

test('parseAddress: no unit, and ZIP+4', () => {
  assert.deepEqual(parseAddress({ lines: ['9 Main St', 'Big Town, NY 10001-1234'] }), { address1: '9 Main St', address2: null, city: 'Big Town', provinceCode: 'NY', zip: '10001-1234' });
  assert.equal(parseAddress({ lines: ['9 Main St, #4', 'X, NY 10001'] }).address2, '#4');
});

test('createSampleOrder creates, checks the total is 0, completes', async () => {
  const calls = [];
  const graphql = async (q, v) => {
    calls.push({ q, v });
    if (/draftOrderCreate/.test(q)) return { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/1', name: '#D1', totalPriceSet: { shopMoney: { amount: '0.0' } } }, userErrors: [] } };
    return { draftOrderComplete: { draftOrder: { id: 'gid://shopify/DraftOrder/1', order: { id: 'gid://shopify/Order/9', name: '#2002' } }, userErrors: [] } };
  };
  assert.deepEqual(await createSampleOrder({ x: 1 }, { graphql }), { name: '#2002' });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].v, { id: 'gid://shopify/DraftOrder/1' });
  assert.ok(!/paymentPending/.test(calls[1].q), 'the deprecated paymentPending is not passed');
});

test('createSampleOrder throws on userErrors', async () => {
  const graphql = async () => ({ draftOrderCreate: { draftOrder: null, userErrors: [{ field: ['input', 'lineItems'], message: 'Variant not found' }] } });
  await assert.rejects(createSampleOrder({}, { graphql }), /Variant not found/);
  const g2 = async (q) => (/Create/.test(q)
    ? { draftOrderCreate: { draftOrder: { id: 'd', name: '#D', totalPriceSet: { shopMoney: { amount: '0.0' } } }, userErrors: [] } }
    : { draftOrderComplete: { draftOrder: null, userErrors: [{ field: null, message: 'cannot complete' }] } });
  await assert.rejects(createSampleOrder({}, { graphql: g2 }), /cannot complete/);
});

test('createSampleOrder never completes a non-zero draft', async () => {
  const calls = [];
  const graphql = async (q) => { calls.push(q); return { draftOrderCreate: { draftOrder: { id: 'd', name: '#D2', totalPriceSet: { shopMoney: { amount: '12.50' } } }, userErrors: [] } }; };
  await assert.rejects(createSampleOrder({}, { graphql }), NonZeroDraftError);
  assert.equal(calls.length, 1, 'draftOrderComplete is never called');
});

test('hasDraftOrderScope reads the access scopes', async () => {
  assert.equal(await hasDraftOrderScope({ graphql: async () => ({ currentAppInstallation: { accessScopes: [{ handle: 'read_orders' }] } }) }), false);
  assert.equal(await hasDraftOrderScope({ graphql: async () => ({ currentAppInstallation: { accessScopes: [{ handle: 'write_draft_orders' }] } }) }), true);
});

test('fetchPrPackageOrders filters by tag and date', async () => {
  let seen;
  const out = await fetchPrPackageOrders({ sinceDays: 30, now: NOW, graphql: async (q, v) => { seen = v; return { orders: { nodes: [order(), order({ tags: ['other'] })] } }; } });
  assert.equal(out.length, 1);
  assert.equal(seen.q, 'tag:"PR Package" created_at:>=2026-09-15');
});

test('matchOrder: shipping name (case-insensitive) or exact email, on or after the date, not cancelled', () => {
  const orders = [
    order({ name: '#1', createdAt: '2026-09-20T00:00:00Z' }),
    order({ name: '#2', cancelledAt: 'x' }),
    order({ name: '#3', shippingAddress: { name: 'JANE  example' }, createdAt: '2026-10-06T00:00:00Z' }),
    order({ name: '#4', shippingAddress: { name: 'Someone Else' }, email: 'jane@example.com', createdAt: '2026-10-04T00:00:00Z' }),
  ];
  assert.equal(matchOrder(orders, { contact, email: 'jane@example.com', sinceDate: '2026-10-01' }).name, '#4');
  assert.equal(matchOrder(orders, { contact, sinceDate: '2026-10-01' }).name, '#3');
  assert.equal(matchOrder(orders, { contact: { name: 'Nobody' }, sinceDate: '2026-10-01' }), null);
});

test('trackingOf and checkinDue', () => {
  assert.equal(trackingOf(order({ fulfillments: [{ trackingInfo: [] }] })), null);
  const t = trackingOf(order({ fulfillments: [{ deliveredAt: '2026-10-08T00:00:00Z', trackingInfo: [{ company: 'USPS', number: '9400', url: 'https://tools.usps.com/x' }] }] }));
  assert.equal(t.url, 'https://tools.usps.com/x');
  assert.equal(checkinDue({ deliveredAt: '2026-10-08T00:00:00Z', nowMs: Date.parse('2026-10-28T23:00:00Z') }), false);
  assert.equal(checkinDue({ deliveredAt: '2026-10-08T00:00:00Z', nowMs: Date.parse('2026-10-29T00:00:00Z') }), true);
  assert.equal(checkinDue({ deliveredAt: null, nowMs: NOW }), false);
});

test('fixed copy has no dash and passes the outgoing gate', () => {
  for (const text of [trackingText({ firstName: 'Jane', url: 'https://example.com/t' }), thanksText({ firstName: 'Jane' }), checkinText({ firstName: 'Jane' })]) {
    assert.ok(!/[—–]/.test(text), text);
    assert.ok(checkOutgoingCopy({ subject: 'Re: Coconut cream', text, kind: 'followup' }).ok, text);
  }
  assert.match(trackingText({ firstName: 'Jane', url: 'https://example.com/t' }), /https:\/\/example\.com\/t/);
});

test('orderRequestEmail lists the address and default variants and says tracking follows', () => {
  const e = orderRequestEmail({ contact, pitch, address: ADDRESS, config: CONFIG });
  assert.equal(e.subject, 'Press outreach: create a PR Package order for Jane Example');
  assert.match(e.body, /12 Example Road, Apt 3B/);
  assert.match(e.body, /lotion: gid:\/\/shopify\/ProductVariant\/45828179165354/);
  assert.match(e.body, /tracking automatically/);
  assert.equal(variantGid(CONFIG, 'deodorant'), null);
});

test('a $0 PR Package order never counts as revenue', () => {
  const r = classifyOrder({ id: 1, name: '#2002', total_price: '0.00', tags: 'PR Package, press-outreach', source_name: 'shopify_draft_order', created_at: '2026-10-15T00:00:00Z' });
  assert.equal(r.countsAsRevenue, false);
});

test('config maps every catalogue product to a variant', async () => {
  const cfg = JSON.parse(readFileSync(new URL('../../config/press-outreach.json', import.meta.url), 'utf8'));
  const { PRODUCTS } = await import('../../lib/press-contacts.js');
  for (const p of PRODUCTS) assert.match(variantGid(cfg, p) || '', /^gid:\/\/shopify\/ProductVariant\/\d+$/, p);
});

test('R2: the orders query is newest first, 100 at a time', async () => {
  let seen;
  await fetchPrPackageOrders({ now: NOW, graphql: async (q) => { seen = q; return { orders: { nodes: [] } }; } });
  assert.match(seen, /orders\(first: 100, query: \$q, sortKey: CREATED_AT, reverse: true\)/);
});

test('R3: an error after draftOrderCreate carries the draft identity', async () => {
  const graphql = async (q) => { if (/Create/.test(q)) return { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/8', name: '#D8', totalPriceSet: { shopMoney: { amount: '0.0' } } }, userErrors: [] } }; throw new Error('HTTP 502'); };
  await assert.rejects(createSampleOrder({}, { graphql }), (err) => err.draft?.name === '#D8' && err.draft?.id === 'gid://shopify/DraftOrder/8' && /HTTP 502/.test(err.message));
  const g2 = async (q) => (/Create/.test(q) ? { draftOrderCreate: { draftOrder: { id: 'gid://shopify/DraftOrder/8', name: '#D8', totalPriceSet: { shopMoney: { amount: '0.0' } } }, userErrors: [] } } : { draftOrderComplete: { draftOrder: null, userErrors: [{ field: null, message: 'nope' }] } });
  await assert.rejects(createSampleOrder({}, { graphql: g2 }), (err) => err.draft?.name === '#D8');
});

test('R5: planSample refuses an address missing city, state or ZIP', () => {
  const r = planSample({ pitch, address: { lines: ['12 Example Road', 'Springfield IL'], zip: null }, config: CONFIG, monthKits: 0 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /incomplete address/);
});
