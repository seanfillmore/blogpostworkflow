// lib/content-revision.js
//
// The validate-and-retry loop around a prose revision, extracted from
// agents/content-remediator so it can be tested without a network call (and
// without importing that agent, which runs on import).
//
// WHY THE RETRY EXISTS. On 2026-08-21 the daily digest carried
// "Revision dropped links (16 < 19) — refusing to save" as a failure. The guard
// was right — a revision that silently deletes three internal links is worse
// than no revision — but giving up on the first sample was not: the model was
// never told what it had dropped, and one more attempt with the missing anchors
// named in the prompt is far cheaper than leaving the post blocked for a human.
//
// WHAT DID NOT CHANGE. The guard is still hard. A second sample that still drops
// a link throws exactly as before, and no revision that loses a link is ever
// saved. Only the dropped-link failure is retryable: retrying a truncation
// (stop_reason=max_tokens) against the same ceiling cannot succeed, and retrying
// a fabricated citation or a suspiciously short body just buys another bad
// sample at full price.

import {
  assertHtmlComplete, externalLinksAdded, futureDatesAdded, droppedLinks,
} from './html-output-guards.js';

/** Minimum fraction of the original length a revision may be. */
const MIN_LENGTH_RATIO = 0.6;

export function stripFences(text) {
  return String(text ?? '').replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

/**
 * The instruction appended to the prompt on the one retry. Names every anchor
 * that went missing — a count ("you dropped 3") is not something a model can act
 * on, an anchor list is.
 */
export function linkDropRetryInstruction(dropped) {
  const list = (dropped || [])
    .map((l) => `- <a href="${l.href}">${l.anchor || '(no anchor text)'}</a>`)
    .join('\n');
  return [
    'RETRY — YOUR PREVIOUS ATTEMPT WAS REJECTED.',
    `You dropped ${(dropped || []).length} link(s) that must be preserved:`,
    list,
    '',
    'Produce the revision again. Every one of the links above must appear in your',
    'output with its href and its anchor text reproduced VERBATIM, in the same place',
    'in the post. Reproduce every OTHER <a href="..."> anchor verbatim as well — add',
    'none, remove none, rename none. Fix only the flagged blockers in the prose',
    'around them.',
  ].join('\n');
}

/**
 * Fatal integrity checks on a revision. Throws on any violation. The dropped-link
 * error carries `.droppedLinks` and `.retryable = true` so the caller can give
 * the model one informed second chance; every other failure is terminal.
 */
export function validateRevision({ original, revised, stopReason, now }) {
  assertHtmlComplete({ html: revised, stopReason });

  if (revised.length < original.length * MIN_LENGTH_RATIO) {
    throw new Error(`Revision is suspiciously short (${revised.length} vs ${original.length} chars) — refusing to save.`);
  }

  const dropped = droppedLinks(original, revised);
  if (dropped.length) {
    // Report WHAT was dropped, never a count comparison. This guard is an
    // href-identity diff, so a revision that drops one link and adds another
    // nets to the same `<a` count — and the old message printed that count pair
    // verbatim, reaching the digest as "dropped links (23 < 23)". A gate whose
    // own error message states a falsehood gets triaged as a broken gate.
    const err = new Error(
      `Revision dropped ${dropped.length} link${dropped.length === 1 ? '' : 's'} — refusing to save: `
      + dropped.map((l) => l.anchor || l.href).slice(0, 5).join(', '),
    );
    err.droppedLinks = dropped;
    err.retryable = true;
    throw err;
  }

  // The reviser must not fabricate citations or dates — that is citation-finder's
  // job (it verifies sources). An added external link or a future-dated "fact"
  // means it invented a source; refuse so the post stays blocked for the proper
  // tool instead of going live with a 404 link or a bogus date.
  const addedLinks = externalLinksAdded(original, revised);
  if (addedLinks.length) {
    throw new Error(`Revision added ${addedLinks.length} unverified external link(s) — citations are citation-finder's job. Refusing to save: ${addedLinks.slice(0, 3).join(', ')}`);
  }

  const stamp = now || (() => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() + 1 }; })();
  const futureDates = futureDatesAdded(original, revised, stamp);
  if (futureDates.length) {
    throw new Error(`Revision introduced future-dated "fact(s)" not in the original (${futureDates.slice(0, 3).join(', ')}) — likely a fabricated citation date. Refusing to save.`);
  }
}

/**
 * Run the reviser, validating each sample. Retries EXACTLY once, and only on a
 * dropped link, with the missing anchors named in the prompt.
 *
 * @param {object}   args
 * @param {string}   args.original    the HTML being revised
 * @param {string}   args.basePrompt  the full revision prompt
 * @param {function} args.callModel   async (prompt) => ({ text, stopReason })
 * @param {{year:number,month:number}} [args.now]
 * @returns {Promise<{revised: string, attempts: number}>}
 */
export async function reviseWithLinkGuard({ original, basePrompt, callModel, now }) {
  let prompt = basePrompt;
  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { text, stopReason } = await callModel(prompt);
    const revised = stripFences(text);
    try {
      validateRevision({ original, revised, stopReason, now });
      return { revised, attempts: attempt };
    } catch (err) {
      if (attempt < MAX_ATTEMPTS && err.retryable && err.droppedLinks?.length) {
        prompt = `${basePrompt}\n\n${linkDropRetryInstruction(err.droppedLinks)}`;
        continue;
      }
      throw err;
    }
  }

  // Unreachable: the loop either returns or throws.
  throw new Error('reviseWithLinkGuard exhausted without a verdict');
}
