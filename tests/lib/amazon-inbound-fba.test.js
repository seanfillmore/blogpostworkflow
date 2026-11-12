import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bookFba, fetchFbaLabels, cancelDraft, netIncentives } from '../../lib/amazon-inbound-fba.js';
import { planName } from '../../lib/amazon-inbound-state.js';

const config = JSON.parse(readFileSync(new URL('../../config/amazon-inbound.json', import.meta.url), 'utf8'));
const V = '/inbound/fba/2024-03-20';
const PLAN = 'wf' + 'p'.repeat(36);
const usd = (amount) => ({ amount, code: 'USD' });
const fee = (amount) => ({ type: 'FEE', target: 'Placement Services', description: 'fee', value: usd(amount) });

const item = (key) => {
  const s = config.skus.find((x) => x.key === key);
  return { sku: s.sku, cases: 4, unitsPerCase: s.units_per_case, case_in: s.case_in, case_lb: s.case_lb };
};
const ITEMS = [item('2-pack'), item('3-pack')];

/**
 * A scripted fake Amazon. Records every call; returns canned responses.
 * placements: [{ id, fees, discounts, shipments: { shipId: [ {id, mode, amount, solution?} ] } }]
 */
function fakeAmazon({ placements, planStatus = 'ACTIVE', existingPlans = [], opStatus = 'SUCCESS', ltlOffered = true, failFirst429 = false, acceptedPlacement = null, selectedTransport = {} } = {}) {
  const calls = [];
  let accepted = acceptedPlacement;
  let op = 0;
  let threw429 = false;
  const transport = {};
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (failFirst429 && !threw429) {
      threw429 = true;
      throw new Error(`SP-API ${method} ${path} failed (429): too many`);
    }
    const ok = () => ({ operationId: `op-${++op}` + '0'.repeat(30) });
    if (path.startsWith(`${V}/operations/`)) {
      return { operationId: 'x', operation: 'x', operationStatus: opStatus, operationProblems: opStatus === 'FAILED' ? [{ code: 'E1', message: 'bad thing', severity: 'ERROR' }] : [] };
    }
    if (method === 'GET' && path === `${V}/inboundPlans`) return { inboundPlans: existingPlans };
    if (method === 'POST' && path === `${V}/inboundPlans`) return { inboundPlanId: PLAN, ...ok() };
    const p = `${V}/inboundPlans/${PLAN}`;
    if (method === 'GET' && path === p) return { inboundPlanId: PLAN, name: 'x', status: planStatus };
    if (method === 'GET' && path === `${p}/packingOptions`) {
      return { packingOptions: [{ packingOptionId: 'pk1', status: 'OFFERED', fees: [], discounts: [], packingGroups: ['pg1'], supportedConfigurations: [], supportedShippingConfigurations: [] }] };
    }
    if (method === 'GET' && path === `${p}/packingGroups/pg1/items`) return { items: ITEMS.map((i) => ({ msku: i.sku, quantity: i.cases * i.unitsPerCase })) };
    if (method === 'GET' && path === `${p}/placementOptions`) {
      return {
        placementOptions: placements.map((pl) => ({
          placementOptionId: pl.id,
          status: accepted === pl.id ? 'ACCEPTED' : 'OFFERED',
          fees: pl.fees, discounts: pl.discounts ?? [],
          shipmentIds: Object.keys(pl.shipments),
        })),
      };
    }
    const shipItems = path.match(/\/shipments\/([^/]+)\/items$/);
    if (method === 'GET' && shipItems) return { items: ITEMS.map((i) => ({ msku: i.sku, quantity: 2 * i.unitsPerCase })) };
    if (method === 'POST' && path === `${p}/transportationOptions`) {
      transport[body.placementOptionId] = body;
      return ok();
    }
    if (method === 'GET' && path === `${p}/transportationOptions`) {
      const pl = placements.find((x) => x.id === body.placementOptionId);
      const opts = [];
      for (const [shipmentId, list] of Object.entries(pl.shipments)) {
        for (const o of list) {
          if (o.mode === 'FREIGHT_LTL' && !(ltlOffered && transport[pl.id]?.shipmentTransportationConfigurations.some((c) => c.pallets))) continue;
          opts.push({ transportationOptionId: o.id, shipmentId, shippingMode: o.mode, shippingSolution: o.solution || 'AMAZON_PARTNERED_CARRIER', carrier: {}, preconditions: [], ...(o.amount === null ? {} : { quote: { cost: usd(o.amount) } }) });
        }
      }
      return { transportationOptions: opts };
    }
    const confirmPl = path.match(/\/placementOptions\/([^/]+)\/confirmation$/);
    if (method === 'POST' && confirmPl) { accepted = confirmPl[1]; return ok(); }
    const shipment = path.match(/\/shipments\/([^/]+)$/);
    if (method === 'GET' && shipment) return { shipmentId: shipment[1], shipmentConfirmationId: `FBA-${shipment[1]}`, ...(selectedTransport[shipment[1]] ? { selectedTransportationOptionId: selectedTransport[shipment[1]] } : {}) };
    const boxes = path.match(/\/shipments\/([^/]+)\/boxes$/);
    if (method === 'GET' && boxes) return { boxes: [{ packageId: 'a', boxId: `${boxes[1]}U1` }, { packageId: 'b', boxId: `${boxes[1]}U2` }] };
    if (method === 'GET' && path.startsWith('/fba/inbound/v0/')) return { payload: { DownloadURL: `https://dl/${path}?${body?.LabelType || 'bol'}` } };
    return ok();
  };
  return { request, calls };
}

