// lib/ad-test-rules.js
//
// The pure half of agents/ad-test-monitor: given a campaign's lifetime numbers
// and a test's stop rules, say whether a rule is hit. No I/O.
//
// ── Which purchase count decides ────────────────────────────────────────────────
//
// Meta's pixel has measured ~2x inflated on this store across Purchase,
// AddToCart and ViewContent (memory: add-to-cart leak note), and its default
// window credits a purchase to an ad merely VIEWED a day earlier. Shopify's own
// order record is the ground truth, so `purchases` is the count of Shopify
// orders whose landing URL carries the test's tag. That count can UNDER-count
// (a buyer who clicks the ad, leaves, and returns by typing the URL lands
// without the tag), so the rules that would STOP a test on too few purchases
// use the larger of the two counts. A stop on "no purchases" therefore needs
// BOTH sources to say zero, and the reported cost per purchase is the kinder of
// the two. The failure a stop rule must avoid is killing a test that is working.

/**
 * @param {{spend: number, impressions: number, linkClicks: number,
 *          shopifyPurchases: number, metaPurchases: number}} m
 * @param {{minImpressionsForCtr, minLinkCtr, maxSpendWithoutPurchase,
 *          maxCostPerPurchase, costPerPurchaseAfter}} rules
 * @returns {{status: 'stop'|'ok'|'early', reasons: string[], ctr: number|null,
 *            purchases: number, cpa: number|null}}
 */
export function evaluateRules(m, rules) {
  const spend = Number(m.spend) || 0;
  const impressions = Number(m.impressions) || 0;
  const purchases = Math.max(Number(m.shopifyPurchases) || 0, Number(m.metaPurchases) || 0);
  const ctr = impressions ? (Number(m.linkClicks) || 0) / impressions : null;
  const cpa = purchases ? spend / purchases : null;
  const reasons = [];

  if (impressions >= rules.minImpressionsForCtr && ctr < rules.minLinkCtr) {
    reasons.push(`link click-through ${pct(ctr)} is under ${pct(rules.minLinkCtr)} after ${impressions.toLocaleString('en-US')} impressions`);
  }
  if (purchases === 0 && spend >= rules.maxSpendWithoutPurchase) {
    reasons.push(`no purchase after $${spend.toFixed(2)} spent (limit $${rules.maxSpendWithoutPurchase})`);
  }
  if (purchases >= rules.costPerPurchaseAfter && cpa > rules.maxCostPerPurchase) {
    reasons.push(`cost per purchase $${cpa.toFixed(2)} is over $${rules.maxCostPerPurchase} after ${purchases} purchases`);
  }

  const early = impressions < rules.minImpressionsForCtr && spend < rules.maxSpendWithoutPurchase && purchases < rules.costPerPurchaseAfter;
  return { status: reasons.length ? 'stop' : early ? 'early' : 'ok', reasons, ctr, purchases, cpa };
}

const pct = (x) => `${(x * 100).toFixed(2)}%`;

/** Meta's purchase count from an insights `actions` array (pixel purchases only). */
export function metaPurchaseCount(actions = []) {
  const pick = (type) => Number((actions.find((a) => a.action_type === type) || {}).value) || 0;
  return pick('offsite_conversion.fb_pixel_purchase') || pick('purchase');
}

/** Orders that arrived through the test's tagged landing URL. */
export function taggedOrders(orders, tag) {
  return (orders || []).filter((o) => !o.cancelled_at && String(o.landing_site || '').includes(tag));
}

export function renderTestLines(test, rows, { shopifyOrders, trybe, tokenDaysLeft, now = Date.now() }) {
  const day = Math.min(Math.max(1, Math.ceil((now - Date.parse(test.startDate)) / 86_400_000)), 999);
  const total = Math.round((Date.parse(test.endDate) - Date.parse(test.startDate)) / 86_400_000);
  const lines = [`${test.name}: day ${day} of ${total}${now > Date.parse(test.endDate) + 86_400_000 ? ' (TEST WINDOW OVER: decide whether to keep, scale or stop)' : ''}`];
  for (const r of rows) {
    const e = r.eval;
    const head = e.status === 'stop' ? 'STOP RULE HIT' : e.status === 'early' ? 'too early to judge' : 'within rules';
    lines.push(`  ${r.label} [${r.status}] ${head}: $${r.spend.toFixed(2)} spent · ${r.impressions.toLocaleString('en-US')} impressions · link CTR ${e.ctr === null ? 'n/a' : pct(e.ctr)} · purchases ${r.shopifyPurchases} on Shopify / ${r.metaPurchases} per Meta${e.cpa ? ` · $${e.cpa.toFixed(2)} per purchase` : ''}`);
    for (const reason of e.reasons) lines.push(`    - ${reason}`);
  }
  lines.push(`  Shopify orders through the ads: ${shopifyOrders.length}${shopifyOrders.length ? ` ($${shopifyOrders.reduce((s, o) => s + Number(o.total_price || 0), 0).toFixed(2)}: ${shopifyOrders.map((o) => o.name).join(', ')})` : ''}`);
  if (trybe) lines.push(`  Trybe-attributed sales: $${(trybe.gmvCents / 100).toFixed(2)} from ${trybe.conversions} order(s)`);
  if (tokenDaysLeft !== null && tokenDaysLeft < 14) lines.push(`  WARNING: the Meta access token expires in ${tokenDaysLeft} day(s); this check stops working then.`);
  return lines;
}
