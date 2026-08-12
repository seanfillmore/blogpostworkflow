/**
 * Entry-ladder rules for the 2026-09 soap giveaway.
 *
 * Single source of truth for what an action is worth. The public endpoint, the
 * nightly referral reconciler, the daily report and Phase 2's weighted draw all
 * read from here so they cannot disagree about a total.
 *
 * NOTE: there is deliberately no `purchase` rung. Awarding entries for buying
 * would make the promotion a lottery rather than a sweepstakes in most states,
 * which matters because a $99 offer follows the draw.
 */

export const ENTRY_VALUES = {
  base: 1,
  confirm: 2,
  survey: 3,
  referral: 5,
  instagram: 3,
  upload: 10,
};

export const REFERRAL_CAP = 10;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw) {
  const email = String(raw ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error(`invalid email: ${JSON.stringify(raw)}`);
  return email;
}

export function entryTotal(breakdown = {}) {
  const {
    confirmed = false, survey = false, referrals = 0,
    instagram = false, upload = false,
  } = breakdown;
  // A non-numeric `referrals` (null from a hand-edited profile, a string from a
  // bad import, undefined-into-Number) must not poison the total: Math.max(0,
  // NaN) is NaN, NaN * 5 is NaN, and the sum below would be written straight to
  // Klaviyo as `gv_entries: NaN` -- which serialises to null and shows the
  // entrant no count at all. lib/giveaway/summarize.js already guards this
  // exact class on the READ side; the writer has to guard it too, or the
  // corrupt value is what gets stored in the first place.
  const raw = Number(referrals);
  const credited = Math.min(Math.max(0, Math.floor(Number.isFinite(raw) ? raw : 0)), REFERRAL_CAP);
  return ENTRY_VALUES.base
    + (confirmed ? ENTRY_VALUES.confirm : 0)
    + (survey ? ENTRY_VALUES.survey : 0)
    + credited * ENTRY_VALUES.referral
    + (instagram ? ENTRY_VALUES.instagram : 0)
    + (upload ? ENTRY_VALUES.upload : 0);
}

export function validateReferral({
  referrerEmail, entrantEmail, referrerIsConfirmedEntrant, referrerReferralCredits = 0,
}) {
  let referrer;
  let entrant;
  try {
    referrer = normalizeEmail(referrerEmail);
    entrant = normalizeEmail(entrantEmail);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  if (referrer === entrant) return { ok: false, reason: 'self-referral is not eligible' };
  if (!referrerIsConfirmedEntrant) {
    return { ok: false, reason: 'referrer is not a confirmed entrant' };
  }
  if (referrerReferralCredits >= REFERRAL_CAP) {
    return { ok: false, reason: `referrer is at the ${REFERRAL_CAP}-referral cap` };
  }
  return { ok: true, reason: null };
}
