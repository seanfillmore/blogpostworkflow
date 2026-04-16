// agents/dashboard/lib/data-parsers.js
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  ROOT, POSTS_DIR, BRIEFS_DIR, REPORTS_DIR, SNAPSHOTS_DIR, CALENDAR_PATH,
  CLARITY_SNAPSHOTS_DIR, SHOPIFY_SNAPSHOTS_DIR, GSC_SNAPSHOTS_DIR,
  GA4_SNAPSHOTS_DIR, GOOGLE_ADS_SNAPSHOTS_DIR, CRO_REPORTS_DIR,
} from './paths.js';
import { kwToSlug } from './fs-helpers.js';
import {
  listAllSlugs, getPostMeta as getPostMetaFromLib, getMetaPath, getContentPath,
  getEditorReportPath,
} from '../../../lib/posts.js';

export function parseCalendar() {
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

export function getPostMeta(slug) {
  const direct = getPostMetaFromLib(slug);
  if (direct) return direct;
  // Fallback: scan all posts for a keyword match
  for (const s of listAllSlugs()) {
    try {
      const m = getPostMetaFromLib(s);
      if (m?.target_keyword?.toLowerCase() === slug.replace(/-/g, ' ')) return m;
    } catch {}
  }
  return null;
}

export function getItemStatus(item) {
  const meta = getPostMeta(item.slug);
  const hasBrief = existsSync(join(BRIEFS_DIR, `${item.slug}.json`));
  const hasHtml  = existsSync(getContentPath(item.slug));
  const publishTs = meta?.shopify_publish_at ? Date.parse(meta.shopify_publish_at) : NaN;
  const publishInPast = !Number.isNaN(publishTs) && publishTs <= Date.now();
  const publishInFuture = !Number.isNaN(publishTs) && publishTs > Date.now();
  if (meta?.shopify_status === 'published' || publishInPast) return 'published';
  if (publishInFuture)                      return 'scheduled';
  if (meta?.shopify_article_id)             return 'draft';
  if (hasHtml)                              return 'written';
  if (hasBrief)                             return 'briefed';
  return 'pending';
}

export function parseEditorReports() {
  const out = {};
  for (const slug of listAllSlugs()) {
    const reportPath = getEditorReportPath(slug);
    if (!existsSync(reportPath)) continue;
    try {
      const txt = readFileSync(reportPath, 'utf8');
      const entry = {
        verdict:     /VERDICT:\s*Needs Work/i.test(txt) ? 'Needs Work' : 'Approved',
        brokenLinks: (txt.match(/\|\s*https?:\/\/[^|]+\|\s*[^|]*\|\s*404\s*\|/g) || []).length,
        generatedAt: statSync(reportPath).mtime.toISOString(),
      };
      // If both original and refreshed reports exist, prefer the more recent one
      if (!out[slug] || entry.generatedAt > out[slug].generatedAt) {
        out[slug] = entry;
      }
    } catch {}
  }
  return out;
}

export function parseRankings(device = 'desktop') {
  const empty = { latestDate: null, previousDate: null, device, items: [], summary: { page1: 0, quickWins: 0, needsWork: 0, notRanking: 0 } };
  if (!existsSync(SNAPSHOTS_DIR)) return empty;

  // Match device-suffixed snapshot files (YYYY-MM-DD-<device>.json). For
  // backward compatibility, legacy plain-date files (YYYY-MM-DD.json) are
  // treated as 'desktop' — that's what the API returned pre-Phase-2.
  const all = readdirSync(SNAPSHOTS_DIR).filter(f => f.endsWith('.json'));
  const deviceRe  = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${device}\\.json$`);
  const legacyRe  = /^\d{4}-\d{2}-\d{2}\.json$/;
  const deviceFiles = all.filter(f => deviceRe.test(f));
  const legacyFiles = device === 'desktop' ? all.filter(f => legacyRe.test(f)) : [];
  const files = [...deviceFiles, ...legacyFiles].sort((a, b) => {
    // Sort by date portion descending (most recent first)
    return b.slice(0, 10).localeCompare(a.slice(0, 10));
  });
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

  return { latestDate: latest.date, previousDate: previous?.date ?? null, device, items, summary };
}

export function parseCROData() {
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

export function loadRejections() {
  const p = join(ROOT, 'data', 'rejected-keywords.json');
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return []; }
}

export function isRejectedKw(keyword, rejections) {
  const kw = keyword.toLowerCase();
  return rejections.some(r => {
    const term = r.keyword.toLowerCase();
    if (r.matchType === 'exact') return kwToSlug(keyword) === kwToSlug(r.keyword);
    return kw.includes(term);
  });
}

