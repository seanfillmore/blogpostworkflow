#!/usr/bin/env node
/**
 * Unmapped Query Promoter
 *
 * Reads the latest gsc-opportunity report and promotes high-impression
 * unmapped queries directly into the content calendar as Pending items.
 * Closes the loop between "GSC says this query has demand" and "there's
 * a pending post to target it" without waiting for the biweekly
 * content-strategist run.
 *
 * Rules:
 *   1. Only queries with >= MIN_IMPRESSIONS over the last 90 days qualify.
 *   2. Skip any keyword that matches the rejected-keywords list (same
 *      matching semantics as the strategist).
 *   3. Skip any keyword already targeted by an existing calendar item,
 *      existing brief, or existing post (fuzzy match on slug or keyword).
 *   4. Skip queries that are already a substring of (or superstring of)
 *      an existing calendar keyword — avoids queuing "sls free toothpaste"
 *      when "best sls free toothpaste" is already pending.
 *   5. Cap at MAX_NEW_ITEMS per run so a single run can't flood the queue.
 *
 * New calendar items:
 *   - status: 'pending' (implicit — no post or brief yet, so parseCalendar
 *     will classify them as pending)
 *   - source: 'gsc_unmapped'
 *   - publish_date: today + 14 days (so they land in the pending column
 *     without disrupting anything already scheduled)
 *   - priority: "🔴 High" (matching existing high-priority calendar rows)
 *
 * Cron: daily 6:45 AM PT (after gsc-opportunity runs at 6:30 AM PT).
 *
 * Usage:
 *   node agents/unmapped-query-promoter/index.js
 *   node agents/unmapped-query-promoter/index.js --dry-run
 *   node agents/unmapped-query-promoter/index.js --min-impressions 300
 *   node agents/unmapped-query-promoter/index.js --limit 10
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../../lib/notify.js';
import { loadCalendar, upsertItem } from '../../lib/calendar-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const REPORTS_DIR = join(ROOT, 'data', 'reports');
const POSTS_DIR = join(ROOT, 'data', 'posts');
const BRIEFS_DIR = join(ROOT, 'data', 'briefs');
const REJECTIONS_PATH = join(ROOT, 'data', 'rejected-keywords.json');

// ── args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const minImprIdx = args.indexOf('--min-impressions');
const MIN_IMPRESSIONS = minImprIdx !== -1 ? parseInt(args[minImprIdx + 1], 10) : 500;
const limitIdx = args.indexOf('--limit');
const MAX_NEW_ITEMS = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 5;

// ── helpers ───────────────────────────────────────────────────────────────────

function slugify(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function titleCase(str) {
  return (str || '')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function loadRejections() {
  if (!existsSync(REJECTIONS_PATH)) return [];
  try { return JSON.parse(readFileSync(REJECTIONS_PATH, 'utf8')); } catch { return []; }
}

function isRejected(keyword, rejections) {
  const kw = (keyword || '').toLowerCase().trim();
  if (!kw) return false;
  return rejections.some((r) => {
    const term = (r.keyword || '').toLowerCase().trim();
    if (!term) return false;
    if (r.matchType === 'exact') return kw === term;
    return kw.includes(term);
  });
}

/**
 * Build a set of keyword signatures that are already covered by:
 *   - existing calendar items
 *   - existing briefs
 *   - existing posts
 *
 * Each signature is the lowercase keyword string. We also include slug
 * variants so a keyword like "best natural deodorant" won't collide with
 * a post whose slug is "best-natural-deodorant".
 */
function buildExistingIndex(calendarItems) {
  const index = new Set();

  for (const item of calendarItems) {
    if (item.keyword) index.add(item.keyword.toLowerCase().trim());
    if (item.slug)    index.add(item.slug);
  }

  if (existsSync(BRIEFS_DIR)) {
    for (const f of readdirSync(BRIEFS_DIR).filter((n) => n.endsWith('.json'))) {
      const slug = basename(f, '.json');
      index.add(slug);
      try {
        const b = JSON.parse(readFileSync(join(BRIEFS_DIR, f), 'utf8'));
        if (b.target_keyword) index.add(b.target_keyword.toLowerCase().trim());
      } catch { /* ignore */ }
    }
  }

  if (existsSync(POSTS_DIR)) {
    for (const f of readdirSync(POSTS_DIR).filter((n) => n.endsWith('.json'))) {
      const slug = basename(f, '.json');
      index.add(slug);
      try {
        const p = JSON.parse(readFileSync(join(POSTS_DIR, f), 'utf8'));
        if (p.target_keyword) index.add(p.target_keyword.toLowerCase().trim());
      } catch { /* ignore */ }
    }
  }

  return index;
}

/**
 * Check whether a query is already "covered" by an existing entry. In
 * addition to exact match (handled by the Set), we also check fuzzy
 * containment — if the query is a substring of an existing keyword or
 * vice versa, treat it as covered.
 */
