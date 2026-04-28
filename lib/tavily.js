/**
 * Minimal Tavily client for image-grounding generative ad workflows.
 *
 * The creative-packager uses this to pull real-world reference photos
 * for the product category before calling Gemini, so the generated ads
 * are anchored to actual product photography rather than the model's
 * generic AI aesthetic.
 *
 * Tavily search endpoint reference:
 *   POST https://api.tavily.com/search
 *   Authorization: Bearer <api_key>
 *   { query, include_images: true, include_image_descriptions: true, max_results }
 *   → { images: [{ url, description }], ... }
 */

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

/**
 * Search for reference images. Returns an array of { url, description }
 * with at most `maxResults` entries. Returns [] when the API errors or
 * returns no images — never throws — so the caller can degrade gracefully.
 */
export async function searchImages(apiKey, query, { maxResults = 5, fetchImpl = fetch } = {}) {
  if (!apiKey || !query) return [];
  try {
    const res = await fetchImpl(TAVILY_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        include_images: true,
        include_image_descriptions: true,
        max_results: Math.min(maxResults, 20),
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const images = Array.isArray(data?.images) ? data.images : [];
    return images
      .filter((i) => i?.url)
      .slice(0, maxResults)
      .map((i) => ({ url: i.url, description: i.description ?? '' }));
  } catch {
    return [];
  }
}

/**
 * Download an image URL into a Buffer + mime hint. Returns null on failure.
 * Caps total bytes at 4 MB to keep Gemini payloads reasonable.
 */
export async function downloadImage(url, { fetchImpl = fetch, maxBytes = 4 * 1024 * 1024 } = {}) {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) return null;
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) return null;
    return { buffer: Buffer.from(ab), mimeType: ct.split(';')[0].trim() };
  } catch {
    return null;
  }
}
