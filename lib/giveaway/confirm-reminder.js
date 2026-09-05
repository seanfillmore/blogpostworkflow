/**
 * Who gets a SECOND confirmation reminder, and — more importantly — who does not.
 *
 * Pure. No Klaviyo, no I/O, so the send policy can be argued with in a test
 * instead of discovered from a bounce report.
 *
 * WHY A SECOND REMINDER IS A DIFFERENT DECISION FROM THE FIRST. Under
 * `double_opt_in` a nudge was a re-issued CONSENT request and could not carry a
 * promotional message. Under `flow_link` the list is single opt-in: the entrant
 * is subscribed the moment they submit, so this is ordinary marketing email to
 * a consented profile, and the thing being asked for is a click that writes
 * `gv_confirmed` and pays the advertised +2 entries. That inversion is the only
 * reason a reminder campaign is possible at all, and it is why
 * `scripts/giveaway/nudge-unconfirmed.mjs` correctly refuses to run here — its
 * mechanism (re-subscribe to trigger Klaviyo's own opt-in email) sends nothing
 * on a single opt-in list.
 *
 * THE FIRST REMINDER WAS MEASURED, AND THE NUMBERS SET THIS POLICY.
 * Campaign `01M0RZM53084R8VEM8A2MS63PZ`, sent 2026-08-25 14:00 UTC to segment
 * `X7atwC`:
 *
 *   recipients 489 · delivered 487 · opened 133 (27.3%) · CLICKED 33 (6.8%)
 *   unsubscribes 4 · spam complaints 1 · bounced 2
 *
 * A click IS a confirmation here — `update_property_link` writes
 * `gv_confirmed:"true"` — so 33 of 489 is the real recovery rate, and it is the
 * only estimate available for a second send.
 *
 * THE SPAM RATE IS THE BINDING CONSTRAINT, NOT THE YIELD. 1 complaint in 487
 * delivered is **0.21%**. Google and Yahoo's bulk-sender rules enforce at 0.3%
 * and ask senders to stay under 0.1%, so the first reminder already ran at
 * roughly twice the target and two-thirds of the way to the enforcement
 * threshold. A domain reputation problem costs every future Klaviyo send for
 * this store — the flows, the deadline campaigns, the post-purchase sequence —
 * which is worth far more than the entries on offer here. That is the same
 * judgement `nudge-unconfirmed.mjs` recorded ("a complaint against the sending
 * domain costs far more than eight entries") and it survives the mechanism
 * change intact.
 *
 * SO THE POLICY IS: ask people who have never been asked, and leave the rest
 * alone. `alreadyRemindedBefore` is a timestamp cutoff rather than a list of
 * addresses because the first reminder went to the WHOLE unconfirmed segment as
 * it stood at that instant — so "entered after it sent" is an exact statement of
 * "never received it", needs no event queries, and cannot drift as the segment
 * grows. Everyone who entered before that moment got their ask and ignored it;
 * they keep their base entry and are left alone.
 */

/** A profile must have had this long to act on the confirm flow's own email first. */
export const MIN_HOURS_SINCE_ENTRY = 48;

/**
 * Stop reminding once the entry period is this close. A confirmation arriving
 * after entries close pays nothing — the +2 cannot apply to a draw that has
 * already snapshotted — so a send inside this window spends domain reputation
 * on entries that cannot count.
 */
export const MIN_HOURS_BEFORE_DEADLINE = 12;

/**
 * Decide the audience.
 *
 * @param {object[]} unconfirmed  `{ email, createdAt, isTest }` — the live
 *   unconfirmed segment. Confirmation state is NOT re-derived here; membership
 *   of that segment is the statement that they are unconfirmed, and second
 *   guessing it would put a fourth copy of the confirmed-vs-subscribed rule in
 *   the codebase (see `confirmedEmailSet` in ./reconcile.js — that rule lives in
 *   exactly one place on purpose).
 * @param {Date} alreadyRemindedBefore  Anyone who entered before this instant
 *   received the previous reminder.
 * @param {Date} now
 * @param {Date} deadline  Entry period close.
 */
