/**
 * Resumable FBA booking for Culina inbound shipments, at the lowest TOTAL cost
 * (placement fee net of discounts + the cheapest partnered transport per shipment).
 *
 * Every path, body and response field below was checked against Amazon's models:
 *   - Fulfillment Inbound v2024-03-20:
 *     https://github.com/amzn/selling-partner-api-models/blob/main/models/fulfillment-inbound-api-model/fulfillmentInbound_2024-03-20.json
 *   - Fulfillment Inbound v0 (getLabels, getBillOfLading only):
 *     https://github.com/amzn/selling-partner-api-models/blob/main/models/fulfillment-inbound-api-model/fulfillmentInboundV0.json
 *   - Developer docs: https://developer-docs.amazon.com/sp-api/docs/fulfillment-inbound-api-v2024-03-20-reference
 *
 * Order, as the model requires it:
 *   createInboundPlan -> generatePackingOptions -> listPackingOptions -> confirmPackingOption
 *   -> setPackingInformation (keyed by packingGroupId, which "must belong to the confirmed
 *   PackingOption", so packing is confirmed BEFORE packing information is set)
 *   -> generatePlacementOptions -> for EVERY placement option: generateTransportationOptions
 *   ("for a given placement option", before any placement is confirmed)
 *   -> choose -> confirmPlacementOption -> [delivery window, only for an option whose
 *   `preconditions` lists CONFIRMED_DELIVERY_WINDOW] -> confirmTransportationOptions.
 *
 * generateTransportationOptions takes no shipping-mode input: it returns every mode Amazon
 * can offer for the configuration given. LTL is only possible when pallets and a contact
 * are sent, so with no contact phone no pallet/contact data is sent at all. Options are then
 * filtered to AMAZON_PARTNERED_CARRIER with GROUND_SMALL_PARCEL or FREIGHT_LTL.
 *
 * Dry mode (deps.apply false) stops after the quote. It does confirm the PACKING option,
 * because placement and transport quotes cannot be generated without it; it never confirms
 * a placement, a delivery window or a transportation option (the calls that spend money).
 *
 * Steps (persisted after each): claimed -> plan_created -> packing_confirmed -> quoted -> confirmed.
 */
import { palletize, chooseCheapest, feeAmount, summarizeOptions } from './amazon-inbound-cost.js';
import { planName } from './amazon-inbound-state.js';

const V = '/inbound/fba/2024-03-20';
const V0 = '/fba/inbound/v0';
const MODES = new Set(['GROUND_SMALL_PARCEL', 'FREIGHT_LTL']);
const PARTNERED = 'AMAZON_PARTNERED_CARRIER';
const CASE_PAGE_TYPE = 'PackageLabel_Letter_2';
const PALLET_PAGE_TYPE = 'PackageLabel_Letter_4';
const CONTACT_NAME = 'Travis';
const RETRIES_429 = 4;
const POLL_MAX = 60;
// Amazon rejects a readyToShipWindow.start in the past ("DateTime value ... cannot be in the past"),
// and generating options for several placements takes minutes, so each start is taken just before
// its own request and leads the clock by this much.
const READY_LEAD_MINUTES = 15;

// ---- plumbing -----------------------------------------------------------

async function call(deps, method, path, body) {
  let wait = 2000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await deps.request(method, path, body);
    } catch (err) {
      if (attempt >= RETRIES_429 || !String(err?.message).includes('(429)')) throw err;
      await deps.sleep(wait);
      wait *= 2;
    }
  }
}

async function waitFor(deps, operationId, label) {
  if (!operationId) throw new Error(`${label}: Amazon returned no operationId`);
  let wait = 1000;
  for (let i = 0; i < POLL_MAX; i++) {
    const op = await call(deps, 'GET', `${V}/operations/${operationId}`);
    const status = op?.operationStatus;
    if (status === 'SUCCESS') return op;
    if (status === 'FAILED') {
      const problems = (op.operationProblems || []).map((p) => `${p.code}: ${p.message}`).join('; ');
      throw new Error(`${label} failed (operation ${operationId})${problems ? `: ${problems}` : ''}`);
    }
    await deps.sleep(wait);
    wait = Math.min(wait * 1.5, 15000);
  }
  throw new Error(`${label} did not finish (operation ${operationId} still in progress)`);
}

