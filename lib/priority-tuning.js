// lib/priority-tuning.js
// Pure brain for the closed-loop weight tuner. Joins the prioritizer's attribution
// ledger (signal→post) against seo-impact action_wins (post→revenue) to measure which
// signal types actually drive revenue, then proposes bounded nudges to the per-signal
// weight knobs in config/pipeline-priority.json. No I/O. See Phase 2 design doc.

const DAY_MS = 86400000;

/** True if an action_win path belongs to the given post slug (path suffix match). */
export function pathMatchesSlug(path, slug) {
  if (!path || !slug) return false;
  const tail = String(path).split(/[?#]/)[0].replace(/\/+$/, '').split('/').pop();
  return tail === slug;
}

/**
 * Per-signal-type performance from the ledger + action_wins.
 * Only ledger records whose `date` is >= measureLagDays old are "measurable".
 * A (slug, signal_type) pair is counted once. score = revenue / measured.
 * @returns {{ [signalType:string]: {measured, wins, revenue, score} }}
 */
export function aggregatePerformance(ledger, actionWins, { today, measureLagDays }) {
  const todayMs = Date.parse(today + 'T00:00:00Z');
  const measurable = (ledger || []).filter((r) => {
    if (!r.date) return false;
    const age = Math.floor((todayMs - Date.parse(r.date + 'T00:00:00Z')) / DAY_MS);
    return age >= measureLagDays;
  });

  // win lookup by slug → revenueDelta (max if multiple paths map to the slug)
  const winRevenueBySlug = new Map();
  for (const w of (actionWins || [])) {
    for (const r of measurable) {
      if (pathMatchesSlug(w.path, r.slug)) {
        const prev = winRevenueBySlug.get(r.slug) || 0;
        winRevenueBySlug.set(r.slug, Math.max(prev, w.revenueDelta || 0));
      }
    }
  }

  // dedup (slug, signal_type)
  const seen = new Set();
  const perf = {};
  for (const r of measurable) {
    const key = `${r.slug}:${r.signal_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const p = (perf[r.signal_type] ||= { measured: 0, wins: 0, revenue: 0, score: 0 });
    p.measured += 1;
    const rev = winRevenueBySlug.get(r.slug) || 0;
    if (rev > 0) { p.wins += 1; p.revenue += rev; }
  }
  for (const t of Object.keys(perf)) {
    perf[t].revenue = Math.round(perf[t].revenue * 100) / 100;
    perf[t].score = perf[t].measured ? Math.round((perf[t].revenue / perf[t].measured) * 100) / 100 : 0;
  }
  return perf;
}
