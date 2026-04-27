/**
 * DataForSEO market-data enrichment.
 *
 * Only entries that pass `passesEnrichThreshold` get a DataForSEO call
 * to bound API spend. On error, we silently skip — entries keep
 * `market: null` and the build proceeds.
 *
 * Default `getSearchVolume` is the project's existing
 * lib/dataforseo.js helper. Tests inject a stub.
 */

let defaultGetSearchVolume;

async function getDefaultSearchVolume() {
  if (!defaultGetSearchVolume) {
    const { getSearchVolume } = await import('../dataforseo.js');
    defaultGetSearchVolume = getSearchVolume;
  }
  return defaultGetSearchVolume;
}

const AMAZON_PURCHASES_THRESHOLD = 0;     // > this counts (i.e., ≥1)
const GSC_IMPRESSIONS_THRESHOLD = 100;    // > this counts

export function passesEnrichThreshold(entry) {
  const amzPurchases = entry?.amazon?.purchases ?? 0;
  const gscImpressions = entry?.gsc?.impressions ?? 0;
  return amzPurchases > AMAZON_PURCHASES_THRESHOLD || gscImpressions > GSC_IMPRESSIONS_THRESHOLD;
}

export async function enrichWithMarketData({ entries, getSearchVolume = null, batchSize = 50 }) {
  // Use provided getSearchVolume or lazy-load the real one
  const searchVolumeFn = getSearchVolume || await getDefaultSearchVolume();

  // Collect keywords that need enrichment
  const keysToEnrich = Object.keys(entries).filter((k) => passesEnrichThreshold(entries[k]));
  if (keysToEnrich.length === 0) return;

  const nowIso = new Date().toISOString();

  // Batch the calls
  for (let i = 0; i < keysToEnrich.length; i += batchSize) {
    const batch = keysToEnrich.slice(i, i + batchSize);
    const keywords = batch.map((k) => entries[k].keyword);
    let results;
    try {
      results = await searchVolumeFn(keywords);
    } catch {
      // Silent skip on enricher failure — don't fail the build.
      continue;
    }
    for (const r of results || []) {
      // Match by normalized keyword text
      const slug = batch.find((k) => entries[k].keyword === r.keyword);
      if (!slug) continue;
      // getSearchVolume returns volume + cpc + competition (per lib/dataforseo.js).
      // keyword_difficulty + traffic_potential aren't in this response — leaving
      // them null in v1. A future task may add a getKeywordIdeas-based call to
      // fill them in for the high-priority subset.
      entries[slug].market = {
        volume: r.volume ?? null,
        keyword_difficulty: null,
        cpc: r.cpc ?? null,
        traffic_potential: null,
        enriched_at: nowIso,
      };
    }
  }
}
