/**
 * DataForSEO API client — the canonical keyword/SERP/competitive/backlink data
 * source for all agents.
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
 * Get backlink summary for a domain. Requires the DataForSEO Backlinks API
 * subscription; returns null when that subscription is inactive.
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

/**
 * Get the referring domains pointing at a target (who links to it).
 * Requires the DataForSEO Backlinks API subscription; returns null when that
 * subscription is inactive (so callers can degrade gracefully).
 *
 * DataForSEO `rank` is a 0–1000 domain-authority score (not a 0–100 scale).
 * The endpoint exposes no clean per-domain dofollow boolean, so we approximate:
 * a domain counts as dofollow if it has at least one non-nofollow referring page.
 *
 * @param {string} domain
 * @param {object} opts - { limit (default 1000), minRank (client-side filter) }
 * @returns {Promise<Array<{domain, rank, backlinks, dofollow, firstSeen, lostDate}>|null>}
 */
export async function getReferringDomains(domain, { limit = 1000, minRank = 0 } = {}) {
  try {
    const { result } = await api('/backlinks/referring_domains/live', {
      target: domain,
      limit,
      order_by: ['rank,desc'],
      backlinks_status_type: 'live', // currently-live referring domains only
    });
    const items = result[0]?.items || [];
    return items
      .map((r) => {
        const backlinks = r.backlinks ?? 0;
        const nofollowPages = r.referring_pages_nofollow ?? 0;
        return {
          domain: (r.domain || '').toLowerCase(),
          rank: r.rank ?? 0,
          backlinks,
          dofollow: backlinks > nofollowPages, // approx: has ≥1 non-nofollow link
          firstSeen: r.first_seen ?? '',
          lostDate: r.lost_date ?? null,
        };
      })
      // Drop any domain marked lost, and apply the rank floor client-side.
      .filter((r) => r.domain && !r.lostDate && r.rank >= minRank);
  } catch (err) {
    // Backlinks API requires a separate subscription — signal "unavailable".
    if (/Access denied|subscription/i.test(err.message)) return null;
    throw err;
  }
}

// ── Domain Metrics ────────────────────────────────────────────────────────────

/**
 * Get domain overview metrics (traffic, keyword counts by position bucket).
 * @param {string} domain
 * @returns {{organicTraffic, organicKeywords, organicCost, organicNew, organicLost, page1Keywords}}
 */
export async function getDomainMetrics(domain) {
  const { result } = await api('/dataforseo_labs/google/domain_rank_overview/live', {
    target: domain,
    location_code: 2840,
    language_code: 'en',
  });
  const organic = result[0]?.items?.[0]?.metrics?.organic || {};
  return {
    organicTraffic: Math.round(organic.etv ?? 0),
    organicKeywords: organic.count ?? 0,
    organicCost: Math.round(organic.estimated_paid_traffic_cost ?? 0),
    organicNew: organic.is_new ?? 0,
    organicLost: organic.is_lost ?? 0,
    page1Keywords: (organic.pos_1 ?? 0) + (organic.pos_2_3 ?? 0) + (organic.pos_4_10 ?? 0),
  };
}

// ── Top Pages ─────────────────────────────────────────────────────────────────

/**
 * Get top pages for a domain by traffic.
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

// ── AI Optimization (LLM Mentions) ──────────────────────────────────────────────

/**
 * LLM Mentions search — reverse index over the LLM-answer corpus DataForSEO has
 * already collected. NOT a live prompt-runner: it finds stored answers where a
 * keyword phrase appears, or where a domain is cited. Use it to measure our
 * citation footprint ("which questions cite realskincare.com") cheaply.
 * Pricing: $0.10/request + $0.001/row.
 *
 * @param {Array<{keyword?:string,domain?:string}>} targets - ≤10 target objects
 * @param {object} opts - { platform: 'google'|'chat_gpt', limit }
 * @returns {Promise<{totalCount:number, items:Array<{question,answer,aiSearchVolume,sources,brandEntities,fanOutQueries}>}>}
 */
export async function getLlmMentions(targets, { platform = 'google', limit = 100 } = {}) {
  const t = (Array.isArray(targets) ? targets : [targets]).slice(0, 10);
  const { result } = await api('/ai_optimization/llm_mentions/search/live', {
    target: t, platform, location_code: 2840, language_code: 'en', limit,
  });
  const r = result[0] || {};
  const items = (r.items || []).map((it) => ({
    question: it.question,
    answer: it.answer,
    aiSearchVolume: it.ai_search_volume ?? 0,
    sources: (it.sources || []).map((s) => ({ domain: s.domain, url: s.url, title: s.title })),
    brandEntities: (it.brand_entities || []).map((b) => b.name || b.title || b).filter(Boolean),
    fanOutQueries: it.fan_out_queries || [],
  }));
  return { totalCount: r.total_count ?? items.length, items };
}

/**
 * LLM Mentions top_domains — share of voice. For a set of category keywords,
 * returns the source domains LLM answers cite most, with mention counts and the
 * associated AI search volume. The richest cheap signal for PR targeting: these
 * are the third-party sites LLMs lean on for our category.
 *
 * @param {string[]} keywords - ≤10 category keywords
 * @param {object} opts - { platform: 'google'|'chat_gpt', limit }
 * @returns {Promise<Array<{domain, mentions, aiSearchVolume}>>}
 */
