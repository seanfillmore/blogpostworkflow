/**
 * Rewrite internal `<a href>` links that point at a Shopify REDIRECT SOURCE so
 * they point straight at the final destination.
 *
 * WHY. Measured read-only 2026-08-31 against the live site: 1,222 internal
 * links — 29.5% of every internal link on the blog — across 174 of 188 live
 * pages resolve through a 301. The top targets are the retired collections from
 * the 62 → 5 consolidation, and they sit in the BUY PATH out of blog content.
 *
 * BE HONEST ABOUT THE VALUE: a 301 passes essentially full ranking signal, so
 * this is not a ranking loss and must not be sold as one. It costs a redundant
 * round trip on every click (worst on mobile) and crawl budget. It is worth
 * doing because the mapping is Shopify's own redirect table — deterministic, no
 * model call, no judgement — not because rankings are bleeding.
 *
 * `agents/link-repair` cannot see any of this: it acts only on 404s, and every
 * one of these returns 200 to a reader.
 *
 * WHY NOT lib/html-prose.js. That module answers "where can PROSE be inserted"
 * and marks tag markup — attribute values included — as PROTECTED, which is
 * exactly the region that must change here. The one thing shared is the
 * raw-text rule: an `<a href>` inside a `<script type="application/ld+json">`
 * block is a JSON string, not a link (58 live pages carry anchors trapped in
 * JSON-LD), so script and style CONTENTS are skipped. Same hazard, opposite
 * polarity — hence a scan written for this job rather than that one bent.
 *
 * FAILURE DIRECTION IS ALWAYS "LEAVE IT ALONE": an unparseable region, a query
 * string, a cycle, an over-long chain, a quoting style we do not recognise —
 * every one of them declines the edit and reports it. The worst outcome is a
 * link we did not improve, never a page we corrupted.
 */

/** Elements whose CONTENT is raw text, never markup. */
const RAW_TEXT = new Set(['script', 'style']);

/** Hosts that count as "us". Anything else is external and never touched. */
const INTERNAL_HOSTS = new Set([
  'www.realskincare.com',
  'realskincare.com',
]);

const MAX_HOPS = 6;

/** Normalize a path for redirect-table lookup: no trailing slash, lowercased. */
function normalizePath(path) {
  const p = String(path || '').replace(/\/+$/, '');
  return (p || '/').toLowerCase();
}

/**
 * Follow a redirect chain to its end.
 *
 * Returns `{ target: null }` on a cycle or a chain longer than MAX_HOPS rather
 * than throwing or half-applying — the caller leaves such a link untouched.
 *
 * Resolving the WHOLE chain matters: rewriting to the intermediate would leave
 * a redirect behind, which is the same defect one step along.
 *
 * @param {string} path
 * @param {Map<string,string>} map  normalized source path -> target
 * @returns {{target: string|null, hops: number}}
 */
export function resolveRedirectChain(path, map, maxHops = MAX_HOPS) {
  let current = String(path || '');
  const seen = new Set([normalizePath(current)]);

  for (let hops = 0; hops <= maxHops; hops += 1) {
    const next = map.get(normalizePath(current));
    if (next === undefined) return { target: current, hops };
    if (seen.has(normalizePath(next))) return { target: null, hops };
    seen.add(normalizePath(next));
    current = next;
  }
  return { target: null, hops: maxHops };
}

/**
 * Spans of the document whose contents must not be edited: the CONTENT of every
 * raw-text element. An unclosed one protects everything after it, which is the
 * safe direction — the same call lib/html-prose.js makes.
 */
function rawTextSpans(html) {
  const spans = [];
  const open = /<(script|style)\b[^>]*>/gi;
  let m;
  while ((m = open.exec(html))) {
    const name = m[1].toLowerCase();
    if (!RAW_TEXT.has(name)) continue;
    const contentStart = m.index + m[0].length;
    const close = html.toLowerCase().indexOf(`</${name}`, contentStart);
    const end = close === -1 ? html.length : close;
    spans.push([contentStart, end]);
    open.lastIndex = end;
  }
  return spans;
}

const inSpans = (spans, i) => spans.some(([s, e]) => i >= s && i < e);

/**
 * Split an href into its parts. Returns null for anything we decline to handle.
 *
 * @returns {{prefix: string, path: string, query: string, hash: string}|null}
 *   `prefix` is the scheme+host for an absolute URL, '' for root-relative, so
 *   the rewritten href keeps the form the author used.
 */
function parseInternalHref(href) {
  const raw = String(href || '');
  if (!raw) return null;

  let prefix = '';
  let rest = raw;

  if (/^https?:\/\//i.test(raw)) {
    let u;
    try { u = new URL(raw); } catch { return null; }
    if (!INTERNAL_HOSTS.has(u.hostname.toLowerCase())) return null;
    prefix = `${u.protocol}//${u.host}`;
    rest = `${u.pathname}${u.search}${u.hash}`;
  } else if (!raw.startsWith('/')) {
    // Protocol-relative, mailto:, tel:, #anchor, or a relative path we cannot
    // resolve without knowing the current page. Decline.
    return null;
  }

  const hashAt = rest.indexOf('#');
  const hash = hashAt === -1 ? '' : rest.slice(hashAt);
  if (hashAt !== -1) rest = rest.slice(0, hashAt);

  const qAt = rest.indexOf('?');
  const query = qAt === -1 ? '' : rest.slice(qAt);
  if (qAt !== -1) rest = rest.slice(0, qAt);

  return { prefix, path: rest, query, hash };
}

/**
 * Rewrite every `<a href>` in `html` that points at a redirect source.
 *
 * @param {string} html
 * @param {Map<string,string>} redirects  normalized source path -> target path
 * @returns {{html: string, rewrites: Array<{from:string,to:string,hops:number}>,
 *            skipped: Array<{href:string, reason:string}>}}
 */
export function rewriteRedirectLinks(html, redirects) {
  const rewrites = [];
  const skipped = [];
  if (typeof html !== 'string' || !html) return { html: html ?? '', rewrites, skipped };

  const spans = rawTextSpans(html);

  // Only a double-quoted href inside an <a> tag. Shopify normalizes to double
  // quotes; any other form is unexpected input and declining beats improvising
  // a parse of it.
  const anchorHref = /<a\b[^>]*?\shref="([^"]*)"/gi;

  const out = html.replace(anchorHref, (match, href, offset) => {
    if (inSpans(spans, offset)) return match;

    const parts = parseInternalHref(href);
    if (!parts) return match;

    const { target, hops } = resolveRedirectChain(parts.path, redirects);
    if (target === null) {
      skipped.push({ href, reason: 'unresolvable-chain' });
      return match;
    }
    if (hops === 0) return match; // not a redirect source

    if (parts.query) {
      // A query carries state that is meaningless on a different destination,
      // and Shopify maps PATHS. Report it; never guess.
      skipped.push({ href, reason: 'query-string' });
      return match;
    }

    const next = `${parts.prefix}${target}${parts.hash}`;
    rewrites.push({ from: href, to: next, hops });
    return match.replace(`href="${href}"`, `href="${next}"`);
  });

  return { html: out, rewrites, skipped };
}

/**
 * Build the lookup a rewrite needs from Shopify's `getRedirects()` rows.
 * Targets are stored raw so an absolute or off-site target survives intact.
 */
export function buildRedirectMap(rows) {
  const map = new Map();
  for (const r of rows || []) {
    if (!r || !r.path || !r.target) continue;
    map.set(normalizePath(r.path), r.target);
  }
  return map;
}
