// lib/citation-redirects.js
//
// Resolve the opaque redirector Gemini cites through, so `agents/pr-target-finder`
// can see WHICH PUBLICATION an answer actually leaned on.
//
// THE PROBLEM, measured on production 2026-09-20 over the four snapshots the
// agent reads (`--weeks 4`):
//
//   total citation URLs            12,527
//   Gemini grounding redirects      3,796   (30.3%)
//   distinct redirect tokens        3,796   (every token is unique)
//
// Every one of them is `https://vertexaisearch.cloud.google.com/grounding-api-
// redirect/<token>`, so `normalizeDomain` folds ALL of Gemini's citations onto
// one host. The consequences, both measured rather than reasoned about:
//
//   1. Gemini contributed ZERO pitch rows. The engine breakdown of the live
//      319-row pitch list was chatgpt 45, google_ai_overview 154, perplexity
//      297, gemini 0 — one of five engines, and the second-largest citation
//      source, invisible.
//   2. The redirector itself ranked SECOND by score with citation_count 3,796,
//      and only fell off the list because the enrichment step's `looksLikeStore`
//      heuristic happened to drop it after spending a fetch on it.
//
// Resolution is a single HEAD with `redirect: 'manual'`; the publisher URL comes
// back in `location`. It costs no API money — these are plain HTTP requests, not
// DataForSEO calls — which is why this lives here and not in the paid tracker.
// Doing it here also fixes the snapshots ALREADY on disk, which a tracker-side
// change could only have fixed going forward.
//
// EVERYTHING DEGRADES. A redirect that will not resolve is simply absent from
// the returned map, `aggregateCitations` then treats it as the redirector host,
// and `NON_EDITORIAL` excludes it — which is exactly the behaviour before this
// module existed. The failure direction is "Gemini contributes nothing this
// run", never "the run breaks".

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { isGroundingRedirect } from './pr-targets.js';

/** Hard ceiling on requests per run, so a malformed snapshot cannot become an
 *  unbounded outbound sweep. The measured four-week window needs 3,796. */
export const MAX_RESOLVE = 6000;
export const DEFAULT_CONCURRENCY = 8;
export const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Every distinct grounding-redirect URL in these snapshots, in first-seen order.
 * Pure.
 * @param {Array} snapshots
 * @returns {string[]}
 */
export function collectGroundingRedirects(snapshots) {
  const out = new Set();
  for (const snap of snapshots || []) {
    for (const result of (snap?.results || [])) {
      for (const resp of Object.values(result?.responses || {})) {
        if (!resp || resp.error) continue;
        for (const url of (resp.citation_urls || [])) {
          if (isGroundingRedirect(url)) out.add(url);
        }
      }
    }
  }
  return [...out];
}

/**
 * Follow ONE redirect hop and return where it points.
 *
 * Deliberately `redirect: 'manual'` rather than letting fetch follow: we want
 * the publisher URL, not that page's content, and not to pay for downloading it.
 * A response that is not a redirect (the token expired, Google served an
 * interstitial) yields null — an unresolved redirect, not a wrong answer.
 *
 * @returns {Promise<string|null>}
 */
export async function resolveOne(url, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RSC-PR-Research/1.0)' },
    });
    const status = res?.status;
    if (!(status >= 300 && status < 400)) return null;
    const location = res.headers?.get?.('location');
    if (!location) return null;
    // Absolute http(s) only. A relative Location would resolve back onto the
    // redirector, which is the domain we are trying to get rid of.
    if (!/^https?:\/\//i.test(location)) return null;
    // A redirect that lands back on the redirector tells us nothing.
    if (isGroundingRedirect(location)) return null;
    return location;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve many, bounded and concurrent, reusing anything already known.
 *
 * `cache` is read AND written: entries resolved on a previous run are not
 * re-fetched. That matters because the agent reads a sliding four-week window,
 * so three of its four snapshots were already resolved last week — measured, 0
 * of the 1,066 tokens in a given week ever recur in another week, so the saving
 * comes entirely from re-reading the same snapshots rather than from any token
 * being repeated.
 *
 * @param {string[]} urls
 * @param {{fetchImpl?:Function, concurrency?:number, timeoutMs?:number,
 *          limit?:number, cache?:Map<string,string|null>, onProgress?:Function}} [opts]
 * @returns {Promise<{resolved: Map<string,string>, attempted:number, failed:number,
 *                    fromCache:number, skipped:number}>}
 */
export async function resolveGroundingRedirects(urls, {
  fetchImpl = fetch,
  concurrency = DEFAULT_CONCURRENCY,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  limit = MAX_RESOLVE,
  cache = new Map(),
  onProgress,
} = {}) {
  const resolved = new Map();
  const todo = [];
  let fromCache = 0;

  for (const url of urls || []) {
    if (cache.has(url)) {
      const hit = cache.get(url);
      fromCache += 1;
      if (hit) resolved.set(url, hit);
      continue;
    }
    todo.push(url);
  }

  const budget = Math.max(0, Math.min(todo.length, limit));
  const skipped = todo.length - budget;
  const work = todo.slice(0, budget);

  let attempted = 0;
  let failed = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, work.length || 1)) }, async () => {
    while (cursor < work.length) {
      const url = work[cursor++];
      const dest = await resolveOne(url, { fetchImpl, timeoutMs });
      attempted += 1;
      // A miss is cached as null too: an expired token will still be expired
      // next week, and re-fetching 3,000 known failures every run is the cost
      // this cache exists to avoid.
      cache.set(url, dest);
      if (dest) resolved.set(url, dest); else failed += 1;
      if (onProgress && attempted % 250 === 0) onProgress(attempted, work.length);
    }
  });
  await Promise.all(workers);

  return { resolved, attempted, failed, fromCache, skipped };
}

// ── Cache persistence ────────────────────────────────────────────────────────
//
// Bounded by PRUNING to the keys of the window just processed rather than by a
// timer: the file can then never outgrow four weeks of redirects (~3,800
// entries, ~1 MB) no matter how long the agent runs. Nothing here is load-
// bearing — an unreadable or absent cache costs a slower run, never a wrong one.

/** @returns {Map<string, string|null>} */
export function loadRedirectCache(path) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.entries) return new Map();
    return new Map(Object.entries(raw.entries));
  } catch {
    return new Map();
  }
}

/**
 * Write the cache back, keeping only the URLs this run actually looked at.
 * Best-effort: a write failure is swallowed, because a cache that cannot be
 * saved must not fail a run that has already produced its report.
 */
export function saveRedirectCache(path, cache, keepKeys) {
  try {
    const keep = keepKeys instanceof Set ? keepKeys : new Set(keepKeys || []);
    const entries = {};
    for (const [k, v] of cache) {
      if (keep.size && !keep.has(k)) continue;
      entries[k] = v ?? null;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ saved_at: new Date().toISOString(), entries }, null, 2));
    return Object.keys(entries).length;
  } catch {
    return 0;
  }
}
