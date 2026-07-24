/**
 * Serve a file from the dashboard's public/ directory.
 *
 * Returns true if the request was handled (file streamed or 404 sent),
 * false if the URL is outside the public/ namespace and the caller
 * should continue dispatching.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.map':  'application/json; charset=utf-8',
};

/**
 * Resolve a URL path against publicDir, returning the absolute file path
 * only if it stays inside publicDir (prevents path traversal).
 */
function safeResolve(publicDir, urlPath) {
  // Strip query string and leading slash
  const clean = urlPath.split('?')[0].replace(/^\/+/, '');
  const abs = normalize(join(publicDir, clean));
  if (!abs.startsWith(publicDir)) return null;
  return abs;
}

export function serveStatic(req, res, publicDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  // Map "/" to /index.html
  const urlPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = safeResolve(publicDir, urlPath);
  if (!filePath) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return true;
  }
  if (!existsSync(filePath)) return false;
  const st = statSync(filePath);
  if (st.isDirectory()) return false;

  const ext = extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const lastModified = st.mtime.toUTCString();

  // App-shell assets (HTML/JS/CSS/maps) must always revalidate: otherwise a
  // freshly deployed index.html can pair with a stale cached dashboard.js and
  // call functions the old JS doesn't have. `no-cache` = cache but revalidate
  // every load; a matching If-Modified-Since gets a cheap 304. Other assets
  // (images, fonts, icons) rarely change and stay cached for a day.
  const REVALIDATE = new Set(['.html', '.js', '.css', '.map']);
  const cacheControl = REVALIDATE.has(ext) ? 'no-cache' : 'public, max-age=86400';

  // Conditional GET: 304 when the file hasn't changed since the client's copy.
  const ims = req.headers && req.headers['if-modified-since'];
  if (ims) {
    const imsTime = Date.parse(ims);
    const fileTime = Math.floor(st.mtimeMs / 1000) * 1000; // HTTP-date second precision
    if (!Number.isNaN(imsTime) && fileTime <= imsTime) {
      res.writeHead(304, { 'Last-Modified': lastModified, 'Cache-Control': cacheControl });
      res.end();
      return true;
    }
  }

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': st.size,
    'Last-Modified': lastModified,
    'Cache-Control': cacheControl,
  });
  if (req.method === 'HEAD') { res.end(); return true; }
  createReadStream(filePath).on('error', () => { res.end(); }).pipe(res);
  return true;
}
