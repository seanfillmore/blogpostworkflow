#!/usr/bin/env node
/**
 * Scheduled DETECTOR for data/posts/<slug>/meta.json drift. Fixes nothing.
 *
 * WHAT IT IS
 * ──────────
 * `scripts/reconcile-post-metas.mjs --ref origin/main` answers "does this box
 * diverge from what a deploy is about to land, and can that divergence be
 * resolved mechanically?" — dry by default, exiting 0/1/2/3. That script is a
 * deploy step a human runs. This wrapper puts the same question on a timer and
 * routes the answer into the 5 AM digest, because a detector nobody reads is
 * not a detector.
 *
 * WHY IT MAY NEVER APPLY
 * ──────────────────────
 * A reconcile that applied on a timer would resolve, unattended, conflicts
 * nobody reviewed — including the CONTESTED fields (`title`,
 * `meta_description`, `target_keyword`) where the losing value is somebody's
 * compliance fix or somebody's A/B-tested title. The arguments below are a
 * frozen constant, `--apply` is refused outright, and the exit-code
 * classification has no branch that writes anything. Compare
 * `scripts/triage-orphan-briefs.mjs --drop-non-earning`, which ran unattended
 * on a fresh-but-wrong report and permanently destroyed three paid-for briefs.
 *
 * WHAT EACH EXIT CODE MEANS HERE
 * ──────────────────────────────
 *   0  in sync. Routine.
 *   1  diverged. ALSO ROUTINE — cron rewrites these files all day, so the box
 *      is expected to be ahead of git. It is reported at `success` precisely so
 *      it does not cry wolf; the finding is that a deploy must use the
 *      snapshot/reconcile sequence rather than a stash pop, which is already
 *      the documented procedure.
 *   2  a field changed on BOTH sides and has no owner. This is the case a human
 *      genuinely needs to see: somebody's agent started writing a field
 *      `FIELD_OWNERS` has never heard of, and the next deploy cannot resolve it.
 *   3  a meta.json on this box already does not parse — conflict markers from a
 *      past bad deploy, or a truncated write. Every reader in the fleet
 *      `catch {}`s a parse failure and carries on as though the file were
 *      empty, so this is silent until something asks for it.
 *
 * 2 and 3 render in the digest's Failures block (`status: 'error'`, which on
 * this fleet changes rendering ONLY — it never escalates to an email). Nothing
 * here is ever `immediate: true`.
 *
 * USAGE
 *   node scripts/check-post-meta-drift.mjs              # fetch, then detect
 *   node scripts/check-post-meta-drift.mjs --no-fetch   # compare against the
 *                                                       # origin/main the box
 *                                                       # already has
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectRun } from '../lib/is-direct-run.js';
import { notify } from '../lib/notify.js';

const ROOT = process.env.SEO_CLAUDE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The ONLY arguments this ever hands the reconcile script. Frozen, and pinned
 * by a test, so a scheduled run can never acquire a write flag by accident.
 *
 * `--no-run-record` because a daily run leaves nothing to audit — it writes no
 * meta.json — and a `run-<id>/` directory every morning forever is how this box
 * lost four days of cron to a full disk. The human report still reaches the
 * cron log on stdout.
 */
export const GATE_ARGS = Object.freeze(['--ref', 'origin/main', '--no-run-record']);

/** How much of the reconcile report to carry into the digest body. */
const BODY_LINES = 40;

/**
 * Exit code → what the digest should say about it.
 *
 * @param {number} code
 * @returns {{status:'success'|'error', headline:string, needsHuman:boolean, immediate:false}}
 */
export function classifyGateExit(code) {
  const base = { immediate: false };
  switch (code) {
    case 0:
      return {
        ...base,
        status: 'success',
        needsHuman: false,
        headline: 'In sync with origin/main — every data/posts/*/meta.json on this box matches what git holds.',
      };
    case 1:
      return {
        ...base,
        status: 'success',
        needsHuman: false,
        headline:
          'Diverged from origin/main. This is the EXPECTED steady state — cron rewrites these files all day. '
          + 'It means only that the next deploy must use the snapshot → pull → reconcile sequence, never a stash pop.',
      };
    case 2:
      return {
        ...base,
        status: 'error',
        needsHuman: true,
        headline:
          'UNCLASSIFIED FIELD: a meta.json field changed on BOTH sides and has no owner. '
          + 'Add it to FIELD_OWNERS in lib/post-meta-reconcile.js, naming the writer that produces it, '
          + 'BEFORE the next deploy — until then the reconcile keeps the live copy and refuses to call the merge clean.',
      };
    case 3:
      return {
        ...base,
        status: 'error',
        needsHuman: true,
        headline:
          'REFUSED: a data/posts/*/meta.json on this box will not parse — git conflict markers or a truncated write. '
          + 'Every reader in the fleet treats a parse failure as an empty file and carries on, so this is silent until '
          + 'something needs the data. Fix it by hand; the offending files are named below.',
      };
    default:
      return {
        ...base,
        status: 'error',
        needsHuman: true,
        headline:
          `Unexpected exit ${code} from scripts/reconcile-post-metas.mjs. `
          + 'The detector could not classify the result, which is itself the finding — read the output below.',
      };
  }
}

