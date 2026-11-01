#!/usr/bin/env node
/**
 * Scheduled RECONCILER for the `different-article` mirror tier, and ONLY that
 * tier. Runs 11:45 UTC, applies, and reports into the 5 AM digest.
 *
 * WHY THIS EXISTS
 * ───────────────
 * `data/posts/<slug>/content.html` is a local mirror of a live article body, and
 * `agents/publisher` republishes from it. When a mirror drifts far enough to be
 * a *different article*, the publisher REFUSES the push — correctly: that stops
 * an old draft silently replacing a live indexed page. But the consequence is
 * that the post becomes un-republishable, so every refresh, link repair,
 * buy-box rebuild and schema injection aimed at it is silently refused. A
 * `refresh-runner` row reading "publisher failed" is usually this.
 *
 * The tier REGROWS ON ITS OWN: 0 on 2026-08-24 after a hand-run reconcile, back
 * to 28 by 2026-09-08, every one of them `both-moved` — live pages kept being
 * edited by the fleet while the local mirrors moved independently. That is the
 * steady state, not an incident, and it means the fix is maintenance on a timer
 * rather than an investigation somebody remembers to open.
 *
 * WHY THIS IS ALLOWED TO APPLY WHEN `check-content-mirror-drift.mjs` IS NOT
 * ────────────────────────────────────────────────────────────────────────
 * That file's header states the rule this one has to answer: a resync overwrites
 * `content.html`, which is also the INPUT to legitimate work — `refresh-runner`
 * moves a paid LLM rewrite over it and then publishes, so for those minutes the
 * local file is legitimately AHEAD of live, and a blind live→local resync there
 * destroys the rewrite.
 *
 * That hazard is real and it lives in the WARN BAND, which this job does not
 * touch. The deepest legitimate refresh ever measured scores **0.775** block
 * similarity (then 0.923, 0.932, 0.964, 0.985) — just above `DIVERGENT_WARN_MAX`
 * of 0.75, so a deep one could plausibly dip into that band. It cannot reach
 * `DIFFERENT_ARTICLE_MAX` of **0.25**: that would be a "refresh" that discarded
 * three quarters of the article's own text blocks. `DIFFERENT_ARTICLE_MAX` was
 * chosen at three times below a measured real refresh precisely so this
 * distinction holds, and `inOutageScope()` is the scope that uses it.
 *
 * Four further things stand between this and the failure mode:
 *
 *   1. `SCOPE_ARGS` is FROZEN and includes `--only-different-article`. The
 *      reconciler refuses to combine that with `--all` or `--slug` (exit 64), so
 *      the scope cannot be widened by editing the crontab.
 *   2. The reconciler's own holds still apply — `live-empty`, `local-ahead`
 *      (live ⊆ local, re-derived per post: an in-flight refresh that ADDS text
 *      is held on its own evidence, not on the scope argument),
 *      `pinned-mirror`, and `faq-regression`, which is decided after the write
 *      and rolls it back.
 *   3. Every overwrite is backed up to
 *      `data/posts/<slug>/backups/content-reconcile-<stamp>.html` first, and the
 *      backup is kept even when the write is rolled back.
 *   4. TIMING. 11:45 UTC is 3h15m before the 15:00 UTC scheduler — the run that
 *      drives `refresh-runner` — so the window where a rewrite sits unpublished
 *      in `content.html` is nowhere near this job. It is also 35 minutes before
 *      the 12:20 detector, so the detector reports the state this left behind
 *      rather than the state it found.
 *
 * WHAT IT DOES NOT DO
 * ───────────────────
 * It never touches the 0.25–0.75 warn band (a human decision, and it blocks
 * nothing in the meantime), never sweeps `--all`, never writes to Shopify — the
 * direction is live → local, always — and never re-runs `agents/editor`, so
 * `editor-report.md` is stale for a reconciled post exactly as it is after a
 * hand run. `scripts/regate-live-posts.js --all` regenerates those.
 *
 * `check-content-mirror-drift.mjs` at 12:20 stays DETECT-ONLY and unchanged. The
 * two are deliberately separate files: this one is the maintenance, that one is
 * the independent check on whether the maintenance worked. Folding them together
 * would mean the thing doing the work is also the thing grading it.
 *
 * USAGE
 *   node scripts/reconcile-content-mirrors-nightly.mjs            # applies
 *   node scripts/reconcile-content-mirrors-nightly.mjs --dry-run  # plan only
 */

import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectRun } from '../lib/is-direct-run.js';
import { notify } from '../lib/notify.js';

const ROOT = process.env.SEO_CLAUDE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The ONLY scope this ever hands the reconciler. Frozen, and pinned by a test,
 * so a scheduled run can never widen past the tier that is an outage.
 */
export const SCOPE_ARGS = Object.freeze(['--only-different-article']);

/** How much of the reconciler's report to carry into the digest body. */
const BODY_LINES = 40;

/**
 * Exit code → what the digest should say about it.
 *
 * Note what is NOT an error. "Reconciled 12 mirrors" is this job doing exactly
 * its work, and a HOLD is the reconciler's guards working. Only a genuine
 * failure to run, or a refused argument, means somebody should go look at the
 * machinery — the same rule as every other row in this digest.
 */
