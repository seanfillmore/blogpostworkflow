// agents/dashboard/lib/router.js
/**
 * Tiny router. Takes an array of { method, match, handler } entries.
 * - method: 'GET' | 'POST' | 'PUT' | 'DELETE'
 * - match: string (exact URL match) OR function (url) => boolean
 * - handler: (req, res, ctx) => Promise<void> | void
 *
 * dispatch(routes, req, res, ctx) walks the route list and calls the first matching
 * handler. Returns true if a route matched, false otherwise.
 */
export function dispatch(routes, req, res, ctx) {
  for (const route of routes) {
    if (route.method !== req.method) continue;
    const matched = typeof route.match === 'string'
      ? req.url === route.match
      : route.match(req.url);
    if (!matched) continue;
    route.handler(req, res, ctx);
    return true;
  }
  return false;
}
