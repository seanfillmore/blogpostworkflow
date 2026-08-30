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
  TIERS, ANCHOR_TIER, tierByCode, BAR_VARIANT_ID, CLOSES_HUMAN,
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
    preview: '18 bars of Pure Unscented for $99, or 12 for $66. One week only.',
    offsetHours: 3, // 15:00 PT draw day — after the winner is notified
  },
  {
    file: '11-offer-reminder.html',
    name: 'Giveaway — Consolation offer (day 3)',
    subject: 'Four days left — 18 bars for $99',
    preview: 'The consolation offer closes September 23.',
    offsetHours: 75, // 15:00 PT, day 3
  },
  {
    file: '12-offer-final.html',
    name: 'Giveaway — Consolation offer (final hours)',
    subject: 'Last day — 18 bars for $99',
    preview: 'After tonight it is gone for good.',
    offsetHours: 165, // 09:00 PT on the closing day, so "closes tonight" is true
  },
];

/**
 * @returns {string[]} problems; empty means the email may be sent.
 */
export function checkOfferEmail(html, { variantId = BAR_VARIANT_ID } = {}) {
  const problems = [];

  const cartLinks = [...html.matchAll(/\/cart\/(\d+):(\d+)\?discount=([A-Za-z0-9_-]+)/g)];
  if (!cartLinks.length) problems.push('no offer cart link — this email cannot sell anything');

  const seen = new Set();
  for (const [, vid, qty, code] of cartLinks) {
    if (Number(vid) !== variantId) problems.push(`cart link points at variant ${vid}, expected ${variantId}`);
    const tier = tierByCode(code);
    if (!tier) { problems.push(`cart link carries unknown discount ${code}`); continue; }
    seen.add(tier.id);
    // The pairing is the whole check. A BXGY discounts min(get, what is left
    // after the prerequisite), so 12 bars under the 9+9 code hands over THREE
    // free instead of nine, silently and with no error anywhere.
    if (Number(qty) !== tier.totalBars) {
      problems.push(
        `cart link for ${code} preloads ${qty} bars, expected ${tier.totalBars} — `
        + 'a BXGY marks the free half of what is in the cart, it does not add it',
      );
    }
  }

  // Every tier the offer sells must be reachable from every send. An email
  // advertising only the small tier quietly removes the anchor the pricing
  // depends on.
  for (const tier of TIERS) {
    if (!seen.has(tier.id)) problems.push(`no cart link for ${tier.code} (${tier.title})`);
    if (!html.includes(`$${tier.priceUsd}`)) problems.push(`price $${tier.priceUsd} does not appear in the email`);
  }
  if (cartLinks.length && !html.includes(`$${ANCHOR_TIER.priceUsd}`)) {
    problems.push(`the anchor tier ($${ANCHOR_TIER.priceUsd}) is missing`);
  }

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
