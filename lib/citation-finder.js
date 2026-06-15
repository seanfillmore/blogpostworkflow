// lib/citation-finder.js
//
// Pure helpers for the citation-finder agent: turn an uncited claim into a search
// query, decide whether a candidate source is authoritative enough to cite, and
// splice a citation link into the exact block that makes the claim.
//
// On YMYL pages a wrong citation is worse than none, so authority filtering here
// is deliberately strict and the agent additionally has Claude verify the source
// actually supports the claim before any link is inserted.

// Concrete domains to target via Tavily include_domains so the search returns
// authoritative sources instead of skincare blogs. Mix of primary literature
// (PubMed/journals), government/health agencies, and gold-standard medical
// institutions — all acceptable YMYL citations; Claude still verifies support.
export const AUTHORITATIVE_DOMAINS = [
  'pubmed.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov', 'nih.gov', 'who.int', 'cdc.gov', 'fda.gov',
  'medlineplus.gov', 'cochranelibrary.com', 'sciencedirect.com', 'nature.com', 'jamanetwork.com',
  'nejm.org', 'thelancet.com', 'bmj.com', 'frontiersin.org', 'mdpi.com',
  'mayoclinic.org', 'my.clevelandclinic.org', 'clevelandclinic.org', 'hopkinsmedicine.org',
  'aad.org', 'ada.org', 'health.harvard.edu', 'healthline.com', 'medicalnewstoday.com',
];

// Host suffixes we trust as authoritative (secondary filter on results).
const AUTHORITATIVE_SUFFIXES = [
  '.gov', '.edu', // government + academic
  'who.int', 'doi.org', 'cochranelibrary.com', 'sciencedirect.com', 'nature.com', 'springer.com',
  'wiley.com', 'onlinelibrary.wiley.com', 'jamanetwork.com', 'nejm.org', 'thelancet.com',
  'bmj.com', 'frontiersin.org', 'mdpi.com', 'ada.org', 'aad.org',
  'mayoclinic.org', 'clevelandclinic.org', 'hopkinsmedicine.org', 'healthline.com', 'medicalnewstoday.com',
];

// Never cite ourselves or obvious commercial/retail/blog domains.
const BLOCKED_SUFFIXES = ['realskincare.com', 'amazon.com', 'pinterest.com', 'facebook.com', 'reddit.com'];

function hostname(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

/** Build a focused web-search query from a claim sentence. */
export function claimSearchQuery(claimText) {
  return String(claimText || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/["“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Is this URL a domain we trust to cite for a health/science claim? */
export function isAuthoritativeSource(url) {
  const host = hostname(url);
  if (!host) return false;
  if (BLOCKED_SUFFIXES.some((s) => host === s || host.endsWith('.' + s) || host.endsWith(s))) return false;
  return AUTHORITATIVE_SUFFIXES.some((s) => host === s || host.endsWith(s));
}

// Normalize text for fuzzy matching a (HTML-stripped, truncated) claim against a block.
function norm(s) {
  return String(s || '').replace(/<[^>]+>/g, ' ').replace(/[^a-z0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function blockHasExternalLink(block) {
  return /<a\s[^>]*href="https?:\/\/[^"]+"/i.test(block);
}

/**
 * Insert a citation link into the <p>/<li> block that contains the claim.
 * Matches on a distinctive normalized chunk of the claim, skips blocks that
 * already carry an external link, and appends the link just before the closing
 * tag (so it counts as "cited in the same block").
 * @returns {{html: string, inserted: boolean}}
 */
export function insertCitation(html, claimText, url, { linkText = 'source' } = {}) {
  if (!html || !url) return { html, inserted: false };
  const needle = norm(claimText).split(' ').slice(0, 8).join(' '); // first ~8 words
  if (!needle) return { html, inserted: false };

  const blockRe = /<(p|li)\b[^>]*>[\s\S]*?<\/\1>/gi;
  let match;
  while ((match = blockRe.exec(html)) !== null) {
    const block = match[0];
    if (!norm(block).includes(needle)) continue;
    if (blockHasExternalLink(block)) return { html, inserted: false }; // already cited
    const closeTag = `</${match[1]}>`;
    const link = ` <a href="${url}" target="_blank" rel="noopener nofollow">${linkText}</a>`;
    const newBlock = block.slice(0, block.length - closeTag.length) + link + closeTag;
    return { html: html.slice(0, match.index) + newBlock + html.slice(match.index + block.length), inserted: true };
  }
  return { html, inserted: false };
}
