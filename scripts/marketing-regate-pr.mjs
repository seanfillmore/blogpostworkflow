#!/usr/bin/env node
/**
 * Monthly marketing re-gate, shipped as a pull request instead of an edit to the live checkout.
 *
 * Usage:
 *   node scripts/marketing-regate-pr.mjs            # dry: re-gate in a throwaway worktree, report only
 *   node scripts/marketing-regate-pr.mjs --apply    # write the markers, commit, open + merge a PR
 *
 * Why this exists. `scheduler.js` used to run `agents/marketing-learner/index.js --regate --apply`
 * directly on the production box. That writes `.claude/skills/*\/SKILL.md`, which are TRACKED files,
 * and nothing ever committed them. On 2026-11-01 it un-parked 17 tactics across 10 skills, and the
 * very next deploy's `git pull` aborted on those files ("Please commit your changes or stash them").
 * Every month the server would have drifted from git and blocked the next deploy, and the re-gate's
 * decisions would have existed nowhere but the box: the same class of hazard as
 * `data/rejected-keywords.json` (37 entries that existed only on the server for four months).
 *
 * So the agent now runs inside a detached worktree cut from `origin/main`. The live checkout is never
 * written and never changes branch. If any skill moved, the change goes out as a branch + PR and is
 * merged through it (CLAUDE.md rule 2), and the next deploy pulls it like any other commit. The
 * re-gate is stage-marker text surgery guarded by `validateSkillEdit`, which is why it is merged
 * unattended rather than left waiting. A PR nobody merges is a decision that never takes effect.
 *
 * Requires `gh` authenticated on the box (as `git push` already is).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { notify } from '../lib/notify.js';
import { isDirectRun } from '../lib/is-direct-run.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_PATH = '.claude/skills';

/** One branch per run day; a re-run on the same day gets a numeric suffix. */
export function regateBranchName(date = new Date(), attempt = 0) {
  const base = `chore/marketing-regate-${date.toISOString().slice(0, 10)}`;
  return attempt ? `${base}-${attempt + 1}` : base;
}

/** Paths under .claude/skills that `git status --porcelain` reports as changed. */
export function changedSkillFiles(porcelain) {
  return porcelain.split('\n')
    .map((l) => l.slice(3).trim())
    .filter((p) => p.startsWith(`${SKILLS_PATH}/`));
}

/** The re-gate's own summary lines, for the PR body. Keeps the agent's report, drops the noise. */
export function summarizeRegateOutput(out, maxLines = 80) {
  const lines = out.split('\n').filter((l) => l.trim());
  const start = lines.findIndex((l) => /── (UNPARK|PARK|scale|team|traffic|tracking|cro|offer-aov)\b/.test(l));
  return (start === -1 ? lines.slice(-maxLines) : lines.slice(start, start + maxLines)).join('\n');
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }).trim();
}

function remoteBranchExists(dir, name) {
  return run('git', ['ls-remote', '--heads', 'origin', name], { cwd: dir }) !== '';
}

/** Detached worktree off origin/main with the live checkout's env, modules and digest wired in. */
function makeWorktree() {
  run('git', ['fetch', '--quiet', 'origin'], { cwd: ROOT });
  const dir = mkdtempSync(join(tmpdir(), 'marketing-regate-'));
  run('git', ['worktree', 'add', '--detach', dir, 'origin/main'], { cwd: ROOT });
  symlinkSync(join(ROOT, '.env'), join(dir, '.env'));
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  // lib/notify.js writes relative to its own file, so inside the worktree the agent's digest row would
  // land in a directory this script deletes. Point it at the live digest instead.
  const digest = join(dir, 'data', 'reports', 'daily-summary');
  rmSync(digest, { recursive: true, force: true });
  mkdirSync(dirname(digest), { recursive: true });
  mkdirSync(join(ROOT, 'data', 'reports', 'daily-summary'), { recursive: true });
  symlinkSync(join(ROOT, 'data', 'reports', 'daily-summary'), digest);
  return dir;
}

function removeWorktree(dir) {
  try { run('git', ['worktree', 'remove', '--force', dir], { cwd: ROOT }); } catch { /* fall through */ }
  rmSync(dir, { recursive: true, force: true });
  try { run('git', ['worktree', 'prune'], { cwd: ROOT }); } catch { /* best effort */ }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const dir = makeWorktree();
  try {
    const agentArgs = [join(dir, 'agents', 'marketing-learner', 'index.js'), '--regate', ...(apply ? ['--apply'] : [])];
    const out = run(process.execPath, agentArgs, { cwd: dir });
    console.log(out);
    if (!apply) { console.log('\nDry run: nothing committed. Pass --apply to ship a PR.'); return; }

    const changed = changedSkillFiles(run('git', ['status', '--porcelain', '--', SKILLS_PATH], { cwd: dir }));
    if (!changed.length) { console.log('\nNo skill moved: nothing to ship.'); return; }

    let attempt = 0;
    while (remoteBranchExists(dir, regateBranchName(new Date(), attempt))) attempt++;
    const branch = regateBranchName(new Date(), attempt);
    const summary = summarizeRegateOutput(out);
    run('git', ['checkout', '-b', branch], { cwd: dir });
    run('git', ['add', '--', ...changed], { cwd: dir });
    run('git', ['commit', '-m', `chore(skills): monthly marketing re-gate (${changed.length} skill files)`,
      '-m', summary], { cwd: dir });
    run('git', ['push', '--quiet', '-u', 'origin', branch], { cwd: dir });
    const url = run('gh', ['pr', 'create', '--base', 'main', '--head', branch,
      '--title', `Monthly marketing re-gate: ${changed.length} skill file(s)`,
      '--body', `Written by \`scripts/marketing-regate-pr.mjs\` from the scheduler's monthly step.\n\n\`\`\`\n${summary}\n\`\`\``],
    { cwd: dir });
    run('gh', ['pr', 'merge', url, '--merge', '--delete-branch'], { cwd: dir });
    console.log(`\nMerged ${url}`);
    await notify({
      subject: `Marketing re-gate shipped: ${changed.length} skill file(s), ${url}`,
      body: `Merged to main. The server picks it up on the next deploy pull.\n\n${summary}`,
      status: 'success',
      category: 'marketing-learner',
    });
  } catch (err) {
    console.error(`✗ marketing re-gate PR failed: ${err.message}`);
    await notify({
      subject: 'Marketing re-gate PR failed',
      body: `${err.message}\n\nThe live checkout was not modified; the worktree was discarded.`,
      status: 'error',
      category: 'marketing-learner',
    });
    process.exitCode = 1;
  } finally {
    removeWorktree(dir);
  }
}

if (isDirectRun(import.meta.url)) main();