const PLACEMENTS = [
  // A: $10 placement, ship1 parcel 50 / LTL 30, ship2 parcel 40 -> 10 + 30 + 40 = 80
  { id: 'plA', fees: [fee(10)], shipments: { s1: [{ id: 'tA1p', mode: 'GROUND_SMALL_PARCEL', amount: 50 }, { id: 'tA1l', mode: 'FREIGHT_LTL', amount: 30 }], s2: [{ id: 'tA2p', mode: 'GROUND_SMALL_PARCEL', amount: 40 }] } },
  // B: $0 placement, one shipment parcel 95 -> 95
  { id: 'plB', fees: [], shipments: { s3: [{ id: 'tB3p', mode: 'GROUND_SMALL_PARCEL', amount: 95 }, { id: 'tB3x', mode: 'GROUND_SMALL_PARCEL', amount: 5, solution: 'USE_YOUR_OWN_CARRIER' }] } },
];

function setup(opts = {}) {
  const { apply = true, record = {}, contactPhone: _c, ...fake } = opts;
  const contactPhone = 'contactPhone' in opts ? opts.contactPhone : '5551234567';
  const amz = fakeAmazon({ placements: PLACEMENTS, ...fake });
  const steps = [];
  const deps = { request: amz.request, sleep: async () => {}, now: () => Date.parse('2026-11-12T17:00:30Z'), contactPhone, apply, marketplaceId: 'ATVPDKIKX0DER', download: async (url) => Buffer.from(url) };
  const rec = { messageId: 'msg-1', step: 'claimed', ...record };
  return { amz, deps, rec, steps, persist: (r) => steps.push(r.step) };
}

const named = (calls, re, method = 'POST') => calls.filter((c) => c.method === method && re.test(c.path));
const CONFIRMS = /placementOptions\/[^/]+\/confirmation$|transportationOptions\/confirmation$|deliveryWindowOptions\/[^/]+\/confirmation$/;

