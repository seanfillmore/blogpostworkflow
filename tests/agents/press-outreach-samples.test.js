import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPressOutreach, renderSummary } from '../../agents/press-outreach/index.js';

// Monday 2026-10-19, inside the send window.
const NOW = Date.parse('2026-10-19T18:00:00Z');
const CONFIG = {
  enabled: true, sendVia: 'resend', dailySendCap: 10, dailySendCapRamped: 25, rampAfterDays: 14, draftExpiryDays: 14, minGapMinutes: 10,
  monthlySampleKits: 10, sampleVariants: { lotion: 45828179165354, soap: 45828179951786 },
};
const ADDRESS_REPLY = "I'd love to try them! Ship to:\n12 Example Road, Apt 3B\nSpringfield, IL 62704";

const contact = (id, pitchOver = {}) => ({
  id, name: `${id[0].toUpperCase()}${id.slice(1)} Example`, status: 'active', domains: ['example.com'],
  channels: [{ type: 'email', address: `${id}@example.com`, verified: true, source: 'https://example.com' }],
  pitches: [{ date: '2026-10-12', concept: 'intro', products: ['lotion', 'soap'], outcome: 'sent', subject: 'Coconut cream', message_id: `<${id}@realskincare.com>`, last_sent_at: '2026-10-12T17:00:00Z', follow_ups_sent: 0, ...pitchOver }],
});
const reply = (from, text, over = {}) => ({ from: `${from}@example.com`, messageId: `<r-${from}>`, text, fullText: text, subject: 'Re: Coconut cream', references: [`<${from}@realskincare.com>`], date: '2026-10-19T10:00:00Z', emojiReaction: false, autoSubmitted: false, ...over });
const prOrder = (over = {}) => ({ name: '#2373', email: null, createdAt: '2026-10-14T10:00:00Z', cancelledAt: null, tags: ['PR Package'], shippingAddress: { name: 'Jane Example' }, fulfillments: [], ...over });

