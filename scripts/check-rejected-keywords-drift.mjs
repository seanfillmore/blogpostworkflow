#!/usr/bin/env node
//
// DAILY DRIFT GATE for data/rejected-keywords.json — DETECT ONLY.
//
//   node scripts/check-rejected-keywords-drift.mjs
//
// WHY THIS EXISTS
//   Two tracked files in this repo are written by production on its own:
//   `data/posts/*/meta.json` and this one. The first has DAILY_POST_META_GATE and
//   content mirrors have DAILY_CONTENT_MIRROR_GATE. Rejections had neither — only
//   `scripts/reconcile-rejected-keywords.mjs`, which somebody has to REMEMBER to
//   run. That is exactly how 37 entries came to exist nowhere but the production
//   box for four months (last commit 2026-04-08), un-noticed until an audit went
//   looking for them.
//
//   Nine agents read this file; it is the last gate before `calendar-runner`
//   spends a full paid research + writing pipeline on a topic Sean already
//   rejected. Losing an entry does not fail loudly — it silently re-authorises
//   spend.
//
// IT CAN NEVER FIX ANYTHING
//   `--apply` is refused with exit 64 and this file contains no write of any
//   kind. A reconcile that applied on a timer would union the two sides
//   unattended; the union is almost always right, but "almost always" is not a
//   thing to run every morning against a file recording human decisions, and
//   `scripts/triage-orphan-briefs.mjs --drop-non-earning` is what a scheduled
//   write looks like when it is wrong.
//
// THE SEVERITY SPLIT IS THE POINT, and it is NOT the same as the post-meta gate's.
//   There, any divergence is routine because the deploy runs a per-field 3-way
//   merge that cannot lose a value. Here there is no such merge — the file's
//   safety depends entirely on somebody running the reconcile — so the two
//   directions of drift mean different things:
//
//     box ahead of git   → ROUTINE. content-strategist appends from the 15:00 UTC
//                          cron and the dashboard writes from two routes, so this
//                          is the normal state. Reported quietly; a daily failure
//                          row for the normal state is how a digest stops being read.
//     git ahead of box   → NEEDS A HUMAN. Either a deploy already reverted box
//                          entries, or a commit has not reached the box. Both end
//                          with a rejected keyword becoming writable again.
//
// Always exits 0 so cron has nothing to say the digest does not — the single
// exception is refusing a write flag, which is a usage error rather than a finding.
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../lib/notify.js';
import { isDirectRun } from '../lib/is-direct-run.js';
import { loadRejections, diffRejections, renderReconcileReport } from '../lib/rejected-keywords.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REL = 'data/rejected-keywords.json';

/**
 * Frozen, and pinned by a test, so a scheduled run can never acquire a write
 * flag by accident. It compares against `origin/main` rather than `HEAD` for the
 * same reason the post-meta gate does: HEAD is whatever the box last pulled, and
 * comparing against it silently under-reports.
 */
export const GATE_ARGS = Object.freeze(['--ref', 'origin/main']);

/**
 * What the digest should say about a diff.
 *
 * @param {{onlyInBase:Array, onlyInHead:Array, merged:Array}} diff
 *   `base` is git, `head` is the working tree — the orientation
 *   `reconcile-rejected-keywords.mjs` uses.
 * @returns {{status:'success'|'error', headline:string, needsHuman:boolean, immediate:false}}
 */
export function classifyRejectionDrift(diff) {
  const gitOnly = diff?.onlyInBase?.length ?? 0;
  const boxOnly = diff?.onlyInHead?.length ?? 0;
  const base = { immediate: false };

  if (!gitOnly && !boxOnly) {
    return {
      ...base,
      status: 'success',
      needsHuman: false,
      headline: `In sync — git origin/main and this box hold the same ${diff?.merged?.length ?? 0} rejected keyword(s).`,
    };
  }

  if (!gitOnly) {
    return {
      ...base,
      status: 'success',
      needsHuman: false,
      headline: `${boxOnly} rejection(s) exist only on this box — the normal state, since content-strategist `
        + 'and the dashboard append here. Commit them from a branch so a future pull cannot revert them.',
    };
  }

  return {
    ...base,
    status: 'error',
    needsHuman: true,
    headline: `${gitOnly} rejection(s) are in git but NOT on this box`
      + (boxOnly ? `, and ${boxOnly} are on the box but not in git` : '')
      + '. Nine agents read this file and it is the last gate before a full paid pipeline, so a missing '
      + 'entry re-authorises spend on a topic already rejected. Merge with '
      + 'scripts/reconcile-rejected-keywords.mjs --ref origin/main --apply.',
  };
}

async function main(argv = []) {
  if (argv.includes('--apply')) {
    console.error(
      'REFUSED: --apply. This is a detector. Run scripts/reconcile-rejected-keywords.mjs --apply by hand '
      + 'to write the union — a merge of human decisions is not something to run unattended.',
    );
    return 64;
  }

  // Remote-tracking refs only — never HEAD, never the working tree.
  let fetched = false;
  let fetchError = null;
  if (!argv.includes('--no-fetch')) {
    try {
      execFileSync('git', ['fetch', '--quiet', 'origin'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
      fetched = true;
    } catch (err) {
      fetchError = (err.stderr || err.message || String(err)).trim().slice(0, 300);
    }
  }

  const ref = GATE_ARGS[GATE_ARGS.indexOf('--ref') + 1];
  let gitSide = [];
  let gitMissing = false;
  try {
    gitSide = JSON.parse(execFileSync('git', ['show', `${ref}:${REL}`], { cwd: ROOT, encoding: 'utf8' }));
  } catch {
    // A ref that does not carry the file is the answer "git has nothing here",
    // not an error — merging against nothing loses nothing.
    gitMissing = true;
  }

  const diff = diffRejections({ base: gitSide, head: loadRejections() });
  const verdict = classifyRejectionDrift(diff);
  const report = renderReconcileReport(diff, { baseLabel: `git ${ref}`, headLabel: 'this box' });

  console.log(`\n${report}\n`);
  console.log(`[rejected-keywords drift gate] ${verdict.headline}`);

  const freshness = fetched
    ? `${ref} was fetched immediately before this check.`
    : fetchError
      ? `git fetch FAILED (${fetchError}) — compared against a possibly stale ${ref}, so this may UNDER-report.`
      : `git fetch was skipped (--no-fetch) — compared against the ${ref} this box already had.`;

  await notify({
    subject: `Rejected-keywords drift — ${verdict.needsHuman ? 'needs a human' : 'ok'}`,
    status: verdict.status,
    category: 'pipeline',
    body: [
      verdict.headline,
      '',
      freshness,
      gitMissing ? `NOTE: ${ref} does not carry ${REL} — git's side was treated as empty.` : '',
      '',
      'Detector only — nothing was written. To merge (never drops an entry either side holds):',
      '  node scripts/reconcile-rejected-keywords.mjs --ref origin/main --apply',
      '',
      `--- ${REL} ---`,
      report,
    ].filter(Boolean).join('\n'),
  });

  return 0;
}

if (isDirectRun(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
