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

// Resolve which snapshots to use as comparison baselines for the rankings
// change column. Snapshots are taken irregularly (not daily), so fixed windows
// (30d/90d) resolve to the nearest available snapshot and may collapse onto the
// same file as Previous or Max — those duplicates are dropped. `files` is the
// list of snapshot filenames sorted most-recent-first; `latestDate` is files[0]'s
// date. Returns baselines ordered by recency (Previous → 30d → 90d → Max).
function resolveRankBaselines(files, latestDate) {
  if (files.length < 2) return [];
  const dayMs = 86400000;
  const dateOf = f => f.slice(0, 10);
  const msOf   = d => new Date(d + 'T00:00:00Z').getTime();
  const latestMs = msOf(latestDate);
  const daysBetween = d => Math.round((latestMs - msOf(d)) / dayMs);

  // Older snapshots only (everything after files[0]).
  const older = files.slice(1);

  // Snapshot whose date is closest to (latestDate - targetDays), among older snapshots.
  const closestTo = (targetDays) => {
    const targetMs = latestMs - targetDays * dayMs;
    let best = null, bestDiff = Infinity;
    for (const f of older) {
      const diff = Math.abs(msOf(dateOf(f)) - targetMs);
      if (diff < bestDiff) { bestDiff = diff; best = f; }
    }
    return best;
  };

  // Candidates, in dedup-priority order: Max and Previous always survive; the
  // fixed windows yield only when they resolve to a distinct snapshot.
  const candidates = [
    { key: 'max',      label: 'Max',      file: older[older.length - 1] },
    { key: 'previous', label: 'Previous', file: older[0] },
    { key: 'd30',      label: '30d',      file: closestTo(30) },
    { key: 'd90',      label: '90d',      file: closestTo(90) },
  ];

  const usedDates = new Set();
  const kept = [];
  for (const c of candidates) {
    if (!c.file) continue;
    const date = dateOf(c.file);
    if (usedDates.has(date)) continue;
    usedDates.add(date);
    kept.push({ ...c, date, days: daysBetween(date) });
  }

  // Display order: most recent baseline first (fewest days back).
  return kept.sort((a, b) => a.days - b.days);
}

export function parseRankings(device = 'desktop') {
  const empty = { latestDate: null, previousDate: null, device, items: [], baselines: [], defaultBaseline: null, summary: { page1: 0, quickWins: 0, needsWork: 0, notRanking: 0 } };
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

  const latest = JSON.parse(readFileSync(join(SNAPSHOTS_DIR, files[0]), 'utf8'));

  // Resolve comparison baselines and load each baseline's position maps once.
  const baselineDefs = resolveRankBaselines(files, latest.date);
  // Default to the oldest baseline (Max) so the change column shows growth over
  // the full extent of data; fall back to whatever exists for tiny histories.
  const defaultBaseline = baselineDefs.some(b => b.key === 'max')
    ? 'max'
    : (baselineDefs[baselineDefs.length - 1]?.key ?? null);

  const baselineMaps = {}; // key -> { posts: {slug:pos}, kws: {kw:pos} }
  for (const b of baselineDefs) {
    const snap = JSON.parse(readFileSync(join(SNAPSHOTS_DIR, b.file), 'utf8'));
    const postMap = {}, kwMap = {};
    for (const p of snap.posts ?? []) postMap[p.slug] = p.position;
    for (const p of snap.allKeywords ?? []) kwMap[p.keyword] = p.position;
    baselineMaps[b.key] = { posts: postMap, kws: kwMap };
  }

  const changeFrom = (prev, pos) => (pos != null && prev != null) ? prev - pos : null;

  // Build an item from a latest-snapshot row. `mapKey` selects which baseline map
  // ('posts' or 'kws') to read, `idKey` the field that keys it ('slug' or 'keyword').
  const toItem = (p, mapKey, idKey, tracked) => {
    const id = p[idKey];
    const changes = {}; // per-baseline change; the selector picks which to show
    for (const b of baselineDefs) {
      changes[b.key] = changeFrom(baselineMaps[b.key][mapKey][id] ?? null, p.position);
    }
    const defPrev = defaultBaseline ? (baselineMaps[defaultBaseline][mapKey][id] ?? null) : null;
    const tier = !p.position       ? 'notRanking'
               : p.position <= 10  ? 'page1'
               : p.position <= 20  ? 'quickWins'
               : 'needsWork';
    // change/previousPosition keep the default baseline's values for backward compat.
    return { ...p, changes, previousPosition: defPrev, change: changes[defaultBaseline] ?? null, tier, tracked };
  };

  const trackedItems = (latest.posts ?? []).map(p => toItem(p, 'posts', 'slug', true));
  const allKwItems   = (latest.allKeywords ?? []).map(p => toItem(p, 'kws', 'keyword', false));

  const items = [...trackedItems, ...allKwItems].sort((a, b) => {
    if (a.position == null && b.position == null) return 0;
    if (a.position == null) return 1;
    if (b.position == null) return -1;
    return a.position - b.position;
  });

  const summary = items.reduce((acc, x) => { acc[x.tier]++; return acc; },
    { page1: 0, quickWins: 0, needsWork: 0, notRanking: 0 });

  const previousBaseline = baselineDefs.find(b => b.key === 'previous');
  return {
    latestDate: latest.date,
    previousDate: previousBaseline?.date ?? null,
    device,
    items,
    baselines: baselineDefs.map(({ key, label, date, days }) => ({ key, label, date, days })),
    defaultBaseline,
    summary,
  };
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

  // Load up to 90 GSC snapshots (supports 90-day filter + 90→180 comparison)
  let gscAll = [];
  if (existsSync(GSC_SNAPSHOTS_DIR)) {
    const files = readdirSync(GSC_SNAPSHOTS_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse().slice(0, 90);
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

