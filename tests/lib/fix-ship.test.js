import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shipFix, parseTestSummary, pastMergeCutoff, deployServer, pushAuthEnv } from '../../lib/fix-ship.js';

const WT = '/srv/recap-fix/fix-foo';
const PROD = '/root/seo-claude';
const TOKEN = 'ghp_SECRET123';
const EARLY = new Date('2026-11-11T11:30:00Z');
const LATE = new Date('2026-11-11T13:45:00Z');

const GOOD_NUMSTAT = '3\t1\tlib/foo.js\n10\t0\ttests/lib/foo.test.js\n';
const GOOD_PATCH = [
  'diff --git a/lib/foo.js b/lib/foo.js', '--- a/lib/foo.js', '+++ b/lib/foo.js', '@@ -1 +1 @@', '-const x = 1;', '+const x = 2;',
  'diff --git a/tests/lib/foo.test.js b/tests/lib/foo.test.js', '--- a/tests/lib/foo.test.js', '+++ b/tests/lib/foo.test.js', '@@ -0,0 +1 @@', "+test('x', () => {});",
].join('\n');
const GREEN = 'TAP version 13\n# tests 12\n# suites 0\n# pass 12\n# fail 0\n# cancelled 0\n# skipped 0\n';

const item = { key: 'k1', subject: 'Foo agent failed', source: 'agents/foo/index.js', detail: 'TypeError: x is undefined' };
const session = { verdict: 'fixed', summary: 'guarded the undefined x' };

/** Human-readable label for an exec call: u: = as recapfix, r: = as root. */
function label(cmd, args) {
  if (cmd === '/usr/sbin/runuser') {
    const i = args.indexOf('--');
    return `u:${args.slice(i + 1).join(' ')}`;
  }
  return `r:${[cmd, ...args].join(' ')}`;
}

function fakeExec(overrides = {}) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    const l = label(cmd, args);
    calls.push({ cmd, args, opts, l });
    for (const [needle, res] of Object.entries(overrides)) {
      if (l.includes(needle)) return { stdout: '', stderr: '', code: 0, ...res };
    }
    if (l.includes('diff --numstat')) return { stdout: GOOD_NUMSTAT, stderr: '', code: 0 };
    if (l.includes(' diff origin/main...HEAD')) return { stdout: GOOD_PATCH, stderr: '', code: 0 };
    if (l.includes('npm test')) return { stdout: GREEN, stderr: '', code: 0 };
    if (l.includes('rev-parse --abbrev-ref HEAD')) return { stdout: 'fix/recap-foo\n', stderr: '', code: 0 };
    if (l.includes(`-C ${PROD} rev-parse HEAD`)) return { stdout: 'serverhead\n', stderr: '', code: 0 };
    if (l.includes('log --format=%H origin/main..HEAD')) return { stdout: 'fixsha1\n', stderr: '', code: 0 };
    if (l.includes('log --format=%H %s serverhead..origin/main')) {
      return { stdout: 'mergesha Merge pull request #7\nfixsha1 fix(foo): guard x\nother111 feat: someone else\n', stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };
  exec.calls = calls;
  return exec;
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
  const order = [];
  const deployCalls = [];
  const deploy = over.deploy || (async () => { deployCalls.push(1); order.push('deploy'); return { ok: true, output: 'online' }; });
  const rerun = 'rerun' in over ? over.rerun : async () => { order.push('rerun'); return { ok: true, output: 'ok' }; };
  return { args: { worktree: WT, item, session, now: EARLY, exec, gh, deploy, rerun, token: TOKEN, prodRoot: PROD, ...over.args }, exec, gh, order, deployCalls };
}

test('parseTestSummary needs pass > 0, fail 0 and cancelled 0, all present', () => {
  assert.equal(parseTestSummary(GREEN).ok, true);
  assert.equal(parseTestSummary('# pass 3\n# fail 0\n# cancelled 1\n').ok, false);
  assert.equal(parseTestSummary('# pass 3\n# fail 1\n# cancelled 0\n').ok, false);
  assert.equal(parseTestSummary('# pass 0\n# fail 0\n# cancelled 0\n').ok, false);
  assert.equal(parseTestSummary('# pass 3\n# fail 0\n').ok, false);
  assert.equal(parseTestSummary('').ok, false);
});

