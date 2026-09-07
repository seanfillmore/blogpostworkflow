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
import { findSemanticDuplicate } from './cannibalization-guard.js';

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
/**
 * How close two questions must be to count as the same one. Reuses the fleet's
 * one similarity measure rather than a second copy — the same reason
 * lib/calendar-coverage.js imports it.
 *
 * MEASURED, not picked. The first real run drafted 10 answers for the deodorant
 * and EIGHT were one question asked eight ways — "can you use coconut oil as
 * deodorant", "can coconut oil be used as deodorant", "can i put coconut oil on
 * my armpits" — burning eight of thirty slots and producing eight near-identical
 * answers. Punctuation dedupe cannot see that; core-token overlap can.
 *
 * LOWER than calendar-coverage's 0.6, and the direction is deliberate because
 * the cost is inverted. There, over-merging silently KILLS planned content, so
 * it errs loose. Here the worst case of over-merging is one wasted slot of
 * thirty, while UNDER-merging wasted eight — so it errs aggressive.
 *
 * Measured against the real batch rather than picked. Against the 8 paraphrases
 * plus 4 genuinely-distinct questions from the first live run:
 *
 *   t     8 paraphrases ->   distinct kept
 *   0.30        2                4/4
 *   0.35        2                4/4     <- chosen
 *   0.40        3                4/4
 *   0.60        4                4/4
 *   0.70        6                4/4     (the first attempt; barely worked)
 *
 * 0.35 gets the full collapse and 0.30 also keeps 4/4, so it sits inside a band
 * rather than on an edge. It stops at 2 rather than 1 honestly: "is coconut oil
 * good for armpits" really is a different phrasing group from "…as deodorant",
 * and merging those two would be over-merging.
 */
export const SAME_QUESTION_THRESHOLD = 0.35;

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
  // Collapse PARAPHRASES after exact-spelling dedupe, strongest first so the
  // survivor is the phrasing with the most impressions. Impressions are summed
  // onto it for the same reason spellings are: the demand is one question's,
  // however it was typed.
  const ranked = [...seen.values()].sort((a, b) => b.impressions - a.impressions);
  const kept = [];
  for (const q of ranked) {
    const dup = findSemanticDuplicate(q.query, kept.map((k) => k.query), { threshold: SAME_QUESTION_THRESHOLD });
    if (dup) {
      kept.find((k) => k.query === dup).impressions += q.impressions;
      continue;
    }
    kept.push({ ...q });
  }

  return kept
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit)
    .map(({ query, impressions, clicks }) => ({ query, impressions, clicks }));
}

/**
 * Brands a buyer names in search. Seeded from config/competitors.json so the
 * fleet's tracked set is honoured, then EXTENDED from the data — that config
 * holds five natural-DTC brands for content monitoring and only ONE of them
 * ("Native") appears in a real question, while the queries are dominated by
 * mass-market names it was never meant to cover.
 *
 * Measured over 28 GSC snapshots: 70 of 586 questions name a competitor,
 * carrying 3,412 impressions — 21% of all question impressions. Toothpaste's
 * top THREE are Sensodyne and Colgate SLS lookups.
 */
export const COMPETITOR_BRANDS = Object.freeze([
  'sensodyne', 'pronamel', 'colgate', 'crest', "tom's of maine", 'arm & hammer',
  'burt\'s bees', 'vaseline', 'chapstick', 'carmex', 'eos', 'aquaphor',
  'cerave', 'dove', 'native', "schmidt's", 'lume', 'secret', 'degree',
  'old spice', 'piperwai', 'weleda', 'captain blankenship', 'dr bronner',
  "dr. bronner", 'shea moisture', 'sheamoisture',
]);

const COMPETITOR_RE = new RegExp(`\\b(${COMPETITOR_BRANDS
  .map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['\u2019]"))
  .join('|')})\\b`, 'i');

/** "how to make X" — a reader building their own is not a reader buying one. */
const DIY_RE = /\b(how (to|do i|do you) make|diy|homemade|home made|make your own|recipe for)\b/i;

/**
 * Questions that must never take one of a product's 30 slots.
 *
 * BOTH are dropped for reasons that are about the SLOT, not the question.
 *
 * COMPETITOR-FACT questions ("does sensodyne have sodium lauryl sulfate") ask
 * for a fact about somebody else's product. We cannot answer them accurately —
 * the live AI Overview for that one cites sensodyne.com and pronamel.us and
 * enumerates their SKUs — and answering about a rival inside our own product
 * feed is the same thing `agents/editor`'s rule 8 already treats as a BLOCKER
 * for FAQ content. Consistency with that rule is the point.
 *
 * DIY questions ("how to make natural moisturizer", 3,165 impressions and the
 * single biggest question in the corpus) have anti-commercial intent by
 * construction: the reader is assembling shea butter and a double boiler. Its
 * AI Overview is a recipe with numbered steps — a shape a product Q&A cannot
 * and should not match.
 *
 * THE ASYMMETRY IS WHY THIS MATTERS. They are only 13.5% of questions but 42%
 * of impressions, and slots are filled in impression order — so unfiltered they
 * take the BEST slots, not the leftover ones.
 */
export function isUnsuitableQuestion(query) {
  const q = String(query ?? '');
  if (COMPETITOR_RE.test(q)) return 'competitor-fact';
  if (DIY_RE.test(q)) return 'diy';
  return null;
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
  const unsuitable = [];
  for (const q of questions ?? []) {
    // Dropped BEFORE clustering and before the cap, so an unsuitable question
    // can never occupy a slot it would otherwise have won on impressions.
    const why = isUnsuitableQuestion(q.query);
    if (why) { unsuitable.push({ ...q, reason: why }); continue; }
    const cluster = assignCluster(q.query);
    const handles = cluster ? (productClusters[cluster] ?? []) : [];
    if (!handles.length) { unassigned.push({ ...q, cluster: cluster ?? null }); continue; }
    for (const handle of handles) {
      if (!byHandle.has(handle)) byHandle.set(handle, []);
      byHandle.get(handle).push({ ...q, cluster });
    }
  }
  for (const list of byHandle.values()) list.splice(MAX_PAIRS_PER_PRODUCT);
  return { byHandle, unassigned, unsuitable };
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