function isCovered(query, existingSet) {
  const q = query.toLowerCase().trim();
  const qSlug = slugify(q);
  if (existingSet.has(q)) return true;
  if (existingSet.has(qSlug)) return true;
  // Slug-normalized fuzzy containment: compare on slug form so spaces vs
  // hyphens don't hide overlaps. Length floor avoids matching trivial
  // tokens like "oil" or "sls" against unrelated slugs.
  for (const existing of existingSet) {
    const existingSlug = slugify(existing);
    if (existingSlug.length < 6 || qSlug.length < 6) continue;
    if (existingSlug.includes(qSlug) || qSlug.includes(existingSlug)) return true;
  }
  return false;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nUnmapped Query Promoter\n');

  const gscPath = join(REPORTS_DIR, 'gsc-opportunity', 'latest.json');
  if (!existsSync(gscPath)) {
    console.error(`Missing ${gscPath}. Run agents/gsc-opportunity/index.js first.`);
    process.exit(1);
  }
  const gsc = JSON.parse(readFileSync(gscPath, 'utf8'));
  const unmapped = gsc.unmapped || [];
  console.log(`  GSC opportunity report has ${unmapped.length} unmapped queries`);

  const rejections = loadRejections();
  if (rejections.length) console.log(`  Loaded ${rejections.length} keyword rejection${rejections.length === 1 ? '' : 's'}`);

  const calendar = loadCalendar();
  const existingIndex = buildExistingIndex(calendar.items);
  console.log(`  Existing coverage: ${existingIndex.size} keywords/slugs across calendar, briefs, and posts`);

  // Filter: impression floor → rejections → coverage
  const qualified = [];
  const stats = { under_floor: 0, rejected: 0, already_covered: 0, qualified: 0 };
  for (const row of unmapped) {
    if ((row.impressions || 0) < MIN_IMPRESSIONS) { stats.under_floor++; continue; }
    if (isRejected(row.keyword, rejections))     { stats.rejected++; continue; }
    if (isCovered(row.keyword, existingIndex))   { stats.already_covered++; continue; }
    qualified.push(row);
    stats.qualified++;
  }

  console.log(`\n  Filtering results:`);
  console.log(`    under ${MIN_IMPRESSIONS}-impression floor: ${stats.under_floor}`);
  console.log(`    rejected:                                   ${stats.rejected}`);
  console.log(`    already covered:                            ${stats.already_covered}`);
  console.log(`    qualified:                                  ${stats.qualified}`);

  // Sort by impressions desc, take top MAX_NEW_ITEMS
  qualified.sort((a, b) => (b.impressions || 0) - (a.impressions || 0));
  const toPromote = qualified.slice(0, MAX_NEW_ITEMS);

  if (toPromote.length === 0) {
    console.log('\n  No new items to promote.');
    return;
  }

  console.log(`\n  Promoting top ${toPromote.length} unmapped quer${toPromote.length === 1 ? 'y' : 'ies'} to calendar:`);
  for (const row of toPromote) {
    console.log(`    • "${row.keyword}" — ${row.impressions} impressions, pos ${(row.position || 0).toFixed(1)}`);
  }

  if (DRY_RUN) {
    console.log('\n  (dry-run — no changes written)');
    return;
  }

  // Promote: upsert one calendar item per query.
  // publish_date = now + 14 days, which keeps it well out of any current
  // scheduled slots and puts it firmly in "pending" territory.
  const now = new Date();
  const publishDate = new Date(now.getTime() + 14 * 86400000).toISOString();
  const nowIso = now.toISOString();

  for (const row of toPromote) {
    const slug = slugify(row.keyword);
    upsertItem({
      slug,
      keyword: row.keyword,
      title: titleCase(row.keyword),
      category: 'GSC Demand',
      content_type: 'Blog Post',
      priority: '🔴 High',
      week: null,
      publish_date: publishDate,
      original_publish_date: publishDate,
      kd: null,
      volume: null,
      source: 'gsc_unmapped',
      topical_hub: null,
      priority_score: Math.min(100, Math.round((row.impressions || 0) / 30)),
      status_override: null,
      added_at: nowIso,
      last_updated: nowIso,
      gsc_impressions: row.impressions,
      gsc_position: row.position,
    });
  }

  console.log(`\n  Promoted ${toPromote.length} item${toPromote.length === 1 ? '' : 's'} to the calendar.`);

  await notify({
    subject: `Unmapped Query Promoter: ${toPromote.length} new item${toPromote.length === 1 ? '' : 's'} promoted`,
    body: toPromote.map((r) => `• "${r.keyword}" — ${r.impressions} impressions (pos ${(r.position || 0).toFixed(1)})`).join('\n'),
    status: 'info',
    category: 'seo',
  }).catch(() => {});

  console.log('\nUnmapped query promotion complete.');
}

main().catch((err) => {
  console.error('Unmapped query promoter failed:', err);
  process.exit(1);
});
