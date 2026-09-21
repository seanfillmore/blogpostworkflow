// lib/fetch-pool.js
//
// A bounded, per-host-capped fetch scheduler whose OUTCOMES ARE NAMED.
//
// Built for `agents/pr-target-finder`, whose enrichment pass — fetch the cited
// article, read its byline, its dates and its author page — was serial and
// therefore capped far below the list it had to cover. Measured on production
// 2026-09-21: **502 pitch targets, 103 enriched.** Everything below the budget
// shipped as a bare domain, so four fifths of the ranked list carried no byline
// data at all and the usable pool was a sample rather than the list.
//
// TWO THINGS MAKE THIS DIFFERENT FROM `Promise.all` OVER A MAP.
//
// 1. PER-HOST BOUNDING, not just a global width. CLAUDE.md's Ahrefs section
//    records a hand crawl of one host at ~6 concurrent earning a 429 on every
//    subsequent request from that IP, persisting past a two-minute cooldown,
//    and briefly recording nine healthy articles as broken. A global width says
//    nothing about how many of those requests land on one publisher.
//
// 2. A FETCH THAT WAS REFUSED MUST NOT LOOK LIKE A FETCH THAT FOUND NOTHING.
//    PR #944 is the cautionary case: an unbounded sweep of 8,400 requests to
//    `vertexaisearch.cloud.google.com` resolved only 2,032 — Google silently
//    serves fewer answers past roughly 6,000 rather than erroring — and the
//    under-resolved run reported real citation rates as ZEROS while looking
//    exactly like a clean run. The same shape was already live here: the old
//    `fetchPage` returned `null` for a 403, a 429, a timeout and a DNS failure
//    alike, and the agent then recorded "no byline found".
//
//    THAT IS NOT A RARE CASE. Measured 2026-09-21 over 240 real pitch-target
//    URLs (four disjoint stride samples of 60 from the live 502-row report):
//
//      ok             212   88.3%
//      blocked (403)   17    7.1%
//      not-found        4    1.7%
//      timeout          3    1.3%
//      rate-limited     1    0.4%
//      network-error    1    0.4%
//      server-error     1    0.4%
//      http-error       1    0.4%
//
//    So ~12% of enrichment fetches never see a page, and every one of them was
//    being reported as a target with no byline. `classifyStatus`/`classifyThrow`
//    give each its own name, and the agent counts and prints them.
//
// CONCURRENCY IS 6 BECAUSE 12 MEASURED NO FASTER. Same samples, wall clock for
// 60 URLs: serial 55.7s (928 ms/fetch mean), concurrency 6 → 10.9s and 10.5s on
// two disjoint samples (~5.2x), concurrency 12 → 11.0s. Per-fetch latency is
// flat across all three (p50 470/478/484 ms), so the bottleneck is round-trip
// latency and at 6 the wall clock is already dominated by the two or three
// slowest requests — one 8s timeout is most of a 10.5s wave. Past the knee,
// extra width buys nothing and only raises outbound pressure.
//
// PER-HOST IS 1, AND ON TODAY'S DATA THAT IS ALMOST A NO-OP — stated plainly
// rather than sold as protection it is not providing. `rankTargets` aggregates
// by DOMAIN, so the live report's 502 rows are 502 distinct hosts (496
// registrable groups; the largest, `nih.gov`, holds 3). At width 6 the pool is
// therefore already talking to 6 different publishers, never 6 threads at one.
// What the cap actually buys: (a) a row's article fetch and its own author-page
// fetch can never overlap, (b) the three-row `nih.gov` group is serialised, at
// a cost of ~2 seconds, and (c) it holds if `rankTargets` ever emits URL-level
// rows, which would turn a one-per-host list into a many-per-host one with no
// other part of this file noticing.

/** Width of the pool. Measured knee; see the header. */
export const DEFAULT_CONCURRENCY = 6;
/** In-flight requests allowed against one registrable domain. */
export const DEFAULT_PER_HOST = 1;
/** Hard ceiling on what `--concurrency` may be raised to without re-measuring. */
export const MAX_CONCURRENCY = 16;
export const MAX_PER_HOST = 4;
export const DEFAULT_TIMEOUT_MS = 8000;

