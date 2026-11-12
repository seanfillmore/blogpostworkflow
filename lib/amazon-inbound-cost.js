/**
 * Pallet building and cheapest-total selection for Culina inbound shipments.
 * Pure: no I/O.
 */

/** Normalise an Amazon money object ({ amount, code }); discounts are negative. null if absent or not USD. */
export function feeAmount(money) {
  if (!money || typeof money !== 'object') return null;
  if (money.code !== 'USD') return null;
  const n = typeof money.amount === 'string' ? Number(money.amount) : money.amount;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

// Cases per layer: best of both orientations, floor on each axis (never area division).
function perLayer(case_in, pallet) {
  const { l, w } = case_in;
  const a = Math.floor(pallet.length_in / l) * Math.floor(pallet.width_in / w);
  const b = Math.floor(pallet.length_in / w) * Math.floor(pallet.width_in / l);
  return Math.max(a, b);
}

/**
 * Single-SKU layers, never stacked past max_height_in including the deck.
 * Each SKU's full pallets come first, in input order; leftover layers are pooled
 * and packed last, so mixed SKUs appear only on the trailing pallet(s).
 */
export function palletize(cases, pallet) {
  const deck = pallet.deck_in || 0;
  const maxStack = pallet.max_height_in - deck;
  const full = [];
  const pool = []; // layers: { sku, count, h, lb }

  for (const c of cases) {
    if (!c.count) continue;
    const { h } = c.case_in;
    const cpl = perLayer(c.case_in, pallet);
    if (cpl < 1) throw new Error(`palletize: case ${c.sku} (${c.case_in.l}x${c.case_in.w}) does not fit the ${pallet.length_in}x${pallet.width_in} in pallet`);
    const maxLayers = Math.floor(maxStack / h);
    if (maxLayers < 1) throw new Error(`palletize: case ${c.sku} is ${h} in tall; only ${maxStack} in available above the deck`);
    const perPallet = cpl * maxLayers;
    let left = c.count;
    while (left >= perPallet) {
      full.push([{ sku: c.sku, count: perPallet, h: h * maxLayers, lb: c.case_lb }]);
      left -= perPallet;
    }
    while (left > 0) {
      const n = Math.min(cpl, left);
      pool.push({ sku: c.sku, count: n, h, lb: c.case_lb });
      left -= n;
    }
  }

  const groups = [...full];
  let cur = null;
  let curH = 0;
  for (const layer of pool) {
    if (!cur || curH + layer.h > maxStack) {
      cur = [];
      curH = 0;
      groups.push(cur);
    }
    cur.push(layer);
    curH += layer.h;
  }

  return groups.map((layers) => {
    const bySku = new Map();
    let height = deck;
    let weight = pallet.pallet_weight_lb;
    for (const l of layers) {
      bySku.set(l.sku, (bySku.get(l.sku) || 0) + l.count);
      height += l.h;
      weight += l.count * l.lb;
    }
    return {
      length_in: pallet.length_in,
      width_in: pallet.width_in,
      height_in: height,
      weight_lb: weight,
      cases: [...bySku].map(([sku, count]) => ({ sku, count })),
    };
  });
}

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

/** Lowest total = placement fee (net of discounts) + cheapest quoted transport per shipment. */
export function chooseCheapest(candidates) {
  let best = null;
  for (const cand of candidates || []) {
    if (!isNum(cand.placementFee)) continue;
    const picks = [];
    let ok = true;
    for (const s of cand.shipments || []) {
      let pick = null;
      for (const o of s.options || []) {
        if (!isNum(o.amount)) continue;
        if (!pick || o.amount < pick.amount) {
          pick = { shipmentId: s.shipmentId, transportationOptionId: o.transportationOptionId, mode: o.mode, amount: o.amount };
        }
      }
      if (!pick) { ok = false; break; }
      picks.push(pick);
    }
    if (!ok) continue;
    const total = cand.placementFee + picks.reduce((n, p) => n + p.amount, 0);
    if (!best || total < best.total || (total === best.total && picks.length < best.picks.length)) {
      best = { placementOptionId: cand.placementOptionId, total, picks };
    }
  }
  return best;
}
