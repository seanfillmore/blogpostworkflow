#!/usr/bin/env node
/**
 * Does every bundle's value stack render ONE number?
 *
 *   npm run check-value-stacks
 *   npm run check-value-stacks -- --json
 *
 * Read-only. There is no --apply and there must never be one: the fix for a
 * failure here is a judgement about what counts as value, not a number to
 * recompute.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * On 2026-08-30 the Coconut Reset lander showed "$180 of value … $59 in savings"
 * in three places, "Total value $174 … You save $53" in a fourth, and struck
 * through $174 in the buy box. Nothing was stale — two Liquid blocks summed the
 * same `bundle.value_stack` metafield under two different rules and the whole
 * difference was one row, `Free shipping $6`, which was neither digital nor
 * actual product value.
 *
 * The invariant that closes it: the sum of NON-DIGITAL rows must equal the
 * product's Shopify compare-at price — the one figure on the page Shopify
 * renders and we do not.
 *
 * Exit codes: 0 all consistent · 1 an inconsistency · 2 could not read Shopify.
 */
import { shopifyGraphQL } from '../lib/shopify.js';
import { checkStackConsistency } from '../lib/bundle-value-stack.js';

const asJson = process.argv.includes('--json');

const QUERY = `{
  products(first: 250) {
    nodes {
      handle title
      variants(first: 1) { nodes { price compareAtPrice } }
      metafield(namespace: "bundle", key: "value_stack") { value }
    }
  }
}`;

let data;
try {
  data = await shopifyGraphQL(QUERY);
} catch (e) {
  console.error(`could not read Shopify: ${e.message}`);
  process.exit(2);
}

const rows = [];
for (const p of data.products.nodes) {
  if (!p.metafield?.value) continue;          // not a bundle with a value stack
  const v = p.variants.nodes[0];
  let stack;
  try {
    stack = JSON.parse(p.metafield.value);
  } catch {
    rows.push({ handle: p.handle, title: p.title, ok: false, total: null, savings: null,
      problems: ['value_stack is not parseable JSON'], notes: [] });
    continue;
  }
  const r = checkStackConsistency({
    stack,
    compareAtPrice: Number(v?.compareAtPrice),
    price: Number(v?.price),
  });
  rows.push({ handle: p.handle, title: p.title, compareAt: Number(v?.compareAtPrice),
    price: Number(v?.price), ...r });
}

if (asJson) {
  console.log(JSON.stringify({ checked: rows.length, rows }, null, 2));
} else {
  console.log(`Bundle value stacks — ${rows.length} product(s) carry one\n`);
  for (const r of rows) {
    const mark = r.ok ? 'ok  ' : 'FAIL';
    const money = r.total === null ? '' : `  value $${r.total}  price $${r.price}  save $${r.savings}`;
    console.log(`${mark}  ${r.handle}${money}`);
    for (const p of r.problems) console.log(`      ! ${p}`);
    for (const n of r.notes) console.log(`      · ${n}`);
  }
}

const bad = rows.filter((r) => !r.ok);
if (bad.length) {
  if (!asJson) console.log(`\n${bad.length} of ${rows.length} inconsistent.`);
  process.exit(1);
}
if (!asJson) console.log(`\nAll ${rows.length} consistent.`);
