/**
 * Meta A/B Test Checker Agent
 *
 * Reads the baseline saved by meta-optimizer (data/reports/meta-ab-tracker.json)
 * and fetches current GSC CTR for each tested page to measure whether the new
 * title/meta description improved click-through rate.
 *
 * Only evaluates entries that are at least 28 days old (one full GSC cycle).
 * Each evaluated test is concluded in place (status='concluded' + winner/delta
 * written back to the tracker so it isn't re-evaluated and the digest can show a
 * real result). Clear losers (CTR regressed beyond the dead-band) are
 * auto-reverted to the original title/meta on Shopify.
 *
 * Usage:
 *   node agents/meta-ab-checker/index.js                # ≥28-day tests; auto-revert losers
 *   node agents/meta-ab-checker/index.js --min-days 14  # ≥14-day tests
 *   node agents/meta-ab-checker/index.js --all          # all entries regardless of age
 *   node agents/meta-ab-checker/index.js --no-apply     # measure + report only, no reverts
 *
 * Output: data/reports/meta-ab/meta-ab-report.md
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as gsc from '../../lib/gsc.js';
import { notify, notifyLatestReport } from '../../lib/notify.js';
import { getBlogs, getArticles, updateArticle } from '../../lib/shopify.js';
import { decideOutcome } from '../../lib/meta-ab-decision.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const REPORTS_DIR = join(ROOT, 'data', 'reports', 'meta-ab');

const config = JSON.parse(readFileSync(join(ROOT, 'config', 'site.json'), 'utf8'));

// ── args ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

const minDays = parseInt(getArg('--min-days') ?? '28', 10);
const checkAll = args.includes('--all');
// Auto-revert measured losers by default; --no-apply measures + reports only.
const apply = !args.includes('--no-apply');

// Resolve a tested page URL back to its Shopify article so a losing variant can
// be reverted to the original title/meta. Matches by article handle (last path
// segment), which is robust to www-vs-myshopify host differences.
async function buildArticleIndex() {
  const byHandle = new Map();
  const blogs = await getBlogs();
  for (const blog of blogs || []) {
    const articles = await getArticles(blog.id);
    for (const a of articles || []) byHandle.set(a.handle, { ...a, blogId: blog.id });
  }
  return byHandle;
}

function handleFromUrl(url) {
  const m = String(url || '').match(/\/blogs\/[^/]+\/([^/?#]+)/);
  return m ? m[1] : null;
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nMeta A/B Checker — ${config.name}`);
  console.log(`Minimum test age: ${checkAll ? 'all entries' : `${minDays} days`}\n`);

  const trackerPath = join(REPORTS_DIR, 'meta-ab-tracker.json');

  if (!existsSync(trackerPath)) {
    console.log('  No A/B tracker found. Run meta-optimizer with --apply first.');
    console.log('  Expected: data/reports/meta-ab-tracker.json');
    process.exit(0);
  }

  let tracker = [];
  try {
    tracker = JSON.parse(readFileSync(trackerPath, 'utf8'));
  } catch (e) {
    console.error(`  Failed to read tracker: ${e.message}`);
    process.exit(1);
  }

  if (tracker.length === 0) {
    console.log('  Tracker is empty. Run meta-optimizer with --apply first.');
    process.exit(0);
  }

  const today = new Date();
  const due = tracker.filter((entry) => {
    if (entry.status === 'concluded') return false; // already decided
    if (checkAll) return true;
    const tested = new Date(entry.testedAt);
    const ageInDays = (today - tested) / 86400000;
    return ageInDays >= minDays;
  });

  console.log(`  Mode: ${apply ? 'APPLY (auto-revert losers)' : 'REPORT ONLY (--no-apply)'}`);
  console.log(`  Tracker entries: ${tracker.length} total, ${due.length} ready to evaluate`);

  if (due.length === 0) {
    console.log(`  No entries are ${minDays}+ days old yet. Check back later.`);
    process.exit(0);
  }

  console.log('');

  // Build the article index once (only needed if we may revert).
  const articleIndex = apply ? await buildArticleIndex() : new Map();

  const results = [];
  const concludedAt = new Date().toISOString().slice(0, 10);

  for (const entry of due) {
    process.stdout.write(`  Checking "${entry.keyword}" (${entry.testedAt})... `);

    try {
      // Fetch current GSC performance for the page (last 28 days = post-test window)
      const perf = await gsc.getPagePerformance(entry.pageUrl, 28);

      const currentCtr = perf.ctr ?? 0;
      const currentImpressions = perf.impressions ?? 0;
      const currentPosition = perf.position ?? entry.baselinePosition;

      const decision = decideOutcome({ baselineCtr: entry.baselineCtr, currentCtr });
      const ctrDelta = decision.delta;
      const ctrDeltaPct = entry.baselineCtr > 0
        ? ((ctrDelta / entry.baselineCtr) * 100).toFixed(1)
        : 'N/A';
      const improved = decision.outcome === 'improved';
      const flag = improved ? '✅' : (decision.outcome === 'regressed' ? '⚠️ Regressed' : '→ Flat');

      // Auto-revert a clear loser to the original title/meta.
      let reverted = false, revertError = null;
      if (decision.shouldRevert && apply) {
        const handle = handleFromUrl(entry.pageUrl);
        const art = handle ? articleIndex.get(handle) : null;
        if (!art) {
          revertError = `could not resolve article for ${entry.pageUrl}`;
        } else {
          try {
            const fields = { title: entry.originalTitle };
            if (entry.originalMeta != null) fields.summary_html = entry.originalMeta;
            await updateArticle(art.blogId, art.id, fields);
            reverted = true;
          } catch (e) {
            revertError = e.message;
          }
        }
      }

      console.log(
        `${improved ? '✅ +' : (ctrDelta >= 0 ? '→ +' : '❌ ')}${(ctrDelta * 100).toFixed(2)}% CTR`
        + (reverted ? ' — reverted to original' : (revertError ? ` — revert FAILED: ${revertError}` : ''))
      );

      // Write the outcome back onto the tracker entry so it's concluded (won't
      // be re-evaluated) and the digest can show a real winner/delta.
      entry.status = 'concluded';
      entry.concludedDate = concludedAt;
      entry.winner = decision.winner;
      entry.currentCtr = currentCtr;
      entry.currentDelta = ctrDelta;
      entry.outcome = decision.outcome;
      entry.reverted = reverted;
      if (revertError) entry.revertError = revertError;

      results.push({
        ...entry,
        currentCtr,
        currentImpressions,
        currentPosition,
        ctrDelta,
        ctrDeltaPct,
        improved,
        flag,
        reverted,
        revertError,
      });
    } catch (e) {
      console.error(`failed: ${e.message}`);
    }
  }

  // Persist concluded outcomes (and any reverts) back to the tracker.
  if (apply && results.length > 0) {
    writeFileSync(trackerPath, JSON.stringify(tracker, null, 2));
  }

  if (results.length === 0) {
    console.log('  No results to report.');
    process.exit(0);
  }

  // ── Build report ────────────────────────────────────────────────────────────

  const improved = results.filter((r) => r.improved);
  const regressed = results.filter((r) => r.ctrDelta < -0.005);
  const flat = results.filter((r) => !r.improved && r.ctrDelta >= -0.005);

  const now = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const lines = [];

  lines.push(`# Meta A/B Test Results — ${config.name}`);
  lines.push(`**Run date:** ${now}`);
  lines.push(`**Test window:** ${minDays} days`);
  lines.push(`**Entries evaluated:** ${results.length}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(`| Result | Count |`);
  lines.push(`|---|---|`);
  lines.push(`| ✅ Improved CTR | ${improved.length} |`);
  lines.push(`| → Flat (±0.5%) | ${flat.length} |`);
  lines.push(`| ⚠️ Regressed    | ${regressed.length} |`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const r of results.sort((a, b) => b.ctrDelta - a.ctrDelta)) {
    const sign = r.ctrDelta >= 0 ? '+' : '';
    lines.push(`## ${r.flag} — "${r.keyword}"`);
    lines.push(`**URL:** [${r.pageUrl}](${r.pageUrl})`);
    lines.push(`**Tested:** ${r.testedAt} (${Math.round((today - new Date(r.testedAt)) / 86400000)} days ago)`);
    lines.push('');
    lines.push(`| Metric | Before | After | Change |`);
    lines.push(`|---|---|---|---|`);
    lines.push(`| CTR | ${(r.baselineCtr * 100).toFixed(2)}% | ${(r.currentCtr * 100).toFixed(2)}% | **${sign}${(r.ctrDelta * 100).toFixed(2)}%** (${sign}${r.ctrDeltaPct}%) |`);
    lines.push(`| Impressions | ${r.baselineImpressions.toLocaleString()} | ${r.currentImpressions.toLocaleString()} | — |`);
    lines.push(`| Position | #${Math.round(r.baselinePosition)} | #${Math.round(r.currentPosition)} | — |`);
    lines.push('');
    lines.push(`| | Before | After |`);
    lines.push(`|---|---|---|`);
    lines.push(`| **Title** | ${r.originalTitle} | ${r.proposedTitle} |`);
    lines.push(`| **Meta** | ${r.originalMeta || '*(none)*'} | ${r.proposedMeta} |`);
    lines.push('');
    if (r.reverted) {
      lines.push(`> **Action taken:** Reverted to the original title/meta (variant B lost). meta-optimizer can try a fresh variant on the next run.`);
    } else if (r.revertError) {
      lines.push(`> **Revert FAILED:** ${r.revertError} — restore manually.`);
    } else if (!r.improved) {
      lines.push(`> **Action:** Variant kept (within dead-band). No revert needed.`);
    }
    lines.push('---');
    lines.push('');
  }

  mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = join(REPORTS_DIR, 'meta-ab-report.md');
  writeFileSync(reportPath, lines.join('\n'));

  const revertedCount = results.filter((r) => r.reverted).length;
  console.log(`\n  Report: ${reportPath}`);
  console.log(`  ✅ Improved: ${improved.length}  → Flat: ${flat.length}  ⚠️ Regressed: ${regressed.length}  ↩ Reverted: ${revertedCount}`);
}

main()
  .then(() => notifyLatestReport('Meta A/B Checker completed', join(ROOT, 'data', 'reports', 'meta-ab')))
  .catch((err) => {
    notify({ subject: 'Meta A/B Checker failed', body: err.message || String(err), status: 'error' });
    console.error('Error:', err.message);
    process.exit(1);
  });
