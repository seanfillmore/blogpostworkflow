/**
 * Literal, text-level edits to a Shopify theme template JSON.
 *
 * These templates are edited as RAW TEXT and never parsed-then-reserialised.
 * Shopify stores them with its own escaping and key order — notably forward
 * slashes escaped, so `</p>` is stored as `<\/p>` — and a reserialise rewrites
 * the whole file, which both defeats review and is a much larger write than the
 * change warrants. See reference_theme_json_template_escaping.
 *
 * The contract is deliberately unforgiving: an edit whose BEFORE does not occur
 * exactly once THROWS, and the caller is expected to abandon the whole run
 * rather than push a partially-applied template. A miss means the live template
 * has changed since the plan was written, and a plan that cannot find its own
 * anchor cannot be trusted to place its replacement correctly.
 */

/**
 * Every JSON encoding of `value` that could plausibly appear in a stored template.
 * `JSON.stringify` does not escape `/`; Shopify does. Both decode identically, so
 * the one that actually occurs is the one to operate on.
 */
export function encodedForms(value) {
  const plain = JSON.stringify(String(value)).slice(1, -1);
  const slashEscaped = plain.replace(/\//g, '\\/');
  return slashEscaped === plain ? [plain] : [slashEscaped, plain];
}

export function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const at = haystack.indexOf(needle, i);
    if (at === -1) return n;
    n += 1;
    i = at + needle.length;
  }
}

/** The encoding of `value` that occurs exactly once in `text`, else null. */
export function resolveEncoding(text, value) {
  for (const form of encodedForms(value)) {
    if (countOccurrences(text, form) === 1) return form;
  }
  return null;
}

/**
 * Apply `edits` ({ id, before, after, … }) to a template's raw text.
 *
 * Returns { text, results }. An edit whose AFTER is already present and whose
 * BEFORE is gone is reported `already-applied` and skipped, which is what makes a
 * plan idempotent. Anything else that cannot be anchored throws.
 */
export function applyTemplateEdits(rawText, edits, { label = 'template' } = {}) {
  let text = rawText;
  const results = [];

  for (const e of edits) {
    const afterPresent = encodedForms(e.after).some((f) => text.includes(f));
    const beforePresent = encodedForms(e.before).some((f) => text.includes(f));

    if (afterPresent && !beforePresent) {
      results.push({ id: e.id, outcome: 'already-applied' });
      continue;
    }

    const encBefore = resolveEncoding(text, e.before);
    if (!encBefore) {
      const counts = encodedForms(e.before).map((f) => countOccurrences(text, f)).join('/');
      throw new Error(
        `${label} :: ${e.id} — expected exactly 1 occurrence of the BEFORE, found ${counts} ` +
          `across the candidate encodings. The template has changed since this plan was ` +
          `written; refusing the whole run.`
      );
    }

    // Replace using the SAME escaping style the file is already written in, so the
    // edit is invisible to a diff apart from the words that changed.
    const plainAfter = JSON.stringify(String(e.after)).slice(1, -1);
    const encAfter = encBefore.includes('\\/') ? plainAfter.replace(/\//g, '\\/') : plainAfter;

    text = text.replace(encBefore, encAfter);
    results.push({ id: e.id, outcome: 'rewritten', compliance: Boolean(e.compliance) });
  }

  return { text, results };
}

/**
 * Parse-only validation of an edited template. The value pushed is always the
 * edited RAW string; this exists solely to refuse a push that would store
 * unparseable JSON.
 */
export function assertParsesAsJson(text, label = 'template') {
  try {
    JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} — edited template is not valid JSON (${err.message}); refusing to push.`);
  }
}
