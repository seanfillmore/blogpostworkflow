/**
 * Verdict computation for change-log windows.
 *
 * - computeDeltas(baseline, current) → { page: {...}, target_queries: {...} }
 *   Compares window.baseline against current metrics, returning relative
 *   deltas (e.g. ctr 0.25 means +25%) for ratios and absolute deltas for
 *   position (where lower = better).
 * - classifyOutcome(deltas) → "improved" | "regressed" | "no_change" | "inconclusive"
 * - decideAction({ outcome, window, events }) → { action, reason }
 *
 * THRESHOLDS is exported so future config can override.
 */

export const THRESHOLDS = {
  // Positive triggers (any one trips → "improved" if no negative is also tripped):
  ctr_positive: 0.20,        // +20% relative
  clicks_positive: 0.25,     // +25% relative
  position_positive: -3,     // -3 positions absolute (lower number = higher rank)
  revenue_positive: 0.20,    // +20% relative

  // Negative triggers (any one trips → "regressed"):
  ctr_negative: -0.20,
  clicks_negative: -0.25,
  position_negative: 5,      // +5 positions absolute
  revenue_negative: -0.20,

  // Within-noise band (all deltas within ±this → "no_change"):
  noise_band: 0.05,          // 5% relative for ratios; 1 position for position
  noise_position: 1,
};

const REVERTABLE_TYPES = new Set([
  'title', 'meta_description', 'schema', 'faq_added', 'internal_link_added',
]);

function relDelta(current, baseline) {
  if (baseline == null || baseline === 0) return current === 0 ? 0 : null;
  return (current - baseline) / baseline;
}

function absDelta(current, baseline) {
  if (current == null || baseline == null) return null;
  return current - baseline;
}

export function computeDeltas(baseline, current) {
  const page = {
    impressions: relDelta(current.gsc.page.impressions, baseline.gsc.page.impressions),
    clicks: relDelta(current.gsc.page.clicks, baseline.gsc.page.clicks),
    ctr: relDelta(current.gsc.page.ctr, baseline.gsc.page.ctr),
    position: absDelta(current.gsc.page.position, baseline.gsc.page.position),
    sessions: relDelta(current.ga4.sessions, baseline.ga4.sessions),
    conversions: relDelta(current.ga4.conversions, baseline.ga4.conversions),
    page_revenue: relDelta(current.ga4.page_revenue, baseline.ga4.page_revenue),
  };
  const target_queries = {};
  for (const q of Object.keys(current.gsc.byQuery || {})) {
    const cur = current.gsc.byQuery[q];
    const base = baseline.gsc.byQuery?.[q] || { impressions: 0, clicks: 0, ctr: 0, position: null };
    target_queries[q] = {
      impressions: relDelta(cur.impressions, base.impressions),
      clicks: relDelta(cur.clicks, base.clicks),
      ctr: relDelta(cur.ctr, base.ctr),
      position: absDelta(cur.position, base.position),
    };
  }
  return { page, target_queries };
}

function isWithinNoise(deltas) {
  const checkRel = (v) => v == null || Math.abs(v) <= THRESHOLDS.noise_band;
  const checkPos = (v) => v == null || Math.abs(v) <= THRESHOLDS.noise_position;
  if (!checkRel(deltas.page.ctr)) return false;
  if (!checkRel(deltas.page.clicks)) return false;
  if (!checkRel(deltas.page.impressions)) return false;
  if (!checkRel(deltas.page.page_revenue)) return false;
  if (!checkRel(deltas.page.sessions)) return false;
  if (!checkPos(deltas.page.position)) return false;
  for (const q of Object.values(deltas.target_queries || {})) {
    if (!checkRel(q.ctr)) return false;
    if (!checkRel(q.clicks)) return false;
    if (!checkPos(q.position)) return false;
  }
  return true;
}

function tripsNegative(deltas) {
  if (deltas.page.ctr != null && deltas.page.ctr <= THRESHOLDS.ctr_negative) return true;
  if (deltas.page.clicks != null && deltas.page.clicks <= THRESHOLDS.clicks_negative) return true;
  if (deltas.page.position != null && deltas.page.position >= THRESHOLDS.position_negative) return true;
  if (deltas.page.page_revenue != null && deltas.page.page_revenue <= THRESHOLDS.revenue_negative) return true;
  for (const q of Object.values(deltas.target_queries || {})) {
    if (q.ctr != null && q.ctr <= THRESHOLDS.ctr_negative) return true;
    if (q.clicks != null && q.clicks <= THRESHOLDS.clicks_negative) return true;
    if (q.position != null && q.position >= THRESHOLDS.position_negative) return true;
  }
  return false;
}

function tripsPositive(deltas) {
  if (deltas.page.ctr != null && deltas.page.ctr >= THRESHOLDS.ctr_positive) return true;
  if (deltas.page.clicks != null && deltas.page.clicks >= THRESHOLDS.clicks_positive) return true;
  if (deltas.page.position != null && deltas.page.position <= THRESHOLDS.position_positive) return true;
  if (deltas.page.page_revenue != null && deltas.page.page_revenue >= THRESHOLDS.revenue_positive) return true;
  for (const q of Object.values(deltas.target_queries || {})) {
    if (q.ctr != null && q.ctr >= THRESHOLDS.ctr_positive) return true;
    if (q.clicks != null && q.clicks >= THRESHOLDS.clicks_positive) return true;
    if (q.position != null && q.position <= THRESHOLDS.position_positive) return true;
  }
  return false;
}

export function classifyOutcome(deltas) {
  if (tripsNegative(deltas)) return 'regressed';
  if (isWithinNoise(deltas)) return 'no_change';
  if (tripsPositive(deltas)) return 'improved';
  return 'inconclusive';
}

export function decideAction({ outcome, window, events }) {
  if (outcome !== 'regressed') {
    return { action: 'kept', reason: outcome };
  }
  const types = events.filter((e) => window.changes.includes(e.id)).map((e) => e.change_type);
  const allRevertable = types.every((t) => REVERTABLE_TYPES.has(t));
  if (allRevertable && types.length > 0) {
    return { action: 'reverted', reason: 'all_revertable_types' };
  }
  return { action: 'surfaced_for_review', reason: 'bundle_includes_irreversible_types' };
}
