// lib/brief-triage.js
// Pure helpers for the "a brief is not a published post" distinction.
//
// content-strategist built ONE inventory Set from briefs + posts and handed it to
// the planner under the heading "EXISTING CONTENT (already published or briefed —
// DO NOT include these)". So the moment a brief was generated the topic counted as
// covered and was excluded from every later calendar: never scheduled, never
// written, and the paid-for research orphaned. 73 briefs had accumulated that way
// by 2026-08-18.

import { findSemanticDuplicate } from './cannibalization-guard.js';
import { clusterForText } from './cluster-revenue.js';

/**
 * Split known slugs into what is genuinely covered and what is merely briefed.
 *
 * @param {{briefSlugs?: string[], contentSlugs?: string[]}} args
 *   contentSlugs — slugs with an actual post (content.html or a Shopify record).
 * @returns {{covered: string[], prepaid: string[]}}
 *   covered — do not propose again.
 *   prepaid — brief exists, post does not. Schedule these FIRST; the expensive
 *             half is already bought.
 */
export function splitInventory({ briefSlugs = [], contentSlugs = [] }) {
  const written = new Set(contentSlugs);
  return {
    covered: [...written].sort(),
    prepaid: [...new Set(briefSlugs)].filter((s) => !written.has(s)).sort(),
  };
}

/**
 * Should an orphaned brief be kept and scheduled, or dropped?
 *
 * Applies the same gates the strategist applies to a fresh proposal, so an
 * orphan only survives if it would be proposed today. Anything else is dropped
 * rather than left in limbo forever.
 *
 * `cluster` and `clusterStats` are returned alongside the verdict — not because
 * this function needs them, but because the caller archives a dropped brief and
 * the archive has to record WHY on evidence a human can re-examine. "The soap
 * cluster does not earn" is not reviewable six weeks later; the classification
 * object behind it is. They are null when no revenue data was supplied.
 *
 * @returns {{keep: boolean, reason: string|null, cluster: string|null, clusterStats: object|null}}
 */
export function triageOrphanBrief(keyword, {
  publishedKeywords = [],
  rejectedKeywords = [],
  brandTerms = [],
  inScope = () => true,
  clusterRevenue = null,
} = {}) {
  const kw = String(keyword || '').toLowerCase();
  const cluster = clusterRevenue ? clusterForText(keyword) : null;
  const clusterStats = (cluster && clusterRevenue?.[cluster]) || null;
  const verdict = (keep, reason) => ({ keep, reason, cluster, clusterStats });

  if (!kw) return verdict(false, 'empty keyword');

  if (rejectedKeywords.some((r) => String(r).toLowerCase() === kw)) {
    return verdict(false, 'on the rejected-keywords list');
  }

  const brandHit = brandTerms.find((t) => kw.includes(String(t).toLowerCase()));
  if (brandHit) {
    return verdict(false, `branded keyword (contains "${brandHit}")`);
  }

  if (!inScope(kw)) {
    return verdict(false, 'outside product scope — nothing to sell from it');
  }

  const exact = publishedKeywords.find((k) => String(k).toLowerCase() === kw);
  const dup = exact || findSemanticDuplicate(keyword, publishedKeywords, { threshold: 0.6 });
  if (dup) {
    return verdict(false, `already covered by published post "${dup}"`);
  }

  // A brief in a cluster the planner may no longer schedule will never be
  // written. Only fires when revenue data was actually supplied — absent data is
  // not evidence of $0.
  //
  // This gate used to be the last thing between a brief and `unlinkSync`, and on
  // 2026-08-19 a wrong `soap` verdict took three of them permanently. Dropping is
  // now a MOVE into data/briefs/_dropped/ (lib/brief-archive.js), so a wrong
  // verdict costs a `--restore` rather than the research.
  if (clusterStats?.status === 'proven_dud') {
    return verdict(
      false,
      `${cluster} cluster does not earn (${clusterStats.clicks} clicks across ${clusterStats.pages} pages, $0.00)`,
    );
  }

  return verdict(true, null);
}
