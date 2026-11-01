/**
 * What may the resolver do to a WINNER page? Pure, split out because
 * agents/cannibalization-resolver/index.js runs on import.
 *
 * Operator decision 2026-10-03: never LLM-merge another post into a locked
 * winner; redirect the loser to it instead. The SLS toothpaste page (the blog's
 * biggest, #5) was merged into twice in a week (2026-09-06 and 09-13) and fell
 * to #10 on the day of the second merge. A winner already ranks: what it needs
 * from a cannibalizing sibling is the sibling's signal (a 301), not the
 * sibling's prose stitched into its body by a model.
 *
 * Two different holds, deliberately:
 *   TIMING (freeze, the 28-day window after the winner's last material change,
 *   or unreadable state) holds the WHOLE pair, the redirect included. Pointing
 *   losers at a page under measurement changes that page too; both redirects
 *   that fired on 2026-09-13 landed on the SLS page the day it dropped. The pair
 *   re-proposes on a later run, because detection is re-derived from live GSC.
 *   LOCK (a locked winner) is permanent, so it does not hold: it downgrades a
 *   CONSOLIDATE to a REDIRECT. The loser's unique copy is given up on purpose.
 *
 * @param {'CONSOLIDATE'|'REDIRECT'} action the model's call for this loser
 * @param {{now:string, freeze?:object|null, locked?:boolean, unreadable?:boolean,
 *          lastMaterialAt?:string|null}} facts from lib/post-edit-gate.js readEditFacts
 * @param {(kind:string, facts:object)=>{allowed:boolean, reason:string, until?:string}} decideEdit
 * @returns {{action:'CONSOLIDATE'|'REDIRECT'|'HOLD', reason:string, until?:string}}
 */
export function decideWinnerAction(action, facts, decideEdit) {
  // `serp` is the gate's timing-only question: freeze, cooldown, unreadable,
  // and no lock term (a winner's title may be tested; its body may not).
  const timing = decideEdit('serp', facts);
  if (!timing.allowed) return { action: 'HOLD', reason: timing.reason, until: timing.until };
  if (action === 'CONSOLIDATE' && facts.locked) {
    return { action: 'REDIRECT', reason: 'locked winner: loser redirected to it instead of merged into it' };
  }
  return { action, reason: 'winner open to this change' };
}
