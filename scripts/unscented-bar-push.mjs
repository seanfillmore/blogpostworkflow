#!/usr/bin/env node
/**
 * Move surplus Pure Unscented bar soap (Sean, 2026-11-04: ~1,500 bars arriving, 24-month
 * shelf life; the variant sold 6 bars on Shopify in the prior 180 days).
 *
 *   node scripts/unscented-bar-push.mjs            # dry run: prints what would change
 *   node scripts/unscented-bar-push.mjs --apply    # writes to Shopify
 *
 * Three changes, each idempotent:
 *
 *   1. Automatic Buy X Get Y "2 free Pure Unscented bars on $60+".
 *      The $60 counts every active product EXCEPT the Pure Unscented single bar. If the
 *      free bars counted toward the minimum, a $38 cart plus two $11 bars would read $60
 *      and qualify, which is a $38 order with free bars. Products created after this runs
 *      are NOT in the qualifying set; re-run the script after adding one.
 *      The shopper still has to put the bars in the cart (Shopify never auto-adds a BXGY
 *      item); the homepage banner links to /cart/add?id=<variant>&quantity=2.
 *
 *   2. "15% off toothpaste" is allowed to combine with product discounts, so a toothpaste
 *      order over $60 gets both instead of Shopify picking one. The new discount combines
 *      with product and shipping discounts the same way.
 *
 *   3. Pure Unscented pack variants only: 4-pack $39 -> $29, 12-pack $88 -> $60. Their
 *      compare-at prices already equal the price of the singles ($44, $132) and are left
 *      alone, so the struck-through saving is honest.
 */

import { shopifyGraphQL } from '../lib/shopify.js';

const APPLY = process.argv.includes('--apply');

export const TITLE = '2 free Pure Unscented bars on $60+';
export const MIN_SUBTOTAL = '60.00';
export const FREE_QTY = '2';
export const BAR_PRODUCT_HANDLE = 'coconut-soap';
export const BAR_VARIANT = 'gid://shopify/ProductVariant/45828179951786'; // Pure Unscented single
export const TOOTHPASTE_DISCOUNT = 'gid://shopify/DiscountAutomaticNode/1597510942890';
export const PRICE_CHANGES = [
  { handle: 'coconut-bar-soap-4-pack', variant: 'gid://shopify/ProductVariant/48868611588266', from: '39.00', to: '29.00' },
  { handle: 'coconut-bar-soap-12-pack', variant: 'gid://shopify/ProductVariant/49135322988714', from: '88.00', to: '60.00' },
];

/** Pure: which products and variants count toward the $60. */
export function qualifyingItems(products, barProductHandle = BAR_PRODUCT_HANDLE, barVariant = BAR_VARIANT) {
  const productsToAdd = [];
  const productVariantsToAdd = [];
  for (const p of products) {
    if (p.handle === barProductHandle) {
      for (const v of p.variants.nodes) if (v.id !== barVariant) productVariantsToAdd.push(v.id);
    } else {
      productsToAdd.push(p.id);
    }
  }
  if (!productVariantsToAdd.length && products.some((p) => p.handle === barProductHandle)) {
    throw new Error('no other bar soap variants found; refusing to build a qualifying set');
  }
  return { productsToAdd, productVariantsToAdd };
}

