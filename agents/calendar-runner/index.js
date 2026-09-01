#!/usr/bin/env node
/**
 * Calendar Runner Agent
 *
 * Reads the content calendar produced by the content-strategist, determines
 * the pipeline status of each item, applies GSC / rank-tracker feedback to
 * adjust publish dates, then executes the pipeline for items that need work.
 *
 * Status flow per item:
 *   pending  → no brief yet           (next: content-researcher)
 *   briefed  → brief exists, no post  (next: blog-post-writer → image → edit → schema → publish)
 *   written  → post HTML exists, not on Shopify
 *   draft    → on Shopify as draft, no publish date
 *   scheduled → has a publish date
 *   published → live
 *
 * Revenue feedback (re-evaluated each run, from data/reports/seo-impact/latest.json):
 *   - Cluster that earned money        → accelerate its items by 2 days
 *   - Cluster with traffic and $0      → NOT DRAFTED AT ALL. Deferring only moved
 *                                        the post to October; it still got written.
 *   - Cluster with too little traffic  → left alone, so a new category can be tested
 * Priority used to key on RANKING here. It does not any more: toothpaste ranks
 * well enough for 725 clicks across 26 pages and returns $0, and rank-keyed
 * priority kept pulling more toothpaste posts forward.
 *
 * USAGE:
 *   node agents/calendar-runner/index.js               # print calendar status
 *   node agents/calendar-runner/index.js --run         # execute next pending item
 *   node agents/calendar-runner/index.js --run --all   # execute all pending items
 *   node agents/calendar-runner/index.js --dry-run     # show pipeline commands without running
 *   node agents/calendar-runner/index.js --keyword "cinnamon toothpaste" --run  # run one specific item
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadCalendar } from '../../lib/calendar-store.js';
import { getMetaPath, getContentPath, getPostMeta as readPostMeta, getEditorReportPath, listAllSlugs, POSTS_DIR } from '../../lib/posts.js';
import { formatPublishAt } from '../../lib/publish-schedule.js';
import { checkEditGate, runEditGateWithRepair } from '../../lib/edit-gate-repair.js';
import { clusterForText } from '../../lib/cluster-revenue.js';
import { loadClusterHold, corroboratedClassification, holdBanner } from '../../lib/cluster-hold.js';
import { isRejected as sharedIsRejected } from '../../lib/rejected-keywords.js';
// Re-export for back-compat: formatPublishAt used to be defined in this file; tests
// and callers that import it from calendar-runner keep working post-extraction.
export { formatPublishAt } from '../../lib/publish-schedule.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const PRIORITY_CFG = (() => { try { return JSON.parse(readFileSync(join(ROOT, 'config', 'pipeline-priority.json'), 'utf8')); } catch { return { buffer: { days: 7 } }; } })();
const BUFFER_DAYS = PRIORITY_CFG.buffer?.days ?? 7;
// Days without a draft that mean the pipeline is broken rather than idle.
const STALL_DAYS = PRIORITY_CFG.buffer?.stallDays ?? 10;
// Cluster priority is keyed on revenue, not ranking — see lib/cluster-revenue.js.
const ACCELERATE_DAYS = PRIORITY_CFG.revenue?.accelerateDays ?? 2;
const DEFER_DAYS      = PRIORITY_CFG.revenue?.deferDays ?? 14;

const CALENDAR_PATH    = join(ROOT, 'data', 'reports', 'content-strategist', 'content-calendar.md');
const STATE_DIR        = join(ROOT, 'data', 'reports', 'calendar-runner');
const STATE_PATH       = join(STATE_DIR, 'calendar-state.json');

const BRIEFS_DIR       = join(ROOT, 'data', 'briefs');

// ── args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const doRun       = args.includes('--run');
const doAll       = args.includes('--all');
const dryRun      = args.includes('--dry-run');
const doPublishDue = args.includes('--publish-due');
const kwArg       = (() => { const i = args.indexOf('--keyword'); return i !== -1 ? args[i + 1] : null; })();

// ── parse calendar markdown ───────────────────────────────────────────────────

function parseCalendar() {
  // Prefer the canonical JSON calendar; loadCalendar() falls back to markdown for legacy data.
  const calendar = loadCalendar();
  if (!calendar.items.length) {
    console.error(`Calendar is empty. Check data/calendar/calendar.json or ${CALENDAR_PATH}`);
    console.error('Run: node agents/content-strategist/index.js');
    process.exit(1);
  }

  const items = calendar.items.map((i) => ({
    week: i.week,
    publishDate: i.publish_date ? new Date(i.publish_date) : null,
    category: i.category || '',
    keyword: i.keyword,
    title: i.title || '',
    kd: i.kd ?? 0,
    volume: i.volume ?? 0,
    contentType: i.content_type || '',
    priority: i.priority || '',
    slug: i.slug,
    status: i.status || null,
  })).filter((i) => i.publishDate && i.status !== 'review');

  return items.sort((a, b) => a.publishDate - b.publishDate);
}

function keywordToSlug(keyword) {
  return keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// ── rejected keywords ─────────────────────────────────────────────────────────

function loadRejections() {
  const p = join(ROOT, 'data', 'rejected-keywords.json');
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return []; }
}

// One rule, in lib/rejected-keywords.js. This was a local copy; there were NINE,
// and three of them disagreed about what `exact` means.
function isRejectedKw(keyword, rejections) {
  return sharedIsRejected(keyword, rejections);
}

// ── determine item status ─────────────────────────────────────────────────────

function getPostMeta(slug) {
  // Try exact slug match first, then scan for matching target_keyword
  const exact = getMetaPath(slug);
  if (existsSync(exact)) {
    try { return JSON.parse(readFileSync(exact, 'utf8')); } catch { return null; }
  }

  // Scan all post JSONs for matching keyword
  for (const s of listAllSlugs()) {
    try {
      const meta = readPostMeta(s);
      if (!meta) continue;
      if (meta.target_keyword?.toLowerCase() === slug.replace(/-/g, ' ').toLowerCase()) {
        return meta;
      }
    } catch { /* skip */ }
  }
  return null;
}

