/**
 * Is a post underperforming? Judged against what THIS SITE'S OWN PAGES earn from
 * the same search demand at the same rank — never against a brief's forecast.
 *
 * The old target was `brief.traffic_potential × months`, a keyword's whole
 * addressable volume, and it was not a target anyone could hit: 144,000 clicks
 * for a men's-deodorant post, 12,600 for a lip-balm recipe. Every post "failed"
 * it, so the verdict carried no information and healthy pages were labelled
 * merge-or-remove.
 *
 * Here the target is the page's OWN demand, measured: its impressions in the
 * window, times the click-through rate the site's blog pages actually achieve at
 * that position band. A page is flagged only when it earns well below its peers
 * on the searches it already gets.
 *
 * WHY A WITHIN-SITE CURVE IS RIGHT HERE when lib/ctr-opportunity.js rejects one.
 * That module RANKS pages by headroom; a self-fitted curve would put the average
 * page at zero gap and leave nothing to rank. This module asks the opposite
 * question — which pages are OUTLIERS below their peers — and "par with the site"
 * is exactly the bar that question needs. The external benchmark sits above every
 * page on this site, so as a pass/fail line it would fail all of them, which is
 * the defect being fixed.
 *
 * Three guards, all measured on production 2026-09-21 (300 blog pages, 90d):
 *
 *   MIN_EXPECTED_CLICKS = 5. Below it a shortfall is noise: a page expected to
 *   earn 1.4 clicks records zero about a quarter of the time by chance alone
 *   (Poisson). At 5 expected, "0 or 1 click" happens 4% of the time.
 *
 *   UNDER_YIELD_RATIO = 0.4. Flag when clicks < 40% of the peer expectation. At
 *   the 5-click floor that is "0 or 1 click" — the same 4% false-positive point.
 *
 *   LOW DEMAND = under 200 impressions per 90 days (pro-rated for other windows)
 *   AND at most one click. That is the operator's rule from 2026-09-21: "if these
 *   posts aren't getting any views then remove them". Few impressions alone is
 *   not enough — a small page that converts its few searches is doing its job.
 *
 * Pure: no I/O, so every threshold is a case a test constructs.
 */

export const MIN_EXPECTED_CLICKS = 5;
export const UNDER_YIELD_RATIO = 0.4;
export const LOW_DEMAND_IMPRESSIONS_PER_90D = 200;
export const LOW_DEMAND_MAX_CLICKS = 1;

const BANDS = [[3, '1-3'], [6, '4-6'], [10, '7-10'], [20, '11-20'], [40, '21-40'], [Infinity, '41+']];

export function positionBand(position) {
  if (typeof position !== 'number' || !Number.isFinite(position) || position <= 0) return null;
  return BANDS.find(([max]) => position <= max)[1];
}

/**
 * The site's CTR per position band, from GSC page rows
 * ({ clicks, impressions, position }). A band with no impressions is absent,
 * never zero — zero would make every page in it "on track" by construction.
 */
export function peerCtrByBand(rows) {
  const agg = {};
  for (const r of rows || []) {
    const band = positionBand(r?.position);
    if (!band || !(r.impressions > 0)) continue;
    agg[band] ??= { clicks: 0, impressions: 0 };
    agg[band].clicks += r.clicks || 0;
    agg[band].impressions += r.impressions;
  }
  return Object.fromEntries(Object.entries(agg).map(([b, a]) => [b, a.clicks / a.impressions]));
}

/**
 * @param {{clicks:number, impressions:number, position:number|null}} metrics
 * @param {Record<string, number>} bandCtr   from peerCtrByBand
 * @param {{days:number, judgeLowDemand?:boolean}} opts
 * @returns {{verdict:'ON_TRACK'|'REFRESH'|'LOW_DEMAND'|'UNJUDGED', expected:number|null, ratio:number|null, why:string}}
 */
export function judgeYield(metrics, bandCtr, { days, judgeLowDemand = false } = {}) {
  const clicks = metrics?.clicks ?? 0;
  const impressions = metrics?.impressions ?? 0;
  const lowDemandFloor = Math.round(LOW_DEMAND_IMPRESSIONS_PER_90D * (days / 90));

  if (judgeLowDemand && impressions < lowDemandFloor && clicks <= LOW_DEMAND_MAX_CLICKS) {
    return { verdict: 'LOW_DEMAND', expected: null, ratio: null, why: `${impressions} impressions and ${clicks} click(s) in ${days} days — under ${lowDemandFloor} impressions, so almost nobody searches for or reaches this page.` };
  }

  const band = positionBand(metrics?.position);
  const peer = band ? bandCtr?.[band] : undefined;
  if (!band || typeof peer !== 'number') {
    return { verdict: 'UNJUDGED', expected: null, ratio: null, why: 'no position band with peer data — not judged.' };
  }
  const expected = impressions * peer;
  if (expected < MIN_EXPECTED_CLICKS) {
    return { verdict: 'UNJUDGED', expected, ratio: null, why: `expected ${expected.toFixed(1)} clicks from ${impressions} impressions at position ${metrics.position.toFixed(1)} — too few to judge (need ${MIN_EXPECTED_CLICKS}).` };
  }
  const ratio = clicks / expected;
  const pct = Math.round(ratio * 100);
  const basis = `${clicks} clicks vs ${expected.toFixed(1)} expected from ${impressions} impressions at position ${metrics.position.toFixed(1)} (site blog CTR in the ${band} band: ${(peer * 100).toFixed(2)}%)`;
  if (ratio < UNDER_YIELD_RATIO) {
    return { verdict: 'REFRESH', expected, ratio, why: `${basis} — ${pct}% of what peers earn from the same searches.` };
  }
  return { verdict: 'ON_TRACK', expected, ratio, why: `${basis} — ${pct}% of peers.` };
}
