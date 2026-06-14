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

// Which knob each signal type tunes.
const PARAM_OF = {
  unmapped: 'unmapped.perImpression',
  rank_drop: 'rank_drop.perPosition',
  revenue_cluster: 'revenue_cluster.perDollar',
  competitor_gap: 'competitor_gap.boost',
  ai_gap: 'ai_gap.boost',
};

function getParam(cfg, param) {
  const [sig, key] = param.split('.');
  return cfg.signals[sig]?.[key];
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function round4(v) { return Math.round(v * 10000) / 10000; }

/**
 * Propose bounded weight nudges. Qualifying signals (measured >= minSamplesPerSignal)
 * are nudged toward their score relative to the qualifying-signal mean, by at most
 * maxStepPct, clamped to paramBounds. Whole-run no-op if <2 qualify or total measured
 * (across ALL signals) < totalFloor. Returns only knobs that actually change.
 */
export function proposeWeightChanges(perf, cfg) {
  const t = cfg.tuning;
  const totalMeasured = Object.values(perf).reduce((a, p) => a + (p.measured || 0), 0);
  if (totalMeasured < t.totalFloor) return [];

  const qualifying = Object.entries(perf).filter(([, p]) => p.measured >= t.minSamplesPerSignal);
  if (qualifying.length < 2) return [];

  const mean = qualifying.reduce((a, [, p]) => a + p.score, 0) / qualifying.length;
  if (mean <= 0) return [];

  const changes = [];
  for (const [signal_type, p] of qualifying) {
    const param = PARAM_OF[signal_type];
    if (!param) continue;
    const from = getParam(cfg, param);
    const bounds = t.paramBounds[param];
    if (from == null || !bounds) continue;
    const dirSign = Math.sign(p.score - mean);           // +1 above mean, -1 below, 0 at mean
    const factor = 1 + dirSign * t.maxStepPct;           // full ±maxStepPct step toward/away from mean
    const to = round4(clamp(from * factor, bounds.min, bounds.max));
    if (to === round4(from)) continue;                   // no effective change
    const dir = to > from ? '+' : '−';
    changes.push({ signal_type, param, from, to,
      reason: `score ${p.score} vs mean ${Math.round(mean * 100) / 100} → ${dir}${Math.abs(Math.round((to / from - 1) * 100))}%` });
  }
  return changes;
}
