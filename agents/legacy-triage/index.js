#!/usr/bin/env node
/**
 * Legacy Post Triage
 *
 * One-time classification pass (re-runnable) that sorts legacy published
 * posts into 4 buckets: winner, rising, flop, broken. Stamps each post's
 * JSON with legacy_bucket and legacy_triage_reason. Auto-locks winners.
 *
 * Usage:
 *   node agents/legacy-triage/index.js
 *   node agents/legacy-triage/index.js --dry-run
 *   node agents/legacy-triage/index.js --force   # re-triage already-bucketed posts
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../../lib/notify.js';

import { listAllSlugs, getPostMeta as readPostMeta, getMetaPath, getContentPath, POSTS_DIR, ROOT } from '../../lib/posts.js';
import { loadDeviceWeights, effectivePosition } from '../../lib/device-weights.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'legacy-triage');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));
const CANONICAL_ROOT = (config.url || '').replace(/\/$/, '');

function readJsonSafe(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function isLegacy(meta) {
  return !!(meta.legacy_source || meta.legacy_synced_at || !meta.target_keyword || meta.target_keyword === '');
}

function wordCount(slug) {
  const html = getContentPath(slug);
  if (!existsSync(html)) return 0;
  return readFileSync(html, 'utf8').replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length;
}

function toCanonicalUrl(meta) {
  if (meta.shopify_handle) return `${CANONICAL_ROOT}/blogs/news/${meta.shopify_handle}`;
  if (meta.shopify_url) return meta.shopify_url.replace(/https?:\/\/[^\/]+/, CANONICAL_ROOT);
  return null;
}

function loadIndexingStates() {
  const idx = readJsonSafe(join(ROOT, 'data', 'reports', 'indexing', 'latest.json'));
  if (!idx) return {};
  const map = {};
  for (const r of (idx.results || [])) {
    if (r.slug) map[r.slug] = r.state;
    if (r.url) map[r.url] = r.state;
  }
  return map;
}

function loadRankData() {
  const dir = join(ROOT, 'data', 'rank-snapshots');
  if (!existsSync(dir)) return {};
  const all = readdirSync(dir).filter(f => f.endsWith('.json'));
  const pickLatest = (regex) => {
    const m = all.filter(f => regex.test(f)).sort((a, b) => a.slice(0, 10).localeCompare(b.slice(0, 10)));
    return m.length ? m[m.length - 1] : null;
  };
  const desktopFile = pickLatest(/^\d{4}-\d{2}-\d{2}-desktop\.json$/) || pickLatest(/^\d{4}-\d{2}-\d{2}\.json$/);
  if (!desktopFile) return {};
  const snap = JSON.parse(readFileSync(join(dir, desktopFile), 'utf8'));

  const mobileFile = pickLatest(/^\d{4}-\d{2}-\d{2}-mobile\.json$/);
  const mobileBySlug = {};
  if (mobileFile) {
    try {
      const mob = JSON.parse(readFileSync(join(dir, mobileFile), 'utf8'));
      for (const p of (mob.posts || [])) {
        if (p.slug) mobileBySlug[p.slug] = p.position ?? null;
      }
    } catch { /* ignore */ }
  }
  const weights = loadDeviceWeights();

  // Classification thresholds (winner ≤10, rising 11–30, flop >50) need to
  // reflect where the site earns revenue — not just desktop. Each entry's
  // `position` field is replaced with its effective (revenue-weighted)
  // position; original desktop and mobile numbers are kept for reporting.
  const map = {};
  for (const p of (snap.posts || [])) {
    const mobilePos = p.slug ? mobileBySlug[p.slug] ?? null : null;
    const eff = effectivePosition({ url: p.url, desktopPos: p.position, mobilePos, weights });
    const entry = { ...p, desktop_position: p.position, mobile_position: mobilePos, position: eff };
    if (p.slug) map[p.slug] = entry;
    if (p.url)  map[p.url]  = entry;
  }
  return map;
}

