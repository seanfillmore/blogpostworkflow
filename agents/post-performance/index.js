#!/usr/bin/env node
/**
 * Post Performance Agent — 30/60/90 Day Review
 *
 * Runs daily. For every published post, checks whether it has crossed a
 * 30/60/90 day milestone and, if so, evaluates whether it's on track. Writes
 * a verdict back into data/posts/<slug>.json under `performance_review` and
 * produces both a per-post review and a daily rollup that the morning digest
 * consumes.
 *
 * Verdicts:
 *   30d — any impressions/clicks at all? If all zero → BLOCKED (or NOT_INDEXED
 *         when indexing-checker says the page is not indexed).
 *   60d — clicks vs what the site's own blog pages earn from the same
 *         impressions at the same rank (lib/peer-yield.js). Well below → REFRESH.
 *   90d — same test, plus LOW_DEMAND when almost nobody searches for or reaches
 *         the page (a merge-or-remove decision for a human).
 *
 * Outputs:
 *   data/reports/post-performance/<slug>-{30d,60d,90d}.md  — per-post review
 *   data/reports/post-performance/YYYY-MM-DD.md            — daily rollup
 *   data/reports/post-performance/latest.json              — action-required
 *                                                             feed for the
 *                                                             daily digest
 *
 * Usage:
 *   node agents/post-performance/index.js           # normal run
 *   node agents/post-performance/index.js --force   # re-run all milestones
 *
 * Cron: daily 6:30 AM PT (after gsc-collector).
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../../lib/notify.js';

import { listAllSlugs, getPostMeta, getMetaPath, writePostMeta, POSTS_DIR, ROOT } from '../../lib/posts.js';
import { isDirectRun } from '../../lib/is-direct-run.js';
import { mayRewriteBody } from '../../lib/post-lock.js';
import { flopAction, countByAction, FLOP_ACTIONS } from '../../lib/flop-candidates.js';
import { judgeYield, peerCtrByBand } from '../../lib/peer-yield.js';
import { CANONICAL_ORIGIN } from '../../lib/gsc-page-url.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const REPORTS_DIR = join(ROOT, 'data', 'reports', 'post-performance');

const MILESTONES = [30, 60, 90];
const FORCE = process.argv.includes('--force');


function ageInDays(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / (24 * 60 * 60 * 1000));
}

/**
 * When a post's review clock starts: the later of its publish date and its last
 * BODY refresh.
 *
 * A 30/60/90-day verdict is a statement about a page. Once the body is replaced
 * that page no longer exists, so the verdict cannot stay "Action Required" —
 * and until 2026-09-21 it did, forever: `all-natural-lotion` was refreshed and
 * republished on 2026-08-30 and still sat on the dashboard three weeks later
 * with its July "0 clicks" verdict. `last_refreshed_at` is stamped by
 * lib/queue-apply.js and refresh-runner; `refreshed_at` by legacy-rebuilder.
 */
export function reviewClockStart(meta) {
  let best = null;
  for (const iso of [meta?.published_at, meta?.last_refreshed_at, meta?.refreshed_at]) {
    const t = iso ? new Date(iso).getTime() : NaN;
    if (!Number.isNaN(t) && (best == null || t > best.t)) best = { iso, t };
  }
  return best ? best.iso : null;
}

/**
 * Split a post's stored reviews into those still describing the current page
 * and those made before the clock restarted. The superseded ones are kept as
 * history, never deleted — "this page flopped, was refreshed, and…" is exactly
 * what someone will want to read six weeks later.
 */
export function supersedeStaleReviews(reviews, clockStart) {
  const start = clockStart ? new Date(clockStart).getTime() : NaN;
  const current = {};
  const superseded = [];
  for (const [key, review] of Object.entries(reviews || {})) {
    const at = review?.reviewed_at ? new Date(review.reviewed_at).getTime() : NaN;
    if (review && review.gsc_basis !== GSC_BASIS) {
      superseded.push({ ...review, superseded_at: new Date().toISOString(), superseded_by: 'basis-change' });
    } else if (!Number.isNaN(start) && !Number.isNaN(at) && at < start) {
      superseded.push({ ...review, superseded_at: new Date().toISOString(), superseded_by: clockStart });
    } else {
      current[key] = review;
    }
  }
  return { current, superseded };
}