async function listAll(deps, path, key, params = {}) {
  const out = [];
  let token;
  do {
    const res = await call(deps, 'GET', path, token ? { ...params, paginationToken: token } : params);
    out.push(...(res?.[key] || []));
    token = res?.pagination?.nextToken;
  } while (token);
  return out;
}

function stamp(record, deps, step, persist) {
  if (step) record.step = step;
  record.updatedAt = new Date(deps.now()).toISOString();
  persist(record);
}

/** Net of an Incentive list pair: fees minus discounts. Discounts subtract whatever their sign. null if anything is unquoted. */
export function netIncentives(fees, discounts) {
  if (!Array.isArray(fees) || !Array.isArray(discounts)) return null;
  let total = 0;
  for (const f of fees) {
    const n = feeAmount(f?.value);
    if (n === null) return null;
    total += n;
  }
  for (const d of discounts) {
    const n = feeAmount(d?.value);
    if (n === null) return null;
    total -= Math.abs(n);
  }
  return Math.round(total * 100) / 100;
}

/** Ready-to-ship start: now plus READY_LEAD_MINUTES, rounded UP to a whole minute (the model keeps minute precision). */
function readyStart(deps) {
  const ms = new Date(deps.now()).getTime() + READY_LEAD_MINUTES * 60000;
  return new Date(Math.ceil(ms / 60000) * 60000).toISOString().slice(0, 16) + 'Z';
}

// ---- steps --------------------------------------------------------------

/** ItemInput for one MSKU; `expiration` only for an expiration-dated SKU (FBA_INB_0180 without it). */
function itemInput(it, quantity) {
  return { msku: it.sku, quantity, labelOwner: 'SELLER', prepOwner: 'SELLER', ...(it.expiration ? { expiration: it.expiration } : {}) };
}

// getInboundPlan status (model: ACTIVE, VOIDED, SHIPPED, ERRORED). A dead plan can never be
// packed or confirmed, so resuming one would fail forever at a later, vaguer step.
const DEAD_PLAN = new Set(['ERRORED', 'VOIDED']);

async function ensurePlan({ record, items, config, deps, persist }) {
  if (record.planId) {
    const plan = await call(deps, 'GET', `${V}/inboundPlans/${record.planId}`);
    if (DEAD_PLAN.has(plan?.status)) {
      throw new Error(`inbound plan ${record.planId} is ${plan.status} on Amazon and cannot be resumed; to retry with a new plan, remove planId and set step to "claimed" for this message in data/amazon-inbound/state.json`);
    }
    return;
  }
  const name = record.planName || planName(record.messageId); // record.planName: dry-run drafts (dryPlanName)
  const plans = await listAll(deps, `${V}/inboundPlans`, 'inboundPlans', { status: 'ACTIVE', sortBy: 'CREATION_TIME', sortOrder: 'DESC' });
  const existing = plans.find((p) => p.name === name && p.status === 'ACTIVE');
  if (existing) {
    record.planId = existing.inboundPlanId;
    stamp(record, deps, 'plan_created', persist);
    return;
  }
  const res = await call(deps, 'POST', `${V}/inboundPlans`, {
    name,
    destinationMarketplaces: [deps.marketplaceId],
    sourceAddress: config.ship_from,
    items: items.map((it) => itemInput(it, it.cases * it.unitsPerCase)),
  });
  record.planId = res?.inboundPlanId;
  if (!record.planId) throw new Error('createInboundPlan: Amazon returned no inboundPlanId');
  stamp(record, deps, null, persist); // keep the id even if the operation then fails
  await waitFor(deps, res.operationId, 'createInboundPlan');
  stamp(record, deps, 'plan_created', persist);
}

