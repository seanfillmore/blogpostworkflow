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
 *   - `npm test` introduces NO NEW failing test against a baseline run of
 *     origin/main, and neither run has a cancelled test or `# pass 0`;
 *   - lib/fix-diff-rules.js passes on the diff root actually ships.
 *
 * WHO RUNS WHAT, and why root never touches /srv/recap-fix with git.
 * The fix checkout is a clone owned by the unprivileged user `recapfix`
 * (lib/fix-session.js). Code from the fix branch can write anything into that
 * repo during `npm test`: `.git/hooks/*`, `core.fsmonitor`, a diff driver. Any
 * git command root ran THERE would execute it as root with the GitHub token in
 * the environment. So:
 *   - recapfix runs fetch, rebase, both `npm test` runs and `git bundle create`,
 *     with hooks and fsmonitor off on its git calls too, and the checkout must
 *     be clean (nothing untracked or ignored but node_modules/) before the
 *     baseline, after it, and after the fix tests, so the tested tree is the
 *     committed tree;
 *   - root reads the bundle as BYTES (lstat: a regular file, not a symlink,
 *     under 50 MB; opened O_NOFOLLOW), copies it into a root-owned ship clone
 *     under `shipRoot`, fetches it there, and does every diff, push and revert
 *     in that clone, with core.hooksPath=/dev/null and core.fsmonitor=false on
 *     every git call, --no-ext-diff --no-textconv on diff/log, and
 *     GIT_CONFIG_NOSYSTEM=1 / GIT_CONFIG_GLOBAL=/dev/null in its env;
 *   - the shipped tip must equal the sha recapfix tested, so a test that
 *     commits something after running cannot ship untested code;
 *   - a revert happens entirely in the root ship clone: no AI code executes.
 *
 * The GitHub token reaches git only through GIT_CONFIG_* env vars on a push:
 * never argv, never a remote URL, never a file or a log line.
 */
import { constants } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { checkFixDiff } from './fix-diff-rules.js';
import { createPullRequest, mergePullRequest, REPO } from './github-pr.js';

const REPO_URL = `https://github.com/${REPO}.git`;
const GENERATED = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';
const CUTOFF_MINUTES = 13 * 60 + 45;
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
/** Every git call (fetch, push and clone included) and the deploy are bounded. */
export const GIT_TIMEOUT_MS = 5 * 60_000;
export const DEPLOY_TIMEOUT_MS = 15 * 60_000;
const REAP_TIMEOUT_MS = 60_000;
/** The TAP reporter is requested explicitly: Node >= 23 prints spec format by default. */
export const NPM_TEST_ARGS = Object.freeze(['test', '--', '--test-reporter=tap']);
/** On every root git call. */
export const SAFE_GIT = Object.freeze(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']);
const NO_DRIVERS = ['--no-ext-diff', '--no-textconv'];

export function pastMergeCutoff(date) {
  return date.getUTCHours() * 60 + date.getUTCMinutes() >= CUTOFF_MINUTES;
}

/**
 * Failing tests from node --test TAP, keyed `<file>::<name>` when the YAML block
 * under the `not ok` line carries `location: '<file>:<line>:<col>'`, else `<name>`.
 */
function failingTests(text) {
  const lines = String(text || '').split('\n');
  const out = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^\s*not ok \d+ - (.+?)\s*(?:# .*)?$/);
    if (!m) continue;
    let file = null;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\s*\.\.\.\s*$/.test(lines[j]) || /^\s*(?:not )?ok \d+ /.test(lines[j])) break;
      const loc = lines[j].match(/^\s*location:\s*'?(.+?):\d+:\d+'?\s*$/);
      if (loc) { file = loc[1]; break; }
    }
    out.add(file ? `${file}::${m[1].trim()}` : m[1].trim());
  }
  return [...out];
}

/** node --test TAP output: counters (last occurrence) and failing tests. */
export function parseTestSummary(text) {
  const s = String(text || '');
  const count = (k) => {
    const all = [...s.matchAll(new RegExp(`^# ${k} (\\d+)\\s*$`, 'gm'))];
    return all.length ? Number(all[all.length - 1][1]) : null;
  };
  const failing = failingTests(s);
  const summary = s.split('\n').filter((l) => /^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) /.test(l)).join('\n');
  return { pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), failing, summary };
}

