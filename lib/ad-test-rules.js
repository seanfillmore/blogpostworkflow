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
  const tags = (Array.isArray(tag) ? tag : [tag]).filter(Boolean);
  return (orders || []).filter((o) => !o.cancelled_at && tags.some((t) => String(o.landing_site || '').includes(t)));
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

// ── Per-creative graduation readout (2026-10-04, rule changed 2026-10-07) ────────
//
// A creative test asks a different question from the stop rules above: not "is
// this campaign burning money" but "which creative has earned a place in the
// scaling campaign". Once a creative has had a fair share of spend it graduates on
// EITHER cost per purchase at or under one average order, OR enough add to carts
// at a healthy link CTR (purchases are too rare at ~0.7-1% conversion to be the
// only route).
//
// The 2026-10-04 version also demanded <= $1.50 per link click. At this account's
// ~$75 CPM that needs a ~5% link CTR, so nothing could clear it: the two ads Meta
// chose (3 of the first 4 purchases, ~$28 per purchase) sat at $2.73 and $3.86.
// Sean replaced it with the cost-per-purchase route on 2026-10-07.

/** Meta's add-to-cart count from an insights `actions` array. */
export function metaAddToCartCount(actions = []) {
  const pick = (type) => Number((actions.find((a) => a.action_type === type) || {}).value) || 0;
  return pick('offsite_conversion.fb_pixel_add_to_cart') || pick('add_to_cart');
}

/**
 * @param {{spend, impressions, linkClicks, addToCarts, purchases}} m  purchases = larger of Shopify and Meta
 * @param {{minSpend, maxCostPerPurchase, minAddToCarts, minLinkCtr}} g
 * @returns {{status: 'ready'|'below'|'collecting', ctr, cpc, cpa, route: string|null, misses: string[]}}
 */
export function evaluateGraduation(m, g) {
  const spend = Number(m.spend) || 0;
  const clicks = Number(m.linkClicks) || 0;
  const impressions = Number(m.impressions) || 0;
  const purchases = Number(m.purchases) || 0;
  const atc = Number(m.addToCarts) || 0;
  const ctr = impressions ? clicks / impressions : null;
  const cpc = clicks ? spend / clicks : null;
  const cpa = purchases ? spend / purchases : null;
  const byPurchase = cpa !== null && cpa <= g.maxCostPerPurchase;
  const byCarts = atc >= g.minAddToCarts && ctr !== null && ctr >= g.minLinkCtr;
  const route = byPurchase ? `$${cpa.toFixed(2)} per purchase` : byCarts ? `${atc} add to carts at ${pct(ctr)} CTR` : null;
  const misses = route ? [] : [
    cpa === null ? 'no purchase yet' : `$${cpa.toFixed(2)} per purchase is over $${g.maxCostPerPurchase}`,
    atc < g.minAddToCarts ? `${atc} of ${g.minAddToCarts} add to carts` : `link CTR under ${pct(g.minLinkCtr)}`,
  ];
  const status = spend < g.minSpend ? 'collecting' : route ? 'ready' : 'below';
  return { status, ctr, cpc, cpa, route, misses };
}

// ── Daily loser pause (Sean, 2026-10-07: "stop the bleeding") ──────────────────
//
// A creative that has spent about one average order with NOT ONE add to cart or
// purchase is paused the morning it crosses the line, instead of waiting for the
// weekly drop. Ads Meta never spends on are left alone: they cost nothing and are
// Meta's own "no". Pausing never takes a campaign below `minActive` running ads, so
// a bad week can thin the test but never switch it off.

/** @returns {string|null} why this creative is a loser, or null */
export function evaluateKill(m, kill) {
  const spend = Number(m.spend) || 0;
  if (spend < kill.maxSpendWithoutAddToCart) return null;
  if ((Number(m.addToCarts) || 0) > 0 || (Number(m.purchases) || 0) > 0) return null;
  return `$${spend.toFixed(2)} spent with no add to cart or purchase (limit $${kill.maxSpendWithoutAddToCart})`;
}

