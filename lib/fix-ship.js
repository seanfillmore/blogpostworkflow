/**
 * Ship a fix the autonomous session committed: verify it, merge it to main,
 * deploy it on the production server, re-run the failing job, and revert the
 * whole thing automatically if the deploy or the re-run fails.
 *
 * Sean decided these fixes merge and deploy without his review, so the checks
 * here ARE the gate:
 *   - nothing merges at or after 13:45 UTC (checked at the start and again
 *     immediately before the merge, since a long test run can cross it);
 *   - the branch is rebased onto a fresh origin/main;
 *   - lib/fix-diff-rules.js must pass on the rebased diff;
 *   - `npm test` must exit 0 AND print `# pass N>0`, `# fail 0`, `# cancelled 0`.
 *
 * WHO RUNS WHAT. The fix checkout is a clone owned by the unprivileged user
 * `recapfix` (lib/fix-session.js). Everything that EXECUTES code from the fix
 * branch before merge (fetch, rebase, npm test) runs as that user with a bare
 * { HOME, PATH } env. root only reads the diff (git with safe.directory, since
 * recapfix owns the repo), pushes, calls the GitHub API, and touches the
 * production repo. root never runs `npm test` on unmerged code.
 *
 * The GitHub token reaches git only through GIT_CONFIG_* env vars on the push
 * call: never argv, never a remote URL, never a file or a log line. The push
 * names the repo URL rather than the `origin` remote so root writes no
 * remote-tracking ref into recapfix's repo.
 */
import { checkFixDiff } from './fix-diff-rules.js';
import { createFixCheckout } from './fix-session.js';
import { createPullRequest, mergePullRequest, REPO } from './github-pr.js';

const REPO_URL = `https://github.com/${REPO}.git`;
const GENERATED = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';
const CUTOFF_MINUTES = 13 * 60 + 45;

export function pastMergeCutoff(date) {
  return date.getUTCHours() * 60 + date.getUTCMinutes() >= CUTOFF_MINUTES;
}

/** node --test summary: all three counters present, pass > 0, fail 0, cancelled 0. */
export function parseTestSummary(text) {
  const count = (k) => {
    const all = [...String(text || '').matchAll(new RegExp(`^# ${k} (\\d+)\\s*$`, 'gm'))];
    return all.length ? Number(all[all.length - 1][1]) : null;
  };
  const pass = count('pass'); const fail = count('fail'); const cancelled = count('cancelled');
  const problems = [];
  if (pass === null || fail === null || cancelled === null) problems.push('test summary missing # pass/# fail/# cancelled');
  else {
    if (pass <= 0) problems.push('tests: # pass 0');
    if (fail !== 0) problems.push(`tests: # fail ${fail}`);
    if (cancelled !== 0) problems.push(`tests: # cancelled ${cancelled}`);
  }
  const summary = String(text || '').split('\n').filter((l) => /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /.test(l)).join('\n');
  return { ok: problems.length === 0, pass, fail, cancelled, problems, summary };
}

