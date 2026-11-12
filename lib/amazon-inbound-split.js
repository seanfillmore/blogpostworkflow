// lib/amazon-inbound-split.js
//
// Routes each shipment line WHOLE to FBA or AWD, never split (Sean, 2026-11-12:
// "do not separate shipments into FBA and AWD. If an ASIN is getting sent to FBA
// send all of it to FBA"). A pack goes to FBA when what FBA holds plus has inbound
// will not cover `coverDays` of forecast demand; it goes to AWD only when FBA
// already has enough. Pure math plus one paginated SP-API read.

import { forecastUnits, seasonalIndex } from './culina-forecast.js';

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Expiration date for an expiration-dated MSKU: `today` (YYYY-MM-DD) plus `years`,
 * as Amazon's ItemInput.expiration pattern wants it. Feb 29 falls back to Feb 28.
 * Amazon refuses createInboundPlan without one for such an MSKU (FBA_INB_0180); the
 * 2-pack's past manual plans used the plan date plus 3 years.
 */
export function expirationDate(today, years) {
  const [y, m, d] = today.split('-').map(Number);
  const date = new Date(Date.UTC(y + years, m - 1, d));
  if (date.getUTCMonth() !== m - 1) date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}

export function splitCases({ lines, fbaBySku, paceBySku, today, seasonal, coverDays = 30 }) {
  const index = seasonal || seasonalIndex(null);
  return (lines || []).map((line) => {
    const { sku, key, cases } = line;
    const fba = fbaBySku?.[sku] || { fulfillable: 0, inbound: 0 };
    const pace = paceBySku?.[sku] ?? null;
    if (!(pace > 0)) {
      return { sku, key, fbaCases: cases, awdCases: 0, needUnits: null, coverDaysNow: null, reason: 'no sales pace yet' };
    }
    const have = (fba.fulfillable || 0) + (fba.inbound || 0);
    const needUnits = forecastUnits(pace, today, coverDays, index) - have;
    const toFba = needUnits > 1e-9;
    const fbaCases = toFba ? cases : 0;
    const awdCases = cases - fbaCases;
    const coverDaysNow = have / pace;
    const days = Math.round(coverDaysNow);
    return {
      sku, key, fbaCases, awdCases, needUnits, coverDaysNow,
      reason: toFba
        ? `${days} days of FBA cover (under ${coverDays}), so all ${plural(cases, 'case')} to FBA`
        : `${days} days of FBA cover (${coverDays}+ covered), so all ${plural(cases, 'case')} to AWD`,
    };
  });
}

export async function readFbaBySku(deps) {
  const out = {};
  let nextToken;
  let first = true;
  do {
    if (!first && deps.sleep) await deps.sleep(1200);
    first = false;
    const res = await deps.request('GET', '/fba/inventory/v1/summaries', {
      granularityType: 'Marketplace', granularityId: deps.marketplaceId, marketplaceIds: deps.marketplaceId,
      details: 'true', nextToken,
    });
    for (const r of res?.payload?.inventorySummaries || []) {
      if (!r.sellerSku) continue;
      const d = r.inventoryDetails || {};
      const row = (out[r.sellerSku] ||= { fulfillable: 0, inbound: 0 });
      row.fulfillable += d.fulfillableQuantity || 0;
      row.inbound += (d.inboundWorkingQuantity || 0) + (d.inboundShippedQuantity || 0) + (d.inboundReceivingQuantity || 0);
    }
    nextToken = res?.pagination?.nextToken || res?.payload?.pagination?.nextToken;
  } while (nextToken);
  return out;
}
