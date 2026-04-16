/**
 * Draft Refresher
 *
 * Runs the "rising tier" light-refresh flow over Shopify drafts: posts
 * with a shopify_article_id but no published/scheduled state. Each post
 * goes through answer-first intro rewrite, featured-product CTA injection,
 * schema injector, and editor pre-review auto-fixes, then body_html is
 * pushed to Shopify via the editor's --push-shopify flag.
 *
 * Does NOT publish — drafts stay drafts on Shopify. Operator still has
 * final say on publication.
 *
 * Usage:
 *   node agents/draft-refresher/index.js                     # dry-run, list drafts
 *   node agents/draft-refresher/index.js --apply             # refresh all drafts
 *   node agents/draft-refresher/index.js --apply --limit 3   # refresh first N
 *   node agents/draft-refresher/index.js --apply <slug>      # refresh one post
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAllSlugs, getPostMeta, getMetaPath, getContentPath, getEditorReportPath, ROOT } from '../../lib/posts.js';
import { upsertItem, loadCalendar } from '../../lib/calendar-store.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;
const slugArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--limit');

function isDraft(meta) {
  if (!meta?.shopify_article_id) return false;
  if (meta.shopify_status === 'published') return false;
  const ts = meta.shopify_publish_at ? Date.parse(meta.shopify_publish_at) : NaN;
  if (!Number.isNaN(ts)) return false; // scheduled or past-published
  return true;
}

function findDrafts() {
  return listAllSlugs()
    .map((slug) => ({ slug, meta: getPostMeta(slug) }))
    .filter((p) => p.meta && isDraft(p.meta) && existsSync(getContentPath(p.slug)));
}

function run(cmd, label) {
  console.log(`    > ${label}`);
  try {
    execSync(cmd, { stdio: 'inherit', cwd: ROOT });
    return true;
  } catch (err) {
    console.error(`    ✗ ${label} failed`);
    return false;
  }
}

/**
 * Returns true if the editor report for this slug has an OVERALL QUALITY
 * verdict that is NOT "Needs Work" — i.e. the post passed the editorial
 * gate. Mirrors the dashboard's findBlockedPosts logic.
 */
function editorPassed(slug) {
  const reportPath = getEditorReportPath(slug);
  if (!existsSync(reportPath)) return false;
  const report = readFileSync(reportPath, 'utf8');
  const overallMatch = report.match(/##[^\n]*OVERALL QUALITY[^\n]*\n[\s\S]*?VERDICT[:*\s]+([^\n]+)/i);
  if (!overallMatch) return false;
  return !/needs work/i.test(overallMatch[1]);
}

/**
 * Compute the next available publish slot, staggered at MAX_PER_DAY posts
 * per day starting tomorrow at 08:00 Pacific. Scans both the calendar and
 * local meta.shopify_publish_at so we never collide with existing
 * schedules. Enforces phased publishing — no batch of cluster posts going
 * live on the same day.
 */
function computeNextPublishDate() {
  const MAX_PER_DAY = 1;
  const HOUR = 8;
  const TZ = '-07:00';

  const counts = new Map();
  try {
    const cal = loadCalendar();
    for (const item of (cal.items || [])) {
      if (!item.publish_date) continue;
      const d = new Date(item.publish_date).toISOString().slice(0, 10);
      counts.set(d, (counts.get(d) || 0) + 1);
    }
  } catch { /* ignore */ }
  for (const slug of listAllSlugs()) {
    const m = getPostMeta(slug);
    if (!m?.shopify_publish_at) continue;
    const d = new Date(m.shopify_publish_at).toISOString().slice(0, 10);
    counts.set(d, (counts.get(d) || 0) + 1);
  }

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let offset = 1; offset <= 365; offset++) {
    const candidate = new Date(today);
    candidate.setUTCDate(candidate.getUTCDate() + offset);
    const dayKey = candidate.toISOString().slice(0, 10);
    if ((counts.get(dayKey) || 0) < MAX_PER_DAY) {
      return `${dayKey}T${String(HOUR).padStart(2, '0')}:00:00${TZ}`;
    }
  }
  throw new Error('Could not find an available publish slot within 365 days');
}

/**
 * Enqueue a refreshed draft for scheduled publishing. Writes
 * shopify_publish_at + shopify_status='scheduled' into local meta and
 * upserts a calendar item. Does NOT call Shopify's published flag —
 * calendar-runner's publishDueArticles() handles that when the date
 * arrives. Prevents link-dump patterns by phasing publishes across days.
 */
