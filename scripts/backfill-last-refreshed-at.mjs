#!/usr/bin/env node
/**
 * Backfill `last_refreshed_at` onto posts whose body was replaced by a
 * queue-driven refresh.
 *
 * `lib/queue-apply.js`'s publishBlogRefresh — the path every flop-refresh,
 * quick-win, legacy-flop and low-ctr-meta item takes when queue-autoapply or the
 * dashboard's Approve button publishes it — replaced the live body and never
 * stamped the post. So agents/post-performance kept every verdict made BEFORE
 * the refresh: `all-natural-lotion` was refreshed on 2026-08-30 and was still
 * "Action Required" with its July "0 clicks" verdict three weeks later.
 * publishBlogRefresh stamps it now; this writes the stamp for the refreshes that
 * already happened, read off the queue items' own `published_at`.
 *
 * Only ever moves a stamp FORWARD — an existing later stamp (refresh-runner's)
 * is left alone. Writes through writePostMeta, which merges and routes the
 * server-owned field to state.json.
 *
 * Run on the SERVER: data/performance-queue/ and state.json live there.
 *
 * Usage:
 *   node scripts/backfill-last-refreshed-at.mjs          # DRY RUN — report only
 *   node scripts/backfill-last-refreshed-at.mjs --apply  # write the stamps
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getPostMeta, writePostMeta, ROOT } from '../lib/posts.js';
import { findPostMeta } from '../lib/queue-apply.js';
import { isDirectRun } from '../lib/is-direct-run.js';

/** The triggers publishBlogRefresh publishes — each one replaced the article body. */
export const BODY_REFRESH_TRIGGERS = new Set(['flop-refresh', 'quick-win', 'legacy-flop', 'low-ctr-meta']);

/**
 * Pure: which posts need a stamp, and what it should be.
 *
 * @param {object[]} items   queue items
 * @param {(slug:string) => {slug:string, meta:object}|null} resolve
 * @returns {{ stamps: Array<{slug, from, to, trigger}>, skipped: Array<{slug, why}> }}
 */
export function planStamps(items, resolve) {
  const latest = new Map();
  const skipped = [];
  for (const item of items) {
    if (!BODY_REFRESH_TRIGGERS.has(item?.trigger)) continue;
    if (item.status !== 'published' || !item.published_at) continue;
    if (Number.isNaN(new Date(item.published_at).getTime())) { skipped.push({ slug: item.slug, why: 'unparseable published_at' }); continue; }
    const found = resolve(item.slug);
    if (!found) { skipped.push({ slug: item.slug, why: 'no local post' }); continue; }
    const prev = latest.get(found.slug);
    if (!prev || item.published_at > prev.to) {
      latest.set(found.slug, { slug: found.slug, from: found.meta.last_refreshed_at || null, to: item.published_at, trigger: item.trigger });
    }
  }
  const stamps = [...latest.values()].filter((s) => !s.from || new Date(s.from).getTime() < new Date(s.to).getTime());
  return { stamps, skipped };
}

function loadQueueItems(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'indexing-submissions.json')) {
    try { out.push(JSON.parse(readFileSync(join(dir, f), 'utf8'))); } catch { /* unreadable item: not a refresh we can date */ }
  }
  return out;
}

function main() {
  const apply = process.argv.includes('--apply');
  const items = loadQueueItems(join(ROOT, 'data', 'performance-queue'));
  const resolve = (slug) => {
    const found = findPostMeta(slug);
    if (!found) return null;
    const postSlug = found.meta.slug || slug;
    return { slug: postSlug, meta: getPostMeta(postSlug) || found.meta };
  };
  const { stamps, skipped } = planStamps(items, resolve);

  console.log(`\nBackfill last_refreshed_at — ${apply ? 'APPLY' : 'DRY RUN'}\n`);
  console.log(`  Queue items read: ${items.length}`);
  for (const s of stamps) {
    console.log(`  ${apply ? 'stamp' : 'would stamp'} ${s.slug}: ${s.from || '(none)'} → ${s.to}  [${s.trigger}]`);
    if (apply) writePostMeta(s.slug, { last_refreshed_at: s.to });
  }
  for (const s of skipped) console.log(`  skip ${s.slug}: ${s.why}`);
  console.log(`\n  ${stamps.length} post(s) ${apply ? 'stamped' : 'to stamp'}, ${skipped.length} skipped.`);
  if (!apply && stamps.length) console.log('  Re-run with --apply to write.');
}

if (isDirectRun(import.meta.url)) main();
