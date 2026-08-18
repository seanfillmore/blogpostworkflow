#!/usr/bin/env node
/**
 * Recompute `orders.{count,revenue,aov}` and `topProducts` in historical Shopify
 * snapshots so they count ONLY revenue-bearing orders.
 *
 * ⚠️  RUN THIS ON THE PRODUCTION SERVER (root@137.184.119.230:~/seo-claude), AFTER
 *     `git pull`.
 *
 * `data/snapshots/` is server-authoritative and gitignored: cron on that box writes it
 * and a local checkout is *expected* to be empty or stale. Running --apply locally
 * would write a recomputed snapshot into a stale checkout, planting a file in a
 * canonical path that somebody later reads as current — which CLAUDE.md forbids.
 * Deploy first, then:
 *
 *   ssh root@137.184.119.230 'cd ~/seo-claude && node scripts/backfill-clean-order-revenue.mjs'
 *   ssh root@137.184.119.230 'cd ~/seo-claude && node scripts/backfill-clean-order-revenue.mjs --apply'
 *
 * ── Why ──────────────────────────────────────────────────────────────────────
 * Until this change the snapshot stored getOrders()'s raw aggregate, which includes
 * admin-preview orders, TEST-discount orders, cancelled orders and $0 orders. Every
 * headline store-revenue figure the fleet quotes was therefore inflated (~7% over one
 * measured 28-day window; 2026-08-12 read 3 orders / $110.15 against a real 2 / $71.98).
 * The collector now excludes them — so without this backfill the time series would take
 * a step down on the deploy date that looks like a sales collapse. Fixing history is
 * not optional here; a discontinuity is worse than the bug.
 *
 * ── Where the corrected numbers come from ────────────────────────────────────
 *  - `orders.{count,revenue,aov}`: recomputed from the snapshot's OWN `attribution`
 *    block (`countsAsRevenue` per order). No network, deterministic, and byte-for-byte
 *    what the collector will emit from now on.
 *  - `topProducts`: line items are NOT in the attribution block, so it cannot be
 *    derived from the file. Only days carrying at least one excluded order can be wrong
 *    at all, so for exactly those days the script re-fetches raw orders from the Shopify
 *    API once for the whole window and rebuilds the list with the collector's
 *    buildTopProducts(). `--no-fetch` skips that pass, leaving topProducts untouched and
 *    reporting each day it could not fix.
 *  - A snapshot with NO `attribution` block is SKIPPED and reported. The block is the
 *    only per-order truth the file holds; run scripts/backfill-order-attribution.mjs
 *    first (it added 72 days on the server on 2026-08-18) and then re-run this. Guessing
 *    which historical orders were tests without that evidence is not something a
 *    revenue series should be built on.
 *  - Snapshots are never fabricated: a date with no file is skipped.
 *
 * MERGES into the existing JSON — spread-first, so no field is ever dropped and the key
 * order that current consumers read stays exactly as it is.
 *
 * Usage:
 *   node scripts/backfill-clean-order-revenue.mjs                      # dry run, 90 days
 *   node scripts/backfill-clean-order-revenue.mjs --days 30
 *   node scripts/backfill-clean-order-revenue.mjs --apply
 *   node scripts/backfill-clean-order-revenue.mjs --no-fetch           # orders.* only
 *   node scripts/backfill-clean-order-revenue.mjs --snapshots-dir /tmp/copy   # test on a copy
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { getOrders } from '../lib/shopify.js';
import {
  SNAPSHOTS_DIR, buildOrderTotals, buildTopProducts, ptDayBounds, ptDayOf,
} from '../agents/shopify-collector/index.js';
import { datesInWindow, bucketOrdersByPtDay } from './backfill-order-attribution.mjs';

// getOrders() asks for limit=250 and does not paginate.
const SHOPIFY_PAGE_LIMIT = 250;

const round2 = (n) => Math.round(n * 100) / 100;

/** Orders in the attribution block that do not count as revenue. */
export function excludedOrders(snapshot) {
  const rows = snapshot?.attribution?.orders;
  return Array.isArray(rows) ? rows.filter(o => !o?.countsAsRevenue) : [];
}

