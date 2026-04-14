// agents/dashboard/lib/data-loader.js
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { loadLatestAhrefsOverview } from '../../../lib/ahrefs-parser.js';
import {
  ROOT, POSTS_DIR, BRIEFS_DIR, IMAGES_DIR, REPORTS_DIR, SNAPSHOTS_DIR,
  ADS_OPTIMIZER_DIR, AHREFS_DIR, CONTENT_GAP_DIR,
  RANK_ALERTS_DIR, ALERTS_VIEWED, META_TESTS_DIR, COMP_BRIEFS_DIR,
} from './paths.js';
import {
  listAllSlugs, getPostMeta as getPostMetaFromLib, getContentPath, getImagePath,
} from '../../../lib/posts.js';
import {
  parseCalendar, parseEditorReports, parseRankings, parseCROData,
  loadRejections, isRejectedKw, getPostMeta, getItemStatus, getPendingAhrefsData,
} from './data-parsers.js';
import { parseTechSeoReport } from './tech-seo-parser.js';

export function aggregateData() {
  const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

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
  {
    const allSlugs = listAllSlugs();
    for (const slug of allSlugs) {
      if (seen.has(slug)) continue;
      try {
        const meta = getPostMetaFromLib(slug);
        if (!meta) continue;
        const kw = (meta.target_keyword || '').toLowerCase();
        if (kw && seenKeywords.has(kw)) continue;
        // If shopify_publish_at exists and is in the past, the post is
        // already live on Shopify — classify as 'published' regardless of
        // whether shopify_status was explicitly stamped. This prevents
        // legacy-synced posts (which have historical publish dates but no
        // stamped status) from showing up as "scheduled" on the dashboard.
        const publishTs = meta.shopify_publish_at ? Date.parse(meta.shopify_publish_at) : NaN;
        const publishInPast = !Number.isNaN(publishTs) && publishTs <= Date.now();
        const publishInFuture = !Number.isNaN(publishTs) && publishTs > Date.now();
        const status = meta.shopify_status === 'published' || publishInPast ? 'published'
                     : publishInFuture                     ? 'scheduled'
                     : meta.shopify_article_id             ? 'draft'
                     : existsSync(getContentPath(slug)) ? 'written'
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
  {
    for (const slug of listAllSlugs()) {
      try {
        const meta = getPostMetaFromLib(slug);
        if (!meta) continue;
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
          hasImage:       existsSync(getImagePath(slug)),
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

  // ── Performance-driven SEO engine signals ──────────────────────────────────
  // Each of these files is written by a scheduled agent; read the latest if present.
  const readJsonIfExists = (path) => {
    if (!existsSync(path)) return null;
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  };

  const quickWinsRaw       = readJsonIfExists(join(REPORTS_DIR, 'quick-wins', 'latest.json'));
  const postPerformance    = readJsonIfExists(join(REPORTS_DIR, 'post-performance', 'latest.json'));
  const gscOpportunityRaw  = readJsonIfExists(join(REPORTS_DIR, 'gsc-opportunity', 'latest.json'));
  const clusterWeights     = readJsonIfExists(join(REPORTS_DIR, 'content-strategist', 'cluster-weights.json'));
  const competitorActivity = readJsonIfExists(join(REPORTS_DIR, 'competitor-watcher', 'latest.json'));
  const indexing           = readJsonIfExists(join(REPORTS_DIR, 'indexing', 'latest.json'));
  const indexingQueue      = readJsonIfExists(join(ROOT, 'data', 'performance-queue', 'indexing-submissions.json'));
  const legacyTriage    = readJsonIfExists(join(REPORTS_DIR, 'legacy-triage', 'latest.json'));
  const cannibalization = readJsonIfExists(join(REPORTS_DIR, 'cannibalization', 'latest.json'));
  const aiCitations = readJsonIfExists(join(REPORTS_DIR, 'ai-citations', 'latest.json'));
  // Enrich cannibalization conflicts with decision details (winner, action, reason)
  const cannibDecisions = readJsonIfExists(join(REPORTS_DIR, 'cannibalization', 'cannibalization-decisions.json'));
  if (cannibalization?.conflicts && cannibDecisions?.decisions) {
    const decisionMap = new Map(cannibDecisions.decisions.map((d) => [d.query, d]));
    for (const c of cannibalization.conflicts) {
      const d = decisionMap.get(c.query);
      if (d) {
        c.winner = d.winner;
        c.losers = d.losers;
        c.confidence = d.confidence;
        c.summary = d.summary;
      }
    }
  }

  // Technical SEO audit report (markdown → parsed)
  const techSeoReportRaw = (() => {
    const p = join(REPORTS_DIR, 'technical-seo', 'technical-seo-audit.md');
    if (!existsSync(p)) return null;
    try { return readFileSync(p, 'utf8'); } catch { return null; }
  })();
  const techSeoAudit = parseTechSeoReport(techSeoReportRaw);
  const techSeoFixResults = readJsonIfExists(join(REPORTS_DIR, 'technical-seo', 'fix-results.json'));
  const altTextProgress = readJsonIfExists(join(REPORTS_DIR, 'technical-seo', 'alt-text-progress.json'));

  // Theme SEO audit (JSON)
  const themeSeoAudit = readJsonIfExists(join(REPORTS_DIR, 'theme-seo-audit', 'latest.json'));

  // Rejected images — posts where CD rejected all image attempts
  const rejectedImagesDir = join(ROOT, 'data', 'images', 'rejected');
  let rejectedImages = [];
  if (existsSync(rejectedImagesDir)) {
    for (const dir of readdirSync(rejectedImagesDir)) {
      const recPath = join(rejectedImagesDir, dir, 'rejection.json');
      if (existsSync(recPath)) {
        try {
          const rec = JSON.parse(readFileSync(recPath, 'utf8'));
          // Add image filenames for the card
          const imageFiles = readdirSync(join(rejectedImagesDir, dir))
            .filter(f => f.endsWith('.webp') || f.endsWith('.png') || f.endsWith('.jpg'));
          rec.imageFiles = imageFiles;
          rejectedImages.push(rec);
        } catch { /* skip */ }
      }
    }
  }

  // Performance engine queue — items awaiting review/approval.
  // Read directly from the queue directory rather than importing the queue
  // module (which would require async import in this sync function).
  const queueDir = join(ROOT, 'data', 'performance-queue');
  let performanceQueue = [];
  if (existsSync(queueDir)) {
    for (const f of readdirSync(queueDir).filter((n) => n.endsWith('.json') && n !== 'indexing-submissions.json')) {
      try {
        const item = JSON.parse(readFileSync(join(queueDir, f), 'utf8'));
        if (item.status !== 'dismissed' && item.status !== 'published') {
          item.has_html = !!(item.refreshed_html_path && existsSync(item.refreshed_html_path));
          performanceQueue.push(item);
        }
      } catch { /* skip */ }
    }
    performanceQueue.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  }

  // Apply the existing keyword rejection list to signals produced by the
  // agents. Rejections are brand-conflict or off-topic terms that must not
  // be targeted (see data/rejected-keywords.json). Filtering here means the
  // dashboard is immediately clean after a rejection is added — no need to
  // re-run the upstream agents.
  const dropRejectedByKeyword = (row) => !isRejectedKw(row.keyword || '', rejections);
  const dropRejectedByQuery = (row) => !isRejectedKw(row.top_query || row.title || row.slug || '', rejections);

  // Quick-wins: require posts to be at least 30 days old before they count
  // as candidates. Brand-new posts need time to stabilize their GSC signals.
  const QUICK_WIN_MIN_AGE_DAYS = 30;
  const nowMs = Date.now();
  const isOldEnough = (slug) => {
    try {
      const meta = getPostMetaFromLib(slug);
      const pub = meta?.published_at;
      if (!pub) return false;
      const age = Math.floor((nowMs - Date.parse(pub)) / 86400000);
      return age >= QUICK_WIN_MIN_AGE_DAYS;
    } catch { return false; }
  };

  // Also require real impression signal — a post with 0 impressions is not
  // a "quick win", it's "not indexed yet" or "not matching any query".
  const QUICK_WIN_MIN_IMPRESSIONS = 10;
  const quickWins = quickWinsRaw ? (() => {
    const filtered = (quickWinsRaw.top || [])
      .filter(dropRejectedByQuery)
      .filter((r) => isOldEnough(r.slug))
      .filter((r) => (r.impressions || 0) >= QUICK_WIN_MIN_IMPRESSIONS);
    return {
      ...quickWinsRaw,
      top: filtered,
      candidate_count: filtered.length,
    };
  })() : null;

  const gscOpportunity = gscOpportunityRaw ? {
    ...gscOpportunityRaw,
    low_ctr:  (gscOpportunityRaw.low_ctr  || []).filter(dropRejectedByKeyword),
    page_2:   (gscOpportunityRaw.page_2   || []).filter(dropRejectedByKeyword),
    unmapped: (gscOpportunityRaw.unmapped || []).filter(dropRejectedByKeyword),
  } : null;

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
    quickWins,
    postPerformance,
    gscOpportunity,
    clusterWeights,
    competitorActivity,
    indexing,
    indexingQueue,
    performanceQueue,
    legacyTriage,
    cannibalization,
    aiCitations,
    techSeoAudit,
    techSeoFixResults,
    altTextProgress,
    themeSeoAudit,
    rejectedImages,
  };
}

let _cache = null;
let _cacheExpiry = 0;
const CACHE_TTL_MS = 2000;

export function loadData() {
  const now = Date.now();
  if (_cache && now < _cacheExpiry) return _cache;
  _cache = aggregateData();
  _cacheExpiry = now + CACHE_TTL_MS;
  return _cache;
}

export function invalidateDataCache() {
  _cache = null;
  _cacheExpiry = 0;
}
