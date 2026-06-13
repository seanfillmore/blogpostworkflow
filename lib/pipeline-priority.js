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
