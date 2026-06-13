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
