/**
 * Internal-link injection — the one place a link is wrapped around existing
 * prose in an article body. Shared by `agents/internal-linker` and
 * `agents/collection-linker`, which carried byte-identical copies of it.
 *
 * Extracted so it can be tested: both agents call loadEnv() and process.exit()
 * at import time, so nothing inside them could ever be unit-tested. Same split
 * as lib/voice-of-customer.js and lib/demand-questions.js.
 *
 * ── THE BUG THIS EXISTS TO CLOSE ────────────────────────────────────────────
 *
 * The previous implementation found its insertion point with
 * `html.search(/(?<!<[^>]*)\b(anchor)\b/i)` over the WHOLE body and guarded it
 * by scanning the preceding 300 characters for an unclosed `<a` or `<h1|2|3`.
 * That is not a parse. It knew nothing about `<script>`, `<style>` or comments,
 * so it rewrote text inside `<script type="application/ld+json">` blocks — and
 * the injected `<a href="…" title="…">` carries unescaped double quotes, which
 * land inside a JSON *string value* and stop the block parsing.
 *
 * This was the DEFAULT path, not an edge case: `agents/schema-injector` returns
 * `blocks + '\n' + cleaned`, prepending the JSON-LD to the front of body_html,
 * so byte 0 of every injected post is a script tag and `html.search()` reached
 * the FAQ questions and the Article description before it ever reached prose.
 *
 * Measured live 2026-08-24 across all 183 URLs in sitemap_blogs_1.xml:
 * 58 pages carried at least one unparseable JSON-LD block (109 blocks in all),
 * and 108 of those 109 contain `<a href=` inside a JSON string.
 *
 * The guard is now positive and structural — see lib/html-prose.js. A
 * replacement may only land in a region the scanner has proved is prose; a
 * region it cannot parse stays protected. Three further defects died with it:
 *
 *   1. An occurrence inside a heading or an existing anchor ABORTED the whole
 *      injection (`return { applied: false }`) instead of trying the next
 *      occurrence, so a phrase that appeared in an H2 could never be linked in
 *      the paragraph below it.
 *   2. The 300-character lookback missed an enclosing `<a>` or heading whose
 *      opening tag sat further back than that, and was defeated outright by an
 *      `</a>` appearing inside an attribute value in the window.
 *   3. `\b(${escaped})\b` never matched an anchor phrase that begins or ends
 *      with a non-word character — `\b` after `)` requires a word character
 *      next. "FAQ (2026)" could be suggested by the model, reported as a
 *      suggestion, and silently never applied.
 */

import { replaceFirstInProse } from './html-prose.js';

/** Escape a string for use inside a double-quoted HTML attribute. */
function attr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build the match regex for an anchor phrase.
 *
 * Word boundaries are applied only at an end that actually IS a word
 * character. `\b` is a boundary between a word and a non-word character, so
 * appending it after a phrase ending in `)` demands a word character
 * immediately after the `)` — which is exactly the input a reader expects to
 * match nothing at all.
 */
function anchorPattern(anchorText) {
  const escaped = anchorText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const lead = /^\w/.test(anchorText) ? '\\b' : '';
  const tail = /\w$/.test(anchorText) ? '\\b' : '';
  return new RegExp(`${lead}(${escaped})${tail}`, 'i');
}

/**
 * Insert a link around the first PROSE occurrence of `anchorText` in `html`.
 *
 * Occurrences inside a `<script>` (JSON-LD included), a `<style>`, an HTML
 * comment, tag markup, an existing `<a>` or a heading are skipped — the next
 * occurrence is tried rather than the whole injection being abandoned.
 *
 * Returns `{ html, applied }`; `applied` is false when no prose occurrence
 * exists, in which case `html` is returned unchanged.
 */
export function injectLink(html, anchorText, url, title) {
  if (typeof html !== 'string' || !html) return { html, applied: false };
  if (typeof anchorText !== 'string' || !anchorText.trim()) return { html, applied: false };

  const href = attr(url);
  const safeTitle = attr(title);

  // The matched text is spliced in VERBATIM rather than through a `$1`
  // replacement pattern, so a `$&` in a URL, a title or the matched prose can
  // never be re-interpreted as a substitution.
  const result = replaceFirstInProse(
    html,
    anchorPattern(anchorText),
    (m) => `<a href="${href}" title="${safeTitle}">${m[1]}</a>`
  );

  return { html: result.html, applied: result.applied };
}
