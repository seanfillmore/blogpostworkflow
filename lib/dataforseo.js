/**
 * DataForSEO API client
 * Drop-in replacement for Ahrefs API calls used across agents.
 * Auth: Basic auth with base64-encoded login:password.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function loadEnv() {
  try {
    const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
    const env = {};
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i === -1) continue;
      env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return env;
  } catch { return {}; }
}

const env = loadEnv();
const AUTH = env.DATAFORSEO_PASSWORD || process.env.DATAFORSEO_PASSWORD;
if (!AUTH) throw new Error('Missing DATAFORSEO_PASSWORD in .env');

const BASE = 'https://api.dataforseo.com/v3';

async function api(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${AUTH}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(Array.isArray(body) ? body : [body]),
  });
  if (!res.ok) throw new Error(`DataForSEO ${path} → ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.status_code !== 20000) throw new Error(`DataForSEO ${path}: ${data.status_message}`);
  const task = data.tasks?.[0];
  if (!task) throw new Error(`DataForSEO ${path}: no tasks returned`);
  if (task.status_code !== 20000) throw new Error(`DataForSEO ${path}: ${task.status_message}`);
  return { result: task.result || [], cost: data.cost || 0 };
}

async function apiGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Basic ${AUTH}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) throw new Error(`DataForSEO GET ${path} → ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const task = data.tasks?.[0];
  if (!task?.result) return [];
  return task.result;
}

// ── Keyword Data ──────────────────────────────────────────────────────────────

/**
 * Get search volume, competition, CPC for keywords.
 * Replaces: Ahrefs keywords-explorer/overview (volume, kd, cpc, traffic_potential)
 * @param {string[]} keywords - up to 1000 keywords per request
 * @returns {Array<{keyword, volume, competition, cpc}>}
 */
export async function getSearchVolume(keywords) {
  const { result } = await api('/keywords_data/google_ads/search_volume/live', {
    keywords: Array.isArray(keywords) ? keywords : [keywords],
    location_code: 2840, // US
    language_code: 'en',
  });
  return result.map((r) => ({
    keyword: r.keyword,
    volume: r.search_volume ?? 0,
    competition: r.competition ?? 0,
    competitionLevel: r.competition_level ?? '',
    cpc: r.cpc ?? 0,
    lowBid: r.low_top_of_page_bid ?? 0,
    highBid: r.high_top_of_page_bid ?? 0,
    monthlySearches: r.monthly_searches ?? [],
  }));
}

/**
 * Get keyword ideas with difficulty, volume, CPC.
 * Replaces: Ahrefs keywords-explorer/overview + related terms
 * @param {string[]} keywords - seed keywords
 * @param {object} opts
 * @returns {Array<{keyword, volume, kd, cpc, competition, intent}>}
 */
export async function getKeywordIdeas(keywords, { limit = 50, filters = null } = {}) {
  const body = {
    keywords: Array.isArray(keywords) ? keywords : [keywords],
    location_code: 2840,
    language_code: 'en',
    limit,
    include_seed_keyword: true,
    include_serp_info: true,
  };
  if (filters) body.filters = filters;
  const { result } = await api('/dataforseo_labs/google/keyword_ideas/live', body);
  return (result[0]?.items || []).map((item) => ({
    keyword: item.keyword,
    volume: item.keyword_info?.search_volume ?? 0,
    kd: item.keyword_properties?.keyword_difficulty ?? 0,
    cpc: item.keyword_info?.cpc ?? 0,
    competition: item.keyword_info?.competition ?? 0,
    competitionLevel: item.keyword_info?.competition_level ?? '',
    trafficPotential: item.impressions_info?.ad_position_average ?? 0,
    intent: item.search_intent_info?.main_intent ?? '',
    serpFeatures: item.serp_info?.serp_item_types ?? [],
  }));
}

// ── SERP Data ─────────────────────────────────────────────────────────────────

/**
 * Get live SERP results for a keyword.
 * Replaces: Ahrefs serp-overview
 * @param {string} keyword
 * @param {number} depth - number of results (default 10)
 * @returns {Array<{position, url, title, domain}>}
 */
export async function getSerpResults(keyword, depth = 10, { device = 'desktop' } = {}) {
  const { result } = await api('/serp/google/organic/live/advanced', {
    keyword,
    location_code: 2840,
    language_code: 'en',
    depth,
    device,
  });
  const taskResult = result[0] || {};
  const items = taskResult.items || [];

  // Collect all SERP feature types present (featured_snippet, people_also_ask, etc.)
  const serpFeatures = [...new Set(items.map((i) => i.type).filter(Boolean))];

  const organic = items
    .filter((i) => i.type === 'organic')
    .map((i) => ({
      position: i.rank_group,
      url: i.url,
      title: i.title,
      domain: i.domain,
      description: i.description,
    }));

  return { organic, serpFeatures };
}