function boxFor(it) {
  return {
    contentInformationSource: 'BOX_CONTENT_PROVIDED',
    quantity: it.cases,
    dimensions: { length: it.case_in.l, width: it.case_in.w, height: it.case_in.h, unitOfMeasurement: 'IN' },
    weight: { value: it.case_lb, unit: 'LB' },
    items: [itemInput(it, it.unitsPerCase)],
  };
}

async function packing({ record, items, deps, persist }) {
  const plan = `${V}/inboundPlans/${record.planId}`;
  let options = await listAll(deps, `${plan}/packingOptions`, 'packingOptions');
  let chosen = options.find((o) => o.status === 'ACCEPTED');
  if (!chosen) {
    const gen = await call(deps, 'POST', `${plan}/packingOptions`);
    await waitFor(deps, gen?.operationId, 'generatePackingOptions');
    options = await listAll(deps, `${plan}/packingOptions`, 'packingOptions');
    for (const o of options) {
      if (o.status !== 'OFFERED') continue;
      const fee = netIncentives(o.fees, o.discounts);
      if (fee === null) continue;
      if (!chosen || fee < chosen.fee) chosen = { ...o, fee };
    }
    if (!chosen) throw new Error('no quoted packing option');
    const conf = await call(deps, 'POST', `${plan}/packingOptions/${chosen.packingOptionId}/confirmation`);
    await waitFor(deps, conf?.operationId, 'confirmPackingOption');
  }
  record.packingFee = chosen.fee ?? netIncentives(chosen.fees, chosen.discounts);

  const placed = new Set();
  const packageGroupings = [];
  for (const groupId of chosen.packingGroups || []) {
    const groupItems = await listAll(deps, `${plan}/packingGroups/${groupId}/items`, 'items');
    const mskus = new Set(groupItems.map((i) => i.msku));
    const boxes = items.filter((it) => mskus.has(it.sku) && !placed.has(it.sku)).map((it) => {
      placed.add(it.sku);
      return boxFor(it);
    });
    if (boxes.length) packageGroupings.push({ packingGroupId: groupId, boxes });
  }
  const missing = items.filter((it) => !placed.has(it.sku)).map((it) => it.sku);
  if (missing.length) throw new Error(`setPackingInformation: no packing group holds ${missing.join(', ')}`);

  const set = await call(deps, 'POST', `${plan}/packingInformation`, { packageGroupings });
  await waitFor(deps, set?.operationId, 'setPackingInformation');
  stamp(record, deps, 'packing_confirmed', persist);
}

/** Pallets for one shipment, from what Amazon placed in it. null when the cases do not palletize. */
async function shipmentPallets(deps, plan, shipmentId, items, config) {
  const shipped = await listAll(deps, `${plan}/shipments/${shipmentId}/items`, 'items');
  const bySku = new Map(items.map((it) => [it.sku, it]));
  const cases = [];
  for (const s of shipped) {
    const it = bySku.get(s.msku);
    if (!it) throw new Error(`shipment ${shipmentId} holds unknown msku ${s.msku}`);
    cases.push({ sku: it.sku, count: Math.round(s.quantity / it.unitsPerCase), case_in: it.case_in, case_lb: it.case_lb });
  }
  let pallets;
  try {
    pallets = palletize(cases, config.pallet);
  } catch (err) {
    if (String(err?.message).startsWith('palletize:')) return null;
    throw err;
  }
  const groups = new Map();
  for (const p of pallets) {
    const k = `${p.length_in}x${p.width_in}x${p.height_in}@${p.weight_lb}`;
    const g = groups.get(k);
    if (g) g.quantity += 1;
    else groups.set(k, {
      quantity: 1,
      dimensions: { length: p.length_in, width: p.width_in, height: p.height_in, unitOfMeasurement: 'IN' },
      weight: { value: p.weight_lb, unit: 'LB' },
      stackability: config.pallet.stackable ? 'STACKABLE' : 'NON_STACKABLE',
    });
  }
  return { pallets: [...groups.values()], count: pallets.length };
}

