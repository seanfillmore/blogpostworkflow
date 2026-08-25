#!/usr/bin/env node
/**
 * Create the giveaway consolation BOGO discount: buy 6 Pure Unscented bars,
 * get 6 free. $66 for 12 bars.
 *
 *   node scripts/giveaway/create-consolation-discount.mjs           # dry run
 *   node scripts/giveaway/create-consolation-discount.mjs --apply
 *
 * Dry by default because this creates a live, money-moving object on the
 * storefront. Idempotent: an existing discount with the same code is reported
 * and left alone rather than duplicated — two live BXGY codes on the same
 * variant is a stacking bug waiting for the first large order.
 *
 * The discount is FUTURE-DATED to the draw (see consolation-offer.js OPENS_AT),
 * so creating it early is safe: Shopify reports it as SCHEDULED and it cannot
 * be redeemed before the window opens. That is deliberate — the alternative is
 * building the campaign's entire revenue event under time pressure on draw day.
 *
 * Mutation shape validated against the 2026-07 admin schema before first run
 * (shopify-dev MCP), because a wrong `effect.percentage` here is a real
 * discount on real orders, not a failed request.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccessToken } from '../../lib/shopify.js';
import { API_VERSION } from '../../lib/shopify-api-version.js';
import { isDirectRun } from '../../lib/is-direct-run.js';
import {
  buildBxgyInput, cartPermalink, priceUsd, valueUsd, totalBars,
  DISCOUNT_CODE, DISCOUNT_TITLE, OPENS_AT, CLOSES_AT, CLOSES_HUMAN,
} from '../../lib/giveaway/consolation-offer.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadEnv() {
  const env = {};
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return env;
}

const CREATE = `
mutation CreateGiveawayBogo($bxgyCodeDiscount: DiscountCodeBxgyInput!) {
  discountCodeBxgyCreate(bxgyCodeDiscount: $bxgyCodeDiscount) {
    codeDiscountNode {
      id
      codeDiscount {
        ... on DiscountCodeBxgy {
          title
          status
          startsAt
          endsAt
          appliesOncePerCustomer
          usesPerOrderLimit
          codes(first: 5) { nodes { code } }
        }
      }
    }
    userErrors { field code message }
  }
}`;

const LOOKUP = `
query FindByCode($q: String!) {
  codeDiscountNodes(first: 10, query: $q) {
    nodes {
      id
      codeDiscount {
        ... on DiscountCodeBxgy { title status startsAt endsAt codes(first: 5) { nodes { code } } }
        ... on DiscountCodeBasic { title status }
      }
    }
  }
}`;

async function main() {
  const apply = process.argv.includes('--apply');
  const env = loadEnv();
  if (!env.SHOPIFY_STORE) throw new Error('Missing SHOPIFY_STORE in .env');
  const url = `https://${env.SHOPIFY_STORE}/admin/api/${API_VERSION}/graphql.json`;
  const token = await getAccessToken();

  const gql = async (query, variables = {}) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(`GraphQL: ${json.errors.map((e) => e.message).join(', ')}`);
    return json.data;
  };

  console.log(`Offer: buy ${totalBars() / 2} Pure Unscented bars, get ${totalBars() / 2} free`);
  console.log(`  $${priceUsd()} for ${totalBars()} bars ($${valueUsd()} value)`);
  console.log(`  code ${DISCOUNT_CODE} | opens ${OPENS_AT} | closes ${CLOSES_AT} (${CLOSES_HUMAN} PT)`);
  console.log(`  cart: ${cartPermalink()}`);

  const existing = await gql(LOOKUP, { q: `code:${DISCOUNT_CODE}` });
  const hit = existing.codeDiscountNodes.nodes.find((n) =>
    (n.codeDiscount?.codes?.nodes || []).some((c) => c.code === DISCOUNT_CODE));
  if (hit) {
    console.log(`\nAlready exists: ${hit.id} — ${hit.codeDiscount.title} (${hit.codeDiscount.status})`);
    console.log('Nothing created. Delete it in the admin first if you need to change the terms.');
    return;
  }

  if (!apply) {
    console.log('\nDry run — would create:');
    console.log(JSON.stringify(buildBxgyInput(), null, 2));
    console.log('\nRe-run with --apply to create it.');
    return;
  }

  const data = await gql(CREATE, { bxgyCodeDiscount: buildBxgyInput() });
  const errs = data.discountCodeBxgyCreate.userErrors;
  if (errs?.length) {
    for (const e of errs) console.error(`  FAIL ${e.field?.join('.')}: ${e.message} (${e.code})`);
    throw new Error(`${errs.length} userError(s) — nothing created`);
  }
  const node = data.discountCodeBxgyCreate.codeDiscountNode;
  const d = node.codeDiscount;
  console.log(`\nCreated ${node.id}`);
  console.log(`  ${d.title} | status ${d.status} | ${d.startsAt} → ${d.endsAt}`);
  console.log(`  code(s): ${d.codes.nodes.map((c) => c.code).join(', ')}`);
  console.log(`  oncePerCustomer ${d.appliesOncePerCustomer} | usesPerOrderLimit ${d.usesPerOrderLimit}`);
  if (d.status !== 'SCHEDULED' && d.status !== 'ACTIVE') {
    console.error(`  WARNING: unexpected status ${d.status}`);
  }
}

if (isDirectRun(import.meta.url)) {
  await main();
}