/**
 * Decide what one snapshot needs, and produce the corrected copy.
 *
 * @param {object} snapshot        the snapshot as read from disk
 * @param {object} opts
 * @param {Array|null} opts.topProducts  rebuilt topProducts, or null to leave as-is
 * @returns {{action:'update'|'skip-no-attribution'|'skip-unchanged', snapshot:object,
 *            before:object, after:object, needsProducts:boolean, productsChanged:boolean}}
 */
export function planCleanRevenue(snapshot, { topProducts = null } = {}) {
  const rows = snapshot?.attribution?.orders;
  const before = {
    count: snapshot?.orders?.count ?? 0,
    revenue: snapshot?.orders?.revenue ?? 0,
    aov: snapshot?.orders?.aov ?? 0,
  };

  if (!Array.isArray(rows)) {
    return {
      action: 'skip-no-attribution', snapshot, before, after: before,
      needsProducts: false, productsChanged: false,
    };
  }

  const after = buildOrderTotals(rows);
  // topProducts can only be wrong on a day that had an order we are now excluding.
  const needsProducts = excludedOrders(snapshot).length > 0;
  const productsChanged = topProducts != null
    && JSON.stringify(topProducts) !== JSON.stringify(snapshot?.topProducts ?? []);
  const totalsChanged = after.count !== before.count
    || after.revenue !== before.revenue
    || after.aov !== before.aov;

  if (!totalsChanged && !productsChanged) {
    return { action: 'skip-unchanged', snapshot, before, after, needsProducts, productsChanged };
  }

  // Spread first so every existing key survives in its existing position; only the
  // fields this script owns are replaced.
  const next = { ...snapshot, orders: { ...snapshot.orders, ...after } };
  if (productsChanged) next.topProducts = topProducts;

  return { action: 'update', snapshot: next, before, after, needsProducts, productsChanged };
}

