// agents/dashboard/lib/data-parsers.js
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  ROOT, POSTS_DIR, BRIEFS_DIR, REPORTS_DIR, SNAPSHOTS_DIR, CALENDAR_PATH,
  CLARITY_SNAPSHOTS_DIR, SHOPIFY_SNAPSHOTS_DIR, GSC_SNAPSHOTS_DIR,
  GA4_SNAPSHOTS_DIR, GOOGLE_ADS_SNAPSHOTS_DIR, CRO_REPORTS_DIR,
  AHREFS_DIR,
} from './paths.js';
import { kwToSlug } from './fs-helpers.js';

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

export function getItemStatus(item) {
  const meta = getPostMeta(item.slug);
  const hasBrief = existsSync(join(BRIEFS_DIR, `${item.slug}.json`));
  const hasHtml  = existsSync(join(POSTS_DIR, `${item.slug}.html`));
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

export function parseRankings() {
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

export function checkAhrefsData(keyword) {
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

export function getPendingAhrefsData(calItems) {
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