/** A fake Shopify: scope, existing orders, draft total. Every call is recorded. */
function shopify({ scope = true, orders = [], amount = '0.0', createErrors = [] } = {}) {
  const calls = [];
  const graphql = async (q, v) => {
    calls.push({ q, v });
    if (/currentAppInstallation/.test(q)) return { currentAppInstallation: { accessScopes: [{ handle: 'read_orders' }, ...(scope ? [{ handle: 'write_draft_orders' }] : [])] } };
    if (/draftOrderCreate/.test(q)) return { draftOrderCreate: { draftOrder: createErrors.length ? null : { id: 'gid://shopify/DraftOrder/5', name: '#D5', totalPriceSet: { shopMoney: { amount } } }, userErrors: createErrors } };
    if (/draftOrderComplete/.test(q)) return { draftOrderComplete: { draftOrder: { id: 'gid://shopify/DraftOrder/5', order: { id: 'gid://shopify/Order/9', name: '#2400' } }, userErrors: [] } };
    if (/orders\(/.test(q)) {
      const byName = String(v.q).match(/^name:(#\d+)/);
      return { orders: { nodes: byName ? orders.filter((o) => o.name === byName[1]) : orders } };
    }
    throw new Error(`unexpected query ${q}`);
  };
  return { graphql, calls, kinds: () => calls.map((c) => (/currentApp/.test(c.q) ? 'scope' : /draftOrderCreate/.test(c.q) ? 'create' : /draftOrderComplete/.test(c.q) ? 'complete' : 'orders')) };
}

function world({ contacts, replies = [], sent = [], state = {}, shop = shopify(), now = NOW, apply = true } = {}) {
  const calls = { send: [], escalate: [], tell: [] };
  const opts = {
    apply, now, config: CONFIG, book: { contacts }, state: { sends: [], processed: [], escalated: {}, ...state }, drafts: [], postalAddress: '1 Example Way, Testville, WY 00000',
    readReplies: async () => replies, readSent: async () => sent,
    send: async (m) => { calls.send.push(m); return { messageId: `<s${calls.send.length}@realskincare.com>`, resendId: 'r' }; },
    saveBook: (b) => { opts.book = b; }, saveState: () => {}, saveDraft: () => {}, readDraft: () => null,
    escalate: async (c, _m, reason) => { calls.escalate.push({ id: c.id, reason }); },
    tellSean: async (m) => { calls.tell.push(m); },
    confirmReply: async () => true, sleep: async () => {}, reportError: async () => {}, log: () => {},
    graphql: shop.graphql,
  };
  return { opts, calls, shop };
}
const pitchOf = (opts, id) => opts.book.contacts.find((c) => c.id === id).pitches.at(-1);

test('address with the scope: a $0 PR Package order is created, recorded, and a threaded thanks goes out', async () => {
  const { opts, calls, shop } = world({ contacts: [contact('jane')], replies: [reply('jane', ADDRESS_REPLY)] });
  const r = await runPressOutreach(opts);
  const k = shop.kinds();
  assert.deepEqual([k.filter((x) => x === 'scope').length, k.filter((x) => x === 'create').length, k.filter((x) => x === 'complete').length], [1, 1, 1]);
  const input = shop.calls.find((c) => /draftOrderCreate/.test(c.q)).v.input;
  assert.deepEqual(input.tags, ['PR Package', 'press-outreach']);
  assert.equal(input.shippingAddress.address2, 'Apt 3B');
  assert.deepEqual(input.lineItems.map((l) => l.variantId), ['gid://shopify/ProductVariant/45828179165354', 'gid://shopify/ProductVariant/45828179951786']);
  const p = pitchOf(opts, 'jane');
  assert.equal(p.outcome, 'samples-sent');
  assert.equal(p.sample_order, '#2400');
  const thanks = calls.send.find((m) => m.to === 'jane@example.com');
  assert.match(thanks.text, /on the way/);
  assert.equal(thanks.inReplyTo, '<r-jane>');
  assert.ok(opts.state.sends.some((s) => s.kind === 'sample-thanks' && s.contact_id === 'jane'));
  assert.equal(opts.state.escalated.jane, undefined, 'not escalated: the order exists');
  assert.deepEqual(calls.tell, []);
  assert.ok(r.samples.some((s) => s.id === 'jane' && /#2400/.test(s.action)));
});

test('address without the scope: recorded, escalated, Sean asked to create the order; not an error', async () => {
  const shop = shopify({ scope: false });
  const { opts, calls } = world({ contacts: [contact('jane')], replies: [reply('jane', ADDRESS_REPLY)], shop });
  const r = await runPressOutreach(opts);
  assert.ok(!shop.kinds().includes('create'));
  const p = pitchOf(opts, 'jane');
  assert.equal(p.outcome, 'sample-accepted');
  assert.deepEqual(p.sample_address.lines, ['12 Example Road, Apt 3B', 'Springfield, IL 62704']);
  assert.ok(opts.state.escalated.jane);
  assert.equal(calls.tell.length, 1);
  assert.equal(calls.tell[0].subject, 'Press outreach: create a PR Package order for Jane Example');
  assert.match(calls.tell[0].body, /12 Example Road, Apt 3B/);
  assert.match(calls.tell[0].body, /lotion: gid:\/\/shopify\/ProductVariant\/45828179165354/);
  assert.match(calls.tell[0].body, /tracking automatically/);
  assert.equal(r.failed.length, 0);
  assert.ok(!calls.send.some((m) => m.to === 'jane@example.com'));
});

test('over the monthly cap: no order, Sean told why', async () => {
  const orders = Array.from({ length: 10 }, (_, i) => prOrder({ name: `#${3000 + i}`, shippingAddress: { name: `Other ${i}` }, createdAt: '2026-10-02T00:00:00Z' }));
  const shop = shopify({ orders });
  const { opts, calls } = world({ contacts: [contact('jane')], replies: [reply('jane', ADDRESS_REPLY)], shop });
  await runPressOutreach(opts);
  assert.ok(!shop.kinds().includes('create'));
  assert.match(calls.tell[0].body, /over monthly cap/);
  assert.ok(opts.state.escalated.jane);
});

test('a non-zero draft is never completed; Sean is told', async () => {
  const shop = shopify({ amount: '34.00' });
  const { opts, calls } = world({ contacts: [contact('jane')], replies: [reply('jane', ADDRESS_REPLY)], shop });
  await runPressOutreach(opts);
  assert.ok(!shop.kinds().includes('complete'));
  assert.match(calls.tell[0].body, /not 0/);
  assert.equal(pitchOf(opts, 'jane').outcome, 'sample-accepted');
});

test('an order for them already exists: adopted, never created twice', async () => {
  const shop = shopify({ orders: [prOrder({ createdAt: '2026-10-19T09:00:00Z' })] });
  const { opts } = world({ contacts: [contact('jane')], replies: [reply('jane', ADDRESS_REPLY)], shop });
  await runPressOutreach(opts);
  assert.ok(!shop.kinds().includes('create'));
  assert.equal(pitchOf(opts, 'jane').sample_order, '#2373');
});

test('a hand-made order is found by name; tracking goes out threaded once it ships', async () => {
  const shipped = prOrder({ fulfillments: [{ displayStatus: 'IN_TRANSIT', deliveredAt: null, trackingInfo: [{ company: 'USPS', number: '9400', url: 'https://tools.usps.com/go/x' }] }] });
  const shop = shopify({ orders: [shipped] });
  const { opts, calls } = world({
    contacts: [contact('jane', { outcome: 'sample-accepted' })], shop,
    state: { escalated: { jane: { at: '2026-10-13T00:00:00Z', reason: 'address received, create the PR Package order', kind: 'order-request' } } },
  });
  const r = await runPressOutreach(opts);
  const p = pitchOf(opts, 'jane');
  assert.equal(p.outcome, 'samples-sent');
  assert.equal(p.sample_order, '#2373');
  const m = calls.send.find((x) => x.to === 'jane@example.com');
  assert.match(m.text, /tools\.usps\.com\/go\/x/);
  assert.equal(m.inReplyTo, '<jane@realskincare.com>');
  assert.equal(m.subject, 'Re: Coconut cream');
  assert.equal(p.tracking_sent_at, new Date(NOW).toISOString());
  assert.equal(opts.state.escalated.jane, undefined, 'the order request is fulfilled');
  assert.ok(r.samples.some((s) => s.id === 'jane'));
});

test('matched but not shipped: recorded as samples-sent, nothing sent', async () => {
  const shop = shopify({ orders: [prOrder({ email: 'jane@example.com', shippingAddress: { name: 'J. Example' } })] });
  const { opts, calls } = world({ contacts: [contact('jane', { outcome: 'sample-accepted' })], shop });
  await runPressOutreach(opts);
  assert.equal(pitchOf(opts, 'jane').sample_order, '#2373');
  assert.equal(calls.send.length, 0);
});

test('an order from before the pitch is not theirs', async () => {
  const shop = shopify({ orders: [prOrder({ createdAt: '2026-09-01T00:00:00Z' })] });
  const { opts } = world({ contacts: [contact('jane', { outcome: 'sample-accepted' })], shop });
  await runPressOutreach(opts);
  assert.equal(pitchOf(opts, 'jane').outcome, 'sample-accepted');
});

test('day-21 check-in goes once, only with no reply since tracking', async () => {
  const delivered = prOrder({ fulfillments: [{ deliveredAt: '2026-09-27T00:00:00Z', trackingInfo: [{ url: 'https://example.com/t' }] }] });
  const base = { outcome: 'samples-sent', sample_order: '#2373', tracking_sent_at: '2026-09-24T17:00:00Z', last_sent_at: '2026-09-24T17:00:00Z', date: '2026-09-10' };
  const a = world({ contacts: [contact('jane', base)], shop: shopify({ orders: [delivered] }) });
  await runPressOutreach(a.opts);
  assert.equal(a.calls.send.length, 1);
  assert.match(a.calls.send[0].text, /chance to try them/);
  assert.equal(pitchOf(a.opts, 'jane').checkin_sent_at, new Date(NOW).toISOString());

  const b = world({ contacts: [contact('jane', base)], shop: shopify({ orders: [delivered] }), replies: [reply('jane', 'Got them, thanks', { date: '2026-09-30T10:00:00Z', messageId: '<r-old>' })], state: { processed: ['<r-old>'] } });
  await runPressOutreach(b.opts);
  assert.equal(b.calls.send.length, 0, 'they replied after the tracking email');

  const c = world({ contacts: [contact('jane', { ...base, checkin_sent_at: '2026-10-18T17:00:00Z' })], shop: shopify({ orders: [delivered] }) });
  await runPressOutreach(c.opts);
  assert.equal(c.calls.send.length, 0, 'once only');
  assert.equal(c.shop.calls.length, 0, 'nothing left to check: no Shopify call');

  const d = world({ contacts: [contact('jane', base)], shop: shopify({ orders: [prOrder({ fulfillments: [{ deliveredAt: '2026-10-10T00:00:00Z', trackingInfo: [{ url: 'https://example.com/t' }] }] })] }) });
  await runPressOutreach(d.opts);
  assert.equal(d.calls.send.length, 0, 'not 21 days yet');
});

test('a tracking email already in state.sends is repaired, never re-sent', async () => {
  const shipped = prOrder({ fulfillments: [{ trackingInfo: [{ url: 'https://example.com/t' }] }] });
  const { opts, calls } = world({
    contacts: [contact('jane', { outcome: 'samples-sent', sample_order: '#2373' })], shop: shopify({ orders: [shipped] }),
    state: { sends: [{ at: '2026-10-18T17:00:00Z', contact_id: 'jane', kind: 'sample-tracking', pitch_date: '2026-10-12', message_id: '<t1>', last_event: 'sent' }] },
  });
  await runPressOutreach(opts);
  assert.equal(calls.send.length, 0);
  assert.equal(pitchOf(opts, 'jane').tracking_sent_at, '2026-10-18T17:00:00Z');
});

test('outside the send window: no tracking, no Shopify call', async () => {
  const shop = shopify({ orders: [prOrder({ fulfillments: [{ trackingInfo: [{ url: 'https://example.com/t' }] }] })] });
  const { opts, calls } = world({ contacts: [contact('jane', { outcome: 'sample-accepted' })], shop, now: Date.parse('2026-10-17T18:00:00Z') });
  await runPressOutreach(opts);
  assert.equal(calls.send.length, 0);
  assert.equal(shop.calls.length, 0);
});

test('a Shopify read failure is reported and the run carries on', async () => {
  const { opts } = world({ contacts: [contact('jane', { outcome: 'sample-accepted' })], shop: { graphql: async () => { throw new Error('HTTP 503'); } } });
  const r = await runPressOutreach(opts);
  assert.ok(r.failed.some((f) => /503/.test(f.error)));
});

test('dry run: no order created, nothing written', async () => {
  const shop = shopify();
  const { opts, calls } = world({ contacts: [contact('jane')], replies: [reply('jane', ADDRESS_REPLY)], shop, apply: false });
  await runPressOutreach(opts);
  assert.ok(!shop.kinds().includes('create') && !shop.kinds().includes('complete'));
  assert.equal(calls.tell.length, 0);
});

test('renderSummary lists sample actions', () => {
  const r = { sent: [], followUps: [], replies: [], escalations: [], expired: [], skipped: [], failed: [], samples: [{ id: 'jane', name: 'Jane Example', action: 'tracking sent' }] };
  assert.match(renderSummary(r, { apply: true }).body, /Jane Example: tracking sent/);
});

test('if telling Sean fails, the reply stays unprocessed and the contact is not escalated', async () => {
  const { opts } = world({ contacts: [contact('jane')], replies: [reply('jane', ADDRESS_REPLY)], shop: shopify({ scope: false }) });
  opts.tellSean = async () => { throw new Error('resend down'); };
  const r = await runPressOutreach(opts);
  assert.equal(opts.state.escalated.jane, undefined);
  assert.ok(!opts.state.processed.includes('<r-jane>'));
  assert.ok(r.failed.some((f) => f.kind === 'address-given'));
});

// ── fix round 1 ──

test('R1: a hand-made order placed before the address arrived is adopted, never duplicated', async () => {
  const shop = shopify({ orders: [prOrder({ name: '#2373', createdAt: '2026-10-15T10:00:00Z' })] });
  const { opts } = world({ contacts: [contact('jane')], replies: [reply('jane', ADDRESS_REPLY)], shop });
  await runPressOutreach(opts);
  assert.equal(shop.kinds().filter((k) => k === 'create').length, 0);
  assert.equal(pitchOf(opts, 'jane').sample_order, '#2373');
  assert.equal(pitchOf(opts, 'jane').outcome, 'samples-sent');
});

test('R3: a failure after draftOrderCreate names the draft and says to check Shopify first', async () => {
  const shop = shopify();
  const inner = shop.graphql;
  shop.graphql = async (q, v) => { if (/draftOrderComplete/.test(q)) throw new Error('socket hang up'); return inner(q, v); };
  const { opts, calls } = world({ contacts: [contact('jane')], replies: [reply('jane', ADDRESS_REPLY)], shop });
  await runPressOutreach(opts);
  assert.match(calls.tell[0].body, /#D5/);
  assert.match(calls.tell[0].body, /gid:\/\/shopify\/DraftOrder\/5/);
  assert.match(calls.tell[0].body, /check Shopify for this draft\/order before creating one/);
});

test('R4: orders created earlier in this run count toward the cap', async () => {
  const orders = Array.from({ length: 9 }, (_, i) => prOrder({ name: `#${3000 + i}`, shippingAddress: { name: `Other ${i}` }, createdAt: '2026-10-02T00:00:00Z' }));
  const shop = shopify({ orders });
  const { opts, calls } = world({
    contacts: [contact('jane'), contact('sam')],
    replies: [reply('jane', ADDRESS_REPLY), reply('sam', ADDRESS_REPLY, { date: '2026-10-19T11:00:00Z' })],
    shop,
  });
  await runPressOutreach(opts);
  assert.equal(shop.kinds().filter((k) => k === 'create').length, 1, 'only the tenth kit is created');
  assert.ok(calls.tell.some((m) => /Sam Example/.test(m.subject) && /over monthly cap/.test(m.body)));
});

test('R6: a check-in with no delivery 90 days after tracking stops being chased', async () => {
  const shop = shopify({ orders: [prOrder({ fulfillments: [{ deliveredAt: null, trackingInfo: [{ url: 'https://example.com/t' }] }] })] });
  const base = { outcome: 'samples-sent', sample_order: '#2373', tracking_sent_at: '2026-07-15T17:00:00Z', last_sent_at: '2026-07-15T17:00:00Z', date: '2026-07-10' };
  const a = world({ contacts: [contact('jane', base)], shop });
  await runPressOutreach(a.opts);
  assert.equal(a.calls.send.length, 0);
  assert.equal(pitchOf(a.opts, 'jane').checkin_skipped_at, new Date(NOW).toISOString());
  const b = world({ contacts: [contact('jane', { ...base, checkin_skipped_at: '2026-10-18T00:00:00Z' })], shop: shopify() });
  await runPressOutreach(b.opts);
  assert.equal(b.shop.calls.length, 0, 'never queried again');
});
