// lib/pr-targets.js
//
// Pure logic for the pr-target-finder agent. Mines the weekly ai-citation
// snapshots for the third-party sources LLMs actually cite, classifies them
// (pitch / engage / exclude), and scores them by leverage. No I/O — every
// function is deterministic and unit-tested.

// Search engines, social platforms, and big retailers are cited constantly but
// are not PR targets we can pitch our way onto.
const PLATFORMS = new Set([
  'google.com', 'youtube.com', 'm.youtube.com', 'facebook.com', 'instagram.com',
  'tiktok.com', 'pinterest.com', 'twitter.com', 'x.com', 'linkedin.com',
  'medium.com', 'wikipedia.org',
]);
const RETAILERS = new Set([
  'amazon.com', 'target.com', 'walmart.com', 'ulta.com', 'sephora.com', 'ebay.com',
  'iherb.com', 'thrivemarket.com', 'well.ca', 'chewy.com', 'costco.com', 'cvs.com',
  'walgreens.com',
]);
// Community sources — high LLM value, but you engage, you don't pitch a byline.
const COMMUNITY = new Set(['reddit.com', 'old.reddit.com', 'quora.com']);
// Link shorteners, coupon/reward/loyalty, and generic directory/aggregator
// domains pad backlink profiles but are never editorial PR targets.
const NON_EDITORIAL = new Set([
  'bit.ly', 't.co', 'goo.gl', 'tinyurl.com', 'ow.ly', 'buff.ly', 'lnk.to', 'rebrand.ly',
  'retailmenot.com', 'honey.com', 'swellrewards.com', 'couponwallet.org', 'coupons.com',
  'slickdeals.net', 'dealspotr.com', 'knoji.com', 'clientsbee.com', 'similarweb.com',
  // Gemini's grounding redirector. Every Gemini citation arrives as an opaque
  // `.../grounding-api-redirect/<token>` URL, so without resolution they ALL
  // normalize to this one host — 3,796 of the 12,527 citation URLs in the
  // 2026-09-20 four-week window (30.3%), which ranked it SECOND by score with a
  // citation_count of 3,796. It is a redirector, never a publication. When
  // resolution works no row reaches here at all; when it fails this is what
  // stops the junk domain occupying a top slot. See lib/citation-redirects.js.
  'vertexaisearch.cloud.google.com',
]);
// Domain-name keyword patterns that signal coupon/deal/directory junk.
const NON_EDITORIAL_PATTERN = /(coupon|promo-?code|discount|rewards?|cashback|directory|listings?)/i;

export function normalizeDomain(d) {
  return String(d || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .trim();
}

// ── Citation URL handling ────────────────────────────────────────────────────

/** Gemini answers cite through an opaque redirector rather than the publisher. */
const GROUNDING_REDIRECT = /^https?:\/\/vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\//i;

export function isGroundingRedirect(url) {
  return GROUNDING_REDIRECT.test(String(url || ''));
}

// Params that identify the REFERRER rather than the page. Engines each stamp
// their own — ChatGPT appends `?utm_source=openai`, Google AI Overview appends
// `?srsltid=…` — so one article arrives under several spellings and its
// citation count is split across them. Measured on the 2026-09-20 four-week
// window: 425 of 12,527 URLs carry one, 62 domains have a single article split
// this way, and for 10 of them it changes which URL is the most-cited.
//
// This is a CLOSED list of things known to be referrer noise, never a guess at
// what looks unimportant: `?variant=`, `?page=` and `?q=` genuinely address
// different pages, and stripping one would merge two real articles into one.
const TRACKING_PARAMS = new Set([
  'srsltid', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'dclid', 'yclid',
  'mc_cid', 'mc_eid', 'igshid', 'ref_src', 'ved', 'sca_esv', 'usg', '_branch_match_id',
]);
const TRACKING_PREFIX = /^utm_/i;

/**
 * One spelling per article: drop referrer params and the fragment, and drop a
 * trailing slash. Anything it cannot parse is returned UNCHANGED — an
 * unparseable URL still counts as itself rather than vanishing.
 */
export function canonicalizeCitationUrl(url) {
  const raw = String(url || '');
  if (!/^https?:\/\//i.test(raw)) return raw;
  let u;
  try { u = new URL(raw); } catch { return raw; }
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase()) || TRACKING_PREFIX.test(key)) u.searchParams.delete(key);
  }
  u.hash = '';
  let out = u.toString();
  // `new URL` normalizes an empty path to '/'; keep the bare origin readable and
  // make `https://x.com/` and `https://x.com` one key rather than two.
  out = out.replace(/\?$/, '').replace(/\/$/, '');
  return out;
}

