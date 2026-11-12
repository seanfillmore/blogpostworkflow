import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { run, parseArgs, acquireLock } from '../../agents/amazon-inbound/index.js';
import { planName, dryPlanName } from '../../lib/amazon-inbound-state.js';
import { spawnSync } from 'node:child_process';
import { utimesSync } from 'node:fs';

const SRC = readFileSync('agents/amazon-inbound/index.js', 'utf8');
const CONFIG = JSON.parse(readFileSync('config/amazon-inbound.json', 'utf8'));
const V = '/inbound/fba/2024-03-20';
const AWD = '/awd/2024-05-09';
const PLAN = 'wf' + 'p'.repeat(36);
const NOW = '2026-11-12T17:00:00Z';
const TRAVIS_ID = '<CAKtravis-1@mail.gmail.com>';
const SEAN = 'sean@realskincare.com';
const sku = (key) => CONFIG.skus.find((s) => s.key === key);

const EMAIL = [
  '4-pack (9 cases - 108 units)',
  '3-pack (9 cases - 108 units)',
  '2-pack (5 cases - 100 unis)',
  '6-pack (10 cases - 120 units)',
].join('\n');

const usd = (amount) => ({ amount, code: 'USD' });
const CONFIRMS = /placementOptions\/[^/]+\/confirmation$|transportationOptions\/confirmation$|deliveryWindowOptions\/[^/]+\/confirmation$/;

/**
 * Scripted Amazon. Every booking goes to one placement (plA, $5) with one shipment (s1) whose
 * cheapest partnered option is small parcel at $40. `manualPlans`, `awdShipments`, `sales`,
 * `inventory` and `labelsReady` shape the reads.
 */
function fakeAmazon({ manualPlans = [], planItems = {}, awdShipments = [], sales = {}, inventory = [], failOn = null, labelsReady = true, awdLabelStatus = 'GENERATED', ltl = false } = {}) {
  const calls = [];
  let op = 0;
  let created = 0;
  let fbaItems = [];
  const request = async (method, path, params) => {
    calls.push({ method, path, params });
    if (failOn && failOn(method, path)) throw new Error(`SP-API ${method} ${path} failed (500): InternalFailure`);
    const ok = () => ({ operationId: `op-${++op}` });
    if (path === '/fba/inventory/v1/summaries') return { payload: { inventorySummaries: inventory } };
    if (path === '/sales/v1/orderMetrics') return { payload: sales[params.asin] || [] };
    if (path.startsWith(`${V}/operations/`)) return { operationStatus: 'SUCCESS', operationProblems: [] };
    if (method === 'GET' && path === `${V}/inboundPlans`) {
      if (params?.status === 'ACTIVE') return { inboundPlans: [] };
      return { inboundPlans: manualPlans };
    }
    if (method === 'POST' && path === `${V}/inboundPlans`) {
      created++;
      fbaItems = params.items;
      return { inboundPlanId: PLAN, ...ok() };
    }
    const planItemsM = path.match(/\/inboundPlans\/([^/]+)\/items$/);
    if (method === 'GET' && planItemsM) {
      const it = planItems[planItemsM[1]];
      if (it instanceof Error) throw it;
      return { items: it || [] };
    }
    const p = `${V}/inboundPlans/${PLAN}`;
    if (method === 'GET' && path === `${p}/packingOptions`) {
      return { packingOptions: [{ packingOptionId: 'pk1', status: 'OFFERED', fees: [], discounts: [], packingGroups: ['pg1'] }] };
    }
    if (method === 'GET' && path === `${p}/packingGroups/pg1/items`) return { items: fbaItems.map((i) => ({ msku: i.msku, quantity: i.quantity })) };
    if (method === 'GET' && path === `${p}/placementOptions`) {
      return { placementOptions: [{ placementOptionId: 'plA', status: 'OFFERED', fees: [{ value: usd(5) }], discounts: [], shipmentIds: ['s1'] }] };
    }
    if (method === 'GET' && path === `${p}/shipments/s1/items`) return { items: fbaItems.map((i) => ({ msku: i.msku, quantity: i.quantity })) };
    if (method === 'GET' && path === `${p}/transportationOptions`) {
      return { transportationOptions: [
        { transportationOptionId: 't1', shipmentId: 's1', shippingMode: 'GROUND_SMALL_PARCEL', shippingSolution: 'AMAZON_PARTNERED_CARRIER', carrier: { name: 'UPS' }, preconditions: [], quote: { cost: usd(40) } },
        { transportationOptionId: 't2', shipmentId: 's1', shippingMode: 'GROUND_SMALL_PARCEL', shippingSolution: 'AMAZON_PARTNERED_CARRIER', carrier: { name: 'UPS' }, preconditions: [], quote: { cost: usd(70) } },
        ...(ltl ? [{ transportationOptionId: 't3', shipmentId: 's1', shippingMode: 'FREIGHT_LTL', shippingSolution: 'AMAZON_PARTNERED_CARRIER', carrier: { name: 'XPO' }, preconditions: [], quote: { cost: usd(30) } }] : []),
      ] };
    }
    if (method === 'GET' && path === `${p}/shipments/s1`) {
      return { shipmentId: 's1', shipmentConfirmationId: labelsReady ? 'FBA19ABCDEF' : undefined, destination: { warehouseId: 'ONT8', address: { city: 'Moreno Valley', stateOrProvinceCode: 'CA' } } };
    }
    if (method === 'GET' && path === `${p}/shipments/s1/boxes`) return { boxes: [{ boxId: 'FBA19ABCDEFU000001' }, { boxId: 'FBA19ABCDEFU000002' }] };
    if (method === 'GET' && path.startsWith('/fba/inbound/v0/')) return { payload: { DownloadURL: `https://dl.example/${params?.LabelType || 'bol'}` } };
    if (method === 'GET' && path === `${AWD}/inboundShipments`) {
      return { shipments: awdShipments.map((s) => ({ shipmentId: s.shipmentId, createdAt: s.createdAt, shipmentStatus: s.status || 'CREATED', orderId: 'o1' })) };
    }
    const awdDetail = path.match(new RegExp(`^${AWD}/inboundShipments/([^/]+)$`));
    if (method === 'GET' && awdDetail) {
      const s = awdShipments.find((x) => x.shipmentId === awdDetail[1]);
      return { shipmentId: s.shipmentId, createdAt: s.createdAt, shipmentSkuQuantities: s.skuQuantities };
    }
    const awdLabels = path.match(new RegExp(`^${AWD}/inboundShipments/([^/]+)/labels$`));
    if (method === 'GET' && awdLabels) return awdLabelStatus === 'GENERATED' ? { labelStatus: 'GENERATED', labelDownloadURL: `https://dl.example/awd/${awdLabels[1]}` } : { labelStatus: awdLabelStatus };
    if (method === 'PUT' && path.endsWith('/cancellation')) return ok();
    return ok();
  };
  return { request, calls, created: () => created };
}

