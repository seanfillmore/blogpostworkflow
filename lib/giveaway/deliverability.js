/**
 * Is the sending domain healthy enough to run a promotional campaign?
 *
 * WHY THIS IS A GATE AND NOT A DASHBOARD. The giveaway roughly doubled the list
 * with cold, paid-acquired leads inside a week, and the backfill put ~950 sends
 * through the domain in a single day. The consolation offer is the campaign's
 * ENTIRE revenue event (spec §7.3) — if it lands in spam, there is no second
 * chance and no other channel scheduled to sell to these people. Worse, the
 * same domain carries Abandoned Cart, Replenishment, Post-Purchase and Winback,
 * so a reputation hit costs repeat revenue that has nothing to do with the
 * giveaway. Sending into a bad rate is how you lose both at once.
 *
 * THE THRESHOLDS ARE THE MAILBOX PROVIDERS', NOT OURS. Google and Yahoo's bulk
 * sender rules enforce a spam-complaint rate below 0.30% and ask senders to stay
 * under 0.10%. Those are the numbers that decide inbox placement, so they are
 * the numbers here — deliberately not a house style we could argue ourselves
 * past on a day we want to send something.
 *
 * Pure: the policy takes counts and returns a verdict, so every threshold is
 * covered by tests instead of being discovered after a campaign lands in spam.
 */

/** Google/Yahoo bulk-sender enforcement line. At or above this, do not send. */
export const SPAM_RATE_BLOCK = 0.003;
/** Google/Yahoo's "keep it under" target. Between this and BLOCK is a warning. */
export const SPAM_RATE_TARGET = 0.001;
/** Hard bounces above this suggest list quality problems worth pausing for. */
export const BOUNCE_RATE_BLOCK = 0.02;
/** Below this many sends the rates are noise — one complaint in 40 is 2.5%. */
export const MIN_SAMPLE = 200;

/**
 * @param {{received:number, spam:number, bounced:number}} counts
 * @returns {{verdict:'send'|'caution'|'hold'|'insufficient-data', reasons:string[],
 *   spamRate:number|null, bounceRate:number|null}}
 */
export function assessDeliverability({ received = 0, spam = 0, bounced = 0 } = {}) {
  const reasons = [];
  if (!received || received < MIN_SAMPLE) {
    return {
      verdict: 'insufficient-data',
      reasons: [`only ${received} sends in window — below the ${MIN_SAMPLE} needed for a rate to mean anything`],
      spamRate: received ? spam / received : null,
      bounceRate: received ? bounced / received : null,
    };
  }

  const spamRate = spam / received;
  const bounceRate = bounced / received;

  // Ordered worst-first so the verdict reflects the most serious finding, and
  // every failing condition is still reported rather than short-circuiting —
  // "spam is fine but bounces are not" is a different fix from either alone.
  if (spamRate >= SPAM_RATE_BLOCK) {
    reasons.push(`spam rate ${(spamRate * 100).toFixed(3)}% is at or above the ${(SPAM_RATE_BLOCK * 100).toFixed(1)}% Google/Yahoo enforcement line`);
  } else if (spamRate > SPAM_RATE_TARGET) {
    reasons.push(`spam rate ${(spamRate * 100).toFixed(3)}% is above the ${(SPAM_RATE_TARGET * 100).toFixed(1)}% target but below the enforcement line`);
  }
  if (bounceRate >= BOUNCE_RATE_BLOCK) {
    reasons.push(`bounce rate ${(bounceRate * 100).toFixed(2)}% is at or above ${(BOUNCE_RATE_BLOCK * 100).toFixed(0)}%`);
  }

  const blocked = spamRate >= SPAM_RATE_BLOCK || bounceRate >= BOUNCE_RATE_BLOCK;
  const verdict = blocked ? 'hold' : (reasons.length ? 'caution' : 'send');
  if (verdict === 'send') reasons.push(`spam ${(spamRate * 100).toFixed(3)}%, bounce ${(bounceRate * 100).toFixed(2)}% — both within limits`);
  return { verdict, reasons, spamRate, bounceRate };
}