/**
 * The post's CURRENT verdict: the most recent milestone reviewed, and only if
 * that one is not ON_TRACK. Every non-ON_TRACK milestone used to be listed, so
 * one post filled up to three rows and a 30-day BLOCKED stayed listed after the
 * same post's 60-day review had come back fine.
 */
export function currentFlop(reviews, milestones = MILESTONES) {
  for (const m of [...milestones].sort((a, b) => b - a)) {
    const r = reviews?.[`${m}d`];
    if (r) return r.verdict !== 'ON_TRACK' ? { milestone: m, review: r } : null;
  }
  return null;
}

const HISTORY_CAP = 12;

/**
 * The basis a review was scored on. A review stamped with any other basis is
 * superseded exactly as a pre-refresh one is, and the milestone re-measured.
 *
 *   (none)                     → queried `meta.shopify_url`, the myshopify host
 *                                 for all 183 posts; an exact GSC page filter on
 *                                 it matches nothing, so every review read 0/0
 *                                 (lib/gsc-page-url.js).
 *   canonical-host-2026-09-21  → real clicks, but judged against the brief's
 *                                 traffic_potential (up to 144,000 clicks), a
 *                                 target no page could meet.
 *   peer-yield-2026-09-21      → judged against what the site's own pages earn
 *                                 from the same demand at the same rank
 *                                 (lib/peer-yield.js).
 */
export const GSC_BASIS = 'peer-yield-2026-09-21';

function listPublishedPosts() {
  const posts = [];
  for (const slug of listAllSlugs()) {
    try {
      const meta = getPostMeta(slug);
      if (!meta) continue;
      if (meta.shopify_status !== 'published') continue;
      if (!meta.published_at) continue;
      if (!meta.shopify_url) continue;
      posts.push({ file: getMetaPath(slug), meta });
    } catch { /* skip */ }
  }
  return posts;
}

async function fetchGscMetrics(pageUrl, days) {
  try {
    const gsc = await import('../../lib/gsc.js');
    const metrics = await gsc.getPagePerformance(pageUrl, days);
    return metrics || { clicks: 0, impressions: 0, ctr: 0, position: null };
  } catch (err) {
    console.warn(`  [warn] GSC unavailable: ${err.message}`);
    return null;
  }
}

/**
 * Evaluate a milestone for a given post.
 * Returns a review object or null if the milestone hasn't been reached.
 */
/**
 * Load cross-agent context (cluster weights, competitor activity, rank alerts).
 * Returns a single object the verdict logic reads to make context-aware calls.
 * See docs/signal-manifest.md — closes gaps where post-performance was making
 * verdict calls without considering external ranking pressure.
 */
function loadExternalContext() {
  const ctx = { clusterWeights: {}, competitorBoosts: {}, rankDrops: new Set(), indexingStateBySlug: {} };

  // Load indexing-checker state per slug so the verdict logic can distinguish
  // "not indexed" (fix indexing) from "indexed but no traffic" (fix content).
  try {
    const idx = JSON.parse(readFileSync(join(ROOT, 'data', 'reports', 'indexing', 'latest.json'), 'utf8'));
    for (const r of (idx.results || [])) {
      if (r.slug && r.state) ctx.indexingStateBySlug[r.slug] = r.state;
    }
  } catch { /* optional */ }

  try {
    const cw = JSON.parse(readFileSync(join(ROOT, 'data', 'reports', 'content-strategist', 'cluster-weights.json'), 'utf8'));
    for (const [name, c] of Object.entries(cw.clusters || {})) ctx.clusterWeights[name] = c.weight || 0;
  } catch { /* optional */ }

  try {
    const comp = JSON.parse(readFileSync(join(ROOT, 'data', 'reports', 'competitor-watcher', 'latest.json'), 'utf8'));
    for (const [name, count] of Object.entries(comp.cluster_boosts || {})) ctx.competitorBoosts[name] = count;
  } catch { /* optional */ }

  // Rank alerts: posts with sudden ranking drops in the last 7 days get an
  // automatic off-cycle review regardless of milestone.
  try {
    const alertsDir = join(ROOT, 'data', 'reports', 'rank-alerts');
    if (existsSync(alertsDir)) {
      const files = readdirSync(alertsDir).filter((f) => f.endsWith('.md')).sort().reverse().slice(0, 7);
      for (const f of files) {
        const content = readFileSync(join(alertsDir, f), 'utf8');
        // Extract slugs from lines mentioning a drop
        for (const line of content.split('\n')) {
          if (!/🔻|dropped|fell/i.test(line)) continue;
          const slugMatch = line.match(/\/blogs\/news\/([a-z0-9-]+)/);
          if (slugMatch) ctx.rankDrops.add(slugMatch[1]);
        }
      }
    }
  } catch { /* optional */ }

  return ctx;
}