function mailRow(over = {}) {
  return {
    messageId: TRAVIS_ID, inReplyTo: null, references: ['<older@mail.gmail.com>'], from: 'travis@traviswales.com',
    subject: 'Culina cases', date: '2026-11-12T16:00:00.000Z', text: EMAIL, autoSubmitted: false, ...over,
  };
}

function setup({ mail = [mailRow()], amazon = {}, config = {}, now = NOW, dir = mkdtempSync(join(tmpdir(), 'amz-inbound-')) } = {}) {
  const amz = fakeAmazon(amazon);
  const sent = [];
  const notes = [];
  const fetches = [];
  let t = Date.parse(now);
  const deps = {
    config: { ...CONFIG, process_after: null, ...config },
    request: amz.request,
    marketplaceId: 'ATVPDKIKX0DER',
    sleep: async () => {},
    now: () => new Date(t),
    download: async (url) => Buffer.from(`%PDF ${url}`),
    contactPhone: undefined,
    creds: { user: SEAN, pass: 'x' },
    resendKey: 're_test',
    fetchMail: async (creds, q) => { fetches.push(q); return mail; },
    sendMail: async (creds, msg, opts) => { sent.push({ msg, opts }); return { messageId: `<sent-${sent.length}@realskincare.com>` }; },
    notify: async (n) => { notes.push(n); },
    log: () => {},
    statePath: join(dir, 'state.json'),
    lockPath: join(dir, '.lock'),
    procRoot: join(dir, 'no-proc'), // absent: pid-alive fallback, as on macOS
    seasonalPath: join(dir, 'no-seasonal.json'),
  };
  return { amz, deps, sent, notes, fetches, dir, state: () => JSON.parse(readFileSync(deps.statePath, 'utf8')), advance: (ms) => { t += ms; } };
}

const SP = (amz) => amz.calls.filter((c) => !c.path.startsWith('/sales/') && c.path !== '/fba/inventory/v1/summaries');

// ---- tests ------------------------------------------------------------------------

test('entry point is guarded with isDirectRun', () => {
  assert.match(SRC, /import \{ isDirectRun \} from '\.\.\/\.\.\/lib\/is-direct-run\.js'/);
  assert.match(SRC, /if \(isDirectRun\(import\.meta\.url\)\) main\(\);/);
});

test('parseArgs', () => {
  assert.deepEqual(parseArgs([]), { apply: false, since: null, text: null });
  assert.deepEqual(parseArgs(['--apply', '--since', '2026-11-01']), { apply: true, since: '2026-11-01', text: null });
  assert.equal(parseArgs(['--dry-run', '--text', '4-pack (1 cases - 12 units)']).text, '4-pack (1 cases - 12 units)');
  assert.throws(() => parseArgs(['--apply', '--dry-run']));
  assert.throws(() => parseArgs(['--since', '2026-1-1']));
  assert.throws(() => parseArgs(['--text']));
});

