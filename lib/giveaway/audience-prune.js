/**
 * Decide who on the giveaway entrant list gets suppressed for being unengaged.
 *
 * Klaviyo bills on ACTIVE profiles and suppressed ones do not count, so this is
 * how the list stops costing money it does not earn. Measured on the 2026-09
 * giveaway: 7,135 entrants produced exactly ONE order, ever, and the draw-day
 * offer send returned 0.31% CTR with a 4.32% unsubscribe rate.
 *
 * BUT UNLIKE THE §5 BOT COHORT, THESE ARE REAL PEOPLE. They entered legitimately;
 * they simply never opened anything. Suppression is invisible in practice — nobody
 * notices they stopped receiving email — so every protection below is arithmetic
 * and every failure is a refusal rather than a warning.
 *
 * Three protections, in order of how much being wrong would cost:
 *
 *  1. PURCHASERS. The one profile where a mistake costs actual revenue. Keeping
 *     them costs one profile on the bill.
 *  2. The winner and alternates, who are mid-obligation under §8.
 *  3. The engaged, who are the audience the remaining sends target.
 *
 * And two circuit breakers, because the engaged set is computed upstream by a
 * Klaviyo segment that can silently stop matching or simply not have materialised
 * yet — in which case almost the whole list looks cold and this would suppress
 * nearly every real entrant:
 *
 *  - `engagedFloor`: refuse unless the engaged set is plausibly populated.
 *  - `maxShare`: refuse if the prune would still take an implausible share.
 *
 * Pure; scripts/giveaway/prune-unengaged.mjs does the Klaviyo calls.
 */

const norm = (e) => String(e ?? '').trim().toLowerCase();
const setOf = (xs) => new Set((xs || []).map(norm).filter(Boolean));

/**
 * @param {object} o
 * @param {string[]} o.listEmails every profile on the entrant list
 * @param {string[]} o.engagedEmails opened or clicked at least once
 * @param {string[]} o.purchaserEmails has ever placed an order
 * @param {string[]} o.protectedEmails winner and alternates
 * @param {string[]} o.suppressedEmails already suppressed (skipped, not re-sent)
 * @param {number} o.engagedFloor minimum plausible engaged count
 * @param {number} [o.maxShare] maximum share of the list this may suppress
 */
export function planPrune({
  listEmails = [], engagedEmails = [], purchaserEmails = [], protectedEmails = [],
  suppressedEmails = [], engagedFloor, maxShare = 0.8,
} = {}) {
  if (!Number.isFinite(engagedFloor)) throw new Error('planPrune: engagedFloor is required');

  const list = [...setOf(listEmails)];
  const engaged = setOf(engagedEmails);
  const purchasers = setOf(purchaserEmails);
  const shielded = setOf(protectedEmails);
  const suppressed = setOf(suppressedEmails);

  if (engaged.size < engagedFloor) {
    throw new Error(
      `refusing: the engaged set holds ${engaged.size}, below the floor of ${engagedFloor} — `
      + 'a segment that has not materialised or has stopped matching would make the whole list look cold',
    );
  }

  const kept = { engaged: 0, purchasers: 0, protected: 0 };
  const toSuppress = [];
  let alreadySuppressed = 0;

  for (const email of list) {
    if (engaged.has(email)) { kept.engaged += 1; continue; }
    if (purchasers.has(email)) { kept.purchasers += 1; continue; }
    if (shielded.has(email)) { kept.protected += 1; continue; }
    if (suppressed.has(email)) { alreadySuppressed += 1; continue; }
    toSuppress.push(email);
  }

  const share = list.length ? toSuppress.length / list.length : 0;
  if (share > maxShare) {
    throw new Error(
      `refusing: would suppress ${toSuppress.length} of ${list.length} (${(share * 100).toFixed(1)}%), `
      + `above the ${(maxShare * 100).toFixed(0)}% share ceiling`,
    );
  }

  return {
    toSuppress: toSuppress.sort(),
    kept,
    alreadySuppressed,
    listSize: list.length,
    engagedSize: engaged.size,
    share,
  };
}
