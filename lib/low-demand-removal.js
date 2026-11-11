/**
 * Which low-demand ("no-demand") blog posts the recap reviewer may remove
 * behind a 301. Pure: callers pass lock state, CTR-protected handles, order
 * history and redirect targets. Every refusal carries its own reason so a
 * skipped post is explained in the digest, never silently dropped.
 */
import { handleOf } from './ctr-protected.js';
import { LOCK_LOCKED, LOCK_UNREADABLE, LOCK_UNLOCKED, LOCK_NO_POST } from './post-lock.js';

const pathOf = (u) => String(u || '').replace(/[?#].*$/, '').replace(/^https?:\/\/[^/]+/i, '').replace(/\/+$/, '');

export function convertedPaths(orders) {
  const out = new Set();
  for (const o of Array.isArray(orders) ? orders : []) {
    const p = pathOf(o?.landing_site);
    if (p) out.add(p);
  }
  return out;
}

export function cannibalizationWinners(report) {
  const out = new Set();
  for (const c of Array.isArray(report?.conflicts) ? report.conflicts : []) {
    let best = null;
    for (const u of Array.isArray(c?.urls) ? c.urls : []) {
      if (!best || (u?.impressions || 0) > (best.impressions || 0)) best = u;
    }
    const h = best ? handleOf(best.url) : '';
    if (h) out.add(h);
  }
  return out;
}

const norm = (u) => {
  let s = String(u || '').replace(/[?#].*$/, '').replace(/^https?:\/\/[^/]+/i, '');
  try { s = decodeURIComponent(s); } catch { /* keep raw */ }
  return s.replace(/\/+$/, '').toLowerCase();
};
const LOCK_STATES = [LOCK_UNLOCKED, LOCK_LOCKED, LOCK_NO_POST, LOCK_UNREADABLE];
const hasNorm = (set, v) => { for (const x of set) if (norm(x) === v) return true; return false; };

export function removalEligibility(row, ctx = {}) {
  const { lockState, ctrHandles, converted, winners, redirectTargets, ordersOk } = ctx || {};
  if (row?.action !== 'no-demand') return { ok: false, reason: 'not a no-demand post' };
  for (const [k, v] of Object.entries({ ctrHandles, converted, winners, redirectTargets })) {
    if (!(v instanceof Set)) return { ok: false, reason: `missing context: ${k}` };
  }
  if (!LOCK_STATES.includes(lockState)) return { ok: false, reason: 'missing context: lockState' };
  if (ordersOk !== true) {
    return { ok: false, reason: ordersOk === false ? 'order history unreadable' : 'missing context: ordersOk' };
  }
  let path;
  if (row?.url) path = norm(row.url);
  else if (String(row?.slug || '').trim()) path = norm(`/blogs/news/${String(row.slug).trim()}`);
  const m = path && path.match(/^\/blogs\/news\/([^/]+)$/);
  if (!m) return { ok: false, reason: 'not a blog article' };
  const handle = m[1];
  if (lockState === LOCK_LOCKED) return { ok: false, reason: 'locked winner' };
  if (lockState === LOCK_UNREADABLE) return { ok: false, reason: 'lock state unreadable' };
  if (hasNorm(ctrHandles, handle)) return { ok: false, reason: 'in a CTR experiment' };
  if (hasNorm(converted, path)) return { ok: false, reason: 'has converted (order landed here)' };
  if (hasNorm(winners, handle)) return { ok: false, reason: 'cannibalization winner' };
  if (hasNorm(redirectTargets, path)) return { ok: false, reason: 'target of an existing redirect' };
  return { ok: true };
}

export function removalCandidates(flops, ctx, { limit = 5 } = {}) {
  const take = [];
  const skipped = [];
  for (const row of Array.isArray(flops) ? flops : []) {
    const handle = row?.url ? handleOf(row.url) : row?.slug;
    let lockState;
    try { lockState = typeof ctx?.lockStateFor === 'function' ? ctx.lockStateFor(handle) : undefined; } catch { lockState = undefined; }
    const v = removalEligibility(row, { ...ctx, lockState });
    if (!v.ok) skipped.push({ slug: row?.slug, reason: v.reason });
    else if (take.length >= limit) skipped.push({ slug: row?.slug, reason: 'cap' });
    else take.push(row);
  }
  return { take, skipped };
}
