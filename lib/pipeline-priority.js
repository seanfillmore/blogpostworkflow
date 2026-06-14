// lib/pipeline-priority.js
// Pure reprioritization brain. No I/O: every function takes plain data + config
// and returns plain data. The agent (agents/pipeline-prioritizer) supplies the
// normalized signals and backlog and applies the returned plan.

import { isCovered, isRejected, slugify } from './keyword-dedup.js';
import { nextOpenSlot } from './publish-schedule.js';

/** Intrinsic value of a backlog idea, revenue-first (intent-weighted). */
export function scoreBase(idea, cfg) {
  const b = cfg.base;
  // Prefer real search volume; fall back to GSC impressions as a demand proxy
  // when volume is unknown (injected unmapped-query ideas have no volume yet but
  // carry real impression demand). Without this, every such idea scored base 0
  // and never ranked for promotion despite genuine demand.
  let vol;
  if (idea.volume != null) {
    vol = Math.min(b.volumeCap, idea.volume / b.volumeDivisor);
  } else if (idea.impressions != null && b.impressionsDivisor) {
    vol = Math.min(b.volumeCap, idea.impressions / b.impressionsDivisor);
  } else {
    vol = 0;
  }
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

/**
 * Compute the reprioritization plan. Pure: the agent does all disk I/O and passes
 * partitioned inputs.
 *
 * inputs = {
 *   backlog,        // idea items (pending, no publish_date)
 *   signals,        // active normalized signals (post-hysteresis)
 *   bufferReady,    // count of written/scheduled-not-published posts
 *   takenSlots,     // Set<'YYYY-MM-DD'> already assigned to dated items
 *   clusterRecent,  // { cluster: ['YYYY-MM-DD', ...] } recent new posts
 *   refreshRecent,  // { slug: 'YYYY-MM-DD' } last refresh per post
 *   coveredIndex,   // Set of keywords+slugs already covered
 *   rejections,     // rejected-keywords.json contents
 *   today,          // 'YYYY-MM-DD'
 *   now,            // Date
 *   cfg,
 * }
 *
 * returns { scored, injections, promotions, suggestions, alerts }
 */
export function computePlan(inputs) {
  const {
    backlog, signals, bufferReady, takenSlots, clusterRecent, refreshRecent,
    coveredIndex, rejections, today, now, cfg,
  } = inputs;

  // index active signals by their matching key (keyword/slug) and by cluster
  const byKey = new Map();
  const byCluster = new Map();
  const suggestions = [];
  for (const sig of signals || []) {
    const c = classify(sig, cfg);
    if (sig.cluster) {
      byCluster.set(sig.cluster, [...(byCluster.get(sig.cluster) || []), { sig, c }]);
    }
    byKey.set(slugify(sig.key), [...(byKey.get(slugify(sig.key)) || []), { sig, c }]);
    if (!c.strong) suggestions.push({ key: sig.key, type: sig.type, score: c.score, reason: c.provenance });
  }

  const contributionsFor = (idea) => {
    const hits = [
      ...(byKey.get(slugify(idea.keyword)) || []),
      ...(byKey.get(idea.slug) || []),
      ...(idea.cluster ? (byCluster.get(idea.cluster) || []) : []),
    ];
    // de-dup identical (sig,c) refs
    const seen = new Set();
    let add = 0; const prov = []; const contributing = [];
    for (const { sig, c } of hits) {
      const id = `${sig.type}:${sig.key}`;
      if (seen.has(id)) continue; seen.add(id);
      add += c.score; prov.push(c.provenance);
      contributing.push({ type: sig.type, strength: sig.strength, score: c.score });
    }
    return { add, prov, contributing };
  };

  // 1) score existing backlog
  const scored = backlog.map((idea) => {
    const base = scoreBase(idea, cfg);
    const { add, prov, contributing } = contributionsFor(idea);
    const provenance = [`base ${base}`, ...prov].join(', ');
    return { ...idea, priority_score: base + add, priority_provenance: provenance, contributing };
  });

  // 2) injections from signals introducing a NOT-yet-covered keyword
  const injections = [];
  const covered = new Set(coveredIndex);
  for (const sig of signals || []) {
    if (sig.type === 'revenue_cluster') continue; // boosts existing, never injects
    const kw = sig.key;
    if (isRejected(kw, rejections)) continue;
    if (isCovered(kw, covered)) continue;
    const c = classify(sig, cfg);
    const idea = {
      slug: slugify(kw), keyword: kw, cluster: sig.cluster || null,
      volume: null, kd: null, search_intent: 'commercial',
      // Persist the unmapped query's GSC impressions as a demand proxy so the
      // idea keeps a meaningful base score on later runs even if the transient
      // signal isn't re-emitted (otherwise it sinks to base 0 and never promotes).
      impressions: sig.type === 'unmapped' ? (sig.strength ?? null) : null,
      task_type: sig.taskType || 'new',
      source: sig.type === 'unmapped' ? 'gsc_unmapped' : sig.type,
      status_override: null, publish_date: null,
      priority_score: c.score, priority_provenance: `injected, ${c.provenance}`,
      contributing: [{ type: sig.type, strength: sig.strength, score: c.score }],
    };
    injections.push(idea);
    covered.add(slugify(kw)); covered.add(kw.toLowerCase());
    scored.push(idea); // injected ideas are promotable this run
  }

  // 3) promotion (JIT buffer fill), respecting guardrails + pins + caps
  const need = Math.max(0, cfg.buffer.target - (bufferReady || 0));
  const limit = Math.min(need, cfg.maxPromotionsPerRun);
  const taken = new Set(takenSlots);
  const promotions = [];

  const rank = (a, b) => {
    const ar = a.status_override === 'rush' ? 1 : 0;
    const br = b.status_override === 'rush' ? 1 : 0;
    if (ar !== br) return br - ar;            // rush first
    return b.priority_score - a.priority_score; // then score
  };
  const candidates = scored
    .filter((i) => i.status_override !== 'paused')
    .sort(rank);

  for (const idea of candidates) {
    if (promotions.length >= limit) break;
    if (idea.cluster && !clusterSpacingOk(idea.cluster, clusterRecent, today, cfg)) continue;
    if (idea.task_type === 'refresh' && !refreshCooldownOk(idea.slug, refreshRecent, today, cfg)) continue;
    const publish_date = nextOpenSlot(taken, now, now);
    taken.add(publish_date.slice(0, 10));
    promotions.push({ slug: idea.slug, publish_date, reason: idea.priority_provenance });
  }

  // 4) backlog low-water alert
  const alerts = [];
  const depth = backlog.length + injections.length;
  if (depth < cfg.backlogLowWater) {
    alerts.push(`Backlog low: ${depth} idea(s) < ${cfg.backlogLowWater}. Run content-strategist to replenish.`);
  }

  return { scored, injections, promotions, suggestions, alerts };
}
