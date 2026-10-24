/**
 * The Social queue: approved ad images that post to Instagram (@realskincare_com)
 * AND the Facebook Page "Real Skin Care" (113847674946808).
 *
 * Sean, 2026-10-24: approved ads land in a queue and post to our socials; approval
 * is an Approve button in the dashboard's Social tab, and every approved image
 * posts to BOTH platforms.
 *
 *   pending   created by the ingest (scripts/social-queue-ingest.mjs, run from
 *             agents/ad-batch at the end of a batch) with a suggested caption
 *   approved  Sean pressed Approve; agents/social-poster posts these, rotating
 *             between products (2026-10-24: three a day, "rotate between the
 *             products"); within a product, an item with a post_by date goes
 *             first, then oldest approved_at
 *   rejected  never posts
 *
 * One JSON file per item under data/social-queue/items/<id>.json, server-owned and
 * gitignored (backed up offsite with the ugc-reels set). Writes are temp-file +
 * rename, so a reader can never see half a file, and the poster re-reads an item
 * just before it records a post so a caption edit made meanwhile is not lost.
 *
 * Per-platform posting state lives on the item: `instagram: {media_id, permalink,
 * posted_at, ...}` and `facebook: {post_id, photo_id, permalink, posted_at, ...}`.
 * A platform that fails is retried on the next run, alone; after
 * MAX_PLATFORM_FAILURES failures that platform is skipped for the item and reported.
 *
 * The caption gate is captionProblems() here (moved from lib/ig-statics.js, not
 * copied): the COMMERCIAL claim surface of lib/seo-copy-health-gate.js plus the
 * Instagram house rules. An item cannot be approved while its caption fails it.
 */

import * as nodeFs from 'node:fs';
import { join } from 'node:path';
import { checkSeoCopyFields, COMMERCIAL_SURFACE } from './seo-copy-health-gate.js';

export const ITEMS_DIR = 'data/social-queue/items';
export const PLATFORMS = Object.freeze(['instagram', 'facebook']);
export const STATUSES = Object.freeze(['pending', 'approved', 'rejected']);
export const MAX_PLATFORM_FAILURES = 2;
export const MAX_CAPTION_CHARS = 2200;
export const REQUIRED_HASHTAG = '#realskincare';
/** Item ids: lower-case slug. Checked before any file access, so ids are safe in paths. */
export const ID_RE = /^[a-z0-9][a-z0-9-]{2,119}$/;

const iso = (ms) => new Date(ms).toISOString();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// ── the caption gate ─────────────────────────────────────────────────────────

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

/** True when this caption is already live (whitespace and case ignored). */
export function alreadyPosted(caption, recent = []) {
  const want = norm(caption);
  return !!want && recent.some((r) => norm(r) === want);
}

/** Dashes become a comma or a hyphen-free space; used on human edits and model output. */
export function stripDashes(s) {
  return String(s || '').replace(/\s*[–—]\s*/g, ', ').replace(/ ,/g, ',');
}

// ── item lifecycle (pure) ────────────────────────────────────────────────────

const STR_FIELDS = ['batch', 'product', 'headline', 'subhead', 'scene', 'source', 'suggested_caption', 'suggested_caption_reason'];

/**
 * A new PENDING item. `image_url` must be a public https JPEG (Shopify Files).
 * `source` is "<batch dir name>/<concept dir>/<file>", the key the ingest dedupes on.
 */