function scheduleDraft(slug, meta, publishAt) {
  const updated = { ...meta, shopify_status: 'scheduled', shopify_publish_at: publishAt };
  writeFileSync(getMetaPath(slug), JSON.stringify(updated, null, 2));
  try {
    upsertItem({
      slug,
      keyword: meta.target_keyword || meta.title || slug,
      title: meta.title || slug,
      category: (meta.tags || [])[0] || 'General',
      content_type: 'Blog Post',
      priority: 'Medium',
      publish_date: publishAt,
      source: 'draft_refresher',
    });
  } catch (e) {
    console.warn(`    Warning: could not upsert calendar item for ${slug}: ${e.message}`);
  }
  console.log(`    ✓ Scheduled for ${new Date(publishAt).toISOString().slice(0, 10)}`);
}

async function refreshDraft(slug) {
  console.log(`\n  Refreshing: ${slug}`);
  const contentPath = getContentPath(slug);

  // Light-refresh sequence — same pattern as rising-tier legacy-rebuilder
  run(`node agents/answer-first-rewriter/index.js ${slug} --apply`, `answer-first: ${slug}`);
  run(`node agents/featured-product-injector/index.js --handle ${slug}`, `featured-product: ${slug}`);
  run(`node agents/schema-injector/index.js --slug ${slug} --apply`, `schema: ${slug}`);

  // Editor with --in-pipeline (no re-tagging) + --push-shopify syncs any
  // pre-review auto-fixes (year refresh, H1 demotion, FAQ competitor
  // rewrite, link-text bumps) back to Shopify body_html.
  if (!run(`node agents/editor/index.js ${contentPath} --in-pipeline --push-shopify`, `editor+push: ${slug}`)) {
    console.error(`    ⛔ Editor failed — draft left as-is on Shopify`);
    return { refreshed: true, scheduled: false };
  }

  // If the editor passed, enqueue for scheduled publishing via the calendar
  // (staggered — never batch-publish on the same day). The calendar-runner's
  // publishDueArticles() flips the draft to published when the date arrives.
  // If the editor returned Needs Work, leave as draft — the daily
  // legacy-rebuilder picks it up for tier-appropriate handling.
  if (!editorPassed(slug)) {
    console.log(`    Editor did not pass — left as draft for next rebuilder cycle`);
    return { refreshed: true, scheduled: false };
  }
  try {
    const meta = getPostMeta(slug);
    const publishAt = computeNextPublishDate();
    scheduleDraft(slug, meta, publishAt);
    return { refreshed: true, scheduled: true };
  } catch (e) {
    console.error(`    ✗ Schedule failed: ${e.message}`);
    return { refreshed: true, scheduled: false };
  }
}

async function main() {
  console.log(`\nDraft Refresher${apply ? ' (APPLY)' : ' (dry run)'}\n`);

  const drafts = findDrafts();
  console.log(`Found ${drafts.length} draft post(s) with content.html and a Shopify article ID.`);

  if (!apply) {
    for (const d of drafts.slice(0, 30)) {
      console.log(`  - ${d.slug} (${d.meta.title || '—'})`);
    }
    if (drafts.length > 30) console.log(`  ... and ${drafts.length - 30} more`);
    console.log('\nDry run — no changes. Pass --apply to refresh.');
    return;
  }

  let toRefresh = drafts;
  if (slugArg) toRefresh = drafts.filter((d) => d.slug === slugArg);
  else if (limit) toRefresh = drafts.slice(0, limit);

  console.log(`\nRefreshing ${toRefresh.length} draft(s)...`);

  let refreshed = 0;
  let scheduled = 0;
  let failed = 0;
  for (const d of toRefresh) {
    try {
      const result = await refreshDraft(d.slug);
      if (result.refreshed) refreshed++;
      if (result.scheduled) scheduled++;
      if (!result.refreshed) failed++;
    } catch (err) {
      console.error(`  ✗ ${d.slug}: ${err.message}`);
      failed++;
    }
  }

  await notify({
    subject: `Draft Refresher: ${scheduled} scheduled, ${refreshed - scheduled} kept as draft, ${failed} failed`,
    body: `Refreshed ${refreshed} draft(s); ${scheduled} passed the editor and were scheduled (1/day via calendar), ${refreshed - scheduled} kept as draft, ${failed} failed.`,
    status: failed > 0 ? 'warning' : 'success',
  });

  console.log(`\nDone. ${refreshed} refreshed, ${scheduled} scheduled (1/day via calendar), ${failed} failed.`);
  if (scheduled > 0) {
    console.log('Scheduled posts will auto-publish via the calendar-runner on their assigned dates.');
  }
}

main().catch((err) => {
  notify({ subject: 'Draft Refresher failed', body: err.message, status: 'error' });
  console.error('Error:', err.message);
  process.exit(1);
});
