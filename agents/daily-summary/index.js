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
 * Usage:
 *   node agents/daily-summary/index.js
 *   node agents/daily-summary/index.js --date 2026-04-03  (specific date)
 *
 * Cron (server) — 5:00 AM PST (13:00 UTC):
 *   0 13 * * * cd ~/seo-claude && node agents/daily-summary/index.js >> data/logs/daily-summary.log 2>&1
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendHtmlEmail } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const DAILY_SUMMARY_DIR = join(ROOT, 'data', 'reports', 'daily-summary');
const POSTS_DIR = join(ROOT, 'data', 'posts');
const LOG_DIR = join(ROOT, 'data', 'logs');

// Collector/snapshot agents — suppress their success entries from the digest
const SILENT_ON_SUCCESS = new Set([
  'clarity', 'shopify', 'gsc', 'ga4', 'google-ads', 'google ads',
  'blog-index', 'blog index', 'topical map', 'topical-map',
  'insight aggregator', 'insight-aggregator',
  'meta a/b', 'meta-ab',
]);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(join(LOG_DIR, 'daily-summary.log'), line + '\n');
  } catch { /* ignore */ }
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
  if (s.includes('rank') || s.includes('ahrefs')) return 'seo';

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
 * Find posts that are hard-blocked in the editorial gate.
 * Scans data/reports/editor/*.md for "Needs Work" verdicts and extracts blocker reasons.
 * Only includes posts whose HTML exists but have not been published/scheduled.
 */