function getPostSlugOnDisk(keyword) {
  const targetKw = keyword.toLowerCase();
  for (const slug of listAllSlugs()) {
    try {
      const meta = readPostMeta(slug);
      if (!meta) continue;
      if (meta.target_keyword?.toLowerCase() === targetKw) {
        return slug;
      }
    } catch { /* skip */ }
  }
  return null;
}

function getItemStatus(item) {
  const briefPath = join(BRIEFS_DIR, `${item.slug}.json`);
  const htmlPath  = getContentPath(item.slug);

  const meta = getPostMeta(item.slug);
  const actualSlug = getPostSlugOnDisk(item.keyword) || item.slug;

  const briefExists = existsSync(briefPath)
    || existsSync(join(BRIEFS_DIR, `${actualSlug}.json`));

  const htmlExists = existsSync(htmlPath)
    || existsSync(getContentPath(actualSlug));

  if (!briefExists && !htmlExists && !meta) return 'pending';
  if (meta?.shopify_status === 'published') return 'published';
  if (meta?.shopify_publish_at) return 'scheduled';
  if (meta?.shopify_article_id) return 'draft';
  if (htmlExists) return 'written';
  if (briefExists) return 'briefed';
  return 'pending';
}

/**
 * Split the calendar into what to draft now and what is merely not due yet.
 *
 * Lead-window guard (JIT): only draft items whose publish date is within
 * BUFFER_DAYS. Promoted ideas get a near-term slot from the prioritizer; ideas
 * dated further out wait. A keyword-targeted run is an explicit override.
 *
 * `deferred` is sorted earliest-first and exists so the caller can say WHY it
 * has nothing to do — an empty selection used to be indistinguishable from an
 * empty calendar.
 */
export function selectWorkItems(items, {
  now = new Date(),
  bufferDays = BUFFER_DAYS,
  keyword = null,
  statusOf = getItemStatus,
  clusterRevenue = null,
} = {}) {
  const unfinished = items.filter((i) => !['published', 'scheduled'].includes(statusOf(i)));

  if (keyword) {
    // Naming an item by hand is a deliberate override of every rule below.
    return {
      workItems: unfinished.filter((i) => i.keyword.toLowerCase() === keyword.toLowerCase()),
      deferred: [], blocked: [],
    };
  }

  // Clusters we have decided not to add to. Deferring these only moved the post
  // down the calendar — it still got written, just in October. Only fires when
  // revenue data was actually supplied; absent data is not evidence of $0.
  const blocked = [];
  const open = [];
  for (const i of unfinished) {
    const cluster = clusterRevenue
      ? (clusterForText(i.keyword) || clusterForText(i.category))
      : null;
    const c = cluster ? clusterRevenue[cluster] : null;
    if (c?.status === 'proven_dud') {
      blocked.push({ ...i, blockedReason: `${cluster} cluster does not earn (${c.clicks} clicks across ${c.pages} pages, $0.00)` });
    } else {
      open.push(i);
    }
  }

  const cutoff = new Date(now.getTime() + bufferDays * 86400000);
  const due = (i) => i.adjustedDate || i.publishDate;
  return {
    workItems: open.filter((i) => due(i) <= cutoff),
    // Blocked items are NOT deferred — work we have decided not to do is not
    // work waiting, and counting it as backlog would fire the stall alert
    // forever on a calendar that is functioning as intended.
    deferred: open.filter((i) => due(i) > cutoff).sort((a, b) => due(a) - due(b)),
    blocked,
  };
}

