// lib/citation-detect.js
//
// "Were WE cited?" and "was a COMPETITOR cited?", asked of a list of citation
// URLs — plus the redirect indirection that made the first question structurally
// unanswerable for one whole engine.
//
// THE BUG THIS EXISTS TO END, measured on production 2026-09-21 across all 23
// stored snapshots in `data/reports/ai-citations/`:
//
//   engine              grounding redirects / citation URLs
//   gemini                      8,400 / 8,400   (100.0%)
//   perplexity                      0 / 15,120
//   google_ai_overview              0 / 8,822
//   chatgpt                         0 / 631
//
// EVERY Gemini citation, on every snapshot since the engine started returning
// citations on 2026-07-12, arrives as
// `https://vertexaisearch.cloud.google.com/grounding-api-redirect/<token>`.
// The publisher never appears in the URL. `agents/ai-citation-tracker` asked
// `url.includes(brand.domain)`, so `cited` COULD NOT BE TRUE FOR GEMINI — the
// 2026-09-20 snapshot duly reported `citation_rate.gemini = 0` beside a
// `mention_rate.gemini` of 3.5%, the highest mention rate of any engine.
//
// Resolved, that same snapshot carries 29 citations of realskincare.com across
// 14 of its 75 Gemini cells: a citation rate of 12.2%-20.9%, not zero, and on
// the low bound identical to Perplexity's 12.2%. The engine reading as our
// worst was one of our best. `detectCompetitorCitations` was blind the same
// way, so every competitor citation tally in every snapshot is missing Gemini's
// contribution entirely.
//
// WHY THAT MATTERS RIGHT NOW: 19 PR pitches went out on 2026-09-21 aimed at
// raising AI-search citation, and the 2026-09-20 snapshot is their pre-outreach
// baseline. A Gemini citation won in November would have landed on a metric
// that reads 0 by construction, and a success would have been read as a failure.
//
// EVERYTHING HERE IS PURE. Resolution itself is `lib/citation-redirects.js`
// (HEAD-only, no API money, already shared with `agents/pr-target-finder`);
// this module only decides what the resolved answer means. An unresolved
// redirect stays in the list as the redirector URL, which matches neither the
// brand nor any competitor — i.e. exactly today's behaviour. The failure
// direction is "Gemini contributes nothing this run", never "a wrong verdict".

import { isGroundingRedirect } from './pr-targets.js';

/**
 * Substitute resolved destinations for the redirect URLs that have one.
 *
 * Order and length are preserved, and a URL with no entry in the map is passed
 * through untouched — so a partial resolution degrades to a partial answer
 * rather than a short list.
 *
 * @param {string[]} urls
 * @param {Map<string,string>|Object} resolved
 * @returns {string[]}
 */
export function applyResolvedUrls(urls, resolved) {
  const get = resolved instanceof Map
    ? (u) => resolved.get(u)
    : (u) => (resolved ? resolved[u] : undefined);
  return (urls || []).map((u) => get(u) || u);
}

/** Redirect URLs in this list that nothing resolved — the honest "unknown" count. */
export function unresolvedRedirects(urls) {
  return (urls || []).filter((u) => isGroundingRedirect(u));
}

/**
 * Was the brand cited?
 *
 * The test is deliberately the SAME loose substring the agent has always used
 * (`url.toLowerCase().includes(brand.domain)`) rather than a hostname compare.
 * Tightening it here would change the basis of every historical figure in the
 * same commit that fixes the redirect blindness, and two basis changes at once
 * is how a metric stops being comparable to its own history — the trap
 * `lib/citation-sampling.js` documents at length. Resolve the URL; do not also
 * re-litigate what a match is.
 *
 * @param {string[]} urls  citation URLs, redirects already substituted
 * @param {{domain:string}} brand
 */
export function detectBrandCited(urls, brand) {
  const domain = String(brand?.domain || '').toLowerCase();
  if (!domain) return false;
  return (urls || []).some((url) => String(url).toLowerCase().includes(domain));
}

/**
 * Which competitors were cited. Same substring basis, same reasoning.
 *
 * @param {string[]} urls  citation URLs, redirects already substituted
 * @param {Array<{name:string, domain:string}>} competitors
 * @returns {string[]} competitor names, in config order
 */
export function detectCompetitorCitations(urls, competitors) {
  const lower = (urls || []).map((u) => String(u).toLowerCase());
  const found = [];
  for (const comp of competitors || []) {
    const domain = String(comp?.domain || '').toLowerCase();
    if (!domain) continue;
    if (lower.some((url) => url.includes(domain))) found.push(comp.name);
  }
  return found;
}

/**
 * The one line every surface prints about this pass.
 *
 * A resolution pass that quietly stopped resolving looks BYTE-IDENTICAL to one
 * with nothing to resolve — the same "quiet loss of capability" `hold.disarmed`
 * and `efficiencyBanner()` exist to make loud. So the banner never returns an
 * empty string on the off path, and never claims a clean run it cannot prove.
 *
 * @param {{mode:string, redirects_seen:number, redirects_resolved:number,
 *          redirects_unresolved:number}} block
 * @returns {string}
 */
export function redirectResolutionBanner(block) {
  const b = block || {};
  const seen = b.redirects_seen || 0;
  if (b.mode !== 'on') {
    return seen
      ? `⚠ Redirect resolution is OFF this run: ${seen} Gemini citation(s) cannot name a publisher, so citation detection for that engine reads 0 by construction.`
      : '⚠ Redirect resolution is OFF this run (no redirect citations were seen).';
  }
  if (!seen) return 'Redirect resolution ON — no grounding redirects in this run.';
  const unresolved = b.redirects_unresolved || 0;
  const base = `Redirect resolution ON — ${b.redirects_resolved || 0}/${seen} Gemini citation(s) resolved to a publisher`;
  return unresolved
    ? `${base}; ⚠ ${unresolved} unresolved and therefore uncountable for citation detection.`
    : `${base}.`;
}