export function newItem(fields, { now = Date.now() } = {}) {
  const f = fields || {};
  if (!ID_RE.test(String(f.id || ''))) throw new Error('item needs a slug id');
  if (!/^https:\/\/cdn\.shopify\.com\//.test(String(f.image_url || ''))) throw new Error('item needs a cdn.shopify.com image_url');
  const item = { id: f.id };
  for (const k of STR_FIELDS) item[k] = typeof f[k] === 'string' ? f[k].slice(0, 4000) : null;
  item.image_url = f.image_url;
  item.shopify_file_id = typeof f.shopify_file_id === 'string' ? f.shopify_file_id : null;
  item.suggested_caption = item.suggested_caption ? stripDashes(item.suggested_caption) : '';
  item.caption = typeof f.caption === 'string' && f.caption.trim() ? stripDashes(f.caption) : item.suggested_caption;
  // A seasonal item (a Halloween post) carries the last UTC day it may post. It
  // jumps its product's line, and once the date has passed it is skipped, never posted.
  item.post_by = typeof f.post_by === 'string' && DATE_RE.test(f.post_by) ? f.post_by : null;
  item.needs_human_review = f.needs_human_review === true;
  item.review_notes = Array.isArray(f.review_notes) ? f.review_notes.map(String).slice(0, 10) : [];
  item.status = 'pending';
  item.created_at = iso(now);
  item.approved_at = null;
  item.rejected_at = null;
  item.instagram = null;
  item.facebook = null;
  item.failures = [];
  return item;
}

export const isPosted = (item, platform) => !!item?.[platform]?.posted_at;
export const postedAnywhere = (item) => PLATFORMS.some((p) => isPosted(item, p));
export const fullyPosted = (item, platforms = PLATFORMS) => platforms.every((p) => isPosted(item, p));
export const failureCount = (item, platform) => (item?.failures || []).filter((f) => f.platform === platform).length;

export function editCaption(item, caption) {
  if (postedAnywhere(item)) throw new Error('cannot edit a caption that has already posted');
  if (item.status === 'rejected') throw new Error('cannot edit a rejected item');
  if (typeof caption !== 'string') throw new Error('caption must be text');
  const next = { ...item, caption: stripDashes(caption), edited: true };
  // An approved item that no longer passes goes back to pending so it cannot post.
  if (next.status === 'approved' && captionProblems(next.caption).length) {
    next.status = 'pending';
    next.approved_at = null;
  }
  return next;
}

export function approveItem(item, { now = Date.now() } = {}) {
  if (item.status !== 'pending') throw new Error(`item is ${item.status}, not pending`);
  const problems = captionProblems(item.caption);
  if (problems.length) { const e = new Error('caption fails the gate'); e.problems = problems; throw e; }
  return { ...item, status: 'approved', approved_at: iso(now), rejected_at: null };
}

export function unapproveItem(item) {
  if (item.status !== 'approved') throw new Error(`item is ${item.status}, not approved`);
  if (postedAnywhere(item)) throw new Error('cannot un-approve an item that has already posted');
  return { ...item, status: 'pending', approved_at: null };
}

export function rejectItem(item, { now = Date.now(), reason = '' } = {}) {
  if (item.status === 'rejected') throw new Error('item is already rejected');
  if (postedAnywhere(item)) throw new Error('cannot reject an item that has already posted');
  return { ...item, status: 'rejected', rejected_at: iso(now), rejected_reason: String(reason || '').slice(0, 500), approved_at: null };
}

/** Approved items in the order they post: oldest approved_at first, then id. */
export function postingOrder(items = []) {
  return items.filter((i) => i.status === 'approved')
    .sort((a, b) => String(a.approved_at).localeCompare(String(b.approved_at)) || a.id.localeCompare(b.id));
}

/**
 * What this run should post. Two phases, so a platform retry never costs the
 * queue a day:
 *   retry  the oldest approved item that posted on one platform and still owes
 *          the other (at most one per run, never counted against posts_per_day);
 *   fresh  the next approved item that has posted nowhere, chosen by
 *          nextInRotation() (rotating products), if fewer than `postsPerDay`
 *          items started posting on this UTC day. An item past its post_by
 *          date is skipped and reported, never posted.
 * A platform that has failed MAX_PLATFORM_FAILURES times is dropped from the
 * item's plan and reported in `skipped`; an item whose caption no longer passes
 * the gate is skipped whole.
 * Returns { retry: {item, platforms}|null, fresh: {item, platforms}|null, skipped, waiting, reason }.
 */
export function planRun(items = [], { postsPerDay = 1, platforms = PLATFORMS, now = Date.now() } = {}) {
  const today = iso(now).slice(0, 10);
  const skipped = [];
  let retry = null;
  let fresh = null;
  let waiting = 0;
  // A platform state marked `detected` was found already live, not posted by us,
  // so it does not use up the day's quota.
  const startedToday = items.filter((i) => {
    const first = platforms.filter((p) => !i[p]?.detected).map((p) => i[p]?.posted_at).filter(Boolean).sort()[0];
    return first && first.slice(0, 10) === today;
  }).length;

  const candidates = [];
  for (const item of postingOrder(items)) {
    const owed = platforms.filter((p) => !isPosted(item, p));
    if (!owed.length) continue;
    const live = owed.filter((p) => {
      if (failureCount(item, p) >= MAX_PLATFORM_FAILURES) {
        skipped.push({ id: item.id, platform: p, reason: `failed to post to ${p} ${failureCount(item, p)} times` });
        return false;
      }
      return true;
    });
    if (!live.length) continue;
    const problems = captionProblems(item.caption);
    if (!/^https:\/\//.test(String(item.image_url || ''))) problems.push('no image_url');
    if (problems.length) { skipped.push({ id: item.id, platform: null, reason: problems.join('; ') }); continue; }
    const partial = postedAnywhere(item);
    if (partial) {
      if (!retry) retry = { item, platforms: live };
      continue;
    }
    if (item.post_by && item.post_by < today) {
      skipped.push({ id: item.id, platform: null, reason: `past its post-by date ${item.post_by}` });
      continue;
    }
    waiting++;
    candidates.push({ item, platforms: live });
  }
  fresh = nextInRotation(candidates, items);

  let reason = null;
  if (fresh && startedToday >= postsPerDay) {
    reason = `already started ${startedToday} post(s) today (posts_per_day ${postsPerDay})`;
    fresh = null;
  }
  if (!fresh && !retry && !reason) reason = 'nothing approved is waiting to post (approve items in the dashboard Social tab)';
  return { retry, fresh, skipped, waiting, startedToday, reason };
}

const lastPostedAt = (item) => PLATFORMS.map((p) => item?.[p]?.posted_at).filter(Boolean).sort().pop() || '';

/**
 * The next fresh post: the product posted LEAST recently goes next (a product that
 * has never posted first), so a run of one product's images cannot take every slot.
 * Within that product, an item with a post_by date goes first (soonest date first),
 * then the oldest approval. Items with no product rotate as one group.
 */
export function nextInRotation(candidates = [], items = []) {
  if (!candidates.length) return null;
  const key = (i) => i.product || '';
  const last = new Map();
  for (const i of items) {
    const at = lastPostedAt(i);
    if (at && at > (last.get(key(i)) || '')) last.set(key(i), at);
  }
  const within = (a, b) => (a.item.post_by ? 0 : 1) - (b.item.post_by ? 0 : 1)
    || String(a.item.post_by || '').localeCompare(String(b.item.post_by || ''))
    || String(a.item.approved_at).localeCompare(String(b.item.approved_at))
    || a.item.id.localeCompare(b.item.id);
  const byProduct = new Map();
  for (const c of candidates) {
    const k = key(c.item);
    const best = byProduct.get(k);
    if (!best || within(c, best) < 0) byProduct.set(k, c);
  }
  // A product holding an item due soonest wins a tie; otherwise the longest-waiting product.
  return [...byProduct.entries()].sort(([ka, a], [kb, b]) =>
    String(last.get(ka) || '').localeCompare(String(last.get(kb) || ''))
    || within(a, b))[0][1];
}

/** Platform states whose insights are due: from 24 h after posting, every ~20 h, final at 30 days. */
export function insightsDue(items = [], now = Date.now()) {
  const H = 3_600_000;
  const out = [];
  for (const item of items) {
    for (const p of PLATFORMS) {
      const s = item[p];
      const remoteId = p === 'instagram' ? s?.media_id : s?.post_id;
      if (!s?.posted_at || !remoteId || s.insights_final) continue;
      const age = now - Date.parse(s.posted_at);
      if (age < 24 * H) continue;
      if (s.insights_at && now - Date.parse(s.insights_at) < 20 * H) continue;
      out.push({ id: item.id, platform: p, remoteId, final: age >= 30 * 24 * H });
    }
  }
  return out;
}

// ── store (I/O) ──────────────────────────────────────────────────────────────

/**
 * Every item in `dir`. A file that cannot be parsed is SKIPPED and reported, never
 * thrown: one half-written file must not stop the poster and the dashboard tab.
 */
export function loadItems(dir = ITEMS_DIR, fsImpl = nodeFs, { onError = (name, err) => console.warn(`social-queue: skipped unreadable ${name}: ${err.message}`) } = {}) {
  let names = [];
  try { names = fsImpl.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const n of names.filter((x) => x.endsWith('.json'))) {
    try { out.push(JSON.parse(fsImpl.readFileSync(join(dir, n), 'utf8'))); } catch (err) {
      try { onError(n, err); } catch { /* reporting must not throw either */ }
    }
  }
  return out;
}

export function readItem(dir, id, fsImpl = nodeFs) {
  if (!ID_RE.test(String(id || ''))) return null;
  try { return JSON.parse(fsImpl.readFileSync(join(dir, `${id}.json`), 'utf8')); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export function saveItem(dir, item, fsImpl = nodeFs) {
  if (!ID_RE.test(String(item?.id || ''))) throw new Error('refusing to save an item without a slug id');
  fsImpl.mkdirSync(dir, { recursive: true });
  const path = join(dir, `${item.id}.json`);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  fsImpl.writeFileSync(tmp, JSON.stringify(item, null, 2) + '\n');
  fsImpl.renameSync(tmp, path);
}

/** Read the item fresh, apply `fn`, write it back. Returns the written item. */
export function updateItem(dir, id, fn, fsImpl = nodeFs) {
  const cur = readItem(dir, id, fsImpl);
  if (!cur) throw new Error(`no social-queue item ${id}`);
  const next = fn(cur);
  saveItem(dir, next, fsImpl);
  return next;
}