async function quote({ record, items, config, deps, persist }) {
  const plan = `${V}/inboundPlans/${record.planId}`;
  let placements = await listAll(deps, `${plan}/placementOptions`, 'placementOptions');
  let accepted = placements.find((p) => p.status === 'ACCEPTED');
  if (!accepted) {
    const gen = await call(deps, 'POST', `${plan}/placementOptions`, {});
    await waitFor(deps, gen?.operationId, 'generatePlacementOptions');
    placements = await listAll(deps, `${plan}/placementOptions`, 'placementOptions');
    accepted = placements.find((p) => p.status === 'ACCEPTED');
  }
  const pool = accepted ? [accepted] : placements.filter((p) => p.status === 'OFFERED');
  if (!pool.length) throw new Error('no placement option offered');

  const phone = deps.contactPhone;
  const contact = phone ? { name: CONTACT_NAME, email: config.sender, phoneNumber: phone } : null;
  const candidates = [];
  const starts = {};
  const palletCounts = {};
  const preconditions = {};

  for (const p of pool) {
    const configs = [];
    const start = readyStart(deps);
    starts[p.placementOptionId] = start;
    for (const shipmentId of p.shipmentIds || []) {
      const conf = { shipmentId, readyToShipWindow: { start } };
      if (contact) {
        const pal = await shipmentPallets(deps, plan, shipmentId, items, config);
        if (pal) {
          conf.contactInformation = contact;
          conf.pallets = pal.pallets;
          palletCounts[shipmentId] = pal.count;
        }
      }
      configs.push(conf);
    }
    const gen = await call(deps, 'POST', `${plan}/transportationOptions`, {
      placementOptionId: p.placementOptionId,
      shipmentTransportationConfigurations: configs,
    });
    await waitFor(deps, gen?.operationId, `generateTransportationOptions (${p.placementOptionId})`);
    const opts = await listAll(deps, `${plan}/transportationOptions`, 'transportationOptions', { placementOptionId: p.placementOptionId });
    const shipments = (p.shipmentIds || []).map((shipmentId) => ({
      shipmentId,
      options: opts
        .filter((o) => o.shipmentId === shipmentId && o.shippingSolution === PARTNERED && MODES.has(o.shippingMode))
        .filter((o) => o.shippingMode !== 'FREIGHT_LTL' || palletCounts[shipmentId])
        .map((o) => {
          preconditions[o.transportationOptionId] = o.preconditions || [];
          return { transportationOptionId: o.transportationOptionId, mode: o.shippingMode, amount: feeAmount(o.quote?.cost) };
        }),
    }));
    // An ACCEPTED placement's fee is already committed; it is the only candidate either way.
    candidates.push({ placementOptionId: p.placementOptionId, placementFee: netIncentives(p.fees, p.discounts), shipments });
  }

  const best = chooseCheapest(candidates);
  if (!best) throw new Error('no quoted option');
  const placementFee = candidates.find((c) => c.placementOptionId === best.placementOptionId).placementFee;
  record.quote = {
    placementOptionId: best.placementOptionId,
    placementAccepted: Boolean(accepted),
    placementFee,
    packingFee: record.packingFee ?? 0,
    total: Math.round((best.total + (record.packingFee || 0)) * 100) / 100,
    picks: best.picks.map((pk) => ({
      ...pk,
      preconditions: preconditions[pk.transportationOptionId] || [],
      ...(pk.mode === 'FREIGHT_LTL' ? { pallets: palletCounts[pk.shipmentId] } : {}),
    })),
    readyToShip: starts[best.placementOptionId],
    options: summarizeOptions(candidates),
    quotedAt: new Date(deps.now()).toISOString(),
  };
  record.shipmentIds = best.picks.map((pk) => pk.shipmentId);
  stamp(record, deps, 'quoted', persist);
}

async function confirmDeliveryWindow(deps, plan, shipmentId) {
  const ship = `${plan}/shipments/${shipmentId}`;
  const gen = await call(deps, 'POST', `${ship}/deliveryWindowOptions`);
  await waitFor(deps, gen?.operationId, `generateDeliveryWindowOptions (${shipmentId})`);
  const windows = await listAll(deps, `${ship}/deliveryWindowOptions`, 'deliveryWindowOptions');
  const pick = windows.find((w) => w.availabilityType === 'AVAILABLE' || w.availabilityType === 'DISCOUNTED');
  if (!pick) throw new Error(`no delivery window available for shipment ${shipmentId}`);
  const conf = await call(deps, 'POST', `${ship}/deliveryWindowOptions/${pick.deliveryWindowOptionId}/confirmation`);
  await waitFor(deps, conf?.operationId, `confirmDeliveryWindowOptions (${shipmentId})`);
}

