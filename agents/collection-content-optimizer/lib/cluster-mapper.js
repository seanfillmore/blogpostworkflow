/**
 * Map a collection (handle + title) to a keyword-index cluster slug.
 *
 * Heuristic: tokenize the collection's handle + title, then for each
 * non-'unclustered' cluster in the index, count how many distinct
 * cluster-keyword tokens appear in the collection's token set. Pick the
 * cluster with the highest count, requiring ≥2 token hits to avoid
 * false positives like "soap-dish" → soap.
 *
 * Returns null when no cluster meets the threshold or when index is null.
 */
export function clusterForCollection(collection, index) {
  if (!index?.keywords || !collection) return null;
  const text = `${collection.handle || ''} ${collection.title || ''}`.toLowerCase();
  const collectionTokens = new Set(text.replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter((w) => w.length > 2));
  if (collectionTokens.size === 0) return null;

  const counts = new Map();
  for (const entry of Object.values(index.keywords)) {
    if (!entry?.cluster || entry.cluster === 'unclustered') continue;
    const kwTokens = (entry.keyword || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/).filter((w) => w.length > 2);
    for (const tok of kwTokens) {
      if (collectionTokens.has(tok)) {
        counts.set(entry.cluster, (counts.get(entry.cluster) || 0) + 1);
      }
    }
  }

  let best = null;
  let bestCount = 0;
  for (const [cluster, count] of counts) {
    if (count > bestCount) { best = cluster; bestCount = count; }
  }
  return bestCount >= 2 ? best : null;
}
