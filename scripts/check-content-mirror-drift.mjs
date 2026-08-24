#!/usr/bin/env node
/**
 * Scheduled DETECTOR for `data/posts/<slug>/content.html` mirror drift. Fixes
 * nothing, and structurally cannot.
 *
 * WHAT IT IS
 * ──────────
 * `scripts/check-content-mirrors.mjs` answers "does every local mirror still
 * hold the article that is actually live?" — read-only, exiting 0/1/2/3. That
 * script is something a human runs. This wrapper puts the same question on a
 * timer and routes the answer into the 5 AM digest, because a detector nobody
 * runs is not a detector: the 27 different-article mirrors found on 2026-08-23
 * had been wrong since a bulk import in April and nothing said so for four
 * months.
 *
 * It is the same split `scripts/check-post-meta-drift.mjs` draws against
 * `scripts/reconcile-post-metas.mjs`, and it is deliberately a separate file
 * rather than a `--notify` flag on the check itself. The check is a tool people
 * run by hand; it should not append to the digest every time somebody looks at
 * it. And a flag can be swapped for another flag by whoever next edits the
 * crontab, which is exactly what `GATE_ARGS` exists to prevent.
 *
 * WHY IT MAY NEVER RESYNC
 * ───────────────────────
 * `scripts/reconcile-content-mirrors.mjs` exists and is `--apply`-gated, so
 * "put the detector on cron" is one edit away from "put the RESYNC on cron".
 * That must not happen. A resync overwrites `content.html` from live, and
 * `content.html` is also the INPUT to legitimate work — `agents/refresh-runner`
 * writes a refreshed draft over it and then publishes, so a file *ahead* of live
 * is a normal state for the minutes between those two steps. A nightly resync
 * would eventually land inside one of those windows and destroy a paid LLM
 * rewrite, unattended, with nothing to say it had. Compare
 * `scripts/triage-orphan-briefs.mjs --drop-non-earning`, which ran unattended on
 * a fresh-but-wrong report and permanently destroyed three paid-for briefs.
 *
 * So `GATE_ARGS` is a frozen constant, `--apply` and `--snapshot-live` are
 * refused outright, and this file never spawns the reconciler.
 *
 * `GATE_ARGS` IS EMPTY, AND THAT IS THE `--no-run-record` DECISION
 * ───────────────────────────────────────────────────────────────
 * `check-post-meta-drift.mjs` passes `--no-run-record` so a daily cron does not
 * leave a `run-<id>/` directory every morning forever on a box that has already
 * lost four days of cron to a full disk. The same reasoning here reaches the
 * empty list: `check-content-mirrors.mjs` writes nothing at all unless it is
 * given `--snapshot-live --apply`, which would drop ~80 full live article bodies
 * into `data/reports/content-mirror/` daily. Adding a flag is the hazard; the
 * frozen empty list is the fix. The human report still reaches the cron log on
 * stdout.
 *
 * WHAT EACH EXIT CODE MEANS HERE
 * ──────────────────────────────
 *   0  every mirror is identical, cosmetic, or an ordinary edit apart. Routine.
 *   1  at least one mirror sits in the 0.25–0.75 band. Reported at `success`,
 *      because the operator's decision on 2026-08-24 was to leave that
 *      threshold ADVISORY rather than promote it to refuse — a daily failure
 *      row for a band we have deliberately chosen not to block on is how a
 *      digest stops being read. The posts are still named in the body.
 *   2  a local file is a DIFFERENT ARTICLE from what is live. `agents/publisher`
 *      already refuses to republish it, so nothing is at risk of being
 *      overwritten — what is broken is that the post can never be republished
 *      at all until a human reconciles it. That needs a human.
 *   3  a local post could not be read. Silent otherwise: readers `catch {}` a
 *      parse failure and carry on as though the file were empty.
 *
 * 2 and 3 render in the digest's Failures block (`status: 'error'`, which on
 * this fleet changes rendering ONLY — it never escalates to an email). Nothing
 * here is ever `immediate: true`.
 *
 * USAGE
 *   node scripts/check-content-mirror-drift.mjs
 */

import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDirectRun } from '../lib/is-direct-run.js';
import { notify } from '../lib/notify.js';

const ROOT = process.env.SEO_CLAUDE_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The ONLY arguments this ever hands the check script. Frozen, and pinned by a
 * test, so a scheduled run can never acquire a write flag by accident.
 */
