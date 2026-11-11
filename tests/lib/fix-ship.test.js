import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shipFix, parseTestSummary, compareTestRuns, pastMergeCutoff, deployServer, pushAuthEnv, SAFE_GIT,
} from '../../lib/fix-ship.js';

const WT = '/srv/recap-fix/fix-foo';
const SHIP = '/root/recap-ship/foo';
const PROD = '/root/seo-claude';
const TOKEN = 'ghp_SECRET123';
const EARLY = new Date('2026-11-11T11:30:00Z');
const LATE = new Date('2026-11-11T13:45:00Z');
const GEN = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';

const GOOD_NUMSTAT = '3\t1\tlib/foo.js\n10\t0\ttests/lib/foo.test.js\n';
const GOOD_PATCH = [
  'diff --git a/lib/foo.js b/lib/foo.js', '--- a/lib/foo.js', '+++ b/lib/foo.js', '@@ -1 +1 @@', '-const x = 1;', '+const x = 2;',
  'diff --git a/tests/lib/foo.test.js b/tests/lib/foo.test.js', '--- a/tests/lib/foo.test.js', '+++ b/tests/lib/foo.test.js', '@@ -0,0 +1 @@', "+test('x', () => {});",
].join('\n');
const tap = (pass, fail, cancelled, failing = []) =>
  `TAP version 13\nok 1 - a\n${failing.map((n, i) => `not ok ${i + 2} - ${n}\n`).join('')}# tests ${pass + fail}\n# pass ${pass}\n# fail ${fail}\n# cancelled ${cancelled}\n`;
const KNOWN = ['extractRecipe stays linear', 'publish target ships only the new template'];
const BASELINE = tap(10, 2, 0, KNOWN);
const GREEN = tap(12, 2, 0, KNOWN);

const item = { key: 'k1', subject: 'Foo agent failed', source: 'agents/foo/index.js', detail: 'TypeError: x is undefined' };
const session = { verdict: 'fixed', summary: 'guarded the undefined x' };

/** u: = as recapfix (runuser), r: = as root. SAFE_GIT flags stripped for readability. */
function label(cmd, args) {
  if (cmd === '/usr/sbin/runuser') return `u:${args.slice(args.indexOf('--') + 1).join(' ')}`;
  const a = args.join(' ').replace(`${SAFE_GIT.join(' ')} `, '');
  return `r:${cmd} ${a}`;
}

function fakeExec(over = {}) {
  const calls = [];
  let detached = false;
  const exec = async (cmd, args, opts) => {
    const l = label(cmd, args);
    calls.push({ cmd, args, opts, l });
    const res = (r) => ({ stdout: '', stderr: '', code: 0, ...r });
    for (const [needle, r] of Object.entries(over)) {
      if (needle.startsWith('npm test')) continue;
      if (l.includes(needle)) return res(r);
    }
    if (l.includes('checkout --detach origin/main')) { detached = true; return res(); }
    if (l === `u:git -C ${WT} checkout fix/recap-foo`) { detached = false; return res(); }
    if (l === 'u:npm test') return res(detached ? (over['npm test baseline'] || { stdout: BASELINE, code: 1 }) : (over['npm test fix'] || { stdout: GREEN, code: 1 }));
    if (l === `u:git -C ${WT} rev-parse origin/main`) return res({ stdout: 'basesha\n' });
    if (l === `u:git -C ${WT} rev-parse HEAD`) return res({ stdout: 'testedsha\n' });
    if (l === `r:git -C ${SHIP} rev-parse fix/recap-foo`) return res({ stdout: 'testedsha\n' });
    if (l.includes('--numstat')) return res({ stdout: GOOD_NUMSTAT });
    if (l === `r:git -C ${SHIP} diff --no-ext-diff --no-textconv origin/main...fix/recap-foo`) return res({ stdout: GOOD_PATCH });
    if (l.includes('log --no-ext-diff --no-textconv --format=%H origin/main..fix/recap-foo')) return res({ stdout: 'fixsha1\n' });
    if (l === `r:git -C ${SHIP} rev-parse mergesha^1`) return res({ stdout: 'basesha\n' });
    if (l === `r:git -C ${PROD} rev-parse HEAD`) return res({ stdout: 'serverhead\n' });
    if (l.includes('--format=%H %s serverhead..origin/main')) {
      return res({ stdout: 'mergesha Merge pull request #7\nfixsha1 fix(foo): guard x\nother111 feat: someone else\n' });
    }
    return res();
  };
  exec.calls = calls;
  return exec;
}

