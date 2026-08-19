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
 * @returns {{keep: boolean, reason: string|null}}
 */
export function triageOrphanBrief(keyword, {
  publishedKeywords = [],
  rejectedKeywords = [],
  brandTerms = [],
  inScope = () => true,
  clusterRevenue = null,
} = {}) {
  const kw = String(keyword || '').toLowerCase();
  if (!kw) return { keep: false, reason: 'empty keyword' };

  if (rejectedKeywords.some((r) => String(r).toLowerCase() === kw)) {
    return { keep: false, reason: 'on the rejected-keywords list' };
  }

  const brandHit = brandTerms.find((t) => kw.includes(String(t).toLowerCase()));
  if (brandHit) {
    return { keep: false, reason: `branded keyword (contains "${brandHit}")` };
  }

  if (!inScope(kw)) {
    return { keep: false, reason: 'outside product scope — nothing to sell from it' };
  }

  const exact = publishedKeywords.find((k) => String(k).toLowerCase() === kw);
  const dup = exact || findSemanticDuplicate(keyword, publishedKeywords, { threshold: 0.6 });
  if (dup) {
    return { keep: false, reason: `already covered by published post "${dup}"` };
  }

  // A brief in a cluster the planner may no longer schedule will never be
  // written. Only fires when revenue data was actually supplied — absent data is
  // not evidence of $0, and deleting a brief cannot be undone.
  if (clusterRevenue) {
    const cluster = clusterForText(keyword);
    const c = cluster ? clusterRevenue[cluster] : null;
    if (c?.status === 'proven_dud') {
      return {
        keep: false,
        reason: `${cluster} cluster does not earn (${c.clicks} clicks across ${c.pages} pages, $0.00)`,
      };
    }
  }

  return { keep: true, reason: null };
}
