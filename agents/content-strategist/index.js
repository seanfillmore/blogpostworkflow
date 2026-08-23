/**
 * Content Strategist Agent
 *
 * Reads the content gap report and existing inventory, then:
 *   1. Produces a prioritized content calendar (data/reports/content-calendar.md)
 *   2. Optionally generates briefs by calling the content-researcher agent for each gap
 *
 * Usage:
 *   node agents/content-strategist/index.js                   # plan only
 *   node agents/content-strategist/index.js --generate-briefs # plan + generate briefs
 *   node agents/content-strategist/index.js --generate-briefs --limit 3  # top N only
 */

import Anthropic from '../../lib/anthropic.js';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { loadCalendar, writeCalendar } from '../../lib/calendar-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'content-strategist');
const BRIEFS_DIR = join(ROOT, 'data', 'briefs');

import { listAllSlugs, getPostMeta as getPostMetaLib, getContentPath, POSTS_DIR } from '../../lib/posts.js';
import {
  coveragePool, findCoverage, classifyClearedItems, renderClearedLines, clearedDigest,
} from '../../lib/calendar-coverage.js';
import { isLiveOrScheduled } from '../../lib/post-publish-state.js';
import { appendRejection as appendRejectionEntry } from '../../lib/rejected-keywords.js';
import { notify } from '../../lib/notify.js';
import { splitInventory } from '../../lib/brief-triage.js';
import { provenDuds, clusterForText } from '../../lib/cluster-revenue.js';
import { loadClusterHold, corroboratedClassification, holdBanner } from '../../lib/cluster-hold.js';
import { clusterPenalties } from '../../lib/cluster-performance.js';
import { identifyPillar } from '../../lib/cluster-architecture.js';
import { loadDeviceWeights, effectivePosition } from '../../lib/device-weights.js';
import { loadIndex, lookupByKeyword, validationTag, unmappedIndexEntries } from '../../lib/keyword-index/consumer.js';
import { isInProductScope, PRODUCT_SCOPE_TERMS } from '../../lib/product-scope.js';
// Re-export so existing importers of these from content-strategist keep working.
export { isInProductScope, PRODUCT_SCOPE_TERMS };

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

// ── env ───────────────────────────────────────────────────────────────────────

function loadEnv() {
  const lines = readFileSync(join(ROOT, '.env'), 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const idx = t.indexOf('=');
    if (idx === -1) continue;
    env[t.slice(0, idx).trim()] = t.slice(idx + 1).trim();
  }
  return env;
}

