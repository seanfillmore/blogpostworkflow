// lib/seo-opportunities.js
// Pure "brain" for the weekly SEO opportunity analyzer.
//
// Turns raw GSC query rows (enriched with search volume) into a ranked list of
// ACTIONABLE opportunities — the analysis we want on a regular basis:
//   - cluster queries by the page they land on (one page ranking for 8 SLS
//     variants is ONE opportunity worth ~20k/mo, not 8 scattered rows);
//   - classify the right action (fix CTR vs push ranking vs deeper refresh);
//   - score by realistic monthly-click upside, boosted for pages tied to a
//     product we actually sell (commercial intent).
//
// Deliberately excludes terms we don't really rank for — winnability comes from
// the rows we feed in (GSC only returns queries we got impressions on).

// Approximate organic CTR by position. Conservative, and flattened past page 1
// because modern SERPs (AI overviews, shopping) suppress clicks.
const CTR_CURVE = [
  [1, 0.28], [2, 0.15], [3, 0.10], [4, 0.07], [5, 0.055],
  [6, 0.045], [7, 0.035], [8, 0.030], [9, 0.027], [10, 0.025],
  [15, 0.015], [20, 0.010], [50, 0.006],
];

/** Expected organic CTR for a given average position (interpolated, clamped). */
export function expectedCtr(position) {
  const p = Math.max(1, Number(position) || 50);
  if (p <= 1) return CTR_CURVE[0][1];
  for (let i = 1; i < CTR_CURVE.length; i++) {
    const [pos, ctr] = CTR_CURVE[i];
    const [prevPos, prevCtr] = CTR_CURVE[i - 1];
    if (p <= pos) {
      const t = (p - prevPos) / (pos - prevPos);
      return prevCtr + t * (ctr - prevCtr);
    }
  }
  return CTR_CURVE[CTR_CURVE.length - 1][1];
}

/**
 * Recommended action for a clustered opportunity.
 *   meta_rewrite — ranks on page 1 but CTR is well below what the position
 *                  should earn → fix the title/meta (safe, auto).
 *   rank_push    — sits on page 2 (11-20) → push onto page 1 (refresh + links).
 *   refresh      — deeper (21-50) → needs a real content rebuild.
 *   monitor      — already performing in line with position.
 */
export function classifyAction({ position, ctr }) {
  const pos = Number(position) || 99;
  const c = Number(ctr) || 0;
  if (pos <= 10) {
    // CTR materially below expected for this position → worth a rewrite.
    return c < expectedCtr(pos) * 0.6 ? 'meta_rewrite' : 'monitor';
  }
  if (pos <= 20) return 'rank_push';
  if (pos <= 50) return 'refresh';
  return 'monitor';
}

/**
 * Page type by URL shape. Collections and products are the commercial assets;
 * everything else (blog posts, homepage, info pages) is content.
 */
