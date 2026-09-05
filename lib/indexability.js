/**
 * "Would Google index this URL?" — one pure answer, no I/O.
 *
 * WHY THIS EXISTS
 * ───────────────
 * `agents/theme-seo-auditor` audited whatever URL it picked, without ever
 * asking whether the page was a search surface at all. Measured against live
 * on 2026-09-05, TWO of its five template rows were meaningless:
 *
 *   blog_post  → the article it picked 404s (getArticles returns drafts too),
 *                so it was auditing Shopify's 404 page. That is where its
 *                "canonical: https://www.realskincare.com/404" came from — a
 *                fact about the 404 page, not about any blog post.
 *   page       → /pages/sales-page-v1 is `noindex,nofollow` and absent from the
 *                sitemap. It is a PAID-TRAFFIC landing page, and
 *                `agents/technical-seo --fix-noindex` is what put the noindex
 *                there ON PURPOSE. The auditor then reported its missing <h1>
 *                as a CRITICAL issue — the entire "1 critical" in that run.
 *
 * So the agent's headline issue count was manufactured from a page the fleet
 * had deliberately excluded from search. **Misleading output is worse than no
 * output**: a report that cries critical about a page that cannot rank is how a
 * report stops being trusted, the same mechanism CLAUDE.md documents for the
 * digest's Failures block, where five agents reporting routine findings as
 * failures made roughly half of every day's failure count noise.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ──────────────────────────────────
 * It does not fix URL SELECTION. Picking a representative article ("newest
 * published"? "highest traffic"?) is a different decision with its own blast
 * radius, and it belongs on top of `lib/post-publish-state.js`'s `isLivePost`
 * rather than becoming a fourth publish-state rule. This is the cheaper and
 * strictly safer half: whatever a caller picks, don't AUDIT it as an SEO
 * surface unless search engines can actually index it. That one check happens
 * to neutralise both defects above, where fixing selection would have fixed one.
 *
 * `nofollow` alone is NOT disqualifying — it governs link equity, not indexing.
 * Only `noindex` and `none` (which means noindex,nofollow) are.
 */

/** Directives that remove a page from the index. */
const BLOCKING_DIRECTIVES = ['noindex', 'none'];

/**
 * Robots meta names that bind Google. `robots` is every crawler; `googlebot`
 * is the more specific override and wins where both appear, but for our
 * purpose EITHER carrying noindex means the page is not a search surface.
 */
const ROBOTS_META_NAMES = ['robots', 'googlebot'];

/** Does a directive list (`"noindex, nofollow"`) block indexing? */
function blocks(content) {
  if (!content) return false;
  return content
    .toLowerCase()
    .split(',')
    .map((d) => d.trim())
    // "googlebot: noindex" appears in X-Robots-Tag; take the directive half.
    .map((d) => (d.includes(':') ? d.slice(d.indexOf(':') + 1).trim() : d))
    .some((d) => BLOCKING_DIRECTIVES.includes(d));
}

/**
 * Read robots directives out of rendered HTML.
 *
 * Parsed per-tag rather than with one mega-regex because attribute ORDER is not
 * guaranteed — `<meta content="noindex" name="robots">` is as valid as the
 * usual spelling, and a single ordered pattern silently misses it. A miss here
 * means auditing a noindex page, which is exactly the defect being fixed.
 *
 * @param {string} html
 * @returns {string|null} the blocking content value, or null
 */
export function robotsMetaDirective(html) {
  if (!html) return null;
  for (const [tag] of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const name = /\bname\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1]?.toLowerCase();
    if (!name || !ROBOTS_META_NAMES.includes(name)) continue;
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (blocks(content)) return content;
  }
  return null;
}

/**
 * Is this response something a search engine would index?
 *
 * @param {object} res
 * @param {number|null} res.status HTTP status
 * @param {string} res.html rendered HTML
 * @param {Record<string,string>} [res.headers] response headers (lowercased keys)
 * @returns {{indexable: boolean, reason: string|null}}
 */
export function checkIndexable({ status, html, headers = {} } = {}) {
  // A missing status is treated as indexable rather than guessed at. The caller
  // that cannot read one still has HTML to audit, and refusing everything we
  // cannot measure would make this check silently skip the whole run — the
  // "quiet loss of capability" failure this repo keeps having to relearn.
  if (status != null && (status < 200 || status >= 300)) {
    return { indexable: false, reason: `HTTP ${status} — not a live page` };
  }

  // X-Robots-Tag is header-level noindex and is just as binding as the meta
  // tag. Header names are matched case-insensitively; puppeteer lowercases
  // them, but a caller passing raw headers should not silently miss.
  const headerKey = Object.keys(headers).find((k) => k.toLowerCase() === 'x-robots-tag');
  if (headerKey && blocks(headers[headerKey])) {
    return { indexable: false, reason: `X-Robots-Tag: ${headers[headerKey]}` };
  }

  const meta = robotsMetaDirective(html);
  if (meta) return { indexable: false, reason: `robots meta: ${meta}` };

  return { indexable: true, reason: null };
}
