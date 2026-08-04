// lib/prompt-budget.js
//
// Keep an agent's prompt inside the model's context window.
//
// Written after the same bug surfaced twice in one week: an agent bounds its input
// by item COUNT but not by item SIZE, so the prompt grows silently with the data
// until the API rejects it. insight-aggregator reached ~370,000 tokens per call
// (41% of the fleet's entire input spend); cro-analyzer reached 1,917,307 tokens
// against a 1,000,000 limit and failed every run until capped.
//
// The rule these helpers encode: a cap that truncates silently is worse than no
// cap, because the model then reasons over a partial picture while the operator
// reads the output as complete. Everything here states what it removed — in the
// prompt itself, so the model knows, and via a return value, so the agent can log.

/** JSON without pretty-printing. Indentation roughly doubles a deep object for no gain. */
export function compactJson(value) {
  return JSON.stringify(value);
}

/**
 * Keep the first `n` entries of an array and append a marker naming how many were
 * dropped. First-n rather than a sample because these feeds arrive sorted by
 * significance (impressions, clicks, revenue) — the head is the part worth keeping.
 *
 * Non-arrays pass through untouched so callers can apply this blindly to a field
 * that may or may not be a list.
 */
export function headArray(value, n) {
  if (!Array.isArray(value) || value.length <= n) return value;
  return [...value.slice(0, n), { _omitted: `${value.length - n} more rows omitted to fit the prompt budget` }];
}

/**
 * Assemble labeled sections into one string within `totalCap` characters.
 *
 * Truncates the largest section first and repeats until it fits, so one runaway
 * feed cannot crowd out several small ones — the failure mode in cro-analyzer,
 * where GSC alone was 4.9 MB and starved four feeds that together were under 140 KB.
 *
 * Returns `{ text, trimmed }` where `trimmed` names the sections that lost content.
 */
export function fitSections(sections, { totalCap = 400_000 } = {}) {
  const live = sections
    .filter((s) => s && typeof s.body === 'string' && s.body.length > 0)
    .map((s) => ({ ...s }));

  const trimmed = [];
  const rendered = () => live.map((s) => `### ${s.label}\n${s.body}`).join('\n\n');

  // Shrink the current largest section toward the mean until the whole thing fits.
  // Bounded by the number of sections: each pass either fits or strictly reduces
  // the largest body, and a section is never cut below a readable floor.
  const FLOOR = 500;
  for (let guard = 0; guard < live.length * 4 && rendered().length > totalCap; guard += 1) {
    const biggest = live.reduce((a, b) => (b.body.length > a.body.length ? b : a));
    if (biggest.body.length <= FLOOR) break; // nothing left worth cutting

    const over = rendered().length - totalCap;
    const target = Math.max(FLOOR, biggest.body.length - over - 120);
    const omitted = biggest.body.length - target;
    biggest.body = `${biggest.body.slice(0, target)}\n[truncated — ${omitted.toLocaleString()} characters omitted to fit the prompt budget]`;
    if (!trimmed.includes(biggest.label)) trimmed.push(biggest.label);
  }

  return { text: rendered(), trimmed };
}
