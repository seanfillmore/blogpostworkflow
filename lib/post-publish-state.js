// lib/post-publish-state.js
//
// ONE answer to "is this post live?" — because the fleet had three.
//
// 52 of 93 posts in data/posts/ carry a `shopify_article_id` and no
// `shopify_status` key at all: the legacy corpus, synced in by
// scripts/sync-legacy-posts.js without ever passing through agents/publisher.
// Every consumer that required a strict `shopify_status === 'published'` treated
// those live, indexed, traffic-earning pages as "not published":
//
//   agents/daily-summary          → reported them hard-blocked, every morning,
//                                   forever (they curl 200; the report is stale)
//   agents/dashboard/lib/data-loader
//   agents/post-performance:75    → invisible
//   agents/refresh-runner:62      → invisible
//   agents/publish-drift:132      → invisible
//   agents/draft-refresher:38     → invisible
//
// Two other agents had already worked around it, inconsistently:
//
//   agents/indexing-checker:84-85 — status published OR (article id + publish
//                                   date + no explicit status)
//   agents/legacy-triage:194      — status published OR a PAST publish date
//
// This module is that same inference, written once. It deliberately does NOT
// invent a third rule: an explicit status always wins, and inference requires a
// Shopify article id plus a parseable publish date, exactly as those two agents
// already did. `scripts/backfill-shopify-status.mjs` is the real fix — it asks
// live Shopify and writes the true status down. This is the safety net for
// anything the backfill cannot resolve, and for posts synced in later.

/** Status values that mean the article is not, and is not about to be, live. */
const NOT_LIVE = new Set(['draft', 'unpublished', 'archived', 'hidden']);

/** Was the status written down, rather than inferred from dates? */
export function hasExplicitStatus(meta) {
  return Boolean(meta && typeof meta.shopify_status === 'string' && meta.shopify_status.trim());
}

function publishTimestamp(meta) {
  for (const field of ['shopify_publish_at', 'published_at']) {
    const raw = meta?.[field];
    if (!raw) continue;
    const ts = Date.parse(raw);
    if (!Number.isNaN(ts)) return ts;
  }
  return NaN;
}

/**
 * Resolve a post's publish state.
 *
 * @param {object|null} meta   parsed data/posts/<slug>/meta.json
 * @param {{now?: number}} opts
 * @returns {'published'|'scheduled'|'draft'|'unpublished'|'archived'|'hidden'|'unknown'}
 *
 * `'unknown'` is returned rather than a guess whenever there is nothing to go
 * on — no article id, or no parseable date. Callers must treat unknown as NOT
 * live: a post we cannot prove is live is a post nothing may skip work on.
 */
export function resolvePublishStatus(meta, { now = Date.now() } = {}) {
  if (!meta || typeof meta !== 'object') return 'unknown';

  if (hasExplicitStatus(meta)) {
    const explicit = meta.shopify_status.trim().toLowerCase();
    if (explicit === 'published' || explicit === 'scheduled') return explicit;
    if (NOT_LIVE.has(explicit)) return explicit;
    return 'unknown'; // an unrecognised value is not something to reason from
  }

  // Inference — the indexing-checker / legacy-triage rule.
  if (!meta.shopify_article_id) return 'unknown';
  const ts = publishTimestamp(meta);
  if (Number.isNaN(ts)) return 'unknown';
  return ts <= now ? 'published' : 'scheduled';
}

/** Is this post live on the storefront right now? */
export function isLivePost(meta, opts = {}) {
  return resolvePublishStatus(meta, opts) === 'published';
}

/** Live now, or dated to go live on its own without any intervention. */
export function isLiveOrScheduled(meta, opts = {}) {
  const s = resolvePublishStatus(meta, opts);
  return s === 'published' || s === 'scheduled';
}

/**
 * The status implied by a LIVE Shopify article object (REST shape).
 *
 * Shopify has no `status` field on an article — `published_at` is the whole
 * story: null means draft, a date in the future means scheduled, a date in the
 * past means live. Returns null for a missing/deleted article so a 404 is never
 * silently written down as "draft"; a post whose article is gone is a different
 * problem and needs a human.
 *
 * @param {object|null} article
 * @returns {'published'|'scheduled'|'draft'|null}
 */
export function statusFromShopifyArticle(article, { now = Date.now() } = {}) {
  if (!article || typeof article !== 'object') return null;
  const raw = article.published_at;
  if (!raw) return 'draft';
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return 'draft';
  return ts <= now ? 'published' : 'scheduled';
}
