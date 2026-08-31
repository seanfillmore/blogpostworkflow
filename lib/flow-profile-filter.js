/**
 * "Does this flow still suppress the profiles it is supposed to suppress?"
 *
 * A flow's `profile_filter` is the quietest thing in Klaviyo to lose. It is invisible
 * in the flow's email content, nothing downstream reads it, and a GO-LIVE REBUILDS THE
 * FLOW — `createFlow()` mints a new id and the old one is retired, so a filter added by
 * hand in the UI survives only if whoever wrote the new definition remembered it.
 *
 * The case this exists for: the Welcome Series suppresses `gv_entrant` profiles so
 * FIRST20 does not stack on the giveaway's day-30 offer, costing ~$20 of a $40
 * contribution per entrant. It was added in the UI on 2026-08-14 against flow
 * `UUa3Qk`; a go-live on 2026-08-31 replaced that flow with `V5fp5i`. The filter did
 * carry over — verified before `UUa3Qk` was deleted, and the two definitions were
 * byte-identical — but nothing had checked, and nothing would have said if it had not.
 *
 * Pure. The caller fetches the definition.
 */

/**
 * Is `property` gated by an existence/`not-set` condition anywhere in the filter?
 *
 * Klaviyo ANDs `condition_groups` and ORs the conditions WITHIN a group — the inverse
 * of what the nesting reads like. A suppression must therefore sit in its OWN group,
 * or it is ORed against the metric gates and a profile passing any one of them slips
 * through. So this only counts a condition in a group that contains nothing else.
 */
export function suppressesProperty(definition, property) {
  const groups = definition?.profile_filter?.condition_groups;
  if (!Array.isArray(groups)) return { suppressed: false, reason: 'no profile_filter on this flow' };

  for (const group of groups) {
    const conditions = group?.conditions ?? [];
    const hit = conditions.find(
      (c) =>
        c?.type === 'profile-property' &&
        c?.property === `properties['${property}']` &&
        c?.filter?.type === 'existence' &&
        c?.filter?.operator === 'not-set',
    );
    if (!hit) continue;
    if (conditions.length > 1) {
      return {
        suppressed: false,
        reason:
          `the ${property} condition shares a group with ${conditions.length - 1} other ` +
          'condition(s) — conditions within a group are ORed, so it does not gate anything',
      };
    }
    return { suppressed: true };
  }
  return { suppressed: false, reason: `no ${property} condition in any group` };
}
