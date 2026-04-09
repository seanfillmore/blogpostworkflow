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

import http from 'http';
import { spawn } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, createReadStream, unlinkSync, renameSync, copyFileSync } from 'fs';
import { join, basename, extname } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import multer from 'multer';
import { GoogleGenAI } from '@google/genai';
import { loadLatestAhrefsOverview } from '../../lib/ahrefs-parser.js';
import { serveStatic } from './lib/static.js';
import { loadEnvAuth, hydrateProcessEnv } from './lib/env.js';
import { createAuthCheck } from './lib/auth.js';
import { ensureDir, kwToSlug } from './lib/fs-helpers.js';
import { loadData, invalidateDataCache } from './lib/data-loader.js';
import { createRunAgentHandler } from './lib/run-agent.js';
import { buildTabChatSystemPrompt } from './lib/tab-chat-prompt.js';
import { GEMINI_MODELS, saveSession, createSession } from './lib/creatives-store.js';
import { dispatch } from './lib/router.js';
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
import * as paths from './lib/paths.js';
import {
  ROOT, POSTS_DIR, BRIEFS_DIR, IMAGES_DIR, REPORTS_DIR, SNAPSHOTS_DIR,
  KEYWORD_TRACKER_DIR, ADS_OPTIMIZER_DIR, CALENDAR_PATH,
  COMP_BRIEFS_DIR, COMP_SCREENSHOTS_DIR, META_ADS_INSIGHTS_DIR,
  CREATIVE_JOBS_DIR, CREATIVE_PACKAGES_DIR, PRODUCT_IMAGES_DIR_MA,
  CREATIVE_TEMPLATES_DIR, CREATIVE_TEMPLATES_PREVIEWS_DIR,
  CREATIVE_SESSIONS_DIR, CREATIVES_DIR, REFERENCE_IMAGES_DIR,
  PRODUCT_IMAGES_DIR, PRODUCT_MANIFEST_PATH,
  CLARITY_SNAPSHOTS_DIR, SHOPIFY_SNAPSHOTS_DIR, GSC_SNAPSHOTS_DIR,
  GA4_SNAPSHOTS_DIR, GOOGLE_ADS_SNAPSHOTS_DIR, CRO_REPORTS_DIR, META_TESTS_DIR,
  AHREFS_DIR, CONTENT_GAP_DIR, RANK_ALERTS_DIR, ALERTS_VIEWED,
  PUBLIC_DIR,
} from './lib/paths.js';

// ── basic auth ─────────────────────────────────────────────────────────────────
// Set DASHBOARD_USER and DASHBOARD_PASSWORD in .env to enable.
// If neither is set the dashboard is open (safe for local-only use).

const _authEnv = loadEnvAuth();
// Populate process.env from .env file for SDK integrations (e.g. Anthropic)
hydrateProcessEnv(_authEnv);
const anthropic = new Anthropic();
const checkAuth = createAuthCheck(_authEnv);
const runAgent = createRunAgentHandler(ROOT);

const args = process.argv.slice(2);
const PORT   = (() => { const i = args.indexOf('--port'); return i !== -1 ? parseInt(args[i+1], 10) : 4242; })();
const doOpen = args.includes('--open');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

// ── paths ── (constants imported from ./lib/paths.js) ──────────────────────────

const adsInFlight = new Set(); // concurrency guard: 'date/id' key


const geminiClient = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

const upload = multer({ dest: join(ROOT, 'data', '.uploads-tmp'), limits: { fileSize: 20 * 1024 * 1024 } });

[CREATIVE_TEMPLATES_DIR, CREATIVE_TEMPLATES_PREVIEWS_DIR, CREATIVE_SESSIONS_DIR, CREATIVES_DIR, REFERENCE_IMAGES_DIR].forEach(ensureDir);

// ── HTML ───────────────────────────────────────────────────────────────────────

// ── Router ─────────────────────────────────────────────────────────────────────

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
];

const ctx = {
  ...paths,
  anthropic,
  adsInFlight,
  loadData,
  invalidateDataCache,
  runAgent,
  geminiClient,
  upload,
  ensureDir,
};

