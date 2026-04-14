#!/usr/bin/env node
/**
 * Quick-Win Targeter Agent
 *
 * Finds posts sitting at positions 11–20 (page 2) and generates refresh briefs
 * ranked by opportunity. Posts close to page 1 with high impressions are the
 * cheapest traffic gains in SEO — this agent surfaces them weekly.
 *
 * Inputs:
 *   - Latest rank snapshot (data/rank-snapshots/*.json)
 *   - GSC per-page metrics (via lib/gsc.js getPagePerformance + getPageKeywords)
 *   - data/posts/<slug>.json for post metadata
 *
 * Output:
 *   - data/reports/quick-wins/YYYY-MM-DD.md — prioritized list with rationale
 *   - data/reports/quick-wins/latest.json — machine-readable top candidates
 *
 * Scoring (higher = better opportunity):
 *   score = impressions × (21 - position) × (1 / (ctr + 0.01))
 *   This prioritizes: high impressions (already being served), close to page 1
 *   (smaller nudge needed), and underperforming CTR (most upside from rewrite).
 *
 * Usage:
 *   node agents/quick-win-targeter/index.js            # generate report
 *   node agents/quick-win-targeter/index.js --limit 5  # top N candidates
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../../lib/notify.js';
import { getMetaPath } from '../../lib/posts.js';
import { loadDeviceWeights, effectivePosition } from '../../lib/device-weights.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const SNAPSHOTS_DIR = join(ROOT, 'data', 'rank-snapshots');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'quick-wins');

// ── args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const limitArg = (() => {
  const i = args.indexOf('--limit');
  return i !== -1 ? parseInt(args[i + 1], 10) : 10;
})();

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Load the latest rank snapshot for each device. Returns the desktop snapshot
 * (which drives eligibility and is the primary data source) plus, when
 * available, a slug→mobile-position map so the scorer can compare the two.
 *
 * Google uses mobile-first indexing, so mobile position is the signal it
 * weighs most. We still use desktop as the "spine" of the snapshot (that's
 * where the post list lives), but score and filter using the mobile position
 * when we have one — and flag large desktop/mobile gaps as mobile-UX issues.
 */
function loadLatestSnapshot() {
  if (!existsSync(SNAPSHOTS_DIR)) return null;
  const all = readdirSync(SNAPSHOTS_DIR).filter((f) => f.endsWith('.json'));
  const pickLatest = (regex) => {
    const matches = all.filter((f) => regex.test(f))
      .sort((a, b) => a.slice(0, 10).localeCompare(b.slice(0, 10)));
    return matches.length ? matches[matches.length - 1] : null;
  };
  // Primary (desktop) snapshot — device-suffixed file, or legacy plain-date.
  const desktopFile = pickLatest(/^\d{4}-\d{2}-\d{2}-desktop\.json$/)
                   || pickLatest(/^\d{4}-\d{2}-\d{2}\.json$/);
  if (!desktopFile) return null;
  const desktop = JSON.parse(readFileSync(join(SNAPSHOTS_DIR, desktopFile), 'utf8'));

  // Mobile snapshot — optional. Indexed by slug for fast lookup.
  const mobileFile = pickLatest(/^\d{4}-\d{2}-\d{2}-mobile\.json$/);
  const mobileBySlug = {};
  if (mobileFile) {
    const mobile = JSON.parse(readFileSync(join(SNAPSHOTS_DIR, mobileFile), 'utf8'));
    for (const p of (mobile.posts || [])) {
      if (p.slug) mobileBySlug[p.slug] = p.position ?? null;
    }
  }
  return { file: desktopFile, data: desktop, mobileBySlug, mobileFile };
}

