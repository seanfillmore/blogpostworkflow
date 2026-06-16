// lib/html-output-guards.js
//
// Fatal checks for LLM-generated HTML before it is saved. Truncated AI output on
// Shopify creates broken links that take a manual audit to find (see the
// blog-post-writer code-review checklist in CLAUDE.md). Any agent that writes
// model-generated HTML to a post should run these and let them throw.

/**
 * Throw if the generated HTML is incomplete.
 *   - stopReason === 'max_tokens' → output was cut at the token limit.
 *   - an unclosed href attribute (/href="[^"]*$/) → truncated mid-link; Shopify
 *     auto-closes it into a malformed URL that 404s.
 * @param {{html: string, stopReason?: string}} args
 */
export function assertHtmlComplete({ html, stopReason } = {}) {
  if (stopReason === 'max_tokens') {
    throw new Error('Generated HTML was truncated (stop_reason=max_tokens) — refusing to save incomplete content.');
  }
  if (/href="[^"]*$/.test(html || '')) {
    throw new Error('Generated HTML has an unclosed href attribute (truncated mid-link) — refusing to save.');
  }
}

// ── fabricated-fact guards ────────────────────────────────────────────────────
// A prose reviser (content-remediator) must not invent citations or dates —
// adding sources is citation-finder's job (it verifies them). In production the
// reviser fabricated a 404 FDA URL and a "December 2026" date in a June-2026 post.
// These let the caller throw and leave the post blocked rather than save junk.

function externalUrlSet(html, siteHost) {
  const host = String(siteHost || 'realskincare.com').replace(/^www\./, '');
  const urls = new Set();
  const re = /href="(https?:\/\/[^"]+)"/gi;
  let m;
  while ((m = re.exec(String(html || ''))) !== null) {
    try {
      if (new URL(m[1]).host.replace(/^www\./, '') !== host) urls.add(m[1]);
    } catch { /* ignore malformed */ }
  }
  return urls;
}

/**
 * External (off-site) citation URLs present in `revised` but not in `original`.
 * @returns {string[]}
 */
export function externalLinksAdded(original, revised, siteHost = 'realskincare.com') {
  const before = externalUrlSet(original, siteHost);
  return [...externalUrlSet(revised, siteHost)].filter((u) => !before.has(u));
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/**
 * Dates newly introduced in `revised` (absent from `original`) that fall in the
 * FUTURE relative to `now` — a strong signal of a fabricated citation date.
 * Catches "Month YYYY" (compared at month granularity) and bare years > now.year.
 * @param {{year:number, month:number}} now  month is 1-indexed
 * @returns {string[]}
 */
export function futureDatesAdded(original, revised, now) {
  const monthRe = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(20\d{2})\b/gi;
  const monthsIn = (s) => {
    const set = new Set();
    let m;
    const re = new RegExp(monthRe.source, 'gi');
    while ((m = re.exec(String(s || ''))) !== null) set.add(`${m[1].toLowerCase()} ${m[2]}`);
    return set;
  };
  const yearsIn = (s) => new Set(String(s || '').match(/\b20\d{2}\b/g) || []);

  const beforeMonths = monthsIn(original);
  const beforeYears = yearsIn(original);
  const out = [];

  for (const d of monthsIn(revised)) {
    if (beforeMonths.has(d)) continue;
    const [mon, yr] = d.split(' ');
    const y = Number(yr);
    if (y > now.year || (y === now.year && MONTHS[mon] > now.month)) out.push(d);
  }
  for (const y of yearsIn(revised)) {
    if (beforeYears.has(y)) continue;
    if (Number(y) > now.year && !out.some((d) => d.endsWith(y))) out.push(y);
  }
  return out;
}
