// agents/dashboard/lib/opportunity-trigger.js
//
// Turns a staged `seo-opportunity` queue item into the concrete agent command
// that should run when a human approves it on the dashboard. A seo-opp item is
// a RECOMMENDATION (a page we already rank for + a suggested action), not a
// publishable artifact — so "approving" it means kicking off the executor agent
// that does the work, not pushing pre-made content to Shopify.

import { classifyPageType, recommendedAgentFor } from '../../../lib/seo-opportunities.js';
import { resolvePostSlug } from '../../../lib/posts.js';

// Agent key → runnable script path (this map is also the allowlist of what the
// dashboard is permitted to spawn for an opportunity).
const AGENT_SCRIPTS = {
  'collection-content-optimizer': 'agents/collection-content-optimizer/index.js',
  'collection-linker': 'agents/collection-linker/index.js',
  'refresh-runner': 'agents/refresh-runner/index.js',
};

/** Last path segment of a URL — the Shopify handle / post slug. */
export function handleFromUrl(url) {
  const m = String(url || '').match(/\/([^/?#]+)\/?(?:[?#]|$)/g);
  if (!m || !m.length) return null;
  const last = m[m.length - 1].replace(/^\//, '').replace(/\/$/, '').replace(/[?#].*$/, '');
  return last || null;
}

/** Best target keyword for the item: explicit field, then title, then GSC keywords. */
export function keywordForItem(item) {
  if (item.target_keyword) return item.target_keyword;
  const fromTitle = String(item.title || '').replace(/^SEO opportunity:\s*/i, '').trim();
  if (fromTitle) return fromTitle;
  const kws = item.signal_source?.keywords;
  if (Array.isArray(kws) && kws.length) return kws[0];
  return null;
}

/**
 * Which executor agent should run for this item. Always re-derives from the page
 * URL + action (the single source of truth, shared with the analyzer) rather than
 * trusting a stored `recommended_agent`: legacy items may carry a stale/buggy
 * value, and for current items the re-derived value is identical anyway.
 */
export function agentForOpportunityItem(item) {
  const pageType = classifyPageType(item.signal_source?.page || item.target_url || '');
  return recommendedAgentFor({ pageType, action: item.recommended_action });
}

/**
 * Build the spawn command for an approved opportunity.
 * @returns {{agent: string, script: string, args: string[]}}
 * @throws if the agent is unknown or the target can't be derived.
 */
export function buildTriggerCommand(item) {
  const agent = agentForOpportunityItem(item);
  const script = AGENT_SCRIPTS[agent];
  if (!script) throw new Error(`No runnable script for agent "${agent}"`);

  const url = item.signal_source?.page || item.target_url || '';
  const handle = handleFromUrl(url);
  const keyword = keywordForItem(item);

  if (agent === 'collection-content-optimizer') {
    if (!handle) throw new Error('Cannot derive collection handle from page URL');
    return { agent, script, args: ['--handle', handle, '--queue'] };
  }
  if (agent === 'collection-linker') {
    if (!url) throw new Error('No target URL for collection-linker');
    if (!keyword) throw new Error('No target keyword for collection-linker');
    return { agent, script, args: ['--url', url, '--keyword', keyword, '--apply'] };
  }
  // refresh-runner — resolve the live URL to the post's ACTUAL local slug, which
  // may differ from the URL's last segment (posts can be stored under a
  // shortened slug). Passing the raw handle makes refresh-runner silently no-op.
  const postSlug = resolvePostSlug(url) || resolvePostSlug(handle);
  if (!postSlug) throw new Error(`No local post found for URL "${url}" — cannot refresh`);
  return { agent, script, args: [postSlug] };
}
