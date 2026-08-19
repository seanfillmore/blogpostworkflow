#!/usr/bin/env node
/**
 * Contribution and discount depth for every bundle, from live Shopify data.
 *
 *   node scripts/bundle-margin-report.mjs
 *
 * Reads price, compare-at, cost and weight straight off the bundle variants — the cost
 * and weight set by scripts/sync-bundle-cost-weight.mjs. Deliberately NOT computed from
 * the SKUS table in bundle-economics.mjs, which carries one cost per SKU and disagrees
 * with Shopify's per-variant costs.
 *
 * Freight comes from lib/shipping-costs.js, the same model bundle-economics uses, so the
 * two reports stay comparable.
 *
 * `floor` is the lowest price that still clears 2× CAC — the depth beyond which a
 * discount stops being affordable.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessToken } from '../lib/shopify.js';
import { loadRoster } from '../lib/bundle-roster.js';
import { estimateShipping, contribution } from '../lib/shipping-costs.js';
import { API_VERSION } from '../lib/shopify-api-version.js';

const CAC = Number(process.env.CAC ?? 25);

// Every Shopify variant whose title matched no roster variant. Collected rather than
// thrown on first sight: one rerun per broken bundle is a bad loop, and an operator
// fixing config/bundles.json wants the whole list. Throws at the end, so the report is
// still fully printed and the process still exits non-zero.
const unmatched = [];

/**
 * Freight is only OUR cost when the order clears the free-shipping threshold. Below it the
 * customer pays, so charging the bundle for freight understates its contribution by the
 * full box cost — which materially misreads every sub-threshold bundle.
 *
 * Those bundles sitting just under the threshold is deliberate: it nudges the customer to
 * add an item to clear it, which lifts AOV. They are attach vehicles, not paid destinations.
 */