test('the real four-line email books once and sends ONE reply To Travis, CC Sean, threaded, with PDFs', async () => {
  const { amz, deps, sent, notes, state } = setup();
  await run(['--apply'], deps);

  assert.equal(amz.created(), 1);
  assert.equal(amz.calls.filter((c) => /transportationOptions\/confirmation$/.test(c.path)).length, 1);
  assert.equal(sent.length, 1);
  const { msg, opts } = sent[0];
  assert.equal(msg.to, 'travis@traviswales.com');
  assert.deepEqual(msg.cc, [SEAN]);
  assert.equal(msg.fromName, 'Sean at Culina');
  assert.equal(msg.inReplyTo, TRAVIS_ID);
  assert.equal(msg.references, `<older@mail.gmail.com> ${TRAVIS_ID}`);
  assert.equal(msg.subject, 'Re: Culina cases');
  assert.deepEqual(opts, { via: 'resend', resendKey: 're_test' });
  assert.ok(msg.attachments.length >= 1);
  for (const a of msg.attachments) {
    assert.match(a.filename, /\.pdf$/);
    assert.ok(Buffer.isBuffer(a.content));
  }
  for (const s of ['FBA19ABCDEF', 'ONT8', '4-pack', '3-pack', '2-pack', '6-pack', 'UPS', 'Drop the boxes at any UPS location or schedule a UPS pickup']) assert.ok(msg.text.includes(s), s);
  assert.ok(!/[—–]/.test(msg.text + msg.subject));

  // no sales history -> every case to FBA, sized from the config table
  const create = amz.calls.find((c) => c.method === 'POST' && c.path === `${V}/inboundPlans`).params;
  assert.equal(create.name, planName(TRAVIS_ID));
  assert.deepEqual(create.items.map((i) => [i.msku, i.quantity]).sort(), [
    [sku('2-pack').sku, 100], [sku('3-pack').sku, 108], [sku('4-pack').sku, 108], [sku('6-pack').sku, 120],
  ].sort());
  // the 2-pack is expiration-dated on Amazon: plan date + config expiration_years; no other SKU carries one
  const exp = Object.fromEntries(create.items.map((i) => [i.msku, i.expiration]));
  const years = sku('2-pack').expiration_years;
  assert.equal(years, 3);
  const d = new Date(NOW);
  assert.equal(exp[sku('2-pack').sku], `${d.getUTCFullYear() + years}${d.toISOString().slice(4, 10)}`);
  for (const k of ['3-pack', '4-pack', '6-pack']) assert.equal(exp[sku(k).sku], undefined, k);

  const rec = state().messages[TRAVIS_ID];
  assert.equal(rec.step, 'labels_sent');
  assert.equal(rec.quote.total, 45);
  assert.equal(notes.filter((n) => n.immediate).length, 0);
  assert.equal(notes.length, 1); // one deferred digest row
  assert.equal(notes[0].status, 'success');
});

test('a second run with the same mail sends nothing and creates no plan', async () => {
  const s = setup();
  await run(['--apply'], s.deps);
  const sentBefore = s.sent.length;
  const created = s.amz.created();
  const callsBefore = s.amz.calls.length;
  const notesBefore = s.notes.length;
  await run(['--apply'], s.deps);
  assert.equal(s.sent.length, sentBefore);
  assert.equal(s.amz.created(), created);
  assert.equal(s.amz.calls.length, callsBefore);
  assert.equal(s.notes.length, notesBefore); // nothing happened, no digest row
});

test('an invalid email sends resendRequest to Travis and makes 0 SP-API calls', async () => {
  const { amz, deps, sent, state } = setup({ mail: [mailRow({ text: '4-pack (9 cases - 100 units)\n3-pack (9 cases - 108 units)' })] });
  await run(['--apply'], deps);
  assert.equal(amz.calls.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].msg.to, 'travis@traviswales.com');
  assert.equal(sent[0].msg.inReplyTo, TRAVIS_ID);
  assert.ok(sent[0].msg.text.includes('4-pack (9 cases - 100 units)'));
  const rec = state().messages[TRAVIS_ID];
  assert.equal(rec.step, 'invalid_replied');
  assert.equal(rec.resendRequestId, '<sent-1@realskincare.com>');
});

test('a resend replying to our resend request books, even when it reads like a correction', async () => {
  const s = setup({ mail: [mailRow({ text: '4-pack (9 cases - 100 units)' })] });
  await run(['--apply'], s.deps);
  // Travis answers our request; an unrelated earlier booking of the same list must not hold it.
  const state = s.state();
  state.messages['<old@x>'] = { messageId: '<old@x>', step: 'labels_sent', receivedAt: '2026-11-11T10:00:00Z', signature: 'irrelevant' };
  writeFileSync(s.deps.statePath, JSON.stringify(state));
  s.deps.fetchMail = async () => [mailRow({ messageId: '<resend@x>', inReplyTo: '<sent-1@realskincare.com>', references: [TRAVIS_ID, '<sent-1@realskincare.com>'], text: `Sorry, here it is\n${EMAIL}`, date: '2026-11-12T16:30:00Z' })];
  await run(['--apply'], s.deps);
  const rec = s.state().messages['<resend@x>'];
  assert.equal(rec.resendOf, TRAVIS_ID);
  assert.equal(rec.step, 'labels_sent');
});

test('a held duplicate makes 0 SP-API calls and sends 1 email, to Sean only', async () => {
  const s = setup();
  await run(['--apply'], s.deps);
  const calls = s.amz.calls.length;
  s.deps.fetchMail = async () => [mailRow({ messageId: '<fwd@x>', date: '2026-11-12T16:45:00Z' })];
  await run(['--apply'], s.deps);
  assert.equal(s.amz.calls.length, calls);
  assert.equal(s.sent.length, 2);
  assert.equal(s.sent[1].msg.to, SEAN);
  assert.equal(s.sent[1].msg.cc, undefined);
  assert.equal(s.state().messages['<fwd@x>'].step, 'held');
});

test('an email already covered by a later manual plan books nothing and sends Sean one note', async () => {
  const created = '2026-11-12T16:20:00Z';
  const manualPlans = [
    { inboundPlanId: 'manual1', name: 'Sean by hand', status: 'ACTIVE', createdAt: created },
    { inboundPlanId: 'old1', name: 'older', status: 'SHIPPED', createdAt: '2026-11-01T00:00:00Z' },
  ];
  const planItems = {
    manual1: [sku('4-pack'), sku('3-pack'), sku('6-pack')].map((s, i) => ({ msku: s.sku, quantity: [108, 108, 120][i] })),
    old1: [{ msku: sku('2-pack').sku, quantity: 100 }],
  };
  const awdShipments = [{ shipmentId: 'AWDX', createdAt: created, skuQuantities: [{ sku: sku('2-pack').sku, expectedQuantity: { quantity: 5, unitOfMeasurement: 'CASES' } }] }];
  const { amz, deps, sent, state } = setup({ amazon: { manualPlans, planItems, awdShipments } });
  await run(['--apply'], deps);
  assert.equal(amz.created(), 0);
  assert.equal(amz.calls.filter((c) => c.method !== 'GET').length, 0);
  assert.equal(amz.calls.filter((c) => c.path === `${V}/inboundPlans/old1/items`).length, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].msg.to, SEAN);
  assert.match(sent[0].msg.text, /manual1/);
  assert.equal(state().messages[TRAVIS_ID].step, 'done');
});