const env = loadEnv();
if (!env.ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY in .env'); process.exit(1); }

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// ── args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const generateBriefs = args.includes('--generate-briefs');
const limitIdx = args.indexOf('--limit');
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : null;

// ── helpers ───────────────────────────────────────────────────────────────────

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Per-cluster revenue from the latest seo-impact run; {} when it has not run.
 *
 * Goes through `loadClusterHold` + `corroboratedClassification`, NOT the raw
 * classification. Dropping an LLM's proposal and clearing existing calendar
 * items is a hard block, so it holds to the same two-source bar as the spend
 * hold: a $0 that real Shopify orders contradict is an attribution defect, not a
 * verdict, and must not silence a category. See lib/cluster-hold.js.
 */
function loadClusterRevenue() {
  try {
    const hold = loadClusterHold({ root: ROOT });
    // Missing AND stale both speak here — holdBanner returns a line for each.
    const banner = holdBanner(hold);
    if (banner) console.log(banner);
    return corroboratedClassification(hold);
  } catch (e) {
    // `{}` is the right VALUE — no verdicts, so nothing is dropped, matching the
    // fail-open rule. Swallowing the reason was not. `loadClusterHold` reads
    // defensively and should never throw, so reaching this catch is a defect in
    // it, and the one run where it happened would otherwise look identical to a
    // run where the report simply said nothing was a dud.
    console.log(`  ⚠ cluster revenue could not be loaded (${e.message}) — no cluster is treated as a dud this run.`);
    return {};
  }
}

function loadLatestRankReport() {
  const path = join(ROOT, 'data', 'reports', 'rank-tracker', 'rank-tracker-report.md');
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8').slice(0, 3000);
}

/**
 * Load latest rank snapshot + post tags and compute per-cluster performance.
 *
 * A "cluster" is derived from a post's first tag (falls back to the first
 * slug token). For each cluster we record median position, count of page-1
 * posts, count of drag posts (position > 30 and age > 30d), and any
 * outstanding flops surfaced by the post-performance agent.
 *
 * Weighting rules used by the strategist:
 *   - page_1 cluster (≥1 post at positions 1–10 AND no outstanding flops):
 *     +2 priority weight — reinforce with adjacent topics.
 *   - drag cluster (median position > 30 AND median age > 30 days):
 *     −3 priority weight — deprioritize new topics here.
 *
 * Returns { computed_at, clusters: { <name>: { weight, page_1, drag, ... } } }
 * or null if no rank snapshot is available.
 */
export function loadClusterPerformance() {
  const snapshotsDir = join(ROOT, 'data', 'rank-snapshots');
  if (!existsSync(snapshotsDir)) return null;
  const all = readdirSync(snapshotsDir).filter((f) => f.endsWith('.json'));
  const pickLatest = (regex) => {
    const matches = all.filter((f) => regex.test(f)).sort((a, b) => a.slice(0, 10).localeCompare(b.slice(0, 10)));
    return matches.length ? matches[matches.length - 1] : null;
  };
  // Primary snapshot: latest desktop-suffixed file, or legacy plain-date file.
  const desktopFile = pickLatest(/^\d{4}-\d{2}-\d{2}-desktop\.json$/)
                   || pickLatest(/^\d{4}-\d{2}-\d{2}\.json$/);
  if (!desktopFile) return null;
  const snap = JSON.parse(readFileSync(join(snapshotsDir, desktopFile), 'utf8'));

  // Mobile snapshot (optional) — indexed by slug so we can compute effective
  // position per post. Without it, effectivePosition falls back to desktop.
  const mobileFile = pickLatest(/^\d{4}-\d{2}-\d{2}-mobile\.json$/);
  const mobileBySlug = {};
  if (mobileFile) {
    try {
      const mob = JSON.parse(readFileSync(join(snapshotsDir, mobileFile), 'utf8'));
      for (const p of (mob.posts || [])) {
        if (p.slug) mobileBySlug[p.slug] = p.position ?? null;
      }
    } catch { /* ignore */ }
  }
  const deviceWeights = loadDeviceWeights();

  // Replace each post's position with its effective (revenue-weighted) position,
  // so cluster metrics (median, page-1 count, drag count) reflect what Google
  // shows the device mix that actually earns revenue — not just desktop.
  const posts = (snap.posts || []).map((p) => {
    const mobilePos = mobileBySlug[p.slug] ?? null;
    const eff = effectivePosition({ url: p.url, desktopPos: p.position, mobilePos, weights: deviceWeights });
    return { ...p, desktop_position: p.position, mobile_position: mobilePos, position: eff };
  });

  // Map slug -> tags from data/posts/*.json
  const tagsBySlug = {};
  for (const slug of listAllSlugs()) {
    try {
      const meta = getPostMetaLib(slug);
      if (meta?.slug) tagsBySlug[meta.slug] = meta.tags || [];
    } catch { /* skip */ }
  }

  // Outstanding flops by slug from post-performance latest.json
  const flopSlugs = new Set();
  const ppPath = join(ROOT, 'data', 'reports', 'post-performance', 'latest.json');
  if (existsSync(ppPath)) {
    try {
      const pp = JSON.parse(readFileSync(ppPath, 'utf8'));
      for (const f of (pp.action_required || [])) flopSlugs.add(f.slug);
    } catch { /* ignore */ }
  }

  // GA4 conversion feedback — gives cluster weights based on actual revenue
  const ga4Path = join(ROOT, 'data', 'reports', 'ga4-content-feedback', 'latest.json');
  let ga4Clusters = {};
  if (existsSync(ga4Path)) {
    try {
      const ga4 = JSON.parse(readFileSync(ga4Path, 'utf8'));
      for (const c of (ga4.clusters || [])) {
        ga4Clusters[c.cluster] = c;
      }
    } catch { /* ignore */ }
  }

  // Known product clusters — checked against tags AND slug as a fallback so
  // posts without proper tags still group correctly. `hair care` and `skincare`
  // are taxonomy buckets for legacy topical-authority content (hair masks,
  // skincare guides, dry brushing, sugar scrubs) that don't map to a single
  // SKU but inform strategy weight.
  const KNOWN_CLUSTERS = [
    'deodorant', 'toothpaste', 'lotion', 'soap', 'lip balm', 'lip-balm',
    'coconut oil', 'coconut-oil', 'shampoo', 'conditioner', 'sunscreen',
    'hair care', 'skincare',
  ];
  function clusterFor(post) {
    const tags = (tagsBySlug[post.slug] || []).map((t) => t.toLowerCase());
    for (const c of KNOWN_CLUSTERS) {
      if (tags.some((t) => t.includes(c.replace('-', ' ')))) return c.replace('-', ' ');
    }
    const slug = (post.slug || '').toLowerCase();
    for (const c of KNOWN_CLUSTERS) {
      if (slug.includes(c.replace(' ', '-'))) return c.replace('-', ' ');
    }
    if (tags.length) return tags[0];
    return slug.split('-')[0];
  }

  // Iterate every published post so post_count reflects the full inventory in
  // each cluster, not just the subset that the rank tracker picked up. Rank
  // metrics (median position, page-1 count, drag count) layer on top — they
  // only consider posts that actually have a position recorded in the snapshot.
  const snapshotBySlug = new Map();
  for (const p of posts) {
    if (p.slug) snapshotBySlug.set(p.slug, p);
  }
  const groups = {};
  const now = Date.now();
  for (const slug of listAllSlugs()) {
    let meta;
    try { meta = getPostMetaLib(slug); } catch { continue; }
    if (!meta || !meta.shopify_article_id) continue;

    const cluster = clusterFor({ slug });
    if (!cluster) continue;

    const snap = snapshotBySlug.get(slug);
    const position = snap?.position ?? null;
    const publishedAt = snap?.published_at || meta.shopify_publish_at || meta.published_at || null;
    const ageDays = publishedAt ? Math.floor((now - new Date(publishedAt).getTime()) / 86400000) : null;

    (groups[cluster] = groups[cluster] || []).push({ slug, position, age_days: ageDays });
  }

  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const clusters = {};
  for (const [name, items] of Object.entries(groups)) {
    // Position-based metrics only consider posts with a position in the
    // snapshot. items contains every post in the cluster (including
    // un-ranked ones), so post_count is the full inventory.
    const ranked = items.filter((i) => i.position != null);
    const positions = ranked.map((i) => i.position);
    const ages = ranked.map((i) => i.age_days).filter((a) => a != null);
    const medianPos = median(positions);
    const medianAge = median(ages);
    const page1Count = ranked.filter((i) => i.position <= 10).length;
    const dragCount = ranked.filter((i) => i.position > 30 && (i.age_days || 0) > 30).length;
    const hasFlop = items.some((i) => flopSlugs.has(i.slug));

    let weight = 0;
    const reasons = [];
    if (page1Count >= 1 && !hasFlop) {
      weight += 2;
      reasons.push(`+2 page-1 cluster (${page1Count} post${page1Count > 1 ? 's' : ''} on page 1)`);
    }
    if (medianPos != null && medianPos > 30 && medianAge != null && medianAge > 30) {
      weight -= 3;
      reasons.push(`-3 drag cluster (median pos ${medianPos}, median age ${medianAge}d)`);
    }
    if (hasFlop) reasons.push(`flop present — page-1 boost suppressed`);

    const ga4 = ga4Clusters[name];
    if (ga4 && ga4.expansion_signal) {
      weight += 2;
      reasons.push('+2 high-conversion cluster (GA4: low traffic but converting)');
    }
    if (ga4 && ga4.cro_signal) {
      reasons.push('CRO flag: high traffic but low conversion (GA4)');
    }

    // Identify pillar post for this cluster — the broadest/highest-authority page
    // that supporting articles should link to. Pass impressions from the rank
    // snapshot when available.
    const clusterPostsForPillar = items.map((i) => {
      const meta = (() => { try { return getPostMetaLib(i.slug); } catch { return null; } })();
      return {
        slug: i.slug,
        keyword: meta?.target_keyword || null,
        position: i.position,
        impressions: snapshotBySlug.get(i.slug)?.impressions || 0,
      };
    });
    const pillar = identifyPillar(clusterPostsForPillar);

    clusters[name] = {
      post_count: items.length,
      ranked_count: ranked.length,
      median_position: medianPos,
      median_age_days: medianAge,
      page_1_count: page1Count,
      drag_count: dragCount,
      has_outstanding_flop: hasFlop,
      weight,
      reasons,
      flop_penalty: 0,
      pillar: pillar?.slug || null,
    };
  }

  // ── Flop-rate cluster penalties (from legacy-triage) ─────────────────────────
  // Load legacy-triage output: results[] is an array of { slug, bucket }.
  // Map each slug to its cluster (using clusterFor), then compute per-cluster
  // flop-rate penalties and subtract from the cluster's weight.
  const legacyTriagePath = join(ROOT, 'data', 'reports', 'legacy-triage', 'latest.json');
  if (existsSync(legacyTriagePath)) {
    try {
      const triage = JSON.parse(readFileSync(legacyTriagePath, 'utf8'));
      const triageEntries = (triage.results || [])
        .map((r) => {
          const cluster = clusterFor({ slug: r.slug || '' });
          return cluster ? { cluster, bucket: r.bucket } : null;
        })
        .filter(Boolean);

      const penalties = clusterPenalties(triageEntries, { minPosts: 3, flopRateForMaxPenalty: 0.5, maxPenalty: 4 });

      for (const [cluster, pen] of Object.entries(penalties)) {
        if (clusters[cluster] && pen.penalty > 0) {
          clusters[cluster].weight -= pen.penalty;
          clusters[cluster].flop_penalty = pen.penalty;
          clusters[cluster].reasons.push(`−${pen.penalty} flop-rate penalty (${Math.round(pen.flopRate * 100)}% flop rate, ${pen.total} posts in legacy triage)`);
          console.log(`  [cluster-penalty] ${cluster}: −${pen.penalty} (flopRate=${pen.flopRate}, ${pen.total} posts)`);
        }
      }
    } catch (e) {
      console.warn(`  [cluster-penalty] Could not load legacy-triage: ${e.message}`);
    }
  }

  return { computed_at: new Date().toISOString(), snapshot_file: desktopFile, mobile_snapshot_file: mobileFile, clusters };
}

function buildClusterWeightSection(clusterPerf) {
  if (!clusterPerf) return '';
  const entries = Object.entries(clusterPerf.clusters)
    .filter(([, c]) => c.weight !== 0)
    .sort((a, b) => b[1].weight - a[1].weight);
  if (!entries.length) return '';
  const lines = entries.map(([name, c]) => {
    const pillarNote = c.pillar ? ` [pillar: ${c.pillar}]` : '';
    const flopNote = c.flop_penalty ? ` [flop-rate penalty: −${c.flop_penalty}]` : '';
    return `- **${name}** (weight ${c.weight > 0 ? '+' : ''}${c.weight})${pillarNote}${flopNote}: ${c.reasons.join('; ')}`;
  });
  return `\n## Cluster Authority Weights\nApply these to your prioritization. Add the weight to the base priority score for any topic in that cluster:\n${lines.join('\n')}\n\nScoring rules:\n- Topics in **page-1 clusters** (+2): prefer these — reinforcing existing winners is higher ROI than breaking into new ones.\n- Topics in **drag clusters** (−3): deprioritize new topics here unless strategically essential. The cluster has not earned authority despite age.\n`;
}

export function loadRejections() {
  const path = join(ROOT, 'data', 'rejected-keywords.json');
  if (!existsSync(path)) return [];
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return []; }
}

