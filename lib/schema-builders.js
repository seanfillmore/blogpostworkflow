// lib/schema-builders.js
// Pure JSON-LD builders shared by schema-injector (articles) and the collection
// agents (Project C). No I/O.
//
// `buildArticleSchema` USED TO LIVE HERE AND IS DELIBERATELY GONE (2026-08-24).
// Its only caller was `agents/schema-injector`, and the node it produced was a
// DUPLICATE: the live theme already publishes Article + BreadcrumbList +
// Organization + WebPage + Person on 182 of 182 blog article pages, measured off
// the rendered pages. Leaving an unused builder in this file is how somebody
// re-adds the second copy. See `buildPostSchemas` below for what a post gets now
// and why.

export function buildBreadcrumb(items) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: (items || []).map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      item: it.url,
    })),
  };
}

export function buildCollectionPageSchema({ name, description, url, image } = {}) {
  const s = {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    name: name || '',
    description: (description || '').slice(0, 300),
    url,
  };
  if (image) s.image = image;
  return s;
}

export function buildItemListSchema(productUrls) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    itemListElement: (productUrls || []).map((u, i) => ({ '@type': 'ListItem', position: i + 1, url: u })),
  };
}

/**
 * Every JSON-LD block a BLOG POST gets, in the order they are written.
 *
 * ONE list, so "what do we still emit on an article" has a single answer that a
 * test can read. It takes no HTML on purpose: the two types whose emission was
 * conditional on the body (FAQPage at 2+ question headings, HowTo at 3+ ordered
 * steps) are retired, and a builder that cannot see the prose cannot grow a
 * body-conditional type back by accident.
 *
 * WHY ONLY A BREADCRUMB (verified 2026-08-24)
 * ──────────────────────────────────────────
 *   FAQPage — Google REMOVED the FAQ rich result from Search. The docs page
 *             301s to /search/updates#removing-faq-rich-result and FAQ is absent
 *             from the rich results gallery.
 *   HowTo   — removed the same way in September 2023; its docs page 404s.
 *   Article — a duplicate. The theme publishes its own Article node (plus
 *             BreadcrumbList, Organization, WebPage and Person) on 182 of 182
 *             live blog article pages.
 *
 * BreadcrumbList stays because it is a live, supported rich result AND because
 * the theme's own breadcrumb is a degenerate ONE-ITEM stub carrying nothing but
 * "Home". This is the real Home › News › Title trail, so it is the one thing on
 * this page the injector still adds that nothing else provides.
 *
 * @param {object} meta    the post's meta.json
 * @param {string} url     the live article URL
 * @param {object} config  config/site.json
 * @returns {object[]}     JSON-LD nodes, ready to serialize
 */
export function buildPostSchemas(meta, url, config) {
  return [
    buildBreadcrumb([
      { name: 'Home', url: config.url },
      { name: 'News', url: `${config.url}/blogs/news` },
      { name: ((meta && meta.title) || '').slice(0, 110), url },
    ]),
  ];
}

// `buildFaqSchema` USED TO LIVE HERE AND IS DELIBERATELY GONE (2026-08-24),
// for the same reason `buildArticleSchema` above it is: an unused builder in
// this file is how somebody re-adds a dead type without ever reading why it
// went. `agents/schema-injector` stopped calling it in the blog change; the
// three COMMERCIAL callers — `agents/collection-creator`,
// `agents/collection-content-optimizer` and `agents/product-optimizer` — were
// the follow-up that note asked for and stopped in the same way.
//
// Google REMOVED the FAQ rich result from Search. Re-verified against the live
// web on 2026-08-24, not recalled:
//
//   .../structured-data/faqpage  → 301 → /search/updates#removing-faq-rich-result
//   .../structured-data/how-to   → 301 → /search/updates#how-to-deprecation
//   .../structured-data/article  → 200   (the control — the 301s are the
//                                         features being retired, not a docs
//                                         reshuffle)
//
// The FAQ PROSE on those pages is untouched and must stay: retiring a rich
// result is a statement about markup, never about content.