// A `Retry-After` longer than this is a publisher telling us to come back
// another day, not to pause — waiting it out would blow the step budget, so
// such a request is recorded as rate-limited and abandoned.
export const MAX_RETRY_WAIT_MS = 5000;
// Ceiling on rate-limit retries for a whole run, so a publisher answering 429
// with `Retry-After: 5` to everything cannot add 400 x 13s to the run. The
// measured rate is 1 in 240 (~0.4%), so 400 rows expect ~2; 25 is ~12x that.
export const MAX_RATE_LIMIT_RETRIES = 25;

/** Every outcome this module can return. `ok` is the only success. */
export const OUTCOMES = Object.freeze([
  'ok',
  'not-found',      // 404 / 410 — the page is gone, which is an answer
  'rate-limited',   // 429, or 503 with a Retry-After
  'blocked',        // 401 / 403 / 451 — the publisher refused us specifically
  'server-error',   // 5xx
  'http-error',     // any other non-2xx
  'timeout',        // our own AbortController fired
  'network-error',  // DNS, TLS, connection reset
  'not-attempted',  // never fetched: past the budget, or the pass was disabled
]);

/** Outcomes that mean "we did not see the page". Everything but `ok`. */
export const FAILED_OUTCOMES = Object.freeze(OUTCOMES.filter((o) => o !== 'ok'));

/**
 * The registrable-ish domain, used as the throttling key so that
 * `pmc.ncbi.nlm.nih.gov` and `www.nih.gov` share a slot.
 *
 * Deliberately naive rather than PSL-backed: it only ever decides how fast we
 * talk to somebody. Being wrong groups two unrelated sites together (slower,
 * never ruder) or splits one publisher in two (still one request per host).
 * Accepts a bare domain as well as a URL, because the agent falls back to
 * `https://<domain>/` when a snapshot carries no article URL.
 */
export function hostGroup(value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  const host = raw
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^[^/@]*@/, '')
    .split(/[/?#]/)[0]
    .split(':')[0]
    .replace(/^www\./, '');
  if (!host) return '';
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const last = parts[parts.length - 1];
  const penultimate = parts[parts.length - 2];
  // co.uk / com.au / org.nz — a short penultimate label under a 2-letter TLD.
  if (penultimate.length <= 3 && last.length === 2) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

/** `Retry-After` in ms: delta-seconds or an HTTP date. null when unusable. */
export function parseRetryAfter(value, { now = Date.now() } = {}) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return Number(raw) * 1000;
  const when = Date.parse(raw);
  if (!Number.isFinite(when)) return null;
  return Math.max(0, when - now);
}

/**
 * Map an HTTP status onto an outcome. Pure.
 *
 * The 503 split is the interesting one: a 503 WITH a `Retry-After` is a
 * publisher pacing us and is worth one retry, while a bare 503 is the origin
 * being down and retrying it immediately buys nothing.
 */
export function classifyStatus(status, { retryAfter = null } = {}) {
  const s = Number(status);
  if (s === 429) return 'rate-limited';
  if (s === 503 && retryAfter != null && String(retryAfter).trim() !== '') return 'rate-limited';
  if (s === 404 || s === 410) return 'not-found';
  if (s === 401 || s === 403 || s === 451) return 'blocked';
  if (s >= 500) return 'server-error';
  if (s >= 200 && s < 300) return 'ok';
  return 'http-error';
}

/** Our own abort is a timeout; anything else thrown is the network. Pure. */
export function classifyThrow(err) {
  const name = err?.name || '';
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  return 'network-error';
}

/**
 * The `'ok' | 'not-found' | 'error'` vocabulary `lib/author-currency.js`
 * already speaks. Kept as an explicit narrowing rather than changing that
 * module: its `not-found` branch carries a measured decision (a 404 on an
 * author page is NOT a departure) that must not be widened by accident.
 */
export function legacyStatus(outcome) {
  if (outcome === 'ok') return 'ok';
  if (outcome === 'not-found') return 'not-found';
  return 'error';
}

/**
 * One GET, with its outcome named.
 *
 * Returns `{ outcome, status, html, retried }`. `html` is non-null only on
 * `ok`, and is capped at `maxBytes` characters — the agent holds one of these
 * per in-flight worker, so the cap is what bounds peak memory on a 961 MB box.
 *
 * `rateLimitBudget` is a shared `{ spent: 0 }` counter, so the one retry this
 * function will make is bounded ACROSS THE RUN and not per call.
 */
export async function fetchWithOutcome(url, {
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = 400_000,
  userAgent = 'Mozilla/5.0 (compatible; RSC-PR-Research/1.0)',
  rateLimitBudget = null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
} = {}) {
  let retried = false;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let outcome;
    let status = null;
    let html = null;
    let waitMs = null;
    try {
      const res = await fetchImpl(url, {
        headers: { 'User-Agent': userAgent },
        redirect: 'follow',
        signal: controller.signal,
      });
      status = res?.status ?? null;
      const retryAfter = res?.headers?.get?.('retry-after') ?? null;
      outcome = classifyStatus(status, { retryAfter });
      if (outcome === 'ok') html = String(await res.text()).slice(0, maxBytes);
      if (outcome === 'rate-limited') waitMs = parseRetryAfter(retryAfter, { now: now() });
    } catch (err) {
      outcome = classifyThrow(err);
    } finally {
      clearTimeout(timer);
    }

    // Exactly one retry, only for an explicitly paced rate limit, only inside
    // the run-wide budget, and only when the publisher named a wait we can
    // afford. Every other failure is returned as it is — a retry loop that
    // guesses is how a bounded pass becomes an unbounded sweep.
    const canRetry = outcome === 'rate-limited'
      && !retried
      && waitMs != null && waitMs > 0 && waitMs <= MAX_RETRY_WAIT_MS
      && rateLimitBudget != null
      && rateLimitBudget.spent < MAX_RATE_LIMIT_RETRIES;
    if (!canRetry) return { outcome, status, html, retried };
    rateLimitBudget.spent += 1;
    retried = true;
    await sleep(waitMs);
  }
}

