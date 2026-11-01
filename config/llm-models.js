// config/llm-models.js
//
// The ONE place the fleet's Claude text-model IDs live. Every agent, library and
// script imports a TIER from here; no file spells a model ID of its own (a source
// scan in tests/config/llm-models.test.js fails on one). Same reasoning as
// lib/shopify-api-version.js: a model pinned in fifty places is upgraded in
// forty-seven of them, and the three that were missed keep running silently.
//
// The tiers are about the JOB, not the price. Every call bills the Claude
// subscription through lib/claude-subscription.js, so cost is not the argument;
// speed is (one CLI process at a time on a 961 MB box).
//
//   flagship  analysis, strategy, ad and CRO judgement, long extraction, vision
//             review: work where the reasoning is the product.
//   standard  everything that WRITES copy a shopper or Google will read (posts,
//             refreshes, product and collection bodies, titles and metas, FAQ
//             answers) and every guard that judges that copy (the editor's
//             review, source-supports-claim, claim verification).
//   fast      mechanical work whose output no reader sees: extraction from a
//             document we wrote, keyword fallbacks, change summaries, link-anchor
//             suggestions, funnel-stage classification, alt text.
//
// ── 2026-10-03 upgrade ────────────────────────────────────────────────────────
// opus-4-6 / 4-7 / 4-8 / opus-5 -> claude-opus-5-5; sonnet-4-6 / sonnet-5 ->
// claude-sonnet-5-5. Haiku 4.5 is still the current Haiku. Nine calls that were
// on Haiku while writing live copy or guarding it moved to `standard` (see the PR).
// Measured through the real transport on the production box: the 5.5 models
// answered 30-40% faster than the 4.6 ones. Their thinking CANNOT be turned off
// and DOES count against the output cap; a first reading ("538 tokens on a
// 300-token cap, end_turn") was the CLI silently continuing and stitching the
// reply, which corrupted every short JSON answer in the first live smoke test.
// lib/claude-subscription.js now adds THINKING_HEADROOM for these models (§1b).
//
// ── Before changing a value ───────────────────────────────────────────────────
// The server's Claude Code CLI never self-updates (DISABLE_AUTOUPDATER=1) and
// refuses a model newer than its catalog with an HTTP 400. Check
// `~/.local/bin/claude --version` on the server and probe the new ID there first;
// the CLI-update procedure is in CLAUDE.md under Server Deployment.
//
// NOT governed here, deliberately: lib/llm-clients.js names the model the
// AI-citation tracker asks through DataForSEO. That is a MEASUREMENT setting; a
// change there breaks the citation baseline rather than improving an agent.

export const LLM_MODELS = Object.freeze({
  flagship: 'claude-opus-5-5',
  standard: 'claude-sonnet-5-5',
  fast: 'claude-haiku-4-5',
});