test('partial manual overlap holds the message for Sean', async () => {
  const manualPlans = [{ inboundPlanId: 'manual1', name: 'by hand', status: 'ACTIVE', createdAt: '2026-11-12T16:20:00Z' }];
  const planItems = { manual1: [{ msku: sku('4-pack').sku, quantity: 36 }] };
  const { amz, deps, sent, state } = setup({ amazon: { manualPlans, planItems } });
  await run(['--apply'], deps);
  assert.equal(amz.created(), 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].msg.to, SEAN);
  assert.equal(state().messages[TRAVIS_ID].step, 'held');
});

test('a plan whose items call answers 400 (AWD-type plan) is skipped, and our own plans never count', async () => {
  const manualPlans = [
    { inboundPlanId: 'awdtype', name: 'awd', status: 'ACTIVE', createdAt: '2026-11-12T16:20:00Z' },
    { inboundPlanId: 'ours', name: planName(TRAVIS_ID), status: 'ACTIVE', createdAt: '2026-11-12T16:21:00Z' },
  ];
  const planItems = { awdtype: new Error(`SP-API GET ${V}/inboundPlans/awdtype/items failed (400): InvalidInput`), ours: [{ msku: sku('4-pack').sku, quantity: 108 }] };
  const { amz, deps, state } = setup({ amazon: { manualPlans, planItems } });
  await run(['--apply'], deps);
  assert.equal(amz.calls.filter((c) => c.path === `${V}/inboundPlans/ours/items`).length, 0);
  assert.equal(state().messages[TRAVIS_ID].step, 'labels_sent');
});

test('bookFba throwing gives exactly one immediate notify and a failed record; the next run resumes without re-notifying', async () => {
  const failOn = (m, p) => m === 'POST' && p.endsWith('/packingInformation');
  const s = setup({ amazon: { failOn } });
  await run(['--apply'], s.deps);
  const imm = s.notes.filter((n) => n.immediate);
  assert.equal(imm.length, 1);
  assert.equal(imm[0].status, 'error');
  assert.match(imm[0].body, /InternalFailure/);
  assert.match(imm[0].body, new RegExp(PLAN));
  const rec = s.state().messages[TRAVIS_ID];
  assert.equal(rec.step, 'failed');
  assert.equal(rec.failedAtStep, 'plan_created');
  assert.equal(s.sent.length, 0);

  await run(['--apply'], s.deps); // fails again at the same step
  assert.equal(s.notes.filter((n) => n.immediate).length, 1);
  assert.equal(s.amz.created(), 1); // resumed the same plan, never a second create
});

test('labels not ready after confirm: record stays confirmed, retried next run, Sean told only after 6 misses', async () => {
  const s = setup({ amazon: { labelsReady: false } });
  await run(['--apply'], s.deps);
  let rec = s.state().messages[TRAVIS_ID];
  assert.equal(rec.step, 'confirmed');
  assert.equal(rec.labelMisses, 1);
  assert.equal(s.notes.filter((n) => n.immediate).length, 0);
  for (let i = 0; i < 6; i++) await run(['--apply'], s.deps);
  rec = s.state().messages[TRAVIS_ID];
  assert.equal(rec.step, 'confirmed');
  assert.equal(s.notes.filter((n) => n.immediate).length, 1);
  assert.equal(s.amz.calls.filter((c) => /transportationOptions\/confirmation$/.test(c.path)).length, 1);
  assert.equal(s.sent.length, 0);
});

