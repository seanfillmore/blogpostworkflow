#!/usr/bin/env node
/**
 * Performance Engine
 *
 * Nightly agent that closes the loop between SEO signals and content changes.
 * Reads flop verdicts, quick-win targets, and low-CTR queries, then runs
 * the content-refresher for up to 6 candidates per night. Generates a
 * plain-English summary for each and writes a queue item to
 * data/performance-queue/ for human review via the dashboard.
 *
 * Also processes items with unapplied feedback — re-runs the refresh from
 * the original HTML with the feedback injected into the prompt.
 *
 * Cron: daily 3:00 AM PT (10:00 UTC).
 *
 * Usage:
 *   node agents/performance-engine/index.js
 *   node agents/performance-engine/index.js --dry-run
 *   node agents/performance-engine/index.js --limit 3
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import { notify } from '../../lib/notify.js';
import { QUEUE_DIR, listQueueItems, writeItem, activeSlugs } from './lib/queue.js';
import { buildSummaryPrompt } from './prompts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports');

import {
  listAllSlugs, getPostMeta as getPostMetaLib, getContentPath, getRefreshedPath, POSTS_DIR,
} from '../../lib/posts.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const MAX_ITEMS = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 6;
const MAX_FLOPS = 3;
const MAX_QUICK_WINS = 2;
const MAX_META = 1;

// ── env ───────────────────────────────────────────────────────────────────────

function loadEnv() {
  try {
    return Object.fromEntries(
      readFileSync(join(ROOT, '.env'), 'utf8').split('\n')
        .filter(l => l.includes('=') && !l.trim().startsWith('#'))
        .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
    );
  } catch { return {}; }
}

const env = loadEnv();
for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v;
const anthropic = new Anthropic();

// ── helpers ───────────────────────────────────────────────────────────────────

function readJsonSafe(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function loadPostHtml(slug) {
  const p = getContentPath(slug);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

// ── candidate pickers ─────────────────────────────────────────────────────────

function pickFlops(blocked) {
  const pp = readJsonSafe(join(REPORTS_DIR, 'post-performance', 'latest.json'));
  if (!pp) return [];
  return (pp.action_required || [])
    .filter(f => (f.verdict === 'REFRESH' || f.verdict === 'BLOCKED') && !blocked.has(f.slug))
    .slice(0, MAX_FLOPS)
    .map(f => ({
      slug: f.slug,
      title: f.title || f.slug,
      trigger: 'flop-refresh',
      signal_source: { type: 'post-performance', milestone: f.milestone, verdict: f.verdict, reason: f.reason },
    }));
}

function pickQuickWins(blocked) {
  const qw = readJsonSafe(join(REPORTS_DIR, 'quick-wins', 'latest.json'));
  if (!qw) return [];
  return (qw.top || [])
    .filter(c => !blocked.has(c.slug))
    .slice(0, MAX_QUICK_WINS)
    .map(c => ({
      slug: c.slug,
      title: c.title || c.slug,
      trigger: 'quick-win',
      signal_source: { type: 'quick-wins', position: c.position, impressions: c.impressions, ctr: c.ctr, top_query: c.top_query },
    }));
}

function pickMetaRewrites(blocked) {
  const gsc = readJsonSafe(join(REPORTS_DIR, 'gsc-opportunity', 'latest.json'));
  if (!gsc || !gsc.low_ctr) return [];
  const posts = listAllSlugs().map(slug => {
    try {
      const m = getPostMetaLib(slug);
      if (!m) return null;
      if (!m.slug) m.slug = slug;
      return m;
    } catch { return null; }
  }).filter(Boolean);

  const picks = [];
  for (const q of gsc.low_ctr) {
    if (picks.length >= MAX_META) break;
    const match = posts.find(p => {
      const tk = (p.target_keyword || '').toLowerCase();
      return tk && (q.keyword.toLowerCase().includes(tk) || tk.includes(q.keyword.toLowerCase()));
    });
    if (!match || blocked.has(match.slug)) continue;
    // Only pick posts that actually have HTML — no point refreshing a stub
    if (!existsSync(getContentPath(match.slug))) continue;
    // Skip posts that aren't on Shopify yet — the publish step would fail
    // because findPostMeta requires shopify_article_id to update the article.
    if (!match.shopify_article_id) continue;
    picks.push({
      slug: match.slug,
      title: match.title || match.slug,
      trigger: 'low-ctr-meta',
      signal_source: { type: 'gsc-opportunity', query: q.keyword, impressions: q.impressions, ctr: q.ctr, position: q.position },
    });
  }
  return picks;
}

function pickLegacyFlops(blocked) {
  const triage = readJsonSafe(join(REPORTS_DIR, 'legacy-triage', 'latest.json'));
  if (!triage) return [];
  return (triage.results || [])
    .filter(r => r.bucket === 'flop' && !blocked.has(r.slug))
    .filter(r => {
      const existing = listQueueItems().find(i => i.slug === r.slug);
      return !existing || existing.status === 'dismissed';
    })
    .sort((a, b) => (b.impressions || 0) - (a.impressions || 0))
    .slice(0, MAX_FLOPS)
    .map(r => ({
      slug: r.slug,
      title: r.title || r.slug,
      trigger: 'legacy-flop',
      signal_source: {
        type: 'legacy-triage',
        bucket: 'flop',
        reason: r.reason,
        words: r.words,
        position: r.position,
        impressions: r.impressions,
      },
    }));
}

// ── refresh execution ─────────────────────────────────────────────────────────

function runRefresh(slug, feedback = null) {
  const cmdArgs = ['agents/content-refresher/index.js', '--slug', slug];
  if (feedback) cmdArgs.push('--feedback', feedback);
  execSync(`node ${cmdArgs.join(' ')}`, { cwd: ROOT, stdio: 'inherit' });
  const refreshedPath = getRefreshedPath(slug);
  if (!existsSync(refreshedPath)) throw new Error(`content-refresher did not produce ${refreshedPath}`);
  return readFileSync(refreshedPath, 'utf8');
}

async function generateSummary({ slug, trigger, signal, originalHtml, refreshedHtml }) {
  const prompt = buildSummaryPrompt({ slug, trigger, signal, originalHtml, refreshedHtml });
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = response.content[0].text.trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try {
    const parsed = JSON.parse(text);
    if (!parsed.what_changed || !parsed.why || !parsed.projected_impact) throw new Error('missing fields');
    return parsed;
  } catch {
    return {
      what_changed: 'Content refreshed (summary generation failed — see HTML).',
      why: `Triggered by ${trigger}.`,
      projected_impact: 'unclear',
    };
  }
}

// ── feedback re-run ───────────────────────────────────────────────────────────

async function processFeedbackQueue() {
  const items = listQueueItems().filter(i => {
    if (!i.feedback) return false;
    return !(i.feedback_history || []).some(h => h.text === i.feedback && h.applied_at);
  });

  let count = 0;
  for (const item of items) {
    console.log(`\n  Re-running ${item.slug} with feedback: "${item.feedback.slice(0, 80)}..."`);
    if (DRY_RUN) { console.log('    (dry-run — skipping)'); continue; }
    try {
      const originalHtml = existsSync(item.backup_html_path) ? readFileSync(item.backup_html_path, 'utf8') : loadPostHtml(item.slug);
      if (!originalHtml) { console.warn(`    [skip] no original HTML`); continue; }
      const refreshedHtml = runRefresh(item.slug, item.feedback);
      writeFileSync(item.refreshed_html_path, refreshedHtml);
      const summary = await generateSummary({ slug: item.slug, trigger: item.trigger, signal: item.signal_source, originalHtml, refreshedHtml });
      item.summary = summary;
      item.status = 'pending';
      item.approved_at = null;
      const history = item.feedback_history || [];
      history.push({ text: item.feedback, applied_at: new Date().toISOString() });
      item.feedback_history = history;
      item.feedback = null;
      writeItem(item);
      count++;
      console.log(`    [ok] feedback applied, back to pending`);
    } catch (err) {
      console.error(`    [fail] ${item.slug}: ${err.message}`);
    }
  }
  return count;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nPerformance Engine\n');

  // Stage 1: feedback
  console.log('  Stage 1: processing feedback queue...');
  const feedbackCount = await processFeedbackQueue();
  console.log(`    ${feedbackCount} feedback item${feedbackCount === 1 ? '' : 's'} processed`);

  // Stage 2: new candidates
  console.log('\n  Stage 2: selecting new candidates...');
  const blocked = activeSlugs();
  const flops = pickFlops(blocked);
  flops.forEach(c => blocked.add(c.slug));
  const quickWins = pickQuickWins(blocked);
  quickWins.forEach(c => blocked.add(c.slug));
  const metaRewrites = pickMetaRewrites(blocked);
  const legacyFlops = pickLegacyFlops(blocked);
  legacyFlops.forEach(c => blocked.add(c.slug));

  const candidates = [...flops, ...quickWins, ...metaRewrites, ...legacyFlops].slice(0, MAX_ITEMS);
  console.log(`    ${flops.length} flops, ${quickWins.length} quick-wins, ${metaRewrites.length} meta, ${legacyFlops.length} legacy flops`);
  console.log(`    Total candidates: ${candidates.length} / ${MAX_ITEMS}`);

  if (candidates.length === 0 && feedbackCount === 0) {
    console.log('\n  Nothing to do.');
    return;
  }

  // Stage 3: refresh each candidate
  console.log('\n  Stage 3: running refresh pipeline...');
  mkdirSync(QUEUE_DIR, { recursive: true });
  const queued = [];

  for (const c of candidates) {
    console.log(`\n  → ${c.slug} [${c.trigger}]`);
    const originalHtml = loadPostHtml(c.slug);
    if (!originalHtml) { console.warn(`    [skip] no HTML`); continue; }

    if (DRY_RUN) { console.log('    (dry-run — skipping refresh)'); queued.push(c); continue; }

    try {
      const refreshedHtml = runRefresh(c.slug);
      const backupPath = join(QUEUE_DIR, `${c.slug}.backup.html`);
      const refreshedPath = join(QUEUE_DIR, `${c.slug}.html`);
      writeFileSync(backupPath, originalHtml);
      writeFileSync(refreshedPath, refreshedHtml);

      const summary = await generateSummary({ slug: c.slug, trigger: c.trigger, signal: c.signal_source, originalHtml, refreshedHtml });

      writeItem({
        slug: c.slug,
        title: c.title,
        trigger: c.trigger,
        signal_source: c.signal_source,
        summary,
        refreshed_html_path: refreshedPath,
        backup_html_path: backupPath,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: 'pending',
        feedback: null,
        feedback_history: [],
        approved_at: null,
        published_at: null,
      });
      queued.push(c);
      console.log(`    [queued] ${c.slug}`);
    } catch (err) {
      console.error(`    [fail] ${c.slug}: ${err.message}`);
    }
  }

  console.log(`\n  Queued ${queued.length} new item${queued.length === 1 ? '' : 's'}.`);

  await notify({
    subject: `Performance Engine: ${queued.length} item${queued.length === 1 ? '' : 's'} queued`,
    body: queued.length === 0 ? 'No new items this run.'
      : queued.map(i => `[${i.trigger}] ${i.title}`).join('\n'),
    status: 'info',
    category: 'pipeline',
  }).catch(() => {});

  console.log('\nPerformance Engine complete.');
}

main().catch(err => {
  console.error('Performance engine failed:', err);
  process.exit(1);
});