// ── HTTP server ────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (!checkAuth(req, res)) return;
  if (dispatch(ROUTES, req, res, ctx)) return;

  // ── Campaign API ──────────────────────────────────────────────────────────────

  const CAMPAIGN_PLANS_DIR = join(ROOT, 'data', 'campaigns');

  function readCampaigns() {
    if (!existsSync(CAMPAIGN_PLANS_DIR)) return [];
    return readdirSync(CAMPAIGN_PLANS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => { try { return JSON.parse(readFileSync(join(CAMPAIGN_PLANS_DIR, f), 'utf8')); } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  }

  // GET /api/campaigns/:id
  if (req.method === 'GET' && /^\/api\/campaigns\/[\w-]+$/.test(req.url)) {
    const id = req.url.split('/')[3];
    const file = join(CAMPAIGN_PLANS_DIR, `${id}.json`);
    if (!existsSync(file)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(readFileSync(file, 'utf8'));
    return;
  }

  // POST /api/campaigns/:id/approve
  if (req.method === 'POST' && /^\/api\/campaigns\/[\w-]+\/approve$/.test(req.url)) {
    const id = req.url.split('/')[3];
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { approvedBudget } = JSON.parse(body);
        if (!approvedBudget || approvedBudget <= 0) throw new Error('approvedBudget must be a positive number');
        const file = join(CAMPAIGN_PLANS_DIR, `${id}.json`);
        if (!existsSync(file)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Not found' })); return; }
        const campaign = JSON.parse(readFileSync(file, 'utf8'));
        campaign.proposal.approvedBudget = approvedBudget;
        campaign.status = 'approved';
        writeFileSync(file, JSON.stringify(campaign, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/campaigns/:id/dismiss
  if (req.method === 'POST' && /^\/api\/campaigns\/[\w-]+\/dismiss$/.test(req.url)) {
    const id = req.url.split('/')[3];
    const file = join(CAMPAIGN_PLANS_DIR, `${id}.json`);
    if (!existsSync(file)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Not found' })); return; }
    const campaign = JSON.parse(readFileSync(file, 'utf8'));
    campaign.status = 'dismissed';
    writeFileSync(file, JSON.stringify(campaign, null, 2));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /api/campaigns/:id/clarify
  if (req.method === 'POST' && /^\/api\/campaigns\/[\w-]+\/clarify$/.test(req.url)) {
    const id = req.url.split('/')[3];
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { clarificationResponse } = JSON.parse(body);
        if (typeof clarificationResponse !== 'string' || !clarificationResponse.trim()) throw new Error('clarificationResponse must be a non-empty string');
        const file = join(CAMPAIGN_PLANS_DIR, `${id}.json`);
        if (!existsSync(file)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Not found' })); return; }
        const campaign = JSON.parse(readFileSync(file, 'utf8'));
        campaign.clarificationResponse = clarificationResponse.trim();
        writeFileSync(file, JSON.stringify(campaign, null, 2));
        // Spawn re-analysis (non-blocking)
        spawn('node', [join(ROOT, 'agents/campaign-analyzer/index.js'), '--campaign', id], { cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  // POST /api/campaigns/:id/alerts/:type/resolve
  if (req.method === 'POST' && /^\/api\/campaigns\/[\w-]+\/alerts\/[\w_]+\/resolve$/.test(req.url)) {
    const parts = req.url.split('/');
    const id = parts[3];
    const alertType = parts[5];
    const file = join(CAMPAIGN_PLANS_DIR, `${id}.json`);
    if (!existsSync(file)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Not found' })); return; }
    const campaign = JSON.parse(readFileSync(file, 'utf8'));
    const alert = campaign.alerts.find(a => a.type === alertType && !a.resolved);
    if (alert) { alert.resolved = true; writeFileSync(file, JSON.stringify(campaign, null, 2)); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }


  // Static assets from agents/dashboard/public/
  if (serveStatic(req, res, PUBLIC_DIR)) return;

  // unknown route
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// Clean up creative job files older than 7 days
if (existsSync(CREATIVE_JOBS_DIR)) {
  const cutoff = Date.now() - 7 * 86400 * 1000;
  for (const f of readdirSync(CREATIVE_JOBS_DIR).filter(f => f.endsWith('.json'))) {
    try {
      const job = JSON.parse(readFileSync(join(CREATIVE_JOBS_DIR, f), 'utf8'));
      if (new Date(job.createdAt).getTime() < cutoff) {
        import('node:fs').then(({ unlinkSync }) => unlinkSync(join(CREATIVE_JOBS_DIR, f))).catch(() => {});
      }
    } catch {}
  }
}

const BIND = args.includes('--public') ? '0.0.0.0' : '127.0.0.1';
server.listen(PORT, BIND, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\nSEO Dashboard — ${config.name}`);
  console.log(`  ${url}`);
  console.log('  Auto-refreshes every 60m. Ctrl+C to stop.\n');

  if (doOpen) {
    import('child_process').then(({ execSync }) => {
      try { execSync(`open "${url}"`); } catch {}
    });
  }
});
