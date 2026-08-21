/**
 * Roll confirmed entrant profiles into the daily report shape.
 *
 * Deferring the offer to day 30 removes every in-flight revenue signal, so the
 * answer mix and ladder participation below ARE the campaign's early gates.
 */
import { isTestProfile } from './test-identity.js';

const ANSWER_KEYS = [
  // Collected today by the three required questions on /pages/giveaway-entered:
  'gv_household', 'gv_frustration', 'gv_current_brand',
  // WIRED BUT NOT YET COLLECTED. The spec's three OPTIONAL questions were never
  // built into the entered page or any email, so these buckets are always empty
  // in production. An empty bucket here means "nobody was asked", NOT "nobody
  // picked that answer" — do not read a zero as a finding. Kept wired (enum
  // validation lives in agents/dashboard/routes/giveaway.js ENUMS) so adding the
  // UI is a one-file change, pending a product decision on the extra drop-off.
  'gv_switch_blocker', 'gv_unscented_reaction',
];

export function summarizeEntrants(profiles) {
  // Test identities live on the PRODUCTION list on purpose, so that the harness
  // exercises the configuration we actually launch with. They must never reach a
  // count: a fake 24-entry profile would distort the day-5 answer-mix gate that
  // decides whether ad spend continues.
  const all = profiles || [];
  const excludedTestProfiles = all.filter((p) => isTestProfile(p.properties)).length;
  profiles = all.filter((p) => !isTestProfile(p.properties));

  const answers = {};
  for (const key of ANSWER_KEYS) answers[key.replace(/^gv_/, '').replace(/_(.)/g, (_, c) => c.toUpperCase())] = {};

  const ladder = { confirmed: 0, survey: 0, referrals: 0, instagram: 0, upload: 0, entrantsWithReferrals: 0 };
  let entriesTotal = 0;

  for (const profile of profiles) {
    const props = profile.properties || {};
    // A corrupt gv_entries must not silently poison the total -- NaN + x is NaN
    // for every later addition, and the day-5 spend decision is made from this
    // number. Fall back to 1 rather than propagating NaN.
    const n = Number(props.gv_entries ?? 1);
    entriesTotal += Number.isFinite(n) ? n : 1;

    const b = props.gv_breakdown || {};
    if (b.confirmed) ladder.confirmed += 1;
    if (b.survey) ladder.survey += 1;
    if (b.instagram) ladder.instagram += 1;
    if (b.upload) ladder.upload += 1;
    const refs = Number(b.referrals ?? 0);
    if (refs > 0) { ladder.referrals += refs; ladder.entrantsWithReferrals += 1; }

    for (const key of ANSWER_KEYS) {
      const value = props[key];
      if (!value) continue;
      const bucket = answers[key.replace(/^gv_/, '').replace(/_(.)/g, (_, c) => c.toUpperCase())];
      bucket[value] = (bucket[value] || 0) + 1;
    }
  }

  return { total: profiles.length, entriesTotal, ladder, answers, excludedTestProfiles };
}

/**
 * How long an entrant must have existed before their non-confirmation means anything.
 *
 * Equal to the nudge's MIN_HOURS_BETWEEN by definition: a "mature" entrant is one the
 * re-confirmation nudge has already had its first chance at. A test asserts the two stay
 * equal, because the day they drift this metric quietly starts lying again.
 */
export const CONFIRM_MATURITY_HOURS = 48;

/**
 * Split the submission funnel into what can be judged and what is still in flight.
 *
 * The raw rate — all-time confirmations over all-time submissions — is not wrong, it is
 * unreadable while a campaign is running: every new entrant lands in the denominator
 * immediately and can only reach the numerator later, so the number is dragged down in
 * proportion to how well the ads are working. On 2026-08-21 it printed 26% across a
 * population where the OLDEST entrant was 31 hours old, confirmation was climbing with
 * age (18% under 6h -> 24% at 6-24h -> 36% at 24-48h), and the nudge had not fired once.
 * Read literally, that number says "fix the funnel". It actually said "wait".
 *
 * `matured.rate` is null rather than 0 when nobody qualifies yet. A 0 there would render
 * as total failure and is the exact misreading this function exists to prevent.
 *
 * @param {{email:string, properties?:object}[]} submitted   everyone who submitted the form
 * @param {Set<string>} confirmedEmails                      lowercase emails on the list
 * @param {number} now                                       epoch ms
 * @returns {{submitted:number, confirmed:number, unconfirmed:number, confirmationRate:number|null,
 *            matured:{submitted:number, confirmed:number, rate:number|null},
 *            pending:number, undateable:number, maturityHours:number}}
 */
export function confirmationFunnel({
  submitted = [], confirmedEmails = new Set(), now = Date.now(),
  maturityHours = CONFIRM_MATURITY_HOURS,
} = {}) {
  const isConfirmed = (email) => confirmedEmails.has(String(email || '').toLowerCase().trim());

  let confirmed = 0;
  let matureSubmitted = 0;
  let matureConfirmed = 0;
  let pending = 0;
  let undateable = 0;

  for (const p of submitted) {
    const ok = isConfirmed(p.email);
    if (ok) confirmed += 1;

    const raw = p.properties?.gv_entered_at;
    const t = raw ? Date.parse(raw) : NaN;
    if (!Number.isFinite(t)) {
      // Cannot age it, so it cannot be judged. Counted, never assumed mature —
      // folding these in would drag the readable rate back toward the raw one.
      undateable += 1;
      continue;
    }
    if ((now - t) / 3_600_000 >= maturityHours) {
      matureSubmitted += 1;
      if (ok) matureConfirmed += 1;
    } else if (!ok) {
      pending += 1;
    }
  }

  const round2 = (n) => Math.round(n * 100) / 100;
  return {
    submitted: submitted.length,
    confirmed,
    unconfirmed: Math.max(0, submitted.length - confirmed),
    confirmationRate: submitted.length ? round2(confirmed / submitted.length) : null,
    matured: {
      submitted: matureSubmitted,
      confirmed: matureConfirmed,
      rate: matureSubmitted ? round2(matureConfirmed / matureSubmitted) : null,
    },
    pending,
    undateable,
    maturityHours,
  };
}