function loadPostMeta(slug) {
  const path = getMetaPath(slug);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * Compute opportunity score for a post at positions 11-20.
 * Higher impressions + closer to page 1 + worse CTR = higher score.
 *
 * Eligibility and proximity are computed from the "effective position" — a
 * revenue-weighted blend of desktop and mobile positions. See
 * lib/device-weights.js. This means a keyword at #5 desktop / #25 mobile on
 * a mobile-converting page scores as ~position 25 (not-a-quick-win), while
 * #15 desktop / #12 mobile on the same page effectively scores as ~12
 * (a real page-1 opportunity).
 */
function scoreOpportunity({ position, impressions = 0, ctr = 0, clusterWeight = 0, competitorBoost = 0, kd = null }) {
  if (!position || position < 11 || position > 20) return 0;
  const proximityWeight = 21 - position; // 1 (pos 20) to 10 (pos 11)
  const ctrFactor = 1 / (ctr + 0.01);    // lower CTR → higher factor
  const base = impressions * proximityWeight * ctrFactor;
  // Cluster-authority multiplier: +2 weight cluster gets +30% score boost,
  // -3 weight drag cluster gets -45% score penalty. See docs/signal-manifest.md.
  const clusterMultiplier = 1 + (clusterWeight * 0.15);
  // Competitor activity multiplier: +1 per new competitor post in cluster.
  const competitorMultiplier = 1 + (competitorBoost * 0.1);
  // KD multiplier: low-KD keywords are easier to push to page 1.
  // KD 0 → 1.5x, KD 50 → 0.9x, KD 100 → 0.3x. When KD is unknown, neutral 1.0x.
  const kdMultiplier = kd != null ? Math.max(0.3, 1.5 - (kd / 100) * 1.2) : 1;
  return Math.round(base * clusterMultiplier * competitorMultiplier * kdMultiplier);
}

/**
 * Load cluster-weights.json and competitor cluster_boosts. Returns maps
 * keyed by cluster name. Both files are produced by upstream agents; this
 * closes the signal-manifest gap where quick-win scoring ignored cluster
 * authority and competitor pressure.
 */
function loadClusterContext() {
  const weights = {};
  const boosts = {};
  try {
    const cw = JSON.parse(readFileSync(join(ROOT, 'data', 'reports', 'content-strategist', 'cluster-weights.json'), 'utf8'));
    for (const [name, c] of Object.entries(cw.clusters || {})) weights[name] = c.weight || 0;
  } catch { /* optional */ }
  try {
    const comp = JSON.parse(readFileSync(join(ROOT, 'data', 'reports', 'competitor-watcher', 'latest.json'), 'utf8'));
    for (const [name, count] of Object.entries(comp.cluster_boosts || {})) boosts[name] = count;
  } catch { /* optional */ }
  return { weights, boosts };
}

/**
 * Best-effort mapping from a post's keyword/slug to a known cluster name.
 * Mirrors the rule used in content-strategist/loadClusterPerformance.
 */
const KNOWN_CLUSTERS = [
  'deodorant', 'toothpaste', 'lotion', 'soap', 'lip balm',
  'coconut oil', 'shampoo', 'conditioner', 'sunscreen',
  'body wash', 'face cream', 'moisturizer', 'serum',
];
function clusterFor(post) {
  const text = ((post.keyword || '') + ' ' + (post.slug || '')).toLowerCase();
  for (const c of KNOWN_CLUSTERS) {
    if (text.includes(c.replace('-', ' ')) || text.includes(c.replace(' ', '-'))) return c;
  }
  return null;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nQuick-Win Targeter Agent\n');

  const snap = loadLatestSnapshot();
  if (!snap) {
    console.error('No rank snapshots found. Run: node agents/rank-tracker/index.js');
    process.exit(1);
  }

  console.log(`  Using snapshot: ${snap.file}`);
  console.log(`  Total tracked posts: ${snap.data.posts?.length || 0}`);
  const mobileAvailable = Object.keys(snap.mobileBySlug || {}).length > 0;
  if (mobileAvailable) {
    console.log(`  Mobile snapshot: ${snap.mobileFile} (${Object.keys(snap.mobileBySlug).length} posts)`);
  }

  // Device weights translate (desktop_pos, mobile_pos) into a single
  // "effective position" weighted by where the site earns revenue. When the
  // file isn't present, effectivePosition falls back to desktop-only.
  const deviceWeights = loadDeviceWeights();
  if (deviceWeights) {
    const { desktop, mobile } = deviceWeights.site;
    console.log(`  Device weights: desktop ${(desktop*100).toFixed(0)}% / mobile ${(mobile*100).toFixed(0)}% (${deviceWeights.basis}, ${Object.keys(deviceWeights.pages).length} per-page overrides)`);
  } else {
    console.log('  Device weights: not available — effective position falls back to desktop-only');
  }

  const clusterContext = loadClusterContext();
  const weightedClusters = Object.entries(clusterContext.weights).filter(([, w]) => w !== 0);
  if (weightedClusters.length) console.log(`  Cluster weights loaded: ${weightedClusters.map(([n, w]) => `${n}:${w > 0 ? '+' : ''}${w}`).join(', ')}`);
  const boostedClusters = Object.keys(clusterContext.boosts);
  if (boostedClusters.length) console.log(`  Competitor boosts: ${boostedClusters.join(', ')}`);

  // Load rejections (brand conflicts, off-topic terms). Filtered out of
  // candidate selection BEFORE GSC enrichment to avoid wasted API calls.
  const rejectionsPath = join(ROOT, 'data', 'rejected-keywords.json');
  let rejections = [];
  if (existsSync(rejectionsPath)) {
    try { rejections = JSON.parse(readFileSync(rejectionsPath, 'utf8')); } catch { /* ignore */ }
  }
  const isRejected = (kw) => {
    const k = (kw || '').toLowerCase().trim();
    if (!k) return false;
    return rejections.some((r) => {
      const term = (r.keyword || '').toLowerCase().trim();
      if (!term) return false;
      if (r.matchType === 'exact') return k === term;
      return k.includes(term);
    });
  };

  // Minimum post age before a post qualifies as a quick-win candidate.
  // Brand-new posts need time to be indexed and stabilize their ranking before
  // we start recommending rewrites — a 30-day floor gives Google time to crawl,
  // assign a real position, and accumulate enough impressions/clicks to make
  // the opportunity score meaningful.
  const MIN_AGE_DAYS = 30;
  const nowMs = Date.now();
  const ageDays = (iso) => {
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : Math.floor((nowMs - t) / 86400000);
  };

  // Step 1: Filter to effective-position 11–20, exclude rejected keywords,
  // and exclude posts younger than MIN_AGE_DAYS. Effective position blends
  // desktop and mobile rankings weighted by where the site earns revenue
  // (per-page when that page has >=3 conversions, site-wide otherwise).
  const annotated = (snap.data.posts || []).map((p) => {
    const mobilePosition = snap.mobileBySlug ? (snap.mobileBySlug[p.slug] ?? null) : null;
    const deviceGap = (mobilePosition != null && p.position != null)
      ? (mobilePosition - p.position)   // +ve = mobile trails desktop (mobile UX issue)
      : null;
    const effectivePos = effectivePosition({
      url: p.url,
      desktopPos: p.position,
      mobilePos: mobilePosition,
      weights: deviceWeights,
    });
    return { ...p, mobilePosition, deviceGap, effectivePos };
  });
  const allCandidates = annotated.filter((p) => p.effectivePos && p.effectivePos >= 11 && p.effectivePos <= 20);
  const afterRejection = allCandidates.filter((p) => !isRejected(p.keyword) && !isRejected(p.slug));
  const candidates = afterRejection.filter((p) => {
    const meta = loadPostMeta(p.slug);
    const publishedAt = meta?.published_at || p.published_at;
    const age = ageDays(publishedAt);
    return age == null ? false : age >= MIN_AGE_DAYS;
  });
  const rejectedCount = allCandidates.length - afterRejection.length;
  const tooYoungCount = afterRejection.length - candidates.length;
  const filterNotes = [];
  if (rejectedCount) filterNotes.push(`${rejectedCount} rejected keyword`);
  if (tooYoungCount) filterNotes.push(`${tooYoungCount} under ${MIN_AGE_DAYS}-day age floor`);
  console.log(`  Posts at positions 11–20: ${candidates.length}${filterNotes.length ? ` (${filterNotes.join(', ')} filtered)` : ''}`);

  if (candidates.length === 0) {
    console.log('\n  No quick-win candidates in the current snapshot.');
    const dateStr = new Date().toISOString().slice(0, 10);
    mkdirSync(REPORTS_DIR, { recursive: true });
    const emptyReport = `# Quick-Win Targets — ${dateStr}\n\nNo posts currently ranking at positions 11–20.\n\nSnapshot: ${snap.file}\n`;
    writeFileSync(join(REPORTS_DIR, `${dateStr}.md`), emptyReport);
    writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify({ generated_at: new Date().toISOString(), candidates: [] }, null, 2));
    return;
  }

  // Step 2: Enrich with GSC data (optional — gracefully handles GSC errors)
  let gsc = null;
  try {
    gsc = await import('../../lib/gsc.js');
    console.log('  Fetching GSC metrics for each candidate...');
  } catch (err) {
    console.warn(`  [warn] GSC library unavailable: ${err.message}`);
  }

  // Posts must show real impression signal in GSC — zero impressions means
  // the post isn't actually matching any query and no rewrite will help.
  const MIN_IMPRESSIONS = 10;

  const enriched = [];
  for (const post of candidates) {
    let gscMetrics = null;
    let topQuery = null;
    if (gsc && post.url) {
      try {
        gscMetrics = await gsc.getPagePerformance(post.url, 90).catch(() => null);
        const pageKws = await gsc.getPageKeywords(post.url, 10, 90).catch(() => []);
        topQuery = pageKws[0] || null;
      } catch (err) {
        console.warn(`    [warn] ${post.slug}: ${err.message}`);
      }
    }

    const meta = loadPostMeta(post.slug);
    const impressions = gscMetrics?.impressions ?? 0;
    const ctr = gscMetrics?.ctr ?? 0;
    const cluster = clusterFor(post);
    const clusterWeight = cluster ? (clusterContext.weights[cluster] || 0) : 0;
    const competitorBoost = cluster ? (clusterContext.boosts[cluster] || 0) : 0;
    const kd = post.kd ?? null;
    const score = scoreOpportunity({ position: post.effectivePos, impressions, ctr, clusterWeight, competitorBoost, kd });

    // Prefer the post's actual title from metadata; fall back to slug prettified.
    const title = meta?.title
      || post.slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    enriched.push({
      slug: post.slug,
      title,
      url: post.url,
      keyword: post.keyword,
      position: post.position,                   // desktop (kept for reference)
      mobile_position: post.mobilePosition,
      effective_position: post.effectivePos,     // revenue-weighted blend, drives score
      device_gap: post.deviceGap,                // mobile_pos - desktop_pos; +ve = mobile trails
      volume: post.volume,
      kd,
      published_at: post.published_at || meta?.published_at,
      gsc: {
        impressions,
        clicks: gscMetrics?.clicks ?? 0,
        ctr: Number(ctr.toFixed(4)),
        gsc_position: gscMetrics?.position != null ? Number(gscMetrics.position.toFixed(1)) : null,
      },
      top_query: topQuery
        ? {
            keyword: topQuery.keyword,
            impressions: topQuery.impressions,
            ctr: Number((topQuery.ctr || 0).toFixed(4)),
            position: topQuery.position != null ? Number(topQuery.position.toFixed(1)) : null,
          }
        : null,
      score,
    });
  }

  // Step 3: Drop posts without meaningful impression signal, then sort by score
  const qualified = enriched.filter((e) => e.gsc.impressions >= MIN_IMPRESSIONS);
  const droppedForNoSignal = enriched.length - qualified.length;
  if (droppedForNoSignal > 0) {
    console.log(`  Dropped ${droppedForNoSignal} post${droppedForNoSignal === 1 ? '' : 's'} with fewer than ${MIN_IMPRESSIONS} impressions (not yet showing GSC signal)`);
  }
  qualified.sort((a, b) => b.score - a.score);
  const top = qualified.slice(0, limitArg);

  console.log(`\n  Top ${top.length} quick-win candidates:`);
  for (const c of top) {
    const kdLabel = c.kd != null ? `, KD ${c.kd}` : '';
    const effLabel = c.effective_position != null && c.effective_position !== c.position
      ? ` (eff #${c.effective_position})` : '';
    console.log(`    [pos ${c.position}${effLabel}] ${c.slug} — ${c.gsc.impressions} impr, ${(c.gsc.ctr * 100).toFixed(1)}% CTR${kdLabel}, score ${c.score}`);
  }

  // Step 4: Write report
  mkdirSync(REPORTS_DIR, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);
  const report = buildMarkdownReport(snap.file, qualified, top);
  writeFileSync(join(REPORTS_DIR, `${dateStr}.md`), report);
  console.log(`\n  Report saved: data/reports/quick-wins/${dateStr}.md`);

  // Step 5: Save machine-readable latest for the daily digest to consume
  writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    snapshot_file: snap.file,
    candidate_count: qualified.length,
    top: top.map((c) => ({
      slug: c.slug,
      title: c.title,
      position: c.position,
      mobile_position: c.mobile_position,
      effective_position: c.effective_position,
      device_gap: c.device_gap,
      impressions: c.gsc.impressions,
      ctr: c.gsc.ctr,
      kd: c.kd,
      score: c.score,
      top_query: c.top_query?.keyword || null,
    })),
  }, null, 2));

  // Step 6: Fire off a notification (deferred to daily digest)
  await notify({
    subject: `Quick-Win Targets: ${top.length} candidates`,
    body: `Top ${top.length} posts at page 2 ready for a rewrite push:\n\n${top.map((c, i) => `${i + 1}. ${c.title} — pos ${c.position}, ${c.gsc.impressions} impressions, ${(c.gsc.ctr * 100).toFixed(1)}% CTR`).join('\n')}`,
    status: 'info',
    category: 'seo',
  }).catch(() => {});

  console.log('\nQuick-win targeting complete.');
}

