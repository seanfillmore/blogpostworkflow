/**
 * Policy for posting finished static ads (agents/ad-batch output) to
 * @realskincare_com as feed images, alongside the UGC Reels (agents/ugc-reels).
 * Pure: no I/O.
 *
 * Sean, 2026-10-23: "The creatives in <ad batch> need to be scheduled to post to
 * Instagram along with the UGC videos."
 *
 * THE QUEUE is config/ig-statics.json, tracked in git: each item is one image
 * already hosted on Shopify Files (a public JPEG, which is what Instagram needs)
 * with a caption written by hand from that batch's approved Meta copy. Captions
 * are authored, not generated: the copy already exists, was reviewed for the ad,
 * and a model adds nothing but risk. Every caption is still re-checked here, on
 * the same COMMERCIAL claim gate as product copy, before it can post.
 *
 * ORDER. Queue order, each item ONCE. Unlike the Reels there is no recycling: a
 * static with its headline baked in reads as a repeat on a grid. When the queue
 * is empty the agent posts nothing and says so; a new batch is added with
 * scripts/ig-statics-add.mjs.
 *
 * NO DOUBLE POSTS. An item is "posted" when the ledger says so OR when its
 * caption already appears on one of the account's recent posts. The second check
 * means a lost ledger cannot repost the whole queue.
 */

import { checkSeoCopyFields, COMMERCIAL_SURFACE } from './seo-copy-health-gate.js';

export const MAX_CAPTION_CHARS = 2200;
export const REQUIRED_HASHTAG = '#realskincare';
export const MAX_PUBLISH_FAILURES = 2;

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Problems with one caption; an empty list means it may post. */
export function captionProblems(caption) {
  const c = String(caption || '');
  const out = [];
  if (!c.trim()) return ['empty caption'];
  if (c.length > MAX_CAPTION_CHARS) out.push(`over ${MAX_CAPTION_CHARS} characters`);
  if (/[–—]/.test(c)) out.push('contains an em or en dash');
  if (/https?:\/\//i.test(c)) out.push('contains a link (Instagram captions do not link; say "link in bio")');
  if (!c.toLowerCase().includes(REQUIRED_HASHTAG)) out.push(`missing ${REQUIRED_HASHTAG}`);
  if (!/link in (our )?bio/i.test(c)) out.push('no "link in bio" call to action');
  const { blocking } = checkSeoCopyFields({ caption: c }, { surface: COMMERCIAL_SURFACE });
  for (const b of blocking) out.push(`claim: "${b.match}" (${b.category})`);
  return out;
}

/** True when this caption is already live on the account (whitespace and case ignored). */
export function alreadyOnAccount(caption, recent = []) {
  const want = norm(caption);
  return recent.some((r) => norm(r) === want);
}

/**
 * The next item to post, or { item: null, reason }. Items that fail the caption
 * check or have failed to publish MAX_PUBLISH_FAILURES times are reported in
 * `skipped` and passed over, so one bad item cannot stall the queue.
 */
export function pickNextStatic(queue = [], ledger = {}, recent = []) {
  const posted = new Set((ledger.posts || []).map((p) => p.id));
  const failures = {};
  for (const f of ledger.failures || []) failures[f.id] = (failures[f.id] || 0) + 1;
  const skipped = [];
  let remaining = 0;
  let item = null;
  for (const q of queue) {
    if (posted.has(q.id)) continue;
    if (alreadyOnAccount(q.caption, recent)) { skipped.push({ item: q, reason: 'caption already live on the account (ledger missed it)', live: true }); continue; }
    const problems = captionProblems(q.caption);
    if (!q.image_url) problems.push('no image_url');
    if ((failures[q.id] || 0) >= MAX_PUBLISH_FAILURES) problems.push(`failed to publish ${failures[q.id]} times`);
    if (problems.length) { skipped.push({ item: q, reason: problems.join('; ') }); continue; }
    remaining++;
    if (!item) item = q;
  }
  return { item, remaining, skipped, reason: item ? null : 'queue is empty: every static has posted (add a batch with scripts/ig-statics-add.mjs)' };
}

/** Insights are read from 24 h after posting, then refreshed daily until 30 days. */
export function insightsDueStatics(ledger = {}, now = Date.now()) {
  const H = 3_600_000;
  return (ledger.posts || []).filter((p) => {
    if (!p.media_id || p.insights_final) return false;
    const age = now - Date.parse(p.posted_at);
    if (age < 24 * H) return false;
    return !p.insights_at || now - Date.parse(p.insights_at) >= 20 * H;
  });
}

export function renderStaticsTable(ledger = {}) {
  const rows = (ledger.posts || []).map((p) => {
    const i = p.insights || {};
    return `- ${p.posted_at.slice(0, 10)} ${p.id}: views ${i.views ?? '?'}, reach ${i.reach ?? '?'}, likes ${i.likes ?? '?'}, saves ${i.saved ?? '?'}, shares ${i.shares ?? '?'}${p.permalink ? ` ${p.permalink}` : ''}`;
  });
  return rows.length ? rows.join('\n') : 'No statics posted yet.';
}