async function confirm({ record, config, deps, persist }) {
  const plan = `${V}/inboundPlans/${record.planId}`;
  const q = record.quote;
  const phone = deps.contactPhone;
  if (q.picks.some((pk) => pk.mode === 'FREIGHT_LTL') && !phone) {
    throw new Error('refusing to confirm an LTL pick: no contact phone (AMAZON_INBOUND_CONTACT_PHONE is not set)');
  }
  if (!q.placementAccepted) {
    const res = await call(deps, 'POST', `${plan}/placementOptions/${q.placementOptionId}/confirmation`);
    await waitFor(deps, res?.operationId, 'confirmPlacementOption');
    q.placementAccepted = true;
    stamp(record, deps, null, persist);
  }
  for (const pk of q.picks) {
    if (pk.preconditions.includes('CONFIRMED_DELIVERY_WINDOW')) await confirmDeliveryWindow(deps, plan, pk.shipmentId);
  }
  const transportationSelections = q.picks.map((pk) => ({
    shipmentId: pk.shipmentId,
    transportationOptionId: pk.transportationOptionId,
    ...(pk.mode === 'FREIGHT_LTL'
      ? { contactInformation: { name: CONTACT_NAME, email: config.sender, phoneNumber: phone } }
      : {}),
  }));
  const res = await call(deps, 'POST', `${plan}/transportationOptions/confirmation`, { transportationSelections });
  await waitFor(deps, res?.operationId, 'confirmTransportationOptions');
  stamp(record, deps, 'confirmed', persist);
}

/**
 * Crash between confirmTransportationOptions and the 'confirmed' stamp: Amazon already holds
 * the booking. If the plan's ACCEPTED placement has a selectedTransportationOptionId on every
 * shipment (Shipment model), stamp 'confirmed' and report true; nothing is confirmed again.
 * Some-but-not-all selected throws for an operator (confirmation is plan-wide, so it should not happen).
 */
async function adoptConfirmedTransport({ record, deps, persist }) {
  const plan = `${V}/inboundPlans/${record.planId}`;
  const placements = await listAll(deps, `${plan}/placementOptions`, 'placementOptions');
  const accepted = placements.find((p) => p.status === 'ACCEPTED');
  if (!accepted?.shipmentIds?.length) return false;
  const selected = {};
  for (const shipmentId of accepted.shipmentIds) {
    const shipment = await call(deps, 'GET', `${plan}/shipments/${shipmentId}`);
    if (shipment?.selectedTransportationOptionId) selected[shipmentId] = shipment.selectedTransportationOptionId;
  }
  const n = Object.keys(selected).length;
  if (n === 0) return false;
  if (n < accepted.shipmentIds.length) {
    throw new Error(`plan ${record.planId}: transport is confirmed on ${n} of ${accepted.shipmentIds.length} shipments; needs a human`);
  }
  const prior = new Map((record.quote?.picks || []).map((pk) => [pk.shipmentId, pk]));
  const picks = [];
  for (const shipmentId of accepted.shipmentIds) {
    const id = selected[shipmentId];
    const old = prior.get(shipmentId);
    if (old && old.transportationOptionId === id) { picks.push(old); continue; }
    const opts = await listAll(deps, `${plan}/transportationOptions`, 'transportationOptions', { shipmentId });
    const o = opts.find((x) => x.transportationOptionId === id);
    picks.push({ shipmentId, transportationOptionId: id, mode: o?.shippingMode ?? null, amount: feeAmount(o?.quote?.cost), preconditions: o?.preconditions || [] });
  }
  record.quote = { ...(record.quote || {}), placementOptionId: accepted.placementOptionId, placementAccepted: true, picks };
  record.shipmentIds = [...accepted.shipmentIds];
  stamp(record, deps, 'confirmed', persist);
  return true;
}

