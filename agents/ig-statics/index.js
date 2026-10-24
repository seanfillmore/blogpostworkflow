#!/usr/bin/env node
/**
 * IG Statics: posts finished static ads to @realskincare_com as feed images, one
 * a day, alongside the UGC Reels (agents/ugc-reels posts three Reels a day).
 *
 * Each --apply run:
 *   1. refreshes insights for earlier statics that are due a read;
 *   2. reads the account's recent captions so nothing posts twice even if the
 *      ledger is lost;
 *   3. picks the next item in config/ig-statics.json (queue order, each ONCE)
 *      whose caption passes the claim gate (lib/ig-statics.js);
 *   4. publishes it and records it in data/ugc-reels/statics-ledger.json.
 *
 * Usage:
 *   node agents/ig-statics/index.js              # dry run: say what would post
 *   node agents/ig-statics/index.js --apply      # post one image (cron)
 *   node agents/ig-statics/index.js --report     # insights per posted static
 *
 * Cron: DAILY_IG_STATICS (18:20 UTC, between the 16:20 and 20:20 Reels) in
 * scripts/setup-cron.sh. Requires META_USER_ACCESS_TOKEN (the system-user
 * token, the only one with instagram_content_publish).
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { notify } from '../../lib/notify.js';
import { publishImage, getImageInsights, recentCaptions } from '../../lib/instagram-reels.js';
import { pickNextStatic, insightsDueStatics, renderStaticsTable } from '../../lib/ig-statics.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const QUEUE_PATH = join(ROOT, 'config', 'ig-statics.json');
export const LEDGER_PATH = join(ROOT, 'data', 'ugc-reels', 'statics-ledger.json');

function loadEnv(root = ROOT) {
  try {
    const env = {};
    for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf('=');
      if (idx === -1) continue;
      env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    }
    return env;
  } catch { return {}; }
}

/** A queue that exists but will not parse throws: guessing at it could post the wrong thing. */
export function readQueue(path = QUEUE_PATH) {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8')).items || [];
}

/** Missing = fresh start (the recent-captions check still stops a repost). Unreadable throws. */
export function readLedger(path = LEDGER_PATH) {
  if (!existsSync(path)) return { posts: [], failures: [] };
  const l = JSON.parse(readFileSync(path, 'utf8'));
  return { posts: l.posts || [], failures: l.failures || [] };
}

export function writeLedger(ledger, path = LEDGER_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(ledger, null, 2) + '\n');
  renameSync(tmp, path);
}

export async function runOnce({
  apply = false,
  token,
  fetchImpl = fetch,
  publish = publishImage,
  insightsFn = getImageInsights,
  captionsFn = recentCaptions,
  queue = readQueue(),
  ledgerPath = LEDGER_PATH,
  now = Date.now(),
  log = console.log,
} = {}) {
  const ledger = readLedger(ledgerPath);
  let insightsRead = 0;
  if (apply) {
    for (const p of insightsDueStatics(ledger, now)) {
      try {
        p.insights = await insightsFn(p.media_id, { token, fetchImpl });
        p.insights_at = new Date(now).toISOString();
        if (now - Date.parse(p.posted_at) >= 30 * 86_400_000) p.insights_final = true;
        insightsRead++;
      } catch (err) { log(`  insights unavailable for ${p.media_id}: ${err.message}`); }
    }
    if (insightsRead) writeLedger(ledger, ledgerPath);
  }

  // Unreadable recent captions = do not post: the check is what stops a double post.
  const recent = await captionsFn({}, { token, fetchImpl });
  const pick = pickNextStatic(queue, ledger, recent);
  if (!pick.item) return { posted: null, ...pick, insightsRead };
  const item = pick.item;
  if (!apply) return { posted: { ...item, dryRun: true }, ...pick, insightsRead };

  try {
    const r = await publish({ imageUrl: item.image_url, caption: item.caption }, { token, fetchImpl });
    const entry = {
      id: item.id,
      batch: item.batch || null,
      product: item.product || null,
      caption: item.caption,
      image_url: item.image_url,
      posted_at: new Date(now).toISOString(),
      media_id: r.mediaId,
      permalink: r.permalink,
    };
    ledger.posts.push(entry);
    writeLedger(ledger, ledgerPath);
    return { posted: entry, ...pick, remaining: pick.remaining - 1, insightsRead };
  } catch (err) {
    ledger.failures.push({ id: item.id, at: new Date(now).toISOString(), error: err.message });
    writeLedger(ledger, ledgerPath);
    return { posted: null, error: err.message, failedItem: item, ...pick, insightsRead };
  }
}

export function renderRun(run) {
  const lines = [];
  if (run.posted) {
    lines.push(`${run.posted.dryRun ? 'Would post' : 'Posted'}: ${run.posted.id}`);
    if (run.posted.permalink) lines.push(run.posted.permalink);
    lines.push('', run.posted.caption, '');
  } else if (run.error) {
    lines.push(`Publish failed for ${run.failedItem.id}: ${run.error}`);
  } else {
    lines.push(`Nothing posted: ${run.reason}`);
  }
  lines.push(`${run.remaining} static(s) left in the queue.`);
  for (const s of run.skipped || []) lines.push(`  - skipped ${s.item.id}: ${s.reason}`);
  if (run.insightsRead) lines.push(`Insights refreshed for ${run.insightsRead} post(s).`);
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const env = loadEnv();
  const token = env.META_USER_ACCESS_TOKEN || process.env.META_USER_ACCESS_TOKEN;

  if (args.includes('--report')) {
    const ledger = readLedger();
    console.log(`${ledger.posts.length} static(s) posted.\n\n${renderStaticsTable(ledger)}`);
    return;
  }
  if (!token) throw new Error('META_USER_ACCESS_TOKEN is not in .env');

  const apply = args.includes('--apply');
  console.log(`IG Statics${apply ? '' : ' (dry run)'}`);
  const run = await runOnce({ apply, token });
  const body = renderRun(run);
  console.log(`\n${body}`);
  if (!apply) return;

  if (run.error) {
    await notify({ subject: `Instagram static failed to publish: ${run.failedItem.id}`, body, status: 'error', category: 'social' });
    return;
  }
  const subject = run.posted
    ? `Instagram static posted: ${run.posted.id} (${run.remaining} left)`
    : 'Instagram statics: nothing to post';
  await notify({ subject, body, status: 'info', category: 'social' });
}

if (isDirectRun(import.meta.url)) {
  main().catch(async (err) => {
    console.error(err);
    try {
      await notify({ subject: 'Instagram statics failed', body: String(err?.stack || err), status: 'error', category: 'social' });
    } catch { /* the console already has it */ }
    process.exit(1);
  });
}
