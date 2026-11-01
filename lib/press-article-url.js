/**
 * What kind of page a press URL is. Pure, no imports.
 *
 * Two questions, deliberately answered by two rules:
 *
 *   pitchPageReason(url)  Can a cold pitch be built on this page? A pitch must
 *                         open by quoting the writer's own article, so the page
 *                         has to BE an article: not a homepage, a listing, a
 *                         product or pricing page, or a signup page. Null when
 *                         it can, else the reason it cannot.
 *
 *   isArticleUrl(url)     (lib/press-followup.js) Is this link on an author page
 *                         the writer's newest piece? Stricter on purpose: it is
 *                         picking one link out of a page of navigation.
 *
 * Why the pitch rule exists (2026-10-05): the link-gap source names a DOMAIN,
 * never the page that links to a competitor, so its prospects were pitched from
 * the homepage. Three drafts went out that way in one run: an ad-library SaaS
 * (opener: its tagline "Save. Tag. Reuse. Build your swipe file."), a coupon
 * site and an SEO agency, two of them approved before anyone noticed. The
 * opener-quote check passed every time, because the tagline really is on the
 * page. Using isArticleUrl here instead was measured and rejected: it drops 17
 * of the 71 eligible editorial targets (fortune.com/article/best-deodorants,
 * thedaleydose.com/non-toxic-body-lotion), which are real articles.
 */

// Path segments that mark a listing, landing, account or commerce page.
export const NON_ARTICLE_SEGMENT = /\/(category|categories|tag|tags|topic|topics|author|authors|page|search|about|subscribe|membership|premium|newsletter)(\/|$)/i;
// A slug word that marks a paywall or signup landing page ("what-is-prevention-premium").
export const LANDING_WORDS = new Set(['premium', 'membership', 'subscribe', 'subscription', 'newsletter']);
// Segments that never hold editorial copy: a store, a SaaS marketing site or an
// account flow. NOT `shop`, `store` or `features`: publishers file editorial
// under them (today.com/shop/best-coconut-oil-for-skin-…, thegoodtrade.com/
// features/all-natural-body-lotion), and both were measured eligible targets.
const COMMERCE_SEGMENT = /\/(products?|collections?|cart|checkout|pricing|plans|login|log-in|signin|sign-in|signup|sign-up|register|account|contact|contact-us)(\/|$)/i;

/** Null when `url` is a specific page a pitch can quote from, else why not. */
export function pitchPageReason(url) {
  let path;
  try { path = new URL(url).pathname; } catch { return 'no usable URL'; }
  const segs = path.split('/').filter(Boolean);
  if (segs.length === 0) return 'a homepage, not an article';
  if (NON_ARTICLE_SEGMENT.test(path)) return 'a listing or landing page, not an article';
  if (COMMERCE_SEGMENT.test(path)) return 'a product, pricing or account page, not an article';
  if (segs.some((seg) => seg.toLowerCase().split('-').some((w) => LANDING_WORDS.has(w)))) return 'a signup or membership page, not an article';
  return null;
}
