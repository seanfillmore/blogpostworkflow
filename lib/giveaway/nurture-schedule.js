// lib/giveaway/nurture-schedule.js
/**
 * Which nurture emails belong on which clock, and when the fixed-date ones send.
 *
 * WHY THIS EXISTS: all six nurture emails were on a single relative-to-entry
 * schedule (0.5h, d2, d6, d12, d20, d28) while the Entry Period is a FIXED
 * 30-day window with one shared close date. Those two facts do not compose. An
 * entrant who joined on day 20 reached 05-reminder ("the drawing is getting
 * closer") on day 40 and 06-final-call ("entries close September 14, the drawing
 * is two days later") on day 48 — over a month after the winner was drawn,
 * quoting a deadline long past and soliciting referrals, Instagram posts and
 * uploads that could no longer be credited to anything.
 *
 * The emails were doing two different jobs:
 *
 *   01-confirm .. 04-ugc   ONBOARDING   — about the entrant's own journey.
 *                                          Time-since-entry is the right anchor,
 *                                          and 01 must land minutes after entry.
 *   05-reminder, 06-final  DEADLINE     — about the contest clock, which is the
 *                                          SAME date for every entrant. Anchoring
 *                                          these to entry date is the bug.
 *
 * So the onboarding four stay in the Klaviyo flow, and the deadline two become
 * scheduled campaigns computed from the close date. A late entrant then gets the
 * deadline emails at the correct moment rather than a sequence they have no time
 * left to act on.
 *
 * The tail of the flow is bounded separately: scripts/giveaway/close-entry-period.mjs
 * flips the flow to `draft` at close (cron `TZ=America/Los_Angeles 5 5 15 9 *`), so a day-28 entrant
 * simply stops receiving onboarding emails once entries close.
 */

/** Onboarding emails — relative to entry, in send order. */
export const FLOW_EMAILS = ['01-confirm.html', '02-referral.html', '03-angle.html', '04-ugc.html'];

/** Deadline emails — fixed calendar dates derived from the Entry Period close. */
export const CAMPAIGN_EMAILS = ['05-reminder.html', '06-final-call.html'];

/**
 * Templates that live in this directory but belong to a DIFFERENT builder.
 *
 * They are neither flow steps nor deadline campaigns, and listing them here is
 * what lets the unclassified-file check below stay a hard error. Without it,
 * every template another flow parks in this directory breaks the nurture
 * builder outright — which is exactly what happened: `00-confirm-request.html`
 * (scripts/giveaway/build-confirm-flow.mjs) and `07-referral-pending.html`
 * (scripts/giveaway/build-referral-audit-flow.mjs) each threw
 * "unclassified nurture email" and stopped the nurture flow from being rebuilt
 * at all.
 *
 * Deliberately NOT a wildcard or a numeric-prefix rule. The check exists
 * because an unclassified email reaches neither the flow nor a campaign and is
 * simply never sent, with nothing downstream to notice — so a new file must
 * still fail loudly until somebody says which builder owns it.
 */
export const EXTERNAL_EMAILS = ['00-confirm-request.html', '07-referral-pending.html'];

/**
 * Absolute hours from entry for the flow emails.
 *
 * 01-confirm fires at 0.5h, not 0h, for separation: 30 minutes is enough that it
 * does not land on top of anything else the entrant just received.
 *
 * READ "ENTRY" HERE AS "CONFIRMATION", NOT "FORM SUBMIT". This flow triggers on
 * Subscribed to List, and under double opt-in a profile joins the list only when
 * the recipient CLICKS Klaviyo's opt-in email — not when they submit the form.
 * So every delay below is measured from confirmation, which may be hours or days
 * after the entrant actually entered, and NOTHING in this flow can ever reach an
 * unconfirmed entrant.
 *
 * This comment previously said Klaviyo sends its opt-in email "immediately at
 * list-add", which inverts the order and is what put a paragraph into
 * 01-confirm.html telling the reader to go click a confirmation link they had
 * definitionally already clicked. Reaching the unconfirmed is a different job
 * with a different mechanism — a re-issued consent request, not a flow — and it
 * lives in scripts/giveaway/nudge-unconfirmed.mjs.
 */
export const FLOW_DELAYS_HOURS = [0.5, 48, 144, 288];

/** Days before the Entry Period close that each deadline campaign sends. */
const CAMPAIGN_LEAD_DAYS = { '05-reminder.html': 3, '06-final-call.html': 1 };

/** Send time for the deadline campaigns, UTC. 14:00Z is 07:00 PT. */
const CAMPAIGN_SEND_HOUR_UTC = 14;

/**
 * Partition the nurture directory into flow emails and campaign emails.
 *
 * Throws on anything unexpected in either direction. A silent pass would be the
 * worst outcome available here: an unclassified email reaches neither the flow
 * nor a campaign and is simply never sent, and nothing downstream would notice.
 */
export function splitNurtureFiles(files) {
  const present = new Set(files);
  for (const f of [...FLOW_EMAILS, ...CAMPAIGN_EMAILS]) {
    if (!present.has(f)) throw new Error(`nurture email missing: ${f}`);
  }
  const known = new Set([...FLOW_EMAILS, ...CAMPAIGN_EMAILS, ...EXTERNAL_EMAILS]);
  for (const f of files) {
    if (!known.has(f)) {
      throw new Error(
        `unclassified nurture email: ${f} — add it to FLOW_EMAILS, CAMPAIGN_EMAILS, `
        + 'or EXTERNAL_EMAILS if another builder owns it',
      );
    }
  }
  return { flow: [...FLOW_EMAILS], campaigns: [...CAMPAIGN_EMAILS] };
}

/**
 * Convert absolute hours-from-entry into the between-send deltas Klaviyo wants.
 * A Klaviyo time-delay waits relative to the PREVIOUS action, not to the trigger.
 */
export function flowDelayDeltas(hours = FLOW_DELAYS_HOURS) {
  return hours.slice(1).map((h, i) => h - hours[i]);
}

/**
 * Scheduled sends for the deadline campaigns, derived from the close date.
 *
 * `entryClosesAt` carries its own UTC offset, and the calendar date a merchant
 * means by "entries close September 14" is the date in THAT offset — not the UTC
 * date, which for a late-evening close is already the next day. So the leading
 * YYYY-MM-DD is taken verbatim and the arithmetic is done on the calendar date,
 * which also sidesteps DST entirely.
 */
export function campaignSchedule(entryClosesAt) {
  if (typeof entryClosesAt !== 'string' || Number.isNaN(new Date(entryClosesAt).getTime())) {
    throw new Error(`invalid entry close date: ${entryClosesAt}`);
  }
  const [y, m, d] = entryClosesAt.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) throw new Error(`invalid entry close date: ${entryClosesAt}`);

  return CAMPAIGN_EMAILS.map((file) => {
    const at = new Date(Date.UTC(y, m - 1, d - CAMPAIGN_LEAD_DAYS[file], CAMPAIGN_SEND_HOUR_UTC, 0, 0));
    return { file, sendAt: at.toISOString(), leadDays: CAMPAIGN_LEAD_DAYS[file] };
  });
}

export default { FLOW_EMAILS, CAMPAIGN_EMAILS, FLOW_DELAYS_HOURS, splitNurtureFiles, flowDelayDeltas, campaignSchedule };
