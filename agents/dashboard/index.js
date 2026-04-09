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

const args = process.argv.slice(2);
const PORT   = (() => { const i = args.indexOf('--port'); return i !== -1 ? parseInt(args[i+1], 10) : 4242; })();
const doOpen = args.includes('--open');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

// ── paths ── (constants imported from ./lib/paths.js) ──────────────────────────

const adsInFlight = new Set(); // concurrency guard: 'date/id' key

const GEMINI_MODELS = [
  { id: 'gemini-3.1-flash-image-preview', name: 'Gemini 3.1 Flash', maxReferenceImages: 16, resolutions: ['512', '1K', '2K', '4K'] },
  { id: 'gemini-3-pro-image-preview', name: 'Gemini 3 Pro', maxReferenceImages: 16, resolutions: ['1K', '2K', '4K'] },
  { id: 'gemini-2.5-flash-image', name: 'Gemini 2.5 Flash', maxReferenceImages: 10, resolutions: ['1K'] },
];

const geminiClient = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

const upload = multer({ dest: join(ROOT, 'data', '.uploads-tmp'), limits: { fileSize: 20 * 1024 * 1024 } });

function ensureDir(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }
[CREATIVE_TEMPLATES_DIR, CREATIVE_TEMPLATES_PREVIEWS_DIR, CREATIVE_SESSIONS_DIR, CREATIVES_DIR, REFERENCE_IMAGES_DIR].forEach(ensureDir);

const RUN_AGENT_ALLOWLIST = new Set([
  'agents/rank-tracker/index.js',
  'agents/content-gap/index.js',
  'agents/gsc-query-miner/index.js',
  'agents/sitemap-indexer/index.js',
  'agents/insight-aggregator/index.js',
  'agents/meta-ab-tracker/index.js',
  'agents/cro-analyzer/index.js',
  'agents/competitor-intelligence/index.js',
  'agents/ads-optimizer/index.js',
  'scripts/create-meta-test.js',
  'scripts/ads-weekly-recap.js',
  'agents/campaign-creator/index.js',
  'agents/campaign-analyzer/index.js',
  'agents/campaign-monitor/index.js',
  'agents/cro-deep-dive-content/index.js',
  'agents/cro-deep-dive-seo/index.js',
  'agents/cro-deep-dive-trust/index.js',
  'agents/content-researcher/index.js',
  'agents/content-strategist/index.js',
  'agents/pipeline-scheduler/index.js',
  'agents/cro-cta-injector/index.js',
]);

// ── calendar parsing ───────────────────────────────────────────────────────────

