// lib/ranked-coverage.js
//
// "Does an existing page already RANK for this topic?" — asked of the queries a
// page really earns impressions on, not of the single `target_keyword` somebody
// typed into its brief.
//
// WHY THIS EXISTS
// ───────────────
// On 2026-09-06 `calendar-runner` spent a full paid pipeline (research, writing,
// images, schema, publish) on
// `best-soap-for-tattoos-what-to-use-for-safe-healing-3` — a THIRD-generation
// duplicate of the site's single biggest CTR opportunity, the `-2` article at
// position ~8 on ~37,531 impressions/90d. Retired in PR #912.
//
// The cause is `agents/gsc-opportunity`'s coverage model. `loadCoveredKeywords`
// collects ONE `target_keyword` per post/brief into a flat Set and `isMapped`
// does bidirectional substring against it. The winner's target keyword is
// "best soap to use on new tattoo"; the duplicate's was
// "best soap for tattoos what to use for safe healing". Neither string contains
// the other, so the topic read as UNMAPPED and was proposed as net-new.
//
// CLAUDE.md flags this area as dangerous, in terms worth repeating: widening
// coverage "would make every coverage check in the fleet MORE aggressive, which
// is precisely how planned content gets killed silently". Everything below is
// shaped by that. Two tiers, and only one of them is allowed to act.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE MEASUREMENT (2026-09-19, data/snapshots/gsc/, trailing 28 daily files)
// ─────────────────────────────────────────────────────────────────────────────
// 14,565 distinct query|page pairs over the window. 734 of the top 1,000 GSC
// queries read as UNMAPPED under the rule as it stands.
//
// 1. EXACT MATCHING ALONE WOULD NOT HAVE PREVENTED THE INCIDENT. The duplicate's
//    keyword, "best soap for tattoos what to use for safe healing", appears
//    NOWHERE as a ranked query in 28 days of GSC. Only the substring tier
//    reaches it, through the queries the winner actually ranks for
//    ("best soap for tattoos", "best soap for tattoo", "soap for tattoos").
//
// 2. pos <= 10 IS TOO TIGHT — it misses a page's own best queries. The winner's
//    `soap for tattoos` sits at 10.3 and `best soap for tattoo` at 11.5
//    (impression-weighted over the window; on an unweighted daily mean the same
//    two read 13.3 and 14.9, and its single biggest query `best soap for
//    tattoos` reads 11.2 where the weighted figure is 9.1). The choice of
//    aggregation moves the numbers; it does not move the verdict, because under
//    EITHER basis a position-10 floor drops queries the winner genuinely owns.
//    RANKED_POS_MAX = 20 is the first floor that holds the page's own cluster
//    together under both.
//
// 3. EXACT MATCHING ON RANKED QUERIES IS MEASURABLY SAFE. At every floor tested,
//    calendar items newly dropped by SUBSTRING was 0 and by EXACT was 18–20 —
//    and all 18 are genuine duplicates: ~12 near-identical phrasings of SLS-free
//    toothpaste ("sls-free toothpaste", "toothpaste sls free", "toothpaste with
//    no sls", …) for a topic where `toothpaste-without-sls` is already a locked
//    winner at 102,816 impressions/90d, plus junk like "yes" and the brand
//    navigational "realskin".
//
// 4. SUBSTRING IS WHERE THE RISK LIVES, AND IT IS NARROW. At pos <= 20,
//    impressions >= 50 it newly matches 7 briefs. Inspected one by one, most are
//    SELF-MATCHES — a post's own brief matched by that same post's ranked
//    queries ("when was deodorant invented a complete history" ← ranked "when
//    was deodorant invented"). Those are not duplicates, they are the same work,
//    and `selfSlug` excludes them. TWO are genuine FALSE POSITIVES, where a
//    short generic ranked query swallows a legitimately distinct topic:
//
//      "best schmidt's deodorant alternatives"  ← ranked "deodorant alternatives"
//      "coconut oil deodorant for men"          ← ranked "coconut oil deodorant"
//
//    A third, smaller noise source is recorded rather than filtered: 27 of the
//    335 ranked queries above the floors are one or two tokens, and one of them
//    is literally `"yes"` (177 impressions, position 4.0, on
//    `toothpaste-without-sls`). A candidate carrying that word is therefore
//    flagged. It is left alone on purpose — a minimum token length is a
//    threshold nobody measured, the measurement above was taken WITHOUT one, and
//    the cost of the noise is one flagged row a human reads, never a dropped
//    topic. On the EXACT tier the same query is the finding rather than the
//    noise: "yes" is junk we should not be proposing as a new topic.
//
//    Separating those lexically was tried and REJECTED: Jaccard on core tokens
//    scores the correct catch ("…what to use for safe healing" vs "best soap for
//    tattoos" = 0.5) identically to the false positive ("best schmidt's
//    deodorant alternatives" vs "deodorant alternatives" = 0.5). No purely
//    lexical rule cleanly separates "adds intent words" from "adds a
//    distinguishing entity" — so automation does not get to decide this one.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TWO TIERS
// ─────────────────────────────────────────────────────────────────────────────
//   AUTO_COVERED       the candidate IS a ranked query for an existing page,
//                      above both floors. Measured false-positive rate on the
//                      live calendar: zero. Treat as mapped, silently.
//
//   POSSIBLE_DUPLICATE a ranked query above the floors is a substring of the
//                      candidate (the tattoo shape). NOT dropped, NOT treated as
//                      mapped. Emitted with its evidence — page, query, position,
//                      impressions — so it is visible as a DECISION. This is the
//                      pattern PR #911 and PR #914 merged: when automation cannot
//                      decide, surface it rather than act.
//
// Nothing here may DROP a candidate. The strongest thing the flagged tier does
// downstream is demote a row below the clean ones inside an existing cap, which
// is the `lib/ctr-opportunity.js` doctrine ("it DEMOTES and never drops").
//
// FAIL-OPEN. A missing, empty or unreadable snapshot set degrades to TODAY'S
// behaviour — authored keywords only, nothing extra covered — never to
// "everything is covered", which would silently stop all content proposals.
// `available: false` plus a `disarmed` reason, so a gate that quietly stopped
// gating is not byte-identical to one with nothing to say (same rule as
// `hold.disarmed` and `efficiencyBanner()`).
//
// No I/O. Snapshots and slug resolution are injected, because importing
// `agents/*/index.js` RUNS the agent and this has to be testable.