// Product-scope guard: isInProductScope / PRODUCT_SCOPE_TERMS now live in
// lib/product-scope.js (imported + re-exported at the top of this file) so
// other agents can reuse them without importing this agent module.

// Persist an auto-rejection so future strategist runs skip the same off-scope
// keyword without us needing to remember it. matchType is "contains" by default
// (see isRejected) — a substring like "body wash" will block any expansion of
// that phrase.
//
// Goes through lib/rejected-keywords.js rather than read-modify-writing the
// file here: this runs from the 15:00 UTC cron scheduler while the long-lived
// PM2 dashboard writes the same file from two routes, and the old unguarded
// read → push → write silently lost whichever side finished second. 18 of the
// 39 entries on the server were written by this function.
function appendRejection(keyword, reason) {
  appendRejectionEntry({ keyword, reason, rejected_at: new Date().toISOString(), source: 'content-strategist:product-scope' });
}

export function isRejected(keyword, rejections) {
  const kw = keyword.toLowerCase().trim();
  return rejections.some(r => {
    const term = r.keyword.toLowerCase().trim();
    if (r.matchType === 'exact') return kw === term;
    return kw.includes(term);
  });
}

export function buildRejectionSection(rejections) {
  if (!rejections.length) return '';
  const lines = rejections.map(r => {
    const note = r.reason ? ` — ${r.reason}` : '';
    if (r.matchType === 'broad') {
      return `- "${r.keyword}" (broad match) — avoid this topic and closely related ideas${note}`;
    }
    if (r.matchType === 'phrase') {
      return `- "${r.keyword}" (phrase match) — do not include keywords containing this phrase${note}`;
    }
    return `- "${r.keyword}" (exact match) — do not schedule this exact keyword${note}`;
  });
  return `\n## Rejected Keywords\nDo not schedule or suggest content related to these topics:\n${lines.join('\n')}\n`;
}

/**
 * Everything we know about, split by whether a POST actually exists.
 *
 * `covered` is what the planner must not propose again. `prepaid` is briefed but
 * unwritten — the planner must SCHEDULE those, not skip them. These used to be
 * one Set handed over as "already published or briefed — DO NOT include these",
 * which meant generating a brief permanently removed the topic from every future
 * calendar. See lib/brief-triage.js.
 */
