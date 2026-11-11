/**
 * Daily Summary Agent
 *
 * Sends one consolidated morning digest email at 5 AM PST with everything
 * that happened the previous day. Non-error notifications are deferred here
 * by lib/notify.js automatically.
 *
 * Sections:
 *   1. Content Pipeline — posts written, edited, published, images generated
 *   2. Pipeline Images — thumbnail links for all images generated yesterday
 *   3. Ads & Campaigns — optimizer suggestions, campaign alerts, weekly recap
 *   4. SEO & Rankings — rank alerts, rank tracker, insights
 *   5. Errors — anything that failed (collectors, agents, etc.)
 *
 * Collector/snapshot successes are suppressed — only shown if they failed.
 *
 * REVIEWED RECAP (2026-11-11). When agents/recap-reviewer has written today's
 * --apply report and done.json, the email renders from it instead: What's
 * working (incl. "Fixed overnight"), How to grow, Still being worked on, and
 * One thing only you can do. The recap waits up to 30 minutes for done.json
 * (--preview never waits). A missing, stale, crashed or dry-run review falls
 * back to the old email under FALLBACK_BANNER; it never reads as an all-clear.
 * After a send that rendered the review, the report is stamped emailed_at; the
 * next morning, any outcome in yesterday's report that finished after that
 * (or all of them, if no email rendered it) shows as "Finished after
 * yesterday's email". Info rows only Sean can act on (ONLY_YOU_SOURCES, or a
 * subject saying it waits on a human) render under One thing only you can do.
 *
 * Usage:
 *   node agents/daily-summary/index.js
 *   node agents/daily-summary/index.js --date 2026-04-03  (specific date)
 *
 * Cron (server) — 5:00 AM PST (13:00 UTC):
 *   0 13 * * * cd ~/seo-claude && node agents/daily-summary/index.js >> data/logs/daily-summary.log 2>&1
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendHtmlEmail, notify } from '../../lib/notify.js';
import { execSync } from 'node:child_process';
import { dropRecoveredFailures } from '../../lib/digest-recovery.js';
import { rowsInWindow, daysBetween } from '../../lib/digest-window.js';
import { renderCreatorReviewSection, awaitingSubmissions } from '../../lib/digest-creator-review.js';
import { checkFreshness, problems, newestSnapshotDate, newestReportDate } from '../../lib/snapshot-health.js';
import { SEO_IMPACT_MAX_AGE_DAYS } from '../../lib/seo-impact-freshness.js';
// The A/B dead-band and its classifier come from the module that OWNS the
// decision. Never re-declare 0.005 here — same single-source rule as
// AWARENESS_LEVELS and HEALTH_CLAIM_PATTERNS.
import { classifyCtrDelta, DEFAULT_REGRESS_THRESHOLD } from '../../lib/meta-ab-decision.js';
import {
  buildReviewItems, classifyRows, itemKey, isReviewedProblem, recoveredBy,
} from '../../lib/recap-review.js';
import { parseCrontab, isRerunnable, splitCommand } from '../../lib/recap-jobs.js';
import { isPermanentSkip } from '../../lib/low-demand-removal.js';
import { loadState as loadReviewerState, REVIEWER_DIR } from '../../lib/recap-reviewer-state.js';
// lib/llm-usage.js still meters every call; the digest just no longer renders a
// dollar row from it. See the LLM cost block removal note below.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const DAILY_SUMMARY_DIR = join(ROOT, 'data', 'reports', 'daily-summary');

// How many failure rows the digest renders in full. The count in the heading is
// always the true total — see the errorsSection builder.
const ERROR_ROWS_SHOWN = 8;

import {
  listAllSlugs, getPostMeta, getEditorReportPath, POSTS_DIR,
} from '../../lib/posts.js';
import { classifyBlockedReport } from '../../lib/blocked-posts.js';
import { freezeFollowupsDue } from '../../lib/post-edit-gate.js';

// Collector/snapshot agents — suppress their success entries from the digest
const SILENT_ON_SUCCESS = new Set([
  'clarity', 'shopify', 'gsc', 'ga4', 'google-ads', 'google ads',
  'blog-index', 'blog index', 'topical map', 'topical-map',
  'insight aggregator', 'insight-aggregator',
  'meta a/b', 'meta-ab',
]);

// The cron entry already redirects stdout into data/logs/daily-summary.log, so
// also appending there duplicated every line in the file and made a single run
// read as if the digest had been sent twice. Write to stdout only, and let the
// redirect own the file — the same contract every other agent in cron uses.
// When there is no redirect (interactive run), stdout is a TTY and nothing is
// lost; the operator sees the output directly.
export function log(msg, out = console.log) {
  out(`[${new Date().toISOString()}] ${msg}`);
}

function loadEnv() {
  try {
    return Object.fromEntries(
      readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
        .filter(l => l.includes('=') && !l.trim().startsWith('#'))
        .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
    );
  } catch { return {}; }
}

/**
 * Categorize a digest entry based on its subject line.
 */
function categorize(entry) {
  const s = (entry.subject || '').toLowerCase();
  const cat = (entry.category || '').toLowerCase();

  if (cat) return cat;

  // Pipeline
  if (s.includes('brief') || s.includes('scheduler') || s.includes('pipeline')
      || s.includes('published') || s.includes('writer') || s.includes('editor')
      || s.includes('image gen')) return 'pipeline';

  // Ads
  if (s.includes('google ads') || s.includes('ads ') || s.includes('campaign')
      || s.includes('ads—') || s.includes('ads —') || s.includes('weekly')) return 'ads';

  // SEO
  if (s.includes('rank') || s.includes('dataforseo') || s.includes('seo report')) return 'seo';

  // Collectors
  if (s.includes('collector') || s.includes('clarity') || s.includes('shopify')
      || s.includes('gsc') || s.includes('ga4')) return 'collector';

  return 'other';
}

/**
 * Check if an entry is a silent collector success that should be suppressed.
 */
function isSilentSuccess(entry) {
  if (entry.status === 'error') return false;
  const s = (entry.subject || '').toLowerCase();
  for (const keyword of SILENT_ON_SUCCESS) {
    if (s.includes(keyword)) return true;
  }
  return false;
}

/**
 * Find posts that are hard-blocked in the editorial gate and need a HUMAN.
 *
 * "Action Required — N posts hard-blocked" ran every morning for three pages
 * that all return HTTP 200. They were live legacy posts carrying a stale
 * `Needs Work` report; the old skip rule here (`shopify_status === 'published'
 * || 'scheduled'`) could never fire on them, because 52 of 93 posts have a
 * `shopify_article_id` and no `shopify_status` key at all — the corpus synced in
 * without ever passing through agents/publisher.
 *
 * Two things fix that, and they are different fixes:
 *   - The rule now lives in lib/blocked-posts.js and resolves publish state via
 *     lib/post-publish-state.js, so an inferred-live post is recognised as live.
 *   - `includeLive: false`: a LIVE page is never an "Action Required" row in the
 *     email. agents/blocked-post-resolver owns repairing those, unattended, and
 *     reports its own outcome into this same digest. The dashboard still shows
 *     them (it passes includeLive: true) — visibility without a daily alarm.
 */
export function findBlockedPosts() {
  const blocked = [];

  for (const slug of listAllSlugs()) {
    try {
      const reportPath = getEditorReportPath(slug);
      if (!existsSync(reportPath)) continue;

      const report = readFileSync(reportPath, 'utf8');
      const meta = getPostMeta(slug);
      if (!meta) continue;

      let reportAgeDays = Infinity;
      try { reportAgeDays = (Date.now() - statSync(reportPath).mtimeMs) / 86400000; } catch { /* keep Infinity */ }

      const verdict = classifyBlockedReport({ report, meta, reportAgeDays, includeLive: false });
      if (!verdict) continue;

      blocked.push({
        title: meta.title || slug,
        slug,
        blockers: verdict.blockerText,
        reportPath: `data/posts/${slug}/editor-report.md`,
      });
    } catch { /* skip */ }
  }

  return blocked;
}

/**
 * Find all pipeline images generated on the target date.
 * Scans data/posts/*.json for image_generated_at matching the date.
 */
function findPipelineImages(targetDate) {
  const images = [];

  for (const slug of listAllSlugs()) {
    try {
      const meta = getPostMeta(slug);
      if (!meta) continue;
      const genDate = (meta.image_generated_at || '').slice(0, 10);
      if (genDate !== targetDate) continue;

      images.push({
        title: meta.title || meta.slug || slug,
        slug: meta.slug || slug,
        imageUrl: meta.shopify_image_url || null,
        imagePath: meta.image_path || null,
        status: meta.shopify_status || 'unknown',
      });
    } catch { /* skip unreadable files */ }
  }

  return images;
}

/**
 * Load the latest quick-win targets (produced by quick-win-targeter agent).
 * Returns { generated_at, candidate_count, top } or null if unavailable.
 */