async function loadGscPerformance(url) {
  try {
    const gsc = await import('../../lib/gsc.js');
    return await gsc.getPagePerformance(url, 90);
  } catch { return null; }
}

// States that require manual investigation (true technical misconfigurations).
// not_found and crawled_not_indexed are handled automatically by indexing-fixer
// and refresh-runner respectively — they are NOT broken.
const BROKEN_STATES = new Set(['excluded_noindex', 'excluded_robots', 'excluded_canonical']);

function classify({ meta, indexState, rankEntry, gscMetrics, words }) {
  if (BROKEN_STATES.has(indexState) || meta.indexing_blocked) {
    return { bucket: 'broken', reason: `Indexing state: ${indexState || 'blocked'}. Technical fix required.` };
  }

  // not_found → indexing-fixer handles via sitemap ping / Indexing API submission
  if (indexState === 'not_found') {
    return { bucket: 'flop', reason: 'Not yet indexed by Google. Indexing-fixer will auto-submit.' };
  }

  // crawled_not_indexed → indexing-fixer auto-triggers refresh-runner
  if (indexState === 'crawled_not_indexed') {
    return { bucket: 'flop', reason: 'Google crawled but chose not to index. Auto-refresh will trigger.' };
  }

  const position = rankEntry?.position ?? gscMetrics?.position ?? null;
  const impressions = gscMetrics?.impressions ?? 0;
  const isIndexed = indexState === 'indexed' || impressions > 0;

  if (isIndexed && position != null && position <= 10 && impressions >= 10) {
    return { bucket: 'winner', reason: `Position ${Math.round(position)}, ${impressions} impressions. Page 1 — auto-locked.` };
  }

  if (isIndexed && position != null && position >= 11 && position <= 30 && impressions >= 10) {
    return { bucket: 'rising', reason: `Position ${Math.round(position)}, ${impressions} impressions. Meta-only optimization candidate.` };
  }

  if (words < 800) {
    return { bucket: 'flop', reason: `Thin content (${words} words). Full rewrite needed.` };
  }

  if (isIndexed && impressions === 0) {
    return { bucket: 'flop', reason: 'Indexed but zero impressions in 90 days. Content not matching any search query.' };
  }

  if (!isIndexed && !BROKEN_STATES.has(indexState)) {
    return { bucket: 'flop', reason: `Not indexed (state: ${indexState || 'unknown'}). Needs rewrite or technical investigation.` };
  }

  if (position == null || position > 50) {
    return { bucket: 'flop', reason: `${position ? 'Position ' + Math.round(position) : 'No ranking data'}. Not competitive.` };
  }

  return { bucket: 'rising', reason: `Position ${Math.round(position)}, ${impressions} impressions. Default: meta-only.` };
}

