/**
 * Health-claim gate for meta-optimizer's proposed title + meta description.
 *
 * Split out of index.js for the same reason lib/sort.js, lib/grounding.js and
 * lib/hold.js are: index.js calls loadEnv() and can process.exit at import time,
 * so anything living there cannot be tested without a network and a .env.
 *
 * ── FAIL CLOSED ON THE WRITE, NOT ON THE CANDIDATE ─────────────────────────────
 *
 * A first-attempt violation costs a RETRY, not the candidate. Dropping the
 * candidate on the first hit would quietly delete CTR work from a weekly
 * unattended `--apply --limit 5` run — the page would simply never be optimised
 * and nothing would say why. Silent removal is the same class of bug as the
 * silent bad write this gate exists to stop; a safety fix that causes it has
 * traded one invisible failure for another.
 *
 * So: generate → check → if blocked, regenerate ONCE with the offending words
 * named in the prompt → if that trips too, skip and say so, loudly, in the digest.
 *
 * Exactly one retry. Two attempts at $0-ish each is a fair price for a rewrite;
 * an unbounded loop against a model that has decided "heals" is the right word is
 * how an unattended run burns a budget on one page.
 *
 * The retry is not a formality — the constraint names the exact words that
 * tripped, because "avoid health claims" is advice a model can satisfy while
 * writing "heals" again. Prevention over detection: the FIRST prompt already
 * carries SEO_COPY_COMPLIANCE_RULE, so most runs should never reach the retry.
 */

import { checkSeoCopy, seoCopyConstraint } from '../../../lib/seo-copy-health-gate.js';

/**
 * @param {(constraint: string) => Promise<{title?:string, meta_description?:string}|null>} generate
 *        Called with '' first, then with the constraint string if the first
 *        attempt trips the blocking tier.
 * @returns {Promise<{
 *   ok: boolean,
 *   proposed: {title?:string, meta_description?:string}|null,
 *   rejected: {title?:string, meta_description?:string}|null,
 *   violations: Array<{field:string, category:string, why:string, match:string}>,
 *   advisory: Array<{field:string, category:string, why:string, match:string}>,
 *   attempts: number,
 * }>}
 */
export async function gateProposedCopy(generate) {
  let constraint = '';
  let attempts = 0;
  let last = null;
  let check = null;

  // Two passes max — the first unconstrained, the second told what it did wrong.
  for (let i = 0; i < 2; i++) {
    last = await generate(constraint);
    attempts++;
    check = checkSeoCopy({ title: last?.title, meta: last?.meta_description });

    // A null/garbled return has no blocking hits (there is nothing to match), so
    // it would sail through the gate. Fail it closed here rather than proposing
    // a write of `undefined` over a live title.
    if (!last?.title) {
      check = {
        ok: false,
        blocking: [{ field: 'title', category: 'malformed', why: 'the rewriter returned no title', match: '(empty)' }],
        advisory: check.advisory,
      };
    }

    if (check.ok) {
      return { ok: true, proposed: last, rejected: null, violations: [], advisory: check.advisory, attempts };
    }
    constraint = seoCopyConstraint(check.blocking);
  }

  // Both attempts blocked. Report the SECOND attempt's violations and text — it
  // is the copy that was rejected last, and the one a human reading the digest
  // would go looking at.
  return { ok: false, proposed: null, rejected: last, violations: check.blocking, advisory: check.advisory, attempts };
}
