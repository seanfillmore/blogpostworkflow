#!/usr/bin/env node
/**
 * Pipeline Prioritizer
 *
 * Makes the content queue signal-aware. Reads the signal latest.json reports,
 * normalizes them, scores the idea backlog, injects new ideas, and promotes the
 * top ideas just-in-time to keep a small write buffer full — all behind SEO
 * best-practice guardrails. Auto-applies strong signals; surfaces weak ones in
 * the daily digest.
 *
 * The decision logic lives in lib/pipeline-priority.js (pure, unit-tested). This
 * file is the I/O glue: read reports → normalize → computePlan → apply to
 * calendar.json → write report + digest.
 *
 * Usage:
 *   node agents/pipeline-prioritizer/index.js            # apply
 *   node agents/pipeline-prioritizer/index.js --dry-run  # print plan, write nothing
 *
 * See docs/superpowers/specs/2026-06-13-pipeline-prioritizer-design.md
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCalendar, upsertItem, writeCalendar } from '../../lib/calendar-store.js';
import { listAllSlugs, getPostMeta } from '../../lib/posts.js';
import { newestReportDate } from '../../lib/snapshot-health.js';
import { computePlan, applyHysteresis } from '../../lib/pipeline-priority.js';
import { slugify } from '../../lib/keyword-dedup.js';
import { isInProductScope } from '../../lib/product-scope.js';
import { getSearchVolume } from '../../lib/dataforseo.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'pipeline-prioritizer');
const SIGNAL_STATE_PATH = join(REPORTS_DIR, 'signal-state.json');
const DRY_RUN = process.argv.includes('--dry-run');

const cfg = JSON.parse(readFileSync(join(ROOT, 'config', 'pipeline-priority.json'), 'utf8'));
const ymd = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }
function reportPath(name) { return join(ROOT, 'data', 'reports', name, 'latest.json'); }
function rejections() { return readJson(join(ROOT, 'data', 'rejected-keywords.json')) || []; }

// ── signal freshness guard ──────────────────────────────────────────────────
function fresh(name, maxAgeDays, today) {
  const d = newestReportDate(reportPath(name));
  if (!d) return false;
  const age = Math.floor((Date.parse(today) - Date.parse(d)) / 86400000);
  return age <= maxAgeDays;
}

// ── map a keyword to an existing post slug (for refresh signals) ─────────────
function slugForKeyword(keyword) {
  const target = keyword.toLowerCase();
  for (const slug of listAllSlugs()) {
    const meta = getPostMeta(slug);
    if (meta?.target_keyword?.toLowerCase() === target) return slug;
  }
  return null;
}

// Re-pull current volume for a keyword at promotion time. Returns the live
// monthly volume (number) or null if unavailable. Single keyword → one cheap call.
async function currentVolume(keyword) {
  try {
    const [row] = await getSearchVolume([keyword]);
    return row?.volume ?? null;
  } catch { return null; }
}

// ── adapters: on-disk report → normalized signals ───────────────────────────
function collectSignals(today) {
  const out = [];

  // 1) surging unmapped queries → inject NEW
  if (fresh('gsc-opportunity', 5, today)) {
    const g = readJson(reportPath('gsc-opportunity'));
    for (const u of (g?.unmapped || [])) {
      if ((u.impressions || 0) < cfg.signals.unmapped.minImpressions) continue;
      out.push({ type: 'unmapped', key: u.keyword, taskType: 'new', cluster: null,
        targetSlug: null, strength: u.impressions, label: `unmapped ${u.impressions} impr`,
        raw: { position: u.position } });
    }
  }

  // 2) revenue-growth clusters → boost NEW ideas in cluster
  if (fresh('seo-impact', 3, today)) {
    const s = readJson(reportPath('seo-impact'));
    for (const c of (s?.clusters || [])) {
      if ((c.revenueDelta || 0) < cfg.signals.revenue_cluster.minDelta) continue;
      out.push({ type: 'revenue_cluster', key: c.cluster, taskType: 'new',
        cluster: String(c.cluster).toLowerCase(), targetSlug: null,
        strength: c.revenueDelta, label: `revenue +$${Math.round(c.revenueDelta)}`,
        raw: { revenue: c.revenue } });
    }
  }

  // 3) rank/traffic drops → REFRESH that post
  if (fresh('rank-alerter', 3, today)) {
    const r = readJson(reportPath('rank-alerter'));
    for (const d of (r?.drops || [])) {
      const slug = slugForKeyword(d.query);
      if (!slug) continue; // can't refresh a post we don't have
      const meta = getPostMeta(slug);
      out.push({ type: 'rank_drop', key: d.query, taskType: 'refresh',
        cluster: (meta?.category || '').toLowerCase() || null, targetSlug: slug,
        strength: d.delta, label: `rank-drop ${d.delta} pos`, raw: { from: d.from, to: d.to } });
    }
  }

  // 4) competitor + AI-citation gaps
  if (fresh('competitor-watcher', 8, today)) {
    const cw = readJson(reportPath('competitor-watcher'));
    for (const p of (cw?.new_posts || [])) {
      const cluster = (p.clusters && p.clusters[0]) ? String(p.clusters[0]).toLowerCase() : null;
      out.push({ type: 'competitor_gap', key: p.title || p.url, taskType: 'new',
        cluster, targetSlug: null, strength: 1, label: `competitor: ${p.domain || 'rival'}` });
    }
  }
  if (fresh('ai-citations', 8, today)) {
    const ai = readJson(reportPath('ai-citations'));
    for (const res of (ai?.results || [])) {
      const gap = Object.values(res.responses || {}).some((r) => r.mentioned === true && r.cited === false);
      if (!gap) continue;
      const slug = slugForKeyword(res.prompt);
      out.push({ type: 'ai_gap', key: res.prompt, taskType: slug ? 'refresh' : 'new',
        cluster: null, targetSlug: slug, strength: 1, label: 'AI mentioned-not-cited' });
    }
  }

  // Guardrail #8: an inject-capable signal (would create a NEW post) must be in
  // product scope. Refresh signals target existing in-scope posts, so they pass.
  return out.filter((s) => {
    const wouldInject = (s.taskType === 'new') && !s.targetSlug && s.type !== 'revenue_cluster';
    return !wouldInject || isInProductScope(s.key);
  });
}

// ── build the covered index + recency maps from disk ────────────────────────
function buildContext(calendar, today) {
  const covered = new Set();
  const clusterRecent = {};
  const refreshRecent = {};

  for (const it of calendar.items) {
    covered.add((it.keyword || '').toLowerCase());
    covered.add(it.slug);
    if (it.publish_date && it.source !== 'refresh') {
      const cl = (it.category || it.topical_hub || '').toLowerCase();
      if (cl) (clusterRecent[cl] ||= []).push(ymd(it.publish_date));
    }
  }
  for (const slug of listAllSlugs()) {
    covered.add(slug);
    const meta = getPostMeta(slug);
    if (meta?.target_keyword) covered.add(meta.target_keyword.toLowerCase());
    if (meta?.last_refreshed_at) refreshRecent[slug] = ymd(meta.last_refreshed_at);
    const cl = (meta?.category || '').toLowerCase();
    if (cl && meta?.published_at) (clusterRecent[cl] ||= []).push(ymd(meta.published_at));
  }
  return { covered, clusterRecent, refreshRecent };
}

// item status (mirrors calendar-runner's getItemStatus, simplified for buffer count)
function statusOf(item) {
  const meta = getPostMeta(item.slug);
  if (meta?.shopify_status === 'published') return 'published';
  if (meta?.shopify_publish_at) return 'scheduled';
  if (meta?.shopify_article_id) return 'draft';
  const briefPath = join(ROOT, 'data', 'briefs', `${item.slug}.json`);
  if (existsSync(join(ROOT, 'data', 'posts', item.slug, 'content.html'))) return 'written';
  if (existsSync(briefPath)) return 'briefed';
  return 'pending';
}

async function main() {
  console.log('\nPipeline Prioritizer' + (DRY_RUN ? ' (dry-run)' : '') + '\n');
  const today = ymd(Date.now());
  const now = new Date();

  const calendar = loadCalendar();
  const { covered, clusterRecent, refreshRecent } = buildContext(calendar, today);

  // partition: backlog ideas = pending items with no publish_date
  const backlog = [];
  let bufferReady = 0;
  const takenSlots = new Set();
  for (const it of calendar.items) {
    const st = statusOf(it);
    if (['written', 'scheduled', 'draft', 'briefed'].includes(st)) bufferReady++;
    if (it.publish_date) takenSlots.add(ymd(it.publish_date));
    if (st === 'pending' && !it.publish_date) {
      backlog.push({
        slug: it.slug, keyword: it.keyword,
        cluster: (it.category || it.topical_hub || '').toLowerCase() || null,
        volume: it.volume, kd: it.kd, search_intent: it.search_intent || 'commercial',
        task_type: it.source === 'refresh' ? 'refresh' : 'new',
        source: it.source, status_override: it.status_override || null,
      });
    }
  }

  // hysteresis
  const rawSignals = collectSignals(today);
  const prevState = readJson(SIGNAL_STATE_PATH) || {};
  const { active, state } = applyHysteresis(rawSignals, prevState, today, cfg);
  console.log(`  Signals: ${rawSignals.length} raw → ${active.length} active (after hysteresis)`);
  console.log(`  Backlog ideas: ${backlog.length} | buffer ready: ${bufferReady}/${cfg.buffer.target}`);

  const plan = computePlan({
    backlog, signals: active, bufferReady, takenSlots, clusterRecent, refreshRecent,
    coveredIndex: covered, rejections: rejections(), today, now, cfg,
  });

  // ── report payload ──
  const generated_at = new Date().toISOString();
  const payload = {
    generated_at,
    backlog_depth: backlog.length + plan.injections.length,
    buffer_ready: bufferReady,
    buffer_target: cfg.buffer.target,
    injections: plan.injections.map((i) => ({ slug: i.slug, keyword: i.keyword, source: i.source, priority_score: i.priority_score, why: i.priority_provenance })),
    promotions: plan.promotions,
    top_backlog: [...plan.scored].sort((a, b) => b.priority_score - a.priority_score).slice(0, 15)
      .map((i) => ({ slug: i.slug, keyword: i.keyword, priority_score: i.priority_score, why: i.priority_provenance })),
    suggestions: plan.suggestions,
    alerts: plan.alerts,
  };

  if (DRY_RUN) {
    console.log(JSON.stringify(payload, null, 2));
    console.log('\nDry-run: no changes written.');
    return;
  }

  // ── apply ──
  // 1) write back priority_score + provenance for existing backlog items
  const scoredBySlug = new Map(plan.scored.map((i) => [i.slug, i]));
  const updatedItems = calendar.items.map((it) => {
    const s = scoredBySlug.get(it.slug);
    return s ? { ...it, priority_score: s.priority_score } : it;
  });
  writeCalendar({ items: updatedItems, preserve_metadata: true });

  // 2) inject new ideas (no publish_date → stays in backlog until promoted)
  for (const idea of plan.injections) {
    upsertItem({
      slug: idea.slug, keyword: idea.keyword, title: null,
      category: idea.cluster || 'GSC Demand', content_type: 'Blog Post',
      priority: 'High', week: null, publish_date: null,
      kd: null, volume: null, source: idea.source, topical_hub: idea.cluster || null,
      priority_score: idea.priority_score, status_override: null,
    });
  }

  // 3) promote: re-validate demand, then assign publish_date
  const MIN_VOL = cfg.signals.unmapped.minImpressions; // reuse demand floor
  for (const p of plan.promotions) {
    const item = calendar.items.find((i) => i.slug === p.slug);
    const kw = item?.keyword || plan.scored.find((i) => i.slug === p.slug)?.keyword;
    const vol = kw ? await currentVolume(kw) : null;
    if (vol != null && vol < MIN_VOL) {
      console.log(`  skip promote ${p.slug}: demand cratered (vol ${vol} < ${MIN_VOL})`);
      payload.promotions = payload.promotions.filter((x) => x.slug !== p.slug);
      continue;
    }
    upsertItem({
      slug: p.slug, publish_date: p.publish_date, original_publish_date: p.publish_date,
      ...(vol != null ? { volume: vol } : {}),
    });
  }

  // 4) persist signal state + report
  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(SIGNAL_STATE_PATH, JSON.stringify(state, null, 2));
  writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify(payload, null, 2));
  writeFileSync(join(REPORTS_DIR, `${today}.md`), buildReport(payload));
  console.log(`  Applied: ${plan.injections.length} injected, ${plan.promotions.length} promoted.`);

  // 5) alerts bypass digest deferral (errors email immediately)
  if (plan.alerts.length) {
    await notify({ subject: `⚠️ Pipeline prioritizer: ${plan.alerts.length} alert(s)`,
      body: plan.alerts.join('\n'), status: 'error', category: 'content' }).catch(() => {});
  }
  console.log('\nPrioritizer complete.');
}

function buildReport(p) {
  const L = ['# Pipeline Prioritizer Report', ''];
  L.push(`**Backlog depth:** ${p.backlog_depth} | **Buffer:** ${p.buffer_ready}/${p.buffer_target}`, '');
  if (p.promotions.length) { L.push('## Promoted (written next)'); for (const x of p.promotions) L.push(`- \`${x.slug}\` → ${x.publish_date.slice(0,10)} (${x.reason})`); L.push(''); }
  if (p.injections.length) { L.push('## Injected ideas'); for (const x of p.injections) L.push(`- \`${x.slug}\` — ${x.why}`); L.push(''); }
  if (p.suggestions.length) { L.push('## Suggested (weak signals — confirm)'); for (const x of p.suggestions) L.push(`- ${x.key} (${x.type}, ${x.reason})`); L.push(''); }
  if (p.alerts.length) { L.push('## Alerts'); for (const a of p.alerts) L.push(`- ${a}`); }
  return L.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => { console.error('Pipeline prioritizer failed:', err); process.exit(1); });
}

export { collectSignals, statusOf };
