/**
 * winback-coupon-monitor
 *
 * The Winback "25% off" closer (flow email) uses a DYNAMIC Klaviyo coupon
 * (external_id WINBACK25) backed by a finite pool of unique Shopify codes.
 * Klaviyo assigns one code per recipient and SKIPS the email once the pool hits
 * zero (and won't let the flow go live at zero). This agent keeps the pool
 * topped up and alerts if anything is off.
 *
 * Each run:
 *   1. Count UNASSIGNED codes in the Klaviyo WINBACK25 coupon.
 *   2. If below LOW_THRESHOLD, generate more unique codes, add them to the
 *      Shopify 25% discount, and import the same strings into the coupon.
 *   3. notify() — deferred summary normally; immediate alert on low/critical/error.
 *
 * Usage: node agents/winback-coupon-monitor/index.js [--dry-run]
 */
import { fileURLToPath } from 'url';
import * as shopify from '../../lib/shopify.js';
import k from '../../lib/klaviyo.js';
import { notify } from '../../lib/notify.js';

const COUPON_ID = 'WINBACK25';
const DISCOUNT_TITLE = 'Winback 25% (unique-per-recipient)';
const PREFIX = 'WB25';
const LOW_THRESHOLD = 100; // top up when fewer than this many codes remain
const REFILL_TO = 300; // bring the available pool back up to this
const CRITICAL = 25; // below this, alert immediately even if top-up succeeds

const DRY = process.argv.includes('--dry-run');

const tok = await shopify.getAccessToken();
const SURL = `https://${shopify.STORE}/admin/api/${shopify.API_VERSION}/graphql.json`;
const gql = async (query, variables = {}) => {
  const r = await fetch(SURL, { method: 'POST', headers: { 'X-Shopify-Access-Token': tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
  return r.json();
};

function genCodes(n) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const set = new Set();
  while (set.size < n) {
    let s = '';
    for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    set.add(`${PREFIX}-${s}`);
  }
  return [...set];
}

async function countUnassigned() {
  let count = 0;
  let url = `/coupons/${COUPON_ID}/coupon-codes/?filter=${encodeURIComponent("equals(status,'UNASSIGNED')")}&page%5Bsize%5D=100`;
  while (url) {
    const d = await k.klaviyoRequest('GET', url);
    count += (d.data || []).length;
    url = d.links?.next || null;
  }
  return count;
}

async function findDiscountId() {
  let cursor = null;
  for (let page = 0; page < 5; page++) {
    const j = await gql(`query($c:String){ codeDiscountNodes(first:100,after:$c){ pageInfo{hasNextPage endCursor} nodes{ id codeDiscount{ ... on DiscountCodeBasic{ title } } } } }`, { c: cursor });
    const conn = j.data?.codeDiscountNodes;
    const hit = (conn?.nodes || []).find((n) => n.codeDiscount?.title === DISCOUNT_TITLE);
    if (hit) return hit.id;
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return null;
}

async function topUp(need) {
  const discountId = await findDiscountId();
  if (!discountId) throw new Error(`Shopify discount "${DISCOUNT_TITLE}" not found — cannot top up`);
  const codes = genCodes(need);
  // Shopify: add codes in chunks of 100
  for (let i = 0; i < codes.length; i += 100) {
    const chunk = codes.slice(i, i + 100).map((code) => ({ code }));
    const j = await gql(`mutation($id:ID!,$codes:[DiscountRedeemCodeInput!]!){ discountRedeemCodeBulkAdd(discountId:$id,codes:$codes){ userErrors{ message } } }`, { id: discountId, codes: chunk });
    const err = j.data?.discountRedeemCodeBulkAdd?.userErrors;
    if (err?.length) throw new Error(`Shopify bulk-add failed: ${JSON.stringify(err)}`);
  }
  // Klaviyo: import the same strings into the coupon
  let imported = 0;
  for (const c of codes) {
    await k.klaviyoRequest('POST', '/coupon-codes/', { data: { type: 'coupon-code', attributes: { unique_code: c }, relationships: { coupon: { data: { type: 'coupon', id: COUPON_ID } } } } });
    imported++;
  }
  return imported;
}

async function main() {
  let available;
  try {
    available = await countUnassigned();
  } catch (e) {
    await notify({ subject: '⚠️ Winback coupon monitor failed', body: `Could not read the WINBACK25 pool: ${e.message}`, status: 'error', category: 'winback-coupon', immediate: true });
    console.error('ERROR:', e.message);
    process.exit(1);
  }

  console.log(`WINBACK25 available codes: ${available} (threshold ${LOW_THRESHOLD}, refill to ${REFILL_TO})`);

  if (available >= LOW_THRESHOLD) {
    console.log('Pool healthy — no action.');
    return; // stay quiet when healthy (avoid daily-digest noise)
  }

  const need = REFILL_TO - available;
  if (DRY) {
    await notify({ subject: `Winback coupon pool low (${available} left)`, body: `Dry run — would add ${need} codes to reach ${REFILL_TO}.`, status: 'warning', category: 'winback-coupon' });
    console.log(`[dry-run] would add ${need} codes.`);
    return;
  }

  try {
    const added = await topUp(need);
    const now = available + added;
    await notify({
      subject: `Winback coupon pool topped up (+${added} → ${now})`,
      body: `The WINBACK25 pool had ${available} codes left (below ${LOW_THRESHOLD}). Added ${added} unique codes to both the Shopify discount and the Klaviyo coupon; now ${now} available.`,
      status: 'info', category: 'winback-coupon',
      immediate: available < CRITICAL, // if it got dangerously low, surface immediately
    });
    console.log(`Topped up: +${added}, now ${now} available.`);
  } catch (e) {
    await notify({ subject: '⚠️ Winback coupon top-up FAILED', body: `Pool is at ${available} (below ${LOW_THRESHOLD}) and the top-up failed: ${e.message}. If it reaches 0, the Winback 25% email will be skipped for recipients.`, status: 'error', category: 'winback-coupon', immediate: true });
    console.error('TOP-UP ERROR:', e.message);
    process.exit(1);
  }
}

export { countUnassigned, findDiscountId, topUp };

// Run only when invoked directly (lets tests import the helpers).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
