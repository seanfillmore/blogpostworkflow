#!/usr/bin/env node
/**
 * Replace the hidden backend search terms (`generic_keyword`) on the 11 RSC listings
 * rewritten on 2026-10-10 (3 deodorant, 3 toothpaste, 5 lotion).
 *
 * Dry by default: sends the exact PATCH with `mode=VALIDATION_PREVIEW`. `--apply` submits.
 * Operator approved 2026-10-10, with one ruling: "We have no basis to make any whitening
 * claims", so no whitening or stain term appears in any value.
 *
 * WHY. Amazon's guidance for this field: under 250 bytes, words NOT already in the title or
 * bullets (Amazon already indexes those), no brand names, synonyms and Spanish encouraged.
 * The live values broke it both ways: the toothpaste fields mostly repeated their own
 * title, and the deodorant and lotion fields still carried "scar", "firming", "gluten",
 * "mosturizer" and "underarmed". Meanwhile Amazon's own Search Query Performance data
 * (six weekly reports, 2026-08-16 → 2026-09-26) and Brand Analytics ranks showed real
 * demand the copy did not index: "mens deodorant" (105,708 searches / 6 weeks),
 * "desodorante sin aluminio mujer" (31,024, where we already took 162 impressions and 4
 * add-to-carts), "kids toothpaste" (Brand Analytics rank 1,361), "lotion for women"
 * (20,379), "crema de coco para el cuerpo".
 *
 * Each AFTER was built per SKU from a candidate list, dropping any word already present in
 * that SKU's live title or bullets. Deliberately left out: competitor brand names (Amazon
 * policy), "unscented" on the scented deodorants, "cruelty-free" (no basis on file),
 * "xylitol" (the toothpaste has none) and "whitening"/"stain" (operator ruling).
 *
 * NOTE ON OWNERSHIP. remediate-rsc-listing-copy.mjs also wrote `generic_keyword` on the
 * three toothpastes. After this runs, that script sees a third value on those SKUs and
 * SKIPS them, which is its documented safe behaviour. This file now owns the field.
 *
 * Usage:
 *   node scripts/amazon/apply-rsc-backend-keywords-2026-10-10.mjs            # preview
 *   node scripts/amazon/apply-rsc-backend-keywords-2026-10-10.mjs --apply    # submit
 */
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { submissionSucceeded, patchPath } from './remediate-toothpaste-bullets.mjs';
import { decideListing, buildPatch, liveValues } from './remediate-rsc-listing-copy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT_DIR = join(ROOT, 'data', 'reports', 'amazon-rsc-backend-keywords');
export const MAX_BYTES = 249;

const DATA = JSON.parse(readFileSync(join(HERE, 'rsc-backend-keywords-2026-10-10.json'), 'utf8')).listings;
export const PLAN = Object.entries(DATA).map(([sku, v]) => ({
  sku,
  asin: v.asin,
  before: { generic_keyword: v.before },
  after: { generic_keyword: v.after },
}));

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
    const live = liveValues(item?.attributes, marketplaceId, ['generic_keyword']);
    const decision = decideListing(entry, live);
    const row = { sku: entry.sku, asin: entry.asin, productType, ...decision, before_live: live };
    results.push(row);
    console.log(`${entry.sku} (${entry.asin}) — ${decision.action.toUpperCase()}: ${decision.why}`);
    if (decision.action !== 'apply') continue;
    if (!productType) throw new Error(`${entry.sku}: no productType on the live listing`);
    const res = await sp.request(client, 'PATCH',
      patchPath({ sellerId: seller, sku: entry.sku, marketplaceId, apply }),
      buildPatch(entry, decision.fields, { productType, marketplaceId }));
    const errors = (res?.issues ?? []).filter((i) => i.severity === 'ERROR');
    row.submission = { mode: apply ? 'LIVE' : 'VALIDATION_PREVIEW', status: res?.status, submissionId: res?.submissionId, issues: res?.issues ?? [] };
    if (!submissionSucceeded(res, { apply }) || errors.length) failed += 1;
    console.log(`  ${apply ? 'SUBMITTED' : 'VALIDATION PREVIEW'} → status ${res?.status}, ${(res?.issues ?? []).length} issue(s)`);
    for (const i of res?.issues ?? []) console.log(`    [${i.severity}] ${i.code}: ${i.message}`);
  }

  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const record = { generated_at: new Date().toISOString(), applied: apply, results };
  writeFileSync(join(outDir, `run-${stamp}.json`), JSON.stringify(record, null, 2));
  console.log(`\nRun record: ${join(outDir, `run-${stamp}.json`)}`);
  return { ...record, failed };
}

if (isDirectRun(import.meta.url)) {
  main()
    .then((r) => process.exit(r.failed ? 2 : 0))
    .catch((err) => { console.error(err.message); process.exit(1); });
}