/**
 * How many trailing daily GSC snapshots the index is built from.
 *
 * 28 days, matching the window every other CTR/coverage measurement in the fleet
 * uses (`lib/ctr-cohort.js`, `meta-ab-checker`'s `getPagePerformance(url, 28)`).
 * Shorter and a page's long-tail queries fall below the impression floor on
 * noise alone; longer and queries a page has since lost still read as coverage.
 */
export const RANKED_WINDOW_DAYS = 28;

/**
 * Position floor. See finding 2 in the header: at 10 the winner's own
 * `soap for tattoos` (10.3) and `best soap for tattoo` (11.5) fall out, so the
 * page stops covering the topic it demonstrably owns. 20 is page two — beyond
 * it a "ranking" is not evidence of anything.
 */
export const RANKED_POS_MAX = 20;

/**
 * Impression floor over the whole window. Below it a query is a handful of
 * impressions and the averaged position is noise. It is the same floor
 * `agents/gsc-opportunity` already applies to a query before it is allowed to
 * become a topic candidate (`UNMAPPED_MIN_IMPRESSIONS`), so the two sides of the
 * comparison are held to one standard rather than two.
 */
export const RANKED_MIN_IMPRESSIONS = 50;

export const AUTO_COVERED = 'auto_covered';
export const POSSIBLE_DUPLICATE = 'possible_duplicate';
export const UNCOVERED = 'uncovered';

/**
 * Lowercase, collapse whitespace, trim. Deliberately NOT punctuation-stripping
 * or stemming: every extra normalisation widens matching, and widening is the
 * direction that kills planned content.
 */
