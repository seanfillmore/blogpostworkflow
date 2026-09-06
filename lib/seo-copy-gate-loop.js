// lib/seo-copy-gate-loop.js
//
// "Generate → check → regenerate ONCE with the offending words named → skip and
// say so", for every agent that generates SEO copy and can regenerate it.
//
// ── Why this is one module and not four copies ──────────────────────────────────
//
// `agents/meta-optimizer/lib/gate.js` shipped this loop on 2026-08-23 for one
// agent. Three more unattended writers needed the identical loop the next day.
// A second hand-written copy of a retry policy is a second copy that drifts —
// the same reason `lib/demand-questions.js` imports AWARENESS_LEVELS and
// `lib/seo-copy-health-gate.js` imports HEALTH_CLAIM_PATTERNS rather than
// restating either. meta-optimizer's `gateProposedCopy` is now a thin wrapper
// over this, with its own field mapping and nothing else.
//
// What genuinely DOES differ per agent is the shape of what the model returns,
// and that is the whole `extract` parameter. `meta-optimizer` returns
// `{title, meta_description}`; `product-optimizer` returns `{seo_title,
// seo_description, body_html}` in one mode and `{new_title}` in another;
// `collection-content-optimizer` returns a 450-650 word `body_html` alongside
// its meta. Mapping all of those onto a two-field `{title, meta}` shape would
// have meant labelling a product body as "meta" in the digest, and — for the
// bare-string cases — silently passing the WRONG SHAPE to `checkSeoCopy`, which
// returns `ok: true` on anything that has no `.title`. Hence named fields.
//
// ── FAIL CLOSED ON THE WRITE, NOT ON THE CANDIDATE ─────────────────────────────
//
// A first-attempt violation costs a RETRY, not the candidate. Dropping the
// candidate on the first hit quietly deletes work from an unattended run and
// nothing says why — the same invisible-failure class as the bad write the gate
// exists to stop. Exactly one retry: two attempts is a fair price, an unbounded
// loop against a model that has decided "heals" is the right word is how an
// unattended run burns a budget on one page.
//
// The retry is not a formality. `seoCopyConstraint` names the exact words that
// tripped, because "avoid health claims" is advice a model can satisfy while
// writing "heals" again. Prevention over detection: callers must ALSO put
// SEO_COPY_COMPLIANCE_RULE in the first prompt, so most runs never get here.

import { checkSeoCopyFields, seoCopyConstraint } from './seo-copy-health-gate.js';
import { checkCopyLength, lengthConstraint } from './seo-copy-length.js';

/**
 * @typedef {object} GateResult
 * @property {boolean} ok
 * @property {any|null} proposed   the generator's return value, when it passed
 * @property {any|null} rejected   the LAST attempt's return value, when it did not
 * @property {Array<{field:string, category:string, why:string, match:string}>} violations
 * @property {Array<{field:string, category:string, why:string, match:string}>} advisory
 * @property {Array<{field:string, kind:string, length:number, max:number, over:number}>} overlong
 *           Fields that SHIPPED over the SERP length limit. Non-empty with
 *           `ok: true` is the normal, intended case — length never blocks a
 *           write (see lib/seo-copy-length.js). Callers should record these.
 * @property {number} attempts
 */

/**
 * @param {(constraint: string) => Promise<any>} generate
 *        Called with `''` first, then with the constraint string if the first
 *        attempt trips the blocking tier. The constraint must be appended to
 *        the prompt.
 * @param {object} opts
 * @param {(result:any) => Record<string,string|undefined|null>} opts.extract
 *        Maps the generator's return value to NAMED copy fields. The names are
 *        what a human reads in the digest, so name them for the surface
 *        ("title", "meta", "body", "faq"), not for the JSON key.
 * @param {string[]} [opts.required]
 *        Field names that must come back non-empty. A null or garbled return
 *        has no blocking hits — there is nothing to match — so it would sail
 *        through the gate and get written as `undefined` over live copy. Fail
 *        it closed here instead.
 * @param {Record<string,'title'|'description'>} [opts.lengths]
 *        field name → SERP copy kind, for the truncation check. A field NOT
 *        named here is never measured, which is what keeps a 650-word
 *        collection `body_html` or an FAQ answer out of a length rule that was
 *        only ever about a SERP snippet. Omit entirely to disable the check.
 * @returns {Promise<GateResult>}
 */
export async function gateGeneratedCopy(generate, { extract, required = [], lengths = {} } = {}) {
  if (typeof extract !== 'function') throw new TypeError('gateGeneratedCopy: `extract` is required');

  let constraint = '';
  let attempts = 0;
  let last = null;
  let check = null;
  let overlong = [];

  // Two passes max — the first unconstrained, the second told what it did wrong.
  for (let i = 0; i < 2; i++) {
    last = await generate(constraint);
    attempts++;

    const fields = last == null ? {} : (extract(last) || {});
    check = checkSeoCopyFields(fields);
    // Length rides INSIDE this same two-attempt budget rather than adding a
    // third call: an over-long field contributes to the retry constraint, and
    // on the second attempt it is reported instead of enforced. See
    // lib/seo-copy-length.js for why it may never block a write.
    overlong = checkCopyLength(fields, lengths).overlong;

    const missing = required.filter((f) => !String(fields[f] ?? '').trim());
    if (missing.length) {
      check = {
        ok: false,
        blocking: [
          ...check.blocking,
          ...missing.map((field) => ({
            field,
            category: 'malformed',
            why: `the generator returned no ${field}`,
            match: '(empty)',
          })),
        ],
        advisory: check.advisory,
      };
    }

    // A length overage is worth a RETRY but never a refusal, so it only holds
    // the loop open while there is a retry left to spend. On the last pass the
    // copy ships and the overage is reported — `overlong` is returned either
    // way, so a caller always sees what it published.
    const isLastPass = i === 1;
    if (check.ok && (overlong.length === 0 || isLastPass)) {
      return { ok: true, proposed: last, rejected: null, violations: [], advisory: check.advisory, overlong, attempts };
    }

    // Only real health-claim hits can be argued with in a prompt; a malformed
    // return is not something the model can be told to "avoid the word" about.
    // Both constraints go in together when both tripped — two separate retries
    // would double the model calls for a defect the model can fix in one pass.
    constraint = [
      seoCopyConstraint(check.blocking.filter((v) => v.category !== 'malformed')),
      lengthConstraint(overlong),
    ].filter(Boolean).join('\n\n');
  }

  // Both attempts blocked. Report the SECOND attempt's violations and text — it
  // is the copy rejected last, and the one a human reading the digest would go
  // looking at.
  return { ok: false, proposed: null, rejected: last, violations: check.blocking, advisory: check.advisory, overlong, attempts };
}
