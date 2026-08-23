/**
 * Reconcile stored entry state against what Klaviyo actually knows.
 *
 * Owns the two rungs no HTTP request can credit:
 *
 *   confirmed (+2) — the entrant clicked the confirmation link. HOW that click
 *     is observed depends on the mechanism (below). Nothing in a request may
 *     set this flag.
 *   referral (+5) — lands on the REFERRER's profile once the friend they
 *     referred confirms. Direction is easy to invert, so state it once: the
 *     ENTRANT names their referrer in gv_referred_by; the credit goes the
 *     other way.
 *
 * TWO MECHANISMS, AND THEY DISAGREE ABOUT EVERY ENTRANT ON THE LIST.
 *
 *   DOUBLE_OPT_IN — the Klaviyo list is double opt-in, so Klaviyo only ADDS a
 *     profile to the list once the opt-in link is clicked. Membership of the
 *     SUBSCRIBED set therefore IS the confirmation, and is the only authority
 *     on it.
 *   FLOW_LINK — the list is SINGLE opt-in and the entrant is subscribed the
 *     moment they submit the form, so a branded flow email carries the
 *     confirmation link instead (Klaviyo's update_property_link, which writes
 *     gv_confirmed). Subscription now proves NOTHING: reading it as
 *     confirmation would pay the +2 to every entrant who ever submitted the
 *     form, and would pay every §5 referral rung along with it.
 *
 * The mechanism is passed in, never inferred, and an unrecognised value throws.
 * These two branches disagree about the entire population at once, so a config
 * typo silently resolving to a default is the one failure mode worth a crash.
 *
 * WHY gv_confirmed IS COMPARED AGAINST A STRING. update_property_link takes its
 * value as a quoted literal — `{% update_property_link 'gv_confirmed' 'true'
 * ... %}` — so the property arrives as the STRING 'true'. A `=== true` test
 * would pass every unit test written with a boolean fixture and reject every
 * real confirmation in production. Both spellings are accepted and nothing
 * else is, so a hand-edited profile or a stray import cannot pay the rung.
 *
 * CONFIRMATION IS DURABLE, CONSENT IS NOT. Official rules §12 promises the draw
 * snapshot is taken "independent of ongoing email subscription status", so
 * confirmation has to survive an unsubscribe. Current consent is a point-in-time
 * read; a confirmation click is history. Someone who confirms at 14:00 and
 * unsubscribes at 16:00 is gone from the SUBSCRIBED set before the 08:30 run
 * ever sees them, so treating that set as the whole truth would leave their +2
 * uncredited forever and would let every friend they referred credit nobody.
 *
 * The fix is a stamp: gv_confirmed_at, written on the FIRST sighting of a
 * confirmed profile and never rewritten. From then on the stamp is the proof,
 * so callers must pass every profile on the list (see listProfilesWithConsent).
 * A legacy profile whose gv_breakdown.confirmed is already true also counts as
 * proof, so profiles credited before the stamp existed do not regress. Both of
 * those records are mechanism-independent BY DESIGN: they are what carries an
 * entrant who confirmed under double opt-in across the cutover, and without
 * them the switch would strip 2 entries from everyone already confirmed.
 *
 * Pure: no Klaviyo, no randomness, and the clock is injected — every rule is
 * covered by tests rather than discovered in production. Idempotency comes from
 * comparing stored state to desired state, so a re-run after a partial failure
 * is safe.
 */
import { validateReferral, REFERRAL_CAP, normalizeEmail, entryTotal } from './entries.js';

/**
 * How a confirmation click is observed. Mirrors config/giveaway.json's
 * `confirmMechanism`; see the header for why the two cannot be conflated.
 */
export const CONFIRM_MECHANISMS = {
  DOUBLE_OPT_IN: 'double_opt_in',
  FLOW_LINK: 'flow_link',
};

const KNOWN_MECHANISMS = new Set(Object.values(CONFIRM_MECHANISMS));

function assertMechanism(mechanism) {
  if (!KNOWN_MECHANISMS.has(mechanism)) {
    throw new Error(
      `unknown confirm mechanism ${JSON.stringify(mechanism)} — expected one of ${[...KNOWN_MECHANISMS].join(', ')}`,
    );
  }
  return mechanism;
}

/**
 * Has this profile EVER confirmed?
 *
 * @param {{properties?:object, subscribed?:boolean}} profile
 * @param {{mechanism?: string}} [options] Defaults to DOUBLE_OPT_IN so a caller
 *   that has not been updated yet keeps the behaviour it shipped with — this
 *   library lands before the Klaviyo list is flipped.
 */
export const confirmedEver = (profile, { mechanism = CONFIRM_MECHANISMS.DOUBLE_OPT_IN } = {}) => {
  assertMechanism(mechanism);
  const props = profile.properties || {};

  // Durable proof, valid under BOTH mechanisms — this is the cutover bridge.
  if (props.gv_confirmed_at) return true;
  if (props.gv_breakdown?.confirmed === true) return true;
  // Written by the flow email's update_property_link. Accepted under both
  // mechanisms: it can only exist because someone clicked, and during the
  // cutover both signals are briefly in flight at once.
  if (props.gv_confirmed === true || props.gv_confirmed === 'true') return true;

  // Under FLOW_LINK everyone is subscribed, so subscription is not evidence.
  if (mechanism === CONFIRM_MECHANISMS.FLOW_LINK) return false;

  // Under DOUBLE_OPT_IN, membership of the subscribed set IS the click.
  // `subscribed` defaults to true when absent so a caller passing an
  // already-filtered SUBSCRIBED set still behaves correctly.
  return profile.subscribed !== false;
};