async function main() {
  console.log('\nLegacy Post Triage\n');

  mkdirSync(REPORTS_DIR, { recursive: true });

  const posts = [];
  for (const slug of listAllSlugs()) {
    try {
      const meta = readPostMeta(slug);
      if (!meta) continue;
      if (!meta.slug) meta.slug = slug;
      // Match the dashboard's classification: posts with a past shopify_publish_at
      // are effectively published even if shopify_status wasn't explicitly stamped.
      const publishTs = meta.shopify_publish_at ? Date.parse(meta.shopify_publish_at) : NaN;
      const isPublished = meta.shopify_status === 'published' || (!Number.isNaN(publishTs) && publishTs <= Date.now());
      if (!isPublished) continue;
      if (!isLegacy(meta)) continue;
      if (meta.legacy_bucket && !FORCE) continue;
      meta._file = getMetaPath(slug);
      posts.push(meta);
    } catch { /* skip */ }
  }

  console.log(`  Legacy published posts to triage: ${posts.length}`);
  if (posts.length === 0) { console.log('  Nothing to triage.'); return; }

  const indexStates = loadIndexingStates();
  const rankData = loadRankData();
  console.log(`  Indexing states loaded: ${Object.keys(indexStates).length}`);
  console.log(`  Rank entries loaded: ${Object.keys(rankData).length}`);

  const results = [];
  const bucketCounts = { winner: 0, rising: 0, flop: 0, broken: 0 };

  for (const meta of posts) {
    const slug = meta.slug;
    const url = toCanonicalUrl(meta);
    const indexState = indexStates[slug] || (url ? indexStates[url] : null) || null;
    const rankEntry = rankData[slug] || (url ? rankData[url] : null) || null;
    const words = wordCount(slug);

    let gscMetrics = null;
    if (url) {
      try { gscMetrics = await loadGscPerformance(url); } catch { /* skip */ }
    }

    const { bucket, reason } = classify({ meta, indexState, rankEntry, gscMetrics, words });
    bucketCounts[bucket]++;

    const entry = {
      slug,
      title: meta.title || slug,
      url,
      bucket,
      reason,
      position: rankEntry?.position ?? gscMetrics?.position ?? null,
      impressions: gscMetrics?.impressions ?? 0,
      clicks: gscMetrics?.clicks ?? 0,
      words,
      indexing_state: indexState,
    };
    results.push(entry);

    const icon = bucket === 'winner' ? 'WINNER' : bucket === 'rising' ? 'RISING' : bucket === 'flop' ? 'FLOP' : 'BROKEN';
    console.log(`  [${icon}] ${slug} — ${reason.slice(0, 80)}`);

    if (!DRY_RUN) {
      meta.legacy_bucket = bucket;
      meta.legacy_triage_reason = reason;
      if (bucket === 'winner') meta.legacy_locked = true;
      meta.legacy_triaged_at = new Date().toISOString();
      const cleaned = { ...meta };
      delete cleaned._file;
      writeFileSync(meta._file, JSON.stringify(cleaned, null, 2));
    }
  }

  console.log('\n  Summary:');
  for (const [b, c] of Object.entries(bucketCounts)) console.log(`    ${b}: ${c}`);

  if (!DRY_RUN) {
    const snapshot = {
      generated_at: new Date().toISOString(),
      total: posts.length,
      counts: bucketCounts,
      results,
    };
    writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify(snapshot, null, 2));

    const dateStr = new Date().toISOString().slice(0, 10);
    const md = [
      `# Legacy Post Triage — ${dateStr}`,
      '',
      `Total: ${posts.length} | Winners: ${bucketCounts.winner} | Rising: ${bucketCounts.rising} | Flops: ${bucketCounts.flop} | Broken: ${bucketCounts.broken}`,
      '',
      '## Winners (locked)',
      ...results.filter(r => r.bucket === 'winner').map(r => `- **${r.title}** — pos ${Math.round(r.position)}, ${r.impressions} impr`),
      '',
      '## Rising (meta-only)',
      ...results.filter(r => r.bucket === 'rising').map(r => `- **${r.title}** — pos ${r.position ? Math.round(r.position) : '?'}, ${r.impressions} impr`),
      '',
      '## Flops (rewrite)',
      ...results.filter(r => r.bucket === 'flop').map(r => `- **${r.title}** — ${r.words} words, ${r.reason.slice(0, 60)}`),
      '',
      '## Broken (technical fix)',
      ...results.filter(r => r.bucket === 'broken').map(r => `- **${r.title}** — ${r.reason}`),
    ].join('\n');
    writeFileSync(join(REPORTS_DIR, `${dateStr}.md`), md);
  }

  await notify({
    subject: `Legacy Triage: ${bucketCounts.winner} winners, ${bucketCounts.rising} rising, ${bucketCounts.flop} flops, ${bucketCounts.broken} broken`,
    body: `Triaged ${posts.length} legacy posts.\n\n` +
      Object.entries(bucketCounts).map(([b, c]) => `${b}: ${c}`).join('\n'),
    status: bucketCounts.broken > 0 ? 'error' : 'info',
    category: 'seo',
  }).catch(() => {});

  console.log('\nLegacy triage complete.');
}

main().catch(err => {
  console.error('Legacy triage failed:', err);
  process.exit(1);
});
