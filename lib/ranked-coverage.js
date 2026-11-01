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
// THE THREE TIERS
// ─────────────────────────────────────────────────────────────────────────────
//   AUTO_COVERED       tier 1, `exact`. The candidate IS a ranked query for an
//                      existing page, above both floors. Measured
//                      false-positive rate on the live calendar: zero. Treat as
//                      mapped, silently.
//
//   POSSIBLE_DUPLICATE tier 2, `ranked_phrase`. A ranked query above the floors
//                      is a substring of the candidate (the tattoo shape). NOT
//                      dropped, NOT treated as mapped. Emitted with its
//                      evidence — page, query, position, impressions — so it is
//                      visible as a DECISION. This is the pattern PR #911 and
//                      PR #914 merged: when automation cannot decide, surface it
//                      rather than act.
//
//   POSSIBLE_DUPLICATE tier 3, `authored_semantic`. The candidate is a near
//                      duplicate, by token-set similarity, of a keyword somebody
//                      AUTHORED on an existing brief or post. See the section
//                      below for why this is a third tier and not a widening of
//                      tier 2. Flagged, never auto-covered — semantic similarity
//                      is the weakest of the three signals, so it gets the
//                      weakest consequence, and a test pins that this tier can
//                      never return AUTO_COVERED.
//
// PRECEDENCE is exact → ranked phrase → authored semantic, and it is the order
// of how directly the evidence answers "is this already covered". Only tier 1
// may cover silently. Every match carries a `tier` so a reader can tell "a page
// RANKS for this exact query" from "this LOOKS LIKE an existing brief" — the
// remedies differ (the first is finished work, the second is a judgement call
// between two phrasings nobody has published yet).
//
// Nothing here may DROP a candidate. The strongest thing the flagged tiers do
// downstream is demote a row below the clean ones inside an existing cap, which
// is the `lib/ctr-opportunity.js` doctrine ("it DEMOTES and never drops").
//
// ─────────────────────────────────────────────────────────────────────────────
// TIER 3 — THE RESIDUAL GAP THE RANKED TIERS CANNOT SEE
// ─────────────────────────────────────────────────────────────────────────────
// Verified live, the two ranked tiers drop 15 of 17 candidate topics, all of
// which already rank on page 1. The survivor `"best soap to clean new tattoo"`
// is a near-duplicate of the tattoo flagship, whose authored target keyword is
// `"best soap to use on new tattoo"`. They differ by ONE WORD IN THE MIDDLE, so
// no substring rule in either direction sees it — and the winner does not rank
// for either phrasing above the floors, so tier 1 cannot see it either. It is
// the same shape as the duplicate article retired in PR #912, which means the
// two ranked tiers alone would not have prevented that incident via this
// phrasing.
//
// So tier 3 asks a different question of a different corpus: not "what does a
// page RANK for" (GSC) but "what has somebody already DECIDED to write about"
// (the authored `target_keyword` on every brief and post). A near-duplicate of
// an authored keyword is a planning collision, which is precisely what the
// ranked tiers are blind to — a brief that has not been drafted yet ranks for
// nothing at all.
//
// THE SIMILARITY FUNCTION IS NOT NEW. `findSemanticDuplicate` from
// `lib/cannibalization-guard.js` is reused whole, including its
// `differentSegments` guard ("natural deodorant for women" vs "…for men" is a
// deliberate segment split, not a duplicate) — which is exactly the
// false-positive class this tier risks.
//
// THE THRESHOLD IS NOT NEW EITHER. `lib/calendar-coverage.js` already calls that
// function at 0.6 in two places, so 0.6 is the established fleet default and
// adopting it keeps ONE value rather than introducing a second. Measured against
// the production corpus (211 authored covered keywords, 734 currently-unmapped
// queries):
//
//   threshold | catches the residual gap?          | newly flagged of 734
//   ----------|------------------------------------|---------------------
//   0.5       | yes                                | 397
//   0.6       | YES                                | 235
//   0.7       | NO — the gap escapes               | 119
//   0.8       | no                                 | 40
//
// The residual gap measures EXACTLY 0.60 (`{soap, clean, new, tattoo}` against
// `{soap, use, new, tattoo}` after stopword removal — 3 shared of 5 union), so it
// sits ON the threshold and is caught only because the comparison is `>=`. Read
// that as the reason 0.6 is a floor and not a starting point: any tightening at
// all, by any amount, loses the one case this tier was built for. A test pins
// both halves — caught at 0.6, missed at 0.7 — so raising it fails loudly rather
// than quietly returning the corpus to the state PR #912 cleaned up.
//
// FAIL-OPEN. A missing, empty or unreadable snapshot set degrades to TODAY'S
// behaviour — authored keywords only, nothing extra covered — never to
// "everything is covered", which would silently stop all content proposals.
// `available: false` plus a `disarmed` reason, so a gate that quietly stopped
// gating is not byte-identical to one with nothing to say (same rule as
// `hold.disarmed` and `efficiencyBanner()`).
//
// FAIL-OPEN APPLIES TO TIER 3 TOO. An unreadable, empty or absent authored
// covered set degrades to the behaviour without it — nothing extra flagged —
// never to "everything is covered". `authoredAvailable: false` plus its own
// `disarmed` reason, because a semantic tier that quietly stopped comparing
// renders byte-identically to one with nothing to compare against.
//
// No I/O. Snapshots, the authored keyword set and slug resolution are all
// injected, because importing `agents/*/index.js` RUNS the agent and this has to
// be testable.