/**
 * Has drafting stopped? Pure — the caller supplies the two facts.
 *
 * At the calendar's 2-posts-per-week pacing the largest legitimate gap between
 * drafts is about four days, so a gap past `maxIdleDays` with unwritten items
 * waiting is not a quiet week, it is a broken pipeline. This exists because the
 * 2026-08 stall ran twelve days while every daily run logged "✓ complete", and a
 * more honest log line would not have been read either.
 */
export function detectDraftStall({ lastDraftedAt, pendingCount, now = new Date(), maxIdleDays = STALL_DAYS }) {
  if (!pendingCount) return { stalled: false, idleDays: null };
  if (!lastDraftedAt) return { stalled: true, idleDays: null };
  const idleDays = Math.floor((now - lastDraftedAt) / 86400000);
  return { stalled: idleDays > maxIdleDays, idleDays };
}

/** Newest `generated_at` across every post on disk, or null if there are none. */
function lastDraftedAt() {
  let newest = null;
  for (const slug of listAllSlugs()) {
    try {
      const at = readPostMeta(slug)?.generated_at;
      if (!at) continue;
      const d = new Date(at);
      if (!isNaN(d) && (!newest || d > newest)) newest = d;
    } catch { /* skip */ }
  }
  return newest;
}

// ── revenue feedback ──────────────────────────────────────────────────────────

/**
 * Days to shift an item, keyed on what its cluster EARNS. Pure.
 *
 * Bucketed from the KEYWORD first, falling back to the calendar's `category`
 * label. Both go through clusterForText so this agrees with what the brief
 * triage decided about the same topic — seo-impact keeps 'bar soap' and 'soap'
 * as separate clusters with different verdicts, so reading the LLM's "Bar Soap"
 * label had "oatmeal soap" judged untested here while its brief was being
 * deleted as a $0 soap topic.
 */
export function revenueAdjustment(category, classified, keyword = null) {
  const cluster = clusterForText(keyword) || clusterForText(category);
  const c = cluster ? classified?.[cluster] : null;
  const status = c?.status || 'unproven';

  // Both messages quote the PRODUCT figure, because that is what the verdict was
  // made on. Printing `revenue` (the entry-page alias) beside a decision made on
  // a different number is how the two came to be confused in the first place.
  if (status === 'earning') {
    return { days: -ACCELERATE_DAYS, reason: `${cluster} cluster sold $${(Number(c.productRevenue) || 0).toFixed(2)} — accelerated ${ACCELERATE_DAYS} days` };
  }
  if (status === 'proven_dud') {
    return { days: DEFER_DAYS, reason: `${cluster} cluster sold $0.00 across ${c.clicks} clicks / ${c.pages} pages — deferred ${DEFER_DAYS} days behind work that earns` };
  }
  // Unproven: too little traffic to judge. Left alone on purpose — deprioritising
  // an untested category is how a category never gets tested.
  return { days: 0, reason: null };
}

function applyFeedbackAdjustments(items, classified = loadClusterRevenue()) {
  const state = loadState();

  return items.map(item => {
    // Check if we have a manually adjusted date in state
    const saved = state[item.keyword];
    const baseDate = saved?.adjustedDate
      ? new Date(saved.adjustedDate)
      : item.publishDate;

    const { days, reason } = revenueAdjustment(item.category, classified, item.keyword);
    const adjustedDate = new Date(baseDate.getTime() + days * 86400000);

    return { ...item, adjustedDate, adjustmentReason: reason };
  });
}

