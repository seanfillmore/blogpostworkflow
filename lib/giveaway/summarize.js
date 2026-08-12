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
