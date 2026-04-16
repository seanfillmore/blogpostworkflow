/**
 * Keyword data helpers for content-researcher.
 *
 * Pure transformations from DataForSEO response shapes into the shapes the
 * brief generator already consumes (originally designed around Ahrefs CSV data).
 * Network calls live in lib/dataforseo.js; this module stays sync + testable.
 */

import {
  getSerpResults,
  getKeywordIdeas,
  getSearchVolume,
} from '../../lib/dataforseo.js';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function computeVolumeHistory(monthlySearches) {
  if (!Array.isArray(monthlySearches) || monthlySearches.length === 0) return null;

  const byMonth = new Map();
  for (const row of monthlySearches) {
    const monthIdx = (row.month ?? 0) - 1;
    if (monthIdx < 0 || monthIdx > 11) continue;
    const name = MONTH_NAMES[monthIdx];
    const existing = byMonth.get(name);
    if (!existing || row.search_volume > existing.avg) {
      byMonth.set(name, { month: name, avg: row.search_volume ?? 0 });
    }
  }

  const seasonality = [...byMonth.values()].sort((a, b) => b.avg - a.avg);
  if (seasonality.length === 0) return null;

  return {
    peak_month: seasonality[0].month,
    low_month: seasonality[seasonality.length - 1].month,
    seasonality,
  };
}

export function mapSerpResults(dfsResponse, limit = 10) {
  const organic = dfsResponse?.organic;
  if (!Array.isArray(organic)) return [];
  return organic
    .filter((r) => r.url)
    .slice(0, limit)
    .map((r) => ({
      position: r.position,
      url: r.url,
      title: r.title,
      domain: r.domain,
      description: r.description,
    }));
}

export function mapKeywordIdeas(dfsItems, { minVolume = 0, maxDifficulty = Infinity } = {}) {
  if (!Array.isArray(dfsItems)) return [];
  return dfsItems
    .filter((k) => k.keyword)
    .filter((k) => (k.volume ?? 0) >= minVolume)
    .filter((k) => (k.kd ?? 0) <= maxDifficulty)
    .map((k) => ({
      keyword: k.keyword,
      volume: k.volume ?? 0,
      difficulty: k.kd ?? null,
      traffic_potential: k.trafficPotential ?? null,
    }));
}

// ── network wrappers ──────────────────────────────────────────────────────────
// Thin wrappers that call DataForSEO and shape the response. Kept here so
// content-researcher stays focused on orchestration + brief generation.

export async function fetchSerpData(keyword, { limit = 10 } = {}) {
  try {
    const dfs = await getSerpResults(keyword, limit);
    return mapSerpResults(dfs, limit);
  } catch (err) {
    console.error(`  ⚠️  DataForSEO SERP fetch failed for "${keyword}": ${err.message}`);
    return [];
  }
}

export async function fetchRelatedKeywords(keyword, { limit = 30, minVolume = 100, maxDifficulty = 40 } = {}) {
  try {
    const ideas = await getKeywordIdeas([keyword], { limit });
    return mapKeywordIdeas(ideas, { minVolume, maxDifficulty });
  } catch (err) {
    console.error(`  ⚠️  DataForSEO keyword-ideas fetch failed for "${keyword}": ${err.message}`);
    return [];
  }
}

export async function fetchKeywordOverview(keyword) {
  try {
    const [volumeRow] = await getSearchVolume([keyword]);
    if (!volumeRow) return { volume: null, monthlySearches: null };
    return {
      volume: volumeRow.volume ?? null,
      cpc: volumeRow.cpc ?? null,
      competition: volumeRow.competition ?? null,
      monthlySearches: volumeRow.monthlySearches ?? null,
    };
  } catch (err) {
    console.error(`  ⚠️  DataForSEO search-volume fetch failed for "${keyword}": ${err.message}`);
    return { volume: null, monthlySearches: null };
  }
}