/**
 * 30d: zero impressions → BLOCKED (or NOT_INDEXED when indexing-checker says so).
 * 60d/90d: judged against the site's own peers on the page's own demand
 * (lib/peer-yield.js) — REFRESH when it earns well below them; at 90d also
 * LOW_DEMAND when almost nobody searches for or reaches it.
 */
export function evaluateMilestone({ milestone, age, metrics, slug, externalCtx, bandCtr }) {
  if (age < milestone) return null;

  const impressions = metrics?.impressions ?? 0;
  const clicks = metrics?.clicks ?? 0;
  let verdict = 'ON_TRACK';
  let reason = '';
  let projection = null;

  if (milestone === 30) {
    if (impressions === 0 && clicks === 0) {
      // A NOT_INDEXED verdict is a different root cause with a different fix, so
      // it is split out when indexing-checker has already said so.
      const idxState = externalCtx?.indexingStateBySlug?.[slug];
      if (idxState && idxState !== 'indexed') {
        verdict = 'NOT_INDEXED';
        reason = `Zero impressions and zero clicks after 30 days because the page is not indexed (state: ${idxState}). Refreshing content will not help — fix indexing first.`;
      } else {
        verdict = 'BLOCKED';
        reason = 'Zero impressions and zero clicks after 30 days — nobody is searching for what this page targets, or it is not indexed.';
      }
    } else {
      reason = `Indexed. ${impressions} impressions, ${clicks} clicks over the last 30 days.`;
    }
  } else {
    const judged = judgeYield(metrics, bandCtr, { days: milestone, judgeLowDemand: milestone === 90 });
    projection = judged.expected != null ? Math.round(judged.expected * 10) / 10 : null;
    reason = judged.why;
    if (judged.verdict === 'REFRESH' || judged.verdict === 'LOW_DEMAND') verdict = judged.verdict;
  }

  return {
    milestone,
    reviewed_at: new Date().toISOString(),
    age_days: age,
    impressions,
    clicks,
    ctr: metrics?.ctr ?? 0,
    position: metrics?.position ?? null,
    projection,
    verdict,
    reason,
    gsc_basis: GSC_BASIS,
  };
}

/**
 * The site's blog CTR per position band over the trailing window, from GSC's
 * own page rows. Only the canonical www host — the host every per-page lookup
 * now queries (lib/gsc-page-url.js) — so page and peers share one basis; GSC
 * also returns tiny apex-domain duplicates that would otherwise be mixed in.
 */
async function loadPeerBandCtr(days) {
  try {
    const gsc = await import('../../lib/gsc.js');
    const rows = (await gsc.getTopPages(5000, days))
      .filter((r) => r.page.startsWith(`${CANONICAL_ORIGIN}/blogs/news/`));
    return { bandCtr: peerCtrByBand(rows), pages: rows.length };
  } catch (err) {
    console.warn(`  [warn] peer CTR unavailable for ${days}d: ${err.message}`);
    return null;
  }
}

function writePerPostReview({ slug, title, url, review }) {
  const path = join(REPORTS_DIR, `${slug}-${review.milestone}d.md`);
  const lines = [
    `# ${review.milestone}-Day Review — ${title || slug}`,
    '',
    `**URL:** ${url}  `,
    `**Slug:** \`${slug}\`  `,
    `**Reviewed:** ${review.reviewed_at.slice(0, 10)}  `,
    `**Post age:** ${review.age_days} days`,
    '',
    `## Verdict: ${review.verdict}`,
    '',
    review.reason,
    '',
    '## GSC metrics (last ' + review.milestone + ' days)',
    '',
    `- Impressions: ${review.impressions}`,
    `- Clicks: ${review.clicks}`,
    `- CTR: ${(review.ctr * 100).toFixed(2)}%`,
    `- Avg position: ${review.position != null ? review.position.toFixed(1) : 'n/a'}`,
    review.projection != null ? `- Expected clicks (site peers, same demand and rank): ${review.projection}` : '',
    '',
  ].filter(Boolean);
  writeFileSync(path, lines.join('\n'));
}