function findBlockedPosts() {
  const editorDir = join(ROOT, 'data', 'reports', 'editor');
  if (!existsSync(editorDir)) return [];

  const blocked = [];
  const files = readdirSync(editorDir).filter(f => f.endsWith('-editor-report.md'));

  for (const file of files) {
    try {
      const report = readFileSync(join(editorDir, file), 'utf8');
      if (!/VERDICT[:*\s]*Needs Work/i.test(report)) continue;

      const slug = file.replace('-editor-report.md', '');
      const postJson = join(POSTS_DIR, `${slug}.json`);
      if (!existsSync(postJson)) continue;

      const meta = JSON.parse(readFileSync(postJson, 'utf8'));
      // Skip if already published or scheduled — only flag truly stuck posts
      if (meta.shopify_status === 'published' || meta.shopify_status === 'scheduled') continue;

      // Extract the blocker reasons section
      const blockersMatch = report.match(/##[^\n]*BLOCKER[^\n]*\n([\s\S]*?)(?=\n##|\n---|$)/i);
      const blockerText = blockersMatch ? blockersMatch[1].trim().slice(0, 600) : 'See editor report for details.';

      blocked.push({
        title: meta.title || slug,
        slug,
        blockers: blockerText,
        reportPath: `data/reports/editor/${file}`,
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
  if (!existsSync(POSTS_DIR)) return [];

  const images = [];
  const files = readdirSync(POSTS_DIR).filter(f => f.endsWith('.json'));

  for (const file of files) {
    try {
      const meta = JSON.parse(readFileSync(join(POSTS_DIR, file), 'utf8'));
      const genDate = (meta.image_generated_at || '').slice(0, 10);
      if (genDate !== targetDate) continue;

      images.push({
        title: meta.title || meta.slug || file,
        slug: meta.slug || file.replace('.json', ''),
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

function loadPerformanceQueue() {
  const queueDir = join(ROOT, 'data', 'performance-queue');
  if (!existsSync(queueDir)) return [];
  try {
    return readdirSync(queueDir)
      .filter(f => f.endsWith('.json') && f !== 'indexing-submissions.json')
      .map(f => { try { return JSON.parse(readFileSync(join(queueDir, f), 'utf8')); } catch { return null; } })
      .filter(i => i && i.status === 'pending')
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  } catch { return []; }
}

/**
 * Build the HTML email body.
 */
function buildDigestHtml(targetDate, entries, pipelineImages, blockedPosts, quickWins, postPerformance, gscOpps, competitors, perfQueue, dashboardUrl) {
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
    .entry-body { color: #6b7280; font-size: 12px; white-space: pre-wrap; margin-top: 2px; max-height: 120px; overflow: hidden; }
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
      const bodyPreview = e.body ? `<div class="entry-body">${esc(e.body.slice(0, 500))}</div>` : '';
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

  // Post performance flops — surfaced as Action Required (below blockers, above quick-wins)
  let flopSection = '';
  const flops = (postPerformance && postPerformance.action_required) || [];
  if (flops.length > 0) {
    const cards = flops.map((f) => `
      <div class="blocked-post">
        <div class="title">${esc(f.title || f.slug)} &mdash; ${esc(f.verdict)} (${f.milestone}d)</div>
        <div class="blockers">${esc(f.reason || '')}</div>
        <div class="report-link">data/reports/post-performance/${esc(f.slug)}-${f.milestone}d.md</div>
      </div>`).join('');
    flopSection = `
      <div class="action-required">
        <div class="section-title">&#9888;&#65039; Action Required &mdash; ${flops.length} underperforming post${flops.length > 1 ? 's' : ''}</div>
        <p style="font-size:12px;color:#6b7280;margin:0 0 12px 0;">Posts that have failed a 30/60/90 day performance check. Investigate (BLOCKED), refresh (REFRESH), or retire (DEMOTE).</p>
        ${cards}
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

  // Optimization queue — items from the performance engine awaiting review
  let queueSection = '';
  if (perfQueue && perfQueue.length > 0) {
    const rows = perfQueue.map(i => {
      const triggerLabel = { 'flop-refresh': 'Refresh (flop)', 'quick-win': 'Quick win', 'low-ctr-meta': 'Meta rewrite' }[i.trigger] || i.trigger;
      return `
        <div style="background:white;border:1px solid #c7d2fe;border-radius:8px;padding:14px 16px;margin-bottom:12px;">
          <div style="font-size:10px;font-weight:700;color:#4338ca;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px;">${esc(triggerLabel)}</div>
          <div style="font-size:14px;font-weight:700;color:#1f2937;margin-bottom:8px;">${esc(i.title)}</div>
          <div style="font-size:12px;color:#374151;line-height:1.5;">
            <p style="margin:4px 0;"><strong>What changed:</strong> ${esc(i.summary?.what_changed || '')}</p>
            <p style="margin:4px 0;"><strong>Why:</strong> ${esc(i.summary?.why || '')}</p>
            <p style="margin:4px 0;"><strong>Projected impact:</strong> ${esc(i.summary?.projected_impact || '')}</p>
          </div>
          <a href="${esc(dashboardUrl)}/#optimize" style="display:inline-block;margin-top:8px;padding:6px 12px;background:#6366f1;color:white;text-decoration:none;border-radius:6px;font-size:12px;font-weight:600;">Review on dashboard &rarr;</a>
        </div>`;
    }).join('');
    queueSection = `
      <div class="section" style="background:#eef2ff;border:1px solid #c7d2fe;">
        <div class="section-title" style="color:#312e81;border-bottom-color:#c7d2fe;">&#9881;&#65039; Optimization Queue &mdash; ${perfQueue.length} item${perfQueue.length > 1 ? 's' : ''} ready for review</div>
        <p style="font-size:12px;color:#6b7280;margin:0 0 12px 0;">The performance engine ran overnight and refreshed these posts. Approve on the dashboard to push the updated content to Shopify.</p>
        ${rows}
      </div>`;
  }

  // Reviews section — surfaces new reviews from review-monitor
  let reviewSection = '';
  const reviewPath = join(ROOT, 'data', 'reports', 'reviews', 'latest.json');
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

  const nothingToReport = !queueSection && !flopSection && !performanceSection && !gscSection && !competitorSection && !blockedSection && !quickWinSection && !pipelineSection && !imageSection && !adsSection && !seoSection && !otherSection && !reviewSection;

  return `<!DOCTYPE html>
<html><head><style>${styles}</style></head><body>
  <h1>Daily Recap</h1>
  <div class="date">${targetDate}${suppressed > 0 ? ` &middot; ${suppressed} routine task${suppressed > 1 ? 's' : ''} ran normally` : ''}</div>
  ${nothingToReport ? '<div class="section"><p class="empty">All systems ran normally yesterday. Nothing requires attention.</p></div>' : ''}
  ${reviewSection}
  ${queueSection}
  ${blockedSection}
  ${flopSection}
  ${performanceSection}
  ${gscSection}
  ${competitorSection}
  ${quickWinSection}
  ${pipelineSection}
  ${imageSection}
  ${adsSection}
  ${seoSection}
  ${otherSection}
  <div class="footer"><a href="${esc(dashboardUrl)}" style="color:#6b7280;">Open Dashboard</a></div>
</body></html>`;
}

async function main() {
  // Default to yesterday's date (runs at 5 AM, reporting on previous day)
  const dateArg = process.argv.indexOf('--date');
  let targetDate;
  if (dateArg !== -1 && process.argv[dateArg + 1]) {
    targetDate = process.argv[dateArg + 1];
  } else {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    targetDate = yesterday.toISOString().slice(0, 10);
  }

  const digestFile = join(DAILY_SUMMARY_DIR, `${targetDate}.jsonl`);

  let entries = [];
  if (existsSync(digestFile)) {
    const lines = readFileSync(digestFile, 'utf8').trim().split('\n').filter(Boolean);
    entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }

  // Find pipeline images generated on the target date
  const pipelineImages = findPipelineImages(targetDate);

  // Find posts hard-blocked in the editorial gate (regardless of date — these are always surfaced until resolved)
  const blockedPosts = findBlockedPosts();

  // Load latest quick-win targets from data/reports/quick-wins/latest.json
  const quickWins = loadQuickWinTargets();

  // Load latest post-performance review output
  const postPerformance = loadPostPerformance();
  const gscOpps = loadGscOpportunities();
  const competitors = loadCompetitorActivity();
  const perfQueue = loadPerformanceQueue();

  // If nothing happened at all, still send a "quiet day" email
  if (!entries.length && !pipelineImages.length && !blockedPosts.length && !(quickWins?.top?.length) && !(postPerformance?.action_required?.length) && !perfQueue.length) {
    log(`No activity for ${targetDate} — sending quiet day summary.`);
  } else {
    log(`Sending daily summary for ${targetDate}: ${entries.length} entries, ${pipelineImages.length} images, ${blockedPosts.length} blocked, ${quickWins?.top?.length || 0} quick-wins.`);
  }

  const env = loadEnv();
  const dashboardUrl = process.env.DASHBOARD_URL || env.DASHBOARD_URL || 'http://137.184.119.230:4242';

  const html = buildDigestHtml(targetDate, entries, pipelineImages, blockedPosts, quickWins, postPerformance, gscOpps, competitors, perfQueue, dashboardUrl);

  const visibleCount = entries.filter(e => !isSilentSuccess(e)).length;
  const imageCount = pipelineImages.length;
  const parts = [];
  if (blockedPosts.length > 0) parts.push(`${blockedPosts.length} BLOCKED`);
  const flopCount = postPerformance?.action_required?.length || 0;
  if (flopCount > 0) parts.push(`${flopCount} flop${flopCount > 1 ? 's' : ''}`);
  if (visibleCount > 0) parts.push(`${visibleCount} update${visibleCount > 1 ? 's' : ''}`);
  if (imageCount > 0) parts.push(`${imageCount} image${imageCount > 1 ? 's' : ''}`);
  const subtitle = parts.length > 0 ? parts.join(', ') : 'all clear';

  await sendHtmlEmail(
    `Daily Recap — ${targetDate} (${subtitle})`,
    html,
  );

  log('Daily summary sent.');
}

main().catch(err => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