export function classifyReconcileExit(code, { reconciled = 0, held = 0 } = {}) {
  const base = { immediate: false };
  const did = reconciled
    ? `Reconciled ${reconciled} different-article mirror(s) from live Shopify. Those posts can be republished again.`
    : 'No different-article mirrors to reconcile.';

  // 0 = clean, 1 = something was HELD, 3 = a post could not be READ, 64 = refused
  // argument. See `process.exitCode = unreadable.length ? 3 : held.length ? 1 : 0`
  // in scripts/reconcile-content-mirrors.mjs.
  if (code === 0) {
    return { ...base, status: 'success', needsHuman: false, headline: did };
  }

  // A HOLD IS THE GUARDS WORKING, NOT A FAILURE. `local-ahead` means the local
  // file holds text live does not — most often an unpublished edit — so refusing
  // to overwrite it is the single most important thing this job does. Reporting
  // that as breakage would send a human to fix an agent that just protected
  // their work, and would train them to stop reading the Failures block. The
  // held posts are still named in the body.
  if (code === 1) {
    return {
      ...base,
      status: 'success',
      needsHuman: false,
      headline: `${did} Held ${held || 'some'} back — the reconciler's own guards refused those, which is the `
        + 'policy working; they are named below.',
    };
  }

  if (code === 3) {
    return {
      ...base,
      status: 'error',
      needsHuman: true,
      headline:
        'REFUSED: a local content.html could not be READ. Every reader in the fleet treats a read failure as an '
        + 'empty file and carries on, so this is silent until something needs the data. The files are named below.',
    };
  }

  if (code === 64) {
    return {
      ...base,
      status: 'error',
      needsHuman: true,
      headline:
        'REFUSED an argument: scripts/reconcile-content-mirrors.mjs rejected the invocation. SCOPE_ARGS is a frozen '
        + 'constant, so this means the script itself changed — check what the scheduled call now passes, and in '
        + 'particular that the scope is still different-article only.',
    };
  }

  return {
    ...base,
    status: 'error',
    needsHuman: true,
    headline:
      `scripts/reconcile-content-mirrors.mjs exited ${code}, which this job cannot classify. Mirrors in the `
      + 'different-article tier may NOT be being repaired, which would mean those posts cannot be republished at '
      + 'all — every refresh and link repair aimed at them silently refused. Read the output below.',
  };
}

/** Pull the counts out of the reconciler's own summary line, for the subject. */
export function parseCounts(output) {
  const text = String(output || '');
  const num = (re) => {
    const m = text.match(re);
    return m ? Number(m[1]) : 0;
  };
  return {
    reconciled: num(/(\d+)\s+reconcil/i),
    held: num(/(\d+)\s+held/i),
  };
}

/** Last N non-empty lines of the reconciler's report, for the digest body. */
function tail(text, lines = BODY_LINES) {
  const all = (text || '').trimEnd().split('\n');
  return all.length <= lines ? all.join('\n') : ['…', ...all.slice(-lines)].join('\n');
}

async function main(argv) {
  // `--all` and `--slug` are the two ways to leave the outage tier. The
  // reconciler refuses them alongside the scope flag too (exit 64); refusing
  // here as well means the scheduled path never even builds such a command.
  for (const forbidden of ['--all', '--slug']) {
    if (argv.some((a) => a === forbidden || a.startsWith(`${forbidden}=`))) {
      console.error(
        `REFUSED: ${forbidden}. This job reconciles the different-article tier and nothing else — that is what makes `
        + 'it safe to run unattended. Run scripts/reconcile-content-mirrors.mjs by hand for any wider sweep.',
      );
      return 64;
    }
  }

  const dryRun = argv.includes('--dry-run');
  const args = [join(ROOT, 'scripts', 'reconcile-content-mirrors.mjs'), ...SCOPE_ARGS];
  if (!dryRun) args.push('--apply');

  const run = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  const code = run.status ?? -1;
  const counts = parseCounts(output);
  const verdict = classifyReconcileExit(code, counts);

  console.log(output);
  console.log(`[content-mirror reconcile] exit ${code} — ${verdict.headline}`);

  await notify({
    subject: `Content-mirror reconcile — ${counts.reconciled} reconciled, ${counts.held} held`
      + `${dryRun ? ' (dry run)' : ''}${verdict.needsHuman ? ' (needs a human)' : ''}`,
    status: verdict.status,
    category: 'pipeline',
    body: [
      verdict.headline,
      '',
      'Scope: the different-article tier ONLY (block similarity <= 0.25). The 0.25-0.75 warn band is deliberately '
      + 'NOT touched on a timer — that is where an in-flight refresh-runner rewrite can live.',
      'Direction is live -> local. Nothing was written to Shopify.',
      'Every overwrite is backed up to data/posts/<slug>/backups/content-reconcile-<stamp>.html first.',
      'editor-report.md is now stale for any reconciled post; scripts/regate-live-posts.js --all regenerates it.',
      '',
      '--- scripts/reconcile-content-mirrors.mjs ---',
      tail(output),
    ].join('\n'),
  });

  // Exit 0 whatever happened. This runs from cron, where a non-zero exit is
  // invisible; the digest row IS the report. The one exception is above:
  // refusing a scope-widening flag is a usage error, not a finding.
  return 0;
}

if (isDirectRun(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
