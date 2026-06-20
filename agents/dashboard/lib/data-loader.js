// agents/dashboard/lib/data-loader.js
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  ROOT, POSTS_DIR, BRIEFS_DIR, IMAGES_DIR, REPORTS_DIR, SNAPSHOTS_DIR,
  ADS_OPTIMIZER_DIR, SEO_AUTHORITY_DIR,
  RANK_ALERTS_DIR, ALERTS_VIEWED, META_TESTS_DIR, COMP_BRIEFS_DIR,
} from './paths.js';
import {
  listAllSlugs, getPostMeta as getPostMetaFromLib, getContentPath, getImagePath,
  getEditorReportPath,
} from '../../../lib/posts.js';
import {
  parseCalendar, parseEditorReports, parseRankings, parseCROData,
  loadRejections, isRejectedKw, getPostMeta, getItemStatus,
} from './data-parsers.js';
import { parseTechSeoReport } from './tech-seo-parser.js';

// How recent a live post's editor report must be to count as a freshly-blocked
// refresh (vs an ancient stale report on a healthy legacy post). Days.
const LIVE_BLOCK_FRESHNESS_DAYS = 30;

/**
 * Pure decision: given a post's editor report + meta (+ report age), should it
 * surface as hard-blocked, and is it a live post whose refresh is blocked?
 * Extracted so the rules are unit-tested and can't silently regress (the
 * `shopify_publish_at`-in-the-past over-filter once hid every refresh-blocked
 * live post — the gap behind "blocked posts aren't surfaced anywhere").
 *
 * Rules (in order):
 *   1. Report must contain a "VERDICT: Needs Work" — cheap pre-filter.
 *   2. Skip only posts Shopify EXPLICITLY marks live (status published/scheduled).
 *      An UNSET status does NOT mean "fine": a refresh of an already-live post
 *      that fails the gate leaves the live post on old content with a fresh
 *      Needs Work report — exactly what must surface.
 *   3. "## OVERALL QUALITY" verdict (the editor's canonical sign-off) trumps
 *      sub-section verdicts: Pass / Good / Excellent → not blocked.
 *   4. "## BLOCKERS*" section starting with "None" → not blocked.
 *   5. For an already-live post (publish date in the past), require a RECENT
 *      report so an ancient stale report on a healthy legacy post doesn't flood
 *      the card. New (not-yet-live) posts surface regardless of age.
 *
 * @returns {{live:boolean, blockerText:string}|null} null = not blocked
 */
