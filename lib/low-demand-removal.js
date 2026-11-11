/**
 * Which low-demand ("no-demand") blog posts the recap reviewer may remove
 * behind a 301. Pure: callers pass lock state, CTR-protected handles, order
 * history and redirect targets. Every refusal carries its own reason so a
 * skipped post is explained in the digest, never silently dropped.
 */
import { handleOf } from './ctr-protected.js';
import { LOCK_LOCKED, LOCK_UNREADABLE } from './post-lock.js';

const pathOf = (u) => {
  let s = String(u || '').replace(/[?#].*$/, '');
  s = s.replace(/^https?:\/\/[^/]+/i, '');
  return s.replace(/\/+$/, '');
};

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

export function removalEligibility(row, { lockState, ctrHandles, converted, winners, redirectTargets, ordersOk } = {}) {
  const handle = row?.url ? handleOf(row.url) : String(row?.slug || '');
  const path = `/blogs/news/${handle}`;
  if (row?.action !== 'no-demand') return { ok: false, reason: 'not a no-demand post' };
  if (lockState === LOCK_LOCKED) return { ok: false, reason: 'locked winner' };
  if (lockState === LOCK_UNREADABLE) return { ok: false, reason: 'lock state unreadable' };
  if (ctrHandles?.has(handle)) return { ok: false, reason: 'in a CTR experiment' };
  if (ordersOk === false) return { ok: false, reason: 'order history unreadable' };
  if (converted?.has(path)) return { ok: false, reason: 'has converted (order landed here)' };
  if (winners?.has(handle)) return { ok: false, reason: 'cannibalization winner' };
  if (redirectTargets?.has(path)) return { ok: false, reason: 'target of an existing redirect' };
  return { ok: true };
}

export function removalCandidates(flops, ctx, { limit = 5 } = {}) {
  const take = [];
  const skipped = [];
  for (const row of Array.isArray(flops) ? flops : []) {
    const handle = row?.url ? handleOf(row.url) : row?.slug;
    const v = removalEligibility(row, { ...ctx, ...(ctx?.lockStateFor ? { lockState: ctx.lockStateFor(handle) } : {}) });
    if (!v.ok) skipped.push({ slug: row?.slug, reason: v.reason });
    else if (take.length >= limit) skipped.push({ slug: row?.slug, reason: 'cap' });
    else take.push(row);
  }
  return { take, skipped };
}
