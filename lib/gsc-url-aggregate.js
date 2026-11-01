// lib/gsc-url-aggregate.js
//
// "How many impressions does this PAGE have?" — a question GSC answers per URL,
// and a Shopify product has many URLs.
//
// WHY THIS EXISTS
// ───────────────
// `agents/product-optimizer` built its URL → metrics map first-wins on the exact
// URL string. Measured on production 2026-09-09, that made the store's HERO
// PRODUCT invisible to it:
//
//   201 impr  pos 1   /products/coconut-lotion?variant=45828179165354&…sag_organic
//    84 impr  pos 1   /products/coconut-lotion?variant=45828179198122&…
//    82 impr  pos 1   /products/coconut-lotion?variant=45828179198122&…&com_cvv=…
//    40 impr  pos 1   /products/coconut-lotion?variant=44414530781354&…
//     1 impr  pos 26  /products/coconut-lotion          ← the only row it kept
//
// `coconut-lotion` sold $1,592.53 of the store's $2,453.38 over 90 days — 65% of
// all revenue — and scored as a ONE-IMPRESSION page, ranking below six products
// from the two least efficient clusters. The optimizer had never selected it.
//
// The parameterised rows are Shopify's product_sync URLs (Google's free product
// listings and Shopping surfaces; `utm_content=sag_organic` is the marker). They
// are real impressions on the same page and belong in its total.
//
// SAME DEFECT CLASS AS THE CTR PROGRAM'S URL MATCHING, which CLAUDE.md already
// records: "comparing whole URLs matches nothing, and matching nothing looks
// exactly like a clean run." Here it does not match NOTHING — it matches the
// wrong row, which is worse, because the agent reports a confident "1 impr".
//
// WHAT IS AND IS NOT COMBINED
// ───────────────────────────
// Rows are keyed on ORIGIN + PATH. The query string goes, because `?variant=`
// and the utm/com_cvv parameters address the same page. The path does NOT get
// normalised beyond a trailing slash: `/collections/x/products/y` is a genuinely
// different URL from `/products/y` — Shopify serves both, they can rank
// separately, and collapsing them would overstate a product by folding in every
// collection path it hangs from.
//
// POSITION IS IMPRESSION-WEIGHTED, never averaged flat. A page at position 1 on
// 201 impressions and 26 on 1 impression is at ~1.1, not 13.5. Averaging flat is
// how a single stray row drags a healthy page into a "quick win" bucket it does
// not belong in. CTR is recomputed from the summed clicks and impressions rather
// than averaged, for the same reason.

