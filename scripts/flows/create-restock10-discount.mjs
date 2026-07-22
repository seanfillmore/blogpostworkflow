/**
 * One-time: create the RESTOCK10 discount (10% off, once per customer) used by
 * the Replenishment flow's Email 2 fallback. Idempotent.
 *   node scripts/flows/create-restock10-discount.mjs
 */
import { readFileSync } from 'fs';
import { getAccessToken } from '../../lib/shopify.js';

const env = {};
for (const l of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
  const t = l.trim(); if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('='); if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}
const STORE = env.SHOPIFY_STORE;
const token = await getAccessToken();

const mutation = `mutation($d: DiscountCodeBasicInput!) {
  discountCodeBasicCreate(basicCodeDiscount: $d) {
    codeDiscountNode { id }
    userErrors { field message }
  }
}`;
const variables = {
  d: {
    title: 'RESTOCK10',
    code: 'RESTOCK10',
    startsAt: new Date().toISOString(),
    customerSelection: { all: true },
    customerGets: { value: { percentage: 0.10 }, items: { all: true } },
    appliesOncePerCustomer: true,
  },
};
const res = await fetch(`https://${STORE}/admin/api/2025-01/graphql.json`, {
  method: 'POST',
  headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: mutation, variables }),
});
const j = await res.json();
const errs = j.data?.discountCodeBasicCreate?.userErrors ?? [];
const node = j.data?.discountCodeBasicCreate?.codeDiscountNode;
if (node) { console.log('✓ RESTOCK10 created:', node.id); }
else if (errs.some((e) => /taken|already exists|has already/i.test(e.message))) { console.log('✓ RESTOCK10 already exists — nothing to do.'); }
else { console.error('ERROR:', JSON.stringify(errs.length ? errs : j, null, 2)); process.exit(1); }
