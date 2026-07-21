/**
 * Set up dynamic (unique-per-recipient) 25% codes for the Winback closer.
 *
 *  - Shopify: one 25%-off code discount (once/customer) + a pool of unique codes.
 *  - Klaviyo: a coupon (external_id WINBACK25) with those same code strings imported,
 *    so Klaviyo hands each recipient a distinct code via {% coupon_code 'WINBACK25' %}.
 *
 * Idempotent-ish: skips creation if the Shopify discount / Klaviyo coupon already exist.
 * Run: node scripts/flows/setup-winback-coupon.js [poolSize]
 */
import * as shopify from '../../lib/shopify.js';
import k from '../../lib/klaviyo.js';

const POOL = Number(process.argv[2] || 300);
const COUPON_ID = 'WINBACK25';
const PREFIX = 'WB25';

const tok = await shopify.getAccessToken();
const SURL = `https://${shopify.STORE}/admin/api/${shopify.API_VERSION}/graphql.json`;
const gql = async (query, variables = {}) => {
  const r = await fetch(SURL, { method: 'POST', headers: { 'X-Shopify-Access-Token': tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  return r.json();
};

// deterministic-ish unique codes (Math.random ok in a plain node script)
function genCodes(n) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
  const set = new Set();
  while (set.size < n) {
    let s = '';
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    set.add(`${PREFIX}-${s}`);
  }
  return [...set];
}

const codes = genCodes(POOL);
console.log(`Generated ${codes.length} unique codes.`);

// ---- Shopify: create discount + pool ----
let discountId;
const existing = await gql(`query($c:String!){ codeDiscountNodeByCode(code:$c){ id } }`, { c: codes[0] });
if (existing.data?.codeDiscountNodeByCode) { console.log('first code already exists — aborting to avoid dup'); process.exit(1); }

const createRes = await gql(
  `mutation($b:DiscountCodeBasicInput!){ discountCodeBasicCreate(basicCodeDiscount:$b){ codeDiscountNode{ id } userErrors{ field message } } }`,
  { b: {
      title: 'Winback 25% (unique-per-recipient)',
      code: codes[0],
      startsAt: new Date().toISOString(),
      appliesOncePerCustomer: true,
      customerSelection: { all: true },
      customerGets: { value: { percentage: 0.25 }, items: { all: true } },
  } },
);
if (createRes.data?.discountCodeBasicCreate?.userErrors?.length) { console.log('discount create ERR', JSON.stringify(createRes.data.discountCodeBasicCreate.userErrors)); process.exit(1); }
discountId = createRes.data.discountCodeBasicCreate.codeDiscountNode.id;
console.log('Shopify 25% discount created:', discountId);

// bulk-add the rest in chunks of 100
const rest = codes.slice(1);
for (let i = 0; i < rest.length; i += 100) {
  const chunk = rest.slice(i, i + 100).map((code) => ({ code }));
  const j = await gql(`mutation($id:ID!,$codes:[DiscountRedeemCodeInput!]!){ discountRedeemCodeBulkAdd(discountId:$id,codes:$codes){ bulkCreation{ id } userErrors{ message } } }`, { id: discountId, codes: chunk });
  const err = j.data?.discountRedeemCodeBulkAdd?.userErrors;
  if (err?.length) { console.log('bulk-add ERR', JSON.stringify(err)); process.exit(1); }
  process.stdout.write(`  Shopify codes added: ${Math.min(i + 100, rest.length) + 1}/${codes.length}\r`);
}
console.log(`\nShopify: ${codes.length} codes under the 25% discount.`);

// ---- Klaviyo: coupon + import same code strings ----
let couponExists = false;
try { await k.klaviyoRequest('GET', `/coupons/${COUPON_ID}/`); couponExists = true; } catch { /* not found */ }
if (!couponExists) {
  await k.klaviyoRequest('POST', '/coupons/', { data: { type: 'coupon', attributes: { external_id: COUPON_ID, description: 'Winback 25% off — unique per recipient' } } });
  console.log('Klaviyo coupon created:', COUPON_ID);
}

// import same strings so Klaviyo assigns real Shopify codes (single endpoint, proven).
let imported = 0, failed = 0;
for (const c of codes) {
  try {
    await k.klaviyoRequest('POST', '/coupon-codes/', { data: { type: 'coupon-code', attributes: { unique_code: c }, relationships: { coupon: { data: { type: 'coupon', id: COUPON_ID } } } } });
    imported++;
  } catch (e) { failed++; if (failed <= 3) console.log('\n  import err:', e.message.slice(0, 100)); }
  if (imported % 50 === 0) process.stdout.write(`  Klaviyo codes imported: ${imported}/${codes.length}\r`);
}
console.log(`\nKlaviyo: imported ${imported}/${codes.length} codes (failed ${failed}).`);

console.log('\nDONE. Reference in email with: {% coupon_code \'WINBACK25\' %}');