export async function getLlmTopDomains(keywords, { platform = 'google', limit = 50 } = {}) {
  const target = (Array.isArray(keywords) ? keywords : [keywords]).slice(0, 10).map((k) => ({ keyword: k }));
  const { result } = await api('/ai_optimization/llm_mentions/top_domains/live', {
    target, platform, location_code: 2840, language_code: 'en', limit,
  });
  const items = result[0]?.items || [];
  return items
    .map((it) => {
      // Each item is a cited domain (it.key) with mention counts broken out by
      // facet (platform / location / language). Take the strongest facet count.
      const facet = it.platform?.length ? it.platform : (it.location || []);
      const mentions = Math.max(0, ...facet.map((f) => f.mentions || 0));
      const aiSearchVolume = Math.max(0, ...facet.map((f) => f.ai_search_volume || 0));
      return { domain: (it.key || '').replace(/^www\./, ''), mentions, aiSearchVolume };
    })
    .filter((d) => d.domain)
    .sort((a, b) => b.mentions - a.mentions);
}

/**
 * Backlinks domain_intersection in ONE call: referring domains that link to the
 * given competitor targets (and NOT to the exclude domains). Requires the
 * Backlinks subscription; returns null when inactive so callers can degrade.
 *
 * IMPORTANT — this is a strict INTERSECTION, not a union link gap. It returns
 * only domains that link to ALL supplied targets simultaneously. For a diverse
 * competitor set that collapses to a tiny, mostly directory-spam set (pilot: 5
 * personal-care competitors → 48 domains, 45 rank-0). Use it for "who links to
 * my 2–3 CLOSEST competitors but not me" (high-precision overlap), NOT as a
 * replacement for per-competitor union link-gap analysis — for that, call
 * getReferringDomains per competitor and diff.
 *
 * NOTE: the per-target `rank` is DataForSEO's rank for that referring domain's
 * links toward the specific competitor (it varies per target) and runs on a
 * lower scale than referring-domain authority — we surface the strongest (max)
 * as a priority proxy. `dofollow` is approximated (≥1 non-nofollow referring
 * page to a target); filter junk with `maxSpamScore`.
 *
 * @param {string[]} competitors - up to 20 competitor domains
 * @param {object} opts - { exclude=[], limit=1000, minRank=0, maxSpamScore=null }
 * @returns {Promise<Array<{domain, competitors:string[], intersectionsCount, rank, backlinks, dofollow, spamScore, firstSeen, perCompetitor}>|null>}
 */
export async function getDomainIntersection(competitors, { exclude = [], limit = 1000, minRank = 0, maxSpamScore = null } = {}) {
  const clean = (d) => (d || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').toLowerCase();
  const list = (Array.isArray(competitors) ? competitors : [competitors]).map(clean).filter(Boolean).slice(0, 20);
  if (!list.length) return [];
  const targets = {};
  list.forEach((d, i) => { targets[i + 1] = d; });
  const body = { targets, limit, order_by: ['1.rank,desc'] };
  const ex = exclude.map(clean).filter(Boolean);
  if (ex.length) body.exclude_targets = ex;
  try {
    const { result } = await api('/backlinks/domain_intersection/live', body);
    const r = result[0] || {};
    const echoed = r.targets || targets; // { "1": "nativecos.com", ... }
    return (r.items || [])
      .map((it) => {
        const di = it.domain_intersection || {};
        const keys = Object.keys(di);
        if (!keys.length) return null;
        const referring = clean(di[keys[0]].target); // same across keys
        const per = keys.map((k) => {
          const t = di[k];
          return {
            competitor: echoed[k],
            rank: t.rank ?? 0,
            backlinks: t.backlinks ?? 0,
            dofollow: (t.backlinks ?? 0) > (t.referring_pages_nofollow ?? 0),
            spamScore: t.backlinks_spam_score ?? 0,
            firstSeen: t.first_seen ?? '',
            lostDate: t.lost_date ?? null,
          };
        }).filter((t) => !t.lostDate);
        if (!per.length) return null;
        return {
          domain: referring,
          competitors: [...new Set(per.map((p) => p.competitor).filter(Boolean))],
          intersectionsCount: it.summary?.intersections_count ?? per.length,
          rank: Math.max(0, ...per.map((p) => p.rank)),
          backlinks: per.reduce((s, p) => s + p.backlinks, 0),
          dofollow: per.some((p) => p.dofollow),
          spamScore: Math.min(...per.map((p) => p.spamScore)),
          firstSeen: per.map((p) => p.firstSeen).filter(Boolean).sort()[0] || '',
          perCompetitor: per,
        };
      })
      .filter((o) => o && o.domain && o.rank >= minRank && (maxSpamScore == null || o.spamScore <= maxSpamScore));
  } catch (err) {
    if (/Access denied|subscription/i.test(err.message)) return null;
    throw err;
  }
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

// Fetches the full link graph for a crawl. `is_broken` only fires on URLs the
// crawler actually visited, so callers must HEAD-verify unverified targets
// (page_to_status_code: null) themselves to discover 404s.
export async function getCrawlLinks(taskId, { internalOnly = true, pageSize = 1000 } = {}) {
  const all = [];
  let offset = 0;
  while (true) {
    const body = { id: taskId, limit: pageSize, offset };
    if (internalOnly) body.filters = [['direction', '=', 'internal']];
    const { result } = await api('/on_page/links', body);
    const items = result[0]?.items || [];
    if (items.length === 0) break;
    all.push(...items);
    if (items.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}