/**
 * The test gate: both runs sane (pass > 0, cancelled 0), and every test failing
 * on the fix also fails on the origin/main baseline.
 */
export function compareTestRuns(baselineText, fixText) {
  const b = parseTestSummary(baselineText);
  const f = parseTestSummary(fixText);
  const problems = [];
  for (const [label, r] of [['baseline', b], ['fix', f]]) {
    if (r.pass === null || r.cancelled === null || r.fail === null) problems.push(`${label} tests: summary missing # pass/# fail/# cancelled`);
    else {
      if (r.pass <= 0) problems.push(`${label} tests: # pass 0`);
      if (r.cancelled !== 0) problems.push(`${label} tests: # cancelled ${r.cancelled}`);
    }
  }
  const base = new Set(b.failing);
  for (const name of f.failing) if (!base.has(name)) problems.push(`new failing test: ${name}`);
  return { ok: problems.length === 0, problems, baseline: b, fix: f };
}

export function pushAuthEnv(token, baseEnv = process.env) {
  return {
    ...baseEnv,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
}

/**
 * Default deploy: scripts/deploy-server.sh in the production repo.
 * Exit 3 means the pull never happened (server unchanged).
 * @returns {Promise<{ok: boolean, pulled: boolean, output: string, headBefore: string}>}
 */
export async function deployServer({ exec, prodRoot = '/root/seo-claude' }) {
  const h = await exec('git', [...SAFE_GIT, '-C', prodRoot, 'rev-parse', 'HEAD'], { timeout: GIT_TIMEOUT_MS });
  const headBefore = String(h.stdout || '').trim();
  const r = await exec('bash', ['scripts/deploy-server.sh'], { cwd: prodRoot, timeout: DEPLOY_TIMEOUT_MS });
  // A timed-out deploy may or may not have pulled; `pulled` stays true so the
  // revert path deploys the revert rather than assuming the server is unchanged.
  const timedOutNote = r.timedOut || r.code === null ? `\ndeploy-server.sh timed out after ${DEPLOY_TIMEOUT_MS / 60_000} minutes; server state unknown` : '';
  return { ok: r.code === 0, pulled: r.code !== 3, output: `${r.stdout || ''}${r.stderr || ''}${timedOutNote}`, headBefore };
}

const tail = (s, n = 1500) => { const t = String(s || '').trim(); return t.length > n ? `…${t.slice(-n)}` : t; };
const timedOut = (r) => !!r?.timedOut || r?.code === null || r?.signal === 'SIGTERM' || r?.signal === 'SIGKILL';

/**
 * `git status --porcelain --untracked-files=all --ignored` -> every listed path
 * except ignored files under node_modules/ (installed by npm ci).
 */
export function dirtyPaths(porcelain) {
  const bad = [];
  for (const line of String(porcelain || '').split('\n')) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const path = line.slice(3).trim();
    if (code === '!!' && path.startsWith('node_modules/')) continue;
    bad.push(path);
  }
  return bad;
}

/** Read the recapfix-written bundle as bytes, refusing anything but a small regular file. */
async function readBundle(src, fsImpl) {
  const st = await fsImpl.lstat(src);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`bundle is not a regular file: ${src}`);
  if (st.size >= MAX_BUNDLE_BYTES) throw new Error(`bundle too large: ${st.size} bytes`);
  const fh = await fsImpl.open(src, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const st2 = await fh.stat();
    if (!st2.isFile() || st2.size >= MAX_BUNDLE_BYTES) throw new Error('bundle changed while opening');
    const buf = await fh.readFile();
    if (buf.length >= MAX_BUNDLE_BYTES) throw new Error(`bundle too large: ${buf.length} bytes`);
    return buf;
  } finally {
    await fh.close();
  }
}

