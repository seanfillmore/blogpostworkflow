// lib/citation-baseline-recompute.js
//
// Re-answer "were we cited?" over ALREADY-STORED ai-citation snapshots, once
// Gemini's grounding redirector has been resolved.
//
// WHY A SEPARATE, READ-ONLY PATH. `agents/ai-citation-tracker` now resolves the
// redirector before detection, so every snapshot from 2026-09-21 onward is
// right. That fixes nothing about the 11 snapshots already on disk — including
// **2026-09-20, the pre-outreach baseline for the 19 PR pitches sent on
// 2026-09-21**. If that baseline stays at `citation_rate.gemini = 0` then a
// Gemini citation won in November reads as no change at all, and a success is
// filed as a failure.
//
// `data/reports/ai-citations/*.json` is server-written and is the only copy of
// this history, so NOTHING here rewrites one. This module is pure; its caller
// (`scripts/recompute-citation-baseline.mjs`) is dry by default and writes only
// to its own report directory.
//
// ── THE RESULT IS A RANGE, AND THAT IS HONEST RATHER THAN EVASIVE ───────────
//
// `citation_rate` is computed over RUNS: `cited_runs / runs_with_citations`
// (see lib/citation-sampling.js). A stored cell keeps those two counts, but its
// `citation_urls` is the UNION across its runs — so a resolved brand URL proves
// at least ONE run cited us and says nothing about the other two. Hence:
//
//   lower bound  every newly-cited cell cited us in exactly 1 run
//   upper bound  every newly-cited cell cited us in all of its runs
//
// A cell sampled once has both bounds equal, so any snapshot at 1 run per cell
// recomputes EXACTLY; `exact` on each engine row says which case you have.
// Inventing a point estimate inside that range would be the same dishonesty as
// tuning a threshold until it produces the answer somebody wanted.
//
// Competitor tallies carry no such caveat: `top_competitor_citations` counts
// per CELL, not per run, so the recomputed figure is exact on every snapshot.
//
// ── TOKENS EXPIRE, SO THE RECOVERABLE WINDOW SHRINKS DAILY ──────────────────
//
// Measured 2026-09-21: 25-URL samples from 2026-08-16 and earlier resolve 0/25,
// while 2026-08-23 and later resolve 25/25. The redirect tokens live roughly 30
// days. An unresolved redirect is simply left in place — it matches neither the
// brand nor any competitor, i.e. exactly the pre-fix behaviour — and is COUNTED
// as `redirects_unresolved` so a run that recovered nothing cannot be mistaken
// for a run that found nothing.

import { applyResolvedUrls, detectBrandCited, detectCompetitorCitations, unresolvedRedirects } from './citation-detect.js';

/**
 * The citation URLs to judge a stored cell on.
 *
 * Preference order, and each fallback exists for a real snapshot shape:
 *  1. `citation_urls` with this run's resolutions substituted — the normal path.
 *  2. `citation_urls_resolved`, written by the fixed agent from 2026-09-21. It
 *     is what keeps a snapshot legible after its tokens expire, so it MUST be
 *     consulted before giving up on an unresolvable redirect.
 *  3. `citations` (bare domains) — snapshots before 2026-06-21 carry no URLs at
 *     all. The original detector's `includes(domain)` test works on a bare
 *     domain too, so this reproduces the stored verdict rather than dropping
 *     the engine to zero.
 *
 * @param {object} resp  one aggregated per-source record from a snapshot
 * @param {Map<string,string>|Object} resolved
 * @returns {string[]}
 */
export function citationUrlsForCell(resp, resolved) {
  const raw = resp?.citation_urls;
  if (Array.isArray(raw) && raw.length) {
    const applied = applyResolvedUrls(raw, resolved);
    const stored = resp?.citation_urls_resolved;
    if (Array.isArray(stored) && stored.length === applied.length) {
      // Prefer a stored resolution wherever this run could not resolve one.
      return applied.map((u, i) => (unresolvedRedirects([u]).length ? (stored[i] || u) : u));
    }
    return applied;
  }
  if (Array.isArray(resp?.citation_urls_resolved) && resp.citation_urls_resolved.length) {
    return resp.citation_urls_resolved;
  }
  return Array.isArray(resp?.citations) ? resp.citations : [];
}

/**
 * Normalize a stored cell's run counts across BOTH snapshot generations.
 *
 * Snapshots before repeated sampling (pre-2026-09) carry no `cited_runs` /
 * `runs_with_citations` at all; there, one cell IS one run and `cited` is the
 * whole answer. Reading `?? 0` on those — which is what `summarizeSources` does
 * for a live run — would zero out every early denominator and make the
 * "original" column disagree with the snapshot's own stored summary, which is
 * the one cross-check this module has.
 *
 * @returns {{citedRuns:number, citationDenominator:number}}
 */
