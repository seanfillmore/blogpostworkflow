#!/usr/bin/env node
/**
 * Indexing Checker
 *
 * Daily agent that inspects every published post via GSC URL Inspection API
 * and classifies its indexing state. Stamps results onto each post's JSON
 * metadata and writes a per-day snapshot + latest.json for downstream agents.
 *
 * Signal producer. Guiding principle per docs/signal-manifest.md: this is
 * the authoritative "is it indexed?" answer that downstream agents use to
 * avoid mis-diagnosing indexing problems as content problems.
 *
 * Consumers (what reads the output):
 *   - post-performance — downgrades BLOCKED verdict to NOT_INDEXED when the
 *     real problem is indexing, not content
 *   - refresh-runner — suppresses refresh triggers for non-indexed posts
 *   - indexing-fixer — chooses which URLs need a sitemap ping or Indexing API
 *     submission
 *   - dashboard Optimize tab — Indexing Status card
 *
 * Outputs:
 *   data/reports/indexing/YYYY-MM-DD.json   — full snapshot
 *   data/reports/indexing/latest.json       — machine-readable for dashboard
 *   data/reports/indexing/history.json      — append-only log of state changes
 *   data/posts/<slug>.json indexing_state   — per-post summary
 *
 * Cron: daily 6:00 AM PT (before gsc-opportunity and post-performance so
 * they can read the output).
 *
 * Usage:
 *   node agents/indexing-checker/index.js                  # check every published post
 *   node agents/indexing-checker/index.js --slug <slug>    # check one post
 *   node agents/indexing-checker/index.js --url <url>      # check one URL directly
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../../lib/notify.js';
import { inspectUrl, getQuotaStatus } from '../../lib/gsc-indexing.js';

const config = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'site.json'), 'utf8'));
const CANONICAL_ROOT = (config.url || '').replace(/\/$/, '');

/**
 * Rewrite a post URL to the canonical public domain so GSC URL Inspection
 * accepts it under the sc-domain:realskincare.com property.
 *
 * Posts are stored with their *.myshopify.com internal URL, but Google only
 * indexes the canonical https://www.realskincare.com variant. URL Inspection
 * returns 403 if you query for a URL outside the property's domain.
 */
function toCanonicalUrl(meta) {
  // Prefer the shopify_handle when available — reliable and doesn't depend
  // on the stored shopify_url domain.
  if (meta.shopify_handle) {
    return `${CANONICAL_ROOT}/blogs/news/${meta.shopify_handle}`;
  }
  // Fallback: rewrite the myshopify URL to the canonical domain.
  if (meta.shopify_url) {
    return meta.shopify_url.replace(/https?:\/\/[^/]+/, CANONICAL_ROOT);
  }
  return null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const POSTS_DIR = join(ROOT, 'data', 'posts');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'indexing');

const args = process.argv.slice(2);
const slugArg = (() => { const i = args.indexOf('--slug'); return i !== -1 ? args[i + 1] : null; })();
const urlArg = (() => { const i = args.indexOf('--url'); return i !== -1 ? args[i + 1] : null; })();

// ── helpers ────────────────────────────────────────────────────────────────────

function listPublishedPosts() {
  if (!existsSync(POSTS_DIR)) return [];
  const out = [];
  for (const f of readdirSync(POSTS_DIR).filter((x) => x.endsWith('.json'))) {
    try {
      const meta = JSON.parse(readFileSync(join(POSTS_DIR, f), 'utf8'));
      if (meta.shopify_status !== 'published' || !meta.shopify_url) continue;
      out.push(meta);
    } catch { /* skip */ }
  }
  return out;
}

function ageInDays(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86400000);
}

function stampPostMeta(slug, indexingState) {
  const path = join(POSTS_DIR, `${slug}.json`);
  if (!existsSync(path)) return;
  try {
    const meta = JSON.parse(readFileSync(path, 'utf8'));
    meta.indexing_state = {
      state: indexingState.state,
      coverage: indexingState.coverage_state,
      last_checked: new Date().toISOString(),
      last_crawled: indexingState.last_crawl,
      google_canonical: indexingState.google_canonical,
      canonical_mismatch: indexingState.canonical_mismatch,
      page_fetch_state: indexingState.page_fetch_state,
    };
    writeFileSync(path, JSON.stringify(meta, null, 2));
  } catch { /* skip */ }
}

