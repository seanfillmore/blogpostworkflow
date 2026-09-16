/**
 * Take the §5-disqualified cohort out of Klaviyo's billable profile count.
 *
 * Klaviyo bills on ACTIVE profiles and suppressed profiles do not contribute to
 * the plan's count (Klaviyo, "Understanding active profile management"), so
 * suppression is what stops us paying for 2,948 bots. It is preferred over
 * DELETION deliberately: deletion would destroy the Klaviyo-side record of
 * entrants we have just disqualified from a promotion somebody may complain
 * about, and it buys nothing extra — both remove the charge, only one is
 * reversible.
 *
 * THE ONLY REAL RISK HERE IS SUPPRESSING THE WRONG PERSON. Suppression is
 * invisible in practice — nobody notices they stopped receiving email — so the
 * guards below are arithmetic rather than vigilance, and they refuse rather than
 * warn.
 *
 * Pure; scripts/giveaway/suppress-disqualified.mjs does the Klaviyo calls.
 */

/** Klaviyo's documented maximum for profile-suppression-bulk-create-jobs. */
export const MAX_BATCH = 100;

const norm = (e) => String(e ?? '').trim().toLowerCase();

/** Split into API-sized batches. Empty in, empty out — never one empty call. */
export function suppressionBatches(emails = [], size = MAX_BATCH) {
  if (size > MAX_BATCH) throw new Error(`batch size ${size} exceeds the API maximum of ${MAX_BATCH}`);
  if (size < 1) throw new Error('batch size must be at least 1');
  const out = [];
  for (let i = 0; i < emails.length; i += size) out.push(emails.slice(i, i + size));
  return out;
}

/**
 * Refuse unless the addresses are provably safe to suppress.
 *
 * Three conditions, each of which has to hold for the operation to mean what it
 * says:
 *
 *  1. NON-EMPTY. An empty list would suppress nobody and report success, which
 *     reads identically to a run that worked.
 *  2. DISJOINT FROM THE DRAW POOL. The disqualified set and the committed pool
 *     partition the entrants exactly (2,948 + 4,419 = 7,367), so any overlap
 *     means something upstream has changed — an edited evidence file, a widened
 *     fraud window — and the cost of being wrong is suppressing a real entrant,
 *     the winner, or an alternate.
 *  3. COUNT MATCHES THE EVIDENCE RECORD. The list being suppressed must be the
 *     whole list that was disqualified, not a truncated read of it.
 *
 * @param {string[]} emails addresses about to be suppressed
 * @param {{entrants:Array<{email:string}>}} snapshot the committed draw snapshot
 * @param {number} expectedCount the evidence record's own disqualified_count
 */
export function assertSafeToSuppress(emails = [], snapshot = {}, expectedCount = null) {
  if (!emails.length) throw new Error('refusing to suppress an empty list');

  if (expectedCount !== null && emails.length !== expectedCount) {
    throw new Error(
      `refusing: ${emails.length} addresses to suppress but the evidence record says ${expectedCount}`,
    );
  }

  const inPool = new Set((snapshot.entrants || []).map((e) => norm(e.email)));
  const overlap = emails.map(norm).filter((e) => inPool.has(e));
  if (overlap.length) {
    throw new Error(
      `refusing: ${overlap.length} address(es) are in the draw pool and must never be suppressed `
      + `(first few: ${overlap.slice(0, 3).join(', ')})`,
    );
  }
  return true;
}