function fakeFs({ symlink = false, size = 1000 } = {}) {
  const writes = [];
  const st = (file) => ({ isFile: () => file, isSymbolicLink: () => !file, size });
  return {
    writes,
    lstat: async () => st(!symlink),
    open: async () => ({ stat: async () => st(true), readFile: async () => Buffer.from('BUNDLE'), close: async () => {} }),
    mkdir: async () => {},
    rm: async (p) => { writes.push(['rm', p]); },
    writeFile: async (p, b) => { writes.push(['write', p, String(b)]); },
  };
}

function fakeGh() {
  const calls = [];
  let n = 6;
  return {
    calls,
    createPullRequest: async (a) => { calls.push(['pr', a]); n += 1; return { number: n, url: `https://github.com/x/pull/${n}` }; },
    mergePullRequest: async (a) => { calls.push(['merge', a]); return { sha: a.number === 7 ? 'mergesha' : 'revertmergesha' }; },
  };
}

function base(over = {}) {
  const exec = over.exec || fakeExec();
  const gh = over.gh || fakeGh();
  const fsImpl = over.fsImpl || fakeFs();
  const deployCalls = [];
  const deploy = over.deploy || (async () => { deployCalls.push(1); return { ok: true, pulled: true, output: 'online', headBefore: 'serverhead' }; });
  const rerun = 'rerun' in over ? over.rerun : async () => ({ ok: true, output: 'ok' });
  return {
    args: { worktree: WT, item, session, now: EARLY, exec, gh, deploy, rerun, token: TOKEN, prodRoot: PROD, shipRoot: '/root/recap-ship', fsImpl },
    exec, gh, fsImpl, deployCalls,
  };
}

// ---- pure helpers ----

test('parseTestSummary reads counters and failing names', () => {
  const r = parseTestSummary(tap(3, 1, 0, ['thing breaks']));
  assert.equal(r.pass, 3); assert.equal(r.fail, 1); assert.equal(r.cancelled, 0);
  assert.deepEqual(r.failing, ['thing breaks']);
  assert.deepEqual(parseTestSummary('    not ok 4 - nested name # TODO\n').failing, ['nested name']);
});

test('compareTestRuns: the same pre-existing failures pass', () => {
  assert.equal(compareTestRuns(BASELINE, GREEN).ok, true);
});

test('compareTestRuns: a new failure is refused and named', () => {
  const r = compareTestRuns(BASELINE, tap(11, 3, 0, [...KNOWN, 'brand new failure']));
  assert.equal(r.ok, false);
  assert.ok(r.problems.includes('new failing test: brand new failure'));
});

test('compareTestRuns: a cancelled test in either run is refused', () => {
  assert.equal(compareTestRuns(tap(10, 2, 1, KNOWN), GREEN).ok, false);
  assert.equal(compareTestRuns(BASELINE, tap(12, 2, 1, KNOWN)).ok, false);
});

test('compareTestRuns: pass 0 or a missing summary is refused', () => {
  assert.equal(compareTestRuns(BASELINE, tap(0, 0, 0)).ok, false);
  assert.equal(compareTestRuns('', GREEN).ok, false);
});

test('pastMergeCutoff is 13:45 UTC', () => {
  assert.equal(pastMergeCutoff(new Date('2026-11-11T13:44:59Z')), false);
  assert.equal(pastMergeCutoff(new Date('2026-11-11T13:45:00Z')), true);
});

