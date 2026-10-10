#!/usr/bin/env node
/**
 * Remove "lifts surface stains" from bullet 3 on the three RSC toothpaste listings.
 *
 * Operator ruling, 2026-10-10: "We have no basis to make any whitening claims." Stain
 * removal is the whitening claim in cosmetic form, and the same day "whitening" and
 * "stain" were kept out of the backend search terms for the same reason.
 *
 * Dry by default: Amazon VALIDATION_PREVIEW. `--apply` submits. Only bullet 3 changes;
 * the other four bullets are carried from live and must equal the recorded BEFORE, or
 * the SKU is skipped (shared decideListing). Run records go to
 * data/reports/amazon-toothpaste-stain-claim/.
 *
 * NOTE: remediate-rsc-listing-copy.mjs recorded the old B3 in its toothpaste AFTERs, so a
 * re-run of that script now SKIPS the toothpastes (third value), which is its safe path.
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { submissionSucceeded, patchPath } from './remediate-toothpaste-bullets.mjs';
import { decideListing, buildPatch, liveValues, PLAN as COPY_PLAN } from './remediate-rsc-listing-copy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT_DIR = join(ROOT, 'data', 'reports', 'amazon-toothpaste-stain-claim');

export const B3_BEFORE = 'COLD-PRESSED COCONUT OIL, BAKING SODA & MYRRH: The coconut oil is cold-pressed and unrefined, so it keeps what a refining process would strip out. Aluminum-free baking soda gently polishes and lifts surface stains instead of the cheap grit that is harder than your enamel. Wildcrafted myrrh has been used in oral care for centuries and is included here for gum comfort.';
export const B3_AFTER = 'COLD-PRESSED COCONUT OIL, BAKING SODA & MYRRH: The coconut oil is cold-pressed and unrefined, so it keeps what a refining process would strip out. Aluminum-free baking soda polishes gently, without the cheap grit that is harder than your enamel. Wildcrafted myrrh has been used in oral care for centuries and is included here for gum comfort.';

export const PLAN = COPY_PLAN.filter((e) => e.product === 'toothpaste').map((e) => {
  const before = [...e.after.bullet_point];
  const after = [...before];
  after[2] = B3_AFTER;
  return { sku: e.sku, asin: e.asin, variant: e.variant, before: { bullet_point: before }, after: { bullet_point: after } };
});

function envValue(key) {
  if (process.env[key]) return process.env[key];
  try {
    const m = readFileSync(join(ROOT, '.env'), 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
}

export async function main({ spapi, argv = process.argv, sellerId, outDir = OUT_DIR } = {}) {
  const apply = argv.includes('--apply');
  const sp = spapi ?? await import('../../lib/amazon/sp-api-client.js');
  const client = await sp.getClient();
  const marketplaceId = sp.getMarketplaceId();
  const seller = sellerId ?? envValue('AMAZON_SPAPI_SELLER_ID');
  if (!seller) throw new Error('AMAZON_SPAPI_SELLER_ID not set');
  const results = [];
  let failed = 0;
  for (const entry of PLAN) {
    const item = await sp.request(client, 'GET',
      `/listings/2021-08-01/items/${encodeURIComponent(seller)}/${encodeURIComponent(entry.sku)}`,
      { marketplaceIds: marketplaceId, includedData: 'summaries,attributes' });
    const productType = item?.summaries?.[0]?.productType;
    const decision = decideListing(entry, liveValues(item?.attributes, marketplaceId, ['bullet_point']));
    results.push({ sku: entry.sku, ...decision });
    console.log(`${entry.variant} ${entry.sku} — ${decision.action.toUpperCase()}: ${decision.why}`);
    if (decision.action !== 'apply') continue;
    const res = await sp.request(client, 'PATCH', patchPath({ sellerId: seller, sku: entry.sku, marketplaceId, apply }),
      buildPatch(entry, decision.fields, { productType, marketplaceId }));
    if (!submissionSucceeded(res, { apply }) || (res?.issues ?? []).some((i) => i.severity === 'ERROR')) failed += 1;
    console.log(`  ${apply ? 'SUBMITTED' : 'VALIDATION PREVIEW'} → status ${res?.status}, ${(res?.issues ?? []).length} issue(s)`);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ applied: apply, results }, null, 2));
  return { results, failed };
}

if (isDirectRun(import.meta.url)) {
  main().then((r) => process.exit(r.failed ? 2 : 0)).catch((err) => { console.error(err.message); process.exit(1); });
}
