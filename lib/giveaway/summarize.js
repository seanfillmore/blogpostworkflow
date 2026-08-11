/**
 * Roll confirmed entrant profiles into the daily report shape.
 *
 * Deferring the offer to day 30 removes every in-flight revenue signal, so the
 * answer mix and ladder participation below ARE the campaign's early gates.
 */
const ANSWER_KEYS = [
  'gv_household', 'gv_frustration', 'gv_current_brand',
  'gv_switch_blocker', 'gv_unscented_reaction',
];

export function summarizeEntrants(profiles) {
  const answers = {};
  for (const key of ANSWER_KEYS) answers[key.replace(/^gv_/, '').replace(/_(.)/g, (_, c) => c.toUpperCase())] = {};

  const ladder = { confirmed: 0, survey: 0, referrals: 0, instagram: 0, upload: 0, entrantsWithReferrals: 0 };
  let entriesTotal = 0;

  for (const profile of profiles) {
    const props = profile.properties || {};
    entriesTotal += Number(props.gv_entries ?? 1);

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

  return { total: profiles.length, confirmed: ladder.confirmed, entriesTotal, ladder, answers };
}