function loadHistory() {
  const p = join(REPORTS_DIR, 'history.json');
  if (!existsSync(p)) return { entries: [] };
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { entries: [] }; }
}

function appendHistory(entries) {
  const h = loadHistory();
  h.entries.push(...entries);
  // Keep history bounded — last 1000 entries
  if (h.entries.length > 1000) h.entries = h.entries.slice(-1000);
  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(join(REPORTS_DIR, 'history.json'), JSON.stringify(h, null, 2));
}

/**
 * Given a state and post age, return a verdict that downstream agents can
 * act on. This is where we encode "is this normal for a new post or is it
 * a real problem?" — avoids flagging 3-day-old posts as broken.
 */
function computeVerdict(state, ageDays) {
  // Indexed is always fine.
  if (state === 'indexed') return { severity: 'ok', action: null };

  // Excluded states are technical bugs — flag immediately regardless of age.
  if (state === 'excluded_noindex') return { severity: 'critical', action: 'fix_noindex_tag' };
  if (state === 'excluded_robots')  return { severity: 'critical', action: 'fix_robots_txt' };
  if (state === 'excluded_canonical') return { severity: 'critical', action: 'fix_canonical_mismatch' };
  if (state === 'not_found')        return { severity: 'critical', action: 'fix_page_fetch' };

  // Not-yet-indexed states — patience window depends on age.
  if (state === 'discovered_not_crawled') {
    if (ageDays == null || ageDays < 7)  return { severity: 'ok',      action: null };
    if (ageDays < 14) return { severity: 'warning', action: 'resubmit_sitemap' };
    return { severity: 'critical', action: 'submit_indexing_api' };
  }
  if (state === 'crawled_not_indexed') {
    // Google crawled but chose not to index. This is usually a quality/duplicate
    // signal, not something a resubmission fixes. Flag for content review.
    return { severity: 'critical', action: 'content_quality_review' };
  }
  if (state === 'submitted_not_indexed') {
    if (ageDays == null || ageDays < 7)  return { severity: 'ok',      action: null };
    if (ageDays < 14) return { severity: 'warning', action: 'resubmit_sitemap' };
    return { severity: 'critical', action: 'submit_indexing_api' };
  }
  if (state === 'unknown') {
    // Google has never seen this URL — submit immediately via sitemap ping.
    return { severity: 'warning', action: 'resubmit_sitemap' };
  }
  return { severity: 'warning', action: null };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nIndexing Checker\n');

  const quota = getQuotaStatus();
  console.log(`  URL Inspection quota: ${quota.inspection.used}/${quota.inspection.cap} used today`);
  if (quota.inspection.remaining === 0) {
    console.error('  Inspection quota exhausted — try again tomorrow.');
    process.exit(1);
  }

  let targets = [];
  if (slugArg) {
    const p = join(POSTS_DIR, `${slugArg}.json`);
    if (!existsSync(p)) { console.error(`  No such post: ${slugArg}`); process.exit(1); }
    targets = [JSON.parse(readFileSync(p, 'utf8'))];
  } else if (urlArg) {
    targets = [{ slug: 'ad-hoc', title: urlArg, shopify_url: urlArg, published_at: null }];
  } else {
    targets = listPublishedPosts();
  }

  console.log(`  Checking ${targets.length} post${targets.length === 1 ? '' : 's'}\n`);

  const results = [];
  const stateTransitions = [];

  for (let i = 0; i < targets.length; i++) {
    const meta = targets[i];
    const url = urlArg ? urlArg : toCanonicalUrl(meta);
    if (!url) {
      console.log(`  [${i + 1}/${targets.length}] ${meta.slug} ... SKIP (no canonical URL)`);
      continue;
    }
    const age = ageInDays(meta.published_at);

    process.stdout.write(`  [${i + 1}/${targets.length}] ${meta.slug} ... `);
    try {
      const inspection = await inspectUrl(url);
      const verdict = computeVerdict(inspection.state, age);

      const entry = {
        slug: meta.slug,
        title: meta.title,
        url,
        age_days: age,
        state: inspection.state,
        verdict,
        coverage_state: inspection.coverage_state,
        indexing_state: inspection.indexing_state,
        last_crawl: inspection.last_crawl,
        google_canonical: inspection.google_canonical,
        user_canonical: inspection.user_canonical,
        canonical_mismatch: inspection.canonical_mismatch,
        page_fetch_state: inspection.page_fetch_state,
        checked_at: new Date().toISOString(),
      };
      results.push(entry);

      // Stamp onto post JSON — skip for ad-hoc URL checks
      if (meta.slug && meta.slug !== 'ad-hoc') {
        // Detect state transition for history
        try {
          const postMeta = JSON.parse(readFileSync(join(POSTS_DIR, `${meta.slug}.json`), 'utf8'));
          const prevState = postMeta.indexing_state?.state;
          if (prevState && prevState !== inspection.state) {
            stateTransitions.push({
              slug: meta.slug,
              from: prevState,
              to: inspection.state,
              at: new Date().toISOString(),
            });
          }
        } catch { /* ignore */ }
        stampPostMeta(meta.slug, inspection);
      }

      const tag = inspection.state === 'indexed' ? 'INDEXED'
                : verdict.severity === 'critical' ? 'CRITICAL'
                : verdict.severity === 'warning'  ? 'WARN'
                : 'ok';
      console.log(`${tag} (${inspection.state})`);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      results.push({
        slug: meta.slug,
        url,
        error: err.message,
        checked_at: new Date().toISOString(),
      });
      // If quota hit mid-run, stop. Don't leave partial state inconsistent.
      if (err.message.includes('quota exhausted')) break;
    }
  }

  // ── Aggregate counts for downstream use ────────────────────────────────────
  const byState = {};
  const actionable = [];
  for (const r of results) {
    if (!r.state) continue;
    byState[r.state] = (byState[r.state] || 0) + 1;
    if (r.verdict && r.verdict.severity !== 'ok') actionable.push(r);
  }

  console.log('\n  Summary:');
  for (const [state, count] of Object.entries(byState).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${state}: ${count}`);
  }
  console.log(`  Actionable: ${actionable.length}`);

  // ── Write outputs ─────────────────────────────────────────────────────────
  mkdirSync(REPORTS_DIR, { recursive: true });
  const dateStr = new Date().toISOString().slice(0, 10);

  const snapshot = {
    generated_at: new Date().toISOString(),
    quota: getQuotaStatus(),
    total_checked: results.length,
    by_state: byState,
    actionable_count: actionable.length,
    results,
  };
  writeFileSync(join(REPORTS_DIR, `${dateStr}.json`), JSON.stringify(snapshot, null, 2));
  writeFileSync(join(REPORTS_DIR, 'latest.json'), JSON.stringify(snapshot, null, 2));

  if (stateTransitions.length > 0) {
    console.log(`\n  State transitions: ${stateTransitions.length}`);
    for (const t of stateTransitions) console.log(`    ${t.slug}: ${t.from} → ${t.to}`);
    appendHistory(stateTransitions);
  }

  if (actionable.length > 0) {
    const critical = actionable.filter((r) => r.verdict.severity === 'critical');
    await notify({
      subject: `Indexing: ${critical.length} critical, ${actionable.length - critical.length} warnings`,
      body: actionable.slice(0, 15).map((r) => `[${r.verdict.severity}] ${r.state} — ${r.slug} (${r.age_days ?? '?'}d old)${r.verdict.action ? ` → ${r.verdict.action}` : ''}`).join('\n'),
      status: critical.length > 0 ? 'error' : 'info',
      category: 'seo',
    }).catch(() => {});
  }

  console.log('\nIndexing check complete.');
}

main().catch((err) => {
  console.error('Indexing checker failed:', err);
  process.exit(1);
});
