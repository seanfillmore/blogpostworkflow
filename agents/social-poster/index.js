#!/usr/bin/env node
/**
 * Social poster: posts APPROVED Social-queue items (lib/social-queue.js) to
 * Instagram (@realskincare_com) AND the Facebook Page "Real Skin Care"
 * (113847674946808). Replaces agents/ig-statics (2026-10-24), whose fixed
 * config/ig-statics.json queue was migrated into the Social queue as approved.
 *
 * Approval happens in the dashboard's Social tab; nothing posts without it.
 *
 * Each --apply run:
 *   1. refreshes insights for posted items that are due a read (IG + FB);
 *   2. reads both accounts' recent captions, so nothing posts twice even if an
 *      item's record is lost (a caption found live is recorded `detected`);
 *   3. RETRY: finishes at most one item that posted on one platform and still
 *      owes the other (never counted against posts_per_day);
 *   4. FRESH: posts the next approved item that has posted nowhere, rotating
 *      between products (nextInRotation in lib/social-queue.js), unless
 *      posts_per_day items already started today (UTC);
 *   5. records each platform's result on the item the moment it lands.
 * A platform that fails is retried next run, alone; after two failures it is
 * skipped for that item and reported.
 *
 * Usage:
 *   node agents/social-poster/index.js              # dry run: say what would post
 *   node agents/social-poster/index.js --apply      # post (cron)
 *   node agents/social-poster/index.js --report     # what posted, with insights
 *
 * Cron: DAILY_SOCIAL_POSTER (18:20, 22:20 and 03:20 UTC) in scripts/setup-cron.sh; config in
 * config/social-queue.json. Requires META_USER_ACCESS_TOKEN (system user: holds
 * instagram_content_publish and pages_manage_posts).
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { notify } from '../../lib/notify.js';
import { publishImage, getImageInsights, recentCaptions } from '../../lib/instagram-reels.js';
import { getPageToken, publishPagePhoto, recentPageMessages, getPagePostInsights } from '../../lib/facebook-page.js';
import {
  ITEMS_DIR, PLATFORMS, loadItems, updateItem, planRun, insightsDue, alreadyPosted, isPosted,
} from '../../lib/social-queue.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONFIG_PATH = join(ROOT, 'config', 'social-queue.json');
export const DIR = join(ROOT, ITEMS_DIR);

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

export function readConfig(path = CONFIG_PATH) {
  const c = JSON.parse(readFileSync(path, 'utf8'));
  const platforms = (c.platforms || PLATFORMS).filter((p) => PLATFORMS.includes(p));
  return {
    postsPerDay: Number.isInteger(c.posts_per_day) && c.posts_per_day >= 0 ? c.posts_per_day : 1,
    platforms: platforms.length ? platforms : [...PLATFORMS],
    igUserId: c.instagram_user_id,
    pageId: c.facebook_page_id,
  };
}

/** The real platform calls, bound to one token set. Tests replace the whole object. */
export function liveClients({ userToken, igUserId, pageId, fetchImpl = fetch }) {
  let pageToken = null;
  const page = async () => (pageToken ||= await getPageToken({ pageId, userToken, fetchImpl }));
  return {
    instagram: {
      recent: () => recentCaptions({ igUserId }, { token: userToken, fetchImpl }),
      publish: async ({ imageUrl, caption }) => {
        const r = await publishImage({ igUserId, imageUrl, caption }, { token: userToken, fetchImpl });
        return { media_id: r.mediaId, permalink: r.permalink };
      },
      insights: (id) => getImageInsights(id, { token: userToken, fetchImpl }),
    },
    facebook: {
      recent: async () => recentPageMessages({ pageId }, { token: await page(), fetchImpl }),
      publish: async ({ imageUrl, caption }) => {
        const r = await publishPagePhoto({ pageId, imageUrl, caption }, { token: await page(), fetchImpl });
        return { post_id: r.postId, photo_id: r.photoId, permalink: r.permalink };
      },
      insights: async (id) => getPagePostInsights(id, { token: await page(), fetchImpl }),
    },
  };
}