test('happy path: confirmed with the cheapest total, LTL included when a phone is set', async () => {
  const { amz, deps, rec, persist } = setup();
  const out = await bookFba({ record: rec, items: ITEMS, config, deps, persist });
  assert.equal(out.step, 'confirmed');
  assert.equal(out.planId, PLAN);
  assert.equal(out.quote.placementOptionId, 'plA');
  assert.equal(out.quote.total, 80);
  assert.deepEqual(out.quote.picks.map((p) => [p.shipmentId, p.transportationOptionId, p.mode]), [['s1', 'tA1l', 'FREIGHT_LTL'], ['s2', 'tA2p', 'GROUND_SMALL_PARCEL']]);
  assert.deepEqual(out.shipmentIds, ['s1', 's2']);

  const create = named(amz.calls, /\/inboundPlans$/)[0].body;
  assert.equal(create.name, planName('msg-1'));
  assert.deepEqual(create.destinationMarketplaces, ['ATVPDKIKX0DER']);
  assert.deepEqual(create.sourceAddress, config.ship_from);
  assert.deepEqual(create.items[0], { msku: ITEMS[0].sku, quantity: 80, labelOwner: 'SELLER', prepOwner: 'SELLER' });

  const pack = named(amz.calls, /\/packingInformation$/)[0].body;
  assert.equal(pack.packageGroupings[0].packingGroupId, 'pg1');
  assert.deepEqual(pack.packageGroupings[0].boxes[0], {
    contentInformationSource: 'BOX_CONTENT_PROVIDED', quantity: 4,
    dimensions: { length: 18, width: 9, height: 12, unitOfMeasurement: 'IN' },
    weight: { value: 27, unit: 'LB' },
    items: [{ msku: ITEMS[0].sku, quantity: 20, labelOwner: 'SELLER', prepOwner: 'SELLER' }],
  });
  // packing option confirmed BEFORE packing information is set (packingGroupId must belong to the confirmed option)
  const idx = (re) => amz.calls.findIndex((c) => c.method === 'POST' && re.test(c.path));
  assert.ok(idx(/packingOptions\/pk1\/confirmation$/) < idx(/packingInformation$/));

  // transport generated for EVERY placement, before any placement is confirmed
  const gens = named(amz.calls, /\/transportationOptions$/);
  assert.deepEqual(gens.map((g) => g.body.placementOptionId), ['plA', 'plB']);
  assert.ok(idx(/transportationOptions$/) < idx(/placementOptions\/plA\/confirmation$/));
  const c1 = gens[0].body.shipmentTransportationConfigurations[0];
  assert.equal(c1.readyToShipWindow.start, '2026-11-12T17:16Z'); // 17:00:30 + 15 min, rounded up
  assert.deepEqual(c1.contactInformation, { name: 'Travis', email: 'travis@traviswales.com', phoneNumber: '5551234567' });
  assert.equal(c1.pallets[0].stackability, 'NON_STACKABLE');
  assert.equal(c1.pallets[0].dimensions.unitOfMeasurement, 'IN');

  const ct = named(amz.calls, /transportationOptions\/confirmation$/)[0].body;
  assert.deepEqual(ct.transportationSelections[0], { shipmentId: 's1', transportationOptionId: 'tA1l', contactInformation: { name: 'Travis', email: 'travis@traviswales.com', phoneNumber: '5551234567' } });
  assert.deepEqual(ct.transportationSelections[1], { shipmentId: 's2', transportationOptionId: 'tA2p' });
  assert.equal(named(amz.calls, /deliveryWindowOptions/).length, 0);
});

test('persist is called with each step in order', async () => {
  const { deps, rec, steps, persist } = setup();
  await bookFba({ record: rec, items: ITEMS, config, deps, persist });
  const distinct = steps.filter((s, i) => s !== steps[i - 1]);
  assert.deepEqual(distinct, ['claimed', 'plan_created', 'packing_confirmed', 'quoted', 'confirmed']);
});

test('dry mode quotes, never confirms placement/transport, and cancelDraft voids the plan', async () => {
  const { amz, deps, rec, persist } = setup({ apply: false });
  const out = await bookFba({ record: rec, items: ITEMS, config, deps, persist });
  assert.equal(out.step, 'quoted');
  assert.equal(out.quote.total, 80);
  assert.equal(amz.calls.filter((c) => CONFIRMS.test(c.path)).length, 0);
  await cancelDraft({ record: out, deps });
  const cancels = amz.calls.filter((c) => c.method === 'PUT' && c.path === `${V}/inboundPlans/${PLAN}/cancellation`);
  assert.equal(cancels.length, 1);
});

test('cancelDraft refuses a confirmed plan', async () => {
  const { deps } = setup();
  await assert.rejects(cancelDraft({ record: { planId: PLAN, step: 'confirmed' }, deps }), /confirmed/);
});

