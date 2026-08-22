/**
 * The drawing itself: a weighted ordering, and the §6 second-prize test.
 *
 * WHY TICKETS AND NOT A WEIGHTED-KEY ALGORITHM. Efraimidis-Spirakis would be
 * fewer lines and is equally correct, but nobody outside this repo could check
 * it by hand — and being checkable by hand is the entire point of publishing a
 * seed. Expanding each entry into its own ticket and shuffling is exactly the
 * mental model an entrant already has: every ticket goes in a drum and they come
 * out one at a time.
 *
 * ONE PASS GIVES THE WINNER AND EVERY ALTERNATE. §8 gives a winner 7 days to
 * respond before Sponsor "may select an alternate winner from the remaining
 * eligible entries". Taking first-appearance order over the shuffled tickets
 * yields that whole list at once, so the alternate is as provable as the winner
 * and needs no second draw.
 */
import { seedFromString, mulberry32, shuffle } from './seeded-random.js';

/**
 * Every entrant, most-favoured first.
 * @returns {Array<string>} emails, no duplicates, length === snapshot.entrants.length
 */
export function drawOrdering(snapshot, seed) {
  if (!seed) throw new Error('drawOrdering: a seed is required');
  const tickets = [];
  for (const entrant of snapshot.entrants) {
    for (let i = 0; i < entrant.entries; i += 1) tickets.push(entrant.email);
  }
  if (!tickets.length) throw new Error('drawOrdering: the snapshot holds no entries');

  const shuffled = shuffle(tickets, mulberry32(seedFromString(seed)));

  const seen = new Set();
  const ordering = [];
  for (const email of shuffled) {
    if (seen.has(email)) continue;
    seen.add(email);
    ordering.push(email);
  }
  return ordering;
}

/**
 * §6, four conditions. Any failure means no prize AND no substitute — §6 states
 * outright that Sponsor "has no obligation to substitute a referral prize
 * winner", so `email` is null on every rejection.
 *
 * Note the asymmetry with entry crediting, which is deliberate and rules-driven:
 * §5 pays the +5 without requiring the referrer to have confirmed, and only this
 * PRIZE test applies §6(a)'s "themselves a confirmed entrant" condition.
 */
export function determineReferralPrize(snapshot, winnerEmail) {
  const byEmail = new Map(snapshot.entrants.map((e) => [e.email, e]));
  const winner = byEmail.get(winnerEmail);
  if (!winner) throw new Error(`determineReferralPrize: ${winnerEmail} is not in the snapshot`);

  const no = (reason) => ({ awarded: false, email: null, reason });

  if (!winner.referredBy) return no('the winner named no referrer at the time of entry');
  if (winner.referredBy === winner.email) return no('the winner named their own address — void under §6');
  if (winner.samePersonSuspected) {
    return no('the named referrer resolves to the same person as the winner — void under §6, no substitute');
  }
  const referrer = byEmail.get(winner.referredBy);
  if (!referrer) return no(`the named referrer ${winner.referredBy} is not in the snapshot — they never entered`);
  if (!referrer.confirmed) {
    return no(`the named referrer ${winner.referredBy} is not a confirmed entrant — §6(a)`);
  }
  return { awarded: true, email: referrer.email, reason: 'all §6 conditions met' };
}