// ── Competitor Analysis ───────────────────────────────────────────────────────

/**
 * Get organic competitors for a domain.
 * Replaces: Ahrefs management/project/competitors + site-explorer/organic-competitors
 * @param {string} domain
 * @returns {Array<{domain, commonKeywords, organicTraffic, organicKeywords}>}
 */
export async function getCompetitors(domain, { limit = 20 } = {}) {
  const { result } = await api('/dataforseo_labs/google/competitors_domain/live', {
    target: domain,
    location_code: 2840,
    language_code: 'en',
    limit: limit + 20, // fetch extra to account for filtering
    exclude_top_domains: true,
  });
  const GENERIC = new Set(['youtube.com', 'reddit.com', 'facebook.com', 'amazon.com', 'wikipedia.org', 'instagram.com', 'tiktok.com', 'twitter.com', 'pinterest.com', 'etsy.com', 'walmart.com', 'target.com', 'ebay.com']);
  return (result[0]?.items || [])
    .filter((item) => !GENERIC.has(item.domain))
    .slice(0, limit)
    .map((item) => ({
      domain: item.domain,
      commonKeywords: item.intersections ?? 0,
      organicTraffic: item.full_domain_metrics?.organic?.etv ?? 0,
      organicKeywords: item.full_domain_metrics?.organic?.count ?? 0,
      avgPosition: item.avg_position ?? 0,
    }));
}

/**
 * Get top ranked keywords for a domain.
 * Replaces: Ahrefs site-explorer/top-pages + organic-keywords
 * @param {string} domain
 * @returns {Array<{keyword, position, volume, url, traffic}>}
 */
export async function getRankedKeywords(domain, { limit = 100, filters = null, device = 'desktop' } = {}) {
  // DataForSEO caps ranked_keywords at 1000 items per request. When the caller
  // asks for more, we paginate via `offset` and stop early if the domain
  // ranks for fewer keywords than the target limit.
  const PAGE_SIZE = 1000;
  const mapItem = (item) => ({
    keyword: item.keyword_data?.keyword,
    position: item.ranked_serp_element?.serp_item?.rank_group ?? 0,
    volume: item.keyword_data?.keyword_info?.search_volume ?? 0,
    cpc: item.keyword_data?.keyword_info?.cpc ?? 0,
    url: item.ranked_serp_element?.serp_item?.relative_url ?? '',
    traffic: item.ranked_serp_element?.serp_item?.etv ?? 0,
    kd: item.keyword_data?.keyword_properties?.keyword_difficulty ?? null,
    serpFeatures: item.keyword_data?.serp_info?.serp_item_types ?? [],
    intent: item.keyword_data?.search_intent_info?.main_intent ?? '',
  });

  const all = [];
  let offset = 0;
  while (all.length < limit) {
    const pageLimit = Math.min(PAGE_SIZE, limit - all.length);
    const body = {
      target: domain,
      location_code: 2840,
      language_code: 'en',
      limit: pageLimit,
      offset,
      order_by: ['keyword_data.keyword_info.search_volume,desc'],
      item_types: ['organic'],
      device,
    };
    if (filters) body.filters = filters;
    const { result } = await api('/dataforseo_labs/google/ranked_keywords/live', body);
    const items = result[0]?.items || [];
    if (items.length === 0) break;
    for (const item of items) all.push(mapItem(item));
    if (items.length < pageLimit) break; // last page
    offset += items.length;
  }
  return all;
}

// ── Backlinks ─────────────────────────────────────────────────────────────────

/**
 * Get backlink summary for a domain.
 * Replaces: Ahrefs site-explorer/backlinks-stats + domain-rating
 * @param {string} domain
 * @returns {{rank, backlinks, referringDomains, dofollow, nofollow}}
 */
export async function getBacklinksSummary(domain) {
  try {
    const { result } = await api('/backlinks/summary/live', {
      target: domain,
      include_subdomains: true,
    });
    const r = result[0] || {};
    return {
      rank: r.rank ?? 0,
      backlinks: r.backlinks ?? 0,
      referringDomains: r.referring_domains ?? 0,
      referringDomainsNofollow: r.referring_domains_nofollow ?? 0,
      dofollow: r.backlinks - (r.backlinks_nofollow ?? 0),
      nofollow: r.backlinks_nofollow ?? 0,
      brokenBacklinks: r.broken_backlinks ?? 0,
      referringIps: r.referring_ips ?? 0,
    };
  } catch (err) {
    // Backlinks API requires separate subscription — return null if not available
    if (err.message.includes('Access denied')) return null;
    throw err;
  }
}