test('an AWD share is handed to Sean, and a matching AWD shipment on a later run sends awdLabelsReply', async () => {
  // 4-pack: steady 2/day for 120 days and 1,000 in FBA -> every case to AWD; the rest have no pace -> FBA.
  const days = [];
  for (let i = 120; i >= 1; i--) days.push({ interval: new Date(Date.parse('2026-11-12T00:00:00Z') - i * 864e5).toISOString().slice(0, 10) + 'T00:00-08:00', unitCount: 2 });
  const four = sku('4-pack');
  const amazon = {
    sales: { [four.asin]: days },
    inventory: [{ sellerSku: four.sku, asin: four.asin, inventoryDetails: { fulfillableQuantity: 1000 } }],
  };
  const s = setup({ amazon });
  await run(['--apply'], s.deps);
  assert.equal(s.sent.length, 2);
  assert.equal(s.sent[0].msg.to, 'travis@traviswales.com');
  assert.match(s.sent[0].msg.text, /AWD/);
  assert.equal(s.sent[1].msg.to, SEAN); // handoff
  assert.match(s.sent[1].msg.text, /Seller Central/);
  assert.match(s.sent[1].msg.text, new RegExp(four.asin));
  const create = s.amz.calls.find((c) => c.method === 'POST' && c.path === `${V}/inboundPlans`).params;
  assert.ok(!create.items.some((i) => i.msku === four.sku));
  const rec = s.state().messages[TRAVIS_ID];
  assert.deepEqual(rec.awdShare.lines.map((l) => [l.sku, l.cases]), [[four.sku, 9]]);

  // Sean creates the AWD inbound in Seller Central; the next run finds it.
  s.advance(3600e3);
  s.amz.calls.length = 0;
  const later = new Date(Date.parse(NOW) + 1800e3).toISOString();
  const s2amazon = fakeAmazon({ ...amazon, awdShipments: [{ shipmentId: 'STARAWD1', createdAt: later, skuQuantities: [{ sku: four.sku, expectedQuantity: { quantity: 9, unitOfMeasurement: 'CASES' } }] }] });
  s.deps.request = s2amazon.request;
  await run(['--apply'], s.deps);
  assert.equal(s.sent.length, 3);
  const reply = s.sent[2].msg;
  assert.equal(reply.to, 'travis@traviswales.com');
  assert.deepEqual(reply.cc, [SEAN]);
  assert.equal(reply.inReplyTo, TRAVIS_ID);
  assert.match(reply.text, /STARAWD1/);
  assert.equal(reply.attachments[0].filename, 'STARAWD1-labels.pdf');
  assert.ok(s.state().messages[TRAVIS_ID].awdShare.labelsSentAt);
  assert.equal(s2amazon.created(), 0);

  await run(['--apply'], s.deps); // nothing more to do
  assert.equal(s.sent.length, 3);
});

test('an AWD share with no matching shipment after 3 days reminds Sean once', async () => {
  const days = [];
  for (let i = 120; i >= 1; i--) days.push({ interval: new Date(Date.parse('2026-11-12T00:00:00Z') - i * 864e5).toISOString().slice(0, 10) + 'T00:00-08:00', unitCount: 2 });
  const four = sku('4-pack');
  const s = setup({ amazon: { sales: { [four.asin]: days }, inventory: [{ sellerSku: four.sku, asin: four.asin, inventoryDetails: { fulfillableQuantity: 1000 } }] } });
  await run(['--apply'], s.deps);
  s.advance(3 * 864e5 + 60e3);
  await run(['--apply'], s.deps);
  await run(['--apply'], s.deps);
  const reminders = s.sent.filter((x) => /still not created/.test(x.msg.subject));
  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].msg.to, SEAN);
});

test('enabled: false makes no calls', async () => {
  const { amz, deps, sent, notes, fetches } = setup({ config: { enabled: false } });
  const out = await run(['--apply'], deps);
  assert.equal(out.skipped, 'disabled');
  assert.equal(amz.calls.length, 0);
  assert.equal(sent.length + notes.length + fetches.length, 0);
  assert.ok(!existsSync(deps.statePath));
});

test('process_after: mail at or before the cutoff is never read; the next email books', async () => {
  const old = setup({ config: { process_after: '2026-11-12T16:00:00Z' } });
  const out = await run(['--apply'], old.deps);
  assert.equal(SP(old.amz).length, 0);
  assert.equal(old.sent.length, 0);
  assert.equal(old.fetches[0].since.toISOString(), '2026-11-12T16:00:00.001Z');
  assert.ok(out);

  const next = setup({ config: { process_after: '2026-11-12T16:00:00Z' }, mail: [mailRow({ messageId: '<next@x>', date: '2026-11-12T16:05:00Z' })] });
  await run(['--apply'], next.deps);
  assert.equal(next.sent.filter((m) => m.msg.to === 'travis@traviswales.com').length, 1);

  const bad = setup({ config: { process_after: 'tomorrow' } });
  await assert.rejects(run(['--apply'], bad.deps), /process_after/);
});

test('the committed config sets a process_after cutoff', () => {
  assert.ok(Number.isFinite(Date.parse(CONFIG.process_after)));
});

test('an unreadable state file notifies once, immediately, and throws before any call', async () => {
  const s = setup();
  writeFileSync(s.deps.statePath, '{ not json');
  await assert.rejects(run(['--apply'], s.deps), /unreadable/);
  assert.equal(s.notes.length, 1);
  assert.equal(s.notes[0].immediate, true);
  assert.equal(s.amz.calls.length + s.fetches.length + s.sent.length, 0);
});

test('mail filters: other senders, auto replies and old messages are ignored', async () => {
  const mail = [
    mailRow({ messageId: '<a@x>', from: 'someone@else.com' }),
    mailRow({ messageId: '<b@x>', autoSubmitted: true }),
    mailRow({ messageId: '<c@x>', date: '2026-10-01T00:00:00Z' }),
  ];
  const { amz, deps, sent, fetches } = setup({ mail });
  await run(['--apply'], deps);
  assert.equal(amz.calls.length + sent.length, 0);
  assert.equal(fetches[0].since.toISOString(), '2026-10-29T17:00:00.000Z');
  assert.deepEqual(fetches[0].senders, ['travis@traviswales.com']);
});

