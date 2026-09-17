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

/**
 * The §5-disqualified cohort, read from the committed evidence record
 * (`data/giveaway/evidence/<date>-entry-fraud/disqualified-entrants.json`).
 *
 * That file is the source rather than the draw snapshot because the snapshot no
 * longer contains these rows — being absent from it is what "disqualified" means.
 * It is also the record a complaint would be answered from, so the offer
 * exclusion and the drawing are arguing from exactly the same list.
 *
 * `exempt[]` is deliberately never consulted for membership. The exemptions are
 * what make the rule safe, and an exempt entrant leaking in here would withhold
 * the offer from someone the rule went out of its way to spare.
 */
export function disqualifiedEmails(evidence = {}) {
  if (!Array.isArray(evidence.disqualified)) {
    throw new Error('evidence record has no disqualified[] array');
  }
  const out = [];
  const seen = new Set();
  for (const row of evidence.disqualified) {
    const email = normalizeEmail(row?.email ?? '');
    if (!email) throw new Error(`disqualified row has no usable email: ${JSON.stringify(row)}`);
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

/**
 * Which of `wanted` is absent from `members`.
 *
 * The caller must pass the WHOLE membership. The read-back this replaces fetched
 * one 100-row page, which was correct while the exclusion list held two winners
 * and silently wrong the moment it held thousands — it would report a winner
 * absent immediately after adding them, at the worst possible moment.
 */
export function missingFromMembership(wanted = [], members = []) {
  const have = new Set(members.map((m) => String(m ?? '').trim().toLowerCase()));
  return wanted
    .map((w) => String(w ?? '').trim().toLowerCase())
    .filter((w) => w && !have.has(w));
}

/**
 * A campaign's audiences with the INCLUDED side replaced by `audienceId`.
 *
 * Narrowing the included audience is more dangerous than adding an exclusion: get
 * it wrong and the campaign sends to NOBODY, silently, at its scheduled time, and
 * reports zero recipients as though that were the answer. So two refusals:
 *
 *  - an empty id, which would leave no audience at all;
 *  - an id that is also on the EXCLUDED side, where the exclusion wins and the
 *    send goes out to nothing.
 *
 * Exclusions are preserved untouched — the winner and the disqualified cohort
 * must stay excluded whatever the audience narrows to.
 *
 * `changed: false` when it already targets exactly that audience, so a re-run
 * does not revert and requeue a scheduled campaign for nothing.
 */
export function withIncludedAudience(audiences = {}, audienceId) {
  if (!audienceId) throw new Error('withIncludedAudience: audienceId is required');
  const excluded = [...(audiences.excluded || [])];
  if (excluded.includes(audienceId)) {
    throw new Error(`audience ${audienceId} is also EXCLUDED on this campaign — it would send to nobody`);
  }
  const included = [...(audiences.included || [])];
  if (included.length === 1 && included[0] === audienceId) {
    return { changed: false, audiences: { included, excluded } };
  }
  return { changed: true, audiences: { included: [audienceId], excluded } };
}

/**
 * Refuse to point a campaign at an audience that is too small to be real.
 *
 * A freshly created Klaviyo segment reports 0 members until it materialises — it
 * took several minutes on this account. Re-pointing inside that window hands the
 * campaign an EMPTY audience, and it then sends to nobody at its scheduled time
 * and reports zero recipients as though that were the answer. The floor also
 * catches a definition that silently stopped matching.
 */
export function assertAudienceViable(memberCount, floor) {
  if (!Number.isFinite(memberCount)) throw new Error('audience member count is unknown — refusing');
  if (memberCount === 0) throw new Error('audience has 0 members — refusing (a new segment reads 0 until it materialises)');
  if (memberCount < floor) throw new Error(`audience has ${memberCount} members, below the floor of ${floor} — refusing`);
  return true;
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