export function parseArgs(argv) {
  const apply = argv.includes('--apply');
  const noFetch = argv.includes('--no-fetch');
  const valueOf = (name) => argv.find(a => a.startsWith(`${name}=`))?.split('=').slice(1).join('=')
    ?? (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const daysRaw = valueOf('--days');
  const days = daysRaw ? Number(daysRaw) : 90;
  if (!Number.isFinite(days) || days < 1) throw new Error(`Invalid --days value: ${daysRaw}`);
  return {
    apply,
    noFetch,
    days: Math.floor(days),
    snapshotsDir: valueOf('--snapshots-dir') || SNAPSHOTS_DIR,
  };
}

async function main() {
  const { apply, noFetch, days, snapshotsDir } = parseArgs(process.argv);

  const today = ptDayOf(new Date());
  const dates = datesInWindow(today, days);

  console.log('Backfill clean order revenue');
  console.log(`  Mode: ${apply ? 'APPLY (writing)' : 'DRY RUN (no writes)'}${noFetch ? ' --no-fetch' : ''}`);
  console.log(`  Window: ${dates[0]} .. ${dates[dates.length - 1]} (${days} PT days)`);
  console.log(`  Snapshots: ${snapshotsDir}`);

  // ── Pass 1: read every snapshot, work out which days need line items ───────
  const loaded = new Map();
  let skippedMissing = 0;
  for (const date of dates) {
    const path = join(snapshotsDir, `${date}.json`);
    if (!existsSync(path)) { skippedMissing++; continue; }
    try {
      loaded.set(date, JSON.parse(readFileSync(path, 'utf8')));
    } catch (err) {
      console.warn(`  ! ${date}: unreadable snapshot (${err.message}) — skipped`);
      skippedMissing++;
    }
  }

  const productDays = [...loaded.entries()]
    .filter(([, snap]) => excludedOrders(snap).length > 0)
    .map(([date]) => date);

  // ── Pass 2: fetch raw orders only if some day's topProducts can be wrong ───
  let ordersByDay = new Map();
  let fetchFailed = false;
  if (productDays.length && !noFetch) {
    const windowStart = ptDayBounds(productDays[0]).dayStart;
    const windowEnd = ptDayBounds(productDays[productDays.length - 1]).dayEnd;
    process.stdout.write(`  Fetching orders for topProducts (${productDays.length} affected day(s))... `);
    try {
      const { rawOrders } = await getOrders(windowStart, windowEnd);
      console.log(`done (${rawOrders.length} orders)`);
      if (rawOrders.length >= SHOPIFY_PAGE_LIMIT) {
        console.warn(`  WARNING: hit the ${SHOPIFY_PAGE_LIMIT}-order page limit — re-run with a smaller --days.`);
      }
      ordersByDay = bucketOrdersByPtDay(rawOrders);
    } catch (err) {
      fetchFailed = true;
      console.log(`FAILED (${err.message})`);
      console.warn('  topProducts left untouched on the affected days; orders.* still corrected.');
    }
  }

  // ── Pass 3: plan, report, write ───────────────────────────────────────────
  let wouldUpdate = 0, updated = 0, unchanged = 0, noAttribution = 0, productsUnfixed = 0;
  let beforeRevenue = 0, afterRevenue = 0, beforeCount = 0, afterCount = 0;
  const changes = [];
  const missingBlock = [];

  const needsRebuild = new Set(productDays);
  for (const [date, existing] of loaded) {
    // Only rebuild topProducts on a day an excluded order could have polluted. The
    // fetch covers a contiguous window, so raw orders are on hand for untouched days
    // too — rebuilding those as well would let this script rewrite history for reasons
    // that have nothing to do with test orders (a refund or a price edit since the
    // snapshot was taken changes what the API returns today).
    const dayOrders = needsRebuild.has(date) ? ordersByDay.get(date) : null;
    const rebuilt = dayOrders ? buildTopProducts(dayOrders) : null;
    const { action, snapshot, before, after, needsProducts, productsChanged } =
      planCleanRevenue(existing, { topProducts: rebuilt });

    if (action === 'skip-no-attribution') {
      noAttribution++;
      missingBlock.push(date);
      beforeRevenue += before.revenue; afterRevenue += before.revenue;
      beforeCount += before.count; afterCount += before.count;
      continue;
    }

    beforeRevenue += before.revenue; afterRevenue += after.revenue;
    beforeCount += before.count; afterCount += after.count;

    if (needsProducts && rebuilt == null) productsUnfixed++;

    if (action === 'skip-unchanged') { unchanged++; continue; }

    const dropped = excludedOrders(existing)
      .map(o => `${o.name || o.id} $${o.total} ${o.channel}${o.isTest ? '/test' : ''}${o.cancelled ? '/cancelled' : ''}`)
      .join(', ');
    changes.push(
      `  ${date}: ${before.count} orders / $${round2(before.revenue)} -> ${after.count} / $${after.revenue}`
      + (dropped ? `  [excluded: ${dropped}]` : '')
      + (productsChanged ? '  [topProducts rebuilt]' : '')
      + (needsProducts && rebuilt == null ? '  [topProducts NOT rebuilt]' : ''),
    );

    if (apply) {
      writeFileSync(join(snapshotsDir, `${date}.json`), JSON.stringify(snapshot, null, 2));
      updated++;
    } else {
      wouldUpdate++;
    }
  }

  if (changes.length) {
    console.log('\nChanges:');
    for (const line of changes) console.log(line);
  }
  if (missingBlock.length) {
    console.log(`\nNo attribution block (skipped — run backfill-order-attribution.mjs first):`);
    console.log(`  ${missingBlock.join(', ')}`);
  }

  console.log('\nSummary');
  console.log(`  Files scanned:            ${loaded.size}`);
  console.log(`  Would update:             ${wouldUpdate}`);
  console.log(`  Updated:                  ${updated}`);
  console.log(`  Already correct:          ${unchanged}`);
  console.log(`  Skipped (no snapshot):    ${skippedMissing}`);
  console.log(`  Skipped (no attribution): ${noAttribution}`);
  if (productsUnfixed) {
    console.log(`  topProducts not rebuilt:  ${productsUnfixed} day(s)${noFetch ? ' (--no-fetch)' : (fetchFailed ? ' (fetch failed)' : '')}`);
  }
  console.log('\nRevenue correction over the window');
  console.log(`  Before: ${beforeCount} orders / $${round2(beforeRevenue)}`);
  console.log(`  After:  ${afterCount} orders / $${round2(afterRevenue)}`);
  const delta = round2(beforeRevenue - afterRevenue);
  const pct = beforeRevenue > 0 ? round2((delta / beforeRevenue) * 100) : 0;
  console.log(`  Removed: ${beforeCount - afterCount} order(s) / $${delta} (${pct}% of the recorded total)`);
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
