// lib/creatives-budget.js
//
// A hard disk budget for `data/creatives/`, enforced as we go.
//
// ── Why a budget and not just an age policy ─────────────────────────────────────────
//
// `scripts/prune-ad-studio.mjs` already prunes by AGE — rejected images after 7 days, all
// images after 90. Age is the right first cut but it is not a ceiling: nothing stops a
// fortnight of heavy batches from filling the disk inside the retention window, and one
// Ad Studio run is ~137 MB.
//
// This project has already lost four days of cron to a full disk (unpruned Amazon dumps on
// a 24 GB box — see CLAUDE.md). The failure is not "images pile up", it is that EVERY
// scheduled job stops and nothing says why. A ceiling that enforces itself is the only
// kind that helps, so this runs at the end of every Ad Studio run rather than waiting for
// somebody to remember a script.
//
// ── What may be deleted, in order ───────────────────────────────────────────────────
//
// Purge is tiered, cheapest loss first, and stops the moment the total is under budget:
//
//   1. Ad Studio images from REJECTED variations, past a short grace period. The frame was
//      never usable; its proof.json survives, so the reason it failed is not lost.
//   2. Ad Studio images from old runs, oldest first.
//   3. Creatives-tab session images from sessions untouched for a while, oldest first.
//
// **JSON is never deleted, at any tier.** run.json, proof.json, copy.json and a session's
// own record are a few KB each and are the permanent audit trail — a run stays explicable
// after its pixels are gone. That is the same rule prune-ad-studio already follows and it
// is not weakened by adding a size ceiling on top.
//
// Tier 3 is age-gated for a reason age is not needed in tiers 1–2: a Creatives session is
// a workspace someone may still have open, and deleting its images empties the canvas of a
// session that still looks alive. Ad Studio run output is finished the moment the run ends.

import { readdirSync, statSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 10 GiB — the LOCAL default, where disk is plentiful.
 *
 * Deliberately NOT the value used on the production box: that machine has ~9.9 GB
 * free of 24 GB, so a 10 GiB ceiling can never fire before the disk fills, and a full
 * disk there has already stopped every cron job for four days with nothing saying
 * why. The server sets CREATIVES_BUDGET_BYTES to 4 GiB.
 */
export const DEFAULT_BUDGET_BYTES = 10 * 1024 * 1024 * 1024;

/**
 * A junk, zero or negative override falls back to the default. A budget of 0 would
 * mean "purge everything eligible", which is the worst possible reading of a typo in
 * a .env file.
 */
export function resolveBudgetBytes(env = process.env) {
  const raw = Number(env?.CREATIVES_BUDGET_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_BUDGET_BYTES;
}

/** How long a rejected Ad Studio frame is kept so a human can look at why. */
export const DEFAULT_REJECTED_GRACE_DAYS = 7;
/** How old an Ad Studio run must be before tier 2 will touch it. */
export const DEFAULT_RUN_AGE_DAYS = 14;
/** How long a Creatives session must be untouched before tier 3 will touch it. */
export const DEFAULT_SESSION_IDLE_DAYS = 30;

const IMAGE_RE = /\.(jpe?g|png|webp|gif|svg)$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Every image file under `dir`, with its size and mtime. Directories are walked; JSON and
 * everything else is ignored, because nothing else is ever a purge candidate.
 */
export function collectImages(dir) {
  const out = [];
  if (!dir || !existsSync(dir)) return out;
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!IMAGE_RE.test(e.name)) continue;
      try {
        const st = statSync(p);
        out.push({ path: p, bytes: st.size, mtimeMs: st.mtimeMs });
      } catch { /* vanished mid-walk; nothing to purge */ }
    }
  };
  walk(dir);
  return out;
}

/** Total bytes of everything under `dir`, images or not — the number the budget is against. */
export function measureDir(dir) {
  let total = 0;
  if (!dir || !existsSync(dir)) return 0;
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      try { total += statSync(p).size; } catch { /* ignore */ }
    }
  };
  walk(dir);
  return total;
}

/**
 * Which Ad Studio variations were rejected, from the run's own report.
 *
 * Read from run.json rather than inferred from filenames — the same rule
 * prune-ad-studio.mjs follows, and for the same reason: a filename says nothing about
 * whether the gate accepted the frame. A run with no readable report is treated as having
 * no rejected variations, so tier 1 skips it entirely and tier 2 handles it on age. Erring
 * toward keeping is right when the alternative is deleting something a human has not seen.
 */