test('crash resume: an existing plan with our name is adopted and createInboundPlan is never called', async () => {
  const existingPlans = [
    { inboundPlanId: 'other', name: 'culina-deadbeef', status: 'ACTIVE' },
    { inboundPlanId: PLAN, name: planName('msg-1'), status: 'ACTIVE' },
  ];
  const { amz, deps, rec, persist } = setup({ existingPlans });
  const out = await bookFba({ record: rec, items: ITEMS, config, deps, persist });
  assert.equal(out.planId, PLAN);
  assert.equal(named(amz.calls, /\/inboundPlans$/).length, 0);
  assert.equal(out.step, 'confirmed');
  const list = amz.calls.find((c) => c.method === 'GET' && c.path === `${V}/inboundPlans`);
  assert.equal(list.body.status, 'ACTIVE');
});

test('a record that already has a planId never lists or creates plans', async () => {
  const { amz, deps, rec, persist } = setup({ record: { planId: PLAN, step: 'plan_created' } });
  await bookFba({ record: rec, items: ITEMS, config, deps, persist });
  assert.equal(amz.calls.filter((c) => c.path === `${V}/inboundPlans`).length, 0);
});

test('all options unquoted: throws no quoted option and confirms nothing', async () => {
  const placements = [
    { id: 'plA', fees: [fee(10)], shipments: { s1: [{ id: 't1', mode: 'GROUND_SMALL_PARCEL', amount: null }] } },
    { id: 'plB', fees: [{ ...fee(0), value: { amount: 3, code: 'EUR' } }], shipments: { s3: [{ id: 't3', mode: 'GROUND_SMALL_PARCEL', amount: 20 }] } },
  ];
  const amz = fakeAmazon({ placements });
  const deps = { request: amz.request, sleep: async () => {}, now: () => Date.now(), contactPhone: undefined, apply: true, marketplaceId: 'M' };
  await assert.rejects(bookFba({ record: { messageId: 'm', step: 'claimed' }, items: ITEMS, config, deps, persist: () => {} }), /no quoted option/);
  assert.equal(amz.calls.filter((c) => CONFIRMS.test(c.path)).length, 0);
});

test('no contactPhone: no LTL request body (no pallets, no contact) is sent and parcel wins', async () => {
  const { amz, deps, rec, persist } = setup({ contactPhone: undefined });
  const out = await bookFba({ record: rec, items: ITEMS, config, deps, persist });
  for (const g of named(amz.calls, /\/transportationOptions$/)) {
    for (const c of g.body.shipmentTransportationConfigurations) {
      assert.deepEqual(Object.keys(c).sort(), ['readyToShipWindow', 'shipmentId']);
    }
  }
  assert.equal(amz.calls.some((c) => /\/shipments\/[^/]+\/items$/.test(c.path)), false);
  assert.ok(out.quote.picks.every((p) => p.mode === 'GROUND_SMALL_PARCEL'));
  assert.equal(out.quote.total, 95); // A = 10 + 50 + 40 = 100, B = 95
  assert.equal(out.quote.placementOptionId, 'plB');
});

test('a FAILED operation throws with Amazon\'s problem text', async () => {
  const { deps, rec, persist } = setup({ opStatus: 'FAILED' });
  await assert.rejects(bookFba({ record: rec, items: ITEMS, config, deps, persist }), /createInboundPlan failed.*E1: bad thing/);
  assert.equal(rec.planId, PLAN); // the id is kept for the operator
});

test('a 429 is retried', async () => {
  const { deps, rec, persist } = setup({ failFirst429: true });
  const out = await bookFba({ record: rec, items: ITEMS, config, deps, persist });
  assert.equal(out.step, 'confirmed');
});