test('dry run with --text quotes, cancels the draft, sends nothing and writes no state', async () => {
  const { amz, deps, sent, notes } = setup({ mail: [] });
  const logs = [];
  deps.log = (l) => logs.push(String(l));
  await run(['--dry-run', '--text', EMAIL], deps);
  assert.equal(sent.length, 0);
  assert.equal(notes.length, 0);
  assert.ok(!existsSync(deps.statePath));
  assert.equal(amz.calls.filter((c) => CONFIRMS.test(c.path)).length, 0);
  assert.equal(amz.calls.filter((c) => c.method === 'PUT' && c.path === `${V}/inboundPlans/${PLAN}/cancellation`).length, 1);
  const create = amz.calls.find((c) => c.method === 'POST' && c.path === `${V}/inboundPlans`).params;
  const id = `text-${createHash('sha256').update(EMAIL).digest('hex').slice(0, 12)}`;
  assert.equal(create.name, dryPlanName(id)); // never the name a real booking of this message would adopt
  assert.match(create.name, /^culina-dry-/);
  const out = logs.join('\n');
  assert.match(out, /Cheapest total: \$45/);
  assert.match(out, /6-pack: 10 case\(s\) to FBA, 0 to AWD/);
  assert.match(out, /plA: placement \$5, 1 shipment\(s\), lowest total \$45/);
  assert.match(out, /s1: parcel \$40, LTL not offered/);
});

test('setup-cron.sh runs the agent at :07/:22/:37/:52 with --apply and no TZ= prefix', () => {
  const cron = readFileSync('scripts/setup-cron.sh', 'utf8');
  assert.match(cron, /EVERY_15_AMAZON_INBOUND="7,22,37,52 \* \* \* \* cd \\"\$PROJECT_DIR\\" && \$NODE agents\/amazon-inbound\/index\.js --apply >> data\/reports\/scheduler\/amazon-inbound\.log 2>&1"/);
  assert.match(cron, /^\$EVERY_15_AMAZON_INBOUND$/m);
  assert.ok(!/TZ=/.test(cron.split('\n').filter((l) => l.includes('amazon-inbound')).join('\n')));
});

// ---- fix round 1 ------------------------------------------------------------------

const AWD_DAYS = () => {
  const days = [];
  for (let i = 120; i >= 1; i--) days.push({ interval: new Date(Date.parse('2026-11-12T00:00:00Z') - i * 864e5).toISOString().slice(0, 10) + 'T00:00-08:00', unitCount: 2 });
  return days;
};
const awdAmazon = (extra = {}) => {
  const four = sku('4-pack');
  return { sales: { [four.asin]: AWD_DAYS() }, inventory: [{ sellerSku: four.sku, asin: four.asin, inventoryDetails: { fulfillableQuantity: 1000 } }], ...extra };
};

test('an ACTIVE dry-run draft with the same SKUs is never read as a manual booking', async () => {
  const manualPlans = [{ inboundPlanId: 'drydraft', name: dryPlanName(TRAVIS_ID), status: 'ACTIVE', createdAt: '2026-11-12T16:20:00Z' }];
  const planItems = { drydraft: [['4-pack', 108], ['3-pack', 108], ['2-pack', 100], ['6-pack', 120]].map(([k, q]) => ({ msku: sku(k).sku, quantity: q })) };
  const { amz, deps, state } = setup({ amazon: { manualPlans, planItems } });
  await run(['--apply'], deps);
  assert.equal(amz.calls.filter((c) => c.path === `${V}/inboundPlans/drydraft/items`).length, 0);
  assert.equal(amz.created(), 1);
  assert.equal(state().messages[TRAVIS_ID].step, 'labels_sent');
});

test('dry run: a failed cancelDraft prints LEFT ACTIVE and returns a non-zero exit code', async () => {
  const failOn = (m, p) => m === 'PUT' && p.endsWith('/cancellation');
  const { deps } = setup({ mail: [], amazon: { failOn } });
  const logs = [];
  deps.log = (l) => logs.push(String(l));
  const out = await run(['--dry-run', '--text', EMAIL], deps);
  assert.equal(out.exitCode, 1);
  assert.deepEqual(out.leftActive, [PLAN]);
  assert.match(logs.join('\n'), new RegExp(`DRAFT PLAN ${PLAN} \\(culina-dry-[0-9a-f]{8}\\) LEFT ACTIVE, cancel it in Seller Central`));
});

test('an AWD shipment that only partly matches the pending share emails Sean once per shipment', async () => {
  const four = sku('4-pack');
  const s = setup({ amazon: awdAmazon() });
  await run(['--apply'], s.deps);
  const sentBefore = s.sent.length;
  s.advance(3600e3);
  const later = new Date(Date.parse(NOW) + 1800e3).toISOString();
  s.deps.request = fakeAmazon(awdAmazon({ awdShipments: [{ shipmentId: 'STARAWD2', createdAt: later, skuQuantities: [{ sku: four.sku, expectedQuantity: { quantity: 7, unitOfMeasurement: 'CASES' } }] }] })).request;
  await run(['--apply'], s.deps);
  await run(['--apply'], s.deps);
  const partial = s.sent.slice(sentBefore);
  assert.equal(partial.length, 1);
  assert.equal(partial[0].msg.to, SEAN);
  assert.match(partial[0].msg.subject, /STARAWD2 only partly matches/);
  assert.match(partial[0].msg.text, /9 x 4-pack/);
  assert.ok(!/[—–]/.test(partial[0].msg.text + partial[0].msg.subject));
  const share = s.state().messages[TRAVIS_ID].awdShare;
  assert.equal(share.awdShipmentId, undefined);
  assert.deepEqual(share.partialNotified, ['STARAWD2']);
});