test('pushAuthEnv builds the extraheader from the token', () => {
  const e = pushAuthEnv('abc', { PATH: '/bin' });
  assert.equal(e.PATH, '/bin');
  assert.equal(e.GIT_CONFIG_COUNT, '1');
  assert.equal(e.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.equal(e.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from('x-access-token:abc').toString('base64')}`);
});

// ---- refusals ----

test('a session verdict other than fixed is refused with its summary, nothing executed', async () => {
  const { args, exec, gh } = base();
  const r = await shipFix({ ...args, session: { verdict: 'gate', summary: 'the gate was right' } });
  assert.equal(r.outcome, 'refused');
  assert.deepEqual(r.problems, ['session verdict: gate', 'the gate was right']);
  assert.equal(exec.calls.length, 0);
  assert.equal(gh.calls.length, 0);
});

test('after 13:45 UTC: too-late and no exec calls', async () => {
  const { args, exec } = base();
  const r = await shipFix({ ...args, now: LATE });
  assert.equal(r.outcome, 'too-late');
  assert.equal(exec.calls.length, 0);
});

test('baseline runs on detached origin/main before the rebase, then the branch is restored', async () => {
  const { args, exec } = base();
  await shipFix(args);
  const ls = exec.calls.map((c) => c.l);
  const i = (s) => ls.indexOf(s);
  assert.ok(i(`u:git -C ${WT} fetch origin`) < i(`u:git -C ${WT} checkout --detach origin/main`));
  assert.ok(i(`u:git -C ${WT} checkout --detach origin/main`) < i('u:npm test'));
  assert.ok(i('u:npm test') < i(`u:git -C ${WT} checkout fix/recap-foo`));
  assert.ok(i(`u:git -C ${WT} checkout fix/recap-foo`) < i(`u:git -C ${WT} rebase origin/main`));
  assert.ok(i(`u:git -C ${WT} rebase origin/main`) < ls.lastIndexOf('u:npm test'));
  assert.equal(ls.filter((l) => l === 'u:npm test').length, 2);
});

test('a cancelled test on the fix run is refused, nothing pushed', async () => {
  const exec = fakeExec({ 'npm test fix': { stdout: tap(12, 2, 1, KNOWN), code: 1 } });
  const { args, gh } = base({ exec });
  const r = await shipFix(args);
  assert.equal(r.outcome, 'refused');
  assert.ok(r.problems.some((p) => /cancelled/.test(p)));
  assert.ok(!exec.calls.some((c) => c.l.includes(' push ')));
  assert.equal(gh.calls.length, 0);
});

test('a new failing test is refused with its name', async () => {
  const exec = fakeExec({ 'npm test fix': { stdout: tap(11, 3, 0, [...KNOWN, 'foo now throws']), code: 1 } });
  const { args } = base({ exec });
  const r = await shipFix(args);
  assert.equal(r.outcome, 'refused');
  assert.ok(r.problems.includes('new failing test: foo now throws'));
});

test('npm test runs with a timeout, and a timeout is refused', async () => {
  const exec = fakeExec({ 'npm test fix': { stdout: '', code: null, timedOut: true } });
  const { args } = base({ exec });
  const r = await shipFix({ ...args, testTimeoutMs: 1234 });
  assert.equal(r.outcome, 'refused');
  assert.ok(r.problems.some((p) => /timed out/.test(p)));
  for (const c of exec.calls.filter((x) => x.l === 'u:npm test')) {
    assert.equal(c.opts.timeout, 1234);
    assert.equal(c.opts.cwd, WT);
    assert.deepEqual(c.opts.env, { HOME: '/home/recapfix', PATH: '/usr/local/bin:/usr/bin:/bin' });
  }
});

test('a diff problem is refused with no push', async () => {
  const exec = fakeExec({ '--numstat': { stdout: '2\t2\tlib/post-lock.js\n1\t0\ttests/x.test.js\n' } });
  const { args, gh } = base({ exec });
  const r = await shipFix(args);
  assert.equal(r.outcome, 'refused');
  assert.ok(r.problems.some((p) => /gate file: lib\/post-lock\.js/.test(p)));
  assert.ok(!exec.calls.some((c) => c.l.includes(' push ')));
  assert.equal(gh.calls.length, 0);
});

test('a failed rebase is aborted and refused', async () => {
  const exec = fakeExec({ 'rebase origin/main': { code: 1, stderr: 'CONFLICT' } });
  const { args } = base({ exec });
  const r = await shipFix(args);
  assert.equal(r.outcome, 'refused');
  assert.ok(exec.calls.some((c) => c.l === `u:git -C ${WT} rebase --abort`));
});

test('a symlinked bundle is refused and nothing is cloned or pushed', async () => {
  const { args, exec, fsImpl } = base({ fsImpl: fakeFs({ symlink: true }) });
  const r = await shipFix(args);
  assert.equal(r.outcome, 'refused');
  assert.ok(r.problems.some((p) => /not a regular file/.test(p)));
  assert.ok(!exec.calls.some((c) => c.l.includes(' clone ') || c.l.includes(' push ')));
  assert.equal(fsImpl.writes.filter(([k]) => k === 'write').length, 0);
});

test('an oversized bundle is refused', async () => {
  const { args } = base({ fsImpl: fakeFs({ size: 60 * 1024 * 1024 }) });
  const r = await shipFix(args);
  assert.equal(r.outcome, 'refused');
  assert.ok(r.problems.some((p) => /too large/.test(p)));
});

test('a shipped tip that is not the tested commit is refused', async () => {
  const exec = fakeExec({ [`-C ${SHIP} rev-parse fix/recap-foo`]: { stdout: 'othersha\n' } });
  const { args } = base({ exec });
  const r = await shipFix(args);
  assert.equal(r.outcome, 'refused');
  assert.ok(r.problems.some((p) => /not the tested commit/.test(p)));
  assert.ok(!exec.calls.some((c) => c.l.includes(' push ')));
});

// ---- isolation ----

test('root never runs git inside /srv/recap-fix, and every root git call disables hooks and fsmonitor', async () => {
  const { args, exec } = base({ rerun: async () => ({ ok: false, output: 'x' }) }); // exercise the revert path too
  await shipFix(args);
  const rootGit = exec.calls.filter((c) => c.cmd === 'git');
  assert.ok(rootGit.length > 5);
  for (const c of rootGit) {
    assert.ok(!c.args.join(' ').includes('/srv/recap-fix'), c.l);
    assert.deepEqual(c.args.slice(0, 4), [...SAFE_GIT], c.l);
    assert.ok(!c.args.some((a) => a.startsWith('safe.directory')), c.l);
  }
  for (const c of rootGit.filter((x) => x.args.includes('diff') || x.args.includes('log'))) {
    assert.ok(c.args.includes('--no-ext-diff') && c.args.includes('--no-textconv'), c.l);
  }
  // root runs nothing but git
  assert.deepEqual(exec.calls.filter((c) => c.cmd !== 'git' && c.cmd !== '/usr/sbin/runuser'), []);
});

test('recapfix creates the bundle; root copies its bytes into the ship dir and fetches it there', async () => {
  const { args, exec, fsImpl } = base();
  await shipFix(args);
  assert.ok(exec.calls.some((c) => c.l === `u:git -C ${WT} bundle create ${WT}.bundle origin/main..HEAD`));
  assert.deepEqual(fsImpl.writes.find(([k]) => k === 'write'), ['write', '/root/recap-ship/foo.bundle', 'BUNDLE']);
  assert.ok(exec.calls.some((c) => c.l === `r:git clone --quiet https://github.com/seanfillmore/blogpostworkflow.git ${SHIP}`));
  assert.ok(exec.calls.some((c) => c.l === `r:git -C ${SHIP} fetch /root/recap-ship/foo.bundle HEAD:refs/heads/fix/recap-foo`));
});

test('the token is never in argv; only the push env carries the auth header', async () => {
  const { args, exec } = base();
  await shipFix(args);
  for (const c of exec.calls) assert.ok(!JSON.stringify(c.args).includes(TOKEN), c.l);
  const push = exec.calls.find((c) => c.l.includes(' push '));
  assert.equal(push.l, `r:git -C ${SHIP} push https://github.com/seanfillmore/blogpostworkflow.git fix/recap-foo:refs/heads/fix/recap-foo`);
  assert.equal(push.opts.env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`);
  for (const c of exec.calls.filter((x) => x !== push)) assert.ok(!JSON.stringify(c.opts?.env || {}).includes('extraheader'), c.l);
});

// ---- happy path ----

test('happy path: fetch, baseline, rebase, test, push, PR, merge, deploy, rerun → deployed', async () => {
  const { args, exec, gh } = base();
  const seq = [];
  const r = await shipFix({
    ...args,
    exec: async (c, a, o) => { const x = await exec(c, a, o); seq.push(label(c, a)); return x; },
    gh: {
      createPullRequest: async (x) => { seq.push('PR'); return gh.createPullRequest(x); },
      mergePullRequest: async (x) => { seq.push('MERGE'); return gh.mergePullRequest(x); },
    },
    deploy: async () => { seq.push('DEPLOY'); return { ok: true, pulled: true, output: '', headBefore: 'serverhead' }; },
    rerun: async () => { seq.push('RERUN'); return { ok: true, output: '' }; },
  });
  assert.equal(r.outcome, 'deployed');
  assert.equal(r.verify, 'rerun');
  assert.equal(r.mainMovedSinceTest, undefined);
  assert.deepEqual(r.pr, { number: 7, url: 'https://github.com/x/pull/7' });
  assert.deepEqual(r.otherCommits, ['other11 feat: someone else']);
  const steps = [
    seq.indexOf(`u:git -C ${WT} fetch origin`),
    seq.indexOf(`u:git -C ${WT} rebase origin/main`),
    seq.lastIndexOf('u:npm test'),
    seq.findIndex((l) => l.includes(' push ')),
    seq.indexOf('PR'), seq.indexOf('MERGE'), seq.indexOf('DEPLOY'), seq.indexOf('RERUN'),
  ];
  assert.ok(steps.every((i) => i >= 0), JSON.stringify({ steps, seq }));
  assert.deepEqual([...steps].sort((a, b) => a - b), steps);
  assert.ok(seq.indexOf(`r:git -C ${PROD} rev-parse HEAD`) < seq.indexOf('DEPLOY'));
});

test('PR body names the error, summary, test added, test summary, and ends with the generated line', async () => {
  const { args, gh } = base();
  await shipFix(args);
  const [, pr] = gh.calls.find(([k]) => k === 'pr');
  assert.equal(pr.head, 'fix/recap-foo');
  assert.match(pr.body, /Foo agent failed/);
  assert.match(pr.body, /TypeError: x is undefined/);
  assert.match(pr.body, /guarded the undefined x/);
  assert.match(pr.body, /tests\/lib\/foo\.test\.js/);
  assert.match(pr.body, /# pass 12/);
  assert.ok(pr.body.trimEnd().endsWith(GEN));
});

test('rerun null → deployed, verify next-scheduled-run', async () => {
  const { args } = base({ rerun: null });
  const r = await shipFix(args);
  assert.equal(r.outcome, 'deployed');
  assert.equal(r.verify, 'next-scheduled-run');
});

test('main moving between the test and the merge is flagged', async () => {
  const exec = fakeExec({ [`-C ${SHIP} rev-parse mergesha^1`]: { stdout: 'newmainsha\n' } });
  const { args } = base({ exec });
  const r = await shipFix(args);
  assert.equal(r.outcome, 'deployed');
  assert.equal(r.mainMovedSinceTest, true);
});

test('a merge cutoff crossed during the test run leaves the PR open: too-late, no merge', async () => {
  const { args, gh } = base();
  const times = [EARLY, LATE];
  const r = await shipFix({ ...args, now: () => times.shift() || LATE });
  assert.equal(r.outcome, 'too-late');
  assert.ok(r.pr);
  assert.ok(!gh.calls.some(([k]) => k === 'merge'));
});

// ---- revert ----

test('a failed rerun reverts in the root ship clone: branch, PR, merge, second deploy → reverted', async () => {
  const { args, exec, gh, deployCalls } = base({ rerun: async () => ({ ok: false, output: 'still broken' }) });
  const r = await shipFix(args);
  assert.equal(r.outcome, 'reverted');
  assert.deepEqual(r.revertPr, { number: 8, url: 'https://github.com/x/pull/8' });
  assert.ok(r.problems.some((p) => /rerun failed/.test(p)));
  const ls = exec.calls.map((c) => c.l);
  assert.ok(ls.includes(`r:git -C ${SHIP} checkout -b revert/recap-foo origin/main`));
  assert.ok(ls.some((l) => l.startsWith(`r:git -C ${SHIP} -c user.name=Recap Reviewer`) && l.endsWith('revert -m 1 --no-edit mergesha')));
  // no recapfix clone, no AI code, no npm during the revert
  const afterMerge = exec.calls.slice(exec.calls.findIndex((c) => c.l.includes(`-C ${PROD} rev-parse HEAD`)));
  assert.ok(!afterMerge.some((c) => c.cmd === '/usr/sbin/runuser'));
  const pushes = exec.calls.filter((c) => c.l.includes(' push '));
  assert.equal(pushes.length, 2);
  assert.ok(pushes[1].l.endsWith('HEAD:refs/heads/revert/recap-foo'));
  const prs = gh.calls.filter(([k]) => k === 'pr');
  assert.equal(prs[1][1].head, 'revert/recap-foo');
  assert.ok(prs[1][1].body.trimEnd().endsWith(GEN));
  assert.deepEqual(gh.calls.filter(([k]) => k === 'merge').map(([, a]) => a.number), [7, 8]);
  assert.equal(deployCalls.length, 2);
});

test('a deploy that pulled then failed reverts and deploys the revert, ignoring the cutoff', async () => {
  let n = 0;
  const { args, gh } = base({ deploy: async () => { n += 1; return n === 1 ? { ok: false, pulled: true, output: 'pm2 not online' } : { ok: true, pulled: true, output: '' }; } });
  const times = [EARLY, EARLY];
  const r = await shipFix({ ...args, now: () => times.shift() || LATE });
  assert.equal(r.outcome, 'reverted');
  assert.ok(r.problems.some((p) => /deploy failed/.test(p)));
  assert.equal(gh.calls.filter(([k]) => k === 'merge').length, 2);
  assert.equal(n, 2);
});

test('a deploy that never pulled: revert merged to main but NOT deployed → not-deployed', async () => {
  let n = 0;
  const { args, gh } = base({ deploy: async () => { n += 1; return { ok: false, pulled: false, output: 'gate exit 2', headBefore: 'abc1234' }; } });
  const r = await shipFix(args);
  assert.equal(r.outcome, 'not-deployed');
  assert.equal(r.message, 'deploy never landed; main has fix + revert; server unchanged at abc1234');
  assert.equal(gh.calls.filter(([k]) => k === 'merge').length, 2);
  assert.equal(n, 1);
});

test('a revert that cannot be merged throws, stating the real production state', async () => {
  const exec = fakeExec({ 'revert -m 1': { code: 1, stderr: 'conflict' } });
  const { args } = base({ exec, rerun: async () => ({ ok: false, output: 'x' }) });
  await assert.rejects(shipFix(args), /merged to main and NOT reverted; the server has the fix deployed/);
});

test('a never-pulled deploy whose revert fails says the server is unchanged', async () => {
  const exec = fakeExec({ 'revert -m 1': { code: 1, stderr: 'conflict' } });
  const { args } = base({ exec, deploy: async () => ({ ok: false, pulled: false, output: '', headBefore: 'abc1234' }) });
  await assert.rejects(shipFix(args), /NOT reverted; the server is unchanged at abc1234/);
});

test('a revert whose deploy fails throws, saying main is reverted', async () => {
  let n = 0;
  const { args } = base({
    rerun: async () => ({ ok: false, output: 'x' }),
    deploy: async () => { n += 1; return n === 1 ? { ok: true, pulled: true } : { ok: false, pulled: true, output: 'pm2' }; },
  });
  await assert.rejects(shipFix(args), /was reverted on main by #8, but deploying the revert failed/);
});

// ---- deployServer ----

test('deployServer reads HEAD, runs the script in prodRoot, maps exit 3 to pulled:false', async () => {
  const calls = [];
  const mk = (code) => async (c, a, o) => { calls.push([c, a, o]); return c === 'git' ? { stdout: 'h1\n', code: 0 } : { stdout: 'out', stderr: '', code }; };
  const ok = await deployServer({ exec: mk(0), prodRoot: '/p' });
  assert.deepEqual(calls[0][1], [...SAFE_GIT, '-C', '/p', 'rev-parse', 'HEAD']);
  assert.deepEqual(calls[1].slice(0, 2), ['bash', ['scripts/deploy-server.sh']]);
  assert.equal(calls[1][2].cwd, '/p');
  assert.deepEqual(ok, { ok: true, pulled: true, output: 'out', headBefore: 'h1' });
  const never = await deployServer({ exec: mk(3), prodRoot: '/p' });
  assert.equal(never.ok, false); assert.equal(never.pulled, false);
  const unhealthy = await deployServer({ exec: mk(1), prodRoot: '/p' });
  assert.equal(unhealthy.ok, false); assert.equal(unhealthy.pulled, true);
});