/**
 * Read the mechanism out of config/giveaway.json.
 *
 * One reader, because "is this entrant confirmed?" is asked by the reconciler,
 * the report funnel, the referral audit, the nudge selector and the launch
 * gate — and a per-script default is how half a toolchain ends up on one
 * mechanism while the other half is on the other.
 */
export function resolveMechanism(config = {}) {
  return assertMechanism(config.confirmMechanism ?? CONFIRM_MECHANISMS.DOUBLE_OPT_IN);
}

/**
 * The set of normalised emails that have EVER confirmed.
 *
 * Replaces the `profiles.filter((p) => p.subscribed)` idiom that was copied
 * into five scripts back when subscription and confirmation were the same
 * event. They are not the same event under FLOW_LINK, and an unmigrated copy
 * of that filter reports every entrant as confirmed.
 */
export function confirmedEmailSet(profiles = [], { mechanism = CONFIRM_MECHANISMS.DOUBLE_OPT_IN } = {}) {
  assertMechanism(mechanism);
  const set = new Set();
  for (const p of profiles) {
    let email;
    try { email = normalizeEmail(p.email); } catch { continue; }
    if (confirmedEver(p, { mechanism })) set.add(email);
  }
  return set;
}

/**
 * @param {Array<{email:string, properties:object, subscribed?:boolean}>} profiles
 *   Every profile on the giveaway list, regardless of current consent.
 * @param {{now?: string, mechanism?: string}} [options] ISO timestamp used for a
 *   first-sighting stamp, and how a confirmation click is observed.
 * @returns {Array<{email:string, entries:number, breakdown:object, confirmedAt:string}>}
 */
export function planEntryUpdates(profiles, {
  now = new Date().toISOString(),
  mechanism = CONFIRM_MECHANISMS.DOUBLE_OPT_IN,
} = {}) {
  assertMechanism(mechanism);
  // EVERY entrant, confirmed or not. An unconfirmed profile earns no +2 and is
  // excluded from the referee loop below, but it can still RECEIVE a referral
  // credit: §5 pays "+5 entries per confirmed friend" and conditions that on the
  // FRIEND confirming, never on the referrer's own confirmation. Only §6's prize
  // clause requires a confirmed referrer, and that is a draw-time test.
  //
  // Callers must therefore pass submitted-but-unlisted profiles too. Under
  // DOUBLE_OPT_IN that is a real distinction — Klaviyo only adds a profile to
  // the list once opt-in completes, so the list alone is the confirmed set.
  // Under FLOW_LINK the list holds every entrant and confirmation is a property
  // on the profile, so the caller's job is simply "pass everyone" either way.
  // See reconcile-referrals.mjs.
  const byEmail = new Map();
  for (const p of profiles) {
    try { byEmail.set(normalizeEmail(p.email), p); } catch { /* skip unusable rows */ }
  }

  const confirmedEmails = new Set();
  for (const [email, p] of byEmail) {
    if (confirmedEver(p, { mechanism })) confirmedEmails.add(email);
  }

  // Count eligible referees per referrer. The referee MUST be confirmed — that
  // is the half of the rule §5 actually states.
  const earned = new Map();
  for (const email of confirmedEmails) {
    const p = byEmail.get(email);
    const raw = p.properties?.gv_referred_by;
    if (!raw) continue;
    let referrer;
    try { referrer = normalizeEmail(raw); } catch { continue; }

    const check = validateReferral({
      referrerEmail: referrer,
      entrantEmail: p.email,
      referrerIsEntrant: byEmail.has(referrer),
      referrerReferralCredits: 0, // the cap is applied to the total below
    });
    if (!check.ok) continue;
    earned.set(referrer, (earned.get(referrer) || 0) + 1);
  }

  const updates = [];
  for (const [email, profile] of byEmail) {
    const isConfirmed = confirmedEmails.has(email);
    const earnedReferrals = earned.get(email) ?? 0;
    // Touch nothing else. Writing to every submitted profile would be 200+
    // pointless Klaviyo calls a night against people who have earned nothing.
    if (!isConfirmed && earnedReferrals === 0) continue;

    const props = profile.properties || {};
    const stored = props.gv_breakdown || {};
    const storedReferrals = Number(stored.referrals ?? 0);
    // Never decrease: a referee who unsubscribes must not claw back a credit
    // already earned, and that also makes re-runs stable.
    const referrals = Math.max(Math.min(earnedReferrals, REFERRAL_CAP), storedReferrals);
    // Written once, on first sighting, then carried forward verbatim — this is
    // the record that makes confirmation survive a later unsubscribe. NULL for
    // someone who has not confirmed: the caller must not write the key at all
    // rather than store a null over a real stamp.
    const confirmedAt = isConfirmed ? (props.gv_confirmed_at || now) : null;

    const settled = stored.confirmed === isConfirmed
      && referrals === storedReferrals
      && (!isConfirmed || Boolean(props.gv_confirmed_at));
    if (settled) continue;

    const breakdown = {
      survey: stored.survey === true,
      instagram: stored.instagram === true,
      upload: stored.upload === true,
      confirmed: isConfirmed,
      referrals,
    };
    updates.push({ email, entries: entryTotal(breakdown), breakdown, confirmedAt });
  }
  return updates;
}