import { findSemanticDuplicate, similarity } from './cannibalization-guard.js';

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

/**
 * Tier 3's similarity floor. NOT a new number — `lib/calendar-coverage.js`
 * already calls `findSemanticDuplicate` at 0.6 in two places, so this is the
 * fleet default adopted rather than a second value invented. The measured table
 * behind it, and why it is a floor rather than a starting point, is in the
 * header above. Do not raise it without re-running that measurement.
 */
export const SEMANTIC_THRESHOLD = 0.6;

export const AUTO_COVERED = 'auto_covered';
export const POSSIBLE_DUPLICATE = 'possible_duplicate';
export const UNCOVERED = 'uncovered';

/** Which tier produced a match. Carried on every match object and every verdict. */
export const TIER_EXACT = 'exact';
export const TIER_RANKED_PHRASE = 'ranked_phrase';
export const TIER_AUTHORED_SEMANTIC = 'authored_semantic';

/**
 * Lowercase, collapse whitespace, trim. Deliberately NOT punctuation-stripping
 * or stemming: every extra normalisation widens matching, and widening is the
 * direction that kills planned content.
 */
export function normalizeQuery(str) {
  return String(str ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * The slug a keyword would be filed under — the same normalisation the ideas
 * inbox uses, and the basis of self-match comparison.
 *
 * It lives here rather than in the agent because BOTH sides of the self-match
 * test have to use one spelling: the candidate's own slug is derived from its
 * keyword this way, so an authored entry's keyword has to be derived the same
 * way or a brief cannot recognise itself. `agents/gsc-opportunity` re-exports
 * this rather than keeping a second copy.
 */
export function slugifyKeyword(str) {
  return String(str ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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

/**
 * Build the AUTHORED-coverage lookup tier 3 reads: every `target_keyword`
 * somebody wrote on a brief or a post, with the slug it was written on.
 *
 * The slug is what makes self-match possible, and it is carried TWICE on
 * purpose. `slug` is where the thing actually lives (`data/briefs/x.json`,
 * `data/posts/x/`); `keywordSlug` is what that entry's keyword would slugify to.
 * A candidate's own slug is derived from its KEYWORD, so comparing only against
 * the file slug misses a brief recognising itself whenever the two differ —
 * which they do the moment punctuation is involved
 * ("best schmidt's deodorant alternatives" → `best-schmidt-s-…`, filed at
 * `best-schmidts-…`). Both of the two candidates that first read as false
 * positives on the live pool turned out to be exactly this: existing briefs
 * matching THEMSELVES. Self-match handling, not a threshold tweak, is what keeps
 * this tier honest.
 *
 * @param {Array<{keyword:string, slug?:string|null, source?:string}>} entries
 * @returns {{available:boolean, disarmed:string|null, entries:Array<object>,
 *            considered:number}}
 */
export function buildAuthoredIndex(entries = []) {
  const all = Array.isArray(entries) ? entries : [];
  const out = [];
  const seen = new Set();
  for (const e of all) {
    const keyword = normalizeQuery(typeof e === 'string' ? e : e?.keyword);
    if (!keyword) continue;
    const slug = (typeof e === 'string' ? null : e?.slug) || null;
    const source = (typeof e === 'string' ? null : e?.source) || null;
    // One row per keyword+slug pair: the same keyword on a brief AND its post is
    // one decision, not two, and would otherwise double-count in the evidence.
    const key = `${keyword}|${slug ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ keyword, slug, source, keywordSlug: slugifyKeyword(keyword) });
  }

  // FAIL OPEN, LOUDLY — same rule and same reason as the ranked index. An empty
  // authored set flags nothing; it never covers everything.
  const disarmed = out.length
    ? null
    : 'no authored target keywords — semantic duplicate detection is OFF this run';

  return { available: out.length > 0, disarmed, entries: out, considered: all.length };
}

/** Strongest first: a bigger query is better evidence than a bigger rank. */
function strongest(list) {
  return [...list].sort((a, b) => b.impressions - a.impressions || a.position - b.position)[0] || null;
}

/** Stamp the tier onto a match so a reader can tell which signal fired. */
const tag = (tier) => (m) => (m ? { ...m, tier } : m);

/**
 * Classify one candidate keyword against the ranked index.
 *
 * `selfSlug` is the local slug the candidate itself resolves to, and excluding
 * it is MANDATORY rather than a refinement. `lib/calendar-coverage.js` had to
 * solve the identical problem: on 2026-08-19 the coverage check cleared calendar
 * items as "already covered" by the very draft generated FROM them. A candidate
 * covered by its own page is not a duplicate — it is the same work, counted
 * twice. It is applied to ALL THREE tiers, never just the flagged ones, because
 * excluding it can only ever make this check less aggressive, and a topic whose
 * own post genuinely exists is already caught by the authored-keyword check that
 * runs first.
 *
 * The two indexes are INDEPENDENT. A disarmed ranked index does not switch tier 3
 * off, and an absent authored index does not switch tiers 1-2 off — each
 * degrades on its own, because they read different corpora and fail for
 * different reasons (no GSC snapshots on this box vs no briefs on this box).
 *
 * @param {string} keyword
 * @param {ReturnType<buildRankedIndex>} index
 * @param {{selfSlug?:string|null, authored?:ReturnType<buildAuthoredIndex>|null}} opts
 * @returns {{status:string, tier:string|null, match:object|null,
 *            matches:Array<object>, selfMatches:Array<object>, keyword:string}}
 */
export function classifyRankedCoverage(keyword, index, { selfSlug = null, authored = null } = {}) {
  const kw = normalizeQuery(keyword);
  const empty = { status: UNCOVERED, tier: null, match: null, matches: [], selfMatches: [], keyword: kw };
  if (!kw) return empty;

  const isSelf = (e) => Boolean(selfSlug) && Boolean(e.slug) && e.slug === selfSlug;
  const rankedReady = Boolean(index) && index.available === true && index.byQuery instanceof Map;
  const selfHits = [];

  if (rankedReady) {
    // TIER 1 — the candidate IS a ranked query for an existing page.
    const exact = index.byQuery.get(kw) || [];
    const exactOther = exact.filter((e) => !isSelf(e));
    if (exactOther.length) {
      return {
        status: AUTO_COVERED,
        tier: TIER_EXACT,
        match: tag(TIER_EXACT)(strongest(exactOther)),
        matches: exactOther.map(tag(TIER_EXACT)),
        selfMatches: exact.filter(isSelf).map(tag(TIER_EXACT)),
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
    for (const [query, list] of index.byQuery) {
      if (query === kw) continue;
      if (!containsPhrase(kw, query)) continue;
      for (const e of list) (isSelf(e) ? selfHits : hits).push(e);
    }
    if (hits.length) {
      return {
        status: POSSIBLE_DUPLICATE,
        tier: TIER_RANKED_PHRASE,
        match: tag(TIER_RANKED_PHRASE)(strongest(hits)),
        matches: hits.map(tag(TIER_RANKED_PHRASE)),
        selfMatches: selfHits.map(tag(TIER_RANKED_PHRASE)),
        keyword: kw,
      };
    }
  }

  // TIER 3 — the candidate is a near-duplicate of a keyword somebody AUTHORED.
  // POSSIBLE_DUPLICATE only: this tier may never return AUTO_COVERED, because
  // token-set similarity is the weakest evidence of the three and only an exact
  // ranked query is allowed to cover a candidate silently.
  const semantic = classifyAuthoredSemantic(kw, authored, isSelf);
  if (semantic.match) {
    return {
      status: POSSIBLE_DUPLICATE,
      tier: TIER_AUTHORED_SEMANTIC,
      match: semantic.match,
      matches: semantic.matches,
      selfMatches: [...selfHits.map(tag(TIER_RANKED_PHRASE)), ...semantic.selfMatches],
      keyword: kw,
    };
  }

  return { ...empty, selfMatches: [...selfHits.map(tag(TIER_RANKED_PHRASE)), ...semantic.selfMatches] };
}

/**
 * Tier 3's body, split out so the precedence above reads as three ordered
 * questions rather than one long function.
 *
 * `findSemanticDuplicate` is called on the ALREADY-FILTERED pool rather than on
 * everything, so a self-match can never win the tie and hide a real collision
 * behind it — the defect `lib/calendar-coverage.js` fixed by asking about the
 * exact keyword before computing any similarity. The score is recomputed with
 * the same module's `similarity` purely to put a number in the evidence; the
 * verdict is `findSemanticDuplicate`'s, including its `differentSegments` guard.
 */
function classifyAuthoredSemantic(kw, authored, isSelf) {
  const none = { match: null, matches: [], selfMatches: [] };
  if (!kw) return none;
  if (!authored || authored.available !== true || !Array.isArray(authored.entries)) return none;

  const isSelfAuthored = (e) => isSelf(e) || isSelf({ slug: e.keywordSlug });

  const pool = [];
  const selves = [];
  for (const e of authored.entries) (isSelfAuthored(e) ? selves : pool).push(e);

  const asMatch = (e) => ({
    tier: TIER_AUTHORED_SEMANTIC,
    keyword: e.keyword,
    slug: e.slug,
    source: e.source,
    similarity: similarity(kw, e.keyword),
    threshold: SEMANTIC_THRESHOLD,
  });

  // Self-matches are REPORTED, not discarded, so "we excluded its own brief" and
  // "nothing was similar" stay distinguishable.
  const selfMatches = selves
    .filter((e) => similarity(kw, e.keyword) >= SEMANTIC_THRESHOLD)
    .map(asMatch);

  const dup = findSemanticDuplicate(kw, pool.map((e) => e.keyword), { threshold: SEMANTIC_THRESHOLD });
  if (!dup) return { ...none, selfMatches };

  const matches = pool.filter((e) => e.keyword === dup).map(asMatch);
  return { match: matches[0] ?? null, matches, selfMatches };
}

/**
 * One description of a match, whichever tier produced it, so the console lines,
 * the markdown table and the digest body cannot drift apart.
 *
 * Detection prefers the explicit `tier` and falls back on shape, because a match
 * read back out of a previous run's `latest.json` predates the field.
 */
export function describeMatch(match) {
  if (!match) return null;
  const isSemantic = match.tier === TIER_AUTHORED_SEMANTIC
    || (match.tier == null && match.keyword != null && match.query == null);
  if (isSemantic) {
    const where = match.slug
      ? (match.source === 'brief' ? `data/briefs/${match.slug}.json` : `data/posts/${match.slug}`)
      : '(unlocated)';
    const score = Number.isFinite(match.similarity) ? match.similarity.toFixed(2) : '?';
    return {
      tier: TIER_AUTHORED_SEMANTIC,
      signal: 'authored keyword',
      matched: match.keyword,
      where,
      evidence: `similarity ${score} (core-token Jaccard, threshold ${SEMANTIC_THRESHOLD})`,
      line: `similar to the authored target keyword "${match.keyword}" on ${where} — similarity ${score}, threshold ${SEMANTIC_THRESHOLD}`,
    };
  }
  const where = match.slug ? `data/posts/${match.slug}` : (match.page || '(unlocated)');
  const position = Number.isFinite(match.position) ? match.position.toFixed(1) : '?';
  return {
    tier: match.tier || TIER_RANKED_PHRASE,
    signal: 'ranked query',
    matched: match.query,
    where,
    evidence: `position ${position}, ${match.impressions} impressions/${RANKED_WINDOW_DAYS}d`,
    line: `ranked query "${match.query}" already lands on ${where} — position ${position}, ${match.impressions} impressions/${RANKED_WINDOW_DAYS}d`,
  };
}

/**
 * Human-readable evidence lines for the console, the markdown report and the
 * digest body. A flagged row is only useful if a reader can re-examine the
 * verdict without re-running anything, so every line names WHICH SIGNAL fired
 * and where to go and look — the same reason `renderClearedLines` names
 * `data/posts/<slug>` rather than a bare keyword. The two flagged tiers need
 * different remedies (a page that already ranks is finished work; a near
 * duplicate of an authored keyword is a choice between two phrasings), so a
 * reader who cannot tell them apart cannot act on either.
 */
export function renderRankedCoverageLines(flagged = [], { max = 20 } = {}) {
  const lines = [];
  for (const f of (flagged || []).slice(0, max)) {
    const d = describeMatch(f?.match);
    if (!d) { lines.push(`  "${f?.keyword ?? ''}" — flagged, no evidence recorded`); continue; }
    lines.push(`  "${f.keyword}"`);
    lines.push(`      ${d.line}`);
  }
  if ((flagged || []).length > max) lines.push(`  (+${flagged.length - max} more)`);
  return lines;
}