test('pastMergeCutoff is 13:45 UTC', () => {
  assert.equal(pastMergeCutoff(new Date('2026-11-11T13:44:59Z')), false);
  assert.equal(pastMergeCutoff(new Date('2026-11-11T13:45:00Z')), true);
  assert.equal(pastMergeCutoff(new Date('2026-11-11T20:00:00Z')), true);
});

test('a session verdict other than fixed is refused with nothing executed', async () => {
  const { args, exec, gh } = base();
  const r = await shipFix({ ...args, session: { verdict: 'gate', summary: 'the gate was right' } });
  assert.equal(r.outcome, 'refused');
  assert.deepEqual(r.problems, ['session verdict: gate']);
  assert.equal(exec.calls.length, 0);
  assert.equal(gh.calls.length, 0);
});

test('after 13:45 UTC: too-late and no exec calls', async () => {
  const { args, exec, gh } = base();
  const r = await shipFix({ ...args, now: LATE });
  assert.equal(r.outcome, 'too-late');
  assert.equal(exec.calls.length, 0);
  assert.equal(gh.calls.length, 0);
});

test('# cancelled 1 with # fail 0 is refused, nothing pushed', async () => {
  const exec = fakeExec({ 'npm test': { stdout: '# pass 4\n# fail 0\n# cancelled 1\n' } });
  const { args, gh } = base({ exec });
  const r = await shipFix(args);
  assert.equal(r.outcome, 'refused');
  assert.ok(r.problems.some((p) => /cancelled/.test(p)));
  assert.ok(!exec.calls.some((c) => c.l.includes(' push ')));
  assert.equal(gh.calls.length, 0);
});

test('a non-zero npm test exit is refused even with a clean-looking summary', async () => {
  const exec = fakeExec({ 'npm test': { stdout: GREEN, code: 1 } });
  const { args } = base({ exec });
  const r = await shipFix(args);
  assert.equal(r.outcome, 'refused');
});

test('a diff problem is refused with no push and no test run', async () => {
  const exec = fakeExec({ 'diff --numstat': { stdout: '2\t2\tlib/post-lock.js\n1\t0\ttests/x.test.js\n' } });
  const { args, gh } = base({ exec });
  const r = await shipFix(args);
  assert.equal(r.outcome, 'refused');
  assert.ok(r.problems.some((p) => /gate file: lib\/post-lock\.js/.test(p)));
  assert.ok(!exec.calls.some((c) => c.l.includes(' push ')));
  assert.ok(!exec.calls.some((c) => c.l.includes('npm test')));
  assert.equal(gh.calls.length, 0);
});

test('a failed rebase is aborted and refused', async () => {
  const exec = fakeExec({ 'rebase origin/main': { code: 1, stderr: 'CONFLICT' } });
  const { args } = base({ exec });
  const r = await shipFix(args);
  assert.equal(r.outcome, 'refused');
  assert.ok(exec.calls.some((c) => c.l === `u:git -C ${WT} rebase --abort`));
});

