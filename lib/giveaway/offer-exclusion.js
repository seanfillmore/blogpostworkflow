/**
 * Keep the prize winners out of the consolation campaigns.
 *
 * The draw-day send opens "We drew the winner. It wasn't you." and targets the
 * whole entrant list. The draw is done by hand at noon PT and that email goes at
 * 15:00 PT, so the exclusion is a static Klaviyo LIST attached to the campaigns
 * in advance, and the winners are added to it once the draw result exists.
 * A list rather than a segment because membership is immediate — a segment on a
 * property takes about a minute to materialize and cannot be verified by count.
 *
 * Pure; scripts/giveaway/exclude-drawn-winners.mjs does the Klaviyo calls.
 */
import { normalizeEmail } from './entries.js';

/**
 * A campaign's audiences with `listId` excluded, the included audience untouched.
 * `changed: false` means the campaign already excludes it, so a re-run reverts
 * and requeues nothing.
 */
export function withExcludedList(audiences = {}, listId) {
  if (!listId) throw new Error('withExcludedList: listId is required');
  const included = [...(audiences.included || [])];
  const excluded = [...(audiences.excluded || [])];
  if (included.includes(listId)) {
    throw new Error(`list ${listId} is the campaign's included audience — excluding it would send to nobody`);
  }
  if (excluded.includes(listId)) return { changed: false, audiences: { included, excluded } };
  return { changed: true, audiences: { included, excluded: [...excluded, listId] } };
}

/** Everyone the draw awarded a prize to: the winner, plus the referrer when §6 was met. */
export function drawnWinnerEmails(result = {}) {
  if (!result.winner) throw new Error('draw result has no winner');
  const out = [normalizeEmail(result.winner)];
  const prize = result.referralPrize;
  if (prize?.awarded && prize.email) {
    const referrer = normalizeEmail(prize.email);
    if (!out.includes(referrer)) out.push(referrer);
  }
  return out;
}
