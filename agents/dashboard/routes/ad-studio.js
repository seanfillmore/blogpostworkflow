// agents/dashboard/routes/ad-studio.js
//
// Read + judge endpoints for Ad Studio runs. No rendering is launched from here yet —
// screens 3 and 4 of the UI spec come first, because runs already work from the CLI and
// judging exists nowhere but a folder of JPEGs.
//
// The logic lives in ../lib/ad-studio-runs.js so it is testable without HTTP; these
// handlers are plumbing.

import { existsSync, createReadStream, statSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { listRuns, readRun, writeDecision } from '../lib/ad-studio-runs.js';
import { readJsonBody } from '../lib/responses.js';
import { ROOT } from '../lib/paths.js';

const RUNS_DIR = join(ROOT, 'data', 'creatives', 'ad-studio');

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Path traversal guard.
 *
 * Every segment of an image URL comes from the client, and this route reads files off disk
 * by name. A `..` in any of them walks out of data/creatives and this server can read
 * `.env`. Rejecting separators outright is stricter than normalising and cheaper to be
 * sure about — no legitimate run id, concept slug, variation or filename contains one.
 */
function safeSegment(seg) {
  const s = decodeURIComponent(String(seg || ''));
  if (!s || s === '.' || s === '..') return null;
  if (s.includes('/') || s.includes('\\') || s.includes('\0')) return null;
  return s;
}

export default [
  // GET /api/ad-studio/runs — the history screen
  {
    method: 'GET',
    match: '/api/ad-studio/runs',
    handler(req, res) {
      try {
        json(res, 200, { runs: listRuns(RUNS_DIR) });
      } catch (err) {
        json(res, 500, { error: err.message });
      }
    },
  },

  // GET /api/ad-studio/run/:runId — the judging screen's whole model
  //
  // `match` is a predicate, not a RegExp: lib/router.js calls `route.match(req.url)`, so a
  // RegExp here throws "match is not a function" on every request. There is no params
  // argument either — the handler parses the URL itself.
  {
    method: 'GET',
    match: (url) => /^\/api\/ad-studio\/run\/[^/]+$/.test(url.split('?')[0]),
    handler(req, res) {
      const runId = safeSegment(req.url.split('?')[0].split('/').pop());
      if (!runId) return json(res, 400, { error: 'bad run id' });
      try {
        const run = readRun(RUNS_DIR, runId);
        if (!run) return json(res, 404, { error: 'no such run' });
        json(res, 200, run);
      } catch (err) {
        json(res, 500, { error: err.message });
      }
    },
  },

  // GET /api/ad-studio/image/:runId/:concept/:variation/:file
  {
    method: 'GET',
    match: (url) => url.startsWith('/api/ad-studio/image/'),
    handler(req, res) {
      const rest = req.url.replace(/^\/api\/ad-studio\/image\//, '').split('?')[0];
      const parts = rest.split('/').map(safeSegment);
      if (parts.length !== 4 || parts.some(p => p === null)) {
        return json(res, 400, { error: 'bad image path' });
      }
      const file = join(RUNS_DIR, ...parts);
      // Belt and braces: even with per-segment checks, confirm the resolved path is still
      // inside the runs directory before opening it.
      if (!normalize(file).startsWith(normalize(RUNS_DIR))) {
        return json(res, 400, { error: 'bad image path' });
      }
      if (!existsSync(file) || !statSync(file).isFile()) {
        return json(res, 404, { error: 'not found' });
      }
      res.writeHead(200, {
        'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
        // Run output is immutable once written — a run id is a timestamp and a frame is
        // never rewritten in place — so the contact sheet can cache hard.
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      createReadStream(file).pipe(res);
    },
  },

  // POST /api/ad-studio/run/:runId/decide — keep / discard one frame
  {
    method: 'POST',
    match: (url) => /^\/api\/ad-studio\/run\/[^/]+\/decide$/.test(url.split('?')[0]),
    async handler(req, res) {
      const runId = safeSegment(req.url.split('?')[0].split('/')[4]);
      if (!runId) return json(res, 400, { error: 'bad run id' });
      const runDir = join(RUNS_DIR, runId);
      if (!existsSync(runDir)) return json(res, 404, { error: 'no such run' });

      let payload;
      try { payload = await readJsonBody(req); } catch { return json(res, 400, { error: 'bad JSON body' }); }
      const { key, keep, note } = payload || {};
      const parts = String(key || '').split('/');
      if (parts.length !== 3 || parts.some(p => !safeSegment(p))) {
        return json(res, 400, { error: 'bad frame key' });
      }

      try {
        // Whether this is an OVERRIDE is decided here, from the gate's own record — never
        // taken from the client. Keeping an accepted frame is routine; keeping a rejected
        // one is a deliberate disagreement with the gate and must be visible as one later.
        const run = readRun(RUNS_DIR, runId);
        let rejected = false;
        for (const c of run?.concepts || []) {
          for (const v of c.variations) {
            for (const t of v.targets) {
              if (t.key === key) rejected = t.outcome.state !== 'accepted';
            }
          }
        }
        const saved = writeDecision(runDir, key, { keep: Boolean(keep), override: Boolean(keep) && rejected, note });
        json(res, 200, { ok: true, decision: saved.decisions[key] });
      } catch (err) {
        json(res, 500, { error: err.message });
      }
    },
  },
];
