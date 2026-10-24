#!/usr/bin/env node
/**
 * One-time migration: the 8 statics agents/ig-statics queued (config/ig-statics.json,
 * PR #1110, now scripts/social-queue-migrate-ig-statics.json) become APPROVED
 * Social-queue items, in the same posting order, so agents/social-poster posts them
 * to Instagram AND the Facebook Page.
 *
 *   node scripts/social-queue-migrate.mjs            # dry run: what it would write
 *   node scripts/social-queue-migrate.mjs --apply    # write data/social-queue/items/
 *
 * Run ON THE SERVER: the queue and the old ledger (data/ugc-reels/statics-ledger.json)
 * both live there. Every post the old ledger records is carried over as
 * Instagram-posted (media id, permalink, insights), and its failures as Instagram
 * failures, so nothing reposts on Instagram; those items still post to Facebook.
 * Idempotent: an item already in the queue is not recreated, but an Instagram post
 * the ledger has and the item lacks is still filled in.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../lib/is-direct-run.js';
import { ITEMS_DIR, newItem, readItem, saveItem, approveItem } from '../lib/social-queue.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE = join(ROOT, 'scripts', 'social-queue-migrate-ig-statics.json');
export const LEDGER = join(ROOT, 'data', 'ugc-reels', 'statics-ledger.json');

/** Pure: the writes the migration would make, given the source, the ledger and what exists. */
export function planMigration({ items, ledger = { posts: [], failures: [] }, existing = {}, now = Date.now() }) {
  const posts = new Map((ledger.posts || []).map((p) => [p.id, p]));
  const out = [];
  items.forEach((src, i) => {
    const post = posts.get(src.id);
    const igState = post ? {
      media_id: post.media_id || null, permalink: post.permalink || null, posted_at: post.posted_at,
      ...(post.insights ? { insights: post.insights, insights_at: post.insights_at || null } : {}),
      ...(post.insights_final ? { insights_final: true } : {}),
      migrated_from: 'ig-statics ledger',
    } : null;
    const failures = (ledger.failures || []).filter((f) => f.id === src.id).map((f) => ({ platform: 'instagram', at: f.at, error: f.error }));
    const cur = existing[src.id];
    if (cur) {
      if (igState && !cur.instagram?.posted_at) out.push({ id: src.id, action: 'fill-instagram', item: { ...cur, instagram: igState } });
      else out.push({ id: src.id, action: 'exists' });
      return;
    }
    // approved_at one second apart keeps the original queue order as posting order.
    const at = now + i * 1000;
    let item = newItem({ ...src, suggested_caption: src.caption, caption: src.caption }, { now: at });
    item = approveItem(item, { now: at });
    item.migrated_from = 'config/ig-statics.json';
    if (igState) item.instagram = igState;
    if (failures.length) item.failures = failures;
    out.push({ id: src.id, action: 'create', item });
  });
  return out;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const dir = join(ROOT, ITEMS_DIR);
  const { items } = JSON.parse(readFileSync(SOURCE, 'utf8'));
  const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : { posts: [], failures: [] };
  const existing = Object.fromEntries(items.map((i) => [i.id, readItem(dir, i.id)]).filter(([, v]) => v));
  console.log(`Social-queue migration${apply ? '' : ' (dry run)'}: ${items.length} item(s); old ledger ${existsSync(LEDGER) ? `has ${(ledger.posts || []).length} post(s)` : 'absent (nothing posted yet)'}`);
  for (const w of planMigration({ items, ledger, existing })) {
    const ig = w.item?.instagram?.posted_at ? ` (already on Instagram ${w.item.instagram.posted_at.slice(0, 10)}, will post to Facebook)` : '';
    console.log(`  ${w.action.padEnd(14)} ${w.id}${ig}`);
    if (apply && w.item) saveItem(dir, w.item);
  }
  if (!apply) console.log('\nApply with --apply.');
}

if (isDirectRun(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