function kwToSlug(kw) {
  return kw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function parseCalendar() {
  // Prefer JSON; fall back to legacy markdown parse via calendar-store
  try {
    const calendarJsonPath = join(ROOT, 'data', 'calendar', 'calendar.json');
    if (existsSync(calendarJsonPath)) {
      const calendar = JSON.parse(readFileSync(calendarJsonPath, 'utf8'));
      return (calendar.items || [])
        .filter((i) => i.publish_date)
        .map((i) => ({
          week: i.week,
          publishDate: new Date(i.publish_date),
          category: i.category || '',
          keyword: i.keyword,
          title: i.title || '',
          kd: i.kd ?? 0,
          volume: i.volume ?? 0,
          contentType: i.content_type || '',
          priority: i.priority || '',
          slug: i.slug,
        }))
        .sort((a, b) => a.publishDate - b.publishDate);
    }
  } catch (err) {
    console.warn('[dashboard] calendar JSON parse failed:', err.message);
  }

  // Legacy markdown fallback
  if (!existsSync(CALENDAR_PATH)) return [];
  const md = readFileSync(CALENDAR_PATH, 'utf8');
  const rows = [];
  const re = /^\|\s*\*{0,2}(\d+)\*{0,2}\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm;
  for (const m of md.matchAll(re)) {
    const [, week, dateStr, category, keyword, title, kd, volume, contentType, priority] = m;
    const dm = dateStr.trim().match(/([A-Za-z]+)\s+(\d+),?\s+(\d{4})/);
    if (!dm) continue;
    const publishDate = new Date(`${dm[1]} ${dm[2]}, ${dm[3]} 08:00:00 GMT-0700`);
    rows.push({
      week: parseInt(week.trim(), 10),
      publishDate,
      category: category.trim(),
      keyword: keyword.trim(),
      title: title.trim(),
      kd: parseInt(kd.trim(), 10) || 0,
      volume: parseInt(volume.trim().replace(/,/g, ''), 10) || 0,
      contentType: contentType.trim(),
      priority: priority.trim(),
      slug: kwToSlug(keyword.trim()),
    });
  }
  return rows.sort((a, b) => a.publishDate - b.publishDate);
}

// ── pipeline status ────────────────────────────────────────────────────────────

function getPostMeta(slug) {
  const exact = join(POSTS_DIR, `${slug}.json`);
  if (existsSync(exact)) {
    try { return JSON.parse(readFileSync(exact, 'utf8')); } catch { return null; }
  }
  if (!existsSync(POSTS_DIR)) return null;
  for (const f of readdirSync(POSTS_DIR).filter(f => f.endsWith('.json'))) {
    try {
      const m = JSON.parse(readFileSync(join(POSTS_DIR, f), 'utf8'));
      if (m.target_keyword?.toLowerCase() === slug.replace(/-/g, ' ')) return m;
    } catch {}
  }
  return null;
}

function getItemStatus(item) {
  const meta = getPostMeta(item.slug);
  const hasBrief = existsSync(join(BRIEFS_DIR, `${item.slug}.json`));
  const hasHtml  = existsSync(join(POSTS_DIR, `${item.slug}.html`));
  if (meta?.shopify_status === 'published') return 'published';
  if (meta?.shopify_publish_at)             return 'scheduled';
  if (meta?.shopify_article_id)             return 'draft';
  if (hasHtml)                              return 'written';
  if (hasBrief)                             return 'briefed';
  return 'pending';
}

// ── editor reports ─────────────────────────────────────────────────────────────

function parseEditorReports() {
  const dir = join(REPORTS_DIR, 'editor');
  if (!existsSync(dir)) return {};
  const out = {};
  for (const f of readdirSync(dir).filter(f => f.endsWith('-editor-report.md'))) {
    const slug = f.replace('-editor-report.md', '');
    try {
      const txt = readFileSync(join(dir, f), 'utf8');
      out[slug] = {
        verdict:     /VERDICT:\s*Needs Work/i.test(txt) ? 'Needs Work' : 'Approved',
        brokenLinks: (txt.match(/\|\s*https?:\/\/[^|]+\|\s*[^|]*\|\s*404\s*\|/g) || []).length,
        generatedAt: statSync(join(dir, f)).mtime.toISOString(),
      };
    } catch {}
  }
  return out;
}

// ── rank snapshots ─────────────────────────────────────────────────────────────

function parseRankings() {
  const empty = { latestDate: null, previousDate: null, items: [], summary: { page1: 0, quickWins: 0, needsWork: 0, notRanking: 0 } };
  if (!existsSync(SNAPSHOTS_DIR)) return empty;

  const files = readdirSync(SNAPSHOTS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort().reverse();
  if (!files.length) return empty;

  const latest   = JSON.parse(readFileSync(join(SNAPSHOTS_DIR, files[0]), 'utf8'));
  const previous = files[1] ? JSON.parse(readFileSync(join(SNAPSHOTS_DIR, files[1]), 'utf8')) : null;

  const prevPostMap = {};
  for (const p of previous?.posts ?? []) prevPostMap[p.slug] = p.position;
  const prevKwMap = {};
  for (const p of previous?.allKeywords ?? []) prevKwMap[p.keyword] = p.position;

  const toItem = (p, prev, tracked) => {
    const change = (p.position != null && prev != null) ? prev - p.position : null;
    const tier   = !p.position       ? 'notRanking'
                 : p.position <= 10  ? 'page1'
                 : p.position <= 20  ? 'quickWins'
                 : 'needsWork';
    return { ...p, previousPosition: prev, change, tier, tracked };
  };

  const trackedItems = (latest.posts ?? []).map(p =>
    toItem(p, prevPostMap[p.slug] ?? null, true)
  );
  const allKwItems = (latest.allKeywords ?? []).map(p =>
    toItem(p, prevKwMap[p.keyword] ?? null, false)
  );

  const items = [...trackedItems, ...allKwItems].sort((a, b) => {
    if (a.position == null && b.position == null) return 0;
    if (a.position == null) return 1;
    if (b.position == null) return -1;
    return a.position - b.position;
  });

  const summary = items.reduce((acc, x) => { acc[x.tier]++; return acc; },
    { page1: 0, quickWins: 0, needsWork: 0, notRanking: 0 });

  return { latestDate: latest.date, previousDate: previous?.date ?? null, items, summary };
}

// ── CRO data ───────────────────────────────────────────────────────────────────

function parseCROData() {
  // Load up to 60 clarity snapshots (supports 30-day view + prior period comparison)
  let clarityAll = [];
  if (existsSync(CLARITY_SNAPSHOTS_DIR)) {
    const files = readdirSync(CLARITY_SNAPSHOTS_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(0, 60);
    clarityAll = files.map(f => JSON.parse(readFileSync(join(CLARITY_SNAPSHOTS_DIR, f), 'utf8')));
  }

  // Load up to 60 shopify snapshots
  let shopifyAll = [];
  if (existsSync(SHOPIFY_SNAPSHOTS_DIR)) {
    const files = readdirSync(SHOPIFY_SNAPSHOTS_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(0, 60);
    shopifyAll = files.map(f => JSON.parse(readFileSync(join(SHOPIFY_SNAPSHOTS_DIR, f), 'utf8')));
  }

  // Load most recent CRO brief
  let brief = null;
  if (existsSync(CRO_REPORTS_DIR)) {
    const files = readdirSync(CRO_REPORTS_DIR)
      .filter(f => f.endsWith('-cro-brief.md'))
      .sort().reverse();
    if (files[0]) {
      brief = {
        date: files[0].replace('-cro-brief.md', ''),
        content: readFileSync(join(CRO_REPORTS_DIR, files[0]), 'utf8'),
      };
    }
  }

  // Load up to 60 GSC snapshots
  let gscAll = [];
  if (existsSync(GSC_SNAPSHOTS_DIR)) {
    const files = readdirSync(GSC_SNAPSHOTS_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(0, 60);
    gscAll = files.map(f => JSON.parse(readFileSync(join(GSC_SNAPSHOTS_DIR, f), 'utf8')));
  }

  // Load up to 60 GA4 snapshots
  let ga4All = [];
  if (existsSync(GA4_SNAPSHOTS_DIR)) {
    const files = readdirSync(GA4_SNAPSHOTS_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(0, 60);
    ga4All = files.map(f => JSON.parse(readFileSync(join(GA4_SNAPSHOTS_DIR, f), 'utf8')));
  }

  // Load up to 60 Google Ads snapshots
  let googleAdsAll = [];
  if (existsSync(GOOGLE_ADS_SNAPSHOTS_DIR)) {
    const files = readdirSync(GOOGLE_ADS_SNAPSHOTS_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(0, 60);
    googleAdsAll = files.map(f => JSON.parse(readFileSync(join(GOOGLE_ADS_SNAPSHOTS_DIR, f), 'utf8')));
  }

  return { clarityAll, shopifyAll, gscAll, ga4All, brief, googleAdsAll };
}

// ── rejection helpers (server-side) ───────────────────────────────────────────

function loadRejections() {
  const p = join(ROOT, 'data', 'rejected-keywords.json');
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return []; }
}

function isRejectedKw(keyword, rejections) {
  const kw = keyword.toLowerCase();
  return rejections.some(r => {
    const term = r.keyword.toLowerCase();
    if (r.matchType === 'exact') return kwToSlug(keyword) === kwToSlug(r.keyword);
    return kw.includes(term);
  });
}

// ── ahrefs data readiness ──────────────────────────────────────────────────────

function checkAhrefsData(keyword) {
  const slug = kwToSlug(keyword);
  const dir  = join(AHREFS_DIR, slug);
  if (!existsSync(dir)) return { ready: false, slug, dir: `data/ahrefs/${slug}/`, hasSerp: false, hasKeywords: false, hasHistory: false };

  // Researcher auto-detects by CSV column headers, not filenames — so just count CSVs
  // and use common filename hints as a best-effort indicator per file type
  const files = readdirSync(dir).filter(f => f.endsWith('.csv')).map(f => f.toLowerCase());
  const hasSerp     = files.some(f => f.includes('serp') || f.includes('overview'));
  // matching_terms.csv or any csv with 'matching'/'terms'; keyword.csv alone is the history file
  const hasKeywords = files.some(f => f.includes('matching') || f.includes('terms'));
  // keyword.csv = volume history export; also accept 'volume' or 'history' in name
  const hasHistory  = files.some(f => f.includes('keyword') || f.includes('volume') || f.includes('history'));
  // Researcher requires serp + at least one keywords csv to produce a quality brief
  const ready       = hasSerp && hasKeywords;
  return { ready, slug, dir: `data/ahrefs/${slug}/`, hasSerp, hasKeywords, hasHistory };
}

function getPendingAhrefsData(calItems) {
  const pending = [];
  const rejections = loadRejections();
  for (const item of calItems) {
    const slug     = item.slug;
    const hasBrief = existsSync(join(BRIEFS_DIR, `${slug}.json`));
    const hasPost  = existsSync(join(POSTS_DIR,  `${slug}.html`));
    if (hasBrief || hasPost) continue; // already past research stage
    if (isRejectedKw(item.keyword, rejections)) continue; // rejected by user

    const status = checkAhrefsData(item.keyword);
    if (!status.ready) {
      const missing = [];
      if (!status.hasSerp)     missing.push('SERP Overview (required)');
      if (!status.hasKeywords) missing.push('Matching Terms (required)');
      if (!status.hasHistory)  missing.push('Volume History (optional)');
      pending.push({
        keyword:     item.keyword,
        slug,
        publishDate: item.publishDate.toISOString(),
        dir:         status.dir,
        missingFiles: missing,
        hasSerp:     status.hasSerp,
        hasKeywords: status.hasKeywords,
        hasHistory:  status.hasHistory,
      });
    }
  }
  return pending;
}

// ── tab chat context builder ────────────────────────────────────────────────

function buildTabChatSystemPrompt(tab) {
  const site = config.name || config.url || 'this site';
  const lines = [
    `You are an expert SEO and digital marketing advisor for ${site}.`,
    `The user is viewing the ${(tab || '').toUpperCase()} tab of their SEO dashboard.`,
    `Answer questions about the data shown, explain trends, and make recommendations.`,
    ``,
    `When you have a specific, concrete action to recommend, include exactly one ACTION_ITEM block at the very end of your response using this format:`,
    `<ACTION_ITEM>{"title": "Short action title", "description": "What should be done and why", "type": "action_type"}</ACTION_ITEM>`,
    `Only include ACTION_ITEM when you have a concrete recommendation the user can act on immediately. Omit it for general advice or clarification responses.`,
    `Keep responses concise (2-4 sentences unless the question requires more detail).`,
    ``,
  ];

  if (tab === 'seo') {
    const rankings = parseRankings();
    const top10 = rankings.items.slice(0, 10).map(r =>
      `${r.keyword || r.slug}: pos ${r.position != null ? r.position : 'unranked'}${r.change != null ? ' (' + (r.change > 0 ? '+' : '') + r.change + ')' : ''}`
    );
    lines.push('KEYWORD RANKINGS (latest):');
    lines.push(top10.length ? top10.join('\n') : 'No ranking data available.');
    const calendar = parseCalendar();
    if (calendar.length) {
      const byStatus = { published: [], scheduled: [], draft: [], written: [], briefed: [], pending: [] };
      for (const c of calendar) {
        const status = getItemStatus(c);
        (byStatus[status] || byStatus.pending).push(`${c.keyword} (${c.publishDate.toISOString().slice(0, 10)})`);
      }
      lines.push('', 'CONTENT PIPELINE STATUS:');
      if (byStatus.published.length) lines.push(`Published (${byStatus.published.length}): ${byStatus.published.join(', ')}`);
      if (byStatus.scheduled.length) lines.push(`Scheduled (${byStatus.scheduled.length}): ${byStatus.scheduled.join(', ')}`);
      if (byStatus.draft.length) lines.push(`Draft (${byStatus.draft.length}): ${byStatus.draft.join(', ')}`);
      if (byStatus.written.length) lines.push(`Written (${byStatus.written.length}): ${byStatus.written.join(', ')}`);
      if (byStatus.briefed.length) lines.push(`Briefed (${byStatus.briefed.length}): ${byStatus.briefed.join(', ')}`);
      if (byStatus.pending.length) lines.push(`Pending/not started (${byStatus.pending.length}): ${byStatus.pending.join(', ')}`);
    }
  } else if (tab === 'cro') {
    const cro = parseCROData();
    if (cro.brief) {
      lines.push('LATEST CRO BRIEF (excerpt):');
      lines.push(cro.brief.content.slice(0, 2000));
    } else {
      lines.push('No CRO brief available yet.');
    }
  } else if (tab === 'ads') {
    if (existsSync(ADS_OPTIMIZER_DIR)) {
      const adsFiles = readdirSync(ADS_OPTIMIZER_DIR)
        .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
      if (adsFiles.length) {
        const latest = JSON.parse(readFileSync(join(ADS_OPTIMIZER_DIR, adsFiles[0]), 'utf8'));
        const pending = (latest.suggestions || []).filter(s => s.status === 'pending');
        lines.push(`OPTIMIZATION QUEUE (${pending.length} pending suggestions):`);
        pending.slice(0, 10).forEach(s => {
          lines.push(`- [${s.type}] ${s.campaign || ''}${s.adGroup ? ' / ' + s.adGroup : ''}${s.keyword ? ' — ' + s.keyword : ''}: ${s.rationale || ''}`);
        });
        if (latest.analysisNotes) {
          lines.push('', 'ACCOUNT ANALYSIS:');
          lines.push(latest.analysisNotes.slice(0, 1000));
        }
      } else {
        lines.push('No ads optimization data yet.');
      }
    } else {
      lines.push('No Google Ads data available yet.');
    }
  } else if (tab === 'optimize') {
    if (existsSync(COMP_BRIEFS_DIR)) {
      const briefFiles = readdirSync(COMP_BRIEFS_DIR).filter(f => f.endsWith('.json')).sort().reverse().slice(0, 5);
      if (briefFiles.length) {
        lines.push('RECENT OPTIMIZATION BRIEFS:');
        briefFiles.forEach(f => {
          try {
            const b = JSON.parse(readFileSync(join(COMP_BRIEFS_DIR, f), 'utf8'));
            lines.push(`- ${b.url || f}: ${(b.proposed_changes || []).length} proposed changes`);
          } catch {}
        });
      } else {
        lines.push('No optimization briefs available yet.');
      }
    } else {
      lines.push('No optimization briefs available yet.');
    }
  }

  return lines.join('\n');
}

// ── aggregate ──────────────────────────────────────────────────────────────────

function aggregateData() {
  const calItems    = parseCalendar();
  const editorMap   = parseEditorReports();
  const rankings    = parseRankings();
  const rejections  = loadRejections();

  // Build lookup from keyword slug → calendar metadata
  const calMap = new Map(calItems.map(c => [c.slug, c]));

  // Start with all post files as the source of truth
  const seen = new Set();
  const seenKeywords = new Set();
  const pipelineItems = [];

  // Add calendar items first (in calendar order), skipping rejected keywords
  for (const item of calItems) {
    if (isRejectedKw(item.keyword, rejections)) continue;
    seen.add(item.slug);
    seenKeywords.add(item.keyword.toLowerCase());
    const meta = getPostMeta(item.slug);
    // Prefer the actual post's scheduled/published date over the stale calendar date
    const actualDate = meta?.shopify_publish_at || meta?.published_at || item.publishDate.toISOString();
    pipelineItems.push({
      keyword:     item.keyword,
      title:       item.title,
      slug:        item.slug,
      publishDate: actualDate,
      week:        item.week,
      priority:    item.priority,
      volume:      item.volume,
      kd:          item.kd,
      status:      getItemStatus(item),
    });
  }

  // Add posts that exist but aren't in the calendar
  if (existsSync(POSTS_DIR)) {
    const postFiles = readdirSync(POSTS_DIR).filter(f => f.endsWith('.json')).sort();
    for (const f of postFiles) {
      const slug = basename(f, '.json');
      if (seen.has(slug)) continue;
      try {
        const meta = JSON.parse(readFileSync(join(POSTS_DIR, f), 'utf8'));
        const kw = (meta.target_keyword || '').toLowerCase();
        if (kw && seenKeywords.has(kw)) continue;
        const status = meta.shopify_status === 'published' ? 'published'
                     : meta.shopify_publish_at             ? 'scheduled'
                     : meta.shopify_article_id             ? 'draft'
                     : existsSync(join(POSTS_DIR, `${slug}.html`)) ? 'written'
                     : existsSync(join(BRIEFS_DIR, `${slug}.json`)) ? 'briefed'
                     : 'pending';
        pipelineItems.push({
          keyword:     meta.target_keyword || slug.replace(/-/g, ' '),
          title:       meta.title || slug,
          slug,
          publishDate: meta.shopify_publish_at || meta.uploaded_at || null,
          week:        null,
          priority:    null,
          volume:      null,
          kd:          null,
          status,
        });
        seen.add(slug);
        if (kw) seenKeywords.add(kw);
      } catch {}
    }
  }

  // Sort: calendar items by publishDate first, then non-calendar by publishDate
  pipelineItems.sort((a, b) => {
    if (!a.publishDate && !b.publishDate) return 0;
    if (!a.publishDate) return 1;
    if (!b.publishDate) return -1;
    return new Date(a.publishDate) - new Date(b.publishDate);
  });

  const statusCounts = pipelineItems.reduce((acc, i) => {
    acc[i.status] = (acc[i.status] || 0) + 1; return acc;
  }, { pending: 0, briefed: 0, written: 0, draft: 0, scheduled: 0, published: 0 });

  const posts = [];
  if (existsSync(POSTS_DIR)) {
    for (const f of readdirSync(POSTS_DIR).filter(f => f.endsWith('.json'))) {
      try {
        const meta = JSON.parse(readFileSync(join(POSTS_DIR, f), 'utf8'));
        const slug = meta.slug || basename(f, '.json');
        const ed   = editorMap[slug];
        posts.push({
          slug,
          title:          meta.title,
          keyword:        meta.target_keyword,
          status:         meta.shopify_status || 'local',
          uploadedAt:     meta.uploaded_at    || null,
          publishAt:      meta.shopify_publish_at || null,
          shopifyUrl:     meta.shopify_url    || null,
          shopifyImageUrl:meta.shopify_image_url || null,
          editorVerdict:  ed?.verdict  ?? null,
          brokenLinks:    ed?.brokenLinks ?? 0,
          hasImage:       existsSync(join(IMAGES_DIR, `${slug}.webp`)) || existsSync(join(IMAGES_DIR, `${slug}.png`)),
        });
      } catch {}
    }
  }
  posts.sort((a, b) => {
    if (!a.uploadedAt && !b.uploadedAt) return 0;
    if (!a.uploadedAt) return 1;
    if (!b.uploadedAt) return -1;
    return new Date(b.uploadedAt) - new Date(a.uploadedAt);
  });

  const pendingAhrefsData = getPendingAhrefsData(calItems);

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const adsOptPath = join(ADS_OPTIMIZER_DIR, `${today}.json`);
  const adsOptimizationRaw = existsSync(adsOptPath)
    ? JSON.parse(readFileSync(adsOptPath, 'utf8'))
    : null;
  const adsOptimization = adsOptimizationRaw ? { ...adsOptimizationRaw, date: today } : null;

  // Ahrefs authority
  const ahrefsData = loadLatestAhrefsOverview(AHREFS_DIR);

  // Latest Ahrefs file
  let ahrefsFile = null;
  if (existsSync(AHREFS_DIR)) {
    const aFiles = readdirSync(AHREFS_DIR).filter(f => f.endsWith('.csv') || f.endsWith('.zip'));
    if (aFiles.length) {
      ahrefsFile = aFiles
        .map(f => ({ name: f, mtime: statSync(join(AHREFS_DIR, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)[0];
    }
  }

  // Rank alerts
  let rankAlert = null;
  if (existsSync(RANK_ALERTS_DIR)) {
    const alertFiles = readdirSync(RANK_ALERTS_DIR)
      .filter(f => f.endsWith('.md') && !f.startsWith('.'))
      .sort().reverse();
    if (alertFiles.length) {
      const latestAlert = alertFiles[0];
      const alertMtime  = statSync(join(RANK_ALERTS_DIR, latestAlert)).mtimeMs;
      const viewedMtime = existsSync(ALERTS_VIEWED) ? statSync(ALERTS_VIEWED).mtimeMs : 0;
      if (alertMtime > viewedMtime) {
        const content = readFileSync(join(RANK_ALERTS_DIR, latestAlert), 'utf8');
        const drops = (content.match(/🔻/g) || []).length;
        const gains = (content.match(/🚀/g) || []).length;
        rankAlert = { file: latestAlert, drops, gains, path: join(RANK_ALERTS_DIR, latestAlert) };
      }
    }
  }

  const metaTests = existsSync(META_TESTS_DIR)
    ? readdirSync(META_TESTS_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => { try { return JSON.parse(readFileSync(join(META_TESTS_DIR, f), 'utf8')); } catch { return null; } })
        .filter(Boolean)
    : [];

  // Load competitor briefs
  const briefs = [];
  if (existsSync(COMP_BRIEFS_DIR)) {
    for (const f of readdirSync(COMP_BRIEFS_DIR).filter(f => f.endsWith('.json'))) {
      try { briefs.push(JSON.parse(readFileSync(join(COMP_BRIEFS_DIR, f), 'utf8'))); } catch {}
    }
  }

  const cro = parseCROData();

  const contentGapFiles = existsSync(CONTENT_GAP_DIR)
    ? readdirSync(CONTENT_GAP_DIR)
        .filter(f => f.endsWith('.csv'))
        .map(f => { try { return { name: f, mtime: statSync(join(CONTENT_GAP_DIR, f)).mtimeMs }; } catch { return null; } })
        .filter(Boolean)
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  return {
    generatedAt: new Date().toISOString(),
    config:      { name: config.name, url: config.url || '' },
    pipeline:    { counts: statusCounts, items: pipelineItems },
    rankings,
    posts,
    pendingAhrefsData,
    cro,
    googleAdsAll: cro.googleAdsAll,
    adsOptimization,
    ahrefsData,
    ahrefsFile,
    rankAlert,
    metaTests,
    briefs,
    contentGapFiles,
  };
}

// ── HTML ───────────────────────────────────────────────────────────────────────


// ── Creatives session helpers ───────────────────────────────────────────────────

function saveSession(session) {
  session.updatedAt = new Date().toISOString();
  const filePath = join(CREATIVE_SESSIONS_DIR, session.id + '.json');
  writeFileSync(filePath, JSON.stringify(session, null, 2));
  return session;
}

function createSession() {
  const id = 'session-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const session = {
    id,
    name: 'New Session',
    nameAutoGenerated: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    model: GEMINI_MODELS[0].id,
    templateId: null,
    prompt: '',
    negativePrompt: '',
    aspectRatio: '1:1',
    referenceImages: [],
    versions: []
  };
  ensureDir(join(CREATIVES_DIR, id));
  return saveSession(session);
}

// ── HTTP server ────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (!checkAuth(req, res)) return;

  if (req.method === 'POST' && req.url === '/run-agent') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let script, args = [];
      try { ({ script, args = [] } = JSON.parse(body)); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        return;
      }
      if (!RUN_AGENT_ALLOWLIST.has(script)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Script not in allowlist' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      const child = spawn('node', [join(ROOT, script), ...args], { cwd: ROOT });
      const send = line => res.write(`data: ${line}\n\n`);
      child.stdout.on('data', d => String(d).split('\n').filter(Boolean).forEach(send));
      child.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => send(`[stderr] ${l}`)));
      child.on('close', code => { res.write(`data: __exit__:${JSON.stringify({ code })}\n\n`); res.end(); });
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/ahrefs-overview') {
    if (!checkAuth(req, res)) return;
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        return;
      }
      const { domainRating, backlinks, referringDomains, trafficValue } = payload;
      const csv = 'Domain Rating,Backlinks,Referring Domains,Organic Traffic Value\n' +
        [domainRating || '', backlinks || '', referringDomains || '', trafficValue || ''].join(',') + '\n';
      const date = new Date().toISOString().slice(0, 10);
      const filename = `overview-${date}.csv`;
      mkdirSync(AHREFS_DIR, { recursive: true });
      writeFileSync(join(AHREFS_DIR, filename), csv);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, filename }));
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/upload/ahrefs') {
    mkdirSync(AHREFS_DIR, { recursive: true });
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const rawName = req.headers['x-filename'] || 'ahrefs-upload.csv';
      const filename = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
      writeFileSync(join(AHREFS_DIR, filename), Buffer.concat(chunks));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, filename, saved_at: new Date().toISOString() }));
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/upload/rank-snapshot') {
    if (!checkAuth(req, res)) return;
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      const rawName = req.headers['x-filename'] || 'keywords.csv';
      const filename = rawName.replace(/[^a-zA-Z0-9._-]/g, '_');
      mkdirSync(KEYWORD_TRACKER_DIR, { recursive: true });
      writeFileSync(join(KEYWORD_TRACKER_DIR, filename), Buffer.concat(chunks));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, filename }));
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/upload/ahrefs-keyword-zip') {
    if (!checkAuth(req, res)) return;
    const slug = (req.headers['x-slug'] || '').replace(/[^a-z0-9-]/g, '');
    if (!slug) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Missing or invalid X-Slug header' }));
      return;
    }
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', async () => {
      const destDir = join(AHREFS_DIR, slug);
      const tmpZip  = join(destDir, '.upload.zip');
      try {
        mkdirSync(destDir, { recursive: true });
        writeFileSync(tmpZip, Buffer.concat(chunks));
        const extract = (await import('extract-zip')).default;
        await extract(tmpZip, { dir: destDir });
        const { unlinkSync, renameSync, rmdirSync } = await import('node:fs');
        unlinkSync(tmpZip);
        // Flatten single nested subdirectory (zip may contain a folder with the same name)
        const top = readdirSync(destDir).filter(f => !f.startsWith('.'));
        if (top.length === 1) {
          const sub = join(destDir, top[0]);
          if (statSync(sub).isDirectory()) {
            for (const f of readdirSync(sub)) renameSync(join(sub, f), join(destDir, f));
            rmdirSync(sub);
          }
        }
        const files = readdirSync(destDir).filter(f => !f.startsWith('.'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, slug, files }));
      } catch (err) {
        try { const { unlinkSync } = await import('node:fs'); unlinkSync(tmpZip); } catch {}
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/upload/content-gap-zip') {
    if (!checkAuth(req, res)) return;
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', async () => {
      const tmpZip = join(CONTENT_GAP_DIR, '.upload.zip');
      try {
        mkdirSync(CONTENT_GAP_DIR, { recursive: true });
        writeFileSync(tmpZip, Buffer.concat(chunks));
        const extract = (await import('extract-zip')).default;
        await extract(tmpZip, { dir: CONTENT_GAP_DIR });
        const { unlinkSync } = await import('node:fs');
        unlinkSync(tmpZip);
        const files = readdirSync(CONTENT_GAP_DIR).filter(f => f.endsWith('.csv'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, files }));
      } catch (err) {
        try { const { unlinkSync } = await import('node:fs'); unlinkSync(tmpZip); } catch {}
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/brief/')) {
    const parts = req.url.split('/'); // ['', 'brief', slug, 'change', id]
    const slug = parts[2], id = parts[4];
    if (!slug || !id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Missing slug or id' })); return; }
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let status;
      try { ({ status } = JSON.parse(body)); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' })); return; }
      if (!['approved', 'rejected'].includes(status)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'status must be approved or rejected' })); return; }
      const briefPath = join(COMP_BRIEFS_DIR, `${slug}.json`);
      if (!existsSync(briefPath)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Brief not found' })); return; }
      const brief = JSON.parse(readFileSync(briefPath, 'utf8'));
      const change = brief.proposed_changes?.find(c => c.id === id);
      if (!change) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Change not found' })); return; }
      change.status = status;
      writeFileSync(briefPath, JSON.stringify(brief, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, change }));
    });
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/apply/')) {
    const slug = req.url.slice('/apply/'.length);
    const briefPath = join(COMP_BRIEFS_DIR, `${slug}.json`);
    if (!existsSync(briefPath)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Brief not found' })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const child = spawn('node', [join(ROOT, 'agents', 'apply-optimization', 'index.js'), slug], { cwd: ROOT });
    child.stdout.on('data', d => {
      for (const line of String(d).split('\n').filter(Boolean)) {
        if (line.startsWith('DONE ')) {
          try { res.write(`event: done\ndata: ${JSON.stringify(JSON.parse(line.slice(5)))}\n\n`); }
          catch { res.write(`event: done\ndata: {}\n\n`); }
        } else {
          res.write(`data: ${line}\n\n`);
        }
      }
    });
    child.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => res.write(`data: [err] ${l}\n\n`)));
    child.on('close', () => res.end());
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/screenshot?')) {
    const urlObj = new URL(req.url, 'http://localhost');
    const imgPath = urlObj.searchParams.get('path');
    const resolved = join(ROOT, imgPath || '');
    if (!resolved.startsWith(COMP_SCREENSHOTS_DIR) || !existsSync(resolved)) {
      res.writeHead(404); res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(readFileSync(resolved));
    return;
  }

  // ── Google OAuth token renewal ────────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/google/auth') {
    if (!checkAuth(req, res)) return;
    const env = loadEnvAuth();
    const clientId = env.GOOGLE_CLIENT_ID;
    if (!clientId) { res.writeHead(500); res.end('GOOGLE_CLIENT_ID not set in .env'); return; }
    const host = req.headers.host || `localhost:${PORT}`;
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const redirectUri = `${proto}://${host}/api/google/callback`;
    const scopes = [
      'https://www.googleapis.com/auth/webmasters.readonly',
      'https://www.googleapis.com/auth/analytics.readonly',
      'https://www.googleapis.com/auth/adwords',
    ].join(' ');
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scopes)}&access_type=offline&prompt=consent`;
    res.writeHead(302, { Location: authUrl });
    res.end();
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/api/google/callback')) {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const code = urlObj.searchParams.get('code');
    const error = urlObj.searchParams.get('error');
    if (error) { res.writeHead(400, { 'Content-Type': 'text/html' }); res.end(`<h2>OAuth Error</h2><p>${error}</p><p><a href="/">Back to dashboard</a></p>`); return; }
    if (!code) { res.writeHead(400, { 'Content-Type': 'text/html' }); res.end('<h2>No authorization code</h2><p><a href="/">Back to dashboard</a></p>'); return; }

    const env = loadEnvAuth();
    const host = req.headers.host || `localhost:${PORT}`;
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const redirectUri = `${proto}://${host}/api/google/callback`;
    fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    }).then(function(tokenRes) {
      if (!tokenRes.ok) return tokenRes.text().then(function(text) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end('<h2>Token exchange failed</h2><pre>' + text + '</pre><p><a href="/">Back to dashboard</a></p>');
      });
      return tokenRes.json().then(function(tokens) {
        if (!tokens.refresh_token) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end('<h2>No refresh token returned</h2><p>Try revoking access at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a> and retry.</p><p><a href="/">Back to dashboard</a></p>');
          return;
        }
        var envPath = join(ROOT, '.env');
        var content = readFileSync(envPath, 'utf8');
        var regex = /^GOOGLE_REFRESH_TOKEN=.*/m;
        if (regex.test(content)) {
          content = content.replace(regex, 'GOOGLE_REFRESH_TOKEN=' + tokens.refresh_token);
        } else {
          content = content.trimEnd() + '\nGOOGLE_REFRESH_TOKEN=' + tokens.refresh_token + '\n';
        }
        writeFileSync(envPath, content);
        process.env.GOOGLE_REFRESH_TOKEN = tokens.refresh_token;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h2>Google token renewed successfully</h2><p>GSC + GA4 + Google Ads re-authorized.</p><p><a href="/">Back to dashboard</a></p>');
      });
    }).catch(function(err) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end('<h2>Error</h2><pre>' + err.message + '</pre><p><a href="/">Back to dashboard</a></p>');
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/google/status') {
    if (!checkAuth(req, res)) return;
    var env2 = loadEnvAuth();
    if (!env2.GOOGLE_REFRESH_TOKEN) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'missing', message: 'No refresh token configured' }));
      return;
    }
    fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env2.GOOGLE_CLIENT_ID,
        client_secret: env2.GOOGLE_CLIENT_SECRET,
        refresh_token: env2.GOOGLE_REFRESH_TOKEN,
        grant_type: 'refresh_token',
      }),
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.access_token) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'valid' }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'expired', message: data.error_description || 'Token expired or revoked' }));
      }
    }).catch(function(err) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/dismiss-alert') {
    mkdirSync(RANK_ALERTS_DIR, { recursive: true });
    writeFileSync(ALERTS_VIEWED, new Date().toISOString());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && req.url.startsWith('/images/')) {
    if (!checkAuth(req, res)) return;
    const slug = req.url.slice('/images/'.length).split('?')[0];
    if (!/^[a-z0-9-]+$/.test(slug)) { res.writeHead(400); res.end('Bad request'); return; }
    const webp = join(IMAGES_DIR, `${slug}.webp`);
    const png  = join(IMAGES_DIR, `${slug}.png`);
    const imgPath = existsSync(webp) ? webp : existsSync(png) ? png : null;
    if (!imgPath) { res.writeHead(404); res.end('Not found'); return; }
    const ct = imgPath.endsWith('.webp') ? 'image/webp' : 'image/png';
    res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=3600' });
    createReadStream(imgPath).on('error', () => { res.end(); }).pipe(res);
    return;
  }

  if (req.method === 'POST' && req.url === '/api/chat') {
    if (!checkAuth(req, res)) return;
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      const { tab, messages } = payload;
      if (!tab || !Array.isArray(messages)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'tab and messages required' }));
        return;
      }
      const VALID_TABS = new Set(['seo', 'cro', 'ads', 'optimize', 'ad-intelligence']);
      if (!VALID_TABS.has(tab)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid tab' }));
        return;
      }

      let systemPrompt;
      try { systemPrompt = buildTabChatSystemPrompt(tab); } catch (e) { systemPrompt = `You are an SEO advisor. Data for this tab could not be loaded (${e.message}).`; }
      const cappedMessages = messages.slice(-20).map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: String(m.content || '').slice(0, 4000),
      }));

      let response;
      try {
        response = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: systemPrompt,
          messages: cappedMessages,
        });
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        res.write(`data: Error contacting Claude: ${err.message.replace(/\n/g, '\\n')}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const fullText = (response.content.find(b => b.type === 'text') || {}).text || '';
      const actionMatch = fullText.match(/<ACTION_ITEM>([\s\S]*?)<\/ACTION_ITEM>/);
      const cleanText = fullText.replace(/<ACTION_ITEM>[\s\S]*?<\/ACTION_ITEM>/g, '').trim();

      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      if (cleanText) res.write(`data: ${cleanText.replace(/\n/g, '\\n')}\n\n`);
      if (actionMatch) {
        try {
          const actionJson = JSON.parse(actionMatch[1].trim());
          res.write(`data: ACTION_ITEM:${JSON.stringify(actionJson)}\n\n`);
        } catch { /* skip malformed ACTION_ITEM */ }
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/chat/action-item') {
    if (!checkAuth(req, res)) return;
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        return;
      }
      const { tab, title, description, type } = payload;
      if (!tab || !title) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'tab and title required' }));
        return;
      }

      if (tab === 'ads') {
        const today = new Date().toISOString().slice(0, 10);
        const filePath = join(ADS_OPTIMIZER_DIR, `${today}.json`);
        let fileData = { analysisNotes: '', suggestions: [] };
        if (existsSync(filePath)) {
          try { fileData = JSON.parse(readFileSync(filePath, 'utf8')); } catch {}
        } else {
          mkdirSync(ADS_OPTIMIZER_DIR, { recursive: true });
        }
        if (!Array.isArray(fileData.suggestions)) fileData.suggestions = [];
        const id = 'chat-' + Date.now();

        // For landing_page_update, extract URL and match campaign resource name from latest snapshot
        let proposedChange = undefined;
        if (type === 'landing_page_update') {
          const text = description || title || '';
          const urlMatch = text.match(/https?:\/\/[^\s,)]+/);
          const finalUrl = urlMatch ? urlMatch[0].replace(/[.,]+$/, '') : null;
          let campaignResourceName = null;
          try {
            const snapDir = join(ROOT, 'data', 'snapshots', 'google-ads');
            const snapFiles = readdirSync(snapDir).filter(f => f.endsWith('.json')).sort();
            if (snapFiles.length) {
              const snap = JSON.parse(readFileSync(join(snapDir, snapFiles[snapFiles.length - 1]), 'utf8'));
              const textLower = text.toLowerCase();
              const matched = (snap.campaigns || []).find(c => {
                const parts = c.name.toLowerCase().split(/[\s|]+/).filter(p => p.length > 3);
                return parts.filter(p => textLower.includes(p)).length >= 2;
              });
              if (matched) campaignResourceName = matched.resourceName;
            }
          } catch {}
          if (finalUrl || campaignResourceName) {
            proposedChange = {};
            if (finalUrl) proposedChange.finalUrl = finalUrl;
            if (campaignResourceName) proposedChange.campaignResourceName = campaignResourceName;
          }
        }

        fileData.suggestions.push({
          id,
          type: type || 'chat_action',
          status: 'pending',
          source: 'chat',
          rationale: description || title,
          campaign: proposedChange?.campaignResourceName || null,
          adGroup: null,
          ...(proposedChange ? { proposedChange } : {}),
        });
        try {
          writeFileSync(filePath, JSON.stringify(fileData, null, 2));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, id }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, message: 'Action noted' }));
      }
    });
    return;
  }

  if (req.url === '/api/data') {
    try {
      const data = aggregateData();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      res.end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/ads/') && req.url.endsWith('/chat') && req.url.includes('/suggestion/')) {
    const parts = req.url.split('/'); // ['', 'ads', date, 'suggestion', id, 'chat']
    const date = parts[2], id = parts[4];
    if (!date || !id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Missing date or id' })); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Invalid date' })); return; }

    const inFlightKey = `${date}/${id}`;
    if (adsInFlight.has(inFlightKey)) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Request already in progress' })); return; }
    adsInFlight.add(inFlightKey);

    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      const cleanup = () => adsInFlight.delete(inFlightKey);
      let payload;
      try { payload = JSON.parse(body); } catch { cleanup(); res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' })); return; }
      const message = (payload.message || '').trim();
      if (!message) { cleanup(); res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'message is required' })); return; }
      if (message.length > 2000) { cleanup(); res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'message exceeds 2000 characters' })); return; }

      const filePath = join(ADS_OPTIMIZER_DIR, `${date}.json`);
      if (!existsSync(filePath)) { cleanup(); res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Suggestion file not found' })); return; }
      const fileData = JSON.parse(readFileSync(filePath, 'utf8'));
      const suggestion = fileData.suggestions?.find(s => s.id === id);
      if (!suggestion) { cleanup(); res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Suggestion not found' })); return; }

      // Append user message to chat history
      if (!suggestion.chat) suggestion.chat = [];
      const now = () => new Date().toISOString();
      suggestion.chat.push({ role: 'user', content: message, ts: now() });

      // Reconstruct Anthropic SDK message array from chat history
      const messages = [];
      for (let i = 0; i < suggestion.chat.length; i++) {
        const entry = suggestion.chat[i];
        if (entry.role === 'user') {
          messages.push({ role: 'user', content: entry.content });
        } else if (entry.role === 'assistant') {
          const content = [{ type: 'text', text: entry.content }];
          // Merge adjacent tool_call into this assistant message
          if (i + 1 < suggestion.chat.length && suggestion.chat[i + 1].role === 'tool_call') {
            const tc = suggestion.chat[i + 1];
            content.push({ type: 'tool_use', id: tc.tool_use_id, name: tc.tool, input: tc.input });
            i++; // skip the tool_call entry
          }
          messages.push({ role: 'assistant', content });
        } else if (entry.role === 'tool_result') {
          messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: entry.tool_use_id, content: entry.content }] });
        }
        // tool_call entries are consumed above alongside their assistant message
      }

      // Build system prompt
      const micros = v => v != null ? `$${(v / 1000000).toFixed(2)} (${v} micros)` : null;
      const otherSuggestions = (fileData.suggestions || []).filter(s => s.id !== suggestion.id);
      const systemPrompt = [
        `You are an expert Google Ads advisor. The user is reviewing an optimization suggestion and may ask questions about it, about the broader campaign, or about Google Ads strategy in general. Answer all questions helpfully — do not refuse or redirect if the question goes beyond the single suggestion.`,
        ``,
        `THIS SUGGESTION:`,
        `Type: ${suggestion.type}`,
        `Campaign: ${suggestion.campaign || 'Unknown'}`,
        `Ad Group: ${suggestion.adGroup || 'Campaign-level'}`,
        suggestion.keyword      ? `Keyword: ${suggestion.keyword}` : null,
        suggestion.matchType    ? `Match Type: ${suggestion.matchType}` : null,
        `Confidence: ${suggestion.confidence || 'unset'}`,
        `Rationale: ${suggestion.rationale}`,
        suggestion.currentCpcMicros  != null ? `Current Max CPC: ${micros(suggestion.currentCpcMicros)}` : null,
        suggestion.proposedCpcMicros != null ? `Proposed Max CPC: ${micros(suggestion.proposedCpcMicros)}` : null,
        suggestion.suggestedCopy     ? `Suggested Copy: ${suggestion.suggestedCopy}` : null,
        suggestion.impressions       != null ? `Impressions: ${suggestion.impressions}` : null,
        suggestion.clicks            != null ? `Clicks: ${suggestion.clicks}` : null,
        suggestion.ctr               != null ? `CTR: ${(suggestion.ctr * 100).toFixed(2)}%` : null,
        suggestion.conversions       != null ? `Conversions: ${suggestion.conversions}` : null,
        suggestion.cvr               != null ? `CVR: ${(suggestion.cvr * 100).toFixed(2)}%` : null,
        suggestion.avgCpcMicros      != null ? `Avg CPC: ${micros(suggestion.avgCpcMicros)}` : null,
        suggestion.costMicros        != null ? `Cost: ${micros(suggestion.costMicros)}` : null,
        suggestion.ahrefsMetrics     ? `Ahrefs Metrics: ${JSON.stringify(suggestion.ahrefsMetrics)}` : null,
        otherSuggestions.length > 0  ? `\nOTHER PENDING SUGGESTIONS:\n${otherSuggestions.map(s => `- [${s.type}] ${s.campaign || ''}${s.adGroup ? ' / ' + s.adGroup : ''}${s.keyword ? ' — ' + s.keyword : ''}: ${s.rationale}`).join('\n')}` : null,
        fileData.analysisNotes       ? `\nACCOUNT ANALYSIS:\n${fileData.analysisNotes}` : null,
        ``,
        `INSTRUCTIONS:`,
        `- Use all data above when answering. Never say data is missing if it appears above.`,
        `- Answer general campaign questions using the account analysis and other suggestions as context.`,
        `- Only call approve_suggestion, reject_suggestion, or update_suggestion when the user has explicitly signalled a decision — never speculatively.`,
        `- For update_suggestion, only provide fields valid for this suggestion type (${suggestion.type}).`,
      ].filter(Boolean).join('\n');

      // Tool definitions
      const ALLOWED_UPDATE_FIELDS = {
        bid_adjust:    ['proposedCpcMicros'],
        keyword_add:   ['keyword', 'matchType'],
        negative_add:  ['keyword', 'matchType'],
        copy_rewrite:  ['suggestedCopy'],
        keyword_pause: [],
      };

      const tools = [
        {
          name: 'approve_suggestion',
          description: 'Approve the suggestion as-is, setting its status to approved.',
          input_schema: { type: 'object', properties: {}, required: [] },
        },
        {
          name: 'reject_suggestion',
          description: 'Reject the suggestion, setting its status to rejected.',
          input_schema: { type: 'object', properties: {}, required: [] },
        },
        {
          name: 'update_suggestion',
          description: 'Modify specific fields of the proposed change and approve the suggestion. Only provide fields valid for this suggestion type.',
          input_schema: {
            type: 'object',
            properties: {
              proposedCpcMicros: { type: 'integer', description: 'New max CPC in micros (bid_adjust only)' },
              keyword:           { type: 'string',  description: 'Keyword text (keyword_add / negative_add only)' },
              matchType:         { type: 'string',  enum: ['EXACT', 'PHRASE', 'BROAD'], description: 'Match type (keyword_add / negative_add only)' },
              suggestedCopy:     { type: 'string',  description: 'Replacement copy text (copy_rewrite only)' },
            },
            required: [],
          },
        },
      ];

      // First Claude call (non-streaming) to detect tool use
      let firstResponse;
      try {
        firstResponse = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          system: systemPrompt,
          messages,
          tools,
        });
      } catch (err) {
        cleanup();
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        res.write(`data: Error contacting Claude: ${err.message.replace(/\n/g, '\\n')}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // Extract text and tool use from first response
      const textBlock   = firstResponse.content.find(b => b.type === 'text');
      const toolBlock   = firstResponse.content.find(b => b.type === 'tool_use');
      let finalText     = textBlock?.text || '';
      let toolCallEntry = null;
      let toolResultEntry = null;

      if (toolBlock) {
        // Validate and execute tool
        const allowedFields = ALLOWED_UPDATE_FIELDS[suggestion.type] || [];
        let toolSummary = '';

        if (toolBlock.name === 'approve_suggestion') {
          suggestion.status = 'approved';
          toolSummary = 'status: approved';
        } else if (toolBlock.name === 'reject_suggestion') {
          suggestion.status = 'rejected';
          toolSummary = 'status: rejected';
        } else if (toolBlock.name === 'update_suggestion') {
          const input = toolBlock.input || {};
          const changes = [];
          for (const field of allowedFields) {
            if (input[field] !== undefined) {
              const oldVal = suggestion.proposedChange[field];
              suggestion.proposedChange[field] = input[field];
              changes.push(`${field}: ${oldVal} → ${input[field]}`);
            }
          }
          suggestion.status = 'approved';
          toolSummary = [...changes, 'status: approved'].join(' · ');
        }

        toolCallEntry   = { role: 'tool_call',   tool: toolBlock.name, tool_use_id: toolBlock.id, input: toolBlock.input, ts: now() };
        toolResultEntry = { role: 'tool_result', tool_use_id: toolBlock.id, content: toolSummary, ts: now() };

        // Second Claude call (streaming) to get narration after tool execution
        const messagesWithTool = [
          ...messages,
          { role: 'assistant', content: firstResponse.content },
          { role: 'user',      content: [{ type: 'tool_result', tool_use_id: toolBlock.id, content: toolSummary }] },
        ];

        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });

        try {
          const stream = anthropic.messages.stream({
            model: 'claude-sonnet-4-6',
            max_tokens: 512,
            system: systemPrompt,
            messages: messagesWithTool,
            tools,
          });
          finalText = '';
          for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
              const chunk = event.delta.text;
              finalText += chunk;
              res.write(`data: ${chunk.replace(/\n/g, '\\n')}\n\n`);
            }
          }
        } catch (err) {
          res.write(`data: Error: ${err.message.replace(/\n/g, '\\n')}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          cleanup();
          return;
        }
      } else {
        // No tool use — write first response text as a single SSE chunk
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
        if (finalText) res.write(`data: ${finalText.replace(/\n/g, '\\n')}\n\n`);
      }

      // Persist to chat history and write file
      if (finalText) suggestion.chat.push({ role: 'assistant', content: finalText, ts: now() });
      if (toolCallEntry)   suggestion.chat.push(toolCallEntry);
      if (toolResultEntry) suggestion.chat.push(toolResultEntry);

      try {
        writeFileSync(filePath, JSON.stringify(fileData, null, 2));
      } catch (err) {
        console.error('[chat] Failed to write suggestion file:', err.message);
      }

      res.write('data: [DONE]\n\n');
      res.end();
      cleanup();
    });
    return;
  }

  if (req.method === 'POST' && req.url.startsWith('/ads/') && req.url.includes('/suggestion/')) {
    const parts = req.url.split('/'); // ['', 'ads', date, 'suggestion', id]
    const date = parts[2], id = parts[4];
    if (!date || !id) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Missing date or id' })); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Invalid date' })); return; }
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' })); return; }
      const filePath = join(ADS_OPTIMIZER_DIR, `${date}.json`);
      if (!existsSync(filePath)) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Suggestion file not found' })); return; }
      const data = JSON.parse(readFileSync(filePath, 'utf8'));
      const suggestion = data.suggestions?.find(s => s.id === id);
      if (!suggestion) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Suggestion not found' })); return; }
      if (payload.status !== undefined) {
        if (!['approved', 'rejected'].includes(payload.status)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'status must be approved or rejected' })); return; }
        suggestion.status = payload.status;
      }
      if (payload.editedValue !== undefined) {
        if (typeof payload.editedValue !== 'string' || payload.editedValue.length > 200) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Invalid editedValue' })); return; }
        suggestion.editedValue = payload.editedValue;
      }
      writeFileSync(filePath, JSON.stringify(data, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, suggestion }));
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/apply-ads') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const child = spawn('node', [join(ROOT, 'agents', 'apply-ads-changes', 'index.js')], { cwd: ROOT });
    let doneSent = false;
    child.stdout.on('data', d => {
      for (const line of String(d).split('\n').filter(Boolean)) {
        if (line.startsWith('DONE ')) {
          try { res.write(`event: done\ndata: ${JSON.stringify(JSON.parse(line.slice(5)))}\n\n`); }
          catch { res.write('event: done\ndata: {}\n\n'); }
          doneSent = true;
        } else {
          res.write(`data: ${line}\n\n`);
        }
      }
    });
    child.stderr.on('data', d => String(d).split('\n').filter(Boolean).forEach(l => res.write(`data: [err] ${l}\n\n`)));
    child.on('close', () => { if (!doneSent) res.write('event: done\ndata: {}\n\n'); res.end(); });
    return;
  }

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

  // GET /api/campaigns
  if (req.method === 'GET' && req.url === '/api/campaigns') {
    const barrierFile = join(CAMPAIGN_PLANS_DIR, 'aov-barrier.json');
    const aovBarrier = existsSync(barrierFile) ? (() => { try { return JSON.parse(readFileSync(barrierFile, 'utf8')); } catch { return null; } })() : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ campaigns: readCampaigns(), aovBarrier }));
    return;
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

  // GET /api/meta-ads-insights
  if (req.method === 'GET' && req.url === '/api/meta-ads-insights') {
    if (!checkAuth(req, res)) return;
    if (!existsSync(META_ADS_INSIGHTS_DIR)) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ date: null, ads: [] })); return; }
    const files = readdirSync(META_ADS_INSIGHTS_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
    if (!files.length) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ date: null, ads: [] })); return; }
    try {
      const data = readFileSync(join(META_ADS_INSIGHTS_DIR, files[0]), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch { res.writeHead(500); res.end('{}'); }
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

  if (req.method === 'POST' && req.url === '/api/reject-keyword') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
        return;
      }
      const { keyword, matchType, reason } = payload;
      if (!keyword || !matchType) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'keyword and matchType are required' }));
        return;
      }
      try {
        const filePath = join(ROOT, 'data', 'rejected-keywords.json');
        const existing = existsSync(filePath)
          ? JSON.parse(readFileSync(filePath, 'utf8'))
          : [];
        existing.push({ keyword, matchType, reason: reason || null, rejectedAt: new Date().toISOString() });
        writeFileSync(filePath, JSON.stringify(existing, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
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
