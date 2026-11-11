import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCleanWorktree, buildFixPrompt, runFixSession, parseVerdict } from '../../lib/fix-session.js';
import { FORBIDDEN_PATHS, GATE_FILES, GUARD_FILES, GUARD_PREFIXES } from '../../lib/fix-diff-rules.js';

function fakeSpawn({ stdout = '', code = 0, hang = false } = {}) {
  const calls = [];
  const impl = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kills = [];
    child.kill = (sig) => { child.kills.push(sig); if (hang) setImmediate(() => child.emit('close', null)); return true; };
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
  const { args, opts } = spawnImpl.calls[0];
  assert.deepEqual(args, ['-p', 'P', '--output-format', 'json', '--permission-mode', 'acceptEdits',
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
    assert.ok(env.HOME && env.PATH);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('createCleanWorktree fetches, adds the worktree, links node_modules, never .env', async () => {
  const cmds = [];
  const exec = async (cmd, args) => { cmds.push([cmd, ...args]); return { stdout: '', stderr: '', code: 0 }; };
  const p = await createCleanWorktree('abc', { exec, root: '/repo' });
  assert.equal(p, '/repo/.claude/worktrees/fix-abc');
  assert.deepEqual(cmds[0], ['git', 'fetch', 'origin']);
  assert.deepEqual(cmds[1], ['git', 'worktree', 'add', '-b', 'fix/recap-abc', '/repo/.claude/worktrees/fix-abc', 'origin/main']);
  assert.deepEqual(cmds[2], ['ln', '-s', '/repo/node_modules', '/repo/.claude/worktrees/fix-abc/node_modules']);
  assert.ok(!JSON.stringify(cmds).includes('.env'));
});

test('createCleanWorktree throws when a step fails', async () => {
  const exec = async () => ({ stdout: '', stderr: 'boom', code: 1 });
  await assert.rejects(() => createCleanWorktree('x', { exec, root: '/r' }), /boom/);
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
  const r = await runFixSession({ worktree: '/w', prompt: 'P', spawnImpl, token: 't', timeoutMs: 20, killGraceMs: 50 });
  assert.equal(r.verdict, 'no-fix');
  assert.equal(r.summary, 'timed out');
  assert.equal(spawnImpl.calls[0].child.kills[0], 'SIGTERM');
});
