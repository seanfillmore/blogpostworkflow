// lib/anchor-destination.js
// A link's words must match where it sends people (Sean, 2026-10-22: "The
// button should match where people are sent").
//
// Why this exists: the 62 → 5 collection consolidation 301'd single-product
// collections to their product page, and scripts/fix-redirect-links.mjs then
// repointed every link's HREF to that product. It never touched the link TEXT,
// so on 2026-10-22, 157 links on 64 live articles still said "collection"
// ("natural bar soap collection", "Shop the Collection") above a single PDP.
//
// Pure (no I/O). Two rules a reader can check by hand:
//   - text naming the product ("natural bar soap collection") just loses the
//     word "collection" → "natural bar soap";
//   - text naming nothing ("Shop the Collection", "Browse our SLS-free
//     collection") gets the product's noun in its place → "Shop the Toothpaste".
// PRODUCT_NOUNS is a WHITELIST: a product handle it does not know returns null
// (leave the link alone), so an unknown input can only ever produce a miss.

export const PRODUCT_NOUNS = Object.freeze({
  'coconut-oil-toothpaste': 'toothpaste',
  'coconut-oil-lip-balm': 'lip balm',
  'coconut-oil-deodorant': 'deodorant',
  'coconut-soap': 'bar soap',
  'coconut-lotion': 'lotion',
  'coconut-body-cream': 'body cream',
  'organic-foaming-hand-soap': 'hand soap',
});

const NAMES_A_PRODUCT = /\b(soaps?|deodorants?|toothpastes?|lip balms?|balms?|lotions?|creams?)\b/i;
const GENERIC_BUTTON = /^(shop|browse|view|see|explore)(?:\s+(?:the|our))?(?:\s+(?:full|entire|whole))?\s+collection$/i;

const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const matchCase = (word, sample) => (sample[0] === sample[0].toUpperCase() ? titleCase(word) : word);

/** Product handle for an href, or null when it is not a /products/ link. */
export function productHandleOf(href) {
  const m = String(href || '').match(/^(?:https?:\/\/[^/]+)?\/(?:collections\/[^/]+\/)?products\/([^/?#]+)/i);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Rewrite one link's text so it matches a product destination.
 * @returns {string|null} the new text, or null to leave the link unchanged.
 */
export function alignAnchorText(text, handle) {
  const t = String(text || '');
  if (!/\bcollections?\b/i.test(t)) return null;
  const noun = PRODUCT_NOUNS[handle];
  if (!noun) return null;

  const trimmed = t.trim();
  const g = trimmed.match(GENERIC_BUTTON);
  if (g) return t.replace(trimmed, `${titleCase(g[1].toLowerCase())} the ${titleCase(noun)}`);

  let out = t.replace(/\b(?:full |entire |whole )?collections? of\s+/i, '');
  if (NAMES_A_PRODUCT.test(out)) {
    // "full natural deodorant collection" must not leave "full natural deodorant".
    out = out.replace(/\s*\bcollections?\b/i, '').replace(/\b(?:full|entire|whole) (?=(?:[\w'-]+ ){0,3}(?:soaps?|deodorants?|toothpastes?|lip balms?|lotions?|creams?)\b)/i, '');
  }
  else out = out.replace(/\bcollections?\b/i, (m) => matchCase(noun, m));
  out = out.replace(/ {2,}/g, ' ');
  return /\bcollections?\b/i.test(out) || out === t ? null : out;
}

/**
 * Align the text of every <a href="…/products/<known handle>"> whose words say
 * "collection". Anchors inside <script>/<style> (JSON-LD carries anchors as
 * string data) are never touched. `onlyHrefs`, when given, limits the change
 * to anchors whose href is in that set (the redirect rewrite passes the hrefs
 * it just repointed).
 * @returns {{ html: string, changes: Array<{href:string, from:string, to:string}> }}
 */
export function alignProductAnchors(html, { onlyHrefs = null } = {}) {
  const changes = [];
  if (typeof html !== 'string' || !html) return { html: html ?? '', changes };
  const opaque = [];
  for (const m of html.matchAll(/<(script|style)\b[\s\S]*?<\/\1>/gi)) opaque.push([m.index, m.index + m[0].length]);
  const inOpaque = (i) => opaque.some(([a, b]) => i >= a && i < b);

  const out = html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (whole, attrs, inner, offset) => {
    if (inOpaque(offset)) return whole;
    const href = (attrs.match(/\bhref="([^"]*)"/i) || [])[1];
    if (!href || (onlyHrefs && !onlyHrefs.has(href))) return whole;
    const handle = productHandleOf(href);
    if (!handle) return whole;
    // Text segments only; tags inside the anchor (<strong>) pass through untouched.
    let changed = false;
    const next = inner.split(/(<[^>]+>)/).map((seg) => {
      if (seg.startsWith('<')) return seg;
      const aligned = alignAnchorText(seg, handle);
      if (aligned === null) return seg;
      changed = true;
      return aligned;
    }).join('');
    if (!changed) return whole;
    const plain = (s) => s.replace(/<[^>]+>/g, '').trim();
    changes.push({ href, from: plain(inner), to: plain(next) });
    return `<a${attrs}>${next}</a>`;
  });
  return { html: out, changes };
}