export async function shipFix({
  worktree, item, session, now = new Date(), exec, gh = {}, deploy, rerun, token,
  prodRoot = '/root/seo-claude', shipRoot = '/root/recap-ship', runAs = 'recapfix',
  runuserBin = '/usr/sbin/runuser', env = process.env, fsImpl = fsp, testTimeoutMs = 20 * 60_000,
}) {
  if (session?.verdict !== 'fixed') {
    return { outcome: 'refused', problems: [`session verdict: ${session?.verdict}`, ...(session?.summary ? [session.summary] : [])] };
  }
  const clock = typeof now === 'function' ? now : () => now;
  if (pastMergeCutoff(clock())) return { outcome: 'too-late' };

  const createPR = gh.createPullRequest || createPullRequest;
  const mergePR = gh.mergePullRequest || mergePullRequest;
  const userEnv = { HOME: `/home/${runAs}`, PATH: '/usr/local/bin:/usr/bin:/bin' };
  const asUser = (cmd, args, opts = {}) => exec(runuserBin, ['-u', runAs, '--', cmd, ...args], { env: userEnv, ...opts });
  // Hooks and fsmonitor off even as recapfix: the session may have written .git/hooks/post-checkout.
  const uGit = (args) => asUser('git', [...SAFE_GIT, '-C', worktree, ...args], { timeout: GIT_TIMEOUT_MS });
  const name = String(worktree).split('/').pop().replace(/^fix-/, '');
  const branch = `fix/recap-${name}`;
  const shipDir = `${shipRoot}/${name}`;
  const bundleSrc = `${worktree}.bundle`;
  const bundleCopy = `${shipRoot}/${name}.bundle`;
  // Root git in the ship clone ignores system and global config; the token's
  // GIT_CONFIG_* vars are added on the push only.
  const shipEnv = { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (args, opts = {}) => exec('git', [...SAFE_GIT, '-C', shipDir, ...args], { env: shipEnv, timeout: GIT_TIMEOUT_MS, ...opts });
  const prodGit = (args) => exec('git', [...SAFE_GIT, '-C', prodRoot, ...args], { timeout: GIT_TIMEOUT_MS });
  // A git call that hit its timeout says so in the refusal, not just "failed".
  const why = (r) => (r?.timedOut || r?.code === null ? `timed out after ${GIT_TIMEOUT_MS / 60_000} minutes` : tail(r?.stderr || r?.stdout, 300));
  const refused = (problems, extra = {}) => ({ outcome: 'refused', problems, ...extra });
  const out = (r) => `${r.stdout || ''}\n${r.stderr || ''}`;
  // Nothing a test run started may outlive it. Run as recapfix (exit 1 = none left).
  const reap = () => asUser('pkill', ['-u', runAs], { timeout: REAP_TIMEOUT_MS });
  const runTests = async () => {
    const r = await asUser('npm', [...NPM_TEST_ARGS], { cwd: worktree, timeout: testTimeoutMs });
    await reap();
    return r;
  };
  // The tested tree must be exactly the committed tree: anything untracked or
  // ignored (other than node_modules/) reaches the tests but not the bundle.
  const cleanTree = async (when) => {
    const st = await uGit(['status', '--porcelain', '--untracked-files=all', '--ignored']);
    if (st.code !== 0) return [`git status failed ${when}: ${tail(st.stderr, 300)}`];
    const bad = dirtyPaths(st.stdout);
    return bad.length ? [`checkout not clean ${when}: ${bad.slice(0, 20).join(', ')}${bad.length > 20 ? ` (+${bad.length - 20} more)` : ''}`] : [];
  };

  const push = async (ref, remoteBranch) => {
    const r = await git(['push', REPO_URL, `${ref}:refs/heads/${remoteBranch}`], { env: pushAuthEnv(token, shipEnv) });
    if (r.code !== 0) throw new Error(`push ${remoteBranch} failed: ${why(r)}`);
  };

  // 2. fresh fetch, baseline tests on origin/main, back to the branch, rebase. All recapfix.
  const f = await uGit(['fetch', 'origin']);
  if (f.code !== 0) return refused([`git fetch failed: ${why(f)}`]);
  const dirty0 = await cleanTree('before the baseline');
  if (dirty0.length) return refused(dirty0);
  const co = await uGit(['checkout', '--detach', 'origin/main']);
  if (co.code !== 0) return refused([`checkout of origin/main for the baseline failed: ${tail(co.stderr, 300)}`]);
  const base = await runTests();
  const back = await uGit(['checkout', branch]);
  if (back.code !== 0) return refused([`could not return to ${branch}: ${tail(back.stderr, 300)}`]);
  if (timedOut(base)) return refused(['baseline npm test timed out']);
  const dirty1 = await cleanTree('after the baseline tests');
  if (dirty1.length) return refused(dirty1);
  const rb = await uGit(['rebase', 'origin/main']);
  if (rb.code !== 0) {
    await uGit(['rebase', '--abort']);
    return refused([`rebase onto origin/main failed: ${tail(rb.stderr || rb.stdout, 300)}`]);
  }
  const testedBase = String((await uGit(['rev-parse', 'origin/main'])).stdout || '').trim();
  const testedSha = String((await uGit(['rev-parse', 'HEAD'])).stdout || '').trim();

  // 3. fix tests, as recapfix
  const t = await runTests();
  if (timedOut(t)) return refused(['npm test timed out']);
  const dirty2 = await cleanTree('after the fix tests');
  if (dirty2.length) return refused(dirty2);
  const tipAfter = String((await uGit(['rev-parse', 'HEAD'])).stdout || '').trim();
  if (tipAfter !== testedSha) return refused([`HEAD moved during the fix tests (${testedSha} -> ${tipAfter})`]);
  const tests = compareTestRuns(out(base), out(t));
  if (!tests.ok) return refused(tests.problems);

  // 4. bundle (recapfix) -> bytes copied by root -> root-owned ship clone
  const bun = await uGit(['bundle', 'create', bundleSrc, 'origin/main..HEAD']);
  if (bun.code !== 0) return refused([`git bundle failed: ${tail(bun.stderr, 300)}`]);
  try {
    const bytes = await readBundle(bundleSrc, fsImpl);
    await fsImpl.mkdir(shipRoot, { recursive: true, mode: 0o700 });
    await fsImpl.rm(shipDir, { recursive: true, force: true });
    await fsImpl.writeFile(bundleCopy, bytes, { mode: 0o600 });
  } catch (e) {
    return refused([e.message]);
  }
  const cl = await exec('git', [...SAFE_GIT, 'clone', '--quiet', REPO_URL, shipDir], { env: shipEnv, timeout: GIT_TIMEOUT_MS });
  if (cl.code !== 0) return refused([`ship clone failed: ${why(cl)}`]);
  const fb = await git(['fetch', bundleCopy, `HEAD:refs/heads/${branch}`]);
  if (fb.code !== 0) return refused([`fetch from bundle failed: ${tail(fb.stderr, 300)}`]);
  const tip = String((await git(['rev-parse', branch])).stdout || '').trim();
  if (!tip || tip !== testedSha) return refused([`shipped tip ${tip || '(none)'} is not the tested commit ${testedSha}`]);

  // 5. deterministic diff rules on exactly what ships
  const range = `origin/main...${branch}`;
  const ns = await git(['diff', ...NO_DRIVERS, '--numstat', range]);
  const pt = await git(['diff', ...NO_DRIVERS, range]);
  if (ns.code !== 0 || pt.code !== 0) return refused(['could not read the fix diff']);
  const diff = checkFixDiff({ numstat: ns.stdout, patch: pt.stdout });
  if (!diff.ok) return refused(diff.problems);
  const testsTouched = String(ns.stdout).split('\n').map((l) => l.split('\t').slice(2).join('\t').trim()).filter((p) => p.includes('tests/'));
  const fixLog = await git(['log', ...NO_DRIVERS, '--format=%H', `origin/main..${branch}`]);
  const fixShas = new Set(String(fixLog.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean));

  // 6. push + PR
  let pr;
  try {
    await push(branch, branch);
    pr = await createPR({
      token, head: branch,
      title: `fix(recap): ${String(item.subject || item.key).slice(0, 80)}`,
      body: [
        'Automatic fix by the recap reviewer (merged without human review; auto-reverts if the deploy or re-run fails).',
        '', '## Error', `**${item.subject}**`, `Source: \`${item.source || '(unknown)'}\``, '', '```', tail(item.detail), '```',
        '', '## Session summary', session.summary || '(none)',
        '', '## Test added', ...(testsTouched.length ? testsTouched.map((p) => `- \`${p}\``) : ['- (none listed)']),
        '', '## Test summary', '```', tests.fix.summary, '```',
        ...(tests.baseline.failing.length ? ['', `Pre-existing failures on origin/main (also failing here): ${tests.baseline.failing.join('; ')}`] : []),
        '', GENERATED,
      ].join('\n'),
    });
  } catch (e) {
    return refused([e.message], pr ? { pr } : {});
  }

  // 7. merge, unless the cutoff passed while testing
  if (pastMergeCutoff(clock())) return { outcome: 'too-late', pr };
  let mergeSha;
  try { ({ sha: mergeSha } = await mergePR({ token, number: pr.number })); } catch (e) { return refused([e.message], { pr }); }

  const extra = {};
  await git(['fetch', 'origin']);
  const parent = String((await git(['rev-parse', `${mergeSha}^1`])).stdout || '').trim();
  if (parent && testedBase && parent !== testedBase) extra.mainMovedSinceTest = true;

  // 8. what else this deploy ships (server HEAD read before deploying)
  let otherCommits = [];
  const head = await prodGit(['rev-parse', 'HEAD']);
  const serverHead = String(head.stdout || '').trim();
  if (head.code === 0 && serverHead) {
    await prodGit(['fetch', 'origin']);
    const lg = await prodGit(['log', ...NO_DRIVERS, '--format=%H %s', `${serverHead}..origin/main`]);
    otherCommits = String(lg.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean)
      .filter((l) => { const sha = l.split(' ')[0]; return sha !== mergeSha && !fixShas.has(sha); })
      .map((l) => { const i = l.indexOf(' '); return `${l.slice(0, 7)} ${l.slice(i + 1)}`; });
  }

  // 9. deploy, then verify
  let failure = null;
  let verify;
  const d = await deploy();
  const pulled = d?.pulled !== false;
  if (!d?.ok) failure = `deploy failed${pulled ? '' : ' (never pulled)'}: ${tail(d?.output, 500)}`;
  else if (rerun === null || rerun === undefined) verify = 'next-scheduled-run';
  else {
    const rr = await rerun();
    if (rr?.ok) verify = 'rerun';
    else failure = `rerun failed: ${tail(rr?.output, 500)}`;
  }
  if (!failure) return { outcome: 'deployed', pr, otherCommits, verify, ...extra };

  // 10. revert, in the root ship clone. No cutoff and no AI code runs.
  const serverState = pulled ? 'the server has the fix deployed' : `server HEAD unchanged at ${d?.headBefore || serverHead || '(unknown)'}`;
  const rbranch = `revert/recap-${name}`;
  let revertPr;
  try {
    for (const args of [
      ['fetch', 'origin'],
      ['checkout', '-b', rbranch, 'origin/main'],
      ['-c', 'user.name=Recap Reviewer', '-c', 'user.email=recap-reviewer@realskincare.com', 'revert', '-m', '1', '--no-edit', mergeSha],
    ]) {
      const r = await git(args);
      if (r.code !== 0) throw new Error(`git ${args.find((a) => ['fetch', 'checkout', 'revert'].includes(a))} failed: ${tail(r.stderr || r.stdout, 300)}`);
    }
    await push('HEAD', rbranch);
    revertPr = await createPR({
      token, head: rbranch,
      title: `revert(recap): #${pr.number} ${String(item.subject || item.key).slice(0, 70)}`,
      body: [`Automatic revert of #${pr.number} (merge ${mergeSha}).`, '', `Reason: ${failure}`, '', GENERATED].join('\n'),
    });
    await mergePR({ token, number: revertPr.number });
  } catch (e) {
    throw new Error(`recap fix #${pr.number} (${mergeSha}) is merged to main and NOT reverted; ${serverState}. Revert failed: ${e.message}. Original failure: ${failure}`);
  }

  if (!pulled) {
    const headBefore = d?.headBefore || serverHead || '(unknown)';
    return {
      outcome: 'not-deployed', pr, revertPr, otherCommits, problems: [failure], ...extra,
      message: `deploy never landed; main has fix + revert; HEAD unchanged at ${headBefore}`,
    };
  }
  const d2 = await deploy();
  if (!d2?.ok) {
    const state = d2?.pulled === false ? 'the server still runs the fix (revert not pulled)' : 'the revert was pulled but the server did not come back online';
    throw new Error(`recap fix #${pr.number} (${mergeSha}) was reverted on main by #${revertPr.number}, but deploying the revert failed: ${state}. ${tail(d2?.output, 500)}`);
  }
  return { outcome: 'reverted', pr, revertPr, otherCommits, problems: [failure], ...extra };
}
