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
 * Which addresses to re-read when verifying a bulk run.
 *
 * SPREAD, never the head. Taking the first N samples only the FIRST batch, so a
 * 25-of-25 pass confirms one batch of 100 and infers the other twenty-nine —
 * which is exactly what the first version of this did, and what re-checking the
 * real 2,948-address run by hand exposed. The last address is always included:
 * the final batch is the short one and the likeliest to be cut off.
 */
export function verificationSample(emails = [], size = 25) {
  if (emails.length <= size) return [...emails];
  const picked = new Set();
  const step = (emails.length - 1) / (size - 1);
  for (let i = 0; i < size; i += 1) picked.add(emails[Math.round(i * step)]);
  // Rounding can collide; top up from the front to keep the requested size.
  for (let i = 0; picked.size < size && i < emails.length; i += 1) picked.add(emails[i]);
  return [...picked];
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

/**
 * Submit suppression batches AND poll each job to completion.
 *
 * WHY THIS EXISTS: `profile-suppression-bulk-create-jobs` is async, and firing it
 * and walking away hides partial failure. On the 2026-09 prune, 1,402 addresses
 * were accepted across 15 batches and only ~1,285 were actually suppressed —
 * roughly 8% silently did not take, on profiles that looked entirely ordinary
 * (SUBSCRIBED, no existing suppression, mailable). Nothing errored. The job id was
 * discarded, so there was nothing to inspect; only a spread verification sample
 * caught it, and only because it sampled the whole list rather than the head.
 *
 * Same trap `subscribeToList` has: the job id is the only handle on what the queue
 * actually did. `skipped_count` is the field that names the loss.
 *
 * Returns aggregate counts rather than throwing, because a partial result is a
 * real state the caller has to report and re-run against, not an exception.
 *
 * @param {object} o
 * @param {string[]} o.emails
 * @param {object} o.deps { request, sleep, log }
 * @param {number} [o.pollTries] per job
 */
export async function submitSuppressionJobs({ emails = [], deps, pollTries = 20 }) {
  const { request, sleep, log = () => {} } = deps;
  const batches = suppressionBatches(emails);
  const jobs = [];
  let unpollable = 0;

  for (const [i, batch] of batches.entries()) {
    const res = await request('POST', '/profile-suppression-bulk-create-jobs/', {
      data: {
        type: 'profile-suppression-bulk-create-job',
        attributes: { profiles: { data: batch.map((email) => ({ type: 'profile', attributes: { email } })) } },
      },
    });
    const id = res?.data?.id ?? null;
    if (!id) unpollable += batch.length;
    jobs.push({ id, size: batch.length });
    log(`  batch ${i + 1}/${batches.length} accepted (${batch.length})${id ? '' : ' — NO job id returned, cannot poll'}`);
  }

  let completed = 0; let skipped = 0; let incomplete = 0;
  for (const job of jobs) {
    if (!job.id) continue;
    let attrs = null;
    for (let t = 0; t < pollTries; t += 1) {
      const d = await request('GET', `/profile-suppression-bulk-create-jobs/${job.id}/`);
      attrs = d?.data?.attributes ?? {};
      if (attrs.status === 'complete' || attrs.status === 'cancelled') break;
      await sleep(3000);
    }
    const done = Number(attrs?.completed_count ?? 0);
    const skip = Number(attrs?.skipped_count ?? 0);
    completed += done;
    skipped += skip;
    if (attrs?.status !== 'complete') incomplete += 1;
    if (skip > 0) log(`  job ${job.id}: status ${attrs?.status} · completed ${done} · SKIPPED ${skip}`);
  }

  return { submitted: emails.length, batches: batches.length, completed, skipped, incomplete, unpollable, jobs };
}