function writeDailyRollup({ dateStr, reviews }) {
  const path = join(REPORTS_DIR, `${dateStr}.md`);
  const lines = [];
  lines.push(`# Post Performance — ${dateStr}`);
  lines.push('');
  if (reviews.length === 0) {
    lines.push('No posts crossed a 30/60/90 day milestone today.');
    writeFileSync(path, lines.join('\n'));
    return;
  }
  lines.push(`${reviews.length} review${reviews.length > 1 ? 's' : ''} generated today.`);
  lines.push('');
  lines.push('| Slug | Milestone | Verdict | Clicks | Impressions | Expected |');
  lines.push('|------|-----------|---------|--------|-------------|------------|');
  for (const r of reviews) {
    lines.push(`| \`${r.slug}\` | ${r.review.milestone}d | ${r.review.verdict} | ${r.review.clicks} | ${r.review.impressions} | ${r.review.projection ?? '—'} |`);
  }
  lines.push('');
  const flops = reviews.filter((r) => r.review.verdict !== 'ON_TRACK');
  if (flops.length) {
    lines.push('## Action Required');
    lines.push('');
    for (const r of flops) {
      lines.push(`### ${r.title || r.slug} — ${r.review.verdict} (${r.review.milestone}d)`);
      lines.push(r.review.reason);
      lines.push('');
      lines.push(`See \`data/reports/post-performance/${r.slug}-${r.review.milestone}d.md\``);
      lines.push('');
    }
  }
  writeFileSync(path, lines.join('\n'));
}