/**
 * Per-cluster revenue from the latest seo-impact run; {} when it has not run.
 *
 * Corroborated against real Shopify orders before anything is blocked or
 * deferred — see lib/cluster-hold.js. Blocking a work item stops it being
 * drafted at all, so it holds to the same bar as the spend hold rather than to
 * seo-impact's directional attribution alone.
 */
function loadClusterRevenue() {
  try {
    const hold = loadClusterHold({ root: ROOT });
    // Missing AND stale both speak here — holdBanner returns a line for each.
    const banner = holdBanner(hold);
    if (banner) console.log(banner);
    return corroboratedClassification(hold);
  } catch (e) {
    // Same reasoning as content-strategist's: `{}` blocks nothing, which is
    // correct, but a silent catch makes a defect in the loader indistinguishable
    // from a report that found no duds.
    console.log(`  ⚠ cluster revenue could not be loaded (${e.message}) — nothing is blocked or deferred this run.`);
    return {};
  }
}

// ── state persistence ─────────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(STATE_PATH)) return {};
  try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}

function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function updateItemState(keyword, updates) {
  const state = loadState();
  state[keyword] = { ...(state[keyword] || {}), ...updates, lastUpdated: new Date().toISOString() };
  saveState(state);
}

// ── pipeline execution ────────────────────────────────────────────────────────

function run(cmd, label) {
  console.log(`  ▶  ${label}`);
  if (dryRun) {
    console.log(`     $ ${cmd}`);
    return true;
  }
  try {
    execSync(cmd, { stdio: 'inherit', cwd: ROOT });
    return true;
  } catch (err) {
    console.error(`  ✗  ${label} failed (exit ${err.status})`);
    return false;
  }
}

// checkEditGate / attemptRepair / runEditGateWithRepair now live in
// lib/edit-gate-repair.js so the dashboard's "Fix blockers" action runs the
// exact same loop. Pass this file's dry-run-aware `run` so repairs honor --dry-run.

function checkBrokenLinks(slug) {
  const reportPath = getEditorReportPath(slug);
  if (!existsSync(reportPath)) return { count404: 0 };
  const report = readFileSync(reportPath, 'utf8');

  // Load blog index handles so we can exclude internal draft links
  let knownHandles = new Set();
  try {
    const idx = JSON.parse(readFileSync(join(ROOT, 'data', 'blog-index.json'), 'utf8'));
    for (const blog of (Array.isArray(idx) ? idx : [idx])) {
      for (const a of (blog.articles || [])) knownHandles.add(a.handle);
    }
  } catch {}

  // Count 404 rows that are NOT internal links to known (draft) articles
  const rowRegex = /^\|\s*(https?:\/\/[^|]+?)\s*\|[^|]*\|\s*404\s*\|/gm;
  let count = 0;
  for (const m of report.matchAll(rowRegex)) {
    const url = m[1].trim();
    // Skip internal links to articles that exist in the blog index (just draft)
    const internalMatch = url.match(/\/blogs\/[^/]+\/(.+?)(?:\?.*)?$/);
    if (internalMatch && knownHandles.has(internalMatch[1])) continue;
    count++;
  }
  return { count404: count };
}