/** Origin + path, trailing slash removed. Query string and hash discarded. */
export function canonicalPageKey(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.origin}${path}`;
  } catch {
    // Not absolute — strip query/hash and trailing slash by hand rather than
    // dropping the row, because a relative path is still a usable key.
    return raw.split('#')[0].split('?')[0].replace(/\/+$/, '') || '/';
  }
}

/**
 * Collapse GSC rows onto one entry per page.
 *
 * @param {Array<object>} rows   GSC rows; the URL is read from `url` or `page`
 * @param {object} [opts]
 * @param {(row:object)=>string} [opts.urlOf]  override how a row's URL is read
 * @returns {Map<string, {url:string, impressions:number, clicks:number,
 *                        position:number, ctr:number, rows:number, keyword?:string}>}
 */
export function aggregateByPage(rows, { urlOf } = {}) {
  const read = urlOf || ((r) => r?.url || r?.page || '');
  const out = new Map();

  for (const row of rows || []) {
    const key = canonicalPageKey(read(row));
    if (!key) continue;

    const impressions = Number(row?.impressions) || 0;
    const clicks = Number(row?.clicks) || 0;
    const position = Number(row?.position);

    const e = out.get(key) || {
      url: key, impressions: 0, clicks: 0, position: 0, ctr: 0, rows: 0, _posWeight: 0, keyword: undefined,
    };

    e.impressions += impressions;
    e.clicks += clicks;
    e.rows += 1;

    // Impression-weighted position. A row with no impressions still carries a
    // real position, so it is weighted 1 rather than dropped — otherwise a page
    // whose every row is zero-impression would report position 0, which reads
    // as "ranking first" to any consumer that sorts ascending.
    if (Number.isFinite(position) && position > 0) {
      const w = impressions || 1;
      e.position += position * w;
      e._posWeight += w;
    }

    // Keep the keyword from the highest-impression row that carries one — the
    // representative query for the page, not whichever row arrived first.
    if (row?.keyword && (!e.keyword || impressions >= e._bestKwImpr || 0)) {
      e.keyword = row.keyword;
      e._bestKwImpr = impressions;
    }

    out.set(key, e);
  }

  for (const e of out.values()) {
    e.position = e._posWeight ? e.position / e._posWeight : 0;
    e.ctr = e.impressions ? e.clicks / e.impressions : 0;
    delete e._posWeight;
    delete e._bestKwImpr;
  }

  return out;
}

/**
 * The one URL → metrics map this fleet builds from GSC.
 *
 * Four byte-identical copies of a first-wins builder lived in
 * agents/product-optimizer (the default rewrite path, --optimize-titles,
 * --from-gsc and --pages-from-gsc), so the hero-product defect above applied to
 * every one of them. A fifth copy is a bug, not a shortcut — the same rule
 * CLAUDE.md states for AWARENESS_LEVELS and for isRejected.
 *
 * THE TWO SOURCES ARE UNIONED, NOT RANKED, AND GETTING THAT WRONG WAS HALF THE
 * BUG. The first version of this module aggregated each source and then let a
 * quick-win entry win the page outright, "because that is what the original
 * builders did". Measured against production immediately after deploying it:
 *
 *     quick-win aggregate :      1 impr, pos 26.0   (the clean URL, alone)
 *     top-page  aggregate : 10,628 impr, pos 25.8   (8 rows)
 *     what the map served :      1 impr             <- precedence threw away 10,627
 *
 * So the hero product STILL scored 150.1 against toothpaste's 202.1 and was
 * still never selected. Preserving a precedence rule that only ever made sense
 * BEFORE aggregation reproduced the defect one layer up. `getQuickWinPages` and
 * `getTopPages` are two VIEWS of one dataset — positions 5-50, and top pages by
 * impressions — not two competing authorities, so a page's impressions are the
 * union of the rows either view returned for it.
 *
 * Rows are deduped on the EXACT url first, because a URL genuinely present in
 * both views must be counted once; only then are they aggregated by page. The
 * KEYWORD still comes from the quick-win side when it has one, because that is
 * the ranking query that makes a page actionable — that part of the old
 * precedence was about naming, not about counting, and it survives.
 *
 * @param {Array<object>} gscPages  getQuickWinPages() rows (URL in `url`)
 * @param {Array<object>} topPages  getTopPages() rows (URL in `page`)
 * @returns {Map<string, object>} keyed by canonicalPageKey()
 */
export function buildPageMetricsMap(gscPages, topPages) {
  // Dedupe on the exact URL. A quick-win row wins a tie because it carries the
  // keyword; the metrics on both sides describe the same row either way.
  const rows = new Map();
  for (const r of topPages || []) {
    const u = r?.page || r?.url;
    if (u) rows.set(u, { ...r, url: u });
  }
  for (const r of gscPages || []) {
    const u = r?.url || r?.page;
    if (u) rows.set(u, { ...r, url: u });
  }

  const map = aggregateByPage([...rows.values()]);

  // Keyword: prefer the quick-win side's, then whatever aggregation kept, then
  // the slug. A page with no ranking query still needs something to optimise for.
  const quickKeyword = new Map();
  for (const r of gscPages || []) {
    const key = canonicalPageKey(r?.url || r?.page);
    if (!key || !r?.keyword) continue;
    const prev = quickKeyword.get(key);
    if (!prev || (Number(r.impressions) || 0) >= prev.impressions) {
      quickKeyword.set(key, { keyword: r.keyword, impressions: Number(r.impressions) || 0 });
    }
  }
  for (const [key, entry] of map) {
    entry.keyword = quickKeyword.get(key)?.keyword
      || entry.keyword
      || key.split('/').pop().replace(/-/g, ' ');
  }

  return map;
}