async function main() {
  console.log('\nPost Performance Agent (30/60/90 day review)\n');

  mkdirSync(REPORTS_DIR, { recursive: true });

  const posts = listPublishedPosts();
  console.log(`  Published posts: ${posts.length}`);

  const externalCtx = loadExternalContext();
  const ctxNotes = [];
  const weightedClusters = Object.keys(externalCtx.clusterWeights).filter((n) => externalCtx.clusterWeights[n] !== 0);
  if (weightedClusters.length) ctxNotes.push(`${weightedClusters.length} weighted clusters`);
  if (Object.keys(externalCtx.competitorBoosts).length) ctxNotes.push(`${Object.keys(externalCtx.competitorBoosts).length} competitor-active clusters`);
  if (externalCtx.rankDrops.size) ctxNotes.push(`${externalCtx.rankDrops.size} recent rank drops`);
  if (ctxNotes.length) console.log(`  External context loaded: ${ctxNotes.join(', ')}`);

  // Peer CTR per band for each judged window, fetched once. A window whose peer
  // data cannot be read is skipped this run rather than judged on nothing.
  const peerByDays = {};
  for (const days of MILESTONES.filter((m) => m > 30)) {
    const peer = await loadPeerBandCtr(days);
    if (peer) {
      peerByDays[days] = peer.bandCtr;
      console.log(`  Peer CTR (${days}d, ${peer.pages} blog pages): ${Object.entries(peer.bandCtr).map(([b, c]) => `${b} ${(c * 100).toFixed(2)}%`).join(' · ')}`);
    }
  }

  const todayReviews = []; // reviews produced this run
  const allFlops = [];      // any outstanding flops across all posts

  let supersededCount = 0;
  for (const { file, meta } of posts) {
    const clockStart = reviewClockStart(meta);
    const { current: existing, superseded } = supersedeStaleReviews(meta.performance_review, clockStart);
    let history = null;
    if (superseded.length) {
      history = [...(meta.performance_review_history || []), ...superseded].slice(-HISTORY_CAP);
      supersededCount += superseded.length;
      console.log(`  [reset] ${meta.slug}: ${superseded.length} earlier verdict(s) superseded (${[...new Set(superseded.map((r) => (r.superseded_by === 'basis-change' ? 'scored on an older basis' : 'body refreshed')))].join(', ')}).`);
    }

    const age = ageInDays(clockStart);
    if (age == null || age < MILESTONES[0]) {
      if (history) writePostMeta(meta.slug, { performance_review: existing, performance_review_history: history });
      continue;
    }

    let metricsByDays = {};
    let updated = Boolean(history);

    for (const milestone of MILESTONES) {
      if (age < milestone) continue;
      const key = `${milestone}d`;
      if (existing[key] && !FORCE) continue; // already reviewed

      // Fetch metrics for this milestone window (lazy, only when needed)
      if (!metricsByDays[milestone]) {
        metricsByDays[milestone] = await fetchGscMetrics(meta.shopify_url, milestone);
      }
      const metrics = metricsByDays[milestone];
      if (!metrics) continue; // GSC unavailable — skip this run
      if (milestone > 30 && !peerByDays[milestone]) continue; // no peers — judge next run

      const review = evaluateMilestone({
        milestone, age, metrics,
        slug: meta.slug,
        externalCtx,
        bandCtr: peerByDays[milestone],
      });
      if (!review) continue;

      existing[key] = review;
      updated = true;

      writePerPostReview({
        slug: meta.slug,
        title: meta.title,
        url: meta.shopify_url,
        review,
      });

      todayReviews.push({ slug: meta.slug, title: meta.title, review });
      console.log(`  [${review.verdict}] ${meta.slug} @${milestone}d — ${review.clicks} clicks, ${review.impressions} impressions`);
    }

    if (updated) {
      meta.performance_review = existing;
      // MERGE through the chokepoint — never write the raw path back.
      // `meta` here came from getPostMeta(), which returns meta.json AND
      // state.json merged, so writing it back raw put every server-owned field
      // (word_count, tokens_used, shopify_article_id, …) into the git-TRACKED
      // meta.json. That is the deploy collision PR #737 split the files to end,
      // and this agent re-created it on 24 posts in two days, once per 13:30 run.
      writePostMeta(meta.slug, history
        ? { performance_review: existing, performance_review_history: history }
        : { performance_review: existing });
    }

    // One row per post: its CURRENT verdict (see currentFlop).
    const flop = currentFlop(existing);
    if (flop) {
      allFlops.push({
        slug: meta.slug,
        title: meta.title,
        url: meta.shopify_url,
        milestone: flop.milestone,
        verdict: flop.review.verdict,
        reason: flop.review.reason,
        reviewed_at: flop.review.reviewed_at,
        clock_start: clockStart,
      });
      const row = allFlops[allFlops.length - 1];
      row.action = flopAction(row, { mayRewriteBody });
      // Carried on the row so the dashboard and digest render one vocabulary
      // without a browser-side copy of it.
      row.action_label = FLOP_ACTIONS[row.action].label;
      row.automated = FLOP_ACTIONS[row.action].automated;
    }
  }

  const dateStr = new Date().toISOString().slice(0, 10);
  writeDailyRollup({ dateStr, reviews: todayReviews });

  // latest.json powers the morning digest's "Action Required — Flops" section
  writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    reviews_today: todayReviews.length,
    // What happens next to each flop — see FLOP_ACTIONS in lib/flop-candidates.js.
    by_action: countByAction(allFlops),
    action_required: allFlops,
  }, null, 2));

  if (supersededCount) console.log(`\n  ${supersededCount} verdict(s) superseded (older basis or body refresh).`);
  console.log(`\n  ${todayReviews.length} new review${todayReviews.length === 1 ? '' : 's'} this run, ${allFlops.length} outstanding flop${allFlops.length === 1 ? '' : 's'}.`);

  if (todayReviews.length > 0) {
    const flopsToday = todayReviews.filter((r) => r.review.verdict !== 'ON_TRACK');
    await notify({
      subject: `Post Performance: ${todayReviews.length} review${todayReviews.length === 1 ? '' : 's'}${flopsToday.length ? `, ${flopsToday.length} flop${flopsToday.length === 1 ? '' : 's'}` : ''}`,
      body: todayReviews.map((r) => `${r.review.milestone}d [${r.review.verdict}] ${r.slug}: ${r.review.reason}`).join('\n'),
      // A review VERDICT, not an agent failure — a flop is this agent working.
      // It belongs in the digest body a human reads, not in the Failures block
      // beside a crashed subprocess.
      status: 'info',
      category: 'seo',
    }).catch(() => {});
  }

  console.log('\nPost performance review complete.');
}

// Guarded: importing this module must not run the agent (live writes, paid
// API calls, process.exit). See lib/is-direct-run.js.
if (isDirectRun(import.meta.url)) {
  main().catch((err) => {
    console.error('Post performance agent failed:', err);
    process.exit(1);
  });
}
