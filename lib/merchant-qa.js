/**
 * Build Google Merchant Center `question_and_answer` feed values from real
 * buyer questions.
 *
 * WHY THIS FIELD AND NOT MORE PRODUCT DATA. `agents/product-schema` and the
 * 2026-08-18 taxonomy work already filled every completeness attribute, and that
 * was TESTED AND FALSIFIED on 2026-08-19 against the Shopify Catalog: listing
 * completeness read "4 of 4 checks passed" both before and after, and the two
 * probe queries still missed the top 10. We are outranked on reviews and sales
 * velocity, not excluded on data.
 *
 * `question_and_answer` is different in kind, and that is the whole argument for
 * doing it. It is not a checkbox Google already scores — it is up to 30 buyer
 * questions and our answers, content that exists nowhere in the feed today, on a
 * DIFFERENT surface (Merchant Center → AI Overview / AI Mode) from the one that
 * falsification measured. See `marketing-ai-search-visibility`.
 *
 * **It is still unproven.** Nothing Google publishes establishes that these
 * attributes move a ranking, and `popularity_rank` — the one that sounds like a
 * ranking lever — is self-asserted relative to your OWN catalogue, so it cannot
 * touch the incumbent problem at all. Build it because it is cheap and the
 * questions are already measured, not because it is expected to fix visibility.
 *
 * THE QUESTIONS ARE MEASURED, NOT INVENTED. They come from GSC: queries real
 * people typed that earned this store an impression. That matters twice — the
 * phrasing is theirs rather than our marketing vocabulary, and a question nobody
 * asks cannot be worth one of 30 slots.
 */

import { assignCluster } from './keyword-index/cluster.js';

/** Google caps this attribute at 30 pairs per product. */
export const MAX_PAIRS_PER_PRODUCT = 30;
/** …and 1,000 characters for each side of a pair. */
export const MAX_SIDE_CHARS = 1000;

/**
 * A query counts as a question when it opens with an interrogative or carries a
 * question mark. Deliberately generous on the opener list and deliberately NOT
 * clever: the cost of a false positive is one wasted slot a human reviews, while
 * a false negative silently drops a real buyer question.
 */
const QUESTION_OPENERS = /^(what|how|why|when|where|which|who|is|are|was|were|does|do|did|can|could|should|will|would|has|have|may|might)\b/i;

export function isQuestionQuery(query) {
  const q = String(query ?? '').trim();
  if (!q) return false;
  return q.includes('?') || QUESTION_OPENERS.test(q);
}

/**
 * Normalize for DEDUPE only — never for output. GSC returns the same question
 * with and without a curly apostrophe and with different casing
 * ("are natural bar soaps better for men's daily cleansing?" appeared twice in
 * one snapshot, differing only in U+2019 vs U+0027), and shipping both would
 * spend two of thirty slots on one question.
 */
export function dedupeKey(query) {
  return String(query ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Collect question-shaped queries from GSC rows, strongest first.
 *
 * Ranked by IMPRESSIONS rather than clicks: the job is to answer what people
 * ASK, and a question that earned impressions and no clicks is if anything a
 * better candidate — it is demand this store is visible for and failing to
 * satisfy. Ranking by clicks would select the questions already working.
 */
export function extractQuestions(rows, { limit = Infinity } = {}) {
  const seen = new Map();
  for (const row of rows ?? []) {
    const query = row.query ?? row.keys?.[0];
    if (!query || !isQuestionQuery(query)) continue;
    const impressions = Number(row.impressions ?? 0);
    const key = dedupeKey(query);
    const prev = seen.get(key);
    // Keep the highest-impression spelling of a duplicated question, and sum the
    // impressions across spellings so a question split over two encodings is not
    // ranked below one that never was.
    if (prev) {
      prev.impressions += impressions;
      if (impressions > prev.best) { prev.best = impressions; prev.query = query; }
      continue;
    }
    seen.set(key, { query, impressions, best: impressions, clicks: Number(row.clicks ?? 0) });
  }
  return [...seen.values()]
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit)
    .map(({ query, impressions, clicks }) => ({ query, impressions, clicks }));
}

/**
 * Route each question to a product by cluster.
 *
 * Uses the fleet's single cluster taxonomy rather than matching product titles,
 * because a buyer asks "is coconut oil toothpaste effective" and never "is the
 * Coconut Oil Toothpaste 4oz effective". A question that maps to no cluster, or
 * to a cluster no product in the catalogue covers, is DROPPED and counted —
 * `brand`, `hair` and `unclustered` all resolve to nothing on purpose.
 */
export function assignQuestionsToProducts(questions, productClusters) {
  const byHandle = new Map();
  const unassigned = [];
  for (const q of questions ?? []) {
    const cluster = assignCluster(q.query);
    const handles = cluster ? (productClusters[cluster] ?? []) : [];
    if (!handles.length) { unassigned.push({ ...q, cluster: cluster ?? null }); continue; }
    for (const handle of handles) {
      if (!byHandle.has(handle)) byHandle.set(handle, []);
      byHandle.get(handle).push({ ...q, cluster });
    }
  }
  for (const list of byHandle.values()) list.splice(MAX_PAIRS_PER_PRODUCT);
  return { byHandle, unassigned };
}

/**
 * Render the feed value: `"Question":"Answer", "Question":"Answer"`.
 *
 * A double quote inside either side would terminate its own field and silently
 * corrupt every pair after it, so quotes are converted rather than escaped —
 * Google's format documents no escape sequence, and inventing one would produce
 * a value that parses differently than intended. Curly quotes read correctly to
 * a human and cannot break the delimiter.
 */
export function formatQuestionAnswer(pairs) {
  // Quotes are converted in matched PAIRS — open, close, open, close — so
  // `"natural"` reads as `“natural”` rather than two opening marks. Getting
  // this wrong is invisible in the feed and only shows up in a rendered answer.
  const clean = (value) => {
    let open = true;
    return String(value ?? '')
      .replace(/"/g, () => (open = !open) ? '”' : '“')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_SIDE_CHARS);
  };
  return (pairs ?? [])
    .slice(0, MAX_PAIRS_PER_PRODUCT)
    .map((p) => `"${clean(p.question)}":"${clean(p.answer)}"`)
    .join(', ');
}

/**
 * A supplemental feed is `id` plus only the columns it supplies — it must NOT
 * restate title, price or availability, or a stale copy here silently overwrites
 * the primary feed's live values.
 */
export function renderSupplementalTsv(rows) {
  const lines = ['id\tquestion_and_answer'];
  for (const r of rows ?? []) {
    // A literal tab or newline inside a value would shift every later column.
    const value = String(r.questionAndAnswer ?? '').replace(/[\t\r\n]+/g, ' ');
    lines.push(`${r.id}\t${value}`);
  }
  return lines.join('\n') + '\n';
}