export const GATE_ARGS = Object.freeze([]);

/** How much of the check's report to carry into the digest body. */
const BODY_LINES = 40;

/**
 * Exit code → what the digest should say about it.
 *
 * @param {number} code
 * @returns {{status:'success'|'error', headline:string, needsHuman:boolean, immediate:false}}
 */
export function classifyMirrorGateExit(code) {
  const base = { immediate: false };
  switch (code) {
    case 0:
      return {
        ...base,
        status: 'success',
        needsHuman: false,
        headline: 'Every data/posts/*/content.html still mirrors the article that is live on Shopify.',
      };
    case 1:
      return {
        ...base,
        status: 'success',
        needsHuman: false,
        headline:
          'DEEP DIVERGENCE: at least one mirror sits in the 0.25-0.75 band — a republish from it would drop a large '
          + 'slice of the live page. This threshold is deliberately ADVISORY and blocks nothing, because blocking it '
          + 'would also stop a legitimate deep refresh. Reconcile with scripts/reconcile-content-mirrors.mjs; the '
          + 'posts are named below.',
      };
    case 2:
      return {
        ...base,
        status: 'error',
        needsHuman: true,
        headline:
          'DIFFERENT ARTICLE: a local content.html holds a different article from what is live. agents/publisher '
          + 'REFUSES to republish it (and --force does not disarm that), so the live page is safe — but the post can '
          + 'never be republished until the mirror is reconciled. Run scripts/reconcile-content-mirrors.mjs (dry by '
          + 'default) and read what it holds back.',
      };
    case 3:
      return {
        ...base,
        status: 'error',
        needsHuman: true,
        headline:
          'REFUSED: a data/posts/*/meta.json or content.html on this box could not be read. Every reader in the fleet '
          + 'treats a read failure as an empty file and carries on, so this is silent until something needs the data. '
          + 'The offending files are named below.',
      };
    case 64:
      return {
        ...base,
        status: 'error',
        needsHuman: true,
        headline:
          'REFUSED an argument: scripts/check-content-mirrors.mjs rejected the invocation. GATE_ARGS is a frozen '
          + 'constant, so this means the script itself changed — check what the scheduled call is now passing.',
      };
    default:
      return {
        ...base,
        status: 'error',
        needsHuman: true,
        headline:
          `Unexpected exit ${code} from scripts/check-content-mirrors.mjs. `
          + 'The detector could not classify the result, which is itself the finding — read the output below.',
      };
  }
}

/** Last N non-empty lines of the check's report, for the digest body. */
function tail(text, lines = BODY_LINES) {
  const all = (text || '').trimEnd().split('\n');
  return all.length <= lines ? all.join('\n') : ['…', ...all.slice(-lines)].join('\n');
}

async function main(argv) {
  for (const forbidden of ['--apply', '--snapshot-live']) {
    if (argv.includes(forbidden)) {
      console.error(
        `REFUSED: ${forbidden}. This is a detector. It never resyncs a mirror and never captures live bodies on a `
        + 'timer. Run scripts/reconcile-content-mirrors.mjs or scripts/check-content-mirrors.mjs by hand for that.',
      );
      return 64;
    }
  }

  const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-content-mirrors.mjs'), ...GATE_ARGS], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  const code = run.status ?? -1;
  const verdict = classifyMirrorGateExit(code);

  console.log(output);
  console.log(`[content-mirror drift gate] exit ${code} — ${verdict.headline}`);

  await notify({
    subject: `Content-mirror drift gate — exit ${code}${verdict.needsHuman ? ' (needs a human)' : ''}`,
    status: verdict.status,
    category: 'pipeline',
    body: [
      verdict.headline,
      '',
      'Detector only — nothing was written, in either direction, on Shopify or on disk.',
      'Reconcile by hand with (dry by default):',
      '  node scripts/reconcile-content-mirrors.mjs',
      '',
      '--- scripts/check-content-mirrors.mjs ---',
      tail(output),
    ].join('\n'),
  });

  // Exit 0 whatever the gate said. This runs from cron, where a non-zero exit is
  // invisible; the digest row IS the report. The one exception is above:
  // refusing a write flag is a usage error, not a finding.
  return 0;
}

if (isDirectRun(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