function loadQuickWinTargets() {
  const path = join(ROOT, 'data', 'reports', 'quick-wins', 'latest.json');
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function loadSeoImpact() {
  const path = join(ROOT, 'data', 'reports', 'seo-impact', 'latest.json');
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function loadPrioritizer() {
  const path = join(ROOT, 'data', 'reports', 'pipeline-prioritizer', 'latest.json');
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * Load the latest post-performance review output (produced by post-performance agent).
 * Returns { reviews_today, action_required } or null if unavailable.
 */
function loadPostPerformance() {
  const path = join(ROOT, 'data', 'reports', 'post-performance', 'latest.json');
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/**
 * Load latest GSC opportunity output (produced by gsc-opportunity agent).
 */
function loadGscOpportunities() {
  const path = join(ROOT, 'data', 'reports', 'gsc-opportunity', 'latest.json');
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function loadCompetitorActivity() {
  const path = join(ROOT, 'data', 'reports', 'competitor-watcher', 'latest.json');
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// The digest deliberately does NOT read data/performance-queue/.
//
// It used to: `loadPerformanceQueue()` returned every `status: 'pending'` item
// and the digest rendered them as an indigo "N items ready for review" block
// headed "Approve on the dashboard to push the updated content to Shopify".
//
// `agents/queue-autoapply` took that chore over — it runs daily with --apply as
// scheduler step 4d and drains the queue unattended — but the block was never
// removed, and the cron clock makes it a guaranteed false alarm:
//
//   07:30 UTC  performance-engine   FILLS the queue
//   13:00 UTC  daily-summary        READ it and emailed it as a to-do list
//   15:00 UTC  queue-autoapply      DRAINS it, no human involved
//
// So the email showed work a robot finished two hours later, every morning,
// forever. Measured on production 2026-09-18, the five rows that day were one
// phantom (a post consolidated away, re-queued nightly and dismissed the same
// afternoon), three on the self-clearing 30-day cooldown, and one genuinely
// parked item the block gave no distinguishing treatment.
//
// Sean, verbatim: "I don't want to see the optimization queue. That should be
// handled automatically and should never surface as a manual task."
//
// What the queue DID is still reported: queue-autoapply fires its own deferred
// notify() every run. An item automation can never clear (gate_attempts >= 3,
// an unrecognised schema, a trigger outside AUTO_APPLY_TRIGGERS) is a gap in
// the AUTOMATION and belongs in a health/ops row, not in a review queue —
// see tests/agents/daily-summary.test.js, which pins that this block stays gone.

/**
 * Build the HTML email body.
 */
/**
 * Build a clean, bounded preview of a notification body for the email digest.
 * Collapses runs of blank lines, then truncates to whole lines (and a char cap),
 * appending an ellipsis when cut. Truncating server-side to complete lines is
 * what prevents mobile clients from rendering a half-cut line — the old approach
 * relied on a fixed-pixel CSS max-height, which clipped mid-line on small screens.
 */
export function previewBody(body, { maxLines = 8, maxChars = 600 } = {}) {
  if (!body) return '';
  const collapsed = String(body)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !/^\s*([-*_])\1{2,}\s*$/.test(l)) // drop markdown horizontal rules (---, ***, ___)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const lines = collapsed.split('\n');
  let text = lines.slice(0, maxLines).join('\n');
  let truncated = lines.length > maxLines;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  if (truncated) text = text.replace(/\s+$/, '') + ' …';
  return text;
}

/**
 * Convert the light markdown agents emit into clean inline HTML for the digest.
 * Escapes first (these bodies are agent-generated but we never trust raw HTML),
 * then renders headings/bold as <strong>, list markers as bullets. Returns text
 * with newlines preserved — the caller renders inside white-space:pre-wrap, so
 * line breaks need no <br>. Block markdown (code fences, tables) is left as-is.
 */
export function formatBodyHtml(text) {
  if (!text) return '';
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return String(text).split('\n').map((raw) => {
    let line = raw;
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (heading) line = heading[1];
    let bullet = false;
    if (!heading) {
      const b = line.match(/^\s*[-*+]\s+(.*)$/);
      if (b) { line = b[1]; bullet = true; }
    }
    let out = esc(line)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>') // **bold** → <strong>
      .replace(/\*\*/g, '');                               // drop any stray unmatched **
    if (heading) out = `<strong>${out}</strong>`;
    if (bullet) out = `• ${out}`;
    return out;
  }).join('\n');
}

/**
 * `dataRoot` exists because this function reads five paths off disk in addition to
 * its twelve injected arguments. That made its output machine-dependent: the same
 * inputs produced a "quiet day" digest on a laptop with no data/reports and a full
 * one on the server, so a test asserting the quiet path passed locally and failed in
 * production. Defaulting to ROOT keeps every caller unchanged.
 */
export function buildDigestHtml(targetDate, entries, pipelineImages, blockedPosts, quickWins, postPerformance, gscOpps, competitors, dashboardUrl, healthIssues = [], seoImpact = null, prioritizer = null, { dataRoot = ROOT, lateFinished = [] } = {}, review = undefined) {
  const esc = s => (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Filter out silent successes
  const visible = entries.filter(e => !isSilentSuccess(e));

  // Group by category
  const groups = { pipeline: [], ads: [], seo: [], other: [] };
  for (const entry of visible) {
    const cat = categorize(entry);
    if (groups[cat]) groups[cat].push(entry);
    else groups.other.push(entry);
  }

  // Count suppressed
  const suppressed = entries.length - visible.length;

  const styles = `
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 640px; margin: 0 auto; padding: 16px; color: #1a1a1a; background: #f9fafb; }
    h1 { font-size: 20px; margin: 0 0 4px 0; }
    .date { color: #6b7280; font-size: 14px; margin-bottom: 20px; }
    .section { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .section-title { font-size: 15px; font-weight: 600; color: #374151; margin: 0 0 12px 0; border-bottom: 1px solid #f3f4f6; padding-bottom: 8px; }
    .entry { margin-bottom: 10px; font-size: 13px; }
    .entry-subject { font-weight: 500; }
    .entry-time { color: #9ca3af; font-size: 12px; }
    .entry-body { color: #6b7280; font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: break-word; word-break: break-word; margin-top: 2px; }
    .image-grid { display: flex; flex-wrap: wrap; gap: 12px; }
    .image-card { text-align: center; width: 140px; }
    .image-card img { width: 140px; height: 79px; object-fit: cover; border-radius: 6px; border: 1px solid #e5e7eb; }
    .image-card .label { font-size: 11px; color: #374151; margin-top: 4px; line-height: 1.3; }
    .status-badge { font-size: 10px; padding: 1px 6px; border-radius: 10px; }
    .status-scheduled { background: #dbeafe; color: #1d4ed8; }
    .status-draft { background: #fef3c7; color: #92400e; }
    .status-active { background: #d1fae5; color: #065f46; }
    .empty { color: #9ca3af; font-style: italic; font-size: 13px; }
    .footer { color: #9ca3af; font-size: 12px; margin-top: 16px; text-align: center; }
    .action-required { background: #fef2f2; border: 2px solid #fecaca; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .action-required .section-title { color: #991b1b; border-bottom-color: #fecaca; }
    .blocked-post { background: #fff; border: 1px solid #fecaca; border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; }
    .blocked-post .title { font-size: 13px; font-weight: 600; color: #1f2937; margin-bottom: 4px; }
    .blocked-post .blockers { font-size: 12px; color: #6b7280; white-space: pre-wrap; line-height: 1.4; }
    .blocked-post .report-link { font-size: 11px; color: #991b1b; margin-top: 6px; font-family: monospace; }
    .quick-wins { background: #f0fdf4; border-color: #bbf7d0; }
    .quick-wins .section-title { color: #166534; border-bottom-color: #bbf7d0; }
    .quick-win-row { display: flex; gap: 10px; padding: 8px 0; border-bottom: 1px solid #f3f4f6; font-size: 13px; }
    .quick-win-row:last-child { border-bottom: none; }
    .qw-rank { font-weight: 600; color: #166534; min-width: 20px; }
    .qw-title { font-weight: 500; color: #1f2937; }
    .qw-meta { font-size: 11px; color: #6b7280; margin-top: 2px; }
  `;

  const formatTime = (ts) => {
    try {
      return new Date(ts).toLocaleTimeString('en-US', {
        timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', hour12: true,
      });
    } catch { return ''; }
  };

  const renderEntries = (items) => {
    if (!items.length) return '<p class="empty">Nothing to report.</p>';
    return items.map(e => {
      const icon = e.status === 'success' ? '&#9989;' : e.status === 'error' ? '&#10060;' : '&#8505;&#65039;';
      const bodyPreview = e.body ? `<div class="entry-body">${formatBodyHtml(previewBody(e.body))}</div>` : '';
      return `<div class="entry">
        <div><span>${icon}</span> <span class="entry-subject">${esc(e.subject)}</span> <span class="entry-time">${formatTime(e.ts)}</span></div>
        ${bodyPreview}
      </div>`;
    }).join('');
  };

  // Build image section
  let imageSection = '';
  if (pipelineImages.length > 0) {
    const imageCards = pipelineImages.map(img => {
      const src = img.imageUrl || '';
      const statusClass = img.status === 'scheduled' ? 'status-scheduled'
        : img.status === 'active' ? 'status-active' : 'status-draft';
      const imgTag = src
        ? `<a href="${esc(src)}" target="_blank"><img src="${esc(src)}" alt="${esc(img.title)}" /></a>`
        : `<div style="width:140px;height:79px;background:#f3f4f6;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#9ca3af;">No CDN URL</div>`;
      return `<div class="image-card">
        ${imgTag}
        <div class="label">${esc(img.title)}</div>
        <span class="status-badge ${statusClass}">${esc(img.status)}</span>
      </div>`;
    }).join('');

    imageSection = `
      <div class="section">
        <div class="section-title">Pipeline Images (${pipelineImages.length})</div>
        <div class="image-grid">${imageCards}</div>
      </div>`;
  }

  // Build sections
  const pipelineSection = groups.pipeline.length > 0
    ? `<div class="section"><div class="section-title">Content Pipeline</div>${renderEntries(groups.pipeline)}</div>` : '';

  const adsSection = groups.ads.length > 0
    ? `<div class="section"><div class="section-title">Ads &amp; Campaigns</div>${renderEntries(groups.ads)}</div>` : '';

  const seoSection = groups.seo.length > 0
    ? `<div class="section"><div class="section-title">SEO &amp; Rankings</div>${renderEntries(groups.seo)}</div>` : '';

  const otherSection = groups.other.length > 0
    ? `<div class="section"><div class="section-title">Other</div>${renderEntries(groups.other)}</div>` : '';

  // AI Citation summary (weekly — show if report exists and < 8 days old)
  let aiCitationSection = '';
  try {
    const citPath = join(dataRoot, 'data', 'reports', 'ai-citations', 'latest.json');
    if (existsSync(citPath)) {
      const cit = JSON.parse(readFileSync(citPath, 'utf8'));
      const age = (Date.now() - new Date(cit.date).getTime()) / (1000 * 60 * 60 * 24);
      if (age < 8) {
        const totalResponses = cit.prompts_run * cit.sources.length;
        const mentioned = cit.results.filter(r => Object.values(r.responses).some(resp => resp.cited || resp.mentioned)).length;
        const topComp = Object.entries(cit.summary.top_competitor_mentions || {}).sort((a, b) => b[1] - a[1])[0];
        aiCitationSection = `<div class="section"><div class="section-title">&#129302; AI Citations</div>` +
          `<p>Mentioned in <strong>${mentioned}</strong> of ${totalResponses} LLM responses across ${cit.sources.length} sources.</p>` +
          (topComp ? `<p>Top competitor: <strong>${topComp[0]}</strong> (${topComp[1]} mentions)</p>` : '') +
          `</div>`;
      }
    }
  } catch { /* skip */ }

  // Blocked posts (hard-blocked in editorial gate — surfaced at the top as Action Required)
  let blockedSection = '';
  if (blockedPosts && blockedPosts.length > 0) {
    const cards = blockedPosts.map(p => `
      <div class="blocked-post">
        <div class="title">${esc(p.title)}</div>
        <div class="blockers">${esc(p.blockers)}</div>
        <div class="report-link">${esc(p.reportPath)}</div>
      </div>`).join('');
    blockedSection = `
      <div class="action-required">
        <div class="section-title">&#9888;&#65039; Action Required — ${blockedPosts.length} post${blockedPosts.length > 1 ? 's' : ''} hard-blocked</div>
        <p style="font-size:12px;color:#6b7280;margin:0 0 12px 0;">These posts failed the editorial gate and cannot be auto-published. Resolve the blockers below or reply to this email for guidance.</p>
        ${cards}
      </div>`;
  }

  // Quick-win targets (posts at positions 11-20 ready for a rewrite push)
  let quickWinSection = '';
  if (quickWins && quickWins.top && quickWins.top.length > 0) {
    const rows = quickWins.top.slice(0, 5).map((c, i) => `
      <div class="quick-win-row">
        <div class="qw-rank">${i + 1}.</div>
        <div class="qw-body">
          <div class="qw-title">${esc(c.title || c.slug)}</div>
          <div class="qw-meta">Position ${c.position} &middot; ${c.impressions.toLocaleString('en-US')} impressions &middot; ${(c.ctr * 100).toFixed(1)}% CTR${c.top_query ? ` &middot; top query: "${esc(c.top_query)}"` : ''}</div>
        </div>
      </div>`).join('');
    quickWinSection = `
      <div class="section quick-wins">
        <div class="section-title">&#128640; Quick-Win Targets (${quickWins.candidate_count} at page 2)</div>
        <p style="font-size:12px;color:#6b7280;margin:0 0 12px 0;">These posts are ranking at positions 11&ndash;20 &mdash; the cheapest traffic gains available. A rewrite + internal links can push them to page 1.</p>
        ${rows}
      </div>`;
  }

  // SEO Impact — "what's working": organic revenue by page/cluster (the feedback loop)
  let seoImpactSection = '';
  if (seoImpact && seoImpact.totals) {
    const t = seoImpact.totals;
    const win = seoImpact.window || {};
    const windowDays = (win.start && win.end)
      ? Math.round((Date.parse(win.end) - Date.parse(win.start)) / 86400000) + 1 : 28;
    const money = (n) => `$${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`;
    const d = t.organic_revenue_delta || 0;
    const deltaStr = `${d >= 0 ? '+' : '−'}${money(Math.abs(d))}`;
    const deltaColor = d >= 0 ? '#166534' : '#991b1b';
    const topPages = (seoImpact.top_revenue || []).slice(0, 5).map((r) =>
      `<div class="quick-win-row"><div class="qw-body"><div class="qw-title">${money(r.revenue)} &mdash; ${esc(r.path)}</div><div class="qw-meta">${r.conversions} conversions &middot; ${r.sessions} organic sessions${r.action ? ` &middot; ${esc(r.action.type)} ${esc(r.action.date)}` : ''}</div></div></div>`).join('');
    // "By cluster" names a CATEGORY, so it prints what that category sold — from
    // order line items — not what landed on pages named after it. The entry-page
    // figure is still in the report and still drives every $0-cluster decision;
    // it just cannot be printed beside a category's name without saying so.
    // Reports written before this field existed fall back to the old alias.
    const clustersHaveProduct = (seoImpact.clusters || []).some((c) => c.product_revenue_all_channels != null);
    const clusterLabel = clustersHaveProduct ? 'Sold by category (organic / all channels)' : 'By cluster (entry-page organic)';
    const topClusters = (seoImpact.clusters || []).slice(0, 4)
      .map((c) => (clustersHaveProduct
        ? `${esc(c.cluster)} ${money(c.product_organic_revenue)} / ${money(c.product_revenue_all_channels)}`
        : `${esc(c.cluster)} ${money(c.revenue)}`)).join(' &middot; ');
    const notConv = (seoImpact.not_converting || []).slice(0, 3)
      .map((r) => `${esc(r.path)} (${r.sessions}s)`).join(', ');
    seoImpactSection = `
      <div class="section quick-wins">
        <div class="section-title">&#128200; What's Working &mdash; Organic Revenue (last ${windowDays} days)</div>
        <p style="font-size:13px;margin:0 0 12px 0;"><strong>${money(t.organic_revenue)}</strong> organic revenue &middot; <span style="color:${deltaColor};font-weight:600;">${deltaStr}</span> vs prior period &middot; ${t.organic_conversions} ${seoImpact.revenue_source === 'shopify-orders' ? 'Shopify orders' : 'conversion events'}${t.organic_sessions != null ? ` &middot; <span style="color:#6b7280;">${t.organic_sessions} organic sessions</span>` : ''}</p>
        ${topPages}
        ${topClusters ? `<div class="qw-meta" style="margin-top:10px;"><strong>${clusterLabel}:</strong> ${topClusters}</div>` : ''}
        ${notConv ? `<div class="qw-meta" style="margin-top:6px;color:#92400e;"><strong>Traffic, no sales:</strong> ${notConv} &mdash; conversion opportunities</div>` : ''}
      </div>`;
  }

  // Pipeline Priority — backlog depth, buffer, promotions, injections, suggestions, alerts
  let prioritizerSection = '';
  if (prioritizer) {
    const pp = prioritizer;
    let phtml = `<div class="section quick-wins"><div class="section-title">&#128203; Pipeline Priority</div>`;
    phtml += `<p style="font-size:13px;margin:0 0 12px 0;">Backlog <strong>${pp.backlog_depth}</strong> ideas &middot; buffer <strong>${pp.buffer_ready}/${pp.buffer_target}</strong></p>`;
    if (pp.promotions && pp.promotions.length) {
      phtml += `<p style="font-size:12px;font-weight:600;color:#1f2937;margin:0 0 4px 0;">Fast-tracked / written next:</p>`;
      for (const x of pp.promotions) {
        phtml += `<div class="quick-win-row"><div class="qw-body"><div class="qw-title">${esc(x.slug)}</div><div class="qw-meta">${esc(x.publish_date ? x.publish_date.slice(0, 10) : '')} &middot; ${esc(x.reason)}</div></div></div>`;
      }
    }
    if (pp.injections && pp.injections.length) {
      phtml += `<p style="font-size:12px;font-weight:600;color:#1f2937;margin:12px 0 4px 0;">New ideas queued:</p>`;
      for (const x of pp.injections) {
        phtml += `<div class="quick-win-row"><div class="qw-body"><div class="qw-title">${esc(x.keyword)}</div><div class="qw-meta">${esc(x.why)}</div></div></div>`;
      }
    }
    if (pp.suggestions && pp.suggestions.length) {
      phtml += `<p style="font-size:12px;font-weight:600;color:#1f2937;margin:12px 0 4px 0;">Suggested (confirm):</p>`;
      for (const x of pp.suggestions.slice(0, 5)) {
        phtml += `<div class="quick-win-row"><div class="qw-body"><div class="qw-title">${esc(x.key)}</div><div class="qw-meta">${esc(x.reason)}</div></div></div>`;
      }
    }
    if (pp.alerts && pp.alerts.length) {
      phtml += `<p style="font-size:12px;font-weight:700;color:#92400e;margin:12px 0 4px 0;">&#9888;&#65039; Alerts:</p><ul style="font-size:12px;color:#92400e;margin:0;padding-left:18px;">`;
      for (const a of pp.alerts) phtml += `<li>${esc(a)}</li>`;
      phtml += '</ul>';
    }
    phtml += '</div>';
    prioritizerSection = phtml;
  }

  // Post performance flops. One row per post, split by what happens NEXT
  // (post-performance stamps `action`). Only the flops no agent handles are
  // listed as cards, capped; the automated ones are a count. This section used
  // to print every flop as an "Action Required" card — 159 of them on
  // 2026-09-21, most either already queued for refresh, locked winners, or
  // owned by indexing-fixer — which is how a section stops being read.
  let flopSection = '';
  const flops = (postPerformance && postPerformance.action_required) || [];
  if (flops.length > 0) {
    const FLOP_CARDS_SHOWN = 10;
    const manual = flops.filter((f) => f.automated !== true);
    const auto = flops.filter((f) => f.automated === true);
    const autoCounts = {};
    for (const f of auto) {
      const label = f.action_label || f.action;
      autoCounts[label] = (autoCounts[label] || 0) + 1;
    }
    const autoLine = Object.entries(autoCounts).map(([label, n]) => `${esc(label)}: ${n}`).join(' &middot; ');
    const cards = manual.slice(0, FLOP_CARDS_SHOWN).map((f) => `
      <div class="blocked-post">
        <div class="title">${esc(f.title || f.slug)} &mdash; ${esc(f.verdict)} (${f.milestone}d)</div>
        <div class="blockers">${esc(f.action_label ? `${f.action_label}. ` : '')}${esc(f.reason || '')}</div>
        <div class="report-link">data/reports/post-performance/${esc(f.slug)}-${f.milestone}d.md</div>
      </div>`).join('');
    const more = manual.length > FLOP_CARDS_SHOWN
      ? `<p style="font-size:12px;color:#6b7280;margin:8px 0 0 0;">+${manual.length - FLOP_CARDS_SHOWN} more on the dashboard.</p>`
      : '';
    flopSection = `
      <div class="${manual.length ? 'action-required' : 'section'}">
        <div class="section-title">Underperforming posts &mdash; ${manual.length} need a decision, ${auto.length} handled automatically</div>
        ${autoLine ? `<p style="font-size:12px;color:#6b7280;margin:0 0 12px 0;">Handled automatically: ${autoLine}.</p>` : ''}
        ${cards}${more}
      </div>`;
  }

  // Post performance — today's reviews summary (informational, shown when no flops or alongside)
  let performanceSection = '';
  if (postPerformance && postPerformance.reviews_today > 0) {
    performanceSection = `
      <div class="section">
        <div class="section-title">Post Performance</div>
        <p style="font-size:13px;color:#374151;margin:0;">${postPerformance.reviews_today} post${postPerformance.reviews_today > 1 ? 's' : ''} crossed a 30/60/90 day milestone today. ${flops.length} flagged for action.</p>
      </div>`;
  }

  // GSC opportunities — top 5 low-CTR queries (informational)
  let gscSection = '';
  if (gscOpps && (gscOpps.low_ctr?.length || gscOpps.unmapped?.length)) {
    const top = (gscOpps.low_ctr || []).slice(0, 5);
    const unmapped = (gscOpps.unmapped || []).slice(0, 3);
    const lowCtrRows = top.map((r, i) => `
      <div class="quick-win-row">
        <div class="qw-rank">${i + 1}.</div>
        <div class="qw-body">
          <div class="qw-title">${esc(r.keyword)}</div>
          <div class="qw-meta">${r.impressions.toLocaleString('en-US')} impressions &middot; ${(r.ctr * 100).toFixed(1)}% CTR &middot; pos ${r.position.toFixed(1)}</div>
        </div>
      </div>`).join('');
    const unmappedList = unmapped.map((r) => `<li>${esc(r.keyword)} &mdash; ${r.impressions} impressions</li>`).join('');
    gscSection = `
      <div class="section">
        <div class="section-title">GSC Opportunities</div>
        <p style="font-size:12px;color:#6b7280;margin:0 0 8px 0;">Top low-CTR queries (rewrite title/meta):</p>
        ${lowCtrRows}
        ${unmappedList ? `<p style="font-size:12px;color:#6b7280;margin:12px 0 4px 0;">Unmapped (new-topic candidates):</p><ul style="font-size:12px;color:#374151;margin:0;padding-left:18px;">${unmappedList}</ul>` : ''}
      </div>`;
  }

  // Competitor activity (only when there's something new)
  let competitorSection = '';
  if (competitors && competitors.new_post_count > 0) {
    const items = (competitors.new_posts || []).slice(0, 8).map((p) => {
      const overlap = p.overlaps_ours ? ' &mdash; <strong style="color:#991b1b;">overlaps our cluster</strong>' : '';
      return `<li><strong>${esc(p.competitor)}:</strong> <a href="${esc(p.url)}" target="_blank">${esc(p.title)}</a>${overlap}</li>`;
    }).join('');
    competitorSection = `
      <div class="section">
        <div class="section-title">Competitor Activity (${competitors.new_post_count})</div>
        <ul style="font-size:13px;color:#374151;margin:0;padding-left:18px;">${items}</ul>
      </div>`;
  }

  // (No optimization-queue section — see the note above loadPerformanceQueue's
  // former home. queue-autoapply owns that work; the digest does not ask.)

  // Work the AUTOMATION has permanently given up on.
  //
  // This is the narrow case that survived removing the Optimization Queue block,
  // and the two properties below are what stop it becoming that block again:
  //
  //   1. It reads queue-autoapply's REPORT — what the robot says it abandoned —
  //      never data/performance-queue/, which is the fleet's workspace. Reading
  //      the queue is what produced a daily to-do list of work finished two
  //      hours later.
  //   2. Only `needs_decision[]` renders, and `decide()` puts an item there only
  //      when NO automated run will ever clear it. A cooldown, an over-cap item
  //      and an unresolvable product count are absent by construction.
  //
  // It states the DECISION, not the item: "rewrite it, or write it off" rather
  // than "approve this". Measured on production 2026-09-18 this is one item of
  // four pending, and it is silent when empty.
  //
  // SECOND PRODUCER, 2026-09-19: agents/indexing-fixer. Its submission-count
  // escalation is the same class of finding — once a post crosses two delivered
  // Indexing API submissions the fixer stamps it and never submits that URL
  // again, so no further run can change the verdict. It had been reaching a cron
  // log and nothing else: five posts re-stamped every morning since 2026-08-30,
  // named in no digest, ever. Both reports carry the SAME `needs_decision[]` row
  // shape on purpose, so this renderer stays one renderer.
  //
  // THIRD PRODUCER: agents/content-strategist. A topic an existing page already
  // ranks for is WITHHELD rather than auto-proposed (lib/duplicate-flag.js), and
  // "write it anyway, or drop the topic" is a call automation is not allowed to
  // make — the flag is a measured heuristic with known false positives, which is
  // why nothing upstream ever drops on it. Same row shape again, so this stays
  // ONE renderer; a withheld topic that appeared nowhere would be the silent
  // drop this whole path exists to prevent.
  //
  // FOURTH PRODUCER, 2026-10-13: agents/amazon-account-health. An open Amazon
  // policy violation is a decision only a human can take (fix and appeal, or
  // delete the listing), and the SP-API cannot submit an appeal. The Geranium
  // deodorant sat removed for ten weeks, unseen, blocking Remote Fulfillment
  // for Amazon.ca. Same row shape.
  let decisionSection = '';
  try {
    const stuck = NEEDS_DECISION_REPORTS.map((r) => join(dataRoot, ...r.path)).flatMap((p) => {
      if (!existsSync(p)) return [];
      try {
        const report = JSON.parse(readFileSync(p, 'utf8'));
        return Array.isArray(report?.needs_decision) ? report.needs_decision : [];
      } catch { return []; } // one unreadable report must not hide the other
    });
    if (stuck.length) {
      const rows = stuck.map((d) => {
        const age = d.created_at
          ? Math.floor((Date.now() - new Date(d.created_at).getTime()) / 86400000)
          : null;
        const why = d.last_gate_reason
          ? `<div style="font-size:12px;color:#6b7280;margin-top:6px;">${esc(previewBody(d.last_gate_reason, { maxLines: 2, maxChars: 200 }))}</div>`
          : '';
        return `
            <div class="blocked-post">
              <div class="title">${esc(d.title || d.slug || 'untitled')}</div>
              <div class="blockers"><strong>${esc(d.label || d.reason || '')}</strong></div>
              <div style="font-size:11px;color:#9ca3af;margin-top:4px;">${esc(d.trigger || '')}${age != null ? ` &middot; stuck ${age} day${age === 1 ? '' : 's'}` : ''}</div>
              ${why}
            </div>`;
      }).join('');
      decisionSection = `
          <div class="action-required">
            <div class="section-title">&#129300; Needs your decision &mdash; ${stuck.length} item${stuck.length > 1 ? 's' : ''} the automation gave up on</div>
            <p style="font-size:12px;color:#6b7280;margin:0 0 12px 0;">Not a review queue &mdash; everything routine is applied automatically. These are the items no further run will ever clear.</p>
            ${rows}
          </div>`;
    }
  } catch { /* best-effort: a missing or unreadable report is silence, never an error */ }

  // Reviews section — surfaces new reviews from review-monitor
  let reviewSection = '';
  const reviewPath = join(dataRoot, 'data', 'reports', 'reviews', 'latest.json');
  if (existsSync(reviewPath)) {
    try {
      const reviewData = JSON.parse(readFileSync(reviewPath, 'utf8'));
      if (reviewData.new_reviews && reviewData.new_reviews.length > 0) {
        const s = reviewData.summary;
        let rhtml = `<div class="section"><div class="section-title" style="color:#312e81;border-bottom-color:#c7d2fe;">&#11088; Reviews &mdash; ${s.total_new} new</div>`;
        rhtml += `<p style="font-size:13px;color:#6b7280;margin:0 0 8px">${s.positive} positive, ${s.neutral} neutral, ${s.negative} negative</p>`;
        if (s.flagged_for_response && s.flagged_for_response.length > 0) {
          rhtml += '<p style="color:#dc2626;font-weight:700;margin:8px 0 4px">Needs Response:</p><ul style="margin:0;padding-left:20px">';
          for (const f of s.flagged_for_response) {
            rhtml += `<li><strong>${esc(f.product_handle)}</strong> (${f.rating}&#9733;): ${esc(f.complaint || '').slice(0, 150)}</li>`;
          }
          rhtml += '</ul>';
        }
        rhtml += '</div>';
        reviewSection = rhtml;
      }
    } catch { /* ignore */ }
  }

  // Blocked images section — posts where CD rejected all image attempts
  let blockedImagesSection = '';
  const rejectedDir = join(dataRoot, 'data', 'images', 'rejected');
  if (existsSync(rejectedDir)) {
    try {
      const rejections = [];
      for (const dir of readdirSync(rejectedDir)) {
        const recPath = join(rejectedDir, dir, 'rejection.json');
        if (existsSync(recPath)) {
          try { rejections.push(JSON.parse(readFileSync(recPath, 'utf8'))); } catch { /* skip */ }
        }
      }
      if (rejections.length > 0) {
        blockedImagesSection = '<div class="section"><div class="section-title" style="color:#991b1b;border-bottom-color:#fecaca">&#9888;&#65039; Blocked Images &mdash; ' + rejections.length + ' post' + (rejections.length > 1 ? 's' : '') + ' need image approval</div>';
        for (const r of rejections) {
          blockedImagesSection += '<div style="padding:6px 0;border-bottom:1px solid #f3f4f6"><strong>' + esc(r.title) + '</strong> &mdash; ' + r.attempts + ' attempt' + (r.attempts > 1 ? 's' : '') + ' rejected';
          if (r.images?.[0]?.reason) blockedImagesSection += '<br><span style="font-size:12px;color:#6b7280">' + esc(r.images[0].reason) + '</span>';
          blockedImagesSection += '</div>';
        }
        blockedImagesSection += '<p style="font-size:12px;color:#6b7280;margin:8px 0 0">Review on the dashboard — select a rejected image or request more attempts.</p></div>';
      }
    } catch { /* ignore */ }
  }

  // Backlinks section
  let backlinksSection = '';
  const backlinksDir = join(dataRoot, 'data', 'reports', 'backlinks');
  if (existsSync(backlinksDir)) {
    try {
      const files = readdirSync(backlinksDir).filter(f => f.endsWith('.json') || f.endsWith('.md')).sort();
      if (files.length > 0) {
        const latest = readFileSync(join(backlinksDir, files[files.length - 1]), 'utf8');
        // Try JSON first
        try {
          const data = JSON.parse(latest);
          const newLinks = data.new_backlinks || data.new || [];
          const lostLinks = data.lost_backlinks || data.lost || [];
          if (newLinks.length > 0 || lostLinks.length > 0) {
            backlinksSection = `<div class="section"><div class="section-title">&#128279; Backlinks</div>`;
            if (newLinks.length > 0) backlinksSection += `<p style="color:#10b981;font-weight:700">+${newLinks.length} new backlink${newLinks.length > 1 ? 's' : ''}</p>`;
            if (lostLinks.length > 0) backlinksSection += `<p style="color:#ef4444;font-weight:700">-${lostLinks.length} lost backlink${lostLinks.length > 1 ? 's' : ''}</p>`;
            backlinksSection += '</div>';
          }
        } catch {
          // Markdown format — just check if it has content
          if (latest.length > 100) {
            backlinksSection = `<div class="section"><div class="section-title">&#128279; Backlinks</div><p>New backlink report available. Check dashboard for details.</p></div>`;
          }
        }
      }
    } catch { /* ignore */ }
  }

  // A/B Test Results section
  let abTestSection = '';
  const metaTestsDir = join(dataRoot, 'data', 'meta-tests');
  const allTests = [];

  // Read new-format tests from data/meta-tests/*.json
  if (existsSync(metaTestsDir)) {
    try {
      const newTests = readdirSync(metaTestsDir)
        .filter(f => f.endsWith('.json'))
        .map(f => { try { return JSON.parse(readFileSync(join(metaTestsDir, f), 'utf8')); } catch { return null; } })
        .filter(Boolean);
      allTests.push(...newTests);
    } catch { /* ignore */ }
  }

  // Read legacy tests from data/reports/meta-ab/meta-ab-tracker.json
  const legacyTrackerPath = join(dataRoot, 'data', 'reports', 'meta-ab', 'meta-ab-tracker.json');
  if (existsSync(legacyTrackerPath)) {
    try {
      const legacyEntries = JSON.parse(readFileSync(legacyTrackerPath, 'utf8'));
      if (Array.isArray(legacyEntries)) {
        for (const entry of legacyEntries) {
          if (!entry.testedAt) continue;
          // Skip tests with no measured outcome — without a decided winner or a
          // delta they'd render a misleading "Variant A wins (n/a)" (the default
          // winner is A), implying a result that was never actually measured.
          const hasOutcome = entry.winner != null || entry.kept != null
            || entry.currentDelta != null || entry.ctrDelta != null;
          if (!hasOutcome) continue;
          // Normalize legacy format to match new-format fields. Legacy entries
          // identify the test by `keyword`/`pageUrl`, not slug/page.
          allTests.push({
            slug: entry.slug || entry.page || entry.keyword || entry.pageUrl || '',
            status: entry.status || 'concluded',
            concludedDate: entry.concludedDate || entry.testedAt,
            originalTitle: entry.originalTitle,
            proposedTitle: entry.proposedTitle,
            winner: entry.winner || (entry.kept === 'proposed' ? 'B' : 'A'),
            currentDelta: entry.currentDelta ?? entry.ctrDelta ?? null,
            _source: 'legacy',
          });
        }
      }
    } catch { /* ignore */ }
  }

  {
    const active = allTests.filter(t => t.status === 'active');
    const recentConcluded = allTests.filter(t => t.status === 'concluded' && (t.concludedDate || t.testedAt))
      .sort((a, b) => ((b.concludedDate || b.testedAt || '').localeCompare(a.concludedDate || a.testedAt || '')))
      .slice(0, 5);
    if (active.length > 0 || recentConcluded.length > 0) {
      abTestSection = `<div class="section"><div class="section-title">&#9878;&#65039; Meta A/B Tests</div>`;
      if (active.length > 0) {
        abTestSection += `<p>${active.length} active test${active.length > 1 ? 's' : ''} running</p>`;
      }
      if (recentConcluded.length > 0) {
        // LABEL the two sets. The active count and these rows are different
        // tests, and printing the count immediately above unlabelled rows read
        // as though the rows WERE the active tests.
        abTestSection += `<p style="font-size:12px;color:#6b7280;margin:12px 0 4px 0;">`
          + `Recently concluded &mdash; a move under &plusmn;${(DEFAULT_REGRESS_THRESHOLD * 100).toFixed(1)}pp is inside the noise floor and counts as no change.`
          + `</p>`;
      }
      for (const t of recentConcluded) {
        // Prefer a STORED outcome; only classify when the record has none.
        // The legacy tracker writes `outcome`; the newer data/meta-tests/*.json
        // files carry only `winner` + `currentDelta`, and deriving a label from
        // `winner` alone is what made a -1.26pp regression read as a win —
        // decideOutcome sets winner='A' for BOTH `flat` and `regressed`.
        const verdict = t.outcome || classifyCtrDelta(t.currentDelta);
        const label = {
          improved: 'improved',
          flat: 'no change',
          regressed: 'REGRESSED',
          confounded: 'confounded &mdash; not concluded',
          underpowered: 'underpowered &mdash; not concluded',
        }[verdict] || 'not measured';
        const color = verdict === 'improved' ? '#10b981'
          : verdict === 'regressed' ? '#ef4444'
            : '#6b7280';
        const delta = t.currentDelta != null
          ? (t.currentDelta >= 0 ? '+' : '') + (t.currentDelta * 100).toFixed(2) + 'pp'
          : 'n/a';
        abTestSection += `<p><strong>${esc(t.slug)}</strong>: `
          + `<span style="color:${color}">${label}</span> (${delta})</p>`;
      }
      abTestSection += '</div>';
    }
  }

  // System-health section — only shown when something is wrong (mirrors the
  // "silent on success" convention). Surfaces stale/missing snapshot feeds and
  // leftover git stashes so a silent data outage can't hide behind a normal-
  // looking digest.
  let healthSection = '';
  if (healthIssues.length) {
    const rows = healthIssues.map(i => `<div class="blocked-post"><div class="title">${esc(i.title)}</div><div class="blockers">${esc(i.detail)}</div></div>`).join('');
    healthSection = `<div class="action-required"><div class="section-title">&#9888;&#65039; System Health — ${healthIssues.length} issue${healthIssues.length > 1 ? 's' : ''}</div>${rows}</div>`;
  }

  const nothingToReport = !healthSection && !seoImpactSection && !prioritizerSection && !decisionSection && !flopSection && !performanceSection && !gscSection && !competitorSection && !blockedSection && !quickWinSection && !pipelineSection && !imageSection && !adsSection && !seoSection && !otherSection && !reviewSection && !backlinksSection && !abTestSection && !blockedImagesSection;

  // LLM cost — passive spend monitoring (best-effort; never breaks the digest).
  // ── LLM cost block REMOVED 2026-09-08, on the operator's instruction ────────
  // The fleet moved off per-token API billing onto the monthly subscription, so
  // agent run cost is no longer a constraint on any decision and a dollar figure
  // is no longer an argument for or against doing work. Sean, verbatim: "Remove
  // this all together, it is no longer a concern now that we switched from the
  // API to the monthly subscription."
  //
  // Its last appearance was also a false alarm, which is the shape to remember:
  // it flagged "$34.03/wk ⚠️ over $20 target" when $11.54 of the $17.19 day was
  // ONE hand-run local script, not fleet spend at all. A budget line that counts
  // a human's ad-hoc run against an unattended-fleet target cannot be read.
  //
  // `lib/llm-usage.js` still METERS every call — that data is useful for volume
  // and debugging and is untouched. What is gone is the digest's dollar row and
  // the $20/wk budget verdict. Do not reinstate either without asking first.
  const costSection = '';

  // ── Lean digest: only what moved the needle (revenue-first) ───────────────
  // Every agent still runs and its full output is on the dashboard. The digest
  // deliberately surfaces only the handful of things that change revenue or need
  // a decision — not a listing of everything that happened. The verbose per-
  // category sections above are intentionally left unrendered here.

  // Rank movers — biggest position gains/drops on tracked queries (rank-alerter).
  let rankMoversSection = '';
  try {
    const raPath = join(dataRoot, 'data', 'reports', 'rank-alerter', 'latest.json');
    if (existsSync(raPath)) {
      const ra = JSON.parse(readFileSync(raPath, 'utf8'));
      const moverRow = (m, up) =>
        `<p style="font-size:13px;margin:5px 0;">${up ? '&#128200;' : '&#128201;'} <strong>${esc(m.query)}</strong> `
        + `#${Math.round(m.from)} &rarr; <span style="color:${up ? '#166534' : '#991b1b'};font-weight:600;">#${Math.round(m.to)}</span></p>`;
      const gains = (ra.gains || []).slice(0, 3).map((g) => moverRow(g, true)).join('');
      const drops = (ra.drops || []).slice(0, 3).map((d) => moverRow(d, false)).join('');
      if (gains || drops) {
        rankMoversSection = `<div class="section"><div class="section-title">&#128202; Rank Movers</div>${gains}${drops}</div>`;
      }
    }
  } catch { /* best-effort */ }

  // Failures that cost money — error-status entries only.
  let errorsSection = '';
  {
    // Show a bounded list but ALWAYS count the true total. The cap used to be a
    // bare slice(0, 5), so a sixth failure vanished with nothing saying so —
    // that is how a daily `Legacy Rebuilder failed` ReferenceError went unread.
    const allErrs = visible.filter((e) => e.status === 'error');
    const errs = allErrs.slice(0, ERROR_ROWS_SHOWN);
    if (allErrs.length) {
      const rows = errs.map((e) =>
        `<div class="blocked-post"><div class="title">&#10060; ${esc(e.subject)}</div>`
        + `${e.body ? `<div class="blockers">${esc(previewBody(e.body, { maxLines: 3, maxChars: 220 }))}</div>` : ''}</div>`).join('');
      const hidden = allErrs.length - errs.length;
      const more = hidden > 0
        ? `<div class="blockers" style="margin-top:6px;">&hellip; and ${hidden} more failure${hidden > 1 ? 's' : ''} not shown &mdash; see the dashboard.</div>`
        : '';
      errorsSection = `<div class="action-required"><div class="section-title">&#10060; Failures &mdash; ${allErrs.length}</div>${rows}${more}</div>`;
    }
  }

  // Did our bets pay off — change-verdict outcomes (they notify as entries).
  let verdictSection = '';
  {
    const vs = visible.filter((e) => /verdict/i.test(e.subject || '')).slice(0, 4);
    if (vs.length) {
      verdictSection = `<div class="section"><div class="section-title">&#9989; Change Verdicts</div>${renderEntries(vs)}</div>`;
    }
  }

  // Decisions awaiting you — posts blocked from publish. A hard-blocked post
  // genuinely needs a person and nothing else reports it; the optimization
  // queue used to share this slot and no longer does.
  // A flop a human must decide (merge or remove a no-demand page) is a
  // decision too, and the subject line already counts it ("1 flop to decide").
  // The section was built but dropped from the layout in the revenue-first
  // strip-down, so the subject promised a row the body never showed. Only
  // rendered when something needs a person; the automated count alone stays off.
  const flopNeedsDecision = flops.some((f) => f.automated !== true);
  const creatorReviewSection = renderCreatorReviewSection(visible, esc);
  const decisionsBody = `${creatorReviewSection}${decisionSection}${flopNeedsDecision ? flopSection : ''}${blockedSection}`;

  // Everything else ran; collapse to a single activity line (no listing).
  const errCount = entries.filter((e) => e.status === 'error').length;
  const okCount = entries.length - errCount;
  const activityLine = `${entries.length} task${entries.length !== 1 ? 's' : ''} ran`
    + ` &middot; ${okCount} ok${errCount ? ` &middot; <span style="color:#991b1b;">${errCount} error${errCount > 1 ? 's' : ''}</span>` : ''}`;

  // Priority order — most revenue-critical first. Each block self-hides when empty.
  const movers = [
    healthSection,       // data outage / stale feeds
    errorsSection,       // things that broke
    seoImpactSection,    // revenue & conversion (the number)
    rankMoversSection,   // leading indicator of traffic → revenue
    decisionsBody,       // unrealized revenue awaiting a click
    verdictSection,      // did our changes work
    abTestSection,       // CTR bets concluded
    costSection,         // always '' — LLM cost block removed 2026-09-08
  ].filter(Boolean);

  // The reviewed recap: what is working, how to grow, what is still being worked
  // on, and the one thing only Sean can do. The failure/decision/health blocks
  // are gone because the overnight reviewer either fixed each item (Fixed
  // overnight) or still owes it (Still being worked on). See renderReviewedRecap.
  const lateBlock = renderLateFinished(lateFinished, esc);
  if (review) {
    return renderReviewedRecap({
      review, targetDate, styles, esc, dashboardUrl, entries, lateBlock,
      working: [seoImpactSection, rankMoversSection, verdictSection, abTestSection].filter(Boolean),
      creatorReviewSection,
    });
  }

  // review === null: the reviewer did not run (or crashed, or is stale, or only
  // dry-ran). Today's email, unchanged, under a banner saying so, so it can never
  // read as an all-clear. review === undefined (a --date run) is the plain email.
  const banner = review === null
    ? `<div class="fallback-banner" style="background:#fef3c7;border:1px solid #f59e0b;color:#92400e;border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:13px;font-weight:600;">${FALLBACK_BANNER}</div>`
    : '';

  return `<!DOCTYPE html>
<html><head><style>${styles}</style></head><body>${banner}
  <h1>Daily Recap &mdash; What Moved</h1>
  <div class="date">${targetDate}</div>${lateBlock ? `\n  <div class="section">${lateBlock}</div>` : ''}
  ${movers.length
    ? movers.join('\n  ')
    : '<div class="section"><p class="empty">Nothing moved the needle yesterday — revenue steady, no failures, no decisions waiting.</p></div>'}
  <div class="footer">${activityLine} &middot; <a href="${esc(dashboardUrl)}" style="color:#6b7280;">Full activity on dashboard &rarr;</a></div>
</body></html>`;
}

/**
 * Check that every data feed is still updating and that no git stashes were
 * left behind by a deploy. Returns a list of {title, detail} issues for the
 * digest. Catches the *silent* failure mode error-driven alerts miss — a cron
 * that stops firing produces no error, just quietly stale data.
 */
export function checkSystemHealth() {
  const today = new Date().toISOString().slice(0, 10);

  // Each feed is written daily, but several name their file by the DATA date,
  // which lags the run date — so a healthy feed's newest file is structurally a
  // few days old. maxAgeDays = expected data lag + ~2 days grace, so we tolerate
  // normal lag/transient API delay but still catch a collector that has stopped
  // (its age then climbs past the threshold within a couple of days).
  //   gsc: dated 3 days back (GSC reporting lag)         → 5
  //   google-ads / shopify: dated yesterday              → 4 / 3
  //   ga4 / clarity / rank-snapshots: ~same-day          → 3 / 3 / 2
  const sources = [
    { name: 'rank-snapshots', dir: join(ROOT, 'data', 'rank-snapshots'), maxAgeDays: 2 },
    { name: 'gsc',        dir: join(ROOT, 'data', 'snapshots', 'gsc'),        maxAgeDays: 5 },
    { name: 'ga4',        dir: join(ROOT, 'data', 'snapshots', 'ga4'),        maxAgeDays: 3 },
    { name: 'clarity',    dir: join(ROOT, 'data', 'snapshots', 'clarity'),    maxAgeDays: 3 },
    { name: 'shopify',    dir: join(ROOT, 'data', 'snapshots', 'shopify'),    maxAgeDays: 3 },
    { name: 'google-ads', dir: join(ROOT, 'data', 'snapshots', 'google-ads'), maxAgeDays: 4 },
  ];

  const results = checkFreshness(
    sources.map(s => ({ name: s.name, newestDate: newestSnapshotDate(s.dir), maxAgeDays: s.maxAgeDays })),
    { today },
  );

  const issues = problems(results).map(r => ({
    title: `Data feed "${r.name}" is ${r.status}`,
    detail: r.status === 'missing'
      ? `No snapshots found in data/snapshots for "${r.name}". Its collector may have never run.`
      : `Latest snapshot is ${r.ageDays} days old (${r.newestDate}); expected within ${r.maxAgeDays} days. The collector likely stopped running.`,
  }));

  // Derived analysis reports (latest.json) — these drive decisions (the email
  // sections, performance-engine, the strategist), so a stale report silently
  // feeds old data into live actions. Freshness comes from each file's
  // generated_at. Thresholds match each producer's cadence + grace:
  //   gsc-opportunity: daily      → 2
  //   quick-wins:      weekly Mon → 9
  //
  // seo-impact is NOT a local number: it imports SEO_IMPACT_MAX_AGE_DAYS, the
  // same constant the gates that block and delete work read. This row is the
  // only channel a stale seo-impact report speaks through, so it must never
  // alert LATER than a consumer degrades. It sat at 9 while
  // `pipeline-prioritizer` silently dropped the revenue signal at 3 — ages 4-9
  // were a window where the fleet ran degraded and the digest said all was well.
  const reports = [
    { name: 'gsc-opportunity report',      path: join(ROOT, 'data', 'reports', 'gsc-opportunity', 'latest.json'),      maxAgeDays: 2 },
    { name: 'quick-wins report',            path: join(ROOT, 'data', 'reports', 'quick-wins', 'latest.json'),            maxAgeDays: 9 },
    { name: 'seo-impact report',            path: join(ROOT, 'data', 'reports', 'seo-impact', 'latest.json'),            maxAgeDays: SEO_IMPACT_MAX_AGE_DAYS,
      // Not "running on stale data" — the gates fail SAFE and stop deciding at
      // all, which is a quiet loss of a capability rather than a wrong action.
      // Say which, or the row reads as a warning instead of an outage.
      note: 'The $0-cluster gates have fallen open: nothing is being held, blocked, deferred or dropped on cluster revenue, and ad-brief is scoring `commercial` neutral. Re-run agents/seo-impact.' },
    { name: 'publish-drift report',         path: join(ROOT, 'data', 'reports', 'publish-drift', 'latest.json'),         maxAgeDays: 2 },
    { name: 'pipeline-prioritizer report',  path: join(ROOT, 'data', 'reports', 'pipeline-prioritizer', 'latest.json'), maxAgeDays: 2 },
  ];
  const noteFor = new Map(reports.map(r => [r.name, r.note]));
  const reportResults = checkFreshness(
    reports.map(r => ({ name: r.name, newestDate: newestReportDate(r.path), maxAgeDays: r.maxAgeDays })),
    { today },
  );
  for (const r of problems(reportResults)) {
    const note = noteFor.get(r.name);
    issues.push({
      title: `Analysis report "${r.name}" is ${r.status}`,
      detail: (r.status === 'missing'
        ? `${r.name} has never been generated (no latest.json). Its producer agent isn't running.`
        : `${r.name} is ${r.ageDays} days old (generated ${r.newestDate}); expected within ${r.maxAgeDays} days. Downstream decisions are running on stale data.`)
        + (note ? ` ${note}` : ''),
    });
  }

  // Edit freezes that have ended and carry a deferred follow-up
  // (scripts/post-edit-freeze.mjs --followup). The freeze held the page still
  // so a change could be measured; the follow-up is the work that waited on it.
  try {
    const metas = listAllSlugs().map((s) => [s, getPostMeta(s)]);
    for (const f of freezeFollowupsDue(metas)) {
      issues.push({
        title: `Edit freeze ended on "${f.slug}" (${f.until.slice(0, 10)}): follow-up due`,
        detail: `${f.followup} Then lift it: \`node scripts/post-edit-freeze.mjs --handle ${f.slug} --clear --apply\`.`,
      });
    }
  } catch { /* posts unreadable — the post-meta gate reports that separately */ }

  // Leftover git stashes — per the deploy hygiene rule the list should be empty
  // outside an active deploy. A non-empty list means a past `git stash pop` was
  // skipped and data updates are stranded.
  try {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' }).trim();
    const stashCount = stashList ? stashList.split('\n').length : 0;
    if (stashCount > 0) {
      issues.push({
        title: `${stashCount} leftover git stash${stashCount > 1 ? 'es' : ''} on the server`,
        detail: `\`git stash list\` should be empty outside a deploy. Run \`git stash list\` and reconcile — a skipped \`git stash pop\` strands data updates.`,
      });
    }
  } catch { /* not a git checkout / git unavailable — skip silently */ }

  return issues;
}


// ── The reviewed recap ─────────────────────────────────────────────────────
//
// agents/recap-reviewer runs at 11:05 UTC and works every problem this digest
// would otherwise hand Sean. Sean, verbatim: "I shouldn't see errors or anything
// didn't work... I should see a summary of what is working and how we can grow
// the business." So when a valid review exists the email renders from it.
//
// The anti-goal is HIDING a broken thing. Every failure the review did not
// resolve still appears, as status, under "Still being worked on" (the review's
// own `unresolved` plus the residual computed here), and a review that is
// missing, stale, crashed or only a dry run is not a review: the old email is
// sent under FALLBACK_BANNER, never an all-clear.

export const FALLBACK_BANNER = 'The overnight reviewer did not run; this is the unreviewed recap.';
export const REVIEW_WAIT_MS = 30 * 60_000;
export const QUICK_RERUN_MAX_MS = 10 * 60_000;
const QUICK_RERUN_MIN_MS = 60_000;
const FIXED_LINES_SHOWN = 12;
const TOMORROW = 'picked up tomorrow morning';

/**
 * Today's review, or null. Valid only when it is an --apply run, did not crash,
 * was generated today (UTC) and the reviewer wrote today's done.json. A dry run
 * writes dry-run.json, never latest.json, but `apply` is checked anyway.
 * @param {{ today: string, read: (name: string) => object|null }} opts
 */
export function loadReview({ today, read }) {
  const safe = (name) => { try { return read(name); } catch { return null; } };
  const report = safe('latest.json');
  if (!report || typeof report !== 'object') return null;
  if (report.apply !== true || report.crashed === true) return null;
  if (String(report.generated_at || '').slice(0, 10) !== today) return null;
  const done = safe('done.json');
  if (!done || done.date !== today || done.crashed === true) return null;
  return report;
}

/**
 * Poll for today's done.json for up to `deadlineMs`. Returns the absolute
 * deadline so the quick pass can spend only what is left of the same budget.
 */
export async function waitForReview({ deadlineMs = REVIEW_WAIT_MS, poll, sleep, now = Date.now, intervalMs = 60_000 } = {}) {
  const start = now();
  const deadline = start + deadlineMs;
  for (;;) {
    let ready = false;
    try { ready = !!(await poll()); } catch { ready = false; }
    if (ready) return { ready: true, deadline, waitedMs: now() - start };
    const left = deadline - now();
    if (left <= 0) return { ready: false, deadline, waitedMs: now() - start };
    await sleep(Math.min(intervalMs, left));
  }
}

const healthKey = (h) => buildReviewItems({ healthIssues: [h] })[0].key;

/**
 * Health rows to raise as an error notify: all of them. They are read fresh by
 * checkSystemHealth() at 13:00, so a row present now IS broken now, even when
 * the 11:05 review resolved it (it broke again since the morning fix).
 */
export function healthIssuesToNotify(healthIssues = []) {
  return healthIssues;
}

/**
 * Reconcile the 13:00 inputs with the 11:05 review.
 *
 *   - error rows older than the review whose key it resolved are dropped;
 *   - error rows newer than the review (the 12:15-12:58 gates) get a quick pass:
 *     transient AND on the re-run allowlist -> re-run now, bounded by the wait
 *     budget and 10 minutes, and counted fixed only when a later non-error row
 *     from the same reporter proves it (dropRecoveredFailures semantics);
 *   - everything the review neither resolved nor already reports goes to
 *     `residual`, never dropped: "picked up tomorrow morning".
 *
 * A row newer than the review whose key the review RESOLVED failed again after
 * the fix, so it is not dropped either.
 */
export async function reconcileWithReview(entries = [], healthIssues = [], review = {}, {
  needsDecision = [], flops = [], blockedDrafts = [], exec = null, crontabText = '',
  readRowsSince = null, deadline = null, now = Date.now, firstSeen = {},
  today = new Date().toISOString().slice(0, 10),
} = {}) {
  const keysOf = (arr) => new Set((Array.isArray(arr) ? arr : []).map((o) => o?.key).filter(Boolean));
  const resolvedKeys = keysOf(review?.resolved);
  const reported = new Set([...keysOf(review?.unresolved), ...keysOf(review?.onlyYou)]);
  const genAt = String(review?.generated_at || '');
  const isLate = (r) => String(r?.ts || '') > genAt;

  const residual = [];
  const fixedNow = [];
  const owed = new Set();
  const owe = (key, kind, subject, action, result, evidence = '') => {
    if (owed.has(key)) return;
    owed.add(key);
    residual.push({ key, kind, subject: subject || '', action, result, evidence: evidence || '', since: firstSeen?.[key] || today });
  };
  const snippet = (b) => previewBody(b, { maxLines: 2, maxChars: 200 });

  // ── error and warning rows (the reviewer reviews both; daily-summary's own
  // System health row is skipped: its issues are the health rows below)
  const errorRows = entries.filter(isReviewedProblem);
  const visibleErrors = [];
  const groups = new Map();
  for (const row of errorRows) {
    const key = itemKey(row);
    if (resolvedKeys.has(key) && !isLate(row)) continue; // the review fixed it
    visibleErrors.push(row);
    if (reported.has(key)) continue; // already "still being worked on"
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const jobs = parseCrontab(crontabText);
  const reruns = new Map();
  const recoveredRows = new Set();
  for (const [key, rows] of groups) {
    const row = [...rows].sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || ''))).at(-1);
    if (!rows.some(isLate)) {
      owe(key, 'failure', row.subject, 'none', `the overnight review did not handle this; ${TOMORROW}`, snippet(row.body));
      continue;
    }
    const tag = resolvedKeys.has(key) ? 'failed again after the overnight fix' : 'failed after the overnight review';
    const source = row.source || '';
    const kind = classifyRows(errorRows.filter((r) => itemKey(r) === key));
    if (kind !== 'transient' || !isRerunnable(source) || typeof exec !== 'function') {
      owe(key, 'failure', row.subject, 'none', `${tag}; ${TOMORROW}`, snippet(row.body));
      continue;
    }
    const left = deadline == null ? QUICK_RERUN_MAX_MS : deadline - now();
    if (left < QUICK_RERUN_MIN_MS) {
      owe(key, 'failure', row.subject, 're-run', `${tag}; no time left to re-run it this morning; ${TOMORROW}`, snippet(row.body));
      continue;
    }
    const command = jobs.get(source)?.command || `node ${source}`;
    let run = reruns.get(command);
    if (!run) {
      const startedAt = new Date(now()).toISOString();
      const [cmd, ...args] = splitCommand(command);
      let res;
      try { res = await exec(cmd, args, { timeout: Math.min(left, QUICK_RERUN_MAX_MS) }); } catch (e) { res = { code: 127, stderr: e.message }; }
      let later = [];
      if (typeof readRowsSince === 'function') { try { later = (await readRowsSince(startedAt)) || []; } catch { later = []; } }
      run = { res: res || {}, later };
      reruns.set(command, run);
    }
    const recovered = run.res.code === 0 && rows.every((r) => recoveredBy(r, run.later));
    if (recovered) {
      for (const r of rows) recoveredRows.add(r);
      fixedNow.push({ key, kind: 'failure', subject: row.subject || '', action: 're-run', result: `re-ran ${source} (recovered)`, evidence: command });
    } else {
      const why = run.res.timedOut ? 're-run timed out'
        : run.res.code !== 0 ? `re-run exited ${run.res.code}`
          : 're-ran (exit 0) but it wrote no success row';
      owe(key, 'failure', row.subject, 're-run', `${tag}; ${why}; ${TOMORROW}`, command);
    }
  }

  // ── health rows
  const visibleHealth = [];
  // checkSystemHealth() ran at 13:00: a row present now is broken now.
  for (const h of healthIssues) {
    const key = healthKey(h);
    visibleHealth.push(h);
    if (resolvedKeys.has(key)) owe(key, 'health', h.title, 'none', `broken again since the morning fix; ${TOMORROW}`, h.detail);
    else if (!reported.has(key)) owe(key, 'health', h.title, 'none', `not resolved overnight; ${TOMORROW}`, h.detail);
  }

  // ── decisions, flops, blocked drafts: whatever the review did not account for
  const skippedWhy = new Map((review?.skipped || []).map((s) => [s?.slug, s?.reason]));
  for (const it of buildReviewItems({ needsDecision, flops, blockedDrafts })) {
    if (it.route === 'count-only' || resolvedKeys.has(it.key) || reported.has(it.key)) continue;
    const reason = skippedWhy.get(it.row?.slug);
    if (isPermanentSkip(reason)) continue; // kept by policy: handled, never homework
    owe(it.key, it.kind, it.subject, 'none', reason ? `skipped overnight: ${reason}` : TOMORROW, it.detail);
  }

  return {
    visibleErrors: visibleErrors.filter((r) => !recoveredRows.has(r)),
    visibleHealth,
    residual,
    fixedNow,
  };
}

/** `Daily Recap — <date> (<n> fixed overnight[, <m> still being worked on][, <k> for you])`. */
export function reviewedSubject(targetDate, { fixed = 0, working = 0, forYou = 0 } = {}) {
  const parts = [];
  if (fixed || working || forYou) parts.push(`${fixed} fixed overnight`);
  if (working) parts.push(`${working} still being worked on`);
  if (forYou) parts.push(`${forYou} for you`);
  return `Daily Recap — ${targetDate} (${parts.length ? parts.join(', ') : 'all clear'})`;
}

/** The counts the subject line reports, from the review plus this morning's reconcile. */
/**
 * The review's resolved outcomes minus any key the 13:00 reconcile put back in
 * residual (a health issue or failure that broke again since the morning fix):
 * such an item renders only as "still being worked on", never also as fixed.
 */
function stillResolved(review, residual = []) {
  const back = new Set((Array.isArray(residual) ? residual : []).map((o) => o?.key));
  return (Array.isArray(review?.resolved) ? review.resolved : []).filter((o) => !back.has(o?.key));
}

export function reviewedCounts(review, { residual = [], fixedNow = [], onlyYouRows: you = [] } = {}, creatorItems = 0) {
  const resolved = stillResolved(review, residual).filter((o) => o?.action !== 'closed earlier' && o?.action !== 'kept');
  return {
    fixed: resolved.length + fixedNow.length,
    working: (review?.unresolved || []).length + residual.length,
    forYou: (review?.onlyYou || []).length + you.length + creatorItems,
  };
}

/**
 * Agents whose info rows can be work only Sean can do (DMs waiting on him,
 * offer codes that failed to send, press replies for him). Only rows that
 * state the ask count (statesAnAsk); the reviewed recap has no entries list,
 * so without this those asks would vanish.
 */
export const ONLY_YOU_SOURCES = Object.freeze(new Set([
  'agents/instagram-dm/index.js',
  'agents/press-outreach/index.js',
]));
const ONLY_YOU_SUBJECT = /waiting on you|needs a human|needs your/i;

/**
 * A row is an ask only when it SAYS so. A source on ONLY_YOU_SOURCES is not
 * enough: instagram-dm writes "0 waiting on you, N code(s) sent" every run and
 * press-outreach writes routine link/draft/follow-up summaries, and counting
 * those would keep the subject from ever reading "all clear".
 */
function statesAnAsk(r) {
  const subject = String(r.subject || '');
  if (r.source === 'agents/instagram-dm/index.js') {
    const m = subject.match(/(\d+)\s+waiting on you/i);
    if (m) return Number(m[1]) > 0;
    return /failed to send/i.test(subject);
  }
  return ONLY_YOU_SUBJECT.test(subject);
}

/**
 * Rows for "One thing only you can do": rows that state an ask (statesAnAsk),
 * newest per itemKey and count-free subject. Errors and warnings are the reviewer's
 * (they reach resolved/unresolved/onlyYou/residual), and a key the review
 * already reports is not repeated.
 */
export function onlyYouRows(entries = [], review = {}) {
  const taken = new Set(['resolved', 'unresolved', 'onlyYou', 'residual', 'fixedNow']
    .flatMap((b) => (Array.isArray(review?.[b]) ? review[b] : []).map((o) => o?.key)));
  const newest = new Map();
  for (const r of entries) {
    if (!r || r.status === 'error' || r.status === 'warning') continue;
    if (!statesAnAsk(r)) continue;
    if (taken.has(itemKey(r))) continue;
    // itemKey alone is the subject STEM ("instagram dms"), which would merge
    // "3 waiting on you" with "1 offer code(s) failed to send". Counts are
    // dropped so the same ask with a new number still collapses to the newest.
    const key = `${itemKey(r)}|${String(r.subject || '').replace(/\d+/g, '#').toLowerCase()}`;
    const cur = newest.get(key);
    if (!cur || String(r.ts || '') > String(cur.ts || '')) newest.set(key, r);
  }
  return [...newest.values()];
}

/**
 * Outcomes in a reviewer report that finished after the email that rendered it
 * (or all of them, when no email ever rendered it: the recap fell back while
 * the fix session was still running). Shown the next morning.
 */
export function lateFinishedOutcomes(report) {
  if (!report || typeof report !== 'object' || report.apply !== true) return [];
  const emailedAt = report.emailed === true ? String(report.emailed_at || '') : '';
  const out = [];
  for (const bucket of ['resolved', 'unresolved', 'onlyYou']) {
    for (const o of Array.isArray(report[bucket]) ? report[bucket] : []) {
      const at = String(o?.finished_at || '');
      if (!at || (emailedAt && at <= emailedAt)) continue;
      out.push({ ...o, bucket });
    }
  }
  return out;
}

const LATE_LABEL = { resolved: 'fixed', unresolved: 'still being worked on', onlyYou: 'only you can do this' };

function renderLateFinished(late, esc) {
  const list = Array.isArray(late) ? late : [];
  if (!list.length) return '';
  const e = (v) => esc(v == null ? '' : String(v));
  return `<div class="section-title" style="margin-top:12px;">Finished after yesterday's email</div>${list.map((o) => `<div class="entry"><span class="entry-subject">${e(o.subject)}</span>${o.result ? ` &mdash; ${e(o.result)}` : ''} <span class="entry-time">(${e(LATE_LABEL[o.bucket] || o.bucket)})</span></div>`).join('')}`;
}

/**
 * After a real send that rendered `review`: stamp emailed/emailed_at on its
 * latest.json and dated copy, read fresh from disk so the 13:00 reconcile
 * fields are never written back. A file from a different run is left alone.
 */
export function markReviewEmailed({ dir = REVIEWER_DIR, review, at = new Date().toISOString() }) {
  for (const name of ['latest.json', `${review?.date}.json`]) {
    const p = join(dir, name);
    try {
      const cur = JSON.parse(readFileSync(p, 'utf8'));
      if (cur?.generated_at !== review?.generated_at) continue;
      const tmp = `${p}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ ...cur, emailed: true, emailed_at: at }, null, 2)}\n`);
      renameSync(tmp, p);
    } catch { /* missing or unreadable: nothing to stamp */ }
  }
}

function renderReviewedRecap({ review, targetDate, styles, esc, dashboardUrl, entries, working, creatorReviewSection, lateBlock = '' }) {
  const e = (v) => esc(v == null ? '' : String(v));
  const h2 = (t) => `<h2 style="font-size:17px;margin:20px 0 8px 0;color:#111827;">${t}</h2>`;
  const muted = (t) => `<p class="empty">${t}</p>`;
  const line = (o, extra = '') => `<div class="entry"><span class="entry-subject">${e(o.subject)}</span>${o.result ? ` &mdash; ${e(o.result)}` : ''}${extra}</div>`;
  const list = (a) => (Array.isArray(a) ? a : []);

  // 1. What's working
  const resolved = stillResolved(review, review.residual);
  const fixed = [...resolved.filter((o) => o?.action !== 'closed earlier' && o?.action !== 'kept'), ...list(review.fixedNow)];
  const closedEarlier = resolved.filter((o) => o?.action === 'closed earlier');
  const kept = resolved.filter((o) => o?.action === 'kept');
  const shown = fixed.slice(0, FIXED_LINES_SHOWN).map((o) => line(o)).join('');
  const more = fixed.length > FIXED_LINES_SHOWN ? `<div class="entry-time">and ${fixed.length - FIXED_LINES_SHOWN} more</div>` : '';
  const earlier = closedEarlier.length
    ? `<p class="empty" style="margin-top:8px;">Closed on earlier runs (${closedEarlier.length}): ${closedEarlier.slice(0, FIXED_LINES_SHOWN).map((o) => e(o.subject)).join('; ')}${closedEarlier.length > FIXED_LINES_SHOWN ? `; and ${closedEarlier.length - FIXED_LINES_SHOWN} more` : ''}</p>`
    : '';
  const keptLine = (o) => `${e(o.subject)}: ${e(String(o.result || '').replace(/^kept:\s*/, ''))}`;
  const keptBlock = !kept.length ? ''
    : kept.length <= FIXED_LINES_SHOWN
      ? kept.map((o) => `<div class="entry"><span class="entry-subject">Kept: ${keptLine(o)}</span></div>`).join('')
      : `<p class="empty" style="margin-top:8px;">Kept (${kept.length}): ${kept.slice(0, FIXED_LINES_SHOWN).map(keptLine).join('; ')}; and ${kept.length - FIXED_LINES_SHOWN} more</p>`;
  const fixedSection = `<div class="section"><div class="section-title">&#128295; Fixed overnight</div>${fixed.length ? shown + more : muted('Nothing needed fixing overnight.')}${keptBlock}${earlier}${lateBlock}</div>`;

  // 2. How to grow
  const recs = list(review.growth?.recs);
  const growBody = recs.length
    ? recs.map((r) => `<div class="quick-win-row"><div class="qw-body"><div class="qw-title">${e(r.move)}</div>`
      + `<div class="qw-meta">${e(r.evidence)}</div>`
      + `<div class="qw-meta"><strong>$${e(r.dollars_low)}-$${e(r.dollars_high)} (directional)</strong> &middot; ${e(r.status)}</div></div></div>`).join('')
    : muted(e(review.growth?.reason || 'No growth recommendations this run.'));
  const growSection = `<div class="section quick-wins"><div class="section-title">&#127793; Recommendations</div>${growBody}</div>`;

  // 3. Still being worked on
  const working3 = [...list(review.unresolved), ...list(review.residual)];
  const workingSection = working3.length
    ? `<div class="section">${working3.map((o) => line(o, ` <span class="entry-time">(since ${e(o.since || targetDate)}${o.action && o.action !== 'none' ? `; tried: ${e(o.action)}` : ''})</span>`)).join('')}</div>`
    : '';

  // 4. One thing only you can do
  const onlyYou = list(review.onlyYou);
  const asks = onlyYouRows(entries, review).map((r) => `<div class="entry"><span class="entry-subject">${e(r.subject)}</span>${r.body ? `<div class="blockers">${e(previewBody(r.body, { maxLines: 4, maxChars: 400 }))}</div>` : ''}</div>`);
  const youRows = onlyYou.length || asks.length
    ? `<div class="section">${onlyYou.map((o) => line(o, o.since ? ` <span class="entry-time">(since ${e(o.since)})</span>` : '')).join('')}${asks.join('')}</div>`
    : '';
  const youSection = youRows || creatorReviewSection ? `${youRows}${creatorReviewSection || ''}` : '';

  return `<!DOCTYPE html>
<html><head><style>${styles}</style></head><body>
  <h1>Daily Recap</h1>
  <div class="date">${targetDate}</div>
  ${h2("What's working")}
  ${[fixedSection, ...working].join('\n  ')}
  ${h2('How to grow')}
  ${growSection}
  ${workingSection ? `${h2('Still being worked on')}\n  ${workingSection}` : ''}
  ${youSection ? `${h2('One thing only you can do')}\n  ${youSection}` : ''}
  <div class="footer">${entries.length} task${entries.length !== 1 ? 's' : ''} ran &middot; <a href="${esc(dashboardUrl)}" style="color:#6b7280;">Full activity on dashboard &rarr;</a></div>
</body></html>`;
}

function readReviewerFile(name) {
  const p = join(REVIEWER_DIR, name);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function readJsonlRows(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

/** Digest rows written after `iso`, read fresh from the day files (for the quick pass). */
function readRowsSince(iso) {
  const rows = [];
  for (const day of daysBetween(iso.slice(0, 10), new Date().toISOString().slice(0, 10))) {
    rows.push(...readJsonlRows(join(DAILY_SUMMARY_DIR, `${day}.jsonl`)));
  }
  return rows.filter((r) => String(r.ts || '') > iso);
}

const LAST_SENT_PATH = () => join(DAILY_SUMMARY_DIR, 'last-sent.json');
function readLastSent() {
  try { return JSON.parse(readFileSync(LAST_SENT_PATH(), 'utf8')).until || null; } catch { return null; }
}
function writeLastSent(until) {
  try { writeFileSync(LAST_SENT_PATH(), JSON.stringify({ until }, null, 2) + '\n'); }
  catch (err) { log(`could not record the digest window end: ${err.message}`); }
}

// The four reports whose `needs_decision[]` rows the recap renders, and the
// entry script that wrote each. Rows carry no `source` of their own, so it is
// stamped from the file they came from: the recap reviewer routes on it (an
// amazon-account-health row is Sean's; a queue row is regenerated).
export const NEEDS_DECISION_REPORTS = Object.freeze([
  { path: ['data', 'reports', 'queue-autoapply', 'latest.json'], source: 'agents/queue-autoapply/index.js' },
  { path: ['data', 'reports', 'indexing-fixer', 'latest.json'], source: 'agents/indexing-fixer/index.js' },
  { path: ['data', 'reports', 'content-strategist', 'latest.json'], source: 'agents/content-strategist/index.js' },
  { path: ['data', 'reports', 'amazon-account-health', 'latest.json'], source: 'agents/amazon-account-health/index.js' },
]);

export function stampDecisionRows(report, source) {
  return (Array.isArray(report?.needs_decision) ? report.needs_decision : [])
    .map((d) => ({ ...d, source: d?.source || source }));
}

function loadNeedsDecision(dataRoot = ROOT) {
  return NEEDS_DECISION_REPORTS.flatMap((r) => {
    const p = join(dataRoot, ...r.path);
    if (!existsSync(p)) return [];
    try { return stampDecisionRows(JSON.parse(readFileSync(p, 'utf8')), r.source); } catch { return []; }
  });
}

/**
 * Everything the recap reads, gathered ONCE so the recap reviewer
 * (agents/recap-reviewer) and the recap work from the same item list rather
 * than two copies that drift.
 *
 * @param {{ now?: Date, readLastSent?: () => string|null, date?: string|null, log?: Function }} [opts]
 *   `date` is the old `--date` whole-calendar-day view; without it the window is
 *   everything since the last real send, up to `now`.
 */
export function collectDigestInputs({ now = new Date(), readLastSent: lastSent = readLastSent, date = null, log: say = () => {} } = {}) {
  let targetDate = date;
  if (!targetDate) {
    const yesterday = new Date(now.getTime());
    yesterday.setDate(yesterday.getDate() - 1);
    targetDate = yesterday.toISOString().slice(0, 10);
  }

  const digestFile = join(DAILY_SUMMARY_DIR, `${targetDate}.jsonl`);

  const readRows = (file) => (existsSync(file)
    ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : []);
  // WHICH ROWS: everything written since the last digest was sent, up to now.
  // Reading only the calendar day before meant anything written between midnight
  // and the 13:00 UTC send (the 12:20-12:50 gates, trybe-review at 12:55) reached
  // Sean a DAY late: on 2026-10-04 he got the previous morning's Trybe review,
  // without the verdicts, while that morning's sat in a file nobody read yet.
  // `--date` keeps the old whole-calendar-day view for inspecting a past day.
  const nowIso = now.toISOString();
  let entries;
  const laterRows = [];
  let windowUntil = null;
  if (date) {
    entries = readRows(digestFile);
    for (let d = new Date(`${targetDate}T00:00:00Z`); ;) {
      d = new Date(d.getTime() + 86_400_000);
      const day = d.toISOString().slice(0, 10);
      if (day > nowIso.slice(0, 10)) break;
      laterRows.push(...readRows(join(DAILY_SUMMARY_DIR, `${day}.jsonl`)));
    }
  } else {
    const since = lastSent() || `${targetDate}T00:00:00.000Z`;
    windowUntil = nowIso;
    entries = [];
    for (const day of daysBetween(since.slice(0, 10), nowIso.slice(0, 10))) {
      entries.push(...readRows(join(DAILY_SUMMARY_DIR, `${day}.jsonl`)));
    }
    entries = rowsInWindow(entries, { since, until: windowUntil });
    say(`Digest window: ${since} → ${windowUntil} (${entries.length} rows)`);
  }

  // A failure that a later run of the same agent has already recovered from is
  // not news (Sean, 2026-10-04): drop it before anything counts or renders it.
  // See lib/digest-recovery.js.
  const { kept, recovered } = dropRecoveredFailures(entries, laterRows);

  return {
    targetDate,
    windowUntil,
    entries: kept,
    recovered,
    laterRows,
    // Posts hard-blocked in the editorial gate (regardless of date — these are always surfaced until resolved)
    blockedPosts: findBlockedPosts(),
    postPerformance: loadPostPerformance(),
    // System-health check — stale/missing data feeds and leftover stashes.
    healthIssues: checkSystemHealth(),
    needsDecision: loadNeedsDecision(),
  };
}

async function main() {
  const preview = process.argv.includes('--preview');
  // Default to yesterday's date (runs at 5 AM, reporting on previous day)
  const dateArg = process.argv.indexOf('--date');
  const today = new Date().toISOString().slice(0, 10);

  // The overnight reviewer (agents/recap-reviewer, 11:05 UTC) should long be
  // done by 13:00; if it is not, wait for today's done.json for up to 30
  // minutes. --preview never waits, and a --date inspection of a past day is
  // not reviewed at all.
  let deadline = Date.now() + REVIEW_WAIT_MS;
  if (dateArg === -1 && !preview) {
    const w = await waitForReview({
      poll: () => { try { return readReviewerFile('done.json')?.date === today; } catch { return false; } },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    });
    deadline = w.deadline;
    log(w.ready ? `Recap reviewer done (waited ${Math.round(w.waitedMs / 1000)}s).` : 'Recap reviewer not done after 30 minutes; sending the unreviewed recap.');
  }

  const {
    targetDate, windowUntil, entries, recovered, blockedPosts, postPerformance, healthIssues, needsDecision,
  } = collectDigestInputs({
    // `--date` with no value keeps the old behaviour: yesterday, whole-day view.
    date: dateArg === -1 ? null
      : (process.argv[dateArg + 1] || new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)),
    log,
  });
  if (recovered.length) log(`Dropped ${recovered.length} failure(s) that later recovered: ${[...new Set(recovered.map(e => e.subject))].join('; ')}`);

  // undefined = not applicable (--date); null = should have run and did not.
  let review;
  if (dateArg === -1) {
    review = loadReview({ today, read: readReviewerFile });
    if (!review) log('No valid review for today (missing, stale, crashed or dry run): falling back to the unreviewed recap.');
  }

  let reconciled = null;
  if (review) {
    let crontabText = '';
    if (!preview) { try { crontabText = execSync('crontab -l', { encoding: 'utf8' }); } catch { crontabText = ''; } }
    let firstSeen = {};
    try { firstSeen = loadReviewerState().firstSeen || {}; } catch { firstSeen = {}; }
    const { makeExec } = await import('../recap-reviewer/exec.js');
    reconciled = await reconcileWithReview(entries, healthIssues, review, {
      needsDecision,
      flops: postPerformance?.action_required || [],
      blockedDrafts: blockedPosts,
      // --preview never re-runs anything: late rows read as residual.
      exec: preview ? null : makeExec({ root: ROOT }),
      crontabText, readRowsSince, deadline, firstSeen, today,
    });
    log(`Reviewed recap: ${review.resolved?.length || 0} resolved, ${reconciled.fixedNow.length} fixed now, ${(review.unresolved?.length || 0) + reconciled.residual.length} still being worked on, ${review.onlyYou?.length || 0} only-you.`);
  }

  // Find pipeline images generated on the target date
  const pipelineImages = findPipelineImages(targetDate);

  // Load latest quick-win targets from data/reports/quick-wins/latest.json
  const quickWins = loadQuickWinTargets();
  const seoImpact = loadSeoImpact();
  const prioritizer = loadPrioritizer();

  const gscOpps = loadGscOpportunities();
  const competitors = loadCompetitorActivity();

  // If nothing happened at all, still send a "quiet day" email.
  // A pending performance-queue used to count as "something happened" here.
  // It no longer does: queue-autoapply drains that queue two hours after this
  // runs, so a queue-only day has nothing to show a human and must fall through
  // to the quiet-day copy rather than emailing an empty shell.
  if (!entries.length && !pipelineImages.length && !blockedPosts.length && !(quickWins?.top?.length) && !(postPerformance?.action_required?.length)) {
    log(`No activity for ${targetDate} — sending quiet day summary.`);
  } else {
    log(`Sending daily summary for ${targetDate}: ${entries.length} entries, ${pipelineImages.length} images, ${blockedPosts.length} blocked, ${quickWins?.top?.length || 0} quick-wins.`);
  }

  const env = loadEnv();
  const dashboardUrl = process.env.DASHBOARD_URL || env.DASHBOARD_URL || 'http://137.184.119.230:4242';

  // System-health check — stale/missing data feeds and leftover stashes. Raised
  // as an error row (it renders in the digest; it does not escalate). Every
  // issue present at 13:00 is raised, including one the overnight reviewer
  // fixed that has broken again since.
  const healthAlerts = healthIssuesToNotify(healthIssues);
  if (healthAlerts.length) {
    log(`System health: ${healthAlerts.length} issue(s) — ${healthAlerts.map(i => i.title).join('; ')}`);
    await notify({
      subject: `⚠️ System health: ${healthAlerts.length} issue${healthAlerts.length > 1 ? 's' : ''}`,
      body: healthAlerts.map(i => `- ${i.title}\n  ${i.detail}`).join('\n\n'),
      status: 'error',
      category: 'ops',
    }).catch(() => {});
  }

  // Work the reviewer finished after yesterday's email (a fix session running
  // past 13:00, or a day the recap fell back) is reported this morning.
  let lateFinished = [];
  if (dateArg === -1) {
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    try { lateFinished = lateFinishedOutcomes(readReviewerFile(`${yesterday}.json`)); } catch { lateFinished = []; }
    if (lateFinished.length) log(`${lateFinished.length} reviewer outcome(s) finished after yesterday's email.`);
  }

  const reviewArg = review ? { ...review, residual: reconciled.residual, fixedNow: reconciled.fixedNow } : review;
  const html = buildDigestHtml(targetDate, entries, pipelineImages, blockedPosts, quickWins, postPerformance, gscOpps, competitors, dashboardUrl, healthIssues, seoImpact, prioritizer, { lateFinished }, reviewArg);

  let subject;
  if (review) {
    subject = reviewedSubject(targetDate, reviewedCounts(review, { ...reconciled, onlyYouRows: onlyYouRows(entries, reviewArg) }, awaitingSubmissions(entries).items.length));
  } else {
    const visibleCount = entries.filter(e => !isSilentSuccess(e)).length;
    const imageCount = pipelineImages.length;
    const parts = [];
    if (blockedPosts.length > 0) parts.push(`${blockedPosts.length} BLOCKED`);
    // Only flops a human must decide count in the subject; the automated ones
    // are the fleet working, not news.
    const flopCount = (postPerformance?.action_required || []).filter((f) => f.automated !== true).length;
    if (flopCount > 0) parts.push(`${flopCount} flop${flopCount > 1 ? 's' : ''} to decide`);
    const toReview = awaitingSubmissions(entries).items.length;
    if (toReview > 0) parts.push(`${toReview} creator submission${toReview > 1 ? 's' : ''} to review`);
    if (visibleCount > 0) parts.push(`${visibleCount} update${visibleCount > 1 ? 's' : ''}`);
    if (imageCount > 0) parts.push(`${imageCount} image${imageCount > 1 ? 's' : ''}`);
    const subtitle = parts.length > 0 ? parts.join(', ') : 'all clear';
    // An unreviewed recap must never read as an all-clear, subject included.
    subject = `Daily Recap — ${targetDate} (${review === null ? `unreviewed: ${subtitle}` : subtitle})`;
  }

  // --preview: write the rendered HTML to a file and skip sending. Lets us eyeball
  // the digest against real data without emailing.
  if (preview) {
    const outPath = join(ROOT, 'data', 'reports', 'daily-summary', `preview-${targetDate}.html`);
    writeFileSync(outPath, html);
    log(`Preview written (not sent): ${outPath}`);
    log(`Subject: ${subject}`);
    return;
  }

  await sendHtmlEmail(subject, html);

  // Only a real send advances the window; a preview or a --date run never does.
  if (windowUntil) writeLastSent(windowUntil);
  // Anything the reviewer finishes after this moment is shown tomorrow.
  if (review) markReviewEmailed({ review });
  log('Daily summary sent.');
}

// Only run when invoked directly (so tests can import previewBody/buildDigestHtml
// without sending an email).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => {
    log(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