function buildMarkdownReport(snapshotFile, all, top) {
  const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const lines = [];
  lines.push(`# Quick-Win Targets — ${date}`);
  lines.push('');
  lines.push(`**Snapshot:** \`${snapshotFile}\`  `);
  lines.push(`**Page-2 candidates:** ${all.length}  `);
  lines.push(`**Top picks:** ${top.length}`);
  lines.push('');
  lines.push('Posts ranking at positions 11–20 are the cheapest traffic gains in SEO. A focused rewrite + internal link boost can often push them to page 1 within 2–4 weeks.');
  lines.push('');
  lines.push('## Top Candidates');
  lines.push('');
  lines.push('| # | Slug | Desktop | Mobile | Effective | KD | Impressions | CTR | Top Query | Score |');
  lines.push('|---|------|--------:|-------:|----------:|----|-------------|-----|-----------|-------|');
  top.forEach((c, i) => {
    const topQ = c.top_query ? `${c.top_query.keyword} (pos ${c.top_query.position})` : '—';
    const kdStr = c.kd != null ? String(c.kd) : '—';
    const mob = c.mobile_position != null ? c.mobile_position : '—';
    const eff = c.effective_position != null ? c.effective_position : '—';
    lines.push(`| ${i + 1} | \`${c.slug}\` | ${c.position} | ${mob} | ${eff} | ${kdStr} | ${c.gsc.impressions} | ${(c.gsc.ctr * 100).toFixed(1)}% | ${topQ} | ${c.score} |`);
  });
  lines.push('');
  lines.push('## Recommended Actions');
  lines.push('');
  top.forEach((c, i) => {
    lines.push(`### ${i + 1}. ${c.title}`);
    lines.push(`- **URL:** ${c.url}`);
    lines.push(`- **Current:** Position ${c.position}, ${c.gsc.impressions} impressions over last 90 days, ${(c.gsc.ctr * 100).toFixed(1)}% CTR`);
    if (c.top_query) {
      lines.push(`- **Top query:** "${c.top_query.keyword}" (${c.top_query.impressions} impressions at position ${c.top_query.position})`);
    }
    lines.push(`- **Action:** Refresh content, add internal links from related published posts, verify title/meta target the top query exactly.`);
    lines.push('');
  });
  if (all.length > top.length) {
    lines.push('## Also at Positions 11–20');
    lines.push('');
    all.slice(top.length).forEach((c) => {
      lines.push(`- \`${c.slug}\` — position ${c.position}, ${c.gsc.impressions} impressions, ${(c.gsc.ctr * 100).toFixed(1)}% CTR`);
    });
    lines.push('');
  }

  // Mobile-gap diagnostic: posts where mobile trails desktop by 10+ positions.
  // Different action than content refresh — this is a mobile UX/speed/layout
  // issue. Surfaced even when the post isn't a top-ranked quick-win because
  // shrinking the gap directly unlocks mobile traffic to a page that's
  // already competitive on desktop.
  const mobileGaps = all.filter((c) => (c.device_gap || 0) >= 10).sort((a, b) => b.device_gap - a.device_gap);
  if (mobileGaps.length) {
    lines.push('## Mobile UX Gaps (mobile trails desktop by 10+ positions)');
    lines.push('');
    lines.push('These posts rank well enough on desktop but lose significantly on mobile. The action here is *not* a content refresh — investigate mobile layout, page speed, or rendering (e.g., heavy JS, bad viewport, hidden CTAs).');
    lines.push('');
    lines.push('| Slug | Desktop | Mobile | Gap | Impressions |');
    lines.push('|------|---------|--------|-----|-------------|');
    mobileGaps.forEach((c) => {
      lines.push(`| \`${c.slug}\` | ${c.position} | ${c.mobile_position} | +${c.device_gap} | ${c.gsc.impressions} |`);
    });
    lines.push('');
  }
  return lines.join('\n');
}

main().catch((err) => {
  console.error('Quick-win targeter failed:', err);
  process.exit(1);
});
