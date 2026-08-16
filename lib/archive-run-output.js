// lib/archive-run-output.js
//
// Copy a finished run's output somewhere `git worktree remove` cannot reach.
//
// ── The hazard ──────────────────────────────────────────────────────────────────
//
// A manually-run agent writes its output under whatever checkout it was launched from.
// That output is gitignored, so inside a worktree it is UNTRACKED — and
// `git worktree remove --force` deletes untracked files. On 2026-08-15 a set of Ad Studio
// sample plates was destroyed exactly this way, before anyone had looked at them, and a
// second orphaned run had to be copied out by hand later the same day.
//
// The fix cannot be "remember to copy them first". It has to run on every exit path.
//
// ── When you need this, and when you do NOT ─────────────────────────────────────
//
// NEEDED for output a MANUALLY-RUN agent generates locally — `agents/ad-studio`
// (data/creatives/ad-studio/) and `agents/creative-packager` (data/creative-packages/).
// Neither runs on the server, so the local copy is the only copy.
//
// NOT NEEDED, and actively misleading, for gitignored directories the SERVER owns:
// `data/snapshots/`, `data/reports/giveaway/`, `data/keyword-index.json`. Those are
// written by cron on the production box and are authoritative there; a local checkout is
// expected to be empty or stale (CLAUDE.md says so for snapshots). Archiving one of those
// out of a worktree just plants a stale file in the canonical path where somebody will
// later read it as current — which is precisely what happened with the giveaway report on
// 2026-08-15, three days out of date and missing a field the live schema had since added.
//
// The test is not "is it gitignored", it is "would this data exist anywhere else if this
// directory vanished". If the server has it, leave it alone.

import { existsSync, mkdirSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';

/**
 * @param {object} args
 * @param {string} args.sourceDir   absolute path to the finished run's directory
 * @param {string} args.runId       the run's directory name at the destination
 * @param {string} args.relativeDir the output root, relative to a checkout, e.g.
 *                                  'data/creatives/ad-studio'
 * @param {string} [args.root]      the checkout to resolve the main worktree from
 * @param {string} [args.envVar]    env var that overrides the destination root
 * @param {object} [args.env]
 * @param {string} [args.label]     agent name, used only in the warning
 * @returns {string|null} the directory copied to, or null if nothing was copied
 */
export function archiveRunOutput({
  sourceDir, runId, relativeDir, root = process.cwd(),
  envVar = '', env = process.env, label = 'agent',
} = {}) {
  try {
    if (!sourceDir || !existsSync(sourceDir)) return null;

    let destRoot = envVar ? String(env[envVar] || '').trim() : '';
    if (!destRoot) {
      // A worktree's `.git` is a FILE pointing at `<main>/.git/worktrees/<name>`, and the
      // common dir is `<main>/.git` — so its parent is the main checkout. In the main
      // checkout the common dir is just `.git` and this resolves to the same place, which
      // is why the same-path check below is a no-op rather than a special case.
      const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!commonDir) return null;
      destRoot = join(dirname(commonDir), ...relativeDir.split('/'));
    }

    const dest = join(destRoot, runId);
    // Same checkout — the files are already where they will stay.
    if (resolve(dest) === resolve(sourceDir)) return null;

    mkdirSync(destRoot, { recursive: true });
    cpSync(sourceDir, dest, { recursive: true });
    return dest;
  } catch (err) {
    // Never throws. A failed backup must not turn a successful, paid run into an error —
    // the output is still on disk at this point, and the whole purpose is to lose less.
    console.warn(
      `${label}: could not archive run output (${err.message}). The run itself is unaffected; ` +
      `copy ${sourceDir} by hand before removing this worktree.`
    );
    return null;
  }
}
