// agents/dashboard/lib/router.js
/**
 * Tiny router. Takes an array of { method, match, handler } entries.
 * - method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
 * - match: string (exact URL match) OR function (url) => boolean
 * - handler: (req, res, ctx) => Promise<void> | void
 *
 * dispatch(routes, req, res, ctx) walks the route list and calls the first matching
 * handler. Returns true if a route matched, false otherwise.
 *
 * WHY THE GUARD BELOW EXISTS. dispatch() calls handlers WITHOUT awaiting them, and
 * `seo-dashboard` is a single shared PM2 process on a public URL. Before this guard,
 * any throw a handler did not catch itself was fatal to the whole process: a sync
 * throw propagated into http.createServer's listener as an uncaughtException, and a
 * rejected handler promise became an unhandledRejection, which Node has terminated on
 * by default since v15. One malformed request took down every tab.
 *
 * BOTH arms are required and they catch different things. The try/catch cannot see a
 * rejection (the handler has already returned by then); the .then() rejection arm
 * cannot see a synchronous throw (there is no promise yet). `campaigns.js`'s bodyless
 * handlers are entirely synchronous and are caught only by the first; every migrated
 * async handler is caught only by the second.
 *
 * WHAT THIS GUARD STILL CANNOT REACH: a throw inside a `req.on('end', cb)` callback.
 * That runs on a later tick on the emitter's stack, outside the handler's promise
 * chain, so no amount of wrapping here will see it. That is why every route module
 * reads its body through readJsonBody and awaits it — the migration is what brings
 * that code inside the promise this guard is watching. Do not reintroduce a route that
 * does its work inside an 'end' callback; it would be silently unprotected.
 */
export function dispatch(routes, req, res, ctx) {
  for (const route of routes) {
    if (route.method !== req.method) continue;
    const matched = typeof route.match === 'string'
      ? req.url === route.match
      : route.match(req.url);
    if (!matched) continue;

    try {
      const result = route.handler(req, res, ctx);
      // Thenable check rather than Promise.resolve(): sync handlers stay fully
      // synchronous, which keeps the existing non-async routes on their current tick.
      if (result && typeof result.then === 'function') {
        result.then(undefined, (err) => failRoute(req, res, err));
      }
    } catch (err) {
      failRoute(req, res, err);
    }
    return true;
  }
  return false;
}

/**
 * Answer a fixed 500. NEVER echoes the exception — this process is reachable from the
 * public internet and exception text carries absolute paths and occasionally token
 * fragments. The detail goes to stderr, which PM2 captures.
 */
function failRoute(req, res, err) {
  console.error(`[router] unhandled error in ${req.method} ${req.url}:`, err?.stack || err);

  // The handler may have already answered and then failed partway through streaming
  // (several routes write SSE). Writing a second set of headers would throw from
  // inside the error path itself, so tear the socket down instead.
  if (res.headersSent || res.writableEnded) {
    try { res.destroy(); } catch { /* connection already gone */ }
    return;
  }

  try {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'internal error' }));
  } catch { /* client vanished mid-write; nothing left to do */ }
}
