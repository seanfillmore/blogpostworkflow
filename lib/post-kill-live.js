/**
 * The one decision in lib/post-kill.js that must be testable without Shopify
 * credentials (lib/shopify.js throws at import without them).
 *
 * On 2026-09-21 a live article published 2024-04-22 carried no `published_at`
 * in local meta, read as unpublished, got no redirect, and was deleted into a
 * hard 404. Unknown is therefore LIVE: a redirect on a draft's path is harmless,
 * a missing one on a live page breaks every inbound link.
 */
/**
 * Should a kill treat this article as live (and so redirect before deleting)?
 * Pure. `known` says whether `publishedAt` came from Shopify; an unknown
 * publish state is treated as live.
 */
export function isArticleLive(publishedAt, known, now = new Date()) {
  if (!known) return true;
  if (!publishedAt) return false;
  const t = new Date(publishedAt);
  return Number.isNaN(t.getTime()) ? true : t <= now;
}