export function rejectedVariationDirs(runDir) {
  let report;
  try { report = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')); } catch { return new Set(); }
  if (!report) return new Set();
  const dirs = new Set();
  for (const c of report.results || []) {
    for (const v of c.variations || []) {
      if (!v.ok) dirs.add(join(runDir, c.conceptSlug, `v${v.n}`));
    }
  }
  return dirs;
}

/**
 * Decide what to delete. PURE — takes facts, returns a plan, touches nothing.
 *
 * @param {object} args
 * @param {string} args.creativesDir
 * @param {number} [args.budgetBytes]
 * @param {string[]} [args.keepPaths]  absolute paths never eligible (the run just written)
 * @param {number} [args.now]
 * @returns {{totalBytes:number, budgetBytes:number, overBy:number, deletions:{path:string,bytes:number,tier:number}[], freedBytes:number, wouldRemain:number, underBudget:boolean}}
 */
export function planPurge({
  creativesDir,
  budgetBytes = resolveBudgetBytes(),
  keepPaths = [],
  now = Date.now(),
  rejectedGraceDays = DEFAULT_REJECTED_GRACE_DAYS,
  runAgeDays = DEFAULT_RUN_AGE_DAYS,
  sessionIdleDays = DEFAULT_SESSION_IDLE_DAYS,
} = {}) {
  const totalBytes = measureDir(creativesDir);
  const overBy = totalBytes - budgetBytes;
  const base = {
    totalBytes, budgetBytes, overBy: Math.max(0, overBy),
    deletions: [], freedBytes: 0, wouldRemain: totalBytes, underBudget: overBy <= 0,
  };
  if (overBy <= 0) return base;

  const adStudioDir = join(creativesDir, 'ad-studio');
  const keep = new Set(keepPaths.map(String));
  const isKept = (p) => [...keep].some(k => p === k || p.startsWith(k + '/'));

  const runDirs = existsSync(adStudioDir)
    ? readdirSync(adStudioDir).filter(n => {
        try { return statSync(join(adStudioDir, n)).isDirectory(); } catch { return false; }
      }).map(n => join(adStudioDir, n))
    : [];

  // Tier 1 — rejected Ad Studio frames past the grace period.
  const tier1 = [];
  for (const runDir of runDirs) {
    const rejected = rejectedVariationDirs(runDir);
    if (!rejected.size) continue;
    for (const img of collectImages(runDir)) {
      if (isKept(img.path)) continue;
      const inRejected = [...rejected].some(d => img.path.startsWith(d + '/'));
      if (!inRejected) continue;
      if (now - img.mtimeMs < rejectedGraceDays * DAY_MS) continue;
      tier1.push({ ...img, tier: 1 });
    }
  }

  // Tier 2 — Ad Studio images from old runs, oldest first.
  const tier1Paths = new Set(tier1.map(f => f.path));
  const tier2 = [];
  for (const runDir of runDirs) {
    for (const img of collectImages(runDir)) {
      if (isKept(img.path) || tier1Paths.has(img.path)) continue;
      if (now - img.mtimeMs < runAgeDays * DAY_MS) continue;
      tier2.push({ ...img, tier: 2 });
    }
  }

  // Tier 3 — Creatives-tab session images, only once idle.
  const tier3 = [];
  const sessionDirs = existsSync(creativesDir)
    ? readdirSync(creativesDir).filter(n => n !== 'ad-studio').map(n => join(creativesDir, n))
        .filter(p => { try { return statSync(p).isDirectory(); } catch { return false; } })
    : [];
  for (const sDir of sessionDirs) {
    for (const img of collectImages(sDir)) {
      if (isKept(img.path)) continue;
      if (now - img.mtimeMs < sessionIdleDays * DAY_MS) continue;
      tier3.push({ ...img, tier: 3 });
    }
  }

  // Oldest first, with PATH as a tiebreak. Files written in the same second are common —
  // a run writes every frame of a variation at once — and without a stable second key the
  // purge order falls back to readdir order, which is filesystem-dependent. A destructive
  // operation should delete the same thing twice given the same inputs.
  const byOldest = (a, b) => (a.mtimeMs - b.mtimeMs) || a.path.localeCompare(b.path);
  const candidates = [...tier1.sort(byOldest), ...tier2.sort(byOldest), ...tier3.sort(byOldest)];

  // Stop the moment the total is under budget — this deletes the least it can, not
  // everything it is allowed to.
  const deletions = [];
  let freed = 0;
  for (const c of candidates) {
    if (totalBytes - freed <= budgetBytes) break;
    deletions.push({ path: c.path, bytes: c.bytes, tier: c.tier });
    freed += c.bytes;
  }

  return {
    totalBytes, budgetBytes, overBy,
    deletions, freedBytes: freed,
    wouldRemain: totalBytes - freed,
    underBudget: totalBytes - freed <= budgetBytes,
  };
}

/**
 * Execute a plan.
 *
 * `apply` defaults to FALSE, matching prune-ad-studio.mjs and the same reasoning: the
 * cheapest action is the one you get by accident. The agent passes `apply: true`
 * deliberately, because "purge as we go" is the requirement.
 *
 * Never throws. A budget sweep must not turn a finished, paid run into a failure — the
 * images are already on disk and the worst case of a failed sweep is that the disk stays
 * full, which the next run's sweep will try again.
 */
export function enforceBudget({ creativesDir, apply = false, ...opts } = {}) {
  let plan;
  try {
    plan = planPurge({ creativesDir, ...opts });
  } catch (err) {
    console.warn(`creatives-budget: could not plan a purge (${err.message}) — skipping.`);
    return { deletions: [], freedBytes: 0, applied: false, error: err.message };
  }
  if (!apply || !plan.deletions.length) return { ...plan, applied: false };

  let freed = 0;
  const deleted = [];
  for (const d of plan.deletions) {
    try { unlinkSync(d.path); deleted.push(d); freed += d.bytes; }
    catch { /* already gone, or unreadable — the next sweep will retry */ }
  }
  return { ...plan, deletions: deleted, freedBytes: freed, applied: true };
}

/** Human-readable bytes, for the one line a run prints. */
export function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.abs(Number(n) || 0);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)}${units[i]}`;
}
