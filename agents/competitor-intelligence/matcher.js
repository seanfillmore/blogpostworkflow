// agents/competitor-intelligence/matcher.js

/**
 * Match a competitor page URL to a store slug via sitemap index.
 * Returns { slug, type } or null if no match.
 */
export function matchCompetitorUrl(url, sitemapPages) {
  let pathSegment = null;
  let type = null;

  const productMatch = url.match(/\/products\/([^/?#]+)/);
  const collectionMatch = url.match(/\/collections\/([^/?#]+)/);

  if (productMatch) { pathSegment = productMatch[1]; type = 'product'; }
  else if (collectionMatch) { pathSegment = collectionMatch[1]; type = 'collection'; }
  else return null;

  const candidates = sitemapPages.filter(p => p.type === type);

  // (a) Exact slug match
  const exact = candidates.find(p => p.slug === pathSegment);
  if (exact) return { slug: exact.slug, type: exact.type };

  // (b) Token overlap — tokenize on '-', require ≥2 tokens of length >2 to match
  const competitorTokens = new Set(pathSegment.split('-').filter(t => t.length > 2));
  let best = null;
  let bestOverlap = 1; // require strictly more than 1 to match

  for (const page of candidates) {
    const pageTokens = page.slug.split('-').filter(t => t.length > 2);
    const overlap = pageTokens.filter(t => competitorTokens.has(t)).length;
    if (overlap > bestOverlap) { bestOverlap = overlap; best = page; }
  }

  return best ? { slug: best.slug, type: best.type } : null;
}