export function normalizeQuery(str) {
  return String(str ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Is `needle` a whole-word phrase inside `haystack`? Both must already be
 * normalised. Space-padding is what stops "oil" matching inside "boiling".
 */
function containsPhrase(haystack, needle) {
  if (!haystack || !needle) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

/**
 * Roll daily `queriesByPage[]` rows up into one row per query|page pair.
 *
 * Position is IMPRESSION-WEIGHTED, which is how GSC itself aggregates: a day on
 * which a query drew two impressions must not carry the same weight as a day it
 * drew two hundred. The header records what the unweighted daily mean says for
 * the same queries, and that the threshold choice survives either.
 *
 * @param {Array<{queriesByPage?: Array<object>}>} snapshots  parsed daily files
 * @returns {Array<{query:string, page:string, clicks:number, impressions:number,
 *                  position:number, days:number}>}
 */
export function aggregateRankedQueries(snapshots = []) {
  const agg = new Map();
  for (const snap of Array.isArray(snapshots) ? snapshots : []) {
    const rows = snap?.queriesByPage;
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      const query = normalizeQuery(r?.query);
      const page = String(r?.page ?? '').trim();
      if (!query || !page) continue;
      const impressions = Number(r?.impressions) || 0;
      const key = `${query}|${page}`;
      let a = agg.get(key);
      if (!a) {
        a = { query, page, clicks: 0, impressions: 0, position: 0, days: 0, _posWeighted: 0 };
        agg.set(key, a);
      }
      a.clicks += Number(r?.clicks) || 0;
      a.impressions += impressions;
      a._posWeighted += (Number(r?.position) || 0) * impressions;
      a.days += 1;
    }
  }
  const out = [];
  for (const a of agg.values()) {
    // No impressions at all → no weighted position to compute. Such a row can
    // never clear RANKED_MIN_IMPRESSIONS anyway; position 0 would read as
    // "rank 0", which is better left explicit than plausible.
    a.position = a.impressions > 0 ? a._posWeighted / a.impressions : Number.POSITIVE_INFINITY;
    delete a._posWeighted;
    out.push(a);
  }
  return out;
}

/**
 * Build the lookup the two tiers read.
 *
 * @param {Array<object>} rows  output of `aggregateRankedQueries`
 * @param {{posMax?:number, minImpressions?:number, pageSlug?:(page:string)=>string|null}} opts
 *        `pageSlug` maps a live URL to the LOCAL post slug. A Shopify article
 *        handle is not always the local slug (the tattoo winner lives in
 *        `data/posts/best-soap-for-tattoos/` behind the handle
 *        `best-soap-for-tattoos-what-to-use-for-safe-healing`), which is why
 *        resolution is injected rather than assumed to be the last path segment.
 * @returns {{available:boolean, disarmed:string|null, entries:Array<object>,
 *            byQuery:Map<string, Array<object>>, considered:number}}
 */
export function buildRankedIndex(rows = [], {
  posMax = RANKED_POS_MAX,
  minImpressions = RANKED_MIN_IMPRESSIONS,
  pageSlug = () => null,
} = {}) {
  const all = Array.isArray(rows) ? rows : [];
  const entries = [];
  for (const r of all) {
    const query = normalizeQuery(r?.query);
    const page = String(r?.page ?? '').trim();
    if (!query || !page) continue;
    const impressions = Number(r?.impressions) || 0;
    const position = Number(r?.position);
    if (!Number.isFinite(position)) continue;
    if (impressions < minImpressions) continue;
    if (position > posMax) continue;
    let slug = null;
    try { slug = pageSlug(page) || null; } catch { slug = null; }
    entries.push({
      query,
      page,
      slug,
      clicks: Number(r?.clicks) || 0,
      impressions,
      position,
    });
  }

  const byQuery = new Map();
  for (const e of entries) {
    const list = byQuery.get(e.query);
    if (list) list.push(e);
    else byQuery.set(e.query, [e]);
  }

  // FAIL OPEN, LOUDLY. An empty index means "nothing extra is covered", which is
  // exactly today's behaviour — never "everything is covered".
  let disarmed = null;
  if (!all.length) disarmed = 'no GSC snapshot rows — ranked-query coverage is OFF this run (authored keywords only)';
  else if (!entries.length) disarmed = `no ranked query cleared position <= ${posMax} and >= ${minImpressions} impressions — ranked-query coverage is OFF this run (authored keywords only)`;

  return { available: entries.length > 0, disarmed, entries, byQuery, considered: all.length };
}

/** Strongest first: a bigger query is better evidence than a bigger rank. */
function strongest(list) {
  return [...list].sort((a, b) => b.impressions - a.impressions || a.position - b.position)[0] || null;
}

/**
 * Classify one candidate keyword against the ranked index.
 *
 * `selfSlug` is the local slug the candidate itself resolves to, and excluding
 * it is MANDATORY rather than a refinement. `lib/calendar-coverage.js` had to
 * solve the identical problem: on 2026-08-19 the coverage check cleared calendar
 * items as "already covered" by the very draft generated FROM them. A candidate
 * covered by its own page is not a duplicate — it is the same work, counted
 * twice. It is applied to BOTH tiers, never just the flagged one, because
 * excluding it can only ever make this check less aggressive, and a topic whose
 * own post genuinely exists is already caught by the authored-keyword check that
 * runs first.
 *
 * @param {string} keyword
 * @param {ReturnType<buildRankedIndex>} index
 * @param {{selfSlug?:string|null}} opts
 * @returns {{status:string, match:object|null, matches:Array<object>,
 *            selfMatches:Array<object>, keyword:string}}
 */
export function classifyRankedCoverage(keyword, index, { selfSlug = null } = {}) {
  const kw = normalizeQuery(keyword);
  const empty = { status: UNCOVERED, match: null, matches: [], selfMatches: [], keyword: kw };
  if (!kw) return empty;
  if (!index || index.available !== true || !(index.byQuery instanceof Map)) return empty;

  const isSelf = (e) => Boolean(selfSlug) && Boolean(e.slug) && e.slug === selfSlug;

  // TIER 1 — the candidate IS a ranked query for an existing page.
  const exact = index.byQuery.get(kw) || [];
  const exactOther = exact.filter((e) => !isSelf(e));
  if (exactOther.length) {
    return {
      status: AUTO_COVERED,
      match: strongest(exactOther),
      matches: exactOther,
      selfMatches: exact.filter(isSelf),
      keyword: kw,
    };
  }

  // TIER 2 — a ranked query is contained IN the candidate. One direction only:
  // the candidate adds words to a phrase a page already owns. The reverse
  // (candidate contained in a ranked query) is the shape today's bidirectional
  // substring rule allows and is not adopted here — a page ranking for
  // "best natural deodorant for men" says nothing about whether "deodorant" is
  // covered.
  const hits = [];
  const selfHits = [];
  for (const [query, list] of index.byQuery) {
    if (query === kw) continue;
    if (!containsPhrase(kw, query)) continue;
    for (const e of list) (isSelf(e) ? selfHits : hits).push(e);
  }
  if (hits.length) {
    return { status: POSSIBLE_DUPLICATE, match: strongest(hits), matches: hits, selfMatches: selfHits, keyword: kw };
  }

  return { ...empty, selfMatches: selfHits };
}

/**
 * Human-readable evidence lines for the console, the markdown report and the
 * digest body. A flagged row is only useful if a reader can re-examine the
 * verdict without re-running anything, so every line names the page, the ranked
 * query, its position and its impressions — the same reason
 * `renderClearedLines` names `data/posts/<slug>` rather than a bare keyword.
 */
export function renderRankedCoverageLines(flagged = [], { max = 20 } = {}) {
  const lines = [];
  for (const f of (flagged || []).slice(0, max)) {
    const m = f?.match;
    if (!m) { lines.push(`  "${f?.keyword ?? ''}" — flagged, no evidence recorded`); continue; }
    lines.push(`  "${f.keyword}"`);
    lines.push(`      ranked query "${m.query}" already lands on ${m.slug ? `data/posts/${m.slug}` : m.page} — position ${m.position.toFixed(1)}, ${m.impressions} impressions/${RANKED_WINDOW_DAYS}d`);
  }
  if ((flagged || []).length > max) lines.push(`  (+${flagged.length - max} more)`);
  return lines;
}