async function refreshInsights({ dir, clients, now, log }) {
  let read = 0;
  for (const due of insightsDue(loadItems(dir), now)) {
    try {
      const insights = await clients[due.platform].insights(due.remoteId);
      updateItem(dir, due.id, (cur) => ({
        ...cur,
        [due.platform]: { ...cur[due.platform], insights, insights_at: new Date(now).toISOString(), ...(due.final ? { insights_final: true } : {}) },
      }));
      read++;
    } catch (err) { log(`  ${due.platform} insights unavailable for ${due.id}: ${err.message}`); }
  }
  return read;
}

/**
 * Post one item to the platforms it still owes. Each platform's outcome is written
 * on the item as soon as it lands, so a crash after Instagram cannot repost there.
 */
async function postItem({ dir, plan, clients, recent, apply, now, log }) {
  const { item } = plan;
  const results = [];
  for (const platform of plan.platforms) {
    if (recent[platform] === undefined) {
      results.push({ platform, outcome: 'unchecked', error: recent.errors[platform] });
      continue;
    }
    if (alreadyPosted(item.caption, recent[platform])) {
      results.push({ platform, outcome: 'detected' });
      if (apply) {
        updateItem(dir, item.id, (cur) => (isPosted(cur, platform) ? cur : {
          ...cur, [platform]: { posted_at: new Date(now).toISOString(), detected: true, note: 'caption was already live on the account; not posted again' },
        }));
      }
      continue;
    }
    if (!apply) { results.push({ platform, outcome: 'would-post' }); continue; }
    try {
      const r = await clients[platform].publish({ imageUrl: item.image_url, caption: item.caption });
      updateItem(dir, item.id, (cur) => ({ ...cur, [platform]: { ...r, posted_at: new Date(now).toISOString() } }));
      results.push({ platform, outcome: 'posted', permalink: r.permalink || null });
    } catch (err) {
      updateItem(dir, item.id, (cur) => ({ ...cur, failures: [...(cur.failures || []), { platform, at: new Date(now).toISOString(), error: err.message }] }));
      results.push({ platform, outcome: 'failed', error: err.message });
      log(`  ${platform} publish failed for ${item.id}: ${err.message}`);
    }
  }
  return { id: item.id, caption: item.caption, image_url: item.image_url, results };
}

export async function runOnce({
  apply = false,
  dir = DIR,
  clients,
  config = readConfig(),
  now = Date.now(),
  log = console.log,
} = {}) {
  const insightsRead = apply ? await refreshInsights({ dir, clients, now, log }) : 0;
  const items = loadItems(dir);
  const plan = planRun(items, { postsPerDay: config.postsPerDay, platforms: config.platforms, now });
  const posts = [];
  if (plan.retry || plan.fresh) {
    // Unreadable recent captions on a platform = do not post THERE this run: that
    // check is what stops a double post. The other platform still goes ahead.
    const recent = { errors: {} };
    for (const p of config.platforms) {
      try { recent[p] = await clients[p].recent(); } catch (err) { recent.errors[p] = `recent posts unreadable: ${err.message}`; }
    }
    for (const which of ['retry', 'fresh']) {
      if (!plan[which]) continue;
      posts.push({ kind: which, ...(await postItem({ dir, plan: plan[which], clients, recent, apply, now, log })) });
    }
  }
  const after = apply ? loadItems(dir) : items;
  const remaining = after.filter((i) => i.status === 'approved' && config.platforms.some((p) => !isPosted(i, p))).length;
  return { apply, posts, skipped: plan.skipped, reason: plan.reason, remaining, insightsRead };
}