/**
 * Which ACTIVE creatives to pause today, biggest spender first, never leaving fewer
 * than `kill.minActive` active.
 * @param {Array<{id, name, status, spend, eval?, kill?: string|null}>} creatives
 */
export function planPauses(creatives, kill) {
  const active = creatives.filter((c) => c.status === 'ACTIVE');
  const losers = active.filter((c) => c.kill).sort((a, b) => b.spend - a.spend);
  const room = Math.max(0, active.length - (kill.minActive ?? 3));
  return { pause: losers.slice(0, room), held: losers.slice(room) };
}

/** True when a readout is due: never sent, or at least `everyDays` calendar days (UTC) since the last. */
export function readoutDue(lastIso, now, everyDays) {
  if (!lastIso) return true;
  const day = (ms) => Math.floor(ms / 86_400_000);
  return day(now) - day(Date.parse(lastIso)) >= everyDays;
}

/**
 * The tag an ad's orders arrive with: Trybe ads carry `trybe=<id>` in their name and link,
 * our own ads carry `utm_content=<value>` in their url_tags. Null when neither is known.
 */
export function adOrderTag(ad) {
  const t = String(ad.name || '').match(/trybe=([a-z0-9]+)/i);
  if (t) return `trybe=${t[1]}`;
  const u = String(ad.urlTags || '').match(/utm_content=([^&]+)/);
  return u ? `utm_content=${u[1]}` : null;
}

/** A scannable creative name: "Taylor Copp · Body Lotion · 9638b656" for a Trybe ad, the ad's own name otherwise. */
export function shortCreativeName(name) {
  const n = String(name || '').replace(/^Trybe \| /, '');
  const m = n.match(/^([A-Za-z]+?)([A-Z][a-z]+)_(.+?)_\d{8}_trybe=([a-z0-9]{8})/);
  if (!m) return n;
  const product = /toothpaste/i.test(m[3]) ? 'Toothpaste' : /foaming/i.test(m[3]) ? 'Foaming Soap' : /soap/i.test(m[3]) ? 'Bar Soap' : /lotion/i.test(m[3]) ? 'Lotion/Cream' : m[3].slice(0, 24);
  return `${m[1]} ${m[2]} · ${product} · ${m[4]}`;
}

export function renderCreativeLines(rows, g) {
  const order = { ready: 0, below: 1, collecting: 2 };
  const sorted = [...rows].sort((a, b) => order[a.eval.status] - order[b.eval.status] || b.spend - a.spend);
  const n = (s) => rows.filter((r) => r.eval.status === s).length;
  const lines = [`  Creative readout (graduate after $${g.minSpend} spend at $${g.maxCostPerPurchase} or less per purchase, or ${g.minAddToCarts}+ add to carts at link CTR ${pct(g.minLinkCtr)}+): ${n('ready')} ready, ${n('below')} below the bar, ${n('collecting')} still collecting`];
  for (const r of sorted) {
    const e = r.eval;
    const head = r.status && r.status !== 'ACTIVE' ? `[${r.status.toLowerCase()}]` : e.status === 'ready' ? 'READY TO GRADUATE' : e.status === 'below' ? 'below the bar' : 'collecting';
    lines.push(`    ${head}: ${shortCreativeName(r.name)} · $${r.spend.toFixed(2)} · ${r.impressions.toLocaleString('en-US')} impr · link CTR ${e.ctr === null ? 'n/a' : pct(e.ctr)} · ${e.cpc === null ? 'no clicks' : `$${e.cpc.toFixed(2)}/click`} · ${r.addToCarts} ATC · ${r.purchases} purchase(s)${e.route ? ` (${e.route})` : e.status === 'below' ? ` (${e.misses.join('; ')})` : ''}`);
  }
  return lines;
}