/**
 * Run `worker(item, index)` over `items`, bounded globally and per host.
 *
 * ORDERING IS INDEX-BASED, NEVER COMPLETION-BASED: `results[i]` is always the
 * result for `items[i]`, whichever worker finished first. That is what lets the
 * agent keep its ranking deterministic while the fetches race — the rows are
 * mutated in place and re-sorted by a stable index sort afterwards, so no part
 * of the report can depend on which publisher answered fastest.
 *
 * A worker that throws yields `{ error }` at its index and does not stop the
 * pool: one publisher serving malformed markup must not cost the other 399.
 *
 * @param {Array} items
 * @param {(item:any, index:number) => Promise<any>} worker
 * @param {{concurrency?:number, perHost?:number, keyOf?:Function, onProgress?:Function}} [opts]
 * @returns {Promise<Array>} results, indexed to match `items`
 */
export async function runPool(items, worker, {
  concurrency = DEFAULT_CONCURRENCY,
  perHost = DEFAULT_PER_HOST,
  keyOf = () => '',
  onProgress = null,
} = {}) {
  const list = Array.from(items || []);
  const results = new Array(list.length);
  if (!list.length) return results;

  const width = Math.max(1, Math.min(Math.trunc(concurrency) || 1, list.length));
  const perKey = Math.max(1, Math.trunc(perHost) || 1);
  const queue = list.map((item, index) => ({ item, index, key: keyOf(item, index) || '' }));
  const inFlight = new Map();
  let completed = 0;
  let waiters = [];
  const wake = () => { const w = waiters; waiters = []; for (const resolve of w) resolve(); };
  const idle = () => new Promise((resolve) => { waiters.push(resolve); });

  async function runner() {
    for (;;) {
      if (!queue.length) return;
      // The first queued item whose host is not already at capacity. Scanning
      // past a saturated host rather than blocking on it is what stops one slow
      // publisher idling the whole pool.
      // AN EMPTY KEY IS "UNKNOWN HOST", NOT "ALL THE SAME HOST", and the
      // difference is load-bearing. `hostGroup` returns '' for anything it
      // cannot parse, and the default `keyOf` returns '' for every item; if
      // those shared one bucket, a handful of malformed rows — or a caller
      // that simply did not pass a `keyOf` — would serialise the entire pool
      // at width 1 while reporting the configured concurrency. Unkeyed items
      // are bounded by the global width alone.
      let pick = -1;
      for (let i = 0; i < queue.length; i += 1) {
        const key = queue[i].key;
        if (!key || (inFlight.get(key) || 0) < perKey) { pick = i; break; }
      }
      if (pick === -1) {
        // Every remaining item is behind a busy host, so something is in flight
        // and a completion is the only thing that can free a slot.
        await idle();
        continue;
      }
      const job = queue.splice(pick, 1)[0];
      if (job.key) inFlight.set(job.key, (inFlight.get(job.key) || 0) + 1);
      try {
        results[job.index] = await worker(job.item, job.index);
      } catch (error) {
        results[job.index] = { error };
      } finally {
        if (job.key) {
          const left = (inFlight.get(job.key) || 1) - 1;
          if (left <= 0) inFlight.delete(job.key); else inFlight.set(job.key, left);
        }
        completed += 1;
        if (onProgress) { try { onProgress(completed, list.length); } catch { /* reporting must not fail a run */ } }
        wake();
      }
    }
  }

  await Promise.all(Array.from({ length: width }, () => runner()));
  return results;
}

