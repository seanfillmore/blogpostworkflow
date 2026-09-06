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

// The loop itself now lives in lib/seo-copy-gate-loop.js — three more unattended
// writers needed it verbatim on 2026-08-24, and a hand-copied retry policy is a
// retry policy that drifts. What stays here is the only thing that is genuinely
// meta-optimizer's: the mapping from THIS agent's rewriter shape
// ({title, meta_description}) onto the gate's named fields.
import { gateGeneratedCopy } from '../../../lib/seo-copy-gate-loop.js';

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
  return gateGeneratedCopy(generate, {
    extract: (r) => ({ title: r?.title, meta: r?.meta_description }),
    required: ['title'],
    // Both are real SERP surfaces. The title is measured on its RENDERED form —
    // the theme appends " – Real Skin Care" unless the title already contains
    // it — so `renderTitle` in lib/seo-copy-length.js reproduces that Liquid
    // rather than counting the authored string.
    lengths: { title: 'title', meta: 'description' },
  });
}
