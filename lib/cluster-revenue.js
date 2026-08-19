// lib/cluster-revenue.js
// Pure: classify each content cluster by whether it actually earns money.
//
// The fleet used to prioritize clusters by RANKING — calendar-runner accelerated
// any cluster with a page-1 post by two days. That is backwards under the Prime
// Directive: the toothpaste cluster ranks well enough to pull 725 clicks across
// 26 pages and has returned $0, so ranking-keyed priority kept pulling more
// toothpaste posts forward. Priority is keyed on dollars now.
//
// Input is the `clusters` array of data/reports/seo-impact/latest.json:
//   { cluster, revenue, revenuePrev, clicks, pages, revenueDelta }

/** A cluster needs at least this much traffic before $0 counts as evidence. */
const MIN_CLICKS = 100;
/** ...across at least this many pages, so one dead page cannot condemn a category. */
const MIN_PAGES = 5;

const norm = (s) => String(s || '').trim().toLowerCase();

/**
 * Cluster names, in match-priority order. ORDER IS LOAD-BEARING and this list is
 * first-match-wins, not longest-match: 'deodorant' precedes 'coconut oil' so
 * "coconut oil deodorant" is a deodorant post, and 'bar soap' precedes bare
 * 'soap'. Reordering silently re-buckets revenue.
 */
const CLUSTERS = [
  'deodorant', 'toothpaste', 'lip balm', 'lip-balm', 'body lotion', 'body-lotion',
  'lotion', 'moisturizer', 'hand soap', 'hand-soap', 'bar soap', 'bar-soap',
  'foaming', 'soap', 'body cream', 'body-cream', 'cream', 'coconut oil', 'coconut-oil',
];

/**
 * Map a URL path, slug or keyword to a cluster name, or null.
 *
 * This is the mapping `agents/seo-impact` uses to attribute revenue, lifted here
 * so everything that acts on those numbers shares one taxonomy. A second copy
 * that drifted would sort a page into a cluster whose dollar figure was computed
 * from a different set of pages.
 */
export function clusterForText(text) {
  const t = norm(text);
  if (!t) return null;
  for (const c of CLUSTERS) {
    if (t.includes(c) || t.includes(c.replace(/[- ]/g, '-')) || t.includes(c.replace(/[- ]/g, ''))) {
      return c.replace(/-/g, ' ');
    }
  }
  return null;
}

/**
 * @returns {{ [cluster:string]: { revenue:number, clicks:number, pages:number, status:'earning'|'proven_dud'|'unproven' } }}
 *
 * - `earning`    — returned money in the window. Any amount counts; a cluster
 *                  that converts at low volume is exactly what we want more of.
 * - `proven_dud` — had a fair shot (traffic across several pages) and returned
 *                  nothing. Do not add to it.
 * - `unproven`   — too little traffic to judge. Left alone deliberately, or a
 *                  new category could never get tested.
 */
export function classifyClusters(clusters, { minClicks = MIN_CLICKS, minPages = MIN_PAGES } = {}) {
  const out = {};
  for (const c of (clusters || [])) {
    const name = norm(c?.cluster);
    if (!name) continue;
    const revenue = Number(c.revenue) || 0;
    const clicks = Number(c.clicks) || 0;
    const pages = Number(c.pages) || 0;

    let status;
    if (revenue > 0) status = 'earning';
    else if (clicks >= minClicks && pages >= minPages) status = 'proven_dud';
    else status = 'unproven';

    out[name] = { revenue, clicks, pages, status };
  }
  return out;
}

/** Look up a calendar item's `category` against the classification. */
export function clusterStatus(classified, category) {
  return classified?.[norm(category)]?.status || 'unproven';
}

/** Cluster names that should not receive new content, for prompts and reports. */
export function provenDuds(classified) {
  return Object.entries(classified || {})
    .filter(([, v]) => v.status === 'proven_dud')
    .sort((a, b) => b[1].clicks - a[1].clicks)
    .map(([cluster, v]) => ({ cluster, ...v }));
}
