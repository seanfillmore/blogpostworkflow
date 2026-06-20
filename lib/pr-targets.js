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

export function normalizeDomain(d) {
  return String(d || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .trim();
}

/**
 * @returns {'pitch'|'engage'|'exclude'}
 */
export function classifySource(domain, { brandDomain, competitorDomains = [] } = {}) {
  const d = normalizeDomain(domain);
  if (!d) return 'exclude';
  if (COMMUNITY.has(d)) return 'engage';
  if (PLATFORMS.has(d) || RETAILERS.has(d)) return 'exclude';
  if (brandDomain && d === normalizeDomain(brandDomain)) return 'exclude';
  if (competitorDomains.some((cd) => d === normalizeDomain(cd))) return 'exclude';
  return 'pitch';
}

/**
 * Aggregate every cited domain across the given snapshots.
 * @param {Array} snapshots - parsed ai-citations/*.json objects
 * @returns {Array<{domain, engines:Set, prompts:Set, competitors:Set, brandMentioned:boolean, citationCount:number}>}
 */
export function aggregateCitations(snapshots) {
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
        for (const rawUrl of raw) {
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
export function rankTargets(snapshots, { brand, competitors = [], commercialValueByPrompt = {} } = {}) {
  const brandDomain = brand?.domain;
  const competitorDomains = competitors.map((c) => c.domain).filter(Boolean);
  const aggregated = aggregateCitations(snapshots);

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
    const urls = [...(agg.urls || new Map()).entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u);
    const row = {
      domain: agg.domain,
      engines: [...agg.engines].sort(),
      prompts: [...agg.prompts].sort(),
      competitors: [...agg.competitors].sort(),
      brand_mentioned: agg.brandMentioned,
      citation_count: agg.citationCount,
      urls,
      top_url: urls[0] || null,
      score, score_components: components,
    };
    (kind === 'engage' ? engage : pitch).push(row);
  }
  pitch.sort((a, b) => b.score - a.score || b.citation_count - a.citation_count);
  engage.sort((a, b) => b.score - a.score || b.citation_count - a.citation_count);
  return { pitch, engage, excluded };
}