test('AWD labels stuck in GENERATING: Sean gets one failureNotice after 6 misses', async () => {
  const four = sku('4-pack');
  const s = setup({ amazon: awdAmazon() });
  await run(['--apply'], s.deps);
  s.advance(3600e3);
  const later = new Date(Date.parse(NOW) + 1800e3).toISOString();
  s.deps.request = fakeAmazon(awdAmazon({ awdLabelStatus: 'GENERATING', awdShipments: [{ shipmentId: 'STARAWD3', createdAt: later, skuQuantities: [{ sku: four.sku, expectedQuantity: { quantity: 9, unitOfMeasurement: 'CASES' } }] }] })).request;
  for (let i = 0; i < 5; i++) await run(['--apply'], s.deps);
  assert.equal(s.notes.filter((n) => n.immediate).length, 0);
  for (let i = 0; i < 3; i++) await run(['--apply'], s.deps);
  const imm = s.notes.filter((n) => n.immediate);
  assert.equal(imm.length, 1);
  assert.match(imm[0].body, /STARAWD3/);
  assert.equal(s.state().messages[TRAVIS_ID].awdShare.labelMisses, 8);
});

test('a cleared AWD list error is persisted, and a label success clears share.awdError', async () => {
  const four = sku('4-pack');
  const s = setup({ amazon: awdAmazon() });
  await run(['--apply'], s.deps);
  s.advance(3600e3);
  s.deps.request = fakeAmazon(awdAmazon({ failOn: (m, p) => p === `${AWD}/inboundShipments` })).request;
  await run(['--apply'], s.deps);
  assert.match(s.state().awdError, /awd_list/);
  const later = new Date(Date.parse(NOW) + 1800e3).toISOString();
  s.deps.request = fakeAmazon(awdAmazon({ awdShipments: [{ shipmentId: 'STARAWD4', createdAt: later, skuQuantities: [{ sku: four.sku, expectedQuantity: { quantity: 9, unitOfMeasurement: 'CASES' } }] }] })).request;
  const st = s.state();
  st.messages[TRAVIS_ID].awdShare.awdError = 'awd_labels: old';
  writeFileSync(s.deps.statePath, JSON.stringify(st));
  await run(['--apply'], s.deps);
  const after = s.state();
  assert.equal(after.awdError, null);
  assert.equal(after.messages[TRAVIS_ID].awdShare.awdError, null);
  assert.ok(after.messages[TRAVIS_ID].awdShare.labelsSentAt);
});

/** A fake /proc with one pid whose cmdline is `cmd`. */
function fakeProc(dir, pid, cmd) {
  const root = join(dir, 'proc');
  mkdirSync(join(root, String(pid)), { recursive: true });
  writeFileSync(join(root, String(pid), 'cmdline'), cmd.split(' ').join('\0'));
  return root;
}
const lockJson = (pid, ageMs) => JSON.stringify({ pid, startedAt: new Date(Date.now() - ageMs).toISOString() });

test('lock: created as { pid, startedAt }; a live pid (no /proc) is never taken over however old; a dead pid is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amz-lock-'));
  const lock = join(dir, '.lock');
  const noProc = { procRoot: join(dir, 'no-proc') };
  assert.deepEqual(acquireLock(lock, noProc), { acquired: true });
  const held = JSON.parse(readFileSync(lock, 'utf8'));
  assert.equal(held.pid, process.pid);
  assert.ok(Number.isFinite(Date.parse(held.startedAt)));
  writeFileSync(lock, lockJson(process.pid, 48 * 3600e3)); // alive
  assert.equal(acquireLock(lock, noProc).acquired, false);
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();
  writeFileSync(lock, dead); // old bare-pid format; that process has exited
  assert.equal(acquireLock(lock, noProc).acquired, true);
  assert.equal(JSON.parse(readFileSync(lock, 'utf8')).pid, process.pid);
});

test('lock: a pid reused by another process (its /proc cmdline is not this agent) is taken over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amz-lock-'));
  const lock = join(dir, '.lock');
  const procRoot = fakeProc(dir, process.pid, '/usr/sbin/sshd -D'); // alive, but not us
  writeFileSync(lock, lockJson(process.pid, 60e3));
  assert.equal(acquireLock(lock, { procRoot }).acquired, true);
  // and a pid with no /proc entry at all is dead
  writeFileSync(lock, lockJson(999999, 60e3));
  assert.equal(acquireLock(lock, { procRoot }).acquired, true);
});

test('lock: a live agent run held over 2 hours is not taken over; Sean is emailed once per 6 hours', async () => {
  const s = setup();
  s.deps.procRoot = fakeProc(s.dir, process.pid, '/usr/bin/node agents/amazon-inbound/index.js --apply');
  writeFileSync(s.deps.lockPath, lockJson(process.pid, 3 * 3600e3));
  const out = await run(['--apply'], s.deps);
  assert.equal(out.skipped, 'locked');
  await run(['--apply'], s.deps);
  const imm = s.notes.filter((n) => n.immediate);
  assert.equal(imm.length, 1);
  assert.equal(imm[0].status, 'error');
  assert.match(imm[0].subject, /over 2 hours/);
  assert.match(imm[0].body, new RegExp(`pid ${process.pid}`));
  assert.equal(s.amz.calls.length + s.fetches.length + s.sent.length, 0);
  assert.equal(JSON.parse(readFileSync(s.deps.lockPath, 'utf8')).pid, process.pid); // untouched
  const marker = join(s.dir, '.lock-stuck-notified');
  const old = new Date(Date.now() - 7 * 3600e3);
  utimesSync(marker, old, old);
  await run(['--apply'], s.deps);
  assert.equal(s.notes.filter((n) => n.immediate).length, 2);
});

test('lock: a live agent run under 2 hours is skipped quietly', async () => {
  const s = setup();
  s.deps.procRoot = fakeProc(s.dir, process.pid, '/usr/bin/node agents/amazon-inbound/index.js --apply');
  writeFileSync(s.deps.lockPath, lockJson(process.pid, 30 * 60e3));
  const out = await run(['--apply'], s.deps);
  assert.equal(out.skipped, 'locked');
  assert.equal(s.amz.calls.length + s.fetches.length + s.sent.length + s.notes.length, 0);
});

