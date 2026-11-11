/**
 * Culina monthly P&L from SP-API finance events. Pure: no I/O.
 *
 * SIGN CONVENTION: Amazon's own. Revenue is positive; every cost (fees, promotions,
 * refunds, COGS, ad spend, freight, storage, coupon fees) is NEGATIVE; reimbursements
 * are positive. So contribution and net are plain sums of their lines.
 *   contribution = sales + fba + referral + promotions + refunds + cogs
 *   net          = contribution + adSpend.total + freight + storage + couponFees + reimbursements
 *
 * Account-level service fees and reimbursements are shared with the sister brand and are
 * allocated by unitShare = Culina units shipped / all units shipped in the same events.
 * Ads rows carry POSITIVE cost; they are negated here. No agency fee exists anywhere.
 */

const r2 = (n) => Math.round(n * 100) / 100 + 0; // + 0 turns -0 into 0
const amt = (o) => o?.CurrencyAmount ?? 0;

const FREIGHT = new Set(['FBAInboundTransportationFee', 'FBAInboundConvenienceFee', 'AmazonUpstreamStorageTransportationFee', 'AWDMcdTransportationFee']);
const STORAGE = new Set(['FBAStorageFee', 'FBALongTermStorageFee', 'STARStorageFee', 'AmazonUpstreamProcessingFee']);
const COUPON = new Set(['CouponParticipationFee', 'CouponPerformanceFee', 'DealParticipationFee', 'DealPerformanceFee']);
const REIMB = new Set(['WAREHOUSE_DAMAGE', 'WAREHOUSE_LOST', 'REVERSAL_REIMBURSEMENT', 'MISSING_FROM_INBOUND', 'MISSING_FROM_INBOUND_CLAWBACK', 'COMPENSATED_CLAWBACK', 'FREE_REPLACEMENT_REFUND_ITEMS']);
const FBA_FEES = new Set(['FBAPerUnitFulfillmentFee', 'FBAPerOrderFulfillmentFee', 'FBAWeightBasedFee']);

const CULINA_WORDS = /\b(cast iron|scrubs?|soaps?|oils?|seasonings?|sticks?|3 pack|2 pack|conditioners?)\b/i;
const RSC_WORDS = /\b(lotions?|deodorants?|toothpastes?|lip balms?|creams?|hand soaps?|bar soaps?|coconut soaps?|foaming|body)\b/i;
const RSC_WORDS_G = new RegExp(RSC_WORDS.source, 'gi');

/** `overrides` maps an exact campaign name to 'culina' | 'rsc' and wins over every rule below. */
export function assignCampaignBrand(name, culinaAsins, rscAsins, overrides = null) {
  const s = String(name ?? '');
  if (overrides && Object.prototype.hasOwnProperty.call(overrides, s)) return overrides[s];
  for (const a of s.match(/\bB0[A-Z0-9]{8}\b/g) || []) {
    if (culinaAsins.has(a)) return 'culina';
    if (rscAsins.has(a)) return 'rsc';
  }
  const r = RSC_WORDS.test(s);
  // RSC phrases like "coconut soap" contain a Culina word ("soap"); strip them before
  // testing Culina words, unless the name also says "cast iron" (then it is ambiguous).
  const c = CULINA_WORDS.test(/cast iron/i.test(s) ? s : s.replace(RSC_WORDS_G, ' '));
  if (c && !r) return 'culina';
  if (r && !c) return 'rsc';
  return null;
}

function adSpend(ads, culinaAsins, rscAsins, overrides) {
  const unassigned = new Set();
  if (!ads) return { spend: null, unassigned: [] };
  const spend = { sp: 0, sb: 0, sd: 0 };
  for (const row of ads.sp || []) {
    const name = String(row.campaignName ?? '');
    let brand = overrides && Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name]
      : row.advertisedAsin && culinaAsins.has(row.advertisedAsin) ? 'culina'
      : row.advertisedAsin && rscAsins.has(row.advertisedAsin) ? 'rsc' : null;
    brand ??= assignCampaignBrand(row.campaignName, culinaAsins, rscAsins, overrides);
    if (brand === 'culina') spend.sp += row.cost ?? 0;
    else if (brand === null) unassigned.add(row.campaignName ?? '(unnamed)');
  }
  for (const k of ['sb', 'sd']) {
    for (const row of ads[k] || []) {
      const brand = assignCampaignBrand(row.campaignName, culinaAsins, rscAsins, overrides);
      if (brand === 'culina') spend[k] += row.cost ?? 0;
      else if (brand === null) unassigned.add(row.campaignName ?? '(unnamed)');
    }
  }
  const out = { sp: -r2(spend.sp), sb: -r2(spend.sb), sd: -r2(spend.sd) };
  out.total = r2(out.sp + out.sb + out.sd);
  for (const k of Object.keys(out)) if (out[k] === 0) out[k] = 0; // avoid -0
  return { spend: out, unassigned: [...unassigned] };
}