/**
 * Which posts have SERVER-owned fields sitting in the git-TRACKED meta.json.
 *
 * ⚠️ THE RECONCILE CANNOT SEE THIS, AND THAT IS WHY THIS FUNCTION EXISTS.
 * That script asks "does this box diverge from what a deploy will land, and can
 * the difference be resolved mechanically?" A field only ONE side moved merges
 * cleanly, so a machine field leaking into the tracked file is, to it, a clean
 * merge. Measured on 2026-09-02: the gate printed "In sync. Nothing to
 * reconcile." and exited 0 while 171 of 208 posts carried `indexing_state` in
 * the tracked meta.json, written by cron that morning.
 *
 * That is the split being UNDONE, one nightly run at a time, reported as green.
 * The migration verified the data moved; nothing verified it STAYED moved.
 *
 * A leak means some writer bypassed writePostMeta/replacePostMeta and wrote the
 * file raw — recreating the tracked-file-that-cron-writes collision that
 * corrupted production twice on 2026-08-23.
 *
 * Pure over an injected reader so it is testable without a corpus.
 */
export function findServerFieldLeaks(slugs, readMeta, fieldOwners) {
  const leaks = [];
  for (const slug of slugs) {
    let raw;
    try {
      raw = readMeta(slug);
    } catch {
      continue; // unparseable is exit 3's job, not this check's
    }
    if (!raw || typeof raw !== 'object') continue;
    const fields = Object.keys(raw).filter((k) => fieldOwners[k] === 'server');
    if (fields.length) leaks.push({ slug, fields });
  }
  return leaks;
}

/** Roll leaks up into the digest lines — the FIELD is what names the culprit. */
export function renderLeakLines(leaks) {
  if (!leaks.length) return [];
  const byField = new Map();
  for (const { slug, fields } of leaks) {
    for (const f of fields) {
      if (!byField.has(f)) byField.set(f, []);
      byField.get(f).push(slug);
    }
  }
  const lines = [
    `SERVER-OWNED FIELDS IN THE TRACKED meta.json on ${leaks.length} post(s).`,
    'Some writer bypassed writePostMeta/replacePostMeta and wrote the file raw.',
    'Find it by field, fix the writer, then re-run: node scripts/split-post-meta.mjs --apply',
    '',
  ];
  for (const [field, slugs] of [...byField.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`  ${String(slugs.length).padStart(4)}  ${field}`);
    lines.push(`        e.g. ${slugs.slice(0, 3).join(', ')}${slugs.length > 3 ? ' …' : ''}`);
  }
  return lines;
}

/** Last N non-empty lines of the reconcile report, for the digest body. */
function tail(text, lines = BODY_LINES) {
  const all = (text || '').trimEnd().split('\n');
  return all.length <= lines ? all.join('\n') : ['…', ...all.slice(-lines)].join('\n');
}

async function main(argv) {
  if (argv.includes('--apply')) {
    console.error(
      'REFUSED: --apply. This is a detector. A reconcile that applied on a timer would resolve '
      + 'contested fields nobody reviewed. Run scripts/reconcile-post-metas.mjs by hand for that.',
    );
    return 64;
  }

  // `git fetch` updates remote-tracking refs only — never HEAD, never the
  // working tree. Without it the comparison silently runs against whatever
  // origin/main the box last saw, which under-reports; so its outcome is
  // reported rather than assumed.
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

  const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'reconcile-post-metas.mjs'), ...GATE_ARGS], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  const code = run.status ?? -1;
  const verdict = classifyGateExit(code);

  // The reconcile cannot see a one-sided field addition, so ask the second
  // question separately: is machine state leaking into the file git tracks?
  let leaks = [];
  let leakError = null;
  try {
    const [posts, owners] = await Promise.all([
      import('../lib/posts.js'),
      import('../lib/post-meta-reconcile.js'),
    ]);
    const { readFileSync } = await import('node:fs');
    leaks = findServerFieldLeaks(
      posts.listAllSlugs(),
      (slug) => JSON.parse(readFileSync(posts.getMetaPath(slug), 'utf8')),
      owners.FIELD_OWNERS,
    );
  } catch (err) {
    leakError = (err.message || String(err)).slice(0, 200);
  }
  const leakLines = renderLeakLines(leaks);

  console.log(output);
  console.log(`[post-meta drift gate] exit ${code} — ${verdict.headline}`);
  if (leakLines.length) console.log('\n' + leakLines.join('\n'));
  if (leakError) console.log(`[post-meta drift gate] leak check could not run: ${leakError}`);

  const freshness = fetched
    ? 'origin/main was fetched immediately before this check.'
    : fetchError
      ? `git fetch FAILED (${fetchError}) — this compared against a possibly stale origin/main, so the result may UNDER-report.`
      : 'git fetch was skipped (--no-fetch) — compared against the origin/main this box already had.';

  // A leak is a human's problem whatever the reconcile said — and the reconcile
  // says "clean" for exactly this condition, which is how it hid for two days.
  const status = leaks.length ? 'error' : verdict.status;
  const needsHuman = verdict.needsHuman || leaks.length > 0;

  await notify({
    subject: `Post-meta drift gate — exit ${code}`
      + (leaks.length ? ` · ${leaks.length} post(s) LEAKING server fields` : '')
      + (needsHuman ? ' (needs a human)' : ''),
    status,
    category: 'pipeline',
    body: [
      verdict.headline,
      '',
      freshness,
      '',
      'Detector only — nothing was written. Reconcile by hand with',
      '  node scripts/reconcile-post-metas.mjs --ref origin/main',
      '',
      ...(leakLines.length ? [...leakLines, ''] : []),
      ...(leakError ? [`Leak check could not run: ${leakError}`, ''] : []),
      '--- scripts/reconcile-post-metas.mjs ---',
      tail(output),
    ].join('\n'),
  });

  // Exit 0 whatever the gate said. This runs from cron, where a non-zero exit
  // is invisible; the digest row IS the report, and a failing cron line would
  // only add a second, quieter channel saying the same thing. The one exception
  // is above: refusing --apply is a usage error, not a finding.
  return 0;
}

if (isDirectRun(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
