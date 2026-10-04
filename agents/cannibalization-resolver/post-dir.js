/**
 * Which local post directory does a merge onto `winnerHandle` belong in?
 *
 * Pure, and split out because agents/cannibalization-resolver/index.js runs on
 * import.
 *
 * THE BUG THIS FIXES. The resolver keyed the merged post by the winner's
 * Shopify HANDLE: `ensurePostDir(winnerHandle)` and `data/posts/<handle>/`. But
 * a post's directory is not its handle. The SLS article lives in
 * `data/posts/toothpaste-without-sls/`, which declares the handle
 * `toothpaste-without-sls-what-to-know-best-options`. Keying by handle created
 * a SECOND, shadow directory holding the merge, and that shadow then hid the
 * real one's `legacy_locked` from every lookup that resolved the handle by
 * exact dir name first: the winner lock was invisible while the page was
 * merged into twice.
 *
 * So resolve the existing post with `resolveSlugAmong(..., { declaredWins })`
 * (the pure core of lib/posts.js `resolveArticleHandle`, which is the resolver
 * for an input KNOWN to be an article handle) and fall back to the handle only
 * when no post holds that article yet.
 */
import { resolveSlugAmong, declaresOtherArticle } from '../../lib/posts.js';

/**
 * @param {string} winnerHandle Shopify article handle
 * @param {Array<[string, object]>} metas [slug, merged meta] pairs
 * @returns {string|null} the post slug to read and write, or null when the
 *   only candidate is a dir named for the handle that holds ANOTHER article
 *   (writing there would put this article's merge into that one's mirror).
 */
export function winnerPostSlug(winnerHandle, metas) {
  if (!winnerHandle) return winnerHandle;
  const list = Array.isArray(metas) ? metas : [];
  const hit = resolveSlugAmong(winnerHandle, list, { declaredWins: true });
  if (hit) return hit;
  const sameName = list.find(([s]) => s === winnerHandle);
  if (sameName && declaresOtherArticle(sameName[1], winnerHandle)) return null;
  return winnerHandle;
}
