// agents/seo-opportunity-analyzer/queue-item.js
//
// Pure shaping for a staged SEO-opportunity performance-queue item. Separate
// from index.js because that file runs the agent on import (live GSC +
// paid DataForSEO calls) — a test importing it to reach this shaping logic
// would trigger a real, billed run. Mirrors agents/gsc-query-miner/leaks-feed.js,
// extracted for the same reason.
//
// This is the PRODUCER side of a handoff the dashboard consumes: a human
// approving a staged item on the performance queue calls
// agents/dashboard/lib/opportunity-trigger.js's buildTriggerCommand(item),
// which reads this object's `signal_source.page`, `recommended_action`,
// `title` / `target_keyword` / `signal_source.keywords` fields to decide which
// executor agent to run and with what arguments. Renaming or dropping a field
// here silently breaks that consumer without either side's own unit tests
// noticing — see tests/agents/seo-opportunity-queue-item-integration.test.js.

import { recommendedAgentFor } from '../../lib/seo-opportunities.js';

/**
 * Slug for a clustered opportunity's destination page — the queue item's
 * filename (`seo-opp-<slug>.json`) and its de-dup/cooldown key against
 * agents/performance-engine/lib/queue.js's activeSlugs().
 */
export function slugFromPage(page) {
  const m = String(page).match(/\/([^/?#]+)\/?$/);
  return m ? m[1] : page.replace(/[^a-z0-9]+/gi, '-');
}

/**
 * Shape one clustered opportunity (as produced by lib/seo-opportunities.js's
 * analyzeOpportunities) into the object agents/performance-engine/lib/queue.js's
 * writeItem(...) persists to data/performance-queue/<slug>.json.
 *
 * Pure: no I/O, no Date.now() unless `now` is omitted (mirrors
 * buildImpressionLeaksFeed's injectable-clock pattern for determinism in tests).
 *
 * @param {object} o  one opportunity: {page, page_type, action, topKeyword,
 *   keywordCount, clusterVolume, impressions, position, keywords,
 *   est_monthly_clicks, commercial}
 * @param {{host: string, now?: string}} opts
 *   host — site origin, stripped from the page URL in the human-readable summary
 *          text (e.g. "https://www.realskincare.com" -> "/collections/...").
 *   now  — ISO timestamp for created_at; defaults to the current time.
 * @returns {object} the item to pass to writeItem(...)
 */
export function buildOpportunityQueueItem(o, { host, now = new Date().toISOString() } = {}) {
  const recommendedAgent = recommendedAgentFor({ pageType: o.page_type, action: o.action });
  return {
    slug: `seo-opp-${slugFromPage(o.page)}`,
    title: `SEO opportunity: ${o.topKeyword}`,
    trigger: 'seo-opportunity',
    signal_source: {
      type: 'gsc-opportunity-analyzer',
      page: o.page,
      page_type: o.page_type,
      cluster_volume: o.clusterVolume,
      impressions: o.impressions,
      position: o.position,
      keywords: o.keywords.slice(0, 10),
    },
    summary: {
      what_changed: `${o.keywordCount} query/queries (~${o.clusterVolume.toLocaleString()}/mo) hit ${o.page.replace(host, '')} at avg position ${o.position}.`,
      why: `Recommended: ${o.action.replace('_', ' ')} — est. +${o.est_monthly_clicks} clicks/mo${o.commercial ? ` (commercial ${o.page_type})` : ''}.`,
      projected_impact: o.action === 'rank_push'
        ? `Run ${recommendedAgent}: internal links + on-page to push from page 2 onto page 1.`
        : `Run ${recommendedAgent}: deeper content rebuild to become competitive.`,
    },
    resource_type: o.page_type === 'collection' ? 'collection' : 'seo-opportunity',
    recommended_action: o.action,
    recommended_agent: recommendedAgent,
    target_keyword: o.topKeyword,
    status: 'pending',
    created_at: now,
  };
}
