/**
 * Change Verdict Agent
 *
 * Daily cron. For every page-window past its verdict_at:
 *   1. Read the last 28d of GSC + GA4 snapshots.
 *   2. Compute deltas vs the window's baseline.
 *   3. Classify outcome (improved/regressed/no_change/inconclusive).
 *   4. Decide action (kept/reverted/surfaced_for_review).
 *   5. Write the verdict to the window file, append a learning to
 *      data/context/feedback.md, and notify the daily-summary digest.
 *
 * Usage:
 *   node agents/change-verdict/index.js
 *   node agents/change-verdict/index.js --dry-run
 */

import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson, readJsonOrNull, eventPath, windowPath } from '../../lib/change-log/store.js';
import { aggregateGSCForUrl, aggregateGA4ForUrl } from '../../lib/change-log/snapshots.js';
import { computeDeltas, classifyOutcome, decideAction } from '../../lib/change-log/verdict.js';
import { CHANGES_ROOT, computeWindowStatus } from '../../lib/change-log.js';
import { updateArticle, getBlogs, getArticles } from '../../lib/shopify.js';
import { notify } from '../../lib/notify.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const SNAPSHOTS_GSC = join(ROOT, 'data', 'snapshots', 'gsc');
const SNAPSHOTS_GA4 = join(ROOT, 'data', 'snapshots', 'ga4');
const FEEDBACK_PATH = join(ROOT, 'data', 'context', 'feedback.md');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'change-verdict');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

function listAllWindows() {
  const windowsDir = join(CHANGES_ROOT, 'windows');
  if (!existsSync(windowsDir)) return [];
  const out = [];
  for (const slug of readdirSync(windowsDir)) {
    const slugDir = join(windowsDir, slug);
    if (!statSync(slugDir).isDirectory()) continue;
    for (const f of readdirSync(slugDir).filter((x) => x.endsWith('.json'))) {
      const w = readJsonOrNull(join(slugDir, f));
      if (w) out.push(w);
    }
  }
  return out;
}

export function summarizeHealthState(windows, nowIso = new Date().toISOString()) {
  const eventsDir = join(CHANGES_ROOT, 'events');
  let totalEvents = 0;
  if (existsSync(eventsDir)) {
    for (const ym of readdirSync(eventsDir)) {
      const ymDir = join(eventsDir, ym);
      try {
        if (!statSync(ymDir).isDirectory()) continue;
        totalEvents += readdirSync(ymDir).filter((f) => f.endsWith('.json')).length;
      } catch {}
    }
  }
  const windowsByStatus = { forming: 0, measuring: 0, verdict_pending: 0, verdict_landed: 0 };
  for (const w of windows) {
    const s = computeWindowStatus(w, nowIso);
    if (s in windowsByStatus) windowsByStatus[s]++;
  }
  // .gitkeep mtime ≈ first deploy on this machine — if zero events 7+ days after, the wiring is broken.
  let daysSinceDeploy = null;
  try {
    const kp = join(eventsDir, '.gitkeep');
    if (existsSync(kp)) {
      daysSinceDeploy = (Date.now() - statSync(kp).mtimeMs) / 86400000;
    }
  } catch {}
  return { totalEvents, windowsByStatus, daysSinceDeploy };
}

function loadEventsForWindow(window) {
  const events = [];
  for (const eid of window.changes) {
    // event id pattern: ch-YYYY-MM-DD-...
    const ymPart = eid.slice(3, 10); // YYYY-MM
    const path = eventPath(eid, ymPart + '-01T00:00:00Z'); // any date in same month works for path
    const ev = readJsonOrNull(path);
    if (ev) events.push(ev);
  }
  return events;
}

async function appendLearning(text) {
  if (!existsSync(dirname(FEEDBACK_PATH))) mkdirSync(dirname(FEEDBACK_PATH), { recursive: true });
  let body = '';
  if (existsSync(FEEDBACK_PATH)) body = readFileSync(FEEDBACK_PATH, 'utf8');
  const heading = '## change-verdict';
  if (!body.includes(heading)) {
    body += (body.endsWith('\n') ? '' : '\n') + `\n${heading}\n\n`;
  }
  // Insert under the heading
  const idx = body.indexOf(heading);
  const insertAt = body.indexOf('\n', idx) + 1;
  const newBody = body.slice(0, insertAt) + `\n- [${new Date().toISOString().slice(0, 10)}] ${text}\n` + body.slice(insertAt);
  writeFileSync(FEEDBACK_PATH, newBody);
}

async function applyRevert(window, events, articleIndex) {
  const results = [];
  for (const eid of window.changes) {
    const ev = events.find((e) => e.id === eid);
    if (!ev) continue;
    const handle = ev.slug;
    const article = articleIndex.get(handle);
    if (!article) {
      results.push({ change_id: eid, field: ev.change_type, ok: false, error: 'article_not_found' });
      continue;
    }
    try {
      if (ev.change_type === 'title') {
        await updateArticle(article.blogId, article.articleId, { title: ev.before });
      } else if (ev.change_type === 'meta_description') {
        // Meta description is on a metafield; for blog-vs-product different handlers exist.
        // For v1 we fall back to setting body_html-adjacent meta via summary_html if present.
        await updateArticle(article.blogId, article.articleId, { summary_html: ev.before });
      } else if (ev.change_type === 'schema' || ev.change_type === 'faq_added') {
        // Body-html stored revert
        await updateArticle(article.blogId, article.articleId, { body_html: ev.before });
      } else if (ev.change_type === 'internal_link_added') {
        await updateArticle(article.blogId, article.articleId, { body_html: ev.before });
      }
      results.push({ change_id: eid, field: ev.change_type, ok: true });
    } catch (err) {
      results.push({ change_id: eid, field: ev.change_type, ok: false, error: err.message });
    }
  }
  return results;
}