function loadInventory() {
  const briefSlugs = existsSync(BRIEFS_DIR)
    ? readdirSync(BRIEFS_DIR).filter((f) => f.endsWith('.json')).map((f) => basename(f, '.json'))
    : [];

  const contentSlugs = new Set();

  // Posts on disk. A post directory with no content.html is a pipeline that died
  // partway, not a covered topic — require the HTML or a Shopify record.
  for (const slug of listAllSlugs()) {
    let meta = null;
    try { meta = getPostMetaLib(slug); } catch { /* skip */ }
    if (!existsSync(getContentPath(slug)) && !meta?.shopify_article_id) continue;
    contentSlugs.add(slug);
    if (meta?.target_keyword) contentSlugs.add(slugify(meta.target_keyword));
  }

  // Published registry (written by scheduler after successful pipeline runs)
  const publishedPath = join(ROOT, 'data', 'published.json');
  if (existsSync(publishedPath)) {
    try {
      for (const entry of JSON.parse(readFileSync(publishedPath, 'utf8'))) {
        if (entry.slug) contentSlugs.add(entry.slug);
        if (entry.keyword) contentSlugs.add(slugify(entry.keyword));
      }
    } catch {}
  }

  const { covered, prepaid } = splitInventory({ briefSlugs, contentSlugs: [...contentSlugs] });
  // `all` preserves the old merged view for callers that just need "do we know
  // about this slug" (unmappedIndexEntries), where a brief IS enough to say yes.
  return { covered, prepaid, all: new Set([...covered, ...prepaid]) };
}

// ── schedule extraction ───────────────────────────────────────────────────────

/**
 * Extract structured calendar items from the markdown Publishing Schedule table.
 * Expects the table with columns: Week | Publish Date | Category | Target Keyword | Suggested Title | KD | Volume | Content Type | Priority
 */
function extractScheduleItems(markdown) {
  const items = [];
  const tableRegex = /^\|\s*\*{0,2}(\d+)\*{0,2}\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/gm;

  for (const match of markdown.matchAll(tableRegex)) {
    const [, week, dateStr, category, keyword, title, kd, volume, contentType, priority] = match;
    if (week.trim() === 'Week' || week.trim() === '---') continue;
    const dm = dateStr.trim().match(/([A-Za-z]+)\s+(\d+),?\s+(\d{4})/);
    if (!dm) continue;
    const publishDate = new Date(`${dm[1]} ${dm[2]}, ${dm[3]} 08:00:00 GMT-0700`);
    const slug = slugify(keyword.trim());
    items.push({
      slug,
      keyword: keyword.trim(),
      title: title.trim(),
      category: category.trim(),
      content_type: contentType.trim(),
      priority: priority.trim(),
      week: parseInt(week.trim(), 10),
      publish_date: publishDate.toISOString(),
      kd: parseInt(kd.trim(), 10) || 0,
      volume: parseInt(volume.trim().replace(/,/g, ''), 10) || 0,
      source: 'gap_report',
    });
  }

  return items;
}

/**
 * Extract the non-table sections (Topical Clusters, Brief Queue, etc.) from
 * Claude's markdown output so the rendered calendar preserves them.
 */