async function main() {
  const { products } = await shopifyGraphQL(`{ products(first: 250, query: "status:active") {
    nodes { id handle variants(first: 50) { nodes { id title price } } } } }`);
  const items = qualifyingItems(products.nodes);
  console.log(`Qualifying set: ${items.productsToAdd.length} products + ${items.productVariantsToAdd.length} other bar variants (Pure Unscented single excluded)`);

  // 1. the BXGY
  const existing = await shopifyGraphQL(`{ discountNodes(first: 5, query: "title:'${TITLE}'") { nodes { id } } }`);
  if (existing.discountNodes.nodes.length) {
    console.log(`1. "${TITLE}" already exists (${existing.discountNodes.nodes[0].id}); not recreated`);
  } else if (!APPLY) {
    console.log(`1. would create "${TITLE}": spend $${MIN_SUBTOTAL} on qualifying items -> ${FREE_QTY} x Pure Unscented bar at 100% off, once per order`);
  } else {
    const r = await shopifyGraphQL(`mutation($d: DiscountAutomaticBxgyInput!) {
      discountAutomaticBxgyCreate(automaticBxgyDiscount: $d) {
        automaticDiscountNode { id } userErrors { field message } } }`, {
      d: {
        title: TITLE,
        startsAt: new Date().toISOString(),
        usesPerOrderLimit: '1',
        combinesWith: { productDiscounts: true, shippingDiscounts: true, orderDiscounts: false },
        customerBuys: { value: { amount: MIN_SUBTOTAL }, items: { products: items } },
        customerGets: {
          value: { discountOnQuantity: { quantity: FREE_QTY, effect: { percentage: 1.0 } } },
          items: { products: { productVariantsToAdd: [BAR_VARIANT] } },
        },
      },
    });
    const out = r.discountAutomaticBxgyCreate;
    if (out.userErrors.length) throw new Error(JSON.stringify(out.userErrors));
    console.log(`1. created "${TITLE}" ${out.automaticDiscountNode.id}`);
  }

  // 2. toothpaste stacking
  const tp = await shopifyGraphQL(`query($id: ID!) { discountNode(id: $id) { discount { ... on DiscountAutomaticBasic {
    title combinesWith { productDiscounts orderDiscounts shippingDiscounts } } } } }`, { id: TOOTHPASTE_DISCOUNT });
  const cw = tp.discountNode.discount.combinesWith;
  if (cw.productDiscounts) {
    console.log('2. toothpaste 15% already combines with product discounts');
  } else if (!APPLY) {
    console.log('2. would let "15% off toothpaste" combine with product discounts');
  } else {
    const r = await shopifyGraphQL(`mutation($id: ID!, $d: DiscountAutomaticBasicInput!) {
      discountAutomaticBasicUpdate(id: $id, automaticBasicDiscount: $d) { userErrors { field message } } }`,
    { id: TOOTHPASTE_DISCOUNT, d: { combinesWith: { ...cw, productDiscounts: true } } });
    if (r.discountAutomaticBasicUpdate.userErrors.length) throw new Error(JSON.stringify(r.discountAutomaticBasicUpdate.userErrors));
    console.log('2. "15% off toothpaste" now combines with product discounts');
  }

  // 3. pack prices
  for (const c of PRICE_CHANGES) {
    const p = products.nodes.find((x) => x.handle === c.handle);
    const v = p?.variants.nodes.find((x) => x.id === c.variant);
    if (!v) throw new Error(`variant ${c.variant} not found on ${c.handle}`);
    if (v.price === c.to) { console.log(`3. ${c.handle} ${v.title} already $${c.to}`); continue; }
    if (v.price !== c.from) throw new Error(`${c.handle} ${v.title} is $${v.price}, expected $${c.from}; refusing`);
    if (!APPLY) { console.log(`3. would set ${c.handle} ${v.title} $${c.from} -> $${c.to}`); continue; }
    const r = await shopifyGraphQL(`mutation($pid: ID!, $v: [ProductVariantsBulkInput!]!) {
      productVariantsBulkUpdate(productId: $pid, variants: $v) { userErrors { field message } } }`,
    { pid: p.id, v: [{ id: c.variant, price: c.to }] });
    if (r.productVariantsBulkUpdate.userErrors.length) throw new Error(JSON.stringify(r.productVariantsBulkUpdate.userErrors));
    console.log(`3. ${c.handle} ${v.title} $${c.from} -> $${c.to}`);
  }
  if (!APPLY) console.log('\nDry run. --apply to write.');
}

import { isDirectRun } from '../lib/is-direct-run.js';
if (isDirectRun(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