export function selectReminderTargets({
  unconfirmed,
  alreadyRemindedBefore,
  now,
  deadline,
  minHoursSinceEntry = MIN_HOURS_SINCE_ENTRY,
  minHoursBeforeDeadline = MIN_HOURS_BEFORE_DEADLINE,
}) {
  const hoursLeft = (deadline.getTime() - now.getTime()) / 3_600_000;
  if (hoursLeft < minHoursBeforeDeadline) {
    return {
      due: [],
      skipped: unconfirmed.map((p) => ({ email: p.email, reason: 'entry period closing' })),
      // A whole-run refusal, distinct from every profile happening to be
      // ineligible — the caller must be able to tell those apart, because one
      // is "nothing to do" and the other is "too late to do anything".
      halted: `entry period closes in ${hoursLeft.toFixed(1)}h (< ${minHoursBeforeDeadline}h)`,
    };
  }

  const due = [];
  const skipped = [];

  for (const p of unconfirmed) {
    // Test inboxes live in this segment (gv_test). They are ours, so mailing
    // them is harmless, but they inflate the recipient count that every rate
    // below is measured against — and this project has already burned test
    // inboxes once by reusing them.
    if (p.isTest) {
      skipped.push({ email: p.email, reason: 'test profile' });
      continue;
    }
    if (!p.createdAt || Number.isNaN(p.createdAt.getTime())) {
      // Undateable means we cannot tell whether they already got one. The
      // failure direction that matters is "did not pester", never "pestered
      // twice", so an unknown date is a skip.
      skipped.push({ email: p.email, reason: 'no entry date — cannot prove they were not already reminded' });
      continue;
    }
    // `<=`, not `<`: the campaign went to the segment as it stood AT that
    // instant, so a profile created exactly then was in it and received the
    // email. Strict `<` would mail that person twice — and the boundary case
    // errs toward pestering, which is the one direction this policy must not
    // fail in.
    if (p.createdAt <= alreadyRemindedBefore) {
      skipped.push({ email: p.email, reason: 'already reminded once and did not confirm' });
      continue;
    }
    const hoursSinceEntry = (now.getTime() - p.createdAt.getTime()) / 3_600_000;
    if (hoursSinceEntry < minHoursSinceEntry) {
      skipped.push({ email: p.email, reason: `entered ${hoursSinceEntry.toFixed(1)}h ago — confirm flow still working` });
      continue;
    }
    due.push(p);
  }

  return { due, skipped, halted: null };
}

/**
 * What the send is expected to cost and return, from the first reminder's own
 * measured rates. Reported BEFORE `--apply` so the trade is visible at the
 * moment of choosing, not reconstructed afterwards.
 *
 * These are the first send's rates applied to a second send, which is optimistic
 * in one direction and conservative in another: the audience here has never been
 * asked (like the first send's audience, so the rate should hold), but it is
 * also a colder, older cohort by the time it is mailed. Treat the output as an
 * order of magnitude, never a forecast — the same caution the CTR program's
 * benchmark curve carries.
 */
export const FIRST_REMINDER = Object.freeze({
  campaignId: '01M0RZM53084R8VEM8A2MS63PZ',
  sentAt: '2026-08-25T14:00:00Z',
  recipients: 489,
  delivered: 487,
  opensUnique: 133,
  clicksUnique: 33,
  unsubscribes: 4,
  spamComplaints: 1,
  bounced: 2,
});

/** Google/Yahoo enforce bulk-sender complaint rates at this level. */
export const SPAM_COMPLAINT_ENFORCEMENT_RATE = 0.003;
/** ...and ask senders to stay below this. */
export const SPAM_COMPLAINT_TARGET_RATE = 0.001;

export function projectReminderOutcome(recipientCount, observed = FIRST_REMINDER) {
  const confirmRate = observed.clicksUnique / observed.delivered;
  const unsubRate = observed.unsubscribes / observed.delivered;
  const spamRate = observed.spamComplaints / observed.delivered;
  return {
    recipients: recipientCount,
    confirmRate,
    spamRate,
    expectedConfirmations: Math.round(recipientCount * confirmRate),
    expectedUnsubscribes: Math.round(recipientCount * unsubRate),
    expectedSpamComplaints: Math.round(recipientCount * spamRate),
    // Stated as a flag rather than a refusal: the observed rate is one complaint
    // out of 487, so the estimate itself is n=1 and refusing on it would be
    // acting on noise. A human reads this and decides.
    aboveComplaintTarget: spamRate > SPAM_COMPLAINT_TARGET_RATE,
    aboveComplaintEnforcement: spamRate > SPAM_COMPLAINT_ENFORCEMENT_RATE,
  };
}
