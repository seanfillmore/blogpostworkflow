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
import { decideOutcome, pickBaselineCtr } from '../../lib/meta-ab-decision.js';
import { isDirectRun } from '../../lib/is-direct-run.js';

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

function isoDaysBefore(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// GSC data lags ~3 days; the measurement window has to end where the data does.
function measurementWindow(days) {
  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 3);
  const endIso = end.toISOString().slice(0, 10);
  return { start: isoDaysBefore(endIso, days - 1), end: endIso };
}

/**
 * What the untouched blog corpus did between the test's baseline window and the
 * measurement window. Subtracting it is the difference between measuring a
 * headline and measuring an algorithm update — see lib/meta-ab-decision.js.
 *
 * Best-effort by design: a failure here yields null, `decideOutcome` ignores a
 * non-finite drift, and the run degrades to the old uncontrolled comparison
 * rather than stopping. It is cached per baseline window because a run
 * evaluating several tests from the same week would otherwise repeat the call.
 */
function makeControlDriftReader(minDays) {
  const cache = new Map();
  let currentPromise = null;
  const now = measurementWindow(minDays);

  return async function controlDriftFor(testedAt) {
    try {
      if (!currentPromise) currentPromise = gsc.getBlogPerformanceForRange(now.start, now.end);
      const current = await currentPromise;
      if (!cache.has(testedAt)) {
        const preEnd = isoDaysBefore(testedAt, 1);
        const preStart = isoDaysBefore(preEnd, minDays - 1);
        cache.set(testedAt, gsc.getBlogPerformanceForRange(preStart, preEnd));
      }
      const pre = await cache.get(testedAt);
      if (!Number.isFinite(current?.ctr) || !Number.isFinite(pre?.ctr)) return null;
      return current.ctr - pre.ctr;
    } catch {
      return null;
    }
  };
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
  const controlDriftFor = makeControlDriftReader(minDays);

  for (const entry of due) {
    process.stdout.write(`  Checking "${entry.keyword}" (${entry.testedAt})... `);

    try {
      // Fetch current GSC performance for the page (last 28 days = post-test window)
      const perf = await gsc.getPagePerformance(entry.pageUrl, 28);

      const currentCtr = perf.ctr ?? 0;
      const currentImpressions = perf.impressions ?? 0;
      const currentPosition = perf.position ?? entry.baselinePosition;

      // `perf` above is PAGE-level over 28 days, so the baseline has to be too.
      // pickBaselineCtr prefers the page-level baseline meta-optimizer now
      // records and falls back to the historical keyword-level one, which is a
      // different denominator and can read as improved/regressed on its own.
      const { ctr: baselineCtr, basis: baselineBasis } = pickBaselineCtr(entry);

      // The three confounds, supplied here because they need I/O and the
      // decision itself must stay pure. Each is optional: a null simply skips
      // that guard rather than failing the evaluation.
      const controlDrift = await controlDriftFor(entry.testedAt);

      // The baseline window on the SAME basis the measurement uses (page-level,
      // `minDays` long, ending the day before the test went live).
      //
      // This refetch is not an optimisation, it is a correctness requirement for
      // the position guard. `entry.baselinePosition` on the 13 pre-2026-08-24
      // entries is the KEYWORD's 90-day average position; `perf.position` is the
      // PAGE's over `minDays`. Comparing those two would be the same
      // different-denominator error PR #630 removed from the CTR side, wearing a
      // different unit — it would manufacture "confounded" verdicts out of a
      // basis mismatch. If the refetch fails we pass nulls and skip the guard
      // rather than compare things that are not comparable.
      //
      // Note what is NOT re-based: the CTR baseline. `pickBaselineCtr` documents
      // a deliberate choice to leave legacy entries on their recorded value
      // rather than silently re-basing them, and that choice is left standing.
      const preEnd = isoDaysBefore(entry.testedAt, 1);
      const preStart = isoDaysBefore(preEnd, minDays - 1);
      let basePerf = null;
      try {
        basePerf = await gsc.getPagePerformanceForRange(entry.pageUrl, preStart, preEnd);
      } catch { /* guard skipped, not fatal */ }

      // Power is set by the THINNER arm — a huge measurement window cannot
      // rescue a baseline nobody saw.
      const impressionsPerArm = Number.isFinite(basePerf?.impressions)
        ? Math.min(basePerf.impressions, currentImpressions)
        : currentImpressions;

      const decision = decideOutcome({
        baselineCtr,
        currentCtr,
        controlDrift,
        baselinePosition: basePerf?.position ?? null,
        currentPosition: perf.position ?? null,
        impressionsPerArm,
      });
      const ctrDelta = decision.delta;
      const ctrDeltaPct = baselineCtr > 0
        ? ((ctrDelta / baselineCtr) * 100).toFixed(1)
        : 'N/A';
      const improved = decision.outcome === 'improved';
      const FLAGS = {
        improved: '✅',
        regressed: '⚠️ Regressed',
        flat: '→ Flat',
        confounded: '⏸ Confounded (position moved)',
        underpowered: '⏸ Underpowered (sample too thin)',
      };
      const flag = FLAGS[decision.outcome] ?? '→ Flat';

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
      //
      // A `confounded` or `underpowered` test is NOT concluded. It stays open,
      // gets re-evaluated on a later run, and keeps its live variant. The whole
      // point of those two outcomes is that nothing has been learned yet, and
      // stamping `concluded` on them would close the only chance to learn it —
      // the same one-way door that made the 2026-07-27 revert unrecoverable.
      // `lastCheckedAt` records that we looked, so a stuck test is visible
      // rather than looking like one nobody ever got to.
      entry.lastCheckedAt = concludedAt;
      entry.outcome = decision.outcome;
      entry.baselineBasis = baselineBasis;
      entry.controlDrift = decision.controlDrift;
      entry.positionDelta = decision.positionDelta;
      entry.impressionsPerArm = impressionsPerArm;

      if (decision.concluded) {
        entry.status = 'concluded';
        entry.concludedDate = concludedAt;
        entry.winner = decision.winner;
        entry.currentCtr = currentCtr;
        entry.currentDelta = ctrDelta;
        entry.reverted = reverted;
        if (revertError) entry.revertError = revertError;
      } else {
        entry.openReason = decision.outcome;
      }

      results.push({
        ...entry,
        // After the spread, so the report prints the baseline the decision was
        // actually made against rather than the raw keyword-level field.
        baselineCtr,
        baselineBasis,
        currentCtr,
        currentImpressions,
        currentPosition,
        ctrDelta,
        ctrDeltaPct,
        improved,
        flag,
        reverted,
        revertError,
        // The decision's own working, so the report explains a verdict instead
        // of re-deriving one.
        outcome: decision.outcome,
        rawDelta: decision.rawDelta,
        controlDrift: decision.controlDrift,
        positionDelta: decision.positionDelta,
        positionTolerance: decision.positionTolerance,
        power: decision.power,
        impressionsPerArm,
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

  // Bucket on the DECISION, never by re-deriving it from the delta. The old
  // `ctrDelta < -0.005` here was a second copy of the rule in
  // lib/meta-ab-decision.js — it ignored the dead-band epsilon and, once the
  // decision learned about drift, position and power, it would have reported a
  // different verdict from the one that was actually acted on.
  const byOutcome = (name) => results.filter((r) => r.outcome === name);
  const improved = byOutcome('improved');
  const regressed = byOutcome('regressed');
  const flat = byOutcome('flat');
  const confounded = byOutcome('confounded');
  const underpowered = byOutcome('underpowered');
  const stillOpen = [...confounded, ...underpowered];

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
  lines.push(`| ⏸ Confounded (position moved) | ${confounded.length} |`);
  lines.push(`| ⏸ Underpowered (sample too thin) | ${underpowered.length} |`);
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
    lines.push(`| CTR (${r.baselineBasis === 'page-28d' ? 'page, 28d' : 'keyword, 90d baseline vs page, 28d — mixed basis'}) | ${(r.baselineCtr * 100).toFixed(2)}% | ${(r.currentCtr * 100).toFixed(2)}% | **${sign}${(r.ctrDelta * 100).toFixed(2)}%** (${sign}${r.ctrDeltaPct}%) |`);
    lines.push(`| Impressions | ${r.baselineImpressions.toLocaleString()} | ${r.currentImpressions.toLocaleString()} | — |`);
    lines.push(`| Position | #${Math.round(r.baselinePosition)} | #${Math.round(r.currentPosition)} | — |`);
    lines.push('');
    lines.push(`| | Before | After |`);
    lines.push(`|---|---|---|`);
    lines.push(`| **Title** | ${r.originalTitle} | ${r.proposedTitle} |`);
    lines.push(`| **Meta** | ${r.originalMeta || '*(none)*'} | ${r.proposedMeta} |`);
    lines.push('');
    // What the comparison was corrected for, so a reader can see whether the
    // verdict survived its confounds or was blocked by them.
    if (Number.isFinite(r.controlDrift) && r.controlDrift !== 0) {
      const cd = (r.controlDrift * 100).toFixed(2);
      lines.push(`> **Corpus drift over the same window:** ${r.controlDrift >= 0 ? '+' : ''}${cd}pp, subtracted before deciding. Raw delta was ${(r.rawDelta * 100).toFixed(2)}pp.`);
      lines.push('');
    }

    if (r.outcome === 'confounded') {
      lines.push(`> **Not concluded — confounded.** The page moved ${r.positionDelta?.toFixed(1)} positions during the window (tolerance ${r.positionTolerance?.toFixed(1)}). CTR follows rank before it follows copy, so this window cannot say anything about the rewrite. The variant stays live and the test stays open for a later run.`);
    } else if (r.outcome === 'underpowered') {
      lines.push(`> **Not concluded — underpowered.** ${Number(r.impressionsPerArm).toLocaleString()} impressions in the thinner arm; detecting the target lift needs ${Math.round(r.power?.requiredImpressionsPerArm ?? 0).toLocaleString()}. The smallest move this sample can distinguish from noise is ${((r.power?.mde ?? 0) * 100).toFixed(2)}pp. Variant stays live, test stays open.`);
    } else if (r.reverted) {
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
  if (stillOpen.length) {
    console.log(`  ⏸ Left open (not concluded): ${stillOpen.length} — ${confounded.length} confounded, ${underpowered.length} underpowered`);
  }
}

// Guarded: importing this module must not run the agent (live writes, paid
// API calls, process.exit). See lib/is-direct-run.js.
if (isDirectRun(import.meta.url)) {
  main()
    .then(() => notifyLatestReport('Meta A/B Checker completed', join(ROOT, 'data', 'reports', 'meta-ab')))
    .catch((err) => {
      notify({ subject: 'Meta A/B Checker failed', body: err.message || String(err), status: 'error' });
      console.error('Error:', err.message);
      process.exit(1);
    });
}
