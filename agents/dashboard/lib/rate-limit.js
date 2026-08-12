// agents/dashboard/lib/rate-limit.js
/**
 * Minimal in-memory, per-key rate limiter, plus a Cloudflare-aware client-IP
 * reader. Built for the giveaway write routes (`/enter`, `/answers`,
 * `/upload`), which are public, unauthenticated, and each accepted request
 * creates a real profile in production Klaviyo -- there was previously no
 * limit at all.
 *
 * Deliberately in-memory, no Redis, no new dependency: this is spam damping,
 * not a security boundary, and resetting on a PM2 restart is acceptable.
 * Deliberately LOOSE: households, offices, and mobile-carrier NAT share IPs,
 * and blocking a real entrant costs more than the spam it prevents.
 *
 * The map is deliberately bounded. This box's 24GB disk has already been
 * filled once by an unpruned dump, taking down every cron job for four days
 * -- unbounded growth of an in-memory Map is the same class of mistake
 * applied to RAM. Every check() call prunes expired buckets, and a hard cap
 * on distinct tracked keys evicts the least-recently-touched bucket once the
 * cap is reached (see createRateLimiter below).
 */

const DEFAULT_MAX_TRACKED_KEYS = 5000; // a few hundred bytes/bucket -> a few MB, worst case

/**
 * @param {object} opts
 * @param {number} opts.windowMs   - length of the rolling window, in ms
 * @param {number} opts.max        - max accepted checks per key per window
 * @param {number} [opts.maxTrackedKeys] - hard cap on distinct keys held at once
 * @param {() => number} [opts.now] - clock override, for tests
 */
export function createRateLimiter({
  windowMs, max, maxTrackedKeys = DEFAULT_MAX_TRACKED_KEYS, now = Date.now,
} = {}) {
  if (!windowMs || !max) throw new Error('createRateLimiter requires windowMs and max');
  const buckets = new Map(); // key -> { count, resetAt }

  /** Remove every bucket whose window has elapsed. O(n) over tracked keys, capped at maxTrackedKeys. */
  function prune(t) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= t) buckets.delete(key);
    }
  }

  return {
    /** Returns true and counts the request if under budget; false (and does NOT count it) once over. */
    check(key) {
      const t = now();
      prune(t);

      const existing = buckets.get(key);
      if (existing) {
        if (existing.count >= max) return false;
        existing.count += 1;
        // Re-insert so Map's insertion-order iteration doubles as
        // recency order -- the first key is always the
        // least-recently-touched one, which is what the eviction below
        // relies on for O(1) LRU-ish behaviour.
        buckets.delete(key);
        buckets.set(key, existing);
        return true;
      }

      buckets.set(key, { count: 1, resetAt: t + windowMs });
      if (buckets.size > maxTrackedKeys) {
        // Evict the oldest (least-recently-touched) bucket rather than
        // refusing new keys -- a cap on memory matters more here than
        // perfect fairness to whichever IP's bucket loses its count early.
        const oldest = buckets.keys().next().value;
        if (oldest !== undefined && oldest !== key) buckets.delete(oldest);
      }
      return true;
    },
    /** Exposed for tests -- current number of tracked keys. */
    size() { return buckets.size; },
  };
}

/**
 * Client IP, as seen through Cloudflare, which fronts this domain.
 *
 * `req.socket.remoteAddress` alone would be Cloudflare's edge IP, not the
 * visitor's -- every request would collapse onto a handful of Cloudflare PoP
 * addresses, making a per-IP limit either lock out unrelated visitors
 * sharing a PoP or, sized to avoid that, fail to limit anyone.
 *
 * Cloudflare sets `CF-Connecting-IP` at its edge on every request that
 * reaches the origin through its proxy, overwriting any client-supplied
 * header of the same name. So as long as the origin is not reachable by
 * skipping Cloudflare (hitting the origin IP/port directly), this header
 * cannot be spoofed by the request itself.
 *
 * Failure / spoofing behaviour:
 *  - Header present (the normal case, proxied through Cloudflare): trusted
 *    as-is.
 *  - Header absent (Cloudflare bypassed, or a local/dev request): falls back
 *    to the first hop of `X-Forwarded-For`, then the raw socket address --
 *    both of which ARE spoofable by the client in that scenario. That is an
 *    accepted gap for a damping control, not a security boundary; this
 *    limiter's job is to blunt a runaway script or scraper, not to resist a
 *    determined attacker who can also reach the origin directly.
 *  - Nothing usable at all: buckets under a fixed 'unknown' key, so such
 *    requests still get *some* shared limit instead of an unbounded
 *    exemption.
 */
export function getClientIp(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return String(cf).trim();

  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();

  return req.socket?.remoteAddress || 'unknown';
}