async function runItem(item) {
  const status = getItemStatus(item);
  const actualSlug = getPostSlugOnDisk(item.keyword) || item.slug;
  const publishAt = formatPublishAt(item.adjustedDate || item.publishDate);

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  "${item.title}"`);
  console.log(`  Keyword: ${item.keyword} | Slug: ${actualSlug} | Publish: ${publishAt}`);
  if (item.adjustmentReason) console.log(`  📊 Date adjusted: ${item.adjustmentReason}`);
  console.log(`  Current status: ${statusLabel(status)}`);

  if (status === 'published') {
    console.log('  ✓ Already published — skipping.');
    return true;
  }
  if (status === 'scheduled') {
    console.log('  ✓ Already scheduled — skipping.');
    return true;
  }

  // Step 1: Research (if no brief)
  if (status === 'pending') {
    const ok = run(
      `node agents/content-researcher/index.js "${item.keyword}"`,
      `research: "${item.keyword}"`
    );
    if (!ok) return false;
  }

  // Step 2: Write
  const briefSlug = existsSync(join(BRIEFS_DIR, `${item.slug}.json`)) ? item.slug : actualSlug;
  if (status === 'pending' || status === 'briefed') {
    const ok = run(
      `node agents/blog-post-writer/index.js data/briefs/${briefSlug}.json`,
      `write: ${briefSlug}`
    );
    if (!ok) return false;
  }

  // Resolve actual slug on disk after writing (writer may use brief's slug)
  const postSlug = getPostSlugOnDisk(item.keyword) || item.slug;

  // Step 3: Image — check both legacy (data/images/) and current (data/posts/<slug>/) paths
  if (!existsSync(join(ROOT, 'data', 'posts', postSlug, 'image.webp')) &&
      !existsSync(join(ROOT, 'data', 'images', `${postSlug}.webp`)) &&
      !existsSync(join(ROOT, 'data', 'images', `${postSlug}.png`))) {
    const ok = run(
      `node agents/image-generator/index.js data/posts/${postSlug}/meta.json`,
      `image: ${postSlug}`
    );
    if (!ok) return false;
  }

  // Step 4: Answer-first rewrite (LLM citation optimization)
  run(
    `node agents/answer-first-rewriter/index.js ${postSlug} --apply`,
    `answer-first: ${postSlug}`
  );

  // Step 5: Edit (final quality check)
  const editorReport = getEditorReportPath(postSlug);
  if (!existsSync(editorReport)) {
    const ok = run(
      `node agents/editor/index.js data/posts/${postSlug}/content.html`,
      `edit: ${postSlug}`
    );
    if (!ok) return false;
  }

  // Editorial gate — auto-repair (looped) if blocked; escalate only if it can't be fixed.
  {
    const initial = checkEditGate(postSlug);
    if (!initial.pass) console.log(`  ⚠️ Editorial gate blocked: ${initial.reason}`);
    const { gate } = runEditGateWithRepair(postSlug, { run });
    if (!gate.pass) {
      console.log(`  ⛔ Still blocked after repair attempts: ${gate.reason}`);
      console.log(`     Review data/posts/${postSlug}/editor-report.md and fix manually.`);
      updateItemState(item.keyword, { blockedAt: new Date().toISOString(), blockReason: gate.reason });
      return false;
    }
    if (!initial.pass) console.log(`  ✓ Repair succeeded — editorial gate now passes.`);
  }

  // Broken-link gate — check for 404s in editor report; repair them if found
  const brokenGate = checkBrokenLinks(postSlug);
  if (brokenGate.count404 > 0) {
    const repaired = run(
      `node agents/link-repair/index.js ${postSlug}`,
      `link-repair: ${postSlug}`
    );
    if (!repaired) return false;

    // Re-run editor after repair to refresh the report
    run(
      `node agents/editor/index.js data/posts/${postSlug}/content.html`,
      `edit (re-check): ${postSlug}`
    );

    // Check again — block if 404s still remain
    const recheck = checkBrokenLinks(postSlug);
    if (recheck.count404 > 0) {
      console.log(`  ⛔ ${recheck.count404} broken link(s) remain after repair — blocked from publishing.`);
      console.log(`     Review data/reports/editor/${postSlug}-editor-report.md and fix manually.`);
      return false;
    }
  }

  // Step 5: Featured product injection
  run(
    `node agents/featured-product-injector/index.js --handle ${postSlug}`,
    `featured-product: ${postSlug}`
  );

  // Step 6: Schema
  run(
    `node agents/schema-injector/index.js --slug ${postSlug}`,
    `schema: ${postSlug}`
  );

  // Step 7: Publish + schedule
  const ok = run(
    `node agents/publisher/index.js data/posts/${postSlug}/meta.json --publish-at "${publishAt}"`,
    `publish: ${postSlug} → ${publishAt}`
  );
  if (!ok) return false;

  updateItemState(item.keyword, { publishedAt: new Date().toISOString(), scheduledFor: publishAt });
  return true;
}

// ── display ───────────────────────────────────────────────────────────────────

const STATUS_ICONS = {
  published: '🟢 published',
  scheduled: '⏰ scheduled',
  draft:     '📝 draft',
  written:   '✍️  written',
  briefed:   '📋 briefed',
  pending:   '⬜ pending',
};

function statusLabel(s) { return STATUS_ICONS[s] || s; }

function printCalendar(items) {
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('  Content Calendar — Real Skin Care');
  console.log('══════════════════════════════════════════════════════════════════════\n');

  let currentWeek = null;
  for (const item of items) {
    if (item.week !== currentWeek) {
      currentWeek = item.week;
      console.log(`  Week ${item.week}`);
    }
    const dateStr = item.adjustedDate
      ? formatDisplayDate(item.adjustedDate) + (item.adjustmentReason ? ' *' : '')
      : formatDisplayDate(item.publishDate);

    const adj = item.adjustedDate &&
      item.adjustedDate.getTime() !== item.publishDate.getTime()
      ? ` (orig: ${formatDisplayDate(item.publishDate)})`
      : '';

    console.log(
      `  ${dateStr.padEnd(14)}${adj.padEnd(20)}${statusLabel(getItemStatus(item)).padEnd(22)}${item.keyword}`
    );
  }

  const counts = {};
  for (const item of items) {
    const s = getItemStatus(item);
    counts[s] = (counts[s] || 0) + 1;
  }

  console.log('\n  Summary:');
  for (const [s, n] of Object.entries(counts)) {
    console.log(`    ${statusLabel(s).padEnd(22)} ${n}`);
  }
  console.log('');

  const pending = items.filter(i => !['published', 'scheduled'].includes(getItemStatus(i)));
  if (pending.length > 0) {
    console.log(`  ${pending.length} item(s) need work. Run with --run to process the next item,`);
    console.log(`  or --run --all to process all pending items.\n`);
  } else {
    console.log('  All items are published or scheduled. ✓\n');
  }
}

function formatDisplayDate(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' });
}

// ── publish-due: flip scheduled drafts to live ────────────────────────────────

async function publishDueArticles() {
  console.log('\nCalendar Runner — Real Skin Care\n');
  console.log('Checking for articles due to publish...\n');

  const now = new Date();

  // Scan all post JSONs for scheduled articles whose date has passed
  if (!existsSync(POSTS_DIR)) { console.log('No posts directory.'); return; }

  const due = [];
  for (const slug of listAllSlugs()) {
    try {
      const meta = readPostMeta(slug);
      if (!meta) continue;
      const isDue = meta.shopify_publish_at &&
        new Date(meta.shopify_publish_at) <= now &&
        meta.shopify_article_id &&
        meta.shopify_blog_id;
      // Catch both 'scheduled' status and 'draft' posts whose publish date has passed (missed publishes)
      if (isDue && (meta.shopify_status === 'scheduled' || meta.shopify_status === 'draft')) {
        due.push({ meta, path: getMetaPath(slug), missed: meta.shopify_status === 'draft' });
      }
    } catch { /* skip */ }
  }

  if (due.length === 0) {
    console.log('  No articles due for publishing right now.');
    return;
  }

  console.log(`  ${due.length} article(s) due:\n`);

  // Load Shopify helpers inline
  const { updateArticle } = await import('../../lib/shopify.js');
  const { notify } = await import('../../lib/notify.js');

  for (const { meta, path, missed } of due) {
    const slug = meta.slug;

    // Editorial gate — check before going live; attempt auto-repair (looped) if needed
    const gate = checkEditGate(slug);
    if (!gate.pass) {
      console.log(`  ⚠️  "${meta.title}" has editorial issues — attempting auto-repair...`);
      const { gate: recheck } = runEditGateWithRepair(slug, { run });
      if (!recheck.pass) {
        console.error(`  ✗  "${meta.title}" still Needs Work after repair — blocked from publishing.`);
        console.error(`     Reason: ${recheck.reason}`);
        console.error(`     Review data/reports/editor/${slug}-editor-report.md and fix manually.`);
        await notify({
          subject: `Post blocked from publishing: ${meta.title}`,
          body: `Scheduled post "${meta.title}" (${slug}) was due to publish but failed the editorial gate after auto-repair.\n\nReason: ${recheck.reason}\n\nReview: data/reports/editor/${slug}-editor-report.md`,
          status: 'error',
        }).catch(() => {});
        continue;
      }
      console.log(`  ✓  Auto-repair succeeded for "${meta.title}"`);
    }

    const label = missed ? `  ⚠️  Missed publish — recovering "${meta.title}"... ` : `  Publishing "${meta.title}"... `;
    process.stdout.write(label);
    if (dryRun) {
      console.log('(dry-run)');
      console.log(`     Would run post-publish steps for ${slug}`);
      continue;
    }
    try {
      await updateArticle(meta.shopify_blog_id, meta.shopify_article_id, { published: true });
      meta.shopify_status = 'published';
      meta.published_at = new Date().toISOString();
      writeFileSync(path, JSON.stringify(meta, null, 2));
      console.log('✓ live');

      // Post-publish feedback loop
      console.log(`\n  Post-publish steps for ${slug}:`);
      run(`node agents/blog-content/index.js list`, 'refresh blog-index');
      run(`node agents/internal-linker/index.js --slug ${slug} --apply`, `internal-link: ${slug}`);
      run(`node agents/collection-linker/index.js --top-targets --apply`, `collection-link`);
      run(`node agents/rank-tracker/index.js`, 'rank-tracker snapshot');
      console.log('');
    } catch (e) {
      console.error(`✗ error: ${e.message}`);
    }
  }

  console.log('\nPublish-due complete.\n');
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (doPublishDue) {
    return publishDueArticles();
  }

  console.log('\nCalendar Runner — Real Skin Care\n');

  const rawItems  = parseCalendar();
  const rejections = loadRejections();
  const allItems  = applyFeedbackAdjustments(rawItems);
  const items     = allItems.filter(i => !isRejectedKw(i.keyword, rejections));
  const skipped   = allItems.length - items.length;
  if (skipped > 0) console.log(`  Skipping ${skipped} rejected keyword(s).`);

  if (!doRun && !dryRun) {
    printCalendar(items);
    return;
  }

  const { workItems, deferred, blocked } = selectWorkItems(items, { keyword: kwArg, clusterRevenue: loadClusterRevenue() });

  if (kwArg && workItems.length === 0) {
    console.log(`No pending calendar item found for keyword: "${kwArg}"`);
    process.exit(1);
  }

  if (blocked.length > 0) {
    console.log(`  ${blocked.length} item(s) not drafted — cluster closed:`);
    for (const b of blocked) console.log(`    "${b.keyword}" — ${b.blockedReason}`);
    console.log('');
  }

  if (workItems.length === 0) {
    // Distinguish "no work exists" from "work exists but is not due yet". These
    // printed the same line until 2026-08-18, so twelve consecutive days of the
    // scheduler drafting nothing looked identical to a finished calendar.
    if (deferred.length > 0) {
      const next = deferred[0];
      const nextDue = next.adjustedDate || next.publishDate;
      const dueIn = Math.ceil((nextDue - Date.now()) / 86400000);
      console.log(`${deferred.length} item(s) pending, none within the ${BUFFER_DAYS}-day lead window.`);
      console.log(`  Next up: "${next.keyword}" in ${dueIn} day(s) (${nextDue.toISOString().slice(0, 10)}).`);
      console.log(`  Run with --keyword "${next.keyword}" to draft it now.`);

      const stall = detectDraftStall({ lastDraftedAt: lastDraftedAt(), pendingCount: deferred.length });
      if (stall.stalled) {
        const idle = stall.idleDays === null ? 'ever' : `${stall.idleDays} days`;
        console.log(`\n  ⚠ No post drafted in ${idle} while ${deferred.length} item(s) wait.`);
        const { notify } = await import('../../lib/notify.js');
        await notify({
          subject: `Content pipeline stalled — nothing drafted in ${idle}`,
          body: `${deferred.length} calendar item(s) are pending but none fall inside the ${BUFFER_DAYS}-day lead window, `
              + `so calendar-runner has drafted nothing.\n\n`
              + `Next up: "${next.keyword}" on ${nextDue.toISOString().slice(0, 10)} (${dueIn} days out).\n\n`
              + `Draft it now:\n  node agents/calendar-runner/index.js --keyword "${next.keyword}" --run\n`,
          status: 'error',
          category: 'pipeline',
        }).catch(() => {});
      }
    } else {
      console.log('All calendar items are published or scheduled. Nothing to do.');
    }
    return;
  }

  if (dryRun) {
    console.log('Dry run — showing pipeline commands only.\n');
  }

  const toProcess = doAll ? workItems : workItems.slice(0, 1);
  console.log(`Processing ${toProcess.length} of ${workItems.length} pending item(s)...\n`);

  let passed = 0;
  let failed = 0;

  for (const item of toProcess) {
    const ok = await runItem(item);
    ok ? passed++ : failed++;
    if (!ok && !doAll) {
      console.log('\n  Stopped after failure. Fix the issue and re-run.');
      break;
    }
  }

  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  Done. ${passed} succeeded, ${failed} failed.\n`);

  // Print updated calendar
  printCalendar(items);
}

// Only run when invoked directly. Without this guard, any import of this module
// (tests import helpers from it) executes the whole agent — hitting live APIs and
// taking the host process down with it on any error.
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch(err => { console.error(err); process.exit(1); });
}
