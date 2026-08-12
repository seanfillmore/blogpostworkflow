/**
 * Google Ads Conversion Uploader
 *
 * Uploads Shopify purchases to Google Ads as offline click conversions, so paid
 * performance is measured from the order book instead of from a browser tag.
 *
 * WHY
 * ---
 * Diagnosed 2026-08-12: Google Ads reported 0 conversions for 5 straight months while
 * the store took real orders from paid clicks. The account's only counted purchase
 * conversion was a GA4 import, and GA4 was missing most of the data — 264 ad clicks
 * produced 85 GA4 sessions (68% lost); 7 storefront orders produced 4 GA4 transactions.
 * Every native WEBPAGE conversion action was REMOVED, so nothing backstopped it.
 * Order #2322 (2026-07-31, $37.19) carried a Google click id in Shopify and never
 * appeared in GA4 at all.
 *
 * The loss is client-side (consent banners, ad blockers, the sandboxed Shopify channel
 * pixel) and cannot be optimised away — real p75 LCP is ~1.5s, so this is NOT a speed
 * problem. Uploading from Shopify sidesteps every one of those failure modes.
 *
 * IDEMPOTENCY: each conversion carries the Shopify order number as `orderId`, which
 * Google deduplicates on. Re-running over the same window never double-counts, so the
 * daily job can safely re-scan recent history to catch late-arriving orders.
 *
 * Writes:
 *   data/reports/ads-conversions/YYYY-MM-DD.json
 *   data/reports/ads-conversions/latest.json
 *
 * Usage:
 *   node agents/ads-conversion-uploader/index.js              # daily: last 14 days
 *   node agents/ads-conversion-uploader/index.js --dry-run    # validate only, writes nothing to Google
 *   node agents/ads-conversion-uploader/index.js --backfill    # full 90-day lookback window
 *   node agents/ads-conversion-uploader/index.js --days 30
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getOrders } from '../../lib/shopify.js';
import { ingestConversionEvents } from '../../lib/google-ads.js';
import { selectUploadableOrders, buildIngestRequest, extractClickId } from '../../lib/ads-conversions.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'ads-conversions');

// Created 2026-08-12. type=UPLOAD_CLICKS, category=PURCHASE, primary, 90-day lookback.
const ADS_ACCOUNT_ID = '5099369750';
const CONVERSION_ACTION_ID = '7718887636';

// Google rejects conversions older than the action's click-through lookback window.
const LOOKBACK_DAYS = 90;

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  return inline ?? (i !== -1 ? process.argv[i + 1] : undefined);
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

async function main() {
  const dryRun = hasFlag('dry-run');
  const days = hasFlag('backfill') ? LOOKBACK_DAYS : Number(arg('days') || 14);
  const now = new Date();
  const from = new Date(now.getTime() - days * 86_400_000);

  console.log(`Google Ads conversion upload — last ${days} days${dryRun ? ' (DRY RUN)' : ''}`);

  const { rawOrders } = await getOrders(from.toISOString(), now.toISOString());
  const uploadable = selectUploadableOrders(rawOrders, { now, lookbackDays: LOOKBACK_DAYS });

  // Visibility into what we are NOT uploading matters as much as what we are: a sudden
  // drop in click-identified orders is how we would notice auto-tagging breaking again.
  const paidOrders = rawOrders.filter((o) => Number(o.total_price) > 0 && !o.cancelled_at);
  const skipped = paidOrders.filter((o) => !extractClickId(o.landing_site));

  console.log(`  ${rawOrders.length} orders in window, ${paidOrders.length} paid`);
  console.log(`  ${uploadable.length} carry a usable Google click id → uploading`);
  console.log(`  ${skipped.length} have no click id (organic/direct/subscription) → skipped`);

  const request = buildIngestRequest(uploadable, {
    accountId: ADS_ACCOUNT_ID,
    conversionActionId: CONVERSION_ACTION_ID,
    validateOnly: dryRun,
  });
  const conversions = request.events;
  for (const c of conversions) {
    const [type, value] = Object.entries(c.adIdentifiers)[0];
    console.log(`    #${c.transactionId}  ${c.eventTimestamp}  $${c.conversionValue}  ${type}=${value.slice(0, 12)}…`);
  }

  const result = await ingestConversionEvents(request);

  if (result.errors.length) {
    console.log(`  ${result.errors.length} event(s) rejected:`);
    for (const e of result.errors) console.log(`    - ${e.message}`);
  }
  console.log(`  ${result.accepted}/${conversions.length} accepted${dryRun ? ' (validated, not written)' : ''}`);

  const value = conversions.reduce((s, c) => s + c.conversionValue, 0);
  const report = {
    date: now.toISOString().slice(0, 10),
    dryRun,
    windowDays: days,
    ordersInWindow: rawOrders.length,
    paidOrders: paidOrders.length,
    uploadable: conversions.length,
    accepted: result.accepted,
    skippedNoClickId: skipped.length,
    conversionValue: Math.round(value * 100) / 100,
    errors: result.errors.map((e) => e.message),
    orders: conversions.map((c) => ({
      orderId: c.transactionId, value: c.conversionValue, at: c.eventTimestamp,
      idType: Object.keys(c.adIdentifiers)[0],
    })),
  };

  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(join(REPORTS_DIR, `${report.date}.json`), JSON.stringify(report, null, 2));
  writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify(report, null, 2));

  if (!dryRun) {
    await notify({
      subject: `Google Ads: ${result.accepted} conversion(s) uploaded ($${report.conversionValue})`,
      body: `${result.accepted}/${conversions.length} accepted from ${paidOrders.length} paid orders `
          + `in the last ${days} days. ${skipped.length} had no Google click id.`
          + (result.errors.length ? `\n\nRejected:\n${report.errors.join('\n')}` : ''),
      status: result.errors.length ? 'error' : 'info',
    });
  }

  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('Error:', e.message); process.exit(1); });
}

export { main };
