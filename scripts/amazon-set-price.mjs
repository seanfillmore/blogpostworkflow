/**
 * Phase 0 Task 5 — read / update a single Amazon listing price (SP-API).
 *
 * Default DRY-RUN: reads the current price and prints the intended change +
 * the PATCH body it WOULD send. Pass --apply to actually write (Sean-gated:
 * live marketplace, affects buy-box).
 *
 *   node scripts/amazon-set-price.mjs <sku> <newPrice>            # dry-run
 *   node scripts/amazon-set-price.mjs <sku> <newPrice> --apply    # write
 *
 * First target (spec): lotion SKU RSC-LO-CB-08-FBA-stickerless (ASIN B09QJFBPJ1)
 * $21.99 -> $25.99.
 */
import { readFileSync } from 'fs';

// Load .env into process.env for the SP-API client (reads process.env).
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i < 0) continue;
  process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}
process.env.AMAZON_SPAPI_ENV = 'production';

const [sku, newPriceArg] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const APPLY = process.argv.includes('--apply');
if (!sku || !newPriceArg) {
  console.error('Usage: node scripts/amazon-set-price.mjs <sku> <newPrice> [--apply]');
  process.exit(1);
}
const newPrice = Number(newPriceArg);

const spapi = await import('../lib/amazon/sp-api-client.js');
const client = spapi.getClient();
const mkt = spapi.getMarketplaceId();
const sellerId = process.env.AMAZON_SPAPI_SELLER_ID;

// --- Read current listing (price + productType) ---
const item = await spapi.request(
  client,
  'GET',
  `/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}?marketplaceIds=${mkt}&includedData=summaries,offers,attributes`,
);
const productType = item.summaries?.[0]?.productType;
const currentPrice =
  item.offers?.[0]?.price?.amount ??
  item.attributes?.purchasable_offer?.[0]?.our_price?.[0]?.schedule?.[0]?.value_with_tax ??
  '(unknown)';

console.log(`SKU ${sku} (productType ${productType})`);
console.log(`  current price: $${currentPrice}  ->  new price: $${newPrice}`);

// --- PATCH body (Listings Items API). Attribute shape can vary by productType;
//     verify against the read-back before trusting --apply on a new SKU. ---
const patchBody = {
  productType,
  patches: [
    {
      op: 'replace',
      path: '/attributes/purchasable_offer',
      value: [
        {
          currency: 'USD',
          marketplace_id: mkt,
          our_price: [{ schedule: [{ value_with_tax: newPrice }] }],
        },
      ],
    },
  ],
};

if (!APPLY) {
  console.log('\nDRY-RUN — would PATCH:');
  console.log(JSON.stringify(patchBody, null, 2));
  console.log('\nPass --apply to write (Sean-gated). Re-run dry-run after ~15min to verify read-back.');
  process.exit(0);
}

const res = await spapi.request(
  client,
  'PATCH',
  `/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(sku)}?marketplaceIds=${mkt}`,
  patchBody,
);
console.log('PATCH status:', res.status, JSON.stringify(res.issues || []));