export function classifyBlockedReport({ report, meta, reportAgeDays = Infinity, now = Date.now() }) {
  if (!report || !meta) return null;
  if (!/VERDICT[:*\s]*Needs Work/i.test(report)) return null;                              // rule 1
  if (meta.shopify_status === 'published' || meta.shopify_status === 'scheduled') return null; // rule 2

  const overallMatch = report.match(/##[^\n]*OVERALL QUALITY[^\n]*\n[\s\S]*?VERDICT[:*\s]+([^\n]+)/i);
  if (overallMatch && !/needs work/i.test(overallMatch[1])) return null;                   // rule 3

  const blockersMatch = report.match(/##[^\n]*BLOCKER[^\n]*\n([\s\S]*?)(?=\n##|\n---|$)/i);
  if (blockersMatch && /^\s*None\b/i.test(blockersMatch[1].trim())) return null;           // rule 4

  const publishTs = meta.shopify_publish_at ? Date.parse(meta.shopify_publish_at) : NaN;
  const live = !Number.isNaN(publishTs) && publishTs <= now;
  if (live && reportAgeDays > LIVE_BLOCK_FRESHNESS_DAYS) return null;                       // rule 5

  const blockerText = blockersMatch ? blockersMatch[1].trim().slice(0, 600) : 'See editor report for details.';
  return { live, blockerText };
}

/**
 * Find posts hard-blocked by the editorial gate — pre-publish posts stuck before
 * going live, AND already-live posts whose refresh just failed the gate (the
 * live post serves old content while the refreshed version is held).
 *
 * Mirrors `findBlockedPosts()` in agents/daily-summary/index.js so the dashboard
 * and the email surface the same set.
 */
function findBlockedPosts() {
  const blocked = [];
  for (const slug of listAllSlugs()) {
    try {
      const reportPath = getEditorReportPath(slug);
      if (!existsSync(reportPath)) continue;
      const report = readFileSync(reportPath, 'utf8');
      const meta = getPostMetaFromLib(slug);
      if (!meta) continue;
      let reportAgeDays = Infinity;
      try { reportAgeDays = (Date.now() - statSync(reportPath).mtimeMs) / 86400000; } catch { /* keep Infinity → skip stale live */ }

      const verdict = classifyBlockedReport({ report, meta, reportAgeDays });
      if (!verdict) continue;

      blocked.push({
        title: meta.title || slug,
        slug,
        post_type: meta.post_type || null, // 'product' | 'topical_authority' | null (legacy, untagged)
        live: verdict.live,                // live post whose refresh is blocked vs new post stuck pre-publish
        blockers: verdict.blockerText,
      });
    } catch { /* skip */ }
  }
  return blocked;
}

export function aggregateData() {
  const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

  const calItems    = parseCalendar();
  const editorMap   = parseEditorReports();
  const rankings    = parseRankings('desktop');
  const rankingsMobile = parseRankings('mobile');
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
          hasImage:       existsSync(getImagePath(slug)) || !!meta.shopify_image_url,
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

  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const adsOptPath = join(ADS_OPTIMIZER_DIR, `${today}.json`);
  const adsOptimizationRaw = existsSync(adsOptPath)
    ? JSON.parse(readFileSync(adsOptPath, 'utf8'))
    : null;
  const adsOptimization = adsOptimizationRaw ? { ...adsOptimizationRaw, date: today } : null;

  // SEO authority (DataForSEO-backed, refreshed on demand via /api/seo-authority/refresh)
  const authorityPath = join(SEO_AUTHORITY_DIR, 'latest.json');
  const seoAuthority = existsSync(authorityPath)
    ? (() => { try { return JSON.parse(readFileSync(authorityPath, 'utf8')); } catch { return null; } })()
    : null;

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

  // Latest content-gap report timestamp (if any)
  const contentGapReportPath = join(REPORTS_DIR, 'content-gap', 'content-gap-report.md');
  const contentGapLastReport = existsSync(contentGapReportPath)
    ? new Date(statSync(contentGapReportPath).mtimeMs).toLocaleString()
    : null;

  // ── Performance-driven SEO engine signals ──────────────────────────────────
  // Each of these files is written by a scheduled agent; read the latest if present.
  const readJsonIfExists = (path) => {
    if (!existsSync(path)) return null;
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  };

  const quickWinsRaw       = readJsonIfExists(join(REPORTS_DIR, 'quick-wins', 'latest.json'));
  const seoImpact          = readJsonIfExists(join(REPORTS_DIR, 'seo-impact', 'latest.json'));
  const postPerformance    = readJsonIfExists(join(REPORTS_DIR, 'post-performance', 'latest.json'));
  const gscOpportunityRaw  = readJsonIfExists(join(REPORTS_DIR, 'gsc-opportunity', 'latest.json'));
  const clusterWeights     = readJsonIfExists(join(REPORTS_DIR, 'content-strategist', 'cluster-weights.json'));
  const competitorActivity = readJsonIfExists(join(REPORTS_DIR, 'competitor-watcher', 'latest.json'));
  const indexing           = readJsonIfExists(join(REPORTS_DIR, 'indexing', 'latest.json'));
  const indexingQueue      = readJsonIfExists(join(ROOT, 'data', 'performance-queue', 'indexing-submissions.json'));
  const legacyTriage    = readJsonIfExists(join(REPORTS_DIR, 'legacy-triage', 'latest.json'));
  const cannibalization = readJsonIfExists(join(REPORTS_DIR, 'cannibalization', 'latest.json'));
  const aiCitations = readJsonIfExists(join(REPORTS_DIR, 'ai-citations', 'latest.json'));
  const prTargets = readJsonIfExists(join(REPORTS_DIR, 'pr-targets', 'latest.json'));
  const pipelinePrioritizer = readJsonIfExists(join(REPORTS_DIR, 'pipeline-prioritizer', 'latest.json'));
  const priorityTuner       = readJsonIfExists(join(REPORTS_DIR, 'priority-tuner', 'latest.json'));
  // Load previous AI citation snapshot for week-over-week delta
  let aiCitationsPrev = null;
  try {
    const citDir = join(REPORTS_DIR, 'ai-citations');
    if (existsSync(citDir)) {
      const citFiles = readdirSync(citDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
      const today = aiCitations?.date;
      const prevFile = citFiles.find((f) => f.replace('.json', '') !== today);
      if (prevFile) aiCitationsPrev = JSON.parse(readFileSync(join(citDir, prevFile), 'utf8'));
    }
  } catch { /* skip */ }
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
        // Terminal states leave the active queue. `completed` = an approved
        // seo-opportunity whose executor finished successfully (its real output
        // is the executor's own artifact / downstream review item). `failed`
        // stays VISIBLE so a silently-failed executor surfaces for action.
        if (!['dismissed', 'published', 'completed'].includes(item.status)) {
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
    rankingsMobile,
    posts,
    cro,
    googleAdsAll: cro.googleAdsAll,
    adsOptimization,
    seoAuthority,
    rankAlert,
    metaTests,
    briefs,
    contentGapLastReport,
    quickWins,
    seoImpact,
    pipelinePrioritizer,
    priorityTuner,
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
    aiCitationsPrev,
    prTargets,
    techSeoAudit,
    techSeoFixResults,
    altTextProgress,
    themeSeoAudit,
    rejectedImages,
    blockedPosts: findBlockedPosts(),
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
