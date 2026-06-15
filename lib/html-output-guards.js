// lib/html-output-guards.js
//
// Fatal checks for LLM-generated HTML before it is saved. Truncated AI output on
// Shopify creates broken links that take a manual audit to find (see the
// blog-post-writer code-review checklist in CLAUDE.md). Any agent that writes
// model-generated HTML to a post should run these and let them throw.

/**
 * Throw if the generated HTML is incomplete.
 *   - stopReason === 'max_tokens' → output was cut at the token limit.
 *   - an unclosed href attribute (/href="[^"]*$/) → truncated mid-link; Shopify
 *     auto-closes it into a malformed URL that 404s.
 * @param {{html: string, stopReason?: string}} args
 */
export function assertHtmlComplete({ html, stopReason } = {}) {
  if (stopReason === 'max_tokens') {
    throw new Error('Generated HTML was truncated (stop_reason=max_tokens) — refusing to save incomplete content.');
  }
  if (/href="[^"]*$/.test(html || '')) {
    throw new Error('Generated HTML has an unclosed href attribute (truncated mid-link) — refusing to save.');
  }
}