test('run exits quietly (no calls) when a live run holds the lock', async () => {
  const s = setup();
  writeFileSync(s.deps.lockPath, String(process.ppid));
  const out = await run(['--apply'], s.deps);
  assert.equal(out.skipped, 'locked');
  assert.equal(s.amz.calls.length + s.fetches.length + s.sent.length + s.notes.length, 0);
});

test('unreadable state: immediate notify at most once per 6 hours, throws every run', async () => {
  const s = setup();
  writeFileSync(s.deps.statePath, '{ not json');
  await assert.rejects(run(['--apply'], s.deps), /unreadable/);
  await assert.rejects(run(['--apply'], s.deps), /unreadable/);
  assert.equal(s.notes.filter((n) => n.immediate).length, 1);
  const marker = join(s.dir, '.unreadable-notified');
  const old = new Date(Date.now() - 7 * 3600e3);
  utimesSync(marker, old, old);
  await assert.rejects(run(['--apply'], s.deps), /unreadable/);
  assert.equal(s.notes.filter((n) => n.immediate).length, 2);
});

test('a none parse records done and adds one deferred info digest event naming the subject', async () => {
  const { amz, deps, notes, state } = setup({ mail: [mailRow({ subject: 'Lunch Friday?', text: 'Want to grab lunch Friday?' })] });
  await run(['--apply'], deps);
  assert.equal(amz.calls.length, 0);
  assert.equal(state().messages[TRAVIS_ID].step, 'done');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].immediate, undefined);
  assert.equal(notes[0].status, 'info');
  assert.match(notes[0].body, /Lunch Friday\?/);
});

// ---- final review fixes -------------------------------------------------------------

test('Hushmail unreadable: a confirmed record still gets its labels; one digest row a day; Sean emailed once past an hour', async () => {
  const s = setup({ amazon: { labelsReady: false } });
  await run(['--apply'], s.deps);
  assert.equal(s.state().messages[TRAVIS_ID].step, 'confirmed');
  const notesBefore = s.notes.length;

  s.deps.fetchMail = async () => { throw new Error('IMAP login failed: connection refused'); };
  s.deps.request = fakeAmazon({ labelsReady: true }).request;
  s.advance(15 * 60e3);
  const out = await run(['--apply'], s.deps);
  assert.equal(s.state().messages[TRAVIS_ID].step, 'labels_sent');
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].msg.to, 'travis@traviswales.com');
  assert.ok(s.sent[0].msg.attachments.length >= 1);
  assert.ok(out.errors.some((e) => e.step === 'read_mail'));
  const after1 = s.notes.slice(notesBefore);
  assert.equal(after1.filter((n) => n.immediate).length, 0); // not yet an hour
  assert.equal(after1.length, 1); // the run's digest row
  assert.match(after1[0].body, /Hushmail unreadable/);

  // 15 minutes later, still down: no new digest row, no email
  s.advance(15 * 60e3);
  await run(['--apply'], s.deps);
  assert.equal(s.notes.length, notesBefore + 1);

  // past an hour: one immediate email, then not again on the next run
  s.advance(50 * 60e3);
  await run(['--apply'], s.deps);
  await run(['--apply'], s.deps);
  const imm = s.notes.filter((n) => n.immediate);
  assert.equal(imm.length, 1);
  assert.match(imm[0].subject, /Hushmail unreadable for over an hour/);
  assert.equal(s.notes.length, notesBefore + 2);

  // mail back: the outage is cleared
  s.deps.fetchMail = async () => [];
  await run(['--apply'], s.deps);
  assert.equal(s.state().mailError, null);
});

test('LTL labels email names pallets by pack, never by raw MSKU', async () => {
  const s = setup({ amazon: { ltl: true } });
  s.deps.contactPhone = '5550000000';
  await run(['--apply'], s.deps);
  const msg = s.sent[0].msg;
  assert.match(msg.text, /freight \(LTL\)/);
  const pallets = msg.text.split('\n').filter((l) => /^- Pallet \d/.test(l));
  assert.ok(pallets.length >= 1);
  for (const l of pallets) {
    for (const k of CONFIG.skus) assert.ok(!l.includes(k.sku), `${l} carries ${k.sku}`);
    assert.match(l, /\d+ x \d-pack/);
  }
});

test('AWD handoff carries the 2-pack expiration date the FBA booking would declare (ship date + 3 years)', async () => {
  const two = sku('2-pack');
  const days = AWD_DAYS();
  const s = setup({ amazon: { sales: { [two.asin]: days }, inventory: [{ sellerSku: two.sku, asin: two.asin, inventoryDetails: { fulfillableQuantity: 1000 } }] } });
  await run(['--apply'], s.deps);
  const handoff = s.sent.find((x) => x.msg.to === SEAN);
  assert.ok(handoff);
  assert.match(handoff.msg.text, new RegExp(`2-pack, SKU ${two.sku}.*expiration date 2029-11-12`));
  assert.deepEqual(s.state().messages[TRAVIS_ID].awdShare.lines.map((l) => l.expiration), ['2029-11-12']);
  // and the split reason states the current FBA cover, once
  assert.match(handoff.msg.text, /2-pack: 500 days of FBA cover, so 0 cases to FBA, 5 to AWD/);
  assert.ok(!/days of FBA cover now/.test(handoff.msg.text));
});