test('fetchFbaLabels: case labels per shipment, pallet labels and BOL for LTL', async () => {
  const { amz, deps, rec, persist } = setup();
  await bookFba({ record: rec, items: ITEMS, config, deps, persist });
  const files = await fetchFbaLabels({ record: rec, deps });
  assert.deepEqual(files.map((f) => f.filename), ['FBA-s1-case-labels.pdf', 'FBA-s1-pallet-labels.pdf', 'FBA-s1-bill-of-lading.pdf', 'FBA-s2-case-labels.pdf']);
  assert.ok(files.every((f) => Buffer.isBuffer(f.content)));
  const labels = amz.calls.filter((c) => c.path === '/fba/inbound/v0/shipments/FBA-s1/labels');
  assert.deepEqual(labels[0].body, { PageType: 'PackageLabel_Thermal', LabelType: 'UNIQUE', PackageLabelsToPrint: ['s1U1', 's1U2'] });
  assert.equal(labels[1].body.LabelType, 'PALLET');
  assert.ok(labels[1].body.NumberOfPallets >= 1);
});

test('netIncentives subtracts discounts whatever their sign; unquoted is null', () => {
  const d = (amount) => ({ type: 'DISCOUNT', target: 'Placement Services', description: 'd', value: usd(amount) });
  assert.equal(netIncentives([fee(10)], [d(3)]), 7);
  assert.equal(netIncentives([fee(10)], [d(-3)]), 7);
  assert.equal(netIncentives([], []), 0);
  assert.equal(netIncentives(undefined, []), null);
  assert.equal(netIncentives([{ value: { amount: 1, code: 'EUR' } }], []), null);
});

test('fix: crash after confirmTransportationOptions: Amazon already shows transport, so no confirm call and step confirmed', async () => {
  const quote = { placementOptionId: 'plA', placementAccepted: true, placementFee: 10, packingFee: 0, total: 80,
    picks: [{ shipmentId: 's1', transportationOptionId: 'tA1l', mode: 'FREIGHT_LTL', amount: 30, preconditions: [], pallets: 1 },
      { shipmentId: 's2', transportationOptionId: 'tA2p', mode: 'GROUND_SMALL_PARCEL', amount: 40, preconditions: [] }] };
  const { amz, deps, rec, steps, persist } = setup({
    record: { planId: PLAN, step: 'quoted', quote },
    acceptedPlacement: 'plA',
    selectedTransport: { s1: 'tA1l', s2: 'tA2p' },
  });
  const out = await bookFba({ record: rec, items: ITEMS, config, deps, persist });
  assert.equal(out.step, 'confirmed');
  assert.deepEqual(steps, ['confirmed']);
  assert.equal(amz.calls.filter((c) => CONFIRMS.test(c.path)).length, 0);
  assert.equal(named(amz.calls, /\/transportationOptions$/).length, 0);
  assert.equal(named(amz.calls, /\/placementOptions$/).length, 0);
  assert.deepEqual(out.shipmentIds, ['s1', 's2']);
  assert.equal(out.quote.picks[0].pallets, 1);
  const files = await fetchFbaLabels({ record: out, deps });
  assert.equal(files.length, 4);
});

test('fix: a record already holding transport on some shipments only throws for a human, no confirm', async () => {
  const { amz, deps, rec, persist } = setup({ record: { planId: PLAN, step: 'quoted' }, acceptedPlacement: 'plA', selectedTransport: { s1: 'tA1l' } });
  await assert.rejects(bookFba({ record: rec, items: ITEMS, config, deps, persist }), /1 of 2 shipments/);
  assert.equal(amz.calls.filter((c) => CONFIRMS.test(c.path)).length, 0);
});

for (const step of ['confirmed', 'labels_sent', 'done']) {
  test(`fix: step ${step} is terminal: zero calls, record untouched`, async () => {
    const { amz, deps, steps, persist } = setup();
    const rec = { messageId: 'm', step, planId: PLAN, updatedAt: 'x' };
    const before = JSON.stringify(rec);
    const out = await bookFba({ record: rec, items: ITEMS, config, deps, persist });
    assert.equal(amz.calls.length, 0);
    assert.equal(steps.length, 0);
    assert.equal(JSON.stringify(out), before);
  });
}