// ── Domain Metrics ────────────────────────────────────────────────────────────

/**
 * Get domain overview metrics (traffic, keywords, top pages).
 * Replaces: Ahrefs site-explorer/metrics
 * @param {string} domain
 * @returns {{organicTraffic, organicKeywords, paidTraffic, paidKeywords}}
 */
export async function getDomainMetrics(domain) {
  const { result } = await api('/dataforseo_labs/google/domain_metrics_by_categories/live', {
    target: domain,
    location_code: 2840,
    language_code: 'en',
  });
  const metrics = result[0]?.items?.[0]?.metrics?.organic || {};
  return {
    organicTraffic: metrics.etv ?? 0,
    organicKeywords: metrics.count ?? 0,
    organicCost: metrics.estimated_paid_traffic_cost ?? 0,
  };
}

// ── Top Pages ─────────────────────────────────────────────────────────────────

/**
 * Get top pages for a domain by traffic.
 * Replaces: Ahrefs site-explorer/top-pages
 * @param {string} domain
 * @returns {Array<{url, traffic, keywords}>}
 */
export async function getTopPages(domain, { limit = 100 } = {}) {
  // Use ranked_keywords grouped by URL to approximate top pages
  const keywords = await getRankedKeywords(domain, { limit });
  const pageMap = new Map();
  for (const kw of keywords) {
    const url = kw.url;
    if (!pageMap.has(url)) pageMap.set(url, { url, traffic: 0, keywords: 0, topKeyword: kw.keyword });
    const page = pageMap.get(url);
    page.traffic += kw.traffic;
    page.keywords++;
  }
  return Array.from(pageMap.values()).sort((a, b) => b.traffic - a.traffic);
}

// ── Account ───────────────────────────────────────────────────────────────────

export async function getBalance() {
  const result = await apiGet('/appendix/user_data');
  const money = result[0]?.money || {};
  return {
    balance: money.balance ?? 0,
    totalSpent: money.total ?? 0,
  };
}

/**
 * Get completed crawl tasks that haven't been collected yet.
 * @returns {Array<{id, target}>}
 */
export async function getCrawlTasksReady() {
  const result = await apiGet('/on_page/tasks_ready');
  return result || [];
}

// ── On-Page Crawl ─────────────────────────────────────────────────────────────

export async function startCrawl(domain, { maxPages = 500, loadResources = true } = {}) {
  const res = await fetch(`${BASE}/on_page/task_post`, {
    method: 'POST',
    headers: { Authorization: `Basic ${AUTH}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([{
      target: domain,
      max_crawl_pages: maxPages,
      load_resources: loadResources,
      enable_javascript: false,
      respect_sitemap: true,
      store_raw_html: false,
    }]),
  });
  if (!res.ok) throw new Error(`DataForSEO task_post → ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const task = data.tasks?.[0];
  if (!task || task.status_code !== 20100) {
    throw new Error(`DataForSEO task_post: ${task?.status_message || 'no task returned'}`);
  }
  return { taskId: task.id, cost: data.cost || 0 };
}

export async function getCrawlSummary(taskId) {
  const res = await fetch(`${BASE}/on_page/summary/${taskId}`, {
    method: 'GET',
    headers: { Authorization: `Basic ${AUTH}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`DataForSEO summary → ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const task = data.tasks?.[0];
  // 40602 = Task In Queue — crawl submitted but not started yet
  if (!task || task.status_code === 40602 || !task.result) {
    return { progress: 'in_progress', pagesCrawled: 0, pagesInQueue: 0, maxPages: 0 };
  }
  const r = task.result[0] || {};
  return {
    progress: r.crawl_progress || 'in_progress',
    pagesCrawled: r.crawl_status?.pages_crawled ?? 0,
    pagesInQueue: r.crawl_status?.pages_in_queue ?? 0,
    maxPages: r.crawl_status?.max_crawl_pages ?? 0,
  };
}

export async function getCrawlPages(taskId, { offset = 0, limit = 1000 } = {}) {
  const { result } = await api('/on_page/pages', {
    id: taskId,
    limit,
    offset,
  });
  return result[0]?.items || [];
}