export function pushAuthEnv(token, baseEnv = process.env) {
  return {
    ...baseEnv,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
}

/** Default deploy: scripts/deploy-server.sh in the production repo. */
export async function deployServer({ exec, prodRoot = '/root/seo-claude' }) {
  const r = await exec('bash', ['scripts/deploy-server.sh'], { cwd: prodRoot });
  return { ok: r.code === 0, output: `${r.stdout || ''}${r.stderr || ''}` };
}

const tail = (s, n = 1500) => { const t = String(s || '').trim(); return t.length > n ? `…${t.slice(-n)}` : t; };

export async function shipFix({
  worktree, item, session, now = new Date(), exec, gh = {}, deploy, rerun, token,
  prodRoot = '/root/seo-claude', runAs = 'recapfix', runuserBin = '/usr/sbin/runuser',
  baseDir = '/srv/recap-fix', env = process.env,
}) {
  if (session?.verdict !== 'fixed') return { outcome: 'refused', problems: [`session verdict: ${session?.verdict}`] };
  const clock = typeof now === 'function' ? now : () => now;
  if (pastMergeCutoff(clock())) return { outcome: 'too-late' };

  const createPR = gh.createPullRequest || createPullRequest;
  const mergePR = gh.mergePullRequest || mergePullRequest;
  const userEnv = { HOME: `/home/${runAs}`, PATH: '/usr/local/bin:/usr/bin:/bin' };
  const asUser = (cmd, args, opts = {}) => exec(runuserBin, ['-u', runAs, '--', cmd, ...args], { env: userEnv, ...opts });
  const rootGit = (wt, args, opts) => exec('git', ['-c', `safe.directory=${wt}`, '-C', wt, ...args], opts);
  const prodGit = (args) => exec('git', ['-C', prodRoot, ...args]);
  const name = String(worktree).split('/').pop().replace(/^fix-/, '');
  const refused = (problems, extra = {}) => ({ outcome: 'refused', problems, ...extra });

  const push = async (wt, branch) => {
    const r = await rootGit(wt, ['push', REPO_URL, `HEAD:refs/heads/${branch}`], { env: pushAuthEnv(token, env) });
    if (r.code !== 0) throw new Error(`push ${branch} failed: ${tail(r.stderr || r.stdout, 300)}`);
  };

  // 2. fresh fetch + rebase, as recapfix
  const f = await asUser('git', ['-C', worktree, 'fetch', 'origin']);
  if (f.code !== 0) return refused([`git fetch failed: ${tail(f.stderr, 300)}`]);
  const rb = await asUser('git', ['-C', worktree, 'rebase', 'origin/main']);
  if (rb.code !== 0) {
    await asUser('git', ['-C', worktree, 'rebase', '--abort']);
    return refused([`rebase onto origin/main failed: ${tail(rb.stderr || rb.stdout, 300)}`]);
  }

  // 3. deterministic diff rules on the rebased diff (root, read-only)
  const ns = await rootGit(worktree, ['diff', '--numstat', 'origin/main...HEAD']);
  const pt = await rootGit(worktree, ['diff', 'origin/main...HEAD']);
  if (ns.code !== 0 || pt.code !== 0) return refused(['could not read the fix diff']);
  const diff = checkFixDiff({ numstat: ns.stdout, patch: pt.stdout });
  if (!diff.ok) return refused(diff.problems);
  const testsTouched = String(ns.stdout).split('\n').map((l) => l.split('\t').slice(2).join('\t').trim())
    .filter((p) => p.includes('tests/'));

  // 4. the full suite, as recapfix
  const t = await asUser('npm', ['test'], { cwd: worktree });
  const out = `${t.stdout || ''}\n${t.stderr || ''}`;
  const summary = parseTestSummary(out);
  if (t.code !== 0 || !summary.ok) {
    return refused([...(t.code !== 0 ? [`npm test exited ${t.code}`] : []), ...summary.problems]);
  }

  // 5. push + PR
  const br = await rootGit(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = String(br.stdout || '').trim();
  if (br.code !== 0 || !branch || branch === 'HEAD') return refused(['could not read the fix branch name']);
  const fixLog = await rootGit(worktree, ['log', '--format=%H', 'origin/main..HEAD']);
  const fixShas = new Set(String(fixLog.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean));
  let pr;
  try {
    await push(worktree, branch);
    pr = await createPR({
      token, head: branch,
      title: `fix(recap): ${String(item.subject || item.key).slice(0, 80)}`,
      body: [
        'Automatic fix by the recap reviewer (merged without human review; auto-reverts if the deploy or re-run fails).',
        '', '## Error', `**${item.subject}**`, `Source: \`${item.source || '(unknown)'}\``, '', '```', tail(item.detail), '```',
        '', '## Session summary', session.summary || '(none)',
        '', '## Test added', ...(testsTouched.length ? testsTouched.map((p) => `- \`${p}\``) : ['- (none listed)']),
        '', '## Test summary', '```', summary.summary, '```',
        '', GENERATED,
      ].join('\n'),
    });
  } catch (e) {
    return refused([e.message], pr ? { pr } : {});
  }

  // 6. merge, unless the cutoff passed while testing
  if (pastMergeCutoff(clock())) return { outcome: 'too-late', pr };
  let mergeSha;
  try { ({ sha: mergeSha } = await mergePR({ token, number: pr.number })); } catch (e) { return refused([e.message], { pr }); }

  // 7. what else this deploy ships (serverHEAD read before deploying)
  let otherCommits = [];
  const head = await prodGit(['rev-parse', 'HEAD']);
  const serverHead = String(head.stdout || '').trim();
  if (head.code === 0 && serverHead) {
    await prodGit(['fetch', 'origin']);
    const lg = await prodGit(['log', '--format=%H %s', `${serverHead}..origin/main`]);
    otherCommits = String(lg.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean)
      .filter((l) => { const sha = l.split(' ')[0]; return sha !== mergeSha && !fixShas.has(sha); })
      .map((l) => { const i = l.indexOf(' '); return `${l.slice(0, 7)} ${l.slice(i + 1)}`; });
  }

  // 8-9. deploy, then verify
  let failure = null;
  let verify;
  const d = await deploy();
  if (!d?.ok) failure = `deploy failed: ${tail(d?.output, 500)}`;
  else if (rerun === null || rerun === undefined) verify = 'next-scheduled-run';
  else {
    const rr = await rerun();
    if (rr?.ok) verify = 'rerun';
    else failure = `rerun failed: ${tail(rr?.output, 500)}`;
  }
  if (!failure) return { outcome: 'deployed', pr, otherCommits, verify };

  // 10. revert. No cutoff: leaving a broken merge live is worse than a late merge.
  // Any failure here throws, so the caller's crash handler escalates it.
  try {
    const rwt = await createFixCheckout(`revert-${name}`, { exec, baseDir, runAs, runuserBin });
    const rbranch = `revert/recap-${name}`;
    for (const args of [['-C', rwt, 'checkout', '-b', rbranch], ['-C', rwt, 'revert', '-m', '1', '--no-edit', mergeSha]]) {
      const r = await asUser('git', args);
      if (r.code !== 0) throw new Error(`git ${args[2]} failed: ${tail(r.stderr || r.stdout, 300)}`);
    }
    await push(rwt, rbranch);
    const revertPr = await createPR({
      token, head: rbranch,
      title: `revert(recap): #${pr.number} ${String(item.subject || item.key).slice(0, 70)}`,
      body: [`Automatic revert of #${pr.number} (merge ${mergeSha}).`, '', `Reason: ${failure}`, '', GENERATED].join('\n'),
    });
    await mergePR({ token, number: revertPr.number });
    const d2 = await deploy();
    if (!d2?.ok) throw new Error(`deploy of the revert failed: ${tail(d2?.output, 500)}`);
    return { outcome: 'reverted', pr, revertPr, otherCommits, problems: [failure] };
  } catch (e) {
    throw new Error(`recap fix #${pr.number} (${mergeSha}) is live and its revert failed (${failure}): ${e.message}`);
  }
}
