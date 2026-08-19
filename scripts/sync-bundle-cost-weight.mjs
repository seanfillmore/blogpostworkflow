#!/usr/bin/env node
/**
 * Set cost and weight on every bundle variant, derived from the components it ships.
 *
 *   node scripts/sync-bundle-cost-weight.mjs              # dry run — prints the change table
 *   node scripts/sync-bundle-cost-weight.mjs --apply      # write to Shopify
 *   node scripts/sync-bundle-cost-weight.mjs <handle>     # limit to one bundle
 *
 * Bundle variants ship with no cost and no weight, because a componentised bundle is
 * assembled at fulfilment and nothing populates those fields. With `unitCost` unset
 * Shopify reports 100% margin on every bundle order, so profit reporting overstates and
 * any margin analysis built on it is wrong. With weight 0, carrier rates and shipping
 * reports are wrong too.
 *
 * Component costs are read from Shopify (`inventoryItem.unitCost`), which is authoritative
 * and per-variant — NOT from the SKUS table in bundle-economics.mjs, which carries one
 * cost per SKU and already disagrees with Shopify.
 *
 * Writes the previous values to data/reports/bundle-cost-weight/<timestamp>.json before
 * applying, so a bad run is reversible.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessToken } from '../lib/shopify.js';
import { loadRoster } from '../lib/bundle-roster.js';
import { computeTotals } from '../lib/bundle-cost-weight.js';
import { API_VERSION } from '../lib/shopify-api-version.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }),
);

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const only = args.filter((a) => !a.startsWith('--'));

const token = await getAccessToken();
const API = `https://${env.SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`;

async function gql(query, variables) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 300));
  return json.data;
}

const PRODUCT_Q = `query($handle:String!){ productByHandle(handle:$handle){
  id title
  variants(first:100){edges{node{ id title
    inventoryItem{ id unitCost{amount} measurement{weight{value unit}} } }}}
}}`;

const cache = new Map();
async function product(handle) {
  if (!cache.has(handle)) cache.set(handle, (await gql(PRODUCT_Q, { handle }))?.productByHandle ?? null);
  return cache.get(handle);
}

/** (productHandle, variantTitle) => component cost/weight, or undefined if absent. */
async function buildLookup(handles) {
  const table = new Map();
  for (const h of handles) {
    const p = await product(h);
    if (!p) continue;
    for (const { node: v } of p.variants.edges) {
      table.set(`${h}|${v.title}`, {
        unitCost: v.inventoryItem?.unitCost?.amount != null ? Number(v.inventoryItem.unitCost.amount) : null,
        weight: v.inventoryItem?.measurement?.weight?.value ?? null,
        weightUnit: v.inventoryItem?.measurement?.weight?.unit ?? 'OUNCES',
      });
    }
  }
  return (prod, variant) => table.get(`${prod}|${variant}`);
}

const roster = loadRoster().bundles.filter((b) => !only.length || only.includes(b.handle));
const componentHandles = [...new Set(
  roster.flatMap((b) => b.variants.flatMap((v) => (v.components ?? []).map((c) => c.product))),
)];
const lookup = await buildLookup(componentHandles);

const rows = [];
for (const bundle of roster) {
  const live = await product(bundle.handle);
  if (!live) { rows.push({ bundle: bundle.handle, error: 'not found in Shopify' }); continue; }

  for (const rv of bundle.variants) {
    const wanted = Object.values(rv.options).join(' / ');
    const node = live.variants.edges
      .map((e) => e.node)
      .find((n) => n.title === wanted || (live.variants.edges.length === 1 && n.title === 'Default Title'));
    if (!node) { rows.push({ bundle: bundle.handle, variant: wanted, error: 'variant not found' }); continue; }

    const totals = computeTotals(rv.components ?? [], lookup, { packaging: bundle.packaging ?? 0 });
    const curCost = node.inventoryItem?.unitCost?.amount != null ? Number(node.inventoryItem.unitCost.amount) : null;
    const curOz = node.inventoryItem?.measurement?.weight?.value ?? null;

    rows.push({
      bundle: bundle.handle,
      variant: wanted,
      inventoryItemId: node.inventoryItem?.id,
      curCost, curOz,
      newCost: totals.cost, newOz: totals.weightOz,
      missing: totals.missing,
      changed: totals.cost != null && (curCost !== totals.cost || curOz !== totals.weightOz),
    });
  }
}

console.log(`${'bundle'.padEnd(30)} ${'variant'.padEnd(22)} ${'cost'.padEnd(18)} weight (oz)`);
for (const r of rows) {
  if (r.error) { console.log(`${r.bundle.padEnd(30)} ${(r.variant ?? '').padEnd(22)} ✗ ${r.error}`); continue; }
  if (r.missing.length) {
    console.log(`${r.bundle.padEnd(30)} ${r.variant.padEnd(22)} ✗ ${r.missing.join('; ')}`);
    continue;
  }
  const cost = `${r.curCost == null ? 'unset' : '$' + r.curCost} → $${r.newCost}`;
  const oz = `${r.curOz == null ? 'unset' : r.curOz} → ${r.newOz}`;
  console.log(`${r.bundle.padEnd(30)} ${r.variant.padEnd(22)} ${cost.padEnd(18)} ${oz}${r.changed ? '' : '   (no change)'}`);
}

const writable = rows.filter((r) => r.changed && !r.error && !r.missing?.length);
const blocked = rows.filter((r) => r.error || r.missing?.length);
console.log(`\n${writable.length} variant(s) to update, ${blocked.length} blocked`);

if (!APPLY) {
  console.log('\ndry run — pass --apply to write');
  process.exit(blocked.length ? 1 : 0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = join(ROOT, 'data/reports/bundle-cost-weight');
mkdirSync(backupDir, { recursive: true });
writeFileSync(join(backupDir, `${stamp}.json`), JSON.stringify(rows, null, 2));
console.log(`previous values saved to data/reports/bundle-cost-weight/${stamp}.json`);

const M = `mutation($input:InventoryItemInput!,$id:ID!){ inventoryItemUpdate(id:$id,input:$input){
  inventoryItem{ id unitCost{amount} measurement{weight{value unit}} } userErrors{field message} }}`;

let ok = 0;
for (const r of writable) {
  const d = await gql(M, {
    id: r.inventoryItemId,
    input: { cost: r.newCost, measurement: { weight: { value: r.newOz, unit: 'OUNCES' } } },
  });
  const errs = d.inventoryItemUpdate.userErrors;
  if (errs.length) console.log(`✗ ${r.bundle} / ${r.variant}: ${errs.map((e) => e.message).join(', ')}`);
  else { ok++; console.log(`✓ ${r.bundle} / ${r.variant}`); }
}
console.log(`\n${ok}/${writable.length} updated`);
process.exit(ok === writable.length ? 0 : 1);