async function buildArticleIndex() {
  const blogs = await getBlogs();
  const byHandle = new Map();
  for (const blog of blogs) {
    const articles = await getArticles(blog.id);
    for (const a of articles) {
      byHandle.set(a.handle, { blogId: blog.id, articleId: a.id, handle: a.handle });
    }
  }
  return byHandle;
}

async function main() {
  console.log(`\nChange Verdict Agent — mode: ${dryRun ? 'DRY RUN' : 'APPLY'}`);
  mkdirSync(REPORTS_DIR, { recursive: true });
  const nowIso = new Date().toISOString();

  const windows = listAllWindows();
  const due = windows.filter((w) => !w.verdict && nowIso >= w.verdict_at);
  console.log(`  ${windows.length} total windows, ${due.length} due for verdict`);

  const summary = { improved: 0, no_change: 0, regressed: 0, inconclusive: 0, reverted: 0, surfaced: 0, kept: 0 };
  const articleIndex = !dryRun && due.length > 0 ? await buildArticleIndex() : new Map();

  for (const window of due) {
    console.log(`\n  ${window.url} (window ${window.id})`);
    const events = loadEventsForWindow(window);
    if (events.length === 0) {
      console.log('    no events found in window — skipping');
      continue;
    }

    // Read CURRENT metrics — last 28d ending today
    const fromDate = new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
    const toDate = new Date().toISOString().slice(0, 10);
    const pagePath = window.url.startsWith('http') ? new URL(window.url).pathname : window.url;
    const fullUrl = window.url.startsWith('http') ? window.url : `https://www.realskincare.com${window.url}`;
    const currentGsc = aggregateGSCForUrl({
      snapshotsDir: SNAPSHOTS_GSC,
      url: fullUrl,
      queries: window.target_queries || [],
      fromDate, toDate,
    });
    const currentGa4 = aggregateGA4ForUrl({
      snapshotsDir: SNAPSHOTS_GA4,
      pagePath,
      fromDate, toDate,
    });

    const deltas = computeDeltas(window.baseline, { gsc: currentGsc, ga4: currentGa4 });
    const outcome = classifyOutcome(deltas);
    const decision = decideAction({ outcome, window, events });
    console.log(`    outcome: ${outcome}, action: ${decision.action}`);
    summary[outcome]++;
    if (decision.action === 'reverted') summary.reverted++;
    else if (decision.action === 'surfaced_for_review') summary.surfaced++;
    else summary.kept++;

    let revertResults = null;
    if (!dryRun && decision.action === 'reverted') {
      revertResults = await applyRevert(window, events, articleIndex);
      console.log(`    reverted ${revertResults.filter((r) => r.ok).length}/${revertResults.length} fields`);
    }

    const verdict = {
      decided_at: new Date().toISOString(),
      gsc_delta: deltas.page,
      ga4_delta: { sessions: deltas.page.sessions, conversions: deltas.page.conversions, page_revenue: deltas.page.page_revenue },
      target_query_deltas: deltas.target_queries,
      outcome,
      action_taken: decision.action,
      revert_results: revertResults,
      learnings: `${decision.action.toUpperCase()} — ${window.target_queries.join(', ')} — outcome ${outcome}, page CTR Δ${(deltas.page.ctr * 100).toFixed(1)}% revenue Δ${(deltas.page.page_revenue * 100).toFixed(1)}%`,
    };

    if (!dryRun) {
      window.verdict = verdict;
      atomicWriteJson(windowPath(window.slug, window.id), window);
      await appendLearning(`${window.url}: ${verdict.learnings}`);
    }
  }

  // Daily heartbeat — always emit, even when no verdicts due, so the digest carries health stats.
  const health = summarizeHealthState(windows, nowIso);
  const lines = [`Change-verdict run: ${due.length} verdicts processed`];
  if (due.length > 0) {
    lines.push(
      `  Improved: ${summary.improved} (kept)`,
      `  No change: ${summary.no_change} (kept)`,
      `  Inconclusive: ${summary.inconclusive} (kept)`,
      `  Regressed: ${summary.regressed} (reverted: ${summary.reverted}, surfaced: ${summary.surfaced})`,
    );
  }
  lines.push(
    `Health:`,
    `  Events logged total: ${health.totalEvents}`,
    `  Windows: ${health.windowsByStatus.forming} forming, ${health.windowsByStatus.measuring} measuring, ${health.windowsByStatus.verdict_pending} pending, ${health.windowsByStatus.verdict_landed} verdict_landed`,
  );
  let status = 'info';
  if (health.daysSinceDeploy != null && health.daysSinceDeploy >= 7 && health.totalEvents === 0) {
    status = 'error';
    lines.push(
      '',
      `⚠ HEALTH ALERT: 0 events logged ${Math.floor(health.daysSinceDeploy)}d after deploy. Check that agents call logChangeEvent and that change-diff-detector is actually running.`,
    );
  }
  if (!dryRun) {
    await notify({ subject: 'Change Verdict ran', body: lines.join('\n'), status });
  }
  console.log('\n' + lines.join('\n'));
}

main().catch((err) => {
  notify({ subject: 'Change Verdict failed', body: err.message || String(err), status: 'error' });
  console.error('Error:', err.message);
  process.exit(1);
});