export function monthPnl({ financeEvents, culinaSkus, cogsTable, skuToAsin, culinaAsins, rscAsins, ads, campaignOverrides = null }) {
  const ev = financeEvents || {};
  let sales = 0, fba = 0, referral = 0, promotions = 0, refunds = 0, cogs = 0;
  let culinaUnits = 0, allUnits = 0;
  const missingCogs = new Set();

  for (const s of ev.ShipmentEventList || []) {
    for (const it of s.ShipmentItemList || []) {
      const qty = it.QuantityShipped ?? 0;
      allUnits += qty;
      const sku = String(it.SellerSKU ?? '').trim();
      if (!culinaSkus.has(sku)) continue;
      culinaUnits += qty;
      for (const c of it.ItemChargeList || []) if (c.ChargeType === 'Principal') sales += amt(c.ChargeAmount);
      for (const f of it.ItemFeeList || []) {
        const v = amt(f.FeeAmount);
        if (FBA_FEES.has(f.FeeType)) fba += v;
        else if (f.FeeType === 'Commission') referral += v;
      }
      for (const p of it.PromotionList || []) promotions += amt(p.PromotionAmount);
      const unitCogs = cogsTable?.[skuToAsin.get(sku)]?.cogs;
      if (unitCogs != null) cogs -= unitCogs * qty;
      else missingCogs.add(sku);
    }
  }
  for (const r of ev.RefundEventList || []) {
    for (const it of r.ShipmentItemAdjustmentList || []) {
      if (!culinaSkus.has(String(it.SellerSKU ?? '').trim())) continue;
      for (const c of it.ItemChargeAdjustmentList || []) if (c.ChargeType === 'Principal') refunds += amt(c.ChargeAmount);
    }
  }

  const unitShare = allUnits > 0 ? culinaUnits / allUnits : null;

  // Weight of a service fee carrying its own SKU/ASIN: 1 = Culina, 0 = RSC, null = unattributed.
  const ownWeight = (e, f) => {
    const sku = String(f.SellerSKU ?? e.SellerSKU ?? '').trim();
    const asin = String(f.ASIN ?? e.ASIN ?? '').trim();
    if (sku) return culinaSkus.has(sku) ? 1 : 0;
    if (asin) return culinaAsins.has(asin) ? 1 : rscAsins.has(asin) ? 0 : null;
    return null;
  };
  const acc = { freight: [0, 0], storage: [0, 0], couponFees: [0, 0] }; // [attributed, shared]
  for (const e of ev.ServiceFeeEventList || []) {
    for (const f of e.FeeList || []) {
      const key = FREIGHT.has(f.FeeType) ? 'freight' : STORAGE.has(f.FeeType) ? 'storage' : COUPON.has(f.FeeType) ? 'couponFees' : null;
      if (!key) continue;
      const v = amt(f.FeeAmount);
      const w = ownWeight(e, f);
      if (w === null) acc[key][1] += v; else acc[key][0] += v * w;
    }
  }
  let reimb = 0;
  for (const a of ev.AdjustmentEventList || []) {
    if (REIMB.has(a.AdjustmentType)) reimb += amt(a.AdjustmentAmount);
  }
  // Shared amounts need unitShare; with no units shipped they are UNKNOWN (null), not 0.
  const alloc = ([attributed, shared]) => (shared !== 0 && unitShare === null ? null : r2(attributed + shared * (unitShare ?? 0)));
  const freight = alloc(acc.freight);
  const storage = alloc(acc.storage);
  const couponFees = alloc(acc.couponFees);
  const reimbursements = alloc([0, reimb]);

  sales = r2(sales); fba = r2(fba); referral = r2(referral); promotions = r2(promotions);
  refunds = r2(refunds); cogs = r2(cogs);
  const contribution = r2(sales + fba + referral + promotions + refunds + cogs);

  const { spend, unassigned } = adSpend(ads, culinaAsins, rscAsins, campaignOverrides);
  const allocated = [freight, storage, couponFees, reimbursements];
  const net = spend && allocated.every((x) => x !== null) ? r2(contribution + spend.total + freight + storage + couponFees + reimbursements) : null;

  return { sales, fba, referral, promotions, refunds, cogs, contribution, adSpend: spend, freight, storage, couponFees, reimbursements, net, unassignedCampaigns: unassigned, unitShare, missingCogs: [...missingCogs] };
}

const LINES = ['sales', 'fba', 'referral', 'promotions', 'refunds', 'cogs', 'contribution', 'adSpend', 'freight', 'storage', 'couponFees', 'reimbursements', 'net'];

export function comparePnl(curr, prev) {
  const val = (p, line) => (line === 'adSpend' ? p?.adSpend?.total ?? null : p?.[line] ?? null);
  return LINES.map((line) => {
    const c = val(curr, line), p = val(prev, line);
    return { line, curr: c, prev: p, change: c == null || p == null ? null : r2(c - p) };
  });
}
