// agents/pdp-builder/lib/util.js
import { execSync } from 'node:child_process';

// PDP builder uses opus deliberately for premium copy quality. Every other agent
// in the repo uses claude-sonnet-4-6; do not "harmonize" this without checking
// pilot output quality (see docs/superpowers/specs/2026-05-02-pdp-builder-design.md).
export const CLAUDE_MODEL = 'claude-opus-4-7';

export function gitSha() {
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}

/**
 * Extracts JSON from a Claude messages.create response.
 *
 * Throws with a descriptive message if:
 * - The response was truncated (`stop_reason === 'max_tokens'`) — the JSON is
 *   inevitably malformed and the fix is to raise max_tokens, not to retry parsing.
 * - The response contains no text block.
 * - The text isn't valid JSON.
 *
 * Strips ```json``` code fences if Claude wrapped the JSON.
 */
export function parseClaudeJson(response) {
  if (response?.stop_reason === 'max_tokens') {
    throw new Error('Claude response truncated at max_tokens — output is incomplete; raise max_tokens for this call');
  }
  const text = response?.content?.find((b) => b.type === 'text')?.text || '';
  if (!text) throw new Error('Claude response contained no text block');
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  return JSON.parse(cleaned);
}
