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
 */
export function buildImpressionLeaksFeed(leaks = [], { minImpr, now = new Date().toISOString() } = {}) {
  return {
    generated_at: now,
    source: 'gsc-query-miner',
    min_impressions: minImpr,
    leaks: [...leaks]
      .sort((a, b) => b.impressions - a.impressions)
      .map(({ query, impressions, clicks, position }) => ({ query, impressions, clicks, position })),
  };
}
