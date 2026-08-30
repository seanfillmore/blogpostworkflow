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
  TIERS, buildBxgyInput, cartPermalink, OPENS_AT, CLOSES_AT, CLOSES_HUMAN,
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

// EXACT lookup by code. The obvious `codeDiscountNodes(query: "code:X")` is NOT a
// filter — it silently ignores the term and returns the first N discounts on the
// store, so an idempotence check built on it always concludes "does not exist"
// and creates a DUPLICATE code. Verified live 2026-08-24: `code:GIVEAWAY6X6`
// returned 10 unrelated discounts while the real one existed.
// codeDiscountNodeByCode is exact and case-insensitive.
const LOOKUP = `
query FindByCode($code: String!) {
  codeDiscountNodeByCode(code: $code) {
    id
    codeDiscount {
      ... on DiscountCodeBxgy { title status startsAt endsAt }
      ... on DiscountCodeBasic { title status }
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

  console.log(`Window: ${OPENS_AT} → ${CLOSES_AT} (closes ${CLOSES_HUMAN} PT)\n`);

  let created = 0;
  let existed = 0;
  for (const tier of TIERS) {
    console.log(`${tier.anchor ? '⭐ ' : '   '}${tier.title} — $${tier.priceUsd} for ${tier.totalBars} bars ($${tier.valueUsd} value)`);
    console.log(`     code ${tier.code} | cart ${cartPermalink(tier)}`);

    const existing = await gql(LOOKUP, { code: tier.code });
    const hit = existing.codeDiscountNodeByCode;
    if (hit) {
      console.log(`     already exists: ${hit.id} (${hit.codeDiscount.status}) — left alone`);
      existed += 1;
      continue;
    }

    if (!apply) { console.log('     WOULD create'); continue; }

    const data = await gql(CREATE, { bxgyCodeDiscount: buildBxgyInput(tier) });
    const errs = data.discountCodeBxgyCreate.userErrors;
    if (errs?.length) {
      for (const e of errs) console.error(`     FAIL ${e.field?.join('.')}: ${e.message} (${e.code})`);
      throw new Error(`${errs.length} userError(s) on ${tier.code} — stopping`);
    }
    const node = data.discountCodeBxgyCreate.codeDiscountNode;
    const d = node.codeDiscount;
    console.log(`     created ${node.id} | status ${d.status} | oncePerCustomer ${d.appliesOncePerCustomer} | usesPerOrderLimit ${d.usesPerOrderLimit}`);
    if (d.status !== 'SCHEDULED' && d.status !== 'ACTIVE') console.error(`     WARNING: unexpected status ${d.status}`);
    created += 1;
  }

  if (!apply) {
    console.log('\nDry run — re-run with --apply to create the missing tiers.');
    return;
  }
  console.log(`\n${created} created, ${existed} already existed.`);
}

if (isDirectRun(import.meta.url)) {
  await main();
}
