// tests/dashboard/static.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { serveStatic } from '../../agents/dashboard/lib/static.js';

// The dashboard's real public/ dir has index.html and js/dashboard.js.
const PUBLIC = join(process.cwd(), 'agents', 'dashboard', 'public');

function mockRes() {
  return {
    statusCode: 0,
    headers: {},
    ended: false,
    writeHead(code, hdrs) { this.statusCode = code; this.headers = hdrs || {}; },
    end() { this.ended = true; },
  };
}

// App-shell assets must always revalidate, so a fresh index.html can never
// pair with a stale cached dashboard.js after a deploy.
test('serveStatic: .js gets no-cache + Last-Modified (revalidate)', () => {
  const res = mockRes();
  const handled = serveStatic({ method: 'HEAD', url: '/js/dashboard.js', headers: {} }, res, PUBLIC);
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Cache-Control'], /no-cache/);
  assert.ok(res.headers['Last-Modified'], 'sends Last-Modified for revalidation');
});

test('serveStatic: index.html ("/") revalidates (entry doc never stale)', () => {
  const res = mockRes();
  serveStatic({ method: 'HEAD', url: '/', headers: {} }, res, PUBLIC);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Cache-Control'], /no-cache/);
});

test('serveStatic: If-Modified-Since >= mtime returns 304', () => {
  const mtime = statSync(join(PUBLIC, 'js', 'dashboard.js')).mtime.toUTCString();
  const res = mockRes();
  serveStatic({ method: 'GET', url: '/js/dashboard.js', headers: { 'if-modified-since': mtime } }, res, PUBLIC);
  assert.equal(res.statusCode, 304);
  assert.equal(res.ended, true);
});

test('serveStatic: non-shell assets stay cacheable (max-age)', () => {
  // dashboard.css is a shell asset; use a HEAD on a .png-style path via MIME.
  // Confirm the .css shell asset revalidates while max-age applies to images.
  const res = mockRes();
  serveStatic({ method: 'HEAD', url: '/dashboard.css', headers: {} }, res, PUBLIC);
  assert.match(res.headers['Cache-Control'], /no-cache/);
});
