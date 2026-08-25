// lib/faq-blocks.js
//
// Where a post's FAQ Q&As come from — THE PROSE, not the JSON-LD.
//
// Extracted from `agents/faq-rewriter` on 2026-08-24 when `agents/editor`
// became the second reader. The editor's rule 8 (COMPETITOR NAMES IN FAQ, a
// BLOCKER) used to parse the `FAQPage` JSON-LD block `agents/schema-injector`
// prepended to the body. That block is gone — Google removed the FAQ rich
// result from Search, so the injector stopped emitting it — and a schema-fed
// rule would have rendered "Pass · rule does not apply" on every post the
// pipeline writes from that day on. A compliance check that switches itself off
// silently is worse than one that never existed.
//
// SHARING THIS IS A CORRECTNESS FIX, NOT DE-DUPLICATION
// ────────────────────────────────────────────────────
// The editor AUTO-FIXES competitor names before its own review (step 1c) by
// delegating to `agents/faq-rewriter`, which rewrites the PROSE and never
// touches the JSON-LD. So the fixer and the checker were reading two different
// copies of the same FAQ, and the schema copy was the stale one: a post whose
// prose had just been cleaned could still be BLOCKED for a brand name that no
// longer appeared anywhere on the rendered page. One extractor, one answer.
//
// Pure — no I/O, no model call.

/**
 * Extract FAQ Q&A blocks from post HTML.
 *
 * Returns `{ raw, q, a, start, end }`, where `start`/`end` are absolute offsets
 * into the source string so a caller can do targeted replacements without
 * re-rendering the whole document (`agents/faq-rewriter` depends on that).
 *
 * Handles the two shapes our posts actually use:
 *   1. `<p><strong>Question?</strong><br>Answer</p>`  — inline FAQ style
 *   2. `<h2|h3>Question?</h2|h3><p>Answer</p>`        — the section style the
 *      writer emits, and the same shape the injector's own heading heuristic
 *      used to key its (now retired) FAQPage schema on
 *
 * @param {string|null|undefined} html
 * @returns {Array<{raw: string, q: string, a: string, start: number, end: number}>}
 */
export function extractFaqBlocks(html) {
  const source = String(html ?? '');
  if (!source) return [];

  const blocks = [];
  const patterns = [
    /<p[^>]*>\s*<strong[^>]*>\s*([^<]*\?[^<]*?)\s*<\/strong>\s*(?:<br\s*\/?>\s*)?([\s\S]*?)<\/p>/gi,
    /<(h[23])[^>]*>\s*([^<]*\?[^<]*?)\s*<\/\1>\s*<p[^>]*>([\s\S]*?)<\/p>/gi,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(source)) !== null) {
      // Two capture groups (Q, A) for the strong pattern, three (heading-tag,
      // Q, A) for the heading pattern. Take Q/A from the end either way.
      const a = m[m.length - 1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const q = m[m.length - 2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      blocks.push({ raw: m[0], q, a, start: m.index, end: m.index + m[0].length });
    }
  }
  // Sort by start offset to make diff reasoning easier.
  return blocks.sort((x, y) => x.start - y.start);
}

/**
 * The same Q&As in the shape `agents/editor`'s rule 8 scans.
 *
 * @param {string|null|undefined} html
 * @returns {Array<{q: string, a: string}>}
 */
export function extractFaqQAs(html) {
  return extractFaqBlocks(html).map(({ q, a }) => ({ q, a }));
}
