/**
 * Drop digest failures that have since RECOVERED.
 *
 * Sean, 2026-10-04: "If there was a temporary outage but everything is
 * operational at the time of the report I should not hear about it." The 5 AM
 * digest listed three `Creator outreach failed` rows (a Hushmail TLS drop at
 * 04:01, 05:01 and 07:31 UTC on 2026-10-03) although every run after each one
 * succeeded. A Failures block that reports self-healed blips is how a real
 * failure stops being read.
 *
 * Rule: an `error` row is RECOVERED when a LATER row from the same reporter,
 * with the same subject stem, has any status other than `error` — the reporter
 * ran again and completed. Evidence may come from the digest day itself or from
 * the report day up to the moment of sending. An error with no later run stays,
 * because as far as anything can tell it is still broken.
 *
 * "Same reporter" needs BOTH halves, deliberately:
 *   - `source` (the entry script, stamped by lib/notify.js) so two agents that
 *     share a category ("creators" = creator-outreach AND trybe-review) can never
 *     clear each other. Older rows carry no source; a missing source on either
 *     side is treated as unknown and the other half decides.
 *   - the subject STEM (text before ":" / " — ", minus a trailing
 *     "failed"/"error"), so a library warning raised inside an agent
 *     ("Shopify API version fell forward") is not cleared by that agent's
 *     ordinary success row.
 * Plus `category`, which every row carries.
 */

const FAIL_WORDS = /\s+(failed|failure|error|errored|crashed)\s*$/i;

export function subjectStem(subject) {
  return String(subject || '')
    .replace(/^[^\p{L}\p{N}]+/u, '')     // leading emoji / punctuation
    .split(/:| [—–-] /)[0]
    .replace(FAIL_WORDS, '')
    .trim()
    .toLowerCase();
}

function sameReporter(a, b) {
  if (a.source && b.source && a.source !== b.source) return false;
  return (a.category || '') === (b.category || '') && subjectStem(a.subject) === subjectStem(b.subject);
}

/**
 * @param {object[]} entries     the digest day's rows
 * @param {object[]} [laterRows] rows written after the digest day (the report day so far)
 * @returns {{ kept: object[], recovered: object[] }}
 */
export function dropRecoveredFailures(entries, laterRows = []) {
  const evidence = [...entries, ...laterRows];
  const kept = [];
  const recovered = [];
  for (const e of entries) {
    if (e.status !== 'error') { kept.push(e); continue; }
    const ok = evidence.some((r) => r !== e && r.status !== 'error'
      && String(r.ts || '') > String(e.ts || '') && sameReporter(e, r));
    (ok ? recovered : kept).push(e);
  }
  return { kept, recovered };
}
