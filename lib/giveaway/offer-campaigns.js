/**
 * The three consolation sends, and the gates every one of them must pass.
 *
 * Spec §7.3: "Seven days, three sends: draw day → day 3 reminder → final hours.
 * A single send is too fragile when it is the whole campaign's revenue."
 *
 * WHY THESE GATES EXIST AT ALL. This is the only revenue event in a $1,895
 * campaign, going to people acquired with paid traffic, on a domain that has
 * just absorbed a backfill. Every check below is a way one of these emails can
 * be sent and be worthless or harmful without anything erroring:
 *
 *   - a cart link holding 6 bars instead of 12 shows full price, because a BXGY
 *     marks 6 of 12 free rather than adding the free ones;
 *   - a missing or wrong discount code shows $132 at checkout;
 *   - a deadline that disagrees with the discount object advertises a date the
 *     code does not honour — the same defect that once had 06-final-call
 *     stating a date that had already passed;
 *   - a missing unsubscribe link is a CAN-SPAM violation on a promotional send;
 *   - a missing NPN disclosure is a sweepstakes problem, and spec §8 requires it
 *     on the offer surfaces, not only in the rules.
 *
 * Pure so all of it is testable without Klaviyo credentials.
 */
import {
  DISCOUNT_CODE, BAR_VARIANT_ID, totalBars, priceUsd, CLOSES_HUMAN,
} from './consolation-offer.js';

/**
 * The three sends. `offsetHours` is measured from the draw
 * (consolation-offer.js OPENS_AT = 2026-09-16 12:00 PT), so moving the draw
 * moves all three together rather than leaving one behind on a hardcoded date.
 *
 * The offsets are chosen so every send lands in Pacific business hours. A naive
 * 0/72/158 put the final send at 02:00 PT — inside the window, technically
 * true, and read at breakfast by nobody. The draw-day send is +3h rather than
 * +0 so the winner is notified before everyone else is told they lost.
 */
export const OFFER_SENDS = [
  {
    file: '10-offer-drawday.html',
    name: 'Giveaway — Consolation offer (draw day)',
    subject: "We drew the winner — it wasn't you, so here's the next best thing",
    preview: '12 bars of Pure Unscented for $66. One week only.',
    offsetHours: 3, // 15:00 PT draw day — after the winner is notified
  },
  {
    file: '11-offer-reminder.html',
    name: 'Giveaway — Consolation offer (day 3)',
    subject: 'Four days left: 12 bars for $66',
    preview: 'The consolation offer closes September 23.',
    offsetHours: 75, // 15:00 PT, day 3
  },
  {
    file: '12-offer-final.html',
    name: 'Giveaway — Consolation offer (final hours)',
    subject: 'Last day — 12 bars for $66',
    preview: 'After tonight it is gone for good.',
    offsetHours: 165, // 09:00 PT on the closing day, so "closes tonight" is true
  },
];

/**
 * @returns {string[]} problems; empty means the email may be sent.
 */
export function checkOfferEmail(html, { code = DISCOUNT_CODE, variantId = BAR_VARIANT_ID } = {}) {
  const problems = [];

  const cartLinks = [...html.matchAll(/\/cart\/(\d+):(\d+)\?discount=([A-Za-z0-9_-]+)/g)];
  if (!cartLinks.length) problems.push('no offer cart link — this email cannot sell anything');
  for (const [, vid, qty, linkCode] of cartLinks) {
    if (Number(vid) !== variantId) problems.push(`cart link points at variant ${vid}, expected ${variantId}`);
    if (Number(qty) !== totalBars()) {
      problems.push(`cart link preloads ${qty} bars, expected ${totalBars()} — a BXGY marks 6 of 12 free, it does not add them`);
    }
    if (linkCode !== code) problems.push(`cart link carries discount ${linkCode}, expected ${code}`);
  }

  if (!html.includes(`$${priceUsd()}`)) problems.push(`price $${priceUsd()} does not appear in the email`);
  if (!html.includes(CLOSES_HUMAN)) problems.push(`deadline "${CLOSES_HUMAN}" does not appear in the email`);
  if (!/\{%\s*unsubscribe\s*%\}/.test(html)) problems.push('no {% unsubscribe %} link — required on a promotional send');
  if (!/No purchase necessary/i.test(html)) problems.push('missing the No-purchase-necessary disclosure (spec §8)');

  // A sweepstakes email asking for a sale must say, in the same email, that
  // buying changed nothing about the draw. Same rule build-nurture-flow.mjs
  // enforces on the nurture set.
  if (!/purchases? (did not|do not|never)/i.test(html)) {
    problems.push('missing the "purchases did not earn entries" clarification alongside the sale');
  }
  return problems;
}

/** Absolute send time for a given send, derived from the draw. */
export function sendTimeFor(send, opensAtIso) {
  return new Date(Date.parse(opensAtIso) + send.offsetHours * 3600 * 1000).toISOString();
}
