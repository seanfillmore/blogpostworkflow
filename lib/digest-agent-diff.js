// lib/digest-agent-diff.js
//
// Which agents stopped reporting into the daily digest?
//
// A wrongly-guarded agent (see lib/is-direct-run.js) becomes a silent no-op that
// still exits 0, so cron records success and the 5 AM digest shows no error. The
// ONLY signal is a row that used to appear and no longer does. This is the pure
// half of scripts/digest-agent-diff.mjs so the comparison is testable without
// reading a JSONL file.

/**
 * Agent identity for one digest record. Notifications carry `agent` when the
 * caller set it, and otherwise only a human subject line, so fall back to the
 * subject's leading phrase — split on the separators the fleet's subjects use
 * (": ", " — ", " - ") and lowercase for comparison.
 * @returns {string|null} null when the record identifies nothing
 */
export function agentNameOf(record) {
  if (!record || typeof record !== 'object') return null;
  if (typeof record.agent === 'string' && record.agent.trim()) {
    return record.agent.trim().toLowerCase();
  }
  const subject = typeof record.subject === 'string' ? record.subject : '';
  const lead = subject.split(/[:—-]/)[0].trim();
  return lead ? lead.toLowerCase() : null;
}

/**
 * Compare today's reporting agents against the union of several baseline days.
 *
 * The baseline is a UNION, not an intersection: an agent that runs on some days
 * and not others should still be *known*, and the caller decides whether its
 * absence is expected. Intersecting would quietly shrink the baseline to only
 * the everyday agents and hide exactly the weekly ones worth checking.
 *
 * @param {Set<string>} today
 * @param {Array<Set<string>>} baselines
 * @returns {{missing: string[], added: string[], baselineSize: number}}
 */
export function diffAgentSets(today, baselines) {
  const todaySet = today instanceof Set ? today : new Set();
  const base = new Set();
  for (const s of baselines || []) {
    if (!(s instanceof Set)) continue;
    for (const a of s) base.add(a);
  }
  return {
    missing: [...base].filter((a) => !todaySet.has(a)).sort(),
    added: [...todaySet].filter((a) => !base.has(a)).sort(),
    baselineSize: base.size,
  };
}
