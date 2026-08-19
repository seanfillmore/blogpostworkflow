/**
 * The ONE Shopify Admin API version for the whole fleet, plus the guard that
 * checks the version we asked for is the version we were served.
 *
 * ── Why this is its own module ───────────────────────────────────────────────
 * `lib/shopify.js` reads `.env` at import time and throws when the OAuth
 * credentials are absent. A dozen standalone scripts build their own admin URLs
 * and some authenticate differently, so forcing them through the full client to
 * reach one string would be a behaviour change. This file reads nothing, has no
 * side effects and no dependencies, so anything in the repo can import it.
 *
 * ── Why the guard exists ─────────────────────────────────────────────────────
 * A pin that does not pin is worse than no pin. Requesting a RETIRED version
 * does not fail — Shopify silently serves the oldest supported version instead
 * and reports what it actually served in `X-Shopify-API-Version`. Measured
 * against the live store on 2026-08-19, while the fleet believed it was on
 * 2025-01:
 *
 *     requested 2025-01 -> HTTP 200 | SERVED: 2025-10   <- fiction
 *     requested 2025-04 -> HTTP 200 | SERVED: 2025-10   <- fiction
 *     requested 2025-07 -> HTTP 200 | SERVED: 2025-10   <- fiction
 *     requested 2025-10 -> HTTP 200 | SERVED: 2025-10
 *     requested 2026-07 -> HTTP 200 | SERVED: 2026-07
 *     requested 2027-01 -> HTTP 404                     <- nonexistent DOES fail
 *
 * Nobody chose 2025-10; we drifted onto it three releases deep with no signal.
 * The only case that fails loudly on its own is a version that does not exist
 * yet (404, which the client already throws on). Silent fall-forward is the
 * case this guard is for.
 */

/**
 * Current stable quarterly release. Shopify ships Jan/Apr/Jul/Oct and supports
 * each version ~12 months. Do NOT bump to the next quarter early: the version
 * one quarter ahead is the release candidate and can change without notice,
 * which reintroduces exactly the "moves under us" failure this file prevents.
 */
export const API_VERSION = '2026-07';

/** Reads a header from either a `Headers` instance or a plain object. */
function header(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return null;
}

/**
 * Compares the version Shopify says it served against the version we asked for.
 *
 * Pure and synchronous — it decides nothing about logging or throwing, so it can
 * be unit-tested without a network or an `.env`.
 *
 * @param {Headers|Object} headers   response headers
 * @param {Object}   [opts]
 * @param {string}   [opts.requested] version we asked for (default: API_VERSION)
 * @returns {{drifted: boolean, served: string|null, requested: string,
 *            warning: string|null, deprecated: string|null, message: string|null}}
 *   `drifted` is true ONLY when Shopify reported a served version that differs
 *   from the requested one. A missing header is not drift — some responses omit
 *   it, and inventing a failure from an absent header would be noise.
 */
export function checkServedApiVersion(headers, { requested = API_VERSION } = {}) {
  const served = header(headers, 'x-shopify-api-version');
  const warning = header(headers, 'x-shopify-api-version-warning');
  const deprecated = header(headers, 'x-shopify-api-deprecated-reason');
  const drifted = Boolean(served) && served !== requested;

  const message = drifted
    ? `Shopify API version drift: requested ${requested}, Shopify SERVED ${served}. ` +
      `The pin in lib/shopify-api-version.js is a fiction — ${requested} is no longer ` +
      `supported and every Shopify call in the fleet is silently running on ${served}. ` +
      `Bump API_VERSION to a supported release.` +
      (warning ? ` (Shopify version warning: ${warning})` : '')
    : null;

  return { drifted, served, requested, warning, deprecated, message };
}
