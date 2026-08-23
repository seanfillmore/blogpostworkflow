// lib/llm-json-suggestions.js
//
// Parse a scored-suggestion JSON array out of a Claude response.
//
// `internal-linker` and `collection-linker` both asked Claude for a JSON array of
// link suggestions and both wrapped the parse in `try { ... } catch { return [] }`.
// That collapses three different outcomes into one: "the model found nothing",
// "the response was truncated at max_tokens", and "the model returned prose". The
// first is a normal result; the other two are failures, and returning [] for them
// meant internal linking could quietly stop working across an entire run with
// nothing in the log, the report, or the digest to say so.
//
// These agents loop over many articles, so a throw would abandon the batch over a
// single bad response. Instead this reports the failure to the caller, which
// counts it and surfaces the count — the same skip-and-count rule the $0-cluster
// holds follow: never silently drop.

/**
 * @param {object} message a Claude API response
 * @param {{minScore?: number}} opts
 * @returns {{suggestions: object[], failure: null | {reason: string, detail: string}}}
 *   `failure` is null on success. `suggestions` is always an array, so a caller
 *   that ignores `failure` behaves exactly as the old code did.
 */
export function parseScoredSuggestions(message, { minScore = 0 } = {}) {
  const fail = (reason, detail) => ({ suggestions: [], failure: { reason, detail } });

  if (!message) return fail('no_response', 'no message object returned');

  // A truncated JSON array cannot be repaired, and retrying against the same
  // ceiling cannot succeed — same reasoning as demand-miner's max_tokens rule.
  if (message.stop_reason === 'max_tokens') {
    return fail('truncated', 'response hit max_tokens — JSON is incomplete');
  }

  const text = message?.content?.[0]?.text;
  if (typeof text !== 'string') return fail('no_text', 'response carried no text block');

  const raw = text.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return fail('unparseable', `${e.message} — starts: ${raw.slice(0, 120)}`);
  }

  if (!Array.isArray(parsed)) {
    return fail('not_an_array', `expected a JSON array, got ${typeof parsed}`);
  }

  return {
    suggestions: parsed.filter((s) => s && typeof s === 'object' && (s.score ?? 0) >= minScore),
    failure: null,
  };
}

/**
 * One-line summary of accumulated failures, for a console line, a report, or a
 * notify() body. Returns '' when nothing failed, so callers can append blindly.
 * @param {Array<{reason: string, detail: string}>} failures
 */
export function summarizeSuggestionFailures(failures) {
  const list = (failures || []).filter(Boolean);
  if (list.length === 0) return '';
  const byReason = new Map();
  for (const f of list) byReason.set(f.reason, (byReason.get(f.reason) || 0) + 1);
  const parts = [...byReason.entries()].sort().map(([r, n]) => `${r}×${n}`);
  return `${list.length} suggestion call(s) failed to parse (${parts.join(', ')}) — these produced NO link suggestions, which is not the same as finding none.`;
}
