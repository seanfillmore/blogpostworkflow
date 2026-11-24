/**
 * Google `goto` redirect links -> real destination URLs.
 *
 * Since 2026-10-30 Google wraps result links in opaque
 * `https://google.com/goto?url=...` redirects. DataForSEO resolves them for
 * Standard tasks, but a Live call returns them raw: measured 2026-11-24, 9 of 9
 * organic results and about half of AI Overview citations came back as goto
 * links, every one with `domain: "google.com"`. Anything that asks "who ranks"
 * or "who was cited" then reads Google as every competitor, which is how the AI
 * Overview citation rate fell from 3-8% to exactly 0 on 2026-11-15.
 *
 * Two fixes exist; this module uses the second, for both `getSerpResults` and
 * the AI Overview client:
 *   - `resolve_goto_urls: true` on the Live request (DataForSEO's flag): same
 *     price, but measured at 90-161s per call against ~15s without it. Too slow
 *     for demand-miner's 40 serial seeds or the tracker's 115 AIO calls.
 *   - The free `/appendix/goto_url_converter` endpoint: measured ~10s per SERP.
 *     Google throttles resolution per SERP page, so a large batch stalls or
 *     500s (12 links: "Internal Error" after 30s) while a small one is fast
 *     (4 links: 3.6s). Hence small batches and one retry.
 *
 * A link that cannot be resolved is LEFT AS IS and counted, never dropped: an
 * unresolved citation is an unknown, not evidence that nobody was cited.
 */

export const GOTO_CONVERTER_URL = 'https://api.dataforseo.com/v3/appendix/goto_url_converter';
export const GOTO_BATCH_SIZE = 4;

export function isGotoUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return /(^|\.)google\.com$/.test(u.hostname) && u.pathname === '/goto';
  } catch {
    return false;
  }
}

export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Pull `{goto, url}` pairs out of a converter response; ignores anything malformed. */
export function parseConverterResponse(json) {
  const map = new Map();
  const task = json?.tasks?.[0];
  if (task?.status_code !== 20000) return map;
  for (const row of task.result || []) {
    if (row && isGotoUrl(row.goto) && typeof row.url === 'string' && /^https?:\/\//.test(row.url) && !isGotoUrl(row.url)) {
      map.set(row.goto, row.url);
    }
  }
  return map;
}

/**
 * Resolve goto links through the free converter.
 * @param {string[]} urls - any URLs; only goto links are sent
 * @param {object} opts - { auth (base64 DataForSEO auth), fetchImpl, batchSize, retries }
 * @returns {Promise<{ resolved: Map<string,string>, unresolved: number }>}
 */
export async function resolveGotoUrls(urls, { auth, fetchImpl = fetch, batchSize = GOTO_BATCH_SIZE, retries = 1 } = {}) {
  const gotos = [...new Set((urls || []).filter(isGotoUrl))];
  const resolved = new Map();
  if (!gotos.length || !auth) return { resolved, unresolved: gotos.length };

  for (const batch of chunk(gotos, batchSize)) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const pending = batch.filter((g) => !resolved.has(g));
      if (!pending.length) break;
      try {
        const res = await fetchImpl(GOTO_CONVERTER_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
          body: JSON.stringify([{ goto_urls: pending }]),
        });
        if (!res.ok) continue;
        for (const [g, u] of parseConverterResponse(await res.json())) resolved.set(g, u);
      } catch {
        // network error: retry, then leave the batch unresolved
      }
    }
  }
  return { resolved, unresolved: gotos.filter((g) => !resolved.has(g)).length };
}

/**
 * Rewrite organic rows `{url, domain, ...}` whose url was a goto link: the url
 * becomes the destination and `domain` is rebuilt from it (DataForSEO reports
 * "google.com" for every goto row). Unresolved rows are returned unchanged.
 */
export function applyResolvedToOrganic(rows, resolved) {
  return (rows || []).map((r) => {
    const dest = r && resolved.get(r.url);
    if (!dest) return r;
    let domain = r.domain;
    try { domain = new URL(dest).hostname; } catch { /* keep */ }
    return { ...r, url: dest, domain };
  });
}

/** Swap resolved goto links for their destinations, keeping order and unresolved links. */
export function applyResolvedGotos(urls, resolved) {
  return (urls || []).map((u) => resolved.get(u) || u);
}