test('happy path: fetch, rebase, test, push, PR, merge, deploy, rerun → deployed', async () => {
  const { args, exec, gh, order } = base();
  const seq = [];
  const wrapExec = async (c, a, o) => { const r = await exec(c, a, o); seq.push(label(c, a)); return r; };
  const wrapGh = {
    createPullRequest: async (x) => { seq.push('PR'); return gh.createPullRequest(x); },
    mergePullRequest: async (x) => { seq.push('MERGE'); return gh.mergePullRequest(x); },
  };
  const r = await shipFix({ ...args, exec: wrapExec, gh: wrapGh,
    deploy: async () => { seq.push('DEPLOY'); return { ok: true, output: '' }; },
    rerun: async () => { seq.push('RERUN'); return { ok: true, output: '' }; } });
  assert.equal(r.outcome, 'deployed');
  assert.equal(r.verify, 'rerun');
  assert.deepEqual(r.pr, { number: 7, url: 'https://github.com/x/pull/7' });
  assert.deepEqual(r.otherCommits, ['other11 feat: someone else']);

  const idx = (pred) => seq.findIndex(pred);
  const steps = [
    idx((l) => l === `u:git -C ${WT} fetch origin`),
    idx((l) => l === `u:git -C ${WT} rebase origin/main`),
    idx((l) => l === 'u:npm test'),
    idx((l) => l.startsWith('r:git') && l.includes(' push ')),
    idx((l) => l === 'PR'),
    idx((l) => l === 'MERGE'),
    idx((l) => l === 'DEPLOY'),
    idx((l) => l === 'RERUN'),
  ];
  assert.ok(steps.every((i) => i >= 0), JSON.stringify({ steps, seq }));
  assert.deepEqual([...steps].sort((a, b) => a - b), steps);
  // serverHEAD is read before the deploy
  assert.ok(idx((l) => l === `r:git -C ${PROD} rev-parse HEAD`) < idx((l) => l === 'DEPLOY'));
  assert.equal(order.length, 0);
});

test('fix-branch code runs only as recapfix; root only reads git, pushes and touches prod', async () => {
  const { args, exec } = base();
  await shipFix(args);
  for (const c of exec.calls) {
    if (c.l.startsWith('r:')) {
      assert.equal(c.cmd, 'git', `root ran non-git: ${c.l}`);
      assert.ok(/^r:git (-c safe\.directory=\S+ -C \S+ (diff|log|rev-parse|push)|-C \/root\/seo-claude (rev-parse|fetch|log)) /.test(c.l), c.l);
    }
  }
  const npm = exec.calls.find((c) => c.l === 'u:npm test');
  assert.equal(npm.opts.cwd, WT);
  assert.deepEqual(npm.opts.env, { HOME: '/home/recapfix', PATH: '/usr/local/bin:/usr/bin:/bin' });
});