function extractNonScheduleSections(markdown) {
  // Strip the Publishing Schedule section (header + table) and return the rest
  const parts = markdown.split(/^##\s+/m);
  const kept = parts.filter((p) => !/^Publishing Schedule/i.test(p.trim()));
  return kept.map((p, i) => (i === 0 ? p : '## ' + p)).join('').trim();
}

/**
 * Convert Claude's structured brief queue (which is JSON, not markdown) into
 * calendar items with sequential weeks and 2-posts-per-week pacing
 * (Mon + Thu, 8 AM PT). This is more reliable than regex-parsing the
 * Publishing Schedule table out of Claude's prose, since Claude varies the
 * column layout from run to run.
 *
 * Validation_source is stamped via the keyword-index lookup.
 *
 * `existingItems` is the calendar as it stands. An item already on it KEEPS its
 * publish_date — only brand-new items are assigned a slot. This is not a nicety:
 * dates used to be re-derived from queue position on every run, and because
 * `start` is always "next Monday", an item that held position 0 slid a week
 * later every week and never came due. Paired with calendar-runner's 7-day lead
 * window that stalled the writer completely — last post written 2026-08-06,
 * discovered 2026-08-18, twelve daily runs reporting success in between.
 */
export function briefQueueToCalendarItems(briefQueue, index, today = new Date(), existingItems = []) {
  const start = new Date(today);
  const daysUntilMon = ((1 + 7 - start.getUTCDay()) % 7) || 7;
  start.setUTCDate(start.getUTCDate() + daysUntilMon);
  start.setUTCHours(15, 0, 0, 0); // 8 AM PT (PDT). Close enough across DST.

  const existingBySlug = new Map(
    (existingItems || []).filter((i) => i?.slug && i.publish_date).map((i) => [i.slug, i]),
  );

  // Dates already spoken for. Reserved up front — a new item must never be
  // dropped onto a slot an existing item holds, and resolving that collision by
  // moving the EXISTING item would reintroduce the drift this function exists to
  // stop. Two posts on one day also violates the staggered-publishing rule.
  const taken = new Set();
  for (const item of briefQueue) {
    const prev = existingBySlug.get(item.slug || slugify(item.keyword));
    if (prev) taken.add(new Date(prev.publish_date).getTime());
  }

  // Mon/Thu at 8 AM PT, walking forward from the first Monday after `today`.
  let cursor = 0;
  const nextFreeSlot = () => {
    for (;;) {
      const week = Math.floor(cursor / 2);
      const publish = new Date(start);
      publish.setUTCDate(start.getUTCDate() + week * 7 + (cursor % 2 === 0 ? 0 : 3));
      cursor++;
      if (!taken.has(publish.getTime())) return publish;
    }
  };

  const nowIso = new Date().toISOString();
  return briefQueue.map((item) => {
    const slug = item.slug || slugify(item.keyword);
    const prev = existingBySlug.get(slug);
    const publish = prev ? new Date(prev.publish_date) : nextFreeSlot();
    taken.add(publish.getTime());

    // Week is a display grouping derived from the date, not from queue position.
    // An overdue item lands in week 1 rather than a negative week.
    const week = Math.max(1, Math.floor((publish - start) / (7 * 86400000)) + 1);

    const tag = validationTag(lookupByKeyword(index, item.keyword));
    return {
      slug,
      keyword: item.keyword,
      title: item.title || '',
      category: item.category || '',
      content_type: item.content_type || 'guide',
      priority: item.priority || (tag === 'amazon' ? 'high' : 'normal'),
      week,
      publish_date: publish.toISOString(),
      kd: item.kd ?? null,
      volume: item.volume ?? null,
      source: 'content_strategist',
      validation_source: tag,
      added_at: nowIso,
    };
  });
}

/**
 * Is `keyword` already covered? Returns the colliding keyword, or null.
 *
 * Thin back-compat wrapper over lib/calendar-coverage.js's `findCoverage`,
 * which is where the rule and its two repaired defects are documented. Kept
 * because existing callers and tests want a bare string back; anything that
 * needs to say WHICH post matched should call `findCoverage` directly, since a
 * keyword alone is what made the 2026-08 clearings unreadable.
 */
export function findScheduledDuplicate(keyword, { publishedKeywords = [], publishedPosts = null, calendarKeywords = [] } = {}) {
  const posts = publishedPosts || publishedKeywords.map((k) => ({ slug: null, keyword: k }));
  return findCoverage(keyword, { publishedPosts: posts, calendarKeywords })?.keyword ?? null;
}

/**
 * The strategist replaces the calendar with its brief queue, which does not
 * contain `review` items — ideas promoted by gsc-opportunity that are waiting
 * for a human in the dashboard Ideas inbox. They previously survived a re-plan
 * only when the LLM happened to re-emit the same keyword; otherwise the idea
 * disappeared with no trace. Carry them across explicitly.
 */
export function mergeReviewItems(newItems, existingItems = []) {
  const slugs = new Set(newItems.map((i) => i.slug));
  const carried = (existingItems || []).filter((i) => i?.status === 'review' && !slugs.has(i.slug));
  return [...newItems, ...carried];
}

/** Max pre-paid briefs to push at the planner at once, so an 8-week plan is not swamped. */
const PREPAID_LIMIT = 12;

/**
 * Tell the planner about briefs it has already paid for.
 *
 * Without this section a briefed topic simply vanished: it was listed under
 * "already published or briefed — DO NOT include these", so it was never
 * scheduled and never written. Exported for tests.
 */
export function buildPrepaidSection(prepaid, limit = PREPAID_LIMIT) {
  if (!prepaid || prepaid.length === 0) return '';
  const shown = prepaid.slice(0, limit);
  const more = prepaid.length - shown.length;
  return `
ALREADY BRIEFED BUT NOT YET WRITTEN — research is paid for, the post is not:
${shown.join('\n')}${more > 0 ? `\n(+${more} more)` : ''}

SCHEDULE THESE FIRST by default. They are the cheapest posts we can ship — the
expensive research step is already done and is wasted until the post exists.

This is a default, not a lock. A brand-new topic MAY jump ahead of them when it
carries validated demand (an Amazon- or GSC/GA4-validated keyword from the
sections above, or a query already earning revenue) — those are worth bumping
up. What must never jump ahead, or be scheduled at all, is a topic in a cluster
listed below as not earning.
`;
}

/**
 * Forbid new posts in clusters that have had a fair shot and returned nothing.
 *
 * Prime Directive: a cluster with traffic and $0 is not an SEO win to extend, it
 * is spend to stop. Toothpaste holds 26 pages pulling 725 clicks for $0 — every
 * additional toothpaste post has been adding to that. Untested clusters are
 * deliberately NOT listed; blocking them is how a category never gets tested.
 * Exported for tests.
 */
export function buildNonEarningSection(classified) {
  const duds = provenDuds(classified);
  if (duds.length === 0) return '';
  return `
## Clusters that do not earn — DO NOT propose new posts here

These have had a fair shot (real traffic, several pages) and returned $0 in the
attribution window. Adding content to them costs money and returns none. Do not
schedule new posts in these clusters; if you see an opportunity there, it belongs
in a rewrite or a conversion-path fix, not a new article.

${duds.map((d) => `- **${d.cluster}** — ${d.clicks} clicks across ${d.pages} pages, $0.00 revenue`).join('\n')}
`;
}

/**
 * Tag each calendar item with the keyword-index validation_source for the
 * matching keyword (or null when no match). Pure — exported for tests.
 */
export function tagCalendarItems(items, index) {
  return items.map((item) => ({
    ...item,
    validation_source: validationTag(lookupByKeyword(index, item.keyword)),
  }));
}

/**
 * Build the prompt section listing Amazon- and GSC/GA4-validated index
 * entries that have no existing content. Returns '' when there's nothing
 * to surface.
 */
export function buildValidatedDemandSection(unmapped) {
  if (!unmapped || unmapped.length === 0) return '';
  const amazon = unmapped.filter((e) => e.validation_source === 'amazon');
  const ga4 = unmapped.filter((e) => e.validation_source === 'gsc_ga4');
  const lines = [
    '## Validated Demand from Keyword Index',
    'The following queries are validated by Amazon (commercial demand) or GSC+GA4 (this site already converts on them) AND we currently have no content for them. Treat these as **highest-priority new-topic candidates** — they should land in the next 2 weeks of the schedule.',
    '',
  ];
  if (amazon.length) {
    lines.push('Amazon-validated:');
    for (const e of amazon.slice(0, 15)) {
      const p = e.amazon?.purchases ?? 0;
      const cs = e.amazon?.conversion_share != null ? ` (${(e.amazon.conversion_share * 100).toFixed(1)}% conv share)` : '';
      lines.push(`- "${e.keyword}" — ${p} amazon purchases${cs}`);
    }
    lines.push('');
  }
  if (ga4.length) {
    lines.push('GSC+GA4-validated:');
    for (const e of ga4.slice(0, 10)) {
      const c = e.ga4?.conversions ?? 0;
      const r = e.ga4?.revenue != null ? ` / $${Number(e.ga4.revenue).toFixed(0)} revenue` : '';
      lines.push(`- "${e.keyword}" — ${c} GA4 conversions${r}`);
    }
    lines.push('');
  }
  return `\n${lines.join('\n')}`;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nContent Strategist Agent — ${config.name}\n`);

  // Load gap report
  const gapReportPath = join(ROOT, 'data', 'reports', 'content-gap', 'content-gap-report.md');
  if (!existsSync(gapReportPath)) {
    console.error(`Content gap report not found: ${gapReportPath}`);
    console.error('Run the content-gap agent first: node agents/content-gap/index.js');
    process.exit(1);
  }

  const gapReport = readFileSync(gapReportPath, 'utf8');
  const inventory = loadInventory();
  const idx = loadIndex(ROOT);
  const unmappedFromIndex = unmappedIndexEntries(idx, inventory.all, { limit: 25 });
  if (idx) {
    const amzCount = unmappedFromIndex.filter((e) => e.validation_source === 'amazon').length;
    console.log(`  Keyword-index: ${unmappedFromIndex.length} unmapped (${amzCount} Amazon-validated)`);
  }
  const rankReport = loadLatestRankReport();
  const clusterPerf = loadClusterPerformance();
  const clusterRevenue = loadClusterRevenue();

  // Load latest GSC opportunity report (unmapped queries are net-new topic candidates)
  let gscOpps = null;
  const gscOppPath = join(ROOT, 'data', 'reports', 'gsc-opportunity', 'latest.json');
  if (existsSync(gscOppPath)) {
    try { gscOpps = JSON.parse(readFileSync(gscOppPath, 'utf8')); } catch { /* ignore */ }
  }

  // Load latest competitor activity (cluster boosts when competitors recently published)
  let competitorSignals = null;
  const compPath = join(ROOT, 'data', 'reports', 'competitor-watcher', 'latest.json');
  if (existsSync(compPath)) {
    try { competitorSignals = JSON.parse(readFileSync(compPath, 'utf8')); } catch { /* ignore */ }
  }

  // Persist computed cluster weights for dashboard / inspection
  if (clusterPerf) {
    mkdirSync(REPORTS_DIR, { recursive: true });
    writeFileSync(join(REPORTS_DIR, 'cluster-weights.json'), JSON.stringify(clusterPerf, null, 2));
    const weighted = Object.values(clusterPerf.clusters).filter((c) => c.weight !== 0).length;
    console.log(`  Cluster weights: ${Object.keys(clusterPerf.clusters).length} clusters, ${weighted} weighted`);
  }

  console.log(`  Gap report: ${gapReportPath}`);
  console.log(`  Existing content: ${inventory.covered.length} written, ${inventory.prepaid.length} briefed-not-written`);
  if (generateBriefs) {
    console.log(`  Mode: plan + generate briefs${limit ? ` (top ${limit})` : ''}`);
  } else {
    console.log('  Mode: plan only (use --generate-briefs to auto-generate briefs)');
  }

  // ── Step 1: Generate content calendar ────────────────────────────────────────

  process.stdout.write('\n  Generating content calendar... ');

  const today = new Date();
  const todayStr = today.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const rejections = loadRejections();
  const brandTerms = (config.brand_terms || []).map((t) => t.toLowerCase());

  const calendarPrompt = `You are a senior SEO content strategist for Real Skin Care (realskincare.com), a clean beauty ecommerce brand selling natural skincare products on Shopify.

TODAY'S DATE: ${todayStr}
SITE: ${config.url || 'https://www.realskincare.com'}

DO NOT PROPOSE BRANDED KEYWORDS. Skip any topic whose target keyword contains one of our own brand terms (${brandTerms.map((t) => `"${t}"`).join(', ')}). Branded queries are already covered by product/collection/homepage SEO — writing blog posts targeting them cannibalizes our own product pages and acquires no new customers.

STAY IN PRODUCT SCOPE. Real Skin Care only sells products in these categories: deodorant, toothpaste, body lotion, body cream, soap (bar + liquid), lip balm, and coconut oil. Every target keyword you propose MUST mention one of these categories or a clear synonym (e.g. "antiperspirant" → deodorant). DO NOT propose articles about adjacent-but-unstocked products — no body wash, no shampoo / conditioner / hair products, no face serum, no shaving cream, no candles, no supplements, etc. If a high-volume keyword is off scope, ignore it — we cannot sell from it, so it is wasted content effort.

You have been given a content gap analysis report. Your job is to produce a detailed, prioritized content calendar that:
1. Targets the highest-impact gaps first (volume × low KD × category importance)
2. Groups related content into topical clusters to build category authority
3. Balances publishing cadence (realistic for a small team — roughly 2–3 posts/week)
4. Considers the buyer journey — ensure each category has TOF, MOF, and BOF coverage over time
5. Specifies the exact keyword, suggested title, content type, and target publish week for each piece

ALREADY WRITTEN — DO NOT propose any of these again:
${inventory.covered.join('\n')}
${buildPrepaidSection(inventory.prepaid)}
${buildClusterWeightSection(clusterPerf)}
${buildNonEarningSection(clusterRevenue)}
${competitorSignals && Object.keys(competitorSignals.cluster_boosts || {}).length ? `\n## Competitor Activity Signals\nCompetitors have recently published in the following clusters. Treat these as a +1 priority boost — keep our cluster fresh and reinforce authority before the competitor post gains traction.\n${Object.entries(competitorSignals.cluster_boosts).map(([cl, n]) => `- **${cl}** — ${n} new competitor post${n > 1 ? 's' : ''}`).join('\n')}\n` : ''}
${gscOpps && (gscOpps.unmapped?.length || gscOpps.low_ctr?.length) ? `\n## GSC Opportunity Signals\nUse these to inform new-topic and rewrite priorities.\n\n**Unmapped high-impression queries (no current page targets these — strong new-topic candidates):**\n${(gscOpps.unmapped || []).slice(0, 15).map((r) => `- "${r.keyword}" — ${r.impressions} impressions, position ${r.position.toFixed(1)}`).join('\n')}\n\n**Low-CTR queries (existing pages need title/meta rewrites — do not schedule as new posts):**\n${(gscOpps.low_ctr || []).slice(0, 10).map((r) => `- "${r.keyword}" — ${r.impressions} impressions, ${(r.ctr * 100).toFixed(1)}% CTR`).join('\n')}\n` : ''}
${buildValidatedDemandSection(unmappedFromIndex)}
${rankReport ? `RANK PERFORMANCE DATA (from latest rank tracker snapshot):
Use this to inform cluster prioritization — double down on clusters with page-1 posts, prioritize quick wins for internal link boosts, and deprioritize clusters with no rankings yet unless high strategic value.
${rankReport}

` : ''}CONTENT GAP REPORT:
${gapReport}
${buildRejectionSection(rejections)}
OUTPUT REQUIREMENTS:
Produce a Markdown content calendar with the following sections:

## Content Calendar — Real Skin Care
[intro paragraph with strategic rationale]

## Publishing Schedule
A table with columns: | Week | Publish Date | Category | Target Keyword | Suggested Title | KD | Volume | Content Type | Priority |
- Plan 8 weeks of content from today
- Start with quick wins and highest-priority items
- Group related topics in adjacent weeks to build cluster authority

## Topical Clusters
For each major category (Toothpaste, Lip Balm, Bar Soap, Body Lotion, Deodorant, Coconut Oil):
- List the planned pieces in recommended order
- Note which piece is the "pillar" vs supporting articles

## Brief Queue
A numbered list of keywords to brief next, in priority order. For each:
- **Keyword:** [target keyword]
- **Suggested Title:** [title]
- **Category:** [category]
- **Rationale:** [1–2 sentences on why this is next]

Format the Brief Queue items so they can be fed directly into the content-researcher agent.
The content-researcher agent is called with: node agents/content-researcher/index.js "<keyword>"

Be specific with dates. Use realistic weekly batches of 2–3 posts.`;

  const calendarResponse = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8192,
    messages: [{ role: 'user', content: calendarPrompt }],
  });

  const calendarMd = calendarResponse.content[0].text;
  console.log('done');

  // ── Step 2: Extract brief queue ───────────────────────────────────────────────

  process.stdout.write('  Extracting brief queue... ');

  const extractPrompt = `From this content calendar, extract the "Brief Queue" section and return ONLY a JSON array of objects, one per item. Each object should have:
{
  "keyword": "the exact target keyword",
  "title": "the suggested title",
  "category": "the category",
  "slug": "url-friendly slug of the keyword"
}

Return only valid JSON, no explanation, no markdown fences.

CONTENT CALENDAR:
${calendarMd}`;

  const extractResponse = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2048,
    messages: [{ role: 'user', content: extractPrompt }],
  });

  // Two candidate pools for cannibalization detection, kept SEPARATE because the
  // exact-match rule differs — see lib/calendar-coverage.js. Merging them is what
  // let keywords with a live post back onto the calendar.
  //
  // A directory under data/posts/ is NOT a post. `blog-post-writer` writes
  // meta.json at draft time, so counting every meta.json as coverage meant a
  // calendar item became "already covered by a published post" the moment it
  // started drafting — covered by the post generated from it. The pool now
  // applies the same written-or-published rule scripts/triage-orphan-briefs.mjs
  // has always applied, and the excluded scaffolds are reported rather than
  // silently believed.
  const { posts: publishedPosts, unwritten } = coveragePool({
    slugs: listAllSlugs(),
    getMeta: (slug) => getPostMetaLib(slug),
    hasContent: (slug) => existsSync(getContentPath(slug)),
  });
  if (unwritten.length) {
    console.log(`  ${unwritten.length} post dir(s) hold meta.json but nothing written — NOT counted as coverage: ${unwritten.map((u) => u.slug).join(', ')}`);
  }
  if (existsSync(join(ROOT, 'data', 'published.json'))) {
    try {
      const pub = JSON.parse(readFileSync(join(ROOT, 'data', 'published.json'), 'utf8'));
      for (const e of pub) { if (e.keyword) publishedPosts.push({ slug: e.slug || null, keyword: e.keyword }); }
    } catch { /* ignore */ }
  }

  // Items already queued. An exact match here is an item matching itself on a
  // re-plan, which is expected.
  const existingCalendarItems = (() => {
    try { return loadCalendar().items || []; } catch { return []; }
  })();
  const calendarKeywords = existingCalendarItems.map((i) => i.keyword).filter(Boolean);

  // Every drop is recorded, not just printed. A `[SKIP]` line in an unattended
  // cron log is not a record — it is what let 12 of 19 calendar items disappear
  // on 2026-08-19/21 with nobody able to say which ones, or why.
  const skips = [];

  let briefQueue = [];
  try {
    const raw = extractResponse.content[0].text.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '');
    briefQueue = JSON.parse(raw);
    if (limit) briefQueue = briefQueue.slice(0, limit);
    briefQueue = briefQueue.filter(item => {
      if (isRejected(item.keyword, rejections)) {
        console.log(`  [SKIP] Rejected keyword: "${item.keyword}"`);
        skips.push({ keyword: item.keyword, reason: 'rejected' });
        return false;
      }
      const kwLower = (item.keyword || '').toLowerCase();
      const brandHit = brandTerms.find((t) => kwLower.includes(t));
      if (brandHit) {
        console.log(`  [SKIP] Branded keyword (contains "${brandHit}"): "${item.keyword}"`);
        skips.push({ keyword: item.keyword, reason: 'branded', detail: `contains "${brandHit}"` });
        return false;
      }
      if (!isInProductScope(item.keyword)) {
        console.log(`  [SKIP] Off product scope (no product mapping): "${item.keyword}"`);
        appendRejection(item.keyword, 'no product mapping');
        skips.push({ keyword: item.keyword, reason: 'off_scope' });
        return false;
      }
      // Cannibalization check: exact against published posts, near-duplicate
      // against both pools. Self-matches on the calendar are allowed through.
      const hit = findCoverage(item.keyword, { publishedPosts, calendarKeywords });
      if (hit) {
        // Naming the PAGE, not just a keyword. "already covered: x ~ existing x"
        // could not distinguish a live competitor page from the item's own draft.
        const where = hit.slug ? `data/posts/${hit.slug}` : `the ${hit.pool} pool`;
        console.log(`  [SKIP] already covered: "${item.keyword}" ~ "${hit.keyword}" (${hit.rule}-match, ${where})`);
        skips.push({
          keyword: item.keyword, reason: 'already_covered',
          matched: hit.keyword, matchedSlug: hit.slug, rule: hit.rule, pool: hit.pool,
        });
        return false;
      }
      // Clusters that have proven they do not earn. This is a HARD filter, not
      // just the prompt instruction above it — the planner is an LLM and the
      // prompt is a request. Dropping the proposal here is also what clears
      // existing items out of the calendar on the next re-plan.
      const dudCluster = clusterForText(item.keyword) || clusterForText(item.category);
      if (clusterRevenue[dudCluster]?.status === 'proven_dud') {
        const c = clusterRevenue[dudCluster];
        const detail = `${dudCluster} cluster does not earn (${c.clicks} clicks, $0.00)`;
        console.log(`  [SKIP] ${detail}: "${item.keyword}"`);
        skips.push({ keyword: item.keyword, reason: 'cluster_dud', detail });
        return false;
      }
      return true;
    });
  } catch (e) {
    console.log('(parse error — queue will be empty)');
    console.error(e.message);
  }
  console.log(`done (${briefQueue.length} items)`);

  // ── Step 3: Build calendar items + save as JSON ──
  // Prefer the structured briefQueue (Claude's JSON extract) over regex-parsing
  // the Publishing Schedule table, which is brittle when Claude varies the
  // column layout. Fall back to the markdown table only if briefQueue is empty.

  let extractedItems;
  if (briefQueue.length > 0) {
    extractedItems = briefQueueToCalendarItems(briefQueue, idx, new Date(), existingCalendarItems);
    const tagged = extractedItems.filter((i) => i.validation_source).length;
    console.log(`  Built ${extractedItems.length} calendar items from brief queue (${tagged} validation-tagged)`);
  } else {
    const rawExtracted = extractScheduleItems(calendarMd);
    extractedItems = tagCalendarItems(rawExtracted, idx);
    console.log(`  Extracted ${extractedItems.length} calendar items from markdown table (fallback)`);
  }

  // Preserve any existing supporting sections (clusters, brief queue) in the markdown view
  const markdownExtras = extractNonScheduleSections(calendarMd);

  // Carry across ideas awaiting human review — they are not in the brief queue,
  // so writing `extractedItems` alone would silently drop them from the inbox.
  const calendarItems = mergeReviewItems(extractedItems, existingCalendarItems);
  const carried = calendarItems.length - extractedItems.length;

  // Write JSON as source of truth + regenerate markdown view automatically
  writeCalendar({
    items: calendarItems,
    regenerated_at: new Date().toISOString(),
    preserve_metadata: true,
    markdown_extras: markdownExtras,
  });
  console.log(`\n  Calendar saved: data/calendar/calendar.json (+ markdown view)`);
  if (carried > 0) console.log(`  Carried ${carried} item(s) awaiting review in the Ideas inbox`);

  // ── The calendar is REPLACED, so say what that cost ──────────────────────────
  //
  // Everything above this line only ever printed why a PROPOSAL was dropped.
  // Nothing said which SCHEDULED items stopped existing as a result, and five of
  // the twelve cleared on 2026-08-19/21 were never mentioned at all — the
  // planner simply did not re-propose them and no filter fired. That class of
  // loss is now named, attributed, and put in front of a human.
  const cleared = classifyClearedItems({
    previousItems: existingCalendarItems,
    newItems: calendarItems,
    skips,
    postState: (slug) => {
      const meta = getPostMetaLib(slug);
      return { exists: Boolean(meta), live: Boolean(meta) && isLiveOrScheduled(meta) };
    },
  });
  if (cleared.length) {
    console.log(`\n  CLEARED — ${cleared.length} scheduled item(s) removed from the calendar by this re-plan:`);
    for (const line of renderClearedLines(cleared)) console.log(line);
    const digest = clearedDigest(cleared, { kept: extractedItems.length });
    // Deferred, per CLAUDE.md's digest convention. A cleared calendar is a thing
    // to read at 5 AM, never a page.
    if (digest) await notify(digest);
  } else {
    console.log('  Nothing was cleared from the calendar by this re-plan.');
  }

  // ── Step 4: Generate briefs (optional) ───────────────────────────────────────

  if (generateBriefs && briefQueue.length > 0) {
    console.log(`\n  Generating ${briefQueue.length} brief(s) via content-researcher...\n`);

    for (let i = 0; i < briefQueue.length; i++) {
      const item = briefQueue[i];
      const slug = item.slug || slugify(item.keyword);
      const briefPath = join(BRIEFS_DIR, `${slug}.json`);

      if (existsSync(briefPath)) {
        console.log(`  [${i + 1}/${briefQueue.length}] Skipping "${item.keyword}" — brief already exists`);
        continue;
      }

      console.log(`  [${i + 1}/${briefQueue.length}] Briefing: "${item.keyword}"`);
      try {
        execSync(
          `node ${join(ROOT, 'agents', 'content-researcher', 'index.js')} "${item.keyword}"`,
          { stdio: 'inherit', cwd: ROOT },
        );
      } catch (e) {
        console.error(`    Error generating brief for "${item.keyword}": ${e.message}`);
      }
    }

    console.log('\n  Brief generation complete.');
  }

  // ── Summary ───────────────────────────────────────────────────────────────────

  console.log('\n── Summary ──────────────────────────────────────────────────────────────────');
  console.log(`  Calendar:  data/calendar/calendar.json (${calendarItems.length} items)`);
  if (briefQueue.length > 0) {
    console.log(`\n  Brief Queue (top ${Math.min(briefQueue.length, 10)}):`);
    briefQueue.slice(0, 10).forEach((item, i) => {
      console.log(`    ${i + 1}. [${item.category}] "${item.keyword}"`);
    });
  }
  if (!generateBriefs && briefQueue.length > 0) {
    console.log(`\n  To generate briefs, run:`);
    console.log(`    node agents/content-strategist/index.js --generate-briefs`);
    console.log(`    node agents/content-strategist/index.js --generate-briefs --limit 3`);
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(() => {
    console.log('\nStrategy complete.');
  }).catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
