// agents/dashboard/lib/responses.js
export function respondJson(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

export function respondError(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: message }));
}

/** 1 MB. Generous for every authenticated JSON body (chat caps its message at 2000
 *  chars; creatives passes filenames and session ids, never image bytes) and far below
 *  a memory problem. The one route that receives image bytes, POST /api/creatives/generate,
 *  is multipart via multer and never reaches this function. */
export const DEFAULT_MAX_BYTES = 1024 * 1024;

/**
 * Resolves the parsed JSON body, or REJECTS — it never resolves something a validator
 * will throw on.
 *
 * THE BUG THIS FIXES (code review 2026-08-17, confirmed by execution through the real
 * dispatch()). JSON's top level may legally be `null` or a scalar, so `JSON.parse('null')`
 * resolved as `null`. Every validator downstream defaults its body parameter — `function
 * validateGenerate(body = {}, ...)` — and a parameter default fires only on `undefined`,
 * never on `null`, so `body.product` threw a TypeError. Those validator calls sit OUTSIDE
 * the handlers' own try/catch, lib/router.js's dispatch() calls handlers without awaiting
 * them, and nothing in this process registers an `unhandledRejection` handler. The result
 * was that `curl -X POST /api/ad-brief/generate -d 'null'` terminated the entire shared
 * seo-dashboard PM2 process — every tab with it, on a public URL.
 *
 * REJECT rather than coerce to `{}`, for two reasons:
 *
 *   1. Rejecting is free. All three route modules that use this helper already answer a
 *      fixed `400 bad JSON body` from their `catch` — the fix therefore needs no per-route
 *      change and cannot be forgotten in a route added later, which coercion could be.
 *   2. Coercion would make a malformed body INDISTINGUISHABLE FROM AN EMPTY ONE. Every
 *      caller treats a missing field as absent, so on any route whose fields are all
 *      optional, `-d 'null'` would stop being an error and start being "do the default
 *      thing" — a nonsense request quietly performing an action. `null` is not an empty
 *      object and must not be read as one.
 *
 * An ARRAY is deliberately passed through untouched. `[].product` is `undefined`, not a
 * throw, so an array cannot cause the crash this exists to close; every validator already
 * reads it correctly as "no fields supplied" and answers 400 on its own terms. Refusing
 * arrays here would be a gratuitous behaviour change for a shape that is already handled,
 * so the rule stays as narrow as the defect: what is refused is exactly what would throw
 * on property access.
 *
 * An absent body still resolves `{}` — a GET-shaped POST with no fields is an ordinary
 * request, and that behaviour predates this change.
 *
 * THE CAP. This is the single body reader for all twelve route modules, and two of them
 * — /api/rum and /api/giveaway/* — are deliberately UNAUTHENTICATED. They capped their
 * bodies before this unification, so the cap is a per-call option and those callers pass
 * their own existing values (8 KB, 4 KB, and MAX_UPLOAD_BASE64 + 2048 respectively).
 * A single shared constant would have silently raised the limit on the two routes that
 * most need one. `err.code = 'BODY_TOO_LARGE'` is load-bearing: giveaway.js branches on
 * that exact string to answer 413 rather than 400. So is `req.destroy()`: without it a
 * client can keep streaming into a request that has already been refused.
 *
 * Chunks are buffered and concatenated as Buffers, never accumulated with `body += chunk`.
 * The latter calls toString() per chunk and corrupts any UTF-8 sequence that straddles a
 * chunk boundary — which every hand-rolled reader this replaces was doing.
 */
export function readJsonBody(req, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let overflowed = false;
    const chunks = [];

    req.on('data', (chunk) => {
      if (overflowed) return;
      size += chunk.length;
      if (size > maxBytes) {
        overflowed = true;
        const err = new Error('request body too large');
        err.code = 'BODY_TOO_LARGE';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (overflowed) return;
      const body = Buffer.concat(chunks).toString('utf8');
      if (!body) return resolve({});
      let parsed;
      try { parsed = JSON.parse(body); } catch (err) { return reject(err); }
      // `null` and every scalar. Fixed message — it is handed back as a fixed 400 by the
      // callers, and never carries any part of the request.
      if (parsed === null || typeof parsed !== 'object') {
        return reject(new Error('request body must be a JSON object'));
      }
      resolve(parsed);
    });

    req.on('error', reject);
  });
}
