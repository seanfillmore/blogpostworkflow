import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createFixCheckout, buildFixPrompt, runFixSession, parseVerdict } from '../../lib/fix-session.js';
import { FORBIDDEN_PATHS, GATE_FILES, GUARD_FILES, GUARD_PREFIXES } from '../../lib/fix-diff-rules.js';

function fakeSpawn({ stdout = '', code = 0, hang = false } = {}) {
  const calls = [];
  const impl = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242;
    child.kills = [];
    child.kill = () => true;
    if (hang) impl.onKill = (sig) => { child.kills.push(sig); setImmediate(() => child.emit('close', null)); };
    calls.push({ bin, args, opts, child });
    if (!hang) setImmediate(() => { child.stdout.emit('data', stdout); child.emit('close', code); });
    return child;
  };
  impl.calls = calls;
  return impl;
}

const result = (text) => JSON.stringify({ result: text, is_error: false });

test('argv is exactly the spec and cwd is the worktree', async () => {
  const spawnImpl = fakeSpawn({ stdout: result('VERDICT: fixed — done') });
  await runFixSession({ worktree: '/w', prompt: 'P', spawnImpl, token: 't' });
  const { bin, args, opts } = spawnImpl.calls[0];
  assert.equal(bin, '/usr/sbin/runuser');
  assert.equal(opts.detached, true);
  assert.deepEqual(args, ['-u', 'recapfix', '--', '/usr/local/bin/claude', '-p', 'P', '--output-format', 'json', '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read,Edit,Write,Grep,Glob,Bash(node:*),Bash(npm test:*),Bash(git diff:*),Bash(git status:*),Bash(git add:*),Bash(git commit:*)']);
  assert.equal(opts.cwd, '/w');
});

test('env carries no production credentials even when the parent has them', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'k', SHOPIFY_ACCESS_TOKEN: 's', KLAVIYO_API_KEY: 'k', HUSHMAIL_PASSWORD: 'h', RESEND_API_KEY: 'r' });
  try {
    const spawnImpl = fakeSpawn({ stdout: result('VERDICT: fixed — ok') });
    await runFixSession({ worktree: '/w', prompt: 'P', spawnImpl, token: 'tok' });
    const env = spawnImpl.calls[0].opts.env;
    assert.deepEqual(Object.keys(env).filter((k) => /ANTHROPIC_API_KEY|SHOPIFY|KLAVIYO|HUSHMAIL|RESEND/.test(k)), []);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'tok');
    assert.equal(env.HOME, '/home/recapfix');
    assert.equal(env.PATH, '/usr/local/bin:/usr/bin:/bin');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('createFixCheckout clones as recapfix in order, no .env, no /root', async () => {
  const cmds = [];
  const exec = async (cmd, args, opts) => { cmds.push([cmd, ...args, opts]); return { stdout: '', stderr: '', code: 0 }; };
  const p = await createFixCheckout('Abc/../X', { exec });
  assert.equal(p, '/srv/recap-fix/fix-abc----x');
  assert.equal(cmds.length, 5);
  for (const c of cmds) assert.deepEqual(c.slice(0, 4), ['/usr/sbin/runuser', '-u', 'recapfix', '--']);
  assert.deepEqual(cmds[0].slice(4, 8), ['git', 'clone', '--quiet', 'https://github.com/seanfillmore/blogpostworkflow.git']);
  assert.deepEqual(cmds[1].slice(4, 8), ['git', '-C', p, 'checkout']);
  assert.ok(cmds[1].includes('fix/recap-abc----x'));
  assert.ok(cmds[2].includes('user.name') && cmds[3].includes('user.email'));
  assert.deepEqual(cmds[4].slice(4, 8), ['npm', 'ci', '--no-audit', '--no-fund']);
  assert.equal(cmds[4].at(-1).cwd, p);
  const flat = JSON.stringify(cmds);
  assert.ok(!flat.includes('.env') && !flat.includes('/root'));
});

test('createFixCheckout rejects an empty name and caps length', async () => {
  const exec = async () => ({ stdout: '', stderr: '', code: 0 });
  await assert.rejects(() => createFixCheckout('', { exec }), /empty/);
  const p = await createFixCheckout('a'.repeat(100), { exec });
  assert.equal(p.length, '/srv/recap-fix/fix-'.length + 60);
});

test('createFixCheckout throws when a step fails', async () => {
  const exec = async () => ({ stdout: '', stderr: 'boom', code: 1 });
  await assert.rejects(() => createFixCheckout('x', { exec, root: '/r' }), /boom/);
});

