/**
 * Reconcile stored entry state against what Klaviyo actually knows.
 *
 * Owns the two rungs no HTTP request can credit:
 *
 *   confirmed (+2) — a profile that is CURRENTLY in the SUBSCRIBED set has
 *     clicked the double-opt-in link, and that is the only authority on it.
 *     Nothing in a request may set this flag.
 *   referral (+5) — lands on the REFERRER's profile once the friend they
 *     referred confirms. Direction is easy to invert, so state it once: the
 *     ENTRANT names their referrer in gv_referred_by; the credit goes the
 *     other way.
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
 * subscribed profile and never rewritten. From then on the stamp is the proof,
 * so callers must pass every profile on the list (see
 * listProfilesWithConsent) and let `subscribed` decide only who is NEWLY
 * confirmed. A legacy profile whose gv_breakdown.confirmed is already true also
 * counts as proof, so profiles credited before the stamp existed do not regress.
 *
 * Pure: no Klaviyo, no randomness, and the clock is injected — every rule is
 * covered by tests rather than discovered in production. Idempotency comes from
 * comparing stored state to desired state, so a re-run after a partial failure
 * is safe.
 */
import { validateReferral, REFERRAL_CAP, normalizeEmail, entryTotal } from './entries.js';

/**
 * Has this profile EVER confirmed?
 *
 * `subscribed` defaults to true when absent so a caller passing an
 * already-filtered SUBSCRIBED set still behaves correctly.
 */
const confirmedEver = (profile) => {
  if (profile.subscribed !== false) return true;
  const props = profile.properties || {};
  return !!props.gv_confirmed_at || props.gv_breakdown?.confirmed === true;
};

/**
 * @param {Array<{email:string, properties:object, subscribed?:boolean}>} profiles
 *   Every profile on the giveaway list, regardless of current consent.
 * @param {{now?: string}} [options] ISO timestamp used for a first-sighting stamp.
 * @returns {Array<{email:string, entries:number, breakdown:object, confirmedAt:string}>}
 */
export function planEntryUpdates(profiles, { now = new Date().toISOString() } = {}) {
  // Only ever-confirmed profiles matter: an entrant still pending double opt-in
  // has earned no +2, and cannot be a valid referrer either.
  const confirmed = [];
  for (const p of profiles) {
    if (confirmedEver(p)) confirmed.push(p);
  }

  const byEmail = new Map();
  for (const p of confirmed) {
    try { byEmail.set(normalizeEmail(p.email), p); } catch { /* skip unusable rows */ }
  }

  // Count eligible confirmed referees per referrer.
  const earned = new Map();
  for (const p of confirmed) {
    const raw = p.properties?.gv_referred_by;
    if (!raw) continue;
    let referrer;
    try { referrer = normalizeEmail(raw); } catch { continue; }

    const check = validateReferral({
      referrerEmail: referrer,
      entrantEmail: p.email,
      referrerIsConfirmedEntrant: byEmail.has(referrer),
      referrerReferralCredits: 0, // the cap is applied to the total below
    });
    if (!check.ok) continue;
    earned.set(referrer, (earned.get(referrer) || 0) + 1);
  }

  const updates = [];
  for (const [email, profile] of byEmail) {
    const props = profile.properties || {};
    const stored = props.gv_breakdown || {};
    const storedReferrals = Number(stored.referrals ?? 0);
    // Never decrease: a referee who unsubscribes must not claw back a credit
    // already earned, and that also makes re-runs stable.
    const referrals = Math.max(Math.min(earned.get(email) ?? 0, REFERRAL_CAP), storedReferrals);
    // Written once, on first sighting, then carried forward verbatim — this is
    // the record that makes confirmation survive a later unsubscribe.
    const confirmedAt = props.gv_confirmed_at || now;

    if (stored.confirmed === true && referrals === storedReferrals && props.gv_confirmed_at) continue;

    const breakdown = {
      survey: stored.survey === true,
      instagram: stored.instagram === true,
      upload: stored.upload === true,
      confirmed: true,
      referrals,
    };
    updates.push({ email, entries: entryTotal(breakdown), breakdown, confirmedAt });
  }
  return updates;
}
