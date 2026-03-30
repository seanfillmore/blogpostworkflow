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
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, createReadStream } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { loadLatestAhrefsOverview } from '../../lib/ahrefs-parser.js';

// ── basic auth ─────────────────────────────────────────────────────────────────
// Set DASHBOARD_USER and DASHBOARD_PASSWORD in .env to enable.
// If neither is set the dashboard is open (safe for local-only use).

function loadEnvAuth() {
  try {
    const lines = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env'), 'utf8').split('\n');
    const e = {};
    for (const l of lines) {
      const t = l.trim(); if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('='); if (i === -1) continue;
      e[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
    return e;
  } catch { return {}; }
}

const _authEnv  = loadEnvAuth();
// Populate process.env from .env file for SDK integrations (e.g. Anthropic)
for (const [k, v] of Object.entries(_authEnv)) { if (!process.env[k]) process.env[k] = v; }
const anthropic = new Anthropic();
const AUTH_USER = _authEnv.DASHBOARD_USER || '';
const AUTH_PASS = _authEnv.DASHBOARD_PASSWORD || '';
const AUTH_REQUIRED = AUTH_USER && AUTH_PASS;
const AUTH_TOKEN = AUTH_REQUIRED
  ? 'Basic ' + Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64')
  : null;

function checkAuth(req, res) {
  if (!AUTH_REQUIRED) return true;
  if (req.headers['authorization'] === AUTH_TOKEN) return true;
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="SEO Dashboard"', 'Content-Type': 'text/plain' });
  res.end('Unauthorized');
  return false;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const args = process.argv.slice(2);
const PORT   = (() => { const i = args.indexOf('--port'); return i !== -1 ? parseInt(args[i+1], 10) : 4242; })();
const doOpen = args.includes('--open');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

// ── paths ──────────────────────────────────────────────────────────────────────

const POSTS_DIR     = join(ROOT, 'data', 'posts');
const BRIEFS_DIR    = join(ROOT, 'data', 'briefs');
const IMAGES_DIR    = join(ROOT, 'data', 'images');
const REPORTS_DIR   = join(ROOT, 'data', 'reports');
const SNAPSHOTS_DIR = join(ROOT, 'data', 'rank-snapshots');
const KEYWORD_TRACKER_DIR = join(ROOT, 'data', 'keyword-tracker');
const ADS_OPTIMIZER_DIR = join(ROOT, 'data', 'ads-optimizer');
const adsInFlight = new Set(); // concurrency guard: 'date/id' key
const CALENDAR_PATH = join(REPORTS_DIR, 'content-strategist', 'content-calendar.md');

const COMP_BRIEFS_DIR      = join(ROOT, 'data', 'competitor-intelligence', 'briefs');
const COMP_SCREENSHOTS_DIR = join(ROOT, 'data', 'competitor-intelligence', 'screenshots');
const META_ADS_INSIGHTS_DIR = join(ROOT, 'data', 'meta-ads-insights');
const CREATIVE_JOBS_DIR      = join(ROOT, 'data', 'creative-jobs');
const CREATIVE_PACKAGES_DIR  = join(ROOT, 'data', 'creative-packages');
const PRODUCT_IMAGES_DIR_MA  = join(ROOT, 'data', 'product-images');

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

]);

// ── calendar parsing ───────────────────────────────────────────────────────────

function kwToSlug(kw) {
  return kw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function parseCalendar() {
  if (!existsSync(CALENDAR_PATH)) return [];
  const md = readFileSync(CALENDAR_PATH, 'utf8');
  const rows = [];
  const re = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm;
  for (const m of md.matchAll(re)) {
    const [, week, dateStr, category, keyword, title, kd, volume, contentType, priority] = m;
    if (week.trim() === 'Week' || week.trim() === '---') continue;
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

const CLARITY_SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'clarity');
const SHOPIFY_SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'shopify');
const GSC_SNAPSHOTS_DIR     = join(ROOT, 'data', 'snapshots', 'gsc');
const GA4_SNAPSHOTS_DIR     = join(ROOT, 'data', 'snapshots', 'ga4');
const GOOGLE_ADS_SNAPSHOTS_DIR = join(ROOT, 'data', 'snapshots', 'google-ads');
const CRO_REPORTS_DIR       = join(ROOT, 'data', 'reports', 'cro');
const META_TESTS_DIR        = join(ROOT, 'data', 'meta-tests');

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

// ── ahrefs data readiness ──────────────────────────────────────────────────────

const AHREFS_DIR      = join(ROOT, 'data', 'ahrefs');
const CONTENT_GAP_DIR = join(ROOT, 'data', 'content_gap');
const RANK_ALERTS_DIR = join(ROOT, 'data', 'reports', 'rank-alerts');
const ALERTS_VIEWED   = join(RANK_ALERTS_DIR, '.last-viewed');

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
  for (const item of calItems) {
    const slug     = item.slug;
    const hasBrief = existsSync(join(BRIEFS_DIR, `${slug}.json`));
    const hasPost  = existsSync(join(POSTS_DIR,  `${slug}.html`));
    if (hasBrief || hasPost) continue; // already past research stage

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

  // Build lookup from keyword slug → calendar metadata
  const calMap = new Map(calItems.map(c => [c.slug, c]));

  // Start with all post files as the source of truth
  const seen = new Set();
  const seenKeywords = new Set();
  const pipelineItems = [];

  // Add calendar items first (in calendar order)
  for (const item of calItems) {
    seen.add(item.slug);
    seenKeywords.add(item.keyword.toLowerCase());
    pipelineItems.push({
      keyword:     item.keyword,
      title:       item.title,
      slug:        item.slug,
      publishDate: item.publishDate.toISOString(),
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

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<title>SEO Dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:      #f8fafc;
    --surface: #ffffff;
    --border:  #e2e8f0;
    --text:    #0f172a;
    --muted:   #94a3b8;
    --green:   #10b981;
    --amber:   #f59e0b;
    --red:     #ef4444;
    --purple:  #8b5cf6;
    --sky:     #38bdf8;
    --orange:  #fb923c;
    --indigo:  #6366f1;
    --teal:    #0891b2;
    --radius:  10px;
    --shadow:  0 1px 3px rgba(0,0,0,.06), 0 4px 12px rgba(0,0,0,.04);
  }
  body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: var(--bg); color: var(--text); font-size: 14px; line-height: 1.5; }

  /* ── hero header ── */
  .hero { background: linear-gradient(135deg, #1e1b4b 0%, #312e81 60%, #4338ca 100%); padding: 14px 24px 16px; position: sticky; top: 0; z-index: 10; }
  .hero-top { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .hero-logo { width: 28px; height: 28px; border-radius: 8px; background: rgba(255,255,255,.15); display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 800; color: white; flex-shrink: 0; }
  .hero-name { color: white; font-size: 13px; font-weight: 700; line-height: 1.2; }
  .hero-url  { color: rgba(255,255,255,.4); font-size: 10px; }
  .tab-pills { display: flex; gap: 2px; background: rgba(0,0,0,.2); border-radius: 999px; padding: 3px; margin-left: 12px; }
  .tab-pill  { padding: 4px 14px; font-size: 11px; font-weight: 600; color: rgba(255,255,255,.55); background: none; border: none; border-radius: 999px; cursor: pointer; transition: all .15s; }
  .tab-pill.active { background: white; color: #312e81; }
  .hero-meta { margin-left: auto; color: rgba(255,255,255,.4); font-size: 11px; }
  .hero-kpis { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
  .hero-kpi  { background: rgba(255,255,255,.10); border: 1px solid rgba(255,255,255,.08); border-radius: 8px; padding: 10px 12px; }
  .hero-kpi-value { font-size: 20px; font-weight: 800; line-height: 1; color: white; }
  .hero-kpi-label { font-size: 9px; color: rgba(255,255,255,.45); margin-top: 3px; font-weight: 500; letter-spacing: .04em; text-transform: uppercase; }
  .refresh-btn { padding: 4px 12px; border-radius: 6px; border: 1px solid rgba(255,255,255,.2); background: rgba(255,255,255,.1); cursor: pointer; font-size: 12px; color: rgba(255,255,255,.7); font-family: inherit; transition: all .15s; }
  .refresh-btn:hover { background: rgba(255,255,255,.2); color: white; }

  /* ── layout ── */
  main { max-width: 1400px; margin: 0 auto; padding: 24px; display: grid; gap: 20px; }

  /* ── cards ── */
  .card { background: var(--surface); border-radius: var(--radius); box-shadow: var(--shadow); border: 1px solid var(--border); }
  .card-header { padding: 14px 18px 10px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
  .card-header-right { display: flex; align-items: center; gap: 8px; }
  .upload-btn { padding: 3px 10px; background: var(--surface); border: 1px solid var(--border); border-radius: 5px; cursor: pointer; font-size: 0.78rem; color: var(--muted); white-space: nowrap; }
  .upload-btn:hover { background: var(--indigo); color: white; border-color: var(--indigo); }
  .card-header h2 { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); }
  .card-header.accent-green  { border-left: 3px solid var(--green); }
  .card-header.accent-sky    { border-left: 3px solid var(--sky); }
  .card-header.accent-purple { border-left: 3px solid var(--purple); }
  .card-header.accent-orange { border-left: 3px solid var(--orange); }
  .card-header.accent-amber  { border-left: 3px solid var(--amber); }
  .card-header.accent-indigo { border-left: 3px solid var(--indigo); }
  .card-body { padding: 16px 18px; }

  /* ── pipeline kanban ── */
  .kanban { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; }
  .kanban-col { border-radius: 8px; border: 1px solid var(--border); overflow: hidden; }
  .kanban-head { padding: 8px 12px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; display: flex; align-items: center; justify-content: space-between; }
  .kanban-count { font-size: 22px; font-weight: 800; padding: 4px 12px 8px; }
  .kanban-items { padding: 0 8px 8px; display: grid; gap: 4px; max-height: 220px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: #d1d5db transparent; }
  .kanban-item { font-size: 11px; padding: 5px 7px; border-radius: 5px; line-height: 1.35; }
  .kanban-item .kw  { font-weight: 500; }
  .kanban-item .vol { color: var(--muted); font-size: 10px; }
  .kanban-item .pub-date-scheduled { color: var(--red);   font-size: 10px; font-weight: 600; }
  .kanban-item .pub-date-published  { color: var(--green); font-size: 10px; font-weight: 600; }
  .col-published .kanban-head { background: #f0fdf4; color: var(--green); }
  .col-published .kanban-item { background: #f0fdf4; }
  .col-scheduled .kanban-head { background: #eef2ff; color: var(--indigo); }
  .col-scheduled .kanban-item { background: #eef2ff; }
  .col-draft     .kanban-head { background: #fffbeb; color: var(--amber); }
  .col-draft     .kanban-item { background: #fffbeb; }
  .col-written   .kanban-head { background: #f5f3ff; color: var(--purple); }
  .col-written   .kanban-item { background: #f5f3ff; }
  .col-briefed   .kanban-head { background: #ecfeff; color: var(--teal); }
  .col-briefed   .kanban-item { background: #ecfeff; }
  .col-pending   .kanban-head { background: #f8fafc; color: var(--muted); }
  .col-pending   .kanban-item { background: #f8fafc; }

  /* ── image lightbox ── */
  #img-modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,.85); z-index: 9999; display: flex; align-items: center; justify-content: center; cursor: pointer; }
  #img-modal-overlay img { max-width: 90vw; max-height: 90vh; border-radius: 8px; box-shadow: 0 8px 32px rgba(0,0,0,.5); cursor: default; }

  /* ── rank filter chips ── */
  .filter-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .filter-chip { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #e0e7ff; color: #3730a3; display: flex; align-items: center; gap: 4px; }
  .filter-chip-x { cursor: pointer; font-size: 13px; line-height: 1; color: #6366f1; }
  .filter-chip-x:hover { color: #ef4444; }

  /* ── rank table header sort/filter ── */
  .th-inner { display: flex; align-items: center; gap: 4px; white-space: nowrap; }
  .th-sort { cursor: pointer; user-select: none; }
  .th-sort:hover { color: var(--text); }
  .th-filter-wrap { position: relative; display: inline-flex; }
  .th-filter-btn { cursor: pointer; font-size: 10px; padding: 0 3px; color: var(--muted); user-select: none; }
  .th-filter-btn:hover { color: var(--text); }
  .th-filter-btn.active { color: #3b82f6; }
  .th-filter-menu { display: none; position: absolute; top: 100%; left: 0; background: #fff; border: 1px solid #d1d5db; border-radius: 6px; padding: 4px; z-index: 200; min-width: 130px; box-shadow: 0 4px 12px rgba(0,0,0,.1); }
  .th-filter-menu.open { display: block; }
  .th-filter-opt { padding: 5px 10px; font-size: 12px; cursor: pointer; border-radius: 4px; text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--text); }
  .th-filter-opt:hover { background: #f3f4f6; }
  .th-filter-opt.selected { font-weight: 600; color: #3b82f6; }

  /* ── tables ── */
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  thead th { text-align: left; padding: 8px 12px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); border-bottom: 1px solid var(--border); white-space: nowrap; }
  tbody td { padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
  tbody tr:hover { background: #f8fafc; }
  tbody tr:last-child td { border-bottom: none; }

  /* ── badges ── */
  .badge { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 999px; display: inline-block; }
  .badge-published { background: #dcfce7; color: var(--green); }
  .badge-scheduled { background: #e0e7ff; color: var(--indigo); }
  .badge-draft     { background: #fef3c7; color: var(--amber); }
  .badge-written   { background: #ede9fe; color: var(--purple); }
  .badge-briefed   { background: #cffafe; color: var(--teal); }
  .badge-pending   { background: #f3f4f6; color: var(--muted); }
  .badge-local     { background: #f3f4f6; color: var(--muted); }
  .badge-page1     { background: #dcfce7; color: var(--green); }
  .badge-quickwins { background: #e0e7ff; color: var(--indigo); }
  .badge-needswork-rank { background: #fef3c7; color: var(--amber); }
  .badge-notranking { background: #f3f4f6; color: var(--muted); }

  /* ── rank change ── */
  .change-up   { color: var(--green); font-weight: 600; }
  .change-down { color: var(--red);   font-weight: 600; }
  .change-flat { color: var(--muted); }

  /* ── tab panels ── */
  .tab-panel { display: none; }
  .tab-panel.active { display: grid; gap: 20px; align-content: start; flex: 1; min-width: 0; }

  /* ── rank alerts ── */
  .alert-banner { border-radius: var(--radius); padding: 12px 18px; font-size: 13px; display: flex; align-items: center; gap: 10px; cursor: pointer; }
  .alert-banner.alert-red   { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; }
  .alert-banner.alert-green { background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; }
  .alert-banner-dismiss { margin-left: auto; font-size: 11px; opacity: .6; }

  /* ── cro ── */
  .cro-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .cro-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .cro-table td { padding: 6px 0; border-bottom: 1px solid var(--border); }
  .cro-table td:first-child { color: var(--muted); }
  .cro-table td:last-child { text-align: right; font-weight: 500; }
  .cro-sub { font-size: 10px; color: var(--muted); }
  .kpi-delta, .cro-delta { font-size: 11px; margin-top: 3px; font-weight: 500; display: block; }
  .kpi-delta.up,   .cro-delta.up   { color: var(--green); }
  .kpi-delta.down, .cro-delta.down { color: var(--red); }
  .kpi-delta.flat, .cro-delta.flat { color: var(--muted); }
  .brief-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 12px; }
  .brief-item { background: #fff7ed; border: 1px solid #fed7aa; border-radius: 6px; padding: 12px; display: flex; flex-direction: column; gap: 6px; }
  .brief-item-title { font-size: 11px; font-weight: 700; color: #c2410c; }
  .brief-item-body  { font-size: 11px; color: #78350f; line-height: 1.5; flex: 1; }
  .brief-item-actions { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
  .btn-cro-resolve { font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 5px; border: 1px solid #16a34a; background: #dcfce7; color: #15803d; cursor: pointer; }
  .btn-cro-resolve:hover { background: #bbf7d0; }
  .btn-cro-preview { font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 5px; border: 1px solid #d97706; background: #fef3c7; color: #92400e; cursor: pointer; }
  .btn-cro-preview:hover { background: #fde68a; }
  .badge-manual { font-size: 10px; padding: 3px 8px; border-radius: 4px; background: #f1f5f9; color: #94a3b8; border: 1px solid #e2e8f0; font-weight: 600; }
  .filter-bar { display: flex; gap: 6px; }
  .filter-btn { padding: 4px 12px; font-size: 11px; font-weight: 600; background: var(--surface); border: 1px solid var(--border); border-radius: 999px; cursor: pointer; color: var(--muted); font-family: inherit; transition: all .15s; }
  .filter-btn:hover { color: var(--text); border-color: #94a3b8; }
  .filter-btn.active { color: var(--indigo); background: #eef2ff; border-color: var(--indigo); font-weight: 600; }
  .gsc-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .gsc-table th { text-align: left; font-size: 11px; color: var(--muted); font-weight: 500; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
  .gsc-table td { padding: 5px 0; border-bottom: 1px solid var(--border); font-size: 12px; }
  .gsc-table td:not(:first-child) { text-align: right; }
  .gsc-summary { display: flex; gap: 24px; margin-bottom: 16px; flex-wrap: wrap; }
  .gsc-stat { display: flex; flex-direction: column; }
  .gsc-stat-value { font-size: 20px; font-weight: 700; }
  .gsc-stat-label { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .ads-opt-card { margin-bottom: 1rem; }
  .ads-opt-analysis { color: var(--muted); font-size: 0.85rem; margin-bottom: 1rem; padding: 0.75rem 1rem; background: var(--surface); border-radius: 6px; border: 1px solid var(--border); }
  .ads-suggestion { border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem; background: var(--bg); }
  .ads-suggestion-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem; }
  .ads-suggestion-rationale { font-size: 0.85rem; color: var(--fg); margin-bottom: 0.75rem; line-height: 1.5; }
  .ads-suggestion-change { font-size: 0.8rem; color: var(--muted); margin-bottom: 0.75rem; }
  .ads-suggestion-actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
  .ads-suggestion-actions button { padding: 0.3rem 0.75rem; border-radius: 5px; border: 1px solid var(--border); cursor: pointer; font-size: 0.82rem; background: var(--surface); }
  .btn-ads-approve { background: #d1fae5 !important; border-color: #6ee7b7 !important; color: #065f46 !important; }
  .btn-ads-approve:hover { background: #6ee7b7 !important; }
  .btn-ads-reject { background: #fee2e2 !important; border-color: #fca5a5 !important; color: #7f1d1d !important; }
  .btn-ads-reject:hover { background: #fca5a5 !important; }
  .ads-copy-edit { padding: 0.3rem 0.5rem; border: 1px solid var(--indigo); border-radius: 4px; font-size: 0.82rem; width: 260px; }
  .ads-char-count { font-size: 0.75rem; color: var(--muted); }
  .ads-char-count.over { color: #ef4444; }
  .ads-applied-section summary { font-size: 0.8rem; color: var(--muted); cursor: pointer; }

  /* ── seo authority ── */
  .authority-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  .authority-stat { padding: 14px 16px; border-left: 3px solid var(--indigo); }
  .authority-stat-value { font-size: 24px; font-weight: 800; color: var(--text); line-height: 1; }
  .authority-stat-label { font-size: 11px; color: var(--muted); margin-top: 3px; text-transform: uppercase; letter-spacing: .05em; font-weight: 500; }

  /* ── data needed ── */
  .data-needed { background: #fffbeb; border: 1px solid #fde68a; border-radius: var(--radius); padding: 14px 18px; font-size: 13px; color: #92400e; }
  .data-needed strong { display: block; margin-bottom: 4px; font-weight: 700; }

  /* ── active tests ── */
  .test-pills { display: flex; gap: 8px; flex-wrap: wrap; }
  .test-pill { display: inline-flex; align-items: center; gap: 6px; background: var(--bg); border: 1px solid var(--border); border-radius: 999px; padding: 4px 12px; font-size: 11px; }
  .test-pill .tp-slug { font-weight: 600; color: var(--text); }
  .test-pill .tp-day  { color: var(--muted); }
  .test-pill .tp-delta-pos { color: var(--green); font-weight: 600; }
  .test-pill .tp-delta-neg { color: var(--red);   font-weight: 600; }
  .test-pill .tp-delta-flat { color: var(--muted); }

  /* ── misc ── */
  .link { color: var(--indigo); text-decoration: none; }
  .link:hover { text-decoration: underline; }
  .muted { color: var(--muted); }
  .empty-state { color: var(--muted); font-size: 13px; padding: 24px 0; text-align: center; }
  .section-note { font-size: 11px; color: var(--muted); }

  /* ── badge aliases (removed in later task) ── */
  .badge-approved  { background: #dcfce7; color: var(--green); }
  .badge-needswork { background: #fee2e2; color: var(--red); }

  /* ── utility classes ── */
  .pos { font-weight: 600; font-size: 15px; }
  .nowrap { white-space: nowrap; }
  .empty { color: var(--muted); font-size: 13px; padding: 16px; text-align: center; }
  .spin { animation: spin .8s linear infinite; display: inline-block; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes chat-dot { 0%,80%,100% { opacity:.2; transform:scale(.8); } 40% { opacity:1; transform:scale(1); } }
  .chat-dot { display:inline-block; width:6px; height:6px; border-radius:50%; background:#818cf8; margin:0 2px; animation:chat-dot 1.2s ease-in-out infinite; }
  .chat-dot:nth-child(2) { animation-delay:.2s; }
  .chat-dot:nth-child(3) { animation-delay:.4s; }
  .tab-actions-bar { display:flex; justify-content:center; align-items:center; gap:0.5rem; padding:8px 24px; background:var(--bg); border-bottom:1px solid var(--border); flex-wrap:wrap; }
  .tab-actions-group { display:flex; gap:0.5rem; flex-wrap:wrap; align-items:center; justify-content:center; }
  .tab-actions-bar button { padding:0.4rem 0.85rem; background:var(--surface); border:1px solid var(--border); border-radius:6px; cursor:pointer; font-size:0.85rem; position:relative; }
  .tab-actions-bar button:hover { background:var(--indigo); color:white; border-color:var(--indigo); }
  .tab-actions-bar button[data-tip]:hover::after { content:attr(data-tip); position:absolute; bottom:calc(100% + 6px); left:50%; transform:translateX(-50%); background:#1e1b4b; color:#fff; font-size:0.72rem; white-space:nowrap; padding:4px 8px; border-radius:5px; pointer-events:none; z-index:100; }
  .tab-actions-bar button[data-tip]:hover::before { content:''; position:absolute; bottom:calc(100% + 1px); left:50%; transform:translateX(-50%); border:5px solid transparent; border-top-color:#1e1b4b; pointer-events:none; z-index:100; }
  .run-log { margin: 0.5rem 24px 0.5rem; padding: 0.75rem; background: #0d0d0d; color: #7ee787; font-size: 0.78rem; border-radius: 6px; max-height: 200px; overflow-y: auto; white-space: pre-wrap; }

  /* ── Optimize tab ── */
  .kanban-optimize { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.5rem; margin-bottom: 2rem; }
  .kanban-optimize-col h3 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 1rem; }
  .brief-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1rem; margin-bottom: 0.75rem; cursor: pointer; transition: border-color 0.15s; }
  .brief-card:hover { border-color: var(--indigo); }
  .brief-card-title { font-weight: 600; margin-bottom: 0.4rem; font-size: 0.9rem; }
  .brief-card-meta { font-size: 0.78rem; color: var(--muted); display: flex; gap: 0.75rem; flex-wrap: wrap; }
  .brief-detail { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; }
  .screenshot-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem; }
  .screenshot-label { font-size: 0.78rem; color: var(--muted); margin-bottom: 0.4rem; }
  .page-screenshot { width: 100%; border-radius: 6px; border: 1px solid var(--border); }
  .screenshot-missing { height: 120px; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 0.8rem; border: 1px dashed var(--border); border-radius: 6px; }
  .change-card { border: 1px solid var(--border); border-radius: 6px; padding: 1rem; margin-bottom: 0.75rem; }
  .change-card.change-approved { border-color: #2ea043; }
  .change-card.change-rejected { opacity: 0.5; }
  .change-header { display: flex; justify-content: space-between; margin-bottom: 0.5rem; }
  .change-label { font-weight: 600; font-size: 0.9rem; }
  .change-status-pill { font-size: 0.75rem; padding: 0.15rem 0.5rem; border-radius: 999px; background: var(--border); }
  .diff-current { text-decoration: line-through; color: var(--muted); font-size: 0.82rem; }
  .diff-proposed { color: #2ea043; font-size: 0.82rem; margin-top: 0.25rem; }
  .html-preview { width: 100%; height: 200px; border: 1px solid var(--border); border-radius: 4px; }
  .change-rationale { font-size: 0.78rem; color: var(--muted); margin-bottom: 0.5rem; }
  .change-actions { display: flex; gap: 0.5rem; }
  .btn-approve { background: #2ea043; color: white; border: none; padding: 0.3rem 0.75rem; border-radius: 4px; cursor: pointer; font-size: 0.82rem; }
  .btn-reject { background: #da3633; color: white; border: none; padding: 0.3rem 0.75rem; border-radius: 4px; cursor: pointer; font-size: 0.82rem; }
  .btn-apply { background: var(--indigo); color: white; border: none; padding: 0.5rem 1.25rem; border-radius: 6px; cursor: pointer; font-weight: 600; }
  .apply-section { margin-top: 1rem; }
  .badge-type { background: var(--indigo); color: white; font-size: 0.7rem; padding: 0.1rem 0.4rem; border-radius: 4px; }
  .upload-zone { display: flex; align-items: center; gap: 0.75rem; font-size: 0.82rem; color: var(--muted); }
  .proposal { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; margin-bottom: 12px; }
  .proposal:last-child { margin-bottom: 0; }
  .proposal-head { padding: 14px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: flex-start; gap: 12px; background: #fafbff; }
  .proposal-name { font-size: 14px; font-weight: 700; color: var(--text); }
  .proposal-sub  { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .proposal-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
  .metrics-row { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr 1fr; border-bottom: 1px solid var(--border); }
  .metric { padding: 12px 16px; border-right: 1px solid var(--border); }
  .metric:last-child { border-right: none; }
  .metric-label { font-size: 9px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin-bottom: 4px; }
  .metric-value { font-size: 18px; font-weight: 800; color: var(--text); line-height: 1; }
  .metric-unit  { font-size: 11px; color: var(--muted); font-weight: 500; }
  .metric-note  { font-size: 10px; color: var(--muted); margin-top: 3px; }
  .budget-metric { background: #fafbff; }
  .budget-row   { display: flex; align-items: center; gap: 6px; margin-top: 4px; }
  .budget-input { width: 72px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px; font-size: 15px; font-weight: 800; font-family: inherit; color: var(--text); background: white; }
  .budget-input:focus { outline: none; border-color: var(--indigo); box-shadow: 0 0 0 2px rgba(67,56,202,.12); }
  .rationale-row  { padding: 13px 16px; border-bottom: 1px solid var(--border); }
  .rationale-label { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); margin-bottom: 5px; }
  .rationale-text  { font-size: 12px; color: #374151; line-height: 1.6; }
  .rationale-summary { font-size: 12px; color: #374151; font-weight: 500; line-height: 1.6; margin-bottom: 6px; }
  .rationale-bullets { margin: 0 0 6px 16px; padding: 0; font-size: 11.5px; color: var(--muted); line-height: 1.6; }
  .rationale-bullets li { margin-bottom: 3px; }
  .rationale-details summary { font-size: 11px; color: var(--muted); cursor: pointer; margin-top: 2px; }
  .rationale-details summary:hover { color: var(--indigo); }
  .camp-proposal { border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; background: var(--bg); }
  .camp-proposal:last-child { margin-bottom: 0; }
  .camp-proposal-name { font-size: 13px; font-weight: 700; color: var(--text); margin-bottom: 10px; }
  .camp-proposal-meta { font-size: 12px; color: var(--muted); line-height: 1.8; }
  .camp-kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 10px; }
  .camp-kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
  .camp-kpi-value { font-size: 18px; font-weight: 800; line-height: 1; color: var(--text); }
  .camp-kpi-label { font-size: 9px; color: var(--muted); margin-top: 3px; font-weight: 500; letter-spacing: .04em; text-transform: uppercase; }
  .camp-kpi-delta { font-size: 10px; margin-top: 3px; font-weight: 600; }
  .adgroups-row    { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .adgroups-label  { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .07em; color: var(--muted); margin-right: 4px; flex-shrink: 0; }
  .adgroup-pill    { background: #f1f5f9; border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; font-size: 11px; font-weight: 600; color: var(--text); }
  .adgroup-kw      { font-size: 10px; color: var(--muted); font-weight: 400; }
  .proposal-actions { padding: 12px 16px; display: flex; gap: 8px; align-items: center; }
  .proposal-action-note { font-size: 11px; color: var(--muted); margin-left: auto; }
  /* ── tab chat sidebar ── */
  .tab-chat-sidebar { width: 300px; background: white; border: 2px solid #818cf8; border-radius: 8px; display: flex; flex-direction: column; position: fixed; top: 170px; right: 8px; bottom: 8px; overflow: hidden; z-index: 9; }
  .tab-chat-header { background: #eef2ff; padding: 10px 14px; border-bottom: 1px solid #c7d2fe; display: flex; justify-content: space-between; align-items: center; font-size: 12px; font-weight: 600; color: #312e81; flex-shrink: 0; }
  .tab-chat-messages { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; min-height: 0; }
  .tab-chat-user-bubble { align-self: flex-end; background: #818cf8; color: white; border-radius: 12px 12px 2px 12px; padding: 8px 11px; max-width: 220px; font-size: 12px; word-break: break-word; white-space: pre-wrap; }
  .tab-chat-ai-bubble { align-self: flex-start; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 2px 12px 12px 12px; padding: 8px 11px; max-width: 240px; color: #374151; font-size: 12px; word-break: break-word; }
  .tab-chat-ai-bubble .chat-md-h2 { font-weight: 700; font-size: 13px; color: #312e81; margin: 6px 0 2px; }
  .tab-chat-ai-bubble .chat-md-h3 { font-weight: 600; font-size: 12px; color: #4338ca; margin: 5px 0 2px; }
  .tab-chat-ai-bubble .chat-md-ul { margin: 4px 0 4px 14px; padding: 0; }
  .tab-chat-ai-bubble .chat-md-ul li { margin-bottom: 3px; list-style: disc; }
  .tab-chat-ai-bubble .chat-md-gap { height: 6px; }
  .tab-chat-ai-bubble code { background: #e0e7ff; color: #3730a3; border-radius: 3px; padding: 1px 4px; font-size: 11px; }
  .tab-chat-action-card { background: #fffbeb; border: 1px solid #fbbf24; border-radius: 6px; padding: 8px 11px; margin-top: 4px; max-width: 240px; align-self: flex-start; }
  .tab-chat-action-label { font-weight: 600; color: #92400e; font-size: 10px; margin-bottom: 3px; }
  .tab-chat-action-desc { color: #374151; font-size: 11px; margin-bottom: 6px; }
  .btn-add-to-queue { background: #f59e0b; color: white; border: none; border-radius: 5px; padding: 4px 10px; font-size: 11px; cursor: pointer; font-weight: 600; }
  .btn-add-to-queue:hover { background: #d97706; }
  .btn-add-to-queue:disabled { background: #fcd34d; cursor: default; }
  .tab-chat-input-row { padding: 10px; border-top: 1px solid #e2e8f0; display: flex; gap: 6px; flex-shrink: 0; }
  .tab-chat-input { flex: 1; border: 1px solid #c7d2fe; border-radius: 6px; padding: 7px 9px; font-size: 12px; font-family: inherit; background: #f8fafc; outline: none; }
  .tab-chat-input:focus { border-color: #818cf8; }
  .tab-chat-send { background: #818cf8; color: white; border: none; border-radius: 6px; padding: 7px 12px; font-size: 13px; cursor: pointer; }
  .tab-chat-send:hover { background: #6366f1; }
  .btn-open-chat { background: #eef2ff !important; color: #4338ca !important; border-color: #c7d2fe !important; }
  .btn-open-chat.active { background: #818cf8 !important; color: white !important; border-color: #818cf8 !important; }
  .tab-chat-empty { color: #94a3b8; font-size: 11px; text-align: center; padding: 20px 8px; line-height: 1.5; }
  .btn-camp-approve  { padding: 7px 16px; font-size: 12px; font-weight: 600; border-radius: 6px; border: none; cursor: pointer; font-family: inherit; background: var(--green); color: white; }
  .btn-camp-approve:hover { background: #15803d; }
  .btn-launch   { padding: 7px 16px; font-size: 12px; font-weight: 600; border-radius: 6px; border: none; cursor: pointer; font-family: inherit; background: var(--indigo); color: white; }
  .btn-launch:hover { background: #3730a3; }
  .btn-dismiss  { padding: 7px 16px; font-size: 12px; font-weight: 600; border-radius: 6px; border: 1px solid var(--border); cursor: pointer; font-family: inherit; background: none; color: var(--muted); }
  .btn-dismiss:hover { color: var(--red); border-color: var(--red); }
  .delta-up { color: #10b981; }
  .delta-down { color: #ef4444; }
  .alert-badge-inline { background: #fef3c7; color: #92400e; border-radius: 4px; padding: 2px 6px; font-size: 11px; margin-right: 4px; }
  .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .section-title { font-weight: 600; font-size: 15px; }
  .badge-gray { background: #f3f4f6; color: #6b7280; }
  .btn-secondary { background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0; padding: 0.3rem 0.75rem; border-radius: 4px; cursor: pointer; font-size: 0.82rem; }
</style>
</head>
<body>
<header class="hero">
  <div class="hero-top">
    <div class="hero-logo" id="hero-logo"></div>
    <div>
      <div class="hero-name" id="site-name"></div>
      <div class="hero-url" id="site-url"></div>
    </div>
    <div class="tab-pills">
      <button class="tab-pill active" onclick="switchTab('seo',this)">SEO</button>
      <button class="tab-pill" onclick="switchTab('cro',this)" id="pill-cro">CRO</button>
      <button class="tab-pill" onclick="switchTab('ads',this)" id="pill-ads" style="display:none">Ads</button>
      <button class="tab-pill" onclick="switchTab('ad-intelligence',this)" id="pill-ad-intelligence">Ad Intelligence</button>
      <button class="tab-pill" onclick="switchTab('optimize',this)" id="pill-optimize">Optimize</button>
    </div>
    <div id="cro-filter-bar" style="display:none">
      <div class="filter-bar">
        <button class="filter-btn active" onclick="setCroFilter('today',this)">Today</button>
        <button class="filter-btn" onclick="setCroFilter('yesterday',this)">Yesterday</button>
        <button class="filter-btn" onclick="setCroFilter('7days',this)">7 Days</button>
        <button class="filter-btn" onclick="setCroFilter('30days',this)">30 Days</button>
      </div>
    </div>
    <span class="hero-meta">Updated <span id="updated-at">—</span></span>
    <button class="refresh-btn" onclick="loadData()"><span id="spin-icon"></span>↻ Refresh</button>
  </div>
  <div class="hero-kpis" id="hero-kpis"></div>
</header>

<div class="tab-actions-bar">
  <div class="tab-actions-group" id="tab-actions-seo">
    <button onclick="runAgent('agents/rank-tracker/index.js')" data-tip="Pull latest keyword positions from Ahrefs and update rankings">Run Rank Tracker</button>
    <button onclick="runAgent('agents/content-gap/index.js')" data-tip="Find topics competitors rank for that this site doesn't cover">Run Content Gap</button>
    <button onclick="runAgent('agents/gsc-query-miner/index.js')" data-tip="Surface high-impression GSC queries with low CTR to optimise">Run GSC Query Miner</button>
    <button onclick="runAgent('agents/sitemap-indexer/index.js')" data-tip="Re-index the sitemap so all agents have the latest page list">Refresh Sitemap</button>
    <button onclick="runAgent('agents/insight-aggregator/index.js')" data-tip="Aggregate Ahrefs + GSC signals into a prioritised insight report">Run Insight Aggregator</button>
    <button id="btn-chat-seo" class="btn-open-chat" onclick="toggleTabChat('seo')" data-tip="Ask Claude about the SEO data on this tab">&#x2736; Chat</button>
  </div>
  <div class="tab-actions-group" id="tab-actions-cro" style="display:none">
    <button onclick="promptAndRun('scripts/create-meta-test.js', 'Enter post slug:')" data-tip="Generate a Variant B meta title and start an A/B test for a post">Create Meta A/B Test</button>
    <button onclick="runAgent('agents/meta-ab-tracker/index.js')" data-tip="Check CTR results for active meta title tests and conclude winners">Run Meta A/B Tracker</button>
    <button onclick="runAgent('agents/cro-analyzer/index.js')" data-tip="Analyse Clarity heatmaps and session data for conversion issues">Run CRO Analyzer</button>
    <button onclick="runAgent('agents/cro-cta-injector/index.js', ['--apply'])" data-tip="Insert product CTA blocks into top-traffic blog posts with 0 conversions">Inject CTAs</button>
    <button id="btn-chat-cro" class="btn-open-chat" onclick="toggleTabChat('cro')" data-tip="Ask Claude about the CRO data on this tab">&#x2736; Chat</button>
  </div>
  <div class="tab-actions-group" id="tab-actions-ads" style="display:none">
    <button onclick="runAgent('agents/ads-optimizer/index.js')" data-tip="Analyze Ads + GSC + GA4 + Ahrefs and generate optimization suggestions">Run Ads Optimizer</button>
    <button onclick="applyAdsChanges()" data-tip="Execute all approved suggestions via the Google Ads Mutate API">Apply Approved</button>
    <button onclick="runAgent('agents/campaign-monitor/index.js', [], loadCampaignCards)" data-tip="Fetch latest Google Ads performance data and update active campaign metrics">Run Campaign Monitor</button>
    <button onclick="runAgent('scripts/ads-weekly-recap.js')" data-tip="Send the weekly recap email now (normally runs automatically Sunday morning)">Send Weekly Recap</button>
    <button id="btn-chat-ads" class="btn-open-chat" onclick="toggleTabChat('ads')" data-tip="Ask Claude about your Ads data on this tab">&#x2736; Chat</button>
  </div>
  <div class="tab-actions-group" id="tab-actions-optimize" style="display:none">
    <button onclick="runAgent('agents/competitor-intelligence/index.js')" data-tip="Scrape top competitor pages and generate optimisation briefs">Run Competitor Intelligence</button>
    <button id="btn-chat-optimize" class="btn-open-chat" onclick="toggleTabChat('optimize')" data-tip="Ask Claude about optimization data on this tab">&#x2736; Chat</button>
  </div>
</div>

<main style="display:flex;align-items:start">
<div id="tab-seo" class="tab-panel active">
  <!-- Data Needed alert (hidden when empty) -->
  <div class="card alert-card" id="data-needed-card" style="display:none">
    <div class="card-header">
      <h2>⚠ Ahrefs Data Needed <span class="alert-badge" id="data-needed-count">0</span></h2>
      <span class="section-note">Upload these CSV exports before the research agent can run</span>
    </div>
    <div class="card-body" id="data-needed-body"></div>
  </div>

  <!-- Rank alert banner -->
  <div id="rank-alert-banner" style="display:none"></div>

  <!-- SEO Authority -->
  <div class="card">
    <div class="card-header accent-indigo"><h2>SEO Authority</h2><div class="card-header-right"><span class="section-note">Ahrefs · Updated manually</span><button class="upload-btn" onclick="openAhrefsModal()" data-tip="Enter latest Ahrefs domain overview metrics">Update</button></div></div>
    <div class="card-body" id="seo-authority-panel"><p class="empty-state">Loading...</p></div>
  </div>

  <!-- Pipeline kanban -->
  <div class="card">
    <div class="card-header"><h2>Content Pipeline</h2><span class="section-note" id="pipeline-note"></span></div>
    <div class="card-body"><div class="kanban" id="kanban"></div></div>
  </div>

  <!-- Rankings -->
  <div class="card">
    <div class="card-header"><h2>Keyword Rankings</h2><div class="card-header-right"><span class="section-note" id="rank-note"></span><button id="rank-upload-btn" class="upload-btn" onclick="uploadRankSnapshot()" data-tip="Upload an Ahrefs keyword tracker CSV export">&#8593; Upload CSV</button></div></div>
    <div class="card-body table-wrap"><div id="rankings-table"></div></div>
  </div>

  <!-- Posts -->
  <div class="card">
    <div class="card-header"><h2>Posts</h2><span class="section-note" id="posts-note"></span></div>
    <div class="card-body table-wrap"><div id="posts-table"></div></div>
  </div>

  <div class="card" id="gsc-seo-card">
    <div class="card-header"><h2>Search Console</h2><span class="section-note" id="gsc-seo-note"></span></div>
    <div class="card-body" id="gsc-seo-body"><p class="empty-state">Loading...</p></div>
  </div>
  <pre id="run-log-agents-rank-tracker-index-js" class="run-log" style="display:none"></pre>
  <pre id="run-log-agents-content-gap-index-js" class="run-log" style="display:none"></pre>
  <pre id="run-log-agents-gsc-query-miner-index-js" class="run-log" style="display:none"></pre>
  <pre id="run-log-agents-sitemap-indexer-index-js" class="run-log" style="display:none"></pre>
  <pre id="run-log-agents-insight-aggregator-index-js" class="run-log" style="display:none"></pre>
</div><!-- /tab-seo -->
<div id="tab-cro" class="tab-panel">
  <div id="cro-kpi-strip" style="display:none"></div>
  <div class="cro-grid" style="margin-bottom:16px">
    <div id="cro-clarity-card"></div>
    <div id="cro-shopify-card"></div>
    <div id="cro-ga4-card"></div>
    <div id="cro-gsc-card"></div>
  </div>
  <div id="active-tests-row" style="display:none">
    <div class="card">
      <div class="card-header accent-indigo"><h2>Active A/B Tests</h2></div>
      <div class="card-body"><div class="test-pills"></div></div>
    </div>
  </div>
  <div id="cro-brief-card"></div>
  <!-- Brief detail modal -->
  <div id="brief-modal-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;align-items:center;justify-content:center" onclick="closeBriefModal(event)">
    <div id="brief-modal" style="background:#fff;border-radius:12px;max-width:660px;width:90%;max-height:82vh;overflow-y:auto;position:relative;padding:28px 32px;box-shadow:0 20px 60px rgba(0,0,0,.25)">
      <button onclick="document.getElementById('brief-modal-overlay').style.display='none'" style="position:absolute;top:12px;right:16px;background:none;border:none;font-size:22px;line-height:1;cursor:pointer;color:#9ca3af;padding:4px 8px">&times;</button>
      <div id="brief-modal-content"></div>
    </div>
  </div>
  <pre id="run-log-scripts-create-meta-test-js" class="run-log" style="display:none"></pre>
  <pre id="run-log-agents-meta-ab-tracker-index-js" class="run-log" style="display:none"></pre>
  <pre id="run-log-agents-cro-analyzer-index-js" class="run-log" style="display:none"></pre>
  <pre id="run-log-agents-cro-cta-injector-index-js" class="run-log" style="display:none"></pre>
  <pre id="run-log-agents-cro-deep-dive-content-index-js" style="display:none" class="run-log"></pre>
  <pre id="run-log-agents-cro-deep-dive-seo-index-js" style="display:none" class="run-log"></pre>
  <pre id="run-log-agents-cro-deep-dive-trust-index-js" style="display:none" class="run-log"></pre>
</div><!-- /tab-cro -->
<div id="tab-ad-intelligence" class="tab-panel" style="display:none">
  <div id="ad-intelligence-content">
    <p class="muted" style="padding:2rem">Loading ad intelligence data…</p>
  </div>
</div>
<div id="tab-ads" class="tab-panel">
  <pre id="run-log-apply-ads" class="run-log" style="display:none"></pre>
  <pre id="run-log-agents-ads-optimizer-index-js" class="run-log" style="display:none"></pre>
  <pre id="run-log-agents-campaign-monitor-index-js" class="run-log" style="display:none"></pre>
  <pre id="run-log-scripts-ads-weekly-recap-js" class="run-log" style="display:none"></pre>
  <!-- Active Campaigns -->
  <div class="card" id="campaign-active-card">
    <div class="card-header accent-indigo">
      <h2>Active Campaigns</h2>
    </div>
    <div id="campaign-active-body"><p class="empty-state">No active campaigns yet.</p></div>
  </div>
  <!-- Campaign Suggestions -->
  <div class="card" id="campaign-proposals-card">
    <div class="card-header accent-indigo">
      <h2>Campaign Suggestions</h2>
      <span style="font-size:11px;color:var(--muted)" id="campaign-proposals-note"></span>
    </div>
    <div style="padding:16px" id="campaign-proposals-body"><p class="empty-state">No campaign suggestions yet. Run Campaign Creator to generate proposals.</p></div>
  </div>
  <!-- Clarifications Needed -->
  <div class="card" id="campaign-clarify-card" style="display:none">
    <div class="card-header accent-indigo">
      <h2>Clarifications Needed</h2>
    </div>
    <div id="campaign-clarify-body"></div>
  </div>
  <!-- Optimization Queue -->
  <div class="card ads-opt-card">
    <div class="card-header accent-indigo"><h2>Optimization Queue</h2></div>
    <div class="card-body" id="ads-opt-body"><p class="empty-state">Loading...</p></div>
  </div>
  <div id="ads-keywords-card"></div>
</div><!-- /tab-ads -->
<div id="tab-optimize" class="tab-panel">
  <div class="empty-state">Loading optimization briefs...</div>
</div>
<div id="tab-chat-sidebar" class="tab-chat-sidebar" style="display:none">
  <div class="tab-chat-header">
    <span id="tab-chat-title">&#x2736; Chat</span>
    <button onclick="closeTabChat()" style="background:none;border:none;cursor:pointer;color:#818cf8;font-size:15px;line-height:1;padding:0">&#x2715;</button>
  </div>
  <div id="tab-chat-messages" class="tab-chat-messages"></div>
  <div class="tab-chat-input-row">
    <input id="tab-chat-input" class="tab-chat-input" placeholder="Ask about this tab..."
      onkeydown="if(event.key===&quot;Enter&quot;&amp;&amp;!event.shiftKey){event.preventDefault();sendTabChatMessage();}">
    <button class="tab-chat-send" onclick="sendTabChatMessage()">&#x2191;</button>
  </div>
</div>
</main>

<script>
let data = null;

let activeTab = 'seo';

var chatOpen = new Set();

function switchTab(name, btn) {
  activeTab = name;
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-pill').forEach(b => b.classList.remove('active'));
  const panel = document.getElementById('tab-' + name);
  if (panel) panel.classList.add('active');
  btn.classList.add('active');
  // Show/hide CRO date filter
  document.getElementById('cro-filter-bar').style.display = (name === 'cro' || name === 'ads') ? '' : 'none';
  // Show/hide tab action groups
  ['seo','cro','optimize','ads'].forEach(function(t) {
    const g = document.getElementById('tab-actions-' + t);
    if (g) g.style.display = t === name ? '' : 'none';
  });
  // Update hero KPIs for this tab
  if (data) renderHeroKpis(data);
  if (name === 'optimize' && data) renderOptimizeTab(data);
  if (name === 'ad-intelligence') renderAdIntelligenceTab();
  // Update chat sidebar when tab switches
  if (tabChatOpen) {
    var chatTitle = document.getElementById('tab-chat-title');
    if (chatTitle) chatTitle.textContent = '\\u2736 ' + (TAB_CHAT_NAMES[name] || name) + ' Chat';
    ['seo','cro','ads','optimize'].forEach(function(t) {
      var btn2 = document.getElementById('btn-chat-' + t);
      if (btn2) { if (t === name) btn2.classList.add('active'); else btn2.classList.remove('active'); }
    });
    renderTabChatMessages();
  }
}

function renderHeroKpis(d) {
  const kpis = activeTab === 'cro'      ? buildCroKpis(d)
             : activeTab === 'ads'      ? buildAdsKpis(d)
             : activeTab === 'optimize' ? buildOptimizeKpis(d)
             : buildSeoKpis(d);
  document.getElementById('hero-kpis').innerHTML = kpis.map(k =>
    '<div class="hero-kpi">' +
    '<div class="hero-kpi-value" style="color:' + k.color + '">' + k.value + '</div>' +
    '<div class="hero-kpi-label">' + k.label + '</div>' +
    '</div>'
  ).join('');
}

function buildSeoKpis(d) {
  const c = d.pipeline?.counts || {};
  const r = d.rankings || {};
  const page1 = r.summary?.page1 ?? '—';
  const rankItems = r.items.filter(x => x.change != null);
  const avgChange = rankItems.length
    ? (rankItems.reduce((s, x) => s + x.change, 0) / rankItems.length).toFixed(1)
    : null;
  const gscClicks = d.cro?.gscAll?.[0]?.summary?.clicks ?? null;
  return [
    { label: 'Published',   value: c.published || 0,                                          color: '#10b981' },
    { label: 'Scheduled',   value: c.scheduled  || 0,                                          color: '#818cf8' },
    { label: 'Pg 1 KWs',    value: page1,                                                      color: '#f59e0b' },
    { label: 'Avg Rank Δ',  value: avgChange != null ? (avgChange > 0 ? '+' : '') + avgChange : '—', color: '#c084fc' },
    { label: 'GSC Clicks',  value: gscClicks != null ? gscClicks.toLocaleString() : '—',       color: '#38bdf8' },
  ];
}

function buildCroKpis(d) {
  const cro = d.cro || {};
  const ga4 = cro.ga4All?.[0];
  const sh  = cro.shopifyAll?.[0];
  const cl  = cro.clarityAll?.[0];
  return [
    { label: 'Conv. Rate',  value: ga4?.conversionRate != null ? (ga4.conversionRate * 100).toFixed(1) + '%' : '—', color: '#10b981' },
    { label: 'Avg Order',   value: sh?.orders?.aov != null ? '$' + Math.round(sh.orders.aov) : '—',                  color: '#fb923c' },
    { label: 'Bounce Rate', value: ga4?.bounceRate != null ? (ga4.bounceRate * 100).toFixed(1) + '%' : '—',           color: '#ef4444' },
    { label: 'Sessions',    value: cl?.sessions?.real ?? ga4?.sessions ?? '—',                                        color: '#38bdf8' },
    { label: 'Cart Abandon',value: sh?.cartAbandonmentRate != null ? (sh.cartAbandonmentRate * 100).toFixed(1) + '%' : '—', color: '#f59e0b' },
  ];
}

function buildAdsKpis(d) {
  const snap = d.googleAdsAll?.[0];
  return [
    { label: 'Ad Spend',     value: snap?.spend != null ? '$' + snap.spend.toFixed(2) : '—',            color: '#fb923c' },
    { label: 'Impressions',  value: snap?.impressions != null ? snap.impressions.toLocaleString() : '—', color: '#38bdf8' },
    { label: 'Clicks',       value: snap?.clicks != null ? snap.clicks.toLocaleString() : '—',           color: '#818cf8' },
    { label: 'CTR',          value: snap?.ctr != null ? (snap.ctr * 100).toFixed(2) + '%' : '—',         color: '#f59e0b' },
    { label: 'ROAS',         value: snap?.roas != null ? snap.roas.toFixed(2) + 'x' : '—',               color: '#10b981' },
  ];
}

function renderOptimizeTab(d) {
  const briefs = d.briefs || [];

  const pending  = briefs.filter(b => (b.proposed_changes || []).some(c => c.status === 'pending'));
  const approved = briefs.filter(b => {
    const ch = b.proposed_changes || [];
    return !ch.some(c => c.status === 'pending') && ch.some(c => c.status === 'approved') && !ch.some(c => c.status === 'applied');
  });
  const applied  = briefs.filter(b => {
    const ch = b.proposed_changes || [];
    return ch.some(c => c.status === 'applied') && !ch.some(c => c.status === 'approved');
  });

  document.getElementById('tab-optimize').innerHTML =
    '<div class="kanban-optimize">' +
      '<div class="kanban-optimize-col">' +
        '<h3>Pending Review <span class="badge">' + pending.length + '</span></h3>' +
        (pending.map(b => renderBriefCard(b)).join('') || '<div class="empty-state">No pending briefs</div>') +
      '</div>' +
      '<div class="kanban-optimize-col">' +
        '<h3>Approved <span class="badge">' + approved.length + '</span></h3>' +
        (approved.map(b => renderBriefCard(b)).join('') || '<div class="empty-state">None approved yet</div>') +
      '</div>' +
      '<div class="kanban-optimize-col">' +
        '<h3>Applied <span class="badge">' + applied.length + '</span></h3>' +
        (applied.map(b => renderBriefCard(b)).join('') || '<div class="empty-state">None applied yet</div>') +
      '</div>' +
    '</div>' +
    '<pre id="run-log-agents-competitor-intelligence-index-js" class="run-log" style="display:none"></pre>';
}

function renderBriefCard(b) {
  const pendingCount  = (b.proposed_changes || []).filter(c => c.status === 'pending').length;
  const approvedCount = (b.proposed_changes || []).filter(c => c.status === 'approved').length;
  const topTV = b.competitors && b.competitors[0] && b.competitors[0].traffic_value
    ? '$' + ((b.competitors[0].traffic_value) / 100).toLocaleString() : '\u2014';
  return '<div class="brief-card" onclick="toggleBriefDetail(&apos;' + esc(b.slug) + '&apos;)">' +
      '<div class="brief-card-title">' + esc(b.slug) + '</div>' +
      '<div class="brief-card-meta">' +
        '<span class="badge-type">' + esc(b.page_type) + '</span>' +
        '<span>' + pendingCount + ' pending \u00b7 ' + approvedCount + ' approved</span>' +
        '<span>' + topTV + '</span>' +
      '</div>' +
    '</div>' +
    '<div id="detail-' + esc(b.slug) + '" class="brief-detail" style="display:none">' +
      renderBriefDetail(b) +
    '</div>';
}

function toggleBriefDetail(slug) {
  const el = document.getElementById('detail-' + slug);
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function renderBriefDetail(b) {
  const topComp = (b.competitors || []).slice().sort(function(a, z) { return z.traffic_value - a.traffic_value; })[0];
  const pair =
    '<div class="screenshot-pair">' +
      '<div>' +
        '<div class="screenshot-label">Your Page</div>' +
        (b.store_screenshot
          ? '<img src="/screenshot?path=' + encodeURIComponent(b.store_screenshot) + '" class="page-screenshot">'
          : '<div class="screenshot-missing">No screenshot</div>') +
      '</div>' +
      '<div>' +
        '<div class="screenshot-label">Top Competitor' + (topComp ? ' (' + esc(topComp.domain) + ')' : '') + '</div>' +
        (topComp && topComp.screenshot
          ? '<img src="/screenshot?path=' + encodeURIComponent(topComp.screenshot) + '" class="page-screenshot">'
          : '<div class="screenshot-missing">No screenshot</div>') +
      '</div>' +
    '</div>';

  const changes = (b.proposed_changes || []).map(function(c) {
    return '<div class="change-card change-' + esc(c.status) + '">' +
      '<div class="change-header">' +
        '<span class="change-label">' + esc(c.label) + '</span>' +
        '<span class="change-status-pill">' + esc(c.status) + '</span>' +
      '</div>' +
      '<div class="change-diff">' +
        (c.type === 'body_html'
          ? '<iframe srcdoc="' + esc(c.proposed || '') + '" class="html-preview" sandbox=""></iframe>'
          : '<div class="diff-current">' + esc(c.current || '\u2014') + '</div>' +
            '<div class="diff-proposed">' + esc(c.proposed || '') + '</div>') +
      '</div>' +
      '<div class="change-rationale">' + esc(c.rationale || '') + '</div>' +
      (c.status === 'pending'
        ? '<div class="change-actions">' +
            '<button class="btn-approve" onclick="updateChange(&apos;' + esc(b.slug) + '&apos;,&apos;' + esc(c.id) + '&apos;,&apos;approved&apos;)">Approve</button>' +
            '<button class="btn-reject"  onclick="updateChange(&apos;' + esc(b.slug) + '&apos;,&apos;' + esc(c.id) + '&apos;,&apos;rejected&apos;)">Reject</button>' +
          '</div>'
        : '') +
    '</div>';
  }).join('');

  const hasApproved = (b.proposed_changes || []).some(function(c) { return c.status === 'approved'; });
  const applyBtn = hasApproved
    ? '<div class="apply-section">' +
        '<button class="btn-apply" onclick="applyBrief(&apos;' + esc(b.slug) + '&apos;)">Apply Approved Changes</button>' +
        '<pre id="apply-log-' + esc(b.slug) + '" class="run-log" style="display:none"></pre>' +
      '</div>'
    : '';

  return pair + changes + applyBtn;
}

async function updateChange(slug, id, status) {
  await fetch('/brief/' + slug + '/change/' + id, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: status }),
  });
  loadData(); // re-render with updated brief
}

async function applyBrief(slug) {
  const logEl = document.getElementById('apply-log-' + slug);
  if (logEl) { logEl.style.display = 'block'; logEl.textContent = ''; }
  const res = await fetch('/apply/' + slug, { method: 'POST' });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  function read() {
    reader.read().then(function({ done, value }) {
      if (done) { loadData(); return; }
      for (const line of decoder.decode(value).split('\\n')) {
        if (line.startsWith('data: ') && logEl) {
          logEl.textContent += line.slice(6) + '\\n';
          logEl.scrollTop = logEl.scrollHeight;
        }
      }
      read();
    });
  }
  read();
}

function buildOptimizeKpis(d) {
  const briefs = d.briefs || [];
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const pendingPages = briefs.filter(b =>
    (b.proposed_changes || []).some(c => c.status === 'pending')
  ).length;

  const approvedChanges = briefs
    .flatMap(b => b.proposed_changes || [])
    .filter(c => c.status === 'approved').length;

  const optimizedThisMonth = briefs.filter(b => {
    const changes = b.proposed_changes || [];
    return changes.some(c => c.status === 'applied')
      && !changes.some(c => c.status === 'approved')
      && new Date(b.generated_at) >= monthStart;
  }).length;

  const allTV = briefs.flatMap(b => (b.competitors || []).map(c => (c.traffic_value || 0) / 100));
  const avgTV = allTV.length ? Math.round(allTV.reduce((s, v) => s + v, 0) / allTV.length) : 0;

  return [
    { label: 'Pending Review',        value: pendingPages,          color: '#f59e0b' },
    { label: 'Changes Approved',      value: approvedChanges,       color: '#818cf8' },
    { label: 'Optimized This Month',  value: optimizedThisMonth,    color: '#10b981' },
    { label: 'Avg Traffic Value',     value: '$' + avgTV.toLocaleString(), color: '#38bdf8' },
  ];
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtNum(n) {
  if (n == null) return '—';
  return n.toLocaleString();
}
function badge(cls, text) {
  return '<span class="badge badge-' + cls + '">' + text + '</span>';
}
function statusBadge(s) {
  const map = { published:'published', scheduled:'scheduled', draft:'draft', written:'written', briefed:'briefed', pending:'pending', local:'local' };
  return badge(map[s] || 'pending', s || 'unknown');
}

function renderKanban(d) {
  const cols = [
    { key: 'published', label: 'Published' },
    { key: 'scheduled', label: 'Scheduled' },
    { key: 'draft',     label: 'Draft' },
    { key: 'written',   label: 'Written' },
    { key: 'briefed',   label: 'Briefed' },
    { key: 'pending',   label: 'Pending' },
  ];
  const byStatus = {};
  for (const col of cols) byStatus[col.key] = [];
  for (const item of d.pipeline.items) {
    if (byStatus[item.status]) byStatus[item.status].push(item);
  }

  const html = cols.map(col => {
    const items = byStatus[col.key];
    const itemsHtml = items.map(i => {
      const dateStr = i.publishDate ? fmtDate(i.publishDate) : null;
      const dateLine = dateStr && col.key === 'scheduled' ? '<div class="pub-date-scheduled">' + dateStr + '</div>'
                     : dateStr && col.key === 'published'  ? '<div class="pub-date-published">' + dateStr + '</div>'
                     : '';
      return '<div class="kanban-item"><div class="kw">' + esc(i.keyword) + '</div>' +
        dateLine +
        (i.volume ? '<div class="vol">' + fmtNum(i.volume) + '/mo</div>' : '') + '</div>';
    }).join('');
    return '<div class="kanban-col col-' + col.key + '">' +
      '<div class="kanban-head">' + col.label + '</div>' +
      '<div class="kanban-count">' + items.length + '</div>' +
      (items.length ? '<div class="kanban-items">' + itemsHtml + '</div>' : '') +
      '</div>';
  }).join('');

  document.getElementById('kanban').innerHTML = html;
  document.getElementById('pipeline-note').textContent = d.pipeline.items.length + ' total calendar items';
}

let rankPage    = 0;
let rankSearch  = '';
let rankSort    = { col: null, dir: null };
let rankFilters = { position: 'all', change: 'all', volume: 'all', tier: 'all' };
const RANK_PAGE_SIZE = 10;

function sortRankBy(col) {
  if (rankSort.col === col) {
    if (rankSort.dir === 'asc') { rankSort.dir = 'desc'; }
    else if (rankSort.dir === 'desc') { rankSort.col = null; rankSort.dir = null; }
    else { rankSort.dir = 'asc'; }
  } else {
    rankSort.col = col; rankSort.dir = 'asc';
  }
  rankPage = 0;
  renderRankings(data);
}

function toggleRankMenu(key) {
  const el = document.getElementById('rmenu-' + key);
  if (!el) return;
  const wasOpen = el.classList.contains('open');
  ['position', 'change', 'volume', 'tier'].forEach(function(k) {
    const m = document.getElementById('rmenu-' + k);
    if (m) m.classList.remove('open');
  });
  if (!wasOpen) el.classList.add('open');
}

function setRankFilter(key, val) {
  rankFilters[key] = val;
  rankPage = 0;
  const el = document.getElementById('rmenu-' + key);
  if (el) el.classList.remove('open');
  renderRankings(data);
}

document.addEventListener('click', function(e) {
  if (!e.target.closest('.th-filter-wrap')) {
    ['position', 'change', 'volume', 'tier'].forEach(function(k) {
      const m = document.getElementById('rmenu-' + k);
      if (m) m.classList.remove('open');
    });
  }
});

function renderRankings(d) {
  const r = d.rankings;
  if (!r.items.length) {
    document.getElementById('rankings-table').innerHTML = '<div class="empty">No rank snapshots yet. Run <code>npm run rank-tracker</code> to generate one.</div>';
    return;
  }

  const note = r.latestDate ? r.latestDate + (r.previousDate ? ' vs ' + r.previousDate : '') : '';
  document.getElementById('rank-note').textContent = note;

  const tierBadge = function(t) {
    if (t === 'page1')     return badge('page1', 'Page 1');
    if (t === 'quickWins') return badge('quickwins', 'Quick Win');
    if (t === 'needsWork') return badge('needswork-rank', 'Needs Work');
    return badge('notranking', 'Not Ranking');
  };

  const changeHtml = function(x) {
    if (x.change == null) return '<span class="muted">&#8212;</span>';
    if (x.change > 0) return '<span class="change change-up">&#8593; ' + x.change + '</span>';
    if (x.change < 0) return '<span class="change change-down">&#8595; ' + Math.abs(x.change) + '</span>';
    return '<span class="change change-flat">&#8594; 0</span>';
  };

  // ── apply search ──
  const q = rankSearch.toLowerCase();
  let items = q ? r.items.filter(function(x) { return x.keyword.toLowerCase().indexOf(q) !== -1; }) : r.items.slice();

  // ── apply filters ──
  if (rankFilters.position !== 'all') {
    items = items.filter(function(x) {
      if (rankFilters.position === 'top3')     return x.position != null && x.position <= 3;
      if (rankFilters.position === 'top10')    return x.position != null && x.position <= 10;
      if (rankFilters.position === 'top20')    return x.position != null && x.position <= 20;
      if (rankFilters.position === 'beyond20') return x.position != null && x.position > 20;
      if (rankFilters.position === 'norank')   return x.position == null;
      return true;
    });
  }
  if (rankFilters.change !== 'all') {
    items = items.filter(function(x) {
      if (rankFilters.change === 'improved') return x.change != null && x.change > 0;
      if (rankFilters.change === 'declined') return x.change != null && x.change < 0;
      if (rankFilters.change === 'flat')     return x.change != null && x.change === 0;
      if (rankFilters.change === 'new')      return x.change == null && x.position != null;
      return true;
    });
  }
  if (rankFilters.volume !== 'all') {
    items = items.filter(function(x) {
      if (rankFilters.volume === 'high') return (x.volume || 0) >= 1000;
      if (rankFilters.volume === 'med')  return (x.volume || 0) >= 100 && (x.volume || 0) < 1000;
      if (rankFilters.volume === 'low')  return (x.volume || 0) < 100;
      return true;
    });
  }
  if (rankFilters.tier !== 'all') {
    items = items.filter(function(x) { return x.tier === rankFilters.tier; });
  }

  // ── apply sort ──
  if (rankSort.col) {
    const dir = rankSort.dir === 'asc' ? 1 : -1;
    items = items.slice().sort(function(a, b) {
      if (rankSort.col === 'keyword') {
        return dir * a.keyword.localeCompare(b.keyword);
      }
      if (rankSort.col === 'position') {
        if (a.position == null && b.position == null) return 0;
        if (a.position == null) return 1;
        if (b.position == null) return -1;
        return dir * (a.position - b.position);
      }
      if (rankSort.col === 'change') {
        const ac = a.change != null ? a.change : -999;
        const bc = b.change != null ? b.change : -999;
        return dir * (ac - bc);
      }
      if (rankSort.col === 'volume') {
        return dir * ((a.volume || 0) - (b.volume || 0));
      }
      if (rankSort.col === 'tier') {
        const order = { page1: 0, quickWins: 1, needsWork: 2, notRanking: 3 };
        return dir * ((order[a.tier] || 0) - (order[b.tier] || 0));
      }
      return 0;
    });
  }

  // ── paginate ──
  const totalPages = Math.max(1, Math.ceil(items.length / RANK_PAGE_SIZE));
  rankPage = Math.max(0, Math.min(rankPage, totalPages - 1));
  const pageItems = items.slice(rankPage * RANK_PAGE_SIZE, (rankPage + 1) * RANK_PAGE_SIZE);

  // ── active filter chips ──
  const chipLabels = {
    position: { top3: 'Pos: Top 3', top10: 'Pos: Top 10', top20: 'Pos: Top 20', beyond20: 'Pos: 20+', norank: 'Pos: Not ranking' },
    change:   { improved: 'Change: Improved', declined: 'Change: Declined', flat: 'Change: Flat', new: 'Change: New' },
    volume:   { high: 'Vol: High', med: 'Vol: Med', low: 'Vol: Low' },
    tier:     { page1: 'Tier: Page 1', quickWins: 'Tier: Quick Win', needsWork: 'Tier: Needs Work', notRanking: 'Tier: Not Ranking' },
  };
  const chips = Object.keys(rankFilters).filter(function(k) { return rankFilters[k] !== 'all'; }).map(function(k) {
    const label = (chipLabels[k] || {})[rankFilters[k]] || rankFilters[k];
    return '<span class="filter-chip">' + label + '<span class="filter-chip-x" onclick="setRankFilter(&#39;' + k + '&#39;,&#39;all&#39;)">&#215;</span></span>';
  }).join('');
  const chipsHtml = chips ? '<div class="filter-chips">' + chips + '</div>' : '';

  // ── search bar ──
  const searchBar = '<div style="margin-bottom:8px"><input id="rank-search-input" type="text" placeholder="Search keywords..." value="' + esc(rankSearch) + '" oninput="rankSearch=this.value;rankPage=0;renderRankings(data)" style="width:100%;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-family:inherit;box-sizing:border-box" /></div>';

  // ── column header builder ──
  function thHtml(label, sortCol, filterKey, filterOpts) {
    const sortInd = rankSort.col === sortCol ? (rankSort.dir === 'asc' ? ' &#8593;' : ' &#8595;') : '';
    const sortAttr = sortCol ? ' class="th-sort" onclick="sortRankBy(&#39;' + sortCol + '&#39;)"' : '';
    let filterHtml = '';
    if (filterKey) {
      const isActive = rankFilters[filterKey] !== 'all';
      const opts = filterOpts.map(function(o) {
        const sel = rankFilters[filterKey] === o.val ? ' selected' : '';
        return '<div class="th-filter-opt' + sel + '" onclick="event.stopPropagation();setRankFilter(&#39;' + filterKey + '&#39;,&#39;' + o.val + '&#39;)">' + o.label + '</div>';
      }).join('');
      filterHtml = '<div class="th-filter-wrap">' +
        '<span class="th-filter-btn' + (isActive ? ' active' : '') + '" onclick="event.stopPropagation();toggleRankMenu(&#39;' + filterKey + '&#39;)">&#9660;</span>' +
        '<div id="rmenu-' + filterKey + '" class="th-filter-menu">' + opts + '</div>' +
        '</div>';
    }
    return '<th><div class="th-inner"><span' + sortAttr + '>' + label + sortInd + '</span>' + filterHtml + '</div></th>';
  }

  const posOpts = [
    { val: 'all', label: 'All' }, { val: 'top3', label: 'Top 3' }, { val: 'top10', label: 'Top 10' },
    { val: 'top20', label: 'Top 20' }, { val: 'beyond20', label: '20+' }, { val: 'norank', label: 'Not ranking' },
  ];
  const chgOpts = [
    { val: 'all', label: 'All' }, { val: 'improved', label: 'Improved' },
    { val: 'declined', label: 'Declined' }, { val: 'flat', label: 'No change' }, { val: 'new', label: 'New entry' },
  ];
  const volOpts = [
    { val: 'all', label: 'All' }, { val: 'high', label: 'High (1k+)' },
    { val: 'med', label: 'Med (100-999)' }, { val: 'low', label: 'Low (<100)' },
  ];
  const tierOpts = [
    { val: 'all', label: 'All' }, { val: 'page1', label: 'Page 1' },
    { val: 'quickWins', label: 'Quick Win' }, { val: 'needsWork', label: 'Needs Work' }, { val: 'notRanking', label: 'Not Ranking' },
  ];

  const rows = pageItems.map(function(x, i) {
    const globalIdx = r.items.indexOf(x);
    const idxRef = globalIdx !== -1 ? globalIdx : rankPage * RANK_PAGE_SIZE + i;
    return '<tr style="cursor:pointer" onclick="openKeywordCard(data.rankings.items[' + idxRef + '])">' +
      '<td>' + esc(x.keyword) + (x.tracked ? ' <span class="muted" style="font-size:10px">&#9679;</span>' : '') + '</td>' +
      '<td class="nowrap"><span class="pos">' + (x.position != null ? '#' + x.position : '&#8212;') + '</span></td>' +
      '<td class="nowrap">' + changeHtml(x) + (x.previousPosition != null ? '<span class="muted" style="font-size:11px;margin-left:4px">was #' + x.previousPosition + '</span>' : '') + '</td>' +
      '<td class="nowrap muted">' + fmtNum(x.volume) + '</td>' +
      '<td>' + tierBadge(x.tier) + '</td>' +
      '</tr>';
  }).join('');

  const pagination =
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;font-size:13px;">' +
    '<button onclick="rankPage--;renderRankings(data)" ' + (rankPage === 0 ? 'disabled' : '') + ' style="padding:4px 12px;cursor:pointer;border:1px solid #d1d5db;border-radius:4px;background:#fff;">&#8592; Prev</button>' +
    '<span class="muted">Page ' + (rankPage + 1) + ' of ' + totalPages + ' (' + items.length + ' keywords)</span>' +
    '<button onclick="rankPage++;renderRankings(data)" ' + (rankPage >= totalPages - 1 ? 'disabled' : '') + ' style="padding:4px 12px;cursor:pointer;border:1px solid #d1d5db;border-radius:4px;background:#fff;">Next &#8594;</button>' +
    '</div>';

  document.getElementById('rankings-table').innerHTML =
    searchBar + chipsHtml +
    '<table><thead><tr>' +
    thHtml('Keyword', 'keyword', null, []) +
    thHtml('Position', 'position', 'position', posOpts) +
    thHtml('Change', 'change', 'change', chgOpts) +
    thHtml('Volume', 'volume', 'volume', volOpts) +
    thHtml('Tier', 'tier', 'tier', tierOpts) +
    '</tr></thead><tbody>' + rows + '</tbody></table>' + pagination;
}

let postsPage = 0;
const POSTS_PAGE_SIZE = 10;

function openImageModal(src) {
  closeImageModal();
  const ov = document.createElement('div');
  ov.id = 'img-modal-overlay';
  ov.onclick = closeImageModal;
  const img = document.createElement('img');
  img.src = src;
  img.onclick = function(e) { e.stopPropagation(); };
  ov.appendChild(img);
  document.body.appendChild(ov);
  document.addEventListener('keydown', _imgModalKey);
}
function closeImageModal() {
  const ov = document.getElementById('img-modal-overlay');
  if (ov) ov.remove();
  document.removeEventListener('keydown', _imgModalKey);
}
function _imgModalKey(e) {
  if (e.key === 'Escape') closeImageModal();
}

function renderPosts(d) {
  if (!d.posts.length) {
    document.getElementById('posts-table').innerHTML = '<div class="empty">No posts found.</div>';
    return;
  }
  const totalPages = Math.max(1, Math.ceil(d.posts.length / POSTS_PAGE_SIZE));
  postsPage = Math.max(0, Math.min(postsPage, totalPages - 1));
  document.getElementById('posts-note').textContent = d.posts.length + ' posts';

  const pageItems = d.posts.slice(postsPage * POSTS_PAGE_SIZE, (postsPage + 1) * POSTS_PAGE_SIZE);

  const rows = pageItems.map(function(p) {
    const titleHtml = p.shopifyUrl
      ? '<a class="link" href="' + p.shopifyUrl + '" target="_blank">' + esc(p.title || p.slug) + '</a>'
      : esc(p.title || p.slug);
    const editorHtml = p.editorVerdict === 'Approved'
      ? badge('approved', 'Approved')
      : p.editorVerdict === 'Needs Work'
      ? badge('needswork', '&#9888; Needs Work')
      : '<span class="muted">&#8212;</span>';
    const linksHtml = p.brokenLinks > 0
      ? '<span style="color:var(--red);font-weight:600">' + p.brokenLinks + ' broken</span>'
      : '<span class="muted">&#8212;</span>';
    let imgHtml;
    if (p.hasImage) {
      const imgSrc = p.shopifyImageUrl || ('/images/' + p.slug);
      imgHtml = '<a href="#" onclick="event.preventDefault();openImageModal(&#39;' + esc(imgSrc) + '&#39;)" title="View image" style="font-size:16px;text-decoration:none">&#128444;</a>';
    } else {
      imgHtml = '<span class="muted">&#8212;</span>';
    }
    const dateHtml = p.status === 'scheduled' && p.publishAt
      ? fmtDate(p.publishAt)
      : fmtDate(p.uploadedAt);

    return '<tr>' +
      '<td>' + titleHtml + '</td>' +
      '<td class="muted">' + (p.keyword ? esc(p.keyword) : '&#8212;') + '</td>' +
      '<td>' + statusBadge(p.status) + '</td>' +
      '<td class="nowrap muted">' + dateHtml + '</td>' +
      '<td>' + editorHtml + '</td>' +
      '<td class="nowrap">' + linksHtml + '</td>' +
      '<td style="text-align:center">' + imgHtml + '</td>' +
      '</tr>';
  }).join('');

  const pagination =
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;font-size:13px;">' +
    '<button onclick="postsPage--;renderPosts(data)" ' + (postsPage === 0 ? 'disabled' : '') + ' style="padding:4px 12px;cursor:pointer;border:1px solid #d1d5db;border-radius:4px;background:#fff;">&#8592; Prev</button>' +
    '<span class="muted">Page ' + (postsPage + 1) + ' of ' + totalPages + ' (' + d.posts.length + ' posts)</span>' +
    '<button onclick="postsPage++;renderPosts(data)" ' + (postsPage >= totalPages - 1 ? 'disabled' : '') + ' style="padding:4px 12px;cursor:pointer;border:1px solid #d1d5db;border-radius:4px;background:#fff;">Next &#8594;</button>' +
    '</div>';

  document.getElementById('posts-table').innerHTML =
    '<table><thead><tr>' +
    '<th>Title</th><th>Keyword</th><th>Status</th><th>Date</th><th>Editor</th><th>Links</th><th>Image</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>' + pagination;
}

function renderDataNeeded(d) {
  const items = d.pendingAhrefsData || [];
  const card  = document.getElementById('data-needed-card');
  const body  = document.getElementById('data-needed-body');
  const count = document.getElementById('data-needed-count');

  if (!items.length) {
    card.style.display = 'none';
    return;
  }

  card.style.display = '';
  count.textContent = items.length;

  body.innerHTML = items.map(item => {
    const fileChecks = [
      { label: 'SERP Overview',  present: item.hasSerp },
      { label: 'Matching Terms', present: item.hasKeywords },
      { label: 'Volume History', present: item.hasHistory },
    ];
    const fileTags = fileChecks.map(f =>
      '<span class="file-tag ' + (f.present ? 'file-tag-present' : 'file-tag-missing') + '">' +
      (f.present ? '✓ ' : '✗ ') + f.label + '</span>'
    ).join('');

    return '<div class="data-item">' +
      '<div class="data-item-header">' +
        '<span class="data-item-keyword">' + esc(item.keyword) + '</span>' +
        '<span class="data-item-date">Scheduled ' + fmtDate(item.publishDate) + '</span>' +
      '</div>' +
      '<div class="data-item-dir">' + esc(item.dir) + '</div>' +
      '<div class="data-item-files">' + fileTags + '</div>' +
      '<div class="data-instructions">' +
        'In Ahrefs Keywords Explorer → search "<strong>' + esc(item.keyword) + '</strong>" →<br>' +
        (!item.hasSerp     ? '&nbsp;• <strong>SERP Overview</strong> tab → Export → save to folder above<br>' : '') +
        (!item.hasKeywords ? '&nbsp;• <strong>Matching Terms</strong> tab → Export (vol ≥100, KD ≤40) → save to folder above<br>' : '') +
        (!item.hasHistory  ? '&nbsp;• <em>Optional:</em> Overview → Volume History chart → Export → save to folder above<br>' : '') +
      '</div>' +
    '</div>';
  }).join('');
}

let croFilter = 'today';

function setCroFilter(name, btn) {
  croFilter = name;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (data) renderCROTab(data);
  loadCampaignCards();
}

function aggregateClarity(snaps) {
  if (!snaps || !snaps.length) return null;
  if (snaps.length === 1) return snaps[0];
  const avg = (fn) => { const vals = snaps.map(fn).filter(v => v != null); return vals.length ? vals.reduce((s,v)=>s+v,0)/vals.length : null; };
  const sum = (fn) => snaps.reduce((s,x) => s + (fn(x)||0), 0);
  const mergeByName = (fn) => {
    const map = {};
    snaps.forEach(x => (fn(x)||[]).forEach(d => { map[d.name] = (map[d.name]||0) + d.sessions; }));
    return Object.entries(map).sort((a,b)=>b[1]-a[1]).map(([name,sessions])=>({name,sessions}));
  };
  const pageMap = {};
  snaps.forEach(x => (x.topPages||[]).forEach(p => { pageMap[p.title] = (pageMap[p.title]||0) + p.sessions; }));
  return {
    date: snaps.length + ' days',
    sessions: { total: sum(x=>x.sessions?.total), bots: sum(x=>x.sessions?.bots), real: sum(x=>x.sessions?.real),
      distinctUsers: sum(x=>x.sessions?.distinctUsers), pagesPerSession: avg(x=>x.sessions?.pagesPerSession) },
    engagement: { totalTime: avg(x=>x.engagement?.totalTime), activeTime: avg(x=>x.engagement?.activeTime) },
    behavior: { scrollDepth: avg(x=>x.behavior?.scrollDepth), rageClickPct: avg(x=>x.behavior?.rageClickPct),
      deadClickPct: avg(x=>x.behavior?.deadClickPct), scriptErrorPct: avg(x=>x.behavior?.scriptErrorPct),
      quickbackPct: avg(x=>x.behavior?.quickbackPct), excessiveScrollPct: avg(x=>x.behavior?.excessiveScrollPct) },
    devices: mergeByName(x=>x.devices),
    countries: mergeByName(x=>x.countries),
    topPages: Object.entries(pageMap).sort((a,b)=>b[1]-a[1]).map(([title,sessions])=>({title,sessions})),
  };
}

function aggregateShopify(snaps) {
  if (!snaps || !snaps.length) return null;
  if (snaps.length === 1) return snaps[0];
  const totalOrders   = snaps.reduce((s,x)=>s+(x.orders?.count||0),0);
  const totalRevenue  = snaps.reduce((s,x)=>s+(x.orders?.revenue||0),0);
  const totalAbandoned = snaps.reduce((s,x)=>s+(x.abandonedCheckouts?.count||0),0);
  const productMap = {};
  snaps.forEach(x => (x.topProducts||[]).forEach(p => {
    if (!productMap[p.title]) productMap[p.title] = {revenue:0,orders:0};
    productMap[p.title].revenue += p.revenue||0;
    productMap[p.title].orders  += p.orders||0;
  }));
  const topProducts = Object.entries(productMap).sort((a,b)=>b[1].revenue-a[1].revenue).slice(0,5).map(([title,v])=>({title,...v}));
  return {
    date: snaps.length + ' days',
    orders: { count: totalOrders, revenue: totalRevenue, aov: totalOrders > 0 ? totalRevenue / totalOrders : 0 },
    abandonedCheckouts: { count: totalAbandoned },
    cartAbandonmentRate: (totalAbandoned + totalOrders) > 0 ? totalAbandoned / (totalAbandoned + totalOrders) : 0,
    topProducts,
  };
}

function aggregateGSC(snaps) {
  if (!snaps || !snaps.length) return null;
  if (snaps.length === 1) return snaps[0];
  const totalClicks      = snaps.reduce((s, x) => s + (x.summary?.clicks || 0), 0);
  const totalImpressions = snaps.reduce((s, x) => s + (x.summary?.impressions || 0), 0);
  const queryMap = {};
  snaps.forEach(x => (x.topQueries || []).forEach(q => {
    if (!queryMap[q.query]) queryMap[q.query] = { clicks: 0, impressions: 0, posWt: 0 };
    queryMap[q.query].clicks      += q.clicks || 0;
    queryMap[q.query].impressions += q.impressions || 0;
    queryMap[q.query].posWt       += (q.position || 0) * (q.impressions || 0);
  }));
  const topQueries = Object.entries(queryMap)
    .sort((a, b) => b[1].clicks - a[1].clicks).slice(0, 10)
    .map(([query, v]) => ({
      query, clicks: v.clicks, impressions: v.impressions,
      ctr:      v.impressions > 0 ? Math.round(v.clicks / v.impressions * 10000) / 10000 : 0,
      position: v.impressions > 0 ? Math.round(v.posWt / v.impressions * 10) / 10 : null,
    }));
  const qTotalImpressions = Object.values(queryMap).reduce((s, v) => s + v.impressions, 0);
  const weightedPos = qTotalImpressions > 0
    ? Object.values(queryMap).reduce((s, v) => s + v.posWt, 0) / qTotalImpressions
    : null;
  const pageMap = {};
  snaps.forEach(x => (x.topPages || []).forEach(p => {
    if (!pageMap[p.page]) pageMap[p.page] = { clicks: 0, impressions: 0, posWt: 0 };
    pageMap[p.page].clicks      += p.clicks || 0;
    pageMap[p.page].impressions += p.impressions || 0;
    pageMap[p.page].posWt       += (p.position || 0) * (p.impressions || 0);
  }));
  const topPages = Object.entries(pageMap)
    .sort((a, b) => b[1].clicks - a[1].clicks).slice(0, 10)
    .map(([page, v]) => ({
      page, clicks: v.clicks, impressions: v.impressions,
      ctr:      v.impressions > 0 ? Math.round(v.clicks / v.impressions * 10000) / 10000 : 0,
      position: v.impressions > 0 ? Math.round(v.posWt / v.impressions * 10) / 10 : null,
    }));
  return {
    date: snaps.length + ' days',
    summary: { clicks: totalClicks, impressions: totalImpressions,
      ctr: totalImpressions > 0 ? Math.round(totalClicks / totalImpressions * 10000) / 10000 : 0,
      position: weightedPos != null ? Math.round(weightedPos * 10) / 10 : null },
    topQueries, topPages,
  };
}

function aggregateGA4(snaps) {
  if (!snaps || !snaps.length) return null;
  if (snaps.length === 1) return snaps[0];
  const totalSessions    = snaps.reduce((s, x) => s + (x.sessions || 0), 0);
  const totalUsers       = snaps.reduce((s, x) => s + (x.users || 0), 0);
  const totalNewUsers    = snaps.reduce((s, x) => s + (x.newUsers || 0), 0);
  const totalConversions = snaps.reduce((s, x) => s + (x.conversions || 0), 0);
  const totalRevenue     = snaps.reduce((s, x) => s + (x.revenue || 0), 0);
  const active = snaps.filter(x => x.sessions > 0);
  const activeSess = active.reduce((s, x) => s + x.sessions, 0);
  const bounceRate        = activeSess > 0 ? active.reduce((s, x) => s + x.bounceRate * x.sessions, 0) / activeSess : null;
  const avgSessionDuration = activeSess > 0 ? active.reduce((s, x) => s + x.avgSessionDuration * x.sessions, 0) / activeSess : null;
  const sourceMap = {};
  snaps.forEach(x => (x.topSources || []).forEach(s => {
    const k = s.source + '/' + s.medium;
    if (!sourceMap[k]) sourceMap[k] = { source: s.source, medium: s.medium, sessions: 0, conversions: 0, revenue: 0 };
    sourceMap[k].sessions    += s.sessions || 0;
    sourceMap[k].conversions += s.conversions || 0;
    sourceMap[k].revenue     += s.revenue || 0;
  }));
  const topSources = Object.values(sourceMap).sort((a, b) => b.sessions - a.sessions).slice(0, 5);
  const pageMap = {};
  snaps.forEach(x => (x.topLandingPages || []).forEach(p => {
    if (!pageMap[p.page]) pageMap[p.page] = { page: p.page, sessions: 0, conversions: 0, revenue: 0 };
    pageMap[p.page].sessions    += p.sessions || 0;
    pageMap[p.page].conversions += p.conversions || 0;
    pageMap[p.page].revenue     += p.revenue || 0;
  }));
  const topLandingPages = Object.values(pageMap).sort((a, b) => b.sessions - a.sessions).slice(0, 5);
  return {
    date: snaps.length + ' days',
    sessions: totalSessions, users: totalUsers, newUsers: totalNewUsers,
    bounceRate: bounceRate != null ? Math.round(bounceRate * 1000) / 1000 : null,
    avgSessionDuration: avgSessionDuration != null ? Math.round(avgSessionDuration) : null,
    conversions: totalConversions,
    conversionRate: totalSessions > 0 ? Math.round(totalConversions / totalSessions * 1000) / 1000 : 0,
    revenue: Math.round(totalRevenue * 100) / 100,
    topSources, topLandingPages,
  };
}

function renderGSCSEOPanel(data) {
  const gscAll = data.cro?.gscAll || [];
  const gsc  = gscAll[0] || null;
  const pgsc = gscAll[1] || null;

  const fmtPos = v => v != null ? v.toFixed(1) : '—';
  const fmtPct = v => v != null ? (v * 100).toFixed(1) + '%' : '—';
  const deltaStr = (curr, prev, higherBetter) => {
    if (curr == null || prev == null) return '';
    const d = curr - prev;
    if (Math.abs(d) < 0.001) return '';
    const up = d > 0;
    const good = higherBetter ? up : !up;
    const color = good ? 'var(--green)' : 'var(--red)';
    const sign = up ? '+' : '';
    return ' <span style="font-size:10px;color:' + color + '">' + sign + (Math.abs(d) < 1 ? d.toFixed(2) : Math.round(d)) + '</span>';
  };

  const noteEl = document.getElementById('gsc-seo-note');
  const bodyEl = document.getElementById('gsc-seo-body');
  if (noteEl) noteEl.textContent = gsc ? esc(gsc.date) : '';

  if (!gsc) {
    bodyEl.innerHTML = '<p class="empty-state">No GSC data yet — run gsc-collector to get started.</p>';
    return;
  }

  const s = gsc.summary;
  if (!s) {
    bodyEl.innerHTML = '<p class="empty-state">GSC data is incomplete.</p>';
    return;
  }
  const ps = pgsc?.summary;

  let html = '<div class="gsc-summary">' +
    '<div class="gsc-stat"><span class="gsc-stat-value">' + fmtNum(s.clicks) + deltaStr(s.clicks, ps?.clicks, true) + '</span><span class="gsc-stat-label">Clicks</span></div>' +
    '<div class="gsc-stat"><span class="gsc-stat-value">' + fmtNum(s.impressions) + deltaStr(s.impressions, ps?.impressions, true) + '</span><span class="gsc-stat-label">Impressions</span></div>' +
    '<div class="gsc-stat"><span class="gsc-stat-value">' + fmtPct(s.ctr) + deltaStr(s.ctr, ps?.ctr, true) + '</span><span class="gsc-stat-label">CTR</span></div>' +
    '<div class="gsc-stat"><span class="gsc-stat-value">' + fmtPos(s.position) + deltaStr(s.position != null ? -s.position : null, ps?.position != null ? -ps.position : null, true) + '</span><span class="gsc-stat-label">Avg Position</span></div>' +
    '</div>';

  html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:24px">';

  html += '<div><div style="font-size:11px;font-weight:600;margin-bottom:8px">Top Queries</div>' +
    '<table class="gsc-table"><thead><tr><th>Query</th><th>Clicks</th><th>Impr</th><th>CTR</th><th>Pos</th></tr></thead><tbody>' +
    (gsc.topQueries || []).map(q =>
      '<tr><td>' + esc((q.query || '').length > 40 ? (q.query || '').slice(0,40) + '...' : (q.query || '')) + '</td>' +
      '<td>' + esc(String(q.clicks)) + '</td><td>' + esc(String(q.impressions)) + '</td>' +
      '<td>' + fmtPct(q.ctr) + '</td><td>' + fmtPos(q.position) + '</td></tr>'
    ).join('') +
    '</tbody></table></div>';

  html += '<div><div style="font-size:11px;font-weight:600;margin-bottom:8px">Top Pages</div>' +
    '<table class="gsc-table"><thead><tr><th>Page</th><th>Clicks</th><th>Impr</th><th>CTR</th><th>Pos</th></tr></thead><tbody>' +
    (gsc.topPages || []).map(p => {
      const slug = p.page.replace(/^https?:\\/\\/[^/]+/, '').slice(0, 35) || '/';
      return '<tr><td title="' + esc(p.page) + '">' + esc(slug) + '</td>' +
        '<td>' + esc(String(p.clicks)) + '</td><td>' + esc(String(p.impressions)) + '</td>' +
        '<td>' + fmtPct(p.ctr) + '</td><td>' + fmtPos(p.position) + '</td></tr>';
    }).join('') +
    '</tbody></table></div>';

  html += '</div>';
  bodyEl.innerHTML = html;
}

var briefItemContents = [];

function prioColor(p) { return p === 'HIGH' ? '#dc2626' : p === 'MED' ? '#d97706' : '#6b7280'; }

function openBriefModal(idx) {
  var item = briefItemContents[idx];
  if (!item) return;
  var bodyText = item.body.join('\\n');
  var bodyHtml = esc(bodyText).replace(/[*][*]([^*]+)[*][*]/g, '<strong>$1</strong>');
  var sections = bodyHtml.split('\\n');
  var out = '';
  var inPre = false;
  for (var si = 0; si < sections.length; si++) {
    var sl = sections[si];
    var isTableRow = sl.trim().charAt(0) === '|';
    if (isTableRow && !inPre) { out += '<pre style="font-size:12px;line-height:1.5;overflow-x:auto;background:#f9fafb;border-radius:6px;padding:10px 12px;margin:8px 0">'; inPre = true; }
    if (!isTableRow && inPre) { out += '</pre>'; inPre = false; }
    if (isTableRow) {
      out += sl + '\\n';
    } else if (sl.trim()) {
      out += '<p style="margin:6px 0;font-size:13px;line-height:1.6">' + sl + '</p>';
    }
  }
  if (inPre) out += '</pre>';
  var prioLabel = item.priority ? '<span style="font-size:11px;font-weight:700;color:' + prioColor(item.priority) + ';text-transform:uppercase;letter-spacing:.06em;margin-right:8px">' + item.priority + '</span>' : '';
  document.getElementById('brief-modal-content').innerHTML =
    '<div style="margin-bottom:16px;padding-bottom:16px;border-bottom:1px solid #e5e7eb">' + prioLabel +
    '<span style="font-size:16px;font-weight:700;color:#1f2937">' + esc(item.title) + '</span></div>' +
    out;
  document.getElementById('brief-modal-overlay').style.display = 'flex';
}

function closeBriefModal(e) {
  if (e && e.target !== document.getElementById('brief-modal-overlay')) return;
  document.getElementById('brief-modal-overlay').style.display = 'none';
}

function runDeepDive(category, handle, itemTitle) {
    var agentMap = {
      'content-formatting': 'agents/cro-deep-dive-content/index.js',
      'seo-discovery':      'agents/cro-deep-dive-seo/index.js',
      'trust-conversion':   'agents/cro-deep-dive-trust/index.js',
    };
    var agent = agentMap[category];
    if (!agent) return;
    runAgent(agent, ['--handle', handle, '--item', itemTitle]);
  }

function renderCROTab(data) {
  const cro = data.cro || {};
  const clarityAll = cro.clarityAll || [];
  const shopifyAll = cro.shopifyAll || [];

  const gscAll = cro.gscAll || [];
  const ga4All = cro.ga4All || [];

  let cl, sh, ga4, gsc, pcl, psh, pga4, pgsc, dateLabel;
  if (croFilter === 'yesterday') {
    cl = clarityAll[1] || null; pcl = clarityAll[2] || null;
    sh = shopifyAll[1] || null; psh = shopifyAll[2] || null;
    ga4 = ga4All[1] || null;   pga4 = ga4All[2] || null;
    gsc = gscAll[1] || null;   pgsc = gscAll[2] || null;
    dateLabel = 'Yesterday';
  } else if (croFilter === '7days') {
    cl  = aggregateClarity(clarityAll.slice(0,7));   pcl  = aggregateClarity(clarityAll.slice(7,14));
    sh  = aggregateShopify(shopifyAll.slice(0,7));   psh  = aggregateShopify(shopifyAll.slice(7,14));
    ga4 = aggregateGA4(ga4All.slice(0,7));           pga4 = aggregateGA4(ga4All.slice(7,14));
    gsc = aggregateGSC(gscAll.slice(0,7));           pgsc = aggregateGSC(gscAll.slice(7,14));
    dateLabel = 'Last 7 Days';
  } else if (croFilter === '30days') {
    cl  = aggregateClarity(clarityAll.slice(0,30));  pcl  = aggregateClarity(clarityAll.slice(30,60));
    sh  = aggregateShopify(shopifyAll.slice(0,30));  psh  = aggregateShopify(shopifyAll.slice(30,60));
    ga4 = aggregateGA4(ga4All.slice(0,30));          pga4 = aggregateGA4(ga4All.slice(30,60));
    gsc = aggregateGSC(gscAll.slice(0,30));          pgsc = aggregateGSC(gscAll.slice(30,60));
    dateLabel = 'Last 30 Days';
  } else {
    cl = clarityAll[0] || null; pcl = clarityAll[1] || null;
    sh = shopifyAll[0] || null; psh = shopifyAll[1] || null;
    ga4 = ga4All[0] || null;   pga4 = ga4All[1] || null;
    gsc = gscAll[0] || null;   pgsc = gscAll[1] || null;
    dateLabel = 'Today';
  }

  // ── helpers ────────────────────────────────────────────────────────────────
  const fmtPct = v => v != null ? v.toFixed(1) + '%' : '—';
  const fmtDollar = v => v != null ? '$' + Math.round(v).toLocaleString() : '—';
  const delta = (curr, prev, higherIsBetter = true) => {
    if (curr == null || prev == null) return '<span class="kpi-delta flat">—</span>';
    const diff = curr - prev;
    const dir = diff > 0 ? (higherIsBetter ? 'up' : 'down') : diff < 0 ? (higherIsBetter ? 'down' : 'up') : 'flat';
    const sign = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
    const display = Math.abs(diff) < 1 ? Math.abs(diff).toFixed(2) : Math.round(Math.abs(diff));
    return '<span class="kpi-delta ' + dir + '">' + sign + ' ' + display + '</span>';
  };

  // ── KPI strip ──────────────────────────────────────────────────────────────
  const kpis = [
    { label: 'Conversion Rate', value: ga4 ? fmtPct(ga4.conversionRate * 100) : '—',
      d: delta(ga4?.conversionRate != null ? ga4.conversionRate * 100 : null,
               pga4?.conversionRate != null ? pga4.conversionRate * 100 : null), alert: false },
    { label: 'Bounce Rate',     value: ga4 ? fmtPct(ga4.bounceRate * 100) : '—',
      d: delta(ga4?.bounceRate != null ? ga4.bounceRate * 100 : null,
               pga4?.bounceRate != null ? pga4.bounceRate * 100 : null, false), alert: false },
    { label: 'Avg Order Value', value: sh ? fmtDollar(sh.orders.aov) : '—',
      d: delta(sh?.orders?.aov, psh?.orders?.aov), alert: false },
    { label: 'Real Sessions',   value: cl ? cl.sessions.real : '—',
      sub: cl ? 'of ' + cl.sessions.total + ' total' : '',
      d: delta(cl?.sessions?.real, pcl?.sessions?.real), alert: false },
    { label: 'Script Errors',   value: cl ? fmtPct(cl.behavior.scriptErrorPct) : '—',
      d: delta(cl?.behavior?.scriptErrorPct, pcl?.behavior?.scriptErrorPct, false),
      alert: cl?.behavior?.scriptErrorPct > 5 },
    { label: 'Scroll Depth',    value: cl ? fmtPct(cl.behavior.scrollDepth) : '—',
      d: delta(cl?.behavior?.scrollDepth, pcl?.behavior?.scrollDepth), alert: false },
    { label: 'Cart Abandon',    value: sh ? fmtPct(sh.cartAbandonmentRate * 100) : '—',
      d: delta(sh?.cartAbandonmentRate != null ? sh.cartAbandonmentRate * 100 : null,
               psh?.cartAbandonmentRate != null ? psh.cartAbandonmentRate * 100 : null, false), alert: false },
  ];

  document.getElementById('cro-kpi-strip').innerHTML =
    '<div class="kpi-strip">' +
    kpis.map(k =>
      '<div class="kpi-card' + (k.alert ? ' alert' : '') + '">' +
      '<div class="kpi-value">' + k.value + '</div>' +
      '<div class="kpi-label">' + k.label + '</div>' +
      (k.sub ? '<div class="cro-sub">' + k.sub + '</div>' : '') +
      k.d +
      '</div>'
    ).join('') +
    '</div>';

  // ── Clarity card ───────────────────────────────────────────────────────────
  const clarityHtml = cl ? (
    '<div class="card">' +
    '<div class="card-header accent-purple"><h2>Clarity</h2><span style="font-size:11px;color:var(--muted)">' + esc(dateLabel) + '</span></div>' +
    '<div class="card-body">' +
    '<table class="cro-table">' +
    '<tr><td>Total Sessions</td><td>' + cl.sessions.total + ' <span class="cro-sub">(' + cl.sessions.bots + ' bots)</span></td></tr>' +
    '<tr><td>Active Engagement</td><td>' + cl.engagement.activeTime + 's <span class="cro-sub">of ' + cl.engagement.totalTime + 's</span></td></tr>' +
    '<tr><td>Device Split</td><td>' + (cl.devices[0] ? esc(cl.devices[0].name) + ': ' + cl.devices[0].sessions : '—') + '</td></tr>' +
    '<tr><td>Top Country</td><td>' + (cl.countries[0] ? esc(cl.countries[0].name) + ' (' + cl.countries[0].sessions + ')' : '—') + '</td></tr>' +
    '<tr><td>Rage Clicks</td><td>' + fmtPct(cl.behavior.rageClickPct) + '</td></tr>' +
    '<tr><td>Dead Clicks</td><td>' + fmtPct(cl.behavior.deadClickPct) + '</td></tr>' +
    '</table>' +
    '<div style="margin-top:12px;font-size:11px;font-weight:600;color:var(--text);margin-bottom:6px">Top Pages</div>' +
    (cl.topPages || []).slice(0, 5).map((p, i) =>
      '<div style="font-size:11px;color:var(--muted);padding:2px 0">' + (i+1) + '. ' + esc(p.title.length > 50 ? p.title.slice(0,50)+'…' : p.title) + ' — ' + p.sessions + '</div>'
    ).join('') +
    '</div></div>'
  ) : '<div class="card"><div class="card-body"><p class="empty-state">No Clarity data collected yet — run clarity-collector to get started.</p></div></div>';

  document.getElementById('cro-clarity-card').innerHTML = clarityHtml;

  // ── Shopify card ───────────────────────────────────────────────────────────
  const shopifyHtml = sh ? (
    '<div class="card">' +
    '<div class="card-header accent-green"><h2>Shopify</h2><span style="font-size:11px;color:var(--muted)">' + esc(dateLabel) + '</span></div>' +
    '<div class="card-body">' +
    '<table class="cro-table">' +
    '<tr><td>Revenue</td><td>' + fmtDollar(sh.orders.revenue) + '</td></tr>' +
    '<tr><td>Orders</td><td>' + sh.orders.count + '</td></tr>' +
    '<tr><td>Avg Order Value</td><td>' + fmtDollar(sh.orders.aov) + '</td></tr>' +
    '<tr><td>Abandoned Carts</td><td>' + sh.abandonedCheckouts.count + '</td></tr>' +
    '<tr><td>Cart Abandon Rate</td><td>' + fmtPct(sh.cartAbandonmentRate * 100) + '</td></tr>' +
    '</table>' +
    '<div style="margin-top:12px;font-size:11px;font-weight:600;color:var(--text);margin-bottom:6px">Top Products</div>' +
    ((sh.topProducts || []).length ? (sh.topProducts || []).slice(0, 5).map((p, i) =>
      '<div style="font-size:11px;color:var(--muted);padding:2px 0">' + (i+1) + '. ' + esc(p.title) + ' — ' + fmtDollar(p.revenue) + ' (' + p.orders + ' orders)</div>'
    ).join('') : '<div style="font-size:11px;color:var(--muted)">No orders today</div>') +
    '</div></div>'
  ) : '<div class="card"><div class="card-body"><p class="empty-state">No Shopify data collected yet — run shopify-collector to get started.</p></div></div>';

  document.getElementById('cro-shopify-card').innerHTML = shopifyHtml;

  // ── GA4 card ────────────────────────────────────────────────────────────────
  const ga4Html = ga4 ? (
    '<div class="card">' +
    '<div class="card-header accent-orange"><h2>GA4</h2><span style="font-size:11px;color:var(--muted)">' + esc(dateLabel) + '</span></div>' +
    '<div class="card-body">' +
    '<table class="cro-table">' +
    '<tr><td>Sessions</td><td>' + fmtNum(ga4.sessions) + '</td></tr>' +
    '<tr><td>Users</td><td>' + fmtNum(ga4.users) + ' <span class="cro-sub">(' + fmtNum(ga4.newUsers) + ' new)</span></td></tr>' +
    '<tr><td>Bounce Rate</td><td>' + (ga4.bounceRate != null ? fmtPct(ga4.bounceRate * 100) : '—') + '</td></tr>' +
    '<tr><td>Avg Session</td><td>' + (ga4.avgSessionDuration != null ? Math.round(ga4.avgSessionDuration) + 's' : '—') + '</td></tr>' +
    '<tr><td>Conversions</td><td>' + fmtNum(ga4.conversions) + ' <span class="cro-sub">(' + fmtPct(ga4.conversionRate * 100) + ')</span></td></tr>' +
    '<tr><td>Revenue</td><td>' + fmtDollar(ga4.revenue) + '</td></tr>' +
    '</table>' +
    '<div style="margin-top:12px;font-size:11px;font-weight:600;color:var(--text);margin-bottom:6px">Top Sources</div>' +
    (ga4.topSources || []).map((s, i) =>
      '<div style="font-size:11px;color:var(--muted);padding:2px 0">' + esc(String(i+1)) + '. ' + esc(s.source) + ' / ' + esc(s.medium) + ' — ' + fmtNum(s.sessions) + ' sessions</div>'
    ).join('') +
    '<div style="margin-top:10px;font-size:11px;font-weight:600;color:var(--text);margin-bottom:6px">Top Landing Pages</div>' +
    (ga4.topLandingPages || []).map((p, i) => {
      const slug = (p.page || '').replace(/^https?:\\/\\/[^/]+/, '').slice(0, 40) || '/';
      return '<div style="font-size:11px;color:var(--muted);padding:2px 0">' + esc(String(i+1)) + '. ' + esc(slug) + ' — ' + fmtDollar(p.revenue) + '</div>';
    }).join('') +
    '</div></div>'
  ) : '<div class="card"><div class="card-body"><p class="empty-state">No GA4 data yet — run ga4-collector to get started.</p></div></div>';

  document.getElementById('cro-ga4-card').innerHTML = ga4Html;

  // ── GSC card (CRO tab) ──────────────────────────────────────────────────────
  const gscCROHtml = gsc ? (
    '<div class="card">' +
    '<div class="card-header accent-sky"><h2>Search Console</h2><span style="font-size:11px;color:var(--muted)">' + esc(dateLabel) + '</span></div>' +
    '<div class="card-body">' +
    '<table class="cro-table">' +
    '<tr><td>Clicks</td><td>' + esc(String(gsc.summary?.clicks ?? '—')) + '</td></tr>' +
    '<tr><td>Impressions</td><td>' + esc(String(gsc.summary?.impressions ?? '—')) + '</td></tr>' +
    '<tr><td>CTR</td><td>' + (gsc.summary?.ctr != null ? (gsc.summary.ctr * 100).toFixed(1) + '%' : '—') + '</td></tr>' +
    '<tr><td>Avg Position</td><td>' + (gsc.summary?.position != null ? gsc.summary.position.toFixed(1) : '—') + '</td></tr>' +
    '</table>' +
    '<div style="margin-top:12px;font-size:11px;font-weight:600;color:var(--text);margin-bottom:6px">Top Queries</div>' +
    (gsc.topQueries || []).slice(0, 5).map((q, i) =>
      '<div style="font-size:11px;color:var(--muted);padding:2px 0">' + esc(String(i+1)) + '. ' + esc((q.query || '').length > 40 ? (q.query || '').slice(0,40) + '...' : (q.query || '')) + ' — ' + esc(String(q.clicks)) + ' clicks</div>'
    ).join('') +
    '</div></div>'
  ) : '<div class="card"><div class="card-body"><p class="empty-state">No GSC data yet — run gsc-collector to get started.</p></div></div>';

  document.getElementById('cro-gsc-card').innerHTML = gscCROHtml;

  // ── CRO Brief ──────────────────────────────────────────────────────────────
  const brief = cro.brief;
  let briefHtml;
  if (!brief) {
    briefHtml = '<div class="card"><div class="card-body"><p class="empty-state">No brief generated yet — run cro-analyzer to generate your first brief.</p></div></div>';
  } else {
    // Parse action items from markdown (lines starting with ### N.)
    var items = [];
    var lines = brief.content.split('\\n');
    var current = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^### [ ]*[0-9]+\./.test(line)) {
        if (current) items.push(current);
        // Extract category and page handle from HTML comment
        var catMatch = line.match(/<!--[ ]*category:(\S+)[ ]+page:(\S+)[ ]*-->/);
        var category = catMatch ? catMatch[1] : null;
        var pageHandle = catMatch ? catMatch[2] : null;
        // Strip comment, then strip priority suffix, then strip "### N. " prefix
        var cleanLine = line
          .replace(/<!--.*?-->/g, '')
          .replace(/[ ]*[—\-][ ]*(HIGH|MED|LOW)[ ]*$/i, '')
          .replace(/^### [ ]*[0-9]+\.[ ]*/, '')
          .trim();
        // Extract priority from original line
        var prioMatch = line.match(/[—\-][ ]*(HIGH|MED|LOW)/i);
        var priority = prioMatch ? prioMatch[1].toUpperCase() : '';
        current = { title: cleanLine, priority: priority, category: category, pageHandle: pageHandle, body: [] };
      } else if (current && line.trim() && !/^##/.test(line)) {
        current.body.push(line.trim());
      }
    }
    if (current) items.push(current);

    // Store items globally so openBriefModal can access full body content
    briefItemContents = items;

    briefHtml = '<div class="card">' +
      '<div class="card-header accent-amber"><h2>AI CRO Brief</h2>' +
      '<span class="section-note">Generated ' + esc(brief.date) + ' · Next run: Every Monday</span></div>' +
      '<div class="card-body">' +
      (items.length ? '<div class="brief-grid">' +
        items.map(function(item, idx) {
          var actions;
          if (item.category && item.pageHandle) {
            var safeTitle = esc(item.title);
            actions = '<div class="brief-item-actions">' +
              '<button class="btn-cro-resolve" onclick="event.stopPropagation();runDeepDive(\\'' + esc(item.category) + '\\', \\'' + esc(item.pageHandle) + '\\', \\'' + safeTitle + '\\')">' +
              'Deep Dive</button>' +
              '</div>';
          } else {
            actions = '<div class="brief-item-actions"><span class="badge-manual">Manual</span></div>';
          }
          return '<div class="brief-item" onclick="openBriefModal(' + idx + ')" style="cursor:pointer" title="Click to expand">' +
            '<div class="brief-item-title" style="color:' + prioColor(item.priority) + '">' +
            (item.priority ? item.priority + ' — ' : '') + esc(item.title) + '</div>' +
            actions +
            '</div>';
        }).join('') + '</div>'
      : '<pre style="font-size:11px;white-space:pre-wrap">' + esc(brief.content) + '</pre>') +
      '</div></div>';
  }

  document.getElementById('cro-brief-card').innerHTML = briefHtml;
}

function renderRankAlertBanner(alert) {
  const el = document.getElementById('rank-alert-banner');
  if (!el) return;
  if (!alert) { el.style.display = 'none'; return; }
  const isNeg = alert.drops > alert.gains;
  el.className = 'alert-banner ' + (isNeg ? 'alert-red' : 'alert-green');
  el.style.display = '';
  el.innerHTML =
    (isNeg ? '🔻' : '🚀') + ' ' +
    '<strong>' + (isNeg ? alert.drops + ' rank drops' : alert.gains + ' rank gains') + ' today</strong> — ' +
    esc(alert.file.replace('.md', '')) +
    '<span class="alert-banner-dismiss" onclick="dismissAlert()">Dismiss ×</span>';
}

async function dismissAlert() {
  await fetch('/dismiss-alert', { method: 'POST' });
  document.getElementById('rank-alert-banner').style.display = 'none';
}

function esc(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function mdToHtml(md) {
  if (!md) return '';
  var s = md.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  var lines = s.split('\\n');
  var out = [];
  var inList = false;
  for (var li = 0; li < lines.length; li++) {
    var ln = lines[li];
    ln = ln.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>');
    ln = ln.replace(/\\*([^*]+)\\*/g,'<em>$1</em>');
    ln = ln.replace(/\`([^\`]+)\`/g,'<code>$1</code>');
    var stripped = ln.replace(/^[ ]*/,'');
    if (stripped.indexOf('### ') === 0) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push('<div class="chat-md-h3">' + stripped.slice(4) + '</div>');
    } else if (stripped.indexOf('## ') === 0) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push('<div class="chat-md-h2">' + stripped.slice(3) + '</div>');
    } else if (stripped.indexOf('# ') === 0) {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push('<div class="chat-md-h2">' + stripped.slice(2) + '</div>');
    } else if (stripped.indexOf('- ') === 0 || stripped.indexOf('* ') === 0) {
      if (!inList) { out.push('<ul class="chat-md-ul">'); inList = true; }
      out.push('<li>' + stripped.slice(2) + '</li>');
    } else if (stripped === '') {
      if (inList) { out.push('</ul>'); inList = false; }
      if (out.length && out[out.length - 1] !== '<div class="chat-md-gap"></div>') {
        out.push('<div class="chat-md-gap"></div>');
      }
    } else {
      if (inList) { out.push('</ul>'); inList = false; }
      out.push('<div>' + ln + '</div>');
    }
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

function kpiCard(label, value, sub) {
  return '<div class="kpi-card">' +
    '<div class="kpi-value">' + esc(String(value)) + '</div>' +
    '<div class="kpi-label">' + esc(label) + '</div>' +
    (sub ? '<div class="cro-sub">' + esc(sub) + '</div>' : '') +
    '</div>';
}

async function renderAdIntelligenceTab() {
  const el = document.getElementById('ad-intelligence-content');
  el.innerHTML = '<p class="muted" style="padding:2rem">Loading\u2026</p>';
  try {
    const res = await fetch('/api/meta-ads-insights', { credentials: 'same-origin' });
    const data = await res.json();
    if (!data.ads || data.ads.length === 0) {
      el.innerHTML = '<p class="muted" style="padding:2rem">No ad intelligence data yet. Run the meta-ads-collector and meta-ads-analyzer agents first.</p>';
      return;
    }
    const ads = data.ads.slice(0, 12);
    el.innerHTML =
      '<div style="padding:1.5rem">' +
      '<h2 style="margin:0 0 0.25rem">Ad Intelligence</h2>' +
      '<p class="muted" style="margin:0 0 1.5rem">Competitor ads from Meta Ads Library \u00b7 Last updated ' + esc(data.date || 'unknown') + '</p>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:1.25rem">' +
      ads.map(function(ad) { return renderAdCard(ad); }).join('') +
      '</div></div>';
  } catch (e) {
    el.innerHTML = '<p class="muted" style="padding:2rem">Error loading data: ' + esc(e.message) + '</p>';
  }
}

function renderAdCard(ad) {
  const platforms = (ad.publisherPlatforms || []).map(function(p) {
    return '<span style="background:#e8f4fd;color:#1a6fa8;padding:2px 7px;border-radius:3px;font-size:11px;font-weight:600;text-transform:uppercase">' + esc(p) + '</span>';
  }).join(' ');
  const analysisHtml = ad.analysis
    ? '<div style="background:#f8f9fa;border-radius:6px;padding:0.75rem;margin-top:0.75rem;font-size:13px">' +
      '<div style="font-weight:600;margin-bottom:0.25rem">' + esc(ad.analysis.headline || '') + '</div>' +
      '<div class="muted">' + esc(ad.analysis.whyEffective || '') + '</div>' +
      (ad.analysis.messagingAngle ? '<div style="margin-top:0.5rem"><span style="font-weight:600">Angle:</span> ' + esc(ad.analysis.messagingAngle) + '</div>' : '') +
      '</div>'
    : '';
  return '<div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;display:flex;flex-direction:column">' +
    '<div style="padding:0.875rem 1rem 0.75rem;border-bottom:1px solid #f3f4f6">' +
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.35rem">' +
    '<span style="font-weight:700;font-size:14px">' + esc(ad.pageName) + '</span>' +
    '<span style="font-size:11px;color:#6b7280;white-space:nowrap;margin-left:0.5rem">Score: ' + ad.effectivenessScore + '</span>' +
    '</div>' +
    '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center">' +
    platforms +
    '<span style="font-size:11px;color:#6b7280">Running ' + ad.longevityDays + 'd</span>' +
    '<span style="font-size:11px;color:#6b7280">' + ad.variationCount + ' variations</span>' +
    '</div></div>' +
    (ad.adSnapshotUrl ? '<iframe src="' + esc(ad.adSnapshotUrl) + '" style="width:100%;height:280px;border:none" loading="lazy" sandbox="allow-scripts allow-same-origin"></iframe>' : '') +
    '<div style="padding:0.75rem 1rem;font-size:13px;flex:1">' +
    (ad.adCreativeBody ? '<div style="margin-bottom:0.5rem">' + esc(ad.adCreativeBody.slice(0, 200)) + (ad.adCreativeBody.length > 200 ? '\u2026' : '') + '</div>' : '') +
    analysisHtml +
    '</div>' +
    '<div style="padding:0.75rem 1rem;border-top:1px solid #f3f4f6">' +
    '<button data-ad-id="' + esc(ad.id) + '" data-page-name="' + esc(ad.pageName) + '" onclick="openCreativeGenerator(this.dataset.adId,this.dataset.pageName)" style="width:100%;padding:0.5rem;background:#1a6fa8;color:#fff;border:none;border-radius:5px;font-size:13px;font-weight:600;cursor:pointer">Generate Creative</button>' +
    '</div></div>';
}

function openCreativeGenerator(adId, pageName) {
  const name = prompt('Generate creative for "' + pageName + '".\\n\\nEnter product image filenames (comma-separated, from data/product-images/) or leave blank for lifestyle-only:\\nExample: deodorant-stick.webp,deodorant-lifestyle.webp');
  // name=null means user cancelled; name='' means they left it blank (lifestyle-only) — both are valid
  if (name === null) return; // user cancelled the prompt
  const productImages = name ? name.split(',').map(s => s.trim()).filter(Boolean) : [];
  // productImages may be empty — that's valid (lifestyle-only prompt, no product reference)
  generateCreative(adId, productImages);
}

async function generateCreative(adId, productImages) {
  try {
    const res = await fetch('/api/generate-creative', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adId, productImages }),
    });
    if (!res.ok) { const e = await res.json(); alert('Error: ' + (e.error || res.status)); return; }
    const { jobId } = await res.json();
    alert('Creative generation started! Job ID: ' + jobId + '\\n\\nThe download link will appear here when ready. Check back in ~2 minutes.');
    pollCreativeJob(jobId);
  } catch (e) { alert('Error: ' + e.message); }
}

async function pollCreativeJob(jobId, attempts = 0) {
  if (attempts > 30) { alert('Creative generation timed out. Check the dashboard for errors.'); return; }
  await new Promise(r => setTimeout(r, 5000));
  try {
    const res = await fetch('/api/creative-packages/' + encodeURIComponent(jobId), { credentials: 'same-origin' });
    const job = await res.json();
    if (job.status === 'complete') {
      if (confirm('Creative package ready! Download now?')) window.location.href = '/api/creative-packages/download/' + encodeURIComponent(jobId);
    } else if (job.status === 'error') {
      alert('Creative generation failed: ' + (job.error || 'unknown error'));
    } else {
      pollCreativeJob(jobId, attempts + 1);
    }
  } catch { pollCreativeJob(jobId, attempts + 1); }
}

function renderAdsTab(data) {
  renderAdsOptimization(data);
  const adsAll = data.cro?.googleAdsAll || [];
  const snap = adsAll[0];

  if (!snap) {
    document.getElementById('ads-keywords-card').innerHTML = '';
    return;
  }

  // Top keywords card
  const kws = snap.topKeywords || [];
  document.getElementById('ads-keywords-card').innerHTML =
    '<div class="card"><div class="card-header"><h2>Top Keywords</h2>' +
    '<span class="section-note">by conversions</span></div>' +
    '<div class="card-body table-wrap">' +
    (kws.length === 0 ? '<p class="empty-state">No keyword data yet.</p>' :
      '<table><thead><tr><th>Keyword</th><th>Match</th><th>QS</th><th>Clicks</th><th>CVR</th><th>CPC</th><th>Conv</th></tr></thead><tbody>' +
      kws.map(k =>
        '<tr><td>' + esc(k.keyword || '—') + '</td>' +
        '<td>' + esc((k.matchType || '').toLowerCase()) + '</td>' +
        '<td>' + (k.qualityScore || '—') + '</td>' +
        '<td>' + fmtNum(k.clicks) + '</td>' +
        '<td>' + (k.clicks > 0 ? (k.conversions / k.clicks * 100).toFixed(1) + '%' : '—') + '</td>' +
        '<td>$' + (k.avgCpc || 0).toFixed(2) + '</td>' +
        '<td>' + k.conversions + '</td></tr>'
      ).join('') +
      '</tbody></table>') +
    '</div></div>';
}

    function renderToolActionCard(tc, tr) {
      var label = tc.tool === 'approve_suggestion' ? 'Suggestion approved' :
                  tc.tool === 'reject_suggestion'  ? 'Suggestion rejected' :
                                                     'Suggestion updated & approved';
      var detail = tr ? esc(tr.content) : '';
      return '<div style="display:flex;gap:8px;margin-bottom:10px">' +
        '<div style="width:24px;flex-shrink:0"></div>' +
        '<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:8px 12px;font-size:11px;color:#166534;display:flex;align-items:center;gap:8px;max-width:480px">' +
          '<span style="font-size:14px">&#9881;&#65039;</span>' +
          '<div><div style="font-weight:700;margin-bottom:2px">' + label + '</div>' +
          '<div style="font-family:monospace;color:#166534">' + esc(detail) + '</div></div>' +
        '</div>' +
      '</div>';
    }

    function renderChatMessages(chatArr) {
      var html = '';
      var i = 0;
      while (i < chatArr.length) {
        var m = chatArr[i];
        if (m.role === 'user') {
          html += '<div style="display:flex;gap:8px;margin-bottom:10px;justify-content:flex-end">' +
            '<div style="background:#ede9fe;border:1px solid #c4b5fd;border-radius:8px 0 8px 8px;padding:8px 10px;font-size:12px;color:#374151;max-width:480px">' + esc(m.content) + '</div>' +
            '<div style="background:#6d28d9;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0">Y</div>' +
            '</div>';
          i++;
        } else if (m.role === 'assistant') {
          html += '<div style="display:flex;gap:8px;margin-bottom:10px">' +
            '<div style="background:#818cf8;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0">C</div>' +
            '<div style="background:#fff;border:1px solid #e2e8f0;border-radius:0 8px 8px 8px;padding:8px 10px;font-size:12px;color:#374151;max-width:480px">' + esc(m.content) + '</div>' +
            '</div>';
          if (i + 1 < chatArr.length && chatArr[i + 1].role === 'tool_call') {
            var tc = chatArr[i + 1];
            var tr = (i + 2 < chatArr.length && chatArr[i + 2].role === 'tool_result') ? chatArr[i + 2] : null;
            html += renderToolActionCard(tc, tr);
            i += tr ? 3 : 2;
          } else {
            i++;
          }
        } else {
          i++; // tool_call / tool_result consumed above
        }
      }
      return html;
    }

function renderAdsOptimization(d) {
  var optEl = document.getElementById('ads-opt-body');
  if (!optEl) return;

  var opt = d.adsOptimization || null;
  if (!opt) {
    optEl.innerHTML = '<div class="ads-opt-analysis">No optimization analysis yet. Run Ads Optimizer to generate suggestions.</div>';
    return;
  }

  var pending  = (opt.suggestions || []).filter(function(s) { return s.status === 'pending'; });
  var approved = (opt.suggestions || []).filter(function(s) { return s.status === 'approved'; });
  var applied  = (opt.suggestions || []).filter(function(s) { return s.status === 'applied'; });
  var rejected = (opt.suggestions || []).filter(function(s) { return s.status === 'rejected'; });

  var allActionable = [].concat(pending, approved);
  var actionable = [].concat(
    allActionable.filter(function(s) { return s.type !== 'copy_rewrite'; }),
    allActionable.filter(function(s) { return s.type === 'copy_rewrite'; })
  );

  function confidenceBadge(c) {
    var label = c === 'high' ? 'HIGH' : c === 'medium' ? 'MED' : 'LOW';
    var color = c === 'high' ? '#065f46' : c === 'medium' ? '#92400e' : '#374151';
    var bg    = c === 'high' ? '#d1fae5' : c === 'medium' ? '#fef3c7' : '#f3f4f6';
    return '<span class="badge" style="background:' + bg + ';color:' + color + ';font-size:0.7rem">' + label + '</span>';
  }

  function typeLabel(s) {
    if (s.type === 'keyword_pause') return 'Pause keyword';
    if (s.type === 'keyword_add')   return 'Add keyword';
    if (s.type === 'negative_add')  return 'Add negative';
    if (s.type === 'copy_rewrite')  return 'Rewrite copy';
    return s.type;
  }

  function changeDesc(s) {
    var pc = s.proposedChange || {};
    if (s.type === 'copy_rewrite') return esc(pc.field) + ': &ldquo;' + esc(pc.current) + '&rdquo; &rarr; &ldquo;' + esc(pc.suggested) + '&rdquo;';
    if (s.type === 'keyword_add')  return esc(pc.keyword) + ' [' + esc((pc.matchType || '').toLowerCase()) + ']';
    if (s.type === 'negative_add') return '&minus;' + esc(pc.keyword);
    return esc(s.target);
  }

  function renderSuggestionCard(s) {
    var isApproved = s.status === 'approved';
    var isCopyRewrite = s.type === 'copy_rewrite';
    var maxLen = (s.proposedChange?.field || '').startsWith('headline') ? 30 : 90;
    var currentVal = s.editedValue || s.proposedChange?.suggested || '';

    var copyEditHtml = '';
    if (isCopyRewrite) {
      var count = currentVal.length;
      var over = count > maxLen;
      copyEditHtml =
        '<div style="margin-bottom:0.5rem">' +
        '<input class="ads-copy-edit" id="copy-edit-' + esc(s.id) + '" maxlength="' + maxLen + '" value="' + esc(currentVal) + '" ' +
        'oninput="updateCopyCount(&apos;' + esc(s.id) + '&apos;,' + maxLen + ')" ' +
        'onblur="saveCopyEdit(&apos;' + esc(s.id) + '&apos;,&apos;' + esc(opt.date) + '&apos;)"> ' +
        '<span class="ads-char-count' + (over ? ' over' : '') + '" id="count-' + esc(s.id) + '">' + count + '/' + maxLen + '</span>' +
        '</div>';
    }

    return '<div class="ads-suggestion" id="suggestion-card-' + esc(s.id) + '" style="' + (chatOpen.has(s.id) ? 'border-bottom-left-radius:0;border-bottom-right-radius:0' : '') + '">' +
      '<div class="ads-suggestion-header">' +
        confidenceBadge(s.confidence) +
        '<strong>' + typeLabel(s) + '</strong>' +
        (s.adGroup ? '<span class="badge-type">' + esc(s.adGroup) + '</span>' : '') +
        (isApproved ? '<span class="badge" style="background:#dbeafe;color:#1e40af;font-size:0.7rem">APPROVED</span>' : '') +
      '</div>' +
      '<div class="ads-suggestion-rationale">' + esc(s.rationale) + '</div>' +
      '<div class="ads-suggestion-change">' + changeDesc(s) + '</div>' +
      copyEditHtml +
      '<div class="ads-suggestion-actions">' +
        '<button class="btn-ads-approve" onclick="adsUpdateSuggestion(&apos;' + esc(opt.date) + '&apos;,&apos;' + esc(s.id) + '&apos;,&apos;approved&apos;)">' +
          (isApproved ? '&#10003; Approved' : 'Approve') +
        '</button>' +
        '<button class="btn-ads-reject" onclick="adsUpdateSuggestion(&apos;' + esc(opt.date) + '&apos;,&apos;' + esc(s.id) + '&apos;,&apos;rejected&apos;)">Reject</button>' +
        '<button class="btn-ads-discuss" onclick="toggleChat(&apos;' + esc(s.id) + '&apos;)" style="background:#818cf8">&#128172; Discuss</button>' +
      '</div>' +
    '</div>' +
    '<div id="chat-panel-' + esc(s.id) + '" style="display:' + (chatOpen.has(s.id) ? 'block' : 'none') + ';border:1px solid #818cf8;border-top:none;border-radius:0 0 8px 8px;background:#f8fafc;padding:12px">' +
      '<div id="chat-messages-' + esc(s.id) + '" style="max-height:320px;overflow-y:auto">' + renderChatMessages(s.chat || []) + '</div>' +
      '<div style="display:flex;gap:6px;margin-top:8px">' +
        '<input id="chat-input-' + esc(s.id) + '" placeholder="Ask a follow-up question..." ' +
          'style="flex:1;padding:7px 10px;border:1px solid #c4b5fd;border-radius:6px;font-size:12px;outline:none;background:#fff" ' +
          'onkeydown="if(event.key===\\'Enter\\')sendChatMessage(&apos;' + esc(opt.date) + '&apos;,&apos;' + esc(s.id) + '&apos;)">' +
        '<button onclick="sendChatMessage(&apos;' + esc(opt.date) + '&apos;,&apos;' + esc(s.id) + '&apos;)" ' +
          'style="padding:7px 14px;background:#818cf8;color:#fff;border:none;border-radius:6px;font-size:12px;cursor:pointer">Send</button>' +
      '</div>' +
    '</div>';
  }

  var html = '';
  if (opt.analysisNotes) html += '<div class="ads-opt-analysis">' + esc(opt.analysisNotes) + '</div>';

  if (actionable.length === 0) {
    html += '<p class="empty-state">No pending suggestions. Run Ads Optimizer to generate new analysis.</p>';
  } else {
    html += actionable.map(renderSuggestionCard).join('');
  }

  if (applied.length > 0 || rejected.length > 0) {
    html += '<details class="ads-applied-section"><summary>' + (applied.length + rejected.length) + ' resolved suggestion(s)</summary>' +
      '<div style="margin-top:0.5rem;opacity:0.6">' +
        [].concat(applied, rejected).map(function(s) {
          return '<div style="font-size:0.8rem;padding:0.25rem 0">' +
          '<span class="badge" style="background:' + (s.status === 'applied' ? '#d1fae5' : '#fee2e2') + ';font-size:0.7rem">' + s.status.toUpperCase() + '</span> ' +
          esc(s.target) + ' — ' + esc(s.rationale) +
          '</div>';
        }).join('') +
      '</div></details>';
  }

  optEl.innerHTML = html;
}

async function adsUpdateSuggestion(date, id, status) {
  try {
    var res = await fetch('/ads/' + date + '/suggestion/' + id, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: status }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (err) {
    console.error('Failed to update suggestion:', err);
    return;
  }
  loadData();
}

function updateCopyCount(id, maxLen) {
  var input = document.getElementById('copy-edit-' + id);
  var counter = document.getElementById('count-' + id);
  if (!input || !counter) return;
  var count = input.value.length;
  counter.textContent = count + '/' + maxLen;
  counter.className = 'ads-char-count' + (count > maxLen ? ' over' : '');
}

async function saveCopyEdit(id, date) {
  var input = document.getElementById('copy-edit-' + id);
  if (!input) return;
  var maxLen = parseInt(input.getAttribute('maxlength') || '90', 10);
  if (input.value.length > maxLen) return;
  try {
    var res = await fetch('/ads/' + date + '/suggestion/' + id, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ editedValue: input.value }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (err) {
    console.error('Failed to save copy edit:', err);
  }
}


async function applyAdsChanges() {
  var logEl = document.getElementById('run-log-apply-ads');
  if (logEl) { logEl.style.display = 'block'; logEl.textContent = ''; }
  var res = await fetch('/apply-ads', { method: 'POST' });
  var reader = res.body.getReader();
  var decoder = new TextDecoder();
  function read() {
    reader.read().then(function(result) {
      if (result.done) { loadData(); return; }
      var lines = decoder.decode(result.value).split('\\n');
      for (var i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('data: ') && logEl) logEl.textContent += lines[i].slice(6) + '\\n';
      }
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
      read();
    });
  }
  read();
}

function renderActiveTests(d) {
  const el = document.getElementById('active-tests-row');
  if (!el) return;
  const tests = d.metaTests || [];
  const active = tests.filter(t => t.status === 'active');
  if (!active.length) { el.style.display = 'none'; return; }
  el.style.display = '';
  const today = new Date();
  el.querySelector('.test-pills').innerHTML = active.map(t => {
    const start = new Date(t.startDate);
    const day = Math.floor((today - start) / 86400000) + 1;
    const delta = t.currentDelta;
    const deltaClass = delta == null ? 'tp-delta-flat'
      : delta > 0 ? 'tp-delta-pos' : delta < 0 ? 'tp-delta-neg' : 'tp-delta-flat';
    const deltaStr = delta == null ? '—'
      : (delta > 0 ? '+' : '') + (delta * 100).toFixed(2) + 'pp';
    return '<span class="test-pill">' +
      '<span class="tp-slug">' + esc(t.slug) + '</span>' +
      '<span class="tp-day">Day ' + day + '/28</span>' +
      '<span class="' + deltaClass + '">CTR ' + deltaStr + '</span>' +
      '</span>';
  }).join('');
}

async function loadAdsOptimization() {
  try {
    var res = await fetch('/api/data', { credentials: 'same-origin' });
    var d = await res.json();
    renderAdsOptimization(d);
  } catch(e) { console.error('loadAdsOptimization failed', e); }
}

function toggleChat(id) {
  var panel = document.getElementById('chat-panel-' + id);
  var card  = document.getElementById('suggestion-card-' + id);
  if (!panel) return;
  if (chatOpen.has(id)) {
    chatOpen.delete(id);
    panel.style.display = 'none';
    if (card) { card.style.borderBottomLeftRadius = ''; card.style.borderBottomRightRadius = ''; }
  } else {
    chatOpen.add(id);
    panel.style.display = 'block';
    if (card) { card.style.borderBottomLeftRadius = '0'; card.style.borderBottomRightRadius = '0'; }
  }
}

async function sendChatMessage(date, id) {
  var inputEl = document.getElementById('chat-input-' + id);
  if (!inputEl) return;
  var msg = inputEl.value.trim();
  if (!msg) return;
  inputEl.value = '';
  inputEl.disabled = true;

  // Append user bubble immediately
  var msgsEl = document.getElementById('chat-messages-' + id);
  if (msgsEl) {
    msgsEl.innerHTML += '<div style="display:flex;gap:8px;margin-bottom:10px;justify-content:flex-end">' +
      '<div style="background:#ede9fe;border:1px solid #c4b5fd;border-radius:8px 0 8px 8px;padding:8px 10px;font-size:12px;color:#374151;max-width:480px">' + esc(msg) + '</div>' +
      '<div style="background:#6d28d9;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0">Y</div>' +
      '</div>';
  }

  // Append Claude bubble with typing indicator
  var bubbleId = 'chat-bubble-' + id + '-' + Date.now();
  if (msgsEl) {
    msgsEl.innerHTML += '<div style="display:flex;gap:8px;margin-bottom:10px">' +
      '<div style="background:#818cf8;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0">C</div>' +
      '<div id="' + bubbleId + '" style="background:#fff;border:1px solid #e2e8f0;border-radius:0 8px 8px 8px;padding:10px 12px;font-size:12px;color:#374151;max-width:480px"><span class="chat-dot"></span><span class="chat-dot"></span><span class="chat-dot"></span></div>' +
      '</div>';
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  var bubbleEl = document.getElementById(bubbleId);
  var firstChunk = true;
  var done = false;

  function finish() {
    if (done) return;
    done = true;
    if (inputEl) inputEl.disabled = false;
    loadAdsOptimization();
    setTimeout(function() {
      var newMsgs = document.getElementById('chat-messages-' + id);
      if (newMsgs) {
        newMsgs.scrollTop = newMsgs.scrollHeight;
        newMsgs.scrollIntoView({ block: 'nearest' });
      }
    }, 80);
  }

  try {
    var res = await fetch('/ads/' + date + '/suggestion/' + id + '/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg }),
    });
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    function read() {
      reader.read().then(function(result) {
        if (result.done) { finish(); return; }
        var lines = decoder.decode(result.value).split('\\n');
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line === 'data: [DONE]') { finish(); return; }
          if (line.startsWith('data: ')) {
            var chunk = line.slice(6);
            if (bubbleEl) {
              if (firstChunk) {
                firstChunk = false;
                bubbleEl.style.color = '#374151';
                bubbleEl.textContent = chunk;
              } else {
                bubbleEl.textContent += chunk;
              }
              if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
            }
          }
        }
        read();
      }).catch(function() { finish(); });
    }
    read();
  } catch(e) {
    if (bubbleEl) { bubbleEl.style.color = '#374151'; bubbleEl.textContent = 'Error: ' + e.message; }
    if (inputEl) inputEl.disabled = false;
  }
}

async function loadData() {
  document.getElementById('spin-icon').textContent = '⟳';
  document.getElementById('spin-icon').classList.add('spin');
  document.getElementById('updated-at').textContent = 'Loading...';
  try {
    const res = await fetch('/api/data', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('API error: ' + res.status + ' ' + await res.text());
    data = await res.json();
    // Populate hero branding
    const nameEl = document.getElementById('site-name');
    const urlEl  = document.getElementById('site-url');
    const logoEl = document.getElementById('hero-logo');
    if (nameEl && data.config) {
      nameEl.textContent = data.config.name || 'SEO Dashboard';
      urlEl.textContent  = data.config.url  || '';
      logoEl.textContent = (data.config.name || 'S').charAt(0).toUpperCase();
    }
    // Show ads tab pill if data present
    if (data.googleAdsAll?.length) document.getElementById('pill-ads').style.display = '';
    // Render hero KPIs
    renderHeroKpis(data);
    document.getElementById('updated-at').textContent = new Date(data.generatedAt).toLocaleTimeString();
    renderDataNeeded(data);
    renderKanban(data);
    renderRankings(data);
    renderPosts(data);
    renderGSCSEOPanel(data);
    renderCROTab(data);
    renderAdsTab(data);
    loadCampaignCards();
    renderActiveTests(data);
    renderSEOAuthorityPanel(data.ahrefsData);
    renderRankAlertBanner(data.rankAlert);
    if (activeTab === 'optimize') renderOptimizeTab(data);
  } catch(e) {
    console.error(e);
    document.getElementById('updated-at').textContent = 'Error: ' + e.message;
  } finally {
    document.getElementById('spin-icon').textContent = '';
    document.getElementById('spin-icon').classList.remove('spin');
  }
}

loadData();
setInterval(loadData, 3600000);

// ── tab chat ─────────────────────────────────────────────────────────────────

var tabChatOpen = false;
var tabChatMessages = { seo: [], cro: [], ads: [], optimize: [] };
var tabChatInFlight = false;
var TAB_CHAT_NAMES = { seo: 'SEO', cro: 'CRO', ads: 'Ads', 'ad-intelligence': 'Ad Intelligence', optimize: 'Optimize' };

function renderTabChatMessages() {
  var msgs = tabChatMessages[activeTab] || [];
  var msgsEl = document.getElementById('tab-chat-messages');
  if (!msgsEl) return;
  if (!msgs.length) {
    msgsEl.innerHTML = '<div class="tab-chat-empty">Ask anything about the data on this tab.<br>I can also create action items for you to review.</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < msgs.length; i++) {
    var m = msgs[i];
    if (m.role === 'user') {
      html += '<div class="tab-chat-user-bubble">' + esc(m.content) + '</div>';
    } else if (m.role === 'assistant') {
      var aiHtml;
      try { aiHtml = mdToHtml(m.content); } catch(e) { aiHtml = esc(m.content); }
      html += '<div class="tab-chat-ai-bubble">' + aiHtml + '</div>';
      if (m.action) {
        var msgIdx = i;
        html += '<div class="tab-chat-action-card">' +
          '<div class="tab-chat-action-label">&#128203; Proposed Action</div>' +
          '<div class="tab-chat-action-desc">' + esc(m.action.title) + ': ' + esc(m.action.description) + '</div>' +
          '<button class="btn-add-to-queue" id="tab-chat-action-btn-' + msgIdx + '"' +
          (m.action.added ? ' disabled' : '') + '>' +
          (m.action.added ? '&#x2713; Added' : '+ Add to Queue') + '</button>' +
          '</div>';
      }
    }
  }
  msgsEl.innerHTML = html;
  // Attach action button listeners after render
  for (var j = 0; j < msgs.length; j++) {
    if (msgs[j].action && !msgs[j].action.added) {
      (function(idx) {
        var btn = document.getElementById('tab-chat-action-btn-' + idx);
        if (btn) btn.onclick = function() { addTabChatActionItem(activeTab, idx, btn); };
      })(j);
    }
  }
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

function toggleTabChat(tab) {
  if (tabChatOpen && activeTab === tab) {
    closeTabChat();
    return;
  }
  tabChatOpen = true;
  var sidebar = document.getElementById('tab-chat-sidebar');
  if (sidebar) sidebar.style.display = 'flex';
  var mainEl = document.querySelector('main');
  if (mainEl) mainEl.style.paddingRight = '316px';
  var title = document.getElementById('tab-chat-title');
  if (title) title.textContent = '\\u2736 ' + (TAB_CHAT_NAMES[tab] || tab) + ' Chat';
  ['seo','cro','ads','optimize'].forEach(function(t) {
    var btn = document.getElementById('btn-chat-' + t);
    if (btn) {
      if (t === tab) btn.classList.add('active'); else btn.classList.remove('active');
    }
  });
  renderTabChatMessages();
  var inp = document.getElementById('tab-chat-input');
  if (inp) inp.focus();
}

function closeTabChat() {
  tabChatOpen = false;
  var sidebar = document.getElementById('tab-chat-sidebar');
  if (sidebar) sidebar.style.display = 'none';
  var mainEl = document.querySelector('main');
  if (mainEl) mainEl.style.paddingRight = '';
  ['seo','cro','ads','optimize'].forEach(function(t) {
    var btn = document.getElementById('btn-chat-' + t);
    if (btn) btn.classList.remove('active');
  });
}

async function sendTabChatMessage() {
  if (tabChatInFlight) return;
  var inputEl = document.getElementById('tab-chat-input');
  if (!inputEl) return;
  var msg = inputEl.value.trim();
  if (!msg) return;
  inputEl.value = '';

  if (!tabChatMessages[activeTab]) tabChatMessages[activeTab] = [];
  tabChatMessages[activeTab].push({ role: 'user', content: msg });
  renderTabChatMessages();

  tabChatInFlight = true;
  inputEl.disabled = true;

  // Add typing indicator
  var msgsEl = document.getElementById('tab-chat-messages');
  if (msgsEl) {
    msgsEl.innerHTML += '<div class="tab-chat-ai-bubble" id="tab-chat-typing"><span class="chat-dot"></span><span class="chat-dot"></span><span class="chat-dot"></span></div>';
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  // Build message array for API (user/assistant turns only)
  var apiMessages = tabChatMessages[activeTab]
    .filter(function(m) { return m.role === 'user' || m.role === 'assistant'; })
    .map(function(m) { return { role: m.role, content: m.content }; });

  try {
    var res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab: activeTab, messages: apiMessages }),
    });
    if (!res.ok) { throw new Error('Server error ' + res.status); }
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var assistantText = '';
    var actionItem = null;

    function readTabChatChunk() {
      reader.read().then(function(result) {
        if (result.done) { finishTabChat(assistantText, actionItem); return; }
        var lines = decoder.decode(result.value).split('\\n');
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line === 'data: [DONE]') { finishTabChat(assistantText, actionItem); return; }
          if (line.startsWith('data: ACTION_ITEM:')) {
            try { actionItem = JSON.parse(line.slice(18)); } catch(e) {}
          } else if (line.startsWith('data: ')) {
            assistantText += line.slice(6).replace(/\\\\n/g, '\\n');
          }
        }
        readTabChatChunk();
      }).catch(function() { finishTabChat(assistantText, actionItem); });
    }
    readTabChatChunk();
  } catch(e) {
    var typingEl = document.getElementById('tab-chat-typing');
    if (typingEl) typingEl.remove();
    if (!tabChatMessages[activeTab]) tabChatMessages[activeTab] = [];
    tabChatMessages[activeTab].push({ role: 'assistant', content: 'Error: ' + e.message });
    renderTabChatMessages();
    tabChatInFlight = false;
    if (inputEl) inputEl.disabled = false;
  }
}

function finishTabChat(text, action) {
  var typingEl = document.getElementById('tab-chat-typing');
  if (typingEl) typingEl.remove();
  if (!tabChatMessages[activeTab]) tabChatMessages[activeTab] = [];
  var entry = { role: 'assistant', content: text || '(no response)' };
  if (action) entry.action = { title: action.title || '', description: action.description || '', type: action.type || 'chat_action', added: false };
  tabChatMessages[activeTab].push(entry);
  try { renderTabChatMessages(); } catch(e) { console.error('renderTabChatMessages failed:', e); }
  tabChatInFlight = false;
  var inputEl = document.getElementById('tab-chat-input');
  if (inputEl) inputEl.disabled = false;
}

async function addTabChatActionItem(tab, msgIdx, btn) {
  var msgs = tabChatMessages[tab];
  if (!msgs || !msgs[msgIdx] || !msgs[msgIdx].action) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Adding...'; }
  var action = msgs[msgIdx].action;
  try {
    var res = await fetch('/api/chat/action-item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab: tab, title: action.title, description: action.description, type: action.type }),
    });
    var json = await res.json();
    if (json.ok) {
      action.added = true;
      if (btn) { btn.textContent = '\\u2713 Added'; }
      loadData();
    } else {
      if (btn) { btn.disabled = false; btn.textContent = 'Error \\u2014 retry'; }
    }
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = 'Error \\u2014 retry'; }
  }
}

// ── keyword detail modal ──────────────────────────────────────────────────────

function openKeywordCard(item) {
  const fmt = v => (v == null || v === '') ? '<span class="muted">—</span>' : esc(String(v));
  const fmtN = v => v == null ? '<span class="muted">—</span>' : fmtNum(v);
  const changeArrow = (v) => {
    if (v == null) return '<span class="muted">—</span>';
    if (v > 0) return '<span class="change-up">↑ ' + v + '</span>';
    if (v < 0) return '<span class="change-down">↓ ' + Math.abs(v) + '</span>';
    return '→ 0';
  };

  const intentsHtml = (item.intents && item.intents.length)
    ? item.intents.map(i => '<span class="badge badge-approved" style="margin-right:4px">' + esc(i) + '</span>').join('')
    : '<span class="muted">—</span>';

  const serpHtml = item.serpFeatures
    ? item.serpFeatures.split(',').map(s => '<span class="badge badge-notranking" style="margin-right:4px">' + esc(s.trim()) + '</span>').join('')
    : '<span class="muted">—</span>';

  const rows = (label, val) =>
    '<tr><td style="color:#6b7280;padding:6px 12px 6px 0;white-space:nowrap;font-size:13px">' + label + '</td>' +
    '<td style="padding:6px 0;font-size:13px">' + val + '</td></tr>';

  const html =
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">' +
    '<div><div style="font-size:18px;font-weight:700;margin-bottom:4px">' + esc(item.keyword) + '</div>' +
    (item.title ? '<div style="color:#6b7280;font-size:13px">' + esc(item.title) + '</div>' : '') +
    '</div>' +
    '<button onclick="closeKeywordCard()" style="background:none;border:none;font-size:22px;cursor:pointer;color:#6b7280;line-height:1">✕</button>' +
    '</div>' +
    '<table style="width:100%;border-collapse:collapse">' +
    rows('Position', item.position != null ? '<strong>#' + item.position + '</strong>' : '<span class="muted">—</span>') +
    rows('Previous Position', item.positionPrev != null ? '#' + item.positionPrev : (item.previousPosition != null ? '#' + item.previousPosition : '<span class="muted">—</span>')) +
    rows('Position Change', changeArrow(item.positionChange)) +
    rows('Volume', fmtN(item.volume)) +
    rows('KD', fmt(item.kd)) +
    rows('CPC', item.cpc != null ? '$' + item.cpc.toFixed(2) : '<span class="muted">—</span>') +
    rows('Traffic (current)', fmtN(item.traffic)) +
    rows('Traffic (previous)', fmtN(item.trafficPrev)) +
    rows('Traffic Change', changeArrow(item.trafficChange)) +
    rows('Country', fmt(item.country)) +
    rows('SERP Features', serpHtml) +
    rows('Intent', intentsHtml) +
    rows('Current URL', item.url ? '<a class="link" href="' + esc(item.url) + '" target="_blank">' + esc(item.url) + '</a>' : '<span class="muted">—</span>') +
    rows('Previous URL', item.urlPrev ? '<a class="link" href="' + esc(item.urlPrev) + '" target="_blank">' + esc(item.urlPrev) + '</a>' : '<span class="muted">—</span>') +
    rows('Last checked', fmt(item.dateCurr)) +
    (item.gsc_clicks != null ? rows('GSC Clicks (90d)', fmtN(item.gsc_clicks)) : '') +
    (item.gsc_impressions != null ? rows('GSC Impressions (90d)', fmtN(item.gsc_impressions)) : '') +
    (item.gsc_ctr != null ? rows('GSC CTR', (item.gsc_ctr * 100).toFixed(1) + '%') : '') +
    '</table>';

  document.getElementById('kw-modal-body').innerHTML = html;
  document.getElementById('kw-modal').style.display = 'flex';
}

function closeKeywordCard() {
  document.getElementById('kw-modal').style.display = 'none';
}

const _kwModal = document.getElementById('kw-modal');
if (_kwModal) _kwModal.addEventListener('click', function(e) {
  if (e.target === this) closeKeywordCard();
});

function runAgent(script, args = [], onDone = null) {
  const logId = 'run-log-' + script.replace(/[^a-z0-9]/gi, '-');
  const logEl = document.getElementById(logId);
  if (!logEl) return;
  logEl.textContent = 'Running...\\n';
  logEl.style.display = 'block';
  fetch('/run-agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script, args }),
  }).then(res => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    function read() {
      reader.read().then(({ done, value }) => {
        if (done) { if (onDone) onDone(); return; }
        for (const line of decoder.decode(value).split('\\n')) {
          if (line.startsWith('data: ')) logEl.textContent += line.slice(6) + '\\n';
        }
        logEl.scrollTop = logEl.scrollHeight;
        read();
      });
    }
    read();
  });
}

function promptAndRun(script, argLabel) {
  const val = prompt(argLabel);
  if (val) runAgent(script, [val]);
}

function renderSEOAuthorityPanel(ahrefs) {
  const el = document.getElementById('seo-authority-panel');
  if (!el) return;
  if (!ahrefs) {
    el.innerHTML = '<div class="data-needed"><strong>&#9888; SEO Authority Data Needed</strong>Click Update to enter your Ahrefs metrics.</div>';
    return;
  }
  const fmt    = v => (v != null && v !== '' && !isNaN(Number(v))) ? Number(v).toLocaleString() : '\u2014';
  const fmtDr  = v => (v != null && v !== '') ? v : '\u2014';
  const fmtVal = v => (v != null && v !== '' && !isNaN(Number(v))) ? '$' + (Number(v) / 100).toLocaleString() : '\u2014';
  el.innerHTML =
    '<div class="authority-row">' +
    '<div class="authority-stat"><div class="authority-stat-value">' + fmtDr(ahrefs.domainRating) + '</div><div class="authority-stat-label">Domain Rating</div></div>' +
    '<div class="authority-stat"><div class="authority-stat-value">' + fmt(ahrefs.backlinks) + '</div><div class="authority-stat-label">Backlinks</div></div>' +
    '<div class="authority-stat"><div class="authority-stat-value">' + fmt(ahrefs.referringDomains) + '</div><div class="authority-stat-label">Referring Domains</div></div>' +
    '<div class="authority-stat"><div class="authority-stat-value">' + fmtVal(ahrefs.organicTrafficValue) + '</div><div class="authority-stat-label">Organic Traffic Value</div></div>' +
    '</div>';
}

function openAhrefsModal() {
  const ov = document.getElementById('ahrefs-modal-overlay');
  if (!ov) return;
  ov.style.display = 'flex';
  try { document.getElementById('ahrefs-dr').focus(); } catch(e) {}
}

function closeAhrefsModal(e) {
  if (e && e.target !== document.getElementById('ahrefs-modal-overlay')) return;
  document.getElementById('ahrefs-modal-overlay').style.display = 'none';
}

async function saveAhrefsOverview() {
  const btn = document.getElementById('ahrefs-save-btn');
  const dr = document.getElementById('ahrefs-dr').value.trim();
  const backlinks = document.getElementById('ahrefs-backlinks').value.trim();
  const refdomains = document.getElementById('ahrefs-refdomains').value.trim();
  const value = document.getElementById('ahrefs-value').value.trim();
  if (!dr && !backlinks && !refdomains && !value) return;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="chat-dot"></span><span class="chat-dot"></span><span class="chat-dot"></span>'; }
  try {
    const res = await fetch('/api/ahrefs-overview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domainRating: dr, backlinks, referringDomains: refdomains, trafficValue: value }),
    });
    const json = await res.json();
    if (json.ok) {
      document.getElementById('ahrefs-modal-overlay').style.display = 'none';
      loadData();
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
  }
}

function uploadRankSnapshot() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.csv,.tsv';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.onchange = async () => {
    document.body.removeChild(input);
    const file = input.files[0];
    if (!file) return;
    const btn = document.getElementById('rank-upload-btn');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="chat-dot"></span><span class="chat-dot"></span><span class="chat-dot"></span>'; }
    try {
      const res = await fetch('/upload/rank-snapshot', {
        method: 'POST',
        headers: { 'X-Filename': file.name, 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      const json = await res.json();
      if (!json.ok) {
        if (btn) { btn.disabled = false; btn.innerHTML = '&#8593; Upload CSV'; }
        return;
      }
      // CSV saved — now run rank tracker to process it, then reload
      runAgent('agents/rank-tracker/index.js', [], function() {
        if (btn) { btn.disabled = false; btn.innerHTML = '&#10003; Updated'; }
        loadData();
      });
    } catch (e) {
      if (btn) { btn.disabled = false; btn.innerHTML = '&#8593; Upload CSV'; }
    }
  };
  input.click();
}

async function loadCampaignCards() {
  try {
    const res = await fetch('/api/campaigns', { credentials: 'same-origin' });
    if (!res.ok) return;
    const data = await res.json();
    renderCampaignCards(data.campaigns || data, data.aovBarrier || null);
  } catch {}
}

function formatRationale(text) {
  if (!text) return '';
  // Split on sentence boundaries
  var sentences = (text.match(/[^.!?]+(?:[.!?]+(?:[ ]|$))/g) || [text]).map(function(s) { return s.trim(); }).filter(Boolean);
  if (sentences.length <= 1) return '<span>' + esc(text) + '</span>';

  var summary  = sentences[0];
  // Skip pure-math sentences (lots of = and $ signs) and cap at 5 bullets
  var bullets  = sentences.slice(1).filter(function(s) { return (s.match(/=/g) || []).length < 3; }).slice(0, 5);
  var overflow = sentences.slice(1 + bullets.length);

  var html = '<div class="rationale-summary">' + esc(summary) + '</div>';
  if (bullets.length) {
    html += '<ul class="rationale-bullets">' + bullets.map(function(s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>';
  }
  if (overflow.length) {
    html += '<details class="rationale-details"><summary>Show full analysis (' + overflow.length + ' more)</summary>' +
      '<ul class="rationale-bullets">' + overflow.map(function(s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>' +
      '</details>';
  }
  return html;
}

function renderCampaignCards(campaigns, aovBarrier) {
  // --- Proposals ---
  const proposals = campaigns.filter(c => (c.status === 'proposed' || c.status === 'approved') && !c.clarificationNeeded);
  const propCard = document.getElementById('campaign-proposals-card');
  const propBody = document.getElementById('campaign-proposals-body');
  if (proposals.length === 0 && aovBarrier) {
    propCard.style.display = '';
    document.getElementById('campaign-proposals-note').textContent = 'Paid search readiness';
    propBody.innerHTML =
      '<div style="padding:4px 0 12px">' +
        '<div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:8px">No viable campaigns at current AOV</div>' +
        '<div style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:16px">' + esc(aovBarrier.message) + '</div>' +
        '<div class="metrics-row" style="border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:16px">' +
          '<div class="metric"><div class="metric-label">Store AOV</div><div class="metric-value">$' + esc(String(aovBarrier.aov.toFixed(2))) + '</div><div class="metric-note">90-day average</div></div>' +
          '<div class="metric"><div class="metric-label">Min ROAS</div><div class="metric-value">' + esc(String(aovBarrier.minRoas)) + '×</div><div class="metric-note">Required threshold</div></div>' +
          '<div class="metric"><div class="metric-label">Max CPA</div><div class="metric-value">$' + esc(String(aovBarrier.breakEvenCpa)) + '</div><div class="metric-note">at ' + esc(String(aovBarrier.minRoas)) + '× ROAS</div></div>' +
          '<div class="metric"><div class="metric-label">Max CPC @ 2% CVR</div><div class="metric-value">$' + esc(String(aovBarrier.breakEvenCpc?.at2pctCvr)) + '</div><div class="metric-note">long-tail threshold</div></div>' +
          '<div class="metric"><div class="metric-label">Max CPC @ 3% CVR</div><div class="metric-value">$' + esc(String(aovBarrier.breakEvenCpc?.at3pctCvr)) + '</div><div class="metric-note">branded threshold</div></div>' +
        '</div>' +
        '<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:6px">Recommendations</div>' +
        '<div style="font-size:12px;color:var(--text);line-height:1.8">' +
          '• Current AOV supports keywords up to $' + esc(String((aovBarrier.aov * 0.03 / aovBarrier.minRoas).toFixed(2))) + ' CPC at 3% CVR — target long-tail terms in that range<br>' +
          '• Push AOV to ~$42 via bundles or upsells to unlock $1.50 CPC keywords<br>' +
          '• Brand search is the best near-term bet — CPCs $0.30–0.50, CVR 8–15%<br>' +
          '• See CRO brief for detailed AOV improvement recommendations' +
        '</div>' +
      '</div>';
  } else if (proposals.length > 0) {
    propCard.style.display = '';
    document.getElementById('campaign-proposals-note').textContent = proposals.length + ' pending';
    propBody.innerHTML = proposals.map(c => {
      const p = c.proposal;
      const proj = c.projections || {};
      const isApproved = c.status === 'approved';
      const sugBudget = p.suggestedBudget || 5;
      const approvedBudget = p.approvedBudget || sugBudget;
      const aov = proj.monthlyConversions > 0 ? Math.round(proj.monthlyRevenue / proj.monthlyConversions) : '—';
      const dateStr = c.createdAt ? new Date(c.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';

      // Status badge
      const statusBadge = isApproved
        ? '<span class="badge badge-published">Approved · $' + approvedBudget + '/day</span>'
        : '<span class="badge badge-draft">Proposed</span>';

      // Budget cell — editable for proposed, display-only for approved
      // JSON.stringify produces double-quoted keys — encode as &quot; for use inside a double-quoted HTML attribute
      const projJson = JSON.stringify(proj).replace(/"/g, '&quot;');
      const budgetCell = isApproved
        ? '<div class="metric budget-metric"><div class="metric-label">Approved Budget</div><div class="metric-value">$' + approvedBudget + ' <span class="metric-unit">/day</span></div><div class="metric-note">$' + (approvedBudget * 30).toFixed(0) + '/mo</div></div>'
        : '<div class="metric budget-metric"><div class="metric-label">Daily Budget</div><div class="budget-row"><span style="font-size:14px;font-weight:700;color:var(--muted)">$</span><input class="budget-input" id="budget-' + esc(c.id) + '" type="number" min="1" step="0.5" value="' + sugBudget + '" data-sug="' + sugBudget + '" data-proj="' + projJson + '" oninput="updateProjections(&apos;' + esc(c.id) + '&apos;)"></div><div class="metric-note">$' + (sugBudget * 30).toFixed(0) + '/mo suggested</div></div>';

      // Ad groups pills
      const adGroupPills = (p.adGroups || []).map(ag =>
        '<span class="adgroup-pill">' + esc(ag.name) + ' <span class="adgroup-kw">· ' + (ag.keywords || []).length + ' kw</span></span>'
      ).join('');
      const negCount = (p.negativeKeywords || []).length;

      // Actions row — note: Approve button uses .btn-camp-approve (not .btn-approve) to avoid collision with CRO section
      const actionsHtml = isApproved
        ? '<button class="btn-launch" onclick="launchCampaign(&apos;' + esc(c.id) + '&apos;)">▶ Launch in Google Ads</button>' +
          '<button class="btn-dismiss" onclick="dismissCampaign(&apos;' + esc(c.id) + '&apos;)">Dismiss</button>' +
          '<span class="proposal-action-note">Budget approved — ready to go live</span>'
        : '<button class="btn-camp-approve" onclick="approveCampaign(&apos;' + esc(c.id) + '&apos;)">✓ Approve &amp; Set Budget</button>' +
          '<button class="btn-dismiss" onclick="dismissCampaign(&apos;' + esc(c.id) + '&apos;)">Dismiss</button>' +
          '<span class="proposal-action-note">Approval sets budget — launch is a separate step</span>';

      return (
        '<div class="proposal" id="prop-' + esc(c.id) + '">' +

        // 1. Header
        '<div class="proposal-head">' +
          '<div>' +
            '<div class="proposal-name">' + esc(p.campaignName) + '</div>' +
            '<div class="proposal-sub">' + esc(p.landingPage || '') + '</div>' +
            '<div class="proposal-tags"><span class="badge badge-scheduled">' + esc(p.network || 'Search') + '</span>' + statusBadge + '</div>' +
          '</div>' +
          '<div style="margin-left:auto;font-size:11px;color:var(--muted)">' + esc(dateStr) + '</div>' +
        '</div>' +

        // 2. Metrics row
        '<div class="metrics-row">' +
          budgetCell +
          '<div class="metric"><div class="metric-label">Est. Clicks/day</div><div class="metric-value" id="clicks-' + esc(c.id) + '">' + esc(String(proj.dailyClicks || '—')) + ' <span class="metric-unit">clicks</span></div><div class="metric-note">CTR ' + ((proj.ctr || 0) * 100).toFixed(1) + '%</div></div>' +
          '<div class="metric"><div class="metric-label">Monthly Cost</div><div class="metric-value" id="cost-' + esc(c.id) + '">$' + esc(String(proj.monthlyCost || '—')) + '</div><div class="metric-note">$' + esc(String(proj.cpc || '—')) + ' avg CPC</div></div>' +
          '<div class="metric"><div class="metric-label">Est. Conversions</div><div class="metric-value" id="conv-' + esc(c.id) + '">' + esc(String(proj.monthlyConversions || '—')) + ' <span class="metric-unit">/mo</span></div><div class="metric-note">CVR ' + ((proj.cvr || 0) * 100).toFixed(1) + '%</div></div>' +
          '<div class="metric"><div class="metric-label">Est. Revenue</div><div class="metric-value" style="color:var(--green)" id="rev-' + esc(c.id) + '">$' + esc(String(proj.monthlyRevenue || '—')) + '</div><div class="metric-note" id="aov-' + esc(c.id) + '">~$' + aov + '/conversion</div></div>' +
        '</div>' +

        // 3. Rationale
        '<div class="rationale-row"><div class="rationale-label">Why this campaign</div><div class="rationale-text">' + formatRationale(c.rationale || '') + '</div></div>' +

        // 4. Ad groups
        '<div class="adgroups-row"><span class="adgroups-label">Ad Groups</span>' + adGroupPills + (negCount > 0 ? '<span style="font-size:11px;color:var(--muted);margin-left:auto">' + negCount + ' neg. keywords</span>' : '') + '</div>' +

        // 5. Actions
        '<div class="proposal-actions">' + actionsHtml + '</div>' +

        '</div>'
      );
    }).join('');
  } else {
    propCard.style.display = '';
    propBody.innerHTML = '<p class="empty-state">No campaign suggestions yet. Run Campaign Creator to generate proposals.</p>';
    document.getElementById('campaign-proposals-note').textContent = '';
  }

  // --- Clarifications ---
  const clarify = campaigns.filter(c => c.clarificationNeeded && c.clarificationNeeded.length > 0);
  const clarCard = document.getElementById('campaign-clarify-card');
  const clarBody = document.getElementById('campaign-clarify-body');
  if (clarify.length > 0) {
    clarCard.style.display = '';
    clarBody.innerHTML = clarify.map(c =>
      '<div class="camp-proposal"><strong>' + esc(c.id) + '</strong>' +
      '<ol>' + c.clarificationNeeded.map(q => '<li>' + esc(q) + '</li>').join('') + '</ol>' +
      '<textarea id="clarify-text-' + esc(c.id) + '" rows="3" style="width:100%;margin-top:8px" placeholder="Your answer..."></textarea>' +
      '<button style="margin-top:6px" onclick="submitClarification(&apos;' + esc(c.id) + '&apos;)">Submit</button>' +
      '</div>'
    ).join('');
  } else { clarCard.style.display = 'none'; }

  // --- Active campaigns ---
  const active = campaigns.filter(c => c.status === 'active');
  const actCard = document.getElementById('campaign-active-card');
  const actBody = document.getElementById('campaign-active-body');
  if (active.length > 0) {
    actCard.style.display = '';
    actBody.innerHTML = active.map(c => {
      const numDays   = croFilter === '30days' ? 30 : croFilter === '7days' ? 7 : 1;
      const entries   = c.performance.slice(-numDays);
      const recent    = c.performance.slice(-1)[0] || {};
      const aggSpend  = entries.reduce((s, e) => s + (e.spend || 0), 0);
      const aggClicks = entries.reduce((s, e) => s + (e.clicks || 0), 0);
      const aggImpr   = entries.reduce((s, e) => s + (e.impressions || 0), 0);
      const aggConv   = entries.reduce((s, e) => s + (e.conversions || 0), 0);
      const aggCtr    = aggImpr   > 0 ? aggClicks / aggImpr : null;
      const aggCpc    = aggClicks > 0 ? aggSpend  / aggClicks : null;
      const aggCvr    = aggClicks > 0 ? aggConv   / aggClicks : null;
      const budget = c.proposal?.approvedBudget || 0;
      const periodBudget = budget * numDays;
      const spendPct = periodBudget > 0 ? Math.round(aggSpend / periodBudget * 100) : 0;
      const openAlerts = (c.alerts || []).filter(a => !a.resolved);
      const ctrDelta = recent.vsProjection?.ctrDelta ?? null;
      const cpcDelta = recent.vsProjection?.cpcDelta ?? null;
      const cvrDelta = recent.vsProjection?.cvrDelta ?? null;
      const campaignDays = c.googleAds?.createdAt ? Math.floor((Date.now() - new Date(c.googleAds.createdAt)) / 86400000) : '?';
      const spendVal  = aggSpend  > 0 ? '$' + aggSpend.toFixed(2)          : '—';
      const ctrVal    = aggCtr   != null ? (aggCtr  * 100).toFixed(2) + '%' : '—';
      const cpcVal    = aggCpc   != null ? '$' + aggCpc.toFixed(2)          : '—';
      const cvrVal    = aggCvr   != null ? (aggCvr  * 100).toFixed(2) + '%' : '—';
      const fmtDelta  = (v, fmt) => v !== null ? '<span class="camp-kpi-delta ' + (v >= 0 ? 'delta-up' : 'delta-down') + '">' + (v >= 0 ? '+' : '') + fmt(v) + ' vs proj</span>' : '';
      const fmtDeltaInv = (v, fmt) => v !== null ? '<span class="camp-kpi-delta ' + (v <= 0 ? 'delta-up' : 'delta-down') + '">' + (v >= 0 ? '+' : '') + fmt(v) + ' vs proj</span>' : '';
      return '<div class="camp-proposal">' +
        '<div class="camp-proposal-name">' + esc(c.proposal?.campaignName || c.id) + ' <span class="section-note">Day ' + campaignDays + '</span></div>' +
        '<div style="background:#f1f5f9;border-radius:4px;height:5px;margin-bottom:4px"><div style="background:#818cf8;height:5px;border-radius:4px;width:' + Math.min(spendPct, 100) + '%"></div></div>' +
        '<div style="font-size:10px;color:var(--muted);margin-bottom:8px">$' + aggSpend.toFixed(2) + ' of $' + (numDays === 1 ? budget + '/day' : periodBudget.toFixed(0)) + ' (' + spendPct + '%)</div>' +
        '<div class="camp-kpi-grid">' +
          '<div class="camp-kpi"><div class="camp-kpi-value">' + spendVal + '</div><div class="camp-kpi-label">Spend</div></div>' +
          '<div class="camp-kpi"><div class="camp-kpi-value">' + ctrVal + '</div><div class="camp-kpi-label">CTR</div>' + fmtDelta(ctrDelta, v => (v * 100).toFixed(2) + 'pp') + '</div>' +
          '<div class="camp-kpi"><div class="camp-kpi-value">' + cpcVal + '</div><div class="camp-kpi-label">Avg CPC</div>' + fmtDeltaInv(cpcDelta, v => '$' + Math.abs(v).toFixed(2)) + '</div>' +
          '<div class="camp-kpi"><div class="camp-kpi-value">' + cvrVal + '</div><div class="camp-kpi-label">CVR</div>' + fmtDelta(cvrDelta, v => (v * 100).toFixed(2) + 'pp') + '</div>' +
        '</div>' +
        (openAlerts.length > 0 ? '<div style="margin-top:10px">' + openAlerts.map(a =>
          '<span class="alert-badge-inline">' + esc(a.type.replace(/_/g, ' ')) + '</span> ' +
          '<button style="font-size:11px;padding:2px 6px" onclick="resolveAlert(&apos;' + esc(c.id) + '&apos;,&apos;' + esc(a.type) + '&apos;)">Resolve</button> '
        ).join('') + '</div>' : '') +
        '</div>';
    }).join('');
  } else {
    actCard.style.display = '';
    actBody.innerHTML = '<p class="empty-state">No active campaigns yet.</p>';
  }
}

function updateProjections(id) {
  const input = document.getElementById('budget-' + id);
  const newBudget       = parseFloat(input?.value);
  const suggestedBudget = parseFloat(input?.dataset.sug);
  let baseProj = {};
  try { baseProj = JSON.parse(input?.dataset.proj || '{}'); } catch { return; }
  if (!newBudget || newBudget <= 0) return;
  if (!suggestedBudget) { console.warn('updateProjections: suggestedBudget is 0 or missing for campaign', id); return; }
  const ratio = newBudget / suggestedBudget;
  const clicks = Math.round((baseProj.dailyClicks || 0) * ratio);
  const cost   = Math.round((baseProj.monthlyCost || 0) * ratio);
  const conv   = Math.round((baseProj.monthlyConversions || 0) * ratio);
  const rev    = Math.round((baseProj.monthlyRevenue || 0) * ratio);
  const aov = conv > 0 ? Math.round(rev / conv) : '—';
  const clickEl = document.getElementById('clicks-' + id);
  const costEl  = document.getElementById('cost-' + id);
  const convEl  = document.getElementById('conv-' + id);
  const revEl   = document.getElementById('rev-' + id);
  const aovEl   = document.getElementById('aov-' + id);
  if (clickEl) clickEl.innerHTML = clicks + ' <span class="metric-unit">clicks</span>';
  if (costEl)  costEl.textContent = '$' + cost;
  if (convEl)  convEl.innerHTML = conv + ' <span class="metric-unit">/mo</span>';
  if (revEl)   revEl.textContent = '$' + rev;
  if (aovEl)   aovEl.textContent = '~$' + aov + '/conversion';
}

async function approveCampaign(id) {
  const budget = parseFloat(document.getElementById('budget-' + id)?.value);
  if (!budget || budget <= 0) { alert('Enter a valid budget before approving.'); return; }
  try {
    const res = await fetch('/api/campaigns/' + encodeURIComponent(id) + '/approve', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ approvedBudget: budget }) });
    if (!res.ok) throw new Error(await res.text());
    loadCampaignCards();
  } catch (e) { alert('Approve failed: ' + e.message); }
}

async function dismissCampaign(id) {
  if (!confirm('Dismiss this campaign proposal?')) return;
  try {
    await fetch('/api/campaigns/' + encodeURIComponent(id) + '/dismiss', { method: 'POST', credentials: 'same-origin' });
    document.getElementById('prop-' + id)?.remove();
  } catch (e) { alert('Dismiss failed: ' + e.message); }
}

function launchCampaign(id) {
  if (!confirm('Create this campaign in Google Ads? This cannot be undone.')) return;
  fetch('/run-agent', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script: 'agents/campaign-creator/index.js', args: ['--campaign', id] }),
  }).then(res => {
    const reader = res.body.getReader();
    const log = document.getElementById('run-log-apply-ads');
    if (log) { log.style.display = ''; log.textContent = ''; }
    const read = () => reader.read().then(({ done, value }) => {
      if (done) { loadCampaignCards(); return; }
      if (log) log.textContent += new TextDecoder().decode(value);
      read();
    });
    read();
  }).catch(e => alert('Launch failed: ' + e.message));
}

async function submitClarification(id) {
  const text = document.getElementById('clarify-text-' + id)?.value?.trim();
  if (!text) { alert('Please enter your answer before submitting.'); return; }
  try {
    await fetch('/api/campaigns/' + encodeURIComponent(id) + '/clarify', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clarificationResponse: text }) });
    alert('Response submitted. Re-analysis is running in the background.');
  } catch (e) { alert('Submit failed: ' + e.message); }
}

async function resolveAlert(campaignId, alertType) {
  try {
    await fetch('/api/campaigns/' + encodeURIComponent(campaignId) + '/alerts/' + encodeURIComponent(alertType) + '/resolve', { method: 'POST', credentials: 'same-origin' });
    loadCampaignCards();
  } catch (e) { alert('Resolve failed: ' + e.message); }
}
</script>

<!-- Ahrefs overview modal -->
<div id="ahrefs-modal-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;align-items:center;justify-content:center" onclick="closeAhrefsModal(event)">
  <div style="background:#fff;border-radius:12px;width:340px;position:relative;padding:28px 28px 24px;box-shadow:0 20px 60px rgba(0,0,0,.25)">
    <button onclick="closeAhrefsModal()" style="position:absolute;top:12px;right:16px;background:none;border:none;font-size:22px;line-height:1;cursor:pointer;color:#9ca3af;padding:4px 8px">&times;</button>
    <div style="font-size:13px;font-weight:700;color:#312e81;margin-bottom:18px">Update SEO Authority</div>
    <div style="display:flex;flex-direction:column;gap:12px">
      <label style="font-size:12px;color:#374151;font-weight:500">Domain Rating<input id="ahrefs-dr" type="number" placeholder="e.g. 19" style="display:block;width:100%;margin-top:4px;padding:7px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-family:inherit"></label>
      <label style="font-size:12px;color:#374151;font-weight:500">Backlinks<input id="ahrefs-backlinks" type="number" placeholder="e.g. 329" style="display:block;width:100%;margin-top:4px;padding:7px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-family:inherit"></label>
      <label style="font-size:12px;color:#374151;font-weight:500">Referring Domains<input id="ahrefs-refdomains" type="number" placeholder="e.g. 251" style="display:block;width:100%;margin-top:4px;padding:7px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-family:inherit"></label>
      <label style="font-size:12px;color:#374151;font-weight:500">Organic Traffic Value (USD)<input id="ahrefs-value" type="number" placeholder="e.g. 89" style="display:block;width:100%;margin-top:4px;padding:7px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-family:inherit"></label>
    </div>
    <div style="display:flex;gap:8px;margin-top:20px;justify-content:flex-end">
      <button onclick="closeAhrefsModal()" style="padding:7px 16px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;font-size:13px">Cancel</button>
      <button id="ahrefs-save-btn" onclick="saveAhrefsOverview()" style="padding:7px 16px;border:none;border-radius:6px;background:#6366f1;color:white;cursor:pointer;font-size:13px;font-weight:600">Save</button>
    </div>
  </div>
</div>

<!-- keyword detail modal -->
<div id="kw-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:1000;align-items:center;justify-content:center">
  <div id="kw-modal-body" style="background:#fff;border-radius:10px;padding:24px;max-width:540px;width:90%;max-height:80vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.2)"></div>
</div>

</body>
</html>`;

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
      child.on('close', code => { res.write(`event: done\ndata: ${JSON.stringify({ code })}\n\n`); res.end(); });
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
        const { unlinkSync } = await import('node:fs');
        unlinkSync(tmpZip);
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

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
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