test('the token is never in argv; push auth goes through GIT_CONFIG env', async () => {
  const { args, exec } = base();
  await shipFix(args);
  for (const c of exec.calls) assert.ok(!JSON.stringify(c.args).includes(TOKEN), c.l);
  const push = exec.calls.find((c) => c.l.includes(' push '));
  assert.deepEqual(push.args.slice(-2), ['https://github.com/seanfillmore/blogpostworkflow.git', 'HEAD:refs/heads/fix/recap-foo']);
  assert.equal(push.opts.env.GIT_CONFIG_COUNT, '1');
  assert.equal(push.opts.env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
  assert.equal(push.opts.env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`);
  for (const c of exec.calls.filter((x) => x !== push)) {
    assert.ok(!JSON.stringify(c.opts?.env || {}).includes('extraheader'), c.l);
  }
});

test('pushAuthEnv builds the extraheader from the token', () => {
  const e = pushAuthEnv('abc', { PATH: '/bin' });
  assert.equal(e.PATH, '/bin');
  assert.equal(e.GIT_CONFIG_VALUE_0, `AUTHORIZATION: basic ${Buffer.from('x-access-token:abc').toString('base64')}`);
});

test('PR body names the error, summary, the test added, the test summary, and ends with the generated line', async () => {
  const { args, gh } = base();
  await shipFix(args);
  const [, pr] = gh.calls.find(([k]) => k === 'pr');
  assert.equal(pr.head, 'fix/recap-foo');
  assert.equal(pr.token, TOKEN);
  assert.match(pr.body, /Foo agent failed/);
  assert.match(pr.body, /TypeError: x is undefined/);
  assert.match(pr.body, /guarded the undefined x/);
  assert.match(pr.body, /tests\/lib\/foo\.test\.js/);
  assert.match(pr.body, /# pass 12/);
  assert.ok(pr.body.trimEnd().endsWith('🤖 Generated with [Claude Code](https://claude.com/claude-code)'));
});

test('rerun null → deployed, verify next-scheduled-run', async () => {
  const { args } = base({ rerun: null });
  const r = await shipFix(args);
  assert.equal(r.outcome, 'deployed');
  assert.equal(r.verify, 'next-scheduled-run');
});

test('a merge cutoff crossed during the test run leaves the PR open: too-late, no merge', async () => {
  const { args, gh } = base();
  const times = [EARLY, LATE];
  const r = await shipFix({ ...args, now: () => times.shift() || LATE });
  assert.equal(r.outcome, 'too-late');
  assert.ok(r.pr);
  assert.ok(!gh.calls.some(([k]) => k === 'merge'));
});

test('a failed rerun reverts: revert branch, PR, merge, second deploy → reverted', async () => {
  const { args, exec, gh, deployCalls } = base({ rerun: async () => ({ ok: false, output: 'still broken' }) });
  const r = await shipFix(args);
  assert.equal(r.outcome, 'reverted');
  assert.deepEqual(r.revertPr, { number: 8, url: 'https://github.com/x/pull/8' });
  assert.ok(r.problems.some((p) => /rerun failed/.test(p)));
  const RWT = '/srv/recap-fix/fix-revert-foo';
  assert.ok(exec.calls.some((c) => c.l === `u:git clone --quiet https://github.com/seanfillmore/blogpostworkflow.git ${RWT}`));
  assert.ok(exec.calls.some((c) => c.l === `u:git -C ${RWT} checkout -b revert/recap-foo`));
  assert.ok(exec.calls.some((c) => c.l === `u:git -C ${RWT} revert -m 1 --no-edit mergesha`));
  const pushes = exec.calls.filter((c) => c.l.includes(' push '));
  assert.equal(pushes.length, 2);
  assert.deepEqual(pushes[1].args.slice(-1), ['HEAD:refs/heads/revert/recap-foo']);
  const prs = gh.calls.filter(([k]) => k === 'pr');
  assert.equal(prs[1][1].head, 'revert/recap-foo');
  assert.ok(prs[1][1].body.trimEnd().endsWith('🤖 Generated with [Claude Code](https://claude.com/claude-code)'));
  assert.deepEqual(gh.calls.filter(([k]) => k === 'merge').map(([, a]) => a.number), [7, 8]);
  assert.equal(deployCalls.length, 2);
});

test('a failed deploy reverts too, and the revert ignores the merge cutoff', async () => {
  let n = 0;
  const { args, gh } = base({ deploy: async () => { n += 1; return n === 1 ? { ok: false, output: 'pm2 not online' } : { ok: true, output: '' }; } });
  const times = [EARLY, EARLY];
  const r = await shipFix({ ...args, now: () => times.shift() || LATE });
  assert.equal(r.outcome, 'reverted');
  assert.ok(r.problems.some((p) => /deploy failed/.test(p)));
  assert.equal(gh.calls.filter(([k]) => k === 'merge').length, 2);
});

test('a revert that cannot be completed throws, so the crash handler escalates it', async () => {
  const exec = fakeExec({ 'revert -m 1': { code: 1, stderr: 'conflict' } });
  const { args } = base({ exec, rerun: async () => ({ ok: false, output: 'x' }) });
  await assert.rejects(shipFix(args), /revert/);
});

test('deployServer runs the script in prodRoot and reports ok from the exit code', async () => {
  const calls = [];
  const exec = async (c, a, o) => { calls.push([c, a, o]); return { stdout: 'out', stderr: 'err', code: 0 }; };
  const r = await deployServer({ exec, prodRoot: '/p' });
  assert.deepEqual(calls[0].slice(0, 2), ['bash', ['scripts/deploy-server.sh']]);
  assert.equal(calls[0][2].cwd, '/p');
  assert.equal(r.ok, true);
  assert.match(r.output, /out/);
  const bad = await deployServer({ exec: async () => ({ stdout: '', stderr: 'boom', code: 1 }), prodRoot: '/p' });
  assert.equal(bad.ok, false);
});