export function renderRun(run) {
  const lines = [];
  for (const p of run.posts) {
    lines.push(`${p.kind === 'retry' ? 'Finishing' : 'New'}: ${p.id}`);
    for (const r of p.results) {
      const label = { 'would-post': 'would post', posted: 'posted', failed: 'FAILED', detected: 'already live there, not posted again', unchecked: 'not attempted' }[r.outcome];
      lines.push(`  ${r.platform}: ${label}${r.permalink ? ` ${r.permalink}` : ''}${r.error ? ` (${r.error})` : ''}`);
    }
    lines.push(`  image: ${p.image_url}`, '', p.caption.split('\n').map((l) => `    ${l}`).join('\n'), '');
  }
  if (!run.posts.length) lines.push(`Nothing posted: ${run.reason}`);
  else if (run.reason) lines.push(`No new item: ${run.reason}`);
  lines.push(`${run.remaining} approved item(s) still owe a post.`);
  for (const s of run.skipped || []) lines.push(`  - skipped ${s.id}${s.platform ? ` on ${s.platform}` : ''}: ${s.reason}`);
  if (run.insightsRead) lines.push(`Insights refreshed for ${run.insightsRead} post(s).`);
  return lines.join('\n');
}

export function renderReport(items) {
  const posted = items.filter((i) => PLATFORMS.some((p) => isPosted(i, p)))
    .sort((a, b) => String(a.instagram?.posted_at || a.facebook?.posted_at).localeCompare(String(b.instagram?.posted_at || b.facebook?.posted_at)));
  if (!posted.length) return 'Nothing posted yet.';
  return posted.map((i) => {
    const ig = i.instagram?.insights || {};
    const fb = i.facebook?.insights || {};
    return `- ${i.id}\n    IG ${i.instagram?.posted_at?.slice(0, 10) || 'not posted'}: views ${ig.views ?? '?'}, reach ${ig.reach ?? '?'}, likes ${ig.likes ?? '?'}, saves ${ig.saved ?? '?'}${i.instagram?.permalink ? ` ${i.instagram.permalink}` : ''}` +
      `\n    FB ${i.facebook?.posted_at?.slice(0, 10) || 'not posted'}: views ${fb.media_views ?? '?'}, reactions ${fb.reactions ?? '?'}, comments ${fb.comments ?? '?'}, shares ${fb.shares ?? '?'}${i.facebook?.permalink ? ` ${i.facebook.permalink}` : ''}`;
  }).join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--report')) {
    const items = loadItems(DIR);
    console.log(`${items.length} item(s) in the Social queue.\n\n${renderReport(items)}`);
    return;
  }
  const env = loadEnv();
  const userToken = env.META_USER_ACCESS_TOKEN || process.env.META_USER_ACCESS_TOKEN;
  if (!userToken) throw new Error('META_USER_ACCESS_TOKEN is not in .env');
  const config = readConfig();
  const apply = args.includes('--apply');
  console.log(`Social poster${apply ? '' : ' (dry run)'}: ${config.platforms.join(' + ')}, ${config.postsPerDay}/day`);
  const clients = liveClients({ userToken, igUserId: config.igUserId, pageId: config.pageId });
  const run = await runOnce({ apply, clients, config });
  const body = renderRun(run);
  console.log(`\n${body}`);
  if (!apply) return;

  const outcomes = run.posts.flatMap((p) => p.results);
  const posted = outcomes.filter((r) => r.outcome === 'posted').map((r) => r.platform);
  const failed = outcomes.filter((r) => r.outcome === 'failed').map((r) => r.platform);
  const subject = run.posts.length
    ? `Social: ${run.posts.map((p) => p.id).join(', ')}${posted.length ? ` posted to ${posted.join(' + ')}` : ''}${failed.length ? `, FAILED on ${failed.join(' + ')} (retries next run)` : ''} (${run.remaining} left)`
    : `Social: nothing posted (${run.remaining} approved waiting)`;
  // A platform refusing one post is reported, not an agent failure: the item
  // retries next run and the crash handler below keeps 'error' for real breakage.
  await notify({ subject, body, status: 'info', category: 'social' });
}

if (isDirectRun(import.meta.url)) {
  main().catch(async (err) => {
    console.error(err);
    try {
      await notify({ subject: 'Social poster failed', body: String(err?.stack || err), status: 'error', category: 'social' });
    } catch { /* the console already has it */ }
    process.exit(1);
  });
}