/** A URL that addresses a page, not just a site root. */
function hasArticlePath(url) {
  try { return new URL(url).pathname.replace(/\/+$/, '') !== ''; } catch { return false; }
}

/**
 * The single URL worth handing a human for this domain.
 *
 * Most-cited wins, but an ARTICLE always beats a homepage however often the
 * homepage was cited: a homepage is exactly what `agents/pr-target-finder`'s
 * freshness check must refuse to read a date from, so picking one is picking
 * the row that cannot be checked. An unresolved grounding redirect is never
 * picked — it names no publication.
 *
 * Ties break on the shortest URL and then lexicographically, so the choice is
 * deterministic rather than whichever snapshot happened to be read first.
 *
 * @param {Map<string, number>|Iterable<[string, number]>} urlCounts
 * @returns {string|null}
 */
export function pickTopUrl(urlCounts) {
  const entries = [...(urlCounts || [])].filter(([u]) => u && !isGroundingRedirect(u));
  if (!entries.length) return null;
  const rank = (e) => (hasArticlePath(e[0]) ? 0 : 1);
  entries.sort((a, b) =>
    rank(a) - rank(b)
    || b[1] - a[1]
    || a[0].length - b[0].length
    || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries[0][0];
}

/**
 * @returns {'pitch'|'engage'|'exclude'}
 */
export function classifySource(domain, { brandDomain, competitorDomains = [] } = {}) {
  const d = normalizeDomain(domain);
  if (!d) return 'exclude';
  if (COMMUNITY.has(d)) return 'engage';
  if (PLATFORMS.has(d) || RETAILERS.has(d)) return 'exclude';
  if (NON_EDITORIAL.has(d) || NON_EDITORIAL_PATTERN.test(d)) return 'exclude';
  if (brandDomain && d === normalizeDomain(brandDomain)) return 'exclude';
  if (competitorDomains.some((cd) => d === normalizeDomain(cd))) return 'exclude';
  return 'pitch';
}

/**
 * Aggregate every cited domain across the given snapshots.
 *
 * `resolvedUrls` maps a grounding-redirect URL to the publisher URL it points
 * at. It is supplied by the agent (resolving one costs an HTTP request, and
 * this module stays pure) and is applied BEFORE the domain is read, because the
 * domain is the thing the redirect hides. Omit it and every Gemini citation
 * still collapses onto the redirector, which `NON_EDITORIAL` then excludes —
 * exactly today's behaviour, minus the junk row at rank 2.
 *
 * @param {Array} snapshots - parsed ai-citations/*.json objects
 * @param {{resolvedUrls?: Map<string,string>|Record<string,string>}} [opts]
 * @returns {Array<{domain, engines:Set, prompts:Set, competitors:Set, brandMentioned:boolean, citationCount:number}>}
 */
export function aggregateCitations(snapshots, { resolvedUrls } = {}) {
  const resolved = resolvedUrls instanceof Map
    ? resolvedUrls
    : new Map(Object.entries(resolvedUrls || {}));
  const map = new Map();
  for (const snap of snapshots) {
    for (const result of (snap.results || [])) {
      const prompt = result.prompt;
      for (const [engine, resp] of Object.entries(result.responses || {})) {
        if (!resp || resp.error) continue;
        const comps = [...(resp.competitor_mentions || []), ...(resp.competitor_citations || [])];
        const brandHere = Boolean(resp.mentioned) || Boolean(resp.cited);
        // Prefer full URLs (citation_urls) when present — newer snapshots keep
        // them so we can fetch the actual article. Fall back to domains.
        const raw = (resp.citation_urls && resp.citation_urls.length) ? resp.citation_urls : (resp.citations || []);
        for (const cited of raw) {
          // Resolve the redirector first, then canonicalize, so one article is
          // one key however many engines cited it under their own params.
          const rawUrl = canonicalizeCitationUrl(resolved.get(cited) || cited);
          const domain = normalizeDomain(rawUrl);
          if (!domain) continue;
          if (!map.has(domain)) {
            map.set(domain, {
              domain, engines: new Set(), prompts: new Set(),
              competitors: new Set(), brandMentioned: false, citationCount: 0,
              urls: new Map(), // full url -> citation frequency
            });
          }
          const a = map.get(domain);
          a.engines.add(engine);
          a.prompts.add(prompt);
          a.citationCount += 1;
          if (/^https?:\/\//.test(rawUrl)) a.urls.set(rawUrl, (a.urls.get(rawUrl) || 0) + 1);
          for (const c of comps) a.competitors.add(c);
          if (brandHere) a.brandMentioned = true;
        }
      }
    }
  }
  return [...map.values()];
}

/**
 * Leverage score: a source many engines cite for many money-prompts is the
 * highest-value place to be. breadth = engines × distinct prompts; commercial
 * is the avg per-prompt weight (default 1.0). competitorGap is surfaced for
 * display + tie-breaks, not multiplied in (it already correlates with prompts).
 */
export function scoreTarget(agg, { commercialValueByPrompt = {} } = {}) {
  const engines = agg.engines.size;
  const prompts = agg.prompts.size;
  const competitorGap = agg.competitors.size;
  const commercial = prompts
    ? [...agg.prompts].reduce((s, p) => s + (commercialValueByPrompt[p] ?? 1), 0) / prompts
    : 1;
  const breadth = engines * prompts;
  const score = Math.round(breadth * commercial * 100) / 100;
  return {
    score,
    components: {
      engines, prompts, competitorGap, breadth,
      commercial: Math.round(commercial * 100) / 100,
      citationCount: agg.citationCount,
    },
  };
}

/**
 * Full ranking pass: classify, drop excludes, keep only sources tied to
 * competitor-winning prompts, score, and split into pitch / engage buckets.
 */
export function rankTargets(snapshots, { brand, competitors = [], commercialValueByPrompt = {}, resolvedUrls } = {}) {
  const brandDomain = brand?.domain;
  const competitorDomains = competitors.map((c) => c.domain).filter(Boolean);
  const aggregated = aggregateCitations(snapshots, { resolvedUrls });

  const pitch = [];
  const engage = [];
  let excluded = 0;
  for (const agg of aggregated) {
    const kind = classifySource(agg.domain, { brandDomain, competitorDomains });
    if (kind === 'exclude') { excluded += 1; continue; }
    // Only addressable opportunities: a source cited for prompts where a
    // competitor (but not necessarily us) shows up.
    if (agg.competitors.size === 0) { excluded += 1; continue; }
    const { score, components } = scoreTarget(agg, { commercialValueByPrompt });
    // Actual cited URLs for this domain, most-cited first — the specific
    // article(s)/thread(s) to fetch for a byline and to hand the user.
    const counts = agg.urls || new Map();
    const urls = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u);
    const row = {
      domain: agg.domain,
      engines: [...agg.engines].sort(),
      prompts: [...agg.prompts].sort(),
      competitors: [...agg.competitors].sort(),
      brand_mentioned: agg.brandMentioned,
      citation_count: agg.citationCount,
      urls,
      top_url: pickTopUrl(counts),
      score, score_components: components,
    };
    (kind === 'engage' ? engage : pitch).push(row);
  }
  pitch.sort((a, b) => b.score - a.score || b.citation_count - a.citation_count);
  engage.sort((a, b) => b.score - a.score || b.citation_count - a.citation_count);
  return { pitch, engage, excluded };
}
