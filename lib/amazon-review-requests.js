/**
 * Pure rules for agents/amazon-review-requests. No I/O, so every decision is testable.
 *
 * WHAT IT IS: Amazon's own "Request a Review" button, sent through the SP-API
 * Solicitations API for every order still eligible. Amazon writes the email; we choose
 * nothing about its content, so it cannot carry an incentive or ask for a positive
 * review. Amazon allows exactly one request per order, 5 to 30 days after delivery, and
 * the GET actions endpoint stops offering the action once ANY tool has sent one.
 *
 * WHY A GAP-FILLER, NOT THE PRIMARY. Measured 2026-10-31: of ~45 sampled orders aged
 * 4-33 days, only 2 were still eligible. Something (most likely the agency's Helium 10
 * follow-up) already requests most orders around day 5-8. So MIN_AGE_DAYS sits at 10:
 * the other tool goes first, and we catch only what it missed. Because eligibility is
 * re-read from Amazon immediately before every send, a double send is impossible
 * whatever the other tool does.
 */

export const SOLICITATION_ACTION = 'productReviewAndSellerFeedback';
/** Let the existing tool act first; FBA orders are delivered well before day 10. */
export const MIN_AGE_DAYS = 10;
/** Amazon closes the window 30 days after delivery; 31 days after purchase is a safe outer bound. */
export const MAX_AGE_DAYS = 31;
/** State entries older than this can never be eligible again and are dropped. */
export const STATE_RETENTION_DAYS = 45;

const DAY = 864e5;

/** The order window to list, as ISO strings. */
export function orderWindow(now = Date.now()) {
  return {
    createdAfter: new Date(now - MAX_AGE_DAYS * DAY).toISOString(),
    createdBefore: new Date(now - MIN_AGE_DAYS * DAY).toISOString(),
  };
}

/**
 * Which orders to check today. Each order is checked ONCE: an order already sent, or
 * already found not eligible at day 10+, is final. A transient error is never recorded,
 * so that order is simply tried again tomorrow.
 */
export function ordersToCheck(orders, state = {}) {
  return orders.filter((o) =>
    o?.AmazonOrderId &&
    o.OrderStatus === 'Shipped' &&
    !state[o.AmazonOrderId]);
}

/** Eligible means Amazon currently offers the review-request action on this order. */
export function isEligible(actionsResponse) {
  const actions = actionsResponse?._links?.actions ?? [];
  return actions.some((a) => String(a?.name ?? a?.href ?? '').includes(SOLICITATION_ACTION));
}

export function pruneState(state = {}, now = Date.now()) {
  const cutoff = now - STATE_RETENTION_DAYS * DAY;
  return Object.fromEntries(Object.entries(state).filter(([, v]) => Date.parse(v?.at) >= cutoff));
}

export function renderBody({ checked, sent, notEligible, errors, dryRun }) {
  const lines = [
    `${dryRun ? 'DRY RUN, nothing sent. ' : ''}Checked ${checked} order(s) aged ${MIN_AGE_DAYS}-${MAX_AGE_DAYS} days.`,
    `${dryRun ? 'Would send' : 'Sent'}: ${sent} review request(s) (Amazon's standard email).`,
    `Already requested or not eligible: ${notEligible}.`,
  ];
  if (errors.length) lines.push(`Errors (retried tomorrow): ${errors.length}`, ...errors.slice(0, 5).map((e) => `  ${e}`));
  return lines.join('\n');
}
