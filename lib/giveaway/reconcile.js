/**
 * Reconcile stored entry state against what Klaviyo actually knows.
 *
 * Owns the two rungs no HTTP request can credit:
 *
 *   confirmed (+2) — every profile passed in came from listSubscribedProfiles,
 *     which filters to SUBSCRIBED consent. Being in that set IS the
 *     double-opt-in confirmation, and it is the only authority on it. Nothing
 *     in a request may set this flag.
 *   referral (+5) — lands on the REFERRER's profile once the friend they
 *     referred confirms. Direction is easy to invert, so state it once: the
 *     ENTRANT names their referrer in gv_referred_by; the credit goes the
 *     other way.
 *
 * Pure: no Klaviyo, no clock, no randomness — every rule is covered by tests
 * rather than discovered in production. Idempotency comes from comparing stored
 * state to desired state, so a re-run after a partial failure is safe.
 */
import { validateReferral, REFERRAL_CAP, normalizeEmail, entryTotal } from './entries.js';

export function planEntryUpdates(confirmedProfiles) {
  const byEmail = new Map();
  for (const p of confirmedProfiles) {
    try { byEmail.set(normalizeEmail(p.email), p); } catch { /* skip unusable rows */ }
  }

  // Count eligible confirmed referees per referrer.
  const earned = new Map();
  for (const p of confirmedProfiles) {
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
    const stored = profile.properties?.gv_breakdown || {};
    const storedReferrals = Number(stored.referrals ?? 0);
    // Never decrease: a referee who unsubscribes must not claw back a credit
    // already earned, and that also makes re-runs stable.
    const referrals = Math.max(Math.min(earned.get(email) ?? 0, REFERRAL_CAP), storedReferrals);

    if (stored.confirmed === true && referrals === storedReferrals) continue;

    const breakdown = {
      survey: stored.survey === true,
      instagram: stored.instagram === true,
      upload: stored.upload === true,
      confirmed: true,
      referrals,
    };
    updates.push({ email, entries: entryTotal(breakdown), breakdown });
  }
  return updates;
}