test('fix: an LTL pick with no contact phone is refused before any confirm call', async () => {
  // The quote step already drops LTL without a phone; this guard is the confirm-side backstop.
  // Simulate the phone being present when quoting and missing when confirming.
  const placements = [{ id: 'plA', fees: [fee(10)], shipments: { s1: [{ id: 'tA1l', mode: 'FREIGHT_LTL', amount: 30 }] } }];
  const amz = fakeAmazon({ placements });
  let reads = 0;
  const deps = { request: amz.request, sleep: async () => {}, now: () => Date.now(), apply: true, marketplaceId: 'M',
    get contactPhone() { return reads++ === 0 ? '5551234567' : undefined; } };
  await assert.rejects(
    bookFba({ record: { messageId: 'm', step: 'claimed' }, items: ITEMS, config, deps, persist: () => {} }),
    /LTL.*AMAZON_INBOUND_CONTACT_PHONE/,
  );
  assert.equal(amz.calls.filter((c) => CONFIRMS.test(c.path)).length, 0);
});

test('a record carrying planName creates (and adopts) a plan under that name', async () => {
  const { amz, deps, persist } = setup({ apply: false });
  const rec = { messageId: 'msg-1', step: 'claimed', planName: 'culina-dry-12345678' };
  await bookFba({ record: rec, items: ITEMS, config, deps, persist });
  assert.equal(named(amz.calls, /\/inboundPlans$/)[0].body.name, 'culina-dry-12345678');
});

test('an expiration-dated item carries the same expiration on the plan item and on its box items (FBA_INB_0180)', async () => {
  const { amz, deps, rec, persist } = setup({ apply: false });
  const dated = [{ ...ITEMS[0], expiration: '2029-11-12' }, ITEMS[1]];
  await bookFba({ record: rec, items: dated, config, deps, persist });
  const create = named(amz.calls, /\/inboundPlans$/)[0].body;
  assert.deepEqual(create.items[0], { msku: ITEMS[0].sku, quantity: 80, labelOwner: 'SELLER', prepOwner: 'SELLER', expiration: '2029-11-12' });
  assert.equal('expiration' in create.items[1], false);
  const boxes = named(amz.calls, /\/packingInformation$/)[0].body.packageGroupings[0].boxes;
  assert.deepEqual(boxes[0].items, [{ msku: ITEMS[0].sku, quantity: 20, labelOwner: 'SELLER', prepOwner: 'SELLER', expiration: '2029-11-12' }]);
  assert.equal('expiration' in boxes[1].items[0], false);
});

test('readyToShipWindow.start is taken per placement, just before its request, so a slow run never sends a past time', async () => {
  const { amz, deps, rec, persist } = setup({ apply: false });
  let t = Date.parse('2026-11-12T17:00:30Z');
  deps.now = () => (t += 60000); // every read of the clock is a minute later
  await bookFba({ record: rec, items: ITEMS, config, deps, persist });
  const gens = named(amz.calls, /\/transportationOptions$/);
  const starts = gens.map((g) => g.body.shipmentTransportationConfigurations[0].readyToShipWindow.start);
  assert.notEqual(starts[0], starts[1]);
  for (const s of starts) assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/);
  assert.equal(rec.quote.readyToShip, starts[gens.findIndex((g) => g.body.placementOptionId === rec.quote.placementOptionId)]);
});

for (const status of ['ERRORED', 'VOIDED']) {
  test(`a recorded plan that is ${status} throws naming the plan and the state.json fix, and calls nothing else`, async () => {
    const { amz, deps, rec, persist } = setup({ record: { planId: PLAN, step: 'packing_confirmed' }, planStatus: status });
    await assert.rejects(
      bookFba({ record: rec, items: ITEMS, config, deps, persist }),
      (err) => err.message.includes(PLAN) && err.message.includes(status) && err.message.includes('remove planId') && err.message.includes('data/amazon-inbound/state.json'),
    );
    assert.deepEqual(amz.calls.map((c) => `${c.method} ${c.path}`), [`GET ${V}/inboundPlans/${PLAN}`]);
  });
}

test('a recorded ACTIVE plan resumes normally after the status read', async () => {
  const { amz, deps, rec, persist } = setup({ record: { planId: PLAN, step: 'plan_created' } });
  const out = await bookFba({ record: rec, items: ITEMS, config, deps, persist });
  assert.equal(out.step, 'confirmed');
  assert.equal(amz.calls[0].path, `${V}/inboundPlans/${PLAN}`);
});