export function cellCounts(resp) {
  if (typeof resp?.runs_with_citations === 'number') {
    return {
      citedRuns: resp.cited_runs || 0,
      citationDenominator: resp.runs_with_citations,
    };
  }
  if (resp?.cited === null || resp?.cited === undefined) {
    return { citedRuns: 0, citationDenominator: 0 };
  }
  return { citedRuns: resp.cited === true ? 1 : 0, citationDenominator: 1 };
}

const rate = (num, den) => (den > 0 ? parseFloat((num / den).toFixed(4)) : null);

/**
 * Recompute one snapshot's citation figures against a redirect resolution map.
 *
 * Returns BOTH the original and the corrected figures side by side — never a
 * replacement — so a reader can see what moved and what did not.
 *
 * @param {object} snapshot
 * @param {Map<string,string>|Object} resolved
 * @param {{brand:object, competitors:Array}} config
 */
export function recomputeSnapshot(snapshot, resolved, { brand, competitors } = {}) {
  const sources = snapshot?.sources || [];
  const results = snapshot?.results || [];
  const engines = {};
  const competitorOriginal = {};
  const competitorCorrected = {};

  for (const source of sources) {
    let originalCited = 0;
    let denominator = 0;
    let minCited = 0;
    let maxCited = 0;
    let cellsWithCitations = 0;
    let cellsNewlyCited = 0;
    let redirectsSeen = 0;
    let redirectsUnresolved = 0;
    let exact = true;

    for (const r of results) {
      const resp = r?.responses?.[source];
      if (!resp || resp.error) continue;

      const { citedRuns, citationDenominator } = cellCounts(resp);
      originalCited += citedRuns;
      denominator += citationDenominator;

      const rawUrls = Array.isArray(resp.citation_urls) ? resp.citation_urls : [];
      redirectsSeen += unresolvedRedirects(rawUrls).length;

      const urls = citationUrlsForCell(resp, resolved);
      redirectsUnresolved += unresolvedRedirects(urls).length;
      if (urls.length) cellsWithCitations += 1;

      for (const comp of resp.competitor_citations || []) {
        competitorOriginal[comp] = (competitorOriginal[comp] || 0) + 1;
      }
      for (const comp of detectCompetitorCitations(urls, competitors)) {
        competitorCorrected[comp] = (competitorCorrected[comp] || 0) + 1;
      }

      if (detectBrandCited(urls, brand) && citedRuns === 0 && citationDenominator > 0) {
        cellsNewlyCited += 1;
        minCited += 1;
        maxCited += citationDenominator;
        if (citationDenominator > 1) exact = false;
      } else {
        minCited += citedRuns;
        maxCited += citedRuns;
      }
    }

    engines[source] = {
      citation_rate_original: rate(originalCited, denominator),
      citation_rate_corrected_min: rate(minCited, denominator),
      citation_rate_corrected_max: rate(maxCited, denominator),
      // True when both bounds coincide, i.e. every newly-cited cell was sampled
      // once. Read the range as a point estimate ONLY when this is true.
      exact,
      n: denominator,
      cells_with_citations: cellsWithCitations,
      cells_newly_cited: cellsNewlyCited,
      redirects_seen: redirectsSeen,
      redirects_unresolved: redirectsUnresolved,
      changed: cellsNewlyCited > 0,
    };
  }

  const byCountDesc = (obj) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]));

  return {
    date: snapshot?.date ?? null,
    runs_per_core_cell: snapshot?.sampling?.runs_per_core_cell ?? 1,
    // What the snapshot itself claims, so a reader can see the recomputation's
    // "original" column agrees with it rather than taking that on trust.
    stored_citation_rate: snapshot?.summary?.citation_rate ?? {},
    engines,
    top_competitor_citations_original: byCountDesc(competitorOriginal),
    top_competitor_citations_corrected: byCountDesc(competitorCorrected),
  };
}

/**
 * Does the recomputation's "original" column reproduce the snapshot's own
 * stored summary? A mismatch means this module is reading the stored shape
 * wrongly, and every corrected figure beside it is suspect — so it is reported
 * as a per-engine list rather than swallowed.
 *
 * @returns {string[]} engine names that disagree (empty is the healthy case)
 */
export function reconciliationMismatches(recomputed) {
  const out = [];
  for (const [source, row] of Object.entries(recomputed?.engines || {})) {
    const stored = recomputed.stored_citation_rate?.[source];
    if (stored === undefined && row.citation_rate_original === null) continue;
    if (stored === undefined) { out.push(source); continue; }
    if (Math.abs((row.citation_rate_original ?? 0) - stored) > 0.0001) out.push(source);
  }
  return out;
}
