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
];

const ctx = {
  ...paths,
  anthropic,
  adsInFlight,
  loadData,
  invalidateDataCache,
  runAgent,
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

  // ── Task 5: Template CRUD ─────────────────────────────────────────────────────

  // GET /api/creatives/templates
  if (req.method === 'GET' && req.url === '/api/creatives/templates') {
    try {
      const files = existsSync(CREATIVE_TEMPLATES_DIR)
        ? readdirSync(CREATIVE_TEMPLATES_DIR).filter(f => f.endsWith('.json'))
        : [];
      const templates = files.map(f => {
        try { return JSON.parse(readFileSync(join(CREATIVE_TEMPLATES_DIR, f), 'utf8')); }
        catch { return null; }
      }).filter(Boolean);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(templates));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Task 6: Create template from image (MUST be before /:id routes) ──────────

  // POST /api/creatives/templates/from-image
  if (req.method === 'POST' && req.url === '/api/creatives/templates/from-image') {
    upload.single('image')(req, res, async (err) => {
      if (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      if (!req.file) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'image file required' }));
        return;
      }
      try {
        const imageData = readFileSync(req.file.path);
        const base64Image = imageData.toString('base64');
        const mimeType = req.file.mimetype || 'image/jpeg';

        const client = new Anthropic();
        const message = await client.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mimeType, data: base64Image }
              },
              {
                type: 'text',
                text: 'Analyze this image and generate a creative ad template. Return a JSON object with these fields: name (string, descriptive template name), prompt (string, detailed image generation prompt describing the style, composition, and visual elements of this image), negativePrompt (string, what to avoid), aspectRatio (string, one of "1:1", "16:9", "9:16", "4:3"). Return ONLY valid JSON, no markdown fences.'
              }
            ]
          }]
        });

        let templateData;
        try {
          const text = message.content[0].text.trim();
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          templateData = JSON.parse(jsonMatch ? jsonMatch[0] : text);
        } catch {
          throw new Error('Failed to parse Claude response as JSON');
        }

        const id = 'tpl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        const ext = extname(req.file.originalname || '.jpg') || '.jpg';
        const previewFilename = id + ext;
        const previewPath = join(CREATIVE_TEMPLATES_PREVIEWS_DIR, previewFilename);
        copyFileSync(req.file.path, previewPath);
        try { unlinkSync(req.file.path); } catch {}

        const template = {
          id,
          name: templateData.name || 'Untitled Template',
          prompt: templateData.prompt || '',
          negativePrompt: templateData.negativePrompt || '',
          aspectRatio: templateData.aspectRatio || '1:1',
          previewImage: previewFilename,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        // Do NOT save to disk here — return the template object unsaved.
        // The client's "Save Template" button will POST to /api/creatives/templates to persist it.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(template));
      } catch (err2) {
        try { unlinkSync(req.file.path); } catch {}
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err2.message }));
      }
    });
    return;
  }

  // POST /api/creatives/templates
  if (req.method === 'POST' && req.url === '/api/creatives/templates') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      if (!data.id || !data.name || !data.prompt) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'id, name, and prompt are required' }));
        return;
      }
      try {
        const template = {
          ...data,
          createdAt: data.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        writeFileSync(join(CREATIVE_TEMPLATES_DIR, data.id + '.json'), JSON.stringify(template, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(template));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // PUT /api/creatives/templates/:id
  if (req.method === 'PUT' && /^\/api\/creatives\/templates\/[^/]+$/.test(req.url)) {
    const id = req.url.split('/').pop();
    const filePath = join(CREATIVE_TEMPLATES_DIR, id + '.json');
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let updates;
      try { updates = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      try {
        const existing = existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : { id };
        const template = { ...existing, ...updates, id, updatedAt: new Date().toISOString() };
        writeFileSync(filePath, JSON.stringify(template, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(template));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // DELETE /api/creatives/templates/:id
  if (req.method === 'DELETE' && /^\/api\/creatives\/templates\/[^/]+$/.test(req.url)) {
    const id = req.url.split('/').pop();
    const filePath = join(CREATIVE_TEMPLATES_DIR, id + '.json');
    try {
      let previewImage = null;
      if (existsSync(filePath)) {
        try { previewImage = JSON.parse(readFileSync(filePath, 'utf8')).previewImage; } catch {}
        unlinkSync(filePath);
      }
      if (previewImage) {
        const previewPath = join(CREATIVE_TEMPLATES_PREVIEWS_DIR, previewImage);
        if (existsSync(previewPath)) try { unlinkSync(previewPath); } catch {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── Task 7: Models, product images, reference images, image serving ───────────

  // GET /api/creatives/models
  if (req.method === 'GET' && req.url === '/api/creatives/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(GEMINI_MODELS));
    return;
  }

  // GET /api/creatives/product-images
  if (req.method === 'GET' && req.url === '/api/creatives/product-images') {
    try {
      if (!existsSync(PRODUCT_MANIFEST_PATH)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
        return;
      }
      const manifest = JSON.parse(readFileSync(PRODUCT_MANIFEST_PATH, 'utf8'));
      const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
      const result = manifest.map(product => {
        const dir = join(PRODUCT_IMAGES_DIR, product.imageDir || product.id || product.handle || '');
        let images = [];
        if (existsSync(dir)) {
          images = readdirSync(dir).filter(f => IMAGE_EXTS.has(extname(f).toLowerCase()));
        }
        return { ...product, images };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/creatives/reference-images
  if (req.method === 'GET' && req.url === '/api/creatives/reference-images') {
    try {
      const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
      const files = existsSync(REFERENCE_IMAGES_DIR)
        ? readdirSync(REFERENCE_IMAGES_DIR).filter(f => IMAGE_EXTS.has(extname(f).toLowerCase()))
        : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(files));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/creatives/reference-images
  if (req.method === 'POST' && req.url === '/api/creatives/reference-images') {
    upload.single('image')(req, res, (err) => {
      if (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      if (!req.file) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'image file required' }));
        return;
      }
      try {
        const ext = extname(req.file.originalname || '.jpg') || '.jpg';
        const filename = 'ref-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
        const destPath = join(REFERENCE_IMAGES_DIR, filename);
        renameSync(req.file.path, destPath);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ filename }));
      } catch (err2) {
        try { unlinkSync(req.file.path); } catch {}
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err2.message }));
      }
    });
    return;
  }

  // GET /api/creatives/product-image/*
  if (req.method === 'GET' && req.url.startsWith('/api/creatives/product-image/')) {
    const filePath = req.url.slice('/api/creatives/product-image/'.length).split('?')[0];
    const absPath = join(PRODUCT_IMAGES_DIR, filePath);
    if (!existsSync(absPath)) { res.writeHead(404); res.end('Not found'); return; }
    const ext2 = extname(absPath).toLowerCase();
    const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
    res.writeHead(200, { 'Content-Type': mimeMap[ext2] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
    createReadStream(absPath).on('error', () => { res.end(); }).pipe(res);
    return;
  }

  // GET /api/creatives/reference-image/:filename
  if (req.method === 'GET' && /^\/api\/creatives\/reference-image\/[^/]+$/.test(req.url)) {
    const filename = req.url.split('/').pop().split('?')[0];
    const absPath = join(REFERENCE_IMAGES_DIR, filename);
    if (!existsSync(absPath)) { res.writeHead(404); res.end('Not found'); return; }
    const ext2 = extname(absPath).toLowerCase();
    const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
    res.writeHead(200, { 'Content-Type': mimeMap[ext2] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
    createReadStream(absPath).on('error', () => { res.end(); }).pipe(res);
    return;
  }

  // GET /api/creatives/image/*
  if (req.method === 'GET' && req.url.startsWith('/api/creatives/image/')) {
    const filePath = req.url.slice('/api/creatives/image/'.length).split('?')[0];
    const absPath = join(CREATIVES_DIR, filePath);
    if (!existsSync(absPath)) { res.writeHead(404); res.end('Not found'); return; }
    const ext2 = extname(absPath).toLowerCase();
    const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
    const isDownload = req.url.includes('?download=1') || req.url.includes('&download=1');
    const headers = { 'Content-Type': mimeMap[ext2] || 'application/octet-stream' };
    if (isDownload) headers['Content-Disposition'] = 'attachment; filename="' + basename(absPath) + '"';
    else headers['Cache-Control'] = 'public, max-age=3600';
    res.writeHead(200, headers);
    createReadStream(absPath).on('error', () => { res.end(); }).pipe(res);
    return;
  }

  // GET /api/creatives/template-preview/:filename
  if (req.method === 'GET' && /^\/api\/creatives\/template-preview\/[^/]+$/.test(req.url)) {
    const filename = req.url.split('/').pop().split('?')[0];
    const absPath = join(CREATIVE_TEMPLATES_PREVIEWS_DIR, filename);
    if (!existsSync(absPath)) { res.writeHead(404); res.end('Not found'); return; }
    const ext2 = extname(absPath).toLowerCase();
    const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
    res.writeHead(200, { 'Content-Type': mimeMap[ext2] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600' });
    createReadStream(absPath).on('error', () => { res.end(); }).pipe(res);
    return;
  }

  // ── Task 8: Session CRUD ──────────────────────────────────────────────────────

  // GET /api/creatives/sessions
  if (req.method === 'GET' && req.url === '/api/creatives/sessions') {
    try {
      const files = existsSync(CREATIVE_SESSIONS_DIR)
        ? readdirSync(CREATIVE_SESSIONS_DIR).filter(f => f.endsWith('.json'))
        : [];
      const sessions = files.map(f => {
        try {
          const s = JSON.parse(readFileSync(join(CREATIVE_SESSIONS_DIR, f), 'utf8'));
          return { id: s.id, name: s.name, updatedAt: s.updatedAt, versionCount: (s.versions || []).length };
        } catch { return null; }
      }).filter(Boolean).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessions));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // POST /api/creatives/sessions (create new session)
  if (req.method === 'POST' && req.url === '/api/creatives/sessions') {
    try {
      mkdirSync(CREATIVE_SESSIONS_DIR, { recursive: true });
      const session = createSession();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(session));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // GET /api/creatives/sessions/:id
  if (req.method === 'GET' && /^\/api\/creatives\/sessions\/[^/]+$/.test(req.url)) {
    const id = req.url.split('/').pop();
    const filePath = join(CREATIVE_SESSIONS_DIR, id + '.json');
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(readFileSync(filePath, 'utf8'));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // PUT /api/creatives/sessions/:id
  if (req.method === 'PUT' && /^\/api\/creatives\/sessions\/[^/]+$/.test(req.url)) {
    const id = req.url.split('/').pop();
    const filePath = join(CREATIVE_SESSIONS_DIR, id + '.json');
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let updates;
      try { updates = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      try {
        const existing = existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : createSession();
        // Handle deleteVersion
        if (updates.deleteVersion !== undefined) {
          const delVer = parseInt(updates.deleteVersion, 10);
          const verObj = (existing.versions || []).find(v => v.version === delVer);
          existing.versions = (existing.versions || []).filter(v => v.version !== delVer);
          // Delete image file from disk
          if (verObj && verObj.imagePath) {
            const imgFile = join(CREATIVES_DIR, verObj.imagePath);
            if (existsSync(imgFile)) unlinkSync(imgFile);
          }
          delete updates.deleteVersion;
        }
        // Handle toggleFavorite
        if (updates.toggleFavorite !== undefined) {
          const toggleId = updates.toggleFavorite;
          (existing.versions || []).forEach(function(v) {
            if (v.id === toggleId || v.version === toggleId) v.favorite = !v.favorite;
          });
          delete updates.toggleFavorite;
        }
        const session = saveSession({ ...existing, ...updates, id });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(session));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }


  // POST /api/generate-creative
  if (req.method === 'POST' && req.url === '/api/generate-creative') {
    if (!checkAuth(req, res)) return;
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { adId, productImages = [] } = JSON.parse(body);
        if (!adId) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'adId required' })); return; }
        if (productImages.length > 3) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'max 3 product images' })); return; }
        for (const f of productImages) {
          if (!existsSync(join(PRODUCT_IMAGES_DIR_MA, f))) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: `Product image not found: ${f}` })); return; }
        }
        // Find pageId for the adId from latest insights
        let pageId = 'unknown';
        if (existsSync(META_ADS_INSIGHTS_DIR)) {
          const iFiles = readdirSync(META_ADS_INSIGHTS_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
          if (iFiles.length) {
            try {
              const ins = JSON.parse(readFileSync(join(META_ADS_INSIGHTS_DIR, iFiles[0]), 'utf8'));
              pageId = ins.ads.find(a => a.id === adId)?.pageId || 'unknown';
            } catch {}
          }
        }
        const jobId = `${pageId}-${Date.now()}`;
        mkdirSync(CREATIVE_JOBS_DIR, { recursive: true });
        writeFileSync(join(CREATIVE_JOBS_DIR, `${jobId}.json`), JSON.stringify({ status: 'pending', adId, productImages, createdAt: new Date().toISOString() }, null, 2));
        spawn('node', ['agents/creative-packager/index.js', '--job-id', jobId], { detached: true, stdio: 'ignore' }).unref();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jobId }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET /api/creative-packages/download/:jobId  ← MUST be registered before /:jobId
  // (otherwise "download" would be matched as the jobId parameter)
  if (req.method === 'GET' && req.url.startsWith('/api/creative-packages/download/')) {
    if (!checkAuth(req, res)) return;
    const jobId = req.url.slice('/api/creative-packages/download/'.length);
    const jobPath = join(CREATIVE_JOBS_DIR, `${jobId}.json`);
    if (!existsSync(jobPath)) { res.writeHead(404); res.end('Not found'); return; }
    try {
      const job = JSON.parse(readFileSync(jobPath, 'utf8'));
      const zipPath = job.zipPath;
      if (!zipPath || !existsSync(zipPath)) { res.writeHead(404); res.end('ZIP not found'); return; }
      const zipName = basename(zipPath);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${zipName}"` });
      import('node:fs').then(({ createReadStream }) => createReadStream(zipPath).pipe(res));
    } catch { res.writeHead(500); res.end('Error'); }
    return;
  }

  // GET /api/creative-packages/:jobId  (status polling)
  if (req.method === 'GET' && /^\/api\/creative-packages\/[^/]+$/.test(req.url)) {
    if (!checkAuth(req, res)) return;
    const jobId = req.url.split('/').pop();
    const jobPath = join(CREATIVE_JOBS_DIR, `${jobId}.json`);
    if (!existsSync(jobPath)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: 'Job not found', downloadUrl: null }));
      return;
    }
    try {
      const job = JSON.parse(readFileSync(jobPath, 'utf8'));
      const age = Date.now() - new Date(job.createdAt).getTime();
      if (age > 10 * 60 * 1000 && job.status !== 'complete') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', error: 'Job timed out', downloadUrl: null }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: job.status, downloadUrl: job.downloadUrl || null, error: job.error || null }));
    } catch { res.writeHead(500); res.end('{}'); }
    return;
  }

  // ── Task 9: POST /api/creatives/generate ─────────────────────────────────────

  if (req.method === 'POST' && req.url === '/api/creatives/generate') {
    upload.array('referenceImages', 20)(req, res, async (err) => {
      if (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      if (!geminiClient) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Gemini API key not configured' }));
        return;
      }
      try {
        const prompt = req.body.prompt || '';
        const negativePrompt = req.body.negativePrompt || '';
        const model = req.body.model || GEMINI_MODELS[0].id;
        const aspectRatio = req.body.aspectRatio || '1:1';
        const sessionId = req.body.sessionId || null;

        // Load or create session
        let session;
        if (sessionId) {
          const sessionPath = join(CREATIVE_SESSIONS_DIR, sessionId + '.json');
          session = existsSync(sessionPath)
            ? JSON.parse(readFileSync(sessionPath, 'utf8'))
            : createSession();
        } else {
          session = createSession();
        }

        // Build Gemini request parts
        const parts = [];

        // Add product images from PRODUCT_IMAGES_DIR
        let productImagePaths = [];
        try {
          const rawPaths = req.body.productImagePaths;
          if (rawPaths) {
            if (Array.isArray(rawPaths)) {
              productImagePaths = rawPaths;
            } else if (typeof rawPaths === 'string' && rawPaths.startsWith('[')) {
              productImagePaths = JSON.parse(rawPaths);
            } else if (typeof rawPaths === 'string') {
              productImagePaths = [rawPaths];
            }
          }
        } catch {}
        for (const relPath of productImagePaths) {
          const absPath = join(PRODUCT_IMAGES_DIR, relPath);
          if (existsSync(absPath)) {
            const imgData = readFileSync(absPath);
            const ext = extname(absPath).toLowerCase();
            const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
            const mimeType = mimeMap[ext] || 'image/jpeg';
            parts.push({ inlineData: { mimeType, data: imgData.toString('base64') } });
          }
        }

        // Add history images (previously generated images used as references)
        let historyImagePaths = [];
        try {
          if (req.body.historyImagePaths) {
            const rawHist = req.body.historyImagePaths;
            if (Array.isArray(rawHist)) {
              historyImagePaths = rawHist;
            } else {
              historyImagePaths = JSON.parse(rawHist);
            }
          }
        } catch {}
        for (const relPath of historyImagePaths) {
          const absPath = join(CREATIVES_DIR, relPath);
          if (existsSync(absPath)) {
            const imgData = readFileSync(absPath);
            const ext = extname(absPath).toLowerCase();
            const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
            const mimeType = mimeMap[ext] || 'image/jpeg';
            parts.push({ inlineData: { mimeType, data: imgData.toString('base64') } });
          }
        }

        // Add uploaded reference files
        for (const file of (req.files || [])) {
          const imgData = readFileSync(file.path);
          const mimeType = file.mimetype || 'image/jpeg';
          parts.push({ inlineData: { mimeType, data: imgData.toString('base64') } });
          try { unlinkSync(file.path); } catch {}
        }

        // Build full prompt text
        let fullPrompt = prompt;
        // Add aspect ratio instruction to prompt
        const arLabels = { '1:1': 'square (1:1)', '4:5': 'portrait (4:5)', '9:16': 'tall portrait (9:16)', '16:9': 'landscape (16:9)' };
        const arLabel = arLabels[aspectRatio];
        if (arLabel) fullPrompt += '\n\nIMPORTANT: Generate this image in ' + arLabel + ' aspect ratio.';
        if (negativePrompt) {
          fullPrompt += '\nDo NOT include: ' + negativePrompt;
        }
        parts.push({ text: fullPrompt });

        // Call Gemini
        const imageSize = req.body.imageSize || '1K';
        console.log('[Creatives] Generating — model:', model, 'aspectRatio:', aspectRatio, 'imageSize:', imageSize);
        const imageConfig = {};
        if (aspectRatio && aspectRatio !== 'custom') imageConfig.aspectRatio = aspectRatio;
        if (imageSize) imageConfig.imageSize = imageSize;
        const result = await geminiClient.models.generateContent({
          model,
          contents: [{ role: 'user', parts }],
          config: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig,
          },
        });
        console.log('[Creatives] Gemini response received, checking for image...');

        // Check for safety/policy rejection
        const candidate = result.candidates?.[0];
        if (!candidate) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No candidates returned — possible safety rejection' }));
          return;
        }
        if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'OTHER') {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Image generation blocked by safety policy', finishReason: candidate.finishReason }));
          return;
        }

        // Find the image part in the response
        const imagePart = candidate.content?.parts?.find(p => p.inlineData?.mimeType?.startsWith('image/'));
        if (!imagePart) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No image returned from Gemini' }));
          return;
        }

        // Derive extension from mimeType
        const mimeType = imagePart.inlineData.mimeType;
        const extMap = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
        const imgExt = extMap[mimeType] || '.png';

        // Save image to disk
        const maxVer = (session.versions || []).reduce((m, v) => Math.max(m, v.version || 0), 0);
        const versionNum = maxVer + 1;
        const imageFilename = `v${versionNum}${imgExt}`;
        const sessionDir = join(CREATIVES_DIR, session.id);
        ensureDir(sessionDir);
        const absImagePath = join(sessionDir, imageFilename);
        writeFileSync(absImagePath, Buffer.from(imagePart.inlineData.data, 'base64'));

        // Relative path for client
        const imagePath = session.id + '/' + imageFilename;

        // Add version to session
        const version = {
          version: versionNum,
          imagePath,
          prompt,
          negativePrompt,
          model,
          aspectRatio,
          createdAt: new Date().toISOString()
        };
        if (!session.versions) session.versions = [];
        session.versions.push(version);
        saveSession(session);

        // Auto-generate session name on first generation
        let sessionName = session.name;
        if (versionNum === 1 && session.nameAutoGenerated) {
          try {
            const nameMsg = await anthropic.messages.create({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 64,
              messages: [{
                role: 'user',
                content: 'Generate a short, descriptive session name (3-5 words, title case) for an image generation session with this prompt: ' + prompt + '\nReturn ONLY the name, nothing else.'
              }]
            });
            const generatedName = nameMsg.content[0]?.text?.trim() || session.name;
            session.name = generatedName;
            session.nameAutoGenerated = false;
            sessionName = generatedName;
            saveSession(session);
          } catch {}
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ imagePath, version: versionNum, sessionId: session.id, sessionName }));
      } catch (err2) {
        // Clean up any temp files from multer
        for (const file of (req.files || [])) {
          try { unlinkSync(file.path); } catch {}
        }
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err2.message }));
      }
    });
    return;
  }

  // ── Task 10: POST /api/creatives/refine ──────────────────────────────────────

  if (req.method === 'POST' && req.url === '/api/creatives/refine') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      if (!geminiClient) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Gemini API key not configured' }));
        return;
      }
      let payload;
      try { payload = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      const { sessionId, refinement, model } = payload;
      const version = parseInt(payload.version, 10);
      if (!sessionId || !version || !refinement) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'sessionId, version, and refinement are required' }));
        return;
      }
      try {
        // Load session
        const sessionPath = join(CREATIVE_SESSIONS_DIR, sessionId + '.json');
        if (!existsSync(sessionPath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session not found' }));
          return;
        }
        const session = JSON.parse(readFileSync(sessionPath, 'utf8'));

        // Find previous version
        const prevVersion = (session.versions || []).find(v => v.version === version);
        if (!prevVersion) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Version not found' }));
          return;
        }

        // Load previous image from disk
        const prevImagePath = join(CREATIVES_DIR, prevVersion.imagePath);
        if (!existsSync(prevImagePath)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Previous image not found on disk' }));
          return;
        }
        const prevImageData = readFileSync(prevImagePath);

        // Detect mime type from file extension
        const prevExt = extname(prevImagePath).toLowerCase();
        const mimeExtMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
        const prevMimeType = mimeExtMap[prevExt] || 'image/jpeg';

        const geminiModel = model || prevVersion.model || GEMINI_MODELS[0].id;

        // Send previous image + refinement text to Gemini
        console.log('[Creatives Refine] model:', geminiModel, 'version:', version, 'refinement:', refinement.slice(0, 80));
        const result = await geminiClient.models.generateContent({
          model: geminiModel,
          contents: [{
            role: 'user',
            parts: [
              { inlineData: { mimeType: prevMimeType, data: prevImageData.toString('base64') } },
              { text: 'Edit this image with the following changes: ' + refinement }
            ]
          }],
          config: {
            responseModalities: ['TEXT', 'IMAGE'],
            imageConfig: {},
          }
        });

        // Check for safety/policy rejection
        const candidate = result.candidates?.[0];
        if (!candidate) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No candidates returned — possible safety rejection' }));
          return;
        }
        if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'OTHER') {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Image refinement blocked by safety policy', finishReason: candidate.finishReason }));
          return;
        }

        // Find the image part
        const imagePart = candidate.content?.parts?.find(p => p.inlineData?.mimeType?.startsWith('image/'));
        if (!imagePart) {
          res.writeHead(422, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No image returned from Gemini' }));
          return;
        }

        // Save new image in original format from Gemini
        const newMimeType = imagePart.inlineData.mimeType;
        const newExtMap = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
        const newExt = newExtMap[newMimeType] || '.png';

        const maxVer = (session.versions || []).reduce((m, v) => Math.max(m, v.version || 0), 0);
        const newVersionNum = maxVer + 1;
        const newImageFilename = `v${newVersionNum}${newExt}`;
        const sessionDir = join(CREATIVES_DIR, session.id);
        ensureDir(sessionDir);
        const absImagePath = join(sessionDir, newImageFilename);
        writeFileSync(absImagePath, Buffer.from(imagePart.inlineData.data, 'base64'));

        const imagePath = session.id + '/' + newImageFilename;

        // Add new version to session with refinement field
        const newVersion = {
          version: newVersionNum,
          imagePath,
          prompt: prevVersion.prompt,
          negativePrompt: prevVersion.negativePrompt,
          refinement,
          model: geminiModel,
          aspectRatio: prevVersion.aspectRatio,
          basedOnVersion: version,
          createdAt: new Date().toISOString()
        };
        session.versions.push(newVersion);
        saveSession(session);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ imagePath, version: newVersionNum }));
      } catch (err2) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err2.message }));
      }
    });
    return;
  }

  // ── Task 11: Packaging endpoints ─────────────────────────────────────────────

  // POST /api/creatives/package
  if (req.method === 'POST' && req.url === '/api/creatives/package') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      try {
        const jobId = 'pkg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        ensureDir(CREATIVE_JOBS_DIR);
        const jobData = { ...payload, jobId, status: 'pending', createdAt: new Date().toISOString() };
        writeFileSync(join(CREATIVE_JOBS_DIR, jobId + '.json'), JSON.stringify(jobData, null, 2));
        spawn('node', [join(ROOT, 'agents/creative-packager/index.js'), '--job-id', jobId], {
          detached: true,
          stdio: 'ignore',
          cwd: ROOT
        }).unref();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jobId }));
      } catch (err2) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err2.message }));
      }
    });
    return;
  }

  // GET /api/creatives/package/download/:jobId  ← MUST be registered before /:jobId
  const packageDownloadMatch = req.url.match(/^\/api\/creatives\/package\/download\/([^/]+)$/);
  if (req.method === 'GET' && packageDownloadMatch) {
    const jobId = packageDownloadMatch[1];
    const jobPath = join(CREATIVE_JOBS_DIR, jobId + '.json');
    if (!existsSync(jobPath)) { res.writeHead(404); res.end('Not found'); return; }
    try {
      const job = JSON.parse(readFileSync(jobPath, 'utf8'));
      const zipPath = job.zipPath;
      if (!zipPath || !existsSync(zipPath)) { res.writeHead(404); res.end('ZIP not found'); return; }
      const zipName = basename(zipPath);
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${zipName}"` });
      createReadStream(zipPath).pipe(res);
    } catch { res.writeHead(500); res.end('Error'); }
    return;
  }

  // GET /api/creatives/package/:jobId  (status polling)
  const packagePollMatch = req.url.match(/^\/api\/creatives\/package\/([^/]+)$/);
  if (req.method === 'GET' && packagePollMatch) {
    const jobId = packagePollMatch[1];
    const jobPath = join(CREATIVE_JOBS_DIR, jobId + '.json');
    if (!existsSync(jobPath)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: 'Job not found', downloadUrl: null }));
      return;
    }
    try {
      const job = JSON.parse(readFileSync(jobPath, 'utf8'));
      const age = Date.now() - new Date(job.createdAt).getTime();
      if (age > 10 * 60 * 1000 && job.status !== 'complete') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', error: 'Job timed out', downloadUrl: null }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: job.status, downloadUrl: job.downloadUrl || null, error: job.error || null }));
    } catch { res.writeHead(500); res.end('{}'); }
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
