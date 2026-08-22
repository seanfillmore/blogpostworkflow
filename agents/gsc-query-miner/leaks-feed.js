// agents/gsc-query-miner/leaks-feed.js
//
// Pure shaping for the impression-leaks feed. Separate from index.js because that
// file runs the agent on import — a test importing it would execute a real run.

/**
 * Shape the already-computed leak set into a durable feed.
 *
 * Mirrors untapped-candidates.json deliberately: same { generated_at, source, ... }
 * envelope, and written even when empty so `generated_at` remains a reliable liveness
 * signal rather than silently going stale on a cycle that found nothing.
 *
 * Input rows originate from lib/gsc.js's `getTopKeywords`, whose field is
 * `keyword`, not `query` (see that file's own field-naming split — some of its
 * functions return `keyword`, others `query`; check the specific function rather
 * than assuming). They reach here via `findImpressionLeaks`, a LOCAL function in
 * this agent's own index.js (not a lib/gsc.js export) that filters/sorts
 * `getTopKeywords`' rows without renaming any field, so the shape at this
 * function's input boundary is still `keyword`, unchanged from lib/gsc.js. Mapped
 * to `query` here on the way out because that's the field name
 * `lib/demand-questions.js`'s `deriveSeeds` and `filterLeaksToSkinCluster` already
 * read (`l.query`). Destructuring `query` off the input row (the original bug)
 * silently produces `undefined`, which JSON.stringify drops from the object
 * entirely — so a shape mismatch here does not throw, it just writes a leak with
 * no query text and no key to notice.
 */
export function buildImpressionLeaksFeed(leaks = [], { minImpr, now = new Date().toISOString() } = {}) {
  return {
    generated_at: now,
    source: 'gsc-query-miner',
    min_impressions: minImpr,
    leaks: [...leaks]
      .sort((a, b) => b.impressions - a.impressions)
      .map(({ keyword, impressions, clicks, position }) => ({ query: keyword, impressions, clicks, position })),
  };
}