const TERMINAL = new Set(['confirmed', 'labels_sent', 'done']);

// ---- public -------------------------------------------------------------

/**
 * Book (or quote, when !deps.apply) the FBA cases. Resumes from record.step;
 * confirmed, labels_sent and done are terminal and returned untouched.
 * A record at 'quoted' is re-quoted before confirming, since quotes expire;
 * an ACCEPTED placement on Amazon's side is reused rather than re-chosen.
 */
export async function bookFba({ record, items, config, deps, persist }) {
  if (TERMINAL.has(record.step)) return record;
  if (!items?.length) throw new Error('bookFba: no FBA cases to book');
  await ensurePlan({ record, items, config, deps, persist });
  if (record.step !== 'packing_confirmed' && record.step !== 'quoted') await packing({ record, items, deps, persist });
  if (await adoptConfirmedTransport({ record, deps, persist })) return record;
  await quote({ record, items, config, deps, persist });
  if (!deps.apply) return record;
  await confirm({ record, config, deps, persist });
  return record;
}

async function download(deps, url, what) {
  if (!url) throw new Error(`${what}: Amazon returned no DownloadURL`);
  if (deps.download) return deps.download(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${what}: download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Case labels per shipment, plus pallet labels and the bill of lading for LTL shipments. */
export async function fetchFbaLabels({ record, deps }) {
  if (record.step !== 'confirmed' && record.step !== 'labels_sent') {
    throw new Error(`fetchFbaLabels: record is at ${record.step}, not confirmed`);
  }
  const plan = `${V}/inboundPlans/${record.planId}`;
  const files = [];
  for (const pk of record.quote.picks) {
    const shipment = await call(deps, 'GET', `${plan}/shipments/${pk.shipmentId}`);
    const confId = shipment?.shipmentConfirmationId;
    if (!confId) throw new Error(`shipment ${pk.shipmentId} has no shipmentConfirmationId yet`);
    const boxes = await listAll(deps, `${plan}/shipments/${pk.shipmentId}/boxes`, 'boxes');
    const boxIds = boxes.map((b) => b.boxId);
    if (!boxIds.length || boxIds.some((id) => !id)) throw new Error(`shipment ${confId}: box IDs not available yet`);

    const cases = await call(deps, 'GET', `${V0}/shipments/${confId}/labels`, {
      PageType: CASE_PAGE_TYPE,
      LabelType: 'UNIQUE',
      PackageLabelsToPrint: boxIds,
    });
    files.push({ filename: `${confId}-case-labels.pdf`, content: await download(deps, cases?.payload?.DownloadURL, `case labels ${confId}`) });

    if (pk.mode === 'FREIGHT_LTL') {
      const pallets = await call(deps, 'GET', `${V0}/shipments/${confId}/labels`, {
        PageType: PALLET_PAGE_TYPE,
        LabelType: 'PALLET',
        NumberOfPallets: pk.pallets,
      });
      files.push({ filename: `${confId}-pallet-labels.pdf`, content: await download(deps, pallets?.payload?.DownloadURL, `pallet labels ${confId}`) });
      const bol = await call(deps, 'GET', `${V0}/shipments/${confId}/billOfLading`);
      files.push({ filename: `${confId}-bill-of-lading.pdf`, content: await download(deps, bol?.payload?.DownloadURL, `bill of lading ${confId}`) });
    }
  }
  return files;
}

/** Dry-run cleanup: void the draft plan. Refuses a confirmed plan (cancelling one can be charged). */
export async function cancelDraft({ record, deps }) {
  if (!record.planId) return;
  if (record.step === 'confirmed' || record.step === 'labels_sent') {
    throw new Error(`cancelDraft: plan ${record.planId} is confirmed; not cancelling it automatically`);
  }
  const res = await call(deps, 'PUT', `${V}/inboundPlans/${record.planId}/cancellation`);
  await waitFor(deps, res?.operationId, 'cancelInboundPlan');
}
