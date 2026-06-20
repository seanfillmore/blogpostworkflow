// lib/html-byline.js
//
// Best-effort author + publication extraction from a fetched article page.
// Pure (takes HTML in). Returns nulls rather than throwing — a missing author
// must never block a PR target (you can still "pitch the editor at <pub>").

function clean(s) {
  if (!s) return null;
  const t = String(s).replace(/\s+/g, ' ').replace(/^by\s+/i, '').trim();
  return t ? t.slice(0, 80) : null;
}

// Reject obvious non-person author strings (orgs, generic team bylines).
function plausibleAuthor(a) {
  if (!a) return null;
  if (/^(the\s+)?(editor|editorial team|staff|team|admin|guest)/i.test(a)) return null;
  if (a.length < 3) return null;
  return a;
}

export function extractByline(html, { domain } = {}) {
  let author = null;
  let publication = null;

  if (html) {
    // 1. <meta name="author"> / article:author
    const meta = html.match(/<meta[^>]+(?:name|property)=["'](?:author|article:author)["'][^>]+content=["']([^"']+)["']/i);
    if (meta) author = clean(meta[1]);

    // 2. JSON-LD author / publisher (most reliable when present)
    for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      let json;
      try { json = JSON.parse(m[1].trim()); } catch { continue; }
      const nodes = Array.isArray(json) ? json : (json['@graph'] || [json]);
      for (const n of nodes) {
        if (!n || typeof n !== 'object') continue;
        if (!author && n.author) {
          const a = typeof n.author === 'string'
            ? n.author
            : (Array.isArray(n.author) ? n.author[0]?.name : n.author.name);
          author = clean(a);
        }
        if (!publication && n.publisher?.name) publication = clean(n.publisher.name);
      }
    }

    // 3. og:site_name as publication fallback
    if (!publication) {
      const og = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
      if (og) publication = clean(og[1]);
    }

    // 4. rel="author" or a byline element as a last resort for author
    if (!author) {
      const rel = html.match(/rel=["']author["'][^>]*>\s*(?:by\s+)?([^<]{3,50})</i)
        || html.match(/class=["'][^"']*byline[^"']*["'][^>]*>\s*(?:by\s+)?([A-Z][^<]{2,40})</i);
      if (rel) author = clean(rel[1]);
    }
  }

  if (!publication && domain) publication = domain;
  return { author: plausibleAuthor(author), publication: publication || null };
}

// Does the fetched page already mention our brand? (If so, we're on it — lower
// priority / different angle.)
export function pageMentionsBrand(html, aliases = []) {
  if (!html || !aliases.length) return false;
  const lower = html.toLowerCase();
  return aliases.some((a) => lower.includes(String(a).toLowerCase()));
}

// Is this an ecommerce STORE (a single brand selling the category) rather than
// an editorial publication? Such sites get cited by LLMs but aren't pitch
// targets — they're competitors we don't track. Detect store platform markers /
// product-page signals without an editorial article signal.
export function looksLikeStore(html) {
  if (!html) return false;
  const lower = html.toLowerCase();
  const storeSignals = [
    'cdn.shopify.com', 'myshopify.com', 'woocommerce', 'bigcommerce',
    'add to cart', 'add-to-cart', '"@type":"product"', '"@type": "product"',
    'og:type" content="product', 'product:price', '/cart"', 'shopify-section',
  ];
  const hits = storeSignals.filter((s) => lower.includes(s)).length;
  // Editorial sites can have a shop link; require a couple of strong signals.
  return hits >= 2;
}
