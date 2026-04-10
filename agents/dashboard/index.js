#!/usr/bin/env node
/**
 * SEO Dashboard
 *
 * Local web server that visualizes the content pipeline, keyword rankings,
 * published posts, and content calendar in a single-page dashboard.
 *
 * Usage:
 *   node agents/dashboard/index.js
 *   node agents/dashboard/index.js --port 4242
 *   node agents/dashboard/index.js --open
 */

import http from 'node:http';
import { readFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import multer from 'multer';
import { GoogleGenAI } from '@google/genai';

import { serveStatic } from './lib/static.js';
import { loadEnvAuth, hydrateProcessEnv } from './lib/env.js';
import { createAuthCheck } from './lib/auth.js';
import { ensureDir } from './lib/fs-helpers.js';
import { loadData, invalidateDataCache } from './lib/data-loader.js';
import { createRunAgentHandler } from './lib/run-agent.js';
import { dispatch } from './lib/router.js';
import * as paths from './lib/paths.js';

import dataRoutes from './routes/data.js';
import agentsRoutes from './routes/agents.js';
import miscRoutes from './routes/misc.js';
import uploadsRoutes from './routes/uploads.js';
import ahrefsRoutes from './routes/ahrefs.js';
import chatRoutes from './routes/chat.js';
import googleRoutes from './routes/google.js';
import metaAdsRoutes from './routes/meta-ads.js';
import adsRoutes from './routes/ads.js';
import creativesRoutes from './routes/creatives.js';
import campaignsRoutes from './routes/campaigns.js';
import indexingRoutes from './routes/indexing.js';
import performanceQueueRoutes from './routes/performance-queue.js';

const {
  ROOT, PUBLIC_DIR,
  CREATIVE_TEMPLATES_DIR, CREATIVE_TEMPLATES_PREVIEWS_DIR,
  CREATIVE_SESSIONS_DIR, CREATIVES_DIR, REFERENCE_IMAGES_DIR, CREATIVE_JOBS_DIR,
} = paths;

// ── bootstrap ──────────────────────────────────────────────────────────────────

const _authEnv = loadEnvAuth();
hydrateProcessEnv(_authEnv);

const checkAuth = createAuthCheck(_authEnv);
const anthropic = new Anthropic();
const runAgent = createRunAgentHandler(ROOT);
const geminiClient = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;
const upload = multer({ dest: join(ROOT, 'data', '.uploads-tmp'), limits: { fileSize: 20 * 1024 * 1024 } });

// Ensure per-session / per-template directories exist before serving.
[CREATIVE_TEMPLATES_DIR, CREATIVE_TEMPLATES_PREVIEWS_DIR, CREATIVE_SESSIONS_DIR, CREATIVES_DIR, REFERENCE_IMAGES_DIR].forEach(ensureDir);

// Clean up creative job files older than 7 days (once at startup).
if (existsSync(CREATIVE_JOBS_DIR)) {
  const cutoff = Date.now() - 7 * 86400 * 1000;
  for (const f of readdirSync(CREATIVE_JOBS_DIR).filter((n) => n.endsWith('.json'))) {
    try {
      const job = JSON.parse(readFileSync(join(CREATIVE_JOBS_DIR, f), 'utf8'));
      if (new Date(job.createdAt).getTime() < cutoff) unlinkSync(join(CREATIVE_JOBS_DIR, f));
    } catch { /* ignore */ }
  }
}

// ── CLI args ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const PORT = (() => { const i = args.indexOf('--port'); return i !== -1 ? parseInt(args[i + 1], 10) : 4242; })();
const BIND = args.includes('--public') ? '0.0.0.0' : '127.0.0.1';
const doOpen = args.includes('--open');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

// ── routes & context ───────────────────────────────────────────────────────────

const ROUTES = [
  ...dataRoutes,
  ...agentsRoutes,
  ...miscRoutes,
  ...uploadsRoutes,
  ...ahrefsRoutes,
  ...chatRoutes,
  ...googleRoutes,
  ...metaAdsRoutes,
  ...adsRoutes,
  ...creativesRoutes,
  ...campaignsRoutes,
  ...indexingRoutes,
  ...performanceQueueRoutes,
];

const adsInFlight = new Set(); // concurrency guard: 'date/id' key

const ctx = Object.freeze({
  ...paths,
  anthropic,
  adsInFlight,
  loadData,
  invalidateDataCache,
  runAgent,
  geminiClient,
  upload,
  ensureDir,
});

// ── HTTP server ────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (!checkAuth(req, res)) return;
  if (dispatch(ROUTES, req, res, ctx)) return;
  if (serveStatic(req, res, PUBLIC_DIR)) return;

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, BIND, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\nSEO Dashboard — ${config.name}`);
  console.log(`  ${url}`);
  console.log('  Auto-refreshes every 60m. Ctrl+C to stop.\n');

  if (doOpen) {
    import('node:child_process').then(({ execSync }) => {
      try { execSync(`open "${url}"`); } catch { /* ignore */ }
    });
  }
});
