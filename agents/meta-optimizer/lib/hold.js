/**
 * $0-cluster hold for meta-optimizer's candidate pick list.
 *
 * Split out of index.js for the same reason lib/sort.js and lib/grounding.js
 * are: that index calls loadEnv() and can process.exit at import time, so a pure
 * selector living there is not testable.
 *
 * WHY THIS AGENT NEEDED GATING. Its weekly cron is `--apply --limit 5`, and the
 * cap is spent in `sortByValidation` order — Amazon-validated first, then by
 * impressions. On the real 2026-08-23 pool that put FOUR of the five slots in
 * the one held cluster and left the site's biggest CTR opportunity fifth, only
 * just inside the cap. The hold therefore has to be applied to the pick list
 * BEFORE the cap, exactly as blocked-post-resolver does, or held candidates go
 * on eating an earning cluster's budget while being "skipped".
 *
 * WHAT IS DELIBERATELY NOT GATED: `runRefreshStaleYears`. A hold pauses
 * unattended LLM/refresh spend; that pass makes no model call, and leaving
 * "2025" in the title of a live indexed page degrades the page — which a hold
 * is explicitly not allowed to do.
 */

import { partitionHeld } from '../../../lib/cluster-hold.js';
import { handleFromUrl } from '../../../lib/posts.js';

/**
 * Split low-CTR candidates into what runs and what is held.
 *
 * Clustering is attempted on the QUERY first, because that is what seo-impact
 * attributes revenue on, then on the page the rewrite would land on — a query
 * like "best options for 2026" names no cluster while its page plainly does.
 *
 * @param {Array<{keyword:string}>} candidates
 * @param {object} hold from loadClusterHold/buildClusterHold
 * @param {{includeHeld?:boolean, pageForKeyword?:(kw:string)=>string|null}} opts
 * @returns {{kept:Array, held:Array, overridden:Array}}
 */
export function holdMetaCandidates(candidates, hold, { includeHeld = false, pageForKeyword = () => null } = {}) {
  return partitionHeld(candidates, hold, {
    includeHeld,
    describe: (c) => {
      const url = pageForKeyword(c?.keyword) || null;
      // `slug` is what dedupeHeld collapses on, so several held queries that
      // point at one page count as one held page in the digest — the number an
      // operator reads as "how much is this hold withholding".
      return { keyword: c?.keyword, url, slug: url ? handleFromUrl(url) : null };
    },
  });
}
