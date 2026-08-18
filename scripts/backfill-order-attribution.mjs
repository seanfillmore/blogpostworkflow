#!/usr/bin/env node
/**
 * Backfill the `attribution` block into Shopify snapshots written before
 * agents/shopify-collector started producing it.
 *
 * ⚠️  RUN THIS ON THE PRODUCTION SERVER (root@137.184.119.230:~/seo-claude).
 *
 * `data/snapshots/` is server-authoritative and gitignored: cron on that box writes it
 * and a local checkout is *expected* to be empty or months stale. Running this locally
 * would either find nothing to do or write an attribution block into a stale checkout,
 * planting a file in a canonical path that somebody later reads as current — which
 * CLAUDE.md forbids. Deploy first, then:
 *
 *   ssh root@137.184.119.230 'cd ~/seo-claude && node scripts/backfill-order-attribution.mjs'
 *   ssh root@137.184.119.230 'cd ~/seo-claude && node scripts/backfill-order-attribution.mjs --apply'
 *
 * Behaviour:
 *   - Dry-run by DEFAULT. `--apply` writes.
 *   - `--days N` (default 90) — how many PT calendar days back to cover.
 *   - MERGES into the existing snapshot JSON. Existing fields are never dropped or
 *     rewritten; only `attribution` is added.
 *   - A date with no snapshot file is SKIPPED. Snapshots are never fabricated: a
 *     missing file means the collector never ran that day, and inventing one would
 *     manufacture a zero-order day that reads as real history.
 *   - A snapshot that already has an `attribution` block is skipped unless `--force`.
 *
 * Orders are bucketed into PT calendar days with the very same helpers the collector
 * uses (`ptDayBounds` / `ptDayOf`, imported from the agent), so a backfilled day and a
 * collector-written day cover an identical window across DST switches.
 *
 * Usage:
 *   node scripts/backfill-order-attribution.mjs                  # dry run, 90 days
 *   node scripts/backfill-order-attribution.mjs --days 30        # dry run, 30 days
 *   node scripts/backfill-order-attribution.mjs --days 30 --apply
 *   node scripts/backfill-order-attribution.mjs --apply --force  # recompute existing blocks
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { getOrders } from '../lib/shopify.js';
import {
  SNAPSHOTS_DIR, buildAttribution, ptDayBounds, ptDayOf,
} from '../agents/shopify-collector/index.js';

// getOrders() asks for limit=250 and does not paginate, so a window that returns
// exactly 250 orders is probably truncated. The store averages ~0.5 orders/day, so 250
// covers well over a year — but say so rather than silently backfilling a partial day.
const SHOPIFY_PAGE_LIMIT = 250;

/** The N PT calendar days ending on (and including) `endDate`, oldest first. */
export function datesInWindow(endDate, days) {
  const n = Math.max(1, Number(days) || 1);
  const end = new Date(`${endDate}T12:00:00Z`);
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(ptDayOf(new Date(end.getTime() - i * 86_400_000)));
  }
  return out;
}

/** Group raw orders by the PT calendar day of created_at. */
export function bucketOrdersByPtDay(orders) {
  const m = new Map();
  for (const o of (orders || [])) {
    const day = ptDayOf(o?.created_at);
    if (!day) continue;
    if (!m.has(day)) m.set(day, []);
    m.get(day).push(o);
  }
  return m;
}

/**
 * Add `attribution` to a snapshot without touching anything else.
 *
 * @returns {{action:'update'|'skip-existing', snapshot:object}}
 */
export function mergeAttribution(snapshot, attribution, { force = false } = {}) {
  if (snapshot?.attribution && !force) {
    return { action: 'skip-existing', snapshot };
  }
  // Spread first so every existing key survives with its existing value; only
  // `attribution` is set. Never rebuild the snapshot from scratch here — the collector
  // has gained fields over time and this script must not be the thing that drops one.
  return { action: 'update', snapshot: { ...snapshot, attribution } };
}

function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const force = argv.includes('--force');
  const daysRaw = argv.find(a => a.startsWith('--days='))?.split('=')[1]
    ?? (argv.includes('--days') ? argv[argv.indexOf('--days') + 1] : null);
  const days = daysRaw ? Number(daysRaw) : 90;
  if (!Number.isFinite(days) || days < 1) throw new Error(`Invalid --days value: ${daysRaw}`);
  return { apply, force, days: Math.floor(days) };
}

async function main() {
  const { apply, force, days } = parseArgs(process.argv);

  const today = ptDayOf(new Date());
  const dates = datesInWindow(today, days);
  const windowStart = ptDayBounds(dates[0]).dayStart;
  const windowEnd = ptDayBounds(dates[dates.length - 1]).dayEnd;

  console.log('Backfill order attribution');
  console.log(`  Mode: ${apply ? 'APPLY (writing)' : 'DRY RUN (no writes)'}${force ? ' --force' : ''}`);
  console.log(`  Window: ${dates[0]} .. ${dates[dates.length - 1]} (${days} PT days)`);
  console.log(`  Snapshots: ${SNAPSHOTS_DIR}`);

  process.stdout.write('  Fetching orders... ');
  const { rawOrders } = await getOrders(windowStart, windowEnd);
  console.log(`done (${rawOrders.length} orders)`);
  if (rawOrders.length >= SHOPIFY_PAGE_LIMIT) {
    console.warn(`  WARNING: hit the ${SHOPIFY_PAGE_LIMIT}-order page limit — the window may be truncated.`);
    console.warn('           Re-run with a smaller --days so every day is complete.');
  }

  const byDay = bucketOrdersByPtDay(rawOrders);

  let scanned = 0, wouldUpdate = 0, updated = 0, skippedMissing = 0, skippedExisting = 0;
  const changes = [];

  for (const date of dates) {
    const path = join(SNAPSHOTS_DIR, `${date}.json`);
    if (!existsSync(path)) { skippedMissing++; continue; }
    scanned++;

    let existing;
    try {
      existing = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      console.warn(`  ! ${date}: unreadable snapshot (${err.message}) — skipped`);
      skippedMissing++;
      scanned--;
      continue;
    }

    const dayOrders = byDay.get(date) || [];
    const attribution = buildAttribution(dayOrders);
    const { action, snapshot } = mergeAttribution(existing, attribution, { force });

    if (action === 'skip-existing') { skippedExisting++; continue; }

    const summary = attribution.channels.map(c => `${c.channel} ${c.orders}/$${c.revenue}`).join(', ') || 'no attributable orders';
    changes.push(`  ${date}: ${attribution.orders.length} order record(s) — ${summary}`);

    if (apply) {
      writeFileSync(path, JSON.stringify(snapshot, null, 2));
      updated++;
    } else {
      wouldUpdate++;
    }
  }

  if (changes.length) {
    console.log('\nChanges:');
    for (const line of changes) console.log(line);
  }

  console.log('\nSummary');
  console.log(`  Files scanned:            ${scanned}`);
  console.log(`  Would update:             ${wouldUpdate}`);
  console.log(`  Updated:                  ${updated}`);
  console.log(`  Skipped (no snapshot):    ${skippedMissing}`);
  console.log(`  Skipped (has block):      ${skippedExisting}`);
  if (!apply && wouldUpdate > 0) console.log('\n  Dry run — re-run with --apply to write.');
}

// Guarded so tests can import the pure helpers without running a live backfill.
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