test('prompt carries the rules verbatim', () => {
  const p = buildFixPrompt({ item: { subject: 'Creator outreach failed', detail: 'TypeError x', source: 'agents/creator-outreach/index.js', row: { body: 'stack here' } }, logTail: 'LOGTAIL', command: 'node agents/creator-outreach/index.js' });
  for (const f of [...FORBIDDEN_PATHS, ...GATE_FILES, ...GUARD_FILES, ...GUARD_PREFIXES]) assert.ok(p.includes(f), f);
  for (const s of ['a failure caused by a gate correctly refusing is not a code defect', 'add a test that fails before the fix', '300',
    'never weaken a test', 'npm test', 'commit your fix', 'VERDICT: fixed|gate|external|no-fix — <one sentence>',
    'Creator outreach failed', 'LOGTAIL', 'node agents/creator-outreach/index.js']) assert.ok(p.includes(s), s);
});

test('verdict parsing: em dash, hyphen, none', async () => {
  assert.deepEqual(parseVerdict('x\nVERDICT: gate — refused correctly'), { verdict: 'gate', summary: 'refused correctly' });
  assert.deepEqual(parseVerdict('VERDICT: external - API down'), { verdict: 'external', summary: 'API down' });
  assert.equal(parseVerdict('nothing here').verdict, 'no-fix');
  const r = await runFixSession({ worktree: '/w', prompt: 'P', spawnImpl: fakeSpawn({ stdout: result('I tried.') }), token: 't' });
  assert.equal(r.verdict, 'no-fix');
  const raw = await runFixSession({ worktree: '/w', prompt: 'P', spawnImpl: fakeSpawn({ stdout: 'plain\nVERDICT: fixed — raw' }), token: 't' });
  assert.deepEqual([raw.verdict, raw.summary], ['fixed', 'raw']);
});

test('timeout kills the child and returns no-fix', async () => {
  const spawnImpl = fakeSpawn({ hang: true });
  const sent = [];
  const killGroup = (pid, sig) => { sent.push([pid, sig]); spawnImpl.onKill(sig); };
  const r = await runFixSession({ worktree: '/w', prompt: 'P', spawnImpl, token: 't', timeoutMs: 20, killGraceMs: 50, killGroup });
  assert.equal(r.verdict, 'no-fix');
  assert.equal(r.summary, 'timed out');
  assert.deepEqual(sent[0], [4242, 'SIGTERM']);
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(sent[1], [4242, 'SIGKILL']); // still armed after the child closed
});

test('captured stdout keeps only the 2 MB tail', async () => {
  const big = 'x'.repeat(3 * 1024 * 1024) + '\nVERDICT: fixed — tail kept';
  const r = await runFixSession({ worktree: '/w', prompt: 'P', spawnImpl: fakeSpawn({ stdout: big }), token: 't' });
  assert.equal(r.summary, 'tail kept');
});

test('I6: every createFixCheckout step passes cwd, the minimal recapfix env and a timeout', async () => {
  const cmds = [];
  const exec = async (cmd, args, opts) => { cmds.push({ args, opts }); return { stdout: '', stderr: '', code: 0 }; };
  const p = await createFixCheckout('x', { exec, baseDir: '/srv/recap-fix' });
  const env = { HOME: '/home/recapfix', PATH: '/usr/local/bin:/usr/bin:/bin' };
  for (const c of cmds) {
    assert.deepEqual(c.opts.env, env, c.args.join(' '));
    assert.ok(Number.isFinite(c.opts.timeout) && c.opts.timeout > 0, c.args.join(' '));
    assert.ok(c.opts.cwd, c.args.join(' '));
  }
  assert.equal(cmds[0].opts.cwd, '/srv/recap-fix', 'clone runs from baseDir, never /root/seo-claude');
  assert.equal(cmds[0].opts.timeout, 10 * 60_000);
  for (const c of cmds.slice(1)) assert.equal(c.opts.cwd, p);
  assert.equal(cmds[2].opts.timeout, 60_000);
  assert.equal(cmds[3].opts.timeout, 60_000);
  assert.equal(cmds[4].opts.timeout, 10 * 60_000);
});

test('I6: a step that times out fails createFixCheckout and says so', async () => {
  const exec = async () => ({ stdout: '', stderr: '', code: null, timedOut: true });
  await assert.rejects(() => createFixCheckout('x', { exec }), /timed out/);
});
