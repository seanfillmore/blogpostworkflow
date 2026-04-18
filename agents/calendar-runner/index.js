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
 * GSC feedback signals (re-evaluated each run):
 *   - Cluster with page-1 post → accelerate remaining cluster items by 2 days
 *   - Cluster with all posts > 30 days old, none ranking → push cluster items out 5 days
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const CALENDAR_PATH    = join(ROOT, 'data', 'reports', 'content-strategist', 'content-calendar.md');
const STATE_DIR        = join(ROOT, 'data', 'reports', 'calendar-runner');
const STATE_PATH       = join(STATE_DIR, 'calendar-state.json');
const RANK_REPORT_PATH = join(ROOT, 'data', 'reports', 'rank-tracker', 'rank-tracker-report.md');

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

function isRejectedKw(keyword, rejections) {
  const kw = keyword.toLowerCase();
  return rejections.some(r => {
    const term = r.keyword.toLowerCase();
    if (r.matchType === 'exact') return keywordToSlug(keyword) === keywordToSlug(r.keyword);
    return kw.includes(term);
  });
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

// ── GSC / rank feedback ───────────────────────────────────────────────────────

function loadRankSignals() {
  // Returns { [cluster]: { page1Count, notRankingOldCount } }
  const signals = {};

  if (!existsSync(RANK_REPORT_PATH)) return signals;
  const report = readFileSync(RANK_REPORT_PATH, 'utf8');

  // Parse cluster performance table
  const clusterRegex = /\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/g;
  for (const m of report.matchAll(clusterRegex)) {
    const cluster = m[1].trim();
    if (cluster === 'Cluster' || cluster === '---') continue;
    const page1 = parseInt(m[4], 10) || 0;
    signals[cluster.toLowerCase()] = { page1Count: page1 };
  }

  return signals;
}

function applyFeedbackAdjustments(items, signals) {
  const state = loadState();

  return items.map(item => {
    const category = item.category.toLowerCase();
    const sig = signals[category];

    // Check if we have a manually adjusted date in state
    const saved = state[item.keyword];
    const baseDate = saved?.adjustedDate
      ? new Date(saved.adjustedDate)
      : item.publishDate;

    let adjustedDate = new Date(baseDate);
    let adjustmentReason = null;

    if (sig) {
      if (sig.page1Count > 0) {
        // Cluster has page-1 post — accelerate by 2 days
        adjustedDate = new Date(baseDate.getTime() - 2 * 24 * 60 * 60 * 1000);
        adjustmentReason = `${item.category} cluster has page-1 ranking — accelerated 2 days`;
      }
    }

    return { ...item, adjustedDate, adjustmentReason };
  });
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

function checkEditGate(slug) {
  const reportPath = getEditorReportPath(slug);
  if (!existsSync(reportPath)) return { pass: true };
  const report = readFileSync(reportPath, 'utf8');
  if (/VERDICT:\s*Needs Work/i.test(report)) {
    const match = report.match(/NOTES:\s*([^\n]+)/i);
    return { pass: false, reason: match?.[1]?.trim() || 'See editor report.' };
  }
  return { pass: true };
}

function attemptRepair(slug, reason) {
  const lower = (reason || '').toLowerCase();
  const repairs = [];

  if (lower.includes('competitor') || lower.includes('brand name') || lower.includes('brand guideline')) {
    repairs.push({ label: 'faq-rewriter', cmd: `node agents/faq-rewriter/index.js --slug ${slug}` });
  }
  if (lower.includes('internal link') || lower.includes('orphan') || lower.includes('cross-link')) {
    repairs.push({ label: 'internal-linker', cmd: `node agents/internal-linker/index.js --slug ${slug}` });
  }
  if (lower.includes('unsourced') || lower.includes('citation') || lower.includes('claim')) {
    repairs.push({ label: 'content-refresher', cmd: `node agents/content-refresher/index.js --slug ${slug}` });
  }
  if (lower.includes('answer') || lower.includes('answer-first')) {
    repairs.push({ label: 'answer-first-rewriter', cmd: `node agents/answer-first-rewriter/index.js ${slug}` });
  }
  if (lower.includes('broken link') || lower.includes('404')) {
    repairs.push({ label: 'link-repair', cmd: `node agents/link-repair/index.js ${slug}` });
  }
  if (lower.includes('schema') || lower.includes('structured data')) {
    repairs.push({ label: 'schema-injector', cmd: `node agents/schema-injector/index.js --slug ${slug}` });
  }

  if (repairs.length === 0) {
    repairs.push({ label: 'link-repair', cmd: `node agents/link-repair/index.js ${slug}` });
    repairs.push({ label: 'schema-injector', cmd: `node agents/schema-injector/index.js --slug ${slug}` });
  }

  console.log(`  🔧 Attempting ${repairs.length} repair(s): ${repairs.map((r) => r.label).join(', ')}`);
  for (const { label, cmd } of repairs) {
    run(cmd, `repair (${label}): ${slug}`);
  }

  run(`node agents/editor/index.js data/posts/${slug}/content.html`, `edit (re-check): ${slug}`);
}

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

  // Step 3: Image
  if (!existsSync(join(ROOT, 'data', 'images', `${postSlug}.webp`)) &&
      !existsSync(join(ROOT, 'data', 'images', `${postSlug}.png`))) {
    const ok = run(
      `node agents/image-generator/index.js data/posts/${postSlug}.json`,
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
      `node agents/editor/index.js data/posts/${postSlug}.html`,
      `edit: ${postSlug}`
    );
    if (!ok) return false;
  }

  // Editorial gate — attempt auto-repair if blocked
  let gate = checkEditGate(postSlug);
  if (!gate.pass) {
    console.log(`  ⚠️ Editorial gate blocked: ${gate.reason}`);
    attemptRepair(postSlug, gate.reason);
    gate = checkEditGate(postSlug);
    if (!gate.pass) {
      console.log(`  ⛔ Still blocked after repair: ${gate.reason}`);
      console.log(`     Review data/posts/${postSlug}/editor-report.md and fix manually.`);
      updateItemState(item.keyword, { blockedAt: new Date().toISOString(), blockReason: gate.reason });
      return false;
    }
    console.log(`  ✓ Repair succeeded — editorial gate now passes.`);
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
      `node agents/editor/index.js data/posts/${postSlug}.html`,
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
    `node agents/publisher/index.js data/posts/${postSlug}.json --publish-at "${publishAt}"`,
    `publish: ${postSlug} → ${publishAt}`
  );
  if (!ok) return false;

  updateItemState(item.keyword, { publishedAt: new Date().toISOString(), scheduledFor: publishAt });
  return true;
}

export function formatPublishAt(date) {
  const PUBLISH_DAYS = new Set([1, 3, 5]); // Mon, Wed, Fri
  const d = new Date(date);
  // Snap forward to next publish day
  while (!PUBLISH_DAYS.has(d.getDay())) {
    d.setDate(d.getDate() + 1);
  }
  // If that date is in the past, advance by 1 week until it is future
  const now = new Date();
  while (d < now) {
    d.setDate(d.getDate() + 7);
  }
  const y  = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dy = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${dy}T08:00:00-07:00`;
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

    // Editorial gate — check before going live; attempt auto-repair if needed
    const gate = checkEditGate(slug);
    if (!gate.pass) {
      console.log(`  ⚠️  "${meta.title}" has editorial issues — attempting auto-repair...`);
      attemptRepair(slug, gate.reason);

      const recheck = checkEditGate(slug);
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
  const signals   = loadRankSignals();
  const rejections = loadRejections();
  const allItems  = applyFeedbackAdjustments(rawItems, signals);
  const items     = allItems.filter(i => !isRejectedKw(i.keyword, rejections));
  const skipped   = allItems.length - items.length;
  if (skipped > 0) console.log(`  Skipping ${skipped} rejected keyword(s).`);

  if (!doRun && !dryRun) {
    printCalendar(items);
    return;
  }

  // Filter to pending items (not yet published or scheduled)
  let workItems = items.filter(i => !['published', 'scheduled'].includes(getItemStatus(i)));

  if (kwArg) {
    workItems = workItems.filter(i => i.keyword.toLowerCase() === kwArg.toLowerCase());
    if (workItems.length === 0) {
      console.log(`No pending calendar item found for keyword: "${kwArg}"`);
      process.exit(1);
    }
  }

  if (workItems.length === 0) {
    console.log('All calendar items are published or scheduled. Nothing to do.');
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

main().catch(err => { console.error(err); process.exit(1); });