const THRESHOLD = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../data/brand/brand-kit.json'), 'utf8'),
).free_shipping_threshold;
const weBearFreight = (price) => price >= THRESHOLD;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const token = await getAccessToken();
const gql = async (query, variables) => {
  const r = await fetch(`https://${env.SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200));
  return j.data;
};

const Q = `query($handle:String!){ productByHandle(handle:$handle){ title
  variants(first:100){edges{node{ title price compareAtPrice
    inventoryItem{ unitCost{amount} measurement{weight{value unit}} } }}} }}`;

/**
 * Lowest price clearing `target` contribution, solved for the 2.9% + $0.30 fee.
 *
 * Inverts contribution() exactly:
 *   contribution = price - cogs - ship - packaging - (price*rate + fixed)
 *   target       = price*(1 - rate) - cogs - ship - packaging - fixed
 *   price        = (target + cogs + ship + packaging + fixed) / (1 - rate)
 *
 * `packaging` was missing from this formula, which understated the floor for any
 * bundle carrying a packaging cost (gift-box is $1). The helper was also never
 * called — the file's own docstring promised a `floor` column that did not exist.
 */
const priceFor = (target, cogs, ship, packaging = 0) =>
  Math.ceil(((target + cogs + ship + packaging + 0.30) / (1 - 0.029)) * 100) / 100;

console.log(`CAC $${CAC} · 2× threshold $${CAC * 2} · freight from lib/shipping-costs.js\n`);
console.log(`${'bundle'.padEnd(28)}${'price'.padEnd(9)}${'off'.padEnd(7)}${'cost'.padEnd(9)}${'frt'.padEnd(7)}${'contrib'.padEnd(10)}${'margin'.padEnd(8)}${'xCAC'.padEnd(7)}${'2xfloor'.padEnd(10)}${'gap'.padEnd(9)}freight`);

for (const b of loadRoster().bundles) {
  const p = (await gql(Q, { handle: b.handle }))?.productByHandle;
  if (!p) { console.log(`${b.handle.padEnd(28)}not found`); continue; }

  // One row per distinct price/cost combination — variants of a bundle usually match.
  const seen = new Set();
  for (const { node: v } of p.variants.edges) {
    const price = Number(v.price);
    const cost = v.inventoryItem?.unitCost?.amount != null ? Number(v.inventoryItem.unitCost.amount) : null;
    const oz = v.inventoryItem?.measurement?.weight?.value ?? null;
    const key = `${price}|${cost}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (cost == null || oz == null) {
      console.log(`${b.handle.padEnd(28)}$${String(price).padEnd(8)}${'—'.padEnd(7)}cost/weight unset`);
      continue;
    }

    // NO FALLBACK. This used to end `?? b.variants[0]`, which silently substituted the
    // FIRST roster variant — usually the "Variety — one of each" basket — whenever a
    // title failed to match. Unit count comes from that variant's components, so a
    // mismatch quietly produced the wrong units, hence the wrong box, the wrong freight
    // and the wrong contribution. The report still printed a confident number, and this
    // is the number pricing and discount-floor decisions are made from.
    //
    // Titles drift for ordinary reasons — an option renamed in Shopify (the
    // "Frankincence" → "Frankincense" correction did exactly this), an option reordered,
    // a variant added in the admin but not in config/bundles.json.
    const rv = b.variants.find((x) => Object.values(x.options).join(' / ') === v.title);
    if (!rv) {
      unmatched.push({
        handle: b.handle,
        shopifyTitle: v.title,
        rosterTitles: b.variants.map((x) => Object.values(x.options).join(' / ')),
      });
      console.log(`${b.handle.padEnd(28)}$${String(price).padEnd(8)}${'—'.padEnd(7)}NO ROSTER VARIANT for "${v.title}"`);
      continue;
    }
    const units = (rv.components ?? []).reduce((s, c) => s + (c.qty ?? 1), 0) || 1;
    const box = estimateShipping({ units, pounds: oz / 16 });
    const ship = weBearFreight(price) ? box : 0; // below the threshold the customer pays
    const contrib = contribution({ price, cogs: cost, shipping: ship, packaging: b.packaging ?? 0 });
    const cmp = v.compareAtPrice ? Number(v.compareAtPrice) : null;
    const off = cmp ? `${Math.round((1 - price / cmp) * 100)}%` : '—';
    const mult = contrib / CAC;
    const flag = mult >= 2 ? '✅' : mult >= 1 ? '🟡' : '🔴';
    // The floor is a MOVING target: crossing the free-shipping threshold makes
    // freight ours, so solving at the current freight can land under the
    // threshold-adjusted answer. Solve, then re-solve if the answer flips which
    // side of the threshold we are on.
    let floor = priceFor(CAC * 2, cost, ship, b.packaging ?? 0);
    if (weBearFreight(floor) !== weBearFreight(price)) {
      floor = priceFor(CAC * 2, cost, weBearFreight(floor) ? box : 0, b.packaging ?? 0);
    }
    const gap = Math.round((floor - price) * 100) / 100;

    console.log(
      `${b.handle.padEnd(28)}$${String(price).padEnd(8)}${off.padEnd(7)}$${String(cost).padEnd(8)}$${String(ship).padEnd(6)}`
      + `$${String(contrib).padEnd(9)}${(Math.round(contrib / price * 100) + '%').padEnd(8)}`
      + `${(mult.toFixed(1) + 'x').padEnd(7)}$${String(floor).padEnd(9)}${((gap > 0 ? '+$' : '$') + gap).padEnd(9)}`
      + `${(weBearFreight(price) ? 'we pay' : 'cust pays').padEnd(10)}${flag}`,
    );
  }
}

console.log('\nBelow the free-shipping threshold the customer pays freight, so it is not our cost. Those bundles are attach vehicles: sitting just under the threshold nudges an add-on, which lifts AOV.');

if (unmatched.length) {
  console.error(`\n${unmatched.length} Shopify variant(s) matched no roster variant in config/bundles.json:\n`);
  for (const u of unmatched) {
    console.error(`  ${u.handle}`);
    console.error(`    shopify : "${u.shopifyTitle}"`);
    console.error(`    roster  : ${u.rosterTitles.map((t) => `"${t}"`).join(', ') || '(none)'}`);
  }
  throw new Error(
    `${unmatched.length} unmatched variant(s) — the rows above are MISSING from the report, not wrong. `
    + 'Reconcile config/bundles.json with Shopify (scripts/roster-from-shopify.mjs regenerates it) and re-run.',
  );
}
