/**
 * Email distance helpers shared by the nightly referral audit and the entry
 * form's live "did you mean?" prompt.
 *
 * One implementation on purpose. The audit decides who is TOLD a referral is
 * broken and the form decides what an entrant is SHOWN before they submit; if
 * those two drifted apart, the form would accept an address the audit then
 * reports as a typo, which is the exact loop this work exists to close.
 */

/** Edit distance at or below which a typed address is treated as a typo of a real one. */
export const NEAR_MISS_MAX_DISTANCE = 2;

/**
 * Shortest local-part stem that may be used to accuse two addresses of being the
 * same person. 'sam' is a prefix of 'samuel' and they are plainly two people;
 * 'lisamarob' is a prefix of 'lisamarobin' and plainly is not. Below this length
 * the heuristic suppresses genuine referrals, which costs a real entrant real
 * entries, so it sits where the false-positive rate collapses rather than where
 * it catches the most cases.
 */
export const MIN_SAME_PERSON_STEM = 5;

export function levenshtein(a, b) {
  if (a === b) return 0;
  // Single row: the whole confirmed-entrant list is compared against every typed
  // address, on every entry-form keystroke pause and on every nightly pass.
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * The comparable stem of a local part: dots and +tags removed.
 *
 * Gmail treats both as insignificant, which is exactly how one person ends up
 * holding several addresses that all deliver to them.
 */
export const stem = (email) => email.split('@')[0].replace(/\+.*$/, '').replace(/\./g, '');

/**
 * Does this pair look like ONE person holding two addresses?
 *
 * Official Rules §6 voids self-referral in two independent places — entry
 * crediting and prize eligibility — and reaches "any other entry you control"
 * and "any email address Sponsor determines resolves to the same person". A pair
 * that trips this is routed to a human and never receives email, because a "did
 * you mean?" message to someone self-referring is an invitation to launder a
 * void referral.
 */
export function looksSamePerson(a, b) {
  const [sa, sb] = [stem(a), stem(b)];
  if (sa === sb) return true; // same local part, different mailbox host
  const [short, long] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  if (short.length >= MIN_SAME_PERSON_STEM && long.startsWith(short)) return true;
  return levenshtein(a, b) <= NEAR_MISS_MAX_DISTANCE;
}

/**
 * The single closest candidate to `typed`, or null when none is within range OR
 * when two sit equally close.
 *
 * A tie returns null on purpose: choosing between two real entrants who are each
 * one edit away would be inventing a referral, and both consumers act on this.
 */
export function nearestWithin(typed, candidates, maxDistance = NEAR_MISS_MAX_DISTANCE) {
  let best = null;
  let bestDistance = Infinity;
  let tied = false;
  for (const candidate of candidates) {
    const d = levenshtein(typed, candidate);
    if (d > maxDistance || d === 0) continue;
    if (d < bestDistance) { best = candidate; bestDistance = d; tied = false; } else if (d === bestDistance) tied = true;
  }
  return tied || !best ? null : { email: best, distance: bestDistance };
}