/** Count outcomes into a plain object, zero-filled for nothing. Pure. */
export function tallyOutcomes(outcomes) {
  const tally = {};
  for (const o of outcomes || []) {
    const key = OUTCOMES.includes(o) ? o : 'network-error';
    tally[key] = (tally[key] || 0) + 1;
  }
  return tally;
}

/** `ok 372 · blocked 19 · timeout 5` — descending, for a console or a digest. */
export function renderOutcomeTally(tally) {
  const entries = Object.entries(tally || {}).filter(([, n]) => n > 0);
  if (!entries.length) return 'none';
  entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.map(([k, n]) => `${k} ${n}`).join(' · ');
}

// A run that fetched far less than it meant to is the PR #944 shape, and it is
// invisible unless something says so. This is the EMPHATIC form only — the
// per-outcome counts and the "never saw the page for N targets" line print on
// every run regardless, so nothing is hidden by the banner staying quiet.
//
// BOTH NUMBERS ARE CALIBRATED AGAINST THE MEASURED BASELINE, because a banner
// that fires on ordinary sampling noise is a banner nobody reads — the same
// reasoning that keeps a routine finding out of the digest's Failures block.
// Baseline failure share is 11.7% (28 of 240 live URLs). At the scheduled
// budget of 400 the binomial SD of that share is 1.6pp, so:
//
//   0.15 → 2.1 SD above baseline: fires on noise a few times a year
//   0.20 → 5.2 SD above baseline: effectively only on a real refusal
//
// and at a hand-run `--enrich 40` (SD 5.1pp) 0.15 fires on noise roughly a
// quarter of the time — measured, on the first real local run of this change,
// which came back 7/40 and tripped it.
export const DEGRADED_FAILURE_SHARE = 0.20;
// Below this many attempts the share is not evidence: three failures out of ten
// is not a degraded run. Every scheduled run is 400, so this only ever exempts
// a small hand-run, which still gets the per-outcome counts.
export const DEGRADED_MIN_ATTEMPTS = 50;

/**
 * Why this enrichment pass should not be read as complete — or null when it
 * should. Same job as `hold.disarmed` and `efficiencyBanner()`: a pass that
 * quietly stopped working must not render identically to a clean one.
 */
export function degradedReason(tally, {
  failureShare = DEGRADED_FAILURE_SHARE,
  minAttempts = DEGRADED_MIN_ATTEMPTS,
} = {}) {
  const counts = tally || {};
  const attempted = OUTCOMES
    .filter((o) => o !== 'not-attempted')
    .reduce((sum, o) => sum + (counts[o] || 0), 0);
  if (attempted < minAttempts) return null;
  const failed = attempted - (counts.ok || 0);
  if (failed / attempted < failureShare) return null;
  const pct = ((failed / attempted) * 100).toFixed(1);
  return `${failed} of ${attempted} fetches (${pct}%) never saw the page — ${renderOutcomeTally(
    Object.fromEntries(Object.entries(counts).filter(([k]) => k !== 'ok' && k !== 'not-attempted')),
  )}`;
}