export function classifyPageType(page) {
  const p = String(page || '');
  if (/\/collections\//.test(p)) return 'collection';
  if (/\/products\//.test(p)) return 'product';
  return 'content';
}

/**
 * The executor agent best suited to act on an opportunity, given its page type
 * and recommended action. Shared by the analyzer (when staging) and the
 * dashboard (when a human approves a staged item) so routing stays consistent.
 *   collection refresh  → collection-content-optimizer (rewrite on-page content)
 *   collection push     → collection-linker (internal links from blog content)
 *   product             → collection-linker (link blog content into the product)
 *   content (blog/info) → refresh-runner (collection-linker can't push a blog post)
 */
export function recommendedAgentFor({ pageType, action }) {
  if (pageType === 'collection') return action === 'refresh' ? 'collection-content-optimizer' : 'collection-linker';
  if (pageType === 'product') return 'collection-linker';
  return 'refresh-runner';
}

/** Group query rows by destination page into one opportunity each. */
export function clusterByPage(rows) {
  const byPage = new Map();
  for (const r of (rows || [])) {
    if (!r || !r.page) continue;
    let c = byPage.get(r.page);
    if (!c) {
      c = { page: r.page, keywords: [], clusterVolume: 0, impressions: 0, clicks: 0, position: Infinity, _top: null };
      byPage.set(r.page, c);
    }
    c.keywords.push(r.keyword);
    c.clusterVolume += r.volume || 0;
    c.impressions += r.impressions || 0;
    c.clicks += r.clicks || 0;
    c.position = Math.min(c.position, Number(r.position) || Infinity); // best position in the cluster
    if (!c._top || (r.volume || 0) > (c._top.volume || 0)) c._top = r;
  }
  return [...byPage.values()].map((c) => ({
    page: c.page,
    keywords: c.keywords,
    keywordCount: c.keywords.length,
    clusterVolume: c.clusterVolume,
    impressions: c.impressions,
    clicks: c.clicks,
    ctr: c.impressions ? c.clicks / c.impressions : 0,
    position: c.position === Infinity ? null : Math.round(c.position * 10) / 10,
    topKeyword: c._top?.keyword || c.keywords[0],
  }));
}

// Collections drive ~80% of ecommerce SEO revenue (products + blog the rest), so
// a collection opportunity of equal click-upside is worth more revenue than a
// product one, and far more than non-commercial content.
const COLLECTION_BOOST = 1.6;
const PRODUCT_BOOST = 1.5;

/**
 * Revenue-weighting multiplier for an opportunity by page type. Collection and
 * product URLs are inherently commercial regardless of handle list; a blog/info
 * page only counts as commercial if it explicitly maps to a product handle.
 */
function commercialBoost(page, pageType, productHandles) {
  if (pageType === 'collection') return COLLECTION_BOOST;
  if (pageType === 'product') return PRODUCT_BOOST;
  const set = productHandles instanceof Set ? productHandles : new Set(productHandles || []);
  for (const h of set) if (h && page.includes(h)) return PRODUCT_BOOST;
  return 1;
}

/**
 * Estimated extra MONTHLY clicks an action could unlock — the comparable
 * currency for ranking opportunities of different kinds.
 */
function monthlyClickUpside(opp, action) {
  const monthlyImpr = opp.impressions / 3; // GSC rows here are 90-day
  if (action === 'meta_rewrite') {
    const gap = Math.max(0, expectedCtr(opp.position) - opp.ctr);
    return monthlyImpr * gap;
  }
  if (action === 'rank_push' || action === 'refresh') {
    // moving onto page 1 (~pos 8) captures click-share against the cluster's demand
    const gain = Math.max(0, expectedCtr(8) - expectedCtr(opp.position));
    return (opp.clusterVolume || 0) * gain;
  }
  return 0;
}

/**
 * @param {Array} rows  GSC rows: {keyword, page, impressions, clicks, ctr, position, volume}
 * @param {{productHandles?: string[]|Set<string>}} opts
 * @returns ranked opportunities, highest score first
 */
export function analyzeOpportunities(rows, { productHandles = [] } = {}) {
  const clusters = clusterByPage(rows);
  const opps = clusters.map((c) => {
    const action = classifyAction(c);
    const page_type = classifyPageType(c.page);
    const boost = commercialBoost(c.page, page_type, productHandles);
    const upside = monthlyClickUpside(c, action);
    const score = Math.round(upside * boost);
    return {
      ...c,
      action,
      page_type,
      commercial: boost > 1,
      est_monthly_clicks: Math.round(upside),
      score,
    };
  });
  return opps.sort((a, b) => b.score - a.score);
}

/**
 * Partition opportunities by target-URL liveness. GSC data lags weeks behind
 * Shopify redirects/removals, so opportunities routinely target consolidated or
 * deleted posts — approving those dead-ends with "No local post found … cannot
 * refresh". Drop them at the source instead.
 *
 * @param {Array<{page:string}>} opps
 * @param {Record<string, number>} statusByUrl  url → HTTP status (0 = unreachable)
 * @returns {{live:Array, dead:Array}}
 *   dead  = status is a redirect (3xx), client/server error (4xx/5xx), or 0.
 *   live  = 2xx OR unknown status (conservative: never drop on a failed/missing check).
 */
export function partitionLiveOpportunities(opps, statusByUrl = {}) {
  const live = [];
  const dead = [];
  for (const o of opps || []) {
    const s = statusByUrl[o.page];
    if (s != null && (s >= 300 || s === 0)) dead.push(o);
    else live.push(o);
  }
  return { live, dead };
}
