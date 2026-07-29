// agents/dashboard/routes/rum.js
/**
 * Real User Monitoring collector.
 *
 * POST /api/rum   — accepts a Core Web Vitals beacon from theme/snippets/rsc-rum.liquid
 * OPTIONS /api/rum — CORS preflight. The beacon is sent as text/plain precisely so
 *                    it stays a *simple* request and never preflights; this handler
 *                    exists only for the fetch fallback path.
 *
 * Appends one JSON line per beacon to data/snapshots/rum/YYYY-MM-DD.jsonl.
 * agents/rum-monitor aggregates those into p75 by page x device.
 *
 * This is a PUBLIC, unauthenticated endpoint on a box whose 24GB disk has
 * already taken down every cron job once by filling up, so every write path
 * here is bounded: request bodies are capped, the daily file has a hard size
 * ceiling, and anything failing validation is dropped rather than stored.
 */
import { appendFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/paths.js';

// NB: paths.js exports SNAPSHOTS_DIR as data/rank-snapshots, which is a
// different tree. RUM belongs with the daily metric feeds under data/snapshots.
const RUM_DIR = join(ROOT, 'data', 'snapshots', 'rum');

const MAX_BODY_BYTES = 8 * 1024;        // a beacon is ~400-900 bytes; 8KB is generous
const MAX_DAILY_FILE_BYTES = 16 * 1024 * 1024; // ~40k beacons/day, then stop writing
const MAX_METRICS_PER_BEACON = 8;

const ALLOWED_ORIGINS = new Set([
  'https://www.realskincare.com',
  'https://realskincare.com',
]);

// name -> max plausible value. Anything outside is a bug or an attempt to poison
// the aggregate, and either way we do not want it in the percentiles.
const METRIC_BOUNDS = {
  LCP: 600000,
  FCP: 600000,
  TTFB: 600000,
  INP: 600000,
  CLS: 100,
};

const RATINGS = new Set(['good', 'needs-improvement', 'poor']);

function corsHeaders(req) {
  const origin = req.headers.origin;
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : 'https://www.realskincare.com';
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/** Read the body with a hard byte cap, destroying the socket if exceeded. */
function readCappedBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function classifyDevice(ua = '') {
  if (/\bTablet\b|\biPad\b|Android(?!.*\bMobile\b)/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone|iPod|Windows Phone/i.test(ua)) return 'mobile';
  return 'desktop';
}

const str = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);

function cleanAttribution(name, attr) {
  if (!attr || typeof attr !== 'object') return null;
  const numeric = (v) => (Number.isFinite(v) && v >= 0 && v <= 600000 ? v : null);
  const base = { element: str(attr.element, 300) };
  if (name === 'LCP') {
    return {
      ...base,
      url: str(attr.url, 300),
      ttfb: numeric(attr.ttfb),
      loadDelay: numeric(attr.loadDelay),
      loadDuration: numeric(attr.loadDuration),
      renderDelay: numeric(attr.renderDelay),
    };
  }
  if (name === 'CLS') {
    const v = attr.largestShiftValue;
    return {
      ...base,
      largestShiftValue: Number.isFinite(v) && v >= 0 && v <= 100 ? v : null,
      largestShiftTime: numeric(attr.largestShiftTime),
    };
  }
  if (name === 'INP') {
    return {
      ...base,
      interactionType: str(attr.interactionType, 20),
      inputDelay: numeric(attr.inputDelay),
      processingDuration: numeric(attr.processingDuration),
      presentationDelay: numeric(attr.presentationDelay),
    };
  }
  return base;
}

/** Returns a sanitised record, or null if the beacon is unusable. */
export function validateBeacon(payload, { ua = '' } = {}) {
  if (!payload || typeof payload !== 'object') return null;

  const path = str(payload.path, 300);
  if (!path || !path.startsWith('/')) return null;

  if (!Array.isArray(payload.metrics) || !payload.metrics.length) return null;

  const metrics = [];
  for (const m of payload.metrics.slice(0, MAX_METRICS_PER_BEACON)) {
    if (!m || typeof m !== 'object') continue;
    const name = typeof m.name === 'string' ? m.name : null;
    const bound = name ? METRIC_BOUNDS[name] : undefined;
    if (bound === undefined) continue;                      // unknown metric name
    if (!Number.isFinite(m.value) || m.value < 0 || m.value > bound) continue;
    metrics.push({
      name,
      value: m.value,
      rating: RATINGS.has(m.rating) ? m.rating : null,
      navigationType: str(m.navigationType, 30),
      attr: cleanAttribution(name, m.attr),
    });
  }
  if (!metrics.length) return null;

  const vw = Number.isFinite(payload.vw) && payload.vw > 0 && payload.vw < 20000
    ? Math.round(payload.vw)
    : null;

  return {
    ts: new Date().toISOString(),
    path,
    template: str(payload.template, 60),
    device: classifyDevice(ua),
    vw,
    conn: str(payload.conn, 12),
    saveData: payload.saveData === true,
    metrics,
  };
}

function dailyPath(date = new Date().toISOString().slice(0, 10)) {
  return join(RUM_DIR, `${date}.jsonl`);
}

/** Append a validated record unless the day's file has hit its ceiling. */
export function appendBeacon(record, { file = dailyPath() } = {}) {
  mkdirSync(RUM_DIR, { recursive: true });
  if (existsSync(file) && statSync(file).size > MAX_DAILY_FILE_BYTES) return false;
  appendFileSync(file, `${JSON.stringify(record)}\n`);
  return true;
}

export default [
  {
    method: 'OPTIONS',
    match: (url) => url.split('?')[0] === '/api/rum',
    handler: (req, res) => {
      res.writeHead(204, corsHeaders(req));
      res.end();
    },
  },
  {
    method: 'POST',
    match: (url) => url.split('?')[0] === '/api/rum',
    handler: async (req, res) => {
      const headers = { ...corsHeaders(req), 'Content-Type': 'application/json' };
      let raw;
      try {
        raw = await readCappedBody(req);
      } catch {
        if (!res.headersSent) { res.writeHead(413, headers); res.end(JSON.stringify({ ok: false })); }
        return;
      }

      let payload;
      try { payload = JSON.parse(raw); } catch {
        res.writeHead(400, headers);
        res.end(JSON.stringify({ ok: false, error: 'bad json' }));
        return;
      }

      const record = validateBeacon(payload, { ua: req.headers['user-agent'] || '' });
      if (!record) {
        res.writeHead(422, headers);
        res.end(JSON.stringify({ ok: false, error: 'no usable metrics' }));
        return;
      }

      // 204 keeps the response body empty — the browser is unloading and does
      // not care what we say, only that the request completed.
      const stored = appendBeacon(record);
      res.writeHead(stored ? 204 : 429, corsHeaders(req));
      res.end();
    },
  },
];
