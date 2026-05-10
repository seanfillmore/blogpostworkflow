#!/usr/bin/env node
/**
 * Creates the two automatic tier discounts referenced in the PDP discount-callout:
 *   - Buy 2 Save 10% (10% off, min 2 items)
 *   - Buy 3 Save 20% (20% off, min 3 items)
 *
 * Both apply store-wide, start immediately, no end date.
 * combinesWith: shipping discounts only (so the subscription free-shipping
 * discount still applies); does NOT combine with other order/product discounts
 * (so the 10% and 20% don't stack — Shopify picks the better tier).
 *
 * Idempotent: skips creation if a discount with the same title already exists.
 *
 * Usage: node scripts/create-automatic-discounts.mjs [--dry-run]
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function loadEnv() {
  const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return env;
}

import { getAccessToken } from '../lib/shopify.js';

const env = loadEnv();
const STORE = env.SHOPIFY_STORE;
const API_VERSION = env.SHOPIFY_API_VERSION || '2024-10';
if (!STORE) {
  console.error('Missing SHOPIFY_STORE in .env');
  process.exit(1);
}
const GQL_URL = `https://${STORE}/admin/api/${API_VERSION}/graphql.json`;

async function gql(query, variables = {}) {
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': await getAccessToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(`GraphQL: ${json.errors.map((e) => e.message).join(', ')}`);
  return json.data;
}

const DRY_RUN = process.argv.includes('--dry-run');

const STARTS_AT = new Date().toISOString();

const DISCOUNTS = [
  {
    title: 'Buy 2 Save 10%',
    percentage: 0.10,
    minQuantity: '2',
  },
  {
    title: 'Buy 3 Save 20%',
    percentage: 0.20,
    minQuantity: '3',
  },
];

async function listExistingAutomaticDiscounts() {
  const data = await gql(`
    query {
      automaticDiscountNodes(first: 100) {
        nodes {
          id
          automaticDiscount {
            __typename
            ... on DiscountAutomaticBasic {
              title
              status
            }
          }
        }
      }
    }
  `);
  return data.automaticDiscountNodes.nodes
    .filter((n) => n.automaticDiscount.__typename === 'DiscountAutomaticBasic')
    .map((n) => ({ id: n.id, title: n.automaticDiscount.title, status: n.automaticDiscount.status }));
}

async function createDiscount({ title, percentage, minQuantity }) {
  const input = {
    title,
    startsAt: STARTS_AT,
    customerGets: {
      value: { percentage },
      items: { all: true },
    },
    minimumRequirement: {
      quantity: { greaterThanOrEqualToQuantity: minQuantity },
    },
    combinesWith: {
      orderDiscounts: false,
      productDiscounts: false,
      shippingDiscounts: true,
    },
  };
  const data = await gql(
    `mutation Create($input: DiscountAutomaticBasicInput!) {
      discountAutomaticBasicCreate(automaticBasicDiscount: $input) {
        automaticDiscountNode { id automaticDiscount { ... on DiscountAutomaticBasic { title status startsAt summary } } }
        userErrors { field message }
      }
    }`,
    { input },
  );
  const r = data.discountAutomaticBasicCreate;
  if (r.userErrors?.length) {
    throw new Error(`userErrors: ${r.userErrors.map((e) => `${e.field?.join('.')}: ${e.message}`).join('; ')}`);
  }
  return r.automaticDiscountNode;
}

async function main() {
  console.log(`Shopify store: ${STORE}`);
  console.log(`API version:   ${API_VERSION}`);
  console.log(`Starts at:     ${STARTS_AT}`);
  console.log(DRY_RUN ? '\n[DRY RUN — no writes]\n' : '');

  console.log('Existing automatic basic discounts:');
  const existing = await listExistingAutomaticDiscounts();
  for (const d of existing) console.log(`  - ${d.title} (${d.status}) ${d.id}`);
  if (!existing.length) console.log('  (none)');

  for (const d of DISCOUNTS) {
    const conflict = existing.find((e) => e.title === d.title);
    if (conflict) {
      console.log(`\n→ "${d.title}" already exists at ${conflict.id} (${conflict.status}) — skipping.`);
      continue;
    }
    console.log(`\n→ Creating "${d.title}" — ${d.percentage * 100}% off, min ${d.minQuantity} items`);
    if (DRY_RUN) { console.log('  (dry-run — would create)'); continue; }
    const node = await createDiscount(d);
    console.log(`  Created ${node.id}`);
    console.log(`  Status:   ${node.automaticDiscount.status}`);
    console.log(`  Summary:  ${node.automaticDiscount.summary}`);
  }

  console.log('\nDone.');
}

main().catch((e) => { console.error(e); process.exit(1); });
