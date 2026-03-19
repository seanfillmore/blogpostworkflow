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
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

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
const CALENDAR_PATH = join(REPORTS_DIR, 'content-strategist', 'content-calendar.md');

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
const CRO_REPORTS_DIR       = join(ROOT, 'data', 'reports', 'cro');

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

  return { clarityAll, shopifyAll, gscAll, ga4All, brief };
}

// ── ahrefs data readiness ──────────────────────────────────────────────────────

const AHREFS_DIR = join(ROOT, 'data', 'ahrefs');

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

// ── aggregate ──────────────────────────────────────────────────────────────────

function aggregateData() {
  const calItems    = parseCalendar();
  const editorMap   = parseEditorReports();
  const rankings    = parseRankings();

  // Build lookup from keyword slug → calendar metadata
  const calMap = new Map(calItems.map(c => [c.slug, c]));

  // Start with all post files as the source of truth
  const seen = new Set();
  const pipelineItems = [];

  // Add calendar items first (in calendar order)
  for (const item of calItems) {
    seen.add(item.slug);
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

  return {
    generatedAt: new Date().toISOString(),
    config:      { name: config.name, url: config.url || '' },
    pipeline:    { counts: statusCounts, items: pipelineItems },
    rankings,
    posts,
    pendingAhrefsData,
    cro: parseCROData(),
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
  .kanban-items { padding: 0 8px 8px; display: grid; gap: 4px; }
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
  .tab-panel.active { display: block; }

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
  .brief-item { background: #fff7ed; border: 1px solid #fed7aa; border-radius: 6px; padding: 12px; }
  .brief-item-title { font-size: 11px; font-weight: 700; color: #c2410c; margin-bottom: 6px; }
  .brief-item-body  { font-size: 11px; color: #78350f; line-height: 1.5; }
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

  /* ── legacy header (removed in Task 3) ── */
  header { background: var(--surface); border-bottom: 1px solid var(--border); padding: 12px 24px; display: flex; align-items: center; gap: 16px; }
  header h1 { font-size: 16px; font-weight: 600; }
  .header-meta { font-size: 12px; color: var(--muted); margin-left: auto; }

  /* ── metric cards (removed in Task 3/5) ── */
  .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; }
  .metric { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; box-shadow: var(--shadow); }
  .metric-value { font-size: 28px; font-weight: 700; line-height: 1; }
  .metric-label { font-size: 12px; color: var(--muted); margin-top: 6px; }
  .metric-sub   { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .metric.green  .metric-value { color: var(--green); }
  .metric.blue   .metric-value { color: var(--indigo); }
  .metric.amber  .metric-value { color: var(--amber); }
  .metric.purple .metric-value { color: var(--purple); }

  /* ── kpi strip (removed in Task 5) ── */
  .kpi-strip { display: grid; grid-template-columns: repeat(7, 1fr); gap: 12px; }
  .kpi-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; text-align: center; box-shadow: var(--shadow); }
  .kpi-card.alert { background: #fef2f2; border-color: #fecaca; }
  .kpi-value { font-size: 22px; font-weight: 700; line-height: 1; }
  .kpi-label { font-size: 11px; color: var(--muted); margin-top: 4px; }

  /* ── data-item cards (replaced by .data-needed in Task 4) ── */
  .alert-card { border-color: #fca5a5; }
  .alert-card .card-header { background: #fff1f2; }
  .alert-card .card-header h2 { color: var(--red); }
  .alert-badge { background: var(--red); color: #fff; border-radius: 999px; font-size: 11px; font-weight: 700; padding: 1px 7px; }
  .data-item { border: 1px solid var(--border); border-radius: 6px; padding: 12px 14px; margin-bottom: 10px; }
  .data-item:last-child { margin-bottom: 0; }
  .data-item-header { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .data-item-keyword { font-weight: 600; font-size: 13px; }
  .data-item-date { font-size: 11px; color: var(--muted); }
  .data-item-dir { font-family: monospace; font-size: 12px; color: var(--indigo); background: #eef2ff; padding: 3px 8px; border-radius: 4px; margin-bottom: 6px; display: inline-block; }
  .data-item-files { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
  .file-tag { font-size: 11px; padding: 2px 8px; border-radius: 4px; border: 1px solid; }
  .file-tag-missing { background: #fee2e2; color: var(--red); border-color: #fca5a5; }
  .file-tag-present { background: #dcfce7; color: var(--green); border-color: #86efac; }

  /* ── badge aliases (removed in later task) ── */
  .badge-approved  { background: #dcfce7; color: var(--green); }
  .badge-needswork { background: #fee2e2; color: var(--red); }

  /* ── utility classes ── */
  .pos { font-weight: 600; font-size: 15px; }
  .nowrap { white-space: nowrap; }
  .empty { color: var(--muted); font-size: 13px; padding: 16px; text-align: center; }
  .spin { animation: spin .8s linear infinite; display: inline-block; }
  @keyframes spin { to { transform: rotate(360deg); } }
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

<main>
<div id="tab-seo" class="tab-panel active">
  <!-- Data Needed alert (hidden when empty) -->
  <div class="card alert-card" id="data-needed-card" style="display:none">
    <div class="card-header">
      <h2>⚠ Ahrefs Data Needed <span class="alert-badge" id="data-needed-count">0</span></h2>
      <span class="section-note">Upload these CSV exports before the research agent can run</span>
    </div>
    <div class="card-body" id="data-needed-body"></div>
  </div>

  <!-- Pipeline kanban -->
  <div class="card">
    <div class="card-header"><h2>Content Pipeline</h2><span class="section-note" id="pipeline-note"></span></div>
    <div class="card-body"><div class="kanban" id="kanban"></div></div>
  </div>

  <!-- Rankings -->
  <div class="card">
    <div class="card-header"><h2>Keyword Rankings</h2><span class="section-note" id="rank-note"></span></div>
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
</div><!-- /tab-seo -->
<div id="tab-cro" class="tab-panel">
  <div id="cro-kpi-strip" style="display:none"></div>
  <div class="cro-grid" style="margin-bottom:16px">
    <div id="cro-clarity-card"></div>
    <div id="cro-shopify-card"></div>
    <div id="cro-ga4-card"></div>
    <div id="cro-gsc-card"></div>
  </div>
  <div id="cro-brief-card"></div>
</div><!-- /tab-cro -->
</main>

<script>
let data = null;

let activeTab = 'seo';

function switchTab(name, btn) {
  activeTab = name;
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-pill').forEach(b => b.classList.remove('active'));
  const panel = document.getElementById('tab-' + name);
  if (panel) panel.classList.add('active');
  btn.classList.add('active');
  // Show/hide CRO date filter
  document.getElementById('cro-filter-bar').style.display = name === 'cro' ? '' : 'none';
  // Update hero KPIs for this tab
  if (data) renderHeroKpis(data);
}

function renderHeroKpis(d) {
  const kpis = activeTab === 'cro' ? buildCroKpis(d)
             : activeTab === 'ads' ? buildAdsKpis(d)
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
    { label: 'Daily Spend',  value: snap?.cost_micros != null ? '$' + (snap.cost_micros / 1e6).toFixed(2) : '—', color: '#fb923c' },
    { label: 'Impressions',  value: snap?.impressions != null ? snap.impressions.toLocaleString() : '—',          color: '#38bdf8' },
    { label: 'Clicks',       value: snap?.clicks != null ? snap.clicks.toLocaleString() : '—',                    color: '#818cf8' },
    { label: 'CTR',          value: snap?.ctr != null ? (snap.ctr * 100).toFixed(2) + '%' : '—',                  color: '#f59e0b' },
    { label: 'ROAS',         value: snap?.roas != null ? snap.roas.toFixed(2) + 'x' : '—',                        color: '#10b981' },
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
    const itemsHtml = items.slice(0, 20).map(i => {
      const dateStr = i.publishDate ? fmtDate(i.publishDate) : null;
      const dateLine = dateStr && col.key === 'scheduled' ? '<div class="pub-date-scheduled">' + dateStr + '</div>'
                     : dateStr && col.key === 'published'  ? '<div class="pub-date-published">' + dateStr + '</div>'
                     : '';
      return '<div class="kanban-item"><div class="kw">' + esc(i.keyword) + '</div>' +
        dateLine +
        (i.volume ? '<div class="vol">' + fmtNum(i.volume) + '/mo</div>' : '') + '</div>';
    }).join('');
    const more = items.length > 20 ? '<div class="muted" style="font-size:11px;padding-top:4px">+' + (items.length - 20) + ' more</div>' : '';
    return '<div class="kanban-col col-' + col.key + '">' +
      '<div class="kanban-head">' + col.label + '</div>' +
      '<div class="kanban-count">' + items.length + '</div>' +
      (items.length ? '<div class="kanban-items">' + itemsHtml + more + '</div>' : '') +
      '</div>';
  }).join('');

  document.getElementById('kanban').innerHTML = html;
  document.getElementById('pipeline-note').textContent = d.pipeline.items.length + ' total calendar items';
}

let rankPage = 0;
const RANK_PAGE_SIZE = 20;

function renderRankings(d) {
  const r = d.rankings;
  if (!r.items.length) {
    document.getElementById('rankings-table').innerHTML = '<div class="empty">No rank snapshots yet. Run <code>npm run rank-tracker</code> to generate one.</div>';
    return;
  }

  const note = r.latestDate ? r.latestDate + (r.previousDate ? ' vs ' + r.previousDate : '') : '';
  document.getElementById('rank-note').textContent = note;

  const tierBadge = t => {
    if (t === 'page1')     return badge('page1', 'Page 1');
    if (t === 'quickWins') return badge('quickwins', 'Quick Win');
    if (t === 'needsWork') return badge('needswork-rank', 'Needs Work');
    return badge('notranking', 'Not Ranking');
  };

  const changeHtml = x => {
    if (x.change == null) return '<span class="muted">—</span>';
    if (x.change > 0) return '<span class="change change-up">↑ ' + x.change + '</span>';
    if (x.change < 0) return '<span class="change change-down">↓ ' + Math.abs(x.change) + '</span>';
    return '<span class="change change-flat">→ 0</span>';
  };

  const totalPages = Math.ceil(r.items.length / RANK_PAGE_SIZE);
  rankPage = Math.max(0, Math.min(rankPage, totalPages - 1));
  const pageItems = r.items.slice(rankPage * RANK_PAGE_SIZE, (rankPage + 1) * RANK_PAGE_SIZE);

  const rows = pageItems.map((x, i) => {
    const idx = rankPage * RANK_PAGE_SIZE + i;
    return '<tr style="cursor:pointer" onclick="openKeywordCard(data.rankings.items[' + idx + '])">' +
    '<td>' + esc(x.keyword) + (x.tracked ? ' <span class="muted" style="font-size:10px">●</span>' : '') + '</td>' +
    '<td class="nowrap"><span class="pos">' + (x.position != null ? '#' + x.position : '—') + '</span></td>' +
    '<td class="nowrap">' + changeHtml(x) + (x.previousPosition != null ? '<span class="muted" style="font-size:11px;margin-left:4px">was #' + x.previousPosition + '</span>' : '') + '</td>' +
    '<td class="nowrap muted">' + fmtNum(x.volume) + '</td>' +
    '<td>' + tierBadge(x.tier) + '</td>' +
    '</tr>';
  }).join('');

  const pagination =
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;font-size:13px;">' +
    '<button onclick="rankPage--;renderRankings(data)" ' + (rankPage === 0 ? 'disabled' : '') + ' style="padding:4px 12px;cursor:pointer;border:1px solid #d1d5db;border-radius:4px;background:#fff;">← Prev</button>' +
    '<span class="muted">Page ' + (rankPage + 1) + ' of ' + totalPages + ' (' + r.items.length + ' keywords)</span>' +
    '<button onclick="rankPage++;renderRankings(data)" ' + (rankPage >= totalPages - 1 ? 'disabled' : '') + ' style="padding:4px 12px;cursor:pointer;border:1px solid #d1d5db;border-radius:4px;background:#fff;">Next →</button>' +
    '</div>';

  document.getElementById('rankings-table').innerHTML =
    '<table><thead><tr>' +
    '<th>Keyword</th><th>Position</th><th>Change</th><th>Volume</th><th>Tier</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>' + pagination;
}

function renderPosts(d) {
  if (!d.posts.length) {
    document.getElementById('posts-table').innerHTML = '<div class="empty">No posts found.</div>';
    return;
  }
  document.getElementById('posts-note').textContent = d.posts.length + ' posts';

  const rows = d.posts.map(p => {
    const titleHtml = p.shopifyUrl
      ? '<a class="link" href="' + p.shopifyUrl + '" target="_blank">' + esc(p.title || p.slug) + '</a>'
      : esc(p.title || p.slug);
    const editorHtml = p.editorVerdict === 'Approved'    ? badge('approved', '✓ Approved')
                     : p.editorVerdict === 'Needs Work'  ? badge('needswork', '⚠ Needs Work')
                     : '<span class="muted">—</span>';
    const linksHtml = p.brokenLinks > 0
      ? '<span style="color:var(--red);font-weight:600">' + p.brokenLinks + ' broken</span>'
      : '<span class="muted">—</span>';
    const imgHtml = p.hasImage ? '🖼' : '<span class="muted">—</span>';
    const dateHtml = p.status === 'scheduled' && p.publishAt
      ? fmtDate(p.publishAt)
      : fmtDate(p.uploadedAt);

    return '<tr>' +
      '<td>' + titleHtml + '</td>' +
      '<td class="muted">' + esc(p.keyword || '—') + '</td>' +
      '<td>' + statusBadge(p.status) + '</td>' +
      '<td class="nowrap muted">' + dateHtml + '</td>' +
      '<td>' + editorHtml + '</td>' +
      '<td class="nowrap">' + linksHtml + '</td>' +
      '<td style="text-align:center">' + imgHtml + '</td>' +
      '</tr>';
  }).join('');

  document.getElementById('posts-table').innerHTML =
    '<table><thead><tr>' +
    '<th>Title</th><th>Keyword</th><th>Status</th><th>Date</th><th>Editor</th><th>Links</th><th>Image</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
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
    '<div class="card-header"><h2>Clarity</h2><span style="font-size:11px;color:var(--muted)">' + esc(dateLabel) + '</span></div>' +
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
    '<div class="card-header"><h2>Shopify</h2><span style="font-size:11px;color:var(--muted)">' + esc(dateLabel) + '</span></div>' +
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
    '<div class="card-header"><h2>GA4</h2><span style="font-size:11px;color:var(--muted)">' + esc(dateLabel) + '</span></div>' +
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
    '<div class="card-header"><h2>Search Console</h2><span style="font-size:11px;color:var(--muted)">' + esc(dateLabel) + '</span></div>' +
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
    const items = [];
    const lines = brief.content.split('\\n');
    let current = null;
    for (const line of lines) {
      if (/^### \d+\./.test(line)) {
        if (current) items.push(current);
        const titleMatch = line.match(/^### \d+\.\s+(.+?)\s+—\s+(HIGH|MED|LOW)/i);
        current = { title: titleMatch?.[1] || line.replace(/^### \d+\.\s*/, ''), priority: titleMatch?.[2] || '', body: [] };
      } else if (current && line.trim() && !/^##/.test(line)) {
        current.body.push(line.trim());
      }
    }
    if (current) items.push(current);

    const prioColor = p => p === 'HIGH' ? '#dc2626' : p === 'MED' ? '#d97706' : '#6b7280';

    briefHtml = '<div class="card" style="background:#fffbeb;border-color:#fde68a">' +
      '<div class="card-header"><h2 style="color:#92400e">AI CRO Brief</h2>' +
      '<span style="font-size:11px;color:#92400e">Generated ' + esc(brief.date) + ' · Next run: Every Monday</span></div>' +
      '<div class="card-body">' +
      (items.length ? '<div class="brief-grid">' +
        items.map(item =>
          '<div class="brief-item">' +
          '<div class="brief-item-title" style="color:' + prioColor(item.priority) + '">' +
          (item.priority ? item.priority + ' — ' : '') + esc(item.title) + '</div>' +
          '<div class="brief-item-body">' + esc(item.body.join(' ')) + '</div>' +
          '</div>'
        ).join('') + '</div>'
      : '<pre style="font-size:11px;white-space:pre-wrap;color:#78350f">' + esc(brief.content) + '</pre>') +
      '</div></div>';
  }

  document.getElementById('cro-brief-card').innerHTML = briefHtml;
}

function esc(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
  } catch(e) {
    console.error(e);
    document.getElementById('updated-at').textContent = 'Error: ' + e.message;
  } finally {
    document.getElementById('spin-icon').textContent = '';
    document.getElementById('spin-icon').classList.remove('spin');
  }
}

loadData();
setInterval(loadData, 60000);

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

document.getElementById('kw-modal').addEventListener('click', function(e) {
  if (e.target === this) closeKeywordCard();
});
</script>

<!-- keyword detail modal -->
<div id="kw-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:1000;align-items:center;justify-content:center">
  <div id="kw-modal-body" style="background:#fff;border-radius:10px;padding:24px;max-width:540px;width:90%;max-height:80vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.2)"></div>
</div>

</body>
</html>`;

// ── HTTP server ────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (!checkAuth(req, res)) return;

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

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
});

const BIND = args.includes('--public') ? '0.0.0.0' : '127.0.0.1';
server.listen(PORT, BIND, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\nSEO Dashboard — ${config.name}`);
  console.log(`  ${url}`);
  console.log('  Auto-refreshes every 60s. Ctrl+C to stop.\n');

  if (doOpen) {
    import('child_process').then(({ execSync }) => {
      try { execSync(`open "${url}"`); } catch {}
    });
  }
});
