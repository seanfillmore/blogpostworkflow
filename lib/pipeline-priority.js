// lib/pipeline-priority.js
// Pure reprioritization brain. No I/O: every function takes plain data + config
// and returns plain data. The agent (agents/pipeline-prioritizer) supplies the
// normalized signals and backlog and applies the returned plan.

/** Intrinsic value of a backlog idea, revenue-first (intent-weighted). */
export function scoreBase(idea, cfg) {
  const b = cfg.base;
  const vol = Math.min(b.volumeCap, (idea.volume || 0) / b.volumeDivisor);
  const intent = b.intentMult[idea.search_intent] ?? b.intentMult.informational ?? 1.0;
  const kdBonus = (idea.kd != null && idea.kd <= b.kdEasyThreshold) ? b.kdEasyBonus : 0;
  return Math.round(vol * intent + kdBonus);
}

/** Score + strong flag + provenance text for one normalized signal. */
export function classify(signal, cfg) {
  const s = cfg.signals[signal.type] || {};
  let score = 0;
  let strong = false;
  switch (signal.type) {
    case 'unmapped':
      score = Math.min(s.cap, Math.round(signal.strength * s.perImpression));
      strong = signal.strength >= s.strongImpressions;
      break;
    case 'rank_drop':
      score = Math.min(s.cap, Math.round(signal.strength * s.perPosition));
      strong = signal.strength >= s.strongPositions;
      break;
    case 'revenue_cluster':
      score = Math.min(s.cap, Math.round(signal.strength * s.perDollar));
      strong = signal.strength >= s.strongDelta;
      break;
    case 'competitor_gap':
    case 'ai_gap':
      score = Math.min(s.cap, s.boost);
      strong = false;
      break;
    default:
      score = 0;
  }
  if (score >= cfg.strongThreshold) strong = true;
  const label = signal.label || signal.type;
  return { score, strong, provenance: `+${score} ${label}` };
}

/**
 * Gate signals on strength-or-persistence. A signal counts as active if it is
 * strong (classify().strong) OR has now been seen for >= cfg.hysteresisRuns
 * consecutive runs. Returns the surviving signals and the rebuilt state (state
 * is rebuilt from THIS run's signals only, so a one-day gap resets the counter).
 */
export function applyHysteresis(signals, prevState, today, cfg) {
  const state = {};
  const active = [];
  for (const sig of signals || []) {
    const id = `${sig.type}:${sig.key}`;
    const prev = prevState ? prevState[id] : undefined;
    const runs = (prev?.runs || 0) + 1;
    state[id] = { firstSeen: prev?.firstSeen || today, lastSeen: today, runs };
    const { strong } = classify(sig, cfg);
    if (strong || runs >= cfg.hysteresisRuns) active.push(sig);
  }
  return { active, state };
}

const DAY_MS = 86400000;
function daysBetween(aYmd, bYmd) {
  return Math.floor((Date.parse(aYmd + 'T00:00:00Z') - Date.parse(bYmd + 'T00:00:00Z')) / DAY_MS);
}

/** True if fewer than clusterSpacingMax new posts landed in this cluster within the window. */
export function clusterSpacingOk(cluster, recentByCluster, today, cfg) {
  const dates = (recentByCluster && recentByCluster[cluster]) || [];
  const within = dates.filter((d) => daysBetween(today, d) <= cfg.clusterSpacingDays && daysBetween(today, d) >= 0);
  return within.length < cfg.clusterSpacingMax;
}

/** True if this post has not been refreshed within the cooldown window. */
export function refreshCooldownOk(slug, lastRefreshBySlug, today, cfg) {
  const last = lastRefreshBySlug && lastRefreshBySlug[slug];
  if (!last) return true;
  return daysBetween(today, last) >= cfg.refreshCooldownDays;
}
